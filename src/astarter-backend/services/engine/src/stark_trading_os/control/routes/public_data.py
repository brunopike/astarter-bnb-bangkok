"""Four exact GET projections, enabled only by explicit local app assembly."""

from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from stark_trading_os.control.public_data_models import (
    PublicDataPayload,
    PublicDataQuery,
    PublicDataResource,
    PublicDataResponse,
)
from stark_trading_os.control.public_data_service import PublicDataService, utc_ms
from stark_trading_os.control.public_data_store import PublicDataStoreError

router = APIRouter(prefix="/v1/data", tags=["public-data"])
_ASSETS = frozenset({"bitcoin", "ethereum", "solana"})
_CHAINS = frozenset({"1", "56", "8453", "42161", "137", "10"})


def _integer(value: str, maximum: int) -> int:
    if not value.isascii() or not value.isdigit() or len(value) > 10:
        raise ValueError("invalid integer")
    number = int(value)
    if number > maximum:
        raise ValueError("integer out of range")
    return number


def _query(request: Request, resource: PublicDataResource) -> tuple[PublicDataQuery, int]:
    params = request.query_params
    allowed = {"selection_version"}
    if resource in {"markets", "assets"}:
        allowed.add("asset_ids")
    elif resource == "news":
        allowed.add("limit")
    else:
        allowed.update({"provider_id", "chain_id"})
    if any(key not in allowed or len(params.getlist(key)) != 1 for key in params):
        raise ValueError("invalid query")
    selection = _integer(params.get("selection_version", "0"), 2147483647)
    if resource in {"markets", "assets"}:
        assets = tuple(params.get("asset_ids", "bitcoin,ethereum,solana").split(","))
        if not assets or len(set(assets)) != len(assets) or not set(assets) <= _ASSETS:
            raise ValueError("invalid assets")
        return PublicDataQuery(resource=resource, asset_ids=tuple(sorted(assets))), selection
    if resource == "news":
        limit = _integer(params.get("limit", "20"), 50)
        if limit < 1:
            raise ValueError("invalid limit")
        return PublicDataQuery(resource="news", limit=limit), selection
    chain = params.get("chain_id")
    if params.get("provider_id", "etherscan") != "etherscan" or (
        chain is not None and chain not in _CHAINS
    ):
        raise ValueError("invalid explorer capability query")
    return PublicDataQuery(resource="explorer/capabilities", chain_id=chain), selection


def _error(code: str, status: int, selection: int = 0) -> JSONResponse:
    messages = {
        "INVALID_QUERY": "Invalid public data query.",
        "DATA_SERVICE_UNAVAILABLE": "Data service is unavailable.",
        "DATA_INTERNAL_ERROR": "Data service failed.",
    }
    return JSONResponse(
        status_code=status,
        headers={"Cache-Control": "no-store"},
        content={
            "schema_version": "AstarterPublicDataError.v1",
            "request_id": str(uuid4()), "selection_version": selection,
            "code": code, "message": messages[code], "retryable": status == 503,
        },
    )


async def _read(
    request: Request, resource: PublicDataResource
) -> PublicDataResponse | JSONResponse:
    try:
        query, selection = _query(request, resource)
    except ValueError:
        return _error("INVALID_QUERY", 400)
    service = getattr(request.app.state, "assistant_fixture_readside", None)
    if service is None:
        service = getattr(request.app.state, "public_data_service", None)
    if service is None:
        if getattr(request.app.state, "public_data_managed", False):
            return _error("DATA_SERVICE_UNAVAILABLE", 503, selection)
        fetcher = getattr(request.app.state, "public_data_fetcher", None)
        if not callable(fetcher):
            return _error("DATA_SERVICE_UNAVAILABLE", 503, selection)
        clock = getattr(request.app.state, "public_data_clock", utc_ms)
        service = PublicDataService(
            fetcher, clock_ms=clock, store=getattr(request.app.state, "public_data_store", None)
        )
        request.app.state.public_data_service = service
    try:
        payload = PublicDataPayload.model_validate(await service.read(query))
        return PublicDataResponse(
            **payload.model_dump(mode="python"), request_id=str(uuid4()),
            selection_version=selection, requested_at_ms=service.clock_ms(),
        )
    except PublicDataStoreError:
        return _error("DATA_SERVICE_UNAVAILABLE", 503, selection)
    except Exception:
        return _error("DATA_INTERNAL_ERROR", 500, selection)


@router.get("/markets", response_model=PublicDataResponse)
async def markets(request: Request) -> PublicDataResponse | JSONResponse:
    return await _read(request, "markets")


@router.get("/assets", response_model=PublicDataResponse)
async def assets(request: Request) -> PublicDataResponse | JSONResponse:
    return await _read(request, "assets")


@router.get("/news", response_model=PublicDataResponse)
async def news(request: Request) -> PublicDataResponse | JSONResponse:
    return await _read(request, "news")


@router.get("/explorer/capabilities", response_model=PublicDataResponse)
async def explorer_capabilities(request: Request) -> PublicDataResponse | JSONResponse:
    return await _read(request, "explorer/capabilities")
