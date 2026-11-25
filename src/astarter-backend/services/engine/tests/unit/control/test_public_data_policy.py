"""Bounded policy DDL, atomic admission, copied fixtures and real OS processes."""

from __future__ import annotations

import multiprocessing
import shutil
import sqlite3
from multiprocessing.connection import Connection
from multiprocessing.process import BaseProcess
from pathlib import Path

import pytest

from stark_trading_os.control import public_data_policy as module
from stark_trading_os.control.public_data_collector import (
    PublicCollectorOwner,
    PublicCollectorOwnerError,
)
from stark_trading_os.control.public_data_policy import (
    DAY_MS,
    ProviderPolicy,
    ProviderScope,
    PublicPolicyError,
    PublicPolicyStore,
    policy_path,
)
from stark_trading_os.control.public_data_store import PublicDataStore
from tests.unit.control.test_public_data_collection import POLICIES
from tests.unit.control.test_public_data_persistence import NOW, synthetic_payload


def open_policy(path: Path) -> PublicPolicyStore:
    return PublicPolicyStore(path, mode="offline_fixture", policies=POLICIES)


@pytest.mark.parametrize("scope,interval", [
    ("binance", 9999), ("coingecko", 299999), ("blockbeats", 59999),
])
def test_operator_policy_cannot_speed_vendor_cadence(scope: ProviderScope, interval: int) -> None:
    with pytest.raises(PublicPolicyError):
        ProviderPolicy(scope, 1, interval)


@pytest.mark.parametrize("cap", [-1, 1000000001, True])
def test_operator_cap_must_be_explicit_bounded_integer(cap: int) -> None:
    with pytest.raises(PublicPolicyError):
        ProviderPolicy("binance", cap, 10000)


def test_weighted_budget_utc_deadline_clock_reversal_and_modes(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    policy = open_policy(path)
    assert policy.reserve("binance", NOW, 0) is None
    assert policy.snapshot("binance").reserved_weight == 3
    policy.record_deadline("binance", NOW, NOW + 10000)
    policy.complete("binance")
    assert policy.reserve("binance", NOW - DAY_MS, 0) == NOW + 10000
    assert policy.reserve("binance", NOW + 9999, 0) == NOW + 10000
    assert policy.reserve("binance", NOW + 10000, 0) is None
    policy.record_deadline("binance", NOW + 10000, NOW + 20000)
    policy.complete("binance")
    assert policy.reserve("binance", NOW + 20000, 0) == (NOW // DAY_MS + 1) * DAY_MS
    assert policy.snapshot("binance").reserved_weight == 6
    # Jump forward: no missed-day credits. A backwards jump cannot reopen a spent day.
    future = NOW + 10 * DAY_MS
    assert policy.reserve("binance", future, 0) is None
    policy.record_deadline("binance", future, future + 10000)
    policy.complete("binance")
    assert policy.reserve("binance", NOW, 0) == future + 10000
    assert policy.snapshot("binance").reserved_weight == 3
    live = PublicPolicyStore(path, mode="live_readonly", policies=POLICIES)
    assert live.snapshot("binance").reserved_weight == 0
    assert live.reserve("binance", NOW, 0) is None
    assert policy.snapshot("binance").day == future // DAY_MS
    live.close()
    policy.close()


@pytest.mark.parametrize("days", [0, 20])
def test_interrupted_charge_requires_new_owner_recovery_then_new_budget(
    tmp_path: Path, days: int,
) -> None:
    path = tmp_path / "public.sqlite"
    owner = PublicCollectorOwner(path)
    owner.acquire()
    policy = open_policy(path)
    refresh: dict[ProviderScope, int] = {scope: 0 for scope in policy.policies}
    policy.recover_session(owner, NOW, refresh)
    assert policy.reserve("binance", NOW, 0) is None
    before = policy.snapshot("binance")
    with pytest.raises(PublicCollectorOwnerError):
        policy.recover_session(owner, NOW + 20 * DAY_MS, refresh)
    assert policy.snapshot("binance") == before
    policy.close()  # Interrupted before HTTP or receipt of Retry-After.
    owner.close()
    policy = open_policy(path)
    assert policy.snapshot("binance") == before
    assert before.reserved_weight == 3 and before.pending
    now = NOW + days * DAY_MS
    with pytest.raises(PublicPolicyError):
        policy.reserve("binance", now, 0)
    assert policy.snapshot("binance") == before
    owner = PublicCollectorOwner(path)
    owner.acquire()
    deadlines = policy.recover_session(owner, now, refresh)
    recovered = policy.snapshot("binance")
    assert not recovered.pending and recovered.reserved_weight == 3
    assert recovered.day == before.day and recovered.last_wall_ms == before.last_wall_ms
    assert recovered.next_at_ms == before.next_at_ms
    assert deadlines["binance"] == now + 60000  # runtime-only guard, enforced by collector
    assert policy.reserve("binance", now + 59999, deadlines["binance"]) == now + 60000
    assert policy.reserve("binance", now + 60000, 0) is None
    assert policy.snapshot("binance").reserved_weight == (6 if days == 0 else 3)
    policy.record_deadline("binance", now + 60000, now + 70000)
    policy.complete("binance")
    if days == 0:
        assert policy.reserve("binance", now + 70000, 0) == (now // DAY_MS + 1) * DAY_MS
    policy.close()
    owner.close()


def test_recovery_needs_new_lease_and_commit_failure_rolls_back_all_scopes(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    policy = open_policy(path)
    assert policy.reserve("binance", NOW, 0) is None
    assert policy.reserve("blockbeats", NOW, 0) is None
    before = {scope: policy.snapshot(scope) for scope in policy.policies}
    refresh: dict[ProviderScope, int] = {scope: 0 for scope in policy.policies}
    refresh["blockbeats"] = NOW + 172801000  # snapshot gate can exceed policy's gate
    owner = PublicCollectorOwner(path)
    with pytest.raises(PublicCollectorOwnerError):
        policy.recover_session(owner, NOW, refresh)
    assert {scope: policy.snapshot(scope) for scope in policy.policies} == before
    owner.acquire()
    try:
        with sqlite3.connect(policy.path, isolation_level=None) as blocker:
            blocker.execute("BEGIN")
            blocker.execute("SELECT * FROM collector_budget").fetchall()
            with pytest.raises(PublicPolicyError):
                policy.recover_session(owner, NOW, refresh)
            blocker.rollback()
        assert {scope: policy.snapshot(scope) for scope in policy.policies} == before
        with pytest.raises(PublicCollectorOwnerError):
            policy.recover_session(owner, NOW, refresh)
    finally:
        owner.close()
    owner = PublicCollectorOwner(path)
    owner.acquire()
    try:
        deadlines = policy.recover_session(owner, NOW, refresh)
        assert deadlines["blockbeats"] == refresh["blockbeats"]
        assert policy.snapshot("blockbeats").reserved_weight == 1
        assert not policy.snapshot("binance").pending
        assert policy.snapshot("binance").reserved_weight == 3
        assert policy.snapshot("blockbeats").next_at_ms == before["blockbeats"].next_at_ms
        assert policy.reserve("blockbeats", refresh["blockbeats"] - 1, refresh["blockbeats"]) == (
            refresh["blockbeats"]
        )
        assert policy.reserve("blockbeats", refresh["blockbeats"], 0) is None
        assert policy.snapshot("blockbeats").reserved_weight == 1  # new UTC day, not a refund
    finally:
        owner.close()
        policy.close()


def test_reconfiguration_cannot_reconcile_a_pending_reservation(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    policy = open_policy(path)
    assert policy.reserve("binance", NOW, 0) is None
    before = policy.snapshot("binance")
    policy.close()
    with pytest.raises(PublicPolicyError):
        PublicPolicyStore(path, mode="offline_fixture", policies=(
            ProviderPolicy("binance", 9, 20000), *POLICIES[1:],
        ))
    policy = open_policy(path)
    assert policy.snapshot("binance") == before
    policy.close()


@pytest.mark.parametrize("where", ["WHERE scope = 'binance'", ""])
def test_missing_initialized_budget_rows_are_not_silently_repaired(
    tmp_path: Path, where: str,
) -> None:
    path = tmp_path / "public.sqlite"
    policy = open_policy(path)
    assert policy.reserve("binance", NOW, 0) is None
    policy.close()
    with sqlite3.connect(policy_path(path)) as db:
        db.execute("DELETE FROM collector_budget " + where)
    before = policy_path(path).read_bytes()
    with pytest.raises(PublicPolicyError):
        open_policy(path)
    assert policy_path(path).read_bytes() == before


def test_stored_deadline_wins_even_at_new_day_and_zero_cap_never_admits(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    policies = (ProviderPolicy("binance", 0, 10000), *POLICIES[1:])
    policy = PublicPolicyStore(path, mode="offline_fixture", policies=policies)
    assert policy.reserve("binance", NOW, 0) is not None
    deadline = NOW + 3 * DAY_MS
    assert policy.reserve("blockbeats", NOW, deadline) == deadline
    assert policy.snapshot("blockbeats").reserved_weight == 0
    policy.close()
    policy = PublicPolicyStore(path, mode="offline_fixture", policies=policies)
    assert policy.reserve("binance", NOW + DAY_MS, 0) is not None
    assert policy.reserve("blockbeats", NOW + DAY_MS, deadline) == deadline
    policy.close()


@pytest.mark.parametrize("column,value", [
    ("scope", "user"), ("mode", "paper"), ("daily_cap", None), ("daily_cap", -1),
    ("daily_cap", 1000000001), ("interval_ms", 9999), ("interval_ms", 1.5),
    ("weight", 1), ("reserved_weight", -1), ("reserved_weight", 7),
    ("day", -1), ("day", 2932897), ("last_wall_ms", None), ("next_at_ms", -1),
    ("next_at_ms", 253402300800000), ("pending", 2), ("pending", 1),
])
def test_actual_policy_not_null_check_unique_constraints(
    tmp_path: Path, column: str, value: object,
) -> None:
    policy = open_policy(tmp_path / "public.sqlite")
    before = policy.snapshot("binance")
    with sqlite3.connect(policy.path) as db:
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(
                f"UPDATE collector_budget SET {column} = ? WHERE scope = 'binance'", (value,),
            )
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("INSERT INTO collector_budget SELECT * FROM collector_budget")
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("UPDATE collector_budget SET interval_ms = 10000 WHERE scope = 'coingecko'")
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("UPDATE collector_binding SET public_path = NULL")
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("UPDATE collector_binding SET initialized_modes = 4")
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("UPDATE collector_binding SET initialized_modes = NULL")
    assert policy.snapshot("binance") == before
    policy.close()


def test_conflicting_policy_locked_commit_and_partial_setup_rollback(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    policy = open_policy(path)
    before = policy.snapshot("binance")
    with sqlite3.connect(policy.path) as blocker:
        blocker.execute("BEGIN IMMEDIATE")
        with pytest.raises(PublicPolicyError):
            policy.reserve("binance", NOW, 0)
    assert policy.snapshot("binance") == before
    policy.close()
    conflicting = (*POLICIES[:2], ProviderPolicy("blockbeats", 5, 60000))
    original_bytes = policy_path(path).read_bytes()
    with pytest.raises(PublicPolicyError):
        PublicPolicyStore(path, mode="offline_fixture", policies=conflicting)
    assert policy_path(path).read_bytes() == original_bytes
    # Populated copied policy fixture: incomplete initialized rows are corruption,
    # not permission to recreate a missing provider's spent quota.
    copied_public = tmp_path / "copy.sqlite"
    shutil.copy2(policy_path(path), policy_path(copied_public))
    with sqlite3.connect(policy_path(copied_public)) as db:
        db.execute("UPDATE collector_binding SET public_path = ?", (str(copied_public),))
        db.execute("DELETE FROM collector_budget WHERE scope = 'binance'")
    copied_bytes = policy_path(copied_public).read_bytes()
    with pytest.raises(PublicPolicyError):
        PublicPolicyStore(copied_public, mode="offline_fixture", policies=conflicting)
    assert policy_path(copied_public).read_bytes() == copied_bytes


def test_new_mode_initialization_commit_failure_rolls_back_on_populated_copy(
    tmp_path: Path,
) -> None:
    original = tmp_path / "original.sqlite"
    open_policy(original).close()
    copied = tmp_path / "copy.sqlite"
    shutil.copy2(policy_path(original), policy_path(copied))
    with sqlite3.connect(policy_path(copied)) as db:
        db.execute("UPDATE collector_binding SET public_path = ?", (str(copied),))
    before = policy_path(copied).read_bytes()
    with sqlite3.connect(policy_path(copied), isolation_level=None) as blocker:
        blocker.execute("BEGIN")
        blocker.execute("SELECT * FROM collector_budget").fetchall()
        with pytest.raises(PublicPolicyError):
            PublicPolicyStore(copied, mode="live_readonly", policies=POLICIES)
        blocker.rollback()
    assert policy_path(copied).read_bytes() == before
    with sqlite3.connect(policy_path(copied)) as db:
        assert db.execute("SELECT initialized_modes FROM collector_binding").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM collector_budget").fetchone()[0] == 3


@pytest.mark.parametrize("mutation", [
    "PRAGMA user_version = 2", "PRAGMA application_id = 77",
    "CREATE TABLE control_commands (id TEXT)",
])
def test_policy_identity_version_failure_does_not_mutate_populated_copy(
    tmp_path: Path, mutation: str,
) -> None:
    path = tmp_path / "public.sqlite"
    policy = open_policy(path)
    assert policy.reserve("blockbeats", NOW, 0) is None
    policy.close()
    copied = tmp_path / "copy.sqlite"
    shutil.copy2(policy_path(path), policy_path(copied))
    with sqlite3.connect(policy_path(copied)) as db:
        db.execute("UPDATE collector_binding SET public_path = ?", (str(copied),))
        db.execute(mutation)
    before = policy_path(copied).read_bytes()
    with pytest.raises(PublicPolicyError):
        open_policy(copied)
    assert policy_path(copied).read_bytes() == before


def test_schema_creation_failure_rolls_back_all_ddl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "public.sqlite"
    monkeypatch.setattr(module, "_BUDGET", "CREATE TABLE invalid (")
    with pytest.raises(PublicPolicyError):
        open_policy(path)
    with sqlite3.connect(policy_path(path)) as db:
        assert db.execute("SELECT name FROM sqlite_schema").fetchall() == []
        assert db.execute("PRAGMA user_version").fetchone()[0] == 0
        assert db.execute("PRAGMA application_id").fetchone()[0] == 0


def test_populated_public_v1_copy_unchanged_by_sidecar_initialization(tmp_path: Path) -> None:
    original = tmp_path / "original.sqlite"
    store = PublicDataStore(original, mode="offline_fixture")
    payload = synthetic_payload("news", empty=True)
    store.save("news", payload=payload, last_good=payload, fetched_at_ms=NOW,
               refresh_at_ms=NOW + 60000, expected_revision=0)
    store.close()
    copied = tmp_path / "copy.sqlite"
    shutil.copy2(original, copied)
    before = copied.read_bytes()
    policy = open_policy(copied)
    policy.close()
    reopened = PublicDataStore(copied, mode="offline_fixture")
    state = reopened.load("news")
    assert state is not None and state.payload == payload and state.revision == 1
    reopened.close()
    assert copied.read_bytes() == original.read_bytes() == before


def _admit_child(path: str, channel: Connection) -> None:
    policy = open_policy(Path(path))
    channel.send("ready")
    channel.recv()
    try:
        result = policy.reserve("binance", NOW, 0)
        channel.send("charged" if result is None else "denied")
    except PublicPolicyError:
        channel.send("denied")
    finally:
        policy.close()
        channel.close()


def test_independent_processes_cannot_double_reserve_same_scope(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    open_policy(path).close()
    context = multiprocessing.get_context("spawn")
    parents: list[Connection] = []
    processes: list[BaseProcess] = []
    try:
        for _ in range(2):
            parent, child = context.Pipe()
            process = context.Process(target=_admit_child, args=(str(path), child))
            process.start()
            child.close()
            parents.append(parent)
            processes.append(process)
            assert parent.poll(10) and parent.recv() == "ready"
        for parent in parents:
            parent.send("go")
        results = []
        for parent in parents:
            assert parent.poll(10)
            results.append(parent.recv())
        assert sorted(results) == ["charged", "denied"]
        for worker in processes:
            worker.join(10)
            assert worker.exitcode == 0
        policy = open_policy(path)
        assert policy.snapshot("binance").reserved_weight == 3
        policy.close()
    finally:
        for worker in processes:
            if worker.is_alive():
                worker.kill()
                worker.join(10)
        for parent in parents:
            parent.close()
