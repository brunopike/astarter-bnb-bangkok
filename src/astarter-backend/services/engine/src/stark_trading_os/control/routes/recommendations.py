"""Opt-in public R1 catalog reads; request data never supplies a candidate/head."""

import re

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from stark_trading_os.control.research.recommendation_readside import (
    RecommendationNotFound,
    RecommendationReadSide,
)
from stark_trading_os.integrations.research_egress import ResearchRejected

router = APIRouter(prefix="/v1/strategy-recommendations", tags=["recommendations"])


def _response(content: object, status: int = 200) -> JSONResponse:
    return JSONResponse(content=content, status_code=status, headers={"Cache-Control": "no-store"})


def _error(code: str, status: int) -> JSONResponse:
    return _response({"schemaVersion": "StrategyRecommendationError.v1", "code": code}, status)


async def _read(request: Request, identifier: str | None = None) -> JSONResponse:
    params = request.query_params
    if identifier is None:
        if params:
            return _error("INVALID_QUERY", 400)
        revision = None
    else:
        revision = params.get("revision", "")
        if (
            set(params) != {"revision"}
            or len(params.getlist("revision")) != 1
            or re.fullmatch(r"[0-9a-f]{64}", identifier) is None
            or re.fullmatch(r"[0-9a-f]{64}", revision) is None
        ):
            return _error("INVALID_QUERY", 400)
    service = getattr(request.app.state, "recommendation_readside", None)
    if type(service) is not RecommendationReadSide:
        return _error("RECOMMENDATION_UNAVAILABLE", 503)
    try:
        if identifier is None:
            return _response({"items": list(await service.list()), "nextCursor": None})
        assert revision is not None
        return _response(await service.read(identifier, revision))
    except RecommendationNotFound:
        return _error("RECOMMENDATION_NOT_FOUND", 404)
    except ResearchRejected as exc:
        if exc.reason == "DENIED":
            return _error("RECOMMENDATION_NOT_FOUND", 404)
        return _error("RECOMMENDATION_UNAVAILABLE", 503)
    except Exception:
        return _error("RECOMMENDATION_UNAVAILABLE", 503)


@router.get("")
async def recommendations(request: Request) -> JSONResponse:
    return await _read(request)


@router.get("/{identifier}")
async def recommendation(request: Request, identifier: str) -> JSONResponse:
    return await _read(request, identifier)
