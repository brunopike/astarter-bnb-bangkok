"""PRIVATE factory recovery uses real roles and a new owned Unix-only PG17."""

import json
import time
from dataclasses import asdict, replace
from hashlib import sha256

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.conninfo import make_conninfo

from stark_trading_os.control import private_research_service as service
from stark_trading_os.control.postgres.private_research_contracts import PrivateLease
from stark_trading_os.control.postgres.private_ui_migration import upgrade_private_ui
from tests.unit.control.postgres import test_private_research_migration as fixture

pytestmark = fixture.native


@pytest.mark.parametrize("lose_commit_ack", [False, True])
def test_private_factory_replaces_dead_resident_before_nonce_without_write_replay(
    tmp_path, monkeypatch, lose_commit_ack,
):
    monkeypatch.setattr(fixture, "TASK", tmp_path.resolve())
    pools = {}
    original_pool = service.PgRepositoryPool

    def capture_pool(*args, **kwargs):
        pool = original_pool(*args, **kwargs)
        pools[kwargs["private_role"]] = pool
        return pool

    monkeypatch.setattr(service, "PgRepositoryPool", capture_pool)
    with fixture.cluster() as pg:
        old = fixture.target_database(pg)
        target = replace(old, schema_version=2)
        with pg.connect(user=old.owner, dbname=old.database) as owner:
            fixture.m.install_private(owner, target=old)
            upgrade_private_ui(owner, target=target)
            lease = PrivateLease(
                leaseId="service-checkout-fixture", targetId=target.target_id,
                database=target.database, schema="astarter_private", runtimeRole=target.runtime,
                audience="astarter-research", budgetId="checkout-fixture-budget",
                model="openai/gpt-4.1-mini", expiresAt=253402300799000,
            )
            values = {
                "ASTARTER_PRIVATE_TARGET_JSON": json.dumps(
                    asdict(target) | {"profile": target.profile.value}),
                "ASTARTER_PRIVATE_LEASE_JSON": lease.model_dump_json(by_alias=True),
                "PRIVATE_RUNTIME_TOKEN": "r" * 48, "PRIVATE_ISSUER_TOKEN": "i" * 48,
                **{f"ASTARTER_PRIVATE_{role.upper()}_DATABASE_URL": make_conninfo(
                    host=target.host, port=target.port, dbname=target.database,
                    user=getattr(target, role)) for role in ("runtime", "issuer")},
            }
            config = service.PrivateServiceConfig.from_env(values)
            assert config is not None
            commits = []
            app = service.create_private_service(config)
            with TestClient(app) as client:
                issuer = pools["issuer"]
                resident = issuer._pool.getconn()
                pid = resident.info.backend_pid
                issuer._pool.putconn(resident)
                with pg.connect() as admin:
                    assert admin.execute(
                        "SELECT datname,usename FROM pg_stat_activity WHERE pid=%s", (pid,),
                    ).fetchone() == {"datname": target.database, "usename": target.issuer}
                    assert admin.execute(
                        "SELECT pg_terminate_backend(%s) AS terminated", (pid,),
                    ).fetchone() == {"terminated": True}
                original_commit = issuer._commit

                def commit(connection):
                    commits.append("DISPATCH")
                    original_commit(connection)
                    if lose_commit_ack:
                        raise psycopg.OperationalError("synthetic acknowledgement loss")
                    commits.append("ACK")

                monkeypatch.setattr(issuer, "_commit", commit)
                now = time.time_ns() // 1_000_000
                key = sha256(b"private-factory-checkout-fixture").hexdigest()
                response = client.post("/internal/private/v1/auth/challenge/issue", json={
                    "challengeHash": key, "nonce": "a" * 64,
                    "origin": "https://astarter.imstark.site", "issuedAt": now,
                    "expires": now + 300000, "address": None, "chain": None, "message": None,
                    "authVersion": 2, "permissionProfile": "private-ui-v2",
                }, headers={"Authorization": "Bearer " + "i" * 48})
                assert response.status_code == (409 if lose_commit_ack else 200)
                if lose_commit_ack:
                    assert response.json()["code"] == "PRIVATE_COMMIT_UNKNOWN"
                else:
                    assert response.json()["result"]["authVersion"] == 2
                assert owner.execute(
                    "SELECT count(*) AS n FROM astarter_private.challenges WHERE challenge_hash=%s",
                    (key,),
                ).fetchone() == {"n": 1}
                assert commits == (["DISPATCH"] if lose_commit_ack else ["DISPATCH", "ACK"])
            assert all(pool._pool.closed for pool in pools.values())
