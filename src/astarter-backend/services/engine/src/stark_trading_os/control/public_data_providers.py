"""Explicit provider assembly for shared PUBLIC refresh; cold/default is zero IO."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, AsyncExitStack, asynccontextmanager
from dataclasses import dataclass, field

from stark_trading_os.control.public_data_models import PublicDataQuery
from stark_trading_os.control.public_data_policy import ProviderScope
from stark_trading_os.control.public_data_service import PublicDataFetcher, provider_fetcher
from stark_trading_os.integrations.cleanup import join_owned
from stark_trading_os.integrations.public_data import PublicDataCredentials, PublicDataProvider
from stark_trading_os.integrations.public_data.models import Mode
from stark_trading_os.integrations.public_data.network import PublicReadHttpTransport, PublicService
from stark_trading_os.integrations.transport import HttpTransport

type TransportFactory = Callable[[PublicService], AbstractAsyncContextManager[HttpTransport]]
_SCOPES: dict[str, tuple[ProviderScope, PublicService]] = {
    "markets": ("binance", "BINANCE_SPOT"),
    "assets": ("coingecko", "COINGECKO_ASSETS"),
    "news": ("blockbeats", "BLOCKBEATS_NEWS"),
}


@dataclass(frozen=True, slots=True)
class SharedPublicProviders:
    """Trusted server configuration, not an HTTP payload or vendor entitlement.

    DB policies remain the authority for budget/expiry. Enable a paid scope only
    after its entitlement is verified. Keys and transport factories are never repr'd.
    """

    mode: Mode
    enabled_scopes: tuple[ProviderScope, ...] = ()
    credentials: PublicDataCredentials = field(default_factory=PublicDataCredentials, repr=False)
    enable_external: bool = False
    transport_factory: TransportFactory | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if (
            self.mode not in {"offline_fixture", "live_readonly"}
            or type(self.enabled_scopes) is not tuple
            or any(
                scope not in {"binance", "coingecko", "blockbeats"} for scope in self.enabled_scopes
            )
            or len(set(self.enabled_scopes)) != len(self.enabled_scopes)
            or not isinstance(self.credentials, PublicDataCredentials)
            or type(self.enable_external) is not bool
            or (self.enable_external and self.mode != "live_readonly")
        ):
            raise ValueError("PUBLIC_PROVIDER_CONFIGURATION")

    @property
    def configured_scopes(self) -> tuple[ProviderScope, ...]:
        if self.mode == "live_readonly" and not self.enable_external:
            return ()
        if self.mode == "offline_fixture" and self.transport_factory is None:
            return ()
        keys = {
            "binance": True,
            "coingecko": bool(self.credentials.coingecko_api_key),
            "blockbeats": bool(self.credentials.blockbeats_api_key),
        }
        return tuple(scope for scope in self.enabled_scopes if keys[scope])

    @asynccontextmanager
    async def open(self) -> AsyncIterator[PublicDataFetcher]:
        stack = AsyncExitStack()
        used = False

        async def fetch(query: PublicDataQuery) -> object:
            nonlocal used
            selected = _SCOPES.get(query.resource)
            if used or selected is None or selected[0] not in self.configured_scopes:
                raise ValueError("PUBLIC_PROVIDER_NOT_CONFIGURED")
            used = True  # A reserved refresh owns one canonical provider operation.
            scope, service = selected
            if self.transport_factory is not None:
                transport = await stack.enter_async_context(self.transport_factory(service))
            else:
                transport = PublicReadHttpTransport(service, enable_external=True)
                stack.push_async_callback(transport.aclose)
            expected = (
                "OFFLINE_FIXTURE" if self.mode == "offline_fixture" else "EXTERNAL_OBSERVATION"
            )
            if transport.purpose != expected:
                raise ValueError("PUBLIC_PROVIDER_MODE_MISMATCH")
            provider = PublicDataProvider(
                market_transport=transport if scope == "binance" else None,
                asset_transport=transport if scope == "coingecko" else None,
                news_transport=transport if scope == "blockbeats" else None,
                credentials=self.credentials,
            )
            return await provider_fetcher(provider)(query)

        try:
            yield fetch
        finally:
            await join_owned(asyncio.create_task(stack.aclose()))
