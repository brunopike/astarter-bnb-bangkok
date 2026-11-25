"""Closed historical publication: committed authority precedes final files."""

from __future__ import annotations

import sqlite3
from collections.abc import Mapping
from hashlib import sha256
from pathlib import Path

from stark_trading_os.catalog.historical_catalog import canonical_historical_bytes
from stark_trading_os.control.database import _immediate_transaction
from stark_trading_os.control.historical_artifacts import ExpectedFiles, locked_root, read_staged
from stark_trading_os.control.historical_preflight import _snapshot
from stark_trading_os.control.historical_terminal import (
    BASE_PATHS,
    REPORT_PATHS,
    HistoricalArtifactAnchor,
    HistoricalAuthority,
    HistoricalEvidenceAnchor,
    HistoricalFinalizationError,
    HistoricalTerminalPreparation,
    HistoricalTerminalPublication,
    _authority,
    _commit_preparation,
    _history,
    _prepared,
    read_preparation,
)
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.transactions import _publish_terminal_rows
from stark_trading_os.domain.models import RunState
from stark_trading_os.runner.historical_report_reader import (
    HistoricalReportExpectationV2,
    reverify_historical_report_v2,
    validate_historical_report_candidate_v2,
)


def _expectation(authority: HistoricalAuthority) -> HistoricalReportExpectationV2:
    return HistoricalReportExpectationV2(
        run_id=authority.run.run_id,
        input_manifest_bytes=authority.preflight.input_manifest_bytes,
        input_manifest_sha256=authority.preflight.receipt.input_manifest_sha256,
        catalog_manifest_bytes=authority.preflight.catalog_publication_bytes,
        account_id=authority.outcome.outcome.identity.account_id,
    )


def _validation(
    authority: HistoricalAuthority,
    payloads: Mapping[str, bytes],
    preparation: HistoricalTerminalPreparation | None = None,
) -> str:
    child = authority.outcome.outcome.child_outcome
    if child is None or not child.artifacts:
        return "NO_REPORT"
    if child.report_status is None:
        return "DIAGNOSTIC_PREFIX"
    if preparation is None:
        checked = validate_historical_report_candidate_v2(
            report_bytes=payloads[REPORT_PATHS[1]],
            component_snapshot_bytes=payloads[REPORT_PATHS[0]],
            expected=_expectation(authority),
        )
    else:
        anchors: dict[str, str] = {a.path: a.sha256 for a in preparation.anchor.artifacts}
        checked = reverify_historical_report_v2(
            report_bytes=payloads[REPORT_PATHS[1]],
            component_snapshot_bytes=payloads[REPORT_PATHS[0]],
            expected=_expectation(authority),
            expected_report_sha256=anchors[REPORT_PATHS[1]],
            expected_component_snapshot_sha256=anchors[REPORT_PATHS[0]],
        )
    if checked.status != child.report_status:
        raise HistoricalFinalizationError()
    return (
        "COMPLETE_PASSED" if checked.status == "INTERNAL_REPORT_CHECK_PASSED" else "COMPLETE_FAILED"
    )


def _projection(
    authority: HistoricalAuthority, preparation: HistoricalTerminalPreparation
) -> tuple[dict[str, bytes], ExpectedFiles, str]:
    """All expected bytes/digests derive from SQLite; none are read from final files."""
    anchor, observer = preparation.anchor, preparation.outcome.outcome
    known = {
        BASE_PATHS[0]: authority.preflight.input_manifest_bytes,
        BASE_PATHS[1]: authority.preflight.catalog_publication_bytes,
        BASE_PATHS[2]: preparation.outcome.outcome_bytes,
        "evidence-anchor.json": preparation.anchor_bytes,
        "events.ndjson": b"".join(
            raw + b"\n" for raw in (*authority.events, preparation.event.envelope_bytes)
        ),
        "audit.ndjson": b"".join(
            raw + b"\n" for raw in (*authority.audits, preparation.audit.intent_bytes)
        ),
        "run.json": canonical_historical_bytes(
            {
                "schema": "HistoricalRunReceipt.v2",
                "run_id": anchor.run_id,
                "contract_kind": "HISTORICAL_SMA_V2",
                "state": anchor.terminal_state,
                "state_version": preparation.terminal_state_version,
                "evidence_anchor_sha256": preparation.anchor_sha256,
                "input_manifest_sha256": anchor.input_manifest_sha256,
                "observer_sha256": anchor.observer_sha256,
                "created_at_ns": str(authority.run.created_at_ns),
                "ended_at_ns": str(observer.ended_at_ns),
                "duration_ns": str(observer.duration_ns),
                "prepared_at_ns": str(preparation.prepared_at_ns),
                "terminal_event_seq": preparation.event.seq,
                "report_validation": anchor.validation,
            }
        ),
    }
    expected: dict[str, tuple[int, str, bytes | None]] = {
        a.path: (a.size_bytes, a.sha256, known.get(a.path)) for a in anchor.artifacts
    }
    expected.update({name: (len(raw), sha256(raw).hexdigest(), raw) for name, raw in known.items()})
    seal = canonical_historical_bytes(
        {
            "schema": "HistoricalSeal.v2",
            "run_id": anchor.run_id,
            "evidence_anchor_sha256": preparation.anchor_sha256,
            "terminal_event_seq": preparation.event.seq,
            "artifacts": [
                {"path": name, "size_bytes": size, "sha256": digest}
                for name, (size, digest, _) in sorted(expected.items())
            ],
        }
    )
    known["seal.json"] = seal
    digest = sha256(seal).hexdigest()
    expected["seal.json"] = (len(seal), digest, seal)
    return known, expected, digest


def _publication(
    connection: sqlite3.Connection, preparation: HistoricalTerminalPreparation, seal_digest: str
) -> HistoricalTerminalPublication | None:
    run_id, seq = preparation.anchor.run_id, preparation.event.seq
    row = connection.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
    seal = connection.execute("SELECT * FROM seals WHERE run_id=?", (run_id,)).fetchone()
    if row is None:
        raise HistoricalFinalizationError()
    for table in ("events", "audit_intents", "outbox"):
        count = connection.execute(
            f"SELECT COUNT(*) FROM {table} WHERE run_id=?", (run_id,)
        ).fetchone()[0]
        if count != (seq - 1 if seal is None else seq):
            raise HistoricalFinalizationError()
    if seal is None:
        if (
            row["state"] != "FINALIZING"
            or row["state_version"] != preparation.terminal_state_version - 1
            or row["last_event_seq"] != seq - 1
            or row["last_audit_seq"] != seq - 1
            or row["control_source_seq"] != seq - 1
            or row["evidence_status"] != "STAGING"
            or row["completed_at_ns"] is not None
            or row["duration_ns"] is not None
        ):
            raise HistoricalFinalizationError()
        return None
    events, audits, _ = _history(connection, run_id, seq)
    pending = connection.execute(
        "SELECT COUNT(*) FROM outbox WHERE run_id=? AND "
        "(materialized<>1 OR materialized_at_ns IS NOT ?)",
        (run_id, seal["published_at_ns"]),
    ).fetchone()[0]
    observer = preparation.outcome.outcome
    if (
        row["state"] != preparation.anchor.terminal_state
        or row["state_version"] != preparation.terminal_state_version
        or row["last_event_seq"] != seq
        or row["last_audit_seq"] != seq
        or row["control_source_seq"] != seq
        or row["materialized_event_seq"] != seq
        or row["materialized_audit_seq"] != seq
        or row["evidence_status"] != "VERIFIED"
        or row["completed_at_ns"] != observer.ended_at_ns
        or row["duration_ns"] != observer.duration_ns
        or seal["seal_digest"] != seal_digest
        or seal["terminal_event_seq"] != seq
        or seal["last_audit_seq"] != seq
        or seal["published_at_ns"] < preparation.prepared_at_ns
        or events[-1] != preparation.event.envelope_bytes
        or audits[-1] != preparation.audit.intent_bytes
        or pending
    ):
        raise HistoricalFinalizationError()
    return HistoricalTerminalPublication(
        run_id,
        RunState(preparation.anchor.terminal_state),
        seal_digest,
        preparation.anchor_sha256,
        seq,
        preparation.anchor.validation,
    )


class HistoricalFinalizer:
    def __init__(self, *, store: ControlStore, runtime_root: Path) -> None:
        if type(store) is not ControlStore:
            raise TypeError("Historical finalizer requires ControlStore.")
        self._store, self._runtime = store, Path(runtime_root)

    def preparation(self, run_id: str) -> HistoricalTerminalPreparation | None:
        return read_preparation(self._store, run_id)

    def prepare(self, run_id: str) -> HistoricalTerminalPreparation:
        try:
            with _snapshot(self._store._connection):
                prepared = _prepared(self._store._connection, run_id)
                if prepared is not None:
                    return prepared
                authority = _authority(self._store._connection, run_id)
                if authority.run.state is not RunState.FINALIZING:
                    raise HistoricalFinalizationError()
            payloads = read_staged(self._runtime, authority)
            paths = (BASE_PATHS + REPORT_PATHS)[: len(payloads)]
            anchor = HistoricalEvidenceAnchor.model_validate(
                {
                    "schema": "HistoricalEvidenceAnchor.v2",
                    "run_id": run_id,
                    "preflight_id": authority.preflight.receipt.preflight_id,
                    "input_manifest_sha256": authority.preflight.receipt.input_manifest_sha256,
                    "catalog_publication_sha256": sha256(
                        authority.preflight.catalog_publication_bytes
                    ).hexdigest(),
                    "observer_sha256": authority.outcome.outcome_hash,
                    "history_sha256": authority.history_sha256,
                    "validation": _validation(authority, payloads),
                    "terminal_state": authority.outcome.outcome.proposed_terminal_state,
                    "artifacts": tuple(
                        HistoricalArtifactAnchor.model_validate(
                            {
                                "path": name,
                                "size_bytes": len(payloads[name]),
                                "sha256": sha256(payloads[name]).hexdigest(),
                            }
                        )
                        for name in paths
                    ),
                }
            )
            return _commit_preparation(self._store, anchor)
        except (ValueError, OSError, KeyError, TypeError):
            raise HistoricalFinalizationError() from None

    def finalize(self, run_id: str) -> HistoricalTerminalPublication:
        return self._finish(self.prepare(run_id))

    def recover_one(self, run_id: str) -> HistoricalTerminalPublication | None:
        prepared = self.preparation(run_id)
        return None if prepared is None else self._finish(prepared)

    def _finish(self, preparation: HistoricalTerminalPreparation) -> HistoricalTerminalPublication:
        try:
            connection = self._store._connection
            run_id = preparation.anchor.run_id
            with _snapshot(connection):
                authority = _authority(connection, run_id, end_seq=preparation.event.seq - 1)
                known, expected, digest = _projection(authority, preparation)
                published = _publication(connection, preparation, digest)

            def create() -> Mapping[str, bytes]:
                payloads = read_staged(self._runtime, authority)
                payloads.update(known)
                return payloads

            def can_materialize() -> bool:
                # Called only while holding the shared publication file lock.
                # Never retain a DB snapshot while waiting to acquire that lock.
                with _snapshot(connection):
                    if _prepared(connection, run_id) != preparation:
                        raise HistoricalFinalizationError()
                    return _publication(connection, preparation, digest) is None

            with locked_root(
                self._runtime,
                run_id,
                expected,
                create=create if published is None else None,
                can_materialize=can_materialize,
            ) as verify:
                with _immediate_transaction(connection):
                    if _prepared(connection, run_id) != preparation:
                        raise HistoricalFinalizationError()
                    publication = _publication(connection, preparation, digest)
                    if (
                        _validation(authority, verify(), preparation)
                        != preparation.anchor.validation
                    ):
                        raise HistoricalFinalizationError()
                    if publication is None:
                        now = self._store._clock()
                        if type(now) is not int or not preparation.prepared_at_ns <= now < 2**63:
                            raise HistoricalFinalizationError()
                        _publish_terminal_rows(
                            connection,
                            event=preparation.event,
                            audit=preparation.audit,
                            terminal_state=RunState(preparation.anchor.terminal_state),
                            state_version=preparation.terminal_state_version,
                            ended_at_ns=preparation.outcome.outcome.ended_at_ns,
                            duration_ns=preparation.outcome.outcome.duration_ns,
                            seal_digest=digest,
                            published_at_ns=now,
                        )
                    verify()
                    publication = _publication(connection, preparation, digest)
                    if publication is None:
                        raise HistoricalFinalizationError()
                return publication
        except (ValueError, OSError, KeyError, TypeError):
            raise HistoricalFinalizationError() from None

    def read_artifact(self, *, run_id: str, relative_path: str) -> bytes:
        try:
            connection = self._store._connection
            with _snapshot(connection):
                preparation = _prepared(connection, run_id)
                if preparation is None:
                    raise HistoricalFinalizationError()
                authority = _authority(connection, run_id, end_seq=preparation.event.seq - 1)
                _, expected, digest = _projection(authority, preparation)
                if (
                    relative_path not in expected
                    or _publication(connection, preparation, digest) is None
                ):
                    raise HistoricalFinalizationError()
            with locked_root(self._runtime, run_id, expected) as verify:
                with _snapshot(connection):
                    if (
                        _prepared(connection, run_id) != preparation
                        or _publication(connection, preparation, digest) is None
                    ):
                        raise HistoricalFinalizationError()
                    payloads = verify()
                    if (
                        _validation(authority, payloads, preparation)
                        != preparation.anchor.validation
                    ):
                        raise HistoricalFinalizationError()
                    return payloads[relative_path]
        except (ValueError, OSError, KeyError, TypeError):
            raise HistoricalFinalizationError() from None
