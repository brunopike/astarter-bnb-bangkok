"""Durable issuer transactions after the HTTP owner verifies genuine wallet signatures."""

import hmac
import secrets
from hashlib import sha256
from typing import Any

from psycopg import Connection

from .access import RepositoryAccessContract
from .pool import PgRepositoryPool
from .private_research_inputs import (
    ChallengeBinding,
    ChallengeKey,
    IssueChallenge,
    IssueSession,
    SessionKey,
    issuer_input,
)


def _authority(row: dict[str, Any]) -> dict[str, Any]:
    version = row.get("auth_version", 1)
    profile = row.get("permission_profile", "research-v1")
    if (version, profile) == (1, "research-v1"):
        return {}
    if (version, profile) != (2, "private-ui-v2"):
        raise ValueError("PRIVATE_STORED_AUTHORITY")
    return {"authVersion": 2, "permissionProfile": "private-ui-v2"}


def _challenge(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "challengeHash": row["challenge_hash"],
        "nonce": row["nonce"],
        "origin": row["origin"],
        "issuedAt": int(row["issued_at_ms"]),
        "expires": int(row["expires_at_ms"]),
        "address": row["address"],
        "chain": None if row["chain_id"] is None else int(row["chain_id"]),
        "message": row["message"],
        **_authority(row),
    }


def _session(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "tokenHash": row["token_digest"],
        "address": row["verified_address"],
        "chain": int(row["chain_id"]),
        "origin": row["origin"],
        "subjectId": row["subject_id"],
        "scopeId": row["tenant_id"],
        "issuedAt": int(row["not_before_ms"]),
        "expires": int(row["expires_at_ms"]),
        "permissions": list(row["permissions"]),
        **_authority(row),
    }


def _load_challenge(
    connection: Connection[dict[str, Any]], key: str, *, write: bool
) -> dict[str, Any] | None:
    return connection.execute(
        "SELECT * FROM astarter_private.challenges WHERE challenge_hash=%s"
        + (" FOR UPDATE" if write else ""),
        (key,),
    ).fetchone()


def _clock(connection: Connection[dict[str, Any]]) -> int:
    row = connection.execute(
        "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms"
    ).fetchone()
    assert row is not None
    return int(row["now_ms"])


class PrivateIssuerRepository:
    def __init__(self, pool: PgRepositoryPool) -> None:
        if (
            type(pool) is not PgRepositoryPool
            or pool.access_contract is not RepositoryAccessContract.PRIVATE_RESEARCH_V1
            or pool.private_role != "issuer"
            or not pool.writable
        ):
            raise ValueError("PRIVATE_ISSUER_CONFIGURATION")
        self._pool = pool

    def invoke(self, operation: str, payload: dict[str, Any], session_digest: str | None) -> Any:
        if session_digest is not None:
            raise PermissionError("PRIVATE_ISSUER_CAPABILITY")
        target = self._pool.private_target
        assert target is not None
        data = issuer_input(operation, payload)
        if isinstance(data, (IssueChallenge, ChallengeBinding, IssueSession)):
            if data.auth_version == 2 and target.schema_version not in (2, 3):
                return None
        key = (
            data.token_hash
            if isinstance(data, SessionKey)
            else data.challenge_hash
            if isinstance(data, (IssueChallenge, ChallengeKey, IssueSession))
            else ""
        )
        write = operation not in {"auth/challenge/get", "auth/session/resolve"}
        with self._pool.transaction(write=write, scope_id="private-issuer:" + key) as connection:
            now = _clock(connection)
            if isinstance(data, IssueChallenge):
                if abs(now - data.issued_at) > 5000:
                    return None
                # Caller time is a bounded freshness hint; persisted identity uses the DB clock.
                fields = "challenge_hash,nonce,origin,issued_at_ms,expires_at_ms"
                values: tuple[Any, ...] = (
                    data.challenge_hash, data.nonce, data.origin, now, now + data.lifetime_ms,
                )
                if target.schema_version in (2, 3):
                    fields += ",auth_version,permission_profile"
                    values += (data.auth_version, data.permission_profile)
                row = connection.execute(
                    "INSERT INTO astarter_private.challenges(" + fields + ") VALUES("
                    + ",".join("%s" for _ in values) + ") "
                    "ON CONFLICT DO NOTHING RETURNING *",
                    values,
                ).fetchone()
                return None if row is None else _challenge(row)
            if isinstance(data, IssueSession):
                return self._issue(connection, data)
            if isinstance(data, SessionKey):
                if operation == "auth/session/revoke":
                    connection.execute(
                        "UPDATE astarter_private.sessions SET revoked_at_ms=%s "
                        "WHERE token_digest=%s AND revoked_at_ms IS NULL",
                        (now, data.token_hash),
                    )
                    return True
                row = connection.execute(
                    "SELECT * FROM astarter_private.sessions WHERE token_digest=%s "
                    "AND not_before_ms<=%s AND expires_at_ms>%s AND revoked_at_ms IS NULL",
                    (data.token_hash, now, now),
                ).fetchone()
                return None if row is None else _session(row)
            assert isinstance(data, ChallengeKey)
            row = _load_challenge(connection, data.challenge_hash, write=write)
            if write:
                now = _clock(connection)
            if operation == "auth/challenge/revoke":
                connection.execute(
                    "UPDATE astarter_private.challenges SET revoked_at_ms=%s "
                    "WHERE challenge_hash=%s AND revoked_at_ms IS NULL",
                    (now, data.challenge_hash),
                )
                return True
            if (
                row is None
                or row["revoked_at_ms"] is not None
                or row["consumed_at_ms"] is not None
                or not row["issued_at_ms"] <= now < row["expires_at_ms"]
            ):
                return None
            if operation == "auth/challenge/get":
                return _challenge(row)
            assert isinstance(data, ChallengeBinding)
            if row["nonce"] != data.nonce or (
                row.get("auth_version", 1), row.get("permission_profile", "research-v1")
            ) != (data.auth_version, data.permission_profile):
                return None
            if row["address"] is None:
                if operation != "auth/challenge/prepare":
                    return None
                updated = connection.execute(
                    "UPDATE astarter_private.challenges SET address=%s,chain_id=%s,message=%s,"
                    "prepared_at_ms=%s WHERE challenge_hash=%s RETURNING *",
                    (data.address, data.chain, data.message, now, data.challenge_hash),
                ).fetchone()
                assert updated is not None
                return _challenge(updated)
            if (row["address"], row["chain_id"], row["message"]) != (
                data.address,
                data.chain,
                data.message,
            ):
                return None
            if operation == "auth/challenge/prepare":
                return _challenge(row)
            claim = secrets.token_urlsafe(32)
            connection.execute(
                "UPDATE astarter_private.challenges SET claim_digest=%s,"
                "consumed_at_ms=%s WHERE challenge_hash=%s",
                (sha256(claim.encode()).hexdigest(), now, data.challenge_hash),
            )
            return {"challenge": _challenge(row), "claimToken": claim}

    @staticmethod
    def _issue(connection: Connection[dict[str, Any]], data: IssueSession) -> dict[str, Any] | None:
        row = _load_challenge(connection, data.challenge_hash, write=True)
        now = _clock(connection)
        if (
            row is None
            or row["revoked_at_ms"] is not None
            or row["claim_digest"] is None
            or row["consumed_at_ms"] is None
            or now >= row["expires_at_ms"]
            or abs(now - data.issued_at) > 5000
            or now < row["consumed_at_ms"]
            or (row["address"], row["chain_id"], row["origin"])
            != (data.address, data.chain, data.origin)
            or (row.get("auth_version", 1), row.get("permission_profile", "research-v1"))
            != (data.auth_version, data.permission_profile)
            or not hmac.compare_digest(
                row["claim_digest"], sha256(data.claim_token.encode()).hexdigest()
            )
        ):
            return None
        if connection.execute(
            "SELECT 1 FROM astarter_private.sessions WHERE challenge_hash=%s",
            (data.challenge_hash,),
        ).fetchone():
            return None
        subject = "wallet:56:" + data.address.lower()
        fields = (
            "token_digest,challenge_hash,claim_digest,verified_address,chain_id,origin,"
            "subject_id,tenant_id,audience,permissions,not_before_ms,expires_at_ms"
        )
        values: tuple[Any, ...] = (
            data.token_hash, data.challenge_hash, row["claim_digest"], data.address, data.chain,
            data.origin, subject, subject, "astarter-research", list(data.permissions),
            now, now + data.lifetime_ms,
        )
        if "auth_version" in row:
            fields += ",auth_version,permission_profile"
            values += (data.auth_version, data.permission_profile)
        session = connection.execute(
            "INSERT INTO astarter_private.sessions(" + fields + ") VALUES("
            + ",".join("%s" for _ in values) + ") RETURNING *", values,
        ).fetchone()
        assert session is not None
        if data.previous_token_hash is not None:
            connection.execute(
                "UPDATE astarter_private.sessions SET revoked_at_ms=%s "
                "WHERE token_digest=%s AND revoked_at_ms IS NULL",
                (now, data.previous_token_hash),
            )
        return _session(session)
