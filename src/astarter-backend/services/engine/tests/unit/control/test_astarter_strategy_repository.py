"""Synthetic Q01 persistence, isolation and non-authority checks."""

import json
import sqlite3
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import FrozenInstanceError
from hashlib import sha256
from threading import Barrier

import pytest

from stark_trading_os.control import database as db
from stark_trading_os.control.astarter import strategy_repository as r
from stark_trading_os.domain import strategy_contracts as c
from tests.unit.domain.test_strategy_contracts import (
    IDS,
    approval,
    budget,
    changed,
    evidence,
    plan,
    ready,
)


class SyntheticBackend:
    """Test-only ownership authority; deliberately not an auth implementation."""

    def __init__(self, binding=None, session="11111111-1111-1111-1111-111111111111"):
        self.assignment = r.ScopeAssignment(
            binding=binding or plan().binding, venue_session=session,
            authority_ref="SYNTHETIC-OWNERSHIP-NOT-AUTH",
        )

    def resolve_scope(self):
        return self.assignment


def account(conn, source):
    a = source.assignment
    conn.execute(
        "INSERT INTO astarter_accounts(account_id,venue_session,baseline_quote,risk_period,"
        "lock_fraction) VALUES(?,?,?,'fixture-period','0.2')",
        (a.binding.account_id, a.venue_session, "10000.000000000000000001"),
    )


@pytest.fixture
def store(tmp_path):
    path = tmp_path / "private.sqlite"
    conn = db.open_control_database(path)
    source = SyntheticBackend()
    account(conn, source)
    r.provision_account_scope(conn, source)
    repo = r.StrategyRepository(conn, source)
    yield path, conn, source, repo
    conn.close()


def save(repo, p=None, key="save-1", expected=None):
    bundle = changed(ready(), approval=None) if p is None else c.PreflightInput(plan=p)
    return repo.save_plan(bundle, request_key=key, expected_revision=expected, now_ms=1000)


def checkpoint(p=None, **updates):
    p = p or ready().plan
    return r.RecoveryCheckpoint.model_validate(dict(
        binding=p.binding, request_key="checkpoint-1", plan_id=p.plan_id,
        revision=p.revision, plan_sha256=c.contract_hash(p), seq=1, previous_sha256=None,
        state=c.StateSnapshot(lifecycle="PAUSED", order="UNKNOWN", protection="UNKNOWN",
                              reconciliation="UNKNOWN"),
        reason_locks=("NATIVE_RECONCILIATION_REQUIRED",),
        causal=evidence("DATA", "MARKET_WINDOW", c.contract_hash(p), "data-v1"),
        observed_at_ms=1000, budgets=budget(),
    ) | updates)


@pytest.mark.parametrize("sid", IDS)
def test_all_catalog_entries_roundtrip_scoped_and_nonexecuting(store, sid):
    path, conn, source, repo = store
    p = plan(sid)
    saved = save(repo, p)
    conn.close()
    reopened = db.open_control_database(path)
    try:
        result = r.StrategyRepository(reopened, source).read_plan(p.plan_id, now_ms=1000)
        assert result.record == saved
        assert result.decision.execution_authorized is False
        assert result.decision.status == "BLOCKED"
        assert reopened.execute("SELECT count(*) FROM astarter_bindings").fetchone()[0] == 0
    finally:
        reopened.close()


def test_private_approval_reopen_expiry_and_supersession(store):
    path, conn, source, repo = store
    first = save(repo)
    p = first.bundle.plan
    a = approval(p)
    saved = repo.save_approval(p.plan_id, a, request_key="review-1", now_ms=1000)
    assert saved.authority == "OFFLINE_REFERENCE"
    assert repo.save_approval(p.plan_id, a, request_key="review-1", now_ms=1000) == saved
    conn.close()
    conn = db.open_control_database(path)
    try:
        repo = r.StrategyRepository(conn, source)
        valid = repo.read_plan(p.plan_id, approval_id=a.reference_id, now_ms=1000)
        assert valid.decision.status == "ELIGIBLE"
        assert not valid.decision.execution_authorized
        expired = repo.read_plan(p.plan_id, approval_id=a.reference_id, now_ms=4000)
        assert expired.decision.status == "BLOCKED"
        new = changed(p, revision="plan-v2", risk_policy_revision="risk-v2")
        save(repo, new, "save-2", p.revision)
        old = repo.read_plan(p.plan_id, revision=p.revision,
                             approval_id=a.reference_id, now_ms=1000)
        assert old.record == first and old.approval == saved
        assert old.decision.reasons == ("PLAN_SUPERSEDED",)
        assert not old.current
        stale = repo.read_plan(p.plan_id, approval_id=a.reference_id, now_ms=1000)
        assert stale.decision.status == "BLOCKED"
        assert len(repo.list_plans(now_ms=1000)) == 2
        assert len(repo.list_plans(after=(p.plan_id, 1), now_ms=1000)) == 1
    finally:
        conn.close()


@pytest.mark.parametrize("revision,plan_reads,spec_reads", [(None, 2, 2), ("plan-v1", 2, 2)])
def test_plan_read_skips_null_revision_lookup_and_revalidates_current(
    store, revision, plan_reads, spec_reads,
):
    _, conn, _, repo = store
    saved = save(repo, plan())
    queries = []

    def observed(statement):
        if statement.startswith("SELECT * FROM astarter_"):
            queries.append(statement.split(" WHERE ", 1)[0])

    conn.set_trace_callback(observed)
    try:
        restored = repo.read_plan("fixture-plan", revision=revision, now_ms=1000)
    finally:
        conn.set_trace_callback(None)
    assert restored.record == saved and restored.current
    assert not restored.decision.execution_authorized
    assert Counter(queries) == {
        "SELECT * FROM astarter_strategy_scopes": 1,
        "SELECT * FROM astarter_plan_versions": plan_reads,
        "SELECT * FROM astarter_strategy_versions": spec_reads,
    }


def test_shared_cache_read_uncommitted_retains_supersession_check(store, monkeypatch):
    path, boot, source, repo = store
    first = save(repo)
    a = approval(first.bundle.plan)
    repo.save_approval("fixture-plan", a, request_key="review", now_ms=1000)
    boot.close()
    connections = []
    try:
        for _ in range(2):
            conn = sqlite3.connect(path.resolve().as_uri() + "?cache=shared", uri=True,
                                   isolation_level=None)
            connections.append(conn)
            conn.row_factory = sqlite3.Row
            conn.create_function("stark_control_writer_schema_version", 0, lambda: 9,
                                 deterministic=True)
            for version in (7, 8, 9):
                conn.create_function("stark_control_writer_schema" + str(version), 0,
                                     lambda version=version: version, deterministic=True)
            for setting in ("foreign_keys=ON", "synchronous=FULL", "busy_timeout=5000",
                            "read_uncommitted=1"):
                conn.execute("PRAGMA " + setting)
        reader, writer = (r.StrategyRepository(conn, source) for conn in connections)
        original = c.preflight
        published = False

        def publish(bundle, *, now_ms):
            nonlocal published
            decision = original(bundle, now_ms=now_ms)
            if not published:
                published = True
                save(writer, changed(bundle.plan, revision="plan-v2"), "v2", "plan-v1")
            return decision

        with monkeypatch.context() as patch:
            patch.setattr(c, "preflight", publish)
            result = reader.read_plan("fixture-plan", approval_id=a.reference_id, now_ms=1000)
        assert published and result.record == first and not result.current
        assert result.decision.reasons == ("PLAN_SUPERSEDED",)
        assert not result.decision.execution_authorized
        following = reader.read_plan("fixture-plan", now_ms=1000)
        assert following.record.bundle.plan.revision == "plan-v2"
    finally:
        for conn in connections:
            conn.close()


def test_replay_cas_different_payload_and_immutable_versions(store):
    _, conn, _, repo = store
    old = save(repo)
    assert save(repo) == old
    with pytest.raises(r.PersistenceConflict, match="REQUEST_PAYLOAD"):
        save(repo, changed(old.bundle.plan, risk_policy_revision="other"))
    with pytest.raises(r.PersistenceConflict, match="CAS"):
        save(repo, changed(old.bundle.plan, revision="v2"), "key2", "wrong")
    with pytest.raises((ValueError, sqlite3.IntegrityError)):
        save(repo, changed(old.bundle.plan, risk_policy_revision="other"), "key2", "plan-v1")
    for table in ("astarter_plan_versions", "astarter_strategy_versions"):
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            conn.execute(f"UPDATE {table} SET content_bytes=content_bytes")
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            conn.execute(f"DELETE FROM {table}")


@pytest.mark.parametrize("changes", [
    {"tenant_id": "other"}, {"account_id": "other"}, {"environment": "PAPER"},
])
def test_scope_is_backend_selected_not_payload_and_never_auto_claimed(store, changes):
    _, conn, source, repo = store
    p = save(repo).bundle.plan
    other_binding = changed(p.binding, **changes)
    other = SyntheticBackend(other_binding)
    with pytest.raises(r.ScopeDenied):
        r.StrategyRepository(conn, other)
    with pytest.raises(r.ScopeDenied):
        save(repo, changed(p, binding=other_binding), "foreign")
    with pytest.raises(r.ScopeDenied):
        repo.save_approval(p.plan_id, changed(approval(p), binding=other_binding),
                           request_key="foreign", now_ms=1000)
    with pytest.raises(r.ScopeDenied):
        repo.save_recovery(checkpoint(p, binding=other_binding), now_ms=1000)
    assert conn.execute("SELECT count(*) FROM astarter_strategy_scopes").fetchone()[0] == 1
    if "account_id" not in changes:
        with pytest.raises((r.ScopeDenied, r.StoredReferenceError)):
            r.provision_account_scope(conn, other)
    assert source.resolve_scope().binding == p.binding


@pytest.mark.parametrize("changes", [
    {"account_id": "account-b"},
    {"tenant_id": "tenant-b", "account_id": "account-b"},
    {"account_id": "account-b", "environment": "PAPER"},
    {"tenant_id": "tenant-b", "account_id": "account-b", "environment": "LIVE"},
])
def test_other_valid_scope_cannot_read_list_or_recover_foreign_ids(store, changes):
    _, conn, _, repo = store
    first = save(repo)
    p = first.bundle.plan
    repo.save_approval(p.plan_id, approval(p), request_key="review", now_ms=1000)
    repo.save_recovery(checkpoint(p), now_ms=1000)
    episode = r.EpisodeReference(binding=p.binding, episode_id="episode-1", plan_id=p.plan_id,
                                 revision=p.revision, plan_sha256=c.contract_hash(p))
    layer = r.LayerReference(binding=p.binding, episode_id=episode.episode_id, layer_index=0,
                             mode="VIRTUAL", action_id="action", trigger=checkpoint(p).causal,
                             disposition="UNKNOWN")
    repo.save_episode(episode)
    repo.save_layer(layer)
    assert repo.read_episode(episode.episode_id) == episode
    assert repo.read_layer(episode.episode_id, 0) == layer
    source = SyntheticBackend(changed(p.binding, **changes),
                              "22222222-2222-2222-2222-222222222222")
    account(conn, source)
    r.provision_account_scope(conn, source)
    other = r.StrategyRepository(conn, source)
    assert other.list_plans(now_ms=1000) == ()
    for call in (
        lambda: other.read_plan(p.plan_id, now_ms=1000),
        lambda: other.read_recovery(p.plan_id, p.revision, now_ms=1000),
        lambda: other.read_episode("episode-1"),
        lambda: other.read_layer("episode-1", 0),
    ):
        with pytest.raises(LookupError):
            call()
    with pytest.raises(r.ScopeDenied):
        save(other, p)
    for call in (
        lambda: other.save_approval(p.plan_id, approval(p), request_key="foreign", now_ms=1000),
        lambda: other.save_recovery(checkpoint(p), now_ms=1000),
        lambda: other.save_episode(episode),
        lambda: other.save_layer(layer),
    ):
        with pytest.raises(r.ScopeDenied):
            call()
    # Same IDs in two scopes do not collide, and foreign approval is not visible.
    own = changed(p, binding=source.assignment.binding)
    save(other, own)
    with pytest.raises(LookupError):
        other.read_plan(own.plan_id, approval_id="fixture-review", now_ms=1000)
    own_approval = other.save_approval(
        own.plan_id, approval(own), request_key="review", now_ms=1000,
    )
    own_recovery = other.save_recovery(checkpoint(own), now_ms=1000)
    assert other.read_recovery(own.plan_id, own.revision, now_ms=1000).checkpoint == own_recovery
    assert other.read_plan(own.plan_id, approval_id="fixture-review", now_ms=1000).approval == (
        own_approval
    )
    assert repo.read_plan(p.plan_id, now_ms=1000).record == first
    assert len(other.list_plans(now_ms=1000)) == len(repo.list_plans(now_ms=1000)) == 1


@pytest.mark.parametrize("forged", ["extra", "construct", "authority", "nested"])
def test_closed_boundary_rejects_forged_model_trees(store, forged):
    _, _, _, repo = store
    b = changed(ready(), approval=None)
    if forged == "extra":
        b = b.model_copy(update={"unknown": True})
    elif forged == "construct":
        b = c.PreflightInput.model_construct(plan=b.plan, extra="not-allowed")
        object.__getattribute__(b, "__dict__")["unknown"] = True
    elif forged == "authority":
        b = b.model_copy(update={"execution_authorized": True})
    else:
        b = b.model_copy(update={"plan": b.plan.model_copy(update={"expires_at_ms": True})})
    with pytest.raises(ValueError):
        repo.save_plan(b, request_key="bad", expected_revision=None, now_ms=1000)


@pytest.mark.parametrize("mutation", ["blob", "hash", "column", "extra-json", "duplicate-json"])
def test_corrupt_stored_payload_and_columns_fail_closed(store, mutation):
    _, conn, _, repo = store
    save(repo)
    # Deliberate corruption of a temporary fixture only, never a production repair.
    conn.execute("DROP TRIGGER trg_plan_versions_update")
    row = conn.execute("SELECT content_bytes FROM astarter_plan_versions").fetchone()
    if mutation == "column":
        conn.execute("UPDATE astarter_plan_versions SET risk_policy_revision='wrong'")
    elif mutation == "hash":
        conn.execute("UPDATE astarter_plan_versions SET content_sha256=?", ("0" * 64,))
    else:
        raw = b"not-json"
        if mutation == "extra-json":
            value = json.loads(row[0]) | {"unknown": 1}
            raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        elif mutation == "duplicate-json":
            raw = row[0][:-1] + b',"request_key":"save-1"}'
        conn.execute("UPDATE astarter_plan_versions SET content_bytes=?,content_sha256=?",
                     (raw, sha256(raw).hexdigest()))
    with pytest.raises(r.StoredReferenceError):
        repo.read_plan("fixture-plan", now_ms=1000)


def test_recovery_preserves_unknown_units_source_times_and_locks(store):
    path, conn, source, repo = store
    p = save(repo).bundle.plan
    item = checkpoint(p)
    assert repo.save_recovery(item, now_ms=1000) == item
    assert repo.save_recovery(item, now_ms=1001) == item
    conn.close()
    conn = db.open_control_database(path)
    try:
        repo = r.StrategyRepository(conn, source)
        result = repo.read_recovery(p.plan_id, p.revision, now_ms=5000)
        assert result.checkpoint == item
        assert result.checkpoint.causal.event_at_ms == 800
        assert result.checkpoint.causal.available_at_ms == 850
        assert result.checkpoint.causal.received_at_ms == 900
        assert result.checkpoint.budgets.simulation.unit == "SIM_MODEL_CREDIT_V1"
        assert result.checkpoint.budgets.supplier.cost_atoms is None
        assert result.checkpoint.budgets.customer.unit == "ASTARTER_CREDITS"
        assert result.budget_policy.supplier_liability_unresolved
        assert result.state_policy.new_risk_blocked and not result.state_policy.risk_release_allowed
        assert result.plan.decision.status == "BLOCKED"
        assert conn.execute("SELECT baseline_quote FROM astarter_accounts").fetchone()[0] == (
            "10000.000000000000000001"
        )
        next_item = changed(item, seq=2, previous_sha256=r.reference_hash(item), request_key="next")
        for bad in (
            changed(next_item, reason_locks=()),
            changed(next_item, state=changed(item.state, order="FILLED")),
            changed(next_item, state=changed(item.state, protection="SUFFICIENT_REFERENCE")),
            changed(next_item, observed_at_ms=999),
        ):
            with pytest.raises(r.PersistenceConflict):
                repo.save_recovery(bad, now_ms=1000)
        with pytest.raises(ValueError, match="FUTURE"):
            repo.read_recovery(p.plan_id, p.revision, now_ms=999)
        assert repo.save_recovery(next_item, now_ms=1000) == next_item
    finally:
        conn.close()


def test_virtual_layer_never_generates_economic_facts_and_unique_action(store):
    _, conn, _, repo = store
    p = save(repo, plan("S02-VP")).bundle.plan
    tables = ("astarter_accounts", "astarter_bindings", "astarter_intents", "astarter_orders",
              "astarter_fills", "astarter_settlements", "astarter_audit")
    before = {t: [tuple(x) for x in conn.execute(f"SELECT * FROM {t}")] for t in tables}
    episode = r.EpisodeReference(binding=p.binding, episode_id="episode-1", plan_id=p.plan_id,
                                 revision=p.revision, plan_sha256=c.contract_hash(p))
    repo.save_episode(episode)
    layer = r.LayerReference(binding=p.binding, episode_id=episode.episode_id, layer_index=0,
                             mode="VIRTUAL", action_id="one-action", trigger=checkpoint(p).causal,
                             disposition="TRIGGERED_REFERENCE")
    assert repo.save_layer(layer) == layer
    assert repo.read_layer(episode.episode_id, 0) == layer
    with pytest.raises(sqlite3.IntegrityError):
        repo.save_layer(changed(layer, layer_index=1))
    item = checkpoint(p, episode_id=episode.episode_id, layer_index=0)
    repo.save_recovery(item, now_ms=1000)
    assert repo.read_recovery(p.plan_id, p.revision, now_ms=1000).checkpoint == item
    assert {t: [tuple(x) for x in conn.execute(f"SELECT * FROM {t}")] for t in tables} == before


def test_two_independent_connections_contend_for_recovery_sequence(store):
    path, _, source, repo = store
    p = save(repo).bundle.plan
    barrier = Barrier(2)

    def worker(key):
        conn = db.open_control_database(path)
        try:
            other = r.StrategyRepository(conn, source)
            barrier.wait(timeout=10)
            try:
                other.save_recovery(checkpoint(p, request_key=key), now_ms=1000)
                return "saved"
            except r.PersistenceConflict:
                return "conflict"
        finally:
            conn.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(worker, ("a", "b"))) == ["conflict", "saved"]
    assert repo.read_recovery(p.plan_id, p.revision, now_ms=1000).checkpoint.seq == 1


def published_references(repo):
    p = save(repo).bundle.plan
    repo.save_approval(p.plan_id, approval(p), request_key="review", now_ms=1000)
    repo.save_episode(r.EpisodeReference(binding=p.binding, episode_id="ep", plan_id=p.plan_id,
                                         revision=p.revision, plan_sha256=c.contract_hash(p)))
    repo.save_layer(r.LayerReference(binding=p.binding, episode_id="ep", layer_index=0,
                                     mode="VIRTUAL", action_id="action",
                                     trigger=checkpoint(p).causal,
                                     disposition="UNKNOWN"))
    repo.save_recovery(checkpoint(p), now_ms=1000)
    return p


@pytest.mark.parametrize("table", [
    "astarter_strategy_scopes", "astarter_strategy_versions", "astarter_plan_versions",
    "astarter_approval_references", "astarter_episode_references", "astarter_layer_references",
    "astarter_recovery_checkpoints",
])
def test_sql_replace_cannot_erase_published_reference(store, table):
    _, conn, _, repo = store
    published_references(repo)
    assert conn.execute("PRAGMA recursive_triggers").fetchone()[0] == 0
    assert conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 1
    before = tuple(tuple(row) for row in conn.execute(f"SELECT * FROM {table}"))
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        conn.execute(f"INSERT OR REPLACE INTO {table} SELECT * FROM {table}")
    assert tuple(tuple(row) for row in conn.execute(f"SELECT * FROM {table}")) == before


@pytest.mark.parametrize("table,changes,unique_columns", [
    ("astarter_strategy_scopes", {"scope_id": "a" * 64}, ("account_id",)),
    ("astarter_strategy_versions", {"parameter_revision": "new"}, ("scope_id", "content_sha256")),
    ("astarter_plan_versions", {"revision": "new", "ordinal": 2, "previous_revision": "plan-v1"},
     ("scope_id", "request_key")),
    ("astarter_plan_versions", {"revision": "new", "request_key": "new"},
     ("scope_id", "plan_id", "ordinal")),
    ("astarter_approval_references", {"reference_id": "new"}, ("scope_id", "request_key")),
    ("astarter_layer_references", {"layer_index": 1}, ("scope_id", "episode_id", "action_id")),
    ("astarter_recovery_checkpoints", {"seq": 2, "content_sha256": "a" * 64},
     ("scope_id", "request_key")),
    ("astarter_recovery_checkpoints", {"seq": 2, "request_key": "new"},
     ("scope_id", "plan_id", "revision", "content_sha256")),
])
def test_sql_replace_alternate_unique_key_cannot_erase_history(
    store, table, changes, unique_columns,
):
    _, conn, _, repo = store
    published_references(repo)
    assert conn.execute("PRAGMA recursive_triggers").fetchone()[0] == 0
    before = tuple(conn.iterdump())
    original = dict(conn.execute(f"SELECT * FROM {table}").fetchone())
    candidate = original | changes
    if table == "astarter_recovery_checkpoints":
        candidate["previous_sha256"] = original["content_sha256"]
    primary = tuple(row[1] for row in conn.execute(f"PRAGMA table_info({table})") if row[5])
    assert tuple(candidate[k] for k in primary) != tuple(original[k] for k in primary)
    assert tuple(candidate[k] for k in unique_columns) == tuple(original[k] for k in unique_columns)
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        conn.execute(f"INSERT OR REPLACE INTO {table} ({','.join(candidate)}) "
                     f"VALUES ({','.join('?' for _ in candidate)})", tuple(candidate.values()))
    assert tuple(conn.iterdump()) == before


def test_sql_hidden_rowid_replace_cannot_erase_approval(store):
    _, conn, _, repo = store
    p = save(repo).bundle.plan
    repo.save_approval(p.plan_id, approval(p), request_key="review", now_ms=1000)
    assert conn.execute("PRAGMA recursive_triggers").fetchone()[0] == 0
    before = tuple(conn.iterdump())
    # All declared keys are NEW: an implicit rowid must not supply another
    # REPLACE conflict path outside the declared immutable-key guards.
    row = dict(conn.execute("SELECT * FROM astarter_approval_references").fetchone())
    row.update(rowid=1, reference_id="new-id", request_key="new-request")
    with pytest.raises(sqlite3.OperationalError, match="rowid"):
        conn.execute(
            f"INSERT OR REPLACE INTO astarter_approval_references ({','.join(row)}) "
            f"VALUES ({','.join('?' for _ in row)})", tuple(row.values()),
        )
    assert tuple(conn.iterdump()) == before


@pytest.mark.parametrize("table,trigger,path,value", [
    ("strategy_scopes", "strategy_scopes", ("binding", "tenant_id"), 1),
    ("strategy_versions", "strategy_versions", ("parameters", "ema_fast"), True),
    ("plan_versions", "plan_versions", ("ordinal",), True),
    ("plan_versions", "plan_versions", ("ordinal",), "1"),
    ("plan_versions", "plan_versions", ("ordinal",), 1.0),
    ("plan_versions", "plan_versions", ("bundle", "plan", "starts_at_ms"), "900"),
    ("plan_versions", "plan_versions", ("bundle", "plan", "expires_at_ms"), True),
    ("plan_versions", "plan_versions", ("execution_authorized",), 0),
    ("approval_references", "approval_references", ("approval", "research_call_budget"), 6.0),
    ("episode_references", "episode_references", ("episode_id",), 1),
    ("layer_references", "layer_references", ("layer_index",), False),
    ("recovery_checkpoints", "recovery_checkpoints", ("budgets", "customer", "atoms"), "0"),
    ("recovery_checkpoints", "recovery_checkpoints", ("observed_at_ms",), 1000.0),
    ("recovery_checkpoints", "recovery_checkpoints", ("causal", "use_allowed"), 1),
    ("plan_versions", "plan_versions", (), None),
    ("plan_versions", "plan_versions", (), 1),
    ("plan_versions", "plan_versions", (), "not-a-record"),
])
def test_rehashed_wrong_scalar_blob_is_rejected(store, table, trigger, path, value):
    _, conn, _, repo = store
    p = published_references(repo)
    table = "astarter_" + table
    original = conn.execute(f"SELECT content_bytes FROM {table}").fetchone()[0]
    payload = json.loads(original)
    if path:
        node = payload
        for key in path[:-1]:
            node = node[key]
        node[path[-1]] = value
    else:
        payload = value
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    assert raw != original
    # Corrupt this temporary fixture only; recompute SHA so rejection is not a stale-hash test.
    conn.execute(f"DROP TRIGGER trg_{trigger}_update")
    # A spec digest is also an FK target. Deliberately inject damaged storage,
    # then restore FK enforcement before exercising reads; never a writer workaround.
    if table == "astarter_strategy_versions":
        conn.execute("PRAGMA foreign_keys=OFF")
    conn.execute(f"UPDATE {table} SET content_bytes=?,content_sha256=?",
                 (raw, sha256(raw).hexdigest()))
    conn.execute("PRAGMA foreign_keys=ON")
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    if table == "astarter_strategy_versions":
        row = conn.execute(f"SELECT * FROM {table}").fetchone()
        with pytest.raises(r.StoredReferenceError, match="STORED_REFERENCE"):
            r._decode(row, c.StrategySpec, c.contract_hash(p.binding))
    readers = {
        "astarter_strategy_scopes": lambda: repo.list_plans(now_ms=1000),
        "astarter_strategy_versions": lambda: repo.read_plan(p.plan_id, now_ms=1000),
        "astarter_plan_versions": lambda: repo.read_plan(p.plan_id, now_ms=1000),
        "astarter_approval_references": lambda: repo.read_plan(
            p.plan_id, approval_id="fixture-review", now_ms=1000),
        "astarter_episode_references": lambda: repo.read_episode("ep"),
        "astarter_layer_references": lambda: repo.read_layer("ep", 0),
        "astarter_recovery_checkpoints": lambda: repo.read_recovery(
            p.plan_id, p.revision, now_ms=1000),
    }
    # Changed spec hash removes the plan's original FK target; the direct decode
    # above proves scalar rejection, while public read rejects that missing target.
    error = ("STRATEGY_VERSION_MISMATCH" if table == "astarter_strategy_versions"
             else "D1_STORED_REFERENCE_MISMATCH")
    with pytest.raises(r.StoredReferenceError, match=f"^{error}$"):
        readers[table]()


@pytest.mark.parametrize("state", ["UNKNOWN", "PARTIAL"])
def test_partial_unknown_cannot_become_success_or_release_liability(store, state):
    _, _, _, repo = store
    p = save(repo).bundle.plan
    old = checkpoint(p)
    old = changed(old, state=changed(old.state, order=state))
    repo.save_recovery(old, now_ms=1000)
    new = changed(old, seq=2, previous_sha256=r.reference_hash(old), request_key="new")
    with pytest.raises(r.PersistenceConflict):
        repo.save_recovery(changed(new, state=changed(new.state, order="FILLED")), now_ms=1000)
    paid = changed(new.budgets.supplier, cost_atoms=0, liability="OBSERVED_REFERENCE")
    with pytest.raises(r.PersistenceConflict):
        repo.save_recovery(changed(new, budgets=changed(new.budgets, supplier=paid)), now_ms=1000)


@pytest.mark.parametrize("now,status", [(899, "BLOCKED"), (900, "ELIGIBLE"),
                                        (1000, "ELIGIBLE"), (4000, "BLOCKED")])
def test_explicit_time_revalidates_restored_nine_duties(store, now, status):
    _, _, _, repo = store
    p = save(repo).bundle.plan
    a = approval(p)
    repo.save_approval(p.plan_id, a, request_key="review", now_ms=1000)
    result = repo.read_plan(p.plan_id, approval_id=a.reference_id, now_ms=now)
    assert result.decision.status == status
    assert result.decision.execution_authorized is False


def test_repository_real_sqlite_commit_denial_rolls_back_and_recovers(store):
    _, conn, _, repo = store
    conn.set_authorizer(lambda action, arg, *_: sqlite3.SQLITE_DENY
                        if action == sqlite3.SQLITE_TRANSACTION and arg == "COMMIT"
                        else sqlite3.SQLITE_OK)
    try:
        with pytest.raises(sqlite3.DatabaseError):
            save(repo)
    finally:
        conn.set_authorizer(None)
    assert not conn.in_transaction
    assert repo.list_plans(now_ms=1000) == ()
    assert conn.execute("SELECT count(*) FROM astarter_strategy_versions").fetchone()[0] == 0
    assert save(repo).ordinal == 1


def test_recovered_causal_rights_and_foreign_evidence_fail_closed(store):
    _, _, _, repo = store
    p = save(repo).bundle.plan
    item = checkpoint(p)
    item = changed(item, causal=changed(item.causal, rights_until_ms=1001))
    repo.save_recovery(item, now_ms=1000)
    assert repo.read_recovery(p.plan_id, p.revision, now_ms=1001).plan.decision.reasons == (
        "CAUSAL_REFERENCE_UNUSABLE",
    )
    foreign = changed(item.causal, classification="PRIVATE", share_allowed=False,
                      binding=changed(p.binding, tenant_id="other"))
    with pytest.raises(r.ScopeDenied):
        repo.save_recovery(changed(item, causal=foreign), now_ms=1000)


def test_real_sql_fk_refuses_foreign_account_binding_and_missing_episode(store):
    _, conn, _, repo = store
    p = save(repo).bundle.plan
    value = r.EpisodeReference(binding=p.binding, episode_id="bad", plan_id=p.plan_id,
                               revision=p.revision, plan_sha256=c.contract_hash(p),
                               binding_id="b" * 36)
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        repo.save_episode(value)
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        repo.save_recovery(checkpoint(p, episode_id="missing", layer_index=0), now_ms=1000)
    assert not conn.in_transaction
    assert conn.execute("SELECT count(*) FROM astarter_recovery_checkpoints").fetchone()[0] == 0


def linked_checkpoint(repo, p, **trigger_updates):
    """Synthetic linked trigger; no claim of a native strategy action."""
    item = checkpoint(p, episode_id="ep", layer_index=0)
    repo.save_episode(r.EpisodeReference(binding=p.binding, episode_id="ep", plan_id=p.plan_id,
                                         revision=p.revision, plan_sha256=c.contract_hash(p)))
    repo.save_layer(r.LayerReference(binding=p.binding, episode_id="ep", layer_index=0,
                                     mode="VIRTUAL", action_id="action",
                                     trigger=changed(item.causal, **trigger_updates),
                                     disposition="TRIGGERED_REFERENCE"))
    return item


@pytest.mark.parametrize("prior_exists", [False, True])
@pytest.mark.parametrize("available,received,now", [
    (850, 1000, 1100),  # Equality is allowed even when saving later.
    (850, 1001, 1100),  # A single millisecond late is still future evidence.
    (1050, 1100, 1100),  # Independent review's actual counterexample.
    (1050, 1100, 1500),  # A later now cannot repair checkpoint history.
])
def test_linked_trigger_checkpoint_time_write_boundary_and_rollback(
    store, prior_exists, available, received, now,
):
    _, conn, _, repo = store
    p = save(repo).bundle.plan
    a = approval(p)
    repo.save_approval(p.plan_id, a, request_key="review", now_ms=1000)
    item = linked_checkpoint(repo, p, available_at_ms=available, received_at_ms=received)
    if prior_exists:
        prior = checkpoint(p, request_key="prior")
        repo.save_recovery(prior, now_ms=1000)
        item = changed(item, seq=2, previous_sha256=r.reference_hash(prior))
    before = tuple(conn.iterdump())
    if received == item.observed_at_ms:
        assert repo.save_recovery(item, now_ms=now) == item
        restored = repo.read_recovery(p.plan_id, p.revision,
                                      approval_id=a.reference_id, now_ms=now)
        assert restored.checkpoint == item
        assert restored.plan.decision.status == "ELIGIBLE"
        assert restored.plan.decision.execution_authorized is False
    else:
        # The same evidence directly on causal was already rejected by shape.
        with pytest.raises(ValueError, match="CAUSAL_REFERENCE_FROM_FUTURE"):
            changed(item, causal=repo.read_layer("ep", 0).trigger)
        with pytest.raises(r.StoredReferenceError, match="^LAYER_TRIGGER_FROM_FUTURE$"):
            repo.save_recovery(item, now_ms=now)
        assert not conn.in_transaction
        assert tuple(conn.iterdump()) == before
        assert conn.execute("SELECT count(*) FROM astarter_recovery_checkpoints").fetchone()[0] == (
            int(prior_exists)
        )
        # Failed insert consumed neither request key nor sequence. No time rewriting.
        unlinked = changed(item, layer_index=None)
        assert repo.save_recovery(unlinked, now_ms=now) == unlinked
        assert repo.read_recovery(p.plan_id, p.revision, now_ms=now).checkpoint == unlinked
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.parametrize("seq", [None, 1])
@pytest.mark.parametrize("now", [1100, 1500])
def test_linked_trigger_future_injected_fixture_rejected_on_read(store, seq, now):
    _, conn, _, repo = store
    p = save(repo).bundle.plan
    a = approval(p)
    repo.save_approval(p.plan_id, a, request_key="review", now_ms=1000)
    item = linked_checkpoint(repo, p, available_at_ms=1050, received_at_ms=1100)
    # Fixture only: valid SQL/bytes/FKs, deliberately bypass repository validation.
    # No FK/trigger toggles and no production repair path.
    with db._immediate_transaction(conn):
        r._insert(conn, "astarter_recovery_checkpoints", c.contract_hash(p.binding), item)
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    before = tuple(conn.iterdump())
    with pytest.raises(r.StoredReferenceError, match="^LAYER_TRIGGER_FROM_FUTURE$"):
        repo.read_recovery(p.plan_id, p.revision, seq=seq,
                           approval_id=a.reference_id, now_ms=now)
    assert not conn.in_transaction
    assert tuple(conn.iterdump()) == before


@pytest.mark.parametrize("updates", [{"rights_until_ms": 1100}, {"max_age_ms": 299}])
def test_linked_trigger_still_rechecks_rights_and_ttl_at_read_now(store, updates):
    _, _, _, repo = store
    p = save(repo).bundle.plan
    a = approval(p)
    repo.save_approval(p.plan_id, a, request_key="review", now_ms=1000)
    item = linked_checkpoint(repo, p, received_at_ms=1000, **updates)
    repo.save_recovery(item, now_ms=1000)
    valid = repo.read_recovery(p.plan_id, p.revision, approval_id=a.reference_id, now_ms=1099)
    assert valid.plan.decision.status == "ELIGIBLE"
    expired = repo.read_recovery(p.plan_id, p.revision, approval_id=a.reference_id, now_ms=1100)
    assert expired.checkpoint == item
    assert expired.plan.decision.reasons == ("CAUSAL_REFERENCE_UNUSABLE",)
    assert expired.plan.decision.execution_authorized is False


@pytest.mark.parametrize("locks", [(), ("NATIVE_RECONCILIATION_REQUIRED",)])
def test_recovery_reference_only_is_fixed_and_healthy_projections_are_not_authority(store, locks):
    _, conn, _, repo = store
    p = save(repo).bundle.plan
    a = approval(p)
    repo.save_approval(p.plan_id, a, request_key="review", now_ms=1000)
    # Subject hashes/source IDs are archival claims, NOT proof of an actual trigger.
    item = linked_checkpoint(repo, p, subject_sha256="c" * 64,
                              source_id="ARCHIVE-NOT-A-TRUSTED-SOURCE")
    item = changed(item, reason_locks=locks,
                   causal=changed(item.causal, subject_sha256="d" * 64),
                   state=c.StateSnapshot(lifecycle="ACTIVE_REFERENCE", order="NONE",
                                         protection="NOT_REQUIRED",
                                         reconciliation="MATCHED_REFERENCE"),
                   budgets=changed(budget(),
                                   supplier=changed(budget().supplier, cost_atoms=0,
                                                    liability="OBSERVED_REFERENCE"),
                                   customer=changed(budget().customer, state="RESERVED_REFERENCE")))
    repo.save_recovery(item, now_ms=1000)
    before = tuple(conn.iterdump())
    result = repo.read_recovery(p.plan_id, p.revision, approval_id=a.reference_id, now_ms=1000)
    assert result.reference_only is True
    assert result.checkpoint_current is True and result.plan.current is True
    assert result.checkpoint == item and result.checkpoint.reason_locks == locks
    assert result.state_policy == c.state_policy(item.state)
    assert result.state_policy.new_risk_blocked is False  # Raw Q01 projection, not merged locks.
    assert result.budget_policy.new_research_blocked is False
    assert result.plan.decision.status == "ELIGIBLE"
    for value in (result.checkpoint, result.plan.record, result.plan.approval,
                  result.plan.decision, result.state_policy, result.budget_policy):
        assert value.execution_authorized is False
    assert result.plan.decision.risk_release_allowed is False
    assert result.state_policy.risk_release_allowed is False
    assert result.budget_policy.automatic_charged_retry_allowed is False
    assert result.budget_policy.transaction_actions == ()
    assert "reference_only" not in result.checkpoint.model_dump()
    assert "checkpoint_current" not in result.checkpoint.model_dump()
    assert r.reference_hash(result.checkpoint) == r.reference_hash(item)
    assert tuple(conn.iterdump()) == before
    for supplied in (True, False):
        with pytest.raises(TypeError, match="reference_only"):
            r.RestoredRecovery(item, result.plan, result.state_policy, result.budget_policy,
                               checkpoint_current=True, reference_only=supplied)
    with pytest.raises(FrozenInstanceError):
        result.reference_only = False


def test_recovery_history_current_is_not_plan_current_or_cross_revision_reconciliation(store):
    _, conn, _, repo = store
    original = save(repo)
    p = original.bundle.plan
    first = checkpoint(p)
    second = changed(first, seq=2, previous_sha256=r.reference_hash(first), request_key="second",
                     reason_locks=(*first.reason_locks, "OPERATOR_REVIEW_REQUIRED"))
    repo.save_recovery(first, now_ms=1000)
    repo.save_recovery(second, now_ms=1000)
    before = tuple(conn.iterdump())
    for seq, expected, current in ((1, first, False), (2, second, True), (None, second, True)):
        result = repo.read_recovery(p.plan_id, p.revision, seq=seq, now_ms=1000)
        assert result.checkpoint == expected
        assert result.checkpoint_current is current
        assert result.plan.current is True and result.reference_only is True
        assert result.plan.decision.execution_authorized is False
    with pytest.raises(LookupError, match="PRIVATE_RECOVERY_NOT_FOUND"):
        repo.read_recovery(p.plan_id, p.revision, seq=3, now_ms=1000)
    assert tuple(conn.iterdump()) == before

    new = changed(p, revision="plan-v2")
    repo.save_plan(changed(original.bundle, plan=new), request_key="new-plan",
                   expected_revision=p.revision, now_ms=1000)
    # A fresh revision's snapshot is not a resolution of the old chain's obligations.
    new_item = checkpoint(new, request_key="new-checkpoint", reason_locks=(),
                          state=c.StateSnapshot(lifecycle="ACTIVE_REFERENCE", order="NONE",
                                                protection="NOT_REQUIRED",
                                                reconciliation="MATCHED_REFERENCE"),
                          budgets=changed(budget(), supplier=changed(
                              budget().supplier, cost_atoms=0, liability="OBSERVED_REFERENCE")))
    repo.save_recovery(new_item, now_ms=1000)
    before = tuple(conn.iterdump())
    old = repo.read_recovery(p.plan_id, p.revision, now_ms=1000)
    current = repo.read_recovery(new.plan_id, new.revision, now_ms=1000)
    assert old.checkpoint == second and old.checkpoint.state.order == "UNKNOWN"
    assert old.checkpoint.reason_locks == second.reason_locks
    assert old.budget_policy.supplier_liability_unresolved is True
    assert old.checkpoint_current is True and old.plan.current is False
    assert old.plan.decision.reasons == ("PLAN_SUPERSEDED",)
    assert current.checkpoint == new_item and current.checkpoint.seq == 1
    assert current.checkpoint_current is True and current.plan.current is True
    assert current.state_policy.new_risk_blocked is False
    assert current.budget_policy.supplier_liability_unresolved is False
    for result in (old, current):
        assert result.reference_only is True
        assert result.plan.decision.execution_authorized is False
        assert result.state_policy.risk_release_allowed is False
    assert tuple(conn.iterdump()) == before


@pytest.mark.parametrize("other_chain", ["scope", "plan"])
def test_recovery_checkpoint_current_uses_only_scoped_plan_revision_chain(store, other_chain):
    _, conn, _, repo = store
    p = save(repo).bundle.plan
    item = checkpoint(p)
    repo.save_recovery(item, now_ms=1000)
    other = repo
    own = changed(p, plan_id="another-plan")
    if other_chain == "scope":
        source = SyntheticBackend(changed(p.binding, account_id="account-b"),
                                  "22222222-2222-2222-2222-222222222222")
        account(conn, source)
        r.provision_account_scope(conn, source)
        other = r.StrategyRepository(conn, source)
        own = changed(p, binding=source.assignment.binding)
    save(other, own, "other-plan")
    first = checkpoint(own, request_key="other-first")
    other.save_recovery(first, now_ms=1000)
    other.save_recovery(changed(first, seq=2, previous_sha256=r.reference_hash(first),
                                request_key="other-second"), now_ms=1000)
    for seq in (None, 1):
        result = repo.read_recovery(p.plan_id, p.revision, seq=seq, now_ms=1000)
        assert result.checkpoint == item and result.checkpoint_current is True
        assert result.reference_only is True
        assert result.plan.decision.execution_authorized is False
