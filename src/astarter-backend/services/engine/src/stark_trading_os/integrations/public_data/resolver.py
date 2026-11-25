"""Opt-in local macOS dig resolver; no credentials, HTTP, shell or global DNS edits.

PublicReadHttpTransport keeps its original system-DNS default. This callback must
be chosen explicitly by the local owner. Injected launchers are trusted test code.
"""

from __future__ import annotations

import asyncio
import ipaddress
import math
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, cast

from stark_trading_os.integrations.cleanup import CloseResult, join_owned

HOSTS = frozenset(
    {
        "api.binance.com",
        "pro-api.coingecko.com",
        "api.coingecko.com",
        "api-pro.theblockbeats.info",
    }
)
MAX_OUTPUT = 16384
type Launcher = Callable[..., Awaitable[asyncio.subprocess.Process]]
type DnsReason = Literal[
    "DNS_INVALID_HOST",
    "DNS_RESPONSE_INVALID",
    "DNS_PROCESS_FAILED",
    "DNS_PROCESS_TIMEOUT",
    "DNS_CLEANUP_FAILED",
    "DNS_RESOLVER_CLOSED",
]


class PublicDnsError(RuntimeError):
    def __init__(self, reason: DnsReason) -> None:
        self.reason = reason
        super().__init__(reason)


@dataclass(frozen=True, slots=True)
class _Answer:
    ips: tuple[str, ...]
    ttl: int


@dataclass(slots=True)
class _Flight:
    task: asyncio.Task[_Answer]
    readers: int = 0


def _name(value: str) -> str:
    if not value.endswith(".") or not value.isascii() or len(value) > 254:
        raise ValueError("DNS_NAME")
    labels = value[:-1].split(".")
    if any(not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", x) for x in labels):
        raise ValueError("DNS_NAME")
    return value[:-1].lower()


def _parse(host: str, content: bytes) -> _Answer:
    if not 0 < len(content) <= MAX_OUTPUT:
        raise ValueError("DNS_SIZE")
    header, flags, declared = 0, 0, -1
    rows: list[tuple[str, int, str, str]] = []
    for line in content.decode("ascii").splitlines():
        if not line.strip():
            continue
        if line.startswith(";; ->>HEADER<<-"):
            if not re.fullmatch(
                r";; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: [0-9]+", line
            ):
                raise ValueError("DNS_STATUS")
            header += 1
        elif line.startswith(";; flags:"):
            match = re.fullmatch(
                r";; flags: ([a-z ]+); QUERY: 1, ANSWER: ([0-9]+), "
                r"AUTHORITY: [0-9]+, ADDITIONAL: [0-9]+",
                line,
            )
            if match is None or "qr" not in match[1].split() or "tc" in match[1].split():
                raise ValueError("DNS_FLAGS")
            flags += 1
            declared = int(match[2])
        elif line.startswith(";"):
            continue
        else:
            parts = line.split()
            if len(parts) != 5 or parts[2] != "IN" or parts[3] not in {"A", "CNAME"}:
                raise ValueError("DNS_RECORD")
            if not re.fullmatch(r"[0-9]{1,10}", parts[1]) or int(parts[1]) > 2147483647:
                raise ValueError("DNS_TTL")
            rows.append((_name(parts[0]), int(parts[1]), parts[3], parts[4]))
    if header != 1 or flags != 1 or not 1 <= len(rows) <= 48 or declared != len(rows):
        raise ValueError("DNS_ANSWER_COUNT")
    aliases: dict[str, str] = {}
    addresses: dict[str, list[str]] = {}
    a_count = 0
    for owner, _, kind, data in rows:
        if kind == "CNAME":
            target = _name(data)
            if owner in aliases and aliases[owner] != target:
                raise ValueError("DNS_CONFLICT")
            aliases[owner] = target
        else:
            ip = ipaddress.IPv4Address(data)
            if not ip.is_global or ip.is_reserved or ip.is_multicast:
                raise ValueError("DNS_NON_PUBLIC")
            a_count += 1
            addresses.setdefault(owner, []).append(str(ip))
    if not 1 <= a_count <= 32 or addresses.keys() & aliases.keys():
        raise ValueError("DNS_ADDRESS_COUNT")
    current = host
    visited: set[str] = set()
    while current in aliases:
        if current in visited or len(visited) >= 16:
            raise ValueError("DNS_CNAME_CYCLE")
        visited.add(current)
        current = aliases[current]
    visited.add(current)
    if current not in addresses or set(aliases) | set(addresses) != visited:
        raise ValueError("DNS_UNRELATED_OR_MISSING")
    return _Answer(tuple(dict.fromkeys(addresses[current])), min(300, *(row[1] for row in rows)))


async def _settle(task: asyncio.Task[_Answer]) -> None:
    try:
        await task
    except (Exception, asyncio.CancelledError):
        pass


class PublicDigResolver:
    def __init__(
        self,
        *,
        launcher: Launcher | None = None,
        clock: Callable[[], float] = time.monotonic,
        timeout_seconds: float = 3.0,
    ) -> None:
        if (
            type(timeout_seconds) not in {int, float}
            or not math.isfinite(timeout_seconds)
            or not 0 < timeout_seconds <= 3
        ):
            raise ValueError("INVALID_DNS_CONFIGURATION")
        self._launcher: Launcher = (
            launcher if launcher is not None else asyncio.create_subprocess_exec
        )
        self._clock = clock
        self._seconds = timeout_seconds
        self._cleanup_seconds = min(0.5, timeout_seconds / 4)
        self._cache: dict[str, tuple[float, _Answer]] = {}
        self._pending: dict[str, _Flight] = {}
        self._owned: set[asyncio.Task[_Answer]] = set()
        self._closed = False
        self._cleanup_failed = False
        self._shutdown: asyncio.Task[CloseResult] | None = None
        self.close_result: CloseResult | None = None

    async def __call__(self, host: str) -> tuple[str, ...]:
        if self._closed:
            raise PublicDnsError("DNS_RESOLVER_CLOSED")
        if type(host) is not str or host not in HOSTS:
            raise PublicDnsError("DNS_INVALID_HOST")
        entry = self._cache.get(host)
        if entry is not None and self._clock() < entry[0]:
            return entry[1].ips
        flight = self._pending.get(host)
        if flight is None:
            task = asyncio.create_task(self._load(host))
            self._owned.add(task)
            task.add_done_callback(self._owned.discard)
            flight = _Flight(task)
            self._pending[host] = flight
        flight.readers += 1
        try:
            return (await asyncio.shield(flight.task)).ips
        finally:
            flight.readers -= 1
            if flight.readers == 0:
                # Retire before yielding to cleanup: a new reader must get its own
                # flight, while _owned retains the old task through physical reap.
                if self._pending.get(host) is flight:
                    self._pending.pop(host)
                if not flight.task.done():
                    flight.task.cancel()
                await join_owned(asyncio.create_task(_settle(flight.task)))

    async def _load(self, host: str) -> _Answer:
        started = self._clock()
        answer = await self._run(host)
        expires = started + answer.ttl
        if not self._closed and self._clock() < expires:
            self._cache[host] = (expires, answer)
        return answer

    async def _run(self, host: str) -> _Answer:
        process: asyncio.subprocess.Process | None = None
        answer: _Answer | None = None
        reason: DnsReason = "DNS_PROCESS_FAILED"
        try:
            async with asyncio.timeout(self._seconds - self._cleanup_seconds):
                process = await self._launcher(
                    "/usr/bin/dig",
                    "-4",
                    "+time=2",
                    "+tries=1",
                    "+ignore",
                    "+noednsnegotiation",
                    "+notcp",
                    "+nosearch",
                    "+noall",
                    "+comments",
                    "+answer",
                    "+ttlid",
                    "+cl",
                    "@1.1.1.1",
                    host + ".",
                    "A",
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    cwd="/",
                    close_fds=True,
                    # macOS dig 9.10.6 has no -r. Its config parser only opens
                    # .digrc when getenv("HOME") exists. Do not inherit HOME or
                    # any user config/proxy variables into this child process.
                    env={"LC_ALL": "C", "LANG": "C", "PATH": "/usr/bin:/bin"},
                    limit=4096,
                )
                if process.stdout is None:
                    raise PublicDnsError("DNS_PROCESS_FAILED")
                content = bytearray()
                while chunk := await process.stdout.read(4096):
                    if len(chunk) > MAX_OUTPUT - len(content):
                        raise PublicDnsError("DNS_RESPONSE_INVALID")
                    content.extend(chunk)
                if await process.wait() != 0:
                    raise PublicDnsError("DNS_PROCESS_FAILED")
                try:
                    answer = _parse(host, bytes(content))
                except (ValueError, UnicodeError):
                    reason = "DNS_RESPONSE_INVALID"
        except PublicDnsError as error:
            reason = error.reason
        except TimeoutError:
            reason = "DNS_PROCESS_TIMEOUT"
        except Exception:
            reason = "DNS_PROCESS_FAILED"
        finally:
            if process is not None:
                await join_owned(asyncio.create_task(self._reap(process)))
        if self._cleanup_failed:
            raise PublicDnsError("DNS_CLEANUP_FAILED")
        if answer is None:
            raise PublicDnsError(reason)
        return answer

    async def _reap(self, process: asyncio.subprocess.Process) -> None:
        okay = True
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            except Exception:
                okay = False
        # Pipe closure prevents Process.wait from hanging on an undrained full
        # stdout pipe after kill. These are pinned CPython 3.12 local handles.
        for owned in (process.stdout, process.stderr, process):
            transport = cast(asyncio.BaseTransport | None, getattr(owned, "_transport", None))
            if transport is not None:
                try:
                    transport.close()
                except Exception:
                    okay = False
        try:
            async with asyncio.timeout(self._cleanup_seconds):
                await process.wait()
        except (Exception, asyncio.CancelledError):
            okay = False
        if not okay:
            self._cleanup_failed = True
            self._closed = True

    async def aclose(self) -> None:
        self._closed = True
        if self._shutdown is None:
            self._shutdown = asyncio.create_task(self._close())
        result = await join_owned(self._shutdown)
        if not result.release_confirmed:
            raise PublicDnsError("DNS_CLEANUP_FAILED")

    async def _close(self) -> CloseResult:
        tasks = tuple(self._owned)
        for task in tasks:
            if not task.done() and not task.cancelling():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._pending.clear()
        self._cache.clear()
        self.close_result = CloseResult("FAILED" if self._cleanup_failed else "CLOSED")
        return self.close_result
