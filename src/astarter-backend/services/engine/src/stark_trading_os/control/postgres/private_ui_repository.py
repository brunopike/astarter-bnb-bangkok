"""PRIVATE notification/workspace metadata using the existing owned transaction pool."""

import base64
import json
import re
from hashlib import sha256
from typing import Any

import psycopg
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from stark_trading_os.control.astarter.strategy_repository import PersistenceConflict
from stark_trading_os.control.private_research_rpc import PrivateRPCError

from .access import AccessRejected
from .pool import PersistenceUnavailable, PgRepositoryPool
from .private_research_contracts import PrivateLease
from .private_research_repository import PrivateRuntimeRepository, _clock
from .private_ui_contracts import (
    EVENTS,
    UI_PERMISSIONS,
    CommandResult,
    MarkRead,
    NotificationCommand,
    NotificationPreferences,
    NotificationRead,
    NotificationState,
    NotificationStateV2,
    UIBinding,
    UIRequest,
    UIWrite,
    WorkspaceSave,
    WorkspaceState,
    ui_input,
)


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False)


def ui_lock_key(tenant: str, subject: str, domain: str) -> int:
    """The server research trigger uses exactly this owner/domain lock ordering."""
    return int.from_bytes(sha256(f"private-ui:{tenant}|{subject}|{domain}".encode()).digest()[:8],
                          signed=True)


def _owner_hash(owner: tuple[str, str]) -> str:
    return sha256(_json(list(owner)).encode()).hexdigest()


def _encode_cursor(owner: tuple[str, str], at: int, event: str) -> str:
    raw = _json(["private-notification-cursor-v1", _owner_hash(owner), at, event]).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(value: str, owner: tuple[str, str]) -> tuple[int, str]:
    try:
        raw = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
        data = json.loads(raw.decode("utf-8"))
        if (type(data) is not list or len(data) != 4
                or data[:2] != ["private-notification-cursor-v1", _owner_hash(owner)]
                or type(data[2]) is not int or not 0 <= data[2] <= 253402300799999
                or type(data[3]) is not str
                or re.fullmatch(r"[A-Za-z0-9:._-]{1,128}", data[3]) is None
                or _encode_cursor(owner, data[2], data[3]) != value):
            raise ValueError("PRIVATE_CURSOR")
        return data[2], data[3]
    except (ValueError, UnicodeError, RecursionError):
        raise PrivateRPCError("PRIVATE_REQUEST_INVALID") from None


class PrivateUIRepository:
    def __init__(self, pool: PgRepositoryPool, *, lease: PrivateLease) -> None:
        # Reuse the same cold configuration gate, exact native role/target and lease.
        self._runtime = PrivateRuntimeRepository(pool, lease=lease)
        self._pool, self._lease = pool, lease

    def _identity(
        self, connection: Connection[dict[str, Any]], digest: str, permission: str,
    ) -> tuple[tuple[str, str], int]:
        principal = self._runtime._principal(connection, digest)
        now = _clock(connection)
        if (principal["revokedAt"] is not None or principal["notBefore"] > now
                or principal["expiresAt"] <= now):
            raise PrivateRPCError("PRIVATE_AUTH_REQUIRED")
        if (type(principal.get("authVersion")) is not int or principal.get("authVersion") != 2
                or principal.get("permissionProfile") != "private-ui-v2"
                or tuple(principal["permissions"]) != UI_PERMISSIONS
                or permission not in principal["permissions"]
                or principal["scopeId"] != principal["tenantId"]
                or principal["audience"] != self._lease.audience):
            raise PrivateRPCError("PRIVATE_FORBIDDEN")
        self._runtime._actual_lease(connection, now)
        return (principal["tenantId"], principal["subjectId"]), now

    def invoke(self, operation: str, payload: dict[str, Any], session_digest: str | None) -> Any:
        if type(session_digest) is not str or re.fullmatch(r"[a-f0-9]{64}", session_digest) is None:
            raise PrivateRPCError("PRIVATE_AUTH_REQUIRED")
        try:
            data = ui_input(operation, payload)
            assert isinstance(data, UIBinding)
            serialized = _json(data.model_dump(by_alias=True))
            if len(serialized.encode()) > 16384:
                raise ValueError("PRIVATE_REQUEST_INVALID")
        except (ValueError, TypeError, UnicodeError, RecursionError):
            raise PrivateRPCError("PRIVATE_REQUEST_INVALID") from None
        if (data.lease_id, data.target_id, data.audience) != (
            self._lease.lease_id, self._lease.target_id, self._lease.audience,
        ):
            raise PrivateRPCError("PRIVATE_TARGET_MISMATCH")
        domain = operation.split("/", 1)[0]
        write = isinstance(data, UIWrite)
        permission = domain + (":write" if write else ":read")
        try:
            scope = "private-ui-runtime:" + session_digest
            with self._pool.transaction(write=write, scope_id=scope) as c:
                owner, now = self._identity(c, session_digest, permission)
                c.execute("SELECT set_config('astarter_private.session_digest',%s,TRUE)",
                          (session_digest,))
                if write:
                    c.execute("SELECT pg_advisory_xact_lock(%s)", (ui_lock_key(*owner, domain),))
                    refreshed, now = self._identity(c, session_digest, permission)
                    if refreshed != owner:
                        raise PrivateRPCError("PRIVATE_FORBIDDEN")
                    assert isinstance(data, UIWrite)
                    return self._write(c, data, domain, operation, serialized, owner, now,
                                       session_digest, permission)
                if operation.endswith("/request"):
                    assert isinstance(data, UIRequest)
                    row = self._command(c, owner, domain, data.request_id)
                    return (None if row is None else
                            self._original(row, owner, domain, data.request_id))
                if isinstance(data, NotificationRead):
                    return self._notices(c, owner, cursor=data.cursor, limit=data.limit,
                                         response_version=data.response_version)
                return self._workspace(c, owner)
        except PersistenceConflict:
            raise PrivateRPCError("PRIVATE_CONFLICT") from None
        except (PersistenceUnavailable, AccessRejected):
            raise PrivateRPCError("PRIVATE_UNAVAILABLE") from None

    @staticmethod
    def _command(c: Connection[dict[str, Any]], owner: tuple[str, str], domain: str,
                 request: str) -> dict[str, Any] | None:
        return c.execute(
            "SELECT * FROM astarter_private.ui_commands WHERE tenant_id=%s "
            "AND subject_id=%s AND domain=%s AND request_id=%s", (*owner, domain, request),
        ).fetchone()

    @staticmethod
    def _original(row: dict[str, Any], owner: tuple[str, str], domain: str,
                  request: str) -> dict[str, Any]:
        try:
            result = CommandResult.model_validate(row["original_result"])
            receipt = result.request
            if (result.state.scope != owner[0] or receipt.domain != domain
                    or receipt.request_id != request
                    or receipt.base_revision != row["base_revision"]
                    or receipt.revision != row["revision"]
                    or receipt.applied_at != row["applied_at_ms"]):
                raise ValueError("PRIVATE_UI_RECEIPT")
            value = result.model_dump(by_alias=True)
            if len(_json(value).encode()) > 65536:
                raise ValueError("PRIVATE_UI_RESULT_SIZE")
            return value
        except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
            raise PrivateRPCError("PRIVATE_UNAVAILABLE") from None

    @staticmethod
    def _notification_preferences(
        c: Connection[dict[str, Any]], owner: tuple[str, str],
    ) -> dict[str, Any]:
        row = c.execute(
            "SELECT * FROM astarter_private.notification_preferences "
            "WHERE tenant_id=%s AND subject_id=%s", owner,
        ).fetchone()
        return row if row is not None else {
            "revision": 0, "updated_at_ms": 0, "inapp": True, "events": list(EVENTS),
            "telegram_enabled": False, "email_enabled": False,
        }

    def _notices(self, c: Connection[dict[str, Any]], owner: tuple[str, str], *,
                 cursor: str | None = None, limit: int = 20,
                 response_version: int | None = None) -> dict[str, Any]:
        pref = self._notification_preferences(c, owner)
        if pref["telegram_enabled"] or pref["email_enabled"]:
            raise PrivateRPCError("PRIVATE_UNAVAILABLE")
        counts = "count(*) AS unread"
        count_params: tuple[Any, ...] = owner
        if response_version == 2:
            counts += ", count(*) FILTER (WHERE type=ANY(%s::TEXT[])) AS reminders"
            count_params = (pref["events"] if pref["inapp"] else [], *owner)
        unread = c.execute(
            "SELECT " + counts + " FROM astarter_private.notification_inbox "
            "WHERE tenant_id=%s AND subject_id=%s AND read_at_ms IS NULL", count_params,
        ).fetchone()
        assert unread is not None
        boundary = ""
        params: tuple[Any, ...] = (*owner, limit + 1)
        if cursor is not None:
            at, event = _decode_cursor(cursor, owner)
            boundary = " AND (created_at_ms,event_id)<(%s,%s)"
            params = (*owner, at, event, limit + 1)
        rows = c.execute(
            "SELECT event_id,request_id,type,title,body,created_at_ms,read_at_ms "
            "FROM astarter_private.notification_inbox WHERE tenant_id=%s AND subject_id=%s"
            + boundary + " ORDER BY created_at_ms DESC,event_id DESC LIMIT %s", params,
        ).fetchall()
        more, selected = len(rows) > limit, rows[:limit]
        items = [dict(id=r["event_id"], requestId=r["request_id"], type=r["type"], title=r["title"],
                      body=r["body"], source="server-research", createdAt=int(r["created_at_ms"]),
                      readAt=None if r["read_at_ms"] is None else int(r["read_at_ms"]),
                      executionAuthority="NONE") for r in selected]
        value = dict(schema="private-notifications-v1", scope=owner[0],
                     revision=int(pref["revision"]), updatedAt=int(pref["updated_at_ms"]),
                     inapp=pref["inapp"], events=pref["events"],
                     services={name: {"available": False, "error": "CHANNEL_DISABLED"}
                               for name in ("telegram", "email")},
                     channels={name: {"channel": name, "label": "", "enabled": 0, "verified": 0}
                               for name in ("telegram", "email")},
                     deliveries=[], inbox=items, unreadCount=int(unread["unread"]),
                     nextCursor=None, mode="server-research-only")
        # Bound UTF8 response bytes too; long Unicode bodies may shorten a legal page.
        while items and len(_json(value).encode()) > 60000:
            items.pop()
            more = True
        if more and items:
            value["nextCursor"] = _encode_cursor(owner, items[-1]["createdAt"], items[-1]["id"])
        # Keep the v1 page identical for immutable receipt reconciliation.
        if response_version == 2:
            value.update(schema="private-notifications-v2",
                         reminderUnreadCount=int(unread["reminders"]))
        try:
            model = NotificationStateV2 if response_version == 2 else NotificationState
            return model.model_validate(value).model_dump(by_alias=True)
        except ValidationError:
            raise PrivateRPCError("PRIVATE_UNAVAILABLE") from None

    @staticmethod
    def _workspace(c: Connection[dict[str, Any]], owner: tuple[str, str]) -> dict[str, Any]:
        row = c.execute(
            "SELECT * FROM astarter_private.workspace_preferences "
            "WHERE tenant_id=%s AND subject_id=%s", owner,
        ).fetchone()
        try:
            return WorkspaceState.model_validate({
                "schema": "private-workspace-v1", "scope": owner[0],
                "revision": 0 if row is None else int(row["revision"]),
                "updatedAt": 0 if row is None else int(row["updated_at_ms"]),
                "preferences": ({"workbenchFilter": "all", "workbenchFocusAsset": None,
                                 "watchedAssets": []} if row is None else row["preferences"]),
                "drafts": [] if row is None else row["drafts"],
                "selectedDraftId": None if row is None else row["selected_draft_id"],
                "executionAuthority": "NONE",
            }).model_dump(by_alias=True)
        except ValidationError:
            raise PrivateRPCError("PRIVATE_UNAVAILABLE") from None

    def _write(self, c: Connection[dict[str, Any]], data: UIWrite, domain: str, operation: str,
               serialized: str, owner: tuple[str, str], now: int, digest: str,
               permission: str) -> dict[str, Any]:
        fingerprint = sha256((operation + "\n" + serialized).encode()).hexdigest()
        previous = self._command(c, owner, domain, data.request_id)
        if previous is not None:
            if previous["fingerprint"] != fingerprint:
                raise PrivateRPCError("PRIVATE_CONFLICT")
            return self._original(previous, owner, domain, data.request_id)
        if isinstance(data, WorkspaceSave):
            fields = data.model_dump(
                by_alias=True, include={"preferences", "drafts", "selected_draft_id"},
            )
            state = self._save_workspace(c, owner, fields, data.base_revision, now)
        else:
            assert isinstance(data, NotificationCommand)
            pref = self._notification_preferences(c, owner)
            self._revision(int(pref["revision"]), data.base_revision)
            changed = False
            if isinstance(data.payload, NotificationPreferences):
                if data.payload.enabled.telegram or data.payload.enabled.email:
                    raise PrivateRPCError("PRIVATE_UNAVAILABLE")
                changed = (pref["inapp"] != data.payload.inapp
                           or pref["events"] != data.payload.events)
                pref = {**pref, "inapp": data.payload.inapp, "events": data.payload.events}
            else:
                assert isinstance(data.payload, MarkRead)
                rows = c.execute(
                    "SELECT event_id,read_at_ms FROM astarter_private.notification_inbox "
                    "WHERE tenant_id=%s AND subject_id=%s AND event_id=ANY(%s) FOR UPDATE",
                    (*owner, data.payload.ids),
                ).fetchall()
                if len(rows) != len(data.payload.ids):
                    raise PrivateRPCError("PRIVATE_FORBIDDEN")
                changed = any(row["read_at_ms"] is None for row in rows)
                if changed:
                    c.execute(
                        "UPDATE astarter_private.notification_inbox SET read_at_ms=%s "
                        "WHERE tenant_id=%s AND subject_id=%s AND event_id=ANY(%s) "
                        "AND read_at_ms IS NULL",
                        (now, *owner, data.payload.ids),
                    )
            if changed:
                row = c.execute(
                    "INSERT INTO astarter_private.notification_preferences(tenant_id,subject_id,"
                    "revision,updated_at_ms,inapp,events,telegram_enabled,email_enabled) "
                    "VALUES(%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(tenant_id,subject_id) "
                    "DO UPDATE SET revision=EXCLUDED.revision,updated_at_ms=EXCLUDED.updated_at_ms,"
                    "inapp=EXCLUDED.inapp,events=EXCLUDED.events,telegram_enabled=EXCLUDED.telegram_enabled,"
                    "email_enabled=EXCLUDED.email_enabled "
                    "WHERE notification_preferences.revision=%s "
                    "RETURNING revision",
                    (*owner, data.base_revision + 1, now, pref["inapp"], pref["events"],
                     False, False, data.base_revision),
                ).fetchone()
                if row is None:
                    raise PrivateRPCError("PRIVATE_CONFLICT")
            state = self._notices(c, owner)
        confirmed, applied = self._identity(c, digest, permission)
        if confirmed != owner:
            raise PrivateRPCError("PRIVATE_FORBIDDEN")
        result = CommandResult.model_validate({
            "request": {"schema": "private-ui-command-v1", "domain": domain,
                        "requestId": data.request_id, "status": "applied",
                        "baseRevision": data.base_revision, "revision": state["revision"],
                        "appliedAt": applied},
            "state": state,
        }).model_dump(by_alias=True)
        c.execute(
            "INSERT INTO astarter_private.ui_commands(tenant_id,subject_id,domain,request_id,"
            "fingerprint,base_revision,revision,applied_at_ms,original_result) "
            "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (*owner, domain, data.request_id, fingerprint, data.base_revision,
             state["revision"], applied, Jsonb(result)),
        )
        return result

    @staticmethod
    def _revision(actual: int, expected: int) -> None:
        if actual != expected:
            raise PrivateRPCError("PRIVATE_CONFLICT")

    @classmethod
    def _save_workspace(cls, c: Connection[dict[str, Any]], owner: tuple[str, str],
                        fields: dict[str, Any], expected: int, now: int) -> dict[str, Any]:
        """Shared CAS; callers already hold the owner workspace transaction lock."""
        state = cls._workspace(c, owner)
        cls._revision(state["revision"], expected)
        if any(state[k] != v for k, v in fields.items()):
            try:
                row = c.execute(
                    "INSERT INTO astarter_private.workspace_preferences(tenant_id,subject_id,"
                    "revision,updated_at_ms,preferences,drafts,selected_draft_id) "
                    "VALUES(%s,%s,%s,%s,%s,%s,%s) "
                    "ON CONFLICT(tenant_id,subject_id) DO UPDATE SET revision=EXCLUDED.revision,"
                    "updated_at_ms=EXCLUDED.updated_at_ms,preferences=EXCLUDED.preferences,"
                    "drafts=EXCLUDED.drafts,selected_draft_id=EXCLUDED.selected_draft_id "
                    "WHERE workspace_preferences.revision=%s RETURNING revision",
                    (*owner, expected + 1, now, Jsonb(fields["preferences"]),
                     Jsonb(fields["drafts"]), fields["selectedDraftId"], expected),
                ).fetchone()
            except psycopg.Error as error:
                if error.diag.message_primary == "PRIVATE_DRAFT_METADATA_CONFLICT":
                    raise PrivateRPCError("PRIVATE_CONFLICT") from None
                raise
            if row is None:
                raise PrivateRPCError("PRIVATE_CONFLICT")
        return cls._workspace(c, owner)
