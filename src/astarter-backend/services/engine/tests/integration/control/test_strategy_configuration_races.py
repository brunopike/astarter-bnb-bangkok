from __future__ import annotations

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.strategy_configurations import StrategyRevisionConflict
from stark_trading_os.control.strategy_models import ConfigurationInput


def _configuration(*, name: str, replay_seed: int = 7) -> ConfigurationInput:
    return ConfigurationInput.model_validate(
        {
            "name": name,
            "strategy_ref": "determinism-probe@v1",
            "parameters": {
                "entry_limit_price": "100",
                "entry_quantity": "15",
                "metric_round_trip_quantity": "1",
                "metric_round_trips": 5,
                "risk_probe_quantity": "20",
                "venue_rejection_quantity": "1",
            },
            "replay_seed": replay_seed,
        }
    )


def test_concurrent_draft_updates_have_one_revision_winner(tmp_path: Path) -> None:
    database = tmp_path / "draft-update-race.sqlite"
    setup = ControlStore.open(database, clock=lambda: 1_700_000_000_000_000_000)
    setup.create_strategy_draft(
        draft_id=f"sd_{1:032x}",
        configuration=_configuration(name="Initial"),
    )
    setup.close()
    barrier = threading.Barrier(2)

    def update(name: str, replay_seed: int) -> tuple[str, str | None]:
        store = ControlStore.open(database, clock=lambda: 1_700_000_000_000_000_001)
        try:
            barrier.wait(timeout=10)
            try:
                result = store.update_strategy_draft(
                    draft_id=f"sd_{1:032x}",
                    expected_revision=1,
                    configuration=_configuration(name=name, replay_seed=replay_seed),
                )
            except StrategyRevisionConflict:
                return "conflict", None
            return "winner", result.name
        finally:
            store.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = tuple(
            executor.map(lambda value: update(*value), (("First", 8), ("Second", 9)))
        )

    assert sorted(result[0] for result in results) == ["conflict", "winner"]
    winner_name = next(result[1] for result in results if result[0] == "winner")
    verify = ControlStore.open(database)
    try:
        draft = verify.strategy_draft(f"sd_{1:032x}")
        assert draft is not None
        assert draft.revision == 2
        assert draft.name == winner_name
        assert (
            verify._connection.execute(
                "SELECT COUNT(*) FROM strategy_configuration_audit_entries"
            ).fetchone()[0]
            == 2
        )
    finally:
        verify.close()


def test_concurrent_publish_retries_return_one_immutable_version(tmp_path: Path) -> None:
    database = tmp_path / "draft-publish-race.sqlite"
    setup = ControlStore.open(database, clock=lambda: 1_700_000_000_000_000_000)
    setup.create_strategy_draft(
        draft_id=f"sd_{2:032x}",
        configuration=_configuration(name="Publish race"),
    )
    setup.close()
    barrier = threading.Barrier(2)

    def publish(configuration_number: int) -> str:
        store = ControlStore.open(database, clock=lambda: 1_700_000_000_000_000_001)
        try:
            barrier.wait(timeout=10)
            version = store.publish_strategy_draft(
                draft_id=f"sd_{2:032x}",
                expected_revision=1,
                configuration_id=f"cfg_{configuration_number:032x}",
            )
            return version.configuration_id
        finally:
            store.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        configuration_ids = tuple(executor.map(publish, (1, 2)))

    assert len(set(configuration_ids)) == 1
    verify = ControlStore.open(database)
    try:
        assert (
            verify._connection.execute(
                "SELECT COUNT(*) FROM strategy_configuration_versions"
            ).fetchone()[0]
            == 1
        )
        assert (
            verify._connection.execute(
                """
                SELECT COUNT(*)
                FROM strategy_configuration_audit_entries
                WHERE action = 'strategy_configuration.published'
                """
            ).fetchone()[0]
            == 1
        )
    finally:
        verify.close()


def test_strategy_configuration_audit_entries_are_append_only(tmp_path: Path) -> None:
    store = ControlStore.open(
        tmp_path / "append-only-audit.sqlite",
        clock=lambda: 1_700_000_000_000_000_000,
    )
    try:
        store.create_strategy_draft(
            draft_id=f"sd_{3:032x}",
            configuration=_configuration(name="Audit"),
        )

        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            store._connection.execute(
                "UPDATE strategy_configuration_audit_entries SET action = action"
            )
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            store._connection.execute("DELETE FROM strategy_configuration_audit_entries")

        assert store._connection.execute(
            "SELECT COUNT(*) FROM strategy_configuration_audit_entries"
        ).fetchone()[0] == 1
    finally:
        store.close()
