"""Historical capacity is exclusive across kinds, under the shared writer lock."""

import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from stark_trading_os.control.registry import ControlStore, EventCandidate
from stark_trading_os.domain.models import RunState

ACTIVE = ("QUEUED", "RUNNING", "CANCEL_REQUESTED", "CANCEL_PENDING", "FINALIZING")


def seed(store, run_id, kind, state):
    store._connection.execute(
        "INSERT INTO runs(run_id,state,created_at_ns,contract_kind) VALUES(?,?,10,?)",
        (run_id, state, kind),
    )


def queue(store, run_id):
    return store.commit_transition(
        run_id=run_id,
        expected_version=0,
        target=RunState.QUEUED,
        candidate=EventCandidate.control(type="run.queued", ts_event_ns="11", payload={}),
    )


@pytest.mark.parametrize("state", ACTIVE)
@pytest.mark.parametrize(
    "entrant,occupant",
    [
        ("HISTORICAL_SMA_V2", "PROBE_V1"),
        ("PROBE_V1", "HISTORICAL_SMA_V2"),
        ("HISTORICAL_SMA_V2", "HISTORICAL_SMA_V2"),
    ],
)
def test_active_run_prevents_historical_overlap_and_rolls_back(tmp_path, state, entrant, occupant):
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        seed(store, "bt_occupant", occupant, state)
        seed(store, "bt_entrant", entrant, "PREFLIGHT_READY")
        before = tuple(store._connection.iterdump())
        with pytest.raises(ValueError, match="^HISTORICAL_CAPACITY_BUSY$"):
            queue(store, "bt_entrant")
        assert tuple(store._connection.iterdump()) == before
    finally:
        store.close()


@pytest.mark.parametrize("state", ["DRAFT", "PREFLIGHT_BLOCKED", "PREFLIGHT_READY"])
def test_unconsumed_reservations_do_not_occupy_capacity(tmp_path, state):
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        seed(store, "bt_waiting", "HISTORICAL_SMA_V2", state)
        seed(store, "bt_entrant", "HISTORICAL_SMA_V2", "PREFLIGHT_READY")
        queue(store, "bt_entrant")
        assert store.run("bt_entrant").state is RunState.QUEUED
    finally:
        store.close()


def test_legacy_only_parallel_admission_is_preserved(tmp_path):
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        for i, state in enumerate(ACTIVE):
            seed(store, f"bt_old{i}", "PROBE_V1", state)
        seed(store, "bt_entrant", "PROBE_V1", "PREFLIGHT_READY")
        queue(store, "bt_entrant")
        assert store.run("bt_entrant").state is RunState.QUEUED
    finally:
        store.close()


@pytest.mark.parametrize("other_kind", ["PROBE_V1", "HISTORICAL_SMA_V2"])
def test_two_connections_cannot_admit_overlapping_historical_work(tmp_path, other_kind):
    path = tmp_path / "race.sqlite"
    setup = ControlStore.open(path)
    seed(setup, "bt_a", "HISTORICAL_SMA_V2", "PREFLIGHT_READY")
    seed(setup, "bt_b", other_kind, "PREFLIGHT_READY")
    setup.close()
    barrier = threading.Barrier(2)

    def worker(run_id):
        store = ControlStore.open(path)
        try:
            barrier.wait(timeout=10)
            try:
                queue(store, run_id)
            except ValueError as error:
                return str(error), run_id
            return "QUEUED", run_id
        finally:
            store.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(worker, ("bt_a", "bt_b")))
    assert sorted(status for status, _ in results) == ["HISTORICAL_CAPACITY_BUSY", "QUEUED"]
    reopened = ControlStore.open(path)
    try:
        for status, run_id in results:
            run = reopened.run(run_id)
            assert run.state.value == ("QUEUED" if status == "QUEUED" else "PREFLIGHT_READY")
            assert run.last_event_seq == (1 if status == "QUEUED" else 0)
    finally:
        reopened.close()
