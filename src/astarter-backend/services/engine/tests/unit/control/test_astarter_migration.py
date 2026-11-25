"""Schema-only checks: no inserted scalar is asserted to be a native account fact."""

import multiprocessing
import sqlite3

import pytest

from stark_trading_os.control import database as db

TABLES = {
    "astarter_accounts",
    "astarter_bindings",
    "astarter_limits",
    "astarter_intents",
    "astarter_orders",
    "astarter_fills",
    "astarter_settlements",
    "astarter_audit",
}


def legacy_v5(path):
    c = sqlite3.connect(path, isolation_level=None)
    c.row_factory = sqlite3.Row
    c.create_function("stark_control_writer_schema_version", 0, lambda: 5, deterministic=True)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=FULL")
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("PRAGMA busy_timeout=5000")
    for version in range(1, 6):
        c.executescript(db._migration_sql(version))
    c.execute("INSERT INTO runs(run_id,state,created_at_ns) VALUES ('bt_keep','DRAFT',10)")
    return c


def test_schema6_upgrades_exact_v5_preserves_data_and_reopens(tmp_path):
    path = tmp_path / "control.sqlite"
    legacy_v5(path).close()
    for _ in range(2):
        c = db.open_control_database(path)
        try:
            assert c.execute("PRAGMA user_version").fetchone()[0] == 9
            assert (
                c.execute("SELECT state FROM runs WHERE run_id='bt_keep'").fetchone()[0] == "DRAFT"
            )
            names = {v[0] for v in c.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
            assert TABLES <= names
            assert c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert not c.execute("PRAGMA foreign_key_check").fetchall()
        finally:
            c.close()


def test_already_open_schema5_writer_is_fenced_on_existing_and_new_tables(tmp_path):
    path = tmp_path / "control.sqlite"
    old = legacy_v5(path)
    new = db.open_control_database(path)
    try:
        assert new.execute("PRAGMA user_version").fetchone()[0] == 9
        new.execute(
            "INSERT INTO astarter_accounts(account_id,venue_session,baseline_quote,risk_period,"
            "lock_fraction) VALUES "
            "('SIM-001','11111111-1111-1111-1111-111111111111','10000','period-1','0.2')"
        )
        for sql in [
            "UPDATE runs SET created_at_ns=created_at_ns WHERE run_id='bt_keep'",
            "UPDATE astarter_accounts SET risk_epoch=risk_epoch WHERE account_id='SIM-001'",
        ]:
            with pytest.raises(sqlite3.OperationalError, match="stark_control_writer_schema9"):
                old.execute(sql)
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            new.execute("UPDATE astarter_accounts SET lock_fraction='0' WHERE account_id='SIM-001'")
    finally:
        old.close()
        new.close()


def test_schema6_failed_upgrade_rolls_back_without_touching_v5(monkeypatch, tmp_path):
    path = tmp_path / "control.sqlite"
    c = legacy_v5(path)
    fingerprint = db._schema_fingerprint(c)
    c.close()
    original = db._migration_sql

    def broken(version):
        if version == 6:
            return (
                "BEGIN IMMEDIATE;\nCREATE TABLE temporary_probe(x);\nSELECT "
                "missing_column;\nPRAGMA user_version = 6;\nCOMMIT;\n"
            )
        return original(version)

    monkeypatch.setattr(db, "_migration_sql", broken)
    with pytest.raises(sqlite3.Error):
        db.open_control_database(path)
    c = sqlite3.connect(path)
    try:
        assert c.execute("PRAGMA user_version").fetchone()[0] == 5
        assert db._schema_fingerprint(c) == fingerprint
        assert c.execute("SELECT state FROM runs WHERE run_id='bt_keep'").fetchone()[0] == "DRAFT"
    finally:
        c.close()


def open_worker(path, barrier, queue):
    barrier.wait(timeout=15)
    c = db.open_control_database(path)
    try:
        queue.put(c.execute("PRAGMA user_version").fetchone()[0])
    finally:
        c.close()


def test_schema6_concurrent_bootstrap_from_v5_uses_one_final_schema(tmp_path):
    path = tmp_path / "control.sqlite"
    legacy_v5(path).close()
    ctx = multiprocessing.get_context("spawn")
    barrier, output = ctx.Barrier(2), ctx.Queue()
    workers = [ctx.Process(target=open_worker, args=(str(path), barrier, output)) for _ in range(2)]
    for p in workers:
        p.start()
    try:
        assert sorted(output.get(timeout=25) for _ in workers) == [9, 9]
    finally:
        for p in workers:
            p.join(timeout=5)
            if p.is_alive():
                p.terminate()
                p.join(timeout=5)
        output.close()
    assert all(p.exitcode == 0 for p in workers)
