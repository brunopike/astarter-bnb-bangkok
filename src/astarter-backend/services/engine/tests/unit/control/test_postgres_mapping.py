"""PG1 offline mapping and fixed-error-category contract tests."""

import json
import re
import sqlite3
import sys
from hashlib import sha256

import pytest

from stark_trading_os.control.database import open_control_database
from stark_trading_os.control.postgres.synthetic_migration import (
    MigrationRejected,
    TargetProfile,
    bundle_sql,
    catalog_check_sql,
    cloud_smoke_plan,
    frame,
    literal,
    main,
    new_target_statements,
    profile_pins,
    replay_statements,
    schema_sql,
    snapshot,
    sql_statements,
    verification_sql,
)
from tests.unit.control.pg_schema8_fixture import open_schema8_fixture


def test_all_37_tables_and_frozen_types(tmp_path):
    path = tmp_path / "closed.sqlite"
    open_schema8_fixture(path).close()
    before = path.read_bytes()
    value = snapshot(path)
    assert len(value.tables) == 37
    assert {kind for t in value.tables for _, kind in t.columns} == {"TEXT", "INTEGER", "BLOB"}
    assert all(not t.rows for t in value.tables)
    manifest = json.loads(value.manifest())
    assert len(manifest["tables"]) == 37
    assert manifest["schema_sha256"] == sha256(schema_sql().encode()).hexdigest()
    sql = bundle_sql(value)
    assert sql.count("CREATE TABLE ") == 38  # 37 source tables + migration metadata
    assert "BEGIN IMMEDIATE" not in sql and "stark_control_writer" not in sql
    assert "JSONB" not in sql and "DOUBLE PRECISION" not in sql
    assert path.read_bytes() == before
    assert not list(tmp_path.glob("*-wal")) and not list(tmp_path.glob("*-shm"))


def test_all_guard_functions_pin_namespace_resolution():
    functions = re.findall(
        r"CREATE FUNCTION (\w+)\(\) RETURNS trigger(.*?)AS \$\$(.*?)\$\$;",
        schema_sql(), re.S,
    )
    expected = {f"pg1_guard_{i:03d}" for i in range(90)} | {
        "pg1_require_writer", "pg1_no_truncate", "pg1_rowid_immutable",
    }
    assert {name for name, _, _ in functions} == expected
    assert len(functions) == len(expected)
    for _, configuration, _ in functions:
        assert " ".join(configuration.split()) == (
            "LANGUAGE plpgsql SET search_path = pg_catalog, pg1_control, pg_temp"
        )
    writer = next(body for name, _, body in functions if name == "pg1_require_writer")
    assert "FROM pg1_control.pg1_metadata" in writer and "FOR SHARE" in writer
    assert not re.search(r"\bFROM\s+pg1_metadata\b", writer)


def test_sparse_rowid_and_exact_typed_values(tmp_path):
    path = tmp_path / "closed.sqlite"
    c = open_schema8_fixture(path)
    for rowid, name in ((9, "later"), (-7, "earlier")):
        c.execute("INSERT INTO runs(rowid,run_id,created_at_ns) VALUES(?,?,?)",
                  (rowid, name, 2**63 - 1))
    c.execute("UPDATE runs SET catalog_revision=NULL WHERE run_id='earlier'")
    c.close()
    first = snapshot(path)
    table = next(t for t in first.tables if t.name == "runs")
    assert table.ordering == ("legacy_rowid",)
    assert [r[0] for r in table.rows] == [-7, 9]
    assert first == snapshot(path)
    assert len(set(table.row_hashes)) == 2
    assert frame(None) != frame("") != frame(b"")
    assert frame("001.230000000000000001") != frame("1.230000000000000001")
    assert literal(b"\x00\xff\\'\n") == "decode('00ff5c270a','hex')"
    assert frame(2**63 - 1).endswith(b"9223372036854775807")
    assert frame(-(2**63)).endswith(b"-9223372036854775808")


@pytest.mark.parametrize("value,category", [
    ("private\x00not-logged", "PG1_TEXT_NUL"), (True, "PG1_CELL_TYPE"),
    (1.5, "PG1_CELL_TYPE"), (2**63, "PG1_INTEGER_RANGE"),
    (-(2**63)-1, "PG1_INTEGER_RANGE"), ("\ud800", "PG1_TEXT_ENCODING"),
])
def test_representability_rejects_without_input_in_error(value, category):
    with pytest.raises(MigrationRejected) as caught:
        frame(value)
    assert str(caught.value) == category


def test_nul_source_rejected_without_rewrite(tmp_path):
    path = tmp_path / "closed.sqlite"
    c = open_schema8_fixture(path)
    c.execute("INSERT INTO runs(run_id,created_at_ns) VALUES(?,0)", ("synthetic\x00text",))
    c.close()
    before = path.read_bytes()
    with pytest.raises(MigrationRejected, match="^PG1_TEXT_NUL$"):
        snapshot(path)
    assert path.read_bytes() == before


@pytest.mark.parametrize("case", ["wal", "version", "schema", "symlink"])
def test_source_preconditions(tmp_path, case):
    path = tmp_path / "closed.sqlite"
    c = open_schema8_fixture(path)
    c.close()
    if case == "wal":
        (tmp_path / "closed.sqlite-wal").write_bytes(b"")
    elif case == "version":
        with sqlite3.connect(path) as c:
            c.execute("PRAGMA user_version=7")
        c.close()
    elif case == "schema":
        with sqlite3.connect(path) as c:
            c.execute("CREATE TABLE unrelated(x)")
        c.close()
    else:
        link = tmp_path / "link.sqlite"
        link.symlink_to(path)
        path = link
    with pytest.raises(MigrationRejected):
        snapshot(path)


def test_cloud_lists_preserve_dollar_bodies_and_have_no_destructive_commands(tmp_path):
    path = tmp_path / "closed.sqlite"
    open_schema8_fixture(path).close()
    source = snapshot(path)
    statements = sql_statements(schema_sql())
    assert len(statements) == 400
    assert sql_statements("\n".join(statements)) == statements
    assert sum("CREATE FUNCTION " in s for s in statements) == 93
    plan = cloud_smoke_plan(source)
    for statement in plan["transaction_statements"]:
        assert statement in bundle_sql(source)
        assert not re.search(r"(?im)^\s*(DROP|TRUNCATE|DELETE|CREATE EXTENSION)\b", statement)
        assert not re.search(r"(?m)^\s*\\", statement)
    assert plan["manifest_sha256"] == sha256(source.manifest()).hexdigest()
    assert plan["source_sha256"] == source.source_sha256


@pytest.mark.parametrize("sql", [
    "SELECT 'unclosed;", "DO $$ BEGIN NULL; END;", "SELECT 1", "/*x*/;",
])
def test_statement_boundary_rejects_unsupported_or_unclosed_input(sql):
    with pytest.raises(MigrationRejected, match="PG1_SQL_BOUNDARY"):
        sql_statements(sql)


@pytest.mark.parametrize("profile", [None, *TargetProfile])
def test_fixed_target_profile_exports_and_cli(tmp_path, monkeypatch, profile):
    selection = [] if profile is None else ["--target-profile", profile.value]
    profile = TargetProfile.LOCAL_PG17 if profile is None else profile
    path = tmp_path / "closed.sqlite"
    open_schema8_fixture(path).close()
    source = snapshot(path)
    before = source.manifest()
    empty, full = profile_pins(profile)
    plan = cloud_smoke_plan(source, profile=profile)
    assert plan["target_profile"] == profile.value
    assert plan["target"] == ("NEW_EXCLUSIVE_EMPTY_CHILD_OF_EXISTING_NEON_SANDBOX"
                              if profile is TargetProfile.NEON_PG17_V1
                              else "NEW_EXCLUSIVE_EMPTY_LOCAL_PG17")
    assert (plan["empty_catalog_sha256"], plan["catalog_sha256"]) == (empty, full)
    assert plan["manifest_sha256"] == sha256(before).hexdigest()
    assert empty in new_target_statements(source, profile=profile)[0]
    assert full in replay_statements(source, profile=profile)[-2]
    assert plan["execution_authorized"] is False
    for statement in plan["transaction_statements"] + plan["reopen_transaction_statements"]:
        assert statement in bundle_sql(source, profile=profile)
    output = tmp_path / "export"
    monkeypatch.setattr(sys, "argv", ["pg1", "--closed-synthetic-source", str(path),
        "--new-output-directory", str(output), *selection])
    assert main() == 0
    assert (output / "manifest.json").read_bytes() == before == source.manifest()
    assert json.loads((output / "neon-smoke-plan.json").read_text()) == plan
    assert (output / "bundle.sql").read_text() == bundle_sql(source, profile=profile)
    assert full in (output / "verify.sql").read_text()
    assert bundle_sql(source) == bundle_sql(source, profile=TargetProfile.LOCAL_PG17)


@pytest.mark.parametrize("invalid", [None, "LOCAL_PG17", "NEON_PG17_V1", "auto", {}, 1])
def test_unknown_profile_rejected_before_source_access(invalid):
    for entry in (bundle_sql, cloud_smoke_plan, new_target_statements,
                  replay_statements, verification_sql):
        with pytest.raises(MigrationRejected, match="^PG1_TARGET_PROFILE$"):
            entry(None, profile=invalid)
    with pytest.raises(MigrationRejected, match="^PG1_TARGET_PROFILE$"):
        catalog_check_sql(profile=invalid)


def test_cli_unknown_profile_has_no_source_or_output_io(tmp_path, monkeypatch):
    output = tmp_path / "not-created"
    monkeypatch.setattr(sys, "argv", ["pg1", "--closed-synthetic-source", "missing",
        "--new-output-directory", str(output), "--target-profile", "auto"])
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 2 and not output.exists()


def test_current_schema9_is_not_a_pg_schema8_source(tmp_path):
    path = tmp_path / "current.sqlite"
    open_control_database(path).close()
    before = path.read_bytes()
    with pytest.raises(MigrationRejected, match="^PG1_SOURCE_VERSION$"):
        snapshot(path)
    assert path.read_bytes() == before
