"""Pure, bounded validation for declared historical bar source bytes."""

from __future__ import annotations

import csv
import json
import re
from collections.abc import Iterator
from dataclasses import dataclass
from hashlib import sha256
from typing import Annotated, Literal

from nautilus_trader.model import FIXED_PRECISION, Currency
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StrictStr,
    ValidationError,
    field_validator,
)

from stark_trading_os.audit.canonical_json import canonical_json_bytes

_VALIDATOR_VERSION = "historical-source-v1"
_CSV_BYTE_LIMIT = 32 * 1024 * 1024
_METADATA_BYTE_LIMIT = 64 * 1024
_RECORD_LIMIT = 100_000
_U64_MAX = (2**64) - 1
_U64_MAX_TEXT = str(_U64_MAX)
_HEADER = (
    "open_time_ns",
    "close_time_ns",
    "available_time_ns",
    "open",
    "high",
    "low",
    "close",
    "volume",
)
_HEADER_TEXT = ",".join(_HEADER)
_ASCII_DIGITS = re.compile(r"[0-9]+")
_BARE_CARRIAGE_RETURN = re.compile(r"\r(?!\n)")

# NautilusTrader 2.0.0rc3's pinned FIXED_PRECISION_16 raw domains.  Values are
# checked as scaled integers, so ambient Decimal context cannot round a source.
_NATIVE_PRICE_RAW_MAX = 17_014_118_346_046 * (10**16)
_NATIVE_QUANTITY_RAW_MAX = 34_028_236_692_093 * (10**16)


class HistoricalSourceInvalid(ValueError):
    """Fail-closed historical source error with a stable, content-free surface."""

    code: str
    line: int | None

    def __init__(self, code: str, *, line: int | None = None) -> None:
        self.code = code
        self.line = line
        message = code if line is None else f"{code}:line={line}"
        super().__init__(message)


class _FrozenModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=False,
        serialize_by_alias=True,
        strict=True,
    )


class HistoricalSourceDeclaration(_FrozenModel):
    name: Annotated[StrictStr, Field(min_length=1, max_length=200)]
    origin: Annotated[StrictStr, Field(min_length=1, max_length=2_048)]
    retrieved_at_ns: StrictStr
    raw_sha256: Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]

    @field_validator("name", "origin")
    @classmethod
    def _require_nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("value must be nonblank")
        return value


class HistoricalInstrumentDeclaration(_FrozenModel):
    market: Annotated[StrictStr, Field(min_length=1, max_length=64)]
    raw_symbol: Annotated[StrictStr, Field(min_length=1, max_length=128)]
    base_currency: Annotated[StrictStr, Field(min_length=1, max_length=32)]
    quote_currency: Annotated[StrictStr, Field(min_length=1, max_length=32)]
    price_precision: StrictInt
    size_precision: StrictInt
    price_increment: StrictStr
    size_increment: StrictStr
    minimum_quantity: StrictStr
    specification_source: Annotated[StrictStr, Field(min_length=1, max_length=2_048)]
    specification_status: Literal["EXPLICIT_ASSUMPTION", "HISTORICAL_EVIDENCE"]

    @field_validator(
        "market",
        "raw_symbol",
        "base_currency",
        "quote_currency",
        "specification_source",
    )
    @classmethod
    def _require_nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("value must be nonblank")
        return value


class HistoricalSourceMetadata(_FrozenModel):
    schema_: Literal["HistoricalBarSource.v1"] = Field(alias="schema")
    source: HistoricalSourceDeclaration
    instrument: HistoricalInstrumentDeclaration
    timeframe_ns: StrictStr
    timestamp_mapping: Annotated[StrictStr, Field(min_length=1, max_length=2_048)]
    availability_source: Literal["ASSUMED_AT_CLOSE", "RECORDED_AT_CLOSE"]
    purpose: Literal["SYNTHETIC_QA", "HISTORICAL_MARKET"]

    @field_validator("timestamp_mapping")
    @classmethod
    def _require_nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("value must be nonblank")
        return value


class HistoricalBarRecord(_FrozenModel):
    source_seq: StrictInt
    open_time_ns: StrictStr
    close_time_ns: StrictStr
    available_time_ns: StrictStr
    open: StrictStr
    high: StrictStr
    low: StrictStr
    close: StrictStr
    volume: StrictStr


@dataclass(frozen=True, slots=True)
class HistoricalSource:
    """Validated bytes and records; this is not a published native catalog."""

    source_id: str
    raw_sha256: str
    metadata_sha256: str
    csv_bytes: bytes
    metadata_bytes: bytes
    metadata: HistoricalSourceMetadata
    records: tuple[HistoricalBarRecord, ...]

    @property
    def record_count(self) -> int:
        return len(self.records)


@dataclass(frozen=True, slots=True)
class _InstrumentGrid:
    price_precision: int
    size_precision: int
    price_increment: int
    size_increment: int


def validate_historical_source(
    csv_bytes: bytes,
    metadata_bytes: bytes,
    *,
    now_ns: int,
) -> HistoricalSource:
    """Validate exact in-memory source bytes without reading, repairing, or publishing."""

    if type(csv_bytes) is not bytes:
        raise HistoricalSourceInvalid("HISTORICAL_CSV_INVALID")
    if not csv_bytes or len(csv_bytes) >= _CSV_BYTE_LIMIT:
        raise HistoricalSourceInvalid("HISTORICAL_CSV_LIMIT")
    if type(metadata_bytes) is not bytes:
        raise HistoricalSourceInvalid("HISTORICAL_METADATA_INVALID")
    if not metadata_bytes or len(metadata_bytes) >= _METADATA_BYTE_LIMIT:
        raise HistoricalSourceInvalid("HISTORICAL_METADATA_LIMIT")
    if type(now_ns) is not int or now_ns < 0 or now_ns > _U64_MAX:
        raise HistoricalSourceInvalid("HISTORICAL_TIMESTAMP_INVALID")

    metadata = _parse_metadata(metadata_bytes)
    raw_sha256 = sha256(csv_bytes).hexdigest()
    metadata_sha256 = sha256(metadata_bytes).hexdigest()
    if metadata.source.raw_sha256 != raw_sha256:
        raise HistoricalSourceInvalid("HISTORICAL_SOURCE_CHECKSUM_MISMATCH")

    retrieved_at_ns = _parse_u64_text(metadata.source.retrieved_at_ns)
    timeframe_ns = _parse_u64_text(metadata.timeframe_ns)
    if retrieved_at_ns is None or timeframe_ns is None or timeframe_ns == 0:
        raise HistoricalSourceInvalid("HISTORICAL_TIMESTAMP_INVALID")
    if retrieved_at_ns > now_ns:
        raise HistoricalSourceInvalid("HISTORICAL_TIMESTAMP_INVALID")

    grid = _validate_instrument(metadata.instrument)
    records = _parse_records(
        csv_bytes,
        grid=grid,
        timeframe_ns=timeframe_ns,
        retrieved_at_ns=retrieved_at_ns,
        now_ns=now_ns,
    )
    identity = {
        "validator_version": _VALIDATOR_VERSION,
        "raw_sha256": raw_sha256,
        "metadata_sha256": metadata_sha256,
        "metadata": metadata.model_dump(mode="json", by_alias=True),
        "records": [record.model_dump(mode="json") for record in records],
    }
    source_id = sha256(canonical_json_bytes(identity)).hexdigest()
    return HistoricalSource(
        source_id=source_id,
        raw_sha256=raw_sha256,
        metadata_sha256=metadata_sha256,
        csv_bytes=csv_bytes,
        metadata_bytes=metadata_bytes,
        metadata=metadata,
        records=records,
    )


def _parse_metadata(raw: bytes) -> HistoricalSourceMetadata:
    parsed: object | None = None
    parse_ok = False
    try:
        text = raw.decode("utf-8")
        parsed = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_pairs,
            parse_constant=_reject_json_constant,
        )
        parse_ok = type(parsed) is dict
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError):
        pass
    if not parse_ok:
        raise HistoricalSourceInvalid("HISTORICAL_METADATA_INVALID")

    metadata: HistoricalSourceMetadata | None = None
    try:
        metadata = HistoricalSourceMetadata.model_validate(parsed)
    except ValidationError:
        pass
    if metadata is None:
        raise HistoricalSourceInvalid("HISTORICAL_METADATA_INVALID")
    return metadata


def _reject_duplicate_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_json_constant(_: str) -> object:
    raise ValueError("non-finite JSON constant")


def _validate_instrument(
    instrument: HistoricalInstrumentDeclaration,
) -> _InstrumentGrid:
    if (
        instrument.price_precision < 0
        or instrument.price_precision > FIXED_PRECISION
        or instrument.size_precision < 0
        or instrument.size_precision > FIXED_PRECISION
        or instrument.base_currency == instrument.quote_currency
    ):
        raise HistoricalSourceInvalid("HISTORICAL_INSTRUMENT_INVALID")

    currencies_valid = True
    for code in (instrument.base_currency, instrument.quote_currency):
        try:
            Currency.from_str(code, strict=True)
        except (KeyError, RuntimeError, ValueError):
            currencies_valid = False
    if not currencies_valid:
        raise HistoricalSourceInvalid("HISTORICAL_INSTRUMENT_INVALID")

    price_increment = _parse_fixed(
        instrument.price_increment,
        precision=instrument.price_precision,
        native_raw_max=_NATIVE_PRICE_RAW_MAX,
        allow_zero=False,
    )
    size_increment = _parse_fixed(
        instrument.size_increment,
        precision=instrument.size_precision,
        native_raw_max=_NATIVE_QUANTITY_RAW_MAX,
        allow_zero=False,
    )
    minimum_quantity = _parse_fixed(
        instrument.minimum_quantity,
        precision=instrument.size_precision,
        native_raw_max=_NATIVE_QUANTITY_RAW_MAX,
        allow_zero=False,
    )
    if (
        price_increment is None
        or size_increment is None
        or minimum_quantity is None
        or minimum_quantity % size_increment != 0
    ):
        raise HistoricalSourceInvalid("HISTORICAL_INSTRUMENT_INVALID")
    return _InstrumentGrid(
        price_precision=instrument.price_precision,
        size_precision=instrument.size_precision,
        price_increment=price_increment,
        size_increment=size_increment,
    )


def _parse_records(
    raw: bytes,
    *,
    grid: _InstrumentGrid,
    timeframe_ns: int,
    retrieved_at_ns: int,
    now_ns: int,
) -> tuple[HistoricalBarRecord, ...]:
    text: str | None = None
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    if text is None:
        raise HistoricalSourceInvalid("HISTORICAL_CSV_INVALID")

    if _BARE_CARRIAGE_RETURN.search(text) is not None:
        raise HistoricalSourceInvalid("HISTORICAL_CSV_INVALID")

    first_newline = text.find("\n")
    header_end = len(text) if first_newline < 0 else first_newline
    if header_end > 0 and text[header_end - 1] == "\r":
        header_end -= 1
    if header_end != len(_HEADER_TEXT) or not text.startswith(_HEADER_TEXT):
        raise HistoricalSourceInvalid("HISTORICAL_HEADER_INVALID", line=1)

    physical_line_count = text.count("\n") + (0 if text.endswith("\n") else 1)
    record_count = physical_line_count - 1
    if record_count >= _RECORD_LIMIT:
        raise HistoricalSourceInvalid("HISTORICAL_CSV_LIMIT")
    if record_count <= 0:
        raise HistoricalSourceInvalid("HISTORICAL_ROW_INVALID")

    records: list[HistoricalBarRecord] = []
    prior_close_ns: int | None = None
    data_start = len(text) if first_newline < 0 else first_newline + 1
    for source_seq, raw_line in enumerate(
        _iter_physical_lines(text, start=data_start),
        start=1,
    ):
        line = source_seq + 1
        row = _parse_physical_row(raw_line)
        if row is None or len(row) != len(_HEADER):
            raise HistoricalSourceInvalid("HISTORICAL_ROW_INVALID", line=line)

        open_time_ns = _parse_u64_text(row[0])
        close_time_ns = _parse_u64_text(row[1])
        available_time_ns = _parse_u64_text(row[2])
        if (
            open_time_ns is None
            or close_time_ns is None
            or available_time_ns is None
            or open_time_ns >= close_time_ns
            or close_time_ns - open_time_ns != timeframe_ns
            or available_time_ns != close_time_ns
            or close_time_ns > retrieved_at_ns
            or close_time_ns > now_ns
        ):
            raise HistoricalSourceInvalid("HISTORICAL_TIMESTAMP_INVALID", line=line)
        if prior_close_ns is not None and open_time_ns != prior_close_ns:
            raise HistoricalSourceInvalid("HISTORICAL_SEQUENCE_INVALID", line=line)

        price_values: list[int] = []
        for value in row[3:7]:
            parsed_price = _parse_fixed(
                value,
                precision=grid.price_precision,
                native_raw_max=_NATIVE_PRICE_RAW_MAX,
                allow_zero=False,
            )
            if parsed_price is None or parsed_price % grid.price_increment != 0:
                raise HistoricalSourceInvalid("HISTORICAL_PRICE_INVALID", line=line)
            price_values.append(parsed_price)
        volume = _parse_fixed(
            row[7],
            precision=grid.size_precision,
            native_raw_max=_NATIVE_QUANTITY_RAW_MAX,
            allow_zero=True,
        )
        if volume is None or volume % grid.size_increment != 0:
            raise HistoricalSourceInvalid("HISTORICAL_VOLUME_INVALID", line=line)

        open_price, high, low, close_price = price_values
        if low > high or not (low <= open_price <= high) or not (
            low <= close_price <= high
        ):
            raise HistoricalSourceInvalid("HISTORICAL_OHLC_INVALID", line=line)

        records.append(
            HistoricalBarRecord(
                source_seq=source_seq,
                open_time_ns=row[0],
                close_time_ns=row[1],
                available_time_ns=row[2],
                open=row[3],
                high=row[4],
                low=row[5],
                close=row[6],
                volume=row[7],
            )
        )
        prior_close_ns = close_time_ns
    return tuple(records)


def _iter_physical_lines(text: str, *, start: int) -> Iterator[str]:
    while start < len(text):
        newline = text.find("\n", start)
        if newline < 0:
            line_end = len(text)
            next_start = len(text)
        else:
            line_end = newline
            next_start = newline + 1
        if line_end > start and text[line_end - 1] == "\r":
            line_end -= 1
        yield text[start:line_end]
        start = next_start


def _parse_physical_row(raw_line: str) -> list[str] | None:
    parsed: list[list[str]] | None = None
    try:
        parsed = list(csv.reader([raw_line], strict=True))
    except csv.Error:
        pass
    if parsed is None or len(parsed) != 1:
        return None
    return parsed[0]


def _parse_u64_text(value: str) -> int | None:
    if (
        type(value) is not str
        or not value
        or len(value) > len(_U64_MAX_TEXT)
        or _ASCII_DIGITS.fullmatch(value) is None
        or (len(value) > 1 and value.startswith("0"))
        or (len(value) == len(_U64_MAX_TEXT) and value > _U64_MAX_TEXT)
    ):
        return None
    return int(value)


def _parse_fixed(
    value: str,
    *,
    precision: int,
    native_raw_max: int,
    allow_zero: bool,
) -> int | None:
    # The native maxima have fourteen whole-number digits.  Apply this bound
    # before regex or int conversion so hostile decimal strings stay cheap.
    maximum_length = 14 if precision == 0 else 15 + precision
    if type(value) is not str or not value or len(value) > maximum_length:
        return None
    whole, separator, fraction = value.partition(".")
    if (
        _ASCII_DIGITS.fullmatch(whole) is None
        or (len(whole) > 1 and whole.startswith("0"))
        or (
            precision == 0
            and (separator != "" or fraction != "")
        )
        or (
            precision > 0
            and (
                separator != "."
                or len(fraction) != precision
                or _ASCII_DIGITS.fullmatch(fraction) is None
            )
        )
    ):
        return None
    digits = whole if precision == 0 else whole + fraction
    scaled_value = int(digits)
    if scaled_value == 0 and not allow_zero:
        return None
    native_raw = scaled_value * (10 ** (FIXED_PRECISION - precision))
    if native_raw > native_raw_max:
        return None
    return scaled_value
