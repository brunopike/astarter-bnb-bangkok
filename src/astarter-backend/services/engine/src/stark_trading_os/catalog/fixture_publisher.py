"""Crash-consistent publication of one immutable native Nautilus QA catalog."""

from __future__ import annotations

import fcntl
import importlib.metadata
import os
import platform
import re
import shutil
import sqlite3
import stat
import threading
import time
import uuid
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from decimal import Decimal
from hashlib import sha256
from pathlib import Path, PurePosixPath
from typing import Protocol

import nautilus_trader._libnautilus as _libnautilus
from nautilus_trader.model import (
    Currency,
    CurrencyPair,
    InstrumentId,
    Price,
    Quantity,
    QuoteTick,
    Symbol,
    Venue,
)
from nautilus_trader.persistence import ParquetDataCatalog
from pydantic import ValidationError

from stark_trading_os.audit.canonical_json import canonical_json_bytes, parse_json_object
from stark_trading_os.catalog.fixture_registry import (
    FixtureRegistry,
    FixtureSource,
    FixtureUnknown,
)
from stark_trading_os.catalog.historical_catalog import (
    CatalogFileSetV2,
    CatalogInventoryV2,
    CatalogManifestV2,
    CatalogValidatedAuditV2,
    CatalogWindowV2,
    HistoricalCatalogInvalid,
    build_historical_native,
    canonical_historical_bytes,
    catalog_schema_from_bytes,
    parse_historical_manifest_bytes,
    readback_historical_native,
    source_sidecar_paths,
    validate_historical_source_object,
)
from stark_trading_os.catalog.historical_source import (
    HistoricalSource,
    HistoricalSourceInvalid,
    validate_historical_source,
)
from stark_trading_os.control.database import DatabaseConfigurationError
from stark_trading_os.control.registry import (
    CatalogConflict,
    CatalogIntegrityFailed,
    CatalogPublication,
    CatalogRecoveryBlocked,
    CatalogStorageFailed,
    Clock,
    ControlStore,
)
from stark_trading_os.domain.models import (
    CatalogFileSetV1,
    CatalogFileV1,
    CatalogInstrumentV1,
    CatalogInventoryV1,
    CatalogManifestV1,
    CatalogMappingV1,
    CatalogNativeFingerprintV1,
    CatalogReadbackV1,
    CatalogValidatedAuditV1,
)

_DIRECTORY_MODE = 0o700
_LOCK_MODE = 0o600
_PUBLISHED_DIRECTORY_MODE = 0o500
_PUBLISHED_FILE_MODE = 0o400
_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_BUILD_NAME = re.compile(r"^build-[0-9a-f]{32}$")
_PREPARED_NAME = re.compile(r"^prepared-([0-9a-f]{64})$")
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_PROCESS_LOCKS_GUARD = threading.Lock()
_PROCESS_LOCKS: dict[str, threading.Lock] = {}
type _CatalogManifest = CatalogManifestV1 | CatalogManifestV2


class CatalogPublishError(RuntimeError):
    """Stable catalog filesystem/native failure."""


class _CatalogIntegrityMismatch(CatalogPublishError):
    """Deterministic evidence that published catalog content is invalid."""


class _CatalogOperationalFailure(CatalogPublishError):
    """Transient or environmental failure that does not prove corruption."""


class CatalogPublicationAuthority(Protocol):
    def catalog_publication(self, catalog_revision: str) -> CatalogPublication | None: ...

    def recoverable_catalog_publications(self) -> tuple[CatalogPublication, ...]: ...

    def prepare_catalog_publication(
        self,
        *,
        catalog_revision: str,
        fixture_id: str,
        inventory_hash: str,
        publication_bytes: bytes,
        staging_identity: str,
    ) -> CatalogPublication: ...

    def publish_catalog_publication(
        self,
        *,
        catalog_revision: str,
        fixture_id: str,
        inventory_hash: str,
        publication_bytes: bytes,
        staging_identity: str,
        audit_intent_bytes: bytes,
    ) -> CatalogPublication: ...

    def mark_catalog_integrity_failed(
        self,
        *,
        catalog_revision: str,
        fixture_id: str,
        inventory_hash: str,
        publication_bytes: bytes,
        staging_identity: str,
    ) -> CatalogPublication: ...


@dataclass(frozen=True)
class _BuiltCatalog:
    build_path: Path
    catalog_revision: str
    inventory_hash: str
    publication_bytes: bytes


@dataclass
class _ServiceTreeOwnership:
    root: Path
    owned: bool = False

    def create(self) -> None:
        if _lexists(self.root):
            raise _CatalogOperationalFailure("CATALOG_FILESYSTEM_FAILED")
        self.owned = True
        try:
            os.mkdir(self.root, _DIRECTORY_MODE)
        except OSError as error:
            raise _filesystem_error(error) from error

    def transfer(self) -> None:
        self.owned = False


class FixturePublisher:
    """Publish registry fixtures and validated historical sources."""

    def __init__(
        self,
        *,
        registry: FixtureRegistry | None,
        control: CatalogPublicationAuthority,
        runtime_root: Path,
    ) -> None:
        self._registry = registry
        self._control = control
        self._runtime_root = runtime_root.absolute()
        self._staging_root = self._runtime_root / "catalog-staging"
        self._catalog_root = self._runtime_root / "catalogs"
        self._lock_path = self._runtime_root / ".catalog-publish.lock"

    def publish(self, fixture_id: str) -> CatalogPublication:
        with self._publication_lock():
            if self._registry is None:
                raise FixtureUnknown
            source = self._registry.load(fixture_id)
            with self._owned_build(
                lambda path: self._build(source, build_path=path)
            ) as (built, ownership):
                return self._publish_built_locked(
                    source_identity=source.fixture_id,
                    built=built,
                    ownership=ownership,
                )

    def publish_historical(self, source: HistoricalSource) -> CatalogPublication:
        """Publish one already-acquired source through the shared catalog lifecycle."""

        with self._publication_lock():
            try:
                trusted = validate_historical_source_object(source, now_ns=time.time_ns())
            except HistoricalCatalogInvalid as error:
                raise CatalogPublishError(error.code) from error
            with self._owned_build(
                lambda path: self._build_historical(trusted, build_path=path)
            ) as (built, ownership):
                return self._publish_built_locked(
                    source_identity=trusted.source_id,
                    built=built,
                    ownership=ownership,
                )

    @contextmanager
    def _owned_build(
        self,
        build: Callable[[Path], _BuiltCatalog],
    ) -> Iterator[tuple[_BuiltCatalog, _ServiceTreeOwnership]]:
        with _owned_build_tree(self._staging_root) as ownership:
            ownership.create()
            built = build(ownership.root)
            yield built, ownership

    def _publish_built_locked(
        self,
        *,
        source_identity: str,
        built: _BuiltCatalog,
        ownership: _ServiceTreeOwnership,
    ) -> CatalogPublication:
        prepared_path = self._staging_root / f"prepared-{built.catalog_revision}"
        target_path = self._catalog_root / built.catalog_revision
        existing = self._control.catalog_publication(built.catalog_revision)
        if existing is not None:
            _require_publication_matches(
                existing,
                built,
                fixture_id=source_identity,
            )
            return self._recover_one(existing)
        if _lexists(target_path):
            raise CatalogConflict
        if _lexists(prepared_path):
            try:
                self._verify_directory(
                    prepared_path,
                    publication_bytes=built.publication_bytes,
                    catalog_revision=built.catalog_revision,
                    require_immutable=False,
                )
            except _CatalogIntegrityMismatch:
                raise CatalogRecoveryBlocked from None
            _remove_service_tree(prepared_path)
        _rename_absent(built.build_path, prepared_path)
        ownership.transfer()
        _fsync_directory(self._staging_root)
        self._checkpoint("after_staging")
        prepared = self._control.prepare_catalog_publication(
            catalog_revision=built.catalog_revision,
            fixture_id=source_identity,
            inventory_hash=built.inventory_hash,
            publication_bytes=built.publication_bytes,
            staging_identity=prepared_path.name,
        )
        self._checkpoint("after_prepare")
        if _lexists(target_path):
            raise CatalogRecoveryBlocked
        _rename_absent(prepared_path, target_path)
        _fsync_directory(self._staging_root)
        _fsync_directory(self._catalog_root)
        self._checkpoint("after_rename")
        self._verify_directory(
            target_path,
            publication_bytes=built.publication_bytes,
            catalog_revision=built.catalog_revision,
            require_immutable=False,
        )
        _make_read_only(target_path)
        self._verify_directory(
            target_path,
            publication_bytes=built.publication_bytes,
            catalog_revision=built.catalog_revision,
            require_immutable=True,
        )
        self._checkpoint("after_readonly")
        published = self._publish_database(prepared)
        self._checkpoint("after_db_publish")
        return published

    def recover(self) -> tuple[CatalogPublication, ...]:
        with self._publication_lock():
            candidates = self._control.recoverable_catalog_publications()
            known_revisions = {publication.catalog_revision for publication in candidates}
            recovered: list[CatalogPublication] = []
            errors: list[Exception] = []
            for publication in candidates:
                try:
                    recovered.append(self._recover_one(publication))
                except (
                    CatalogConflict,
                    CatalogIntegrityFailed,
                    CatalogPublishError,
                    CatalogRecoveryBlocked,
                    CatalogStorageFailed,
                ) as error:
                    errors.append(error)
                except OSError as error:
                    errors.append(_filesystem_error(error))
            try:
                self._cleanup_orphan_staging(known_revisions)
            except (
                CatalogConflict,
                CatalogIntegrityFailed,
                CatalogPublishError,
                CatalogRecoveryBlocked,
                CatalogStorageFailed,
            ) as error:
                errors.append(error)
            except OSError as error:
                errors.append(_filesystem_error(error))
            try:
                with os.scandir(self._catalog_root) as entries:
                    catalog_entries = sorted(entries, key=lambda item: item.name)
            except OSError as error:
                errors.append(_filesystem_error(error))
                catalog_entries = []
            for entry in catalog_entries:
                if entry.name in known_revisions:
                    continue
                try:
                    retained = (
                        self._control.catalog_publication(entry.name)
                        if _DIGEST.fullmatch(entry.name) is not None
                        else None
                    )
                    if retained is None or retained.status != "INTEGRITY_FAILED":
                        errors.append(CatalogConflict())
                except (
                    CatalogConflict,
                    CatalogIntegrityFailed,
                    CatalogPublishError,
                    CatalogRecoveryBlocked,
                    CatalogStorageFailed,
                ) as error:
                    errors.append(error)
                except OSError as error:
                    errors.append(_filesystem_error(error))
            if errors:
                _raise_recovery_error(errors)
            return tuple(recovered)

    def revalidate(self, catalog_revision: str) -> CatalogPublication:
        with self._publication_lock():
            publication = self._control.catalog_publication(catalog_revision)
            if publication is None:
                raise CatalogConflict
            if publication.status == "INTEGRITY_FAILED":
                raise CatalogIntegrityFailed
            if publication.status != "PUBLISHED":
                raise CatalogRecoveryBlocked
            try:
                self._verify_directory(
                    self._catalog_root / catalog_revision,
                    publication_bytes=publication.publication_bytes,
                    catalog_revision=catalog_revision,
                    require_immutable=True,
                )
            except _CatalogIntegrityMismatch:
                self._mark_failed(publication)
                raise CatalogIntegrityFailed from None
            stage = self._staging_root / publication.staging_identity
            if _lexists(stage):
                raise CatalogRecoveryBlocked
            return publication

    def _build(self, source: FixtureSource, *, build_path: Path) -> _BuiltCatalog:
        try:
            instrument = _native_instrument(source.instrument)
            quotes = tuple(_native_quote(record) for record in source.records)
            writer = ParquetDataCatalog(str(build_path.resolve()))
            instrument_paths = writer.write_instruments([instrument])
            quote_path = writer.write_quote_ticks(quotes)
            returned_paths = tuple(instrument_paths) + (quote_path,)
            _make_staging_private(build_path)
            catalog_files = validate_native_returned_paths(build_path, returned_paths)
            readback = _native_readback(build_path, source)
            file_set = CatalogFileSetV1(
                schema="CatalogFileSet.v1", catalog_files=catalog_files
            )
            catalog_checksum = sha256(
                canonical_json_bytes(file_set.model_dump(mode="json", by_alias=True))
            ).hexdigest()
            inventory = CatalogInventoryV1(
                schema="CatalogInventory.v1",
                fixture_id=source.fixture_id,
                label="LOCAL QA FIXTURE",
                source_revision=source.source_revision,
                timezone="UTC",
                purpose="LOCAL_QA_ONLY",
                source_checksum=source.source_checksum,
                catalog_checksum=catalog_checksum,
                catalog_files=catalog_files,
                instrument=source.instrument,
                source_records=source.records,
                readback=readback,
                mapping=CatalogMappingV1(
                    schema="CatalogMapping.v1",
                    event_timestamp="ts_event_ns -> QuoteTick.ts_event",
                    availability_timestamp="ts_available_ns -> QuoteTick.ts_init",
                    source_identity=(
                        "source_seq/source_revision/record_hash -> catalog-manifest.json"
                    ),
                ),
                native_fingerprint=_native_fingerprint(),
                information_set_policy=source.information_set_policy,
                evaluation_protocol=source.evaluation_protocol,
                gaps=source.gaps,
                duplicates=source.duplicates,
                ordering_result=source.ordering_result,
            )
            inventory_bytes = canonical_json_bytes(
                inventory.model_dump(mode="json", by_alias=True)
            )
            inventory_hash = sha256(inventory_bytes).hexdigest()
            manifest = CatalogManifestV1(
                schema="CatalogManifest.v1",
                fixture_id=source.fixture_id,
                label="LOCAL QA FIXTURE",
                source_checksum=source.source_checksum,
                catalog_checksum=catalog_checksum,
                inventory_hash=inventory_hash,
                inventory=inventory,
            )
            publication_bytes = canonical_json_bytes(
                manifest.model_dump(mode="json", by_alias=True)
            )
            catalog_revision = sha256(publication_bytes).hexdigest()
            _write_exclusive(build_path / "catalog-manifest.json", publication_bytes)
            _fsync_tree(build_path)
            self._verify_directory(
                build_path,
                publication_bytes=publication_bytes,
                catalog_revision=catalog_revision,
                require_immutable=False,
            )
            return _BuiltCatalog(
                build_path=build_path,
                catalog_revision=catalog_revision,
                inventory_hash=inventory_hash,
                publication_bytes=publication_bytes,
            )
        except (CatalogPublishError, CatalogConflict, CatalogRecoveryBlocked):
            raise
        except Exception as error:
            raise CatalogPublishError("CATALOG_NATIVE_WRITE_FAILED") from error

    def _build_historical(
        self,
        source: HistoricalSource,
        *,
        build_path: Path,
    ) -> _BuiltCatalog:
        try:
            native = build_historical_native(
                build_path,
                source,
                now_ns=time.time_ns(),
            )
            _make_staging_private(build_path)
            native_files = validate_native_returned_paths(
                build_path,
                native.returned_paths,
            )
            source_directory = build_path / "source"
            os.mkdir(source_directory, _DIRECTORY_MODE)
            csv_relative, metadata_relative = source_sidecar_paths()
            _write_exclusive(build_path / csv_relative, source.csv_bytes)
            _write_exclusive(build_path / metadata_relative, source.metadata_bytes)
            _make_staging_private(build_path)
            catalog_files = tuple(
                sorted(
                    _walk_regular_files(build_path, immutable=False),
                    key=lambda item: item.relative_path,
                )
            )
            files_by_path = {item.relative_path: item for item in catalog_files}
            source_files = (
                files_by_path[csv_relative],
                files_by_path[metadata_relative],
            )
            returned_files = tuple(
                sorted(
                    (files_by_path[item.relative_path] for item in native_files),
                    key=lambda item: item.relative_path,
                )
            )
            file_set = CatalogFileSetV2(
                schema="CatalogFileSet.v2",
                catalog_files=catalog_files,
            )
            catalog_checksum = sha256(canonical_historical_bytes(file_set)).hexdigest()
            first = source.records[0]
            last = source.records[-1]
            inventory = CatalogInventoryV2(
                schema="CatalogInventory.v2",
                source_id=source.source_id,
                raw_sha256=source.raw_sha256,
                metadata_sha256=source.metadata_sha256,
                metadata=source.metadata,
                record_count=source.record_count,
                timeframe_ns=source.metadata.timeframe_ns,
                window=CatalogWindowV2(
                    first_open_ns=first.open_time_ns,
                    first_close_ns=first.close_time_ns,
                    last_open_ns=last.open_time_ns,
                    last_close_ns=last.close_time_ns,
                    first_available_ns=first.available_time_ns,
                    last_available_ns=last.available_time_ns,
                ),
                catalog_checksum=catalog_checksum,
                catalog_files=catalog_files,
                source_files=source_files,
                native_returned_files=returned_files,
                instrument=native.instrument,
                bar_type=native.bar_type,
                readback=native.readback,
                mapping=native.mapping,
                native_fingerprint=_native_fingerprint(),
                source_validation="FRESH_BOUNDED_SIDECAR_REVALIDATION",
            )
            inventory_hash = sha256(canonical_historical_bytes(inventory)).hexdigest()
            manifest = CatalogManifestV2(
                schema="CatalogManifest.v2",
                source_id=source.source_id,
                label="HISTORICAL BAR SOURCE",
                raw_sha256=source.raw_sha256,
                metadata_sha256=source.metadata_sha256,
                catalog_checksum=catalog_checksum,
                inventory_hash=inventory_hash,
                inventory=inventory,
            )
            publication_bytes = canonical_historical_bytes(manifest)
            catalog_revision = sha256(publication_bytes).hexdigest()
            _write_exclusive(build_path / "catalog-manifest.json", publication_bytes)
            _fsync_tree(build_path)
            self._verify_directory(
                build_path,
                publication_bytes=publication_bytes,
                catalog_revision=catalog_revision,
                require_immutable=False,
            )
            return _BuiltCatalog(
                build_path=build_path,
                catalog_revision=catalog_revision,
                inventory_hash=inventory_hash,
                publication_bytes=publication_bytes,
            )
        except HistoricalCatalogInvalid as error:
            raise CatalogPublishError(error.code) from error
        except (CatalogPublishError, CatalogConflict, CatalogRecoveryBlocked):
            raise
        except Exception as error:
            raise CatalogPublishError("CATALOG_NATIVE_WRITE_FAILED") from error

    def _recover_one(self, publication: CatalogPublication) -> CatalogPublication:
        stage = self._staging_root / publication.staging_identity
        target = self._catalog_root / publication.catalog_revision
        stage_exists = _lexists(stage)
        target_exists = _lexists(target)
        if publication.status == "PUBLISHED":
            if not target_exists:
                self._mark_failed(publication)
                raise CatalogIntegrityFailed
            try:
                self._verify_directory(
                    target,
                    publication_bytes=publication.publication_bytes,
                    catalog_revision=publication.catalog_revision,
                    require_immutable=True,
                )
            except _CatalogIntegrityMismatch:
                self._mark_failed(publication)
                raise CatalogIntegrityFailed from None
            if stage_exists:
                raise CatalogRecoveryBlocked
            return publication
        if publication.status == "INTEGRITY_FAILED":
            raise CatalogIntegrityFailed
        if stage_exists == target_exists:
            raise CatalogRecoveryBlocked
        if stage_exists:
            try:
                self._verify_directory(
                    stage,
                    publication_bytes=publication.publication_bytes,
                    catalog_revision=publication.catalog_revision,
                    require_immutable=False,
                )
            except _CatalogIntegrityMismatch:
                raise CatalogRecoveryBlocked from None
            _rename_absent(stage, target)
            _fsync_directory(self._staging_root)
            _fsync_directory(self._catalog_root)
            self._verify_directory(
                target,
                publication_bytes=publication.publication_bytes,
                catalog_revision=publication.catalog_revision,
                require_immutable=False,
            )
            _make_read_only(target)
        else:
            try:
                self._verify_directory(
                    target,
                    publication_bytes=publication.publication_bytes,
                    catalog_revision=publication.catalog_revision,
                    require_immutable=True,
                )
            except _CatalogIntegrityMismatch:
                try:
                    self._verify_directory(
                        target,
                        publication_bytes=publication.publication_bytes,
                        catalog_revision=publication.catalog_revision,
                        require_immutable=False,
                        allow_prepared_transition=True,
                    )
                except _CatalogIntegrityMismatch:
                    raise CatalogRecoveryBlocked from None
                _make_read_only(target)
        try:
            self._verify_directory(
                target,
                publication_bytes=publication.publication_bytes,
                catalog_revision=publication.catalog_revision,
                require_immutable=True,
            )
        except _CatalogIntegrityMismatch:
            raise CatalogRecoveryBlocked from None
        return self._publish_database(publication)

    def _publish_database(self, publication: CatalogPublication) -> CatalogPublication:
        manifest = _manifest_from_bytes(publication.publication_bytes)
        if isinstance(manifest, CatalogManifestV1):
            audit = CatalogValidatedAuditV1(
                schema="CatalogValidatedAudit.v1",
                action="catalog.validated",
                fixture_id=publication.fixture_id,
                catalog_revision=publication.catalog_revision,
                inventory_hash=publication.inventory_hash,
                source_checksum=manifest.source_checksum,
                catalog_checksum=manifest.catalog_checksum,
            )
            audit_bytes = canonical_json_bytes(
                audit.model_dump(mode="json", by_alias=True)
            )
        else:
            historical_audit = CatalogValidatedAuditV2(
                schema="CatalogValidatedAudit.v2",
                action="catalog.validated",
                source_id=publication.fixture_id,
                catalog_revision=publication.catalog_revision,
                inventory_hash=publication.inventory_hash,
                raw_sha256=manifest.raw_sha256,
                metadata_sha256=manifest.metadata_sha256,
                catalog_checksum=manifest.catalog_checksum,
            )
            audit_bytes = canonical_historical_bytes(historical_audit)
        return self._control.publish_catalog_publication(
            catalog_revision=publication.catalog_revision,
            fixture_id=publication.fixture_id,
            inventory_hash=publication.inventory_hash,
            publication_bytes=publication.publication_bytes,
            staging_identity=publication.staging_identity,
            audit_intent_bytes=audit_bytes,
        )

    def _mark_failed(self, publication: CatalogPublication) -> None:
        self._control.mark_catalog_integrity_failed(
            catalog_revision=publication.catalog_revision,
            fixture_id=publication.fixture_id,
            inventory_hash=publication.inventory_hash,
            publication_bytes=publication.publication_bytes,
            staging_identity=publication.staging_identity,
        )

    def _verify_directory(
        self,
        path: Path,
        *,
        publication_bytes: bytes,
        catalog_revision: str,
        require_immutable: bool,
        allow_prepared_transition: bool = False,
    ) -> None:
        _require_directory(
            path,
            immutable=require_immutable,
            allow_prepared_transition=allow_prepared_transition,
        )
        manifest = _manifest_from_bytes(publication_bytes)
        if sha256(publication_bytes).hexdigest() != catalog_revision:
            raise _CatalogIntegrityMismatch("CATALOG_REVISION_MISMATCH")
        actual_files = _walk_regular_files(
            path,
            immutable=require_immutable,
            allow_prepared_transition=allow_prepared_transition,
        )
        actual_by_path = {item.relative_path: item for item in actual_files}
        expected_paths = {
            item.relative_path for item in manifest.inventory.catalog_files
        } | {"catalog-manifest.json"}
        if set(actual_by_path) != expected_paths:
            raise _CatalogIntegrityMismatch("CATALOG_INVENTORY_MISMATCH")
        expected_directories: set[str] = set()
        for relative_path in expected_paths:
            parent = PurePosixPath(relative_path).parent
            while parent != PurePosixPath("."):
                expected_directories.add(parent.as_posix())
                parent = parent.parent
        if _relative_directories(path) != expected_directories:
            raise _CatalogIntegrityMismatch("CATALOG_INVENTORY_MISMATCH")
        sidecar = path / "catalog-manifest.json"
        if _read_exact_file(sidecar) != publication_bytes:
            raise _CatalogIntegrityMismatch("CATALOG_MANIFEST_MISMATCH")
        payload = tuple(
            item for item in actual_files if item.relative_path != "catalog-manifest.json"
        )
        if set(payload) != set(manifest.inventory.catalog_files):
            raise _CatalogIntegrityMismatch("CATALOG_FILE_MISMATCH")
        if isinstance(manifest, CatalogManifestV1):
            file_set: CatalogFileSetV1 | CatalogFileSetV2 = CatalogFileSetV1(
                schema="CatalogFileSet.v1",
                catalog_files=payload,
            )
            checksum = sha256(
                canonical_json_bytes(file_set.model_dump(mode="json", by_alias=True))
            ).hexdigest()
        else:
            file_set = CatalogFileSetV2(
                schema="CatalogFileSet.v2",
                catalog_files=tuple(
                    sorted(payload, key=lambda item: item.relative_path)
                ),
            )
            checksum = sha256(canonical_historical_bytes(file_set)).hexdigest()
        if checksum != manifest.catalog_checksum:
            raise _CatalogIntegrityMismatch("CATALOG_CHECKSUM_MISMATCH")
        inventory_hash = sha256(
            canonical_json_bytes(
                manifest.inventory.model_dump(mode="json", by_alias=True)
            )
            if isinstance(manifest, CatalogManifestV1)
            else canonical_historical_bytes(manifest.inventory)
        ).hexdigest()
        if inventory_hash != manifest.inventory_hash:
            raise _CatalogIntegrityMismatch("CATALOG_INVENTORY_HASH_MISMATCH")
        if manifest.inventory.native_fingerprint != _native_fingerprint():
            raise _CatalogOperationalFailure("CATALOG_NATIVE_FINGERPRINT_MISMATCH")
        if isinstance(manifest, CatalogManifestV1):
            source = _source_projection(manifest)
            if _native_readback(path, source) != manifest.inventory.readback:
                raise _CatalogIntegrityMismatch("CATALOG_READBACK_MISMATCH")
        else:
            self._verify_historical_directory(
                path,
                manifest=manifest,
                actual_by_path=actual_by_path,
            )

    def _verify_historical_directory(
        self,
        path: Path,
        *,
        manifest: CatalogManifestV2,
        actual_by_path: dict[str, CatalogFileV1],
    ) -> None:
        inventory = manifest.inventory
        csv_relative, metadata_relative = source_sidecar_paths()
        try:
            source = validate_historical_source(
                _read_exact_file(path / csv_relative),
                _read_exact_file(path / metadata_relative),
                now_ns=time.time_ns(),
            )
            expected_source_files = (
                actual_by_path[csv_relative],
                actual_by_path[metadata_relative],
            )
            expected_native_files = tuple(
                item
                for item in inventory.catalog_files
                if item.relative_path not in {csv_relative, metadata_relative}
            )
            first = source.records[0]
            last = source.records[-1]
            expected_window = CatalogWindowV2(
                first_open_ns=first.open_time_ns,
                first_close_ns=first.close_time_ns,
                last_open_ns=last.open_time_ns,
                last_close_ns=last.close_time_ns,
                first_available_ns=first.available_time_ns,
                last_available_ns=last.available_time_ns,
            )
            declaration = source.metadata.instrument
            if (
                source.source_id != manifest.source_id
                or source.source_id != inventory.source_id
                or source.raw_sha256 != manifest.raw_sha256
                or source.raw_sha256 != inventory.raw_sha256
                or source.metadata_sha256 != manifest.metadata_sha256
                or source.metadata_sha256 != inventory.metadata_sha256
                or source.metadata != inventory.metadata
                or source.record_count != inventory.record_count
                or source.metadata.timeframe_ns != inventory.timeframe_ns
                or expected_window != inventory.window
                or inventory.source_files != expected_source_files
                or inventory.native_returned_files != expected_native_files
                or inventory.instrument.source_market != declaration.market
                or inventory.instrument.source_raw_symbol != declaration.raw_symbol
                or inventory.instrument.base_currency != declaration.base_currency
                or inventory.instrument.quote_currency != declaration.quote_currency
                or inventory.instrument.price_precision != declaration.price_precision
                or inventory.instrument.size_precision != declaration.size_precision
                or inventory.instrument.price_increment != declaration.price_increment
                or inventory.instrument.size_increment != declaration.size_increment
                or inventory.instrument.minimum_quantity != declaration.minimum_quantity
            ):
                raise _CatalogIntegrityMismatch("CATALOG_SOURCE_MISMATCH")
            readback = readback_historical_native(
                path,
                source,
                inventory.instrument,
                inventory.bar_type,
            )
            if readback != inventory.readback:
                raise _CatalogIntegrityMismatch("CATALOG_READBACK_MISMATCH")
        except _CatalogIntegrityMismatch:
            raise
        except HistoricalSourceInvalid as error:
            raise _CatalogIntegrityMismatch("CATALOG_SOURCE_MISMATCH") from error
        except HistoricalCatalogInvalid as error:
            if error.code == "HISTORICAL_NATIVE_READBACK_FAILED":
                raise _CatalogOperationalFailure(
                    "CATALOG_NATIVE_READBACK_FAILED"
                ) from error
            raise _CatalogIntegrityMismatch("CATALOG_READBACK_MISMATCH") from error
        except (KeyError, ValueError) as error:
            raise _CatalogIntegrityMismatch("CATALOG_SOURCE_MISMATCH") from error

    def _cleanup_orphan_staging(self, known_revisions: set[str]) -> None:
        with os.scandir(self._staging_root) as entries:
            ordered_entries = sorted(entries, key=lambda item: item.name)
        for entry in ordered_entries:
            path = Path(entry.path)
            if entry.name.startswith("build-"):
                if _BUILD_NAME.fullmatch(entry.name) is None or entry.is_symlink():
                    raise CatalogRecoveryBlocked
                try:
                    _require_directory(path, immutable=False)
                except _CatalogIntegrityMismatch:
                    raise CatalogRecoveryBlocked from None
                _remove_service_tree(path)
                continue
            match = _PREPARED_NAME.fullmatch(entry.name)
            if match is None or entry.is_symlink():
                raise CatalogRecoveryBlocked
            revision = match.group(1)
            if revision in known_revisions:
                continue
            retained = self._control.catalog_publication(revision)
            if retained is not None and retained.status == "INTEGRITY_FAILED":
                continue
            sidecar = path / "catalog-manifest.json"
            try:
                publication_bytes = _read_exact_file(sidecar)
                self._verify_directory(
                    path,
                    publication_bytes=publication_bytes,
                    catalog_revision=revision,
                    require_immutable=False,
                )
            except _CatalogIntegrityMismatch:
                raise CatalogRecoveryBlocked from None
            _remove_service_tree(path)

    @contextmanager
    def _publication_lock(self) -> Iterator[None]:
        _ensure_directory(self._runtime_root)
        _ensure_directory(self._staging_root)
        _ensure_directory(self._catalog_root)
        key = str(self._lock_path)
        with _PROCESS_LOCKS_GUARD:
            process_lock = _PROCESS_LOCKS.setdefault(key, threading.Lock())
        with process_lock:
            flags = os.O_RDWR | os.O_CREAT | _NOFOLLOW | _CLOEXEC
            try:
                lock_fd = os.open(self._lock_path, flags, _LOCK_MODE)
            except OSError as error:
                raise CatalogPublishError("CATALOG_LOCK_INVALID") from error
            with _managed_descriptor(lock_fd, code="CATALOG_LOCK_INVALID"):
                try:
                    metadata = os.fstat(lock_fd)
                except OSError as error:
                    raise CatalogPublishError("CATALOG_LOCK_INVALID") from error
                if (
                    not stat.S_ISREG(metadata.st_mode)
                    or stat.S_IMODE(metadata.st_mode) != _LOCK_MODE
                ):
                    raise CatalogPublishError("CATALOG_LOCK_INVALID")
                try:
                    fcntl.flock(lock_fd, fcntl.LOCK_EX)
                except OSError as error:
                    raise CatalogPublishError("CATALOG_LOCK_INVALID") from error
                with _managed_publication_flock(lock_fd):
                    yield

    def _checkpoint(self, point: str) -> None:
        """Overridden only by crash-injection integration tests."""


def open_catalog_service(
    *,
    fixture_root: Path | None,
    runtime_root: Path,
    clock: Clock | None = None,
) -> tuple[FixturePublisher, ControlStore]:
    """Bootstrap the explicit private runtime before opening its control database."""

    runtime = runtime_root.absolute()
    _ensure_directory(runtime)
    try:
        control = ControlStore.open(runtime / "control.sqlite", clock=clock)
    except (sqlite3.Error, DatabaseConfigurationError) as error:
        raise CatalogStorageFailed from error
    except OSError as error:
        raise CatalogPublishError("CATALOG_RUNTIME_INVALID") from error
    try:
        service = FixturePublisher(
            registry=None if fixture_root is None else FixtureRegistry(fixture_root),
            control=control,
            runtime_root=runtime,
        )
    except BaseException as error:
        _close_control_store(control, primary=error)
        raise
    return service, control


def validate_native_returned_paths(
    catalog_root: Path, returned_paths: Sequence[str]
) -> tuple[CatalogFileV1, ...]:
    if len(set(returned_paths)) != len(returned_paths):
        raise CatalogPublishError("CATALOG_PATH_COLLISION")
    declared: set[str] = set()
    for value in returned_paths:
        if type(value) is not str:
            raise CatalogPublishError("CATALOG_PATH_INVALID")
        path = PurePosixPath(value)
        if value != path.as_posix() or path.is_absolute() or any(
            part in {"", ".", ".."} for part in path.parts
        ):
            raise CatalogPublishError("CATALOG_PATH_INVALID")
        declared.add(value)
    actual = _walk_regular_files(catalog_root, immutable=False)
    if {item.relative_path for item in actual} != declared:
        raise CatalogPublishError("CATALOG_RETURNED_PATH_MISMATCH")
    return actual


def _native_instrument(source: CatalogInstrumentV1) -> CurrencyPair:
    instrument_id = InstrumentId(Symbol(source.raw_symbol), Venue(source.venue))
    if str(instrument_id) != source.instrument_id:
        raise CatalogPublishError("CATALOG_INSTRUMENT_ID_MISMATCH")
    return CurrencyPair(
        instrument_id=instrument_id,
        raw_symbol=Symbol(source.raw_symbol),
        base_currency=Currency.from_str(source.base_currency, strict=True),
        quote_currency=Currency.from_str(source.quote_currency, strict=True),
        price_precision=source.price_precision,
        size_precision=source.size_precision,
        price_increment=Price.from_str(source.price_increment),
        size_increment=Quantity.from_str(source.size_increment),
        ts_event=int(source.ts_event_ns),
        ts_init=int(source.ts_available_ns),
        min_quantity=Quantity.from_str(source.minimum_quantity),
        min_notional=None,
        margin_init=Decimal(source.margin_init),
        margin_maint=Decimal(source.margin_maint),
        maker_fee=Decimal(source.maker_fee),
        taker_fee=Decimal(source.taker_fee),
    )


def _native_quote(source: object) -> QuoteTick:
    from stark_trading_os.domain.models import CatalogSourceRecordV1

    if not isinstance(source, CatalogSourceRecordV1):
        raise CatalogPublishError("CATALOG_QUOTE_INVALID")
    return QuoteTick(
        instrument_id=InstrumentId.from_str(source.instrument_id),
        bid_price=Price.from_str(source.bid_price),
        ask_price=Price.from_str(source.ask_price),
        bid_size=Quantity.from_str(source.bid_size),
        ask_size=Quantity.from_str(source.ask_size),
        ts_event=int(source.ts_event_ns),
        ts_init=int(source.ts_available_ns),
    )


def _native_readback(path: Path, source: FixtureSource) -> CatalogReadbackV1:
    try:
        return _native_readback_verified(path, source)
    except (_CatalogIntegrityMismatch, _CatalogOperationalFailure):
        raise
    except Exception as error:
        raise _CatalogOperationalFailure("CATALOG_NATIVE_READBACK_FAILED") from error


def _native_readback_verified(path: Path, source: FixtureSource) -> CatalogReadbackV1:
    reader = ParquetDataCatalog(str(path.resolve()))
    data_types = tuple(reader.list_data_types())
    if data_types != ("instruments", "quotes"):
        raise _CatalogIntegrityMismatch("CATALOG_DATA_TYPES_MISMATCH")
    instruments = reader.instruments()
    quotes = reader.query_quote_ticks()
    if len(instruments) != 1 or len(quotes) != len(source.records):
        raise _CatalogIntegrityMismatch("CATALOG_READBACK_COUNT_MISMATCH")
    native = instruments[0]
    expected = source.instrument
    comparisons = (
        str(native.id) == expected.instrument_id,
        str(native.raw_symbol) == expected.raw_symbol,
        str(native.id.venue) == expected.venue,
        str(native.base_currency) == expected.base_currency,
        str(native.quote_currency) == expected.quote_currency,
        native.price_precision == expected.price_precision,
        native.size_precision == expected.size_precision,
        str(native.price_increment) == expected.price_increment,
        str(native.size_increment) == expected.size_increment,
        str(native.min_quantity) == expected.minimum_quantity,
        Decimal(native.margin_init) == Decimal(expected.margin_init),
        Decimal(native.margin_maint) == Decimal(expected.margin_maint),
        Decimal(native.maker_fee) == Decimal(expected.maker_fee),
        Decimal(native.taker_fee) == Decimal(expected.taker_fee),
        native.ts_event == int(expected.ts_event_ns),
        native.ts_init == int(expected.ts_available_ns),
    )
    if not all(comparisons):
        raise _CatalogIntegrityMismatch("CATALOG_INSTRUMENT_READBACK_MISMATCH")
    for native_quote, source_quote in zip(quotes, source.records, strict=True):
        if (
            str(native_quote.instrument_id) != source_quote.instrument_id
            or str(native_quote.bid_price) != source_quote.bid_price
            or str(native_quote.ask_price) != source_quote.ask_price
            or str(native_quote.bid_size) != source_quote.bid_size
            or str(native_quote.ask_size) != source_quote.ask_size
            or native_quote.ts_event != int(source_quote.ts_event_ns)
            or native_quote.ts_init != int(source_quote.ts_available_ns)
        ):
            raise _CatalogIntegrityMismatch("CATALOG_QUOTE_READBACK_MISMATCH")
    first_timestamp = reader.query_first_timestamp("quotes", expected.instrument_id)
    last_timestamp = reader.query_last_timestamp("quotes", expected.instrument_id)
    if (
        first_timestamp != quotes[0].ts_init
        or last_timestamp != quotes[-1].ts_init
        or first_timestamp != int(source.records[0].ts_available_ns)
        or last_timestamp != int(source.records[-1].ts_available_ns)
    ):
        raise _CatalogIntegrityMismatch("CATALOG_TIMESTAMP_INVENTORY_MISMATCH")
    return CatalogReadbackV1(
        instrument=source.instrument,
        quote_count=len(quotes),
        first_ts_init=str(first_timestamp),
        last_ts_init=str(last_timestamp),
        data_types=data_types,
    )


def _source_projection(manifest: CatalogManifestV1) -> FixtureSource:
    inventory = manifest.inventory
    return FixtureSource(
        fixture_id=inventory.fixture_id,
        label=inventory.label,
        source_revision=inventory.source_revision,
        timezone=inventory.timezone,
        purpose=inventory.purpose,
        source_checksum=inventory.source_checksum,
        sha256sums_bytes=b"",
        instrument=inventory.instrument,
        records=inventory.source_records,
        information_set_policy=inventory.information_set_policy,
        evaluation_protocol=inventory.evaluation_protocol,
        gaps=inventory.gaps,
        duplicates=inventory.duplicates,
        ordering_result=inventory.ordering_result,
        file_bytes={},
    )


def _native_fingerprint() -> CatalogNativeFingerprintV1:
    try:
        return _native_fingerprint_verified()
    except _CatalogOperationalFailure:
        raise
    except Exception as error:
        raise _CatalogOperationalFailure("CATALOG_NATIVE_FINGERPRINT_FAILED") from error


def _native_fingerprint_verified() -> CatalogNativeFingerprintV1:
    extension_path = Path(str(_libnautilus.__file__))
    installed_version = importlib.metadata.version("nautilus_trader")
    writer_identity = f"{ParquetDataCatalog.__module__}.{ParquetDataCatalog.__qualname__}"
    if installed_version != "2.0.0rc3" or writer_identity != (
        "nautilus_trader.persistence.ParquetDataCatalog"
    ):
        raise _CatalogOperationalFailure("CATALOG_NATIVE_FINGERPRINT_MISMATCH")
    return CatalogNativeFingerprintV1(
        schema="CatalogNativeFingerprint.v1",
        python_version=platform.python_version(),
        platform_system=platform.system(),
        platform_machine=platform.machine(),
        installed_nautilus_version="2.0.0rc3",
        native_extension_sha256=_file_sha256(extension_path),
        writer_class="nautilus_trader.persistence.ParquetDataCatalog",
        writer_options=(
            "batch_size=null;compression=null;max_row_group_size=null;storage_options=null"
        ),
    )


def _manifest_from_bytes(raw: bytes) -> _CatalogManifest:
    try:
        schema = catalog_schema_from_bytes(raw)
        if schema == "CatalogManifest.v1":
            parsed = parse_json_object(raw)
            if canonical_json_bytes(parsed) != raw:
                raise _CatalogIntegrityMismatch("CATALOG_MANIFEST_NONCANONICAL")
            return CatalogManifestV1.model_validate(parsed)
        if schema == "CatalogManifest.v2":
            return parse_historical_manifest_bytes(raw)
        raise _CatalogOperationalFailure("CATALOG_SCHEMA_UNSUPPORTED")
    except _CatalogOperationalFailure:
        raise
    except (HistoricalCatalogInvalid, ValidationError, ValueError) as error:
        raise _CatalogIntegrityMismatch("CATALOG_MANIFEST_INVALID") from error


def _require_publication_matches(
    publication: CatalogPublication, built: _BuiltCatalog, *, fixture_id: str
) -> None:
    if (
        publication.fixture_id != fixture_id
        or publication.inventory_hash != built.inventory_hash
        or publication.publication_bytes != built.publication_bytes
        or publication.staging_identity != f"prepared-{built.catalog_revision}"
    ):
        raise CatalogConflict


def _walk_regular_files(
    root: Path,
    *,
    immutable: bool,
    allow_prepared_transition: bool = False,
) -> tuple[CatalogFileV1, ...]:
    files: list[CatalogFileV1] = []

    def visit(directory: Path, relative: PurePosixPath) -> None:
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.is_symlink():
                    raise _CatalogIntegrityMismatch("CATALOG_SYMLINK_INVALID")
                child_relative = relative / entry.name
                metadata = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(metadata.st_mode):
                    if not _mode_allowed(
                        metadata.st_mode,
                        immutable=immutable,
                        allow_prepared_transition=allow_prepared_transition,
                        directory=True,
                    ):
                        raise _CatalogIntegrityMismatch("CATALOG_PERMISSION_INVALID")
                    visit(Path(entry.path), child_relative)
                elif stat.S_ISREG(metadata.st_mode):
                    if not _mode_allowed(
                        metadata.st_mode,
                        immutable=immutable,
                        allow_prepared_transition=allow_prepared_transition,
                        directory=False,
                    ):
                        raise _CatalogIntegrityMismatch("CATALOG_PERMISSION_INVALID")
                    child_path = Path(entry.path)
                    files.append(
                        CatalogFileV1(
                            relative_path=child_relative.as_posix(),
                            size_bytes=metadata.st_size,
                            sha256=_file_sha256(child_path),
                        )
                    )
                else:
                    raise _CatalogIntegrityMismatch("CATALOG_FILE_TYPE_INVALID")

    try:
        visit(root, PurePosixPath())
    except FileNotFoundError as error:
        raise _CatalogIntegrityMismatch("CATALOG_FILE_INVALID") from error
    except OSError as error:
        raise _filesystem_error(error) from error
    return tuple(files)


def _relative_directories(root: Path) -> set[str]:
    directories: set[str] = set()
    try:
        for current_root, directory_names, _ in os.walk(
            root,
            followlinks=False,
            onerror=_raise_walk_error,
        ):
            current = Path(current_root)
            for name in directory_names:
                child = current / name
                if child.is_symlink():
                    raise _CatalogIntegrityMismatch("CATALOG_SYMLINK_INVALID")
                directories.add(child.relative_to(root).as_posix())
    except FileNotFoundError as error:
        raise _CatalogIntegrityMismatch("CATALOG_DIRECTORY_MISSING") from error
    except OSError as error:
        raise _filesystem_error(error) from error
    return directories


def _require_directory(
    path: Path,
    *,
    immutable: bool,
    allow_prepared_transition: bool = False,
) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise _CatalogIntegrityMismatch("CATALOG_DIRECTORY_MISSING") from error
    except OSError as error:
        raise _filesystem_error(error) from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise _CatalogIntegrityMismatch("CATALOG_DIRECTORY_INVALID")
    if not _mode_allowed(
        metadata.st_mode,
        immutable=immutable,
        allow_prepared_transition=allow_prepared_transition,
        directory=True,
    ):
        raise _CatalogIntegrityMismatch("CATALOG_PERMISSION_INVALID")


def _mode_allowed(
    mode: int,
    *,
    immutable: bool,
    allow_prepared_transition: bool,
    directory: bool,
) -> bool:
    private_mode = _DIRECTORY_MODE if directory else _LOCK_MODE
    published_mode = _PUBLISHED_DIRECTORY_MODE if directory else _PUBLISHED_FILE_MODE
    allowed = (
        {private_mode, published_mode}
        if allow_prepared_transition
        else {published_mode if immutable else private_mode}
    )
    return stat.S_IMODE(mode) in allowed


def _ensure_directory(path: Path) -> None:
    try:
        path.mkdir(mode=_DIRECTORY_MODE)
    except FileExistsError:
        pass
    except OSError as error:
        raise CatalogPublishError("CATALOG_RUNTIME_INVALID") from error
    try:
        metadata = path.lstat()
    except OSError as error:
        raise CatalogPublishError("CATALOG_RUNTIME_INVALID") from error
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != _DIRECTORY_MODE
    ):
        raise CatalogPublishError("CATALOG_RUNTIME_INVALID")


def _rename_absent(source: Path, target: Path) -> None:
    if _lexists(target):
        raise CatalogConflict
    try:
        os.rename(source, target)
    except OSError as error:
        raise _filesystem_error(error) from error


def _lexists(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    except OSError as error:
        raise _filesystem_error(error) from error
    return True


def _make_read_only(root: Path) -> None:
    try:
        directories: list[Path] = []
        for current_root, directory_names, file_names in os.walk(
            root,
            followlinks=False,
            onerror=_raise_walk_error,
        ):
            current = Path(current_root)
            directories.append(current)
            for name in (*directory_names, *file_names):
                if (current / name).is_symlink():
                    raise CatalogPublishError("CATALOG_SYMLINK_INVALID")
            for name in file_names:
                os.chmod(current / name, _PUBLISHED_FILE_MODE, follow_symlinks=False)
        for directory in reversed(directories):
            os.chmod(directory, _PUBLISHED_DIRECTORY_MODE, follow_symlinks=False)
    except OSError as error:
        raise _filesystem_error(error) from error


def _make_staging_private(root: Path) -> None:
    try:
        directories: list[Path] = []
        for current_root, directory_names, file_names in os.walk(
            root,
            followlinks=False,
            onerror=_raise_walk_error,
        ):
            current = Path(current_root)
            directories.append(current)
            for name in (*directory_names, *file_names):
                if (current / name).is_symlink():
                    raise CatalogPublishError("CATALOG_SYMLINK_INVALID")
            for name in file_names:
                os.chmod(current / name, _LOCK_MODE, follow_symlinks=False)
        for directory in reversed(directories):
            os.chmod(directory, _DIRECTORY_MODE, follow_symlinks=False)
    except OSError as error:
        raise _filesystem_error(error) from error


def _remove_service_tree(root: Path) -> None:
    try:
        metadata = root.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise CatalogRecoveryBlocked
        for current_root, directory_names, file_names in os.walk(
            root,
            followlinks=False,
            onerror=_raise_walk_error,
        ):
            current = Path(current_root)
            os.chmod(current, _DIRECTORY_MODE, follow_symlinks=False)
            for name in directory_names:
                child = current / name
                if child.is_symlink():
                    raise CatalogRecoveryBlocked
                os.chmod(child, _DIRECTORY_MODE, follow_symlinks=False)
            for name in file_names:
                child = current / name
                if child.is_symlink():
                    raise CatalogRecoveryBlocked
                os.chmod(child, _LOCK_MODE, follow_symlinks=False)
        shutil.rmtree(root)
    except OSError as error:
        raise _filesystem_error(error) from error


def _write_exclusive(path: Path, content: bytes) -> None:
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW,
            _LOCK_MODE,
        )
        with _managed_descriptor(descriptor, code="CATALOG_FILESYSTEM_FAILED"):
            remaining = memoryview(content)
            while remaining:
                written = os.write(descriptor, remaining)
                remaining = remaining[written:]
            os.fsync(descriptor)
    except OSError as error:
        raise _filesystem_error(error) from error


def _read_exact_file(path: Path) -> bytes:
    try:
        descriptor = os.open(path, os.O_RDONLY | _NOFOLLOW | _CLOEXEC)
        with _managed_descriptor(descriptor, code="CATALOG_FILESYSTEM_FAILED"):
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise _CatalogIntegrityMismatch("CATALOG_FILE_INVALID")
            chunks: list[bytes] = []
            while chunk := os.read(descriptor, 1024 * 1024):
                chunks.append(chunk)
            return b"".join(chunks)
    except FileNotFoundError as error:
        raise _CatalogIntegrityMismatch("CATALOG_FILE_INVALID") from error
    except OSError as error:
        raise _filesystem_error(error) from error


def _file_sha256(path: Path) -> str:
    digest = sha256()
    try:
        descriptor = os.open(path, os.O_RDONLY | _NOFOLLOW | _CLOEXEC)
        with _managed_descriptor(descriptor, code="CATALOG_FILESYSTEM_FAILED"):
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise _CatalogIntegrityMismatch("CATALOG_FILE_INVALID")
            while chunk := os.read(descriptor, 1024 * 1024):
                digest.update(chunk)
    except FileNotFoundError as error:
        raise _CatalogIntegrityMismatch("CATALOG_FILE_INVALID") from error
    except OSError as error:
        raise _filesystem_error(error) from error
    return digest.hexdigest()


def _fsync_tree(root: Path) -> None:
    try:
        directories: list[Path] = []
        for current_root, _, file_names in os.walk(
            root,
            followlinks=False,
            onerror=_raise_walk_error,
        ):
            current = Path(current_root)
            directories.append(current)
            for name in file_names:
                descriptor = os.open(
                    current / name,
                    os.O_RDONLY | _NOFOLLOW | _CLOEXEC,
                )
                with _managed_descriptor(
                    descriptor, code="CATALOG_FILESYSTEM_FAILED"
                ):
                    os.fsync(descriptor)
        for directory in reversed(directories):
            _fsync_directory(directory)
    except OSError as error:
        raise _filesystem_error(error) from error


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _NOFOLLOW,
        )
        with _managed_descriptor(descriptor, code="CATALOG_FILESYSTEM_FAILED"):
            os.fsync(descriptor)
    except OSError as error:
        raise _filesystem_error(error) from error


def _raise_walk_error(error: OSError) -> None:
    raise error


@contextmanager
def _managed_descriptor(descriptor: int, *, code: str) -> Iterator[int]:
    primary: BaseException | None = None
    try:
        yield descriptor
    except BaseException as error:
        primary = error
        raise
    finally:
        _close_descriptor(descriptor, code=code, primary=primary)


@contextmanager
def _managed_publication_flock(descriptor: int) -> Iterator[None]:
    primary: BaseException | None = None
    try:
        yield
    except BaseException as error:
        primary = error
        raise
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        except OSError as error:
            failure = _CatalogOperationalFailure("CATALOG_LOCK_INVALID")
            if primary is None:
                raise failure from error
            primary.add_note("Secondary cleanup failure: CATALOG_LOCK_INVALID")


@contextmanager
def _owned_build_tree(staging_root: Path) -> Iterator[_ServiceTreeOwnership]:
    ownership = _ServiceTreeOwnership(
        root=staging_root / f"build-{uuid.uuid4().hex}"
    )
    primary: BaseException | None = None
    try:
        yield ownership
    except BaseException as error:
        primary = error
        raise
    finally:
        if ownership.owned:
            _cleanup_owned_service_tree(ownership.root, primary=primary)


def _cleanup_owned_service_tree(
    root: Path, *, primary: BaseException | None
) -> None:
    try:
        if not _lexists(root):
            return
        _remove_service_tree(root)
    except BaseException:
        if primary is None:
            raise
        primary.add_note("Secondary cleanup failure: CATALOG_FILESYSTEM_FAILED")


def _close_descriptor(
    descriptor: int, *, code: str, primary: BaseException | None
) -> None:
    try:
        os.close(descriptor)
    except OSError as error:
        failure = _CatalogOperationalFailure(code)
        if primary is None:
            raise failure from error
        primary.add_note(f"Secondary cleanup failure: {code}")


def _close_control_store(
    control: ControlStore, *, primary: BaseException | None
) -> None:
    try:
        control.close()
    except BaseException as error:
        if primary is None:
            if isinstance(error, Exception):
                raise CatalogStorageFailed() from error
            raise
        primary.add_note("Secondary cleanup failure: CATALOG_STORAGE_FAILED")


def _filesystem_error(_error: OSError) -> CatalogPublishError:
    return _CatalogOperationalFailure("CATALOG_FILESYSTEM_FAILED")


def _raise_recovery_error(errors: Sequence[Exception]) -> None:
    for error_type in (
        CatalogIntegrityFailed,
        CatalogConflict,
        CatalogStorageFailed,
        CatalogPublishError,
        CatalogRecoveryBlocked,
    ):
        for error in errors:
            if isinstance(error, error_type):
                raise error
    raise CatalogPublishError("CATALOG_RECOVERY_FAILED")
