"""Offline transaction/identity probes; native RLS integration belongs to the owner."""

import copy
import importlib
import importlib.util
import json
from contextlib import contextmanager

import pytest
from pydantic import ValidationError

from stark_trading_os.control.postgres.access import RepositoryAccessContract
from stark_trading_os.control.postgres.pool import CommitUnknown, PgRepositoryPool
from stark_trading_os.control.postgres.private_research_contracts import PrivateLease
from stark_trading_os.control.postgres.private_research_repository import PrivateRuntimeRepository
from stark_trading_os.control.private_research_rpc import PrivateRPCError
from tests.unit.control.postgres.test_private_research_pool import target
from tests.unit.control.postgres.test_private_ui_contracts import BINDING, workspace

MODULE = "stark_trading_os.control.postgres.private_ui_repository"
DIGEST = "a" * 64
PERMISSIONS = ["research:analyze", "notifications:read", "notifications:write",
               "workspace:read", "workspace:write"]


def test_private_ui_repository_exists():
    assert importlib.util.find_spec(MODULE) is not None, "PRIVATE UI repository missing"


class Rows:
    def __init__(self, rows=()):
        self.rows = list(rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class Memory:
    def __init__(self):
        self.now = 1000
        self.subject = "alice"
        self.version = 2
        self.permissions = PERMISSIONS.copy()
        self.revoked = False
        self.expires = 10000
        self.lease_expires = 20000
        self.data = {"workspace": {}, "notification": {}, "inbox": {}, "commands": {}}
        self.sql = []
        self.on_lock = None
        self.unknown = False

    @contextmanager
    def transaction(self, *, write=False, scope_id=""):
        before = copy.deepcopy(self.data)
        try:
            yield self
        except BaseException:
            self.data = before
            raise
        if self.unknown and write:
            raise CommitUnknown("fixture committed, acknowledgement lost")

    def principal(self, connection, digest):
        if self.revoked:
            raise PrivateRPCError("PRIVATE_AUTH_REQUIRED")
        assert digest == DIGEST
        return {
            "subjectId": self.subject, "tenantId": self.subject, "scopeId": self.subject,
            "audience": "astarter-research", "expiresAt": self.expires,
            "notBefore": 0, "revokedAt": None, "authVersion": self.version,
            "permissionProfile": "private-ui-v2", "permissions": self.permissions,
        }

    def actual_lease(self, instance, connection, now):
        if now >= self.lease_expires:
            raise PrivateRPCError("PRIVATE_TARGET_MISMATCH")
        return instance._lease.model_dump(by_alias=True)

    def execute(self, statement, params=(), **kwargs):
        self.sql.append((statement, params))
        q = " ".join(statement.split())
        if q.startswith("SELECT floor(extract"):
            return Rows([{"now_ms": self.now}])
        if "pg_advisory_xact_lock" in q:
            if self.on_lock:
                self.on_lock()
            return Rows()
        if "set_config(" in q:
            assert params == (DIGEST,)
            return Rows()
        if q.startswith("SELECT * FROM astarter_private.ui_commands"):
            row = self.data["commands"].get(tuple(params))
            return Rows([row] if row else [])
        if q.startswith("INSERT INTO astarter_private.ui_commands"):
            t, s, domain, request, fingerprint, base, revision, now, result = params
            key = (t, s, domain, request)
            assert key not in self.data["commands"]
            self.data["commands"][key] = {
                "fingerprint": fingerprint, "base_revision": base, "revision": revision,
                "applied_at_ms": now, "original_result": copy.deepcopy(result.obj),
            }
            return Rows()
        if q.startswith("SELECT * FROM astarter_private.workspace_preferences"):
            row = self.data["workspace"].get(tuple(params))
            return Rows([row] if row else [])
        if q.startswith("INSERT INTO astarter_private.workspace_preferences"):
            t, s, revision, now, preferences, drafts, selected, base = params
            previous = self.data["workspace"].get((t, s))
            if previous and previous["revision"] != base:
                return Rows()
            row = {"revision": revision, "updated_at_ms": now, "preferences": preferences.obj,
                   "drafts": drafts.obj, "selected_draft_id": selected}
            self.data["workspace"][(t, s)] = copy.deepcopy(row)
            return Rows([row])
        if q.startswith("SELECT * FROM astarter_private.notification_preferences"):
            row = self.data["notification"].get(tuple(params))
            return Rows([row] if row else [])
        if q.startswith("INSERT INTO astarter_private.notification_preferences"):
            t, s, revision, now, inapp, events, telegram, email, base = params
            old = self.data["notification"].get((t, s))
            if old and old["revision"] != base:
                return Rows()
            row = {"revision": revision, "updated_at_ms": now, "inapp": inapp,
                   "events": events, "telegram_enabled": telegram, "email_enabled": email}
            self.data["notification"][(t, s)] = row
            return Rows([row])
        if "FROM astarter_private.notification_inbox" in q:
            t, s, *remaining = params
            rows = [v for (tenant, subject, _), v in self.data["inbox"].items()
                    if (tenant, subject) == (t, s)]
            if "count(*)" in q:
                return Rows([{"unread": sum(r["read_at_ms"] is None for r in rows)}])
            if "event_id=ANY" in q:
                return Rows([r for r in rows if r["event_id"] in remaining[0]])
            rows.sort(key=lambda r: (r["created_at_ms"], r["event_id"]), reverse=True)
            if len(remaining) == 3:
                at, event, maximum = remaining
                rows = [r for r in rows if (r["created_at_ms"], r["event_id"]) < (at, event)]
            else:
                maximum = remaining[0]
            return Rows(rows[:maximum])
        if q.startswith("UPDATE astarter_private.notification_inbox"):
            now, t, s, ids = params
            for (tenant, subject, key), row in self.data["inbox"].items():
                if (tenant, subject) == (t, s) and key in ids and row["read_at_ms"] is None:
                    row["read_at_ms"] = now
            return Rows()
        raise AssertionError("unexpected SQL: " + q)


@pytest.fixture
def runtime(monkeypatch):
    assert importlib.util.find_spec(MODULE) is not None, "PRIVATE UI repository missing"
    module = importlib.import_module(MODULE)
    memory = Memory()
    pool = object.__new__(PgRepositoryPool)
    pool.access_contract = RepositoryAccessContract.PRIVATE_RESEARCH_V1
    pool.private_role, pool.writable, pool.private_target = "runtime", True, target()
    pool.transaction = memory.transaction
    configured = PrivateLease(
        **BINDING, database="private_fixture", schema="astarter_private",
        runtimeRole="private_runtime", budgetId="policy", model="openai/gpt-4.1-mini",
        expiresAt=20000,
    )
    monkeypatch.setattr(PrivateRuntimeRepository, "_principal", staticmethod(memory.principal))
    monkeypatch.setattr(
        PrivateRuntimeRepository, "_actual_lease",
        lambda instance, connection, now: memory.actual_lease(instance, connection, now),
    )
    return module.PrivateUIRepository(pool, lease=configured), memory


def invoke(runtime, operation, payload):
    return runtime[0].invoke(operation, payload, DIGEST)


def test_get_defaults_is_read_only(runtime):
    result = invoke(runtime, "workspace/state", BINDING)
    assert result["revision"] == 0 and result["drafts"] == []
    notice = invoke(runtime, "notifications/state", {**BINDING, "cursor": None, "limit": 20})
    assert notice["unreadCount"] == 0 and notice["deliveries"] == []
    assert not any("INSERT" in sql or "UPDATE" in sql for sql, _ in runtime[1].sql)


@pytest.mark.parametrize("change,code", [
    ({"version": 1}, "PRIVATE_FORBIDDEN"),
    ({"permissions": ["research:analyze"]}, "PRIVATE_FORBIDDEN"),
    ({"revoked": True}, "PRIVATE_AUTH_REQUIRED"),
    ({"expires": 999}, "PRIVATE_AUTH_REQUIRED"),
])
def test_identity_rejection_precedes_ui_data(runtime, change, code):
    for name, value in change.items():
        setattr(runtime[1], name, value)
    with pytest.raises(PrivateRPCError, match=code):
        invoke(runtime, "workspace/state", BINDING)
    assert not any("workspace_preferences" in sql for sql, _ in runtime[1].sql)


@pytest.mark.parametrize("change,code", [
    ({"version": 1}, "PRIVATE_FORBIDDEN"),
    ({"permissions": ["research:analyze"]}, "PRIVATE_FORBIDDEN"),
    ({"revoked": True}, "PRIVATE_AUTH_REQUIRED"),
    ({"expires": 999}, "PRIVATE_AUTH_REQUIRED"),
])
def test_v2_reminder_identity_rejection_precedes_counts(runtime, change, code):
    for name, value in change.items():
        setattr(runtime[1], name, value)
    with pytest.raises(PrivateRPCError, match=code):
        invoke(runtime, "notifications/state", {
            **BINDING, "cursor": None, "limit": 20, "responseVersion": 2,
        })
    assert not any("notification_" in sql for sql, _ in runtime[1].sql)


def test_cas_idempotency_original_and_owner_isolation(runtime):
    first = invoke(runtime, "workspace/save", workspace())
    assert first["request"]["revision"] == 1
    assert invoke(runtime, "workspace/save", workspace()) == first
    with pytest.raises(PrivateRPCError, match="PRIVATE_CONFLICT"):
        invoke(runtime, "workspace/save", workspace(selectedDraftId=None))
    with pytest.raises(PrivateRPCError, match="PRIVATE_CONFLICT"):
        invoke(runtime, "workspace/save", workspace(requestId="workspace-2"))
    assert invoke(runtime, "workspace/request", {**BINDING, "requestId": "workspace-1"}) == first
    runtime[1].subject = "bob"
    assert invoke(runtime, "workspace/request", {**BINDING, "requestId": "workspace-1"}) is None
    assert invoke(runtime, "workspace/state", BINDING)["drafts"] == []


@pytest.mark.parametrize("change,code", [
    ({"revoked": True}, "PRIVATE_AUTH_REQUIRED"),
    ({"now": 10001}, "PRIVATE_AUTH_REQUIRED"),
    ({"lease_expires": 999}, "PRIVATE_TARGET_MISMATCH"),
])
def test_waiting_on_owner_lock_rechecks_identity_and_clock(runtime, change, code):
    runtime[1].on_lock = lambda: [setattr(runtime[1], k, v) for k, v in change.items()]
    with pytest.raises(PrivateRPCError, match=code):
        invoke(runtime, "workspace/save", workspace())
    assert runtime[1].data["commands"] == {} and runtime[1].data["workspace"] == {}


def test_commit_unknown_is_not_replayed_or_refunded(runtime):
    runtime[1].unknown = True
    with pytest.raises(CommitUnknown):
        invoke(runtime, "workspace/save", workspace())
    runtime[1].unknown = False
    result = invoke(runtime, "workspace/request", {**BINDING, "requestId": "workspace-1"})
    assert result["request"]["status"] == "applied"
    assert len(runtime[1].data["commands"]) == 1


def test_unavailable_channels_are_not_saved(runtime):
    with pytest.raises(PrivateRPCError, match="PRIVATE_UNAVAILABLE"):
        invoke(runtime, "notifications/command", {
            **BINDING, "requestId": "notice-01", "baseRevision": 0, "action": "save",
            "payload": {"events": ["research"], "inapp": True,
                        "enabled": {"telegram": True, "email": False}},
        })
    assert runtime[1].data["notification"] == {} and runtime[1].data["commands"] == {}


def inbox(memory, subject, event):
    memory.data["inbox"][(subject, subject, event)] = {
        "event_id": event, "request_id": "research-01", "terminal_state": "complete",
        "type": "research", "title": "Research complete", "body": "Open the research task.",
        "created_at_ms": 500, "read_at_ms": None,
    }


def test_inbox_get_preserves_read_state_and_mark_read_is_atomic(runtime):
    inbox(runtime[1], "alice", "event-1")
    inbox(runtime[1], "bob", "event-2")
    read = {**BINDING, "cursor": None, "limit": 1}
    state = invoke(runtime, "notifications/state", read)
    assert state["unreadCount"] == 1 and state["inbox"][0]["readAt"] is None
    command = {**BINDING, "requestId": "notice-01", "baseRevision": 0,
               "action": "mark-read", "payload": {"ids": ["event-1", "event-2"]}}
    with pytest.raises(PrivateRPCError, match="PRIVATE_FORBIDDEN"):
        invoke(runtime, "notifications/command", command)
    assert invoke(runtime, "notifications/state", read)["unreadCount"] == 1
    command["payload"]["ids"] = ["event-1"]
    state = invoke(runtime, "notifications/command", command)["state"]
    assert state["unreadCount"] == 0 and state["inbox"][0]["readAt"] == 1000
    assert not any("INSERT INTO astarter_private.notification_inbox" in sql
                   for sql, _ in runtime[1].sql)


def test_cursor_cannot_cross_owner(runtime):
    inbox(runtime[1], "alice", "event-1")
    inbox(runtime[1], "alice", "event-2")
    state = invoke(runtime, "notifications/state", {**BINDING, "cursor": None, "limit": 1})
    assert state["nextCursor"] is not None
    second = invoke(runtime, "notifications/state", {
        **BINDING, "cursor": state["nextCursor"], "limit": 1,
    })
    assert second["inbox"][0]["id"] != state["inbox"][0]["id"]
    runtime[1].subject = "bob"
    with pytest.raises(PrivateRPCError, match="PRIVATE_REQUEST_INVALID"):
        invoke(runtime, "notifications/state", {
            **BINDING, "cursor": state["nextCursor"], "limit": 1,
        })


@pytest.mark.parametrize("operation,payload,digest,code", [
    ("workspace/state", {**BINDING, "subjectId": "other"}, DIGEST, "PRIVATE_REQUEST_INVALID"),
    ("workspace/state", {**BINDING, "targetId": "other"}, DIGEST, "PRIVATE_TARGET_MISMATCH"),
    ("workspace/state", BINDING, None, "PRIVATE_AUTH_REQUIRED"),
    ("workspace/state", BINDING, "bad", "PRIVATE_AUTH_REQUIRED"),
    ("research/claim", BINDING, DIGEST, "PRIVATE_REQUEST_INVALID"),
])
def test_invalid_requests_have_no_pool_io(runtime, operation, payload, digest, code):
    with pytest.raises(PrivateRPCError, match=code):
        runtime[0].invoke(operation, payload, digest)
    assert runtime[1].sql == []


def test_expiry_after_data_write_rolls_back_everything(runtime, monkeypatch):
    original = runtime[0]._identity
    calls = 0

    def delayed(*args):
        nonlocal calls
        calls += 1
        if calls == 3:
            runtime[1].now = 10001
        return original(*args)

    monkeypatch.setattr(runtime[0], "_identity", delayed)
    with pytest.raises(PrivateRPCError, match="PRIVATE_AUTH_REQUIRED"):
        invoke(runtime, "workspace/save", workspace())
    assert any("INSERT INTO astarter_private.workspace_preferences" in sql
               for sql, _ in runtime[1].sql)
    assert runtime[1].data["workspace"] == {} and runtime[1].data["commands"] == {}


def test_same_id_returns_original_snapshot_after_later_save(runtime):
    first = invoke(runtime, "workspace/save", workspace())
    second = invoke(runtime, "workspace/save", workspace(
        requestId="workspace-2", baseRevision=1, selectedDraftId=None,
    ))
    assert second["state"]["revision"] == 2
    assert invoke(runtime, "workspace/save", workspace()) == first
    assert invoke(runtime, "workspace/state", BINDING)["revision"] == 2


def test_noop_is_durable_without_false_revision(runtime):
    result = invoke(runtime, "workspace/save", workspace(
        preferences={"workbenchFilter": "all", "workbenchFocusAsset": None,
                     "watchedAssets": []}, drafts=[], selectedDraftId=None,
    ))
    assert result["request"]["revision"] == 0
    assert runtime[1].data["workspace"] == {} and len(runtime[1].data["commands"]) == 1


def test_notification_save_and_replay(runtime):
    command = {**BINDING, "requestId": "notice-01", "baseRevision": 0,
               "action": "save", "payload": {"events": ["research"], "inapp": False,
                                              "enabled": {"telegram": False, "email": False}}}
    result = invoke(runtime, "notifications/command", command)
    assert result["state"]["inapp"] is False and result["state"]["revision"] == 1
    assert invoke(runtime, "notifications/command", command) == result


def test_unicode_pagination_is_byte_bounded_and_complete(runtime):
    for number in range(60):
        event = f"event-{number:03}"
        inbox(runtime[1], "alice", event)
        runtime[1].data["inbox"][("alice", "alice", event)]["body"] = "研" * 1200
    cursor, seen = None, []
    while True:
        state = invoke(runtime, "notifications/state", {**BINDING, "cursor": cursor, "limit": 50})
        assert len(json.dumps(state, ensure_ascii=False).encode()) < 62000
        assert state["unreadCount"] == 60
        seen.extend(row["id"] for row in state["inbox"])
        cursor = state["nextCursor"]
        if cursor is None:
            break
    assert len(seen) == len(set(seen)) == 60


def test_cold_wrong_pool_has_no_io():
    module = importlib.import_module(MODULE)
    with pytest.raises(ValueError, match="PRIVATE_RUNTIME_CONFIGURATION"):
        module.PrivateUIRepository(None, lease=None)


@pytest.mark.parametrize("field", ["draft-id", "legacy-watch", "coin-watch", "request-id"])
def test_credentials_cannot_enter_state_or_idempotency_receipt(runtime, field):
    synthetic = "sk-or-v1-" + "synthetic_only_" * 3
    data = workspace()
    if field == "draft-id":
        data["drafts"][0]["id"] = synthetic
        data["selectedDraftId"] = synthetic
    elif field == "request-id":
        data["requestId"] = synthetic
    else:
        data["preferences"]["watchedAssets"] = [
            synthetic if field == "legacy-watch" else "coin:" + synthetic,
        ]
    with pytest.raises(PrivateRPCError, match="PRIVATE_REQUEST_INVALID"):
        invoke(runtime, "workspace/save", data)
    assert runtime[1].sql == []
    assert runtime[1].data["commands"] == {} and runtime[1].data["workspace"] == {}


def test_default_chinese_page_and_mutation_fit_actual_rpc_envelope(runtime):
    from stark_trading_os.control.private_research_rpc import _response

    ids = [f"event-{number:03}" for number in range(20)]
    for event in ids:
        inbox(runtime[1], "alice", event)
        row = runtime[1].data["inbox"][("alice", "alice", event)]
        row["title"], row["body"] = "研" * 160, "研" * 1200
    state = invoke(runtime, "notifications/state", {**BINDING, "cursor": None, "limit": 20})
    assert 0 < len(state["inbox"]) < 20 and state["nextCursor"] is not None
    assert len(_response(200, result=state).body) <= 60 * 1024
    result = invoke(runtime, "notifications/command", {
        **BINDING, "requestId": "mark-read-20", "baseRevision": 0,
        "action": "mark-read", "payload": {"ids": ids},
    })
    assert result["state"]["unreadCount"] == 0
    assert len(_response(200, result=result).body) <= 60 * 1024
    assert len(result["state"]["inbox"]) < 20 and result["state"]["nextCursor"] is not None


def test_reminder_v2_response_does_not_widen_legacy_state_or_command_codec(runtime):
    from stark_trading_os.control.postgres.private_ui_contracts import (
        CommandResult,
        NotificationState,
        NotificationStateV2,
    )

    old = invoke(runtime, "notifications/state", {**BINDING, "cursor": None, "limit": 20})
    value = old | {"schema": "private-notifications-v2", "unreadCount": 7,
                   "reminderUnreadCount": 3}
    assert NotificationStateV2.model_validate(value).reminder_unread_count == 3
    with pytest.raises(ValidationError):
        NotificationState.model_validate(value)
    for change in ({"reminderUnreadCount": True}, {"reminderUnreadCount": -1},
                   {"reminderUnreadCount": 8}, {"inapp": False}, {"events": []},
                   {"schema": "private-notifications-v1"}):
        with pytest.raises(ValidationError):
            NotificationStateV2.model_validate(value | change)
    for change in ({"inapp": False}, {"events": []}):
        assert NotificationStateV2.model_validate(
            value | change | {"reminderUnreadCount": 0},
        ).reminder_unread_count == 0
    with pytest.raises(ValidationError):
        CommandResult.model_validate({
            "request": {"schema": "private-ui-command-v1", "domain": "notifications",
                        "requestId": "reminder-cmd-001", "status": "applied",
                        "baseRevision": 0, "revision": 0, "appliedAt": 1000},
            "state": value,
        })
