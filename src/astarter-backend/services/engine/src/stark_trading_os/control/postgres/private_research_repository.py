"""Runtime PRIVATE DAL over the existing bounded pool; construction performs no IO."""

import hmac
import json
import re
import secrets
from hashlib import sha256
from typing import Annotated, Any, Literal

import psycopg
from psycopg import Connection
from pydantic import Field, ValidationError, model_validator

from stark_trading_os.control.private_research_rpc import PrivateRPCError

from .access import AccessRejected, RepositoryAccessContract
from .pool import PersistenceUnavailable, PgRepositoryPool
from .private_draft_contracts import DRAFT_METHODS
from .private_research_contracts import (
    AUDIENCE,
    COMPLETION_MICROUSD_PER_MILLION,
    CONTRACT,
    MAX_SAFE_INTEGER,
    MODEL,
    PROMPT_MICROUSD_PER_MILLION,
    RESERVED_TOKENS,
    Identifier,
    Millis,
    PrivateDTO,
    PrivateLease,
    RequestIdentity,
    reserve_microusd,
    utc_month_bounds,
)
from .private_ui_contracts import UI_METHODS, UI_PERMISSIONS

Amount = Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER)]
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$", max_length=64)]


class _LeaseInput(PrivateDTO):
    lease_id: Identifier = Field(alias="leaseId")
    target_id: Identifier = Field(alias="targetId")
    audience: Literal["astarter-research"]


class _ResolveInput(_LeaseInput):
    token_digest: Digest = Field(alias="tokenDigest")
    now: Millis


class _OwnedInput(RequestIdentity, _LeaseInput):
    pass


class _Policy(PrivateDTO):
    id: Identifier
    start: Millis = Field(alias="from")
    until: Millis
    token_limit: Annotated[int, Field(ge=13056, le=MAX_SAFE_INTEGER)] = Field(alias="tokenLimit")
    request_limit: Annotated[int, Field(ge=1, le=MAX_SAFE_INTEGER)] = Field(alias="requestLimit")
    model: Literal["openai/gpt-4.1-mini"]
    limit_microusd: Annotated[int, Field(ge=1, le=50_000_000)] = Field(alias="limitMicrousd")
    fixed_service_microusd: Amount = Field(alias="fixedServiceMicrousd")
    prompt_price: Annotated[int, Field(ge=400000, le=400000)] = Field(
        alias="promptMicrousdPerMillion"
    )
    completion_price: Annotated[int, Field(ge=1600000, le=1600000)] = Field(
        alias="completionMicrousdPerMillion"
    )


class _Claim(_OwnedInput):
    fingerprint: Digest
    created_at: Millis = Field(alias="createdAt")
    expires_at: Millis = Field(alias="expiresAt")
    reserved_tokens: Annotated[int, Field(ge=13056, le=13056)] = Field(alias="reservedTokens")
    reserved_microusd: Annotated[int, Field(ge=20890, le=20890)] = Field(alias="reservedMicrousd")
    policy: _Policy


class _Finish(_OwnedInput):
    claim_token: Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{43}$", max_length=43)] = Field(
        alias="claimToken"
    )
    state: Literal["complete", "failed", "unknown"]
    settled_tokens: Annotated[int, Field(ge=0, le=13056)] | None = Field(alias="settledTokens")
    settled_microusd: Amount | None = Field(alias="settledMicrousd")
    provider_receipt: dict[str, Any] | None = Field(alias="providerReceipt")
    result: dict[str, Any] | None = None
    error: Identifier | None = None
    query_original: bool = Field(default=False, alias="queryOriginalRequest")

    @model_validator(mode="after")
    def outcome(self) -> "_Finish":
        if self.state == "complete":
            valid = (
                self.settled_tokens is not None
                and self.settled_microusd is None
                and self.result is not None
                and self.result.get("model") == MODEL
                and self.result.get("executionAuthority") == "NONE"
                and self.provider_receipt == self.result.get("billing")
                and self.error is None
                and not self.query_original
            )
        elif self.state == "failed":
            valid = (
                self.settled_tokens == 0
                and self.settled_microusd == 0
                and self.provider_receipt is None
                and self.result is None
                and not self.query_original
            )
        else:
            valid = (
                self.settled_tokens is None
                and self.settled_microusd is None
                and self.provider_receipt is None
                and self.result is None
                and self.query_original
            )
        if not valid:
            raise ValueError("PRIVATE_REQUEST_INVALID")
        return self


_INPUTS: dict[str, type[_LeaseInput]] = {
    "lease": _LeaseInput,
    "session/resolve": _ResolveInput,
    "research/get": _OwnedInput,
    "research/claim": _Claim,
    "research/finish": _Finish,
}
_ERRORS = {
    "AUTH_REQUIRED": "PRIVATE_AUTH_REQUIRED",
    "SCOPE_EXPIRED": "PRIVATE_AUTH_REQUIRED",
    "PRIVATE_TARGET_MISMATCH": "PRIVATE_TARGET_MISMATCH",
    "PRIVATE_CONFLICT": "PRIVATE_CONFLICT",
    "REQUEST_NOT_FOUND": "PRIVATE_CONFLICT",
    "REQUEST_INVALID": "PRIVATE_REQUEST_INVALID",
    "BUDGET_UNAVAILABLE": "PRIVATE_UNAVAILABLE",
}


def _clock(connection: Connection[dict[str, Any]]) -> int:
    row = connection.execute(
        "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms"
    ).fetchone()
    assert row is not None
    return int(row["now_ms"])


def _record(row: dict[str, Any], now: int) -> dict[str, Any]:
    return dict(
        tenantId=row["tenant_id"],
        subjectId=row["subject_id"],
        scopeId=row["tenant_id"],
        requestId=row["request_id"],
        fingerprint=row["fingerprint"],
        state=row["state"],
        createdAt=int(row["created_at_ms"]),
        expiresAt=int(row["expires_at_ms"]),
        result=row["result"],
        error=row["error_code"],
        settledTokens=None if row["settled_tokens"] is None else int(row["settled_tokens"]),
        queryOriginalRequest=(
            row["state"] == "unknown" or row["state"] == "pending" and row["expires_at_ms"] <= now
        ),
    )


def _call(
    connection: Connection[dict[str, Any]], statement: str, params: tuple[Any, ...]
) -> dict[str, Any]:
    try:
        row = connection.execute(statement, params).fetchone()
    except psycopg.Error as error:
        # Only fixed known messages are mapped; never copy raw diagnostics or parameters.
        code = _ERRORS.get(error.diag.message_primary or "", "PRIVATE_UNAVAILABLE")
        if error.sqlstate and error.sqlstate.startswith(("22", "23")):
            code = "PRIVATE_REQUEST_INVALID"
        raise PrivateRPCError(code) from None
    if row is None or type(row["result"]) is not dict:
        raise PrivateRPCError("PRIVATE_UNAVAILABLE")
    return dict(row["result"])


class PrivateRuntimeRepository:
    def __init__(self, pool: PgRepositoryPool, *, lease: PrivateLease) -> None:
        if (
            type(pool) is not PgRepositoryPool
            or type(lease) is not PrivateLease
            or pool.access_contract is not RepositoryAccessContract.PRIVATE_RESEARCH_V1
            or pool.private_role != "runtime"
            or not pool.writable
            or pool.private_target is None
            or (
                pool.private_target.target_id,
                pool.private_target.database,
                pool.private_target.runtime,
            )
            != (lease.target_id, lease.database, lease.runtime_role)
        ):
            raise ValueError("PRIVATE_RUNTIME_CONFIGURATION")
        self._pool, self._lease = pool, lease

    def invoke(self, operation: str, payload: dict[str, Any], session_digest: str | None) -> Any:
        if operation in DRAFT_METHODS:
            assert self._pool.private_target is not None
            if self._pool.private_target.schema_version != 3:
                raise PrivateRPCError("PRIVATE_UNAVAILABLE")
            from .private_draft_repository import PrivateDraftRepository
            return PrivateDraftRepository(self._pool, lease=self._lease).invoke(
                operation, payload, session_digest
            )
        if operation in UI_METHODS:
            assert self._pool.private_target is not None
            if self._pool.private_target.schema_version not in (2, 3):
                raise PrivateRPCError("PRIVATE_UNAVAILABLE")
            from .private_ui_repository import PrivateUIRepository
            return PrivateUIRepository(self._pool, lease=self._lease).invoke(
                operation, payload, session_digest
            )
        if type(session_digest) is not str or re.fullmatch(r"[a-f0-9]{64}", session_digest) is None:
            raise PrivateRPCError("PRIVATE_AUTH_REQUIRED")
        model = _INPUTS.get(operation)
        if model is None:
            raise PrivateRPCError("PRIVATE_REQUEST_INVALID")
        try:
            data = model.model_validate(payload)
        except ValidationError:
            raise PrivateRPCError("PRIVATE_REQUEST_INVALID") from None
        if (data.lease_id, data.target_id, data.audience) != (
            self._lease.lease_id,
            self._lease.target_id,
            self._lease.audience,
        ):
            raise PrivateRPCError("PRIVATE_TARGET_MISMATCH")
        if isinstance(data, _ResolveInput) and not hmac.compare_digest(
            data.token_digest, session_digest
        ):
            raise PrivateRPCError("PRIVATE_AUTH_REQUIRED")
        serialized: str | None = None
        if isinstance(data, _Finish) and data.result is not None:
            try:
                serialized = json.dumps(data.result, ensure_ascii=False, allow_nan=False)
                if len(serialized.encode()) > 65536:
                    raise ValueError("PRIVATE_REQUEST_INVALID")
            except (ValueError, TypeError, RecursionError, UnicodeError):
                raise PrivateRPCError("PRIVATE_REQUEST_INVALID") from None
        write = isinstance(data, (_Claim, _Finish))
        scope = "private-runtime:" + session_digest
        try:
            with self._pool.transaction(write=write, scope_id=scope) as connection:
                principal = self._principal(connection, session_digest)
                current = _clock(connection)
                if principal["expiresAt"] <= current:
                    raise PrivateRPCError("PRIVATE_AUTH_REQUIRED")
                actual_lease = self._actual_lease(connection, current)
                connection.execute(
                    "SELECT set_config('astarter_private.session_digest',%s,TRUE)",
                    (session_digest,),
                )
                if isinstance(data, _OwnedInput) and (
                    data.tenant_id,
                    data.subject_id,
                    data.scope_id,
                ) != (principal["tenantId"], principal["subjectId"], principal["scopeId"]):
                    raise PrivateRPCError("PRIVATE_FORBIDDEN")
                if operation == "session/resolve":
                    return principal
                if operation == "lease":
                    return dict(
                        contract=CONTRACT,
                        kind="PRIVATE",
                        **actual_lease,
                        now=current,
                        policy=self._policy(connection, principal["tenantId"], current),
                    )
                assert isinstance(data, _OwnedInput)
                if operation == "research/get":
                    row = connection.execute(
                        "SELECT * FROM astarter_private.requests WHERE tenant_id=%s "
                        "AND subject_id=%s AND request_id=%s AND lease_id=%s",
                        (data.tenant_id, data.subject_id, data.request_id, data.lease_id),
                    ).fetchone()
                    return None if row is None else _record(row, current)
                if isinstance(data, _Claim):
                    policy = self._policy(connection, principal["tenantId"], current)
                    snapshot = data.policy.model_dump(by_alias=True)
                    if any(policy[key] != value for key, value in snapshot.items()):
                        raise PrivateRPCError("PRIVATE_CONFLICT")
                    claim = secrets.token_urlsafe(32)
                    result = _call(
                        connection,
                        "SELECT astarter_private.claim_research(%s,%s,%s,%s,%s,%s,%s,%s) AS result",
                        (
                            session_digest,
                            data.lease_id,
                            data.target_id,
                            data.request_id,
                            data.fingerprint,
                            sha256(claim.encode()).hexdigest(),
                            data.created_at,
                            data.expires_at,
                        ),
                    )
                    if result.get("acquired") is True:
                        return {"acquired": True, "claimToken": claim}
                    return result
                assert isinstance(data, _Finish)
                return _call(
                    connection,
                    "SELECT astarter_private.finish_research(%s,%s,%s,%s,%s,%s,%s,"
                    "%s::jsonb,%s) AS result",
                    (
                        session_digest,
                        data.lease_id,
                        data.target_id,
                        data.request_id,
                        sha256(data.claim_token.encode()).hexdigest(),
                        data.state,
                        data.settled_tokens,
                        serialized,
                        data.error,
                    ),
                )
        except (PersistenceUnavailable, AccessRejected):
            raise PrivateRPCError("PRIVATE_UNAVAILABLE") from None

    @staticmethod
    def _principal(connection: Connection[dict[str, Any]], digest: str) -> dict[str, Any]:
        row = connection.execute(
            "SELECT * FROM astarter_private.resolve_session(%s,%s)", (digest, AUDIENCE)
        ).fetchone()
        if row is None:
            raise PrivateRPCError("PRIVATE_AUTH_REQUIRED")
        permissions = tuple(row["permissions"])
        if permissions not in {("research:analyze",), UI_PERMISSIONS}:
            raise PrivateRPCError("PRIVATE_AUTH_REQUIRED")
        authority = {"authVersion": 2, "permissionProfile": "private-ui-v2"} if (
            permissions == UI_PERMISSIONS
        ) else {}
        return dict(
            subjectId=row["subject_id"],
            tenantId=row["tenant_id"],
            scopeId=row["scope_id"],
            audience=row["audience"],
            notBefore=int(row["not_before_ms"]),
            expiresAt=int(row["expires_at_ms"]),
            revokedAt=row["revoked_at_ms"],
            permissions=list(row["permissions"]),
            **authority,
        )

    def _actual_lease(self, connection: Connection[dict[str, Any]], now: int) -> dict[str, Any]:
        row = connection.execute(
            "SELECT * FROM astarter_private.leases WHERE lease_id=%s", (self._lease.lease_id,)
        ).fetchone()
        if row is None or not row["created_at_ms"] <= now < row["expires_at_ms"]:
            raise PrivateRPCError("PRIVATE_TARGET_MISMATCH")
        actual = dict(
            leaseId=row["lease_id"],
            targetId=row["target_id"],
            database=row["database_name"],
            schema="astarter_private",
            runtimeRole=row["runtime_role"],
            audience=row["audience"],
            budgetId=row["budget_id"],
            model=row["model"],
            expiresAt=int(row["expires_at_ms"]),
        )
        if actual != self._lease.model_dump(by_alias=True):
            raise PrivateRPCError("PRIVATE_TARGET_MISMATCH")
        return actual

    def _policy(
        self, connection: Connection[dict[str, Any]], tenant: str, now: int
    ) -> dict[str, Any]:
        start, end = utc_month_bounds(now)
        parent = connection.execute(
            "SELECT * FROM astarter_private.global_budget WHERE month_start_ms=%s", (start,)
        ).fetchone()
        child = connection.execute(
            "SELECT * FROM astarter_private.policies WHERE month_start_ms=%s "
            "AND tenant_id=%s AND policy_id=%s",
            (start, tenant, self._lease.budget_id),
        ).fetchone()
        if (
            parent is None
            or child is None
            or parent["fixed_service_microusd"] is None
            or parent["month_end_ms"] != end
            or child["model"] != MODEL
        ):
            raise PrivateRPCError("PRIVATE_UNAVAILABLE")
        reserve = reserve_microusd()
        blocked = (
            parent["blocked"]
            or child["blocked"]
            or parent["fixed_service_microusd"]
            + parent["held_microusd"]
            + parent["spent_microusd"]
            + reserve
            > parent["limit_microusd"]
            or child["held_microusd"] + child["spent_microusd"] + reserve > child["limit_microusd"]
            or child["held_tokens"] + child["spent_tokens"] + RESERVED_TOKENS > child["token_limit"]
            or child["request_count"] + 1 > child["request_limit"]
        )
        # USD fields are the one global parent, not an additional per-wallet 50 USD grant.
        return dict(
            id=child["policy_id"],
            **{"from": start},
            until=end,
            tokenLimit=int(child["token_limit"]),
            requestLimit=int(child["request_limit"]),
            model=MODEL,
            limitMicrousd=int(parent["limit_microusd"]),
            fixedServiceMicrousd=int(parent["fixed_service_microusd"]),
            heldMicrousd=int(parent["held_microusd"]),
            spentMicrousd=int(parent["spent_microusd"]),
            promptMicrousdPerMillion=PROMPT_MICROUSD_PER_MILLION,
            completionMicrousdPerMillion=COMPLETION_MICROUSD_PER_MILLION,
            blocked=bool(blocked),
        )
