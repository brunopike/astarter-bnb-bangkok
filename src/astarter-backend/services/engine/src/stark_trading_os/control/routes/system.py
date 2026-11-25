"""System identity and backtest-only capability routes."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from stark_trading_os.control.api_models import ApiError, CapabilitiesResponse, HealthResponse
from stark_trading_os.control.dependencies import (
    CONTROL_SCHEMA_VERSION,
    ControlDependencies,
    control_package_version,
    engine_identity_check,
    get_dependencies,
)
from stark_trading_os.control.preflight_contract import validate_unix_epoch_ns
from stark_trading_os.control.transactions import (
    PINNED_ENGINE_PACKAGE_VERSION,
    PINNED_ENGINE_TAG_COMMIT,
)
from stark_trading_os.domain.models import ErrorResponse

router = APIRouter(prefix="/v1/system", tags=["system"])
Dependencies = Annotated[ControlDependencies, Depends(get_dependencies)]


@router.get(
    "/health",
    response_model=HealthResponse,
    responses={503: {"model": ErrorResponse}},
)
async def health(dependencies: Dependencies) -> HealthResponse:
    control_failure = dependencies.scheduler.unavailable_reason()
    if control_failure is not None:
        raise ApiError(
            status_code=503,
            code="CONTROL_UNAVAILABLE",
            message="The local control scheduler could not recover committed work.",
            retryable=False,
            details={"check": control_failure},
        )
    failed_check = engine_identity_check(dependencies.engine_identity)
    if failed_check is not None:
        raise ApiError(
            status_code=503,
            code="ENGINE_UNAVAILABLE",
            message="The installed engine identity does not match the frozen backtest pin.",
            retryable=False,
            details={"check": failed_check},
        )
    return HealthResponse(
        status="ok",
        observed_at_ns=str(
            validate_unix_epoch_ns(
                dependencies.clock(),
                label="Health observation timestamp",
            )
        ),
        control_version=control_package_version(),
        schema_version=CONTROL_SCHEMA_VERSION,
        engine_version=dependencies.engine_identity.package_version,
        engine_commit=dependencies.engine_identity.tag_commit,
        engine_commit_provenance="LOCKED_RELEASE_PIN",
        python_version=dependencies.engine_identity.python_version,
        precision_mode=dependencies.engine_identity.precision_mode,
        input_manifest_engine_version=PINNED_ENGINE_PACKAGE_VERSION,
        input_manifest_engine_commit=PINNED_ENGINE_TAG_COMMIT,
    )


@router.get("/capabilities", response_model=CapabilitiesResponse)
async def capabilities(dependencies: Dependencies) -> CapabilitiesResponse:
    return CapabilitiesResponse(
        execution_modes=("BACKTEST",),
        live_available=False,
        observed_at_ns=str(
            validate_unix_epoch_ns(
                dependencies.clock(),
                label="Capabilities observation timestamp",
            )
        ),
        control_version=control_package_version(),
        schema_version=CONTROL_SCHEMA_VERSION,
        engine_version=dependencies.engine_identity.package_version,
        engine_commit=dependencies.engine_identity.tag_commit,
        engine_commit_provenance="LOCKED_RELEASE_PIN",
        python_version=dependencies.engine_identity.python_version,
        precision_mode=dependencies.engine_identity.precision_mode,
        input_manifest_engine_version=PINNED_ENGINE_PACKAGE_VERSION,
        input_manifest_engine_commit=PINNED_ENGINE_TAG_COMMIT,
    )
