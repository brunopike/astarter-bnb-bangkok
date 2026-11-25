"""Opt-in historical HTTP adapter; the existing Control graph owns all work."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request, Response

from stark_trading_os.catalog.historical_catalog import canonical_historical_bytes
from stark_trading_os.control.admission import HistoricalCapacityBusy
from stark_trading_os.control.api_adapters import event_response, parse_nonnegative_cursor
from stark_trading_os.control.api_models import (
    ApiError,
    CancelRequest,
    EventPage,
    RunCommandResponse,
)
from stark_trading_os.control.dependencies import (
    ApiCommandScheduler,
    ControlDependencies,
    engine_identity_check,
)
from stark_trading_os.control.historical_api_adapters import (
    historical_artifact_bytes,
    historical_artifact_index,
    historical_preflight_status,
    historical_run_response,
)
from stark_trading_os.control.historical_api_models import (
    HistoricalArtifactIndex,
    HistoricalArtifactName,
    HistoricalCapabilitiesResponse,
    HistoricalCatalogPage,
    HistoricalCatalogResponse,
    HistoricalConfigurationPage,
    HistoricalDraftPage,
    HistoricalPreflightId,
    HistoricalPreflightRequest,
    HistoricalPreflightStatus,
    HistoricalReportSummary,
    HistoricalRunId,
    HistoricalRunResponse,
    HistoricalStartRequest,
    HistoricalStartResponse,
    HistoricalStrategyDefinition,
    HistoricalStrategyDefinitionList,
    HistoricalUpdateDraftRequest,
)
from stark_trading_os.control.historical_catalog_reads import (
    historical_catalog_detail,
    historical_catalog_page,
)
from stark_trading_os.control.historical_configuration_models import (
    HistoricalStrategyConfigurationVersionV2,
    HistoricalStrategyDraftV2,
)
from stark_trading_os.control.historical_configuration_service import HistoricalInputCandidateError
from stark_trading_os.control.historical_control import HistoricalControl
from stark_trading_os.control.historical_preflight import (
    HistoricalPreflightInvalid,
    HistoricalPreflightReceiptV2,
    HistoricalPreflightStale,
)
from stark_trading_os.control.historical_report_summary import historical_report_summary
from stark_trading_os.control.registry import (
    ControlStoreError,
    IdempotencyConflict,
    RunNotFound,
)
from stark_trading_os.control.run_contract import RunContractMismatch, require_historical_contract
from stark_trading_os.control.security import raw_header_values
from stark_trading_os.control.strategy_configurations import (
    StrategyConfigurationError,
    StrategyConfigurationStorageError,
    StrategyConfigurationUnknown,
    StrategyDraftUnknown,
    StrategyRevisionConflict,
)
from stark_trading_os.control.strategy_models import (
    PublishStrategyDraftRequest,
    StrategyConfigurationId,
    StrategyDraftId,
)
from stark_trading_os.domain.historical_input import Digest, SmaConfigurationInputV2
from stark_trading_os.domain.models import ErrorResponse, RunState

router = APIRouter(
    prefix="/v2/historical",
    tags=["historical"],
    responses={status: {"model": ErrorResponse} for status in (404, 409, 422, 503)},
)


def _error(status: int, code: str) -> ApiError:
    return ApiError(status_code=status, code=code, message=code)


async def _enabled_dependencies(request: Request) -> ControlDependencies:
    dependencies = getattr(request.app.state, "control_dependencies", None)
    if type(dependencies) is not ControlDependencies or dependencies.historical is None:
        raise _error(503, "CAPABILITY_DISABLED")
    return dependencies


Dependencies = Annotated[ControlDependencies, Depends(_enabled_dependencies)]
IdempotencyKey = Annotated[
    str, Header(alias="Idempotency-Key", min_length=1, max_length=128, pattern=r"^[!-~]+$")
]


@router.get("/strategies", response_model=HistoricalStrategyDefinitionList)
async def historical_strategies(_dependencies: Dependencies) -> HistoricalStrategyDefinitionList:
    return HistoricalStrategyDefinitionList(items=(HistoricalStrategyDefinition(),))


@router.get("/catalogs", response_model=HistoricalCatalogPage)
async def historical_catalogs(
    dependencies: Dependencies,
    after_revision: Digest | None = None,
    limit: int = Query(default=20, ge=1, le=100),
) -> HistoricalCatalogPage:
    return historical_catalog_page(dependencies.store, after_revision=after_revision, limit=limit)


@router.get("/catalogs/{catalog_revision}", response_model=HistoricalCatalogResponse)
async def historical_catalog(
    catalog_revision: Digest, dependencies: Dependencies
) -> HistoricalCatalogResponse:
    return historical_catalog_detail(dependencies.store, catalog_revision)


def _control(dependencies: ControlDependencies) -> HistoricalControl:
    assert dependencies.historical is not None
    return dependencies.historical


def _command_scheduler(
    dependencies: ControlDependencies, *, needs_engine: bool = False
) -> ApiCommandScheduler:
    scheduler = dependencies.scheduler
    if type(scheduler) is not ApiCommandScheduler or scheduler.command_unavailable_reason():
        raise _error(503, "CONTROL_UNAVAILABLE")
    if needs_engine and engine_identity_check(dependencies.engine_identity) is not None:
        raise _error(503, "ENGINE_VERSION_MISMATCH")
    return scheduler


def _key(request: Request, parsed: str) -> str:
    values = raw_header_values(request, "Idempotency-Key")
    if len(values) != 1 or values[0] != parsed:
        raise _error(422, "REQUEST_INVALID")
    return parsed


def _configuration_command(request: Request, dependencies: ControlDependencies) -> None:
    _command_scheduler(dependencies)
    # Configuration services use revision CAS, not a generic command receipt.
    if raw_header_values(request, "Idempotency-Key"):
        raise _error(422, "REQUEST_INVALID")


@contextmanager
def _mapped_errors() -> Iterator[None]:
    try:
        yield
    except RunNotFound:
        raise _error(404, "RUN_UNKNOWN") from None
    except (StrategyConfigurationUnknown, StrategyDraftUnknown):
        raise _error(404, "CONFIGURATION_UNKNOWN") from None
    except RunContractMismatch:
        raise _error(409, "RUN_CONTRACT_UNSUPPORTED") from None
    except IdempotencyConflict:
        raise _error(409, "IDEMPOTENCY_CONFLICT") from None
    except HistoricalPreflightStale:
        raise _error(409, "HISTORICAL_PREFLIGHT_STALE") from None
    except HistoricalCapacityBusy:
        raise _error(409, "HISTORICAL_CAPACITY_BUSY") from None
    except StrategyRevisionConflict:
        raise _error(409, "CONFIGURATION_REVISION_CONFLICT") from None
    except StrategyConfigurationStorageError:
        raise _error(503, "CONTROL_UNAVAILABLE") from None
    except (HistoricalPreflightInvalid, HistoricalInputCandidateError, StrategyConfigurationError):
        raise _error(409, "HISTORICAL_INPUT_CANDIDATE_INVALID") from None
    except ControlStoreError:
        raise _error(409, "STATE_CONFLICT") from None
    except (sqlite3.Error, OSError):
        raise _error(503, "CONTROL_UNAVAILABLE") from None


@router.get("/capabilities", response_model=HistoricalCapabilitiesResponse)
async def capabilities(request: Request) -> HistoricalCapabilitiesResponse:
    dependencies = getattr(request.app.state, "control_dependencies", None)
    return HistoricalCapabilitiesResponse(
        enabled=type(dependencies) is ControlDependencies and dependencies.historical is not None
    )


@router.get("/configuration-drafts", response_model=HistoricalDraftPage)
async def drafts(
    dependencies: Dependencies,
    after_id: StrategyDraftId | None = None,
    limit: int = Query(default=50, ge=1, le=100),
) -> HistoricalDraftPage:
    with _mapped_errors():
        items, cursor = _control(dependencies)._preflights._configurations.draft_page(
            after_id=after_id, limit=limit
        )
        return HistoricalDraftPage(items=items, next_cursor=cursor)


@router.post("/configuration-drafts", response_model=HistoricalStrategyDraftV2, status_code=201)
async def create_draft(
    request: SmaConfigurationInputV2, http_request: Request, dependencies: Dependencies
) -> HistoricalStrategyDraftV2:
    _configuration_command(http_request, dependencies)
    with _mapped_errors():
        return _control(dependencies)._preflights._configurations.create_draft(request)


@router.get("/configuration-drafts/{draft_id}", response_model=HistoricalStrategyDraftV2)
async def draft(draft_id: StrategyDraftId, dependencies: Dependencies) -> HistoricalStrategyDraftV2:
    with _mapped_errors():
        return _control(dependencies)._preflights._configurations.draft(draft_id)


@router.put("/configuration-drafts/{draft_id}", response_model=HistoricalStrategyDraftV2)
async def update_draft(
    draft_id: StrategyDraftId,
    request: HistoricalUpdateDraftRequest,
    http_request: Request,
    dependencies: Dependencies,
) -> HistoricalStrategyDraftV2:
    _configuration_command(http_request, dependencies)
    configuration = SmaConfigurationInputV2.model_validate(
        request.model_dump(exclude={"expected_revision"})
    )
    with _mapped_errors():
        return _control(dependencies)._preflights._configurations.update_draft(
            draft_id=draft_id,
            expected_revision=request.expected_revision,
            configuration=configuration,
        )


@router.post(
    "/configuration-drafts/{draft_id}/publish",
    response_model=HistoricalStrategyConfigurationVersionV2,
)
async def publish_draft(
    draft_id: StrategyDraftId,
    request: PublishStrategyDraftRequest,
    http_request: Request,
    dependencies: Dependencies,
) -> HistoricalStrategyConfigurationVersionV2:
    _configuration_command(http_request, dependencies)
    with _mapped_errors():
        return _control(dependencies)._preflights._configurations.publish_draft(
            draft_id=draft_id, expected_revision=request.expected_revision
        )


@router.get("/configurations", response_model=HistoricalConfigurationPage)
async def configurations(
    dependencies: Dependencies,
    after_id: StrategyConfigurationId | None = None,
    limit: int = Query(default=50, ge=1, le=100),
) -> HistoricalConfigurationPage:
    with _mapped_errors():
        items, cursor = _control(dependencies)._preflights._configurations.configuration_page(
            after_id=after_id, limit=limit
        )
        return HistoricalConfigurationPage(items=items, next_cursor=cursor)


@router.get(
    "/configurations/{configuration_id}", response_model=HistoricalStrategyConfigurationVersionV2
)
async def configuration(
    configuration_id: StrategyConfigurationId, dependencies: Dependencies
) -> HistoricalStrategyConfigurationVersionV2:
    with _mapped_errors():
        return _control(dependencies)._preflights._configurations.configuration(configuration_id)


@router.post("/preflights", response_model=HistoricalPreflightReceiptV2)
async def preflight(
    request: HistoricalPreflightRequest,
    http_request: Request,
    idempotency_key: IdempotencyKey,
    dependencies: Dependencies,
) -> Response:
    key = _key(http_request, idempotency_key)
    _command_scheduler(dependencies, needs_engine=True)
    control = _control(dependencies)
    with _mapped_errors():
        control._preflights._configurations.configuration(request.configuration_id)
        receipt = control.preflight(configuration_id=request.configuration_id, idempotency_key=key)
        return Response(content=canonical_historical_bytes(receipt), media_type="application/json")


@router.get("/preflights/{preflight_id}", response_model=HistoricalPreflightStatus)
async def preflight_status(
    preflight_id: HistoricalPreflightId, dependencies: Dependencies
) -> HistoricalPreflightStatus:
    with _mapped_errors():
        return historical_preflight_status(_control(dependencies), preflight_id)


@router.post("/runs", response_model=HistoricalStartResponse, status_code=202)
async def start(
    request: HistoricalStartRequest,
    http_request: Request,
    idempotency_key: IdempotencyKey,
    dependencies: Dependencies,
) -> Response:
    key = _key(http_request, idempotency_key)
    scheduler = _command_scheduler(dependencies, needs_engine=True)
    control = _control(dependencies)
    with _mapped_errors():
        if control._preflights.record(request.preflight_id) is None:
            raise _error(404, "PREFLIGHT_UNKNOWN")
        reservation = control.reserve(
            preflight_id=request.preflight_id,
            request_sha256=request.request_sha256,
            idempotency_key=key,
        )
        # reserve() already validates the original receipt against the original
        # consumed admission. Return that stored queue receipt, never current state.
        row = dependencies.store._connection.execute(
            "SELECT response_status,response_body FROM idempotency_records "
            "WHERE idempotency_scope='historical.create' AND idempotency_key=?",
            (key,),
        ).fetchone()
        expected = canonical_historical_bytes(
            HistoricalStartResponse(
                run_id=reservation.run_id,
                state="QUEUED",
                state_version=2,
                last_visible_seq=2,
                input_manifest_hash=reservation.input_manifest_hash,
            )
        )
        if row is None or row["response_status"] != 202 or row["response_body"] != expected:
            raise HistoricalPreflightInvalid()
        scheduler.schedule_historical_run(reservation.run_id)
        return Response(
            content=row["response_body"], status_code=202, media_type="application/json"
        )


@router.post(
    "/runs/{run_id}/cancel",
    response_model=RunCommandResponse,
    status_code=202,
    responses={200: {"model": RunCommandResponse}},
)
async def cancel(
    run_id: HistoricalRunId,
    request: CancelRequest,
    http_request: Request,
    idempotency_key: IdempotencyKey,
    dependencies: Dependencies,
) -> Response:
    key = _key(http_request, idempotency_key)
    scheduler = _command_scheduler(dependencies)
    with _mapped_errors():
        snapshot = dependencies.store.run(run_id)
        require_historical_contract(snapshot.contract_kind)
        if snapshot.state is RunState.PREFLIGHT_READY:
            raise _error(409, "STATE_CONFLICT")
        _control(dependencies)._preflights.record_for_run(run_id)
        decision = dependencies.cancellation.request(
            run_id=run_id,
            idempotency_key=key,
            reason=request.reason,
        )
        scheduler.schedule_historical_cancel(decision)
        return Response(
            content=decision.response.body,
            status_code=decision.response.status_code,
            media_type="application/json",
        )


@router.get("/runs/{run_id}", response_model=HistoricalRunResponse)
async def run(run_id: HistoricalRunId, dependencies: Dependencies) -> HistoricalRunResponse:
    with _mapped_errors():
        return historical_run_response(_control(dependencies), run_id)


@router.get("/runs/{run_id}/events", response_model=EventPage)
async def events(
    run_id: HistoricalRunId,
    dependencies: Dependencies,
    after_seq: str = Query(default="0", max_length=20, pattern=r"^[0-9]+$"),
    limit: int = Query(default=100, ge=1, le=500),
) -> EventPage:
    with _mapped_errors():
        require_historical_contract(dependencies.store.run(run_id).contract_kind)
        cursor = parse_nonnegative_cursor(after_seq)
        visible = dependencies.store.events(run_id)
        if cursor > (visible[-1].seq if visible else 0):
            raise _error(422, "CURSOR_INVALID")
        page = tuple(event for event in visible if event.seq > cursor)[:limit]
        return EventPage(
            run_id=run_id,
            items=tuple(event_response(event) for event in page),
            next_after_seq=page[-1].seq if page else cursor,
        )


@router.get("/runs/{run_id}/artifacts", response_model=HistoricalArtifactIndex)
async def artifact_index(
    run_id: HistoricalRunId, dependencies: Dependencies
) -> HistoricalArtifactIndex:
    with _mapped_errors():
        return historical_artifact_index(_control(dependencies), run_id)


@router.get("/runs/{run_id}/report-summary", response_model=HistoricalReportSummary)
async def report_summary(
    run_id: HistoricalRunId, dependencies: Dependencies
) -> HistoricalReportSummary:
    with _mapped_errors():
        return historical_report_summary(_control(dependencies), run_id)


@router.get(
    "/runs/{run_id}/artifacts/{artifact_name}",
    response_class=Response,
    responses={
        200: {
            "description": "Verified original artifact bytes.",
            "content": {
                "application/json": {},
                "application/x-ndjson": {},
                "text/plain": {},
            },
        }
    },
)
async def artifact(
    run_id: HistoricalRunId, artifact_name: HistoricalArtifactName, dependencies: Dependencies
) -> Response:
    with _mapped_errors():
        raw = historical_artifact_bytes(_control(dependencies), run_id, artifact_name)
    media = (
        "text/plain"
        if artifact_name is HistoricalArtifactName.STDERR
        else "application/x-ndjson"
        if artifact_name
        in {
            HistoricalArtifactName.EVENTS,
            HistoricalArtifactName.AUDIT,
        }
        else "application/json"
    )
    return Response(content=raw, media_type=media)
