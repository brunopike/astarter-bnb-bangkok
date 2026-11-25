"""One explicit fixture-only, loopback-protected capability GET."""

from uuid import uuid4

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from stark_trading_os.control.assistant_tools import AssistantFixtureReadSide, ToolProvidersResponse

router = APIRouter(prefix="/v1/assistant", tags=["assistant-fixture"])


def _error(code: str, status: int) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        headers={"Cache-Control": "no-store"},
        content={
            "schema_version": "AstarterAssistantToolProvidersError.v1",
            "request_id": str(uuid4()),
            "code": code,
            "message": "Assistant fixture request unavailable.",
        },
    )


@router.get("/tool-providers", response_model=ToolProvidersResponse)
async def providers(request: Request, response: Response) -> ToolProvidersResponse | JSONResponse:
    response.headers["Cache-Control"] = "no-store"
    if request.query_params:
        return _error("INVALID_QUERY", 400)
    readside = getattr(request.app.state, "assistant_fixture_readside", None)
    if type(readside) is not AssistantFixtureReadSide:
        return _error("ASSISTANT_FIXTURE_UNAVAILABLE", 503)
    try:
        return readside.catalog(str(uuid4()))
    except Exception:
        return _error("ASSISTANT_FIXTURE_INTERNAL_ERROR", 500)
