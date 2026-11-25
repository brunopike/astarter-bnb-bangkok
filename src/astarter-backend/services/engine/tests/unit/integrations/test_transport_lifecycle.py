"""Formal RC1/RC2 regressions. All resources are cooperative synthetic components."""

import asyncio
import socket
import traceback

import httpx
import pytest

from stark_trading_os.integrations.bounded_http import BoundedHttpTransport
from stark_trading_os.integrations.transport import HttpRequest, TransportRejected

URL = "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT&type=FULL"


@pytest.fixture(autouse=True)
def deny_network(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError("LIFECYCLE_NETWORK_FORBIDDEN")

    monkeypatch.setattr(socket, "getaddrinfo", denied)
    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(socket.socket, "connect_ex", denied)


class Wire(httpx.AsyncBaseTransport):
    def __init__(self, *, stream=None, close_gate=None, close_error=False, close_delay=0):
        self.stream = stream
        self.close_gate = close_gate
        self.close_error = close_error
        self.close_delay = close_delay
        self.closing = asyncio.Event()
        self.closed = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.close_calls = 0
        self.dispatches = 0

    async def handle_async_request(self, request):
        self.dispatches += 1
        if self.stream is not None:
            return httpx.Response(200, stream=self.stream)
        return httpx.Response(200, json={})

    async def aclose(self):
        self.close_calls += 1
        self.closing.set()
        try:
            if self.close_delay:
                await asyncio.sleep(self.close_delay)
            if self.close_gate is not None:
                await self.close_gate.wait()
            if self.close_error:
                raise RuntimeError("synthetic-private-close-error")
            self.closed.set()
        except asyncio.CancelledError:
            self.cancelled.set()
            raise


class Stream(httpx.AsyncByteStream):
    def __init__(self, *, block_read=False, close_gate=None, close_delay=0):
        self.block_read = block_read
        self.close_gate = close_gate
        self.close_delay = close_delay
        self.reading = asyncio.Event()
        self.closing = asyncio.Event()
        self.closed = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.close_calls = 0

    async def __aiter__(self):
        self.reading.set()
        if self.block_read:
            await asyncio.Event().wait()
        yield b"{}"

    async def aclose(self):
        self.close_calls += 1
        self.closing.set()
        try:
            if self.close_gate is not None:
                await self.close_gate.wait()
            if self.close_delay:
                await asyncio.sleep(self.close_delay)
            self.closed.set()
        except asyncio.CancelledError:
            self.cancelled.set()
            raise


async def entered(event):
    await asyncio.wait_for(event.wait(), 1)


@pytest.mark.asyncio
async def test_context_exit_preserves_real_task_cancellation():
    body = asyncio.Event()
    wire = Wire(close_error=True)
    boundary = BoundedHttpTransport("BINANCE_SPOT", offline_transport=wire)

    async def run():
        async with boundary:
            body.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(run())
    await entered(body)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert wire.close_calls == 1
    assert (await boundary.wait_closed()).state == "FAILED"


@pytest.mark.asyncio
async def test_context_exit_preserves_original_policy_rejection():
    wire = Wire(close_error=True)
    boundary = BoundedHttpTransport("BINANCE_SPOT", offline_transport=wire)
    with pytest.raises(TransportRejected, match="REQUEST_POLICY_REJECTED") as error:
        async with boundary:
            await boundary.send(HttpRequest("GET", "https://invalid.example/"))
    assert "synthetic-private-close-error" not in "".join(traceback.format_exception(error.value))
    assert wire.close_calls == 1 and wire.dispatches == 0


@pytest.mark.asyncio
async def test_eof_deadline_waits_for_cooperative_stream_close():
    stream = Stream(close_delay=0.04)
    wire = Wire(stream=stream)
    boundary = BoundedHttpTransport("BINANCE_SPOT", offline_transport=wire, timeout_seconds=0.005)
    with pytest.raises(TransportRejected, match="TRANSPORT_TIMEOUT"):
        await boundary.send(HttpRequest("GET", URL))
    await boundary.aclose()
    assert stream.closed.is_set() and not stream.cancelled.is_set()
    assert stream.close_calls == 1 and wire.closed.is_set()
    assert not boundary._pending


@pytest.mark.asyncio
async def test_shutdown_does_not_interrupt_already_running_cleanup():
    release = asyncio.Event()
    stream = Stream(block_read=True, close_gate=release)
    wire = Wire(stream=stream)
    boundary = BoundedHttpTransport("BINANCE_SPOT", offline_transport=wire)
    request = asyncio.create_task(boundary.send(HttpRequest("GET", URL)))
    await entered(stream.reading)
    request.cancel()
    await entered(stream.closing)
    shutdown = asyncio.create_task(boundary.aclose())
    await asyncio.sleep(0.01)
    assert not shutdown.done(), "shutdown must wait for the owned stream close"
    release.set()
    await shutdown
    with pytest.raises(asyncio.CancelledError):
        await request
    assert stream.closed.is_set() and not stream.cancelled.is_set()
    assert stream.close_calls == 1 and wire.close_calls == 1


@pytest.mark.asyncio
async def test_concurrent_closers_wait_for_one_real_completion():
    release = asyncio.Event()
    wire = Wire(close_gate=release)
    boundary = BoundedHttpTransport("BINANCE_SPOT", offline_transport=wire)
    first = asyncio.create_task(boundary.aclose())
    await entered(wire.closing)
    second = asyncio.create_task(boundary.aclose())
    await asyncio.sleep(0.01)
    assert not second.done(), "HTTPX CLOSED is not evidence of actual completion"
    assert boundary.close_result is None
    release.set()
    await asyncio.gather(first, second)
    assert wire.closed.is_set() and wire.close_calls == 1
    assert (await boundary.wait_closed()).release_confirmed


@pytest.mark.asyncio
async def test_cancelled_close_caller_still_joins_shared_cleanup():
    release = asyncio.Event()
    wire = Wire(close_gate=release)
    boundary = BoundedHttpTransport("BINANCE_SPOT", offline_transport=wire)
    first = asyncio.create_task(boundary.aclose())
    await entered(wire.closing)
    first.cancel()
    second = asyncio.create_task(boundary.aclose())
    await asyncio.sleep(0.01)
    first.cancel()
    assert not first.done() and not second.done()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await first
    await second
    await boundary.aclose()
    assert wire.closed.is_set() and not wire.cancelled.is_set()
    assert wire.close_calls == 1


@pytest.mark.asyncio
async def test_new_cancellation_during_context_close_is_not_swallowed():
    release = asyncio.Event()
    wire = Wire(close_gate=release)
    boundary = BoundedHttpTransport("BINANCE_SPOT", offline_transport=wire)

    async def run():
        async with boundary:
            raise ValueError("original-body-error")

    task = asyncio.create_task(run())
    await entered(wire.closing)
    task.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert wire.closed.is_set() and wire.close_calls == 1


@pytest.mark.asyncio
async def test_cleanup_timeout_is_terminal_waitable_and_never_success():
    tasks_before = asyncio.all_tasks()
    wire = Wire(close_gate=asyncio.Event())
    boundary = BoundedHttpTransport(
        "BINANCE_SPOT",
        offline_transport=wire,
        cleanup_timeout_seconds=0.02,
    )
    with pytest.raises(TransportRejected, match="CLEANUP_TIMEOUT"):
        await boundary.aclose()
    result = await boundary.wait_closed()
    assert result.state == "TIMED_OUT" and not result.release_confirmed
    assert boundary.close_result == result
    assert wire.cancelled.is_set() and not wire.closed.is_set()
    with pytest.raises(TransportRejected, match="CLEANUP_TIMEOUT"):
        await boundary.aclose()
    with pytest.raises(TransportRejected, match="TRANSPORT_CLOSED"):
        await boundary.send(HttpRequest("GET", URL))
    assert wire.close_calls == 1 and wire.dispatches == 0
    assert not (asyncio.all_tasks() - tasks_before)


@pytest.mark.asyncio
async def test_close_failure_without_original_error_remains_failed_on_repeated_close():
    wire = Wire(close_error=True)
    boundary = BoundedHttpTransport("BINANCE_SPOT", offline_transport=wire)
    with pytest.raises(TransportRejected, match="TRANSPORT_UNAVAILABLE") as error:
        async with boundary:
            pass
    assert error.value.__context__ is None and error.value.__cause__ is None
    assert "synthetic-private-close-error" not in "".join(traceback.format_exception(error.value))
    result = await boundary.wait_closed()
    assert result.state == "FAILED" and not result.release_confirmed
    with pytest.raises(TransportRejected, match="TRANSPORT_UNAVAILABLE"):
        await boundary.aclose()
    assert wire.close_calls == 1


@pytest.mark.asyncio
async def test_stream_cleanup_timeout_blocks_new_work_and_retains_failed_terminal():
    tasks_before = asyncio.all_tasks()
    stream = Stream(close_gate=asyncio.Event())
    wire = Wire(stream=stream)
    boundary = BoundedHttpTransport(
        "BINANCE_SPOT",
        offline_transport=wire,
        cleanup_timeout_seconds=0.02,
    )
    with pytest.raises(TransportRejected, match="CLEANUP_TIMEOUT"):
        await boundary.send(HttpRequest("GET", URL))
    assert stream.cancelled.is_set() and not stream.closed.is_set()
    with pytest.raises(TransportRejected, match="TRANSPORT_CLOSED"):
        await boundary.send(HttpRequest("GET", URL))
    result = await boundary.wait_closed()
    assert result.state == "TIMED_OUT" and not result.release_confirmed
    assert wire.closed.is_set() and wire.dispatches == 1
    assert not boundary._pending
    assert not (asyncio.all_tasks() - tasks_before)


@pytest.mark.asyncio
async def test_repeated_request_cancellation_cannot_detach_stream_cleanup():
    tasks_before = asyncio.all_tasks()
    release = asyncio.Event()
    stream = Stream(block_read=True, close_gate=release)
    wire = Wire(stream=stream)
    boundary = BoundedHttpTransport("BINANCE_SPOT", offline_transport=wire)
    request = asyncio.create_task(boundary.send(HttpRequest("GET", URL)))
    await entered(stream.reading)
    request.cancel()
    await entered(stream.closing)
    request.cancel()
    await asyncio.sleep(0.01)
    assert not request.done() and not stream.cancelled.is_set()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await request
    assert (await boundary.wait_closed()).release_confirmed
    assert stream.closed.is_set() and stream.close_calls == 1
    assert not (asyncio.all_tasks() - tasks_before)


@pytest.mark.asyncio
async def test_shutdown_budget_is_shared_not_refreshed_for_wire_after_stream():
    tasks_before = asyncio.all_tasks()
    stream = Stream(block_read=True, close_delay=0.1)
    wire = Wire(stream=stream, close_delay=0.1)
    boundary = BoundedHttpTransport(
        "BINANCE_SPOT",
        offline_transport=wire,
        cleanup_timeout_seconds=0.15,
    )
    request = asyncio.create_task(boundary.send(HttpRequest("GET", URL)))
    await entered(stream.reading)
    result = await boundary.wait_closed()
    with pytest.raises(asyncio.CancelledError):
        await request
    assert result.state == "TIMED_OUT" and not result.release_confirmed
    assert stream.closed.is_set() and stream.close_calls == 1
    assert not wire.closed.is_set()
    assert wire.cancelled.is_set() or wire.close_calls == 0
    assert not (asyncio.all_tasks() - tasks_before)
