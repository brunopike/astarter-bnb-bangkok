"""PRIVATE v1: new Unix-only owned PG17; never discover existing services or credentials."""

import importlib.util
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql

from stark_trading_os.control.postgres import private_research_migration as m
from stark_trading_os.control.postgres.access import AccessRejected
from stark_trading_os.control.postgres.private_research_access import verify_private_access
from stark_trading_os.control.postgres.private_research_contracts import utc_month_bounds
from stark_trading_os.control.postgres.synthetic_migration import TargetProfile, sql_statements

TASK = Path(
    "/Users/mac/Documents/AI "
    "Space/Developer/交易大法/任务/01a15fe7_Lego原生能力验证/private-backend-r2-20"
    "261116"
)
HARNESS = TASK.parent / "r2-4-live-l1-20261116/lane-b-public-db/test_owner_provision.py"
HARNESS_SHA = "06193265aff464fbd2a60d9a26f5160ee478b2b866015207cc08cf7a01d85291"
native = pytest.mark.skipif(
    os.environ.get("PRIVATE_RESEARCH_OWNED_PG") != "1", reason="explicit new owned PG17 only"
)
ORIGIN = "https://astarter.imstark.site"
MODEL = "openai/gpt-4.1-mini"


@contextmanager
def cluster():
    assert sha256(HARNESS.read_bytes()).hexdigest() == HARNESS_SHA
    spec = importlib.util.spec_from_file_location("private_owned_fixture", HARNESS)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(HARNESS.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.pop(0)
    module.LANE = TASK
    pg = module.OwnedOwnerPG(password_auth=False)
    original_run = subprocess.run

    def child_run(*args, **kwargs):
        if Path(args[0][0]).parent == module.PG_BIN:
            kwargs["env"] = {"PATH": "/opt/homebrew/bin:/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
        return original_run(*args, **kwargs)

    with patch.object(module.subprocess, "run", child_run):
        try:
            pg.start()
            with pg.connect() as admin:
                for cap in m.CAPABILITIES.values():
                    admin.execute(sql.SQL("CREATE ROLE {} NOLOGIN").format(sql.Identifier(cap)))
            yield pg
        finally:
            pg.stop()


def target_database(pg):
    prefix = "private_" + uuid4().hex[:10]
    names = {key: prefix + "_" + key for key in ("owner", "runtime", "issuer", "cost")}
    with pg.connect() as admin:
        for role in names.values():
            admin.execute(sql.SQL("CREATE ROLE {} LOGIN").format(sql.Identifier(role)))
        for role, cap in m.CAPABILITIES.items():
            admin.execute(
                sql.SQL("GRANT {} TO {}").format(sql.Identifier(cap), sql.Identifier(names[role]))
            )
        admin.execute(
            sql.SQL("CREATE DATABASE {} OWNER {} TEMPLATE template0").format(
                sql.Identifier(prefix), sql.Identifier(names["owner"])
            )
        )
    target = m.PrivateTarget(
        TargetProfile.LOCAL_PG17,
        str(pg.alias),
        pg.port,
        prefix,
        **names,
        target_id="PRIVATE_LOCAL_SYNTHETIC",
    )
    return target


@pytest.fixture(scope="module")
def pg():
    with cluster() as owned:
        yield owned


@pytest.fixture
def db(pg):
    target = target_database(pg)
    with pg.connect(user=target.owner, dbname=target.database) as owner:
        m.install_private(owner, target=target)
        owner.execute("SET search_path=pg_catalog")
        yield pg, owner, target


@contextmanager
def app(db, role):
    pg, _, target = db
    with pg.connect(user=getattr(target, role), dbname=target.database) as connection:
        with connection.transaction():
            connection.execute("SET LOCAL search_path=pg_catalog")
            verify_private_access(connection, target=target, role=role)
            yield connection


def execute_failure(connection, statement, params=()):
    with pytest.raises(psycopg.Error):
        with connection.transaction():
            connection.execute(statement, params)


def identity(connection, digit="a", *, now=None, issue=True):
    now = int(time.time() * 1000) if now is None else now
    challenge, claim, token = (
        digit * 64,
        sha256((digit + "claim").encode()).hexdigest(),
        sha256((digit + "token").encode()).hexdigest(),
    )
    address = "0x" + digit * 40
    subject = "wallet:56:" + address
    connection.execute(
        "INSERT INTO astarter_private.challenges(challenge_hash,nonce,"
        "origin,issued_at_ms,expires_at_ms) VALUES(%s,%s,%s,%s,%s)",
        (
            challenge,
            sha256((digit + "nonce").encode()).hexdigest(),
            ORIGIN,
            now - 1000,
            now + 299000,
        ),
    )
    connection.execute(
        "UPDATE astarter_private.challenges SET address=%s,chain_id=56,"
        "message=%s,prepared_at_ms=%s WHERE challenge_hash=%s",
        (address, "public SIWE synthetic message " + digit, now - 900, challenge),
    )
    connection.execute(
        "UPDATE astarter_private.challenges SET claim_digest=%s,"
        "consumed_at_ms=%s WHERE challenge_hash=%s",
        (claim, now - 800, challenge),
    )
    if issue:
        connection.execute(
            "INSERT INTO astarter_private.sessions VALUES(%s,%s,%s,%s,56,%s,"
            "%s,%s,%s,%s,%s,%s,NULL)",
            (
                token,
                challenge,
                claim,
                address,
                ORIGIN,
                subject,
                subject,
                "astarter-research",
                ["research:analyze"],
                now - 700,
                now - 700 + 604800000,
            ),
        )
    return dict(
        challenge=challenge, claim=claim, token=token, address=address, subject=subject, now=now
    )


def accounting(db, digit="a"):
    _, owner, target = db
    with app(db, "issuer") as issuer:
        who = identity(issuer, digit)
    start, end = utc_month_bounds(who["now"])
    owner.execute(
        "INSERT INTO astarter_private.global_budget VALUES(%s,%s,50000000,"
        "1000000,20890,0,FALSE) ON CONFLICT DO NOTHING",
        (start, end),
    )
    owner.execute(
        "INSERT INTO astarter_private.leases VALUES(%s,%s,%s,%s,%s,%s,%s,"
        "%s,%s,%s) ON CONFLICT DO NOTHING",
        (
            "lease",
            target.target_id,
            target.database,
            target.runtime,
            target.profile.value,
            "astarter-research",
            MODEL,
            "policy",
            who["now"] - 1000,
            who["now"] + 60000,
        ),
    )
    owner.execute(
        "INSERT INTO astarter_private.policies VALUES(%s,%s,%s,%s,100000,"
        "10,5000000,13056,0,1,20890,0,FALSE)",
        (start, who["subject"], "policy", MODEL),
    )
    owner.execute(
        "INSERT INTO astarter_private.requests(tenant_id,subject_id,"
        "request_id,session_digest,lease_id,month_start_ms,policy_id,"
        "fingerprint,claim_digest,reserved_tokens,reserved_microusd,"
        "created_at_ms,expires_at_ms) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,"
        "13056,20890,%s,%s)",
        (
            who["subject"],
            who["subject"],
            "request-001",
            who["token"],
            "lease",
            start,
            "policy",
            "f" * 64,
            sha256((digit + "requestclaim").encode()).hexdigest(),
            who["now"],
            who["now"] + 60000,
        ),
    )
    who["month"] = start
    return who


def test_resources_sealed_and_types():
    assert len(m.private_resources()) == 3
    assert len(m.private_profile_pins(TargetProfile.LOCAL_PG17)) == 2
    assert m.private_profile_pins(TargetProfile.NEON_PG17_V1) == (
        "7ef54546eb99777c47c19d269884e526c5e41fa9c0299f7a79f6aa3b3c838ab6",
        "e340cdbd1fc2e88ac1654cdd5815c5f246247246d355f5605184ce6d1bf2137d",
    )
    with pytest.raises(AccessRejected, match="INVALID"):
        m.private_profile_pins("LOCAL_PG17")
    with (
        patch.object(m, "RESOURCE_SHA256", "0" * 64),
        pytest.raises(AccessRejected, match="RESOURCE"),
    ):
        m.private_resources()


@pytest.mark.parametrize("field", ["NEON_EMPTY_PIN", "NEON_CATALOG_PIN"])
def test_unverified_neon_pin_still_refuses_without_affecting_local(field):
    local = m.private_profile_pins(TargetProfile.LOCAL_PG17)
    with patch.object(m, field, "not-a-reviewed-pin"):
        with pytest.raises(AccessRejected, match="PRIVATE_PROFILE_UNVERIFIED"):
            m.private_profile_pins(TargetProfile.NEON_PG17_V1)
        assert m.private_profile_pins(TargetProfile.LOCAL_PG17) == local


class _TLSConnection(psycopg.Connection):
    def __init__(self, target, tls, params):
        self.transactions = 0
        self.parameter_reads = 0
        self._params = params
        self._pg = SimpleNamespace(
            ssl_in_use=tls, transaction_status=psycopg.pq.TransactionStatus.IDLE
        )
        self._info = SimpleNamespace(
            host=target.host, port=target.port, dbname=target.database, user=target.owner,
            get_parameters=self.parameters,
        )

    def parameters(self):
        self.parameter_reads += 1
        return self._params

    closed = property(lambda self: False)
    autocommit = property(lambda self: True)
    info = property(lambda self: self._info)
    pgconn = property(lambda self: self._pg)

    def transaction(self):
        self.transactions += 1
        raise AssertionError("TLS_GATE_REACHED_TRANSACTION")

    def __del__(self):
        pass


@pytest.mark.parametrize(
    "weak", ["tls", "disable", "require", "binding", "missing_binding", "ca", "missing_ca", None]
)
def test_neon_owner_tls_rejected_before_transaction(weak):
    target = m.PrivateTarget(
        TargetProfile.NEON_PG17_V1, "ep-fixture.region.aws.neon.tech", 5432,
        "private_fixture", "fixture_owner", "fixture_runtime", "fixture_issuer", "fixture_cost",
        "PRIVATE_NEON_FIXTURE",
    )
    params = {"sslmode": "verify-full", "channel_binding": "require", "sslrootcert": "system"}
    if weak in {"disable", "require"}:
        params["sslmode"] = weak
    elif weak == "binding":
        params["channel_binding"] = "prefer"
    elif weak == "missing_binding":
        del params["channel_binding"]
    elif weak == "ca":
        params["sslrootcert"] = "other-ca"
    elif weak == "missing_ca":
        del params["sslrootcert"]
    connection = _TLSConnection(target, weak != "tls", params)
    if weak is None:
        m.check_connection(connection, target, target.owner)
        assert connection.parameter_reads == 1
    else:
        with pytest.raises(AccessRejected, match="PRIVATE_CONNECTION_REJECTED"):
            m.install_private(connection, target=target)
    assert connection.transactions == 0


@pytest.mark.parametrize(
    "field,value",
    [
        ("owner", "bad;DROP ROLE x"),
        ("runtime", "r\x00"),
        ("port", True),
        ("port", 0),
        ("host", "127.0.0.1"),
        ("target_id", "x\n"),
        ("database", "x" * 64),
    ],
)
def test_target_invalid(field, value):
    kwargs = dict(
        profile=TargetProfile.LOCAL_PG17,
        host="/tmp/owned",
        port=5432,
        database="db",
        owner="o",
        runtime="r",
        issuer="i",
        cost="c",
        target_id="synthetic",
    )
    kwargs[field] = value
    with pytest.raises(AccessRejected):
        m.PrivateTarget(**kwargs)


@native
def test_install_replay_all_role_handshakes_and_mismatch(db):
    pg, owner, target = db
    m.install_private(owner, target=target)
    for role in m.CAPABILITIES:
        with app(db, role):
            pass
    with pytest.raises(AccessRejected, match="CONNECTION"):
        m.install_private(owner, target=replace(target, database="other"))
    with pytest.raises(AccessRejected, match="METADATA"):
        m.install_private(owner, target=replace(target, target_id="WRONG"))
    with pytest.raises(AccessRejected, match="PRIVATE_CONNECTION_REJECTED"):
        m.install_private(
            owner,
            target=replace(
                target, profile=TargetProfile.NEON_PG17_V1, host="ep-fake.region.aws.neon.tech"
            ),
        )
    with owner.transaction(), pytest.raises(AccessRejected, match="TRANSACTION"):
        m.install_private(owner, target=target)
    with pg.connect(user=target.runtime, dbname=target.database) as runtime:
        with pytest.raises(AccessRejected):
            m.install_private(runtime, target=target)


@native
@pytest.mark.parametrize(
    "mutation",
    [
        "CREATE TABLE astarter_private.extra(x INTEGER)",
        "CREATE DOMAIN astarter_private.extra AS TEXT",
        "GRANT SELECT ON astarter_private.sessions TO astarter_private_runtime",
        "GRANT UPDATE(limit_microusd) ON astarter_private.global_budget TO astarter_private_cost",
        "ALTER POLICY request_owner ON astarter_private.requests TO astarter_private_issuer",
        "GRANT EXECUTE ON FUNCTION astarter_private.settle_cost(TEXT,TEXT,"
        "TEXT,TEXT,NUMERIC,NUMERIC) TO PUBLIC",
    ],
)
def test_catalog_and_acl_drift_rejected(db, mutation):
    pg, owner, target = db
    owner.execute(mutation)
    with pytest.raises(AccessRejected):
        with app(db, "runtime"):
            pass
    with pytest.raises(AccessRejected):
        m.install_private(owner, target=target)


@native
def test_nonempty_target_not_migrated(pg):
    target = target_database(pg)
    with pg.connect(user=target.owner, dbname=target.database) as owner:
        owner.execute("CREATE TABLE public.extra(x INTEGER)")
        with pytest.raises(AccessRejected, match="EMPTY"):
            m.install_private(owner, target=target)
        assert owner.execute("SELECT to_regnamespace('astarter_private') AS n").fetchone() == {
            "n": None
        }


@native
def test_identity_and_research_isolation(db):
    first = accounting(db, "a")
    second = accounting(db, "b")
    with app(db, "runtime") as runtime:
        assert runtime.execute("SELECT * FROM astarter_private.requests").fetchall() == []
        runtime.execute(
            "SELECT set_config('astarter_private.tenant_id',%s,TRUE)", (first["subject"],)
        )
        assert runtime.execute("SELECT * FROM astarter_private.requests").fetchall() == []
        runtime.execute(
            "SELECT set_config('astarter_private.session_digest',%s,TRUE)", (first["token"],)
        )
        assert runtime.execute("SELECT subject_id FROM astarter_private.requests").fetchall() == [
            {"subject_id": first["subject"]}
        ]
        assert runtime.execute("SELECT tenant_id FROM astarter_private.policies").fetchall() == [
            {"tenant_id": first["subject"]}
        ]
        assert (
            runtime.execute(
                "SELECT * FROM astarter_private.resolve_session(%s,%s)", (first["token"], "wrong")
            ).fetchall()
            == []
        )
        for statement in [
            "SELECT * FROM astarter_private.sessions",
            "SELECT * FROM astarter_private.challenges",
            "UPDATE astarter_private.global_budget SET limit_microusd=50000000",
            "DELETE FROM astarter_private.requests",
            "INSERT INTO astarter_private.challenges DEFAULT VALUES",
            "SELECT astarter_private.settle_cost('x','x','x','x',0,0)",
        ]:
            execute_failure(runtime, statement)
    with app(db, "issuer") as issuer:
        execute_failure(issuer, "SELECT * FROM astarter_private.requests")
        issuer.execute(
            "UPDATE astarter_private.challenges SET revoked_at_ms=%s WHERE challenge_hash=%s",
            (first["now"] + 1, first["challenge"]),
        )
    with app(db, "runtime") as runtime:
        assert (
            runtime.execute(
                "SELECT * FROM astarter_private.resolve_session(%s,%s)",
                (first["token"], "astarter-research"),
            ).fetchall()
            == []
        )
        assert (
            len(
                runtime.execute(
                    "SELECT * FROM astarter_private.resolve_session(%s,%s)",
                    (second["token"], "astarter-research"),
                ).fetchall()
            )
            == 1
        )


@native
def test_challenge_binding_claim_and_session_rejects(db):
    with app(db, "issuer") as issuer:
        who = identity(issuer)
        execute_failure(
            issuer,
            "UPDATE astarter_private.challenges SET address=%s WHERE challenge_hash=%s",
            ("0x" + "b" * 40, who["challenge"]),
        )
        execute_failure(
            issuer,
            "UPDATE astarter_private.challenges SET claim_digest=%s WHERE challenge_hash=%s",
            ("b" * 64, who["challenge"]),
        )
        execute_failure(
            issuer,
            "INSERT INTO astarter_private.sessions SELECT %s,challenge_hash,"
            "claim_digest,verified_address,chain_id,origin,subject_id,"
            "tenant_id,audience,permissions,not_before_ms,expires_at_ms,"
            "revoked_at_ms FROM astarter_private.sessions WHERE "
            "token_digest=%s",
            ("b" * 64, who["token"]),
        )
        execute_failure(
            issuer,
            "UPDATE astarter_private.sessions SET subject_id='forged' WHERE token_digest=%s",
            (who["token"],),
        )
        issuer.execute(
            "UPDATE astarter_private.challenges SET revoked_at_ms=%s WHERE challenge_hash=%s",
            (who["now"], who["challenge"]),
        )
        issuer.execute(
            "UPDATE astarter_private.challenges SET revoked_at_ms=%s WHERE challenge_hash=%s",
            (who["now"], who["challenge"]),
        )
        execute_failure(
            issuer,
            "UPDATE astarter_private.challenges SET revoked_at_ms=NULL WHERE challenge_hash=%s",
            (who["challenge"],),
        )


@native
@pytest.mark.parametrize("value", [None, True, -1, "1.5", 50000001, "Infinity", "NaN", "bad"])
def test_global_budget_invalid_amount(db, value):
    _, owner, _ = db
    start, end = utc_month_bounds(int(time.time() * 1000))
    execute_failure(
        owner,
        "INSERT INTO astarter_private.global_budget VALUES(%s,%s,%s,0,0,0,FALSE)",
        (start, end, value),
    )


@native
def test_global_unique_calendar_fixedcost_and_cross_identity(db):
    who = accounting(db)
    _, owner, _ = db
    row = owner.execute("SELECT * FROM astarter_private.global_budget").fetchone()
    execute_failure(
        owner,
        "INSERT INTO astarter_private.global_budget SELECT * FROM astarter_private.global_budget",
    )
    execute_failure(
        owner, "UPDATE astarter_private.global_budget SET fixed_service_microusd=NULL,blocked=FALSE"
    )
    execute_failure(owner, "UPDATE astarter_private.global_budget SET month_end_ms=month_end_ms-1")
    execute_failure(owner, "UPDATE astarter_private.policies SET limit_microusd=50000001")
    execute_failure(
        owner,
        "UPDATE astarter_private.requests SET tenant_id='other' WHERE request_id='request-001'",
    )
    assert owner.execute("SELECT * FROM astarter_private.global_budget").fetchone() == row
    assert who["subject"].startswith("wallet:56:")


@native
@pytest.mark.parametrize("state", ["unknown", "failed", "complete"])
def test_unbilled_terminal_holds_usd(db, state):
    accounting(db)
    _, owner, _ = db
    result = (
        json.dumps({"model": MODEL, "executionAuthority": "NONE"}) if state == "complete" else None
    )
    owner.execute(
        "UPDATE astarter_private.requests SET state=%s,result=%s::jsonb,"
        "finished_at_ms=created_at_ms+1,settled_tokens=%s",
        (state, result, 0 if state == "complete" else None),
    )
    assert owner.execute(
        "SELECT held_microusd,spent_microusd FROM astarter_private.global_budget"
    ).fetchone() == dict(held_microusd=20890, spent_microusd=0)
    assert owner.execute(
        "SELECT settled_microusd FROM astarter_private.requests"
    ).fetchone() == dict(settled_microusd=None)


@native
def test_cost_actual_overrun_append_only_idempotency(db):
    who = accounting(db)
    _, owner, _ = db
    with app(db, "cost") as cost:
        args = ("receipt-001", who["subject"], who["subject"], "request-001", 25000, 14000)
        statement = "SELECT astarter_private.settle_cost(%s,%s,%s,%s,%s,%s) AS settled"
        assert cost.execute(statement, args).fetchone() == {"settled": True}
        assert cost.execute(statement, args).fetchone() == {"settled": False}
        execute_failure(cost, statement, args[:-2] + (25001, 14000))
        for denied in [
            "DELETE FROM astarter_private.cost_events",
            "UPDATE astarter_private.global_budget SET limit_microusd=50000000",
            "UPDATE astarter_private.requests SET settled_microusd=0",
            "INSERT INTO astarter_private.cost_events DEFAULT VALUES",
        ]:
            execute_failure(cost, denied)
    assert owner.execute(
        "SELECT held_microusd,spent_microusd,blocked FROM astarter_private.global_budget"
    ).fetchone() == dict(held_microusd=0, spent_microusd=25000, blocked=True)
    assert owner.execute(
        "SELECT amount_microusd,actual_tokens FROM astarter_private.cost_events"
    ).fetchone() == dict(amount_microusd=25000, actual_tokens=14000)
    execute_failure(owner, "DELETE FROM astarter_private.cost_events")


def test_import_has_no_connection_or_network():
    code = """
import socket, psycopg
from unittest.mock import patch
def denied(*args,**kwargs): raise AssertionError('EXTERNAL_IO')
with (patch.object(socket.socket,'connect',denied),
      patch.object(socket,'getaddrinfo',denied),patch.object(psycopg,'connect',denied)):
 import stark_trading_os.control.postgres.private_research_migration
 import stark_trading_os.control.postgres.private_research_access
"""
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        timeout=10,
        env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(Path(m.__file__).parents[3])},
    )
    assert result.returncode == 0, result.stderr


@native
@pytest.mark.parametrize(
    "kind", ["role_setting", "extra_member", "admin_option", "table_grant_option"]
)
def test_role_privilege_drift(db, kind):
    pg, owner, target = db
    with pg.connect() as admin:
        if kind == "role_setting":
            admin.execute(
                sql.SQL("ALTER ROLE {} SET statement_timeout='1s'").format(
                    sql.Identifier(target.runtime)
                )
            )
        elif kind == "extra_member":
            admin.execute(
                sql.SQL("GRANT astarter_private_issuer TO {}").format(
                    sql.Identifier(target.runtime)
                )
            )
        elif kind == "admin_option":
            admin.execute(
                sql.SQL("GRANT astarter_private_runtime TO {} WITH ADMIN OPTION").format(
                    sql.Identifier(target.runtime)
                )
            )
        else:
            owner.execute(
                sql.SQL("GRANT SELECT ON astarter_private.leases TO {} WITH GRANT OPTION").format(
                    sql.Identifier(target.runtime)
                )
            )
    with pytest.raises(AccessRejected):
        with app(db, "runtime"):
            pass


@native
def test_expired_session_and_invalid_preparation(db):
    with app(db, "issuer") as issuer:
        expired = identity(issuer, now=int(time.time() * 1000) - 604800001)
        now = int(time.time() * 1000)
        challenge = "e" * 64
        issuer.execute(
            "INSERT INTO astarter_private.challenges(challenge_hash,nonce,"
            "origin,issued_at_ms,expires_at_ms) VALUES(%s,%s,%s,%s,%s)",
            (challenge, "d" * 64, ORIGIN, now, now + 300000),
        )
        for values in [
            ("0x" + "e" * 40, None, "message"),
            ("0x" + "e" * 40, 1, "message"),
            ("0x" + "e" * 40, 56, "x" * 4097),
        ]:
            execute_failure(
                issuer,
                "UPDATE astarter_private.challenges SET address=%s,chain_id=%s,"
                "message=%s,prepared_at_ms=%s WHERE challenge_hash=%s",
                values + (now, challenge),
            )
        execute_failure(
            issuer,
            "UPDATE astarter_private.challenges SET claim_digest=%s,"
            "consumed_at_ms=%s WHERE challenge_hash=%s",
            ("f" * 64, now, challenge),
        )
    with app(db, "runtime") as runtime:
        assert (
            runtime.execute(
                "SELECT * FROM astarter_private.resolve_session(%s,%s)",
                (expired["token"], "astarter-research"),
            ).fetchall()
            == []
        )


@native
def test_session_issue_serializes_after_revoke(db):
    pg, _, target = db
    with app(db, "issuer") as issuer:
        who = identity(issuer, issue=False)
    started = Event()
    backend_pid = []

    def issue_late():
        with (
            pytest.raises(psycopg.Error, match="PRIVATE_SESSION_STATE"),
            app(db, "issuer") as issuer,
        ):
            issuer.execute("SET LOCAL statement_timeout='3s'")
            backend_pid.append(issuer.info.backend_pid)
            started.set()
            issuer.execute(
                "INSERT INTO astarter_private.sessions VALUES(%s,%s,%s,%s,56,%s,"
                "%s,%s,%s,%s,%s,%s,NULL)",
                (
                    who["token"],
                    who["challenge"],
                    who["claim"],
                    who["address"],
                    ORIGIN,
                    who["subject"],
                    who["subject"],
                    "astarter-research",
                    ["research:analyze"],
                    who["now"],
                    who["now"] + 604800000,
                ),
            )

    with ThreadPoolExecutor(max_workers=1) as executor:
        with app(db, "issuer") as revoker:
            revoker.execute(
                "UPDATE astarter_private.challenges SET revoked_at_ms=%s WHERE challenge_hash=%s",
                (who["now"], who["challenge"]),
            )
            future = executor.submit(issue_late)
            assert started.wait(2)
            deadline = time.monotonic() + 1
            with pg.connect() as admin:
                while time.monotonic() < deadline:
                    waiting = admin.execute(
                        "SELECT wait_event_type='Lock' AS waiting "
                        "FROM pg_stat_activity WHERE pid=%s",
                        (backend_pid[0],),
                    ).fetchone()
                    if waiting == {"waiting": True}:
                        break
                    time.sleep(0.01)
                else:
                    raise AssertionError("NATIVE_CHALLENGE_LOCK_NOT_OBSERVED")
            assert not future.done()
        future.result(timeout=4)
    with app(db, "issuer") as issuer:
        assert issuer.execute("SELECT token_digest FROM astarter_private.sessions").fetchall() == []


@native
@pytest.mark.parametrize("bad_amount", [None, -1, "0.5", "NaN", True])
def test_cost_rejects_invalid_and_keeps_reservation(db, bad_amount):
    who = accounting(db)
    with app(db, "cost") as cost:
        execute_failure(
            cost,
            "SELECT astarter_private.settle_cost(%s,%s,%s,%s,%s,1)",
            ("receipt", who["subject"], who["subject"], "request-001", bad_amount),
        )
    _, owner, _ = db
    assert owner.execute("SELECT held_microusd FROM astarter_private.global_budget").fetchone() == {
        "held_microusd": 20890
    }
    assert owner.execute("SELECT * FROM astarter_private.cost_events").fetchall() == []


if __name__ == "__main__":
    # Explicit independent pristine oracle, not an application entry or target-learned pin.
    with cluster() as owned:
        target = target_database(owned)
        with owned.connect(user=target.owner, dbname=target.database) as owner:
            owner.execute("SET search_path=pg_catalog")
            empty = m.private_catalog_digest(owner)
            for resource in m.private_resources():
                for statement in sql_statements(resource):
                    owner.execute(statement)
            full = m.private_catalog_digest(owner)
            receipt = dict(
                profile=target.profile.value,
                resource_sha256=m.RESOURCE_SHA256,
                empty_catalog_sha256=empty,
                catalog_sha256=full,
                run_id=owned.run_id,
                pid=owned.pid,
                host=str(owned.alias),
                tcp_listeners=0,
            )
            path = TASK / ("private-oracle-" + owned.run_id + ".json")
            path.write_text(json.dumps(receipt, indent=2) + "\n")
            print(json.dumps(receipt))
