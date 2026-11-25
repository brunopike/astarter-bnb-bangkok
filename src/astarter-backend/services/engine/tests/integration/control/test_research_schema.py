"""Owned new PG17 databases only; no DSN discovery, model or cloud operations."""

# ruff: noqa: E402 -- explicit local-cluster opt-in precedes optional imports.
import hashlib
import importlib
import importlib.util
import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest

if not os.environ.get("Q08_TEST_ROOT"):
    pytest.skip("Q08 owned synthetic PG17 not supplied", allow_module_level=True)

import psycopg
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from stark_trading_os.control.astarter import strategy_repository as r
from stark_trading_os.control.database import open_control_database
from stark_trading_os.control.postgres.access import (
    PG2_CATALOG_PINS,
    AccessRejected,
    catalog_digest,
    install_access,
)
from stark_trading_os.control.postgres.identity import Principal
from stark_trading_os.control.postgres.pool import (
    PersistenceUnavailable,
    PgRepositoryPool,
    PoolSettings,
)
from stark_trading_os.control.postgres.strategy_repository import PostgresStrategyRepository
from stark_trading_os.control.postgres.synthetic_migration import (
    TargetProfile,
    new_target_statements,
    snapshot,
    verification_sql,
)
from stark_trading_os.domain import research_jobs as j
from stark_trading_os.domain import strategy_contracts as c
from stark_trading_os.integrations.research_delivery import make_artifact
from stark_trading_os.integrations.research_egress import encode, request_digest
from tests.unit.domain.test_research_jobs import dict_to_output, fixture_tree, policy, trigger

TABLES = (
    "research_jobs",
    "research_role_attempts",
    "research_consumers",
    "research_artifacts",
    "research_budget_scopes",
    "research_reservations",
    "research_events_outbox",
    "research_metadata",
)


def api():
    name = "stark_trading_os.control.postgres.research_access"
    assert importlib.util.find_spec(name) is not None, "Research schema/profile is missing"
    return importlib.import_module(name)


@pytest.fixture
def baseline():
    root = Path(os.environ["Q08_TEST_ROOT"])
    a = json.loads((root / "root-socket-authorization.json").read_text())
    alias = Path(os.environ["Q08_TEST_SOCKET"])
    assert alias.is_symlink() and str(alias) == a["alias"]
    assert alias.lstat().st_ino == a["alias_inode"] and alias.lstat().st_uid == os.getuid()
    assert alias.resolve() == root / "socket" and a["uid"] == os.getuid()
    base = dict(host=str(alias), port=55439, connect_timeout=3)
    db = "q08_" + uuid.uuid4().hex
    with psycopg.connect(**base, user="pg1_owner", dbname="postgres", autocommit=True) as admin:
        assert admin.execute("SHOW data_directory").fetchone()[0] == str(root / "pgdata")
        assert admin.execute("SHOW listen_addresses").fetchone()[0] == ""
        for role, login in [
            ("pg2_owner", True),
            ("pg2_app", True),
            ("pg2_reader", True),
            ("pg2_reference_read", False),
            ("pg2_reference_write", False),
            ("q08_app", True),
            ("q08_reader", True),
            ("q08_research_read", False),
            ("q08_research_write", False),
        ]:
            if not admin.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (role,)).fetchone():
                admin.execute(
                    psycopg.sql.SQL("CREATE ROLE {} {}").format(
                        psycopg.sql.Identifier(role),
                        psycopg.sql.SQL("LOGIN" if login else "NOLOGIN"),
                    )
                )
        admin.execute("GRANT pg2_reference_write TO pg2_app")
        admin.execute("GRANT pg2_reference_read TO pg2_reader")
        admin.execute("GRANT q08_research_write TO q08_app")
        admin.execute("GRANT q08_research_read TO q08_reader")
        admin.execute(
            psycopg.sql.SQL("CREATE DATABASE {} OWNER pg2_owner TEMPLATE template0").format(
                psycopg.sql.Identifier(db)
            )
        )
    source = snapshot(root / "source.sqlite")
    assert len(source.tables) == 37 and sum(len(t.rows) for t in source.tables) == 49
    owner = psycopg.connect(**base, user="pg2_owner", dbname=db, autocommit=True)
    with owner.transaction():
        for stmt in new_target_statements(source):
            owner.execute(stmt)
    install_access(owner)
    assert catalog_digest(owner) == PG2_CATALOG_PINS[TargetProfile.LOCAL_PG17]
    yield SimpleNamespace(
        owner=owner,
        source=source,
        base=base,
        database=db,
        root=root,
        dsn=make_conninfo(**base, user="q08_app", dbname=db),
    )
    owner.close()


def migrate(b):
    q = api()
    with b.owner.transaction():
        for stmt in q.research_migration_statements(
            b.source, target_profile=TargetProfile.LOCAL_PG17
        ):
            b.owner.execute(stmt)


@pytest.fixture
def research(baseline):
    migrate(baseline)
    return baseline


def open_pool(b, reader=False):
    q = api()
    dsn = make_conninfo(**b.base, user="q08_reader" if reader else "q08_app", dbname=b.database)
    p = PgRepositoryPool(
        dsn,
        writable=not reader,
        settings=PoolSettings(max_size=1),
        access_contract=q.RepositoryAccessContract.Q08_RESEARCH_STUB_V1,
    )
    p.open()
    return p


def job_values(b, public=False, key="job-1", subject="q08-fixture-user", with_evidence=False):
    scope_rows = b.owner.execute("SELECT * FROM pg1_control.astarter_strategy_scopes LIMIT 1")
    scope_row = dict(zip((d.name for d in scope_rows.description), scope_rows.fetchone()))
    assignment = r._decode(scope_row, r.ScopeAssignment, scope_row["scope_id"])
    planrow = b.owner.execute("SELECT * FROM pg1_control.astarter_plan_versions LIMIT 1")
    names = [d.name for d in planrow.description]
    record = r._decode(dict(zip(names, planrow.fetchone())), r.PlanRecord, scope_row["scope_id"])
    if public:
        from tests.unit.domain.test_research_jobs import principal

        who = principal(True)
        t = trigger(
            kind="FACTS",
            public=True,
            job_id=key,
            logical_request_id="request-" + key,
            event_id="event-" + key,
        )
    else:
        who = Principal(subject, assignment, "writer")
        data = {} if with_evidence else {"evidence": ()}
        if with_evidence:
            # New reference plan, leaving the sealed 49-row import untouched.
            original = trigger(kind="FACTS", public=True).evidence[0]
            source = c.EvidenceSnapshot.model_validate(
                original.source.model_dump()
                | {"subject_sha256": c.contract_hash(record.bundle.plan.instrument)}
            )
            evidence = (j.JobEvidenceV1(source=source, text=original.text, egress_allowed=True),)
            plan = c.PlanRevision.model_validate(
                record.bundle.plan.model_dump()
                | {
                    "plan_id": "plan-" + key,
                    "evidence_sha256s": tuple(c.contract_hash(e.source) for e in evidence),
                }
            )
            p = open_pool(b)
            try:
                repo = PostgresStrategyRepository(
                    p, SimpleNamespace(resolve_scope=lambda: assignment)
                )
                record = repo.save_plan(
                    c.PreflightInput(plan=plan, evidence=tuple(e.source for e in evidence)),
                    request_key="plan-" + key,
                    expected_revision=None,
                    now_ms=1000,
                )
            finally:
                p.close()
            data = {"evidence": evidence}
        t = trigger(
            kind="FACTS",
            plan=record.bundle.plan,
            **data,
            job_id=key,
            logical_request_id="request-" + key,
            event_id="event-" + key,
        )
    m = j.compile_manifest(who, t, policy())
    scope = hashlib.sha256(encode(m.visibility.model_dump(mode="json")).encode()).hexdigest()
    raw = encode(m.model_dump(mode="json")).encode()
    values = dict(
        scope_key=scope,
        job_id=key,
        visibility="PUBLIC" if public else "PRIVATE",
        tenant_id="platform" if public else record.bundle.plan.binding.tenant_id,
        principal_id=who.subject,
        account_id="public-research" if public else record.bundle.plan.binding.account_id,
        source_scope_id=None if public else scope_row["scope_id"],
        plan_id=None if public else record.bundle.plan.plan_id,
        plan_revision=None if public else record.bundle.plan.revision,
        plan_sha256=None if public else c.contract_hash(record.bundle.plan),
        subject_sha256=m.subject_sha256,
        logical_request_id="request-" + key,
        event_id="event-" + key,
        research_kind=m.trigger.kind,
        mode=m.trigger.mode,
        policy_revision=m.policy.revision,
        manifest_sha256=m.manifest_sha256,
        manifest_bytes=raw,
        content_sha256=hashlib.sha256(raw).hexdigest(),
        created_at_ms=1000,
        updated_at_ms=1000,
        deadline_ms=4000,
    )
    return m, values


def insert_job(conn, values):
    insert(conn, "research_jobs", values)


def insert(conn, table, values):
    assert table in TABLES
    conn.execute(
        psycopg.sql.SQL("INSERT INTO q08_research.{} ({}) VALUES ({})").format(
            psycopg.sql.Identifier(table),
            psycopg.sql.SQL(",").join(map(psycopg.sql.Identifier, values)),
            psycopg.sql.SQL(",").join(psycopg.sql.Placeholder() for _ in values),
        ),
        tuple(values.values()),
    )


def pipeline(b, public=True, key="job-1", subject="q08-fixture-user"):
    m, job = job_values(b, public, key, subject, with_evidence=True)
    ready = j.plan_ready_roles(m, (), now_ms=1000)
    assert ready.roles, ready
    item = ready.roles[0]
    req = item.request
    raw = encode(req.model_dump(mode="json")).encode()
    attempt = dict(
        scope_key=job["scope_key"],
        job_id=key,
        visibility=job["visibility"],
        role_id=item.role_id,
        attempt_id=req.spec.identity.attempt_id,
        manifest_sha256=m.manifest_sha256,
        request_sha256=request_digest(req),
        payload_sha256=req.payload_sha256,
        request_bytes=raw,
        content_sha256=hashlib.sha256(raw).hexdigest(),
        model_id=req.spec.policy.model,
        profile_revision=req.spec.task.profile_version,
        policy_revision=req.spec.policy.revision,
        effort="HIGH",
        key_owner_id=req.spec.identity.key_owner_id,
        credential_revision=req.spec.identity.credential_binding_revision,
        funding=req.spec.context.funding,
        created_at_ms=1000,
        updated_at_ms=1000,
    )
    art = make_artifact(
        req,
        dict_to_output("REVIEW", tuple(e.evidence_id for e in req.spec.task.evidence)),
        artifact_id="artifact-" + key,
        created_at_ms=1000,
    )
    raw = encode(art.model_dump(mode="json")).encode()
    artifact = dict(
        scope_key=job["scope_key"],
        job_id=key,
        artifact_id=art.artifact_id,
        principal_id=job["principal_id"],
        attempt_id=attempt["attempt_id"],
        role_id=item.role_id,
        visibility=job["visibility"],
        funding=attempt["funding"],
        key_owner_id=attempt["key_owner_id"],
        credential_revision=attempt["credential_revision"],
        reuse_key=item.reuse_key,
        content_bytes=raw,
        content_sha256=hashlib.sha256(raw).hexdigest(),
        output_sha256=art.output_sha256,
        created_at_ms=1000,
        use_until_ms=art.use_until_ms,
    )
    return SimpleNamespace(job=job, attempt=attempt, artifact=artifact, req=req, manifest=m)


def budget(key="root", **changes):
    return (
        dict(
            budget_scope_id=hashlib.sha256(key.encode()).hexdigest(),
            scope_kind="ROOT",
            scope_owner=key,
            period_id="fixture-day",
            policy_revision="policy-v1",
            unit_id="SIM_MODEL_CREDIT_V1",
            scale=6,
            cap_atoms=1000,
            created_at_ms=1000,
            updated_at_ms=1000,
        )
        | changes
    )


def reservation(data, scope, **changes):
    return (
        dict(
            reservation_id="reserve-1",
            budget_scope_id=scope["budget_scope_id"],
            scope_key=data.job["scope_key"],
            job_id=data.job["job_id"],
            attempt_id=data.attempt["attempt_id"],
            request_sha256=data.attempt["request_sha256"],
            quote_sha256=hashlib.sha256(
                encode(data.req.spec.quote.model_dump(mode="json")).encode()
            ).hexdigest(),
            atoms=100,
            created_at_ms=1000,
            updated_at_ms=1000,
        )
        | changes
    )


def consumer(job, artifact, **changes):
    return (
        dict(
            scope_key=job["scope_key"],
            job_id=job["job_id"],
            consumer_id="consumer-1",
            principal_id=job["principal_id"],
            key_owner_id=artifact["key_owner_id"],
            credential_revision=artifact["credential_revision"],
            producer_scope_key=artifact["scope_key"],
            producer_job_id=artifact["job_id"],
            artifact_id=artifact["artifact_id"],
            producer_visibility=artifact["visibility"],
            producer_principal_id=artifact["principal_id"],
            producer_key_owner_id=artifact["key_owner_id"],
            producer_credential_revision=artifact["credential_revision"],
            created_at_ms=1000,
            use_until_ms=artifact["use_until_ms"],
        )
        | changes
    )


def outbox(job):
    raw = b'{"kind":"NOTICE","reference_only":true}'
    return dict(
        scope_key=job["scope_key"],
        job_id=job["job_id"],
        seq=1,
        event_id="notice-1",
        kind="NOTICE",
        fact_bytes=raw,
        fact_sha256=hashlib.sha256(raw).hexdigest(),
        created_at_ms=1000,
        not_before_ms=1000,
        updated_at_ms=1000,
    )


def seed(conn, data):
    insert_job(conn, data.job)
    insert(conn, "research_role_attempts", data.attempt)
    insert(conn, "research_artifacts", data.artifact)


def test_incremental_migration_preserves_all_37_tables_and_49_rows_then_replays(baseline):
    migrate(baseline)
    migrate(baseline)
    with baseline.owner.transaction():
        baseline.owner.execute(verification_sql(baseline.source))
    tables = baseline.owner.execute(
        "SELECT tablename FROM pg_tables WHERE schemaname='q08_research'"
    )
    assert {x[0] for x in tables} == set(TABLES)
    assert (
        baseline.owner.execute("SELECT count(*) FROM q08_research.research_jobs").fetchone()[0] == 0
    )


def test_failure_after_ddl_rolls_back_all_research_objects_and_old_history(baseline):
    q = api()
    with pytest.raises(psycopg.Error):
        with baseline.owner.transaction():
            for stmt in q.research_migration_statements(baseline.source):
                baseline.owner.execute(stmt)
            baseline.owner.execute("SELECT 1/0")
    assert (
        baseline.owner.execute("SELECT 1 FROM pg_namespace WHERE nspname='q08_research'").fetchone()
        is None
    )
    assert catalog_digest(baseline.owner) == PG2_CATALOG_PINS[TargetProfile.LOCAL_PG17]
    with baseline.owner.transaction():
        baseline.owner.execute(verification_sql(baseline.source))


def test_new_profile_is_required_and_original_default_still_rejects_new_schema(research):
    old = PgRepositoryPool(make_conninfo(**research.base, user="pg2_app", dbname=research.database))
    try:
        with pytest.raises(AccessRejected, match="CATALOG"):
            old.open()
    finally:
        old.close()
    p = open_pool(research)
    p.close()


@pytest.mark.parametrize("reader", [False, True])
def test_real_nonowner_roles_can_read_reference_archives_and_research(research, reader):
    p = open_pool(research, reader)
    try:
        with p.transaction() as conn:
            assert (
                conn.execute(
                    "SELECT count(*) AS n FROM pg1_control.astarter_plan_versions"
                ).fetchone()["n"]
                == 1
            )
            assert (
                conn.execute("SELECT count(*) AS n FROM q08_research.research_metadata").fetchone()[
                    "n"
                ]
                == 1
            )
    finally:
        p.close()


def test_writer_uses_existing_pool_transaction_and_insert_cannot_become_execution(research):
    m, values = job_values(research)
    p = open_pool(research)
    try:
        with p.transaction(write=True, scope_id=values["scope_key"]) as conn:
            insert_job(conn, values)
        with p.transaction() as conn:
            row = conn.execute(
                "SELECT state,version,manifest_bytes FROM q08_research.research_jobs"
            ).fetchone()
            assert row["state"] == "QUEUED" and row["version"] == 0
            restored = j.JobManifestV1.model_validate(
                fixture_tree(json.loads(row["manifest_bytes"]))
            )
            assert not restored.execution_authorized
    finally:
        p.close()


@pytest.mark.parametrize(
    "sql",
    [
        "DELETE FROM pg1_control.astarter_intents",
        "UPDATE pg1_control.astarter_accounts SET baseline_quote=baseline_quote",
        "INSERT INTO pg1_control.astarter_intents DEFAULT VALUES",
        "TRUNCATE pg1_control.astarter_accounts",
        "CREATE TABLE q08_research.bad_table(x int)",
        "CREATE TABLE public.bad_table(x int)",
        "ALTER TABLE q08_research.research_jobs ADD COLUMN bad int",
    ],
)
def test_research_writer_cannot_access_financial_or_ddl_paths(research, sql):
    p = open_pool(research)
    try:
        with pytest.raises(PersistenceUnavailable, match="PG2_TRANSACTION_FAILED"):
            with p.transaction(write=True) as conn:
                conn.execute(sql)
    finally:
        p.close()


def test_reader_and_original_app_cannot_write_research_tables(research):
    for user in ("q08_reader", "pg2_app"):
        with psycopg.connect(
            **research.base, user=user, dbname=research.database, autocommit=True
        ) as conn:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute("INSERT INTO q08_research.research_jobs DEFAULT VALUES")


def test_old_writer_version_is_not_accepted_by_research_guards(research):
    _, values = job_values(research)
    with psycopg.connect(research.dsn, autocommit=True) as conn:
        with pytest.raises(psycopg.Error, match="VERSION"):
            with conn.transaction():
                conn.execute("SET LOCAL pg1.writer_version='1'")
                insert_job(conn, values)


@pytest.mark.parametrize(
    "field,value",
    [("plan_sha256", "f" * 64), ("tenant_id", "foreign-tenant"), ("content_sha256", "0" * 64)],
)
def test_job_parent_scope_and_content_bytes_must_agree(research, field, value):
    _, values = job_values(research)
    p = open_pool(research)
    try:
        with pytest.raises((r.PersistenceConflict, PersistenceUnavailable)):
            with p.transaction(write=True) as conn:
                insert_job(conn, values | {field: value})
        with p.transaction() as conn:
            assert (
                conn.execute("SELECT count(*) AS n FROM q08_research.research_jobs").fetchone()["n"]
                == 0
            )
    finally:
        p.close()


@pytest.mark.parametrize(
    "drift",
    [
        "CREATE SCHEMA unexpected_scope",
        "ALTER TABLE q08_research.research_jobs ADD COLUMN extra text",
        "GRANT CREATE ON SCHEMA q08_research TO q08_app",
        "GRANT SELECT ON q08_research.research_jobs TO PUBLIC",
        "GRANT SELECT(manifest_bytes) ON q08_research.research_jobs TO q08_app WITH GRANT OPTION",
    ],
)
def test_complete_catalog_and_effective_acl_drift_fail_closed_without_repair(research, drift):
    research.owner.execute(drift)
    after = api().research_catalog_digest(research.owner)
    with pytest.raises(AccessRejected):
        open_pool(research)
    assert api().research_catalog_digest(research.owner) == after


def test_old_pg2_capabilities_are_not_granted_research_schema_usage(research):
    row = research.owner.execute(
        "SELECT has_schema_privilege('pg2_app','q08_research','USAGE'),"
        "has_schema_privilege('pg2_reader','q08_research','USAGE')"
    ).fetchone()
    assert row == (False, False)


def test_all_seven_tables_roundtrip_and_delivery_updates_preserve_facts(research):
    data = pipeline(research)
    p = open_pool(research)
    try:
        with p.transaction(write=True) as conn:
            seed(conn, data)
            insert(conn, "research_consumers", consumer(data.job, data.artifact))
            for key in ("root", "owner"):
                scope = budget(key)
                insert(conn, "research_budget_scopes", scope)
                insert(conn, "research_reservations", reservation(data, scope))
            insert(conn, "research_events_outbox", outbox(data.job))
        with p.transaction(write=True) as conn:
            conn.execute(
                "UPDATE q08_research.research_jobs SET state='WAIT_REVIEW',version=1 "
                "WHERE version=0"
            )
            conn.execute(
                "UPDATE q08_research.research_role_attempts SET state='CLAIMED', "
                "worker_id='worker-1',claim_id='claim-1',owner_epoch=1,"
                "lease_until_ms=2000,version=1 WHERE version=0"
            )
            conn.execute(
                "UPDATE q08_research.research_budget_scopes SET reserved_atoms=100,version=1"
            )
            conn.execute(
                "UPDATE q08_research.research_reservations SET state='DISPATCH_STARTED',version=1"
            )
            conn.execute(
                "UPDATE q08_research.research_events_outbox SET delivery_state='CLAIMED',"
                "delivery_owner='notice-worker',delivery_epoch=1,delivery_attempts=1,"
                "delivery_lease_until_ms=2000,version=1 WHERE version=0"
            )
        with p.transaction() as conn:
            for table in TABLES:
                n = conn.execute(
                    psycopg.sql.SQL("SELECT count(*) AS n FROM q08_research.{}").format(
                        psycopg.sql.Identifier(table)
                    )
                ).fetchone()["n"]
                assert n == (
                    2 if table in ("research_budget_scopes", "research_reservations") else 1
                )
            saved = conn.execute(
                "SELECT fact_bytes,fact_sha256,delivery_state FROM "
                "q08_research.research_events_outbox"
            ).fetchone()
            assert saved == dict(
                fact_bytes=outbox(data.job)["fact_bytes"],
                fact_sha256=outbox(data.job)["fact_sha256"],
                delivery_state="CLAIMED",
            )
            assert (
                conn.execute(
                    "SELECT request_bytes FROM q08_research.research_role_attempts"
                ).fetchone()["request_bytes"]
                == data.attempt["request_bytes"]
            )
        with research.owner.transaction():
            research.owner.execute(verification_sql(research.source))
    finally:
        p.close()


@pytest.mark.parametrize(
    "change",
    [
        {"unit_id": "USD"},
        {"scale": 5},
        {"cap_atoms": -1},
        {"cap_atoms": "1.1"},
        {"cap_atoms": 2**127},
        {"reserved_atoms": 1001},
        {"spent_atoms": -1},
        {"unknown_atoms": 600, "spent_atoms": 401},
    ],
)
def test_budget_units_precision_and_conservation_are_database_constraints(research, change):
    p = open_pool(research)
    try:
        with pytest.raises(r.PersistenceConflict):
            with p.transaction(write=True) as conn:
                insert(conn, "research_budget_scopes", budget(**change))
        with p.transaction() as conn:
            assert (
                conn.execute(
                    "SELECT count(*) AS n FROM q08_research.research_budget_scopes"
                ).fetchone()["n"]
                == 0
            )
    finally:
        p.close()


@pytest.mark.parametrize(
    "change", [{"atoms": 101}, {"quote_sha256": "c" * 64}, {"state": "SETTLED"}]
)
def test_one_reservation_cannot_commit_inconsistent_scope_rows(research, change):
    data = pipeline(research)
    p = open_pool(research)
    try:
        with pytest.raises(PersistenceUnavailable, match="COMMIT_REJECTED"):
            with p.transaction(write=True) as conn:
                seed(conn, data)
                for key in ("root", "owner"):
                    scope = budget(key)
                    insert(conn, "research_budget_scopes", scope)
                    insert(
                        conn,
                        "research_reservations",
                        reservation(data, scope, **(change if key == "owner" else {})),
                    )
        with p.transaction() as conn:
            assert (
                conn.execute("SELECT count(*) AS n FROM q08_research.research_jobs").fetchone()["n"]
                == 0
            )
    finally:
        p.close()


@pytest.mark.parametrize(
    "change",
    [
        {"key_owner_id": "foreign-key-owner"},
        {"credential_revision": "wrong-credential"},
        {"funding": "BYOK"},
    ],
)
def test_artifact_cannot_change_its_producer_attempt_identity(research, change):
    data = pipeline(research, public=False)
    p = open_pool(research)
    try:
        with pytest.raises(r.PersistenceConflict):
            with p.transaction(write=True) as conn:
                insert_job(conn, data.job)
                insert(conn, "research_role_attempts", data.attempt)
                insert(conn, "research_artifacts", data.artifact | change)
    finally:
        p.close()


def test_public_artifact_is_reusable_but_private_is_not_shared_between_principals(research):
    shared = pipeline(research)
    private = pipeline(research, public=False, key="private-a", subject="principal-a")
    _, other = job_values(research, key="private-b", subject="principal-b")
    p = open_pool(research)
    try:
        with p.transaction(write=True) as conn:
            seed(conn, shared)
            seed(conn, private)
            insert_job(conn, other)
            insert(conn, "research_consumers", consumer(other, shared.artifact))
        with pytest.raises(r.PersistenceConflict):
            with p.transaction(write=True) as conn:
                insert(
                    conn, "research_consumers", consumer(other, private.artifact, consumer_id="bad")
                )
    finally:
        p.close()


@pytest.mark.parametrize(
    "table,changes",
    [
        (
            "research_jobs",
            {"manifest_bytes": b"{}", "content_sha256": hashlib.sha256(b"{}").hexdigest()},
        ),
        ("research_role_attempts", {"owner_epoch": 1}),
        ("research_role_attempts", {"state": "DISPATCH_STARTED"}),
        ("research_consumers", {"use_until_ms": 50000}),
        ("research_consumers", {"producer_principal_id": "another-principal"}),
        ("research_artifacts", {"content_sha256": "0" * 64}),
    ],
)
def test_invalid_headers_claims_hashes_and_reuse_expiry_fail_closed(research, table, changes):
    data = pipeline(research)
    values = {
        "research_jobs": data.job,
        "research_role_attempts": data.attempt,
        "research_artifacts": data.artifact,
        "research_consumers": consumer(data.job, data.artifact),
    }[table]
    p = open_pool(research)
    try:
        with pytest.raises((r.PersistenceConflict, PersistenceUnavailable)):
            with p.transaction(write=True) as conn:
                if table != "research_jobs":
                    insert_job(conn, data.job)
                if table in ("research_artifacts", "research_consumers"):
                    insert(conn, "research_role_attempts", data.attempt)
                if table == "research_consumers":
                    insert(conn, "research_artifacts", data.artifact)
                insert(conn, table, values | changes)
    finally:
        p.close()


@pytest.mark.parametrize(
    "sql",
    [
        "UPDATE q08_research.research_jobs SET manifest_sha256=repeat('f',64)",
        "UPDATE q08_research.research_role_attempts SET request_sha256=repeat('f',64)",
        "UPDATE q08_research.research_artifacts SET use_until_ms=50000",
        "UPDATE q08_research.research_consumers SET use_until_ms=50000",
        "UPDATE q08_research.research_events_outbox SET fact_bytes='bad'::bytea",
        "DELETE FROM q08_research.research_artifacts",
        "TRUNCATE q08_research.research_jobs CASCADE",
    ],
)
def test_app_cannot_rewrite_or_destroy_reference_facts(research, sql):
    data = pipeline(research)
    p = open_pool(research)
    try:
        with p.transaction(write=True) as conn:
            seed(conn, data)
            insert(conn, "research_consumers", consumer(data.job, data.artifact))
            insert(conn, "research_events_outbox", outbox(data.job))
        with pytest.raises(PersistenceUnavailable, match="TRANSACTION_FAILED"):
            with p.transaction(write=True) as conn:
                conn.execute(sql)
    finally:
        p.close()


def test_existing_dal_reads_old_plan_approval_history_and_appends_new_reference(research):
    cursor = research.owner.cursor(row_factory=dict_row)
    row = cursor.execute("SELECT * FROM pg1_control.astarter_strategy_scopes").fetchone()
    assignment = r._decode(row, r.ScopeAssignment, row["scope_id"])
    p = open_pool(research)
    try:
        repo = PostgresStrategyRepository(p, SimpleNamespace(resolve_scope=lambda: assignment))
        plan = repo.list_plans(now_ms=1000)[0].record.bundle.plan
        history = repo.read_recovery(plan.plan_id, plan.revision, now_ms=1000)
        assert history.checkpoint.seq == 12 and not history.plan.decision.execution_authorized
        old = repo.read_recovery(plan.plan_id, plan.revision, seq=1, now_ms=1000)
        assert old.checkpoint.seq == 1
        review = research.owner.execute(
            "SELECT reference_id FROM pg1_control.astarter_approval_references"
        ).fetchone()[0]
        assert repo.read_plan(plan.plan_id, approval_id=review, now_ms=1000).approval is not None
        cp = type(history.checkpoint).model_validate(
            history.checkpoint.model_dump()
            | {
                "seq": 13,
                "previous_sha256": r.reference_hash(history.checkpoint),
                "request_key": "q08-next",
            }
        )
        assert repo.save_recovery(cp, now_ms=1000) == cp
        assert repo.read_recovery(plan.plan_id, plan.revision, now_ms=1000).checkpoint == cp
        with pytest.raises(r.PersistenceConflict, match="CAS"):
            repo.save_recovery(
                type(cp).model_validate(cp.model_dump() | {"request_key": "old-cas"}), now_ms=1000
            )
    finally:
        p.close()


@pytest.mark.parametrize(
    "path",
    [
        ("visibility", "tenant_id"),
        ("visibility", "principal_scope_id"),
        ("visibility", "account_scope_id"),
        ("trigger", "plan", "revision"),
    ],
)
def test_manifest_private_headers_cannot_disagree_with_indexed_columns(research, path):
    _, values = job_values(research)
    body = json.loads(values["manifest_bytes"])
    leaf = body
    for key in path[:-1]:
        leaf = leaf[key]
    leaf[path[-1]] = "foreign-value"
    raw = encode(body).encode()
    p = open_pool(research)
    try:
        with pytest.raises(r.PersistenceConflict):
            with p.transaction(write=True) as conn:
                insert_job(
                    conn,
                    values
                    | {"manifest_bytes": raw, "content_sha256": hashlib.sha256(raw).hexdigest()},
                )
    finally:
        p.close()


def test_scope_key_cannot_be_supplied_from_a_different_visibility_binding(research):
    _, values = job_values(research)
    p = open_pool(research)
    try:
        with pytest.raises(r.PersistenceConflict):
            with p.transaction(write=True) as conn:
                insert_job(conn, values | {"scope_key": "a" * 64})
    finally:
        p.close()


def test_unknown_namespace_before_install_is_rejected_without_ddl_or_repair(baseline):
    baseline.owner.execute("CREATE SCHEMA unexpected_scope")
    before = catalog_digest(baseline.owner)
    with pytest.raises(psycopg.Error, match="Q08_PRE_CATALOG"):
        migrate(baseline)
    assert catalog_digest(baseline.owner) == before
    assert (
        baseline.owner.execute("SELECT 1 FROM pg_namespace WHERE nspname='q08_research'").fetchone()
        is None
    )


def test_pool_rechecks_profile_on_later_transactions_instead_of_trusting_open(research):
    p = open_pool(research)
    try:
        research.owner.execute("GRANT USAGE ON SCHEMA q08_research TO PUBLIC")
        with pytest.raises(AccessRejected):
            with p.transaction():
                pytest.fail("drift must be rejected before caller SQL")
    finally:
        p.close()


def test_sealed_replay_refuses_later_archive_changes_without_resetting_them(research):
    pipeline(research, public=False, key="new-plan")
    before = research.owner.execute(
        "SELECT count(*) FROM pg1_control.astarter_plan_versions"
    ).fetchone()[0]
    assert before == 2
    with pytest.raises(psycopg.Error):
        migrate(research)
    assert (
        research.owner.execute(
            "SELECT count(*) FROM pg1_control.astarter_plan_versions"
        ).fetchone()[0]
        == before
    )
    assert api().research_catalog_digest(research.owner) == api().RESEARCH_CATALOG_PIN


def test_reservation_group_serializes_two_actual_connections_and_rejects_conflict(research):
    data = pipeline(research)
    a, b = open_pool(research), open_pool(research)
    held, attempting, release = Event(), Event(), Event()
    pids = {}
    scopes = [budget("root"), budget("owner")]
    try:
        with a.transaction(write=True) as conn:
            seed(conn, data)
            for scope in scopes:
                insert(conn, "research_budget_scopes", scope)

        def first():
            with a.transaction(write=True, scope_id="independent-caller-a") as conn:
                pids["first"] = conn.execute("SELECT pg_backend_pid() AS pid").fetchone()["pid"]
                insert(conn, "research_reservations", reservation(data, scopes[0]))
                held.set()
                assert release.wait(10)

        def second():
            assert held.wait(10)
            with pytest.raises(PersistenceUnavailable, match="COMMIT_REJECTED"):
                with b.transaction(write=True, scope_id="independent-caller-b") as conn:
                    pids["second"] = conn.execute("SELECT pg_backend_pid() AS pid").fetchone()[
                        "pid"
                    ]
                    attempting.set()
                    insert(conn, "research_reservations", reservation(data, scopes[1], atoms=101))

        with ThreadPoolExecutor(max_workers=2) as workers:
            f1, f2 = workers.submit(first), workers.submit(second)
            try:
                assert attempting.wait(10)
                end = time.monotonic() + 5
                while time.monotonic() < end:
                    blockers = research.owner.execute(
                        "SELECT pg_blocking_pids(%s)", (pids["second"],)
                    ).fetchone()[0]
                    if pids["first"] in blockers:
                        break
                    time.sleep(0.01)
                else:
                    pytest.fail("actual concurrent reservation did not block on its group lock")
            finally:
                release.set()
            f1.result(timeout=10)
            f2.result(timeout=10)
        with a.transaction() as conn:
            saved = conn.execute(
                "SELECT atoms,budget_scope_id FROM q08_research.research_reservations"
            ).fetchall()
            assert len(saved) == 1 and saved[0]["atoms"] == 100
            assert saved[0]["budget_scope_id"] == scopes[0]["budget_scope_id"]
    finally:
        release.set()
        a.close()
        b.close()


def test_domain_default_drift_cannot_hide_behind_unchanged_type_name_and_acl(research):
    before = api().research_catalog_digest(research.owner)
    research.owner.execute("ALTER DOMAIN q08_research.identifier SET DEFAULT 'unexpected-default'")
    after = api().research_catalog_digest(research.owner)
    assert after != before, "a domain default changes the versioned writer contract"
    with pytest.raises(AccessRejected):
        open_pool(research)
    assert api().research_catalog_digest(research.owner) == after


def test_research_role_cannot_create_temporary_schema_objects(research):
    p = open_pool(research)
    try:
        with pytest.raises(PersistenceUnavailable, match="TRANSACTION_FAILED"):
            with p.transaction(write=True) as conn:
                conn.execute("CREATE TEMP TABLE unexpected_temp(x integer) ON COMMIT DROP")
    finally:
        p.close()


def test_database_connect_grant_option_is_rejected_before_caller_sql(research):
    research.owner.execute(
        psycopg.sql.SQL("GRANT CONNECT ON DATABASE {} TO q08_app WITH GRANT OPTION").format(
            psycopg.sql.Identifier(research.database)
        )
    )
    with pytest.raises(AccessRejected):
        open_pool(research)


def test_database_acl_to_an_unrelated_role_is_also_part_of_the_fixed_catalog(research):
    research.owner.execute(
        psycopg.sql.SQL("GRANT CONNECT ON DATABASE {} TO q08_reader").format(
            psycopg.sql.Identifier(research.database)
        )
    )
    with pytest.raises(AccessRejected):
        open_pool(research)


@pytest.mark.parametrize("kind", ["DATABASE", "SCHEMA", "DOMAIN"])
def test_acl_owner_marker_cannot_alias_a_real_nonowner_role_named_owner(research, kind):
    with psycopg.connect(
        **research.base, user="pg1_owner", dbname="postgres", autocommit=True
    ) as admin:
        if not admin.execute("SELECT 1 FROM pg_roles WHERE rolname='owner'").fetchone():
            admin.execute('CREATE ROLE "owner" NOLOGIN')
    target = {
        "DATABASE": psycopg.sql.Identifier(research.database),
        "SCHEMA": psycopg.sql.Identifier("q08_research"),
        "DOMAIN": psycopg.sql.Identifier("q08_research", "identifier"),
    }[kind]
    before = api().research_catalog_digest(research.owner)
    research.owner.execute(
        psycopg.sql.SQL('GRANT ALL ON {} {} TO "owner"').format(psycopg.sql.SQL(kind), target)
    )
    research.owner.execute(
        psycopg.sql.SQL("REVOKE ALL ON {} {} FROM pg2_owner").format(psycopg.sql.SQL(kind), target)
    )
    after = api().research_catalog_digest(research.owner)
    assert after != before, "object owner and a named role are distinct ACL identities"
    with pytest.raises(AccessRejected):
        open_pool(research)


def test_fresh_database_bootstrap_composes_existing_dal_and_empty_business_snapshot(
    baseline, tmp_path
):
    path = tmp_path / "empty-synthetic.sqlite"
    db = open_control_database(path)
    db.close()
    source = snapshot(path)
    assert len(source.tables) == 37
    name = "q08_empty_" + uuid.uuid4().hex
    with psycopg.connect(
        **baseline.base, user="pg1_owner", dbname="postgres", autocommit=True
    ) as admin:
        admin.execute(
            psycopg.sql.SQL("CREATE DATABASE {} OWNER pg2_owner TEMPLATE template0").format(
                psycopg.sql.Identifier(name)
            )
        )
    with psycopg.connect(**baseline.base, user="pg2_owner", dbname=name, autocommit=True) as owner:
        with owner.transaction():
            for stmt in new_target_statements(source):
                owner.execute(stmt)
        install_access(owner)
        target = SimpleNamespace(owner=owner, source=source, base=baseline.base, database=name)
        migrate(target)
        migrate(target)
        p = open_pool(target)
        try:
            with p.transaction() as conn:
                assert (
                    conn.execute(
                        "SELECT count(*) AS n FROM pg1_control.astarter_plan_versions"
                    ).fetchone()["n"]
                    == 0
                )
                assert (
                    conn.execute("SELECT count(*) AS n FROM q08_research.research_jobs").fetchone()[
                        "n"
                    ]
                    == 0
                )
            with owner.transaction():
                owner.execute(verification_sql(source))
        finally:
            p.close()
