"""One local owner, four independent canonical workers, no GET-triggered refresh."""

from __future__ import annotations

import asyncio
import fcntl
import logging
import os
import stat
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

from stark_trading_os.control.public_data_models import PublicDataResource
from stark_trading_os.control.public_data_policy import ProviderScope, PublicPolicyStore
from stark_trading_os.control.public_data_service import CADENCE_MS, PublicDataService
from stark_trading_os.control.public_data_store import PublicDataStore

_LOG = logging.getLogger(__name__)
SCOPES: dict[PublicDataResource, ProviderScope | None] = {
    "markets": "binance", "assets": "coingecko", "news": "blockbeats",
    "explorer/capabilities": None,
}


class PublicCollectorOwnerError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("PUBLIC_COLLECTOR_OWNER_UNAVAILABLE")


class PublicCollectorOwner:
    """OS lifetime flock on a canonical DB-adjacent file, never a PID lease.

    macOS flock on the SQLite inode conflicts with SQLite's own locks, so this
    descriptor must be separate. Readers need no lease. No unlink/truncate/takeover;
    symlink DB aliases resolve to one lock path. Hardlinked DBs/locks are rejected.
    Runtime retains both descriptors until every worker/transport has closed.
    """

    def __init__(self, path: Path) -> None:
        if not path.is_absolute():
            raise PublicCollectorOwnerError()
        self.path = path
        self._fd: int | None = None
        self._db_fd: int | None = None
        self._session_started = False

    def acquire(self) -> None:
        if self._fd is not None or self._session_started:
            raise PublicCollectorOwnerError()
        fd: int | None = None
        db_fd: int | None = None
        try:
            self.path = self.path.resolve()
            fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            db_fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            self._fd = fd
            self._db_fd = db_fd
            self.assert_owned(self.path)
        except (OSError, PublicCollectorOwnerError):
            if db_fd is not None:
                os.close(db_fd)
            if fd is not None:
                os.close(fd)
            self._fd = None
            self._db_fd = None
            raise PublicCollectorOwnerError() from None

    @property
    def lock_path(self) -> Path:
        return self.path.with_name(self.path.name + ".collector.lock")

    def assert_owned(self, path: Path) -> None:
        try:
            if self._fd is None or self._db_fd is None or path.resolve() != self.path:
                raise PublicCollectorOwnerError()
            for fd, target in ((self._fd, self.lock_path), (self._db_fd, self.path)):
                held = os.fstat(fd)
                current = target.stat()
                if (
                    not stat.S_ISREG(held.st_mode) or held.st_nlink != 1
                    or (held.st_dev, held.st_ino) != (current.st_dev, current.st_ino)
                ):
                    raise PublicCollectorOwnerError()
        except OSError:
            raise PublicCollectorOwnerError() from None

    def begin_session(self, path: Path) -> None:
        """Consume one startup reconciliation permit for this exclusive lifetime.

        A reader or another collector sharing a live owner cannot reuse it. Even
        failed startup requires closing this lease and acquiring a new owner.
        """
        self.assert_owned(path)
        if self._session_started:
            raise PublicCollectorOwnerError()
        self._session_started = True

    def close(self) -> None:
        fd, self._fd = self._fd, None
        db_fd, self._db_fd = self._db_fd, None
        try:
            if db_fd is not None:
                os.close(db_fd)
        finally:
            if fd is not None:
                os.close(fd)  # OS releases on normal close, crash, SIGTERM and SIGINT.


class PublicDataCollector:
    """Runtime owns resources; this object owns only the four worker tasks.

    Ordinary upstream failures are observations with fixed persisted retry floors.
    Storage/clock/ownership/internal failures are failclosed, logged without raw
    exceptions, and signalled to the runtime. No silent stopped or orphaned task.
    """

    def __init__(
        self, service: PublicDataService, policy: PublicPolicyStore, owner: PublicCollectorOwner,
        *, registry_interval_ms: int = 300000,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        if (
            not service.snapshot_only or not isinstance(service.store, PublicDataStore)
            or service.store.mode != policy.mode
            or service.store.path != policy.public_path
            or type(registry_interval_ms) is not int
            or not CADENCE_MS["explorer/capabilities"] <= registry_interval_ms <= 31622400000
        ):
            raise ValueError("PUBLIC_COLLECTOR_CONFIGURATION_INVALID")
        self.service = service
        self.store = service.store
        self.policy = policy
        self.owner = owner
        self.registry_interval_ms = registry_interval_ms
        self._sleep = sleep
        self._tasks: list[asyncio.Task[None]] = []
        self._started = False
        self._closing = False
        self._not_before: dict[PublicDataResource, int] = {}
        self._startup_deadlines: dict[PublicDataResource, int] = {}
        self.failed = asyncio.Event()
        self.state: dict[PublicDataResource, str] = {r: "NOT_STARTED" for r in SCOPES}

    def start(self) -> None:
        if self._started:
            raise PublicCollectorOwnerError()
        self.owner.assert_owned(self.store.path)
        # Preflight all lanes BEFORE scheduling any DNS/provider work.
        stored = {r: self.service.store.load(r) for r in SCOPES}
        now = self.service.clock_ms()
        deadlines = self.policy.recover_session(self.owner, now, {
            scope: 0 if (entry := stored[r]) is None else entry.refresh_at_ms
            for r, scope in SCOPES.items() if scope is not None
        })
        elapsed = self._monotonic_ms()
        for resource, scope in SCOPES.items():
            entry = stored[resource]
            deadline = deadlines[scope] if scope is not None else (
                0 if entry is None else max(entry.refresh_at_ms, now + self.registry_interval_ms)
            )
            if entry is not None:
                # UTC may already have jumped past refresh BEFORE this owner started.
                # Reapply the full persisted duration, not just its UTC remainder.
                deadline = max(deadline, now + entry.refresh_at_ms - entry.fetched_at_ms)
            self._startup_deadlines[resource] = deadline
            self._not_before[resource] = elapsed + max(0, deadline - now)
        self._started = True
        self._tasks = [asyncio.create_task(self._worker(r), name=f"public-collector:{r}")
                       for r in SCOPES]

    async def _cycle(self, resource: PublicDataResource) -> tuple[int, int]:
        self.owner.assert_owned(self.store.path)
        now = self.service.clock_ms()
        startup = self._startup_deadlines[resource]
        if now < startup:
            self.state[resource] = "WAITING"
            return startup, 0
        stored = self.service.store.load(resource)
        refresh = 0 if stored is None else stored.refresh_at_ms
        scope = SCOPES[resource]
        interval = (self.registry_interval_ms if scope is None
                    else self.policy.policies[scope].interval_ms)
        if scope is None:
            if now < refresh:
                self.state[resource] = "WAITING"
                return refresh, 0
        else:
            deadline = self.policy.reserve(scope, now, refresh)
            if deadline is not None:
                self.state[resource] = "WAITING"
                return deadline, 0
        self.state[resource] = "COLLECTING"

        def before_save(deadline: int) -> None:
            if scope is not None:
                self.policy.record_deadline(scope, self.service.clock_ms(), deadline)

        payload = await self.service.collect(
            resource, interval_ms=interval, before_save=before_save,
        )
        if scope is not None:
            self.policy.complete(scope)
        saved = self.service.store.load(resource)
        if saved is None:
            raise RuntimeError("PUBLIC_COLLECTION_NOT_PERSISTED")
        self.state[resource] = (
            "OK" if all(s.status in {"OK", "STALE"} for s in payload.sources) else "DEGRADED"
        )
        return saved.refresh_at_ms, max(interval, saved.refresh_at_ms - saved.fetched_at_ms)

    def _monotonic_ms(self) -> int:
        """Independent elapsed clock; overridable with deterministic test time."""
        return time.monotonic_ns() // 1_000_000

    async def _worker(self, resource: PublicDataResource) -> None:
        try:
            while True:
                remaining = self._not_before[resource] - self._monotonic_ms()
                if remaining > 0:
                    self.state[resource] = "WAITING"
                    await self._sleep(max(1.0, remaining / 1000))
                    continue
                deadline, minimum_delay = await self._cycle(resource)
                # Recheck elapsed time on EVERY wake, not just a sleep request.
                # Completion anchors a new gate: no catch-up after oversleep. UTC
                # admission independently enforces persisted deadlines/day budgets.
                if minimum_delay:
                    self._not_before[resource] = self._monotonic_ms() + minimum_delay
                await self._sleep(max(
                    1.0, minimum_delay / 1000, (deadline - self.service.clock_ms()) / 1000,
                ))
        except asyncio.CancelledError:
            if not self._closing:
                self._fail(resource)
            raise
        except Exception:
            self._fail(resource)

    def _fail(self, resource: PublicDataResource) -> None:
        self.state[resource] = "FAILED_CLOSED"
        self.failed.set()
        _LOG.error("PUBLIC_COLLECTOR_FAILED_CLOSED resource=%s", resource)

    async def close(self) -> None:
        self._closing = True
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        for resource in SCOPES:
            if self.state[resource] != "FAILED_CLOSED":
                self.state[resource] = "STOPPED"
