from __future__ import annotations

import errno
import os
import shutil
from hashlib import sha256
from pathlib import Path

import pytest

import stark_trading_os.catalog.fixture_publisher as fixture_publisher_module
from stark_trading_os.audit.canonical_json import canonical_json_bytes, parse_json_object
from stark_trading_os.catalog.fixture_publisher import CatalogPublishError, FixturePublisher
from stark_trading_os.catalog.fixture_registry import FixtureRegistry
from stark_trading_os.control.registry import (
    CatalogConflict,
    CatalogIntegrityFailed,
    CatalogRecoveryBlocked,
    ControlStore,
)

REPOSITORY_ROOT = Path(__file__).parents[5]


class SimulatedProcessDeath(BaseException):
    pass


class CrashPublisher(FixturePublisher):
    def __init__(
        self,
        *,
        crash_point: str,
        registry: FixtureRegistry,
        control: ControlStore,
        runtime_root: Path,
    ) -> None:
        super().__init__(registry=registry, control=control, runtime_root=runtime_root)
        self._crash_point = crash_point

    def _checkpoint(self, point: str) -> None:
        if point == self._crash_point:
            raise SimulatedProcessDeath(point)


def make_publisher(
    tmp_path: Path, store: ControlStore, *, crash_point: str | None = None
) -> FixturePublisher:
    arguments = {
        "registry": FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
        "control": store,
        "runtime_root": tmp_path / "trading",
    }
    if crash_point is not None:
        return CrashPublisher(crash_point=crash_point, **arguments)
    return FixturePublisher(**arguments)


def current_build_trees(tmp_path: Path) -> tuple[Path, ...]:
    staging = tmp_path / "trading" / "catalog-staging"
    if not staging.is_dir():
        return ()
    return tuple(sorted(staging.glob("build-*")))


def test_round3_stale_no_row_prepared_eio_retries_cleanup_current_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        with pytest.raises(SimulatedProcessDeath, match="after_staging"):
            make_publisher(tmp_path, store, crash_point="after_staging").publish(
                "local-qa-v1"
            )
        staging = tmp_path / "trading" / "catalog-staging"
        prepared = next(staging.glob("prepared-*"))
        prepared_snapshot = {
            path.relative_to(prepared).as_posix(): (
                path.is_dir(),
                path.stat().st_mode & 0o777,
                b"" if path.is_dir() else path.read_bytes(),
            )
            for path in (prepared, *sorted(prepared.rglob("*")))
        }
        real_scandir = os.scandir

        def fail_prepared_scandir(
            path: int | str | bytes | os.PathLike[str],
        ) -> os.ScandirIterator[str]:
            if path == prepared:
                raise OSError(errno.EIO, "injected prepared verification failure")
            return real_scandir(path)

        with monkeypatch.context() as patch:
            patch.setattr(
                fixture_publisher_module.os, "scandir", fail_prepared_scandir
            )
            for _ in range(3):
                with pytest.raises(
                    CatalogPublishError, match="CATALOG_FILESYSTEM_FAILED"
                ):
                    make_publisher(tmp_path, store).publish("local-qa-v1")

        assert prepared.is_dir()
        assert {
            path.relative_to(prepared).as_posix(): (
                path.is_dir(),
                path.stat().st_mode & 0o777,
                b"" if path.is_dir() else path.read_bytes(),
            )
            for path in (prepared, *sorted(prepared.rglob("*")))
        } == prepared_snapshot
        assert current_build_trees(tmp_path) == ()
        assert store.recoverable_catalog_publications() == ()
    finally:
        store.close()


def test_round3_target_conflict_cleans_current_build_and_retains_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        with pytest.raises(SimulatedProcessDeath, match="after_staging"):
            make_publisher(tmp_path, store, crash_point="after_staging").publish(
                "local-qa-v1"
            )
        staging = tmp_path / "trading" / "catalog-staging"
        prepared = next(staging.glob("prepared-*"))
        real_lexists = fixture_publisher_module._lexists
        prepared_checks = 0

        def inject_late_target_conflict(path: Path) -> bool:
            nonlocal prepared_checks
            if path == prepared:
                prepared_checks += 1
                if prepared_checks == 2:
                    prepared.mkdir(mode=0o700)
                    return True
            return real_lexists(path)

        with monkeypatch.context() as patch:
            patch.setattr(
                fixture_publisher_module, "_lexists", inject_late_target_conflict
            )
            with pytest.raises(CatalogConflict, match="CATALOG_CONFLICT"):
                make_publisher(tmp_path, store).publish("local-qa-v1")

        assert prepared.is_dir()
        assert current_build_trees(tmp_path) == ()
        assert store.recoverable_catalog_publications() == ()
    finally:
        store.close()


def test_round3_existing_catalog_target_conflict_cleans_current_build(
    tmp_path: Path,
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        with pytest.raises(SimulatedProcessDeath, match="after_staging"):
            make_publisher(tmp_path, store, crash_point="after_staging").publish(
                "local-qa-v1"
            )
        staging = tmp_path / "trading" / "catalog-staging"
        prepared = next(staging.glob("prepared-*"))
        revision = prepared.name.removeprefix("prepared-")
        target = tmp_path / "trading" / "catalogs" / revision
        os.rename(prepared, target)

        with pytest.raises(CatalogConflict, match="CATALOG_CONFLICT"):
            make_publisher(tmp_path, store).publish("local-qa-v1")

        assert target.is_dir()
        assert current_build_trees(tmp_path) == ()
        assert store.recoverable_catalog_publications() == ()
    finally:
        store.close()


@pytest.mark.parametrize(
    "crash_point",
    ["after_staging", "after_prepare", "after_rename", "after_readonly", "after_db_publish"],
)
def test_crash_points_recover_to_honest_single_publication(
    tmp_path: Path, crash_point: str
) -> None:
    database = tmp_path / "control.sqlite"
    first = ControlStore.open(database, clock=lambda: 100)
    try:
        with pytest.raises(SimulatedProcessDeath, match=crash_point):
            make_publisher(tmp_path, first, crash_point=crash_point).publish("local-qa-v1")
    finally:
        first.close()

    second = ControlStore.open(database, clock=lambda: 200)
    try:
        recovered = make_publisher(tmp_path, second).recover()
        if crash_point == "after_staging":
            assert recovered == ()
            published = make_publisher(tmp_path, second).publish("local-qa-v1")
        else:
            assert len(recovered) == 1
            published = recovered[0]
        assert published.status == "PUBLISHED"
        assert second.catalog_publication(published.catalog_revision) == published
    finally:
        second.close()


def test_process_global_and_file_locks_release_after_base_exception(tmp_path: Path) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        with pytest.raises(SimulatedProcessDeath):
            make_publisher(tmp_path, store, crash_point="after_staging").publish("local-qa-v1")
        assert make_publisher(tmp_path, store).publish("local-qa-v1").status == "PUBLISHED"
    finally:
        store.close()


def test_crashed_staging_tree_and_service_runtime_have_exact_private_modes(
    tmp_path: Path,
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    runtime = tmp_path / "trading"
    try:
        with pytest.raises(SimulatedProcessDeath, match="after_staging"):
            make_publisher(tmp_path, store, crash_point="after_staging").publish(
                "local-qa-v1"
            )
        assert _mode(runtime) == 0o700
        assert _mode(runtime / "catalog-staging") == 0o700
        assert _mode(runtime / "catalogs") == 0o700
        assert _mode(runtime / ".catalog-publish.lock") == 0o600
        staged = tuple((runtime / "catalog-staging").iterdir())
        assert len(staged) == 1
        staged_entries = (staged[0], *staged[0].rglob("*"))
        assert all(
            _mode(path) == 0o700 for path in staged_entries if path.is_dir()
        )
        assert all(
            _mode(path) == 0o600 for path in staged[0].rglob("*") if path.is_file()
        )
    finally:
        store.close()


def test_prepared_with_both_stage_and_target_remains_prepared_and_blocked(tmp_path: Path) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        with pytest.raises(SimulatedProcessDeath):
            make_publisher(tmp_path, store, crash_point="after_prepare").publish("local-qa-v1")
        publication = store.recoverable_catalog_publications()[0]
        stage = tmp_path / "trading" / "catalog-staging" / publication.staging_identity
        target = tmp_path / "trading" / "catalogs" / publication.catalog_revision
        shutil.copytree(stage, target)

        with pytest.raises(CatalogRecoveryBlocked, match="CATALOG_RECOVERY_BLOCKED"):
            make_publisher(tmp_path, store).recover()
        retained = store.catalog_publication(publication.catalog_revision)
        assert retained is not None and retained.status == "PREPARED"
    finally:
        store.close()


def _mode(path: Path) -> int:
    return path.stat(follow_symlinks=False).st_mode & 0o777


def test_published_with_extra_staging_is_kept_published_and_blocked(tmp_path: Path) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        service = make_publisher(tmp_path, store)
        publication = service.publish("local-qa-v1")
        target = tmp_path / "trading" / "catalogs" / publication.catalog_revision
        stage = tmp_path / "trading" / "catalog-staging" / publication.staging_identity
        shutil.copytree(target, stage)

        with pytest.raises(CatalogRecoveryBlocked, match="CATALOG_RECOVERY_BLOCKED"):
            service.recover()
        assert store.catalog_publication(publication.catalog_revision) == publication
        assert stage.exists()
    finally:
        store.close()


def test_no_row_target_is_conflict_and_is_never_adopted_or_deleted(tmp_path: Path) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    service = make_publisher(tmp_path, store)
    runtime = tmp_path / "trading"
    runtime.mkdir(mode=0o700)
    (runtime / "catalog-staging").mkdir(mode=0o700)
    catalogs = runtime / "catalogs"
    catalogs.mkdir(mode=0o700)
    unknown = catalogs / ("a" * 64)
    unknown.mkdir(mode=0o500)
    try:
        with pytest.raises(CatalogConflict, match="CATALOG_CONFLICT"):
            service.recover()
        assert unknown.exists()
    finally:
        store.close()


def test_extra_empty_directory_and_permission_mutation_fail_closed(tmp_path: Path) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        service = make_publisher(tmp_path, store)
        publication = service.publish("local-qa-v1")
        target = tmp_path / "trading" / "catalogs" / publication.catalog_revision
        os.chmod(target, 0o700)
        extra = target / "empty"
        extra.mkdir(mode=0o500)
        os.chmod(target, 0o500)

        with pytest.raises(CatalogIntegrityFailed, match="CATALOG_INTEGRITY_FAILED"):
            service.revalidate(publication.catalog_revision)
        failed = store.catalog_publication(publication.catalog_revision)
        assert failed is not None and failed.status == "INTEGRITY_FAILED"
    finally:
        store.close()


def test_failed_publication_target_is_retained_without_becoming_unknown_conflict(
    tmp_path: Path,
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        service = make_publisher(tmp_path, store)
        publication = service.publish("local-qa-v1")
        target = tmp_path / "trading" / "catalogs" / publication.catalog_revision
        os.chmod(target, 0o700)
        (target / "attack").write_bytes(b"x")
        os.chmod(target / "attack", 0o400)
        os.chmod(target, 0o500)
        with pytest.raises(CatalogIntegrityFailed):
            service.revalidate(publication.catalog_revision)

        assert service.recover() == ()
        assert target.exists()
    finally:
        store.close()


def test_recovery_inspects_later_published_corruption_after_earlier_blocked_prepare(
    tmp_path: Path,
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        service = make_publisher(tmp_path, store)
        published = service.publish("local-qa-v1")
        blocked_identity = _publication_variant_before(published)
        blocked = store.prepare_catalog_publication(
            catalog_revision=blocked_identity[0],
            fixture_id=blocked_identity[1],
            inventory_hash=blocked_identity[2],
            publication_bytes=blocked_identity[3],
            staging_identity=f"prepared-{blocked_identity[0]}",
        )
        assert blocked.catalog_revision < published.catalog_revision
        target = tmp_path / "trading" / "catalogs" / published.catalog_revision
        os.chmod(target, 0o700)
        corruption = target / "late-corruption"
        corruption.write_bytes(b"attack")
        os.chmod(corruption, 0o400)
        os.chmod(target, 0o500)

        with pytest.raises(CatalogIntegrityFailed, match="CATALOG_INTEGRITY_FAILED"):
            service.recover()

        retained_blocked = store.catalog_publication(blocked.catalog_revision)
        retained_published = store.catalog_publication(published.catalog_revision)
        assert retained_blocked is not None and retained_blocked.status == "PREPARED"
        assert retained_published is not None
        assert retained_published.status == "INTEGRITY_FAILED"
    finally:
        store.close()


@pytest.mark.parametrize(
    "failure",
    ["scandir-emfile", "scandir-eio", "native-reader"],
)
def test_operational_failure_keeps_published_and_does_not_starve_later_corruption(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        service = make_publisher(tmp_path, store)
        later = service.publish("local-qa-v1")
        earlier, earlier_target = _materialize_published_variant_before(
            store=store,
            tmp_path=tmp_path,
            publication=later,
        )
        assert earlier.catalog_revision < later.catalog_revision

        later_target = tmp_path / "trading" / "catalogs" / later.catalog_revision
        os.chmod(later_target, 0o700)
        corruption = later_target / "late-corruption"
        corruption.write_bytes(b"attack")
        os.chmod(corruption, 0o400)
        os.chmod(later_target, 0o500)

        with monkeypatch.context() as patch:
            if failure.startswith("scandir"):
                real_scandir = os.scandir
                error_number = errno.EMFILE if failure.endswith("emfile") else errno.EIO

                def fail_first_target(
                    path: str | os.PathLike[str],
                ) -> os.ScandirIterator[str]:
                    if Path(path) == earlier_target:
                        raise OSError(
                            error_number, "injected operational scandir failure"
                        )
                    return real_scandir(path)

                patch.setattr(
                    fixture_publisher_module.os, "scandir", fail_first_target
                )
            else:
                real_list_data_types = (
                    fixture_publisher_module.ParquetDataCatalog.list_data_types
                )
                calls = 0

                def fail_first_native_reader(reader: object) -> list[str]:
                    nonlocal calls
                    calls += 1
                    if calls == 1:
                        raise RuntimeError("injected native reader failure")
                    return real_list_data_types(reader)

                patch.setattr(
                    fixture_publisher_module.ParquetDataCatalog,
                    "list_data_types",
                    fail_first_native_reader,
                )

            with pytest.raises(CatalogIntegrityFailed, match="CATALOG_INTEGRITY_FAILED"):
                service.recover()

        retained_earlier = store.catalog_publication(earlier.catalog_revision)
        retained_later = store.catalog_publication(later.catalog_revision)
        assert retained_earlier is not None and retained_earlier.status == "PUBLISHED"
        assert retained_later is not None and retained_later.status == "INTEGRITY_FAILED"
    finally:
        store.close()


def test_lock_close_failure_preserves_base_exception(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
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
        with monkeypatch.context() as patch:
            patch.setattr(fixture_publisher_module.os, "open", track_lock_open)
            patch.setattr(fixture_publisher_module.os, "close", fail_lock_close)
            with pytest.raises(SimulatedProcessDeath) as caught:
                make_publisher(
                    tmp_path, store, crash_point="after_staging"
                ).publish("local-qa-v1")
        assert any(
            "CATALOG_LOCK_INVALID" in note
            for note in getattr(caught.value, "__notes__", ())
        )
    finally:
        for descriptor in lock_fds:
            real_close(descriptor)
        store.close()


def test_prepared_mixed_private_and_immutable_modes_finish_idempotently(
    tmp_path: Path,
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        with pytest.raises(SimulatedProcessDeath, match="after_rename"):
            make_publisher(tmp_path, store, crash_point="after_rename").publish(
                "local-qa-v1"
            )
        prepared = store.recoverable_catalog_publications()[0]
        target = tmp_path / "trading" / "catalogs" / prepared.catalog_revision
        first_file = next(path for path in target.rglob("*") if path.is_file())
        os.chmod(first_file, 0o400)
        os.chmod(target, 0o500)

        recovered = make_publisher(tmp_path, store).recover()

        assert len(recovered) == 1 and recovered[0].status == "PUBLISHED"
        assert _mode(target) == 0o500
        assert all(_mode(path) == 0o500 for path in target.rglob("*") if path.is_dir())
        assert all(_mode(path) == 0o400 for path in target.rglob("*") if path.is_file())
        assert make_publisher(tmp_path, store).recover() == recovered
    finally:
        store.close()


def test_prepared_mixed_modes_still_require_exact_bytes_before_chmod(
    tmp_path: Path,
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        with pytest.raises(SimulatedProcessDeath, match="after_rename"):
            make_publisher(tmp_path, store, crash_point="after_rename").publish(
                "local-qa-v1"
            )
        prepared = store.recoverable_catalog_publications()[0]
        target = tmp_path / "trading" / "catalogs" / prepared.catalog_revision
        payload = next(path for path in target.rglob("*.parquet") if path.is_file())
        payload.write_bytes(payload.read_bytes() + b"attack")
        os.chmod(payload, 0o400)
        os.chmod(target, 0o500)

        with pytest.raises(CatalogRecoveryBlocked, match="CATALOG_RECOVERY_BLOCKED"):
            make_publisher(tmp_path, store).recover()
        retained = store.catalog_publication(prepared.catalog_revision)
        assert retained is not None and retained.status == "PREPARED"
    finally:
        store.close()


def test_publish_rename_enospc_is_stable_and_cleans_only_unreferenced_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        service = make_publisher(tmp_path, store)

        def fail_rename(_source: object, _target: object) -> None:
            raise OSError(errno.ENOSPC, "injected full disk")

        monkeypatch.setattr(fixture_publisher_module.os, "rename", fail_rename)
        with pytest.raises(CatalogPublishError, match="CATALOG_FILESYSTEM_FAILED"):
            service.publish("local-qa-v1")

        assert store.recoverable_catalog_publications() == ()
        staging = tmp_path / "trading" / "catalog-staging"
        assert not any(path.name.startswith("build-") for path in staging.iterdir())
    finally:
        store.close()


def test_recovery_rename_enospc_is_stable_and_preserves_prepared_stage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        with pytest.raises(SimulatedProcessDeath, match="after_prepare"):
            make_publisher(tmp_path, store, crash_point="after_prepare").publish(
                "local-qa-v1"
            )
        prepared = store.recoverable_catalog_publications()[0]
        stage = tmp_path / "trading" / "catalog-staging" / prepared.staging_identity

        def fail_rename(_source: object, _target: object) -> None:
            raise OSError(errno.ENOSPC, "injected full disk")

        with monkeypatch.context() as patch:
            patch.setattr(fixture_publisher_module.os, "rename", fail_rename)
            with pytest.raises(CatalogPublishError, match="CATALOG_FILESYSTEM_FAILED"):
                make_publisher(tmp_path, store).recover()
        assert stage.exists()
        retained = store.catalog_publication(prepared.catalog_revision)
        assert retained is not None and retained.status == "PREPARED"
        assert make_publisher(tmp_path, store).recover()[0].status == "PUBLISHED"
    finally:
        store.close()


def test_recovery_fsync_failure_is_stable_and_keeps_renamed_prepared_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        with pytest.raises(SimulatedProcessDeath, match="after_prepare"):
            make_publisher(tmp_path, store, crash_point="after_prepare").publish(
                "local-qa-v1"
            )
        prepared = store.recoverable_catalog_publications()[0]
        target = tmp_path / "trading" / "catalogs" / prepared.catalog_revision

        def fail_fsync(_descriptor: int) -> None:
            raise OSError(errno.ENOSPC, "injected full disk")

        with monkeypatch.context() as patch:
            patch.setattr(fixture_publisher_module.os, "fsync", fail_fsync)
            with pytest.raises(CatalogPublishError, match="CATALOG_FILESYSTEM_FAILED"):
                make_publisher(tmp_path, store).recover()
        assert target.exists()
        retained = store.catalog_publication(prepared.catalog_revision)
        assert retained is not None and retained.status == "PREPARED"
        assert make_publisher(tmp_path, store).recover()[0].status == "PUBLISHED"
    finally:
        store.close()


def test_recovery_chmod_failure_is_stable_and_keeps_prepared_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        with pytest.raises(SimulatedProcessDeath, match="after_rename"):
            make_publisher(tmp_path, store, crash_point="after_rename").publish(
                "local-qa-v1"
            )
        prepared = store.recoverable_catalog_publications()[0]
        target = tmp_path / "trading" / "catalogs" / prepared.catalog_revision

        def fail_chmod(*_args: object, **_kwargs: object) -> None:
            raise OSError(errno.EACCES, "injected permission failure")

        with monkeypatch.context() as patch:
            patch.setattr(fixture_publisher_module.os, "chmod", fail_chmod)
            with pytest.raises(CatalogPublishError, match="CATALOG_FILESYSTEM_FAILED"):
                make_publisher(tmp_path, store).recover()
        assert target.exists()
        retained = store.catalog_publication(prepared.catalog_revision)
        assert retained is not None and retained.status == "PREPARED"
        assert make_publisher(tmp_path, store).recover()[0].status == "PUBLISHED"
    finally:
        store.close()


def _publication_variant_before(
    publication: object,
) -> tuple[str, str, str, bytes]:
    assert hasattr(publication, "publication_bytes")
    assert hasattr(publication, "catalog_revision")
    original_revision = publication.catalog_revision
    for index in range(10_000):
        fixture_id = f"blocked-{index}"
        manifest = parse_json_object(publication.publication_bytes)
        inventory = manifest["inventory"]
        assert isinstance(inventory, dict)
        manifest["fixture_id"] = fixture_id
        inventory["fixture_id"] = fixture_id
        inventory_hash = sha256(canonical_json_bytes(inventory)).hexdigest()
        manifest["inventory_hash"] = inventory_hash
        publication_bytes = canonical_json_bytes(manifest)
        revision = sha256(publication_bytes).hexdigest()
        if revision < original_revision:
            return revision, fixture_id, inventory_hash, publication_bytes
    raise AssertionError("failed to derive a lower deterministic catalog revision")


def _materialize_published_variant_before(
    *,
    store: ControlStore,
    tmp_path: Path,
    publication: object,
) -> tuple[object, Path]:
    revision, fixture_id, inventory_hash, publication_bytes = (
        _publication_variant_before(publication)
    )
    assert hasattr(publication, "catalog_revision")
    source = tmp_path / "trading" / "catalogs" / publication.catalog_revision
    target = tmp_path / "trading" / "catalogs" / revision
    shutil.copytree(source, target)
    _make_tree_private(target)
    (target / "catalog-manifest.json").write_bytes(publication_bytes)
    _make_tree_immutable(target)
    prepared = store.prepare_catalog_publication(
        catalog_revision=revision,
        fixture_id=fixture_id,
        inventory_hash=inventory_hash,
        publication_bytes=publication_bytes,
        staging_identity=f"prepared-{revision}",
    )
    manifest = parse_json_object(publication_bytes)
    audit = {
        "schema": "CatalogValidatedAudit.v1",
        "action": "catalog.validated",
        "fixture_id": fixture_id,
        "catalog_revision": revision,
        "inventory_hash": inventory_hash,
        "source_checksum": manifest["source_checksum"],
        "catalog_checksum": manifest["catalog_checksum"],
    }
    published = store.publish_catalog_publication(
        catalog_revision=revision,
        fixture_id=fixture_id,
        inventory_hash=inventory_hash,
        publication_bytes=publication_bytes,
        staging_identity=prepared.staging_identity,
        audit_intent_bytes=canonical_json_bytes(audit),
    )
    return published, target


def _make_tree_private(root: Path) -> None:
    directories: list[Path] = []
    for current_root, _, file_names in os.walk(root):
        current = Path(current_root)
        directories.append(current)
        os.chmod(current, 0o700)
        for name in file_names:
            os.chmod(current / name, 0o600)


def _make_tree_immutable(root: Path) -> None:
    directories: list[Path] = []
    for current_root, _, file_names in os.walk(root):
        current = Path(current_root)
        directories.append(current)
        for name in file_names:
            os.chmod(current / name, 0o400)
    for directory in reversed(directories):
        os.chmod(directory, 0o500)
