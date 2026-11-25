"""SQLite-backed visible event replay over server-sent events."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import StreamingResponse

from stark_trading_os.control.api_adapters import parse_nonnegative_cursor
from stark_trading_os.control.api_models import ApiError
from stark_trading_os.control.dependencies import ControlDependencies, get_dependencies
from stark_trading_os.control.registry import RunNotFound
from stark_trading_os.control.security import raw_header_values
from stark_trading_os.domain.models import ErrorResponse

router = APIRouter(tags=["stream"])
Dependencies = Annotated[ControlDependencies, Depends(get_dependencies)]
LastEventId = Annotated[str | None, Header(alias="Last-Event-ID")]


@router.get(
    "/v1/stream",
    response_class=StreamingResponse,
    responses={
        200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}},
        404: {"model": ErrorResponse},
        410: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
    },
)
async def stream_events(
    request: Request,
    dependencies: Dependencies,
    run_id: str = Query(min_length=1),
    last_event_id: LastEventId = None,
) -> StreamingResponse:
    header_values = raw_header_values(request, "Last-Event-ID")
    if len(header_values) > 1 or (header_values and not header_values[0]):
        raise _cursor_invalid(run_id, "Last-Event-ID must be one non-empty value.")
    if header_values:
        last_event_id = header_values[0]
    try:
        cursor = parse_nonnegative_cursor("0" if last_event_id is None else last_event_id)
    except ValueError as error:
        raise _cursor_invalid(run_id, "Last-Event-ID is malformed or negative.") from error
    try:
        events = dependencies.store.events(run_id)
    except RunNotFound as error:
        raise ApiError(
            status_code=404,
            code="RUN_UNKNOWN",
            message="The run ID is not registered.",
            run_id=run_id,
        ) from error
    tail = events[-1].seq if events else 0
    if cursor > tail:
        raise _cursor_invalid(run_id, "Last-Event-ID is above the visible SQLite tail.")
    floor = dependencies.event_retention_floor
    if floor is not None and cursor < floor.minimum_available_seq(run_id) - 1:
        raise ApiError(
            status_code=410,
            code="CURSOR_EXPIRED",
            message="The event cursor predates the authoritative retention floor.",
            run_id=run_id,
        )
    return StreamingResponse(
        _visible_event_stream(
            request=request,
            dependencies=dependencies,
            run_id=run_id,
            after_seq=cursor,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


async def _visible_event_stream(
    *,
    request: Request,
    dependencies: ControlDependencies,
    run_id: str,
    after_seq: int,
) -> AsyncIterator[bytes]:
    cursor = after_seq
    heartbeat_count = 0
    while True:
        events = dependencies.store.events(run_id)
        for event in events:
            if event.seq <= cursor:
                continue
            yield (
                f"id: {event.seq}\n"
                f"event: {event.type}\n"
                f"data: {event.envelope_bytes.decode('utf-8')}\n\n"
            ).encode()
            cursor = event.seq
        yield b": heartbeat\n\n"
        heartbeat_count += 1
        limit = dependencies.sse_heartbeat_limit
        if limit is not None and heartbeat_count >= limit:
            return
        if await request.is_disconnected():
            return
        await asyncio.sleep(dependencies.sse_heartbeat_seconds)


def _cursor_invalid(run_id: str, message: str) -> ApiError:
    return ApiError(
        status_code=422,
        code="CURSOR_INVALID",
        message=message,
        run_id=run_id,
    )
