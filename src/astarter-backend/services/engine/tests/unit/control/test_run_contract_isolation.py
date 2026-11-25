"""An admitted schema kind cannot accidentally enter a legacy consumer."""

import asyncio
import sys
from hashlib import sha256
from pathlib import Path

import pytest

from stark_trading_os.control.dependencies import ApiCommandScheduler
from stark_trading_os.control.finalizer import Finalizer
from stark_trading_os.control.preflight import RunReservation
from stark_trading_os.control.recovery import FinalizationRecovery
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.supervisor import RunnerSupervisor
from stark_trading_os.domain.models import RunState


@pytest.fixture
def store(tmp_path):
    value = ControlStore.open(tmp_path / "control.sqlite")
    yield value
    value.close()


def seed_historical(store, state="QUEUED"):
    store._connection.execute(
        "INSERT INTO runs(run_id,state,created_at_ns,contract_kind) "
        "VALUES('bt_v2',?,10,'HISTORICAL_SMA_V2')",
        (state,),
    )


def supervisor(store, tmp_path):
    return RunnerSupervisor(
        control=store,
        runtime_root=tmp_path,
        python_executable=Path(sys.executable),
        runner_cwd=tmp_path,
    )


def test_shared_snapshots_preserve_the_contract_discriminator(store):
    old = store.reserve_run(run_id="bt_v1")
    seed_historical(store)
    assert old.contract_kind == "PROBE_V1"
    assert store.run("bt_v2").contract_kind == "HISTORICAL_SMA_V2"
    assert [(run.run_id, run.contract_kind) for run in store.recoverable_active_runs()] == [
        ("bt_v2", "HISTORICAL_SMA_V2")
    ]


def test_legacy_reservation_rejects_an_explicit_v2_before_catalog_lookup(store):
    raw = b'{"schema":"InputManifest.v2"}'
    with pytest.raises(ValueError, match="run contract"):
        store.reserve_run(
            run_id="bt_wrong",
            input_manifest_bytes=raw,
            input_manifest_hash=sha256(raw).hexdigest(),
            catalog_revision="a" * 64,
            catalog_inventory_hash="b" * 64,
        )
    assert store._connection.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 0


@pytest.mark.parametrize(
    "consumer", ["run", "recover", "finalize", "artifact", "outcome", "prepare"]
)
def test_legacy_entry_points_reject_before_files_or_database_mutation(store, tmp_path, consumer):
    seed_historical(store)
    before = tuple(store._connection.iterdump())
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700)
    with pytest.raises(ValueError, match="run contract"):
        if consumer == "run":
            reservation = RunReservation(
                run_id="bt_v2",
                state=RunState.QUEUED,
                state_version=0,
                last_visible_seq=0,
                input_manifest_bytes=b"{}",
                input_manifest_hash=sha256(b"{}").hexdigest(),
            )
            asyncio.run(supervisor(store, runtime).run(reservation))
        elif consumer == "recover":
            asyncio.run(supervisor(store, runtime).recover_one("bt_v2"))
        elif consumer == "finalize":
            Finalizer(store=store, runtime_root=runtime).finalize("bt_v2")
        elif consumer == "artifact":
            FinalizationRecovery(store=store, runtime_root=runtime).read_artifact(
                run_id="bt_v2", relative_path="metrics.json"
            )
        elif consumer == "prepare":
            store.prepare_terminal(run_id="bt_v2")
        else:
            store.runner_outcome("bt_v2")
    assert tuple(store._connection.iterdump()) == before
    assert list(runtime.iterdir()) == []


def test_pending_v2_does_not_enter_legacy_recovery_parser(store, tmp_path):
    seed_historical(store, state="FINALIZING")
    store._connection.execute(
        "INSERT INTO runner_outcomes VALUES('bt_v2',?, ?, 10)", (b"untrusted-v2", "a" * 64)
    )
    before = tuple(store._connection.iterdump())
    assert store.recoverable_terminal_run_ids() == ()
    assert FinalizationRecovery(store=store, runtime_root=tmp_path).recover() == ()
    assert tuple(store._connection.iterdump()) == before


def test_pending_v2_clean_cancel_is_skipped_before_legacy_recovery(store, tmp_path):
    seed_historical(store, state="CANCEL_REQUESTED")
    assert asyncio.run(supervisor(store, tmp_path).recover_all()) == ()
    assert store.run("bt_v2").state is RunState.CANCEL_REQUESTED


def test_api_startup_dispatches_legacy_only_and_keeps_v2_pending(store, monkeypatch):
    seed_historical(store)
    store._connection.execute(
        "INSERT INTO runs(run_id,state,created_at_ns) VALUES('bt_v1','QUEUED',10)"
    )
    seen = []
    monkeypatch.setattr(
        ApiCommandScheduler, "reconcile_run", lambda self, run_id: seen.append(run_id)
    )
    scheduler = ApiCommandScheduler(
        store=store,
        supervisor=object(),
        cancellation=object(),
        recovery=object(),
        engine_identity=object(),
    )
    asyncio.run(scheduler.start())
    assert seen == ["bt_v1"]
    assert scheduler.unavailable_reason() is None


def test_direct_api_reconcile_refuses_v2_before_starting_any_task(store):
    seed_historical(store)
    scheduler = ApiCommandScheduler(
        store=store,
        supervisor=object(),
        cancellation=object(),
        recovery=object(),
        engine_identity=object(),
    )
    with pytest.raises(ValueError, match="run contract"):
        scheduler.reconcile_run("bt_v2")
    assert scheduler._tasks == {}
