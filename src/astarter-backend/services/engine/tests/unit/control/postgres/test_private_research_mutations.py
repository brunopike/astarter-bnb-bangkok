"""P2 business regressions on the complete sealed PRIVATE schema; prior stage preserved."""

import json
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path
from threading import Barrier, Event

import psycopg
import pytest
import test_private_research_migration as base

from stark_trading_os.control.postgres import private_research_migration as migration
from stark_trading_os.control.postgres.access import AccessRejected
from stark_trading_os.control.postgres.private_research_access import verify_private_access
from stark_trading_os.control.postgres.synthetic_migration import sql_statements

SQL_PATH = Path(migration.__file__).with_name("private_research_mutations_v1.sql")
CLAIM = "SELECT astarter_private.claim_research(%s,%s,%s,%s,%s,%s,%s,%s) AS result"
FINISH = "SELECT astarter_private.finish_research(%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s) AS result"
ASSEMBLY_FILES = {
    "private_research_schema_v1.sql": (
        "91a7d9eae216bb9f01fc8d6ea055d864be3101b64f545281678b1cc299ad813b"
    ),
    "private_research_access_v1.sql": (
        "2a4692dbfac61c6ff02a1d775004a02b42a2d222d41f08337ed01224f60bdf5f"
    ),
    "private_research_mutations_v1.sql": (
        "2057893ec5aa4ca8da13fd105a8bffbf848471fe939c3163b116264a0e166fab"
    ),
    # v2/v3 use explicit sealed catalogs; v1 SQL and financial mutations stay unchanged.
    "private_research_migration.py": (
        "2e1f01ba965dbc1e077b8f2f61d9027bd0aa8d2f9013bd9e7e4eb3172a14452a"
    ),
    "private_research_access.py": (
        "143a7e4800e3c1ebcf55d2cec250ec72f1d02cdc8b801a49bd8301b23f965962"
    ),
}


def test_fixed_assembly_bytes_and_two_function_surface():
    for name, expected in ASSEMBLY_FILES.items():
        assert sha256(SQL_PATH.with_name(name).read_bytes()).hexdigest() == expected
    assert (
        sha256(Path(base.__file__).read_bytes()).hexdigest()
        == "c692bdd1649c56981fff52c2f15d31d9f73fd5258d44da43209b965675faf338"
    )
    statements = sql_statements(SQL_PATH.read_text())
    assert sum("CREATE FUNCTION" in s for s in statements) == 2
    assert sum("SECURITY DEFINER SET search_path=pg_catalog" in s for s in statements) == 2
    assert not any(
        word in SQL_PATH.read_text().upper()
        for word in ["CREATE TABLE", "ALTER TABLE", "CREATE ROLE", "CREATE EXTENSION"]
    )


@pytest.fixture(scope="module")
def pg():
    with base.cluster() as owned:
        receipt = {
            "component": "PRIVATE_MUTATIONS_P2",
            "run_id": owned.run_id,
            "pid": owned.pid,
            "host": str(owned.alias),
            "tcp_listeners": 0,
            "real_secrets": 0,
            "cloud_io": 0,
        }
        (base.TASK / ("private-mutations-fixture-" + owned.run_id + ".json")).write_text(
            json.dumps(receipt, indent=2) + "\n"
        )
        yield owned


@contextmanager
def app(db, role="runtime"):
    pg, _, target, _ = db
    with pg.connect(user=getattr(target, role), dbname=target.database) as connection:
        with connection.transaction():
            connection.execute("SET LOCAL search_path=pg_catalog")
            connection.execute("SET LOCAL statement_timeout='4s'")
            # Full sealed install and role handshake occur in the fixture; drift is tested below.
            yield connection


def now(connection):
    return int(
        connection.execute(
            "SELECT floor(extract(epoch FROM clock_timestamp())*1000) AS n"
        ).fetchone()["n"]
    )


@pytest.fixture
def db(pg):
    target = base.target_database(pg)
    with pg.connect(user=target.owner, dbname=target.database) as owner:
        migration.install_private(owner, target=target)
        owner.execute("SET search_path=pg_catalog")
        for role in migration.CAPABILITIES:
            with base.app((pg, owner, target), role):
                pass
        assert len(migration.private_resources()) == 3
        assert migration.private_resources()[2] == SQL_PATH.read_text()
        catalog = migration.private_catalog_digest(owner)
        catalog_path = base.TASK / ("private-mutations-component-catalog-" + pg.run_id + ".json")
        if not catalog_path.exists():
            with catalog_path.open("x") as evidence:
                json.dump(
                    {
                        "component_catalog_sha256": catalog,
                        "sql_sha256": sha256(SQL_PATH.read_bytes()).hexdigest(),
                        "database_clock_ms": now(owner),
                        "run_id": pg.run_id,
                        "profile": "LOCAL_PG17_COMPLETE_SEAL",
                        "profile_validation_expected": "ACCEPT_ONLY_FIXED_FULL_CATALOG",
                    },
                    evidence,
                    indent=2,
                )
        else:
            assert json.loads(catalog_path.read_text())["component_catalog_sha256"] == catalog
        users = []
        result = (pg, owner, target, users)
        with app(result, "issuer") as issuer:
            for digit in ("a", "b"):
                users.append(base.identity(issuer, digit, now=now(owner)))
        current = now(owner)
        start, end = base.utc_month_bounds(current)
        owner.execute(
            "INSERT INTO astarter_private.global_budget VALUES(%s,%s,50000000,1000000,0,0,FALSE)",
            (start, end),
        )
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
                current - 1000,
                current + 120000,
            ),
        )
        for who in users:
            owner.execute(
                "INSERT INTO astarter_private.policies(month_start_ms,tenant_id,"
                "policy_id,model,token_limit,request_limit,limit_microusd,"
                "blocked) VALUES(%s,%s,%s,%s,130560,10,50000000,FALSE)",
                (start, who["subject"], "policy", base.MODEL),
            )
        yield result


def args(db, who=None, request="request-001", claim="c" * 64, fingerprint="f" * 64):
    _, owner, target, users = db
    current = now(owner)
    return (
        (who or users[0])["token"],
        "lease",
        target.target_id,
        request,
        fingerprint,
        claim,
        current,
        current + 30000,
    )


def claim(db, values=None):
    with app(db) as runtime:
        return runtime.execute(CLAIM, values or args(db)).fetchone()["result"]


def model_result():
    return {
        "method": "ai",
        "model": base.MODEL,
        "responseId": "synthetic-response",
        "usage": {"inputTokens": 120, "outputTokens": 30, "totalTokens": 150},
        "billing": None,
        "output": {
            "outcome": "watch",
            "headline": "synthetic",
            "summary": "synthetic only",
            "claims": [{"text": "synthetic", "evidenceIds": ["market-synthetic"]}],
        },
        "sources": [{"id": "market-synthetic"}],
        "missingDimensions": ["depth", "macro", "social", "chain", "risk"],
        "createdAt": int(time.time() * 1000),
        "validUntil": int(time.time() * 1000) + 60000,
        "executionAuthority": "NONE",
        "methodVersion": "closed-market-research-v1",
    }


def finish_args(
    db, *, state="complete", tokens=150, result=None, error=None, who=None, claim_digest="c" * 64
):
    values = args(db, who)
    if state == "complete" and result is None:
        result = model_result()
    return values[:4] + (
        claim_digest,
        state,
        tokens,
        json.dumps(result) if result is not None else None,
        error,
    )


def finish(db, values):
    with app(db) as runtime:
        return runtime.execute(FINISH, values).fetchone()["result"]


def counters(db):
    return (
        db[1]
        .execute("SELECT held_microusd,spent_microusd FROM astarter_private.global_budget")
        .fetchone()
    )


@base.native
def test_atomic_claim_and_complete_does_not_settle(db):
    assert claim(db) == {"acquired": True}
    assert counters(db) == {"held_microusd": 20890, "spent_microusd": 0}
    values = finish_args(db)
    result = finish(db, values)
    assert result["state"] == "complete" and result["result"]["executionAuthority"] == "NONE"
    assert finish(db, values) == result
    assert counters(db) == {"held_microusd": 20890, "spent_microusd": 0}
    row = (
        db[1]
        .execute(
            "SELECT held_tokens,spent_tokens,request_count FROM "
            "astarter_private.policies WHERE tenant_id=%s",
            (db[3][0]["subject"],),
        )
        .fetchone()
    )
    assert row == {"held_tokens": 13056, "spent_tokens": 0, "request_count": 1}
    assert db[1].execute("SELECT settled_microusd FROM astarter_private.requests").fetchone() == {
        "settled_microusd": None
    }
    assert not any(
        key in json.dumps(result)
        for key in ["claim_digest", "session_digest", "claimDigest", "claimToken", "token_digest"]
    )


@base.native
def test_new_catalog_and_only_runtime_execute(db):
    _, owner, target, _ = db
    assert migration.private_catalog_digest(owner) == migration.LOCAL_CATALOG_PIN
    with app(db) as runtime:
        verify_private_access(runtime, target=target, role="runtime")
    functions = owner.execute(
        "SELECT p.proname,p.prosecdef,p.proconfig,"
        "pg_get_userbyid(p.proowner) AS owner FROM pg_proc p JOIN "
        "pg_namespace n ON n.oid=p.pronamespace WHERE "
        "n.nspname='astarter_private' AND p.proname IN ('claim_research',"
        "'finish_research') ORDER BY p.proname"
    ).fetchall()
    assert functions == [
        dict(proname=name, prosecdef=True, proconfig=["search_path=pg_catalog"], owner=target.owner)
        for name in ["claim_research", "finish_research"]
    ]
    for role in ("issuer", "cost"):
        with app(db, role) as connection:
            base.execute_failure(connection, CLAIM, args(db))
    with app(db) as runtime:
        base.execute_failure(runtime, "UPDATE astarter_private.global_budget SET held_microusd=0")
        base.execute_failure(runtime, "UPDATE astarter_private.requests SET state=%s", ("failed",))
    owner.execute(
        "CREATE FUNCTION astarter_private.unreviewed() RETURNS INT LANGUAGE SQL AS 'SELECT 1'"
    )
    assert migration.private_catalog_digest(owner) != migration.LOCAL_CATALOG_PIN
    with app(db) as runtime, pytest.raises(AccessRejected):
        verify_private_access(runtime, target=target, role="runtime")


@base.native
def test_same_id_concurrent_exactly_one_claim(db):
    barrier = Barrier(2)
    current = args(db)

    def take(digit):
        with app(db) as connection:
            barrier.wait(timeout=2)
            return connection.execute(CLAIM, current[:5] + (digit * 64,) + current[6:]).fetchone()[
                "result"
            ]

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(take, ["c", "d"]))
    assert sum(row["acquired"] for row in results) == 1
    previous = next(row for row in results if not row["acquired"])["record"]
    assert previous["state"] == "pending" and previous["subjectId"] == db[3][0]["subject"]
    assert counters(db) == dict(held_microusd=20890, spent_microusd=0)
    assert db[1].execute("SELECT count(*) AS n FROM astarter_private.requests").fetchone() == {
        "n": 1
    }
    with pytest.raises(psycopg.Error, match="PRIVATE_CONFLICT"):
        claim(db, args(db, fingerprint="e" * 64))
    assert "c" * 64 not in json.dumps(results) and "d" * 64 not in json.dumps(results)


@base.native
def test_two_tenants_share_one_global_cap_concurrently(db):
    db[1].execute("UPDATE astarter_private.global_budget SET fixed_service_microusd=49979110")
    barrier = Barrier(2)

    def take(index):
        values = args(db, db[3][index], claim=("c" if index == 0 else "d") * 64)
        with app(db) as connection:
            barrier.wait(timeout=2)
            return connection.execute(CLAIM, values).fetchone()["result"]

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(take, [0, 1]))
    assert sorted(results, key=lambda row: row["acquired"]) == [
        {"acquired": False, "code": "BUDGET_EXCEEDED"},
        {"acquired": True},
    ]
    assert counters(db) == dict(held_microusd=20890, spent_microusd=0)
    assert db[1].execute(
        "SELECT sum(request_count) AS n,sum(held_tokens) AS tokens FROM astarter_private.policies"
    ).fetchone() == {"n": 1, "tokens": 13056}


@base.native
@pytest.mark.parametrize(
    "mutation",
    [
        "UPDATE astarter_private.global_budget SET blocked=TRUE",
        "UPDATE astarter_private.global_budget SET blocked=TRUE,fixed_service_microusd=NULL",
        "UPDATE astarter_private.global_budget SET fixed_service_microusd=49979111",
        "UPDATE astarter_private.policies SET token_limit=13056,spent_tokens=1",
        "UPDATE astarter_private.policies SET request_limit=1,request_count=1",
        "UPDATE astarter_private.policies SET limit_microusd=20889",
    ],
)
def test_insufficient_budget_never_inserts_or_partially_reserves(db, mutation):
    db[1].execute(mutation)
    assert claim(db) == dict(acquired=False, code="BUDGET_EXCEEDED")
    assert counters(db) == dict(held_microusd=0, spent_microusd=0)
    assert db[1].execute("SELECT * FROM astarter_private.requests").fetchall() == []


@base.native
@pytest.mark.parametrize(
    "field,value",
    [
        (0, "0" * 64),
        (1, "wrong"),
        (2, "wrong"),
        (3, "bad'; SELECT 1"),
        (4, "not-digest"),
        (5, "a" * 63),
        (6, True),
        (6, -1),
        (6, "1.5"),
        (6, None),
        (7, True),
        (7, -1),
        (7, "1.5"),
        (7, None),
    ],
)
def test_claim_bad_identity_types_and_dates_fail_before_reservation(db, field, value):
    values = list(args(db))
    values[field] = value
    with pytest.raises(psycopg.Error):
        claim(db, values)
    assert counters(db) == dict(held_microusd=0, spent_microusd=0)
    assert db[1].execute("SELECT * FROM astarter_private.requests").fetchall() == []


@base.native
@pytest.mark.parametrize(
    "which", ["old_created", "future_created", "expired", "beyond_lease", "wrong_current_month"]
)
def test_claim_db_clock_and_expiry(db, which):
    values = list(args(db))
    if which == "old_created":
        values[6] -= 6000
    elif which == "future_created":
        values[6] += 6000
    elif which == "expired":
        values[7] = values[6] - 1
    elif which == "beyond_lease":
        values[7] = values[6] + 200000
    else:
        db[1].execute("UPDATE astarter_private.global_budget SET blocked=TRUE")
        # Caller cannot select an arbitrary historical month by supplying its clock.
        values[6] = base.utc_month_bounds(values[6])[0] - 1
    with pytest.raises(psycopg.Error, match="SCOPE_EXPIRED"):
        claim(db, values)
    assert counters(db) == dict(held_microusd=0, spent_microusd=0)


@base.native
@pytest.mark.parametrize(
    "state,tokens,error", [("unknown", None, "MODEL_TIMEOUT"), ("failed", 0, "EVIDENCE_INVALID")]
)
def test_unknown_and_failed_hold_and_never_redispatch(db, state, tokens, error):
    assert claim(db) == {"acquired": True}
    values = finish_args(db, state=state, tokens=tokens, error=error)
    record = finish(db, values)
    assert record["state"] == state and record["queryOriginalRequest"] == (state == "unknown")
    assert finish(db, values) == record
    assert claim(db, args(db, claim="d" * 64)) == {"acquired": False, "record": record}
    assert counters(db) == dict(held_microusd=20890, spent_microusd=0)
    assert db[1].execute(
        "SELECT held_tokens,spent_tokens FROM astarter_private.policies WHERE tenant_id=%s",
        (db[3][0]["subject"],),
    ).fetchone() == dict(held_tokens=13056, spent_tokens=0)
    with pytest.raises(psycopg.Error, match="PRIVATE_CONFLICT"):
        finish(db, finish_args(db))


@base.native
def test_claim_and_finish_transaction_rollback(db):
    with pytest.raises(RuntimeError, match="synthetic rollback"):
        with app(db) as runtime:
            assert runtime.execute(CLAIM, args(db)).fetchone()["result"] == {"acquired": True}
            raise RuntimeError("synthetic rollback")
    assert counters(db) == dict(held_microusd=0, spent_microusd=0)
    assert claim(db) == {"acquired": True}
    with pytest.raises(RuntimeError, match="synthetic rollback"):
        with app(db) as runtime:
            runtime.execute(FINISH, finish_args(db))
            raise RuntimeError("synthetic rollback")
    assert db[1].execute("SELECT state FROM astarter_private.requests").fetchone() == {
        "state": "pending"
    }
    assert counters(db) == dict(held_microusd=20890, spent_microusd=0)


@base.native
@pytest.mark.parametrize(
    "field,value",
    [
        (4, "d" * 64),
        (5, "pending"),
        (6, -1),
        (6, True),
        (6, "0.5"),
        (6, 13057),
        (8, "PASSWORD_CANARY_NEVER_ECHO"),
    ],
)
def test_finish_bad_claim_or_input_keeps_pending(db, field, value):
    assert claim(db) == {"acquired": True}
    values = list(finish_args(db))
    values[field] = value
    with pytest.raises(psycopg.Error):
        finish(db, values)
    assert db[1].execute("SELECT state FROM astarter_private.requests").fetchone() == {
        "state": "pending"
    }
    assert counters(db) == dict(held_microusd=20890, spent_microusd=0)


@base.native
@pytest.mark.parametrize(
    "kind",
    [
        "model",
        "authority",
        "method_null",
        "usage_bool",
        "usage_negative",
        "usage_fraction",
        "usage_mismatch",
        "too_many",
        "output_limit",
        "billing_bool",
        "billing_negative",
        "billing_fraction",
        "unknown_key",
        "missing_key",
        "too_large",
        "empty_output",
        "empty_claims",
        "unbound_evidence",
    ],
)
def test_complete_result_validation(db, kind):
    assert claim(db) == {"acquired": True}
    result = model_result()
    if kind == "model":
        result["model"] = "other"
    elif kind == "authority":
        result["executionAuthority"] = "EXECUTE"
    elif kind == "method_null":
        result["method"] = None
    elif kind == "usage_bool":
        result["usage"]["inputTokens"] = True
    elif kind == "usage_negative":
        result["usage"]["inputTokens"] = -1
    elif kind == "usage_fraction":
        result["usage"]["inputTokens"] = 120.5
    elif kind == "usage_mismatch":
        result["usage"]["totalTokens"] = 151
    elif kind == "too_many":
        result["usage"] = {"inputTokens": 13056, "outputTokens": 1, "totalTokens": 13057}
    elif kind == "output_limit":
        result["usage"] = {"inputTokens": 0, "outputTokens": 801, "totalTokens": 801}
    elif kind in {"billing_bool", "billing_negative", "billing_fraction"}:
        result["billing"] = {
            "provider": "openrouter",
            "model": base.MODEL,
            "responseId": result["responseId"],
            "costMicrousd": {"billing_bool": True, "billing_negative": -1, "billing_fraction": 0.5}[
                kind
            ],
            "isByok": False,
        }
    elif kind == "unknown_key":
        result["headers"] = {"Authorization": "SYNTHETIC_CANARY"}
    elif kind == "missing_key":
        del result["model"]
    elif kind == "empty_output":
        result["output"] = {}
    elif kind == "empty_claims":
        result["output"]["claims"] = []
    elif kind == "unbound_evidence":
        result["output"]["claims"][0]["evidenceIds"] = ["other"]
    else:
        result["output"]["summary"] = "x" * 65536
    with pytest.raises(psycopg.Error):
        finish(db, finish_args(db, result=result))
    assert db[1].execute("SELECT state FROM astarter_private.requests").fetchone() == {
        "state": "pending"
    }


@base.native
def test_subject_and_session_claim_cannot_be_swapped(db):
    assert claim(db) == {"acquired": True}
    with pytest.raises(psycopg.Error, match="REQUEST_NOT_FOUND"):
        finish(db, finish_args(db, who=db[3][1]))
    # A separate valid session for the same wallet must not finish another session's claim.
    who = db[3][0]
    current = now(db[1])
    with app(db, "issuer") as issuer:
        other = base.identity(issuer, "c", now=current, issue=False)
        # Bind a new challenge to this wallet through the same fixed issuer columns.
        # Its already prepared address cannot be changed; create another fresh challenge.
        challenge = "d" * 64
        token = "e" * 64
        claim_digest = "9" * 64
        issuer.execute(
            "INSERT INTO astarter_private.challenges(challenge_hash,nonce,"
            "origin,issued_at_ms,expires_at_ms) VALUES(%s,%s,%s,%s,%s)",
            (challenge, "8" * 64, base.ORIGIN, current - 1000, current + 299000),
        )
        issuer.execute(
            "UPDATE astarter_private.challenges SET address=%s,chain_id=56,"
            "message=%s,prepared_at_ms=%s,claim_digest=%s,consumed_at_ms=%s "
            "WHERE challenge_hash=%s",
            (who["address"], "synthetic", current - 900, claim_digest, current - 800, challenge),
        )
        issuer.execute(
            "INSERT INTO astarter_private.sessions VALUES(%s,%s,%s,%s,56,%s,"
            "%s,%s,%s,%s,%s,%s,NULL)",
            (
                token,
                challenge,
                claim_digest,
                who["address"],
                base.ORIGIN,
                who["subject"],
                who["subject"],
                "astarter-research",
                ["research:analyze"],
                current - 700,
                current - 700 + 604800000,
            ),
        )
    assert other["subject"] != who["subject"]
    values = list(finish_args(db))
    values[0] = token
    with pytest.raises(psycopg.Error, match="PRIVATE_CONFLICT"):
        finish(db, values)
    assert counters(db) == dict(held_microusd=20890, spent_microusd=0)


@base.native
@pytest.mark.parametrize("operation", ["claim", "finish"])
def test_revocation_serializes_before_mutation(db, operation):
    if operation == "finish":
        assert claim(db) == {"acquired": True}
    started = Event()
    backend = []
    values = args(db) if operation == "claim" else finish_args(db)
    statement = CLAIM if operation == "claim" else FINISH

    def mutate():
        with pytest.raises(psycopg.Error, match="AUTH_REQUIRED"), app(db) as runtime:
            backend.append(runtime.info.backend_pid)
            started.set()
            runtime.execute(statement, values)

    with ThreadPoolExecutor(max_workers=1) as pool:
        with app(db, "issuer") as issuer:
            issuer.execute(
                "UPDATE astarter_private.sessions SET revoked_at_ms=%s WHERE token_digest=%s",
                (now(db[1]), db[3][0]["token"]),
            )
            future = pool.submit(mutate)
            assert started.wait(2)
            deadline = time.monotonic() + 1
            with db[0].connect() as admin:
                while time.monotonic() < deadline:
                    if admin.execute(
                        "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity "
                        "WHERE pid=%s",
                        (backend[0],),
                    ).fetchone() == {"waiting": True}:
                        break
                    time.sleep(0.01)
                else:
                    raise AssertionError("NATIVE_SESSION_LOCK_NOT_OBSERVED")
        future.result(timeout=4)
    assert counters(db) == dict(
        held_microusd=20890 if operation == "finish" else 0, spent_microusd=0
    )
    assert db[1].execute("SELECT state FROM astarter_private.requests").fetchall() == (
        [{"state": "pending"}] if operation == "finish" else []
    )


@base.native
def test_cost_settlement_after_finish_is_only_release(db):
    assert claim(db) == {"acquired": True}
    values = finish_args(db)
    result = json.loads(values[7])
    result["billing"] = {
        "provider": "openrouter",
        "responseId": result["responseId"],
        "model": base.MODEL,
        "costMicrousd": 0,
        "isByok": False,
    }
    values = values[:7] + (json.dumps(result), None)
    finish(db, values)
    assert counters(db) == dict(held_microusd=20890, spent_microusd=0)
    with app(db, "cost") as cost:
        who = db[3][0]["subject"]
        assert cost.execute(
            "SELECT astarter_private.settle_cost(%s,%s,%s,%s,%s,%s) AS settled",
            ("trusted-receipt", who, who, "request-001", 30000, 150),
        ).fetchone() == {"settled": True}
    assert finish(db, values)["state"] == "complete"
    assert counters(db) == dict(held_microusd=0, spent_microusd=30000)
    assert db[1].execute(
        "SELECT held_tokens,spent_tokens FROM astarter_private.policies WHERE tenant_id=%s",
        (db[3][0]["subject"],),
    ).fetchone() == dict(held_tokens=0, spent_tokens=150)
    assert claim(db, args(db, request="request-002", claim="d" * 64)) == {
        "acquired": False,
        "code": "BUDGET_EXCEEDED",
    }


@base.native
def test_expired_pending_returns_original_without_dispatch_or_refund(db):
    values = list(args(db))
    values[7] = values[6] + 200
    assert claim(db, values) == {"acquired": True}
    deadline = time.monotonic() + 1
    while now(db[1]) <= values[7] and time.monotonic() < deadline:
        time.sleep(0.01)
    assert now(db[1]) > values[7]
    # Readback wins over blocked budget and new proposed timestamps/token.
    db[1].execute("UPDATE astarter_private.global_budget SET blocked=TRUE")
    original = claim(db, args(db, claim="d" * 64))
    assert original["acquired"] is False and original["record"]["state"] == "pending"
    assert original["record"]["queryOriginalRequest"] is True
    with pytest.raises(psycopg.Error, match="SCOPE_EXPIRED"):
        finish(db, finish_args(db))
    assert counters(db) == dict(held_microusd=20890, spent_microusd=0)


@base.native
def test_expiry_rechecked_after_global_lock_wait(db):
    values = list(args(db))
    values[7] = values[6] + 300
    started = Event()
    backend = []

    def waiting_claim():
        with pytest.raises(psycopg.Error, match="SCOPE_EXPIRED"), app(db) as runtime:
            backend.append(runtime.info.backend_pid)
            started.set()
            runtime.execute(CLAIM, values)

    with ThreadPoolExecutor(max_workers=1) as pool:
        with db[1].transaction():
            db[1].execute("SELECT 1 FROM astarter_private.global_budget FOR UPDATE")
            future = pool.submit(waiting_claim)
            assert started.wait(2)
            deadline = time.monotonic() + 1
            with db[0].connect() as admin:
                while time.monotonic() < deadline:
                    if admin.execute(
                        "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity "
                        "WHERE pid=%s",
                        (backend[0],),
                    ).fetchone() == {"waiting": True}:
                        break
                    time.sleep(0.01)
                else:
                    raise AssertionError("GLOBAL_LOCK_WAIT_NOT_OBSERVED")
            while now(db[1]) <= values[7] and time.monotonic() < deadline:
                time.sleep(0.01)
            assert now(db[1]) > values[7]
        future.result(timeout=4)
    assert counters(db) == dict(held_microusd=0, spent_microusd=0)
    assert db[1].execute("SELECT * FROM astarter_private.requests").fetchall() == []


@base.native
@pytest.mark.parametrize("kind", ["session", "lease"])
def test_expired_identity_or_lease(db, kind):
    values = list(args(db))
    if kind == "session":
        with app(db, "issuer") as issuer:
            expired = base.identity(issuer, "e", now=now(db[1]) - 604800001)
        values[0] = expired["token"]
    else:
        db[1].execute("UPDATE astarter_private.leases SET expires_at_ms=%s", (now(db[1]) - 1,))
    with pytest.raises(psycopg.Error, match="AUTH_REQUIRED|SCOPE_EXPIRED"):
        claim(db, values)
    assert counters(db) == dict(held_microusd=0, spent_microusd=0)
