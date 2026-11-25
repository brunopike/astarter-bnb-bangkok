from __future__ import annotations

import multiprocessing
import os
import sqlite3
from multiprocessing.queues import Queue
from multiprocessing.synchronize import Barrier
from pathlib import Path

import pytest

import stark_trading_os.control.database as database_module
from stark_trading_os.control.database import (
    DatabaseConfigurationError,
    _immediate_transaction,
    _migration_sql,
    open_control_database,
)
from stark_trading_os.control.registry import ControlStore

EXPECTED_TABLES = {
    "runs",
    "preflights",
    "idempotency_records",
    "events",
    "audit_intents",
    "outbox",
    "runner_processes",
    "runner_outcomes",
    "catalog_publications",
    "catalog_audit_intents",
    "finalization_faults",
    "seals",
    "terminal_preparations",
    "strategy_drafts",
    "strategy_configuration_versions",
    "strategy_configuration_audit_entries",
    "preflight_configuration_bindings",
    "historical_preflights",
    "historical_terminal_anchors",
    "astarter_accounts",
    "astarter_bindings",
    "astarter_limits",
    "astarter_intents",
    "astarter_orders",
    "astarter_fills",
    "astarter_settlements",
    "astarter_audit",
    "astarter_strategy_scopes",
    "astarter_strategy_versions",
    "astarter_plan_versions",
    "astarter_approval_references",
    "astarter_episode_references",
    "astarter_layer_references",
    "astarter_recovery_checkpoints",
    "astarter_admission_heads",
    "astarter_admissions",
    "astarter_intent_admissions",
    "s03_runs",
    "s03_events",
    "s03_signals",
    "s03_lifecycle",
    "s03_plan_manifest",
    "s03_audit",
}


def _table_names(connection: sqlite3.Connection) -> set[str]:
    return {
        str(row["name"])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )
    }


def _open_exact_v1_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(_migration_sql(1))
    return connection


def _open_exact_v2_database(path: Path) -> sqlite3.Connection:
    connection = _open_exact_v1_database(path)
    connection.executescript(_migration_sql(2))
    return connection


def _upgrade_exact_v1_process(
    database_path: str,
    barrier: Barrier,
    output: Queue,
) -> None:
    connection = sqlite3.connect(database_path, isolation_level=None, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA synchronous = FULL")
    try:
        preflight_version = database_module._preflight_v1(connection)
        barrier.wait(timeout=10)
        upgraded = database_module._upgrade_v1_to_v2(connection)
        verified_loser = False
        if not upgraded:
            database_module._verify_exact_schema(connection, version=2)
            verified_loser = True
        output.put(
            (
                "ok",
                os.getpid(),
                preflight_version,
                upgraded,
                verified_loser,
                int(connection.execute("PRAGMA user_version").fetchone()[0]),
                int(
                    connection.execute(
                        "SELECT COUNT(*) FROM sqlite_schema "
                        "WHERE name = 'terminal_preparations'"
                    ).fetchone()[0]
                ),
            )
        )
    except BaseException as error:
        output.put(("error", os.getpid(), type(error).__name__, str(error)))
    finally:
        connection.close()


def _upgrade_exact_v2_process(
    database_path: str,
    barrier: Barrier,
    output: Queue,
) -> None:
    connection = sqlite3.connect(database_path, isolation_level=None, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA synchronous = FULL")
    try:
        preflight_version = database_module._preflight_v2(connection)
        barrier.wait(timeout=10)
        upgraded = database_module._upgrade_v2_to_v3(connection)
        verified_loser = False
        if not upgraded:
            database_module._verify_exact_schema(connection, version=3)
            verified_loser = True
        output.put(
            (
                "ok",
                os.getpid(),
                preflight_version,
                upgraded,
                verified_loser,
                int(connection.execute("PRAGMA user_version").fetchone()[0]),
                int(
                    connection.execute(
                        "SELECT COUNT(*) FROM sqlite_schema "
                        "WHERE name = 'strategy_configuration_versions'"
                    ).fetchone()[0]
                ),
            )
        )
    except BaseException as error:
        output.put(("error", os.getpid(), type(error).__name__, str(error)))
    finally:
        connection.close()


def _insert_raw_event(
    connection: sqlite3.Connection,
    *,
    event_id: str,
    run_id: str,
    seq: int,
    source_seq: int,
    source: str,
    event_type: str,
    visible: int = 1,
) -> None:
    connection.execute(
        """
        INSERT INTO events (
            event_id,
            run_id,
            seq,
            source_seq,
            source,
            type,
            writer,
            schema_version,
            ts_event_ns,
            ts_ingest_ns,
            visible,
            envelope_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, 'control-api', 1, '0', '0', ?, ?)
        """,
        (event_id, run_id, seq, source_seq, source, event_type, visible, b"{}"),
    )


def _insert_raw_audit(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    audit_seq: int,
    event_seq: int,
) -> None:
    connection.execute(
        """
        INSERT INTO audit_intents (
            run_id, audit_seq, event_seq, event_digest, intent_bytes, created_at_ns
        ) VALUES (?, ?, ?, ?, ?, 0)
        """,
        (run_id, audit_seq, event_seq, "a" * 64, b"{}"),
    )


def _insert_v2_preparation(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    terminal_state: str = "COMPLETED",
    event_type: str = "run.completed",
) -> None:
    connection.execute(
        "INSERT INTO runs (run_id, state, state_version, created_at_ns) "
        "VALUES (?, 'FINALIZING', 4, 0)",
        (run_id,),
    )
    connection.execute(
        "INSERT INTO runner_outcomes (run_id, outcome_bytes, outcome_hash, recorded_at_ns) "
        "VALUES (?, ?, ?, 0)",
        (run_id, b"{}", "a" * 64),
    )
    connection.execute("BEGIN IMMEDIATE")
    connection.execute(
        """
        INSERT INTO terminal_preparations (
            run_id, runner_outcome_hash, terminal_state, terminal_state_version,
            event_id, event_seq, event_source_seq, event_source, event_type,
            event_writer, event_schema_version, event_ts_event_ns,
            event_ts_ingest_ns, event_visible, event_envelope_bytes, event_digest,
            initial_event_digest, audit_seq, audit_event_digest, audit_intent_bytes,
            audit_intent_digest, audit_created_at_ns, prepared_at_ns, disposition,
            failure_attempt_count, last_failure_at_ns, last_failure_stage,
            conversion_fault_hash, converted_at_ns
        ) VALUES (
            ?, ?, ?, 5, ?, 1, 1, 'control-api', ?, 'control-api', 1,
            '10', '10', 0, ?, ?, ?, 1, ?, ?, ?, 10, 10, 'NORMAL', 0,
            NULL, NULL, NULL, NULL
        )
        """,
        (
            run_id,
            "a" * 64,
            terminal_state,
            f"evt_{run_id}_000001",
            event_type,
            b'{"candidate":true}',
            "b" * 64,
            "b" * 64,
            "b" * 64,
            b'{"audit":true}',
            "c" * 64,
        ),
    )
    connection.execute(
        """
        UPDATE runs
        SET prepared_terminal_state = ?, prepared_terminal_state_version = 5,
            prepared_terminal_event_seq = 1, evidence_status = 'STAGING'
        WHERE run_id = ?
        """,
        (terminal_state, run_id),
    )
    connection.commit()


def test_open_database_applies_and_verifies_required_connection_configuration(
    tmp_path: Path,
) -> None:
    connection = open_control_database(tmp_path / "control.sqlite")
    try:
        assert connection.isolation_level is None
        assert connection.row_factory is sqlite3.Row
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert connection.execute("PRAGMA busy_timeout").fetchone()[0] >= 5_000
        assert connection.execute("PRAGMA synchronous").fetchone()[0] == 2
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 9
        assert EXPECTED_TABLES <= _table_names(connection)
    finally:
        connection.close()


def test_migration_is_idempotent_and_preserves_existing_rows(tmp_path: Path) -> None:
    database_path = tmp_path / "control.sqlite"
    first = open_control_database(database_path)
    first.execute(
        "INSERT INTO runs (run_id, state, created_at_ns) VALUES (?, ?, ?)",
        ("bt_preserved", "DRAFT", 10),
    )
    first.close()

    second = open_control_database(database_path)
    try:
        row = second.execute(
            "SELECT run_id, state, created_at_ns FROM runs WHERE run_id = ?",
            ("bt_preserved",),
        ).fetchone()
        assert dict(row) == {
            "run_id": "bt_preserved",
            "state": "DRAFT",
            "created_at_ns": 10,
        }
        assert second.execute("PRAGMA user_version").fetchone()[0] == 9
    finally:
        second.close()


def test_exact_v1_upgrades_to_v4_and_preserves_ordinary_rows(tmp_path: Path) -> None:
    database_path = tmp_path / "exact-v1.sqlite"
    legacy = _open_exact_v1_database(database_path)
    legacy.execute(
        "INSERT INTO runs (run_id, state, created_at_ns) VALUES (?, 'DRAFT', 10)",
        ("bt_v1_preserved",),
    )
    legacy.close()

    upgraded = open_control_database(database_path)
    try:
        assert upgraded.execute("PRAGMA user_version").fetchone()[0] == 9
        assert _table_names(upgraded) == EXPECTED_TABLES
        assert tuple(
            upgraded.execute(
                "SELECT run_id, state, created_at_ns FROM runs WHERE run_id = ?",
                ("bt_v1_preserved",),
            ).fetchone()
        ) == ("bt_v1_preserved", "DRAFT", 10)
    finally:
        upgraded.close()


def test_exact_v2_upgrades_to_v4_and_preserves_terminal_preparation(tmp_path: Path) -> None:
    database_path = tmp_path / "exact-v2.sqlite"
    legacy = _open_exact_v2_database(database_path)
    _insert_v2_preparation(legacy, run_id="bt_v2_preserved")
    legacy.close()

    upgraded = open_control_database(database_path)
    try:
        assert upgraded.execute("PRAGMA user_version").fetchone()[0] == 9
        assert _table_names(upgraded) == EXPECTED_TABLES
        assert tuple(
            upgraded.execute(
                """
                SELECT run_id, terminal_state, disposition
                FROM terminal_preparations
                WHERE run_id = ?
                """,
                ("bt_v2_preserved",),
            ).fetchone()
        ) == ("bt_v2_preserved", "COMPLETED", "NORMAL")
    finally:
        upgraded.close()


def test_failed_003_statement_rolls_back_exact_v2_schema_version_and_data(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_path = tmp_path / "failed-v3.sqlite"
    legacy = _open_exact_v2_database(database_path)
    _insert_v2_preparation(legacy, run_id="bt_v2_rollback")
    v2_fingerprint = database_module._schema_fingerprint(legacy)
    legacy.close()
    statements = database_module._migration_statements(3)
    broken = list(statements)
    broken[2] = "CREATE TABLE deliberately_broken ("
    monkeypatch.setattr(
        database_module,
        "_migration_statements",
        lambda version: tuple(broken) if version == 3 else statements,
    )

    with pytest.raises(sqlite3.OperationalError):
        open_control_database(database_path)

    verify = sqlite3.connect(database_path, isolation_level=None)
    verify.row_factory = sqlite3.Row
    try:
        assert verify.execute("PRAGMA user_version").fetchone()[0] == 2
        assert database_module._schema_fingerprint(verify) == v2_fingerprint
        assert verify.execute(
            "SELECT terminal_state FROM terminal_preparations WHERE run_id = ?",
            ("bt_v2_rollback",),
        ).fetchone()[0] == "COMPLETED"
        assert "strategy_drafts" not in _table_names(verify)
    finally:
        verify.close()


def test_failed_002_statement_rolls_back_exact_v1_schema_version_and_data(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_path = tmp_path / "failed-v2.sqlite"
    legacy = _open_exact_v1_database(database_path)
    legacy.execute(
        "INSERT INTO runs (run_id, state, created_at_ns) VALUES (?, 'DRAFT', 10)",
        ("bt_rollback",),
    )
    v1_fingerprint = database_module._schema_fingerprint(legacy)
    legacy.close()
    statements = database_module._migration_statements(2)
    broken = list(statements)
    broken[2] = "CREATE TABLE deliberately_broken ("
    monkeypatch.setattr(
        database_module,
        "_migration_statements",
        lambda version: tuple(broken) if version == 2 else statements,
    )

    with pytest.raises(sqlite3.OperationalError):
        open_control_database(database_path)

    verify = sqlite3.connect(database_path, isolation_level=None)
    verify.row_factory = sqlite3.Row
    try:
        assert verify.execute("PRAGMA user_version").fetchone()[0] == 1
        assert database_module._schema_fingerprint(verify) == v1_fingerprint
        assert verify.execute(
            "SELECT state FROM runs WHERE run_id = ?", ("bt_rollback",)
        ).fetchone()[0] == "DRAFT"
    finally:
        verify.close()


def test_under_lock_legacy_residue_rolls_back_without_partial_v2(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_path = tmp_path / "under-lock-residue.sqlite"
    legacy = _open_exact_v1_database(database_path)
    legacy.execute(
        "INSERT INTO runs (run_id, state, state_version, created_at_ns) "
        "VALUES (?, 'FINALIZING', 4, 0)",
        ("bt_legacy_residue",),
    )
    legacy.close()
    real_guard = database_module._reject_legacy_terminal_residue
    calls = 0

    def insert_after_prelock(connection: sqlite3.Connection) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            connection.execute(
                """
                UPDATE runs
                SET prepared_terminal_state = 'COMPLETED',
                    prepared_terminal_state_version = 5,
                    prepared_terminal_event_seq = 1
                WHERE run_id = ?
                """,
                ("bt_legacy_residue",),
            )
            return
        real_guard(connection)

    monkeypatch.setattr(
        database_module,
        "_reject_legacy_terminal_residue",
        insert_after_prelock,
    )
    with pytest.raises(DatabaseConfigurationError, match="legacy terminal residue"):
        open_control_database(database_path)
    assert calls == 2

    verify = sqlite3.connect(database_path, isolation_level=None)
    try:
        assert verify.execute("PRAGMA user_version").fetchone()[0] == 1
        assert "terminal_preparations" not in {
            str(row[0])
            for row in verify.execute("SELECT name FROM sqlite_schema WHERE type = 'table'")
        }
    finally:
        verify.close()


def test_two_processes_upgrade_one_exact_v1_database_to_the_same_v2(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "upgrade-race.sqlite"
    legacy = _open_exact_v1_database(database_path)
    assert legacy.execute("PRAGMA journal_mode = WAL").fetchone()[0] == "wal"
    legacy.close()
    context = multiprocessing.get_context("spawn")
    barrier = context.Barrier(2)
    output = context.Queue()
    processes = [
        context.Process(
            target=_upgrade_exact_v1_process,
            args=(str(database_path), barrier, output),
        )
        for _ in range(2)
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=15)
        assert not process.is_alive()
        assert process.exitcode == 0
    results = [output.get(timeout=5) for _ in range(2)]
    output.close()
    output.join_thread()

    assert all(result[0] == "ok" for result in results), results
    assert len({result[1] for result in results}) == 2
    assert {result[2] for result in results} == {1}
    assert sorted(result[3] for result in results) == [False, True]
    loser = next(result for result in results if result[3] is False)
    assert loser[4] is True
    assert {(result[5], result[6]) for result in results} == {(2, 1)}

    verify = open_control_database(database_path)
    try:
        assert verify.execute("PRAGMA foreign_key_check").fetchall() == []
        assert verify.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert _table_names(verify) == EXPECTED_TABLES
    finally:
        verify.close()


def test_two_processes_upgrade_one_exact_v2_database_to_the_same_v3(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "upgrade-v3-race.sqlite"
    legacy = _open_exact_v2_database(database_path)
    _insert_v2_preparation(legacy, run_id="bt_v2_race_preserved")
    assert legacy.execute("PRAGMA journal_mode = WAL").fetchone()[0] == "wal"
    legacy.close()
    context = multiprocessing.get_context("spawn")
    barrier = context.Barrier(2)
    output = context.Queue()
    processes = [
        context.Process(
            target=_upgrade_exact_v2_process,
            args=(str(database_path), barrier, output),
        )
        for _ in range(2)
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=15)
        assert not process.is_alive()
        assert process.exitcode == 0
    results = [output.get(timeout=5) for _ in range(2)]
    output.close()
    output.join_thread()

    assert all(result[0] == "ok" for result in results), results
    assert len({result[1] for result in results}) == 2
    assert {result[2] for result in results} == {2}
    assert sorted(result[3] for result in results) == [False, True]
    loser = next(result for result in results if result[3] is False)
    assert loser[4] is True
    assert {(result[5], result[6]) for result in results} == {(3, 1)}

    verify = open_control_database(database_path)
    try:
        assert verify.execute("PRAGMA foreign_key_check").fetchall() == []
        assert verify.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert _table_names(verify) == EXPECTED_TABLES
        assert verify.execute(
            "SELECT terminal_state FROM terminal_preparations WHERE run_id = ?",
            ("bt_v2_race_preserved",),
        ).fetchone()[0] == "COMPLETED"
    finally:
        verify.close()


@pytest.mark.parametrize("damage", ["missing", "extra"])
def test_exact_v4_rejects_missing_or_extra_schema_objects(
    tmp_path: Path,
    damage: str,
) -> None:
    database_path = tmp_path / f"forged-v3-{damage}.sqlite"
    connection = open_control_database(database_path)
    if damage == "missing":
        connection.execute("DROP TRIGGER trg_terminal_preparations_reject_delete")
    else:
        connection.execute("CREATE TABLE rogue_v2_extension (value TEXT) STRICT")
    connection.close()

    with pytest.raises(DatabaseConfigurationError, match="schema fingerprint"):
        open_control_database(database_path)


def test_v1_legacy_terminal_residue_is_rejected_before_upgrade(tmp_path: Path) -> None:
    database_path = tmp_path / "legacy-terminal.sqlite"
    legacy = _open_exact_v1_database(database_path)
    legacy.execute(
        """
        INSERT INTO runs (
            run_id, state, state_version, created_at_ns,
            prepared_terminal_state, prepared_terminal_state_version,
            prepared_terminal_event_seq
        ) VALUES (?, 'FINALIZING', 4, 0, 'FAILED', 5, 1)
        """,
        ("bt_legacy_terminal",),
    )
    legacy.close()

    with pytest.raises(DatabaseConfigurationError, match="legacy terminal residue"):
        open_control_database(database_path)
    verify = sqlite3.connect(database_path, isolation_level=None)
    try:
        assert verify.execute("PRAGMA user_version").fetchone()[0] == 1
        assert verify.execute(
            "SELECT prepared_terminal_state FROM runs WHERE run_id = ?",
            ("bt_legacy_terminal",),
        ).fetchone()[0] == "FAILED"
    finally:
        verify.close()


def test_control_store_rejects_an_unconfigured_connection(tmp_path: Path) -> None:
    connection = sqlite3.connect(tmp_path / "unconfigured.sqlite", isolation_level=None)
    try:
        with pytest.raises(DatabaseConfigurationError):
            ControlStore(connection)
    finally:
        connection.close()


def test_open_database_refuses_to_downgrade_a_future_schema_version(tmp_path: Path) -> None:
    database_path = tmp_path / "future.sqlite"
    future = sqlite3.connect(database_path, isolation_level=None)
    future.execute("PRAGMA user_version = 10")
    future.close()

    with pytest.raises(DatabaseConfigurationError, match="newer"):
        open_control_database(database_path)

    verify = sqlite3.connect(database_path, isolation_level=None)
    try:
        assert verify.execute("PRAGMA user_version").fetchone()[0] == 10
    finally:
        verify.close()


def test_v2_binary_gate_rejects_schema_v3_without_modifying_the_database(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_path = tmp_path / "v3-rejected-by-v2.sqlite"
    current = _open_exact_v2_database(database_path)
    current.executescript(_migration_sql(3))
    current.execute(
        "INSERT INTO runs (run_id, state, created_at_ns) VALUES (?, 'DRAFT', 10)",
        ("bt_preserved_after_rejected_downgrade",),
    )
    current.close()
    monkeypatch.setattr(database_module, "_SCHEMA_VERSION", 2)

    with pytest.raises(DatabaseConfigurationError, match="newer than supported version 2"):
        open_control_database(database_path)

    verify = sqlite3.connect(database_path, isolation_level=None)
    try:
        assert verify.execute("PRAGMA user_version").fetchone()[0] == 3
        assert verify.execute(
            "SELECT state FROM runs WHERE run_id = ?",
            ("bt_preserved_after_rejected_downgrade",),
        ).fetchone()[0] == "DRAFT"
        assert "strategy_configuration_versions" in {
            str(row[0])
            for row in verify.execute("SELECT name FROM sqlite_schema WHERE type = 'table'")
        }
    finally:
        verify.close()


def test_open_database_rejects_a_nonempty_unknown_version_zero_database(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "unknown-v0.sqlite"
    unknown = sqlite3.connect(database_path, isolation_level=None)
    unknown.execute("CREATE TABLE foreign_application (value TEXT)")
    unknown.close()

    with pytest.raises(DatabaseConfigurationError, match="non-empty.*version 0"):
        open_control_database(database_path)

    verify = sqlite3.connect(database_path, isolation_level=None)
    try:
        assert verify.execute("PRAGMA user_version").fetchone()[0] == 0
        assert {
            str(row[0])
            for row in verify.execute(
                "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )
        } == {"foreign_application"}
    finally:
        verify.close()


@pytest.mark.parametrize("version", [0, 1])
def test_schema_fingerprint_does_not_treat_like_wildcards_as_internal_objects(
    tmp_path: Path,
    version: int,
) -> None:
    database_path = tmp_path / f"deceptive-internal-name-v{version}.sqlite"
    if version == 1:
        connection = _open_exact_v1_database(database_path)
    else:
        connection = sqlite3.connect(database_path, isolation_level=None)
    connection.execute("CREATE TABLE sqliteXrogue (value TEXT)")
    connection.close()

    with pytest.raises(DatabaseConfigurationError):
        open_control_database(database_path)


def test_schema_fingerprint_does_not_exclude_forged_sqlite_prefix_objects(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "forged-sqlite-prefix.sqlite"
    connection = _open_exact_v1_database(database_path)
    connection.execute(
        """
        CREATE TRIGGER rogue_run_guard
        BEFORE INSERT ON runs
        BEGIN SELECT RAISE(ABORT, 'rogue trigger'); END
        """
    )
    schema_version = int(connection.execute("PRAGMA schema_version").fetchone()[0])
    connection.execute("PRAGMA writable_schema = ON")
    connection.execute(
        """
        UPDATE sqlite_schema
        SET name = 'sqlite_rogue_run_guard',
            sql = replace(sql, 'rogue_run_guard', 'sqlite_rogue_run_guard')
        WHERE type = 'trigger' AND name = 'rogue_run_guard'
        """
    )
    connection.execute(f"PRAGMA schema_version = {schema_version + 1}")
    connection.execute("PRAGMA writable_schema = OFF")
    connection.close()

    with pytest.raises(DatabaseConfigurationError, match="schema fingerprint"):
        open_control_database(database_path)


def test_open_database_rejects_a_forged_version_one_schema(tmp_path: Path) -> None:
    database_path = tmp_path / "forged-v1.sqlite"
    forged = sqlite3.connect(database_path, isolation_level=None)
    forged.execute("CREATE TABLE runs (run_id TEXT PRIMARY KEY)")
    forged.execute("PRAGMA user_version = 1")
    forged.close()

    with pytest.raises(DatabaseConfigurationError, match="schema fingerprint"):
        open_control_database(database_path)


@pytest.mark.parametrize("damage", ["missing", "extra"])
def test_open_database_rejects_a_damaged_or_extended_version_one_schema(
    tmp_path: Path,
    damage: str,
) -> None:
    database_path = tmp_path / f"{damage}-v1.sqlite"
    connection = _open_exact_v1_database(database_path)
    if damage == "missing":
        connection.execute("DROP TABLE seals")
    else:
        connection.execute("CREATE TABLE rogue_extension (value TEXT) STRICT")
    connection.close()

    with pytest.raises(DatabaseConfigurationError, match="schema fingerprint"):
        open_control_database(database_path)


def test_open_database_rejects_existing_foreign_key_orphans(tmp_path: Path) -> None:
    database_path = tmp_path / "orphan.sqlite"
    connection = open_control_database(database_path)
    connection.close()

    raw = open_control_database(database_path)
    raw.execute("PRAGMA foreign_keys = OFF")
    raw.execute(
        """
        INSERT INTO runner_outcomes (run_id, outcome_bytes, outcome_hash, recorded_at_ns)
        VALUES (?, ?, ?, ?)
        """,
        ("bt_missing", b"{}", "a" * 64, 0),
    )
    raw.close()

    with pytest.raises(DatabaseConfigurationError, match="foreign key"):
        open_control_database(database_path)


@pytest.mark.parametrize(
    "downgrade",
    [
        "PRAGMA foreign_keys = OFF",
        "PRAGMA journal_mode = DELETE",
        "PRAGMA synchronous = NORMAL",
        "PRAGMA user_version = 0",
        "PRAGMA writable_schema = ON",
        "PRAGMA ignore_check_constraints = ON",
    ],
)
def test_every_write_rejects_runtime_database_configuration_downgrade(
    tmp_path: Path,
    downgrade: str,
) -> None:
    connection = open_control_database(tmp_path / "runtime-downgrade.sqlite")
    store = ControlStore(connection)
    try:
        connection.execute(downgrade)
        with pytest.raises(DatabaseConfigurationError):
            store.reserve_run(run_id="bt_downgrade")
        assert connection.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 0
    finally:
        store.close()


def test_failed_commit_is_rolled_back_and_leaves_connection_reusable(tmp_path: Path) -> None:
    connection = open_control_database(tmp_path / "commit-failure.sqlite")
    try:
        connection.execute("CREATE TABLE parents (id INTEGER PRIMARY KEY) STRICT")
        connection.execute(
            """
            CREATE TABLE children (
                parent_id INTEGER,
                FOREIGN KEY (parent_id) REFERENCES parents(id)
                    DEFERRABLE INITIALLY DEFERRED
            ) STRICT
            """
        )
        with pytest.raises(sqlite3.IntegrityError):
            with _immediate_transaction(connection):
                connection.execute("INSERT INTO children (parent_id) VALUES (?)", (99,))

        assert not connection.in_transaction
        assert connection.execute("SELECT COUNT(*) FROM children").fetchone()[0] == 0
        with _immediate_transaction(connection):
            connection.execute("INSERT INTO parents (id) VALUES (?)", (99,))
    finally:
        connection.close()


@pytest.mark.parametrize("state", ["LIVE", "PAPER", "UNKNOWN", "completed"])
def test_runs_table_rejects_unknown_or_noncanonical_states(
    tmp_path: Path, state: str
) -> None:
    connection = open_control_database(tmp_path / "control.sqlite")
    try:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO runs (run_id, state, created_at_ns) VALUES (?, ?, ?)",
                (f"bt_{state}", state, 0),
            )
    finally:
        connection.close()


def test_runs_table_requires_manifest_and_catalog_identity_as_one_group(
    tmp_path: Path,
) -> None:
    connection = open_control_database(tmp_path / "control.sqlite")
    try:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO runs (
                    run_id, state, created_at_ns, input_manifest_bytes, input_manifest_hash
                ) VALUES (?, ?, ?, ?, ?)
                """,
                ("bt_partial_identity", "DRAFT", 0, b"{}", "0" * 64),
            )
    finally:
        connection.close()


def test_sql_defense_rejects_wrong_event_ownership_and_hidden_nonterminal(
    tmp_path: Path,
) -> None:
    connection = open_control_database(tmp_path / "control.sqlite")
    try:
        connection.execute(
            "INSERT INTO runs (run_id, state, created_at_ns) VALUES (?, ?, ?)",
            ("bt_sql", "RUNNING", 0),
        )
        common = (
            "evt_wrong",
            "bt_sql",
            1,
            1,
            "control-api",
            "order.filled",
            "control-api",
            1,
            "0",
            "0",
            b"{}",
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO events (
                    event_id, run_id, seq, source_seq, source, type, writer,
                    schema_version, ts_event_ns, ts_ingest_ns, envelope_bytes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                common,
            )

        hidden_nonterminal = (
            "evt_hidden",
            "bt_sql",
            1,
            1,
            "runner",
            "order.filled",
            "control-api",
            1,
            "0",
            "0",
            0,
            b"{}",
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO events (
                    event_id, run_id, seq, source_seq, source, type, writer,
                    schema_version, ts_event_ns, ts_ingest_ns, visible, envelope_bytes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                hidden_nonterminal,
            )
    finally:
        connection.close()


def test_event_uniqueness_and_terminal_index_are_enforced_by_sql(tmp_path: Path) -> None:
    connection = _open_exact_v1_database(tmp_path / "control.sqlite")
    try:
        connection.execute(
            """
            INSERT INTO runs (
                run_id, state, state_version, last_event_seq, last_audit_seq,
                control_source_seq, created_at_ns, prepared_terminal_state,
                prepared_terminal_state_version, prepared_terminal_event_seq
            ) VALUES (?, 'FINALIZING', 0, 1, 1, 1, 0, 'COMPLETED', 1, 1)
            """,
            ("bt_unique",),
        )
        _insert_raw_event(
            connection,
            event_id="evt_terminal_1",
            run_id="bt_unique",
            seq=1,
            source_seq=1,
            source="control-api",
            event_type="run.completed",
            visible=0,
        )
        with pytest.raises(sqlite3.IntegrityError):
            _insert_raw_event(
                connection,
                event_id="evt_terminal_2",
                run_id="bt_unique",
                seq=2,
                source_seq=2,
                source="control-api",
                event_type="run.failed",
            )

        connection.execute(
            "INSERT INTO runs (run_id, state, created_at_ns) VALUES (?, ?, ?)",
            ("bt_runner_unique", "RUNNING", 0),
        )
        _insert_raw_event(
            connection,
            event_id="evt_runner_1",
            run_id="bt_runner_unique",
            seq=1,
            source_seq=0,
            source="runner",
            event_type="order.submitted",
        )
        with pytest.raises(sqlite3.IntegrityError):
            _insert_raw_event(
                connection,
                event_id="evt_runner_2",
                run_id="bt_runner_unique",
                seq=2,
                source_seq=0,
                source="runner",
                event_type="order.accepted",
            )
        with pytest.raises(sqlite3.IntegrityError):
            _insert_raw_event(
                connection,
                event_id="evt_runner_1",
                run_id="bt_runner_unique",
                seq=2,
                source_seq=1,
                source="runner",
                event_type="order.accepted",
            )
    finally:
        connection.close()


def test_outbox_requires_the_audit_row_paired_to_the_same_event(tmp_path: Path) -> None:
    connection = open_control_database(tmp_path / "outbox-pair.sqlite")
    try:
        connection.execute(
            "INSERT INTO runs (run_id, state, created_at_ns) VALUES (?, 'RUNNING', 0)",
            ("bt_pair",),
        )
        _insert_raw_event(
            connection,
            event_id="evt_pair_1",
            run_id="bt_pair",
            seq=1,
            source_seq=0,
            source="runner",
            event_type="order.submitted",
        )
        _insert_raw_event(
            connection,
            event_id="evt_pair_2",
            run_id="bt_pair",
            seq=2,
            source_seq=1,
            source="runner",
            event_type="order.accepted",
        )
        _insert_raw_audit(connection, run_id="bt_pair", audit_seq=1, event_seq=1)
        _insert_raw_audit(connection, run_id="bt_pair", audit_seq=2, event_seq=2)

        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO outbox (run_id, seq, audit_seq) VALUES (?, ?, ?)",
                ("bt_pair", 1, 2),
            )
    finally:
        connection.close()


def test_idempotency_scope_key_and_hash_constraints_are_enforced_by_sql(
    tmp_path: Path,
) -> None:
    connection = open_control_database(tmp_path / "control.sqlite")
    try:
        values = (
            "backtest.preflight",
            "idem-1",
            "a" * 64,
            b'{"command":"backtest.preflight","request":{}}',
            200,
            b"{}",
            0,
        )
        connection.execute(
            """
            INSERT INTO idempotency_records (
                idempotency_scope,
                idempotency_key,
                request_hash,
                request_body,
                response_status,
                response_body,
                created_at_ns
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            values,
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO idempotency_records (
                    idempotency_scope,
                    idempotency_key,
                    request_hash,
                    request_body,
                    response_status,
                    response_body,
                    created_at_ns
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                values,
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO idempotency_records (
                    idempotency_scope,
                    idempotency_key,
                    request_hash,
                    request_body,
                    response_status,
                    response_body,
                    created_at_ns
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                ("client.scope", "idem-2", "a" * 64, b"{}", 200, b"{}", 0),
            )
    finally:
        connection.close()


def test_cancel_idempotency_target_is_bound_to_its_scope_and_response(
    tmp_path: Path,
) -> None:
    connection = open_control_database(tmp_path / "cancel-target.sqlite")
    try:
        connection.execute(
            "INSERT INTO runs (run_id, state, created_at_ns) VALUES (?, 'QUEUED', 0)",
            ("bt_target",),
        )
        connection.execute(
            "INSERT INTO runs (run_id, state, created_at_ns) VALUES (?, 'QUEUED', 0)",
            ("bt_other",),
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO idempotency_records (
                    idempotency_scope,
                    idempotency_key,
                    request_hash,
                    request_body,
                    response_status,
                    response_body,
                    target_run_id,
                    run_id,
                    created_at_ns
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "backtest.cancel/bt_other",
                    "cancel-target",
                    "a" * 64,
                    b'{"command":"backtest.cancel","request":{},"run_id":"bt_target"}',
                    202,
                    b'{"run_id":"bt_other"}',
                    "bt_target",
                    "bt_other",
                    0,
                ),
            )
    finally:
        connection.close()


def test_sql_freezes_events_after_terminal_preparation_or_terminal_insert(
    tmp_path: Path,
) -> None:
    connection = _open_exact_v1_database(tmp_path / "terminal-freeze.sqlite")
    try:
        connection.execute(
            """
            INSERT INTO runs (
                run_id, state, state_version, last_event_seq, last_audit_seq,
                control_source_seq, created_at_ns, prepared_terminal_state,
                prepared_terminal_state_version, prepared_terminal_event_seq
            ) VALUES (?, 'FINALIZING', 4, 1, 1, 1, 0, 'COMPLETED', 5, 2)
            """,
            ("bt_prepared_freeze",),
        )
        with pytest.raises(sqlite3.IntegrityError, match="terminal"):
            _insert_raw_event(
                connection,
                event_id="evt_late_report",
                run_id="bt_prepared_freeze",
                seq=2,
                source_seq=2,
                source="control-api",
                event_type="report.generated",
            )

        connection.execute(
            """
            INSERT INTO runs (
                run_id, state, state_version, last_event_seq, last_audit_seq,
                control_source_seq, created_at_ns, prepared_terminal_state,
                prepared_terminal_state_version, prepared_terminal_event_seq
            ) VALUES (?, 'FINALIZING', 4, 1, 1, 1, 0, 'FAILED', 5, 1)
            """,
            ("bt_terminal_freeze",),
        )
        _insert_raw_event(
            connection,
            event_id="evt_terminal_freeze",
            run_id="bt_terminal_freeze",
            seq=1,
            source_seq=1,
            source="control-api",
            event_type="run.failed",
            visible=0,
        )
        with pytest.raises(sqlite3.IntegrityError, match="terminal"):
            _insert_raw_event(
                connection,
                event_id="evt_after_terminal",
                run_id="bt_terminal_freeze",
                seq=2,
                source_seq=2,
                source="control-api",
                event_type="report.generated",
            )
    finally:
        connection.close()


@pytest.mark.parametrize(
    ("prepared_state", "terminal_type", "terminal_seq"),
    [
        ("COMPLETED", "run.failed", 1),
        ("COMPLETED", "run.completed", 2),
    ],
)
def test_hidden_terminal_insert_must_match_the_prepared_state_and_sequence(
    tmp_path: Path,
    prepared_state: str,
    terminal_type: str,
    terminal_seq: int,
) -> None:
    connection = _open_exact_v1_database(
        tmp_path / f"terminal-{terminal_type}-{terminal_seq}.sqlite"
    )
    try:
        connection.execute(
            """
            INSERT INTO runs (
                run_id, state, state_version, last_event_seq, last_audit_seq,
                control_source_seq, created_at_ns, prepared_terminal_state,
                prepared_terminal_state_version, prepared_terminal_event_seq
            ) VALUES (?, 'FINALIZING', 4, 1, 1, 1, 0, ?, 5, 1)
            """,
            ("bt_terminal_match", prepared_state),
        )
        with pytest.raises(sqlite3.IntegrityError, match="terminal"):
            _insert_raw_event(
                connection,
                event_id="evt_terminal_mismatch",
                run_id="bt_terminal_match",
                seq=terminal_seq,
                source_seq=1,
                source="control-api",
                event_type=terminal_type,
                visible=0,
            )
    finally:
        connection.close()


def test_existing_economic_event_cannot_be_rewritten_as_a_terminal_boundary(
    tmp_path: Path,
) -> None:
    connection = _open_exact_v1_database(tmp_path / "event-rewrite.sqlite")
    try:
        connection.execute(
            """
            INSERT INTO runs (
                run_id, state, state_version, last_event_seq, last_audit_seq,
                runner_source_seq, created_at_ns
            ) VALUES (?, 'RUNNING', 3, 1, 1, 0, 0)
            """,
            ("bt_event_rewrite",),
        )
        _insert_raw_event(
            connection,
            event_id="evt_economic_rewrite",
            run_id="bt_event_rewrite",
            seq=1,
            source_seq=0,
            source="runner",
            event_type="order.filled",
        )
        _insert_raw_audit(
            connection,
            run_id="bt_event_rewrite",
            audit_seq=1,
            event_seq=1,
        )
        connection.execute(
            """
            UPDATE runs
            SET state = 'FINALIZING',
                state_version = 4,
                control_source_seq = 1,
                prepared_terminal_state = 'COMPLETED',
                prepared_terminal_state_version = 5,
                prepared_terminal_event_seq = 1
            WHERE run_id = ?
            """,
            ("bt_event_rewrite",),
        )

        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                """
                UPDATE events
                SET source = 'control-api',
                    source_seq = 1,
                    type = 'run.completed',
                    visible = 0
                WHERE run_id = ? AND seq = 1
                """,
                ("bt_event_rewrite",),
            )
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                "DELETE FROM events WHERE run_id = ? AND seq = 1",
                ("bt_event_rewrite",),
            )
    finally:
        connection.close()


def test_seal_requires_a_matching_prepared_hidden_terminal_and_audit_boundary(
    tmp_path: Path,
) -> None:
    connection = _open_exact_v1_database(tmp_path / "seal-boundary.sqlite")
    try:
        connection.execute(
            """
            INSERT INTO runs (
                run_id, state, state_version, last_event_seq, last_audit_seq,
                control_source_seq, created_at_ns
            ) VALUES (?, 'FINALIZING', 4, 1, 1, 0, 0)
            """,
            ("bt_seal",),
        )
        _insert_raw_event(
            connection,
            event_id="evt_seal_economic",
            run_id="bt_seal",
            seq=1,
            source_seq=0,
            source="runner",
            event_type="order.filled",
        )
        _insert_raw_audit(connection, run_id="bt_seal", audit_seq=1, event_seq=1)
        connection.execute(
            """
            UPDATE runs
            SET prepared_terminal_state = 'COMPLETED',
                prepared_terminal_state_version = 5,
                prepared_terminal_event_seq = 2,
                last_event_seq = 2,
                last_audit_seq = 2,
                control_source_seq = 1
            WHERE run_id = ?
            """,
            ("bt_seal",),
        )
        _insert_raw_event(
            connection,
            event_id="evt_seal_terminal",
            run_id="bt_seal",
            seq=2,
            source_seq=1,
            source="control-api",
            event_type="run.completed",
            visible=0,
        )
        _insert_raw_audit(connection, run_id="bt_seal", audit_seq=2, event_seq=2)

        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO seals (
                    run_id, seal_digest, terminal_event_seq, last_audit_seq, published_at_ns
                ) VALUES (?, ?, ?, ?, ?)
                """,
                ("bt_seal", "b" * 64, 2, 1, 0),
            )

        connection.execute(
            """
            INSERT INTO seals (
                run_id, seal_digest, terminal_event_seq, last_audit_seq, published_at_ns
            ) VALUES (?, ?, ?, ?, ?)
            """,
            ("bt_seal", "b" * 64, 2, 2, 0),
        )
        with pytest.raises(sqlite3.IntegrityError, match="already exists"):
            connection.execute(
                """
                INSERT OR REPLACE INTO seals (
                    run_id, seal_digest, terminal_event_seq, last_audit_seq,
                    published_at_ns
                ) VALUES (?, ?, ?, ?, ?)
                """,
                ("bt_seal", "d" * 64, 2, 2, 1),
            )
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                """
                UPDATE seals
                SET terminal_event_seq = 1, last_audit_seq = 1
                WHERE run_id = ?
                """,
                ("bt_seal",),
            )
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute("DELETE FROM seals WHERE run_id = ?", ("bt_seal",))
        with pytest.raises(sqlite3.IntegrityError, match="sealed"):
            connection.execute(
                """
                INSERT INTO finalization_faults (
                    run_id, fault_bytes, fault_hash, recorded_at_ns
                ) VALUES (?, ?, ?, ?)
                """,
                ("bt_seal", b"{}", "f" * 64, 0),
            )
        with pytest.raises(sqlite3.IntegrityError, match="sealed"):
            connection.execute(
                "UPDATE runs SET evidence_status = 'UNVERIFIED' WHERE run_id = ?",
                ("bt_seal",),
            )

        connection.execute(
            "UPDATE events SET visible = 1 WHERE run_id = ? AND seq = 2",
            ("bt_seal",),
        )
        assert connection.execute(
            "SELECT visible FROM events WHERE run_id = ? AND seq = 2",
            ("bt_seal",),
        ).fetchone()[0] == 1
        connection.execute(
            """
            UPDATE runs
            SET state = 'COMPLETED', state_version = 5, evidence_status = 'VERIFIED'
            WHERE run_id = ?
            """,
            ("bt_seal",),
        )
    finally:
        connection.close()


def test_seal_rejects_an_ordinary_event_and_invalid_finalization_context(
    tmp_path: Path,
) -> None:
    connection = _open_exact_v1_database(tmp_path / "seal-context.sqlite")
    try:
        connection.execute(
            """
            INSERT INTO runs (
                run_id, state, state_version, last_event_seq, last_audit_seq,
                created_at_ns
            ) VALUES (?, 'FINALIZING', 4, 1, 1, 0)
            """,
            ("bt_bad_seal",),
        )
        _insert_raw_event(
            connection,
            event_id="evt_bad_seal",
            run_id="bt_bad_seal",
            seq=1,
            source_seq=0,
            source="runner",
            event_type="order.filled",
        )
        _insert_raw_audit(connection, run_id="bt_bad_seal", audit_seq=1, event_seq=1)
        connection.execute(
            """
            UPDATE runs
            SET prepared_terminal_state = 'FAILED',
                prepared_terminal_state_version = 5,
                prepared_terminal_event_seq = 1
            WHERE run_id = ?
            """,
            ("bt_bad_seal",),
        )
        with pytest.raises(sqlite3.IntegrityError, match="seal"):
            connection.execute(
                """
                INSERT INTO seals (
                    run_id, seal_digest, terminal_event_seq, last_audit_seq, published_at_ns
                ) VALUES (?, ?, ?, ?, ?)
                """,
                ("bt_bad_seal", "c" * 64, 1, 1, 0),
            )

        connection.execute(
            """
            INSERT INTO runs (
                run_id, state, state_version, last_event_seq, last_audit_seq,
                control_source_seq, created_at_ns, prepared_terminal_state,
                prepared_terminal_state_version, prepared_terminal_event_seq
            ) VALUES (?, 'FINALIZING', 4, 1, 1, 1, 0, 'CANCELLED', 5, 1)
            """,
            ("bt_bad_context",),
        )
        _insert_raw_event(
            connection,
            event_id="evt_bad_context",
            run_id="bt_bad_context",
            seq=1,
            source_seq=1,
            source="control-api",
            event_type="run.cancelled",
            visible=0,
        )
        _insert_raw_audit(connection, run_id="bt_bad_context", audit_seq=1, event_seq=1)
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                "UPDATE events SET visible = 1 WHERE run_id = ?",
                ("bt_bad_context",),
            )
    finally:
        connection.close()


@pytest.mark.parametrize(
    ("state", "evidence_status"),
    [
        ("DRAFT", "PENDING"),
        ("DRAFT", "UNVERIFIED"),
        ("PREFLIGHT_BLOCKED", "UNVERIFIED"),
        ("PREFLIGHT_READY", "UNVERIFIED"),
        ("QUEUED", "UNVERIFIED"),
        ("RUNNING", "UNVERIFIED"),
        ("CANCEL_REQUESTED", "UNVERIFIED"),
        ("CANCEL_PENDING", "UNVERIFIED"),
        ("COMPLETED", "UNVERIFIED"),
        ("FAILED", "UNVERIFIED"),
        ("CANCELLED", "UNVERIFIED"),
        ("FINALIZING", "PENDING"),
        ("FINALIZING", "STAGING"),
        ("FINALIZING", "PARTIAL"),
        ("FINALIZING", "VERIFIED"),
    ],
)
def test_finalization_fault_requires_finalizing_unverified_run(
    tmp_path: Path,
    state: str,
    evidence_status: str,
) -> None:
    connection = _open_exact_v1_database(
        tmp_path / f"fault-context-{state}-{evidence_status}.sqlite"
    )
    try:
        connection.execute(
            """
            INSERT INTO runs (run_id, state, created_at_ns, evidence_status)
            VALUES (?, ?, 0, ?)
            """,
            ("bt_invalid_fault", state, evidence_status),
        )

        with pytest.raises(
            sqlite3.IntegrityError,
            match="FINALIZING.*UNVERIFIED",
        ):
            connection.execute(
                """
                INSERT INTO finalization_faults (
                    run_id, fault_bytes, fault_hash, recorded_at_ns
                ) VALUES (?, ?, ?, ?)
                """,
                ("bt_invalid_fault", b"{}", "f" * 64, 0),
            )
        assert connection.execute(
            "SELECT COUNT(*) FROM finalization_faults"
        ).fetchone()[0] == 0
    finally:
        connection.close()


def test_unverified_fault_path_rejects_seal_but_can_publish_failed_event(
    tmp_path: Path,
) -> None:
    connection = _open_exact_v1_database(tmp_path / "unverified-fault.sqlite")
    try:
        connection.execute(
            """
            INSERT INTO runs (
                run_id, state, state_version, created_at_ns, evidence_status
            ) VALUES (?, 'FINALIZING', 4, 0, 'UNVERIFIED')
            """,
            ("bt_unverified_fault",),
        )
        connection.execute(
            """
            INSERT INTO finalization_faults (
                run_id, fault_bytes, fault_hash, recorded_at_ns
            ) VALUES (?, ?, ?, ?)
            """,
            ("bt_unverified_fault", b"{}", "f" * 64, 0),
        )
        connection.execute(
            """
            UPDATE runs
            SET last_event_seq = 1,
                last_audit_seq = 1,
                control_source_seq = 1,
                prepared_terminal_state = 'FAILED',
                prepared_terminal_state_version = 5,
                prepared_terminal_event_seq = 1
            WHERE run_id = ?
            """,
            ("bt_unverified_fault",),
        )
        _insert_raw_event(
            connection,
            event_id="evt_unverified_failure",
            run_id="bt_unverified_fault",
            seq=1,
            source_seq=1,
            source="control-api",
            event_type="run.failed",
            visible=0,
        )
        _insert_raw_audit(
            connection,
            run_id="bt_unverified_fault",
            audit_seq=1,
            event_seq=1,
        )
        with pytest.raises(sqlite3.IntegrityError, match="already exists"):
            connection.execute(
                """
                INSERT OR REPLACE INTO finalization_faults (
                    run_id, fault_bytes, fault_hash, recorded_at_ns
                ) VALUES (?, ?, ?, ?)
                """,
                ("bt_unverified_fault", b'{"changed":true}', "e" * 64, 1),
            )

        with pytest.raises(sqlite3.IntegrityError, match="seal"):
            connection.execute(
                """
                INSERT INTO seals (
                    run_id, seal_digest, terminal_event_seq, last_audit_seq, published_at_ns
                ) VALUES (?, ?, ?, ?, ?)
                """,
                ("bt_unverified_fault", "e" * 64, 1, 1, 0),
            )

        connection.execute(
            "UPDATE events SET visible = 1 WHERE run_id = ? AND seq = 1",
            ("bt_unverified_fault",),
        )
        assert connection.execute(
            "SELECT visible FROM events WHERE run_id = ? AND seq = 1",
            ("bt_unverified_fault",),
        ).fetchone()[0] == 1
        connection.execute(
            "UPDATE runs SET state = 'FAILED', state_version = 5 WHERE run_id = ?",
            ("bt_unverified_fault",),
        )
        row = connection.execute(
            "SELECT state, evidence_status FROM runs WHERE run_id = ?",
            ("bt_unverified_fault",),
        ).fetchone()
        assert tuple(row) == ("FAILED", "UNVERIFIED")

        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                """
                UPDATE finalization_faults
                SET fault_hash = ?
                WHERE run_id = ?
                """,
                ("e" * 64, "bt_unverified_fault"),
            )
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                "DELETE FROM finalization_faults WHERE run_id = ?",
                ("bt_unverified_fault",),
            )
        with pytest.raises(sqlite3.IntegrityError, match="UNVERIFIED"):
            connection.execute(
                "UPDATE runs SET evidence_status = 'VERIFIED' WHERE run_id = ?",
                ("bt_unverified_fault",),
            )
    finally:
        connection.close()


def test_catalog_audit_shell_is_catalog_scoped_not_run_scoped(tmp_path: Path) -> None:
    connection = open_control_database(tmp_path / "control.sqlite")
    try:
        columns = {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(catalog_audit_intents)")
        }
        assert columns == {
            "catalog_revision",
            "intent_bytes",
            "created_at_ns",
        }
        assert "run_id" not in columns
    finally:
        connection.close()


def test_downstream_shells_store_exact_blobs_and_external_seal_identity(
    tmp_path: Path,
) -> None:
    connection = open_control_database(tmp_path / "control.sqlite")
    try:
        runner_columns = {
            str(row["name"]): str(row["type"])
            for row in connection.execute("PRAGMA table_info(runner_outcomes)")
        }
        fault_columns = {
            str(row["name"]): str(row["type"])
            for row in connection.execute("PRAGMA table_info(finalization_faults)")
        }
        seal_columns = {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(seals)")
        }
        run_columns = {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(runs)")
        }
        idempotency_columns = {
            str(row["name"]): str(row["type"])
            for row in connection.execute("PRAGMA table_info(idempotency_records)")
        }

        assert runner_columns["outcome_bytes"] == "BLOB"
        assert fault_columns["fault_bytes"] == "BLOB"
        assert idempotency_columns["request_body"] == "BLOB"
        assert idempotency_columns["response_body"] == "BLOB"
        assert {"created_at_ns", "started_at_ns", "completed_at_ns", "duration_ns"} <= (
            run_columns
        )
        assert {
            "run_id",
            "seal_digest",
            "terminal_event_seq",
            "last_audit_seq",
            "published_at_ns",
        } <= seal_columns
    finally:
        connection.close()


def test_v2_prepared_identity_requires_child_first_deferred_relationship(
    tmp_path: Path,
) -> None:
    connection = open_control_database(tmp_path / "prepared-owner.sqlite")
    try:
        connection.execute(
            "INSERT INTO runs (run_id, state, state_version, created_at_ns) "
            "VALUES (?, 'FINALIZING', 4, 0)",
            ("bt_unowned",),
        )
        with pytest.raises(sqlite3.IntegrityError, match="preparation"):
            connection.execute(
                """
                UPDATE runs
                SET prepared_terminal_state = 'COMPLETED',
                    prepared_terminal_state_version = 5,
                    prepared_terminal_event_seq = 1
                WHERE run_id = ?
                """,
                ("bt_unowned",),
            )

        _insert_v2_preparation(connection, run_id="bt_owned")
        assert tuple(
            connection.execute(
                """
                SELECT prepared_terminal_state, prepared_terminal_state_version,
                       prepared_terminal_event_seq, state, state_version,
                       last_event_seq, last_audit_seq, control_source_seq
                FROM runs WHERE run_id = ?
                """,
                ("bt_owned",),
            ).fetchone()
        ) == ("COMPLETED", 5, 1, "FINALIZING", 4, 0, 0, 0)
    finally:
        connection.close()


def test_v2_preparation_retry_update_and_immutability_are_sql_enforced(
    tmp_path: Path,
) -> None:
    connection = open_control_database(tmp_path / "preparation-immutable.sqlite")
    try:
        _insert_v2_preparation(connection, run_id="bt_immutable")
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                "DELETE FROM terminal_preparations WHERE run_id = ?",
                ("bt_immutable",),
            )
        with pytest.raises(sqlite3.IntegrityError, match="invalid.*update"):
            connection.execute(
                "UPDATE terminal_preparations SET event_id = ? WHERE run_id = ?",
                ("evt_forged", "bt_immutable"),
            )
        connection.execute(
            """
            UPDATE terminal_preparations
            SET failure_attempt_count = 1,
                last_failure_at_ns = 11,
                last_failure_stage = 'FSYNC'
            WHERE run_id = ?
            """,
            ("bt_immutable",),
        )
        with pytest.raises(sqlite3.IntegrityError, match="invalid.*update"):
            connection.execute(
                """
                UPDATE terminal_preparations
                SET failure_attempt_count = 2,
                    last_failure_at_ns = 11,
                    last_failure_stage = 'RENAME'
                WHERE run_id = ?
                """,
                ("bt_immutable",),
            )
        connection.execute(
            """
            UPDATE terminal_preparations
            SET failure_attempt_count = 2,
                last_failure_at_ns = 12,
                last_failure_stage = 'RENAME'
            WHERE run_id = ?
            """,
            ("bt_immutable",),
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE terminal_preparations SET failure_attempt_count = 3 WHERE run_id = ?",
                ("bt_immutable",),
            )
    finally:
        connection.close()


def test_v2_fault_conversion_requires_child_run_fault_order_and_rolls_back_missing_fault(
    tmp_path: Path,
) -> None:
    connection = open_control_database(tmp_path / "fault-conversion.sqlite")
    run_id = "bt_fault_conversion"
    try:
        _insert_v2_preparation(
            connection,
            run_id=run_id,
            terminal_state="CANCELLED",
            event_type="run.cancelled",
        )

        def convert_without_commit() -> None:
            connection.execute(
                """
                UPDATE terminal_preparations
                SET terminal_state = 'FAILED', event_type = 'run.failed',
                    event_envelope_bytes = ?, event_digest = ?, audit_event_digest = ?,
                    audit_intent_bytes = ?, audit_intent_digest = ?,
                    disposition = 'FAULT_CONVERTED', failure_attempt_count = 3,
                    last_failure_at_ns = 20, last_failure_stage = 'PUBLICATION',
                    conversion_fault_hash = ?, converted_at_ns = 20
                WHERE run_id = ?
                """,
                (
                    b'{"failed":true}',
                    "d" * 64,
                    "d" * 64,
                    b'{"failed_audit":true}',
                    "e" * 64,
                    "f" * 64,
                    run_id,
                ),
            )
            connection.execute(
                "UPDATE runs SET prepared_terminal_state = 'FAILED', "
                "evidence_status = 'UNVERIFIED' WHERE run_id = ?",
                (run_id,),
            )

        connection.execute("BEGIN IMMEDIATE")
        convert_without_commit()
        with pytest.raises(sqlite3.IntegrityError):
            connection.commit()
        connection.rollback()
        assert not connection.in_transaction
        assert connection.execute(
            "SELECT disposition FROM terminal_preparations WHERE run_id = ?", (run_id,)
        ).fetchone()[0] == "NORMAL"

        connection.execute("BEGIN IMMEDIATE")
        convert_without_commit()
        connection.execute(
            """
            INSERT INTO finalization_faults (run_id, fault_bytes, fault_hash, recorded_at_ns)
            VALUES (?, ?, ?, 20)
            """,
            (run_id, b'{"fault":true}', "f" * 64),
        )
        connection.commit()
        assert tuple(
            connection.execute(
                "SELECT terminal_state, disposition, conversion_fault_hash "
                "FROM terminal_preparations WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        ) == ("FAILED", "FAULT_CONVERTED", "f" * 64)
        with pytest.raises(sqlite3.IntegrityError, match="seal"):
            connection.execute(
                """
                INSERT INTO seals (
                    run_id, seal_digest, terminal_event_seq, last_audit_seq, published_at_ns
                ) VALUES (?, ?, 1, 1, 20)
                """,
                (run_id, "9" * 64),
            )
    finally:
        connection.close()


def test_v2_terminal_rows_are_exact_copies_and_transition_only_after_publication(
    tmp_path: Path,
) -> None:
    connection = open_control_database(tmp_path / "terminal-copy.sqlite")
    run_id = "bt_terminal_copy"
    try:
        _insert_v2_preparation(connection, run_id=run_id)
        connection.execute(
            """
            UPDATE runs
            SET last_event_seq = 1, last_audit_seq = 1, control_source_seq = 1
            WHERE run_id = ?
            """,
            (run_id,),
        )
        with pytest.raises(sqlite3.IntegrityError, match="exact preparation copy"):
            _insert_raw_event(
                connection,
                event_id=f"evt_{run_id}_000001",
                run_id=run_id,
                seq=1,
                source_seq=1,
                source="control-api",
                event_type="run.completed",
                visible=0,
            )
        connection.execute(
            """
            INSERT INTO events (
                event_id, run_id, seq, source_seq, source, type, writer,
                schema_version, ts_event_ns, ts_ingest_ns, visible, envelope_bytes
            ) VALUES (?, ?, 1, 1, 'control-api', 'run.completed', 'control-api',
                      1, '10', '10', 0, ?)
            """,
            (f"evt_{run_id}_000001", run_id, b'{"candidate":true}'),
        )
        with pytest.raises(sqlite3.IntegrityError, match="exact preparation copy"):
            _insert_raw_audit(connection, run_id=run_id, audit_seq=1, event_seq=1)
        connection.execute(
            """
            INSERT INTO audit_intents (
                run_id, audit_seq, event_seq, event_digest, intent_bytes, created_at_ns
            ) VALUES (?, 1, 1, ?, ?, 10)
            """,
            (run_id, "b" * 64, b'{"audit":true}'),
        )
        with pytest.raises(sqlite3.IntegrityError, match="outbox"):
            connection.execute(
                "INSERT INTO outbox (run_id, seq, audit_seq) VALUES (?, 1, 1)",
                (run_id,),
            )
        connection.execute(
            """
            INSERT INTO outbox (
                run_id, seq, audit_seq, materialized, materialized_at_ns
            ) VALUES (?, 1, 1, 1, 20)
            """,
            (run_id,),
        )
        with pytest.raises(sqlite3.IntegrityError, match="transition"):
            connection.execute(
                "UPDATE runs SET state = 'COMPLETED', state_version = 5 WHERE run_id = ?",
                (run_id,),
            )
        connection.execute(
            """
            INSERT INTO seals (
                run_id, seal_digest, terminal_event_seq, last_audit_seq, published_at_ns
            ) VALUES (?, ?, 1, 1, 20)
            """,
            (run_id, "9" * 64),
        )
        connection.execute(
            "UPDATE events SET visible = 1 WHERE run_id = ? AND seq = 1", (run_id,)
        )
        connection.execute(
            """
            UPDATE runs
            SET state = 'COMPLETED', state_version = 5,
                completed_at_ns = 30, duration_ns = 20,
                evidence_status = 'VERIFIED',
                materialized_event_seq = 1, materialized_audit_seq = 1
            WHERE run_id = ?
            """,
            (run_id,),
        )
        assert tuple(
            connection.execute(
                "SELECT state, state_version, evidence_status FROM runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        ) == ("COMPLETED", 5, "VERIFIED")
    finally:
        connection.close()
