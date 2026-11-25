"""PRIVATE RPC admits 16 calls at once and refuses the next one at the door, today.

Pins the admission count of private_research_rpc.py (one Semaphore(16) per app; a call that
finds it full answers 503 PRIVATE_UNAVAILABLE before any backend call). It does not measure the
real parallelism behind it (the runtime pool has 2 connections), and the refusal has no
Retry-After today; whether to add one is still open, so the name says "today".

The backend work runs in asyncio.to_thread. The default thread pool has min(32, CPUs + 4)
workers, so this test gives its own loop a 32-worker pool; without it a runner with fewer than
12 CPUs could never hold 16 calls at once. Every wait is bounded and the gate is always opened,
so a regression fails instead of hanging. Synthetic values and stub backends only.
"""

import asyncio
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx

from stark_trading_os.control.private_research_rpc import create_private_research_app

RUNTIME = "r" * 48
ISSUER = "i" * 48
DIGEST = "a" * 64
BASE = "/internal/private/v1"
CONTRACT = "ASTARTER_PRIVATE_RESEARCH_V1"
ADMITTED = 16
WAIT_SECONDS = 10.0
# Longer than any wait of the test, so a held call never frees capacity before the gate opens.
HOLD_SECONDS = 3 * WAIT_SECONDS
OWNER = {"Authorization": "Bearer " + RUNTIME, "X-Astarter-Private-Session-Digest": DIGEST}


class GatedBackend:
    """Holds every admitted call inside its worker thread until the test opens the gate."""

    def __init__(self) -> None:
        self.gate = threading.Event()
        self.calls: list[int] = []
        self._lock = threading.Lock()

    def invoke(self, operation: str, payload: dict[str, Any], session_digest: str | None) -> Any:
        with self._lock:
            self.calls.append(payload["n"])
        if not self.gate.wait(HOLD_SECONDS):
            raise RuntimeError("gate stayed closed")
        return {"n": payload["n"]}

    def seen(self) -> list[int]:
        with self._lock:
            return sorted(self.calls)


class IdleBackend:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def invoke(self, operation: str, payload: dict[str, Any], session_digest: str | None) -> Any:
        self.calls.append(operation)
        return {}


async def until(condition: Callable[[], bool]) -> bool:
    deadline = time.monotonic() + WAIT_SECONDS
    while not condition():
        if time.monotonic() > deadline:
            return False
        await asyncio.sleep(0.01)
    return True


async def scenario() -> dict[str, Any]:
    asyncio.get_running_loop().set_default_executor(
        ThreadPoolExecutor(max_workers=32, thread_name_prefix="private-rpc-capacity")
    )
    runtime, issuer = GatedBackend(), IdleBackend()
    app = create_private_research_app(
        runtime=runtime, issuer=issuer, runtime_secret=RUNTIME, issuer_secret=ISSUER
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://fixture.invalid"
    ) as client:

        async def call(n: int) -> httpx.Response:
            return await client.post(BASE + "/lease", json={"n": n}, headers=OWNER)

        held = [asyncio.create_task(call(n)) for n in range(ADMITTED)]
        extra: asyncio.Task[httpx.Response] | None = None
        try:
            full = await until(lambda: len(runtime.seen()) == ADMITTED)
            extra = asyncio.create_task(call(ADMITTED))
            done, _ = await asyncio.wait({extra}, timeout=WAIT_SECONDS)
            refused_while_full = extra in done
            seen_while_full = runtime.seen()
        finally:
            runtime.gate.set()
        held_answers = await asyncio.wait_for(asyncio.gather(*held), WAIT_SECONDS)
        refused = await asyncio.wait_for(extra, WAIT_SECONDS)
        after = await asyncio.wait_for(call(ADMITTED + 1), WAIT_SECONDS)
    return {
        "full": full,
        "refused_while_full": refused_while_full,
        "seen_while_full": seen_while_full,
        "refused": refused,
        "held": held_answers,
        "after": after,
        "seen_at_end": runtime.seen(),
        "issuer_calls": issuer.calls,
    }


def test_sixteen_calls_are_admitted_and_the_17th_is_refused_today_without_retry_after() -> None:
    outcome = asyncio.run(scenario())

    assert outcome["full"], "16 admitted calls never reached the backend together"
    assert outcome["seen_while_full"] == list(range(ADMITTED))
    assert outcome["refused_while_full"], "the 17th call waited for capacity instead"
    refused = outcome["refused"]
    assert refused.status_code == 503
    assert refused.json() == {"contract": CONTRACT, "code": "PRIVATE_UNAVAILABLE"}
    assert refused.headers["cache-control"] == "no-store"
    assert refused.headers["x-content-type-options"] == "nosniff"
    assert "retry-after" not in refused.headers

    assert [r.status_code for r in outcome["held"]] == [200] * ADMITTED
    assert [r.json()["result"]["n"] for r in outcome["held"]] == list(range(ADMITTED))
    # Capacity comes back after the release, and the refused call never reached the backend.
    assert outcome["after"].status_code == 200
    assert outcome["seen_at_end"] == list(range(ADMITTED)) + [ADMITTED + 1]
    assert outcome["issuer_calls"] == []
