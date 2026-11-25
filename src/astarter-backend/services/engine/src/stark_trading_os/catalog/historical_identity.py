"""Shared pure consistency checks for published historical catalog declarations."""

from __future__ import annotations

from hashlib import sha256
from pathlib import PurePosixPath

from stark_trading_os.catalog.historical_catalog import (
    CatalogFileSetV2,
    CatalogManifestV2,
    HistoricalCatalogInvalid,
    canonical_historical_bytes,
    historical_bar_type,
    source_sidecar_paths,
)


def validate_historical_catalog_identity(
    manifest: CatalogManifestV2,
    *,
    source_id: str,
    inventory_hash: str,
) -> None:
    """Check embedded claims only; actual publication files need separate revalidation."""
    inventory = manifest.inventory
    csv_relative, metadata_relative = source_sidecar_paths()
    catalog_files = inventory.catalog_files
    source_files = inventory.source_files
    native_files = inventory.native_returned_files
    all_paths = tuple(item.relative_path for item in catalog_files)
    source_paths = tuple(item.relative_path for item in source_files)
    native_paths = tuple(item.relative_path for item in native_files)
    if any(not _safe_catalog_relative_path(path) for path in all_paths):
        raise HistoricalCatalogInvalid("HISTORICAL_CATALOG_IDENTITY_INVALID")
    if (
        tuple(sorted(all_paths)) != all_paths
        or len(set(all_paths)) != len(all_paths)
        or source_paths != (csv_relative, metadata_relative)
        or tuple(sorted(native_paths)) != native_paths
        or len(native_paths) < 2
        or len(set(native_paths)) != len(native_paths)
        or set(all_paths) != set(source_paths) | set(native_paths)
        or set(source_paths) & set(native_paths)
    ):
        raise HistoricalCatalogInvalid("HISTORICAL_CATALOG_IDENTITY_INVALID")
    files_by_path = {item.relative_path: item for item in catalog_files}
    readback = inventory.readback
    window = inventory.window
    instrument = inventory.instrument
    declaration = inventory.metadata.instrument
    try:
        timeframe_ns = int(inventory.timeframe_ns)
        first_open_ns = int(window.first_open_ns)
        first_close_ns = int(window.first_close_ns)
        last_open_ns = int(window.last_open_ns)
        last_close_ns = int(window.last_close_ns)
        expected_bar_type = historical_bar_type(
            instrument.instrument_id,
            inventory.timeframe_ns,
        )
    except (HistoricalCatalogInvalid, ValueError) as error:
        raise HistoricalCatalogInvalid("HISTORICAL_CATALOG_IDENTITY_INVALID") from error
    expected_native_symbol = f"HIST{source_id[:20].upper()}"
    expected_instrument_id = f"{expected_native_symbol}.SIM"
    file_set = CatalogFileSetV2(
        schema="CatalogFileSet.v2",
        catalog_files=catalog_files,
    )
    if (
        manifest.source_id != source_id
        or inventory.source_id != source_id
        or manifest.inventory_hash != inventory_hash
        or manifest.raw_sha256 != inventory.raw_sha256
        or manifest.metadata_sha256 != inventory.metadata_sha256
        or manifest.catalog_checksum != inventory.catalog_checksum
        or inventory.metadata.source.raw_sha256 != manifest.raw_sha256
        or inventory.metadata.timeframe_ns != inventory.timeframe_ns
        or source_files[0] != files_by_path[csv_relative]
        or source_files[1] != files_by_path[metadata_relative]
        or native_files != tuple(files_by_path[path] for path in native_paths)
        or source_files[0].sha256 != manifest.raw_sha256
        or source_files[1].sha256 != manifest.metadata_sha256
        or source_files[0].size_bytes <= 0
        or source_files[1].size_bytes <= 0
        or readback.instrument != instrument
        or readback.bar_type != inventory.bar_type
        or inventory.bar_type != expected_bar_type
        or readback.bar_count != inventory.record_count
        or readback.first_ts_event != window.first_close_ns
        or readback.last_ts_event != window.last_close_ns
        or readback.first_ts_init != window.first_available_ns
        or readback.last_ts_init != window.last_available_ns
        or readback.first_bar.ts_event != window.first_close_ns
        or readback.last_bar.ts_event != window.last_close_ns
        or readback.first_bar.ts_init != window.first_available_ns
        or readback.last_bar.ts_init != window.last_available_ns
        or instrument.ts_event_ns != window.first_close_ns
        or instrument.ts_init_ns != window.first_available_ns
        or instrument.native_symbol != expected_native_symbol
        or instrument.instrument_id != expected_instrument_id
        or instrument.source_market != declaration.market
        or instrument.source_raw_symbol != declaration.raw_symbol
        or instrument.base_currency != declaration.base_currency
        or instrument.quote_currency != declaration.quote_currency
        or instrument.price_precision != declaration.price_precision
        or instrument.size_precision != declaration.size_precision
        or instrument.price_increment != declaration.price_increment
        or instrument.size_increment != declaration.size_increment
        or instrument.minimum_quantity != declaration.minimum_quantity
        or window.first_available_ns != window.first_close_ns
        or window.last_available_ns != window.last_close_ns
        or timeframe_ns <= 0
        or first_close_ns - first_open_ns != timeframe_ns
        or last_close_ns - last_open_ns != timeframe_ns
        or last_close_ns - first_open_ns != inventory.record_count * timeframe_ns
        or sha256(canonical_historical_bytes(file_set)).hexdigest()
        != manifest.catalog_checksum
    ):
        raise HistoricalCatalogInvalid("HISTORICAL_CATALOG_IDENTITY_INVALID")
    if sha256(canonical_historical_bytes(inventory)).hexdigest() != inventory_hash:
        raise HistoricalCatalogInvalid("HISTORICAL_CATALOG_IDENTITY_INVALID")


def _safe_catalog_relative_path(value: str) -> bool:
    parsed = PurePosixPath(value)
    return (
        value == parsed.as_posix()
        and not parsed.is_absolute()
        and "\\" not in value
        and "\x00" not in value
        and bool(parsed.parts)
        and all(part not in {"", ".", ".."} for part in parsed.parts)
    )
