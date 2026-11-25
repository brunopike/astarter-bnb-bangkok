"""Concrete bounded collector policy sidecar. No changes to public projection v1.

Reserved weight is NOT measured wire traffic. Interrupted reservations stay charged;
only a newly proven exclusive collector session may reconcile them for a later GET.
An unobserved/unpersisted Retry-After cannot be recovered after a crash.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import TYPE_CHECKING, Literal, cast

from stark_trading_os.integrations.public_data.models import Mode

if TYPE_CHECKING:
    from stark_trading_os.control.public_data_collector import PublicCollectorOwner

type ProviderScope = Literal["binance", "coingecko", "blockbeats"]
DAY_MS = 86400000
MAX_TIME = 253402300799999
MIN_INTERVAL: dict[ProviderScope, int] = {
    "binance": 10000, "coingecko": 300000, "blockbeats": 60000,
}
WEIGHT: dict[ProviderScope, int] = {"binance": 3, "coingecko": 1, "blockbeats": 1}
_APP_ID = 0x41504350
_MODE_BIT: dict[Mode, int] = {"offline_fixture": 1, "live_readonly": 2}
_BINDING = """CREATE TABLE collector_binding (
    singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton = 1),
    public_path TEXT NOT NULL CHECK(length(public_path) BETWEEN 2 AND 4096),
    initialized_modes INTEGER NOT NULL CHECK(initialized_modes BETWEEN 0 AND 3)
) STRICT, WITHOUT ROWID"""
_BUDGET = """CREATE TABLE collector_budget (
    scope TEXT NOT NULL CHECK(scope IN ('binance','coingecko','blockbeats')),
    mode TEXT NOT NULL CHECK(mode IN ('offline_fixture','live_readonly')),
    daily_cap INTEGER NOT NULL CHECK(daily_cap BETWEEN 0 AND 1000000000),
    interval_ms INTEGER NOT NULL CHECK(interval_ms BETWEEN 10000 AND 31622400000),
    weight INTEGER NOT NULL CHECK((scope = 'binance' AND weight = 3)
        OR (scope IN ('coingecko','blockbeats') AND weight = 1)),
    day INTEGER NOT NULL CHECK(day BETWEEN 0 AND 2932896),
    reserved_weight INTEGER NOT NULL CHECK(reserved_weight BETWEEN 0 AND daily_cap),
    last_wall_ms INTEGER NOT NULL CHECK(last_wall_ms BETWEEN 0 AND 253402300799999),
    next_at_ms INTEGER NOT NULL CHECK(next_at_ms BETWEEN 0 AND 253402300799999),
    pending INTEGER NOT NULL CHECK(pending IN (0,1)),
    CHECK((scope = 'binance' AND interval_ms >= 10000)
        OR (scope = 'coingecko' AND interval_ms >= 300000)
        OR (scope = 'blockbeats' AND interval_ms >= 60000)),
    CHECK(day <= last_wall_ms / 86400000),
    CHECK(pending = 0 OR reserved_weight >= weight),
    PRIMARY KEY(scope, mode)
) STRICT, WITHOUT ROWID"""


class PublicPolicyError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("PUBLIC_COLLECTOR_POLICY_FAILED")


@dataclass(frozen=True, slots=True)
class ProviderPolicy:
    scope: ProviderScope
    daily_cap: int
    interval_ms: int

    def __post_init__(self) -> None:
        if (
            self.scope not in MIN_INTERVAL or type(self.daily_cap) is not int
            or not 0 <= self.daily_cap <= 1000000000 or type(self.interval_ms) is not int
            or not MIN_INTERVAL[self.scope] <= self.interval_ms <= 31622400000
        ):
            raise PublicPolicyError()


@dataclass(frozen=True, slots=True)
class PolicySnapshot:
    day: int
    reserved_weight: int
    last_wall_ms: int
    next_at_ms: int
    pending: bool


def policy_path(public_path: Path) -> Path:
    return public_path.with_name(public_path.name + ".collector-policy.sqlite3")


def _time(value: int) -> None:
    if type(value) is not int or not 0 <= value <= MAX_TIME:
        raise PublicPolicyError()


class PublicPolicyStore:
    """At most three immutable provider policies per mode, with one UTC day bucket.

    Exact schema/version/binding required, no repair/migration. The runtime owns
    close; the collector owns admissions, always outside provider/DNS awaits.
    """

    def __init__(
        self, public_path: Path, *, mode: Mode, policies: tuple[ProviderPolicy, ...],
    ) -> None:
        if (
            not public_path.is_absolute() or mode not in {"offline_fixture", "live_readonly"}
            or len(policies) != 3 or {p.scope for p in policies} != set(MIN_INTERVAL)
        ):
            raise PublicPolicyError()
        self.public_path = public_path.resolve()
        self.path = policy_path(self.public_path)
        self.mode = mode
        self.policies: dict[ProviderScope, ProviderPolicy] = {p.scope: p for p in policies}
        self._lock = RLock()
        self._closed = False
        try:
            self._db = sqlite3.connect(self.path, timeout=0, check_same_thread=False,
                                       isolation_level=None)
        except (sqlite3.Error, OSError):
            raise PublicPolicyError() from None
        self._db.row_factory = sqlite3.Row
        try:
            with self._transaction():
                objects = self._db.execute("SELECT name FROM sqlite_schema").fetchall()
                app = self._db.execute("PRAGMA application_id").fetchone()[0]
                version = self._db.execute("PRAGMA user_version").fetchone()[0]
                created = not objects and app == 0 and version == 0
                if created:
                    self._db.execute(_BINDING)
                    self._db.execute(_BUDGET)
                    self._db.execute("INSERT INTO collector_binding VALUES (1, ?, 0)",
                                     (str(self.public_path),))
                    self._db.execute(f"PRAGMA application_id = {_APP_ID}")
                    self._db.execute("PRAGMA user_version = 1")
                modes = self._verify(allow_uninitialized=created)
                for p in policies:
                    row = self._row(p.scope)
                    if row is None:
                        self._db.execute(
                            "INSERT INTO collector_budget VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0)",
                            (p.scope, mode, p.daily_cap, p.interval_ms, WEIGHT[p.scope]),
                        )
                    elif (row["daily_cap"], row["interval_ms"], row["weight"]) != (
                        p.daily_cap, p.interval_ms, WEIGHT[p.scope],
                    ):
                        raise PublicPolicyError()
                self._db.execute("UPDATE collector_binding SET initialized_modes = ?",
                                 (modes | _MODE_BIT[mode],))
                self._verify()
                if [tuple(r) for r in self._db.execute("PRAGMA quick_check")] != [("ok",)]:
                    raise PublicPolicyError()
                self._db.commit()
        except BaseException:
            self._db.close()
            self._closed = True
            raise

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        with self._lock:
            if self._closed:
                raise PublicPolicyError()
            try:
                self._db.execute("BEGIN IMMEDIATE")
                yield
            except (sqlite3.Error, ValueError, TypeError, OverflowError):
                raise PublicPolicyError() from None
            finally:
                try:
                    if self._db.in_transaction:
                        self._db.rollback()
                except sqlite3.Error:
                    raise PublicPolicyError() from None

    def _verify(self, *, allow_uninitialized: bool = False) -> int:
        objects = [tuple(row) for row in self._db.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name"
        )]
        if (
            objects != [
                ("table", "collector_binding", "collector_binding", _BINDING),
                ("table", "collector_budget", "collector_budget", _BUDGET),
            ]
            or self._db.execute("PRAGMA application_id").fetchone()[0] != _APP_ID
            or self._db.execute("PRAGMA user_version").fetchone()[0] != 1
        ):
            raise PublicPolicyError()
        binding = self._db.execute("SELECT * FROM collector_binding").fetchall()
        if len(binding) != 1 or tuple(binding[0])[:2] != (1, str(self.public_path)):
            raise PublicPolicyError()
        modes = int(binding[0]["initialized_modes"])
        expected = sorted((mode, 3) for mode, bit in _MODE_BIT.items() if modes & bit)
        actual = [tuple(row) for row in self._db.execute(
            "SELECT mode, count(*) FROM collector_budget GROUP BY mode ORDER BY mode"
        )]
        if (modes == 0 and not allow_uninitialized) or actual != expected:
            # Missing rows in an initialized mode must NEVER recreate spent quota.
            raise PublicPolicyError()
        return modes

    def _row(self, scope: ProviderScope) -> sqlite3.Row | None:
        return cast(sqlite3.Row | None, self._db.execute(
            "SELECT * FROM collector_budget WHERE scope = ? AND mode = ?", (scope, self.mode),
        ).fetchone())

    def _required(self, scope: ProviderScope) -> sqlite3.Row:
        self._verify()
        row = self._row(scope)
        p = self.policies[scope]
        if row is None or (row["daily_cap"], row["interval_ms"], row["weight"]) != (
            p.daily_cap, p.interval_ms, WEIGHT[scope],
        ):
            raise PublicPolicyError()
        return row

    def snapshot(self, scope: ProviderScope) -> PolicySnapshot:
        with self._transaction():
            row = self._required(scope)
            return PolicySnapshot(row["day"], row["reserved_weight"], row["last_wall_ms"],
                                  row["next_at_ms"], bool(row["pending"]))

    def recover_session(
        self, owner: PublicCollectorOwner, now: int, refresh_at_ms: dict[ProviderScope, int],
    ) -> dict[ProviderScope, int]:
        """Reconcile once under a NEW exclusive lifetime, before any worker starts.

        Preserve charge/day/high-water and durable deadlines; clear only pending.
        Return runtime-only UTC gates covering the full known policy duration,
        even if UTC jumped before startup. Never persist startup + floor with an
        old last_wall_ms: repeated restarts would turn downtime into retry duration.
        The collector adds snapshot durations and enforces UTC AND monotonic gates.
        """
        _time(now)
        if set(refresh_at_ms) != set(self.policies):
            raise PublicPolicyError()
        for refresh in refresh_at_ms.values():
            _time(refresh)
        with self._transaction():
            deadlines: dict[ProviderScope, int] = {}
            for scope in self.policies:
                row = self._required(scope)
                known = max(row["next_at_ms"], row["last_wall_ms"], refresh_at_ms[scope])
                history = known or row["reserved_weight"] or row["pending"]
                floor = max(row["interval_ms"], 60000, row["next_at_ms"] - row["last_wall_ms"])
                deadline = max(known, now + floor) if history else 0
                _time(deadline)
                deadlines[scope] = deadline
            # Validate all lanes before consuming the single-use owner permit or
            # changing rows. A commit failure rolls back ALL reconciliation.
            owner.begin_session(self.public_path)
            for scope in deadlines:
                self._db.execute(
                    "UPDATE collector_budget SET pending = 0 "
                    "WHERE scope = ? AND mode = ?", (scope, self.mode),
                )
            self._db.commit()
            return deadlines

    def reserve(self, scope: ProviderScope, now: int, refresh_at_ms: int) -> int | None:
        """None means charged permission. Otherwise return the next eligible UTC ms.

        Backward wall clocks cannot reset the window or shorten a deadline. Forward
        jumps open at most the current day (never missed-day credits/catch-up).
        Workers additionally enforce independent monotonic not-before gates.
        """
        _time(now)
        _time(refresh_at_ms)
        with self._transaction():
            row = self._required(scope)
            if row["pending"]:
                raise PublicPolicyError()
            deadline = max(int(row["next_at_ms"]), refresh_at_ms, int(row["last_wall_ms"]))
            day = now // DAY_MS
            spent = row["reserved_weight"] if day <= row["day"] else 0
            if spent + row["weight"] > row["daily_cap"]:
                deadline = max(deadline, (max(day, row["day"]) + 1) * DAY_MS)
            if now < deadline:
                self._db.execute(
                    "UPDATE collector_budget SET last_wall_ms = max(last_wall_ms, ?) "
                    "WHERE scope = ? AND mode = ?", (now, scope, self.mode),
                )
                self._db.commit()
                return deadline
            # Never auto-refund, even if the process dies before its first DNS call.
            self._db.execute(
                "UPDATE collector_budget SET day = ?, reserved_weight = ?, last_wall_ms = ?, "
                "next_at_ms = ?, pending = 1 WHERE scope = ? AND mode = ?",
                (day, spent + row["weight"], now, now + max(60000, row["interval_ms"]),
                 scope, self.mode),
            )
            self._db.commit()
            return None

    def record_deadline(self, scope: ProviderScope, now: int, deadline: int) -> None:
        """Persist Retry-After before committing observation; pending stays failclosed."""
        _time(now)
        _time(deadline)
        with self._transaction():
            row = self._required(scope)
            if not row["pending"] or now < row["last_wall_ms"] or deadline < now:
                raise PublicPolicyError()
            self._db.execute(
                "UPDATE collector_budget SET last_wall_ms = ?, next_at_ms = ? "
                "WHERE scope = ? AND mode = ?",
                (now, max(deadline, row["last_wall_ms"] + row["interval_ms"]), scope, self.mode),
            )
            self._db.commit()

    def complete(self, scope: ProviderScope) -> None:
        with self._transaction():
            row = self._required(scope)
            if not row["pending"]:
                raise PublicPolicyError()
            self._db.execute(
                "UPDATE collector_budget SET pending = 0 WHERE scope = ? AND mode = ?",
                (scope, self.mode),
            )
            self._db.commit()

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                try:
                    self._db.close()
                except sqlite3.Error:
                    raise PublicPolicyError() from None
                finally:
                    self._closed = True
