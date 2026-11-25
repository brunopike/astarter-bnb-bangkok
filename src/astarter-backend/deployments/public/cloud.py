"""Stateless HTTP assembly over the existing PUBLIC-only contracts and service."""

import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import RequestResponseEndpoint

from cloud_transport import PublicMarketTransport
from stark_trading_os.control.public_data_service import (
    PublicDataService,
    provider_fetcher,
    utc_ms,
)
from stark_trading_os.control.routes import public_data
from stark_trading_os.integrations.public_data import PublicDataProvider
from stark_trading_os.integrations.transport import HttpTransport

ALLOWED_ORIGINS = frozenset({
    "https://astarter.imstark.site",
    "https://ipfund.art",
})


def create_app(
    *, market_transport: HttpTransport | None = None, clock_ms: Callable[[], int] = utc_ms
) -> FastAPI:
    provider = PublicDataProvider(
        market_transport=PublicMarketTransport() if market_transport is None else market_transport,
        clock_ms=clock_ms,
    )
    service = PublicDataService(provider_fetcher(provider), clock_ms=clock_ms)

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            await service.close()

    app = FastAPI(
        title="Astarter Public Backend",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.public_data_service = service

    @app.middleware("http")
    async def public_boundary(request: Request, call_next: RequestResponseEndpoint) -> Response:
        response: Response
        origins = request.headers.getlist("origin")
        origin = origins[0] if len(origins) == 1 else None
        if origins and (len(origins) != 1 or origin not in ALLOWED_ORIGINS):
            response = JSONResponse({"code": "ORIGIN_DENIED"}, status_code=403)
        elif request.method == "OPTIONS":
            if request.headers.get("access-control-request-method", "GET") != "GET":
                response = JSONResponse({"code": "METHOD_NOT_ALLOWED"}, status_code=405)
            else:
                response = Response(status_code=204)
                response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
                response.headers["Access-Control-Allow-Headers"] = "Accept, Content-Type"
        else:
            response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Vary"] = "Origin"
        response.headers["X-Content-Type-Options"] = "nosniff"
        if origin in ALLOWED_ORIGINS:
            response.headers["Access-Control-Allow-Origin"] = origin
        return response

    @app.get("/healthz")
    async def health() -> dict[str, object]:
        return {
            "service": "astarter-public-backend",
            "status": "ok",
            "release": os.environ.get("VERCEL_GIT_COMMIT_SHA"),
            "mode": provider.mode,
            "frontend_origins": sorted(ALLOWED_ORIGINS),
            "capabilities": {
                "public_markets": True,
                "paid_sources": False,
                "commerce": False,
                "wallet_auth": False,
                "trading": False,
                "models": False,
            },
            "upstream_probe_performed": False,
        }

    app.include_router(public_data.router)
    return app
