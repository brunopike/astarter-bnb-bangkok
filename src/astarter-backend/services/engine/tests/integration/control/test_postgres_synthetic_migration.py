"""Real PG17 SQL compatibility probes, not Python AstarterControl-on-PG tests.

An evidence runner must supply an owned private cluster socket explicitly. Tests
never discover databases or accept URLs. Synthetic fixtures use frozen factories.
"""

import json
import os
import re
import select
import sqlite3
import subprocess
import time
import uuid
from dataclasses import replace
from fractions import Fraction
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch

import pytest

from stark_trading_os.control.astarter import strategy_repository as repository
from stark_trading_os.control.astarter.service import AstarterControl
from stark_trading_os.control.database import open_control_database
from stark_trading_os.control.postgres.synthetic_migration import (
    MigrationRejected,
    TargetProfile,
    bundle_sql,
    catalog_rows_sql,
    cloud_smoke_plan,
    import_statements,
    profile_pins,
    replay_statements,
    schema_sql,
    snapshot,
    transaction_settings,
    verification_sql,
)
from stark_trading_os.domain import astarter_risk as risk
from stark_trading_os.domain.astarter_simulation import SimulationPolicy
from stark_trading_os.runner.astarter_simulation import run_btc_simulation
from tests.unit.control.pg_schema8_fixture import derive_schema8_fixture, open_schema8_fixture
from tests.unit.control.test_astarter_strategy_repository import checkpoint
from tests.unit.control.test_astarter_transactions import plan_reserve, plan_setup
from tests.unit.control.test_registry import _persist_owned_terminal_preparation

BIN = Path("/opt/homebrew/opt/postgresql@17/bin")
PREFIX = "BEGIN; SET LOCAL pg1.writer_version='1'; SET LOCAL search_path=pg1_control,pg_catalog;"


class Pg:
    def __init__(self, socket, directory, database="postgres", user="pg1_owner"):
        self.socket, self.directory, self.database, self.user = socket, directory, database, user
        self.env = {"PATH": "/usr/bin:/bin", "HOME": str(directory / "empty-home"),
                    "LC_ALL": "C", "PGCONNECT_TIMEOUT": "3"}
        self.receipts = []

    def args(self):
        return [str(BIN / "psql"), "-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1",
                "-v", "VERBOSITY=sqlstate", "-h", self.socket, "-p", "55439",
                "-U", self.user, "-d", self.database]

    def sql(self, text, *, ok=True):
        result = subprocess.run(self.args(), input=text, text=True, capture_output=True,
                                env=self.env, timeout=40)
        self.receipts.append({"sql_sha256": sha256(text.encode()).hexdigest(),
                              "exitcode": result.returncode,
                              "stderr": result.stderr.strip()})
        identity = "sql-" + uuid.uuid4().hex
        (self.directory / (identity + ".sql")).write_text(text)
        (self.directory / (identity + ".json")).write_text(json.dumps({
            **self.receipts[-1], "stdout": result.stdout, "database": self.database,
            "user": self.user}, indent=2))
        if ok:
            assert result.returncode == 0, result.stderr
        else:
            assert result.returncode != 0
        return result.stdout.strip(), result.stderr

    def session(self):
        return Session(self)


class Session:
    def __init__(self, pg):
        self.directory = pg.directory
        self.pending = b""
        self.process = subprocess.Popen(pg.args(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, bufsize=1, env=pg.env)
        self.send("SELECT pg_backend_pid();")
        self.pid = int(self.line())

    def send(self, sql):
        (self.directory / ("session-" + uuid.uuid4().hex + ".json")).write_text(json.dumps({
            "backend_pid": getattr(self, "pid", None), "sql": sql}))
        assert self.process.stdin is not None
        self.process.stdin.write(sql + "\n")
        self.process.stdin.flush()

    def line(self):
        assert self.process.stdout is not None
        end = time.monotonic() + 8
        while time.monotonic() < end:
            while b"\n" in self.pending:
                line, self.pending = self.pending.split(b"\n", 1)
                if line.strip():
                    return line.decode().strip()
            ready, _, _ = select.select([self.process.stdout], [], [], max(0, end-time.monotonic()))
            assert ready, "PG1_SESSION_TIMEOUT"
            chunk = os.read(self.process.stdout.fileno(), 65536)
            assert chunk, "PG1_SESSION_EOF"
            self.pending += chunk
        pytest.fail("PG1_SESSION_TIMEOUT")

    def close(self):
        if self.process.poll() is None:
            self.send("ROLLBACK;\n\\q")
        self.process.communicate(timeout=10)


@pytest.fixture
def pg(tmp_path):
    socket = os.environ.get("PG1_TEST_SOCKET")
    if socket is None:
        pytest.skip("PG1 owned local cluster not supplied")
    root = Path(os.environ["PG1_TEST_ROOT"])
    marker = json.loads((root / "cluster-owner.json").read_text())
    assert marker["socket"] == socket and marker["pgdata"] == str(root / "pgdata")
    assert Path(socket).resolve() == root / "socket"
    admin = Pg(socket, tmp_path)
    name = "pg1_" + uuid.uuid4().hex
    admin.sql('CREATE DATABASE "' + name + '" TEMPLATE template0;')
    instance = Pg(socket, tmp_path, name)
    assert instance.sql("SHOW server_version;")[0] == "17.11 (Homebrew)"
    yield instance
    # Retain database for readback/evidence; cluster finally is owned by runner.


def synthetic(path):
    current = path.with_suffix(".current.sqlite")
    with plan_setup(current) as (control, binding, source, store, backend, _, plan, _, repo):
        receipt = plan_reserve(control, binding, backend.update.admission_id)
        control.claim_order(receipt.entry_order_id, fence=control.controller_identity.fence)
        ep = "episode-fixture-plan-plan-v1"
        cp = checkpoint(plan, episode_id=ep, layer_index=0)
        repo.save_layer(repository.LayerReference(
            binding=plan.binding, episode_id=ep, layer_index=0, mode="ACTUAL_REFERENCE",
            action_id="synthetic-action", trigger=cp.causal, disposition="UNKNOWN"))
        repo.save_recovery(cp, now_ms=1000)
        backend.update = replace(backend.update, admission_id="synthetic-revoked",
                                 previous_generation=1, state="REVOKED")
        control.refresh_admission()
        control.revoke(binding)
        control.begin_recovery(source.account_id)
        control.halt(source.account_id, "DAY_LOSS")
        _persist_owned_terminal_preparation(store._connection, run_id="synthetic-terminal",
                                           include_hidden_event=True)
        # Legal schema rows exercise byte/text edge values; no fake economic facts.
        store._connection.execute(
            "INSERT INTO runs(rowid,run_id,created_at_ns) VALUES(?,?,?)",
            (9223372036854775807, "合成'\\\n", 9223372036854775807))
        store._connection.execute(
            "INSERT INTO runner_outcomes(run_id,outcome_bytes,outcome_hash,recorded_at_ns) "
            "VALUES(?,?,?,?)", ("合成'\\\n", b"\x00\xff\\'\n", "f" * 64, 0))
        assert not receipt.execution_authorized
    derive_schema8_fixture(current, path)
    return snapshot(path)


def migrate(pg, value):
    sql = bundle_sql(value)
    (pg.directory / "bundle.sql").write_text(sql)
    (pg.directory / "manifest.json").write_bytes(value.manifest())
    pg.sql(sql)


@pytest.mark.parametrize("populated", [False, True])
def test_empty_and_populated_migration_reopen_replay(pg, tmp_path, populated):
    path = tmp_path / "synthetic.sqlite"
    if populated:
        value = synthetic(path)
    else:
        open_schema8_fixture(path).close()
        value = snapshot(path)
    before = sha256(path.read_bytes()).hexdigest()
    migrate(pg, value)
    # Each sql() is a freshly opened independent psql/backend connection.
    pg.sql(verification_sql(value))
    pg.sql(bundle_sql(value))
    assert sha256(path.read_bytes()).hexdigest() == before == value.source_sha256
    if populated:
        out, _ = pg.sql("SELECT native_state FROM pg1_control.astarter_orders;")
        assert out == "UNKNOWN"
        out, _ = pg.sql("SELECT cash_hold,pending_risk FROM pg1_control.astarter_intents;")
        assert out == "221.46284528|5"
        assert pg.sql("SELECT status FROM pg1_control.astarter_bindings;")[0] == "REVOKED"
        assert pg.sql("SELECT max(legacy_rowid) FROM pg1_control.runs;")[0] == str(2**63 - 1)


@pytest.mark.parametrize("failure", ["nonempty", "manifest", "version", "row", "ddl", "fk"])
def test_target_rejections_and_full_transaction_rollback(pg, tmp_path, failure):
    value = synthetic(tmp_path / "synthetic.sqlite")
    if failure == "nonempty":
        pg.sql("CREATE TABLE public.unrelated(x bigint); INSERT INTO public.unrelated VALUES(17);")
        pg.sql(bundle_sql(value), ok=False)
        assert pg.sql("SELECT x FROM public.unrelated;")[0] == "17"
    elif failure in {"manifest", "version", "row"}:
        migrate(pg, value)
        if failure == "manifest":
            pg.sql("UPDATE pg1_control.pg1_metadata SET manifest_sha256=repeat('0',64);")
        elif failure == "version":
            pg.sql("ALTER TABLE pg1_control.pg1_metadata "
                   "DROP CONSTRAINT pg1_metadata_schema_version_check;"
                   "UPDATE pg1_control.pg1_metadata SET schema_version=2;")
        else:
            pg.sql(PREFIX + "UPDATE astarter_accounts SET risk_epoch=risk_epoch+1; COMMIT;")
        pg.sql(bundle_sql(value), ok=False)
        return
    elif failure == "ddl":
        sql = bundle_sql(value).replace("CREATE FUNCTION pg1_require_writer()", "SELECT 1/0;\n"
                          "CREATE FUNCTION pg1_require_writer()")
        pg.sql(sql, ok=False)
    else:
        sql = bundle_sql(value).replace("ALTER TABLE astarter_admissions ADD FOREIGN KEY",
                                       "INSERT INTO pg1_control.astarter_intent_admissions "
                                       "VALUES('missing','missing','missing','missing');\n"
                                       "ALTER TABLE astarter_admissions ADD FOREIGN KEY", 1)
        pg.sql(sql, ok=False)
    assert pg.sql("SELECT count(*) FROM pg_namespace WHERE nspname='pg1_control';")[0] == "0"


@pytest.mark.parametrize("sql", [
    "DELETE FROM astarter_admissions",
    "UPDATE astarter_admissions SET state='READY'",
    "INSERT INTO astarter_admissions SELECT * FROM astarter_admissions "
    "ON CONFLICT(admission_id) DO UPDATE SET state='READY'",
    "TRUNCATE astarter_audit CASCADE",
    "UPDATE astarter_intents SET legacy_rowid=999",
    "UPDATE astarter_intents SET binding_id='missing'",
    "INSERT INTO astarter_intent_admissions VALUES('missing','missing','missing','missing')",
    "UPDATE astarter_accounts SET risk_epoch=9223372036854775808",
])
def test_constraints_append_only_conflict_replace_and_bounds(pg, tmp_path, sql):
    value = synthetic(tmp_path / "synthetic.sqlite")
    migrate(pg, value)
    pg.sql(PREFIX + sql + "; COMMIT;", ok=False)
    pg.sql(verification_sql(value))


@pytest.mark.parametrize("version", [None, "0", "2"])
def test_zero_row_writer_protocol_mismatch(pg, tmp_path, version):
    value = synthetic(tmp_path / "synthetic.sqlite")
    migrate(pg, value)
    setting = "" if version is None else f"SET LOCAL pg1.writer_version='{version}';"
    pg.sql("BEGIN;" + setting + "UPDATE pg1_control.astarter_accounts SET risk_epoch=0 "
           "WHERE FALSE; COMMIT;", ok=False)
    pg.sql(verification_sql(value))


def test_nonowner_cannot_read_or_mutate_even_with_self_declared_tenant(pg, tmp_path):
    value = synthetic(tmp_path / "synthetic.sqlite")
    migrate(pg, value)
    role = "pg1_app_" + uuid.uuid4().hex
    pg.sql(f"CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;")
    app = Pg(pg.socket, tmp_path, pg.database, role)
    assert app.sql("SELECT current_user;")[0] == role
    for sql in ("SELECT * FROM pg1_control.astarter_accounts",
                "UPDATE pg1_control.astarter_accounts SET risk_epoch=0",
                "TRUNCATE pg1_control.astarter_accounts CASCADE"):
        _, error = app.sql(
            "BEGIN; SET LOCAL pg1.tenant='synthetic'; SET LOCAL pg1.writer_version='1';"
            + sql + "; COMMIT;", ok=False)
        assert "42501" in error
    pg.sql(verification_sql(value))


def test_deferred_commit_failure_rolls_back_and_disconnect_rolls_back(pg, tmp_path):
    value = synthetic(tmp_path / "synthetic.sqlite")
    migrate(pg, value)
    pg.sql(PREFIX + "DELETE FROM runner_outcomes WHERE run_id='synthetic-terminal'; COMMIT;",
           ok=False)
    pg.sql(verification_sql(value))
    session = pg.session()
    try:
        session.send(PREFIX + "UPDATE astarter_accounts SET risk_epoch=risk_epoch+1;"
                     " SELECT 'held';")
        assert session.line() == "held"
        assert pg.sql(f"SELECT pg_terminate_backend({session.pid});")[0] == "t"
        # Force a round trip: EOF alone may let idle psql exit zero without
        # noticing the terminated server connection. Keep the failure assertion.
        session.send("SELECT 1;")
        session.process.communicate(timeout=10)
        assert session.process.returncode != 0
    finally:
        session.close()
    pg.sql(verification_sql(value))
    (tmp_path / "interruption.json").write_text(json.dumps({"backend_pid": session.pid,
                                                           "rollback_verified": True}))


def test_nul_is_preflight_refusal_and_target_stays_empty(pg, tmp_path):
    path = tmp_path / "synthetic.sqlite"
    c = open_schema8_fixture(path)
    c.execute("INSERT INTO runs(run_id,created_at_ns) VALUES(?,0)", ("synthetic\x00",))
    c.close()
    with pytest.raises(MigrationRejected, match="PG1_TEXT_NUL"):
        snapshot(path)
    assert pg.sql("SELECT count(*) FROM pg_namespace WHERE nspname='pg1_control';")[0] == "0"


def test_two_backend_row_lock_cas_and_existing_holds(pg, tmp_path):
    value = synthetic(tmp_path / "synthetic.sqlite")
    migrate(pg, value)
    a, b = pg.session(), pg.session()
    schedule = []
    try:
        assert a.pid != b.pid
        a.send(PREFIX + "SELECT risk_epoch FROM astarter_accounts WHERE account_id='SIM-001' "
               "FOR UPDATE;")
        epoch = int(a.line())
        schedule.append("a_locked")
        b.send(PREFIX + "SELECT risk_epoch FROM astarter_accounts WHERE account_id='SIM-001' "
               "FOR UPDATE;")
        end = time.monotonic() + 5
        waiting = ""
        while time.monotonic() < end:
            waiting = pg.sql(f"SELECT wait_event_type FROM pg_stat_activity WHERE pid={b.pid};")[0]
            if waiting == "Lock":
                break
            time.sleep(0.02)
        assert waiting == "Lock"
        schedule.append("b_observed_lock_wait")
        a.send(f"UPDATE astarter_accounts SET risk_epoch=risk_epoch+1 WHERE account_id='SIM-001' "
               f"AND risk_epoch={epoch}; COMMIT; SELECT 'committed';")
        assert a.line() == "committed"
        assert int(b.line()) == epoch + 1
        b.send(f"WITH updated AS (UPDATE astarter_accounts SET risk_epoch=risk_epoch+1 "
               f"WHERE account_id='SIM-001' AND risk_epoch={epoch} RETURNING 1) "
               "SELECT count(*) FROM updated;")
        assert b.line() == "0"
        schedule.append("b_stale_cas_zero_rows")
        b.send("ROLLBACK; SELECT 'rolledback';")
        assert b.line() == "rolledback"
    finally:
        a.close()
        b.close()
    # No UNKNOWN obligation is released by the SQL concurrency protocol.
    assert pg.sql("SELECT cash_hold,pending_risk,inventory_risk FROM "
                  "pg1_control.astarter_intents;")[0] == "221.46284528|5|0"
    (tmp_path / "schedule.json").write_text(json.dumps({"backend_pids": [a.pid, b.pid],
                                                       "schedule": schedule}, indent=2))


@pytest.mark.parametrize("tamper", [
    "ALTER TABLE pg1_control.astarter_accounts DROP CONSTRAINT astarter_accounts_risk_epoch_check",
    "DROP TRIGGER pg1_guard_003 ON pg1_control.astarter_accounts",
    "CREATE OR REPLACE FUNCTION pg1_control.pg1_guard_003() RETURNS trigger "
    "LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
    "ALTER TABLE pg1_control.astarter_accounts DISABLE TRIGGER pg1_writer",
    "ALTER TABLE pg1_control.astarter_accounts ALTER COLUMN profit_hwm DROP NOT NULL",
    "ALTER TABLE pg1_control.astarter_accounts ALTER COLUMN profit_hwm SET DEFAULT '1'",
    "ALTER TABLE pg1_control.astarter_accounts ALTER COLUMN profit_hwm TYPE varchar",
    "ALTER TABLE pg1_control.astarter_accounts ALTER COLUMN profit_hwm TYPE text COLLATE \"POSIX\"",
    "DROP INDEX pg1_control.idx_astarter_orders_intent",
    "ALTER TABLE pg1_control.astarter_fills DROP CONSTRAINT "
    "astarter_fills_order_id_account_id_fkey",
    "ALTER TABLE pg1_control.astarter_accounts DROP CONSTRAINT astarter_accounts_risk_epoch_check; "
    "ALTER TABLE pg1_control.astarter_accounts ADD CONSTRAINT astarter_accounts_risk_epoch_check "
    "CHECK(risk_epoch>=-1)",
    "ALTER FUNCTION pg1_control.pg1_guard_003() SECURITY DEFINER",
    "CREATE SEQUENCE public.extra",
    "CREATE DOMAIN public.extra AS text",
    "GRANT SELECT ON pg1_control.astarter_accounts TO PUBLIC",
    "CREATE TABLE pg1_control.extra(x bigint)",
    "CREATE SCHEMA extra",
    "CREATE FUNCTION public.extra() RETURNS integer LANGUAGE SQL AS $$ SELECT 1 $$",
    "CREATE TYPE public.extra AS ENUM ('x')",
])
def test_actual_catalog_tampering_rejected_without_data_writes(pg, tmp_path, tamper):
    value = synthetic(tmp_path / "synthetic.sqlite")
    migrate(pg, value)
    pg.sql(tamper + ";")
    catalog = ("SET search_path=pg_catalog; SELECT encode(sha256(convert_to("
               "string_agg(v,E'\\n' ORDER BY v COLLATE \"C\"),'UTF8')),'hex') FROM ("
               + catalog_rows_sql() + ") c;")
    damaged = pg.sql(catalog)[0]
    pg.sql(verification_sql(value))  # No data change: metadata/typed hashes alone miss this.
    pg.sql(bundle_sql(value), ok=False)
    assert pg.sql(catalog)[0] == damaged  # Reject, never silently repair the target.
    pg.sql(verification_sql(value))


@pytest.mark.parametrize("extra", [
    "CREATE SCHEMA extra",
    "CREATE FUNCTION public.extra() RETURNS integer LANGUAGE SQL AS $$ SELECT 1 $$",
    "CREATE TYPE public.extra AS ENUM ('x')",
])
def test_non_table_objects_refuse_new_target(pg, tmp_path, extra):
    path = tmp_path / "empty.sqlite"
    open_schema8_fixture(path).close()
    pg.sql(extra + ";")
    pg.sql(bundle_sql(snapshot(path)), ok=False)
    assert pg.sql("SELECT count(*) FROM pg_namespace WHERE nspname='pg1_control';")[0] == "0"


@pytest.mark.parametrize("privilege,column,principal,grantable", [
    (None, "run_id", "role", False),
    ("SELECT", "run_id", "role", False),
    ("UPDATE", "state", "role", False),
    ("SELECT", "run_id", "role", True),
    ("SELECT", "run_id", "public", False),
    ("INSERT", "run_id", "role", False),
    ("REFERENCES", "run_id", "role", False),
    ("SELECT", "run_id", "owner", False),
])
def test_column_acl_drift_rejects_without_repair(
    pg, tmp_path, privilege, column, principal, grantable,
):
    value = synthetic(tmp_path / "synthetic.sqlite")
    migrate(pg, value)
    role = "pg1_column_" + uuid.uuid4().hex
    pg.sql(f"CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;")
    # A role alone is not schema drift. The original ungranted target stays legal.
    pg.sql(bundle_sql(value))
    if privilege is not None:
        grantee = {"role": role, "public": "PUBLIC", "owner": pg.user}[principal]
        option = " WITH GRANT OPTION" if grantable else ""
        pg.sql(f"GRANT {privilege}({column}) ON pg1_control.runs TO {grantee}{option};")
    raw_acl = ("SELECT attname,attacl::text FROM pg_attribute "
               "WHERE attrelid='pg1_control.runs'::regclass AND attnum>0 ORDER BY attnum;")
    before = pg.sql(raw_acl)[0]
    assert pg.sql(f"SELECT has_schema_privilege('{role}','pg1_control','USAGE');")[0] == "f"
    app = Pg(pg.socket, tmp_path, pg.database, role)
    assert "42501" in app.sql("SELECT run_id FROM pg1_control.runs;", ok=False)[1]
    # Preserve the actual replay result and read back even on the baseline RED.
    try:
        _, error = pg.sql("\\set VERBOSITY default\n" + bundle_sql(value),
                          ok=privilege is None)
        if privilege is not None:
            assert "PG1_CATALOG_MISMATCH" in error
    finally:
        assert pg.sql(raw_acl)[0] == before
        pg.sql(verification_sql(value))
    # Read the whole oracle before selecting categories; avoid pushing a JSON
    # predicate into pg_get_functiondef evaluation on unrelated system aggregates.
    rows = pg.sql("SET search_path=pg_catalog; SELECT v FROM (" + catalog_rows_sql()
                  + ") c ORDER BY v COLLATE \"C\";")[0]
    normalized = [row for line in rows.splitlines()
                  if (row := json.loads(line))[0] == "column_grant"]
    if privilege is None:
        assert normalized == []
    else:
        attnum = int(pg.sql("SELECT attnum FROM pg_attribute "
                           "WHERE attrelid='pg1_control.runs'::regclass "
                           f"AND attname='{column}';")[0])
        identity = ["role", role] if principal == "role" else [principal]
        assert normalized == [["column_grant", "pg1_control.runs", attnum, column,
                               ["owner"], identity, privilege, grantable]]


def test_column_acl_normalization_ignores_grant_order(pg, tmp_path):
    value = synthetic(tmp_path / "synthetic.sqlite")
    migrate(pg, value)
    roles = ["pg1_column_" + uuid.uuid4().hex for _ in range(2)]
    for role in roles:
        pg.sql(f"CREATE ROLE {role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;")
    # Same explicit grants, opposite ACL array insertion order, on two columns.
    for column, ordered in (("run_id", roles), ("state", roles[::-1])):
        for role in ordered:
            pg.sql(f"GRANT SELECT({column}),UPDATE({column}) ON pg1_control.runs "
                   f"TO {role} WITH GRANT OPTION;")
    out = pg.sql("SET search_path=pg_catalog; SELECT v FROM (" + catalog_rows_sql()
                 + ") c ORDER BY v COLLATE \"C\";")[0]
    rows = [row for line in out.splitlines() if (row := json.loads(line))[0] == "column_grant"]
    expected = sorted(json.dumps([["owner"], ["role", role], privilege, True])
                      for role in roles for privilege in ("SELECT", "UPDATE"))
    for column in ("run_id", "state"):
        assert sorted(json.dumps(row[4:]) for row in rows if row[3] == column) == expected
    pg.sql(verification_sql(value))


def test_guard_catalog_definitions_and_ordinary_state_regressions(pg, tmp_path):
    value = synthetic(tmp_path / "synthetic.sqlite")
    migrate(pg, value)
    source_functions = dict(re.findall(
        r"CREATE FUNCTION (\w+)\(\) RETURNS trigger.*?AS \$\$(.*?)\$\$;",
        schema_sql(), re.S,
    ))
    out = pg.sql("SELECT json_build_array(proname,proconfig,prosrc,prosecdef) "
                 "FROM pg_proc WHERE pronamespace='pg1_control'::regnamespace "
                 "ORDER BY proname;")[0]
    definitions = [json.loads(line) for line in out.splitlines()]
    assert {row[0] for row in definitions} == set(source_functions)
    for name, config, body, definer in definitions:
        assert config == ["search_path=pg_catalog, pg1_control, pg_temp"]
        assert body == source_functions[name] and definer is False
    pg.sql("BEGIN; SET LOCAL search_path=pg_catalog; SET LOCAL pg1.writer_version='1';"
           "UPDATE pg1_control.astarter_accounts SET risk_epoch=risk_epoch+1; ROLLBACK;")
    _, error = pg.sql("\\set VERBOSITY default\n" + PREFIX
                     + "INSERT INTO pg1_control.astarter_approval_references "
                     "SELECT * FROM pg1_control.astarter_approval_references; COMMIT;", ok=False)
    assert "PG1_INVARIANT_001" in error
    _, error = pg.sql("\\set VERBOSITY default\nBEGIN;"
                     "UPDATE pg1_control.astarter_accounts SET risk_epoch=0 WHERE FALSE;"
                     "COMMIT;", ok=False)
    assert "PG1_VERSION_MISMATCH" in error
    pg.sql(verification_sql(value))


def legacy_terminal(connection):
    """Complete the existing owned terminal fixture through its legal SQL guards."""
    _persist_owned_terminal_preparation(connection, run_id="legacy-completed",
                                       include_hidden_event=True)
    connection.execute("BEGIN IMMEDIATE")
    connection.execute("INSERT INTO audit_intents SELECT run_id,audit_seq,event_seq,"
                       "audit_event_digest,audit_intent_bytes,audit_created_at_ns "
                       "FROM terminal_preparations WHERE run_id='legacy-completed'")
    connection.execute("INSERT INTO outbox VALUES('legacy-completed',1,1,1,20)")
    connection.execute("INSERT INTO seals VALUES('legacy-completed',?,1,1,20)", ("d" * 64,))
    connection.execute("UPDATE events SET visible=1 WHERE run_id='legacy-completed'")
    connection.execute("UPDATE runs SET state='COMPLETED',state_version=5,"
                       "evidence_status='VERIFIED',completed_at_ns=20,duration_ns=20,"
                       "materialized_event_seq=1,materialized_audit_seq=1 "
                       "WHERE run_id='legacy-completed'")
    connection.commit()


def native_history(path, scenario, *, partial_path=None):
    current = path.with_suffix(".current.sqlite")
    original = AstarterControl.observe
    captured = []

    def observe(control, *args, **kwargs):
        result = original(control, *args, **kwargs)
        conn = control._store._connection
        if partial_path is not None and not captured and conn.execute(
            "SELECT 1 FROM astarter_orders WHERE native_state='PARTIALLY_FILLED'"
        ).fetchone():
            assert not conn.in_transaction
            partial_current = partial_path.with_suffix(".current.sqlite")
            with sqlite3.connect(partial_current) as target:
                conn.backup(target)  # ONLY this new, committed synthetic source.
            target.close()
            derive_schema8_fixture(partial_current, partial_path)
            captured.append(True)
        return result

    with patch.object(AstarterControl, "observe", observe):
        result = run_btc_simulation(database_path=current, scenario=scenario)
    assert result.engine_disposed
    evidence = json.loads(result.evidence_bytes)
    assert evidence["errors"] == [] and evidence["status"] == "COMPLETE"
    path.with_suffix(".native.json").write_bytes(result.evidence_bytes)
    if partial_path is not None:
        assert captured == [True]
    conn = open_control_database(current)
    try:
        legacy_terminal(conn)
    finally:
        conn.close()
    derive_schema8_fixture(current, path)
    return snapshot(path), evidence


@pytest.mark.parametrize("scenario", ["round_trip", "partial_stop"])
def test_native_fill_fee_settlement_profit_lock_and_legacy_terminal(pg, tmp_path, scenario):
    value, evidence = native_history(tmp_path / "history.sqlite", scenario)
    migrate(pg, value)
    pg.sql(bundle_sql(value))
    assert pg.sql("SELECT state FROM pg1_control.runs WHERE run_id='legacy-completed';")[0] == (
        "COMPLETED")
    assert pg.sql("SELECT count(*) FROM pg1_control.astarter_fills;")[0] == "2"
    if scenario == "round_trip":
        assert [(f["quantity"], f["price"], f["fee"]) for f in
                evidence["native_snapshot"]["fills"]] == [
                    ("0.00368", "60000", "0.2208"), ("0.00368", "61000", "0.22448")]
        assert pg.sql("SELECT profit_increment,new_lock FROM "
                      "pg1_control.astarter_settlements;")[0] == "3.23472|0.646944"
        assert pg.sql("SELECT profit_hwm,locked_reserve FROM "
                      "pg1_control.astarter_accounts;")[0] == "3.23472|0.646944"
    else:
        assert evidence["settlement"]["net_profit"] == "-1.2189"
        assert pg.sql("SELECT booked_debit FROM pg1_control.astarter_limits "
                      "WHERE scope='CYCLE';")[0] == "1.2189"
    for table in ("astarter_fills", "astarter_settlements"):
        pg.sql(PREFIX + f"UPDATE {table} SET fact_sha256=repeat('0',64); COMMIT;", ok=False)
        pg.sql(PREFIX + f"DELETE FROM {table}; COMMIT;", ok=False)
        pg.sql(PREFIX + f"INSERT INTO {table} SELECT * FROM {table} "
               "ON CONFLICT DO NOTHING; COMMIT;")
    pg.sql(verification_sql(value))


def test_native_partial_checkpoint_keeps_obligations(pg, tmp_path):
    partial = tmp_path / "partial.sqlite"
    native_history(tmp_path / "finished.sqlite", "partial_stop", partial_path=partial)
    value = snapshot(partial)
    table = next(t for t in value.tables if t.name == "astarter_intents")
    row = dict(zip((c[0] for c in table.columns), table.rows[0], strict=True))
    assert Fraction(row["pending_risk"]) > 0 and Fraction(row["inventory_risk"]) > 0
    assert 0 < Fraction(row["cash_hold"]) < Fraction("221.46284528")
    migrate(pg, value)
    pg.sql(bundle_sql(value))
    assert "PARTIALLY_FILLED" in pg.sql(
        "SELECT native_state FROM pg1_control.astarter_orders;")[0]
    assert pg.sql("SELECT cash_hold,pending_risk,inventory_risk "
                  "FROM pg1_control.astarter_intents;")[0] == "|".join(
                      row[n] for n in ("cash_hold", "pending_risk", "inventory_risk"))
    pg.sql(verification_sql(value))


def backend(pg, tmp_path):
    role = "pg1_backend_" + uuid.uuid4().hex
    pg.sql(f"CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;"
           f"GRANT USAGE ON SCHEMA pg1_control TO {role};"
           f"GRANT SELECT ON ALL TABLES IN SCHEMA pg1_control TO {role};"
           f"GRANT UPDATE(singleton) ON pg1_control.pg1_metadata TO {role};"
           f"GRANT UPDATE ON pg1_control.astarter_accounts TO {role};"
           "GRANT INSERT ON pg1_control.astarter_intents,pg1_control.astarter_orders,"
           "pg1_control.astarter_intent_admissions,pg1_control.astarter_episode_references "
           f"TO {role};")
    result = Pg(pg.socket, tmp_path, pg.database, role)
    assert result.sql("SELECT current_user;")[0] == role
    assert result.sql("SELECT rolsuper FROM pg_roles WHERE rolname=current_user;")[0] == "f"
    return result


def test_trusted_backend_scope_is_explicit_not_a_tenant_guc(pg, tmp_path):
    value = synthetic(tmp_path / "synthetic.sqlite")
    migrate(pg, value)
    app = backend(pg, tmp_path)
    # Explicit backend selection is required; no RLS or authentication claim.
    assert app.sql("SELECT count(*) FROM pg1_control.astarter_strategy_scopes "
                   "WHERE tenant_id='foreign-tenant' AND account_id='SIM-001';")[0] == "0"
    _, error = app.sql(PREFIX + "INSERT INTO astarter_episode_references "
        "SELECT repeat('0',64),account_id,'cross-scope',plan_id,revision,plan_sha256,"
        "binding_id,content_bytes,content_sha256 FROM astarter_episode_references; COMMIT;",
        ok=False)
    assert "23503" in error  # Actual scoped FK, not a permission/parser failure.
    assert app.sql("SET pg1.tenant='foreign-tenant'; SELECT count(*) FROM "
                   "pg1_control.astarter_strategy_scopes;")[0] == "1"
    pg.sql(verification_sql(value))


def test_distinct_manifest_refusal_and_no_xid_readonly_replay(pg, tmp_path):
    value = synthetic(tmp_path / "synthetic.sqlite")
    migrate(pg, value)
    other = tmp_path / "other.sqlite"
    open_schema8_fixture(other).close()
    pg.sql(bundle_sql(snapshot(other)), ok=False)
    pg.sql(verification_sql(value))
    sql = "BEGIN;" + "\n".join(transaction_settings() + replay_statements(value))
    out, _ = pg.sql(sql + "SELECT txid_current_if_assigned() IS NULL; COMMIT;")
    assert out == "t"  # No data/DDL write transaction ID allocated on replay.


def test_cloud_statements_are_independent_and_identical_to_psql(pg, tmp_path):
    value, _ = native_history(tmp_path / "history.sqlite", "round_trip")
    plan = cloud_smoke_plan(value)
    (tmp_path / "neon-smoke-plan.json").write_text(json.dumps(plan, indent=2))
    (tmp_path / "manifest.json").write_bytes(value.manifest())
    session = pg.session()
    try:
        session.send("BEGIN;")
        for number, statement in enumerate(plan["transaction_statements"]):
            assert statement in bundle_sql(value)
            assert not statement.lstrip().startswith("\\")
            # Separate round trip per statement, including intact PL/pgSQL bodies.
            session.send(statement + f"\nSELECT 'statement-{number}';")
            assert session.line() == f"statement-{number}"
        session.send("COMMIT; SELECT 'committed';")
        assert session.line() == "committed"
    finally:
        session.close()
    pg.sql(bundle_sql(value))  # psql accepts the independently executed cloud target.
    pg.sql(verification_sql(value))


@pytest.mark.parametrize("limit", ["cash", "risk"])
@pytest.mark.parametrize("schedule", ["overlap", "a_first", "b_first"])
def test_two_nonowner_backends_cash_risk_cas(pg, tmp_path, limit, schedule):
    path = tmp_path / "proposals.sqlite"
    initial = tmp_path / "initial.sqlite"
    current = path.with_suffix(".current.sqlite")
    initial_current = initial.with_suffix(".current.sqlite")
    with plan_setup(current) as (control, binding, _, store, admission, *_):
        old = plan_reserve(control, binding, admission.update.admission_id, key="old-unknown")
        with sqlite3.connect(initial_current) as target:
            store._connection.backup(target)
        target.close()
        proposals = [plan_reserve(control, binding, admission.update.admission_id, key=k)
                     for k in ("proposal-a", "proposal-b")]
    derive_schema8_fixture(initial_current, initial)
    derive_schema8_fixture(current, path)
    value, proposed = snapshot(initial), snapshot(path)
    migrate(pg, value)
    quote = risk.size_spot(SimulationPolicy().profile(), risk.SizingLimits(
        risk.Pair("BTC", "USDT"), "5", "1000", "10000", "0.00001", "5")).costs
    assert quote is not None
    assert (quote.quantity, quote.reserve, quote.stress_loss) == (
        "0.00368", "221.46284528", "4.99377472")
    assert all((p.quantity, p.cash_hold, p.stress_loss) == (
        quote.quantity, quote.reserve, quote.stress_loss) for p in proposals)
    app = backend(pg, tmp_path)
    a, b = app.session(), app.session()
    # Conservative synthetic available-cash/risk ceilings, NOT a new cash ledger
    # or a port of the native freshness/admission/Control algorithm.
    cash_cap = "442.92569056" if limit == "cash" else "10000"
    risk_cap = "10" if limit == "risk" else "25"
    epoch = int(pg.sql("SELECT risk_epoch FROM pg1_control.astarter_accounts;")[0])
    fence = int(pg.sql("SELECT controller_fence FROM pg1_control.astarter_accounts;")[0])
    assert Fraction(cash_cap) >= Fraction(old.cash_hold) + Fraction(quote.reserve)
    rows = []
    for proposal in proposals:
        selected = []
        for t in proposed.tables:
            if t.name not in {"astarter_intents", "astarter_orders", "astarter_intent_admissions"}:
                continue
            key = [n for n, _ in t.columns].index("intent_id")
            selected.append(replace(
                t, rows=tuple(r for r in t.rows if r[key] == proposal.intent_id)))
        selected.sort(key=lambda t: ["astarter_intents", "astarter_orders",
                                     "astarter_intent_admissions"].index(t.name))
        rows.append("\n".join(import_statements(replace(proposed, tables=tuple(selected)))))
    first, second = (b, a) if schedule == "b_first" else (a, b)
    winner = 1 if schedule == "b_first" else 0
    observed = []
    lock = PREFIX + ("SELECT risk_epoch FROM astarter_accounts "
                     "WHERE account_id='SIM-001' FOR UPDATE;")

    def capacity(session):
        session.send("SELECT (sum(cash_hold::numeric)+221.46284528<=" + cash_cap
                     + " AND sum(pending_risk::numeric+inventory_risk::numeric)+5<="
                     + risk_cap + ") FROM astarter_intents WHERE account_id='SIM-001';")
        return session.line()

    try:
        assert a.pid != b.pid
        first.send(lock)
        assert int(first.line()) == epoch
        if schedule == "overlap":
            second.send(lock)
            end = time.monotonic() + 5
            while time.monotonic() < end:
                waiting = pg.sql("SELECT wait_event_type FROM pg_stat_activity "
                                 f"WHERE pid={second.pid};")[0]
                if waiting == "Lock":
                    break
                time.sleep(0.02)
            else:
                pytest.fail("PG1_NO_OBSERVED_LOCK_WAIT")
            observed.append("second_waiting_on_first_row_lock")
        assert capacity(first) == "t"
        first.send(f"UPDATE astarter_accounts SET risk_epoch=risk_epoch+1 "
                   f"WHERE account_id='SIM-001' AND risk_epoch={epoch} "
                   f"AND controller_fence={fence} RETURNING risk_epoch;")
        assert int(first.line()) == epoch + 1
        first.send(rows[winner] + "\nCOMMIT; SELECT 'winner-committed';")
        assert first.line() == "winner-committed"
        if schedule != "overlap":
            second.send(lock)
        assert int(second.line()) == epoch + 1
        second.send(f"WITH u AS (UPDATE astarter_accounts SET risk_epoch=risk_epoch+1 "
                    f"WHERE account_id='SIM-001' AND risk_epoch={epoch} "
                    f"AND controller_fence={fence} RETURNING 1) SELECT count(*) FROM u;")
        assert second.line() == "0"
        assert capacity(second) == "f"
        second.send("ROLLBACK; SELECT 'loser-rolledback';")
        assert second.line() == "loser-rolledback"
        observed += ["winner_committed", "stale_cas_zero", "fresh_capacity_rejected"]
    finally:
        a.close()
        b.close()
    assert pg.sql("SELECT count(*),sum(cash_hold::numeric),sum(pending_risk::numeric) "
                  "FROM pg1_control.astarter_intents;")[0] == "2|442.92569056|10"
    assert pg.sql("SELECT cash_hold,pending_risk,inventory_risk FROM pg1_control.astarter_intents "
                  "WHERE opportunity_key='old-unknown';")[0] == "221.46284528|5|0"
    assert pg.sql("SELECT native_state FROM pg1_control.astarter_orders WHERE order_id='"
                  + old.entry_order_id + "';")[0] == "UNKNOWN"
    (tmp_path / "schedule.json").write_text(json.dumps({
        "backend_pids": [a.pid, b.pid], "nonowner": app.user, "schedule": schedule,
        "observed": observed, "limit": limit, "cash_cap": cash_cap, "risk_cap": risk_cap,
        "source_q03_reserve": quote.reserve, "scope": "SQL_PATTERN_NOT_CONTROL_PORT"}, indent=2))


@pytest.mark.parametrize("failure", ["commit", "interrupt"])
def test_import_commit_failure_or_interruption_has_no_half_schema(pg, tmp_path, failure):
    value = synthetic(tmp_path / "synthetic.sqlite")
    statements = cloud_smoke_plan(value)["transaction_statements"]
    if failure == "commit":
        # Existing deferred FK is valid throughout import, then broken in this
        # NEW fixture transaction. The deletion returns before COMMIT rejects it.
        sql = "BEGIN;" + "\n".join(statements) + (
            "SET LOCAL pg1.writer_version='1'; DELETE FROM pg1_control.runner_outcomes "
            "WHERE run_id='synthetic-terminal' RETURNING 'precommit-delete-succeeded'; COMMIT;")
        out, err = pg.sql(sql, ok=False)
        assert out == "precommit-delete-succeeded" and "23503" in err
    else:
        session = pg.session()
        try:
            session.send("BEGIN;" + "\n".join(statements) + "SELECT 'import-uncommitted';")
            assert session.line() == "import-uncommitted"
            assert pg.sql(f"SELECT pg_terminate_backend({session.pid});")[0] == "t"
            session.send("SELECT 1;")
            session.process.communicate(timeout=10)
            assert session.process.returncode != 0
            (tmp_path / "import-interruption.json").write_text(json.dumps({
                "backend_pid": session.pid, "state": "TERMINATED_AFTER_IMPORT_BEFORE_COMMIT"}))
        finally:
            session.close()
    assert pg.sql("SELECT count(*) FROM pg_namespace WHERE nspname='pg1_control';")[0] == "0"
    # Failure consumed no schema/data identity; exact source can recover normally.
    migrate(pg, value)
    pg.sql(bundle_sql(value))


def test_exact_bigint_lower_bound_sparse_rowid_empty_bytes_and_null(pg, tmp_path):
    path = tmp_path / "edges.sqlite"
    conn = open_schema8_fixture(path)
    for rowid, name, raw in ((-(2**63), "空'\\\n", b""), (9, "later", b"\x00\xff")):
        conn.execute("INSERT INTO runs(rowid,run_id,created_at_ns) VALUES(?,?,?)",
                     (rowid, name, 2**63-1))
        conn.execute("INSERT INTO runner_outcomes VALUES(?,?,?,0)",
                     (name, raw, sha256(raw).hexdigest()))
    conn.close()
    value = snapshot(path)
    migrate(pg, value)
    pg.sql(bundle_sql(value))
    assert pg.sql("SELECT legacy_rowid FROM pg1_control.runs ORDER BY legacy_rowid;")[0] == (
        "-9223372036854775808\n9")
    assert pg.sql("SELECT input_manifest_bytes IS NULL FROM pg1_control.runs "
                  "ORDER BY legacy_rowid;")[0] == "t\nt"
    assert pg.sql("SELECT octet_length(outcome_bytes) FROM pg1_control.runner_outcomes "
                  "ORDER BY legacy_rowid;")[0] == "0\n2"
    assert sha256(path.read_bytes()).hexdigest() == value.source_sha256


# Exact sanitized platform facts: two objects, NINE privileges, not GRANT ALL.
NEON_DEFAULTS = """ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin IN SCHEMA public
GRANT SELECT,UPDATE,USAGE ON SEQUENCES TO neon_superuser WITH GRANT OPTION;
ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin IN SCHEMA public
GRANT DELETE,INSERT,MAINTAIN,SELECT,TRUNCATE,UPDATE ON TABLES
TO neon_superuser WITH GRANT OPTION;"""
NEON_REVOKE = """ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin IN SCHEMA public
REVOKE SELECT,UPDATE,USAGE ON SEQUENCES FROM neon_superuser;
ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin IN SCHEMA public
REVOKE DELETE,INSERT,MAINTAIN,SELECT,TRUNCATE,UPDATE ON TABLES FROM neon_superuser;"""


def neon_defaults(pg):
    for role in ("cloud_admin", "neon_superuser", "pg1_other_creator"):
        if pg.sql(f"SELECT count(*) FROM pg_roles WHERE rolname='{role}';")[0] == "0":
            pg.sql(f"CREATE ROLE {role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;")
    pg.sql(NEON_DEFAULTS)


def catalog_text(pg):
    return pg.sql("SET search_path=pg_catalog; SELECT v FROM (" + catalog_rows_sql()
                  + ") c ORDER BY v COLLATE \"C\";")[0]


@pytest.mark.parametrize("profile", list(TargetProfile))
def test_target_profiles_import_replay_wrong_profile_and_typed(pg, tmp_path, profile):
    if profile is TargetProfile.NEON_PG17_V1:
        neon_defaults(pg)
    value = synthetic(tmp_path / "profile.sqlite")
    empty, full = profile_pins(profile)
    assert sha256(catalog_text(pg).encode()).hexdigest() == empty
    wrong = (TargetProfile.NEON_PG17_V1 if profile is TargetProfile.LOCAL_PG17
             else TargetProfile.LOCAL_PG17)
    before = catalog_text(pg)
    _, error = pg.sql("\\set VERBOSITY default\n" + bundle_sql(value, profile=wrong), ok=False)
    assert "PG1_TARGET_NOT_EMPTY" in error and catalog_text(pg) == before
    pg.sql(bundle_sql(value, profile=profile))
    assert sha256(catalog_text(pg).encode()).hexdigest() == full
    pg.sql(bundle_sql(value, profile=profile))  # independent connection replay
    replay = "BEGIN;" + "\n".join(transaction_settings()
                                    + replay_statements(value, profile=profile))
    assert pg.sql(replay + "SELECT txid_current_if_assigned() IS NULL; COMMIT;")[0] == "t"
    before = catalog_text(pg)
    # The identical source manifest is insufficient for the wrong target profile.
    _, error = pg.sql("\\set VERBOSITY default\n" + bundle_sql(value, profile=wrong), ok=False)
    assert "PG1_CATALOG_MISMATCH" in error and catalog_text(pg) == before
    pg.sql(verification_sql(value, profile=profile))
    assert sha256((tmp_path / "profile.sqlite").read_bytes()).hexdigest() == value.source_sha256
    if profile is TargetProfile.NEON_PG17_V1:
        rows = [json.loads(x) for x in before.splitlines()]
        heads = [r for r in rows if r[0] == "default_acl"]
        grants = [r for r in rows if r[0] == "default_acl_grant"]
        assert heads == [["default_acl", "cloud_admin", ["schema", "public"], k]
                         for k in ("S", "r")]
        expected = [("S", p) for p in ("SELECT", "UPDATE", "USAGE")] + [
            ("r", p) for p in ("DELETE", "INSERT", "MAINTAIN", "SELECT", "TRUNCATE", "UPDATE")]
        assert grants == [["default_acl_grant", "cloud_admin", ["schema", "public"],
                           k, "cloud_admin", ["role", "neon_superuser"], p, True]
                          for k, p in expected]
        # Defaults apply to future objects of that creator/schema, not these tables.
        assert pg.sql("SELECT count(*) FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a "
                      "WHERE c.relnamespace='pg1_control'::regnamespace "
                      "AND a.grantee='neon_superuser'::regrole;")[0] == "0"


@pytest.mark.parametrize("imported", [False, True])
@pytest.mark.parametrize("change", [
    "missing", "references", "trigger", "owner", "grantee", "schema", "global",
    "grantable", "empty_object", "extra_type", "other_object", "column_acl",
])
def test_neon_default_acl_drift_refuses_without_repair(pg, tmp_path, imported, change):
    neon_defaults(pg)
    value = synthetic(tmp_path / "profile.sqlite")
    profile = TargetProfile.NEON_PG17_V1
    if imported:
        pg.sql(bundle_sql(value, profile=profile))
    prefix = "ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin IN SCHEMA public "
    if change == "missing":
        sql = prefix + "REVOKE SELECT ON SEQUENCES FROM neon_superuser;"
    elif change in {"references", "trigger"}:
        sql = prefix + f"GRANT {change.upper()} ON TABLES TO neon_superuser WITH GRANT OPTION;"
    elif change in {"owner", "grantee", "schema", "global"}:
        replacement = {
            "owner": NEON_DEFAULTS.replace("FOR ROLE cloud_admin", "FOR ROLE pg1_other_creator"),
            "grantee": NEON_DEFAULTS.replace("TO neon_superuser", "TO pg1_other_creator"),
            "schema": "CREATE SCHEMA extra;"
            + NEON_DEFAULTS.replace("SCHEMA public", "SCHEMA extra"),
            "global": NEON_DEFAULTS.replace(" IN SCHEMA public", ""),
        }[change]
        sql = NEON_REVOKE + replacement
    elif change == "grantable":
        sql = prefix + "REVOKE GRANT OPTION FOR SELECT ON SEQUENCES FROM neon_superuser;"
    elif change == "empty_object":
        # Ordinary DDL creates an empty global function-default ACL, no catalog writes.
        sql = ("ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin "
               "REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC,cloud_admin;")
    elif change == "extra_type":
        sql = prefix + "GRANT USAGE ON TYPES TO neon_superuser;"
    elif change == "other_object":
        sql = "CREATE TABLE public.extra(x bigint); INSERT INTO public.extra VALUES(17);"
    elif not imported:
        sql = ("CREATE TABLE public.extra(x bigint); INSERT INTO public.extra VALUES(17);"
               "GRANT SELECT(x) ON public.extra TO neon_superuser;")
    else:
        sql = "GRANT SELECT(run_id) ON pg1_control.runs TO neon_superuser;"
    pg.sql(sql)
    before = catalog_text(pg)
    raw_acl_sql = ("SELECT defaclrole,defaclnamespace,defaclobjtype,defaclacl::text "
                   "FROM pg_default_acl ORDER BY oid;")
    raw_acl = pg.sql(raw_acl_sql)[0]
    rows = [json.loads(x) for x in before.splitlines()]
    if change == "empty_object":
        assert ["default_acl", "cloud_admin", ["global"], "f"] in rows
        assert not [r for r in rows if r[0] == "default_acl_grant" and r[2:4] == [["global"], "f"]]
        assert pg.sql("SELECT cardinality(defaclacl) FROM pg_default_acl "
                      "WHERE defaclnamespace=0 AND defaclobjtype='f';")[0] == "0"
    elif change == "global":
        assert any(r[0] == "default_acl" and r[2] == ["global"] for r in rows)
    for profile_attempt in (profile, TargetProfile.LOCAL_PG17):
        _, error = pg.sql("\\set VERBOSITY default\n"
                          + bundle_sql(value, profile=profile_attempt), ok=False)
        assert ("PG1_CATALOG_MISMATCH" if imported else "PG1_TARGET_NOT_EMPTY") in error
        assert catalog_text(pg) == before  # Includes all ACL semantics, never repairs.
        assert pg.sql(raw_acl_sql)[0] == raw_acl
        if change == "other_object" or (change == "column_acl" and not imported):
            assert pg.sql("SELECT x FROM public.extra;")[0] == "17"
    if imported:
        pg.sql(verification_sql(value, profile=profile))
        verify = "BEGIN;" + "\n".join(transaction_settings()
                                        + replay_statements(value, profile=profile)) + "COMMIT;"
        _, error = pg.sql("\\set VERBOSITY default\n" + verify, ok=False)
        assert "PG1_CATALOG_MISMATCH" in error
        assert catalog_text(pg) == before
        pg.sql(verification_sql(value, profile=profile))
    else:
        assert pg.sql("SELECT count(*) FROM pg_namespace WHERE nspname='pg1_control';")[0] == "0"


def test_neon_default_acl_grant_order_canonicalization(pg):
    neon_defaults(pg)
    before = catalog_text(pg)
    pg.sql(NEON_REVOKE)
    for kind, privileges in (
        ("TABLES", ("UPDATE", "TRUNCATE", "SELECT", "MAINTAIN", "INSERT", "DELETE")),
        ("SEQUENCES", ("USAGE", "UPDATE", "SELECT")),
    ):
        for privilege in privileges:
            pg.sql("ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin IN SCHEMA public "
                   f"GRANT {privilege} ON {kind} TO neon_superuser WITH GRANT OPTION;")
    assert catalog_text(pg) == before


@pytest.mark.parametrize("imported", [False, True])
@pytest.mark.parametrize("empty_acl", [False, True])
def test_local_global_default_acl_is_not_invisible(pg, tmp_path, imported, empty_acl):
    value = synthetic(tmp_path / "local.sqlite")
    if imported:
        migrate(pg, value)
    privilege = ("REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC," + pg.user if empty_acl
                 else "GRANT SELECT ON TABLES TO PUBLIC")
    pg.sql("ALTER DEFAULT PRIVILEGES " + privilege + ";")
    before = catalog_text(pg)
    rows = [json.loads(line) for line in before.splitlines()]
    assert any(r[0] == "default_acl" and r[2] == ["global"] for r in rows)
    if empty_acl:
        assert ["default_acl", pg.user, ["global"], "f"] in rows
        assert not any(r[0] == "default_acl_grant" for r in rows)
    _, error = pg.sql("\\set VERBOSITY default\n" + bundle_sql(value), ok=False)
    assert ("PG1_CATALOG_MISMATCH" if imported else "PG1_TARGET_NOT_EMPTY") in error
    assert catalog_text(pg) == before
    if imported:
        pg.sql(verification_sql(value))
    else:
        assert pg.sql("SELECT count(*) FROM pg_namespace WHERE nspname='pg1_control';")[0] == "0"
