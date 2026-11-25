"""Server-owned strategy catalog and persisted configuration routes."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request

from stark_trading_os.control.api_adapters import preflight_response
from stark_trading_os.control.api_models import ApiError, PreflightApiResponse
from stark_trading_os.control.dependencies import (
    ControlDependencies,
    engine_identity_check,
    get_dependencies,
)
from stark_trading_os.control.registry import IdempotencyConflict, RunNotFound
from stark_trading_os.control.security import raw_header_values
from stark_trading_os.control.strategy_configurations import (
    StrategyConfigurationIntegrityError,
    StrategyConfigurationStorageError,
    StrategyConfigurationUnknown,
    StrategyDraftUnknown,
    StrategyPreflightConflict,
    StrategyRevisionConflict,
    StrategyUnknown,
)
from stark_trading_os.control.strategy_models import (
    ConfigurationInput,
    PublishStrategyDraftRequest,
    StrategyConfigurationVersion,
    StrategyConfigurationVersionList,
    StrategyDefinitionList,
    StrategyDraft,
    StrategyDraftList,
    UpdateStrategyDraftRequest,
)
from stark_trading_os.domain.models import BacktestDraftRequest, ErrorResponse

router = APIRouter(tags=["strategies"])
Dependencies = Annotated[ControlDependencies, Depends(get_dependencies)]
IdempotencyKey = Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=256)]


@router.get("/v1/strategies", response_model=StrategyDefinitionList)
async def get_strategies(dependencies: Dependencies) -> StrategyDefinitionList:
    return StrategyDefinitionList(items=dependencies.strategy_configurations.definitions())


@router.get(
    "/v1/strategy-drafts",
    response_model=StrategyDraftList,
    responses={409: {"model": ErrorResponse}},
)
async def get_strategy_drafts(dependencies: Dependencies) -> StrategyDraftList:
    try:
        return StrategyDraftList(items=dependencies.strategy_configurations.drafts())
    except (StrategyConfigurationIntegrityError, StrategyConfigurationStorageError) as error:
        raise _configuration_integrity_failed() from error


@router.post(
    "/v1/strategy-drafts",
    response_model=StrategyDraft,
    status_code=201,
    responses={409: {"model": ErrorResponse}, 422: {"model": ErrorResponse}},
)
async def create_strategy_draft(
    request: ConfigurationInput,
    dependencies: Dependencies,
) -> StrategyDraft:
    try:
        return dependencies.strategy_configurations.create_draft(request)
    except StrategyUnknown as error:
        raise ApiError(
            status_code=422,
            code="STRATEGY_UNKNOWN",
            message="The requested strategy is not registered for configuration.",
        ) from error
    except (StrategyConfigurationIntegrityError, StrategyConfigurationStorageError) as error:
        raise _configuration_integrity_failed() from error


@router.get(
    "/v1/strategy-drafts/{draft_id}",
    response_model=StrategyDraft,
    responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
)
async def get_strategy_draft(draft_id: str, dependencies: Dependencies) -> StrategyDraft:
    try:
        return dependencies.strategy_configurations.draft(draft_id)
    except StrategyDraftUnknown as error:
        raise ApiError(
            status_code=404,
            code="CONFIGURATION_DRAFT_UNKNOWN",
            message="The strategy draft ID is not registered.",
        ) from error
    except (StrategyConfigurationIntegrityError, StrategyConfigurationStorageError) as error:
        raise _configuration_integrity_failed() from error


@router.put(
    "/v1/strategy-drafts/{draft_id}",
    response_model=StrategyDraft,
    responses={
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
    },
)
async def update_strategy_draft(
    draft_id: str,
    request: UpdateStrategyDraftRequest,
    dependencies: Dependencies,
) -> StrategyDraft:
    configuration = _configuration_input(request)
    try:
        return dependencies.strategy_configurations.update_draft(
            draft_id=draft_id,
            expected_revision=request.expected_revision,
            configuration=configuration,
        )
    except StrategyDraftUnknown as error:
        raise _draft_unknown() from error
    except StrategyRevisionConflict as error:
        raise _revision_conflict() from error
    except StrategyUnknown as error:
        raise ApiError(
            status_code=422,
            code="STRATEGY_UNKNOWN",
            message="The requested strategy is not registered for configuration.",
        ) from error
    except (StrategyConfigurationIntegrityError, StrategyConfigurationStorageError) as error:
        raise _configuration_integrity_failed() from error


@router.post(
    "/v1/strategy-drafts/{draft_id}/publish",
    response_model=StrategyConfigurationVersion,
    status_code=201,
    responses={
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
    },
)
async def publish_strategy_draft(
    draft_id: str,
    request: PublishStrategyDraftRequest,
    dependencies: Dependencies,
) -> StrategyConfigurationVersion:
    try:
        return dependencies.strategy_configurations.publish_draft(
            draft_id=draft_id,
            expected_revision=request.expected_revision,
        )
    except StrategyDraftUnknown as error:
        raise _draft_unknown() from error
    except StrategyRevisionConflict as error:
        raise _revision_conflict() from error
    except (StrategyConfigurationIntegrityError, StrategyConfigurationStorageError) as error:
        raise _configuration_integrity_failed() from error


@router.get(
    "/v1/strategy-configurations/{configuration_id}",
    response_model=StrategyConfigurationVersion,
    responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
)
async def get_strategy_configuration(
    configuration_id: str,
    dependencies: Dependencies,
) -> StrategyConfigurationVersion:
    try:
        return dependencies.strategy_configurations.configuration(configuration_id)
    except StrategyConfigurationUnknown as error:
        raise _configuration_unknown() from error
    except (StrategyConfigurationIntegrityError, StrategyConfigurationStorageError) as error:
        raise _configuration_integrity_failed() from error


@router.get(
    "/v1/strategy-drafts/{draft_id}/versions",
    response_model=StrategyConfigurationVersionList,
    responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
)
async def get_strategy_configuration_versions(
    draft_id: str,
    dependencies: Dependencies,
) -> StrategyConfigurationVersionList:
    try:
        return StrategyConfigurationVersionList(
            items=dependencies.strategy_configurations.versions(draft_id)
        )
    except StrategyDraftUnknown as error:
        raise _draft_unknown() from error
    except (StrategyConfigurationIntegrityError, StrategyConfigurationStorageError) as error:
        raise _configuration_integrity_failed() from error


@router.post(
    "/v1/strategy-configurations/{configuration_id}/preflight",
    response_model=PreflightApiResponse,
    responses={
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
async def preflight_strategy_configuration(
    configuration_id: str,
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
        resolved, binding = dependencies.strategy_configurations.resolve_preflight(
            configuration_id=configuration_id,
            request=request,
        )
        result = dependencies.preflight.run(
            resolved,
            idempotency_key,
            configuration_binding=binding,
        )
    except StrategyConfigurationUnknown as error:
        raise _configuration_unknown() from error
    except StrategyPreflightConflict as error:
        raise ApiError(
            status_code=409,
            code="CONFIGURATION_PREFLIGHT_MISMATCH",
            message="The preflight request differs from the selected configuration version.",
        ) from error
    except IdempotencyConflict as error:
        raise ApiError(
            status_code=409,
            code="IDEMPOTENCY_CONFLICT",
            message="The idempotency key is bound to another preflight request.",
        ) from error
    except (StrategyConfigurationIntegrityError, StrategyConfigurationStorageError) as error:
        raise _configuration_integrity_failed() from error
    return preflight_response(result)


@router.get(
    "/v1/backtests/{run_id}/configuration",
    response_model=StrategyConfigurationVersion | None,
    responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
)
async def get_backtest_strategy_configuration(
    run_id: str,
    dependencies: Dependencies,
) -> StrategyConfigurationVersion | None:
    try:
        dependencies.store.run(run_id)
        return dependencies.strategy_configurations.configuration_for_run(run_id)
    except RunNotFound as error:
        raise ApiError(
            status_code=404,
            code="RUN_UNKNOWN",
            message="The run ID is not registered.",
            run_id=run_id,
        ) from error
    except (StrategyConfigurationIntegrityError, StrategyConfigurationStorageError) as error:
        raise _configuration_integrity_failed() from error


def _configuration_integrity_failed() -> ApiError:
    return ApiError(
        status_code=409,
        code="CONFIGURATION_INTEGRITY_FAILED",
        message="Persisted strategy configuration integrity verification failed.",
    )


def _draft_unknown() -> ApiError:
    return ApiError(
        status_code=404,
        code="CONFIGURATION_DRAFT_UNKNOWN",
        message="The strategy draft ID is not registered.",
    )


def _configuration_unknown() -> ApiError:
    return ApiError(
        status_code=404,
        code="CONFIGURATION_UNKNOWN",
        message="The strategy configuration ID is not registered.",
    )


def _revision_conflict() -> ApiError:
    return ApiError(
        status_code=409,
        code="CONFIGURATION_REVISION_CONFLICT",
        message="The strategy draft revision has changed.",
        retryable=True,
    )


def _configuration_input(request: UpdateStrategyDraftRequest) -> ConfigurationInput:
    return ConfigurationInput(
        name=request.name,
        strategy_ref=request.strategy_ref,
        parameters=request.parameters,
        replay_seed=request.replay_seed,
    )


def _require_idempotency_key(request: Request, parsed_value: str) -> str:
    values = raw_header_values(request, "Idempotency-Key")
    if len(values) != 1 or not values[0] or len(values[0]) > 256:
        raise ApiError(
            status_code=422,
            code="CONFIGURATION_INPUT_INVALID",
            message="Idempotency-Key must be one non-empty value.",
        )
    if values[0] != parsed_value:
        raise ApiError(
            status_code=422,
            code="CONFIGURATION_INPUT_INVALID",
            message="Idempotency-Key parsing is ambiguous.",
        )
    return values[0]
