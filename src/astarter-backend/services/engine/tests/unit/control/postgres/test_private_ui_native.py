"""Owned local PG only: PRIVATE UI privileges, RLS, atomicity and two-owner journeys.

Issuer messages/results are synthetic fixtures, not wallet signatures or model calls.
"""

import copy
import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

import psycopg
import pytest

from stark_trading_os.control.postgres.pool import CommitUnknown
from stark_trading_os.control.postgres.private_research_contracts import (
    MAX_SAFE_INTEGER,
    utc_month_bounds,
)
from stark_trading_os.control.postgres.private_research_issuer import PrivateIssuerRepository
from stark_trading_os.control.postgres.private_research_repository import PrivateRuntimeRepository
from stark_trading_os.control.postgres.private_ui_migration import upgrade_private_ui
from stark_trading_os.control.postgres.private_ui_repository import PrivateUIRepository
from stark_trading_os.control.private_research_rpc import PrivateRPCError
from tests.unit.control.postgres import test_private_research_issuer as identity
from tests.unit.control.postgres import test_private_research_migration as base
from tests.unit.control.postgres.test_private_research_migration import db as db
from tests.unit.control.postgres.test_private_research_migration import native
from tests.unit.control.postgres.test_private_research_repository import (
    claim_payload,
    finish_payload,
    lease,
    pool_for,
    scope,
)
from tests.unit.control.postgres.test_private_ui_identity import (
    PROFILE,
    PROFILE_LINE,
    UI_PERMISSIONS,
)

EVIDENCE = Path(
    "/Users/mac/Documents/AI Space/Developer/交易大法/任务/"
    "01a1de40_Astarter后端协作/ai-team-assist-20261116"
)


@pytest.fixture(scope="module")
def pg():
    evidence = EVIDENCE / ("ui-native-owned-" + uuid4().hex)
    evidence.mkdir(mode=0o700)
    with patch.object(base, "TASK", evidence), base.cluster() as owned:
        yield owned


def _issue(repo, digit, suffix, version):
    now = time.time_ns() // 1_000_000
    profile = {"authVersion": 2, "permissionProfile": PROFILE} if version == 2 else {}
    record = {
        "challengeHash": identity.hashed(suffix), "nonce": identity.hashed(suffix + "nonce"),
        "origin": identity.ORIGIN, "issuedAt": now, "expires": now + 300000,
        "address": None, "chain": None, "message": None, **profile,
    }
    saved = repo.invoke("auth/challenge/issue", record, None)
    assert saved is not None
    binding = identity.binding(saved, digit)
    binding |= profile
    if version == 2:
        binding["message"] += "\nResources:\n" + PROFILE_LINE
    assert repo.invoke("auth/challenge/prepare", binding, None) is not None
    consumed = repo.invoke("auth/challenge/consume", binding, None)
    assert consumed is not None
    args = identity.session_args(binding, consumed, suffix + "-session") | profile
    if version == 2:
        args["permissions"] = UI_PERMISSIONS
    session = repo.invoke("auth/session/issue", args, None)
    assert session is not None
    return {"digest": args["tokenHash"], "subject": session["subjectId"]}


@pytest.fixture
def live(db):
    owned, owner, old_target = db
    target = replace(old_target, schema_version=2)
    upgrade_private_ui(owner, target=target)
    issuer_pool, runtime_pool = pool_for(target, "issuer"), pool_for(target, "runtime")
    try:
        issuer_pool.open()
        runtime_pool.open()
        issuer = PrivateIssuerRepository(issuer_pool)
        users = {name: _issue(issuer, digit, uuid4().hex, version)
                 for name, digit, version in (
                     ("alice", "1", 2), ("bob", "2", 2),
                     ("legacy", "1", 1), ("alice-second", "1", 2),
                 )}
        now = owner.execute(
            "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS n"
        ).fetchone()["n"]
        configured = lease(target, now + 180000)
        owner.execute(
            "INSERT INTO astarter_private.leases VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            ("lease", target.target_id, target.database, target.runtime, target.profile.value,
             "astarter-research", base.MODEL, "policy", now - 1, configured.expires_at),
        )
        start, end = utc_month_bounds(now)
        owner.execute(
            "INSERT INTO astarter_private.global_budget VALUES(%s,%s,50000000,1000000,0,0,FALSE)",
            (start, end),
        )
        for name in ("alice", "bob"):
            owner.execute(
                "INSERT INTO astarter_private.policies(month_start_ms,tenant_id,policy_id,model,"
                "token_limit,request_limit,limit_microusd,blocked) "
                "VALUES(%s,%s,'policy',%s,130560,10,2000000,FALSE)",
                (start, users[name]["subject"], base.MODEL),
            )
        yield {
            "ui": PrivateUIRepository(runtime_pool, lease=configured),
            "research": PrivateRuntimeRepository(runtime_pool, lease=configured),
            "pool": runtime_pool, "issuer": issuer, "users": users,
            "owner": owner, "target": target, "lease": configured, "pg": owned,
        }
    finally:
        runtime_pool.close()
        issuer_pool.close()
        assert runtime_pool._pool.closed and issuer_pool._pool.closed
        deadline = time.monotonic() + 1
        while True:
            active = owner.execute(
                "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() "
                "AND usename=ANY(%s)", ([target.runtime, target.issuer],),
            ).fetchone()["n"]
            if active == 0 or time.monotonic() >= deadline:
                break
            time.sleep(0.01)
        assert active == 0


def _invoke(live, operation, payload=None, who="alice"):
    return live["ui"].invoke(
        operation, scope(live["lease"]) | (payload or {}), live["users"][who]["digest"],
    )


def _save(request="workspace-01", base_revision=0, name="Research"):
    return {
        "requestId": request, "baseRevision": base_revision,
        "preferences": {"workbenchFilter": "tracked", "workbenchFocusAsset": "BTC",
                        "watchedAssets": ["BTC", "ca:sui:0x" + "a" * 64]},
        "drafts": [{"id": "draft-01", "strategyId": "RX03-S", "name": name}],
        "selectedDraftId": "draft-01",
    }


def _notices(live, who="alice"):
    return _invoke(live, "notifications/state", {"cursor": None, "limit": 20}, who)


def _claim(live, who="alice"):
    user, repo = live["users"][who], live["research"]
    return repo.invoke(
        "research/claim", claim_payload(repo, user, live["lease"]), user["digest"],
    )


@native
def test_native_workspace_cas_replay_and_second_owner_isolation(live):
    first = _invoke(live, "workspace/save", _save())
    assert first["request"]["revision"] == 1
    assert _invoke(live, "workspace/save", _save()) == first
    assert _invoke(live, "workspace/state", who="bob")["drafts"] == []
    assert _invoke(live, "workspace/request", {"requestId": "workspace-01"}, "bob") is None
    with pytest.raises(PrivateRPCError, match="PRIVATE_CONFLICT"):
        _invoke(live, "workspace/save", _save(name="Changed"))
    with pytest.raises(PrivateRPCError, match="PRIVATE_CONFLICT"):
        _invoke(live, "workspace/save", _save(request="workspace-02"))
    assert _invoke(live, "workspace/state")["revision"] == 1
    assert live["owner"].execute(
        "SELECT count(*) AS n FROM astarter_private.ui_commands"
    ).fetchone()["n"] == 1


@native
def test_native_cross_session_owner_cas_has_one_winner(live):
    barrier = Barrier(2)

    def save(who):
        barrier.wait(3)
        try:
            return _invoke(live, "workspace/save", _save(request="save-" + who), who)
        except PrivateRPCError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(save, ["alice", "alice-second"]))
    assert sum(isinstance(result, dict) for result in results) == 1
    assert results.count("PRIVATE_CONFLICT") == 1
    assert _invoke(live, "workspace/state")["revision"] == 1


@native
def test_native_v1_same_owner_is_not_upgraded_and_runtime_rls_is_real(live):
    _invoke(live, "workspace/save", _save(), "bob")
    with pytest.raises(PrivateRPCError, match="PRIVATE_FORBIDDEN"):
        _invoke(live, "workspace/state", who="legacy")
    user = live["users"]["alice"]
    bob = live["users"]["bob"]["subject"]
    with live["pool"].transaction(write=True, scope_id=bob) as c:
        c.execute("SELECT set_config('astarter_private.session_digest',%s,TRUE)", (user["digest"],))
        assert c.execute("SELECT * FROM astarter_private.workspace_preferences").fetchall() == []
        assert c.execute(
            "UPDATE astarter_private.workspace_preferences SET revision=revision+1 "
            "WHERE tenant_id=%s AND subject_id=%s", (bob, bob),
        ).rowcount == 0
        with pytest.raises(psycopg.errors.InsufficientPrivilege), c.transaction():
            c.execute(
                "INSERT INTO astarter_private.notification_preferences(tenant_id,subject_id) "
                "VALUES(%s,%s)", (bob, bob),
            )
    with live["pool"].transaction() as c:
        c.execute("SELECT set_config('astarter_private.session_digest',%s,TRUE)",
                  (live["users"]["legacy"]["digest"],))
        for table in ("notification_preferences", "notification_inbox", "workspace_preferences",
                      "ui_commands"):
            # Table names are this fixed literal tuple, never a caller argument.
            assert c.execute("SELECT * FROM astarter_private." + table).fetchall() == []


@native
def test_native_exact_runtime_column_privileges_do_not_reach_funds_or_inbox_insert(live):
    forbidden = (
        "UPDATE astarter_private.sessions SET revoked_at_ms=0 WHERE FALSE",
        "UPDATE astarter_private.global_budget SET spent_microusd=0 WHERE FALSE",
        "INSERT INTO astarter_private.notification_inbox(tenant_id) VALUES('synthetic')",
        "UPDATE astarter_private.notification_inbox SET title='forged' WHERE FALSE",
        "UPDATE astarter_private.ui_commands SET revision=revision+1 WHERE FALSE",
        "DELETE FROM astarter_private.workspace_preferences WHERE FALSE",
    )
    with live["pool"].transaction(write=True, scope_id="ui-forbidden-probes") as c:
        for statement in forbidden:
            with pytest.raises(psycopg.errors.InsufficientPrivilege), c.transaction():
                c.execute(statement)
        assert c.execute(
            "SELECT has_function_privilege(current_user,"
            "'astarter_private.ui_research_terminal()','EXECUTE') AS allowed"
        ).fetchone() == {"allowed": False}


@native
@pytest.mark.parametrize("state", ["complete", "failed", "unknown"])
def test_native_research_finish_event_is_atomic_classified_and_deduplicated(live, state):
    user, repo = live["users"]["alice"], live["research"]
    claim = _claim(live)
    assert claim["acquired"]
    payload = finish_payload(user, live["lease"], claim["claimToken"], state)
    finished = repo.invoke("research/finish", payload, user["digest"])
    assert finished["state"] == state
    notice = _notices(live)
    if state == "unknown":
        assert notice["inbox"] == [] and notice["revision"] == 0
        return
    assert len(notice["inbox"]) == notice["unreadCount"] == 1
    assert notice["inbox"][0]["type"] == ("research" if state == "complete" else "risk")
    assert notice["inbox"][0]["executionAuthority"] == "NONE"
    assert notice["revision"] == 1
    assert _notices(live, "bob")["inbox"] == []
    assert repo.invoke("research/finish", payload, user["digest"]) == finished
    assert _notices(live) == notice
    read = _invoke(live, "notifications/command", {
        "requestId": "mark-read-01", "baseRevision": 1, "action": "mark-read",
        "payload": {"ids": [notice["inbox"][0]["id"]]},
    })
    assert read["state"]["unreadCount"] == 0 and read["state"]["revision"] == 2
    assert read["state"]["inbox"][0]["readAt"] is not None
    assert _invoke(live, "notifications/request", {"requestId": "mark-read-01"}) == read


@native
def test_native_trigger_failure_rolls_back_finish_and_its_inbox(live):
    user, repo, owner = live["users"]["alice"], live["research"], live["owner"]
    claim = _claim(live)
    owner.execute(
        "INSERT INTO astarter_private.notification_preferences(tenant_id,subject_id,revision) "
        "VALUES(%s,%s,%s)", (user["subject"], user["subject"], MAX_SAFE_INTEGER),
    )
    before = owner.execute("SELECT * FROM astarter_private.global_budget").fetchone()
    with pytest.raises(PrivateRPCError):
        repo.invoke("research/finish", finish_payload(user, live["lease"], claim["claimToken"]),
                    user["digest"])
    assert owner.execute("SELECT state FROM astarter_private.requests").fetchone() == {
        "state": "pending"
    }
    assert owner.execute(
        "SELECT count(*) AS n FROM astarter_private.notification_inbox"
    ).fetchone()["n"] == 0
    assert owner.execute("SELECT * FROM astarter_private.global_budget").fetchone() == before
    assert owner.execute(
        "SELECT revision FROM astarter_private.notification_preferences"
    ).fetchone()["revision"] == MAX_SAFE_INTEGER


@native
def test_native_post_commit_ack_unknown_queries_original_without_new_write(live):
    pool = live["pool"]
    commit = pool._commit

    def lost_ack(connection):
        commit(connection)
        raise psycopg.OperationalError("SYNTHETIC_POST_COMMIT_ACK_LOST")

    with patch.object(pool, "_commit", lost_ack), pytest.raises(CommitUnknown):
        _invoke(live, "workspace/save", _save())
    original = _invoke(live, "workspace/request", {"requestId": "workspace-01"})
    assert original["request"]["status"] == "applied"
    assert original["state"]["revision"] == 1
    assert _invoke(live, "workspace/state") == original["state"]
    assert live["owner"].execute(
        "SELECT count(*) AS n FROM astarter_private.ui_commands"
    ).fetchone()["n"] == 1


@native
def test_native_notification_preferences_are_private_and_do_not_send(live):
    data = {"requestId": "notice-save-01", "baseRevision": 0, "action": "save",
            "payload": {"events": ["research"], "inapp": False,
                        "enabled": {"telegram": False, "email": False}}}
    saved = _invoke(live, "notifications/command", data)
    assert saved["state"]["inapp"] is False
    assert _notices(live, "bob")["inapp"] is True
    assert saved["state"]["deliveries"] == []
    invalid = copy.deepcopy(data)
    invalid["requestId"], invalid["baseRevision"] = "notice-save-02", 1
    invalid["payload"]["enabled"]["email"] = True
    with pytest.raises(PrivateRPCError, match="PRIVATE_UNAVAILABLE"):
        _invoke(live, "notifications/command", invalid)
    assert _notices(live) == saved["state"]
    assert "secret" not in json.dumps(saved).lower()


def _reminder_terminal(live, request, *, who="alice", state="complete"):
    user, repo = live["users"][who], live["research"]
    claim = repo.invoke(
        "research/claim", claim_payload(repo, user, live["lease"], request), user["digest"],
    )
    assert claim["acquired"]
    payload = finish_payload(user, live["lease"], claim["claimToken"], state)
    payload["requestId"] = request
    assert repo.invoke("research/finish", payload, user["digest"])["state"] == state


@native
def test_native_reminder_count_spans_pages_and_preferences_without_erasing_history(live):
    owner, alice = live["owner"], live["users"]["alice"]["subject"]
    owner.execute(
        "UPDATE astarter_private.policies SET request_limit=64,token_limit=1000000 "
        "WHERE tenant_id=%s", (alice,),
    )
    for number in range(52):
        _reminder_terminal(live, f"reminder-fixture-{number:03}")
    _reminder_terminal(live, "reminder-fixture-risk", state="failed")
    _reminder_terminal(live, "reminder-fixture-bob", who="bob")
    before = owner.execute("SELECT * FROM astarter_private.global_budget").fetchone()

    def read(*, version=2, cursor=None, who="alice"):
        payload = {"cursor": cursor, "limit": 1}
        if version is not None:
            payload["responseVersion"] = version
        return _invoke(live, "notifications/state", payload, who)

    original = _invoke(live, "notifications/command", {
        "requestId": "reminder-pref-001", "baseRevision": 53, "action": "save",
        "payload": {"events": ["research"], "inapp": True,
                    "enabled": {"telegram": False, "email": False}},
    })
    first = read()
    assert first["schema"] == "private-notifications-v2"
    assert first["unreadCount"] == 53 and first["reminderUnreadCount"] == 52
    assert first["inbox"][0]["type"] == "risk"  # None of this page qualifies.
    second = read(cursor=first["nextCursor"])
    assert second["reminderUnreadCount"] == 52 and second["inbox"][0]["type"] == "research"
    assert "reminderUnreadCount" not in read(version=None)
    assert read(version=None)["schema"] == "private-notifications-v1"

    event = owner.execute(
        "SELECT event_id FROM astarter_private.notification_inbox "
        "WHERE tenant_id=%s AND request_id='reminder-fixture-000'", (alice,),
    ).fetchone()["event_id"]
    marked = _invoke(live, "notifications/command", {
        "requestId": "reminder-mark-001", "baseRevision": 54, "action": "mark-read",
        "payload": {"ids": [event]},
    })
    assert marked["state"]["schema"] == "private-notifications-v1"
    assert "reminderUnreadCount" not in marked["state"]
    assert read()["reminderUnreadCount"] == 51 and read()["unreadCount"] == 52
    for revision, inapp, events, expected in (
        (55, False, ["research"], 0), (56, True, [], 0), (57, True, ["risk"], 1),
    ):
        _invoke(live, "notifications/command", {
            "requestId": f"reminder-pref-{revision:03}", "baseRevision": revision,
            "action": "save", "payload": {"events": events, "inapp": inapp,
                                           "enabled": {"telegram": False, "email": False}},
        })
        state = read()
        assert state["unreadCount"] == 52 and state["reminderUnreadCount"] == expected
        assert len(state["inbox"]) == 1
    bob = read(who="bob")
    assert bob["unreadCount"] == bob["reminderUnreadCount"] == 1
    assert bob["inbox"][0]["requestId"] == "reminder-fixture-bob"
    with pytest.raises(PrivateRPCError, match="PRIVATE_REQUEST_INVALID"):
        read(cursor=first["nextCursor"], who="bob")
    assert _invoke(live, "notifications/request", {"requestId": "reminder-pref-001"}) == original
    assert owner.execute("SELECT * FROM astarter_private.global_budget").fetchone() == before
    assert owner.execute(
        "SELECT count(*) AS n FROM astarter_private.notification_inbox"
    ).fetchone()["n"] == 54


@native
def test_native_reminder_preferences_and_count_share_one_read_snapshot(live, monkeypatch):
    _reminder_terminal(live, "reminder-snapshot-001")
    original, changed = psycopg.Connection.execute, False

    def interleaved(connection, query, *args, **kwargs):
        nonlocal changed
        result = original(connection, query, *args, **kwargs)
        if (not changed and connection.info.user == live["target"].runtime
                and isinstance(query, str)
                and query.startswith("SELECT * FROM astarter_private.notification_preferences")):
            changed = True
            live["owner"].execute(
                "UPDATE astarter_private.notification_preferences SET inapp=FALSE,revision=2 "
                "WHERE tenant_id=%s", (live["users"]["alice"]["subject"],),
            )
        return result

    payload = {"cursor": None, "limit": 20, "responseVersion": 2}
    with monkeypatch.context() as patcher:
        patcher.setattr(psycopg.Connection, "execute", interleaved)
        before = _invoke(live, "notifications/state", payload)
    assert changed and before["inapp"] is True and before["revision"] == 1
    assert before["unreadCount"] == before["reminderUnreadCount"] == 1
    after = _invoke(live, "notifications/state", payload)
    assert after["inapp"] is False and after["revision"] == 2
    assert after["unreadCount"] == 1 and after["reminderUnreadCount"] == 0


@native
def test_native_v2_does_not_shorten_the_same_v1_page_at_the_byte_boundary(live):
    owner, alice = live["owner"], live["users"]["alice"]["subject"]
    owner.execute(
        "UPDATE astarter_private.policies SET request_limit=20,token_limit=300000 "
        "WHERE tenant_id=%s", (alice,),
    )
    for number in range(14):
        _reminder_terminal(live, f"reminder-byte-{number:03}")
    owner.execute("UPDATE astarter_private.notification_inbox SET body='a'")
    payload = {"cursor": None, "limit": 20}
    small = _invoke(live, "notifications/state", payload)
    assert len(small["inbox"]) == 14 and small["nextCursor"] is None
    size = len(json.dumps(small, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=False).encode())
    remaining = 60000 - size + 14
    for index, item in enumerate(small["inbox"]):
        length = min(4800, remaining - (13 - index))
        assert 1 <= length <= 4800
        body = "😀" * (length // 4) + ("", "a", "é", "研")[length % 4]
        assert len(body.encode()) == length and len(body) <= 1200
        owner.execute(
            "UPDATE astarter_private.notification_inbox SET body=%s "
            "WHERE tenant_id=%s AND event_id=%s", (body, alice, item["id"]),
        )
        remaining -= length
    assert remaining == 0
    old = _invoke(live, "notifications/state", payload)
    assert len(old["inbox"]) == 14
    assert len(json.dumps(old, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=False).encode()) == 60000
    new = _invoke(live, "notifications/state", payload | {"responseVersion": 2})
    legacy_projection = {k: v for k, v in new.items() if k != "reminderUnreadCount"}
    legacy_projection["schema"] = "private-notifications-v1"
    assert legacy_projection == old
    assert new["reminderUnreadCount"] == 14
    from stark_trading_os.control.private_research_rpc import _response
    assert len(_response(200, result=new).body) <= 60 * 1024
