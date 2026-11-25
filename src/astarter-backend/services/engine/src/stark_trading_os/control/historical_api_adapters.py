"""Read-only v2 projections over the existing SQLite and artifact authorities."""

from hashlib import sha256

from stark_trading_os.audit.historical_input import parse_input_manifest_bytes
from stark_trading_os.control.api_models import ApiError
from stark_trading_os.control.historical_api_models import (
    HistoricalArtifactEntry,
    HistoricalArtifactIndex,
    HistoricalArtifactName,
    HistoricalOutcomeStatus,
    HistoricalPreflightStatus,
    HistoricalProcessStatus,
    HistoricalPublicationStatus,
    HistoricalRunResponse,
)
from stark_trading_os.control.historical_artifacts import ExpectedFiles
from stark_trading_os.control.historical_control import HistoricalControl
from stark_trading_os.control.historical_finalizer import _projection, _publication
from stark_trading_os.control.historical_preflight import _identifier, _now, _record, _snapshot
from stark_trading_os.control.historical_terminal import (
    HistoricalFinalizationError,
    HistoricalTerminalPreparation,
    HistoricalTerminalPublication,
    _authority,
    _history,
    _prepared,
)
from stark_trading_os.control.run_contract import require_historical_contract
from stark_trading_os.domain.models import RunState

ARTIFACT_PATHS: dict[HistoricalArtifactName, str] = {
    HistoricalArtifactName.INPUT_MANIFEST: "input-manifest.json",
    HistoricalArtifactName.CATALOG_MANIFEST: "catalog-manifest.json",
    HistoricalArtifactName.RUNNER_EXIT: "runner-exit.json",
    HistoricalArtifactName.STDERR: "stderr.txt",
    HistoricalArtifactName.COMPONENT_SNAPSHOT: "reports/component-snapshot.json",
    HistoricalArtifactName.HISTORICAL_REPORT: "reports/historical-report.json",
    HistoricalArtifactName.EVIDENCE_ANCHOR: "evidence-anchor.json",
    HistoricalArtifactName.EVENTS: "events.ndjson",
    HistoricalArtifactName.AUDIT: "audit.ndjson",
    HistoricalArtifactName.RUN: "run.json",
    HistoricalArtifactName.SEAL: "seal.json",
}


def _require_run(control: HistoricalControl, run_id: str) -> None:
    _identifier(run_id, "bt")
    require_historical_contract(control._store.run(run_id).contract_kind)


def _error(run_id: str, code: str, *, status: int = 409) -> ApiError:
    return ApiError(status_code=status, code=code, message=code, run_id=run_id)


def historical_preflight_status(
    control: HistoricalControl, preflight_id: str
) -> HistoricalPreflightStatus:
    record = control._preflights.record(preflight_id)
    if record is None:
        raise ApiError(status_code=404, code="PREFLIGHT_UNKNOWN", message="PREFLIGHT_UNKNOWN")
    now = _now(control._store._clock)
    checked, expires = int(record.receipt.checked_at_ns), int(record.receipt.expires_at_ns)
    return HistoricalPreflightStatus(
        receipt=record.receipt,
        consumed_at_ns=None if record.consumed_at_ns is None else str(record.consumed_at_ns),
        observed_at_ns=str(now),
        time_status="BEFORE_CHECK"
        if now < checked
        else "IN_WINDOW"
        if now < expires
        else "EXPIRED",
    )


def _publication_metadata(
    control: HistoricalControl,
    run_id: str,
) -> tuple[
    HistoricalTerminalPreparation | None, ExpectedFiles, HistoricalTerminalPublication | None
]:
    """Caller holds a read snapshot. No filesystem read or lifecycle mutation."""
    connection = control._store._connection
    preparation = _prepared(connection, run_id)
    if preparation is None:
        if control._store.run(run_id).state in {
            RunState.COMPLETED,
            RunState.FAILED,
            RunState.CANCELLED,
        }:
            raise HistoricalFinalizationError()
        return None, {}, None
    authority = _authority(connection, run_id, end_seq=preparation.event.seq - 1)
    _, expected, digest = _projection(authority, preparation)
    return preparation, expected, _publication(connection, preparation, digest)


def historical_run_response(control: HistoricalControl, run_id: str) -> HistoricalRunResponse:
    _require_run(control, run_id)
    store = control._store
    try:
        with _snapshot(store._connection):
            snapshot = store.run(run_id)
            row = store._connection.execute(
                "SELECT preflight_id FROM historical_preflights WHERE run_id=?", (run_id,)
            ).fetchone()
            record = None if row is None else _record(store._connection, row["preflight_id"])
            if record is None or record.receipt.run_id != run_id:
                raise ValueError("Historical run binding is missing.")
            manifest = parse_input_manifest_bytes(
                record.input_manifest_bytes, expected_sha256=record.receipt.input_manifest_sha256
            )
            _history(store._connection, run_id, snapshot.last_event_seq)
            process = store.runner_process(run_id)
            outcome = store.historical_runner_outcome(run_id)
            preparation, _, publication = _publication_metadata(control, run_id)
            if (outcome is not None) != (
                snapshot.state
                in {
                    RunState.FINALIZING,
                    RunState.COMPLETED,
                    RunState.FAILED,
                    RunState.CANCELLED,
                }
            ):
                raise HistoricalFinalizationError()
            receipt = record.receipt
            return HistoricalRunResponse(
                run_id=run_id,
                state=snapshot.state,
                state_version=snapshot.state_version,
                last_visible_seq=snapshot.last_event_seq,
                created_at_ns=str(snapshot.created_at_ns),
                observed_at_ns=str(_now(store._clock)),
                preflight_id=receipt.preflight_id,
                configuration_id=receipt.configuration_id,
                configuration_version=receipt.configuration_version,
                configuration_content_sha256=receipt.configuration_content_sha256,
                input_manifest_hash=receipt.input_manifest_sha256,
                catalog_revision=manifest.dataset.catalog_revision,
                catalog_publication_sha256=sha256(record.catalog_publication_bytes).hexdigest(),
                cost_sha256=manifest.cost_sha256,
                process=HistoricalProcessStatus(
                    claim="UNCLAIMED"
                    if process is None
                    else "CLAIMED_UNBOUND"
                    if process.pid is None
                    else "CLAIMED_BOUND",
                    cancel_phase=None if process is None else process.cancel_phase,
                ),
                outcome=None
                if outcome is None
                else HistoricalOutcomeStatus(
                    classification=outcome.outcome.classification,
                    outcome_sha256=outcome.outcome_hash,
                ),
                publication=HistoricalPublicationStatus(
                    state="PUBLISHED"
                    if publication is not None
                    else "PREPARED"
                    if preparation is not None
                    else "NOT_PREPARED",
                    evidence_anchor_sha256=None
                    if preparation is None
                    else preparation.anchor_sha256,
                    seal_sha256=None if publication is None else publication.seal_digest,
                    report_validation=None
                    if preparation is None
                    else preparation.anchor.validation,
                ),
            )
    except (ValueError, KeyError, TypeError):
        raise _error(run_id, "ARTIFACT_INTEGRITY_FAILED") from None


def _published_context(
    control: HistoricalControl,
    run_id: str,
) -> tuple[HistoricalTerminalPreparation, ExpectedFiles, HistoricalTerminalPublication]:
    _require_run(control, run_id)
    try:
        with _snapshot(control._store._connection):
            preparation, expected, publication = _publication_metadata(control, run_id)
            if preparation is None or publication is None:
                raise _error(run_id, "ARTIFACT_UNVERIFIED")
            return preparation, expected, publication
    except (ValueError, KeyError, TypeError):
        raise _error(run_id, "ARTIFACT_INTEGRITY_FAILED") from None


def _verified_bytes(
    control: HistoricalControl, run_id: str, path: str, expected: ExpectedFiles
) -> bytes:
    try:
        raw = control.read_artifact(run_id=run_id, relative_path=path)
        size, digest, _ = expected[path]
        if len(raw) != size or sha256(raw).hexdigest() != digest:
            raise HistoricalFinalizationError()
        return raw
    except (ValueError, OSError, KeyError, TypeError):
        raise _error(run_id, "ARTIFACT_INTEGRITY_FAILED") from None


def historical_artifact_index(control: HistoricalControl, run_id: str) -> HistoricalArtifactIndex:
    preparation, expected, publication = _published_context(control, run_id)
    _verified_bytes(control, run_id, "seal.json", expected)
    return HistoricalArtifactIndex(
        run_id=run_id,
        state=publication.state,
        report_validation=preparation.anchor.validation,
        evidence_anchor_sha256=preparation.anchor_sha256,
        seal_sha256=publication.seal_digest,
        observed_at_ns=str(_now(control._store._clock)),
        items=tuple(
            HistoricalArtifactEntry(
                name=name,
                downloadable=path in expected,
                size_bytes=expected[path][0] if path in expected else None,
                sha256=expected[path][1] if path in expected else None,
            )
            for name, path in ARTIFACT_PATHS.items()
        ),
    )


def historical_artifact_bytes(control: HistoricalControl, run_id: str, artifact_name: str) -> bytes:
    name = HistoricalArtifactName(artifact_name)
    _, expected, _ = _published_context(control, run_id)
    path = ARTIFACT_PATHS[name]
    if path not in expected:
        # A diagnostic prefix is "not present" only after the whole root is verified.
        _verified_bytes(control, run_id, "seal.json", expected)
        raise _error(run_id, "ARTIFACT_NOT_PRESENT", status=404)
    return _verified_bytes(control, run_id, path, expected)
