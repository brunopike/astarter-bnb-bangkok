"""P3 original-pool native end to end on owned local fixtures only."""

import asyncio
import json
import socket
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from unittest.mock import patch

import psycopg
import pytest
from psycopg.conninfo import make_conninfo

from stark_trading_os.control.postgres.access import RepositoryAccessContract
from stark_trading_os.control.postgres.caller import owned_thread
from stark_trading_os.control.postgres.pool import CommitUnknown, PgRepositoryPool, PoolSettings
from stark_trading_os.control.postgres.private_research_contracts import PrivateLease
from stark_trading_os.control.postgres.private_research_issuer import PrivateIssuerRepository
from stark_trading_os.control.postgres.private_research_repository import PrivateRuntimeRepository
from stark_trading_os.control.private_research_rpc import PrivateRPCError
from tests.unit.control.postgres import test_private_research_migration as base
from tests.unit.control.postgres.test_private_research_issuer import (
    challenge,
    consume,
    session_args,
)
from tests.unit.control.postgres.test_private_research_migration import db as db
from tests.unit.control.postgres.test_private_research_migration import native
from tests.unit.control.postgres.test_private_research_migration import pg as pg
from tests.unit.control.postgres.test_private_research_mutations import model_result
from tests.unit.control.postgres.test_private_research_pool import target as cold_target


def lease(target, expires):
    return PrivateLease(
        leaseId="lease",
        targetId=target.target_id,
        database=target.database,
        schema="astarter_private",
        runtimeRole=target.runtime,
        audience="astarter-research",
        budgetId="policy",
        model=base.MODEL,
        expiresAt=expires,
    )


def pool_for(target, role):
    return PgRepositoryPool(
        make_conninfo(
            host=target.host,
            port=target.port,
            dbname=target.database,
            user=getattr(target, role),
            passfile="/dev/null",
            sslmode="disable",
        ),
        settings=PoolSettings(max_size=2),
        access_contract=RepositoryAccessContract.PRIVATE_RESEARCH_V1,
        private_target=target,
        private_role=role,
    )


@pytest.fixture
def runtime(db):
    _, owner, target = db
    issuer_pool, runtime_pool = pool_for(target, "issuer"), pool_for(target, "runtime")
    try:
        issuer_pool.open()
        runtime_pool.open()
        issuer = PrivateIssuerRepository(issuer_pool)
        users = []
        for index in ("1", "2"):
            bound, claim = consume(issuer, challenge(issuer, index), index)
            data = session_args(bound, claim, "session-" + index)
            issued = issuer.invoke("auth/session/issue", data, None)
            assert issued is not None
            users.append(
                {
                    "digest": data["tokenHash"],
                    "subject": issued["subjectId"],
                    "challenge": data["challengeHash"],
                }
            )
        now = int(
            owner.execute(
                "SELECT floor(extract(epoch FROM clock_timestamp())*1000) AS n"
            ).fetchone()["n"]
        )
        configured = lease(target, now + 120000)
        owner.execute(
            "INSERT INTO astarter_private.leases VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                "lease",
                target.target_id,
                target.database,
                target.runtime,
                target.profile.value,
                "astarter-research",
                base.MODEL,
                "policy",
                now - 1000,
                configured.expires_at,
            ),
        )
        start, end = base.utc_month_bounds(now)
        owner.execute(
            "INSERT INTO astarter_private.global_budget VALUES(%s,%s,50000000,1000000,0,0,FALSE)",
            (start, end),
        )
        for user in users:
            owner.execute(
                "INSERT INTO astarter_private.policies(month_start_ms,tenant_id,"
                "policy_id,model,token_limit,request_limit,limit_microusd,"
                "blocked) VALUES(%s,%s,%s,%s,130560,10,2000000,FALSE)",
                (start, user["subject"], "policy", base.MODEL),
            )
        yield (
            PrivateRuntimeRepository(runtime_pool, lease=configured),
            runtime_pool,
            issuer,
            users,
            configured,
        )
    finally:
        runtime_pool.close()
        issuer_pool.close()
        assert runtime_pool._pool.closed and issuer_pool._pool.closed
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            active = owner.execute(
                "SELECT count(*) AS n FROM pg_stat_activity "
                "WHERE datname=current_database() AND usename=ANY(%s)",
                ([target.runtime, target.issuer],),
            ).fetchone()["n"]
            if active == 0:
                break
            time.sleep(0.01)
        assert active == 0
        with (base.TASK / ("private-repository-pool-cleanup-" + db[0].run_id + ".jsonl")).open(
            "a"
        ) as evidence:
            evidence.write(
                json.dumps(
                    {
                        "database": target.database,
                        "runtime_pool_closed": True,
                        "issuer_pool_closed": True,
                        "native_role_connections": active,
                    }
                )
                + "\n"
            )


def scope(configured):
    return dict(
        leaseId=configured.lease_id, targetId=configured.target_id, audience=configured.audience
    )


def owned(user, configured, request="request-001"):
    return scope(configured) | dict(
        tenantId=user["subject"],
        subjectId=user["subject"],
        scopeId=user["subject"],
        requestId=request,
    )


def claim_payload(repo, user, configured, request="request-001"):
    inspected = repo.invoke("lease", scope(configured), user["digest"])
    p = inspected["policy"]
    fields = (
        "id",
        "from",
        "until",
        "tokenLimit",
        "requestLimit",
        "model",
        "limitMicrousd",
        "fixedServiceMicrousd",
        "promptMicrousdPerMillion",
        "completionMicrousdPerMillion",
    )
    return owned(user, configured, request) | dict(
        fingerprint="f" * 64,
        createdAt=inspected["now"],
        expiresAt=min(configured.expires_at, p["until"]),
        reservedTokens=13056,
        reservedMicrousd=20890,
        policy={key: p[key] for key in fields},
    )


def finish_payload(user, configured, token, state="complete"):
    result = model_result() if state == "complete" else None
    payload = owned(user, configured) | dict(
        claimToken=token,
        state=state,
        settledTokens=150 if state == "complete" else 0 if state == "failed" else None,
        settledMicrousd=0 if state == "failed" else None,
        providerReceipt=None,
    )
    if result is not None:
        payload["result"] = result
    if state == "unknown":
        payload |= dict(queryOriginalRequest=True, error="MODEL_TIMEOUT")
    if state == "failed":
        payload["error"] = "EVIDENCE_INVALID"
    return payload


def test_cold_constructor_no_io_and_fixed_role():
    def deny(*args, **kwargs):
        raise AssertionError("UNEXPECTED_IO")

    target = cold_target()
    with (
        patch.object(socket.socket, "connect", deny),
        patch.object(socket, "getaddrinfo", deny),
        patch.object(psycopg, "connect", deny),
    ):
        pool = pool_for(target, "runtime")
        try:
            repo = PrivateRuntimeRepository(pool, lease=lease(target, 253402300799998))
            assert repo is not None and pool._pool.closed
            with pytest.raises(ValueError):
                PrivateRuntimeRepository(
                    pool,
                    lease=lease(target, 253402300799998).model_copy(update={"target_id": "wrong"}),
                )
        finally:
            pool.close()
        issuer_pool = pool_for(target, "issuer")
        try:
            with pytest.raises(ValueError):
                PrivateRuntimeRepository(issuer_pool, lease=lease(target, 253402300799998))
        finally:
            issuer_pool.close()


@native
def test_original_pool_all_five_and_usd_not_double_counted(db, runtime):
    repo, pool, _, users, configured = runtime
    user = users[0]
    inspected = repo.invoke("lease", scope(configured), user["digest"])
    assert (
        inspected["contract"] == "ASTARTER_PRIVATE_RESEARCH_V1" and inspected["kind"] == "PRIVATE"
    )
    assert inspected["policy"]["limitMicrousd"] == 50000000
    assert inspected["policy"]["fixedServiceMicrousd"] == 1000000
    principal = repo.invoke(
        "session/resolve",
        scope(configured) | dict(tokenDigest=user["digest"], now=0),
        user["digest"],
    )
    assert (
        principal["subjectId"] == principal["tenantId"] == principal["scopeId"] == user["subject"]
    )
    assert principal["revokedAt"] is None and principal["permissions"] == ["research:analyze"]
    assert repo.invoke("research/get", owned(user, configured), user["digest"]) is None
    acquired = repo.invoke("research/claim", claim_payload(repo, user, configured), user["digest"])
    assert acquired["acquired"] and len(acquired["claimToken"]) == 43
    record = repo.invoke("research/get", owned(user, configured), user["digest"])
    assert record["state"] == "pending" and "claimToken" not in record
    finished = repo.invoke(
        "research/finish", finish_payload(user, configured, acquired["claimToken"]), user["digest"]
    )
    assert finished["state"] == "complete"
    assert repo.invoke("research/get", owned(user, configured), user["digest"]) == finished
    assert db[1].execute(
        "SELECT held_microusd,spent_microusd FROM astarter_private.global_budget"
    ).fetchone() == dict(held_microusd=20890, spent_microusd=0)
    with pool.transaction() as connection:
        assert connection.execute(
            "SELECT current_setting('astarter_private.session_digest',TRUE) AS s"
        ).fetchone()["s"] in (None, "")
        assert connection.execute("SELECT * FROM astarter_private.requests").fetchall() == []
        assert connection.execute("SHOW transaction_read_only").fetchone() == {
            "transaction_read_only": "on"
        }


@native
def test_two_principals_and_header_binding(runtime):
    repo, _, _, users, configured = runtime
    for user in users:
        result = repo.invoke(
            "research/claim", claim_payload(repo, user, configured), user["digest"]
        )
        assert result["acquired"]
    for user in users:
        record = repo.invoke("research/get", owned(user, configured), user["digest"])
        assert record["subjectId"] == user["subject"]
    with pytest.raises(PrivateRPCError) as error:
        repo.invoke("research/get", owned(users[1], configured), users[0]["digest"])
    assert error.value.code == "PRIVATE_FORBIDDEN"
    with pytest.raises(PrivateRPCError) as error:
        repo.invoke(
            "session/resolve",
            scope(configured) | dict(tokenDigest=users[1]["digest"], now=0),
            users[0]["digest"],
        )
    assert error.value.code == "PRIVATE_AUTH_REQUIRED"


@native
@pytest.mark.parametrize("state", ["unknown", "failed"])
def test_unknown_and_failed_repeat_original_and_keep_holds(db, runtime, state):
    repo, _, _, users, configured = runtime
    user = users[0]
    payload = claim_payload(repo, user, configured)
    claim = repo.invoke("research/claim", payload, user["digest"])
    finished = repo.invoke(
        "research/finish",
        finish_payload(user, configured, claim["claimToken"], state),
        user["digest"],
    )
    assert finished["queryOriginalRequest"] == (state == "unknown")
    again = repo.invoke("research/claim", payload, user["digest"])
    assert again == dict(acquired=False, record=finished)
    assert db[1].execute("SELECT held_microusd FROM astarter_private.global_budget").fetchone() == {
        "held_microusd": 20890
    }
    with pytest.raises(PrivateRPCError) as error:
        repo.invoke(
            "research/finish", finish_payload(user, configured, claim["claimToken"]), user["digest"]
        )
    assert error.value.code == "PRIVATE_CONFLICT"


@native
def test_shared_global_cap_and_same_id(db, runtime):
    repo, _, _, users, configured = runtime
    db[1].execute("UPDATE astarter_private.global_budget SET fixed_service_microusd=49979110")
    payloads = [claim_payload(repo, u, configured) for u in users]
    barrier = Barrier(2)

    def take(i):
        barrier.wait(2)
        return repo.invoke("research/claim", payloads[i], users[i]["digest"])

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(take, [0, 1]))
    assert sum(r["acquired"] for r in results) == 1
    winner = next(i for i, r in enumerate(results) if r["acquired"])
    previous = repo.invoke("research/claim", payloads[winner], users[winner]["digest"])
    assert previous["acquired"] is False and previous["record"]["state"] == "pending"
    assert db[1].execute("SELECT count(*) AS n FROM astarter_private.requests").fetchone() == {
        "n": 1
    }


@native
@pytest.mark.parametrize(
    "key,value",
    [
        ("reservedTokens", True),
        ("reservedTokens", 13056.0),
        ("reservedTokens", 13055),
        ("reservedMicrousd", 20889),
        ("reservedMicrousd", True),
        ("createdAt", -1),
        ("fingerprint", "x"),
        ("expiresAt", 1),
    ],
)
def test_typed_claim_inputs(db, runtime, key, value):
    repo, _, _, users, configured = runtime
    user = users[0]
    payload = claim_payload(repo, user, configured)
    payload[key] = value
    with pytest.raises(PrivateRPCError):
        repo.invoke("research/claim", payload, user["digest"])
    assert db[1].execute("SELECT * FROM astarter_private.requests").fetchall() == []


@native
@pytest.mark.parametrize(
    "key,value",
    [
        ("promptMicrousdPerMillion", True),
        ("promptMicrousdPerMillion", 0.4),
        ("completionMicrousdPerMillion", 1600001),
        ("limitMicrousd", 50000001),
        ("fixedServiceMicrousd", 0),
        ("tokenLimit", 13056),
        ("id", "wrong"),
        ("from", 0),
    ],
)
def test_exact_policy_price_fee_snapshot(db, runtime, key, value):
    repo, _, _, users, configured = runtime
    user = users[0]
    payload = claim_payload(repo, user, configured)
    payload["policy"][key] = value
    with pytest.raises(PrivateRPCError):
        repo.invoke("research/claim", payload, user["digest"])
    assert db[1].execute("SELECT held_microusd FROM astarter_private.global_budget").fetchone() == {
        "held_microusd": 0
    }


@native
@pytest.mark.parametrize("missing", ["policy", "global", "fixed"])
def test_no_implicit_wallet_budget(db, runtime, missing):
    repo, _, _, users, configured = runtime
    if missing == "policy":
        db[1].execute("DELETE FROM astarter_private.policies")
    elif missing == "global":
        db[1].execute("DELETE FROM astarter_private.policies")
        db[1].execute("DELETE FROM astarter_private.global_budget")
    else:
        db[1].execute(
            "UPDATE astarter_private.global_budget SET blocked=TRUE,fixed_service_microusd=NULL"
        )
    # Login remains usable independently of model admission.
    assert repo.invoke(
        "session/resolve",
        scope(configured) | dict(tokenDigest=users[0]["digest"], now=0),
        users[0]["digest"],
    )
    with pytest.raises(PrivateRPCError) as error:
        repo.invoke("lease", scope(configured), users[0]["digest"])
    assert error.value.code == "PRIVATE_UNAVAILABLE"


@native
def test_revoked_and_expired_identity_and_lease(db, runtime):
    repo, _, issuer, users, configured = runtime
    issuer.invoke("auth/session/revoke", dict(tokenHash=users[0]["digest"], now=0), None)
    with pytest.raises(PrivateRPCError) as error:
        repo.invoke("lease", scope(configured), users[0]["digest"])
    assert error.value.code == "PRIVATE_AUTH_REQUIRED"
    with base.app(db, "issuer") as connection:
        expired = base.identity(connection, "f", now=int(time.time() * 1000) - 604800001)
    with pytest.raises(PrivateRPCError):
        repo.invoke("lease", scope(configured), expired["token"])
    db[1].execute(
        "UPDATE astarter_private.leases SET expires_at_ms=%s", (int(time.time() * 1000) - 1,)
    )
    with pytest.raises(PrivateRPCError) as error:
        repo.invoke("research/get", owned(users[1], configured), users[1]["digest"])
    assert error.value.code == "PRIVATE_TARGET_MISMATCH"


@native
def test_unknown_commit_retains_request_without_returning_new_token(db, runtime, monkeypatch):
    repo, pool, _, users, configured = runtime
    user = users[0]
    payload = claim_payload(repo, user, configured)
    original = pool._commit

    def lose_ack(connection):
        original(connection)
        raise OSError("synthetic secret error must not escape")

    monkeypatch.setattr(pool, "_commit", lose_ack)
    with pytest.raises(CommitUnknown):
        repo.invoke("research/claim", payload, user["digest"])
    monkeypatch.setattr(pool, "_commit", original)
    record = repo.invoke("research/get", owned(user, configured), user["digest"])
    assert record["state"] == "pending"
    assert repo.invoke("research/claim", payload, user["digest"]) == dict(
        acquired=False, record=record
    )
    assert db[1].execute("SELECT held_microusd FROM astarter_private.global_budget").fetchone() == {
        "held_microusd": 20890
    }


@native
@pytest.mark.parametrize(
    "mutation",
    [
        "CREATE TABLE astarter_private.extra(x INTEGER)",
        "REVOKE EXECUTE ON FUNCTION astarter_private.claim_research(TEXT,"
        "TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,NUMERIC) FROM "
        "astarter_private_runtime",
        "GRANT EXECUTE ON FUNCTION astarter_private.finish_research(TEXT,"
        "TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,JSONB,TEXT) TO PUBLIC",
    ],
)
def test_exact_catalog_or_acl_drift_denied(db, runtime, mutation):
    repo, _, _, users, configured = runtime
    db[1].execute(mutation)
    with pytest.raises(PrivateRPCError) as error:
        repo.invoke("lease", scope(configured), users[0]["digest"])
    assert error.value.code == "PRIVATE_UNAVAILABLE"


@native
def test_owned_thread_cancellation_waits_for_committed_request(db, runtime, monkeypatch):
    repo, pool, _, users, configured = runtime
    user = users[0]
    payload = claim_payload(repo, user, configured)
    entered, released = Event(), Event()
    original = pool._commit

    def gate(connection):
        entered.set()
        assert released.wait(3)
        original(connection)

    monkeypatch.setattr(pool, "_commit", gate)

    async def cancel_twice():
        task = asyncio.create_task(
            owned_thread(lambda: repo.invoke("research/claim", payload, user["digest"]))
        )
        assert await asyncio.to_thread(entered.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        released.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    try:
        asyncio.run(cancel_twice())
    finally:
        released.set()
        monkeypatch.setattr(pool, "_commit", original)
    assert (
        repo.invoke("research/get", owned(user, configured), user["digest"])["state"] == "pending"
    )
    assert db[1].execute("SELECT held_microusd FROM astarter_private.global_budget").fetchone() == {
        "held_microusd": 20890
    }


@native
def test_same_id_concurrent_repository_and_read_operations_do_not_commit(db, runtime, monkeypatch):
    repo, pool, _, users, configured = runtime
    user = users[0]
    payload = claim_payload(repo, user, configured)
    start = Barrier(2)

    def take():
        start.wait(2)
        return repo.invoke("research/claim", payload, user["digest"])

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(lambda _: take(), range(2)))
    assert sum(result["acquired"] for result in results) == 1
    assert db[1].execute("SELECT held_microusd FROM astarter_private.global_budget").fetchone() == {
        "held_microusd": 20890
    }

    def forbidden_commit(connection):
        raise AssertionError("READ_OPERATION_COMMITTED")

    monkeypatch.setattr(pool, "_commit", forbidden_commit)
    assert (
        repo.invoke("research/get", owned(user, configured), user["digest"])["state"] == "pending"
    )
    assert repo.invoke("lease", scope(configured), user["digest"])["kind"] == "PRIVATE"
    assert repo.invoke(
        "session/resolve",
        scope(configured) | dict(tokenDigest=user["digest"], now=0),
        user["digest"],
    )


@native
def test_finish_cas_and_sanitized_error(db, runtime):
    repo, _, _, users, configured = runtime
    user = users[0]
    claim = repo.invoke("research/claim", claim_payload(repo, user, configured), user["digest"])
    payload = finish_payload(user, configured, "z" * 43, "unknown")
    with pytest.raises(PrivateRPCError) as error:
        repo.invoke("research/finish", payload, user["digest"])
    assert error.value.code == "PRIVATE_CONFLICT"
    payload["claimToken"] = claim["claimToken"]
    payload["error"] = "SYNTHETIC_SECRET_CANARY"
    with pytest.raises(PrivateRPCError) as error:
        repo.invoke("research/finish", payload, user["digest"])
    assert (
        error.value.code == "PRIVATE_REQUEST_INVALID"
        and str(error.value) == "PRIVATE_REQUEST_INVALID"
    )
    assert db[1].execute("SELECT state FROM astarter_private.requests").fetchone() == {
        "state": "pending"
    }
