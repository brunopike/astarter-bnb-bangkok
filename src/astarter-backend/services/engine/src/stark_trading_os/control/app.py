"""FastAPI application factory for the loopback-only backtest control API."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from stark_trading_os.control.api_models import ApiError
from stark_trading_os.control.dependencies import (
    ApiCommandScheduler,
    ControlDependencies,
    DependencyFactory,
    build_default_dependencies,
    historical_api_enabled,
    validate_historical_dependencies,
)
from stark_trading_os.control.public_data_collector import PublicDataCollector
from stark_trading_os.control.public_data_service import (
    PublicDataFetcher,
    PublicDataService,
    provider_fetcher,
)
from stark_trading_os.control.public_data_store import PublicDataStore
from stark_trading_os.control.routes import (
    agent,
    artifacts,
    backtests,
    catalogs,
    historical,
    public_data,
    strategies,
    stream,
    system,
)
from stark_trading_os.control.security import LocalOriginMiddleware, validate_local_origin
from stark_trading_os.integrations.public_data import PublicDataProvider

if TYPE_CHECKING:
    from stark_trading_os.control.assistant_tools import AssistantFixtureReadSide
    from stark_trading_os.control.postgres.caller import ReferenceRuntime
    from stark_trading_os.control.research.recommendation_readside import RecommendationReadSide

_TEST_ORIGIN = "http://127.0.0.1:3000"


class CanonicalFastAPI(FastAPI):
    """Normalize integral JSON-schema bounds before canonical serialization."""

    def openapi(self) -> dict[str, Any]:
        schema = super().openapi()
        _normalize_openapi_numbers(schema)
        _remove_unreachable_validation_responses(schema)
        _freeze_agent_review_pairs(schema)
        return schema


def create_app(
    *,
    testing: bool = False,
    dependency_factory: DependencyFactory | None = None,
    web_local_origin: str | None = None,
    public_data_enabled: bool = False,
    public_data_only: bool = False,
    public_data_cleanup: Callable[[], Awaitable[None]] | None = None,
    public_data_fetcher: PublicDataFetcher | None = None,
    public_data_provider: PublicDataProvider | None = None,
    public_data_store: PublicDataStore | None = None,
    public_data_runtime: (
        Callable[[], AbstractAsyncContextManager[PublicDataCollector]] | None
    ) = None,
    strategy_reference_runtime: ReferenceRuntime | None = None,
    strategy_reference_only: bool = False,
    assistant_fixture: AssistantFixtureReadSide | None = None,
    recommendation_readside: RecommendationReadSide | None = None,
) -> FastAPI:
    recommendation_only = recommendation_readside is not None
    if recommendation_only:
        from stark_trading_os.control.research.recommendation_readside import RecommendationReadSide

        if (type(recommendation_readside) is not RecommendationReadSide
                or public_data_enabled or public_data_only or strategy_reference_only
                or any(value is not None for value in (
                    dependency_factory, public_data_cleanup, public_data_fetcher,
                    public_data_provider, public_data_store, public_data_runtime,
                    strategy_reference_runtime, assistant_fixture,
                ))):
            raise ValueError("RECOMMENDATION_EXCLUSIVE_READSIDE_REQUIRED")
    if assistant_fixture is not None:
        from stark_trading_os.control.assistant_tools import AssistantFixtureReadSide

        if (type(assistant_fixture) is not AssistantFixtureReadSide
                or public_data_only is not True or public_data_enabled is not True
                or strategy_reference_only
                or any(value is not None for value in (
                    dependency_factory, public_data_cleanup, public_data_fetcher,
                    public_data_provider, public_data_store, public_data_runtime,
                    strategy_reference_runtime,
                ))):
            raise ValueError("ASSISTANT_FIXTURE_CONFIGURATION")
    if strategy_reference_only and (
        strategy_reference_runtime is None or dependency_factory is not None
        or public_data_enabled or public_data_only or public_data_runtime is not None
        or any(value is not None for value in (
            public_data_cleanup, public_data_fetcher, public_data_provider, public_data_store,
        ))
    ) or strategy_reference_runtime is not None and public_data_only:
        raise ValueError("REFERENCE_CONFIGURATION")
    if public_data_runtime is not None and (
        not public_data_only or not public_data_enabled
        or any(value is not None for value in (
            public_data_store, public_data_fetcher, public_data_provider, public_data_cleanup,
            dependency_factory,
        ))
    ):
        raise ValueError("PUBLIC_COLLECTOR_REQUIRES_EXCLUSIVE_READSIDE_OWNER")
    if public_data_store is not None and (
        not public_data_enabled
        or (
            public_data_provider is not None and public_data_provider.mode != public_data_store.mode
        )
    ):
        raise ValueError("A public store requires enabled routes and a matching provider mode.")
    if public_data_provider is not None:
        if (
            not public_data_enabled
            or public_data_cleanup is None
            or public_data_fetcher is not None
        ):
            raise ValueError("A public provider requires enabled routes and one explicit owner.")
        public_data_fetcher = provider_fetcher(public_data_provider)
    if public_data_only and (not public_data_enabled or dependency_factory is not None):
        raise ValueError("Read-side-only mode requires data routes and forbids a Control factory.")
    historical_enabled = historical_api_enabled()
    configured_origin = web_local_origin
    if configured_origin is None:
        configured_origin = _TEST_ORIGIN if testing else os.environ.get("WEB_LOCAL_ORIGIN")
    allowed_origin = validate_local_origin(configured_origin)
    repository_root = Path(__file__).resolve().parents[5]
    if public_data_only or strategy_reference_only or recommendation_only:
        factory = None
    elif dependency_factory is not None:
        factory = dependency_factory
    elif not testing:

        def factory() -> ControlDependencies:
            return build_default_dependencies(
                repository_root, historical_enabled=historical_enabled
            )

    else:
        factory = None

    @asynccontextmanager
    async def control_lifespan(application: FastAPI) -> AsyncIterator[None]:
        if public_data_runtime is not None:
            # Managed assembly owns every resource, even partial startup failures.
            # The HTTP layer never constructs a second service/refresh lane.
            try:
                async with public_data_runtime() as collector:
                    application.state.public_data_collector = collector
                    application.state.public_data_service = collector.service
                    application.state.control_dependencies = None
                    yield
            finally:
                application.state.public_data_service = None
            return
        dependencies = None
        try:
            dependencies = factory() if factory is not None else None
            application.state.control_dependencies = dependencies
            if type(dependencies) is ControlDependencies:
                validate_historical_dependencies(dependencies)
            if (
                type(dependencies) is ControlDependencies
                and type(dependencies.scheduler) is ApiCommandScheduler
            ):
                await dependencies.scheduler.start()
            yield
        finally:
            try:
                read_service = getattr(application.state, "public_data_service", None)
                if isinstance(read_service, PublicDataService):
                    await read_service.close()
            finally:
                try:
                    if public_data_cleanup is not None:
                        await public_data_cleanup()
                finally:
                    try:
                        if public_data_store is not None:
                            public_data_store.close()
                    finally:
                        if type(dependencies) is ControlDependencies:
                            if type(dependencies.scheduler) is ApiCommandScheduler:
                                await dependencies.scheduler.close()
                            dependencies.store.close()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        if strategy_reference_runtime is None:
            async with control_lifespan(application):
                yield
        else:
            async with strategy_reference_runtime.lifespan():
                async with control_lifespan(application):
                    yield

    application_class = (
        FastAPI if public_data_only or strategy_reference_only or recommendation_only
        else CanonicalFastAPI
    )
    application = application_class(
        title=(
            "Astarter Public Recommendation Read Side" if recommendation_only
            else "Astarter Local Public Data Read Side" if public_data_only
            else "Stark Trading OS Local Backtest Control API"
        ),
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        swagger_ui_oauth2_redirect_url=None,
    )
    application.add_middleware(LocalOriginMiddleware, allowed_origin=allowed_origin)
    application.add_exception_handler(ApiError, _api_error_handler)
    application.add_exception_handler(RequestValidationError, _validation_error_handler)
    if recommendation_only:
        @application.middleware("http")
        async def recommendation_no_store(
            request: Request, call_next: Callable[[Request], Awaitable[Response]]
        ) -> Response:
            response = await call_next(request)
            response.headers["Cache-Control"] = "no-store"
            return response

    application.state.allow_external_agent_review = (
        not testing and not public_data_only and not strategy_reference_only
        and not recommendation_only
    )
    application.state.strategy_reference_runtime = strategy_reference_runtime
    application.state.public_data_fetcher = public_data_fetcher
    application.state.public_data_store = public_data_store
    application.state.public_data_service = None
    application.state.public_data_managed = public_data_runtime is not None
    application.state.assistant_fixture_readside = assistant_fixture
    application.state.recommendation_readside = recommendation_readside
    if not public_data_only and not strategy_reference_only and not recommendation_only:
        application.include_router(system.router)
        application.include_router(catalogs.router)
        application.include_router(strategies.router)
        application.include_router(backtests.router)
        application.include_router(artifacts.router)
        application.include_router(stream.router)
        application.include_router(agent.router)
        application.include_router(historical.router)
    if public_data_enabled:
        application.include_router(public_data.router)
    if assistant_fixture is not None:
        from stark_trading_os.control.routes import assistant_tools

        application.include_router(assistant_tools.router)
    if strategy_reference_runtime is not None:
        from stark_trading_os.control.routes import strategy_references

        application.include_router(strategy_references.router)
    if recommendation_only:
        from stark_trading_os.control.routes import recommendations

        application.include_router(recommendations.router)
    return application


def _normalize_openapi_numbers(value: object, path: tuple[str, ...] = ()) -> None:
    if type(value) is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise RuntimeError("OpenAPI object keys must be strings.")
            if type(item) is float:
                if path + (key,) == (
                    "components",
                    "schemas",
                    "BacktestDraftRequest",
                    "properties",
                    "replay_seed",
                    "maximum",
                ):
                    value[key] = (2**64) - 1
                elif item.is_integer():
                    value[key] = int(item)
                else:
                    raise RuntimeError("OpenAPI contains a non-integral binary float.")
            else:
                _normalize_openapi_numbers(item, path + (key,))
    elif type(value) is list:
        for index, item in enumerate(value):
            if type(item) is float:
                if not item.is_integer():
                    raise RuntimeError("OpenAPI contains a non-integral binary float.")
                value[index] = int(item)
            else:
                _normalize_openapi_numbers(item, path + (str(index),))


def _remove_unreachable_validation_responses(schema: dict[str, Any]) -> None:
    paths = schema.get("paths")
    if type(paths) is not dict:
        raise RuntimeError("OpenAPI paths are unavailable.")
    for path in (
        "/v1/backtests/{run_id}",
        "/v1/backtests/{run_id}/artifacts",
        "/v1/backtests/{run_id}/configuration",
        "/v1/strategy-drafts/{draft_id}",
        "/v1/strategy-drafts/{draft_id}/versions",
        "/v1/strategy-configurations/{configuration_id}",
    ):
        operation = paths.get(path, {}).get("get")
        if type(operation) is not dict or type(operation.get("responses")) is not dict:
            raise RuntimeError("OpenAPI read operation is unavailable.")
        operation["responses"].pop("422", None)
    components = schema.get("components")
    if type(components) is not dict or type(components.get("schemas")) is not dict:
        raise RuntimeError("OpenAPI component schemas are unavailable.")
    components["schemas"].pop("HTTPValidationError", None)
    components["schemas"].pop("ValidationError", None)


def _freeze_agent_review_pairs(schema: dict[str, Any]) -> None:
    response_schema = schema["paths"]["/v1/agent/run-review"]["post"]["responses"]["200"][
        "content"
    ]["application/json"]["schema"]
    pair_schema = [
        {
            "type": "object",
            "properties": {"mode": {"const": mode}, "status": {"const": status}},
            "required": ["mode", "status"],
        }
        for mode, status in (
            ("LOCAL_DETERMINISTIC", "AI_REVIEW_NOT_CONFIGURED"),
            ("LOCAL_DETERMINISTIC", "AI_REVIEW_REJECTED"),
            ("LOCAL_DETERMINISTIC", "AI_REVIEW_UNAVAILABLE"),
            ("OPENAI_AGENT", "COMPLETE"),
        )
    ]
    frozen_schema = {
        "oneOf": pair_schema,
        "allOf": [{"$ref": "#/components/schemas/RunReviewResponse"}],
    }
    if response_schema == frozen_schema:
        return
    if response_schema != {"$ref": "#/components/schemas/RunReviewResponse"}:
        raise RuntimeError("Agent review response schema is unavailable.")
    response_schema.clear()
    response_schema.update(frozen_schema)


async def _api_error_handler(_request: Request, error: Exception) -> JSONResponse:
    if type(error) is not ApiError:
        raise error
    return JSONResponse(status_code=error.status_code, content=_error_content(error))


async def _validation_error_handler(
    request: Request,
    error: Exception,
) -> JSONResponse:
    if type(error) is not RequestValidationError:
        raise error
    if request.url.path.startswith("/v2/historical/"):
        # Pydantic locations/messages may contain rejected field names or input.
        # This boundary never reflects those values into public diagnostics.
        api_error = ApiError(
            status_code=422, code="REQUEST_INVALID", message="The historical request is invalid."
        )
        return JSONResponse(status_code=422, content=_error_content(api_error))
    if request.url.path == "/v1/agent/run-review":
        failure_types = tuple(
            failure.get("type") for failure in error.errors() if type(failure.get("type")) is str
        )
        if "review_sensitive_input_not_accepted" in failure_types:
            details: dict[str, object] = {
                "field": "question",
                "reason": "SENSITIVE_INPUT_NOT_ACCEPTED",
            }
        elif "json_invalid" in failure_types:
            details = {"field": "body", "reason": "MALFORMED_JSON"}
        else:
            details = {"field": "body", "reason": "SCHEMA_INVALID"}
        api_error = ApiError(
            status_code=422,
            code="REVIEW_REQUEST_INVALID",
            message="The review request is invalid.",
            details=details,
        )
        return JSONResponse(status_code=api_error.status_code, content=_error_content(api_error))
    if request.url.path.startswith(("/v1/strategy-drafts", "/v1/strategy-configurations")):
        locations = tuple(
            item
            for failure in error.errors()
            for item in failure.get("loc", ())
            if isinstance(item, str)
        )
        parameters_invalid = "parameters" in locations
        api_error = ApiError(
            status_code=422,
            code=(
                "CONFIGURATION_PARAMETERS_INVALID"
                if parameters_invalid
                else "CONFIGURATION_INPUT_INVALID"
            ),
            message=(
                "The fixed strategy parameters are invalid."
                if parameters_invalid
                else "The strategy configuration request is invalid."
            ),
            details={
                "errors": [
                    {
                        "location": [str(value) for value in failure.get("loc", ())],
                        "message": str(failure.get("msg", "invalid value")),
                    }
                    for failure in error.errors()
                ]
            },
        )
        return JSONResponse(status_code=api_error.status_code, content=_error_content(api_error))
    locations = tuple(
        item
        for failure in error.errors()
        for item in failure.get("loc", ())
        if isinstance(item, str)
    )
    cursor_error = any(
        item in {"after_seq", "cursor", "limit", "Last-Event-ID"} for item in locations
    )
    api_error = ApiError(
        status_code=422,
        code="CURSOR_INVALID" if cursor_error else "REQUEST_INVALID",
        message="The request cursor is invalid." if cursor_error else "The request is invalid.",
        details={
            "errors": [
                {
                    "location": [str(value) for value in failure.get("loc", ())],
                    "message": str(failure.get("msg", "invalid value")),
                }
                for failure in error.errors()
            ]
        },
    )
    return JSONResponse(status_code=api_error.status_code, content=_error_content(api_error))


def _error_content(error: ApiError) -> dict[str, object]:
    return {
        "code": error.code,
        "message": error.message,
        "run_id": error.run_id,
        "retryable": error.retryable,
        "evidence_id": None,
        "details": error.details,
    }
