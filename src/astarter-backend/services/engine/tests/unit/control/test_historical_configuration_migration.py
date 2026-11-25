"""Additive migration and explicit kind isolation, against real SQLite connections."""

import multiprocessing
import sqlite3
from hashlib import sha256

import pytest

import stark_trading_os.control.database as database
from stark_trading_os.audit.historical_input import configuration_bytes
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.strategy_configurations import (
    StrategyConfigurationBinding,
    StrategyConfigurationIntegrityError,
    StrategyDraftUnknown,
    _validate_configuration_for_preflight,
)
from stark_trading_os.domain.historical_input import SmaConfigurationInputV2
from tests.integration.control.test_strategy_configuration_races import _configuration
from tests.unit.domain.test_historical_input import config_payload

NOW = 1_700_000_000_000_000_000
DRAFT = "sd_" + "a" * 32
VERSION = "cfg_" + "a" * 32


def exact_v3(path):
    connection = sqlite3.connect(path, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    for version in (1, 2, 3):
        connection.executescript(database._migration_sql(version))
    return connection


def snapshot(connection):
    return tuple(connection.iterdump())


def open_process(path, barrier, queue):
    try:
        barrier.wait(timeout=15)
        connection = database.open_control_database(path)
        try:
            queue.put(("ok", connection.execute("PRAGMA user_version").fetchone()[0]))
        finally:
            connection.close()
    except Exception as error:
        queue.put(("error", type(error).__name__))


def test_schema3_upgrade_preserves_legacy_bytes_rows_and_defaults(tmp_path):
    path = tmp_path / "upgrade.sqlite"
    old = exact_v3(path)
    old.execute("INSERT INTO runs(run_id,state,created_at_ns) VALUES('bt_old','DRAFT',10)")
    old.execute(
        "INSERT INTO strategy_drafts VALUES(?,?,?,?,?,?)",
        (DRAFT, b"legacy-bytes", "a" * 64, 7, NOW, NOW + 7),
    )
    old.execute(
        "INSERT INTO strategy_configuration_versions VALUES(?,?,?,?,?,?,?)",
        (VERSION, DRAFT, 2, 6, b"old-version-bytes", "b" * 64, NOW + 6),
    )
    old.close()
    current = database.open_control_database(path)
    try:
        assert current.execute("PRAGMA user_version").fetchone()[0] == 9
        draft = dict(current.execute("SELECT * FROM strategy_drafts").fetchone())
        assert draft == dict(
            draft_id=DRAFT,
            content_bytes=b"legacy-bytes",
            content_sha256="a" * 64,
            revision=7,
            created_at_ns=NOW,
            updated_at_ns=NOW + 7,
            content_schema="StrategyConfigurationInput.v1",
        )
        version = dict(current.execute("SELECT * FROM strategy_configuration_versions").fetchone())
        assert version["content_bytes"] == b"old-version-bytes"
        assert version["content_sha256"] == "b" * 64
        assert version["source_revision"] == 6 and version["version"] == 2
        assert version["content_schema"] == "StrategyConfigurationInput.v1"
        assert (
            current.execute("SELECT state FROM runs WHERE run_id='bt_old'").fetchone()[0] == "DRAFT"
        )
        before = snapshot(current)
    finally:
        current.close()
    reopened = database.open_control_database(path)
    try:
        assert snapshot(reopened) == before
    finally:
        reopened.close()


def test_failed_fourth_migration_leaves_exact_schema3(tmp_path, monkeypatch):
    path = tmp_path / "rollback.sqlite"
    old = exact_v3(path)
    old.execute("INSERT INTO runs(run_id,state,created_at_ns) VALUES('bt_old','DRAFT',10)")
    before = snapshot(old)
    old.close()
    original = database._migration_sql

    def broken(version):
        sql = original(version)
        return (
            sql.replace(
                "PRAGMA user_version = 4;",
                "INSERT INTO absent_table VALUES(1);\nPRAGMA user_version = 4;",
            )
            if version == 4
            else sql
        )

    monkeypatch.setattr(database, "_migration_sql", broken)
    with pytest.raises((sqlite3.Error, database.DatabaseConfigurationError)):
        database.open_control_database(path)
    after = sqlite3.connect(path, isolation_level=None)
    try:
        assert after.execute("PRAGMA user_version").fetchone()[0] == 3
        assert snapshot(after) == before
    finally:
        after.close()


def test_two_processes_upgrade_schema3_once(tmp_path):
    path = tmp_path / "race.sqlite"
    exact_v3(path).close()
    context = multiprocessing.get_context("spawn")
    barrier, queue = context.Barrier(2), context.Queue()
    processes = [
        context.Process(target=open_process, args=(str(path), barrier, queue)) for _ in range(2)
    ]
    try:
        for process in processes:
            process.start()
        results = [queue.get(timeout=30) for _ in processes]
        for process in processes:
            process.join(timeout=30)
            assert process.exitcode == 0
        assert results == [("ok", 9), ("ok", 9)]
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join(timeout=5)
        queue.close()


def test_schema3_binary_refuses_current_schema_without_mutation(tmp_path, monkeypatch):
    path = tmp_path / "old-binary.sqlite"
    connection = database.open_control_database(path)
    before = snapshot(connection)
    connection.close()
    monkeypatch.setattr(database, "_SCHEMA_VERSION", 3)
    with pytest.raises(database.DatabaseConfigurationError, match="newer"):
        database.open_control_database(path)
    verify = sqlite3.connect(path, isolation_level=None)
    try:
        assert verify.execute("PRAGMA user_version").fetchone()[0] == 9
        assert snapshot(verify) == before
    finally:
        verify.close()


@pytest.mark.parametrize("operation", ["insert_run", "update_run", "delete_run", "insert_draft"])
def test_already_open_schema3_writer_cannot_write_after_upgrade(tmp_path, operation):
    path = tmp_path / "already-open-old-writer.sqlite"
    old = exact_v3(path)
    old.execute("PRAGMA journal_mode=WAL")
    old.execute("PRAGMA synchronous=FULL")
    old.execute("PRAGMA busy_timeout=5000")
    old.execute("INSERT INTO runs(run_id,state,created_at_ns) VALUES('bt_old','DRAFT',10)")
    sql, params = {
        "insert_run": (
            "INSERT INTO runs(run_id,state,created_at_ns) VALUES('bt_late','DRAFT',10)",
            (),
        ),
        "update_run": ("UPDATE runs SET state_version=state_version+1 WHERE run_id='bt_old'", ()),
        "delete_run": ("DELETE FROM runs WHERE run_id='bt_old'", ()),
        "insert_draft": (
            "INSERT INTO strategy_drafts(draft_id,content_bytes,content_sha256,revision,"
            "created_at_ns,updated_at_ns) VALUES(?,?,?,1,?,?)",
            (DRAFT, b"old-writer-bytes", "a" * 64, NOW, NOW),
        ),
    }[operation]
    # Cache the old statement and finish the old binary's pre-write schema check.
    old.execute("BEGIN IMMEDIATE")
    old.execute(sql, params)
    old.rollback()
    assert old.execute("PRAGMA user_version").fetchone()[0] == 3
    current = database.open_control_database(path)
    try:
        before = snapshot(current)
        old.execute("BEGIN IMMEDIATE")
        with pytest.raises(sqlite3.DatabaseError, match="stark_control_writer_schema9"):
            old.execute(sql, params)
        old.rollback()
        assert snapshot(current) == before
        # The upgraded binary can still perform the same valid write.
        with database._immediate_transaction(current):
            current.execute(sql, params)
    finally:
        old.rollback()
        old.close()
        current.close()


def test_writer_rechecks_version_after_acquiring_transaction(tmp_path, monkeypatch):
    path = tmp_path / "changed-between-check-and-lock.sqlite"
    connection = database.open_control_database(path)
    original = database._verify_write_connection
    checks = 0

    def change_schema_after_first_check(candidate):
        nonlocal checks
        original(candidate)
        checks += 1
        if checks == 1:
            other = sqlite3.connect(path, isolation_level=None)
            try:
                other.execute("PRAGMA user_version=10")
            finally:
                other.close()

    monkeypatch.setattr(database, "_verify_write_connection", change_schema_after_first_check)
    try:
        with pytest.raises(database.DatabaseConfigurationError, match="version: 10"):
            with database._immediate_transaction(connection):
                connection.execute(
                    "INSERT INTO runs(run_id,state,created_at_ns) VALUES('bt_late','DRAFT',10)"
                )
        assert not connection.in_transaction
        assert connection.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 0
    finally:
        connection.close()


def test_unregistered_old_connection_cannot_prepare_mutations_of_any_shared_table(tmp_path):
    path = tmp_path / "all-table-writer-fence.sqlite"
    current = database.open_control_database(path)
    old = sqlite3.connect(path, isolation_level=None)
    try:
        tables = current.execute(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        for (table,) in tables:
            column = current.execute(f"PRAGMA table_info({table})").fetchone()[1]
            for statement in (
                f"INSERT INTO {table} DEFAULT VALUES",
                f"UPDATE {table} SET {column}={column}",
                f"DELETE FROM {table}",
            ):
                with pytest.raises(
                    sqlite3.DatabaseError, match="stark_control_writer_schema9"
                ):
                    old.execute(statement)
    finally:
        old.close()
        current.close()


def insert_v2_rows(store):
    raw = configuration_bytes(SmaConfigurationInputV2.model_validate(config_payload()))
    digest = sha256(raw).hexdigest()
    connection = store._connection
    connection.execute(
        "INSERT INTO strategy_drafts(draft_id,content_bytes,content_sha256,revision,"
        "created_at_ns,updated_at_ns,content_schema) "
        "VALUES(?,?,?,1,?,?,'StrategyConfigurationInput.v2')",
        (DRAFT, raw, digest, NOW, NOW),
    )
    connection.execute(
        "INSERT INTO strategy_configuration_versions(configuration_id,draft_id,version,"
        "source_revision,content_bytes,content_sha256,created_at_ns,content_schema) "
        "VALUES(?,?,1,1,?,?,?,'StrategyConfigurationInput.v2')",
        (VERSION, DRAFT, raw, digest, NOW),
    )
    return digest


def test_legacy_reads_writes_and_preflight_cannot_consume_v2(tmp_path):
    store = ControlStore.open(tmp_path / "mixed.sqlite", clock=lambda: NOW)
    try:
        digest = insert_v2_rows(store)
        old = store.create_strategy_draft(
            draft_id="sd_" + "b" * 32, configuration=_configuration(name="Old")
        )
        assert store.strategy_drafts() == (old,)
        assert store.strategy_draft(DRAFT) is None
        assert store.strategy_configuration(VERSION) is None
        assert store.strategy_configuration_versions(DRAFT) == ()
        with pytest.raises(StrategyDraftUnknown):
            store.update_strategy_draft(
                draft_id=DRAFT, expected_revision=1, configuration=_configuration(name="overwrite")
            )
        with pytest.raises(StrategyDraftUnknown):
            store.publish_strategy_draft(
                draft_id=DRAFT, expected_revision=1, configuration_id="cfg_" + "c" * 32
            )
        with pytest.raises(StrategyConfigurationIntegrityError):
            _validate_configuration_for_preflight(
                store._connection,
                binding=StrategyConfigurationBinding(
                    configuration_id=VERSION, content_sha256=digest
                ),
                request_bytes=b"{}",
                input_manifest_bytes=None,
            )
        store._connection.execute(
            "UPDATE strategy_drafts SET content_bytes=? WHERE draft_id=?", (b"{}", old.draft_id)
        )
        with pytest.raises(StrategyConfigurationIntegrityError):
            store.strategy_drafts()
    finally:
        store.close()


@pytest.mark.parametrize(
    "mutation", ["draft_kind", "version_update", "version_delete", "version_kind", "parent_kind"]
)
def test_sql_kind_and_published_v2_immutability(tmp_path, mutation):
    store = ControlStore.open(tmp_path / "constraints.sqlite", clock=lambda: NOW)
    try:
        insert_v2_rows(store)
        sql, params = {
            "draft_kind": (
                "UPDATE strategy_drafts SET content_schema='StrategyConfigurationInput.v1' "
                "WHERE draft_id=?",
                (DRAFT,),
            ),
            "version_update": (
                "UPDATE strategy_configuration_versions SET content_bytes=content_bytes "
                "WHERE configuration_id=?",
                (VERSION,),
            ),
            "version_delete": (
                "DELETE FROM strategy_configuration_versions WHERE configuration_id=?",
                (VERSION,),
            ),
            "version_kind": (
                "UPDATE strategy_configuration_versions "
                "SET content_schema='StrategyConfigurationInput.v1' "
                "WHERE configuration_id=?",
                (VERSION,),
            ),
            "parent_kind": (
                "INSERT INTO strategy_configuration_versions(configuration_id,draft_id,version,"
                "source_revision,content_bytes,content_sha256,created_at_ns) VALUES(?,?,2,2,?,?,?)",
                ("cfg_" + "c" * 32, DRAFT, b"{}", "a" * 64, NOW),
            ),
        }[mutation]
        with pytest.raises(sqlite3.IntegrityError):
            store._connection.execute(sql, params)
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM strategy_configuration_versions"
            ).fetchone()[0]
            == 1
        )
    finally:
        store.close()
