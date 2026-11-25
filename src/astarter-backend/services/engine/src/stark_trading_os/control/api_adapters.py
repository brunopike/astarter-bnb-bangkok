"""Pure adapters from persisted control authority to HTTP DTOs."""

from __future__ import annotations

from collections.abc import Mapping
from hashlib import sha256
from pathlib import PurePosixPath
from typing import Literal, cast

from stark_trading_os.audit.canonical_json import canonical_json_bytes, parse_json_object
from stark_trading_os.control.api_models import (
    ArtifactEntry,
    EventResponse,
    EvidenceProvenanceResponse,
    EvidenceStatus,
    FinalizationFailureEvidence,
    PerformancePointResponse,
    PreflightApiResponse,
    PreflightCheckResponse,
    PreflightEvidenceFactResponse,
    ProcessExitEvidenceResponse,
    PublicArtifactName,
    RunCommandResponse,
    RunEvidenceResponse,
    RunInputEvidenceResponse,
    RunnerFailureEvidence,
    RunPerformanceEvidenceResponse,
    RunResponse,
    SupervisorFailureEvidence,
)
from stark_trading_os.control.preflight import EngineIdentity, PreflightResponse, RunReservation
from stark_trading_os.control.transactions import (
    PersistedCancelRequest,
    PersistedEvent,
    RunEvidenceSnapshot,
    TerminalPublication,
    UnverifiedTerminalPublication,
)
from stark_trading_os.domain.models import CatalogManifestV1, InputManifestV1, RunState
from stark_trading_os.runner.report_export import export_metrics

ARTIFACT_PATHS: Mapping[PublicArtifactName, str] = {
    PublicArtifactName.REQUEST: "request.json",
    PublicArtifactName.PREFLIGHT: "preflight.json",
    PublicArtifactName.INPUT_MANIFEST: "input-manifest.json",
    PublicArtifactName.RUN_RECORD: "run-record.json",
    PublicArtifactName.EVENTS: "events.ndjson",
    PublicArtifactName.AUDIT: "audit.ndjson",
    PublicArtifactName.RUNNER_EXIT: "runner-exit.json",
    PublicArtifactName.STDERR: "stderr.txt",
    PublicArtifactName.ORDERS_REPORT: "reports/orders.json",
    PublicArtifactName.FILLS_REPORT: "reports/fills.json",
    PublicArtifactName.POSITIONS_REPORT: "reports/positions.json",
    PublicArtifactName.ACCOUNT_REPORT: "reports/account.json",
    PublicArtifactName.METRICS_REPORT: "reports/metrics.json",
    PublicArtifactName.SEAL: "seal.json",
}


class RunEvidenceIntegrityError(ValueError):
    """Raised when a RunResponse authority cannot be projected exactly."""


def preflight_response(value: PreflightResponse) -> PreflightApiResponse:
    return PreflightApiResponse(
        preflight_id=value.preflight_id,
        run_id=value.run_id,
        state=cast(Literal["PREFLIGHT_BLOCKED", "PREFLIGHT_READY"], value.state.value),
        state_version=value.state_version,
        canonical_request_hash=value.canonical_request_hash,
        input_manifest_hash=value.input_manifest_hash,
        catalog_revision=value.catalog_revision,
        expires_at=str(value.expires_at_ns),
        checks=tuple(
            PreflightCheckResponse(
                code=check.code,
                passed=check.passed,
                checked_at_ns=str(check.checked_at_ns),
                explanation=check.explanation,
                evidence=tuple(
                    PreflightEvidenceFactResponse(name=fact.name, value=fact.value)
                    for fact in check.evidence
                ),
            )
            for check in value.checks
        ),
    )


def reservation_response(value: RunReservation) -> RunCommandResponse:
    return RunCommandResponse(
        run_id=value.run_id,
        state=value.state,
        state_version=value.state_version,
        last_visible_seq=value.last_visible_seq,
    )


def cancellation_response(value: PersistedCancelRequest) -> RunCommandResponse:
    run_id = value.response.run_id
    if run_id is None:
        raise ValueError("Persisted cancellation response has no run_id.")
    return RunCommandResponse(
        run_id=run_id,
        state=value.state,
        state_version=value.state_version,
        last_visible_seq=value.last_visible_seq,
    )


def run_response(
    evidence_snapshot: RunEvidenceSnapshot,
    *,
    sealed_metrics_bytes: bytes | None,
    control_version: str,
    schema_version: int,
    engine_identity: EngineIdentity,
) -> RunResponse:
    snapshot = evidence_snapshot.run
    _validate_evidence_phase(evidence_snapshot, sealed_metrics_bytes=sealed_metrics_bytes)
    manifest, input_evidence = _input_evidence(evidence_snapshot)
    performance = _performance_evidence(
        evidence_snapshot,
        manifest=manifest,
        sealed_metrics_bytes=sealed_metrics_bytes,
    )
    process_exit, failure = _outcome_evidence(evidence_snapshot)
    input_manifest_engine_version: str | None = None
    input_manifest_engine_commit: str | None = None
    input_manifest_python_version: str | None = None
    input_manifest_precision_mode: str | None = None
    if manifest is not None:
        input_manifest_engine_version = manifest.engine_package_version
        input_manifest_engine_commit = manifest.engine_tag_commit
        input_manifest_python_version = manifest.python_version
        input_manifest_precision_mode = manifest.precision_mode
    return RunResponse(
        run_id=snapshot.run_id,
        state=snapshot.state,
        state_version=snapshot.state_version,
        last_visible_seq=evidence_snapshot.last_visible_seq,
        evidence_status=cast(EvidenceStatus, snapshot.evidence_status),
        created_at_ns=str(snapshot.created_at_ns),
        input_manifest_hash=snapshot.input_manifest_hash,
        catalog_revision=snapshot.catalog_revision,
        control_version=control_version,
        schema_version=schema_version,
        engine_version=engine_identity.package_version,
        engine_commit=engine_identity.tag_commit,
        engine_commit_provenance="LOCKED_RELEASE_PIN",
        python_version=engine_identity.python_version,
        precision_mode=engine_identity.precision_mode,
        input_manifest_engine_version=input_manifest_engine_version,
        input_manifest_engine_commit=input_manifest_engine_commit,
        input_manifest_python_version=input_manifest_python_version,
        input_manifest_precision_mode=input_manifest_precision_mode,
        evidence=RunEvidenceResponse(
            input=input_evidence,
            performance=performance,
            process_exit=process_exit,
            failure=failure,
        ),
    )


def _validate_evidence_phase(
    evidence_snapshot: RunEvidenceSnapshot,
    *,
    sealed_metrics_bytes: bytes | None,
) -> None:
    run = evidence_snapshot.run
    outcome = evidence_snapshot.runner_outcome
    preparation = evidence_snapshot.terminal_preparation
    finalization = evidence_snapshot.terminal_finalization
    if evidence_snapshot.last_visible_seq != run.last_event_seq:
        raise RunEvidenceIntegrityError("Run cursor authority is inconsistent.")
    if run.evidence_status not in {"PENDING", "STAGING", "PARTIAL", "VERIFIED", "UNVERIFIED"}:
        raise RunEvidenceIntegrityError("Run evidence phase is invalid.")

    terminal_states = {RunState.COMPLETED, RunState.FAILED, RunState.CANCELLED}
    if run.state not in terminal_states | {RunState.FINALIZING}:
        if (
            run.evidence_status != "PENDING"
            or outcome is not None
            or preparation is not None
            or finalization is not None
        ):
            raise RunEvidenceIntegrityError("Preterminal run has terminal evidence authority.")
    else:
        if outcome is None or outcome.run_id != run.run_id:
            raise RunEvidenceIntegrityError("Run outcome presence differs from its phase.")
        expected_terminal_state = {
            "NATURAL_SUCCESS": RunState.COMPLETED,
            "NATURAL_FAILURE": RunState.FAILED,
            "NO_SPAWN_CANCELLED": RunState.CANCELLED,
            "SUPERVISOR_FAILURE": RunState.FAILED,
        }.get(outcome.outcome.classification)
        if (
            expected_terminal_state is None
            or outcome.outcome.proposed_terminal_state != expected_terminal_state.value
        ):
            raise RunEvidenceIntegrityError("Runner outcome terminal target is invalid.")

        if run.state is RunState.FINALIZING:
            if finalization is not None:
                raise RunEvidenceIntegrityError("Terminal authority appears before terminal state.")
            if preparation is None:
                if run.evidence_status != "PENDING":
                    raise RunEvidenceIntegrityError("Unprepared finalizing run must be pending.")
            else:
                expected_status = "STAGING" if preparation.failure_attempt_count == 0 else "PARTIAL"
                if (
                    preparation.run_id != run.run_id
                    or preparation.outcome != outcome
                    or preparation.disposition != "NORMAL"
                    or preparation.terminal_state is not expected_terminal_state
                    or preparation.terminal_state_version != run.state_version + 1
                    or preparation.event.run_id != run.run_id
                    or preparation.event.seq != run.last_event_seq + 1
                    or preparation.audit_intent.run_id != run.run_id
                    or preparation.audit_intent.event_seq != preparation.event.seq
                    or preparation.failure_attempt_count not in {0, 1, 2}
                    or run.evidence_status != expected_status
                ):
                    raise RunEvidenceIntegrityError(
                        "Staged evidence has an invalid terminal phase."
                    )
        else:
            if preparation is None or finalization is None:
                raise RunEvidenceIntegrityError("Terminal run lacks complete terminal authority.")
            if (
                preparation.run_id != run.run_id
                or preparation.outcome != outcome
                or preparation.terminal_state_version != run.state_version
                or preparation.event.run_id != run.run_id
                or preparation.audit_intent.run_id != run.run_id
                or finalization.run_id != run.run_id
                or finalization.state is not run.state
                or finalization.state_version != run.state_version
                or finalization.event.run_id != run.run_id
                or finalization.event.seq != run.last_event_seq
                or finalization.audit_intent.run_id != run.run_id
                or finalization.audit_intent.audit_seq != run.last_audit_seq
            ):
                raise RunEvidenceIntegrityError("Terminal authority identity is inconsistent.")
            if run.evidence_status == "VERIFIED":
                if (
                    type(finalization) is not TerminalPublication
                    or preparation.disposition != "NORMAL"
                    or preparation.terminal_state is not expected_terminal_state
                    or run.state is not expected_terminal_state
                ):
                    raise RunEvidenceIntegrityError(
                        "Verified run lacks verified terminal authority."
                    )
            elif run.evidence_status == "UNVERIFIED":
                if (
                    type(finalization) is not UnverifiedTerminalPublication
                    or run.state is not RunState.FAILED
                    or preparation.disposition != "FAULT_CONVERTED"
                    or preparation.terminal_state is not RunState.FAILED
                    or preparation.failure_attempt_count != 3
                ):
                    raise RunEvidenceIntegrityError(
                        "Unverified run lacks finalizer fault authority."
                    )
            else:
                raise RunEvidenceIntegrityError("Terminal run has a nonterminal evidence phase.")
    if run.evidence_status != "VERIFIED" and sealed_metrics_bytes is not None:
        raise RunEvidenceIntegrityError("Unverified run cannot expose sealed metrics.")


def _input_evidence(
    evidence_snapshot: RunEvidenceSnapshot,
) -> tuple[InputManifestV1 | None, RunInputEvidenceResponse]:
    run = evidence_snapshot.run
    identity = (
        run.input_manifest_bytes,
        run.input_manifest_hash,
        run.catalog_revision,
        run.catalog_inventory_hash,
    )
    if all(value is None for value in identity):
        if run.state not in {RunState.DRAFT, RunState.PREFLIGHT_BLOCKED}:
            raise RunEvidenceIntegrityError("Run phase requires committed input evidence.")
        if evidence_snapshot.catalog_publication is not None:
            raise RunEvidenceIntegrityError("Unbound run unexpectedly has catalog evidence.")
        return None, RunInputEvidenceResponse(
            completeness="UNAVAILABLE",
            unavailable_reason="INPUT_MANIFEST_NOT_COMMITTED",
            fixture_id=None,
            fixture_label=None,
            strategy_id=None,
            strategy_version=None,
            instrument_ids=(),
            window_start_ns=None,
            window_end_ns=None,
            timezone=None,
            provenance=None,
        )
    if any(value is None for value in identity) or run.state is RunState.PREFLIGHT_BLOCKED:
        raise RunEvidenceIntegrityError("Run input authority is partial or phase-invalid.")
    assert run.input_manifest_bytes is not None
    assert run.input_manifest_hash is not None
    assert run.catalog_revision is not None
    assert run.catalog_inventory_hash is not None
    publication = evidence_snapshot.catalog_publication
    if publication is None or publication.status != "PUBLISHED":
        raise RunEvidenceIntegrityError("Run catalog evidence is not published.")
    try:
        manifest_value = parse_json_object(run.input_manifest_bytes)
        manifest = InputManifestV1.model_validate(manifest_value)
        catalog_value = parse_json_object(publication.publication_bytes)
        catalog = CatalogManifestV1.model_validate(catalog_value)
    except Exception as error:
        raise RunEvidenceIntegrityError("Run input evidence is not schema-valid.") from error
    if (
        canonical_json_bytes(manifest.model_dump(mode="json", by_alias=True))
        != run.input_manifest_bytes
        or sha256(run.input_manifest_bytes).hexdigest() != run.input_manifest_hash
        or canonical_json_bytes(catalog.model_dump(mode="json", by_alias=True))
        != publication.publication_bytes
        or sha256(publication.publication_bytes).hexdigest() != run.catalog_revision
        or publication.catalog_revision != run.catalog_revision
        or publication.inventory_hash != run.catalog_inventory_hash
        or catalog.inventory_hash != run.catalog_inventory_hash
        or manifest.catalog_revision != run.catalog_revision
        or manifest.fixture_id != publication.fixture_id
        or catalog.fixture_id != publication.fixture_id
        or manifest.source_checksum != catalog.source_checksum
        or manifest.catalog_checksum != catalog.catalog_checksum
    ):
        raise RunEvidenceIntegrityError("Run input and catalog evidence does not bind exactly.")
    return manifest, RunInputEvidenceResponse(
        completeness="COMPLETE",
        unavailable_reason=None,
        fixture_id=manifest.fixture_id,
        fixture_label=catalog.label,
        strategy_id=manifest.strategy_id,
        strategy_version=manifest.strategy_version,
        instrument_ids=tuple(item.instrument_id for item in manifest.instruments),
        window_start_ns=manifest.window.start_ns,
        window_end_ns=manifest.window.end_ns,
        timezone=manifest.timezone,
        provenance=EvidenceProvenanceResponse(
            authority="CONTROL_SQLITE_INPUT_MANIFEST_AND_CATALOG",
            artifact_name=None,
            evidence_id=run.input_manifest_hash,
            seal_digest=None,
        ),
    )


def _unavailable_performance(
    reason: Literal[
        "RUN_NOT_VERIFIED",
        "METRICS_ARTIFACT_NOT_SEALED",
        "LEGACY_METRICS_SERIES_ABSENT",
    ],
) -> RunPerformanceEvidenceResponse:
    return RunPerformanceEvidenceResponse(
        completeness="UNAVAILABLE",
        unavailable_reason=reason,
        series_schema=None,
        source=None,
        selection=None,
        calculation=None,
        timestamp_unit="UNIX_EPOCH_NS",
        equity_unit="ACCOUNT_CURRENCY",
        drawdown_unit="PERCENT",
        account_id=None,
        currency=None,
        points=(),
        provenance=None,
    )


def _performance_evidence(
    evidence_snapshot: RunEvidenceSnapshot,
    *,
    manifest: InputManifestV1 | None,
    sealed_metrics_bytes: bytes | None,
) -> RunPerformanceEvidenceResponse:
    run = evidence_snapshot.run
    if run.evidence_status != "VERIFIED":
        return _unavailable_performance("RUN_NOT_VERIFIED")
    publication = evidence_snapshot.terminal_finalization
    if type(publication) is not TerminalPublication:
        raise RunEvidenceIntegrityError("Verified performance lacks terminal publication.")
    if sealed_metrics_bytes is None:
        if run.state is RunState.COMPLETED:
            raise RunEvidenceIntegrityError("Completed run lacks sealed metrics evidence.")
        return _unavailable_performance("METRICS_ARTIFACT_NOT_SEALED")
    try:
        parsed = parse_json_object(sealed_metrics_bytes)
        normalized = export_metrics(parsed)
        if canonical_json_bytes(normalized) != sealed_metrics_bytes:
            raise ValueError("Metrics bytes are not their exact normalized projection.")
    except Exception as error:
        raise RunEvidenceIntegrityError("Sealed metrics evidence is invalid.") from error
    raw_series = normalized.get("performance_series")
    if raw_series is None:
        return _unavailable_performance("LEGACY_METRICS_SERIES_ABSENT")
    if manifest is None or not isinstance(raw_series, Mapping):
        raise RunEvidenceIntegrityError("Performance has no committed input binding.")
    if raw_series["currency"] != manifest.venue_account_model.currency:
        raise RunEvidenceIntegrityError("Performance currency differs from the input manifest.")
    raw_points = raw_series["points"]
    if type(raw_points) is not list:
        raise RunEvidenceIntegrityError("Performance points are invalid.")
    points = tuple(PerformancePointResponse.model_validate(point) for point in raw_points)
    return RunPerformanceEvidenceResponse(
        completeness="COMPLETE",
        unavailable_reason=None,
        series_schema=cast(Literal["PortfolioEquitySeries.v1"], raw_series["schema"]),
        source=cast(Literal["NAUTILUS_PORTFOLIO_SNAPSHOTS"], raw_series["source"]),
        selection=cast(Literal["SOLE_TOTAL_EQUITY"], raw_series["selection"]),
        calculation=cast(
            Literal["RUNNING_PEAK_DRAWDOWN_PERCENT_V1"],
            raw_series["calculation"],
        ),
        timestamp_unit="UNIX_EPOCH_NS",
        equity_unit="ACCOUNT_CURRENCY",
        drawdown_unit="PERCENT",
        account_id=cast(str, raw_series["account_id"]),
        currency=cast(str, raw_series["currency"]),
        points=points,
        provenance=EvidenceProvenanceResponse(
            authority="SEALED_METRICS_ARTIFACT",
            artifact_name="metrics_report",
            evidence_id=sha256(sealed_metrics_bytes).hexdigest(),
            seal_digest=publication.seal_digest,
        ),
    )


def _outcome_evidence(
    evidence_snapshot: RunEvidenceSnapshot,
) -> tuple[
    ProcessExitEvidenceResponse | None,
    RunnerFailureEvidence | SupervisorFailureEvidence | FinalizationFailureEvidence | None,
]:
    record = evidence_snapshot.runner_outcome
    if record is None:
        return None, None
    outcome = record.outcome
    provenance = EvidenceProvenanceResponse(
        authority="CONTROL_SQLITE_RUNNER_OUTCOME",
        artifact_name=None,
        evidence_id=record.outcome_hash,
        seal_digest=None,
    )
    process_exit = ProcessExitEvidenceResponse(
        classification=outcome.classification,
        supervisor_failure_code=outcome.failure_code,
        exit_code=outcome.exit_code,
        signal=outcome.signal,
        ended_at_ns=str(outcome.ended_at_ns),
        duration_ns=str(outcome.duration_ns),
        final_cancel_phase=outcome.final_cancel_phase,
        stderr_sha256=outcome.stderr_sha256,
        stderr_truncated=outcome.stderr_truncated,
        provenance=provenance,
    )
    if evidence_snapshot.run.state is not RunState.FAILED:
        return process_exit, None
    finalization = evidence_snapshot.terminal_finalization
    if type(finalization) is UnverifiedTerminalPublication:
        fault = finalization.fault
        try:
            value = parse_json_object(fault.fault_bytes)
            if canonical_json_bytes(value) != fault.fault_bytes:
                raise ValueError("Finalization fault bytes are not canonical.")
        except Exception as error:
            raise RunEvidenceIntegrityError("Finalization fault is invalid.") from error
        return process_exit, FinalizationFailureEvidence(
            source="FINALIZER",
            category=fault.category,
            stage=fault.stage,
            attempt_count=3,
            observed_at_ns=str(fault.recorded_at_ns),
            outcome_hash=cast(str, value["outcome_hash"]),
            initial_event_digest=cast(str, value["initial_event_digest"]),
            provenance=EvidenceProvenanceResponse(
                authority="CONTROL_SQLITE_FINALIZATION_FAULT",
                artifact_name=None,
                evidence_id=fault.fault_hash,
                seal_digest=None,
            ),
        )
    if outcome.classification == "NATURAL_FAILURE":
        child = outcome.child_outcome
        if child is None or child.failure is None:
            raise RunEvidenceIntegrityError("Natural failure lacks runner failure evidence.")
        return process_exit, RunnerFailureEvidence(
            source="RUNNER",
            code=child.failure.code,
            message=child.failure.message,
            provenance=provenance,
        )
    if outcome.classification == "SUPERVISOR_FAILURE":
        if outcome.failure_code is None:
            raise RunEvidenceIntegrityError("Supervisor failure lacks a closed code.")
        return process_exit, SupervisorFailureEvidence(
            source="SUPERVISOR",
            code=outcome.failure_code,
            provenance=provenance,
        )
    raise RunEvidenceIntegrityError("Failed run has no causal failure evidence.")


def event_response(event: PersistedEvent) -> EventResponse:
    envelope = parse_json_object(event.envelope_bytes)
    payload = envelope.get("payload")
    schema_version = envelope.get("schema_version")
    if type(payload) is not dict or type(schema_version) is not int:
        raise ValueError("Persisted event envelope has an invalid HTTP projection.")
    return EventResponse(
        event_id=event.event_id,
        run_id=event.run_id,
        seq=event.seq,
        source_seq=event.source_seq,
        source=event.source,
        type=event.type,
        ts_event_ns=event.ts_event_ns,
        ts_ingest_ns=event.ts_ingest_ns,
        schema_version=schema_version,
        payload=cast(dict[str, object], payload),
    )


def artifact_entries(
    *,
    evidence_status: str,
    sealed_paths: frozenset[str] = frozenset(),
) -> tuple[ArtifactEntry, ...]:
    if evidence_status not in {"PENDING", "STAGING", "PARTIAL", "VERIFIED", "UNVERIFIED"}:
        raise ValueError("Persisted evidence status is invalid.")
    result: list[ArtifactEntry] = []
    for name, relative_path in ARTIFACT_PATHS.items():
        path = PurePosixPath(relative_path)
        if path.is_absolute() or ".." in path.parts:
            raise RuntimeError("Artifact allowlist contains an unsafe path.")
        downloadable = evidence_status == "VERIFIED" and relative_path in sealed_paths
        result.append(
            ArtifactEntry(
                name=name,
                downloadable=downloadable,
            )
        )
    return tuple(result)


def parse_nonnegative_cursor(value: str) -> int:
    if not value or not value.isascii() or not value.isdecimal():
        raise ValueError("CURSOR_INVALID")
    parsed = int(value)
    if parsed < 0:
        raise ValueError("CURSOR_INVALID")
    return parsed
