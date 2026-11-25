"""Backtest preflight, command, state, and persisted event routes."""

from __future__ import annotations

import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request, Response

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.control.admission import HistoricalCapacityBusy
from stark_trading_os.control.api_adapters import (
    RunEvidenceIntegrityError,
    cancellation_response,
    event_response,
    parse_nonnegative_cursor,
    preflight_response,
    reservation_response,
    run_response,
)
from stark_trading_os.control.api_models import (
    ApiError,
    CancelRequest,
    CreateBacktestRequest,
    EventPage,
    PreflightApiResponse,
    RunCommandResponse,
    RunResponse,
)
from stark_trading_os.control.dependencies import (
    CONTROL_SCHEMA_VERSION,
    ControlDependencies,
    control_package_version,
    engine_identity_check,
    get_dependencies,
)
from stark_trading_os.control.preflight import PreflightStale
from stark_trading_os.control.recovery import ArtifactAccessDenied, ArtifactIntegrityError
from stark_trading_os.control.registry import (
    ControlStoreError,
    EventRejected,
    IdempotencyConflict,
    RunNotFound,
    VersionConflict,
)
from stark_trading_os.control.run_contract import RunContractMismatch, require_probe_contract
from stark_trading_os.control.security import raw_header_values
from stark_trading_os.control.transactions import IdempotencyCommand
from stark_trading_os.domain.errors import StateConflict
from stark_trading_os.domain.models import BacktestDraftRequest, ErrorResponse

router = APIRouter(prefix="/v1/backtests", tags=["backtests"])
Dependencies = Annotated[ControlDependencies, Depends(get_dependencies)]
IdempotencyKey = Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=256)]


@router.post(
    "/preflight",
    response_model=PreflightApiResponse,
    responses={
        409: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
async def preflight(
    request: BacktestDraftRequest,
    http_request: Request,
    idempotency_key: IdempotencyKey,
    dependencies: Dependencies,
) -> PreflightApiResponse:
    idempotency_key = _require_idempotency_key(http_request, idempotency_key)
    failed_check = engine_identity_check(dependencies.engine_identity)
    if failed_check is not None:
        raise ApiError(
            status_code=503,
            code="ENGINE_VERSION_MISMATCH",
            message="Preflight is blocked by the installed engine identity.",
            details={"check": failed_check},
        )
    try:
        result = dependencies.preflight.run(request, idempotency_key)
    except IdempotencyConflict as error:
        raise ApiError(
            status_code=409,
            code="IDEMPOTENCY_CONFLICT",
            message="The idempotency key is bound to another preflight request.",
        ) from error
    return preflight_response(result)


@router.post(
    "",
    response_model=RunCommandResponse,
    status_code=202,
    responses={409: {"model": ErrorResponse}, 422: {"model": ErrorResponse}},
)
async def create_backtest(
    request: CreateBacktestRequest,
    http_request: Request,
    idempotency_key: IdempotencyKey,
    dependencies: Dependencies,
) -> RunCommandResponse:
    idempotency_key = _require_idempotency_key(http_request, idempotency_key)
    request_bytes = canonical_json_bytes(
        {
            "canonical_request_hash": request.canonical_request_hash,
            "preflight_id": request.preflight_id,
        }
    )
    command = IdempotencyCommand.create(
        key=idempotency_key,
        canonical_request_bytes=request_bytes,
    )
    try:
        replay = dependencies.store.idempotent_response(command) is not None
        reservation = dependencies.preflight.consume_ready(
            request.preflight_id,
            request.canonical_request_hash,
            idempotency_key,
        )
    except HistoricalCapacityBusy as error:
        raise ApiError(
            status_code=409,
            code="HISTORICAL_CAPACITY_BUSY",
            message="Execution capacity is busy. Retry while the preflight remains valid.",
            retryable=True,
        ) from error
    except PreflightStale as error:
        raise ApiError(
            status_code=409,
            code="PREFLIGHT_STALE",
            message="The ready preflight is missing, expired, consumed, or no longer current.",
        ) from error
    except IdempotencyConflict as error:
        raise ApiError(
            status_code=409,
            code="IDEMPOTENCY_CONFLICT",
            message="The idempotency key is bound to another create request.",
        ) from error
    if replay:
        dependencies.scheduler.reconcile_run(reservation.run_id)
    else:
        dependencies.scheduler.schedule_run(reservation)
    return reservation_response(reservation)


@router.get(
    "/{run_id}",
    response_model=RunResponse,
    responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
)
async def get_backtest(run_id: str, dependencies: Dependencies) -> RunResponse:
    try:
        snapshot = dependencies.store.run_evidence_snapshot(run_id)
        sealed_metrics_bytes: bytes | None = None
        if snapshot.run.evidence_status == "VERIFIED":
            try:
                sealed_metrics_bytes = dependencies.recovery.read_artifact(
                    run_id=run_id,
                    relative_path="reports/metrics.json",
                )
            except ArtifactAccessDenied:
                pass
        return run_response(
            snapshot,
            sealed_metrics_bytes=sealed_metrics_bytes,
            control_version=control_package_version(),
            schema_version=CONTROL_SCHEMA_VERSION,
            engine_identity=dependencies.engine_identity,
        )
    except RunNotFound as error:
        raise _run_unknown(run_id) from error
    except (
        ArtifactIntegrityError,
        ControlStoreError,
        RunEvidenceIntegrityError,
        sqlite3.Error,
        ValueError,
    ) as error:
        raise ApiError(
            status_code=409,
            code="RUN_EVIDENCE_INTEGRITY_FAILED",
            message="The run evidence failed authoritative integrity verification.",
            run_id=run_id,
        ) from error


@router.post(
    "/{run_id}/cancel",
    response_model=RunCommandResponse,
    status_code=202,
    responses={
        200: {"model": RunCommandResponse},
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
    },
)
async def cancel_backtest(
    run_id: str,
    request: CancelRequest,
    http_request: Request,
    response: Response,
    idempotency_key: IdempotencyKey,
    dependencies: Dependencies,
) -> RunCommandResponse:
    idempotency_key = _require_idempotency_key(http_request, idempotency_key)
    try:
        require_probe_contract(dependencies.store.run(run_id).contract_kind)
        decision = dependencies.cancellation.request(
            run_id=run_id,
            idempotency_key=idempotency_key,
            reason=request.reason,
        )
    except RunNotFound as error:
        raise _run_unknown(run_id) from error
    except RunContractMismatch as error:
        raise ApiError(
            status_code=409,
            code="RUN_CONTRACT_UNSUPPORTED",
            message="This endpoint does not support the run contract.",
            run_id=run_id,
        ) from error
    except IdempotencyConflict as error:
        raise ApiError(
            status_code=409,
            code="IDEMPOTENCY_CONFLICT",
            message="The idempotency key is bound to another cancel request.",
            run_id=run_id,
        ) from error
    except (EventRejected, VersionConflict, StateConflict, ControlStoreError) as error:
        raise ApiError(
            status_code=409,
            code="STATE_CONFLICT",
            message="The run cannot accept cancellation in its persisted state.",
            run_id=run_id,
        ) from error
    if not decision.created_by_caller:
        dependencies.scheduler.reconcile_run(run_id)
    elif decision.clean_no_claim or decision.signal_required:
        dependencies.scheduler.schedule_cancel(decision)
    response.status_code = decision.response.status_code
    return cancellation_response(decision)


@router.get(
    "/{run_id}/events",
    response_model=EventPage,
    responses={404: {"model": ErrorResponse}, 422: {"model": ErrorResponse}},
)
async def get_events(
    run_id: str,
    dependencies: Dependencies,
    after_seq: str = Query(default="0"),
    limit: int = Query(default=100, ge=1, le=500),
) -> EventPage:
    try:
        cursor = parse_nonnegative_cursor(after_seq)
    except ValueError as error:
        raise _cursor_invalid(run_id, "The event cursor is malformed or negative.") from error
    try:
        events = dependencies.store.events(run_id)
    except RunNotFound as error:
        raise _run_unknown(run_id) from error
    tail = events[-1].seq if events else 0
    if cursor > tail:
        raise _cursor_invalid(run_id, "The event cursor is above the visible SQLite tail.")
    page = tuple(event for event in events if event.seq > cursor)[:limit]
    return EventPage(
        run_id=run_id,
        items=tuple(event_response(event) for event in page),
        next_after_seq=page[-1].seq if page else cursor,
    )


def _run_unknown(run_id: str) -> ApiError:
    return ApiError(
        status_code=404,
        code="RUN_UNKNOWN",
        message="The run ID is not registered.",
        run_id=run_id,
    )


def _cursor_invalid(run_id: str, message: str) -> ApiError:
    return ApiError(
        status_code=422,
        code="CURSOR_INVALID",
        message=message,
        run_id=run_id,
    )


def _require_idempotency_key(request: Request, parsed_value: str) -> str:
    values = raw_header_values(request, "Idempotency-Key")
    if len(values) != 1 or not values[0] or len(values[0]) > 256:
        raise ApiError(
            status_code=422,
            code="REQUEST_INVALID",
            message="Idempotency-Key must be one non-empty value.",
        )
    if values[0] != parsed_value:
        raise ApiError(
            status_code=422,
            code="REQUEST_INVALID",
            message="Idempotency-Key parsing is ambiguous.",
        )
    return values[0]
