"""Offline fixture derivation checks; no PG process, socket, API or cloud access."""

import sqlite3
from fractions import Fraction
from hashlib import sha256

import pytest

from stark_trading_os.control import database as db
from stark_trading_os.control.postgres.synthetic_migration import snapshot
from tests.integration.control.test_postgres_synthetic_migration import native_history, synthetic
from tests.unit.control.pg_schema8_fixture import (
    derive_schema8_fixture,
    legacy_rows,
    open_schema8_fixture,
)
from tests.unit.control.test_astarter_transactions import plan_reserve, plan_setup
from tests.unit.control.test_s03_schema9_migration import populated_v8


def populated_current(path):
    populated_v8(path).close()
    conn = db.open_control_database(path)
    for rowid, name, raw in ((-(2**63), "空'\\\n", b""), (9, "sparse", b"\x00\xff\\'\n")):
        conn.execute("INSERT INTO runs(rowid,run_id,created_at_ns) VALUES(?,?,?)",
                     (rowid, name, 2**63-1))
        conn.execute("INSERT INTO runner_outcomes VALUES(?,?,?,0)",
                     (name, raw, sha256(raw).hexdigest()))
    return conn


def test_frozen_empty_factory_has_exact8_and_only_legacy_writer_capabilities(tmp_path):
    path = tmp_path / "empty.sqlite"
    conn = open_schema8_fixture(path)
    db._verify_exact_schema(conn, version=8)
    assert tuple(conn.execute("SELECT stark_control_writer_schema7(),"
                              "stark_control_writer_schema8()").fetchone()) == (7, 8)
    with pytest.raises(sqlite3.OperationalError, match="stark_control_writer_schema9"):
        conn.execute("SELECT stark_control_writer_schema9()")
    conn.close()
    assert len(snapshot(path).tables) == 37
    before = path.read_bytes()
    with pytest.raises(FileExistsError):
        open_schema8_fixture(path)
    assert path.read_bytes() == before


def test_derived_copy_preserves_all_37_tables_types_blobs_and_sparse_rowids(tmp_path):
    source, destination = tmp_path / "current.sqlite", tmp_path / "pg.sqlite"
    conn = populated_current(source)
    before_rows = legacy_rows(conn)
    conn.close()
    before = source.read_bytes()
    assert derive_schema8_fixture(source, destination) == destination
    assert source.read_bytes() == before
    conn = sqlite3.connect(destination)
    try:
        db._verify_exact_schema(conn, version=8)
        assert legacy_rows(conn) == before_rows
    finally:
        conn.close()
    result = snapshot(destination)
    assert result.source_sha256 == sha256(destination.read_bytes()).hexdigest()
    runs = next(table for table in result.tables if table.name == "runs")
    assert [row[0] for row in runs.rows] == [-(2**63), 1, 9]
    assert all(not list(tmp_path.glob("*" + suffix)) for suffix in ("-wal", "-shm", "-journal"))
    with sqlite3.connect(source) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 9
    conn.close()


@pytest.mark.parametrize("damage", ["extra", "legacy", "version", "nonempty_s03"])
def test_invalid_or_nonempty_current_source_refused_without_rewrite(tmp_path, damage):
    source, destination = tmp_path / "current.sqlite", tmp_path / "pg.sqlite"
    conn = populated_current(source)
    if damage == "extra":
        conn.execute("CREATE TABLE unexpected(x)")
    elif damage == "legacy":
        conn.execute("DROP TRIGGER d2_astarter_accounts_u")
    elif damage == "version":
        conn.execute("PRAGMA user_version=8")
    else:
        conn.execute(
            "INSERT INTO s03_runs(run_id,account_id,venue_session,group_id,plan_sha256,"
            "manifest_sha256,owner_id,owner_epoch,fence,credential_sha256,status,starts_at_ns,"
            "expires_at_ns,reasons) VALUES(?,?,?,?,?,?,?,1,1,?,'ACTIVE',0,100,?)",
            ("a" * 64, "account-a", "11111111-1111-1111-1111-111111111111", "fixture",
             "b" * 64, "c" * 64, "d" * 64, "e" * 64, b"[]"),
        )
    conn.close()
    before = source.read_bytes()
    with pytest.raises((db.DatabaseConfigurationError, ValueError)):
        derive_schema8_fixture(source, destination)
    assert source.read_bytes() == before and not destination.exists()


@pytest.mark.parametrize("suffix", ["-wal", "-shm", "-journal"])
@pytest.mark.parametrize("side", ["source", "destination"])
def test_detached_source_and_destination_required(tmp_path, suffix, side):
    source, destination = tmp_path / "current.sqlite", tmp_path / "pg.sqlite"
    db.open_control_database(source).close()
    path = source if side == "source" else destination
    path.with_name(path.name + suffix).write_bytes(b"fixture-sidecar")
    before = source.read_bytes()
    with pytest.raises(ValueError, match="PG_FIXTURE_NOT_DETACHED"):
        derive_schema8_fixture(source, destination)
    assert source.read_bytes() == before and not destination.exists()


def test_existing_destination_and_source_symlink_refused(tmp_path):
    source, destination = tmp_path / "current.sqlite", tmp_path / "pg.sqlite"
    db.open_control_database(source).close()
    before = source.read_bytes()
    destination.write_bytes(b"keep existing file")
    with pytest.raises(FileExistsError):
        derive_schema8_fixture(source, destination)
    assert destination.read_bytes() == b"keep existing file" and source.read_bytes() == before
    link = tmp_path / "link.sqlite"
    link.symlink_to(source)
    with pytest.raises(ValueError, match="PG_FIXTURE_SOURCE_PATH"):
        derive_schema8_fixture(link, tmp_path / "other.sqlite")


@pytest.mark.parametrize("change", ["unknown", "nonadditive"])
def test_unreviewed_migration_difference_is_not_a_fixture_downgrade(tmp_path, monkeypatch, change):
    source, destination = tmp_path / "current.sqlite", tmp_path / "pg.sqlite"
    db.open_control_database(source).close()
    original = db._expected_schema_fingerprint

    def changed(version):
        rows = original(version)
        if version != 9:
            return rows
        if change == "unknown":
            extra = ("table", "future_table", "future_table", "CREATE TABLE future_table(x)")
            return (*rows, extra)
        return tuple(row for row in rows if row[1] != "d2_astarter_accounts_u")

    monkeypatch.setattr(db, "_expected_schema_fingerprint", changed)
    before = source.read_bytes()
    with pytest.raises(ValueError, match="PG_FIXTURE_(UNKNOWN_ADDITIONS|NON_ADDITIVE_SCHEMA)"):
        derive_schema8_fixture(source, destination)
    assert source.read_bytes() == before and not destination.exists()


def test_failed_derived_copy_does_not_leave_a_half_fixture(tmp_path, monkeypatch):
    source, destination = tmp_path / "current.sqlite", tmp_path / "pg.sqlite"
    db.open_control_database(source).close()
    before = source.read_bytes()
    original = db._verify_exact_schema

    def reject_postflight(conn, *, version):
        if version == 8:
            raise ValueError("synthetic postflight failure")
        return original(conn, version=version)

    monkeypatch.setattr(db, "_verify_exact_schema", reject_postflight)
    with pytest.raises(ValueError, match="synthetic postflight failure"):
        derive_schema8_fixture(source, destination)
    assert source.read_bytes() == before and not destination.exists()
    assert all(not list(tmp_path.glob("*" + suffix)) for suffix in ("-wal", "-shm", "-journal"))


def test_real_current_plan_fixture_is_derived_after_close(tmp_path):
    path = tmp_path / "synthetic.sqlite"
    value = synthetic(path)
    assert value.source_sha256 == sha256(path.read_bytes()).hexdigest()
    current = path.with_suffix(".current.sqlite")
    with sqlite3.connect(current) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 9
        assert conn.execute("SELECT count(*) FROM astarter_intent_admissions").fetchone()[0] == 1
    conn.close()
    assert next(t for t in value.tables if t.name == "astarter_intent_admissions").rows


def test_native_partial_is_its_actual_checkpoint_not_final_history(tmp_path):
    path, partial = tmp_path / "finished.sqlite", tmp_path / "partial.sqlite"
    final, evidence = native_history(path, "partial_stop", partial_path=partial)
    assert evidence["status"] == "COMPLETE"
    earlier = snapshot(partial)
    table = next(t for t in earlier.tables if t.name == "astarter_intents")
    row = dict(zip((c[0] for c in table.columns), table.rows[0], strict=True))
    assert Fraction(row["pending_risk"]) > 0 and Fraction(row["inventory_risk"]) > 0
    assert 0 < Fraction(row["cash_hold"]) < Fraction("221.46284528")
    assert earlier.tables != final.tables
    for fixture in (path, partial):
        assert fixture.with_suffix(".current.sqlite").is_file()
        assert snapshot(fixture).source_sha256 == sha256(fixture.read_bytes()).hexdigest()


def test_plan_initial_and_proposed_are_separate_actual_checkpoints(tmp_path):
    current = tmp_path / "proposals.current.sqlite"
    initial_current = tmp_path / "initial.current.sqlite"
    with plan_setup(current) as (control, binding, _, store, admission, *_):
        plan_reserve(control, binding, admission.update.admission_id, key="old-unknown")
        with sqlite3.connect(initial_current) as target:
            store._connection.backup(target)
        target.close()
        for key in ("proposal-a", "proposal-b"):
            plan_reserve(control, binding, admission.update.admission_id, key=key)
    initial, proposed = tmp_path / "initial.sqlite", tmp_path / "proposals.sqlite"
    derive_schema8_fixture(initial_current, initial)
    derive_schema8_fixture(current, proposed)
    for path, count in ((initial, 1), (proposed, 3)):
        table = next(t for t in snapshot(path).tables if t.name == "astarter_intents")
        assert len(table.rows) == count
