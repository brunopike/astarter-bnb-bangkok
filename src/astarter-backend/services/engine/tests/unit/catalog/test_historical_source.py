from __future__ import annotations

import json
import tracemalloc
from copy import deepcopy
from dataclasses import FrozenInstanceError
from decimal import localcontext
from hashlib import sha256
from typing import Any

import pytest
from nautilus_trader.model import FIXED_PRECISION, Bar
from pydantic import ValidationError

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.catalog.historical_source import (
    HistoricalSource,
    HistoricalSourceInvalid,
    validate_historical_source,
)

CSV_HEADER = (
    "open_time_ns,close_time_ns,available_time_ns,open,high,low,close,volume"
)
FIRST_OPEN_NS = 1_700_000_000_000_000_000
FIRST_CLOSE_NS = 1_700_000_060_000_000_000
SECOND_OPEN_NS = FIRST_CLOSE_NS
SECOND_CLOSE_NS = 1_700_000_120_000_000_000
RETRIEVED_AT_NS = 1_700_000_300_000_000_000
NOW_NS = 1_700_000_400_000_000_000
U64_MAX = (2**64) - 1

VALID_ROWS = (
    (
        str(FIRST_OPEN_NS),
        str(FIRST_CLOSE_NS),
        str(FIRST_CLOSE_NS),
        "100.00",
        "110.00",
        "90.00",
        "105.00",
        "100.000",
    ),
    (
        str(SECOND_OPEN_NS),
        str(SECOND_CLOSE_NS),
        str(SECOND_CLOSE_NS),
        "200.00",
        "220.00",
        "180.00",
        "210.00",
        "100.000",
    ),
)

ERROR_CODES = frozenset(
    {
        "HISTORICAL_CSV_INVALID",
        "HISTORICAL_CSV_LIMIT",
        "HISTORICAL_HEADER_INVALID",
        "HISTORICAL_INSTRUMENT_INVALID",
        "HISTORICAL_METADATA_INVALID",
        "HISTORICAL_METADATA_LIMIT",
        "HISTORICAL_OHLC_INVALID",
        "HISTORICAL_PRICE_INVALID",
        "HISTORICAL_ROW_INVALID",
        "HISTORICAL_SEQUENCE_INVALID",
        "HISTORICAL_SOURCE_CHECKSUM_MISMATCH",
        "HISTORICAL_TIMESTAMP_INVALID",
        "HISTORICAL_VOLUME_INVALID",
    }
)


def _csv_bytes(
    rows: tuple[tuple[str, ...], ...] = VALID_ROWS,
    *,
    newline: str = "\n",
    trailing_newline: bool = True,
) -> bytes:
    text = newline.join((CSV_HEADER, *(",".join(row) for row in rows)))
    if trailing_newline:
        text += newline
    return text.encode()


def _metadata(csv_bytes: bytes) -> dict[str, Any]:
    return {
        "schema": "HistoricalBarSource.v1",
        "source": {
            "name": "Synthetic test bars",
            "origin": "generated test input; not market data",
            "retrieved_at_ns": str(RETRIEVED_AT_NS),
            "raw_sha256": sha256(csv_bytes).hexdigest(),
        },
        "instrument": {
            "market": "SYNTHETIC",
            "raw_symbol": "ETHUSDT",
            "base_currency": "ETH",
            "quote_currency": "USDT",
            "price_precision": 2,
            "size_precision": 3,
            "price_increment": "0.01",
            "size_increment": "0.001",
            "minimum_quantity": "0.001",
            "specification_source": "test assumptions, not historical exchange rules",
            "specification_status": "EXPLICIT_ASSUMPTION",
        },
        "timeframe_ns": "60000000000",
        "timestamp_mapping": "UTC nanoseconds, half-open [open, close), available at close",
        "availability_source": "ASSUMED_AT_CLOSE",
        "purpose": "SYNTHETIC_QA",
    }


def _metadata_bytes(
    csv_bytes: bytes,
    *,
    mutate: Any | None = None,
) -> bytes:
    metadata = _metadata(csv_bytes)
    if mutate is not None:
        mutate(metadata)
    return json.dumps(
        metadata,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()


def _with_cell(
    rows: tuple[tuple[str, ...], ...],
    row_index: int,
    column: str,
    value: str,
) -> tuple[tuple[str, ...], ...]:
    result = [list(row) for row in rows]
    result[row_index][CSV_HEADER.split(",").index(column)] = value
    return tuple(tuple(row) for row in result)


def _bar_row(
    open_ns: int,
    *,
    open_price: str = "200.00",
    high: str = "220.00",
    low: str = "180.00",
    close_price: str = "210.00",
    volume: str = "100.000",
) -> tuple[str, ...]:
    close_ns = open_ns + 60_000_000_000
    return (
        str(open_ns),
        str(close_ns),
        str(close_ns),
        open_price,
        high,
        low,
        close_price,
        volume,
    )


def _assert_invalid(
    csv_bytes: bytes,
    metadata_bytes: bytes,
    *,
    code: str,
    line: int | None = None,
    now_ns: object = NOW_NS,
) -> HistoricalSourceInvalid:
    assert code in ERROR_CODES
    with pytest.raises(HistoricalSourceInvalid) as caught:
        validate_historical_source(  # type: ignore[arg-type]
            csv_bytes,
            metadata_bytes,
            now_ns=now_ns,
        )
    error = caught.value
    assert error.code == code
    assert error.line == line
    expected_message = code if line is None else f"{code}:line={line}"
    assert str(error) == expected_message
    return error


def test_valid_source_retains_exact_bytes_records_and_independent_identity() -> None:
    csv_bytes = _csv_bytes()
    metadata_bytes = _metadata_bytes(csv_bytes)
    original_csv = bytes(csv_bytes)
    original_metadata = bytes(metadata_bytes)

    source = validate_historical_source(csv_bytes, metadata_bytes, now_ns=NOW_NS)

    assert isinstance(source, HistoricalSource)
    assert source.csv_bytes is csv_bytes
    assert source.metadata_bytes is metadata_bytes
    assert source.csv_bytes == original_csv
    assert source.metadata_bytes == original_metadata
    assert source.raw_sha256 == sha256(csv_bytes).hexdigest()
    assert source.metadata_sha256 == sha256(metadata_bytes).hexdigest()
    assert source.record_count == 2
    assert isinstance(source.records, tuple)
    assert [record.source_seq for record in source.records] == [1, 2]
    assert source.records[0].open_time_ns == str(FIRST_OPEN_NS)
    assert source.records[0].open == "100.00"
    assert source.records[0].volume == "100.000"
    assert all(not isinstance(record, Bar) for record in source.records)

    identity = {
        "validator_version": "historical-source-v1",
        "raw_sha256": source.raw_sha256,
        "metadata_sha256": source.metadata_sha256,
        "metadata": source.metadata.model_dump(mode="json", by_alias=True),
        "records": [record.model_dump(mode="json") for record in source.records],
    }
    assert source.source_id == sha256(canonical_json_bytes(identity)).hexdigest()


def test_source_and_all_nested_models_are_frozen() -> None:
    csv_bytes = _csv_bytes()
    source = validate_historical_source(
        csv_bytes,
        _metadata_bytes(csv_bytes),
        now_ns=NOW_NS,
    )

    with pytest.raises(FrozenInstanceError):
        source.source_id = "0" * 64  # type: ignore[misc]
    with pytest.raises(ValidationError):
        source.metadata.source.name = "changed"  # type: ignore[misc]
    with pytest.raises(ValidationError):
        source.records[0].open = "101.00"  # type: ignore[misc]


def test_identity_is_repeatable_and_binds_valid_csv_and_metadata_changes() -> None:
    csv_bytes = _csv_bytes()
    metadata_bytes = _metadata_bytes(csv_bytes)
    repeated = validate_historical_source(csv_bytes, metadata_bytes, now_ns=NOW_NS)
    same = validate_historical_source(csv_bytes, metadata_bytes, now_ns=NOW_NS)

    changed_metadata_bytes = _metadata_bytes(
        csv_bytes,
        mutate=lambda value: value["source"].update(name="Synthetic test bars v2"),
    )
    changed_metadata = validate_historical_source(
        csv_bytes,
        changed_metadata_bytes,
        now_ns=NOW_NS,
    )
    changed_rows = _with_cell(VALID_ROWS, 1, "volume", "101.000")
    changed_csv_bytes = _csv_bytes(changed_rows)
    changed_csv = validate_historical_source(
        changed_csv_bytes,
        _metadata_bytes(changed_csv_bytes),
        now_ns=NOW_NS,
    )

    assert repeated.source_id == same.source_id
    assert repeated.source_id != changed_metadata.source_id
    assert repeated.source_id != changed_csv.source_id


def test_meaningful_metadata_whitespace_is_preserved_without_normalization() -> None:
    csv_bytes = _csv_bytes()
    metadata_bytes = _metadata_bytes(
        csv_bytes,
        mutate=lambda value: value["source"].update(
            name="  Synthetic test bars  ",
            origin=" generated test input; not market data ",
        ),
    )

    source = validate_historical_source(csv_bytes, metadata_bytes, now_ns=NOW_NS)

    assert source.metadata.source.name == "  Synthetic test bars  "
    assert source.metadata.source.origin == " generated test input; not market data "


@pytest.mark.parametrize("newline", ["\n", "\r\n"], ids=["lf", "crlf"])
@pytest.mark.parametrize("trailing_newline", [False, True], ids=["no-final-eol", "final-eol"])
def test_standard_line_endings_are_accepted(
    newline: str,
    trailing_newline: bool,
) -> None:
    csv_bytes = _csv_bytes(newline=newline, trailing_newline=trailing_newline)

    source = validate_historical_source(
        csv_bytes,
        _metadata_bytes(csv_bytes),
        now_ns=NOW_NS,
    )

    assert source.record_count == 2


def test_all_supported_provenance_declarations_are_accepted_as_declarations() -> None:
    csv_bytes = _csv_bytes()
    metadata_bytes = _metadata_bytes(
        csv_bytes,
        mutate=lambda value: (
            value["instrument"].update(specification_status="HISTORICAL_EVIDENCE"),
            value.update(
                availability_source="RECORDED_AT_CLOSE",
                purpose="HISTORICAL_MARKET",
            ),
        ),
    )

    source = validate_historical_source(csv_bytes, metadata_bytes, now_ns=NOW_NS)

    assert source.metadata.instrument.specification_status == "HISTORICAL_EVIDENCE"
    assert source.metadata.availability_source == "RECORDED_AT_CLOSE"
    assert source.metadata.purpose == "HISTORICAL_MARKET"


@pytest.mark.parametrize(
    ("csv_bytes", "expected_code"),
    [
        (b"", "HISTORICAL_CSV_LIMIT"),
        (b"x" * (32 * 1024 * 1024), "HISTORICAL_CSV_LIMIT"),
    ],
    ids=["empty", "at-32-mib"],
)
def test_csv_byte_bounds_reject_entire_source(
    csv_bytes: bytes,
    expected_code: str,
) -> None:
    _assert_invalid(
        csv_bytes,
        _metadata_bytes(csv_bytes),
        code=expected_code,
    )


@pytest.mark.parametrize(
    "metadata_bytes",
    [b"", b" " * (64 * 1024)],
    ids=["empty", "at-64-kib"],
)
def test_metadata_byte_bounds_reject_entire_source(metadata_bytes: bytes) -> None:
    _assert_invalid(
        _csv_bytes(),
        metadata_bytes,
        code="HISTORICAL_METADATA_LIMIT",
    )


def test_record_count_at_100000_is_rejected_before_row_repair_or_deduplication() -> None:
    row = (",".join(VALID_ROWS[0]) + "\n").encode()
    csv_bytes = (CSV_HEADER + "\n").encode() + (row * 100_000)
    assert len(csv_bytes) < 32 * 1024 * 1024

    _assert_invalid(
        csv_bytes,
        _metadata_bytes(csv_bytes),
        code="HISTORICAL_CSV_LIMIT",
    )


def test_newline_dense_record_limit_scan_has_bounded_validation_memory() -> None:
    csv_bytes = (CSV_HEADER + "\n").encode() + (b"\n" * (2 * 1024 * 1024))
    metadata_bytes = _metadata_bytes(csv_bytes)
    error_code: str | None = None

    tracing_was_active = tracemalloc.is_tracing()
    if not tracing_was_active:
        tracemalloc.start()
    tracemalloc.reset_peak()
    baseline_bytes, _ = tracemalloc.get_traced_memory()
    try:
        try:
            validate_historical_source(csv_bytes, metadata_bytes, now_ns=NOW_NS)
        except HistoricalSourceInvalid as error:
            error_code = error.code
        _, peak_bytes = tracemalloc.get_traced_memory()
    finally:
        if not tracing_was_active:
            tracemalloc.stop()

    assert error_code == "HISTORICAL_CSV_LIMIT"
    validation_peak_bytes = peak_bytes - baseline_bytes
    assert validation_peak_bytes < 8 * 1024 * 1024, validation_peak_bytes


def test_99999_physical_records_are_below_the_record_limit() -> None:
    row = b"0,1,1,1,1,1,1,0\n"
    csv_bytes = (CSV_HEADER + "\n").encode() + (row * 99_999)
    metadata_bytes = _metadata_bytes(
        csv_bytes,
        mutate=lambda metadata: (
            metadata["source"].update(retrieved_at_ns="1"),
            metadata.update(timeframe_ns="1"),
            metadata["instrument"].update(
                price_precision=0,
                size_precision=0,
                price_increment="1",
                size_increment="1",
                minimum_quantity="1",
            ),
        ),
    )

    _assert_invalid(
        csv_bytes,
        metadata_bytes,
        code="HISTORICAL_SEQUENCE_INVALID",
        line=3,
        now_ns=1,
    )


@pytest.mark.parametrize(
    ("csv_bytes", "code", "line"),
    [
        (b"not-the-header\n" + (b"\n" * 100_000), "HISTORICAL_HEADER_INVALID", 1),
        (
            (CSV_HEADER + "\n").encode() + (b"\n" * 100_000) + b"\xff",
            "HISTORICAL_CSV_INVALID",
            None,
        ),
        (
            (CSV_HEADER + "\n").encode() + (b"\n" * 100_000) + b"\r",
            "HISTORICAL_CSV_INVALID",
            None,
        ),
    ],
    ids=["header-before-row-limit", "utf8-before-row-limit", "bare-cr-before-row-limit"],
)
def test_csv_error_priority_is_preserved_before_record_limit(
    csv_bytes: bytes,
    code: str,
    line: int | None,
) -> None:
    _assert_invalid(
        csv_bytes,
        _metadata_bytes(csv_bytes),
        code=code,
        line=line,
    )


@pytest.mark.parametrize(
    "header",
    [
        "open_time_ns,close_time_ns,available_time_ns,open,high,low,close",
        f"{CSV_HEADER},trade_count",
        "open_time_ns,close_time_ns,available_time_ns,open,high,low,close,close",
        "close_time_ns,open_time_ns,available_time_ns,open,high,low,close,volume",
    ],
    ids=["missing", "extra", "duplicate", "swapped"],
)
def test_header_must_be_exact(header: str) -> None:
    csv_bytes = (header + "\n" + ",".join(VALID_ROWS[0]) + "\n").encode()

    _assert_invalid(
        csv_bytes,
        _metadata_bytes(csv_bytes),
        code="HISTORICAL_HEADER_INVALID",
        line=1,
    )


@pytest.mark.parametrize(
    ("row_text", "line"),
    [
        (",".join(VALID_ROWS[0][:-1]), 2),
        (",".join((*VALID_ROWS[0], "extra")), 2),
        ("", 2),
        (
            f'{FIRST_OPEN_NS},{FIRST_CLOSE_NS},{FIRST_CLOSE_NS},"100.00,110.00,90.00,105.00,100.000',
            2,
        ),
    ],
    ids=["missing-cell", "extra-cell", "blank-row", "malformed-quoting"],
)
def test_malformed_physical_rows_are_rejected_without_repair(
    row_text: str,
    line: int,
) -> None:
    csv_bytes = f"{CSV_HEADER}\n{row_text}\n".encode()

    _assert_invalid(
        csv_bytes,
        _metadata_bytes(csv_bytes),
        code="HISTORICAL_ROW_INVALID",
        line=line,
    )


def test_embedded_newline_field_is_rejected_at_its_first_physical_line() -> None:
    csv_bytes = (
        f"{CSV_HEADER}\n"
        f'{FIRST_OPEN_NS},{FIRST_CLOSE_NS},{FIRST_CLOSE_NS},"100.\n'
        '00",110.00,90.00,105.00,100.000\n'
    ).encode()

    _assert_invalid(
        csv_bytes,
        _metadata_bytes(csv_bytes),
        code="HISTORICAL_ROW_INVALID",
        line=2,
    )


@pytest.mark.parametrize(
    "csv_bytes",
    [
        (CSV_HEADER + "\n").encode() + b"\xff\n",
        (CSV_HEADER + "\r").encode() + (",".join(VALID_ROWS[0]) + "\r").encode(),
    ],
    ids=["non-utf8", "bare-cr"],
)
def test_invalid_csv_encoding_or_line_endings_fail_closed(csv_bytes: bytes) -> None:
    _assert_invalid(
        csv_bytes,
        _metadata_bytes(csv_bytes),
        code="HISTORICAL_CSV_INVALID",
    )


@pytest.mark.parametrize(
    ("column", "value"),
    [
        ("open_time_ns", "01700000000000000000"),
        ("open_time_ns", "-1"),
        ("open_time_ns", "1e18"),
        ("open_time_ns", str(U64_MAX + 1)),
        ("open_time_ns", str(FIRST_CLOSE_NS)),
        ("close_time_ns", str(FIRST_CLOSE_NS + 1)),
        ("available_time_ns", str(FIRST_CLOSE_NS + 1)),
    ],
    ids=[
        "leading-zero",
        "negative",
        "scientific",
        "u64-overflow",
        "open-not-before-close",
        "duration-mismatch",
        "availability-not-close",
    ],
)
def test_row_timestamp_contract_is_strict(column: str, value: str) -> None:
    rows = _with_cell(VALID_ROWS, 0, column, value)
    csv_bytes = _csv_bytes(rows)

    _assert_invalid(
        csv_bytes,
        _metadata_bytes(csv_bytes),
        code="HISTORICAL_TIMESTAMP_INVALID",
        line=2,
    )


def test_future_close_is_rejected() -> None:
    future_open = NOW_NS
    rows = (VALID_ROWS[0], _bar_row(future_open))
    csv_bytes = _csv_bytes(rows)
    metadata_bytes = _metadata_bytes(
        csv_bytes,
        mutate=lambda value: value["source"].update(
            retrieved_at_ns=str(future_open)
        ),
    )

    _assert_invalid(
        csv_bytes,
        metadata_bytes,
        code="HISTORICAL_TIMESTAMP_INVALID",
        line=3,
    )


def test_close_after_declared_acquisition_is_rejected() -> None:
    csv_bytes = _csv_bytes()
    metadata_bytes = _metadata_bytes(
        csv_bytes,
        mutate=lambda value: value["source"].update(
            retrieved_at_ns=str(SECOND_CLOSE_NS - 1)
        ),
    )

    _assert_invalid(
        csv_bytes,
        metadata_bytes,
        code="HISTORICAL_TIMESTAMP_INVALID",
        line=3,
    )


def test_acquisition_after_validation_clock_is_rejected() -> None:
    csv_bytes = _csv_bytes()
    metadata_bytes = _metadata_bytes(
        csv_bytes,
        mutate=lambda value: value["source"].update(retrieved_at_ns=str(NOW_NS + 1)),
    )

    _assert_invalid(
        csv_bytes,
        metadata_bytes,
        code="HISTORICAL_TIMESTAMP_INVALID",
    )


@pytest.mark.parametrize("value", ["060000000000", "-1", "6e10", "0", str(U64_MAX + 1)])
def test_timeframe_is_a_positive_canonical_u64(value: str) -> None:
    csv_bytes = _csv_bytes()
    metadata_bytes = _metadata_bytes(
        csv_bytes,
        mutate=lambda metadata: metadata.update(timeframe_ns=value),
    )

    _assert_invalid(
        csv_bytes,
        metadata_bytes,
        code="HISTORICAL_TIMESTAMP_INVALID",
    )


@pytest.mark.parametrize("now_ns", [True, -1, U64_MAX + 1, "1700000400000000000"])
def test_validation_clock_is_a_strict_native_u64(now_ns: object) -> None:
    csv_bytes = _csv_bytes()

    _assert_invalid(
        csv_bytes,
        _metadata_bytes(csv_bytes),
        code="HISTORICAL_TIMESTAMP_INVALID",
        now_ns=now_ns,
    )


@pytest.mark.parametrize(
    "second_row",
    [
        VALID_ROWS[0],
        _bar_row(FIRST_OPEN_NS - 60_000_000_000),
        _bar_row(FIRST_CLOSE_NS - 1),
        _bar_row(FIRST_CLOSE_NS + 1),
    ],
    ids=["duplicate", "reversed", "overlap", "gap"],
)
def test_sequence_defects_report_first_offending_physical_row(
    second_row: tuple[str, ...],
) -> None:
    csv_bytes = _csv_bytes((VALID_ROWS[0], second_row))

    _assert_invalid(
        csv_bytes,
        _metadata_bytes(csv_bytes),
        code="HISTORICAL_SEQUENCE_INVALID",
        line=3,
    )


@pytest.mark.parametrize(
    ("column", "value", "code"),
    [
        ("open", "1e2", "HISTORICAL_PRICE_INVALID"),
        ("open", "NaN", "HISTORICAL_PRICE_INVALID"),
        ("open", "Infinity", "HISTORICAL_PRICE_INVALID"),
        ("open", "-1.00", "HISTORICAL_PRICE_INVALID"),
        ("open", "0.00", "HISTORICAL_PRICE_INVALID"),
        ("open", "100.0", "HISTORICAL_PRICE_INVALID"),
        ("open", ("9" * 5_000) + ".00", "HISTORICAL_PRICE_INVALID"),
        ("open", "17014118346047.00", "HISTORICAL_PRICE_INVALID"),
        ("volume", "1e2", "HISTORICAL_VOLUME_INVALID"),
        ("volume", "NaN", "HISTORICAL_VOLUME_INVALID"),
        ("volume", "Infinity", "HISTORICAL_VOLUME_INVALID"),
        ("volume", "-1.000", "HISTORICAL_VOLUME_INVALID"),
        ("volume", "100.00", "HISTORICAL_VOLUME_INVALID"),
        ("volume", ("9" * 5_000) + ".000", "HISTORICAL_VOLUME_INVALID"),
        ("volume", "34028236692094.000", "HISTORICAL_VOLUME_INVALID"),
    ],
    ids=[
        "price-scientific",
        "price-nan",
        "price-infinity",
        "price-negative",
        "price-zero",
        "price-precision",
        "price-text-limit",
        "price-native-range",
        "volume-scientific",
        "volume-nan",
        "volume-infinity",
        "volume-negative",
        "volume-precision",
        "volume-text-limit",
        "volume-native-range",
    ],
)
def test_price_and_volume_domains_are_strict(
    column: str,
    value: str,
    code: str,
) -> None:
    rows = _with_cell(VALID_ROWS, 0, column, value)
    csv_bytes = _csv_bytes(rows)

    _assert_invalid(
        csv_bytes,
        _metadata_bytes(csv_bytes),
        code=code,
        line=2,
    )


@pytest.mark.parametrize(
    ("column", "value", "instrument_change", "code"),
    [
        ("open", "100.01", {"price_increment": "0.05"}, "HISTORICAL_PRICE_INVALID"),
        (
            "volume",
            "100.001",
            {"size_increment": "0.010", "minimum_quantity": "0.010"},
            "HISTORICAL_VOLUME_INVALID",
        ),
    ],
    ids=["off-price-tick", "off-volume-step"],
)
def test_values_must_lie_on_declared_integer_grids(
    column: str,
    value: str,
    instrument_change: dict[str, object],
    code: str,
) -> None:
    rows = _with_cell(VALID_ROWS, 0, column, value)
    csv_bytes = _csv_bytes(rows)
    metadata_bytes = _metadata_bytes(
        csv_bytes,
        mutate=lambda metadata: metadata["instrument"].update(instrument_change),
    )

    _assert_invalid(csv_bytes, metadata_bytes, code=code, line=2)


@pytest.mark.parametrize(
    ("column", "value"),
    [
        ("low", "111.00"),
        ("open", "89.00"),
        ("close", "111.00"),
    ],
    ids=["low-above-high", "open-outside", "close-outside"],
)
def test_ohlc_relationships_fail_closed(column: str, value: str) -> None:
    rows = _with_cell(VALID_ROWS, 0, column, value)
    csv_bytes = _csv_bytes(rows)

    _assert_invalid(
        csv_bytes,
        _metadata_bytes(csv_bytes),
        code="HISTORICAL_OHLC_INVALID",
        line=2,
    )


def test_zero_volume_is_valid() -> None:
    rows = _with_cell(VALID_ROWS, 0, "volume", "0.000")
    csv_bytes = _csv_bytes(rows)

    source = validate_historical_source(
        csv_bytes,
        _metadata_bytes(csv_bytes),
        now_ns=NOW_NS,
    )

    assert source.records[0].volume == "0.000"


def test_precision_zero_requires_integer_values() -> None:
    rows = tuple(
        tuple(
            value.split(".", maxsplit=1)[0] if index >= 3 else value
            for index, value in enumerate(row)
        )
        for row in VALID_ROWS
    )
    csv_bytes = _csv_bytes(rows)
    metadata_bytes = _metadata_bytes(
        csv_bytes,
        mutate=lambda metadata: metadata["instrument"].update(
            price_precision=0,
            size_precision=0,
            price_increment="1",
            size_increment="1",
            minimum_quantity="1",
        ),
    )

    source = validate_historical_source(csv_bytes, metadata_bytes, now_ns=NOW_NS)
    assert source.records[0].open == "100"

    invalid_rows = _with_cell(rows, 0, "open", "100.0")
    invalid_csv = _csv_bytes(invalid_rows)
    invalid_metadata = _metadata_bytes(
        invalid_csv,
        mutate=lambda metadata: metadata["instrument"].update(
            price_precision=0,
            size_precision=0,
            price_increment="1",
            size_increment="1",
            minimum_quantity="1",
        ),
    )
    _assert_invalid(
        invalid_csv,
        invalid_metadata,
        code="HISTORICAL_PRICE_INVALID",
        line=2,
    )


def test_maximum_supported_precision_uses_exact_integer_arithmetic() -> None:
    assert FIXED_PRECISION == 16
    rows = tuple(
        tuple(
            value + ("0" * (16 - len(value.partition(".")[2]))) if index >= 3 else value
            for index, value in enumerate(row)
        )
        for row in VALID_ROWS
    )
    csv_bytes = _csv_bytes(rows)
    metadata_bytes = _metadata_bytes(
        csv_bytes,
        mutate=lambda metadata: metadata["instrument"].update(
            price_precision=16,
            size_precision=16,
            price_increment="0.0000000000000001",
            size_increment="0.0000000000000001",
            minimum_quantity="0.0000000000000001",
        ),
    )

    with localcontext() as context:
        context.prec = 1
        source = validate_historical_source(csv_bytes, metadata_bytes, now_ns=NOW_NS)

    assert source.record_count == 2
    assert source.records[0].open == "100.0000000000000000"


@pytest.mark.parametrize(
    ("instrument_change", "case_id"),
    [
        ({"base_currency": "UNKNOWN_CURRENCY"}, "unknown-base"),
        ({"quote_currency": "UNKNOWN_CURRENCY"}, "unknown-quote"),
        ({"quote_currency": "ETH"}, "identical-currencies"),
        ({"price_precision": FIXED_PRECISION + 1}, "price-precision-unsupported"),
        ({"size_precision": FIXED_PRECISION + 1}, "size-precision-unsupported"),
        ({"price_precision": -1}, "price-precision-negative"),
        ({"size_precision": -1}, "size-precision-negative"),
        ({"price_increment": "0.00"}, "zero-price-increment"),
        ({"price_increment": "-0.01"}, "negative-price-increment"),
        ({"size_increment": "0.000"}, "zero-size-increment"),
        ({"size_increment": "-0.001"}, "negative-size-increment"),
        ({"price_increment": "0.001"}, "price-increment-precision"),
        ({"size_increment": "0.01"}, "size-increment-precision"),
        ({"minimum_quantity": "0.000"}, "zero-minimum"),
        (
            {"size_increment": "0.002", "minimum_quantity": "0.003"},
            "minimum-off-step",
        ),
        ({"minimum_quantity": "0.01"}, "minimum-precision"),
        ({"price_increment": "17014118346047.00"}, "price-increment-range"),
        ({"size_increment": "34028236692094.000"}, "size-increment-range"),
    ],
    ids=lambda item: item if isinstance(item, str) else None,
)
def test_instrument_contract_rejects_unsupported_declarations(
    instrument_change: dict[str, object],
    case_id: str,
) -> None:
    del case_id
    csv_bytes = _csv_bytes()
    metadata_bytes = _metadata_bytes(
        csv_bytes,
        mutate=lambda metadata: metadata["instrument"].update(instrument_change),
    )

    _assert_invalid(
        csv_bytes,
        metadata_bytes,
        code="HISTORICAL_INSTRUMENT_INVALID",
    )


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value["source"].pop("origin"),
        lambda value: value.pop("timestamp_mapping"),
        lambda value: value["instrument"].pop("specification_source"),
        lambda value: value["source"].update(name=" \t "),
        lambda value: value["source"].update(origin="\n"),
        lambda value: value.update(timestamp_mapping="   "),
        lambda value: value["instrument"].update(specification_source=""),
        lambda value: value["instrument"].update(market=" "),
        lambda value: value["instrument"].update(raw_symbol=""),
        lambda value: value.update(extra="not allowed"),
        lambda value: value["source"].update(extra="not allowed"),
        lambda value: value["source"].update(name=123),
        lambda value: value["instrument"].update(price_precision="2"),
        lambda value: value["instrument"].update(size_precision=True),
        lambda value: value.update(timeframe_ns=60_000_000_000),
        lambda value: value["source"].update(retrieved_at_ns=RETRIEVED_AT_NS),
        lambda value: value["source"].update(name="x" * 201),
        lambda value: value.update(availability_source="GUESSED"),
        lambda value: value.update(purpose="BACKTEST"),
        lambda value: value["instrument"].update(specification_status="CURRENT_RULES"),
    ],
    ids=[
        "missing-origin",
        "missing-mapping",
        "missing-specification-source",
        "blank-name",
        "blank-origin",
        "blank-mapping",
        "blank-specification-source",
        "blank-market",
        "blank-symbol",
        "extra-root",
        "extra-nested",
        "coerced-name",
        "coerced-price-precision",
        "bool-size-precision",
        "coerced-timeframe",
        "coerced-retrieval",
        "name-too-long",
        "unknown-availability",
        "unknown-purpose",
        "unknown-specification-status",
    ],
)
def test_metadata_shape_types_bounds_and_required_provenance_are_strict(
    mutation: Any,
) -> None:
    csv_bytes = _csv_bytes()

    _assert_invalid(
        csv_bytes,
        _metadata_bytes(csv_bytes, mutate=mutation),
        code="HISTORICAL_METADATA_INVALID",
    )


def test_metadata_duplicate_keys_are_rejected() -> None:
    csv_bytes = _csv_bytes()
    valid = _metadata_bytes(csv_bytes).decode()
    duplicated = valid.replace(
        '"purpose":"SYNTHETIC_QA"',
        '"purpose":"SYNTHETIC_QA","purpose":"SYNTHETIC_QA"',
        1,
    ).encode()
    assert duplicated != valid.encode()

    _assert_invalid(
        csv_bytes,
        duplicated,
        code="HISTORICAL_METADATA_INVALID",
    )


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
def test_metadata_json_constants_are_rejected(constant: str) -> None:
    csv_bytes = _csv_bytes()
    valid = _metadata_bytes(csv_bytes).decode()
    invalid = valid.replace('"price_precision":2', f'"price_precision":{constant}', 1).encode()

    _assert_invalid(
        csv_bytes,
        invalid,
        code="HISTORICAL_METADATA_INVALID",
    )


def test_malformed_metadata_utf8_is_rejected() -> None:
    csv_bytes = _csv_bytes()

    _assert_invalid(
        csv_bytes,
        b'{"schema":"HistoricalBarSource.v1","source":"\xff"}',
        code="HISTORICAL_METADATA_INVALID",
    )


def test_json_escaped_unpaired_surrogate_is_rejected_before_identity_encoding() -> None:
    csv_bytes = _csv_bytes()
    metadata_bytes = _metadata_bytes(csv_bytes).replace(
        b'"Synthetic test bars"',
        b'"\\ud800"',
        1,
    )

    _assert_invalid(
        csv_bytes,
        metadata_bytes,
        code="HISTORICAL_METADATA_INVALID",
    )


def test_declared_raw_digest_must_match_exact_canonical_csv_input() -> None:
    csv_bytes = _csv_bytes()
    metadata_bytes = _metadata_bytes(
        csv_bytes,
        mutate=lambda value: value["source"].update(raw_sha256="0" * 64),
    )

    _assert_invalid(
        csv_bytes,
        metadata_bytes,
        code="HISTORICAL_SOURCE_CHECKSUM_MISMATCH",
    )


def test_stable_errors_do_not_echo_or_chain_raw_user_content() -> None:
    csv_bytes = _csv_bytes()
    credential_like = "sk-live-raw-user-content-must-not-leak"
    metadata = _metadata(csv_bytes)
    metadata["unexpected"] = credential_like
    metadata_bytes = json.dumps(metadata, separators=(",", ":")).encode()

    error = _assert_invalid(
        csv_bytes,
        metadata_bytes,
        code="HISTORICAL_METADATA_INVALID",
    )

    assert credential_like not in str(error)
    assert credential_like not in repr(error)
    assert error.__cause__ is None
    assert error.__context__ is None


def test_non_bytes_inputs_fail_closed_without_coercion() -> None:
    csv_bytes = _csv_bytes()
    metadata_bytes = _metadata_bytes(csv_bytes)

    _assert_invalid(  # type: ignore[arg-type]
        bytearray(csv_bytes),
        metadata_bytes,
        code="HISTORICAL_CSV_INVALID",
    )
    _assert_invalid(  # type: ignore[arg-type]
        csv_bytes,
        bytearray(metadata_bytes),
        code="HISTORICAL_METADATA_INVALID",
    )


def test_test_helpers_do_not_mutate_metadata_between_cases() -> None:
    csv_bytes = _csv_bytes()
    first = _metadata(csv_bytes)
    snapshot = deepcopy(first)
    _metadata_bytes(csv_bytes, mutate=lambda value: value["source"].update(name="changed"))
    assert first == snapshot
