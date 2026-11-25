"""No DNS, secrets or HTTP: subprocess doubles, local Python children and dig -h only."""

from __future__ import annotations

import asyncio
import subprocess
import sys

import pytest

HOST = "api.binance.com"


def answer(*records, status="NOERROR", flags="qr rd ra"):
    return (
        f";; ->>HEADER<<- opcode: QUERY, status: {status}, id: 12\n"
        f";; flags: {flags}; QUERY: 1, ANSWER: {len(records)}, AUTHORITY: 0, ADDITIONAL: 0\n"
        + "\n".join(records)
        + "\n"
    ).encode()


GOOD = answer("api.binance.com. 60 IN CNAME edge.example.", "edge.example. 30 IN A 8.8.8.8")


class Handle:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class Reader:
    def __init__(self, content, gate=None):
        self.content = content
        self.gate = gate
        self._transport = Handle()

    async def read(self, size):
        if self.gate:
            await self.gate.wait()
        part, self.content = self.content[:size], self.content[size:]
        return part


class Process:
    def __init__(self, content=GOOD, gate=None, returncode=0, wait_gate=None):
        self.stdout = Reader(content, gate)
        self.stderr = None
        self._transport = Handle()
        self.returncode = None
        self.exit_code = returncode
        self.killed = False
        self.waits = 0
        self.wait_gate = wait_gate

    def kill(self):
        self.killed = True
        self.returncode = -9

    async def wait(self):
        self.waits += 1
        if self.wait_gate:
            await self.wait_gate.wait()
        if self.returncode is None:
            self.returncode = self.exit_code
        return self.returncode


def resolver(process=None, **kwargs):
    from stark_trading_os.integrations.public_data.resolver import PublicDigResolver

    calls = []
    process = process if process is not None else Process()

    async def launch(*args, **options):
        calls.append((args, options))
        return process

    return PublicDigResolver(launcher=launch, **kwargs), process, calls


@pytest.mark.asyncio
async def test_fixed_argv_minimal_environment_and_no_subprocess_until_requested():
    r, process, calls = resolver()
    assert not calls
    assert await r(HOST) == ("8.8.8.8",)
    args, options = calls[0]
    assert args[0] == "/usr/bin/dig"
    assert "@1.1.1.1" in args and args[-2:] == (HOST + ".", "A")
    assert "+tries=1" in args and "+ignore" in args
    assert options["env"] == {"LC_ALL": "C", "LANG": "C", "PATH": "/usr/bin:/bin"}
    assert options["stdin"] == asyncio.subprocess.DEVNULL
    assert options["stderr"] == asyncio.subprocess.STDOUT
    assert process.stdout._transport.closed and process._transport.closed
    await r.aclose()
    assert r.close_result.release_confirmed


@pytest.mark.asyncio
async def test_local_dig_accepts_exact_options_in_help_mode_without_a_dns_question():
    r, _, calls = resolver()
    await r(HOST)
    args, options = calls[0]
    # Remove hostname and A question; -h exits while parsing options, before DNS.
    result = subprocess.run(
        (*args[:-2], "-h"),
        env=options["env"],
        cwd="/",
        timeout=2,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    await r.aclose()
    assert result.returncode == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "host", ["example.com", HOST + ".", "API.BINANCE.COM", "@evil", "$(echo bad)"]
)
async def test_unregistered_or_ambiguous_host_never_spawns(host):
    r, _, calls = resolver()
    with pytest.raises(RuntimeError, match="DNS_INVALID_HOST"):
        await r(host)
    assert not calls
    await r.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "content",
    [
        answer(status="NXDOMAIN"),
        answer("api.binance.com. 30 IN A 8.8.8.8", flags="qr tc rd ra"),
        answer(),
        b"8.8.8.8\n",
        answer("api.binance.com. 30 IN A 127.0.0.1"),
        answer("api.binance.com. 30 IN A 198.18.0.2"),
        answer("api.binance.com. 30 IN A 224.0.0.1"),
        answer("api.binance.com. 30 IN AAAA ::ffff:127.0.0.1"),
        answer("api.binance.com. 30 IN A 8.8.8.8", "api.binance.com. 30 IN A 10.0.0.1"),
        answer("api.binance.com. 30 IN A 8.8.8.8", "unrelated.example. 30 IN A 1.1.1.1"),
        answer(
            "api.binance.com. 30 IN CNAME other.example.",
            "other.example. 30 IN CNAME api.binance.com.",
        ),
        answer("api.binance.com. 30 IN CNAME other.example.", "api.binance.com. 30 IN A 8.8.8.8"),
        answer("api.binance.com. -1 IN A 8.8.8.8"),
        answer(
            "api.binance.com. 30 IN CNAME one.example.",
            "api.binance.com. 30 IN CNAME two.example.",
            "one.example. 30 IN A 8.8.8.8",
        ),
        answer(*[f"api.binance.com. 30 IN A 8.8.8.{i}" for i in range(1, 34)]),
    ],
)
async def test_bad_dns_status_chain_identity_or_any_ip_fails_closed(content):
    r, _, calls = resolver(Process(content))
    with pytest.raises(RuntimeError, match="DNS_RESPONSE_INVALID"):
        await r(HOST)
    assert len(calls) == 1
    await r.aclose()


@pytest.mark.asyncio
async def test_ttl_uses_minimum_chain_and_a_ttl_never_more_than_300_seconds():
    for cname_ttl, a_ttl, duration in [(20, 60, 20), (60, 5, 5), (900, 900, 300), (0, 60, 0)]:
        now = [100.0]
        calls = []

        async def launch(*args, **kwargs):
            calls.append(1)
            return Process(
                answer(
                    f"{HOST}. {cname_ttl} IN CNAME edge.example.",
                    f"edge.example. {a_ttl} IN A 8.8.8.8",
                )
            )

        from stark_trading_os.integrations.public_data.resolver import PublicDigResolver

        r = PublicDigResolver(launcher=launch, clock=lambda: now[0])
        await r(HOST)
        if duration:
            now[0] += duration - 0.01
            await r(HOST)
            assert len(calls) == 1
            now[0] += 0.01
        await r(HOST)
        assert len(calls) == 2
        await r.aclose()


@pytest.mark.asyncio
async def test_same_host_singleflight_one_cancelled_reader_does_not_cancel_others():
    gate = asyncio.Event()
    r, process, calls = resolver(Process(gate=gate))
    first, second = asyncio.create_task(r(HOST)), asyncio.create_task(r(HOST))
    while not calls:
        await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert not process.killed
    gate.set()
    assert await second == ("8.8.8.8",)
    assert len(calls) == 1
    await r.aclose()


@pytest.mark.asyncio
async def test_last_reader_cancellation_kills_waits_and_closes_process_handles():
    r, process, calls = resolver(Process(gate=asyncio.Event()))
    task = asyncio.create_task(r(HOST))
    while not calls:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert process.killed and process.waits > 0
    assert process.stdout._transport.closed and process._transport.closed
    await r.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["timeout", "overflow", "exit_failure"])
async def test_subprocess_boundaries_kill_reap_and_do_not_cache_failures(kind):
    process = Process(
        content=b"x" * 16385 if kind == "overflow" else GOOD,
        gate=asyncio.Event() if kind == "timeout" else None,
        returncode=1 if kind == "exit_failure" else 0,
    )
    r, process, calls = resolver(process, timeout_seconds=0.08)
    with pytest.raises(RuntimeError):
        await r(HOST)
    assert process.waits > 0 and process.stdout._transport.closed and process._transport.closed
    assert process.killed if kind != "exit_failure" else process.returncode == 1
    await r.aclose()


@pytest.mark.asyncio
async def test_close_cancels_active_query_and_is_idempotent_and_fail_closed():
    r, process, calls = resolver(Process(gate=asyncio.Event()))
    task = asyncio.create_task(r(HOST))
    while not calls:
        await asyncio.sleep(0)
    await r.aclose()
    await r.aclose()
    with pytest.raises(asyncio.CancelledError):
        await task
    with pytest.raises(RuntimeError, match="DNS_RESOLVER_CLOSED"):
        await r(HOST)
    assert process.killed and r.close_result.release_confirmed


@pytest.mark.asyncio
async def test_cleanup_timeout_is_retained_and_cannot_be_reported_closed_later():
    process = Process(gate=asyncio.Event(), wait_gate=asyncio.Event())
    r, _, _ = resolver(process, timeout_seconds=0.08)
    with pytest.raises(RuntimeError):
        await r(HOST)
    for _ in range(2):
        with pytest.raises(RuntimeError, match="DNS_CLEANUP_FAILED"):
            await r.aclose()
    assert not r.close_result.release_confirmed


@pytest.mark.asyncio
async def test_failed_lookup_is_not_cached_and_does_not_trigger_automatic_retry():
    from stark_trading_os.integrations.public_data.resolver import PublicDigResolver

    calls = []

    async def launch(*args, **kwargs):
        calls.append(1)
        return Process(answer(status="SERVFAIL") if len(calls) == 1 else GOOD)

    r = PublicDigResolver(launcher=launch)
    with pytest.raises(RuntimeError, match="DNS_RESPONSE_INVALID"):
        await r(HOST)
    assert len(calls) == 1
    assert await r(HOST) == ("8.8.8.8",)
    assert len(calls) == 2
    await r.aclose()


@pytest.mark.asyncio
async def test_repeated_reader_cancellation_joins_owned_kill_wait_cleanup():
    wait_gate = asyncio.Event()
    r, process, calls = resolver(Process(gate=asyncio.Event(), wait_gate=wait_gate))
    task = asyncio.create_task(r(HOST))
    while not calls:
        await asyncio.sleep(0)
    task.cancel()
    while not process.killed:
        await asyncio.sleep(0)
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    wait_gate.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    await r.aclose()
    assert r.close_result.release_confirmed and process.waits > 0


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
async def test_real_local_python_child_release_with_no_dns_or_network(cancel):
    from stark_trading_os.integrations.public_data.resolver import PublicDigResolver

    started = asyncio.Event()
    processes = []

    async def launch(*args, **kwargs):
        program = (
            "import time; time.sleep(30)"
            if cancel
            else ("import sys; sys.stdout.buffer.write(" + repr(GOOD) + ")")
        )
        process = await asyncio.create_subprocess_exec(sys.executable, "-c", program, **kwargs)
        processes.append(process)
        started.set()
        return process

    r = PublicDigResolver(launcher=launch)
    task = asyncio.create_task(r(HOST))
    await asyncio.wait_for(started.wait(), 1.0)
    if cancel:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        assert await task == ("8.8.8.8",)
    await r.aclose()
    assert processes[0].returncode is not None
    assert processes[0].stdout._transport.is_closing()
    assert r.close_result.release_confirmed


@pytest.mark.asyncio
async def test_review_new_reader_never_joins_retiring_cancelled_flight_and_close_joins_retirement():
    from stark_trading_os.integrations.public_data.resolver import PublicDigResolver

    cleanup_gate = asyncio.Event()
    second_started = asyncio.Event()
    first_process = Process(gate=asyncio.Event(), wait_gate=cleanup_gate)
    processes = []

    async def launch(*args, **kwargs):
        process = first_process if not processes else Process(answer(f"{HOST}. 30 IN A 9.9.9.9"))
        processes.append(process)
        if len(processes) == 2:
            second_started.set()
        return process

    r = PublicDigResolver(launcher=launch)
    first = asyncio.create_task(r(HOST))
    second = closing = None
    try:
        while not processes:
            await asyncio.sleep(0)
        first.cancel()
        while not first_process.killed:
            await asyncio.sleep(0)
        second = asyncio.create_task(r(HOST))
        await asyncio.wait_for(second_started.wait(), 0.2)
        assert await second == ("9.9.9.9",)
        assert not first.done()
        closing = asyncio.create_task(r.aclose())
        # Let shutdown reach its owned work, while the retired process is blocked.
        for _ in range(3):
            await asyncio.sleep(0)
        assert not closing.done()
    finally:
        cleanup_gate.set()
        await asyncio.gather(
            first, *([second] if second is not None else []), return_exceptions=True
        )
        if closing is not None:
            await closing
        else:
            await r.aclose()
    assert len(processes) == 2
    assert all(p.stdout._transport.closed and p._transport.closed for p in processes)
    assert r.close_result.release_confirmed
