"""PRIVATE report-to-draft writes share the existing owner workspace transaction."""

import re
from typing import Any

import psycopg
from psycopg import Connection
from psycopg.types.json import Jsonb

from stark_trading_os.control.astarter.strategy_repository import PersistenceConflict
from stark_trading_os.control.private_research_rpc import PrivateRPCError

from .access import AccessRejected
from .pool import PersistenceUnavailable, PgRepositoryPool
from .private_draft_contracts import (
    CATALOG_VERSION,
    DraftAdopt,
    DraftCommandResult,
    DraftContent,
    DraftDocument,
    DraftPreview,
    DraftPreviewResult,
    DraftRead,
    canonical,
    changed_groups,
    digest,
    draft_input,
    missing_fields,
    report_source,
)
from .private_research_contracts import PrivateLease
from .private_ui_contracts import UIRequest, WorkspaceFields
from .private_ui_repository import PrivateUIRepository, ui_lock_key


class PrivateDraftRepository:
    def __init__(self, pool: PgRepositoryPool, *, lease: PrivateLease) -> None:
        self._ui = PrivateUIRepository(pool, lease=lease)
        if pool.private_target is None or pool.private_target.schema_version != 3:
            raise ValueError("PRIVATE_DRAFT_CONFIGURATION")
        self._pool, self._lease = pool, lease

    def invoke(self, operation: str, payload: dict[str, Any], session_digest: str | None) -> Any:
        if type(session_digest) is not str or re.fullmatch(r"[a-f0-9]{64}", session_digest) is None:
            raise PrivateRPCError("PRIVATE_AUTH_REQUIRED")
        try:
            data = draft_input(operation, payload)
            serialized = data.model_dump(by_alias=True)
            if len(canonical(serialized).encode()) > 16384:
                raise ValueError()
        except (ValueError, TypeError, UnicodeError, RecursionError):
            raise PrivateRPCError("PRIVATE_REQUEST_INVALID") from None
        if (data.lease_id, data.target_id, data.audience) != (
            self._lease.lease_id,
            self._lease.target_id,
            self._lease.audience,
        ):
            raise PrivateRPCError("PRIVATE_TARGET_MISMATCH")
        write = isinstance(data, DraftAdopt)
        permission = "workspace:write" if write else "workspace:read"
        try:
            with self._pool.transaction(
                write=write, scope_id="private-draft:" + session_digest
            ) as c:
                owner, now = self._ui._identity(c, session_digest, permission)
                c.execute(
                    "SELECT set_config('astarter_private.session_digest',%s,TRUE)",
                    (session_digest,),
                )
                if isinstance(data, DraftAdopt):
                    c.execute(
                        "SELECT pg_advisory_xact_lock(%s)", (ui_lock_key(*owner, "workspace"),)
                    )
                    confirmed, now = self._ui._identity(c, session_digest, permission)
                    if confirmed != owner:
                        raise PrivateRPCError("PRIVATE_FORBIDDEN")
                    fingerprint = digest({"operation": operation, "payload": serialized})
                    previous = self._command(c, owner, data.request_id)
                    if previous is not None:
                        if previous["fingerprint"] != fingerprint:
                            raise PrivateRPCError("PRIVATE_CONFLICT")
                        return self._original(previous, owner)
                    return self._adopt(c, data, owner, now, fingerprint, session_digest)
                if isinstance(data, UIRequest):
                    row = self._command(c, owner, data.request_id)
                    return None if row is None else self._original(row, owner)
                if isinstance(data, DraftPreview):
                    return self._preview(c, data, owner, now).model_dump(by_alias=True)
                assert isinstance(data, DraftRead)
                return self._current(c, owner, data.draft_id)
        except PersistenceConflict:
            raise PrivateRPCError("PRIVATE_CONFLICT") from None
        except (PersistenceUnavailable, AccessRejected):
            raise PrivateRPCError("PRIVATE_UNAVAILABLE") from None
        except psycopg.Error as error:
            if error.diag.message_primary in (
                "PRIVATE_DRAFT_HEAD_CONFLICT",
                "PRIVATE_DRAFT_METADATA_CONFLICT",
            ):
                raise PrivateRPCError("PRIVATE_CONFLICT") from None
            raise PrivateRPCError("PRIVATE_UNAVAILABLE") from None

    @staticmethod
    def _document(row: dict[str, Any], owner: tuple[str, str]) -> dict[str, Any]:
        try:
            if (row["tenant_id"], row["subject_id"]) != owner:
                raise ValueError()
            value = DraftDocument.model_validate(
                {
                    "schema": "private-strategy-draft-v1",
                    "scope": owner[0],
                    "draftId": row["draft_id"],
                    "revision": int(row["revision"]),
                    "savedAt": int(row["saved_at_ms"]),
                    "content": row["content"],
                }
            ).model_dump(by_alias=True)
            if (
                len(canonical(value).encode()) > 40000
                or value["content"]["source"]["sourceRequestId"] != row["source_request_id"]
            ):
                raise ValueError()
            return value
        except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
            raise PrivateRPCError("PRIVATE_UNAVAILABLE") from None

    @classmethod
    def _current(
        cls, c: Connection[dict[str, Any]], owner: tuple[str, str], draft: str
    ) -> dict[str, Any] | None:
        row = c.execute(
            "SELECT v.* FROM astarter_private.draft_versions v "
            "JOIN astarter_private.draft_heads h USING(tenant_id,subject_id,draft_id,revision) "
            "WHERE v.tenant_id=%s AND v.subject_id=%s AND v.draft_id=%s",
            (*owner, draft),
        ).fetchone()
        return None if row is None else cls._document(row, owner)

    @staticmethod
    def _command(
        c: Connection[dict[str, Any]], owner: tuple[str, str], request: str
    ) -> dict[str, Any] | None:
        return c.execute(
            "SELECT r.*,v.source_request_id,v.saved_at_ms,v.content "
            "FROM astarter_private.draft_commands r JOIN astarter_private.draft_versions v "
            "USING(tenant_id,subject_id,draft_id,revision) "
            "WHERE r.tenant_id=%s AND r.subject_id=%s AND r.request_id=%s",
            (*owner, request),
        ).fetchone()

    @classmethod
    def _original(cls, row: dict[str, Any], owner: tuple[str, str]) -> dict[str, Any]:
        try:
            return DraftCommandResult.model_validate(
                {
                    "schema": "private-draft-command-v1",
                    "scope": owner[0],
                    "request": {
                        "requestId": row["request_id"],
                        "draftId": row["draft_id"],
                        "status": "applied",
                        "expectedRevision": int(row["expected_revision"]),
                        "revision": int(row["revision"]),
                        "workspaceBaseRevision": int(row["workspace_base_revision"]),
                        "workspaceRevision": int(row["workspace_revision"]),
                        "appliedAt": int(row["applied_at_ms"]),
                    },
                    "draft": cls._document(row, owner),
                }
            ).model_dump(by_alias=True)
        except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
            raise PrivateRPCError("PRIVATE_UNAVAILABLE") from None

    def _preview(
        self, c: Connection[dict[str, Any]], data: DraftPreview, owner: tuple[str, str], now: int
    ) -> DraftPreviewResult:
        row = c.execute(
            "SELECT tenant_id,subject_id,request_id,fingerprint,lease_id,state,result,error_code,"
            "created_at_ms::bigint,finished_at_ms::bigint FROM astarter_private.requests "
            "WHERE tenant_id=%s AND subject_id=%s AND request_id=%s",
            (*owner, data.source_request_id),
        ).fetchone()
        try:
            if row is None:
                raise ValueError()
            source = report_source(
                row, owner=owner, lease_id=self._lease.lease_id, market=data.fields.market, now=now
            )
        except ValueError:
            # Missing, foreign, incomplete and expired sources have one non-oracular error.
            raise PrivateRPCError("PRIVATE_REQUEST_INVALID") from None
        proposal = DraftContent.model_validate(
            {
                "catalogVersion": CATALOG_VERSION,
                "templateVersion": data.fields.plan_variant + "@paper-v1",
                "parameterOrigin": "user-confirmed",
                "source": source.model_dump(by_alias=True),
                "fields": data.fields.model_dump(by_alias=True),
                "missingFields": missing_fields(data.fields),
                "executionAuthority": "NONE",
            }
        )
        current = self._current(c, owner, data.draft_id)
        workspace = self._ui._workspace(c, owner)
        revision = 0 if current is None else current["revision"]
        content = proposal.model_dump(by_alias=True)
        changed = changed_groups(
            None if current is None else DraftContent.model_validate(current["content"]), proposal
        )
        binding = {
            "owner": list(owner),
            "leaseId": data.lease_id,
            "targetId": data.target_id,
            "audience": data.audience,
            "draftId": data.draft_id,
            "expectedRevision": revision,
            "workspaceRevision": workspace["revision"],
            "proposal": content,
        }
        return DraftPreviewResult.model_validate(
            {
                "schema": "private-draft-preview-v1",
                "scope": owner[0],
                "draftId": data.draft_id,
                "expectedRevision": revision,
                "workspaceRevision": workspace["revision"],
                "proposalRevision": digest(binding),
                "current": current,
                "proposal": content,
                "listed": any(item["id"] == data.draft_id for item in workspace["drafts"]),
                "changedFields": changed,
            }
        )

    def _adopt(
        self,
        c: Connection[dict[str, Any]],
        data: DraftAdopt,
        owner: tuple[str, str],
        now: int,
        fingerprint: str,
        session_digest: str,
    ) -> dict[str, Any]:
        preview = self._preview(c, data, owner, now)
        if (preview.expected_revision, preview.workspace_revision, preview.proposal_revision) != (
            data.expected_revision,
            data.workspace_revision,
            data.proposal_revision,
        ):
            raise PrivateRPCError("PRIVATE_CONFLICT")
        workspace = self._ui._workspace(c, owner)
        metadata = {
            "id": data.draft_id,
            "strategyId": data.fields.strategy,
            "name": data.fields.name,
        }
        summaries = [metadata if d["id"] == data.draft_id else d for d in workspace["drafts"]]
        if not preview.listed:
            summaries.append(metadata)
        try:
            fields = WorkspaceFields.model_validate(
                {
                    "preferences": workspace["preferences"],
                    "drafts": summaries,
                    "selectedDraftId": data.draft_id,
                }
            ).model_dump(by_alias=True)
        except ValueError:
            raise PrivateRPCError("PRIVATE_REQUEST_INVALID") from None
        content, revision = preview.proposal.model_dump(by_alias=True), data.expected_revision + 1
        c.execute(
            "INSERT INTO astarter_private.draft_versions(tenant_id,subject_id,draft_id,revision,"
            "source_request_id,saved_at_ms,content) VALUES(%s,%s,%s,%s,%s,%s,%s)",
            (*owner, data.draft_id, revision, data.source_request_id, now, Jsonb(content)),
        )
        if data.expected_revision == 0:
            c.execute(
                "INSERT INTO astarter_private.draft_heads VALUES(%s,%s,%s,%s)",
                (*owner, data.draft_id, revision),
            )
        else:
            changed = c.execute(
                "UPDATE astarter_private.draft_heads SET revision=%s WHERE tenant_id=%s "
                "AND subject_id=%s AND draft_id=%s AND revision=%s RETURNING revision",
                (revision, *owner, data.draft_id, data.expected_revision),
            ).fetchone()
            if changed is None:
                raise PrivateRPCError("PRIVATE_CONFLICT")
        state = self._ui._save_workspace(c, owner, fields, data.workspace_revision, now)
        c.execute(
            "INSERT INTO astarter_private.draft_commands(tenant_id,subject_id,request_id,"
            "fingerprint,draft_id,expected_revision,revision,workspace_base_revision,"
            "workspace_revision,applied_at_ms) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                *owner,
                data.request_id,
                fingerprint,
                data.draft_id,
                data.expected_revision,
                revision,
                data.workspace_revision,
                state["revision"],
                now,
            ),
        )
        confirmed, final_now = self._ui._identity(c, session_digest, "workspace:write")
        if confirmed != owner:
            raise PrivateRPCError("PRIVATE_FORBIDDEN")
        if preview.proposal.source.valid_until <= final_now:
            raise PrivateRPCError("PRIVATE_REQUEST_INVALID")
        row = self._command(c, owner, data.request_id)
        if row is None:
            raise PrivateRPCError("PRIVATE_UNAVAILABLE")
        return self._original(row, owner)
