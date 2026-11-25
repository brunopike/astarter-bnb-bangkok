"""Explicit, expiring PUBLIC assembly; import/construction performs no IO."""

import json
import os
import re
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from time import time_ns
from typing import Any, Literal, Self

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from psycopg import Connection
from psycopg.conninfo import make_conninfo
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from stark_trading_os.control.postgres.access import RepositoryAccessContract
from stark_trading_os.control.postgres.pool import PgRepositoryPool, PoolSettings
from stark_trading_os.control.postgres.public_access import public_profile_pin
from stark_trading_os.control.postgres.synthetic_migration import TargetProfile
from stark_trading_os.control.public_data_providers import SharedPublicProviders, TransportFactory
from stark_trading_os.control.public_data_shared import create_shared_public_app
from stark_trading_os.integrations.public_data import PublicDataCredentials
from stark_trading_os.integrations.public_data.network import PublicReadHttpTransport, PublicService
from stark_trading_os.integrations.transport import HttpRequest, HttpResponse, HttpTransport


def _clock() -> int:
    return time_ns() // 1_000_000


@dataclass(frozen=True)
class PublicLiveTarget:
    """Independently reviewed caller pin; never learned from secret configuration."""
    host: str
    port: int
    dbname: str
    reader: str
    collector: str
    profile: TargetProfile
    catalog_pin: str

    def __post_init__(self) -> None:
        if (type(self.profile) is not TargetProfile or type(self.port) is not int
                or not 1 <= self.port <= 65535 or self.reader == self.collector
                or any(type(v) is not str or not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", v)
                       for v in (self.dbname, self.reader, self.collector))
                or self.catalog_pin != public_profile_pin(self.profile)
                or type(self.host) is not str
                or not (re.fullmatch(r"/[^,\x00-\x1f]+", self.host)
                        if self.profile is TargetProfile.LOCAL_PG17
                        else re.fullmatch(r"ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech", self.host))):
            raise ValueError("PUBLIC_LIVE_CONFIGURATION")


class _Config(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    enabled: bool
    mode: Literal["live_readonly"]
    host: str
    port: int
    dbname: str
    reader: str
    collector: str
    profile: str
    catalog_pin: str
    expires_at_ms: int = Field(gt=0, le=253402300799999)
    reader_password: SecretStr = Field(repr=False)
    collector_password: SecretStr | None = Field(default=None, repr=False)
    refresh_token: SecretStr | None = Field(default=None, repr=False)
    scopes: tuple[Literal["binance", "coingecko"], ...] = ()
    coingecko_api_key: SecretStr | None = Field(default=None, repr=False)


def _parse(raw: str) -> _Config | None:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in items:
            if key in value:
                raise ValueError()
            value[key] = item
        return value
    try:
        if type(raw) is not str or len(raw) > 16384:
            raise ValueError()
        value = json.loads(raw, object_pairs_hook=pairs)
        if value == {"enabled": False} and type(value["enabled"]) is bool:
            return None
        config = _Config.model_validate_json(raw)
        if not config.enabled:
            raise ValueError()
        return config
    except (ValueError, TypeError):
        raise ValueError("PUBLIC_LIVE_CONFIGURATION") from None


def _environment() -> None:
    # Do not read values or mutate process settings; reject libpq fallback inputs.
    if any(key.startswith("PG") and not re.fullmatch(r"PG[123]_TEST_(ROOT|SOCKET)", key)
           for key in os.environ):
        raise ValueError("PUBLIC_LIVE_ENVIRONMENT")


class _LivePool(PgRepositoryPool):
    """Keep native ACL/catalog/transaction checks, add target and deployment expiry."""
    def __init__(self, conninfo: str, *, target: PublicLiveTarget, user: str,
                 expires: int, clock: Callable[[], int], writable: bool):
        self.target, self.user, self.expires, self.clock = target, user, expires, clock
        super().__init__(conninfo, writable=writable, profile=target.profile,
                         access_contract=RepositoryAccessContract.PUBLIC_DATA_V1,
                         settings=PoolSettings(max_size=2, check_on_checkout=True))
        check = self.check_time

        class BoundConnection(Connection[dict[str, Any]]):
            @classmethod
            def connect(cls, *args: Any, **kwargs: Any) -> Self:
                check()  # Includes background pool replacements, before native connect.
                return super().connect(*args, **kwargs)

        self._pool.connection_class = BoundConnection

    def check_time(self) -> None:
        _environment()
        if self.clock() >= self.expires:
            raise ValueError("PUBLIC_LIVE_EXPIRED")

    @contextmanager
    def transaction(self, *, write: bool = False, scope_id: str = "") -> Iterator[
        Connection[dict[str, Any]]
    ]:
        self.check_time()
        with super().transaction(write=write, scope_id=scope_id) as connection:
            row = connection.execute(
                "SELECT current_database() AS db,session_user AS login,"
                "floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms"
            ).fetchone()
            if (row is None or (row["db"], row["login"]) != (self.target.dbname, self.user)
                    or row["ms"] >= self.expires):
                raise ValueError("PUBLIC_LIVE_TARGET_REJECTED")
            if self.writable:
                policies = connection.execute(
                    "SELECT mode,valid_until_ms FROM public_data.budgets"
                ).fetchall()
                if (len(policies) != 3 or any(p["mode"] != "live_readonly"
                        or p["valid_until_ms"] <= row["ms"] for p in policies)):
                    raise ValueError("PUBLIC_LIVE_POLICY_REJECTED")
                if connection.execute(
                    "SELECT 1 FROM public_data.attempts WHERE mode<>'live_readonly' LIMIT 1"
                ).fetchone():
                    raise ValueError("PUBLIC_LIVE_MODE_REJECTED")
            # Reader retains SELECT on snapshots only; policy access is collector-only.
            if connection.execute(
                "SELECT 1 FROM public_data.snapshots WHERE mode<>'live_readonly' LIMIT 1"
            ).fetchone():
                raise ValueError("PUBLIC_LIVE_MODE_REJECTED")
            self.check_time()
            yield connection
            if write:
                self.check_time()
                end = connection.execute(
                    "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms"
                ).fetchone()
                if end is None or end["ms"] >= self.expires:
                    raise ValueError("PUBLIC_LIVE_EXPIRED")


def create_live_public_app(
    raw: str | None = None, *, target: PublicLiveTarget | None = None,
    service: Literal["reader", "collector"] = "reader",
    transport_factory: TransportFactory | None = None,
    clock_ms: Callable[[], int] = _clock,
) -> FastAPI:
    """Explicit factory, not an environment switch. Local PG requires injected stub.

    Reader rejects collector/provider credentials. Collector retains separate reader
    and writer logins and the existing internal Bearer authentication.
    """
    parsed = _parse(raw) if raw is not None else None
    headers = {"Cache-Control": "no-store"}
    if parsed is None:
        disabled = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

        @disabled.middleware("http")
        async def off(request: Request, call_next: Any) -> JSONResponse:
            return JSONResponse({"code": "PUBLIC_LIVE_DISABLED"}, status_code=503, headers=headers)

        return disabled
    config = parsed
    _environment()
    if (target is None or service not in {"reader", "collector"}
            or tuple(getattr(config, name) for name in ("host", "port", "dbname", "reader",
                    "collector", "catalog_pin")) != (target.host, target.port, target.dbname,
                    target.reader, target.collector, target.catalog_pin)
            or config.profile != target.profile.value or config.expires_at_ms <= clock_ms()
            or len(set(config.scopes)) != len(config.scopes)
            or (target.profile is TargetProfile.LOCAL_PG17 and transport_factory is None)
            or (service == "reader" and (config.collector_password is not None
                or config.refresh_token is not None or config.scopes
                or config.coingecko_api_key is not None))
            or (service == "collector" and (config.collector_password is None
                or config.refresh_token is None or not config.scopes))
            or (bool(config.coingecko_api_key) != ("coingecko" in config.scopes))):
        raise ValueError("PUBLIC_LIVE_CONFIGURATION")
    for secret in (config.reader_password, config.collector_password, config.refresh_token):
        if secret is not None and (not 12 <= len(secret.get_secret_value()) <= 256
                                  or not secret.get_secret_value().isascii()
                                  or any(not 33 <= ord(c) <= 126
                                         for c in secret.get_secret_value())):
            raise ValueError("PUBLIC_LIVE_CONFIGURATION")
    if config.refresh_token is not None and len(config.refresh_token.get_secret_value()) < 32:
        raise ValueError("PUBLIC_LIVE_CONFIGURATION")
    try:
        credentials = PublicDataCredentials(coingecko_api_key=(
            config.coingecko_api_key.get_secret_value() if config.coingecko_api_key else None))
    except ValueError:
        raise ValueError("PUBLIC_LIVE_CONFIGURATION") from None

    def check() -> None:
        _environment()
        if clock_ms() >= config.expires_at_ms:
            raise ValueError("PUBLIC_LIVE_EXPIRED")

    def pool(user: str, password: SecretStr, writable: bool) -> _LivePool:
        check()
        return _LivePool(make_conninfo(host=target.host, port=target.port, dbname=target.dbname,
            user=user, password=password.get_secret_value(), passfile="/dev/null",
            sslmode="disable" if target.profile is TargetProfile.LOCAL_PG17 else "verify-full",
            **({} if target.profile is TargetProfile.LOCAL_PG17 else {
                "sslrootcert": "system", "channel_binding": "require"})),
            target=target, user=user, expires=config.expires_at_ms,
            clock=clock_ms, writable=writable)

    @asynccontextmanager
    async def transports(source: PublicService) -> AsyncIterator[HttpTransport]:
        check()

        class Expiring:
            def __init__(self, base: HttpTransport):
                self.base, self.purpose = base, base.purpose

            async def send(self, request: HttpRequest) -> HttpResponse:
                check()
                response = await self.base.send(request)
                check()
                return response

        if transport_factory is not None:
            async with transport_factory(source) as base:
                yield Expiring(base)
        else:
            network = PublicReadHttpTransport(source, enable_external=True, before_io=check)
            try:
                yield Expiring(network)
            finally:
                await network.aclose()

    reader = pool(target.reader, config.reader_password, False)
    collector = (pool(target.collector, config.collector_password, True)
                 if config.collector_password is not None else None)
    providers = (SharedPublicProviders(mode="live_readonly", enabled_scopes=config.scopes,
                   credentials=credentials, enable_external=True, transport_factory=transports)
                 if collector is not None else None)
    app = create_shared_public_app(reader_pool=reader, mode="live_readonly",
        collector_pool=collector, providers=providers,
        refresh_token=config.refresh_token.get_secret_value() if config.refresh_token else None)
    original = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        check()
        async with original(application):
            yield

    app.router.lifespan_context = lifespan

    @app.middleware("http")
    async def boundary(request: Request, call_next: Any) -> Any:
        if clock_ms() >= config.expires_at_ms:
            return JSONResponse({"code": "PUBLIC_LIVE_EXPIRED"}, status_code=503, headers=headers)
        paths = {"/v1/data/markets", "/v1/data/assets", "/v1/data/news",
                 "/v1/data/explorer/capabilities", "/internal/public-data/refresh"}
        if request.headers.get("origin") is not None:
            return JSONResponse({"code": "PUBLIC_LIVE_FORBIDDEN"}, status_code=403, headers=headers)
        if request.url.path not in paths:
            return JSONResponse({"code": "NOT_FOUND"}, status_code=404, headers=headers)
        response = await call_next(request)
        response.headers.update(headers)
        return response

    return app
