from __future__ import annotations

import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from multiprocessing import get_context
from pathlib import Path
from threading import Barrier
from typing import Protocol

import pytest
from nautilus_trader.persistence import ParquetDataCatalog

from stark_trading_os.catalog.fixture_publisher import (
    CatalogPublishError,
    FixturePublisher,
    _native_instrument,
    validate_native_returned_paths,
)
from stark_trading_os.catalog.fixture_registry import FixtureRegistry
from stark_trading_os.control.database import open_control_database
from stark_trading_os.control.registry import CatalogConflict, CatalogPublication, ControlStore

REPOSITORY_ROOT = Path(__file__).parents[5]


class WaitBarrier(Protocol):
    def wait(self) -> object: ...


class ResultQueue(Protocol):
    def put(self, value: object) -> None: ...


class ReadyEvent(Protocol):
    def set(self) -> None: ...


def _process_publish_worker(
    database: str,
    runtime: str,
    fixture_root: str,
    barrier: WaitBarrier,
    results: ResultQueue,
) -> None:
    store = ControlStore.open(database)
    try:
        service = FixturePublisher(
            registry=FixtureRegistry(Path(fixture_root)),
            control=store,
            runtime_root=Path(runtime),
        )
        barrier.wait()
        publication = service.publish("local-qa-v1")
        results.put(("ok", publication.catalog_revision))
    except BaseException as error:
        results.put(("error", type(error).__name__))
    finally:
        store.close()


def _process_die_holding_lock(
    database: str, runtime: str, fixture_root: str, ready: ReadyEvent
) -> None:
    store = ControlStore.open(database)
    service = FixturePublisher(
        registry=FixtureRegistry(Path(fixture_root)),
        control=store,
        runtime_root=Path(runtime),
    )
    with service._publication_lock():
        ready.set()
        os._exit(23)


def _process_load_fifo_under_publication_lock(
    database: str,
    runtime: str,
    fixture_root: str,
    ready: ReadyEvent,
    results: ResultQueue,
) -> None:
    store = ControlStore.open(database)
    service = FixturePublisher(
        registry=FixtureRegistry(Path(fixture_root)),
        control=store,
        runtime_root=Path(runtime),
    )
    try:
        with service._publication_lock():
            ready.set()
            service._registry.load("local-qa-v1")
        results.put(("ok", ""))
    except BaseException as error:
        results.put((type(error).__name__, str(error)))
    finally:
        store.close()


def test_two_publishers_and_independent_stores_converge_on_one_target(tmp_path: Path) -> None:
    database = tmp_path / "control.sqlite"
    runtime = tmp_path / "trading"
    barrier = Barrier(2)

    def publish(_: int) -> CatalogPublication:
        store = ControlStore.open(database)
        try:
            service = FixturePublisher(
                registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
                control=store,
                runtime_root=runtime,
            )
            barrier.wait()
            return service.publish("local-qa-v1")
        finally:
            store.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = tuple(executor.map(publish, (1, 2)))
    assert results[0] == results[1]
    assert [path.name for path in (runtime / "catalogs").iterdir()] == [
        results[0].catalog_revision
    ]

    inspection = open_control_database(database)
    try:
        assert inspection.execute("SELECT count(*) FROM catalog_publications").fetchone()[0] == 1
        assert inspection.execute("SELECT count(*) FROM catalog_audit_intents").fetchone()[0] == 1
    finally:
        inspection.close()


def test_real_rc3_sanitized_instrument_collision_is_rejected_before_prepare(
    tmp_path: Path,
) -> None:
    source = FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures").load("local-qa-v1")
    first = _native_instrument(source.instrument)
    collision_source = source.instrument.model_copy(
        update={"instrument_id": "ETHUSDT.SIM", "raw_symbol": "ETHUSDT"}
    )
    second = _native_instrument(collision_source)
    catalog_root = tmp_path / "native"
    catalog_root.mkdir()
    native = ParquetDataCatalog(str(catalog_root.resolve()))
    returned = native.write_instruments([first, second])

    assert len(returned) == 2 and returned[0] == returned[1]
    with pytest.raises(CatalogPublishError, match="CATALOG_PATH_COLLISION"):
        validate_native_returned_paths(catalog_root, returned)

    database = open_control_database(tmp_path / "control.sqlite")
    try:
        assert database.execute("SELECT count(*) FROM catalog_publications").fetchone()[0] == 0
    finally:
        database.close()


def test_existing_empty_target_is_not_overwritten_by_os_rename(tmp_path: Path) -> None:
    seed_store = ControlStore.open(tmp_path / "seed.sqlite")
    try:
        revision = FixturePublisher(
            registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
            control=seed_store,
            runtime_root=tmp_path / "seed-runtime",
        ).publish("local-qa-v1").catalog_revision
    finally:
        seed_store.close()

    runtime = tmp_path / "trading"
    runtime.mkdir(mode=0o700)
    (runtime / "catalog-staging").mkdir(mode=0o700)
    catalogs = runtime / "catalogs"
    catalogs.mkdir(mode=0o700)
    target = catalogs / revision
    target.mkdir(mode=0o700)
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        service = FixturePublisher(
            registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
            control=store,
            runtime_root=runtime,
        )
        with pytest.raises(CatalogConflict, match="CATALOG_CONFLICT"):
            service.publish("local-qa-v1")
        assert list(target.iterdir()) == []
        assert store.catalog_publication(revision) is None
    finally:
        store.close()


def test_two_spawned_process_publishers_converge_under_flock(tmp_path: Path) -> None:
    context = get_context("spawn")
    database = str(tmp_path / "control.sqlite")
    runtime = str(tmp_path / "trading")
    fixture_root = str(REPOSITORY_ROOT / "data" / "fixtures")
    barrier = context.Barrier(2)
    results = context.Queue()
    processes = [
        context.Process(
            target=_process_publish_worker,
            args=(database, runtime, fixture_root, barrier, results),
        )
        for _ in range(2)
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=30)
        assert not process.is_alive()
        assert process.exitcode == 0
    outcomes = [results.get(timeout=5) for _ in processes]
    assert outcomes[0][0] == outcomes[1][0] == "ok"
    assert outcomes[0][1] == outcomes[1][1]


def test_kernel_releases_flock_after_real_process_death(tmp_path: Path) -> None:
    context = get_context("spawn")
    database = str(tmp_path / "control.sqlite")
    runtime = str(tmp_path / "trading")
    fixture_root = str(REPOSITORY_ROOT / "data" / "fixtures")
    ready = context.Event()
    process = context.Process(
        target=_process_die_holding_lock,
        args=(database, runtime, fixture_root, ready),
    )
    process.start()
    assert ready.wait(timeout=15)
    process.join(timeout=15)
    assert not process.is_alive()
    assert process.exitcode == 23

    store = ControlStore.open(database)
    try:
        publication = FixturePublisher(
            registry=FixtureRegistry(Path(fixture_root)),
            control=store,
            runtime_root=Path(runtime),
        ).publish("local-qa-v1")
        assert publication.status == "PUBLISHED"
    finally:
        store.close()


def test_fifo_source_cannot_hold_the_global_publication_lock(tmp_path: Path) -> None:
    fixture_root = tmp_path / "fixtures"
    shutil.copytree(REPOSITORY_ROOT / "data" / "fixtures", fixture_root)
    fifo = fixture_root / "local-qa-v1" / "quotes.jsonl"
    fifo.unlink()
    os.mkfifo(fifo, mode=0o600)
    context = get_context("spawn")
    database = str(tmp_path / "control.sqlite")
    runtime = str(tmp_path / "trading")
    ready = context.Event()
    results = context.Queue()
    process = context.Process(
        target=_process_load_fifo_under_publication_lock,
        args=(database, runtime, str(fixture_root), ready, results),
    )
    process.start()
    assert ready.wait(timeout=15)
    process.join(timeout=3)
    timed_out = process.is_alive()
    if timed_out:
        process.terminate()
        process.join(timeout=3)

    store = ControlStore.open(database)
    try:
        publication = FixturePublisher(
            registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
            control=store,
            runtime_root=Path(runtime),
        ).publish("local-qa-v1")
        assert publication.status == "PUBLISHED"
    finally:
        store.close()

    assert not timed_out, "FIFO source blocked while holding the publication lock"
    assert process.exitcode == 0
    assert results.get(timeout=1) == ("FixtureInvalid", "SOURCE_PATH_INVALID")
