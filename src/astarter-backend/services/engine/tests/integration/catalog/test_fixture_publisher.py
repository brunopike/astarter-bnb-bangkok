from __future__ import annotations

import builtins
import errno
import gc
import json
import os
import shutil
import sys
import threading
from hashlib import sha256
from pathlib import Path
from typing import cast

import pytest
from nautilus_trader.persistence import ParquetDataCatalog

import stark_trading_os.catalog.fixture_publisher as fixture_publisher_module
from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.catalog.fixture_publisher import (
    CatalogPublicationAuthority,
    CatalogPublishError,
    FixturePublisher,
)
from stark_trading_os.catalog.fixture_registry import (
    FixtureInvalid,
    FixtureRegistry,
    FixtureUnknown,
)
from stark_trading_os.control.registry import (
    CatalogIntegrityFailed,
    CatalogStorageFailed,
    ControlStore,
)

REPOSITORY_ROOT = Path(__file__).parents[5]


def publisher(tmp_path: Path) -> tuple[FixturePublisher, ControlStore]:
    store = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: 100)
    service = FixturePublisher(
        registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
        control=store,
        runtime_root=tmp_path / "trading",
    )
    return service, store


def current_build_trees(tmp_path: Path) -> tuple[Path, ...]:
    staging = tmp_path / "trading" / "catalog-staging"
    if not staging.is_dir():
        return ()
    return tuple(sorted(staging.glob("build-*")))


def test_round4_enter_interrupt_before_with_suite_has_no_build_side_effect(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service, store = publisher(tmp_path)
    primary = BaseException("injected after generator yield before enter return")
    real_next = builtins.next
    target_code = fixture_publisher_module._owned_build_tree.__wrapped__.__code__
    fired = False

    def next_then_interrupt(iterator: object, *default: object) -> object:
        nonlocal fired
        value = real_next(iterator, *default)
        if not fired and getattr(iterator, "gi_code", None) is target_code:
            fired = True
            raise primary
        return value

    try:
        with monkeypatch.context() as patch:
            patch.setattr(builtins, "next", next_then_interrupt)
            with pytest.raises(BaseException) as caught:
                service.publish("local-qa-v1")
        gc.collect()
        assert fired is True
        assert caught.value is primary
        assert current_build_trees(tmp_path) == ()
        assert store.recoverable_catalog_publications() == ()
    finally:
        store.close()


def test_round3_closed_store_retries_cleanup_exact_current_build(
    tmp_path: Path,
) -> None:
    service, store = publisher(tmp_path)
    store.close()

    for _ in range(3):
        with pytest.raises(CatalogStorageFailed, match="CATALOG_STORAGE_FAILED"):
            service.publish("local-qa-v1")

    assert current_build_trees(tmp_path) == ()
    reopened = ControlStore.open(tmp_path / "control.sqlite")
    try:
        assert reopened.recoverable_catalog_publications() == ()
    finally:
        reopened.close()


def test_round3_post_build_interrupt_has_no_unowned_line_window(
    tmp_path: Path,
) -> None:
    service, store = publisher(tmp_path)
    primary = BaseException("injected immediately after build return")
    trace_fired = False

    def interrupt_after_build(frame: object, event: str, _argument: object) -> object:
        nonlocal trace_fired
        frame_code = getattr(frame, "f_code", None)
        frame_locals = getattr(frame, "f_locals", {})
        if (
            event == "line"
            and frame_code is FixturePublisher.publish.__code__
            and "built" in frame_locals
            and not trace_fired
        ):
            trace_fired = True
            raise primary
        return interrupt_after_build

    try:
        sys.settrace(interrupt_after_build)
        with pytest.raises(BaseException) as caught:
            service.publish("local-qa-v1")
    finally:
        sys.settrace(None)
        store.close()

    assert trace_fired is True
    assert caught.value is primary
    assert current_build_trees(tmp_path) == ()


def test_round3_build_name_collision_preserves_preexisting_tree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service, store = publisher(tmp_path)
    collision_hex = "a" * 32
    runtime = tmp_path / "trading"
    runtime.mkdir(mode=0o700)
    staging = runtime / "catalog-staging"
    staging.mkdir(mode=0o700)
    collision = staging / f"build-{collision_hex}"
    collision.mkdir(mode=0o700)
    sentinel = collision / "sentinel"
    sentinel.write_bytes(b"preexisting service-owned bytes")
    sentinel.chmod(0o600)
    before = (
        collision.stat().st_mode & 0o777,
        sentinel.stat().st_mode & 0o777,
        sentinel.read_bytes(),
    )

    class FixedUUID:
        hex = collision_hex

    monkeypatch.setattr(
        fixture_publisher_module.uuid, "uuid4", lambda: FixedUUID()
    )

    try:
        with pytest.raises(CatalogPublishError, match="CATALOG_FILESYSTEM_FAILED"):
            service.publish("local-qa-v1")

        assert collision.is_dir()
        assert sentinel.is_file()
        assert (
            collision.stat().st_mode & 0o777,
            sentinel.stat().st_mode & 0o777,
            sentinel.read_bytes(),
        ) == before
        assert store.recoverable_catalog_publications() == ()
    finally:
        store.close()


def test_round3_mkdir_side_effect_interrupt_cleans_exact_created_tree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service, store = publisher(tmp_path)
    primary = BaseException("injected after mkdir side effect")
    real_mkdir = os.mkdir
    fired = False

    def mkdir_then_interrupt(
        path: str | bytes | os.PathLike[str], mode: int = 0o777, *, dir_fd: int | None = None
    ) -> None:
        nonlocal fired
        real_mkdir(path, mode, dir_fd=dir_fd)
        if Path(path).name.startswith("build-") and not fired:
            fired = True
            raise primary

    try:
        with monkeypatch.context() as patch:
            patch.setattr(fixture_publisher_module.os, "mkdir", mkdir_then_interrupt)
            with pytest.raises(BaseException) as caught:
                service.publish("local-qa-v1")
        assert fired is True
        assert caught.value is primary
        assert current_build_trees(tmp_path) == ()
        assert store.recoverable_catalog_publications() == ()
    finally:
        store.close()


def test_round3_existing_row_failure_cleans_current_build(tmp_path: Path) -> None:
    service, store = publisher(tmp_path)
    try:
        publication = service.publish("local-qa-v1")
        target = tmp_path / "trading" / "catalogs" / publication.catalog_revision
        fixture_publisher_module._remove_service_tree(target)

        with pytest.raises(
            CatalogIntegrityFailed, match="CATALOG_INTEGRITY_FAILED"
        ):
            service.publish("local-qa-v1")

        assert current_build_trees(tmp_path) == ()
        retained = store.catalog_publication(publication.catalog_revision)
        assert retained is not None and retained.status == "INTEGRITY_FAILED"
    finally:
        store.close()


def test_round3_current_build_cleanup_secondary_preserves_control_primary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    primary = SystemExit("injected control read process death")
    cleanup_failure = BaseException("injected build cleanup failure")

    class FailingControl:
        def catalog_publication(self, _catalog_revision: str) -> None:
            raise primary

    service = FixturePublisher(
        registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
        control=cast(CatalogPublicationAuthority, FailingControl()),
        runtime_root=tmp_path / "trading",
    )
    real_remove = fixture_publisher_module._remove_service_tree

    def fail_cleanup(_path: Path) -> None:
        raise cleanup_failure

    try:
        with monkeypatch.context() as patch:
            patch.setattr(
                fixture_publisher_module, "_remove_service_tree", fail_cleanup
            )
            with pytest.raises(BaseException) as caught:
                service.publish("local-qa-v1")
        assert caught.value is primary
        assert tuple(getattr(primary, "__notes__", ())) == (
            "Secondary cleanup failure: CATALOG_FILESYSTEM_FAILED",
        )
    finally:
        for path in current_build_trees(tmp_path):
            real_remove(path)


def test_round3_build_cleanup_secondary_preserves_build_primary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service, store = publisher(tmp_path)
    primary = CatalogPublishError("INJECTED_BUILD_PRIMARY")
    cleanup_failure = BaseException("injected build cleanup failure")
    real_remove = fixture_publisher_module._remove_service_tree

    def fail_build(_source: object) -> None:
        raise primary

    def fail_cleanup(_path: Path) -> None:
        raise cleanup_failure

    try:
        with monkeypatch.context() as patch:
            patch.setattr(fixture_publisher_module, "_native_instrument", fail_build)
            patch.setattr(
                fixture_publisher_module, "_remove_service_tree", fail_cleanup
            )
            with pytest.raises(BaseException) as caught:
                service.publish("local-qa-v1")
        assert caught.value is primary
        assert tuple(getattr(primary, "__notes__", ())) == (
            "Secondary cleanup failure: CATALOG_FILESYSTEM_FAILED",
        )
    finally:
        for path in current_build_trees(tmp_path):
            real_remove(path)
        store.close()


def test_real_rc3_catalog_is_published_read_back_and_content_addressed(
    tmp_path: Path,
) -> None:
    service, store = publisher(tmp_path)
    try:
        publication = service.publish("local-qa-v1")
        assert publication.status == "PUBLISHED"
        assert publication.catalog_revision == sha256(publication.publication_bytes).hexdigest()
        assert service.publish("local-qa-v1") == publication

        target = tmp_path / "trading" / "catalogs" / publication.catalog_revision
        assert target.is_dir()
        assert stat_mode(target) == 0o500
        assert all(stat_mode(path) == 0o400 for path in target.rglob("*") if path.is_file())
        assert {path.name for path in target.rglob("catalog-manifest.json")} == {
            "catalog-manifest.json"
        }
        native = ParquetDataCatalog(str(target.resolve()))
        assert native.list_data_types() == ["instruments", "quotes"]
        assert len(native.instruments()) == 1
        quotes = native.query_quote_ticks()
        assert len(quotes) == 2
        assert [quote.ts_init for quote in quotes] == [
            1_700_000_000_000_000_000,
            1_700_000_000_000_000_001,
        ]
    finally:
        store.close()


def test_public_surface_accepts_only_fixture_id(tmp_path: Path) -> None:
    service, store = publisher(tmp_path)
    try:
        with pytest.raises(FixtureUnknown):
            service.publish("../../private")
    finally:
        store.close()


def test_published_extra_file_is_detected_and_database_is_failed_closed(tmp_path: Path) -> None:
    service, store = publisher(tmp_path)
    try:
        publication = service.publish("local-qa-v1")
        target = tmp_path / "trading" / "catalogs" / publication.catalog_revision
        os.chmod(target, 0o700)
        extra = target / "extra"
        extra.write_bytes(b"attack")
        os.chmod(extra, 0o400)
        os.chmod(target, 0o500)

        with pytest.raises(CatalogIntegrityFailed, match="CATALOG_INTEGRITY_FAILED"):
            service.revalidate(publication.catalog_revision)
        failed = store.catalog_publication(publication.catalog_revision)
        assert failed is not None and failed.status == "INTEGRITY_FAILED"
    finally:
        store.close()


def test_published_payload_byte_mutation_is_detected(tmp_path: Path) -> None:
    service, store = publisher(tmp_path)
    try:
        publication = service.publish("local-qa-v1")
        target = tmp_path / "trading" / "catalogs" / publication.catalog_revision
        payload = next(path for path in target.rglob("*.parquet") if path.is_file())
        os.chmod(payload, 0o600)
        payload.write_bytes(payload.read_bytes() + b"attack")
        os.chmod(payload, 0o400)

        with pytest.raises(CatalogIntegrityFailed, match="CATALOG_INTEGRITY_FAILED"):
            service.revalidate(publication.catalog_revision)
    finally:
        store.close()


def test_published_payload_permission_mutation_is_detected(tmp_path: Path) -> None:
    service, store = publisher(tmp_path)
    try:
        publication = service.publish("local-qa-v1")
        target = tmp_path / "trading" / "catalogs" / publication.catalog_revision
        payload = next(path for path in target.rglob("*.parquet") if path.is_file())
        os.chmod(payload, 0o600)

        with pytest.raises(CatalogIntegrityFailed, match="CATALOG_INTEGRITY_FAILED"):
            service.revalidate(publication.catalog_revision)
    finally:
        store.close()


def test_published_symlink_is_detected(tmp_path: Path) -> None:
    service, store = publisher(tmp_path)
    target: Path | None = None
    link: Path | None = None
    try:
        publication = service.publish("local-qa-v1")
        target = tmp_path / "trading" / "catalogs" / publication.catalog_revision
        outside = tmp_path / "outside"
        outside.write_bytes(b"attack")
        os.chmod(target, 0o700)
        link = target / "symlink"
        link.symlink_to(outside)
        os.chmod(target, 0o500)

        with pytest.raises(CatalogIntegrityFailed, match="CATALOG_INTEGRITY_FAILED"):
            service.revalidate(publication.catalog_revision)
    finally:
        if target is not None and target.exists():
            os.chmod(target, 0o700)
        if link is not None and link.is_symlink():
            link.unlink()
        if target is not None and target.exists():
            for current_root, directory_names, file_names in os.walk(target):
                current = Path(current_root)
                os.chmod(current, 0o700)
                for name in directory_names:
                    os.chmod(current / name, 0o700)
                for name in file_names:
                    os.chmod(current / name, 0o600)
        store.close()


@pytest.mark.parametrize("error_number", [errno.EMFILE, errno.EIO])
def test_published_scandir_operational_failure_keeps_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, error_number: int
) -> None:
    service, store = publisher(tmp_path)
    try:
        publication = service.publish("local-qa-v1")
        target = tmp_path / "trading" / "catalogs" / publication.catalog_revision
        real_scandir = os.scandir

        def fail_target(path: str | os.PathLike[str]) -> os.ScandirIterator[str]:
            if Path(path) == target:
                raise OSError(error_number, "injected operational scandir failure")
            return real_scandir(path)

        with monkeypatch.context() as patch:
            patch.setattr(fixture_publisher_module.os, "scandir", fail_target)
            with pytest.raises(CatalogPublishError, match="CATALOG_FILESYSTEM_FAILED"):
                service.revalidate(publication.catalog_revision)

        retained = store.catalog_publication(publication.catalog_revision)
        assert retained is not None and retained.status == "PUBLISHED"
    finally:
        store.close()


def test_published_native_reader_operational_failure_keeps_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service, store = publisher(tmp_path)
    try:
        publication = service.publish("local-qa-v1")

        def fail_list_data_types(_reader: object) -> list[str]:
            raise RuntimeError("injected native reader failure")

        with monkeypatch.context() as patch:
            patch.setattr(
                fixture_publisher_module.ParquetDataCatalog,
                "list_data_types",
                fail_list_data_types,
            )
            with pytest.raises(
                CatalogPublishError, match="CATALOG_NATIVE_READBACK_FAILED"
            ):
                service.revalidate(publication.catalog_revision)

        retained = store.catalog_publication(publication.catalog_revision)
        assert retained is not None and retained.status == "PUBLISHED"
    finally:
        store.close()


def test_lockfile_symlink_is_rejected(tmp_path: Path) -> None:
    runtime = tmp_path / "trading"
    runtime.mkdir(mode=0o700)
    target = tmp_path / "elsewhere"
    target.write_bytes(b"")
    (runtime / ".catalog-publish.lock").symlink_to(target)
    store = ControlStore.open(tmp_path / "control.sqlite")
    service = FixturePublisher(
        registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
        control=store,
        runtime_root=runtime,
    )
    try:
        with pytest.raises(CatalogPublishError, match="CATALOG_LOCK_INVALID"):
            service.publish("local-qa-v1")
    finally:
        store.close()


def test_lockfile_mode_mutation_is_rejected(tmp_path: Path) -> None:
    runtime = tmp_path / "trading"
    runtime.mkdir(mode=0o700)
    lock = runtime / ".catalog-publish.lock"
    lock.write_bytes(b"")
    os.chmod(lock, 0o644)
    store = ControlStore.open(tmp_path / "control.sqlite")
    service = FixturePublisher(
        registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
        control=store,
        runtime_root=runtime,
    )
    try:
        with pytest.raises(CatalogPublishError, match="CATALOG_LOCK_INVALID"):
            service.publish("local-qa-v1")
    finally:
        store.close()


def test_lock_close_only_failure_is_stable_inside_outer_exception_handler(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service, store = publisher(tmp_path)
    real_open = os.open
    real_close = os.close
    lock_fds: set[int] = set()

    def track_lock_open(
        path: str | os.PathLike[str],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        descriptor = real_open(path, flags, mode, dir_fd=dir_fd)
        if dir_fd is None and Path(path).name == ".catalog-publish.lock":
            lock_fds.add(descriptor)
        return descriptor

    def fail_lock_close(descriptor: int) -> None:
        if descriptor in lock_fds:
            raise OSError(errno.EIO, "injected lock close failure")
        real_close(descriptor)

    try:
        try:
            raise ValueError("handled outer exception")
        except ValueError as outer:
            handled = outer
            with monkeypatch.context() as patch:
                patch.setattr(fixture_publisher_module.os, "open", track_lock_open)
                patch.setattr(fixture_publisher_module.os, "close", fail_lock_close)
                with pytest.raises(CatalogPublishError, match="CATALOG_LOCK_INVALID"):
                    with service._publication_lock():
                        pass
        assert getattr(handled, "__notes__", ()) == ()
    finally:
        for descriptor in lock_fds:
            real_close(descriptor)
        store.close()


def test_lock_close_failure_releases_kernel_lock_for_bounded_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service, store = publisher(tmp_path)
    real_open = os.open
    real_close = os.close
    leaked_lock_fds: set[int] = set()

    def track_lock_open(
        path: str | os.PathLike[str],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        descriptor = real_open(path, flags, mode, dir_fd=dir_fd)
        if dir_fd is None and Path(path).name == ".catalog-publish.lock":
            leaked_lock_fds.add(descriptor)
        return descriptor

    def fail_lock_close(descriptor: int) -> None:
        if descriptor in leaked_lock_fds:
            raise OSError(errno.EIO, "injected lock close failure")
        real_close(descriptor)

    acquired = threading.Event()
    retry_errors: list[BaseException] = []

    def retry_lock() -> None:
        try:
            with service._publication_lock():
                acquired.set()
        except BaseException as error:
            retry_errors.append(error)
            acquired.set()

    retry = threading.Thread(target=retry_lock, daemon=True)
    try:
        with monkeypatch.context() as patch:
            patch.setattr(fixture_publisher_module.os, "open", track_lock_open)
            patch.setattr(fixture_publisher_module.os, "close", fail_lock_close)
            with pytest.raises(CatalogPublishError, match="CATALOG_LOCK_INVALID"):
                with service._publication_lock():
                    pass
        retry.start()
        assert acquired.wait(0.25), "publication lock remained held after cleanup failure"
        assert retry_errors == []
    finally:
        for descriptor in leaked_lock_fds:
            real_close(descriptor)
        retry.join(timeout=1.0)
        store.close()


def test_publication_flock_unlock_only_failure_is_stable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    descriptor = os.open(tmp_path / "lock", os.O_RDWR | os.O_CREAT, 0o600)
    real_flock = fixture_publisher_module.fcntl.flock
    real_flock(descriptor, fixture_publisher_module.fcntl.LOCK_EX)

    def fail_unlock(lock_fd: int, operation: int) -> None:
        if operation == fixture_publisher_module.fcntl.LOCK_UN:
            raise OSError(errno.EIO, "injected unlock failure")
        real_flock(lock_fd, operation)

    try:
        with monkeypatch.context() as patch:
            patch.setattr(fixture_publisher_module.fcntl, "flock", fail_unlock)
            with pytest.raises(
                CatalogPublishError, match="CATALOG_LOCK_INVALID"
            ):
                with fixture_publisher_module._managed_publication_flock(
                    descriptor
                ):
                    pass
    finally:
        real_flock(descriptor, fixture_publisher_module.fcntl.LOCK_UN)
        os.close(descriptor)


def test_publication_flock_unlock_failure_preserves_body_exception(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    descriptor = os.open(tmp_path / "lock", os.O_RDWR | os.O_CREAT, 0o600)
    real_flock = fixture_publisher_module.fcntl.flock
    real_flock(descriptor, fixture_publisher_module.fcntl.LOCK_EX)
    primary = BaseException("simulated process death")

    def fail_unlock(lock_fd: int, operation: int) -> None:
        if operation == fixture_publisher_module.fcntl.LOCK_UN:
            raise OSError(errno.EIO, "injected unlock failure")
        real_flock(lock_fd, operation)

    try:
        with monkeypatch.context() as patch:
            patch.setattr(fixture_publisher_module.fcntl, "flock", fail_unlock)
            with pytest.raises(BaseException) as caught:
                with fixture_publisher_module._managed_publication_flock(
                    descriptor
                ):
                    raise primary
        assert caught.value is primary
        assert tuple(getattr(primary, "__notes__", ())) == (
            "Secondary cleanup failure: CATALOG_LOCK_INVALID",
        )
    finally:
        real_flock(descriptor, fixture_publisher_module.fcntl.LOCK_UN)
        os.close(descriptor)


def test_publication_flock_unlock_and_close_failures_keep_first_cleanup_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    descriptor = os.open(tmp_path / "lock", os.O_RDWR | os.O_CREAT, 0o600)
    real_flock = fixture_publisher_module.fcntl.flock
    real_close = os.close
    real_flock(descriptor, fixture_publisher_module.fcntl.LOCK_EX)

    def fail_unlock(lock_fd: int, operation: int) -> None:
        if operation == fixture_publisher_module.fcntl.LOCK_UN:
            raise OSError(errno.EIO, "injected unlock failure")
        real_flock(lock_fd, operation)

    def fail_close(lock_fd: int) -> None:
        if lock_fd == descriptor:
            raise OSError(errno.EIO, "injected close failure")
        real_close(lock_fd)

    try:
        with monkeypatch.context() as patch:
            patch.setattr(fixture_publisher_module.fcntl, "flock", fail_unlock)
            patch.setattr(fixture_publisher_module.os, "close", fail_close)
            with pytest.raises(CatalogPublishError) as caught:
                with fixture_publisher_module._managed_descriptor(
                    descriptor, code="CATALOG_LOCK_INVALID"
                ):
                    with fixture_publisher_module._managed_publication_flock(
                        descriptor
                    ):
                        pass
        assert str(caught.value) == "CATALOG_LOCK_INVALID"
        assert tuple(getattr(caught.value, "__notes__", ())) == (
            "Secondary cleanup failure: CATALOG_LOCK_INVALID",
        )
    finally:
        real_flock(descriptor, fixture_publisher_module.fcntl.LOCK_UN)
        real_close(descriptor)


def test_lock_fstat_operational_failure_is_stable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service, store = publisher(tmp_path)
    real_open = os.open
    real_fstat = os.fstat
    lock_fds: set[int] = set()

    def track_lock_open(
        path: str | os.PathLike[str],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        descriptor = real_open(path, flags, mode, dir_fd=dir_fd)
        if dir_fd is None and Path(path).name == ".catalog-publish.lock":
            lock_fds.add(descriptor)
        return descriptor

    def fail_lock_fstat(descriptor: int) -> os.stat_result:
        if descriptor in lock_fds:
            raise OSError(errno.EIO, "injected lock fstat failure")
        return real_fstat(descriptor)

    try:
        with monkeypatch.context() as patch:
            patch.setattr(fixture_publisher_module.os, "open", track_lock_open)
            patch.setattr(fixture_publisher_module.os, "fstat", fail_lock_fstat)
            with pytest.raises(CatalogPublishError, match="CATALOG_LOCK_INVALID"):
                service.publish("local-qa-v1")
    finally:
        store.close()


@pytest.mark.parametrize(
    ("case", "error_code"),
    [
        ("overlap", "EVALUATION_WINDOW_OVERLAP"),
        ("order", "EVALUATION_WINDOW_ORDER"),
        ("range", "EVALUATION_WINDOW_RANGE"),
        ("purge", "EVALUATION_PURGE"),
        ("embargo", "EVALUATION_EMBARGO"),
    ],
)
def test_fully_signed_publish_rejects_invalid_evaluation_protocols(
    tmp_path: Path, case: str, error_code: str
) -> None:
    root = copied_fixture(tmp_path)
    manifest_path = root / "local-qa-v1" / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    base = 1_700_000_000_000_000_000
    manifest["quote_shards"][0]["end_ns"] = str(base + 100)
    windows: dict[str, object] = {
        "schema": "EvaluationProtocol.v1",
        "mode": "explicit",
        "train": _window(base, 0, 20),
        "tune": _window(base, 25, 40),
        "out_of_sample": _window(base, 45, 60),
        "purge_ns": "0",
        "embargo_ns": "0",
    }
    if case == "overlap":
        windows["train"] = _window(base, 0, 30)
        windows["tune"] = _window(base, 20, 40)
    elif case == "order":
        windows["train"] = _window(base, 40, 50)
        windows["tune"] = _window(base, 10, 20)
        windows["out_of_sample"] = _window(base, 60, 70)
    elif case == "range":
        windows["train"] = {"start_ns": str(base - 1), "end_ns": str(base + 20)}
    elif case == "purge":
        windows["purge_ns"] = "6"
    else:
        windows["embargo_ns"] = "6"
    manifest["evaluation_protocol"] = windows
    write_json(manifest_path, manifest)
    resign(root)
    service, store = publisher_for_root(tmp_path, root)
    try:
        with pytest.raises(FixtureInvalid, match=error_code):
            service.publish("local-qa-v1")
    finally:
        store.close()


def test_fully_signed_publish_rejects_instrument_event_after_availability(
    tmp_path: Path,
) -> None:
    root = copied_fixture(tmp_path)
    instrument_path = root / "local-qa-v1" / "instrument.json"
    instrument = json.loads(instrument_path.read_bytes())
    instrument["ts_event_ns"] = str(int(instrument["ts_available_ns"]) + 1)
    write_json(instrument_path, instrument)
    resign(root)
    service, store = publisher_for_root(tmp_path, root)
    try:
        with pytest.raises(
            FixtureInvalid, match="INSTRUMENT_EVENT_AFTER_AVAILABILITY"
        ):
            service.publish("local-qa-v1")
    finally:
        store.close()


def test_fully_signed_publish_maps_large_fixed_price_to_stable_fixture_error(
    tmp_path: Path,
) -> None:
    root = copied_fixture(tmp_path)
    quote_path = root / "local-qa-v1" / "quotes.jsonl"
    records = [json.loads(line) for line in quote_path.read_text().splitlines()]
    huge_price = ("9" * 5_000) + ".00"
    records[0]["bid_price"] = huge_price
    records[0]["ask_price"] = huge_price
    records[0]["record_hash"] = record_hash(records[0])
    write_jsonl(quote_path, records)
    resign(root)
    service, store = publisher_for_root(tmp_path, root)
    try:
        with pytest.raises(FixtureInvalid, match="QUOTE_PRICE_INVALID"):
            service.publish("local-qa-v1")
    finally:
        store.close()


def test_fully_signed_publish_rejects_precision_unsupported_by_pinned_rc3(
    tmp_path: Path,
) -> None:
    root = copied_fixture(tmp_path)
    instrument_path = root / "local-qa-v1" / "instrument.json"
    instrument = json.loads(instrument_path.read_bytes())
    instrument["price_precision"] = 17
    instrument["price_increment"] = "0.00000000000000001"
    write_json(instrument_path, instrument)
    quote_path = root / "local-qa-v1" / "quotes.jsonl"
    records = [json.loads(line) for line in quote_path.read_text().splitlines()]
    for record in records:
        record["bid_price"] = "99.00000000000000000"
        record["ask_price"] = "100.00000000000000000"
        record["record_hash"] = record_hash(record)
    write_jsonl(quote_path, records)
    resign(root)
    service, store = publisher_for_root(tmp_path, root)
    try:
        with pytest.raises(FixtureInvalid, match="PRICE_PRECISION_UNSUPPORTED"):
            service.publish("local-qa-v1")
    finally:
        store.close()


def test_service_owned_runtime_bootstrap_creates_database_and_catalog_siblings(
    tmp_path: Path,
) -> None:
    runtime = tmp_path / "trading"
    open_catalog_service = getattr(
        fixture_publisher_module, "open_catalog_service", None
    )
    assert open_catalog_service is not None

    service, store = open_catalog_service(
        fixture_root=REPOSITORY_ROOT / "data" / "fixtures",
        runtime_root=runtime,
        clock=lambda: 100,
    )
    try:
        publication = service.publish("local-qa-v1")
        assert stat_mode(runtime) == 0o700
        assert (runtime / "control.sqlite").is_file()
        assert (runtime / "catalogs" / publication.catalog_revision).is_dir()
        assert (runtime / "control.sqlite").parent == (runtime / "catalogs").parent
    finally:
        store.close()


@pytest.mark.parametrize("database_shape", ["directory", "corrupt"])
def test_service_owned_runtime_bootstrap_maps_invalid_control_storage(
    tmp_path: Path, database_shape: str
) -> None:
    runtime = tmp_path / "trading"
    runtime.mkdir(mode=0o700)
    database = runtime / "control.sqlite"
    if database_shape == "directory":
        database.mkdir(mode=0o700)
    else:
        database.write_bytes(b"not a sqlite database")

    with pytest.raises(CatalogStorageFailed, match="CATALOG_STORAGE_FAILED"):
        fixture_publisher_module.open_catalog_service(
            fixture_root=REPOSITORY_ROOT / "data" / "fixtures",
            runtime_root=runtime,
        )


def test_service_owned_runtime_bootstrap_does_not_map_arbitrary_runtime_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    failure = RuntimeError("injected unrelated runtime failure")

    def fail_open(*_args: object, **_kwargs: object) -> None:
        raise failure

    monkeypatch.setattr(fixture_publisher_module.ControlStore, "open", fail_open)

    with pytest.raises(RuntimeError) as caught:
        fixture_publisher_module.open_catalog_service(
            fixture_root=REPOSITORY_ROOT / "data" / "fixtures",
            runtime_root=tmp_path / "trading",
        )

    assert caught.value is failure


def test_service_owned_runtime_bootstrap_rejects_symlink_and_maps_oserror(
    tmp_path: Path,
) -> None:
    open_catalog_service = getattr(
        fixture_publisher_module, "open_catalog_service", None
    )
    assert open_catalog_service is not None
    target = tmp_path / "target"
    target.mkdir(mode=0o700)
    symlink = tmp_path / "runtime-link"
    symlink.symlink_to(target, target_is_directory=True)
    with pytest.raises(CatalogPublishError, match="CATALOG_RUNTIME_INVALID"):
        open_catalog_service(
            fixture_root=REPOSITORY_ROOT / "data" / "fixtures",
            runtime_root=symlink,
        )
    assert not (target / "control.sqlite").exists()

    blocker = tmp_path / "blocker"
    blocker.write_bytes(b"not a directory")
    with pytest.raises(CatalogPublishError, match="CATALOG_RUNTIME_INVALID"):
        open_catalog_service(
            fixture_root=REPOSITORY_ROOT / "data" / "fixtures",
            runtime_root=blocker / "trading",
        )


def test_service_owned_runtime_bootstrap_closes_store_if_construction_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class OpenedControl:
        closed = False

        def close(self) -> None:
            self.closed = True

    opened = OpenedControl()

    def fail_registry(_fixture_root: Path) -> None:
        raise RuntimeError("injected post-open construction failure")

    monkeypatch.setattr(
        fixture_publisher_module.ControlStore,
        "open",
        lambda *_args, **_kwargs: opened,
    )
    monkeypatch.setattr(fixture_publisher_module, "FixtureRegistry", fail_registry)

    with pytest.raises(RuntimeError, match="post-open construction failure"):
        fixture_publisher_module.open_catalog_service(
            fixture_root=REPOSITORY_ROOT / "data" / "fixtures",
            runtime_root=tmp_path / "trading",
        )

    assert opened.closed is True


def test_service_owned_runtime_bootstrap_close_failure_preserves_primary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class OpenedControl:
        def close(self) -> None:
            raise RuntimeError("injected control close failure")

    primary = RuntimeError("injected post-open construction failure")

    def fail_registry(_fixture_root: Path) -> None:
        raise primary

    monkeypatch.setattr(
        fixture_publisher_module.ControlStore,
        "open",
        lambda *_args, **_kwargs: OpenedControl(),
    )
    monkeypatch.setattr(fixture_publisher_module, "FixtureRegistry", fail_registry)

    with pytest.raises(RuntimeError) as caught:
        fixture_publisher_module.open_catalog_service(
            fixture_root=REPOSITORY_ROOT / "data" / "fixtures",
            runtime_root=tmp_path / "trading",
        )

    assert caught.value is primary
    assert any(
        "CATALOG_STORAGE_FAILED" in note
        for note in getattr(caught.value, "__notes__", ())
    )


@pytest.mark.parametrize("secondary_type", [SystemExit, KeyboardInterrupt])
def test_round3_control_flow_close_secondary_preserves_primary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    secondary_type: type[BaseException],
) -> None:
    primary = RuntimeError("injected post-open construction failure")
    secondary = secondary_type("injected control-flow close failure")

    class OpenedControl:
        def close(self) -> None:
            raise secondary

    def fail_registry(_fixture_root: Path) -> None:
        raise primary

    monkeypatch.setattr(
        fixture_publisher_module.ControlStore,
        "open",
        lambda *_args, **_kwargs: OpenedControl(),
    )
    monkeypatch.setattr(fixture_publisher_module, "FixtureRegistry", fail_registry)

    with pytest.raises(BaseException) as caught:
        fixture_publisher_module.open_catalog_service(
            fixture_root=REPOSITORY_ROOT / "data" / "fixtures",
            runtime_root=tmp_path / "trading",
        )

    assert caught.value is primary
    assert tuple(getattr(primary, "__notes__", ())) == (
        "Secondary cleanup failure: CATALOG_STORAGE_FAILED",
    )


@pytest.mark.parametrize("secondary_type", [SystemExit, KeyboardInterrupt])
def test_round3_close_without_primary_propagates_control_flow(
    secondary_type: type[BaseException],
) -> None:
    secondary = secondary_type("injected control-flow close failure")

    class OpenedControl:
        def close(self) -> None:
            raise secondary

    with pytest.raises(BaseException) as caught:
        fixture_publisher_module._close_control_store(
            cast(ControlStore, OpenedControl()), primary=None
        )

    assert caught.value is secondary


def test_round3_close_without_primary_maps_ordinary_exception() -> None:
    class OpenedControl:
        def close(self) -> None:
            raise RuntimeError("injected ordinary close failure")

    with pytest.raises(CatalogStorageFailed, match="CATALOG_STORAGE_FAILED"):
        fixture_publisher_module._close_control_store(
            cast(ControlStore, OpenedControl()), primary=None
        )


def publisher_for_root(
    tmp_path: Path, fixture_root: Path
) -> tuple[FixturePublisher, ControlStore]:
    store = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: 100)
    return (
        FixturePublisher(
            registry=FixtureRegistry(fixture_root),
            control=store,
            runtime_root=tmp_path / "trading",
        ),
        store,
    )


def copied_fixture(tmp_path: Path) -> Path:
    root = tmp_path / "fixtures"
    shutil.copytree(REPOSITORY_ROOT / "data" / "fixtures", root)
    return root


def _window(base: int, start: int, end: int) -> dict[str, str]:
    return {"start_ns": str(base + start), "end_ns": str(base + end)}


def write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        + "\n",
        encoding="utf-8",
    )


def write_jsonl(path: Path, values: list[dict[str, object]]) -> None:
    path.write_text(
        "".join(
            json.dumps(
                value,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            )
            + "\n"
            for value in values
        ),
        encoding="utf-8",
    )


def record_hash(record: dict[str, object]) -> str:
    unhashed = {key: value for key, value in record.items() if key != "record_hash"}
    return sha256(canonical_json_bytes(unhashed)).hexdigest()


def resign(root: Path) -> None:
    fixture = root / "local-qa-v1"
    manifest_path = fixture / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    instrument_path = fixture / manifest["instrument"]["relative_path"]
    manifest["instrument"]["sha256"] = sha256(instrument_path.read_bytes()).hexdigest()
    for shard in manifest["quote_shards"]:
        shard_path = fixture / shard["relative_path"]
        shard["sha256"] = sha256(shard_path.read_bytes()).hexdigest()
    write_json(manifest_path, manifest)
    source_paths = ["instrument.json", "manifest.json", "quotes.jsonl"]
    sums = "".join(
        f"{sha256((fixture / path).read_bytes()).hexdigest()}  {path}\n"
        for path in source_paths
    )
    (fixture / "SHA256SUMS").write_text(sums, encoding="ascii")
    registry_document = json.loads((root / "registry.json").read_bytes())
    registry_document["fixtures"]["local-qa-v1"]["manifest_sha256"] = sha256(
        manifest_path.read_bytes()
    ).hexdigest()
    write_json(root / "registry.json", registry_document)


def stat_mode(path: Path) -> int:
    return path.stat(follow_symlinks=False).st_mode & 0o777
