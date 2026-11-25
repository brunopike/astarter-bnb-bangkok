"""Explicit loopback public collector CLI. Import and --help do not open resources."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
from collections.abc import AsyncIterator, Iterator
from contextlib import AsyncExitStack, asynccontextmanager, contextmanager
from pathlib import Path
from types import FrameType

import uvicorn
from fastapi import FastAPI

from stark_trading_os.control.app import create_app
from stark_trading_os.control.public_data_collector import PublicCollectorOwner, PublicDataCollector
from stark_trading_os.control.public_data_policy import MAX_TIME, ProviderPolicy, PublicPolicyStore
from stark_trading_os.control.public_data_service import PublicDataService, provider_fetcher
from stark_trading_os.control.public_data_store import PublicDataStore
from stark_trading_os.integrations.cleanup import join_owned
from stark_trading_os.integrations.public_data import PublicDataProvider
from stark_trading_os.integrations.public_data.network import PublicReadHttpTransport, PublicService
from stark_trading_os.integrations.public_data.providers import PublicDataCredentials
from stark_trading_os.integrations.public_data.resolver import PublicDigResolver

_LOG = logging.getLogger(__name__)
ORIGIN = "http://127.0.0.1:4188"


def _credentials() -> PublicDataCredentials:
    # Only these selected names, only on explicit runtime startup. No dotenv,
    # environment enumeration, logging, persistence or configuration repr.
    tier = os.environ.get("COINGECKO_TIER", "pro")
    if tier not in {"pro", "demo"}:
        raise ValueError("INVALID_PUBLIC_DATA_CONFIGURATION")
    return PublicDataCredentials(
        coingecko_api_key=os.environ.get("COINGECKO_API_KEY"),
        coingecko_tier="demo" if tier == "demo" else "pro",
        blockbeats_api_key=os.environ.get("BLOCKBEATS_API_KEY"),
    )


class PublicCollectorRuntime:
    def __init__(
        self, path: Path, policies: tuple[ProviderPolicy, ...], *, enable_external: bool = False,
        use_dig: bool = False, credentials: PublicDataCredentials | None = None,
        registry_interval_ms: int = 300000,
    ) -> None:
        if not path.is_absolute() or enable_external is not True:
            raise ValueError("PUBLIC_COLLECTOR_EXPLICIT_CONFIGURATION_REQUIRED")
        self.path = path
        self.policies = policies
        self.use_dig = use_dig
        self._credentials = credentials
        self.registry_interval_ms = registry_interval_ms

    def _provider(self, stack: AsyncExitStack) -> PublicDataProvider:
        resolver = PublicDigResolver() if self.use_dig else None
        if resolver is not None:
            stack.push_async_callback(resolver.aclose)
        transports: list[PublicReadHttpTransport] = []
        scopes: tuple[PublicService, ...] = ("BINANCE_SPOT", "COINGECKO_ASSETS", "BLOCKBEATS_NEWS")
        for service in scopes:
            transport = (
                PublicReadHttpTransport(service, enable_external=True)
                if resolver is None else
                PublicReadHttpTransport(service, enable_external=True, resolver=resolver)
            )
            stack.push_async_callback(transport.aclose)
            transports.append(transport)
        return PublicDataProvider(
            market_transport=transports[0], asset_transport=transports[1],
            news_transport=transports[2],
            credentials=self._credentials if self._credentials is not None else _credentials(),
        )

    @asynccontextmanager
    async def open(self) -> AsyncIterator[PublicDataCollector]:
        stack = AsyncExitStack()
        try:
            owner = PublicCollectorOwner(self.path)
            owner.acquire()  # Exclusion before provider construction or any DNS.
            stack.callback(owner.close)
            store = PublicDataStore(owner.path, mode="live_readonly")
            stack.callback(store.close)
            policy = PublicPolicyStore(owner.path, mode=store.mode, policies=self.policies)
            stack.callback(policy.close)
            provider = self._provider(stack)
            if provider.mode != store.mode:
                raise ValueError("PUBLIC_COLLECTOR_MODE_MISMATCH")
            service = PublicDataService(provider_fetcher(provider), store=store, snapshot_only=True)
            stack.push_async_callback(service.close)
            collector = PublicDataCollector(
                service, policy, owner, registry_interval_ms=self.registry_interval_ms,
            )
            stack.push_async_callback(collector.close)
            collector.start()
            _LOG.info("PUBLIC_COLLECTOR_STARTED")
            yield collector
        except asyncio.CancelledError:
            raise
        except Exception:
            raise RuntimeError("PUBLIC_COLLECTOR_RUNTIME_FAILED") from None
        finally:
            try:
                # Existing owned-cleanup primitive defers even repeated cancellation.
                # LIFO: workers, service, transports, resolver, policy, store, lease.
                await join_owned(asyncio.create_task(stack.aclose()))
            except asyncio.CancelledError:
                raise
            except Exception:
                raise RuntimeError("PUBLIC_COLLECTOR_CLEANUP_FAILED") from None
            finally:
                _LOG.info("PUBLIC_COLLECTOR_STOPPED")

    def application(self) -> FastAPI:
        return create_app(
            public_data_enabled=True, public_data_only=True, web_local_origin=ORIGIN,
            public_data_runtime=self.open,
        )


class _LocalServer(uvicorn.Server):
    @contextmanager
    def capture_signals(self) -> Iterator[None]:
        # The outer runtime owns signals, including startup and cleanup. Uvicorn
        # must not re-raise SIGTERM before the outer resource context has exited.
        yield


@contextmanager
def _signals(server: uvicorn.Server) -> Iterator[None]:
    def stop(_number: int, _frame: FrameType | None) -> None:
        server.should_exit = True

    previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


async def serve(runtime: PublicCollectorRuntime, *, duration_seconds: int) -> None:
    # Match the public timestamp range; reject huge ints before asyncio's float timer.
    if type(duration_seconds) is not int or not 1 <= duration_seconds <= MAX_TIME // 1000:
        raise ValueError("PUBLIC_COLLECTOR_DURATION_INVALID")
    app = runtime.application()
    # Lifespan is owned here exactly once, including bind/server exceptions.
    server = _LocalServer(uvicorn.Config(
        app, host="127.0.0.1", port=8765, lifespan="off", workers=1,
        access_log=False, log_config=None, proxy_headers=False,
        timeout_graceful_shutdown=5,
    ))
    with _signals(server):
        async with app.router.lifespan_context(app):
            collector: PublicDataCollector = app.state.public_data_collector

            async def stop_when_done() -> None:
                try:
                    async with asyncio.timeout(duration_seconds):
                        await collector.failed.wait()
                except TimeoutError:
                    pass
                server.should_exit = True

            stopper = asyncio.create_task(stop_when_done())
            try:
                await server.serve()
                if collector.failed.is_set():
                    raise RuntimeError("PUBLIC_COLLECTOR_FAILED_CLOSED")
            finally:
                stopper.cancel()
                await asyncio.gather(stopper, return_exceptions=True)
                if server.started and any(s.is_serving() for s in server.servers):
                    await join_owned(asyncio.create_task(server.shutdown()))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(
        "Explicit public read-only collector on 127.0.0.1:8765; Origin 127.0.0.1:4188. "
        "Caps are operator reserved HTTP weights per UTC day, not vendor entitlements."
    ))
    parser.add_argument("--enable-external", action="store_true", required=True)
    parser.add_argument(
        "--db", type=Path, required=True, help="Absolute separate public SQLite path",
    )
    parser.add_argument("--duration-seconds", type=int, required=True)
    parser.add_argument("--dig-resolver", action="store_true", help="Opt in to PublicDigResolver")
    for scope, seconds in (("binance", 10), ("coingecko", 300), ("blockbeats", 60)):
        parser.add_argument(f"--{scope}-daily-cap", type=int, required=True)
        parser.add_argument(f"--{scope}-interval-seconds", type=int, default=seconds)
    parser.add_argument("--registry-interval-seconds", type=int, default=300)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        policies = (
            ProviderPolicy("binance", args.binance_daily_cap, args.binance_interval_seconds * 1000),
            ProviderPolicy("coingecko", args.coingecko_daily_cap,
                           args.coingecko_interval_seconds * 1000),
            ProviderPolicy("blockbeats", args.blockbeats_daily_cap,
                           args.blockbeats_interval_seconds * 1000),
        )
        runtime = PublicCollectorRuntime(
            args.db, policies, enable_external=args.enable_external, use_dig=args.dig_resolver,
            registry_interval_ms=args.registry_interval_seconds * 1000,
        )
        asyncio.run(serve(runtime, duration_seconds=args.duration_seconds))
    except KeyboardInterrupt:
        return 130
    except (Exception, SystemExit):
        _LOG.error("PUBLIC_COLLECTOR_STOPPED_WITH_ERROR")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
