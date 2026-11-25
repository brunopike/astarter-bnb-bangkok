from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest
from nautilus_trader.model import BarType
from nautilus_trader.persistence import ParquetDataCatalog
from test_historical_source import NOW_NS, _csv_bytes, _metadata_bytes

import stark_trading_os.catalog.historical_catalog as historical_catalog_module
from stark_trading_os.catalog.historical_catalog import (
    HistoricalCatalogInvalid,
    build_historical_native,
    native_bar_specification,
    validate_historical_source_object,
)
from stark_trading_os.catalog.historical_source import validate_historical_source


def _source(*, raw_symbol: str = "ETHUSDT"):
    csv_bytes = _csv_bytes()
    metadata_bytes = _metadata_bytes(
        csv_bytes,
        mutate=lambda value: value["instrument"].update(raw_symbol=raw_symbol),
    )
    return validate_historical_source(csv_bytes, metadata_bytes, now_ns=NOW_NS)


def test_frozen_source_is_revalidated_from_retained_bytes_before_trust() -> None:
    source = _source()

    assert validate_historical_source_object(source, now_ns=NOW_NS) == source

    forged = replace(source, source_id="0" * 64)
    with pytest.raises(HistoricalCatalogInvalid, match="HISTORICAL_SOURCE_FORGED"):
        validate_historical_source_object(forged, now_ns=NOW_NS)


def test_exact_supported_timeframe_maps_to_external_last_bar() -> None:
    specification = native_bar_specification("60000000000")

    assert str(specification) == "1-MINUTE-LAST"
    assert specification.get_interval_ns() == 60_000_000_000


def test_nonrepresentable_timeframe_is_rejected_explicitly() -> None:
    with pytest.raises(
        HistoricalCatalogInvalid,
        match="HISTORICAL_TIMEFRAME_UNSUPPORTED",
    ):
        native_bar_specification("7000000000")


def test_real_native_build_uses_digest_symbol_and_preserves_values_and_times(
    tmp_path: Path,
) -> None:
    source = _source(raw_symbol="../../private/ETHUSDT")

    built = build_historical_native(tmp_path, source, now_ns=NOW_NS)

    assert built.instrument.venue == "SIM"
    assert built.instrument.source_raw_symbol == "../../private/ETHUSDT"
    assert ".." not in built.instrument.native_symbol
    assert "/" not in built.instrument.native_symbol
    assert built.instrument.instrument_id == f"{built.instrument.native_symbol}.SIM"
    assert built.bar_type == f"{built.instrument.instrument_id}-1-MINUTE-LAST-EXTERNAL"
    assert str(BarType.from_str(built.bar_type)) == built.bar_type
    assert built.readback.bar_count == source.record_count
    assert built.readback.first_ts_event == source.records[0].close_time_ns
    assert built.readback.first_ts_init == source.records[0].available_time_ns
    assert built.readback.first_bar.open == source.records[0].open
    assert built.readback.last_bar.close == source.records[-1].close

    reader = ParquetDataCatalog(str(tmp_path.resolve()))
    bars = reader.query_bars()
    assert bars[0].ts_event == int(source.records[0].close_time_ns)
    assert bars[0].ts_init == int(source.records[0].available_time_ns)
    assert str(bars[0].open) == source.records[0].open
    assert str(bars[-1].close) == source.records[-1].close


def test_native_writer_backslash_paths_are_rejected_before_readback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _source()

    class UnsafePathWriter:
        def __init__(self, root: str) -> None:
            self.root = Path(root)

        def write_instruments(self, _instruments: object) -> list[str]:
            relative = "data\\instruments.parquet"
            (self.root / relative).write_bytes(b"instrument")
            return [relative]

        def write_bars(self, _bars: object) -> str:
            relative = "data\\bars.parquet"
            (self.root / relative).write_bytes(b"bars")
            return relative

    monkeypatch.setattr(
        historical_catalog_module,
        "ParquetDataCatalog",
        UnsafePathWriter,
    )

    with pytest.raises(
        HistoricalCatalogInvalid,
        match="HISTORICAL_NATIVE_PATH_INVALID",
    ):
        build_historical_native(tmp_path, source, now_ns=NOW_NS)
