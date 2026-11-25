"""Opt-in shared PUBLIC BFF. No environment, credentials, database or provider on import."""

from __future__ import annotations

import asyncio
import hmac
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from contextvars import ContextVar
from dataclasses import asdict
from typing import Any, Literal
from uuid import UUID, uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, ValidationError

from stark_trading_os.control.postgres.pool import CommitUnknown, PgRepositoryPool
from stark_trading_os.control.postgres.public_repository import (
    RESOURCES,
    Admission,
    PgPublicStore,
    PublicRepository,
)
from stark_trading_os.control.public_data_models import PublicDataPayload, PublicDataQuery
from stark_trading_os.control.public_data_policy import ProviderScope
from stark_trading_os.control.public_data_providers import SharedPublicProviders
from stark_trading_os.control.public_data_service import PublicDataFetcher, PublicDataService
from stark_trading_os.control.public_data_store import PublicDataStoreError
from stark_trading_os.control.routes.public_data import router
from stark_trading_os.integrations.public_data.models import Mode

type FetcherFactory = Callable[[], AbstractAsyncContextManager[PublicDataFetcher]]


class RefreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    request_id: UUID
    scope: Literal["binance", "coingecko", "blockbeats"]


async def _never_fetch(query: PublicDataQuery) -> object:
    raise RuntimeError("PUBLIC_GET_CANNOT_COLLECT")


async def refresh_once(
    repository: PublicRepository,
    factory: FetcherFactory,
    request: RefreshRequest,
    *,
    configured_scopes: tuple[ProviderScope, ...] = tuple(RESOURCES),
) -> Admission:
    """Server-internal entry after authentication. One canonical resource; no retries/loop.

    Native pool waits/statements and fetcher IO are independently bounded. A cancellation
    resistant arbitrary callback is not supported; only owned cancellable transports.
    """
    if request.scope not in configured_scopes:
        previous = repository.status(request.request_id, scope=request.scope)
        return Admission("UNCONFIGURED") if previous.state == "NOT_FOUND" else previous
    try:
        admission = repository.reserve(request.scope, request.request_id, uuid4())
    except CommitUnknown:
        return Admission("UNKNOWN")  # Do not fetch after an unacknowledged reservation.
    t = admission.ticket
    if t is None:
        return admission
    service: PublicDataService | None = None
    try:
        async with asyncio.timeout(12):
            async with factory() as fetcher:
                service = PublicDataService(
                    fetcher,
                    store=PgPublicStore(repository, ticket=t),
                    clock_ms=repository.clock_ms,
                    snapshot_only=True,
                )
                await service.collect(
                    RESOURCES[t.scope],
                    interval_ms=t.interval_ms,
                    before_save=lambda d: repository.deadline(t, d),
                )
        return repository.status(t.request_id)
    except CommitUnknown:
        return Admission("UNKNOWN")  # Next identical request reads the durable receipt.
    except BaseException as error:
        try:
            repository.unknown(t)
        except Exception:
            pass  # Existing RESERVED lease/charge remains conservative; never rearm.
        if isinstance(error, asyncio.CancelledError):
            raise
        if not isinstance(error, Exception):
            raise
        return Admission("UNKNOWN")
    finally:
        if service is not None:
            await service.close()


class _OwnedCalls:
    """Bounded sync DAL offload; disconnected requests cannot abandon DB writes."""

    def __init__(self) -> None:
        self.pending: set[asyncio.Task[Any]] = set()
        self.slots = asyncio.Semaphore(4)
        self.closing = False

    async def run[T](self, call: Callable[[], T]) -> T:
        if self.closing:
            raise PublicDataStoreError()
        try:
            await asyncio.wait_for(self.slots.acquire(), timeout=3)
        except TimeoutError:
            raise PublicDataStoreError() from None
        if self.closing:
            self.slots.release()
            raise PublicDataStoreError()
        task = asyncio.create_task(asyncio.to_thread(call))
        self.pending.add(task)

        def done(finished: asyncio.Task[T]) -> None:
            self.pending.discard(finished)
            self.slots.release()
            if not finished.cancelled():
                finished.exception()  # Consume disconnected-request failures without raw logs.

        task.add_done_callback(done)
        return await asyncio.shield(task)

    async def close(self) -> None:
        self.closing = True
        drain = asyncio.gather(*tuple(self.pending), return_exceptions=True)
        cancelled = False
        while not drain.done():
            try:
                await asyncio.shield(drain)
            except asyncio.CancelledError:
                cancelled = True
        if cancelled:
            raise asyncio.CancelledError


class _SharedReader:
    def __init__(self, repository: PublicRepository, calls: _OwnedCalls) -> None:
        self.repository, self.calls = repository, calls
        self.observed: ContextVar[int] = ContextVar("public_read_clock", default=0)

    def clock_ms(self) -> int:
        return self.observed.get()

    async def read(self, query: PublicDataQuery) -> PublicDataPayload:
        async def once() -> tuple[PublicDataPayload, int]:
            stored, observed = PgPublicStore(self.repository).load_at(query.resource)
            service = PublicDataService(_never_fetch)
            try:
                return service.project_snapshot(
                    query, stored, now=observed, mode=self.repository.mode,
                ), observed
            finally:
                await service.close()

        result, observed = await self.calls.run(lambda: asyncio.run(once()))
        self.observed.set(observed)
        return result


def create_shared_public_app(
    *,
    reader_pool: PgRepositoryPool,
    mode: Mode,
    collector_pool: PgRepositoryPool | None = None,
    fetcher_factory: FetcherFactory | None = None,
    refresh_token: str | None = None,
    providers: SharedPublicProviders | None = None,
) -> FastAPI:
    """Explicit factory owns supplied pools during lifespan; never selected by defaults.

    Deployment wiring/Neon profile qualification are a later gate. Tokens stay in server
    configuration, never URLs or public responses; fixture callers use synthetic tokens.
    """
    configured_scopes = tuple(RESOURCES)
    if providers is not None:
        if providers.mode != mode or fetcher_factory is not None or collector_pool is None:
            raise ValueError("PUBLIC_PROVIDER_CONFIGURATION")
        fetcher_factory = providers.open
        configured_scopes = providers.configured_scopes
    if reader_pool.writable:
        raise ValueError("PUBLIC_READER_ROLE_REQUIRED")
    reader = PublicRepository(reader_pool, mode=mode)
    collector = None
    if collector_pool is not None:
        if (
            not collector_pool.writable
            or fetcher_factory is None
            or refresh_token is None
            or not 32 <= len(refresh_token) <= 256
            or not refresh_token.isascii()
        ):
            raise ValueError("PUBLIC_REFRESH_CONFIGURATION")
        collector = PublicRepository(collector_pool, mode=mode)
    elif fetcher_factory is not None or refresh_token is not None:
        raise ValueError("PUBLIC_REFRESH_CONFIGURATION")
    calls = _OwnedCalls()
    service = _SharedReader(reader, calls)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            reader_pool.open()
            if collector_pool is not None:
                collector_pool.open()
            app.state.public_data_managed = True
            app.state.public_data_service = service
            app.state.public_data_calls = calls
            yield
        finally:
            try:
                await calls.close()
            finally:
                try:
                    if collector_pool is not None:
                        collector_pool.close()
                finally:
                    reader_pool.close()

    app = FastAPI(lifespan=lifespan)
    app.include_router(router)

    @app.post("/internal/public-data/refresh")
    async def refresh(request: Request) -> JSONResponse:
        headers = {"Cache-Control": "no-store"}
        authorization = request.headers.getlist("authorization")
        if (
            collector is None
            or fetcher_factory is None
            or refresh_token is None
            or request.headers.get("origin") is not None
            or request.query_params
            or len(authorization) != 1
            or not authorization[0].isascii()
            or not hmac.compare_digest(authorization[0], "Bearer " + refresh_token)
        ):
            return JSONResponse(
                {"code": "PUBLIC_REFRESH_FORBIDDEN"}, status_code=403, headers=headers
            )
        raw = bytearray()
        try:
            async with asyncio.timeout(3):
                async for part in request.stream():
                    raw.extend(part)
                    if len(raw) > 1024:
                        return JSONResponse(
                            {"code": "INVALID_REFRESH"}, status_code=400, headers=headers
                        )
        except TimeoutError:
            return JSONResponse({"code": "INVALID_REFRESH"}, status_code=408, headers=headers)
        try:
            command = RefreshRequest.model_validate_json(raw)
        except ValidationError:
            return JSONResponse({"code": "INVALID_REFRESH"}, status_code=400, headers=headers)
        try:
            result = await calls.run(
                lambda: asyncio.run(
                    refresh_once(
                        collector,
                        fetcher_factory,
                        command,
                        configured_scopes=configured_scopes,
                    )
                )
            )
        except Exception:
            return JSONResponse(
                {"code": "PUBLIC_REFRESH_UNAVAILABLE"}, status_code=503, headers=headers
            )
        body = asdict(result)
        body.pop("ticket")  # Never serialize a write capability.
        status = 202 if result.state in {"RESERVED", "UNKNOWN"} else 200
        return JSONResponse(body, status_code=status, headers=headers)

    return app
