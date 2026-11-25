"""Explicit runtime ownership, cross-process lease, cancellation and signal evidence."""

from __future__ import annotations

import asyncio
import multiprocessing
import os
import signal
import socket
import sqlite3
import subprocess
import sys
from contextlib import AsyncExitStack
from multiprocessing.connection import Connection
from multiprocessing.process import BaseProcess
from pathlib import Path
from typing import Literal, cast

import pytest

from stark_trading_os.control import public_data_runtime as module
from stark_trading_os.control.app import create_app
from stark_trading_os.control.public_data_collector import (
    PublicCollectorOwner,
    PublicCollectorOwnerError,
)
from stark_trading_os.control.public_data_policy import (
    ProviderPolicy,
    PublicPolicyStore,
    policy_path,
)
from stark_trading_os.control.public_data_runtime import PublicCollectorRuntime
from stark_trading_os.control.public_data_service import PublicDataService
from stark_trading_os.control.public_data_store import PublicDataStore, PublicDataStoreError
from stark_trading_os.integrations.contracts import Purpose
from stark_trading_os.integrations.public_data import PublicDataProvider
from stark_trading_os.integrations.public_data.network import PublicService, Resolver
from stark_trading_os.integrations.public_data.providers import PublicDataCredentials
from stark_trading_os.integrations.transport import HttpRequest, HttpResponse
from tests.unit.control.test_public_data_collection import POLICIES

ZERO_POLICIES = (
    ProviderPolicy("binance", 0, 10000), ProviderPolicy("coingecko", 0, 300000),
    ProviderPolicy("blockbeats", 0, 60000),
)


class NoNetworkRuntime(PublicCollectorRuntime):
    def _provider(self, stack: AsyncExitStack) -> PublicDataProvider:
        return PublicDataProvider()


def test_default_import_help_and_app_have_no_db_dns_or_loops(tmp_path: Path) -> None:
    code = """
import asyncio, socket, sqlite3, sys
from pathlib import Path

def forbidden(*args, **kwargs):
    raise AssertionError('unexpected I/O')
sqlite3.connect = forbidden
socket.getaddrinfo = forbidden
socket.socket = forbidden
asyncio.create_task = forbidden
from stark_trading_os.control.public_data_runtime import main
from stark_trading_os.control.app import create_app
app = create_app(testing=True)
assert app.state.public_data_service is None
assert not any(p.startswith('/v1/data/') for p in app.openapi()['paths'])
main(['--help'])
"""
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "--binance-daily-cap" in result.stdout
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_existing_control_db_rejected_before_provider_and_schema_mutation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "control-copy.sqlite"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE control_commands (id TEXT PRIMARY KEY)")
        db.execute("INSERT INTO control_commands VALUES ('synthetic')")
    before = path.read_bytes()

    def forbidden(self: PublicCollectorRuntime, stack: AsyncExitStack) -> PublicDataProvider:
        pytest.fail("provider cannot be constructed for incompatible DB")

    monkeypatch.setattr(PublicCollectorRuntime, "_provider", forbidden)
    runtime = PublicCollectorRuntime(path, POLICIES, enable_external=True)
    with pytest.raises(RuntimeError, match="^PUBLIC_COLLECTOR_RUNTIME_FAILED$"):
        async with runtime.open():
            pytest.fail("must reject Control copy")
    assert path.read_bytes() == before
    assert not policy_path(path).exists()
    owner = PublicCollectorOwner(path)
    owner.acquire()
    owner.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", [
    "normal", "transport_start", "transport_close", "resolver_close",
    "service_close", "policy_close", "store_close",
])
async def test_unique_cleanup_owners_even_with_startup_and_shutdown_exceptions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stage: str,
) -> None:
    events: list[str] = []
    path = tmp_path / "public.sqlite"

    class Transport:
        purpose: Purpose = "EXTERNAL_OBSERVATION"

        def __init__(
            self, service: PublicService, *, enable_external: bool,
            resolver: Resolver | None = None,
        ) -> None:
            self.service = service
            if stage == "transport_start" and service == "COINGECKO_ASSETS":
                raise RuntimeError("synthetic-private-startup")
            events.append("open:" + service)

        async def send(self, request: HttpRequest) -> HttpResponse:
            pytest.fail("zero caps must prohibit any HTTP or DNS")

        async def aclose(self) -> None:
            events.append("close:" + self.service)
            if stage == "transport_close" and self.service == "COINGECKO_ASSETS":
                raise RuntimeError("synthetic-private-cleanup")

    class ResolverOwner:
        async def __call__(self, host: str) -> tuple[str, ...]:
            pytest.fail("zero caps must not resolve")

        async def aclose(self) -> None:
            events.append("resolver")
            if stage == "resolver_close":
                raise RuntimeError("synthetic-private-resolver")

    class Store(PublicDataStore):
        def close(self) -> None:
            events.append("store")
            super().close()
            if stage == "store_close":
                raise RuntimeError("synthetic-private-store")

    class Policy(PublicPolicyStore):
        def close(self) -> None:
            events.append("policy")
            super().close()
            if stage == "policy_close":
                raise RuntimeError("synthetic-private-policy")

    class Service(PublicDataService):
        async def close(self) -> None:
            await super().close()
            if stage == "service_close":
                raise RuntimeError("synthetic-private-service")

    monkeypatch.setattr(module, "PublicReadHttpTransport", Transport)
    monkeypatch.setattr(module, "PublicDigResolver", ResolverOwner)
    monkeypatch.setattr(module, "PublicDataStore", Store)
    monkeypatch.setattr(module, "PublicPolicyStore", Policy)
    monkeypatch.setattr(module, "PublicDataService", Service)
    runtime = PublicCollectorRuntime(path, ZERO_POLICIES, enable_external=True,
                                     use_dig=True, credentials=PublicDataCredentials())

    async def run() -> None:
        async with runtime.open() as collector:
            with pytest.raises(RuntimeError, match="^PUBLIC_COLLECTOR_RUNTIME_FAILED$"):
                async with runtime.open():
                    pytest.fail("second runtime must not start")
            assert collector.service.snapshot_only

    if stage == "normal":
        await run()
    else:
        with pytest.raises(RuntimeError, match="^PUBLIC_COLLECTOR_(RUNTIME|CLEANUP)_FAILED$"):
            await run()
    for service in ("BINANCE_SPOT", "COINGECKO_ASSETS", "BLOCKBEATS_NEWS"):
        assert events.count("close:" + service) == events.count("open:" + service)
        assert events.count("close:" + service) <= 1
    assert events.count("resolver") == events.count("store") == events.count("policy") == 1
    assert events[-2:] == ["policy", "store"]
    owner = PublicCollectorOwner(path)
    owner.acquire()
    owner.close()


@pytest.mark.asyncio
async def test_cancelled_runtime_waits_for_cleanup_before_releasing_owner(tmp_path: Path) -> None:
    entered, closing, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    events: list[str] = []
    path = tmp_path / "public.sqlite"

    class Runtime(NoNetworkRuntime):
        def _provider(self, stack: AsyncExitStack) -> PublicDataProvider:
            async def cleanup() -> None:
                closing.set()
                await release.wait()
                events.append("closed")
            stack.push_async_callback(cleanup)
            return super()._provider(stack)

    runtime = Runtime(path, ZERO_POLICIES, enable_external=True)

    async def run() -> None:
        async with runtime.open():
            entered.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(run())
    await asyncio.wait_for(entered.wait(), 2)
    task.cancel()
    await asyncio.wait_for(closing.wait(), 2)
    task.cancel()  # second cancellation must not detach cleanup
    probe = PublicCollectorOwner(path)
    with pytest.raises(PublicCollectorOwnerError):
        probe.acquire()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert events == ["closed"]
    probe.acquire()
    probe.close()


def _owner_child(path: str, channel: Connection) -> None:
    class Runtime(NoNetworkRuntime):
        def _provider(self, stack: AsyncExitStack) -> PublicDataProvider:
            channel.send("provider")
            return super()._provider(stack)

    async def run() -> None:
        runtime = Runtime(Path(path), ZERO_POLICIES, enable_external=True)
        try:
            async with runtime.open():
                channel.send("owned")
                channel.recv()  # parent crash probe, no worker or network runs here
        except RuntimeError:
            channel.send("blocked")

    asyncio.run(run())
    channel.close()


def test_independent_owner_exclusion_readers_crash_release_and_aliases(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    context = multiprocessing.get_context("spawn")
    channels: list[Connection] = []
    processes: list[BaseProcess] = []

    def start(target: Path) -> Connection:
        parent, child = context.Pipe()
        process = context.Process(target=_owner_child, args=(str(target), child))
        process.start()
        child.close()
        channels.append(parent)
        processes.append(process)
        return parent

    try:
        first = start(path)
        assert first.poll(10) and first.recv() == "provider"
        assert first.poll(10) and first.recv() == "owned"
        alias = tmp_path / "alias.sqlite"
        alias.symlink_to(path)
        second = start(alias)
        assert second.poll(10) and second.recv() == "blocked"  # before provider construction
        processes[1].join(10)
        assert processes[1].exitcode == 0
        reader = PublicDataStore(path, mode="live_readonly")
        assert reader.load("news") is None  # reader never acquires writer lease
        reader.close()
        processes[0].kill()
        processes[0].join(10)
        assert processes[0].exitcode == -signal.SIGKILL
        third = start(path)
        assert third.poll(10) and third.recv() == "provider"
        assert third.poll(10) and third.recv() == "owned"
        third.send("stop")
        processes[2].join(10)
        assert processes[2].exitcode == 0
        assert path.with_name(path.name + ".collector.lock").exists()  # never unlink lease file
        hardlink = tmp_path / "hardlink.sqlite"
        os.link(path, hardlink)
        with pytest.raises(PublicCollectorOwnerError):
            PublicCollectorOwner(hardlink).acquire()
    finally:
        for process in processes:
            if process.is_alive():
                process.kill()
                process.join(10)
        for channel in channels:
            channel.close()


def _signal_child(path: str, channel: Connection) -> None:
    class Server(module._LocalServer):
        @property
        def should_exit(self) -> bool:
            return self._exit

        @should_exit.setter
        def should_exit(self, value: bool) -> None:
            self._exit = value
            if value and hasattr(self, "wake"):
                self.wake.set()

        async def serve(self, sockets: list[socket.socket] | None = None) -> None:
            self.wake = asyncio.Event()
            channel.send("ready")
            await self.wake.wait()  # exercise outer signal + lifespan; never bind a socket

    setattr(module, "_LocalServer", Server)
    runtime = NoNetworkRuntime(Path(path), ZERO_POLICIES, enable_external=True)
    asyncio.run(module.serve(runtime, duration_seconds=60))
    channel.send("stopped")
    channel.close()


@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGINT])
def test_runtime_signal_shutdown_releases_lease_without_network(tmp_path: Path, sig: int) -> None:
    path = tmp_path / "public.sqlite"
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe()
    process = context.Process(target=_signal_child, args=(str(path), child))
    process.start()
    child.close()
    try:
        assert parent.poll(10) and parent.recv() == "ready"
        os.kill(process.pid or 0, sig)
        assert parent.poll(10) and parent.recv() == "stopped"
        process.join(10)
        assert process.exitcode == 0
        owner = PublicCollectorOwner(path)
        owner.acquire()
        owner.close()
    finally:
        if process.is_alive():
            process.kill()
            process.join(10)
        parent.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("duration_seconds", [172802, 253402300799])
async def test_duration_beyond_known_recovery_window_enters_and_cleans_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, duration_seconds: int,
) -> None:
    path = tmp_path / "public.sqlite"
    runtime = NoNetworkRuntime(path, ZERO_POLICIES, enable_external=True)
    app = runtime.application()
    stores: list[PublicDataStore] = []
    probe = PublicCollectorOwner(path)

    async def finish(self: module._LocalServer, sockets: list[socket.socket] | None = None) -> None:
        stores.append(app.state.public_data_collector.service.store)
        with pytest.raises(PublicCollectorOwnerError):
            probe.acquire()  # The real lifespan must hold the lease while serving.
        await asyncio.sleep(0)  # Let the actual duration timer start; never bind or wait days.

    monkeypatch.setattr(runtime, "application", lambda: app)
    monkeypatch.setattr(module._LocalServer, "serve", finish)
    await module.serve(runtime, duration_seconds=duration_seconds)
    assert len(stores) == 1
    with pytest.raises(PublicDataStoreError):
        stores[0].load("news")
    probe.acquire()
    probe.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("duration", [
    0, -1, True, False, 1.0, "1", None, float("inf"), float("nan"),
    253402300800, pytest.param(10 ** 1000, id="nonrepresentable-int"),
])
async def test_invalid_duration_rejected_before_application_startup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, duration: object,
) -> None:
    runtime = NoNetworkRuntime(tmp_path / "public.sqlite", ZERO_POLICIES, enable_external=True)

    def forbidden() -> None:
        pytest.fail("invalid duration must not construct the application or open resources")

    monkeypatch.setattr(runtime, "application", forbidden)
    with pytest.raises(ValueError, match="^PUBLIC_COLLECTOR_DURATION_INVALID$"):
        await module.serve(runtime, duration_seconds=cast(int, duration))
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(("duration", "exit_code"), [
    (None, 2), ("0", 1), ("-1", 1), ("1.5", 2), ("true", 2),
    ("253402300800", 1), pytest.param(str(10 ** 1000), 1, id="nonrepresentable-int"),
])
def test_cli_duration_is_required_and_invalid_values_never_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, duration: str | None, exit_code: int,
) -> None:
    def forbidden(self: PublicCollectorRuntime) -> None:
        pytest.fail("invalid CLI duration must not start the application")

    monkeypatch.setattr(PublicCollectorRuntime, "application", forbidden)
    argv = [
        "--enable-external", "--db", str(tmp_path / "public.sqlite"),
        "--binance-daily-cap", "0", "--coingecko-daily-cap", "0", "--blockbeats-daily-cap", "0",
    ]
    if duration is not None:
        argv.extend(["--duration-seconds", duration])
    if exit_code == 2:
        with pytest.raises(SystemExit) as error:
            module.main(argv)
        assert error.value.code == exit_code
    else:
        assert module.main(argv) == exit_code
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["bind", "server"])
async def test_server_exception_cleans_runtime_and_managed_app_cannot_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: Literal["bind", "server"],
) -> None:
    path = tmp_path / "public.sqlite"
    runtime = NoNetworkRuntime(path, ZERO_POLICIES, enable_external=True)

    async def fail(self: module._LocalServer, sockets: list[socket.socket] | None = None) -> None:
        if failure == "bind":
            raise SystemExit(1)
        raise RuntimeError("synthetic server error")

    monkeypatch.setattr(module._LocalServer, "serve", fail)
    with pytest.raises((SystemExit, RuntimeError)):
        await module.serve(runtime, duration_seconds=1)
    owner = PublicCollectorOwner(path)
    owner.acquire()
    owner.close()
    other = PublicDataStore(tmp_path / "other.sqlite", mode="live_readonly")
    try:
        with pytest.raises(ValueError, match="EXCLUSIVE"):
            create_app(testing=True, public_data_enabled=True, public_data_only=True,
                       public_data_runtime=runtime.open, public_data_store=other)
    finally:
        other.close()


@pytest.mark.asyncio
async def test_runtime_closes_store_and_modes_do_not_cross_poison(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    runtime = NoNetworkRuntime(path, ZERO_POLICIES, enable_external=True)
    async with runtime.open() as collector:
        store = collector.service.store
    with pytest.raises(PublicDataStoreError):
        store.load("news")
    policy = PublicPolicyStore(path, mode="offline_fixture", policies=POLICIES)
    assert policy.reserve("binance", 100000, 0) is None
    policy.close()
    # Live and fixture policies are isolated; pending fixture cannot poison live startup.
    async with runtime.open():
        pass
