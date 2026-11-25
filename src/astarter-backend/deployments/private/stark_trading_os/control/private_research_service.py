"""Explicit PRIVATE service assembly; importing or default construction performs no IO."""

import asyncio
import json
import os
import re
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from threading import Condition
from typing import Any, Literal

from fastapi import FastAPI

from .postgres.access import RepositoryAccessContract
from .postgres.caller import owned_thread
from .postgres.pool import PgRepositoryPool, PoolSettings
from .postgres.private_research_contracts import PrivateLease
from .postgres.private_research_issuer import PrivateIssuerRepository
from .postgres.private_research_migration import PrivateTarget
from .postgres.private_research_repository import PrivateRuntimeRepository
from .postgres.synthetic_migration import TargetProfile
from .private_research_rpc import PrivateRPCBackend, PrivateRPCError, create_private_research_app

_ENV_KEYS = (
    "ASTARTER_PRIVATE_TARGET_JSON", "ASTARTER_PRIVATE_LEASE_JSON",
    "ASTARTER_PRIVATE_RUNTIME_DATABASE_URL", "ASTARTER_PRIVATE_ISSUER_DATABASE_URL",
    "PRIVATE_RUNTIME_TOKEN", "PRIVATE_ISSUER_TOKEN",
)


def _unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("PRIVATE_SERVICE_CONFIGURATION")
        result[key] = value
    return result


@dataclass(frozen=True, repr=False)
class PrivateServiceConfig:
    target: PrivateTarget
    lease: PrivateLease
    runtime_database_url: str
    issuer_database_url: str
    runtime_token: str
    issuer_token: str

    def __post_init__(self) -> None:
        if (
            type(self.target) is not PrivateTarget or type(self.lease) is not PrivateLease
            or (self.target.target_id, self.target.database, self.target.runtime)
            != (self.lease.target_id, self.lease.database, self.lease.runtime_role)
            or self.runtime_token == self.issuer_token
            or any(type(value) is not str or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", value)
                   for value in (self.runtime_token, self.issuer_token))
            or any(type(value) is not str or not 1 <= len(value) <= 8192
                   for value in (self.runtime_database_url, self.issuer_database_url))
        ):
            raise ValueError("PRIVATE_SERVICE_CONFIGURATION")

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "PrivateServiceConfig | None":
        if not any(env.get(key) for key in _ENV_KEYS):
            return None
        try:
            if any(type(env.get(key)) is not str or not 1 <= len(env[key]) <= 8192
                   for key in _ENV_KEYS):
                raise ValueError()
            data = json.loads(env[_ENV_KEYS[0]], object_pairs_hook=_unique)
            if type(data) is not dict:
                raise ValueError()
            target = PrivateTarget(**(data | {"profile": TargetProfile(data["profile"])}))
            lease = PrivateLease.model_validate(
                json.loads(env[_ENV_KEYS[1]], object_pairs_hook=_unique)
            )
            return cls(target, lease, *(env[key] for key in _ENV_KEYS[2:]))
        except (ValueError, TypeError, KeyError, RecursionError):
            raise ValueError("PRIVATE_SERVICE_CONFIGURATION") from None


class _Backend:
    def __init__(self) -> None:
        self._repository: PrivateRPCBackend | None = None
        self._active = 0
        self._condition = Condition()

    def bind(self, repository: PrivateRPCBackend) -> None:
        with self._condition:
            self._repository = repository

    def retire(self) -> None:
        with self._condition:
            self._repository = None

    def drain(self) -> None:
        with self._condition:
            self._condition.wait_for(lambda: self._active == 0)

    def invoke(self, operation: str, payload: dict[str, Any], session_digest: str | None) -> Any:
        with self._condition:
            repository = self._repository
            if repository is None:
                raise PrivateRPCError("PRIVATE_UNAVAILABLE")
            self._active += 1
        try:
            return repository.invoke(operation, payload, session_digest)
        finally:
            with self._condition:
                self._active -= 1
                self._condition.notify_all()


def create_private_service(config: PrivateServiceConfig | None = None) -> FastAPI:
    if config is None:
        return create_private_research_app()
    if type(config) is not PrivateServiceConfig:
        raise ValueError("PRIVATE_SERVICE_CONFIGURATION")
    runtime, issuer = _Backend(), _Backend()
    app = create_private_research_app(
        runtime=runtime, issuer=issuer,
        runtime_secret=config.runtime_token, issuer_secret=config.issuer_token,
    )
    app.state.private_service_error = None
    used = False

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        nonlocal used
        if used:
            raise RuntimeError("PRIVATE_SERVICE_LIFESPAN_UNAVAILABLE")
        # Queued RPCs retain this backend forever; restarting requires a new factory/app.
        used = True
        app.state.private_service_error = None
        pools: list[PgRepositoryPool] = []
        first_error: BaseException | None = None

        def open_pools() -> tuple[PrivateRuntimeRepository, PrivateIssuerRepository]:
            roles: tuple[tuple[Literal["runtime", "issuer"], str], ...] = (
                ("runtime", config.runtime_database_url), ("issuer", config.issuer_database_url),
            )
            for role, dsn in roles:
                pools.append(PgRepositoryPool(
                    dsn, settings=PoolSettings(max_size=2, check_on_checkout=True), writable=True,
                    profile=config.target.profile,
                    access_contract=RepositoryAccessContract.PRIVATE_RESEARCH_V1,
                    private_target=config.target, private_role=role,
                ))
            for pool in pools:
                pool.open()
            return (PrivateRuntimeRepository(pools[0], lease=config.lease),
                    PrivateIssuerRepository(pools[1]))

        def close_pools() -> bool:
            runtime.drain()
            issuer.drain()
            closed = True
            for pool in reversed(pools):
                try:
                    pool.close()
                except Exception:
                    closed = False
            return closed

        try:
            try:
                runtime_repo, issuer_repo = await owned_thread(open_pools)
                runtime.bind(runtime_repo)
                issuer.bind(issuer_repo)
            except asyncio.CancelledError:
                raise
            except Exception:
                app.state.private_service_error = "PRIVATE_SERVICE_STARTUP_FAILED"
                raise RuntimeError("PRIVATE_SERVICE_STARTUP_FAILED") from None
            try:
                yield
            except asyncio.CancelledError:
                raise
            except Exception:
                app.state.private_service_error = "PRIVATE_SERVICE_LIFESPAN_FAILED"
                raise RuntimeError("PRIVATE_SERVICE_LIFESPAN_FAILED") from None
        except BaseException as error:
            first_error = error
            if isinstance(error, asyncio.CancelledError):
                app.state.private_service_error = "PRIVATE_SERVICE_CANCELLED"
            raise
        finally:
            runtime.retire()
            issuer.retire()
            try:
                closed = await owned_thread(close_pools)
            except asyncio.CancelledError:
                if first_error is None:
                    app.state.private_service_error = "PRIVATE_SERVICE_CANCELLED"
                    raise
            except Exception:
                # An unavailable executor cannot own cleanup; native closes remain bounded.
                close_pools()
                if first_error is None:
                    app.state.private_service_error = "PRIVATE_SERVICE_SHUTDOWN_FAILED"
                    raise RuntimeError("PRIVATE_SERVICE_SHUTDOWN_FAILED") from None
            else:
                if not closed and first_error is None:
                    app.state.private_service_error = "PRIVATE_SERVICE_SHUTDOWN_FAILED"
                    raise RuntimeError("PRIVATE_SERVICE_SHUTDOWN_FAILED") from None

    app.router.lifespan_context = lifespan
    return app


def create_private_service_from_env(env: Mapping[str, str] | None = None) -> FastAPI:
    """Explicit ASGI --factory entry; missing configuration stays an inert 503 service."""
    return create_private_service(PrivateServiceConfig.from_env(os.environ if env is None else env))
