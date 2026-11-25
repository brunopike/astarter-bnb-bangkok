"""Immutable historical artifact anchors on the shared terminal boundary tables."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from hashlib import sha256
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, model_validator

from stark_trading_os.audit.canonical_json import canonical_json_bytes, parse_json_object
from stark_trading_os.catalog.historical_catalog import (
    canonical_historical_bytes,
    parse_historical_model_bytes,
)
from stark_trading_os.control.database import _immediate_transaction
from stark_trading_os.control.historical_outcomes import (
    _require_historical_run,
    read_historical_runner_outcome,
)
from stark_trading_os.control.historical_preflight import (
    HistoricalPreflightRecord,
    _record,
    _snapshot,
)
from stark_trading_os.control.historical_process import HistoricalRunnerOutcomeRecord
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.transactions import (
    AuditIntent,
    PersistedEvent,
    RunSnapshot,
    _insert_terminal_boundary,
)
from stark_trading_os.domain.historical_input import Digest
from stark_trading_os.domain.models import EventEnvelopeV1, RunState

BASE_PATHS = ("input-manifest.json", "catalog-manifest.json", "runner-exit.json", "stderr.txt")
REPORT_PATHS = ("reports/component-snapshot.json", "reports/historical-report.json")


class HistoricalFinalizationError(ValueError):
    def __init__(self) -> None:
        super().__init__("HISTORICAL_FINALIZATION_INVALID")


class HistoricalArtifactAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    path: Literal[
        "input-manifest.json",
        "catalog-manifest.json",
        "runner-exit.json",
        "stderr.txt",
        "reports/component-snapshot.json",
        "reports/historical-report.json",
    ]
    sha256: Digest
    size_bytes: Annotated[StrictInt, Field(ge=0, le=128 * 1024 * 1024)]


class HistoricalEvidenceAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, serialize_by_alias=True)
    schema_: Literal["HistoricalEvidenceAnchor.v2"] = Field(alias="schema")
    run_id: Annotated[StrictStr, Field(pattern=r"^bt_[0-9a-f]{32}$")]
    preflight_id: Annotated[StrictStr, Field(pattern=r"^pfh_[0-9a-f]{32}$")]
    input_manifest_sha256: Digest
    catalog_publication_sha256: Digest
    observer_sha256: Digest
    history_sha256: Digest
    validation: Literal["COMPLETE_PASSED", "COMPLETE_FAILED", "DIAGNOSTIC_PREFIX", "NO_REPORT"]
    terminal_state: Literal["COMPLETED", "FAILED", "CANCELLED"]
    artifacts: tuple[HistoricalArtifactAnchor, ...]

    @model_validator(mode="after")
    def truthful_inventory(self) -> HistoricalEvidenceAnchor:
        paths = tuple(a.path for a in self.artifacts)
        if not 4 <= len(paths) <= 6 or paths != (BASE_PATHS + REPORT_PATHS)[: len(paths)]:
            raise HistoricalFinalizationError()
        if self.validation.startswith("COMPLETE") and len(paths) != 6:
            raise HistoricalFinalizationError()
        if self.validation == "DIAGNOSTIC_PREFIX" and len(paths) not in (5, 6):
            raise HistoricalFinalizationError()
        if self.validation == "NO_REPORT" and len(paths) != 4:
            raise HistoricalFinalizationError()
        if self.terminal_state == "COMPLETED" and self.validation != "COMPLETE_PASSED":
            raise HistoricalFinalizationError()
        if self.terminal_state == "CANCELLED" and self.validation != "NO_REPORT":
            raise HistoricalFinalizationError()
        return self


@dataclass(frozen=True)
class HistoricalAuthority:
    run: RunSnapshot
    preflight: HistoricalPreflightRecord
    outcome: HistoricalRunnerOutcomeRecord
    events: tuple[bytes, ...]
    audits: tuple[bytes, ...]
    history_sha256: str


@dataclass(frozen=True)
class HistoricalTerminalPreparation:
    anchor: HistoricalEvidenceAnchor
    anchor_bytes: bytes
    anchor_sha256: str
    outcome: HistoricalRunnerOutcomeRecord
    terminal_state_version: int
    event: PersistedEvent
    audit: AuditIntent
    prepared_at_ns: int


@dataclass(frozen=True)
class HistoricalTerminalPublication:
    run_id: str
    state: RunState
    seal_digest: str
    anchor_sha256: str
    terminal_event_seq: int
    validation: str


def _history(
    connection: sqlite3.Connection, run_id: str, end_seq: int
) -> tuple[tuple[bytes, ...], tuple[bytes, ...], str]:
    rows = connection.execute(
        "SELECT e.*,a.intent_bytes,a.event_digest,a.created_at_ns AS audit_created,"
        "a.audit_seq,o.audit_seq AS outbox_audit FROM events e "
        "JOIN audit_intents a ON a.run_id=e.run_id AND a.event_seq=e.seq "
        "JOIN outbox o ON o.run_id=e.run_id AND o.seq=e.seq "
        "WHERE e.run_id=? AND e.seq<=? ORDER BY e.seq",
        (run_id, end_seq),
    ).fetchall()
    if len(rows) != end_seq:
        raise HistoricalFinalizationError()
    events, audits = [], []
    for seq, row in enumerate(rows, start=1):
        raw, intent = row["envelope_bytes"], row["intent_bytes"]
        envelope = EventEnvelopeV1.model_validate(parse_json_object(raw))
        expected_intent = canonical_json_bytes(
            {
                "seq": seq,
                "run_id": run_id,
                "event_seq": seq,
                "event_digest": sha256(raw).hexdigest(),
            }
        )
        if (
            envelope.run_id != run_id
            or envelope.seq != seq
            or envelope.source_seq != seq
            or envelope.source != "control-api"
            or envelope.writer != "control-api"
            or canonical_json_bytes(envelope.model_dump(mode="json")) != raw
            or row["seq"] != seq
            or row["source_seq"] != seq
            or row["visible"] != 1
            or row["source"] != envelope.source
            or row["writer"] != envelope.writer
            or row["type"] != envelope.type
            or row["event_id"] != envelope.event_id
            or row["ts_event_ns"] != envelope.ts_event_ns
            or row["ts_ingest_ns"] != envelope.ts_ingest_ns
            or row["schema_version"] != 1
            or row["audit_seq"] != seq
            or row["outbox_audit"] != seq
            or str(row["audit_created"]) != envelope.ts_ingest_ns
            or row["event_digest"] != sha256(raw).hexdigest()
            or intent != expected_intent
        ):
            raise HistoricalFinalizationError()
        events.append(raw)
        audits.append(intent)
    digest = sha256(
        canonical_json_bytes(
            {
                "events": [sha256(v).hexdigest() for v in events],
                "audits": [sha256(v).hexdigest() for v in audits],
            }
        )
    ).hexdigest()
    return tuple(events), tuple(audits), digest


def _authority(
    connection: sqlite3.Connection, run_id: str, *, end_seq: int | None = None
) -> HistoricalAuthority:
    run = _require_historical_run(connection, run_id)
    outcome = read_historical_runner_outcome(connection, run_id)
    row = connection.execute(
        "SELECT preflight_id FROM historical_preflights WHERE run_id=?", (run_id,)
    ).fetchone()
    if outcome is None or row is None:
        raise HistoricalFinalizationError()
    preflight = _record(connection, row["preflight_id"])
    if preflight is None or preflight.consumed_at_ns is None:
        raise HistoricalFinalizationError()
    end_seq = run.last_event_seq if end_seq is None else end_seq
    events, audits, digest = _history(connection, run_id, end_seq)
    finalizing = parse_json_object(events[-1])
    if finalizing["type"] != "run.finalizing" or finalizing["payload"] != {
        "classification": outcome.outcome.classification,
        "outcome_hash": outcome.outcome_hash,
        "proposed_terminal_state": outcome.outcome.proposed_terminal_state,
    }:
        raise HistoricalFinalizationError()
    return HistoricalAuthority(run, preflight, outcome, events, audits, digest)


def _validate_anchor(anchor: HistoricalEvidenceAnchor, authority: HistoricalAuthority) -> None:
    preflight, outcome = authority.preflight, authority.outcome
    if (
        anchor.run_id != authority.run.run_id
        or anchor.preflight_id != preflight.receipt.preflight_id
        or anchor.input_manifest_sha256 != preflight.receipt.input_manifest_sha256
        or anchor.catalog_publication_sha256
        != sha256(preflight.catalog_publication_bytes).hexdigest()
        or anchor.observer_sha256 != outcome.outcome_hash
        or anchor.history_sha256 != authority.history_sha256
        or anchor.terminal_state != outcome.outcome.proposed_terminal_state
    ):
        raise HistoricalFinalizationError()
    expected_base = (
        preflight.input_manifest_bytes,
        preflight.catalog_publication_bytes,
        outcome.outcome_bytes,
    )
    for artifact, raw in zip(anchor.artifacts[:3], expected_base, strict=True):
        if artifact.sha256 != sha256(raw).hexdigest() or artifact.size_bytes != len(raw):
            raise HistoricalFinalizationError()
    stderr = anchor.artifacts[3]
    if (
        stderr.sha256 != outcome.outcome.stderr_sha256
        or stderr.size_bytes != outcome.outcome.stderr_size_bytes
    ):
        raise HistoricalFinalizationError()
    child = outcome.outcome.child_outcome
    candidates = () if child is None else child.artifacts
    if len(candidates) != len(anchor.artifacts) - 4:
        raise HistoricalFinalizationError()
    for artifact, candidate in zip(anchor.artifacts[4:], candidates, strict=True):
        if (
            artifact.path != candidate.path
            or artifact.sha256 != candidate.sha256
            or artifact.size_bytes != candidate.size_bytes
        ):
            raise HistoricalFinalizationError()


def _prepared(connection: sqlite3.Connection, run_id: str) -> HistoricalTerminalPreparation | None:
    _require_historical_run(connection, run_id)
    row = connection.execute(
        "SELECT * FROM terminal_preparations WHERE run_id=?", (run_id,)
    ).fetchone()
    anchor_row = connection.execute(
        "SELECT * FROM historical_terminal_anchors WHERE run_id=?", (run_id,)
    ).fetchone()
    if row is None and anchor_row is None:
        return None
    if row is None or anchor_row is None:
        raise HistoricalFinalizationError()
    try:
        anchor = parse_historical_model_bytes(anchor_row["anchor_bytes"], HistoricalEvidenceAnchor)
        digest = sha256(anchor_row["anchor_bytes"]).hexdigest()
        if digest != anchor_row["anchor_hash"]:
            raise HistoricalFinalizationError()
        authority = _authority(connection, run_id, end_seq=row["event_seq"] - 1)
        _validate_anchor(anchor, authority)
        envelope = EventEnvelopeV1.model_validate(parse_json_object(row["event_envelope_bytes"]))
        expected = _terminal_envelope(
            run_id, row["event_id"], row["event_seq"], row["prepared_at_ns"], anchor, digest
        )
        raw = canonical_json_bytes(expected.model_dump(mode="json"))
        audit_raw = canonical_json_bytes(
            {
                "seq": row["event_seq"],
                "run_id": run_id,
                "event_seq": row["event_seq"],
                "event_digest": sha256(raw).hexdigest(),
            }
        )
        if (
            envelope != expected
            or raw != row["event_envelope_bytes"]
            or row["event_digest"] != sha256(raw).hexdigest()
            or anchor_row["event_digest"] != row["event_digest"]
            or row["runner_outcome_hash"] != authority.outcome.outcome_hash
            or row["terminal_state"] != anchor.terminal_state
            or row["terminal_state_version"] != row["event_seq"]
            or row["event_source_seq"] != row["event_seq"]
            or row["event_source"] != "control-api"
            or row["event_writer"] != "control-api"
            or row["event_type"] != expected.type
            or row["event_schema_version"] != 1
            or row["event_visible"] != 0
            or row["event_ts_event_ns"] != expected.ts_event_ns
            or row["event_ts_ingest_ns"] != expected.ts_ingest_ns
            or row["audit_seq"] != row["event_seq"]
            or row["audit_intent_bytes"] != audit_raw
            or row["audit_intent_digest"] != sha256(audit_raw).hexdigest()
            or row["audit_event_digest"] != row["event_digest"]
            or row["initial_event_digest"] != row["event_digest"]
            or row["audit_created_at_ns"] != row["prepared_at_ns"]
            or row["disposition"] != "NORMAL"
            or row["failure_attempt_count"] != 0
            or any(
                row[k] is not None
                for k in (
                    "last_failure_at_ns",
                    "last_failure_stage",
                    "conversion_fault_hash",
                    "converted_at_ns",
                )
            )
        ):
            raise HistoricalFinalizationError()
        run_row = connection.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        if (
            run_row["prepared_terminal_state"] != anchor.terminal_state
            or run_row["prepared_terminal_state_version"] != row["terminal_state_version"]
            or run_row["prepared_terminal_event_seq"] != row["event_seq"]
        ):
            raise HistoricalFinalizationError()
        event = PersistedEvent(
            envelope.event_id,
            run_id,
            envelope.seq,
            envelope.source_seq,
            envelope.source,
            envelope.type,
            envelope.ts_event_ns,
            envelope.ts_ingest_ns,
            False,
            raw,
        )
        audit = AuditIntent(
            run_id,
            row["audit_seq"],
            envelope.seq,
            row["event_digest"],
            audit_raw,
            row["prepared_at_ns"],
        )
        return HistoricalTerminalPreparation(
            anchor,
            anchor_row["anchor_bytes"],
            digest,
            authority.outcome,
            row["terminal_state_version"],
            event,
            audit,
            row["prepared_at_ns"],
        )
    except Exception:
        raise HistoricalFinalizationError() from None


def _terminal_envelope(
    run_id: str, event_id: str, seq: int, at_ns: int, anchor: HistoricalEvidenceAnchor, digest: str
) -> EventEnvelopeV1:
    return EventEnvelopeV1.model_validate(
        {
            "event_id": event_id,
            "run_id": run_id,
            "seq": seq,
            "source_seq": seq,
            "ts_event_ns": str(at_ns),
            "ts_ingest_ns": str(at_ns),
            "type": {
                "COMPLETED": "run.completed",
                "FAILED": "run.failed",
                "CANCELLED": "run.cancelled",
            }[anchor.terminal_state],
            "source": "control-api",
            "writer": "control-api",
            "schema_version": 1,
            "payload": {
                "outcome_hash": anchor.observer_sha256,
                "evidence_anchor_sha256": digest,
                "report_validation": anchor.validation,
                "terminal_state": anchor.terminal_state,
            },
        }
    )


def _commit_preparation(
    store: ControlStore, anchor: HistoricalEvidenceAnchor
) -> HistoricalTerminalPreparation:
    with _immediate_transaction(store._connection):
        existing = _prepared(store._connection, anchor.run_id)
        if existing is not None:
            if existing.anchor != anchor:
                raise HistoricalFinalizationError()
            return existing
        authority = _authority(store._connection, anchor.run_id)
        if authority.run.state is not RunState.FINALIZING:
            raise HistoricalFinalizationError()
        _validate_anchor(anchor, authority)
        raw = canonical_historical_bytes(anchor)
        digest = sha256(raw).hexdigest()
        now = store._clock()
        if type(now) is not int or not 0 <= now < 2**63:
            raise HistoricalFinalizationError()
        seq = authority.run.last_event_seq + 1
        event = _terminal_envelope(
            anchor.run_id, store._event_id_factory(anchor.run_id, seq), seq, now, anchor, digest
        )
        _insert_terminal_boundary(
            store._connection,
            run_id=anchor.run_id,
            outcome_hash=anchor.observer_sha256,
            terminal_state=RunState(anchor.terminal_state),
            state_version=authority.run.state_version + 1,
            envelope=event,
            audit_seq=authority.run.last_audit_seq + 1,
            prepared_at_ns=now,
        )
        store._connection.execute(
            "INSERT INTO historical_terminal_anchors VALUES(?,?,?,?)",
            (
                anchor.run_id,
                raw,
                digest,
                sha256(canonical_json_bytes(event.model_dump(mode="json"))).hexdigest(),
            ),
        )
        result = _prepared(store._connection, anchor.run_id)
        if result is None:
            raise HistoricalFinalizationError()
        return result


def read_preparation(store: ControlStore, run_id: str) -> HistoricalTerminalPreparation | None:
    with _snapshot(store._connection):
        return _prepared(store._connection, run_id)
