"""Strict v2 mapping between validated historical bytes and native bar catalogs."""

from __future__ import annotations

import os
import stat
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from hashlib import sha256
from pathlib import Path, PurePosixPath
from typing import Annotated, Literal

from nautilus_trader.model import (
    AggregationSource,
    Bar,
    BarAggregation,
    BarSpecification,
    BarType,
    Currency,
    CurrencyPair,
    InstrumentId,
    Price,
    PriceType,
    Quantity,
    Symbol,
    Venue,
)
from nautilus_trader.persistence import ParquetDataCatalog
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, ValidationError

from stark_trading_os.audit.canonical_json import (
    CanonicalJSONError,
    canonical_json_bytes,
    parse_json_object,
)
from stark_trading_os.catalog.historical_source import (
    HistoricalSource,
    HistoricalSourceMetadata,
    validate_historical_source,
)
from stark_trading_os.domain.models import CatalogFileV1, CatalogNativeFingerprintV1

type Sha256Digest = Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]
type HistoricalCatalogNanoseconds = Annotated[StrictStr, Field(pattern=r"^(0|[1-9][0-9]*)$")]

_NATIVE_SYMBOL_PREFIX = "HIST"
_NATIVE_SYMBOL_DIGEST_LENGTH = 20
_NATIVE_VENUE: Literal["SIM"] = "SIM"
_SOURCE_CSV_PATH = "source/bars.csv"
_SOURCE_METADATA_PATH = "source/source.json"
_CANONICAL_WRAPPER_PREFIX = b'{"value":'
_TIME_UNITS: tuple[tuple[BarAggregation, int], ...] = (
    (BarAggregation.WEEK, 604_800_000_000_000),
    (BarAggregation.DAY, 86_400_000_000_000),
    (BarAggregation.HOUR, 3_600_000_000_000),
    (BarAggregation.MINUTE, 60_000_000_000),
    (BarAggregation.SECOND, 1_000_000_000),
    (BarAggregation.MILLISECOND, 1_000_000),
)


class HistoricalCatalogInvalid(ValueError):
    """Stable v2 source/native contract failure."""

    code: str

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class _FrozenModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=False,
        serialize_by_alias=True,
        strict=True,
    )


class CatalogInstrumentV2(_FrozenModel):
    schema_: Literal["CatalogInstrument.v2"] = Field(alias="schema")
    instrument_id: Annotated[StrictStr, Field(pattern=r"^HIST[0-9A-F]{20}\.SIM$")]
    native_symbol: Annotated[StrictStr, Field(pattern=r"^HIST[0-9A-F]{20}$")]
    venue: Literal["SIM"]
    source_market: StrictStr
    source_raw_symbol: StrictStr
    base_currency: StrictStr
    quote_currency: StrictStr
    price_precision: Annotated[StrictInt, Field(ge=0, le=16)]
    size_precision: Annotated[StrictInt, Field(ge=0, le=16)]
    price_increment: StrictStr
    size_increment: StrictStr
    minimum_quantity: StrictStr
    margin_init: Literal["0"]
    margin_maint: Literal["0"]
    maker_fee: Literal["0"]
    taker_fee: Literal["0"]
    fee_semantics: Literal["STRUCTURAL_ZERO_NOT_EXECUTION_COST"]
    ts_event_ns: HistoricalCatalogNanoseconds
    ts_init_ns: HistoricalCatalogNanoseconds


class CatalogBarValueV2(_FrozenModel):
    open: StrictStr
    high: StrictStr
    low: StrictStr
    close: StrictStr
    volume: StrictStr
    ts_event: HistoricalCatalogNanoseconds
    ts_init: HistoricalCatalogNanoseconds


class CatalogReadbackV2(_FrozenModel):
    schema_: Literal["CatalogReadback.v2"] = Field(alias="schema")
    instrument: CatalogInstrumentV2
    bar_type: StrictStr
    bar_count: Annotated[StrictInt, Field(gt=0)]
    first_ts_event: HistoricalCatalogNanoseconds
    last_ts_event: HistoricalCatalogNanoseconds
    first_ts_init: HistoricalCatalogNanoseconds
    last_ts_init: HistoricalCatalogNanoseconds
    first_bar: CatalogBarValueV2
    last_bar: CatalogBarValueV2
    bar_values_sha256: Sha256Digest
    data_types: tuple[Literal["bars"], Literal["instruments"]]


class CatalogMappingV2(_FrozenModel):
    schema_: Literal["CatalogMapping.v2"] = Field(alias="schema")
    event_timestamp: Literal["close_time_ns -> Bar.ts_event"]
    availability_timestamp: Literal["available_time_ns -> Bar.ts_init"]
    interval: Literal["[open_time_ns, close_time_ns)"]
    price_type: Literal["LAST"]
    aggregation_source: Literal["EXTERNAL"]
    source_identity: Literal["fresh sidecar validation -> source_id"]
    execution_cost_boundary: Literal[
        "instrument zero fees are structural; run costs require later bound configuration"
    ]


class CatalogWindowV2(_FrozenModel):
    first_open_ns: HistoricalCatalogNanoseconds
    first_close_ns: HistoricalCatalogNanoseconds
    last_open_ns: HistoricalCatalogNanoseconds
    last_close_ns: HistoricalCatalogNanoseconds
    first_available_ns: HistoricalCatalogNanoseconds
    last_available_ns: HistoricalCatalogNanoseconds


class CatalogFileSetV2(_FrozenModel):
    schema_: Literal["CatalogFileSet.v2"] = Field(alias="schema")
    catalog_files: tuple[CatalogFileV1, ...]


class CatalogInventoryV2(_FrozenModel):
    schema_: Literal["CatalogInventory.v2"] = Field(alias="schema")
    source_id: Sha256Digest
    raw_sha256: Sha256Digest
    metadata_sha256: Sha256Digest
    metadata: HistoricalSourceMetadata
    record_count: Annotated[StrictInt, Field(gt=0, lt=100_000)]
    timeframe_ns: HistoricalCatalogNanoseconds
    window: CatalogWindowV2
    catalog_checksum: Sha256Digest
    catalog_files: tuple[CatalogFileV1, ...]
    source_files: tuple[CatalogFileV1, CatalogFileV1]
    native_returned_files: tuple[CatalogFileV1, ...]
    instrument: CatalogInstrumentV2
    bar_type: StrictStr
    readback: CatalogReadbackV2
    mapping: CatalogMappingV2
    native_fingerprint: CatalogNativeFingerprintV1
    source_validation: Literal["FRESH_BOUNDED_SIDECAR_REVALIDATION"]


class CatalogManifestV2(_FrozenModel):
    schema_: Literal["CatalogManifest.v2"] = Field(alias="schema")
    source_id: Sha256Digest
    label: Literal["HISTORICAL BAR SOURCE"]
    raw_sha256: Sha256Digest
    metadata_sha256: Sha256Digest
    catalog_checksum: Sha256Digest
    inventory_hash: Sha256Digest
    inventory: CatalogInventoryV2


class CatalogValidatedAuditV2(_FrozenModel):
    schema_: Literal["CatalogValidatedAudit.v2"] = Field(alias="schema")
    action: Literal["catalog.validated"]
    source_id: Sha256Digest
    catalog_revision: Sha256Digest
    inventory_hash: Sha256Digest
    raw_sha256: Sha256Digest
    metadata_sha256: Sha256Digest
    catalog_checksum: Sha256Digest


@dataclass(frozen=True, slots=True)
class HistoricalNativeBuild:
    instrument: CatalogInstrumentV2
    bar_type: str
    returned_paths: tuple[str, ...]
    readback: CatalogReadbackV2
    mapping: CatalogMappingV2


def canonical_historical_bytes(value: BaseModel | Mapping[str, object]) -> bytes:
    """Use CanonicalJSON.v1 encoding without registering v2 in the v1 schema table."""

    payload = (
        value.model_dump(mode="json", by_alias=True) if isinstance(value, BaseModel) else value
    )
    wrapped = canonical_json_bytes({"value": payload})
    if not wrapped.startswith(_CANONICAL_WRAPPER_PREFIX) or not wrapped.endswith(b"}"):
        raise HistoricalCatalogInvalid("HISTORICAL_CANONICAL_INVALID")
    return wrapped[len(_CANONICAL_WRAPPER_PREFIX) : -1]


def parse_historical_model_bytes[ModelT: BaseModel](
    raw: bytes,
    model: type[ModelT],
) -> ModelT:
    if type(raw) is not bytes:
        raise HistoricalCatalogInvalid("HISTORICAL_CANONICAL_INVALID")
    try:
        wrapper = parse_json_object(_CANONICAL_WRAPPER_PREFIX + raw + b"}")
        parsed = wrapper["value"]
        if type(parsed) is not dict:
            raise HistoricalCatalogInvalid("HISTORICAL_CANONICAL_INVALID")
        # Strict models accept JSON arrays for tuple fields while still rejecting
        # Python-list coercion. The wrapper parse above owns duplicate-key rejection.
        validated = model.model_validate_json(raw)
        if canonical_historical_bytes(validated) != raw:
            raise HistoricalCatalogInvalid("HISTORICAL_CANONICAL_INVALID")
        return validated
    except HistoricalCatalogInvalid:
        raise
    except (CanonicalJSONError, KeyError, ValidationError, ValueError) as error:
        raise HistoricalCatalogInvalid("HISTORICAL_CANONICAL_INVALID") from error


def parse_historical_manifest_bytes(raw: bytes) -> CatalogManifestV2:
    try:
        return parse_historical_model_bytes(raw, CatalogManifestV2)
    except HistoricalCatalogInvalid as error:
        raise HistoricalCatalogInvalid("CATALOG_MANIFEST_INVALID") from error


def catalog_schema_from_bytes(raw: bytes) -> str:
    """Read only an exact canonical catalog discriminator without widening v1."""

    if type(raw) is not bytes:
        raise HistoricalCatalogInvalid("HISTORICAL_CANONICAL_INVALID")
    try:
        wrapper = parse_json_object(_CANONICAL_WRAPPER_PREFIX + raw + b"}")
        parsed = wrapper["value"]
        if type(parsed) is not dict or canonical_historical_bytes(parsed) != raw:
            raise HistoricalCatalogInvalid("HISTORICAL_CANONICAL_INVALID")
        schema = parsed.get("schema")
        if type(schema) is not str:
            raise HistoricalCatalogInvalid("HISTORICAL_CANONICAL_INVALID")
        return schema
    except HistoricalCatalogInvalid:
        raise
    except (CanonicalJSONError, KeyError, ValueError) as error:
        raise HistoricalCatalogInvalid("HISTORICAL_CANONICAL_INVALID") from error


def validate_historical_source_object(
    source: HistoricalSource,
    *,
    now_ns: int,
) -> HistoricalSource:
    """Revalidate retained bytes and compare every frozen field before native use."""

    if type(source) is not HistoricalSource:
        raise HistoricalCatalogInvalid("HISTORICAL_SOURCE_FORGED")
    try:
        validated = validate_historical_source(
            source.csv_bytes,
            source.metadata_bytes,
            now_ns=now_ns,
        )
    except (TypeError, ValueError) as error:
        raise HistoricalCatalogInvalid("HISTORICAL_SOURCE_FORGED") from error
    if validated != source:
        raise HistoricalCatalogInvalid("HISTORICAL_SOURCE_FORGED")
    return validated


def native_bar_specification(timeframe_ns: str) -> BarSpecification:
    if (
        type(timeframe_ns) is not str
        or not timeframe_ns
        or not timeframe_ns.isascii()
        or not timeframe_ns.isdigit()
        or (len(timeframe_ns) > 1 and timeframe_ns.startswith("0"))
    ):
        raise HistoricalCatalogInvalid("HISTORICAL_TIMEFRAME_UNSUPPORTED")
    value = int(timeframe_ns)
    for aggregation, unit_ns in _TIME_UNITS:
        if value == 0 or value % unit_ns != 0:
            continue
        step = value // unit_ns
        try:
            specification = BarSpecification(step, aggregation, PriceType.LAST)
            interval_ns = specification.get_interval_ns()
        except (OverflowError, RuntimeError, ValueError):
            continue
        if interval_ns == value:
            return specification
    raise HistoricalCatalogInvalid("HISTORICAL_TIMEFRAME_UNSUPPORTED")


def historical_bar_type(instrument_id: str, timeframe_ns: str) -> str:
    """Recompute the exact pinned external LAST BarType contract."""

    if type(instrument_id) is not str:
        raise HistoricalCatalogInvalid("HISTORICAL_INSTRUMENT_UNSUPPORTED")
    try:
        parsed_instrument = InstrumentId.from_str(instrument_id)
    except (KeyError, RuntimeError, ValueError) as error:
        raise HistoricalCatalogInvalid("HISTORICAL_INSTRUMENT_UNSUPPORTED") from error
    if str(parsed_instrument) != instrument_id:
        raise HistoricalCatalogInvalid("HISTORICAL_INSTRUMENT_UNSUPPORTED")
    specification = native_bar_specification(timeframe_ns)
    try:
        bar_type = BarType(parsed_instrument, specification, AggregationSource.EXTERNAL)
        round_tripped = BarType.from_str(str(bar_type))
    except (KeyError, RuntimeError, ValueError) as error:
        raise HistoricalCatalogInvalid("HISTORICAL_BAR_TYPE_UNSUPPORTED") from error
    if str(round_tripped) != str(bar_type):
        raise HistoricalCatalogInvalid("HISTORICAL_BAR_TYPE_UNSUPPORTED")
    return str(bar_type)


def build_historical_native(
    catalog_root: Path,
    source: HistoricalSource,
    *,
    now_ns: int,
) -> HistoricalNativeBuild:
    trusted = validate_historical_source_object(source, now_ns=now_ns)
    _require_private_native_root(catalog_root)
    digest_symbol = trusted.source_id[:_NATIVE_SYMBOL_DIGEST_LENGTH].upper()
    native_symbol = f"{_NATIVE_SYMBOL_PREFIX}{digest_symbol}"
    instrument_id = InstrumentId(Symbol(native_symbol), Venue(_NATIVE_VENUE))
    if str(InstrumentId.from_str(str(instrument_id))) != str(instrument_id):
        raise HistoricalCatalogInvalid("HISTORICAL_INSTRUMENT_UNSUPPORTED")
    bar_type_text = historical_bar_type(
        str(instrument_id),
        trusted.metadata.timeframe_ns,
    )
    bar_type = BarType.from_str(bar_type_text)

    declaration = trusted.metadata.instrument
    first = trusted.records[0]
    instrument_contract = CatalogInstrumentV2(
        schema="CatalogInstrument.v2",
        instrument_id=str(instrument_id),
        native_symbol=native_symbol,
        venue=_NATIVE_VENUE,
        source_market=declaration.market,
        source_raw_symbol=declaration.raw_symbol,
        base_currency=declaration.base_currency,
        quote_currency=declaration.quote_currency,
        price_precision=declaration.price_precision,
        size_precision=declaration.size_precision,
        price_increment=declaration.price_increment,
        size_increment=declaration.size_increment,
        minimum_quantity=declaration.minimum_quantity,
        margin_init="0",
        margin_maint="0",
        maker_fee="0",
        taker_fee="0",
        fee_semantics="STRUCTURAL_ZERO_NOT_EXECUTION_COST",
        ts_event_ns=first.close_time_ns,
        ts_init_ns=first.available_time_ns,
    )
    try:
        native_instrument = _native_instrument(instrument_contract)
        bars = tuple(
            Bar(
                bar_type,
                Price.from_str(record.open),
                Price.from_str(record.high),
                Price.from_str(record.low),
                Price.from_str(record.close),
                Quantity.from_str(record.volume),
                int(record.close_time_ns),
                int(record.available_time_ns),
            )
            for record in trusted.records
        )
        writer = ParquetDataCatalog(str(catalog_root))
        instrument_paths = writer.write_instruments([native_instrument])
        bar_path = writer.write_bars(bars)
    except HistoricalCatalogInvalid:
        raise
    except Exception as error:
        raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_WRITE_FAILED") from error
    returned_paths = tuple(instrument_paths) + (bar_path,)
    _validate_native_returned_paths(catalog_root, returned_paths)
    readback = readback_historical_native(
        catalog_root,
        trusted,
        instrument_contract,
        bar_type_text,
    )
    return HistoricalNativeBuild(
        instrument=instrument_contract,
        bar_type=bar_type_text,
        returned_paths=returned_paths,
        readback=readback,
        mapping=CatalogMappingV2(
            schema="CatalogMapping.v2",
            event_timestamp="close_time_ns -> Bar.ts_event",
            availability_timestamp="available_time_ns -> Bar.ts_init",
            interval="[open_time_ns, close_time_ns)",
            price_type="LAST",
            aggregation_source="EXTERNAL",
            source_identity="fresh sidecar validation -> source_id",
            execution_cost_boundary=(
                "instrument zero fees are structural; run costs require later bound configuration"
            ),
        ),
    )


def readback_historical_native(
    catalog_root: Path,
    source: HistoricalSource,
    instrument: CatalogInstrumentV2,
    bar_type: str,
) -> CatalogReadbackV2:
    try:
        reader = ParquetDataCatalog(str(catalog_root))
        data_types = tuple(reader.list_data_types())
        if data_types != ("bars", "instruments"):
            raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_DATA_TYPES_MISMATCH")
        instruments = reader.instruments()
        bars = reader.query_bars()
        if len(instruments) != 1 or len(bars) != source.record_count:
            raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_COUNT_MISMATCH")
        native_instrument = instruments[0]
        if not isinstance(native_instrument, CurrencyPair):
            raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_INSTRUMENT_MISMATCH")
        _verify_native_instrument(native_instrument, instrument)
        values: list[CatalogBarValueV2] = []
        for native_bar, record in zip(bars, source.records, strict=True):
            value = _bar_value(native_bar)
            if (
                str(native_bar.bar_type) != bar_type
                or value.open != record.open
                or value.high != record.high
                or value.low != record.low
                or value.close != record.close
                or value.volume != record.volume
                or value.ts_event != record.close_time_ns
                or value.ts_init != record.available_time_ns
            ):
                raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_BAR_MISMATCH")
            values.append(value)
        first_timestamp = reader.query_first_timestamp("bars", bar_type)
        last_timestamp = reader.query_last_timestamp("bars", bar_type)
        if first_timestamp != int(source.records[0].available_time_ns) or last_timestamp != int(
            source.records[-1].available_time_ns
        ):
            raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_TIMESTAMP_MISMATCH")
        digest = sha256(
            canonical_historical_bytes(
                {"bars": [value.model_dump(mode="json", by_alias=True) for value in values]}
            )
        ).hexdigest()
        return CatalogReadbackV2(
            schema="CatalogReadback.v2",
            instrument=instrument,
            bar_type=bar_type,
            bar_count=len(values),
            first_ts_event=values[0].ts_event,
            last_ts_event=values[-1].ts_event,
            first_ts_init=values[0].ts_init,
            last_ts_init=values[-1].ts_init,
            first_bar=values[0],
            last_bar=values[-1],
            bar_values_sha256=digest,
            data_types=("bars", "instruments"),
        )
    except HistoricalCatalogInvalid:
        raise
    except Exception as error:
        raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_READBACK_FAILED") from error


def source_sidecar_paths() -> tuple[str, str]:
    return (_SOURCE_CSV_PATH, _SOURCE_METADATA_PATH)


def _native_instrument(contract: CatalogInstrumentV2) -> CurrencyPair:
    instrument_id = InstrumentId.from_str(contract.instrument_id)
    return CurrencyPair(
        instrument_id=instrument_id,
        raw_symbol=Symbol(contract.native_symbol),
        base_currency=Currency.from_str(contract.base_currency, strict=True),
        quote_currency=Currency.from_str(contract.quote_currency, strict=True),
        price_precision=contract.price_precision,
        size_precision=contract.size_precision,
        price_increment=Price.from_str(contract.price_increment),
        size_increment=Quantity.from_str(contract.size_increment),
        ts_event=int(contract.ts_event_ns),
        ts_init=int(contract.ts_init_ns),
        min_quantity=Quantity.from_str(contract.minimum_quantity),
        min_notional=None,
        margin_init=Decimal("0"),
        margin_maint=Decimal("0"),
        maker_fee=Decimal("0"),
        taker_fee=Decimal("0"),
    )


def _verify_native_instrument(
    native: CurrencyPair,
    expected: CatalogInstrumentV2,
) -> None:
    comparisons = (
        str(native.id) == expected.instrument_id,
        str(native.raw_symbol) == expected.native_symbol,
        str(native.id.venue) == expected.venue,
        str(native.base_currency) == expected.base_currency,
        str(native.quote_currency) == expected.quote_currency,
        native.price_precision == expected.price_precision,
        native.size_precision == expected.size_precision,
        str(native.price_increment) == expected.price_increment,
        str(native.size_increment) == expected.size_increment,
        str(native.min_quantity) == expected.minimum_quantity,
        Decimal(native.margin_init) == Decimal("0"),
        Decimal(native.margin_maint) == Decimal("0"),
        Decimal(native.maker_fee) == Decimal("0"),
        Decimal(native.taker_fee) == Decimal("0"),
        native.ts_event == int(expected.ts_event_ns),
        native.ts_init == int(expected.ts_init_ns),
    )
    if not all(comparisons):
        raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_INSTRUMENT_MISMATCH")


def _bar_value(bar: Bar) -> CatalogBarValueV2:
    return CatalogBarValueV2(
        open=str(bar.open),
        high=str(bar.high),
        low=str(bar.low),
        close=str(bar.close),
        volume=str(bar.volume),
        ts_event=str(bar.ts_event),
        ts_init=str(bar.ts_init),
    )


def _require_private_native_root(root: Path) -> None:
    try:
        metadata = root.lstat()
    except OSError as error:
        raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_ROOT_INVALID") from error
    if (
        root != root.absolute()
        or stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(metadata.st_mode)
    ):
        raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_ROOT_INVALID")
    if any(root.iterdir()):
        raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_ROOT_INVALID")


def _validate_native_returned_paths(root: Path, returned_paths: tuple[str, ...]) -> None:
    if len(set(returned_paths)) != len(returned_paths):
        raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_PATH_INVALID")
    for value in returned_paths:
        if type(value) is not str:
            raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_PATH_INVALID")
        parsed = PurePosixPath(value)
        if (
            value != parsed.as_posix()
            or parsed.is_absolute()
            or "\\" in value
            or "\x00" in value
            or any(part in {"", ".", ".."} for part in parsed.parts)
        ):
            raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_PATH_INVALID")
    actual = _regular_relative_paths(root)
    if set(returned_paths) != actual:
        raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_PATH_INVALID")


def _regular_relative_paths(root: Path) -> set[str]:
    result: set[str] = set()
    for current_root, directory_names, file_names in os.walk(root, followlinks=False):
        current = Path(current_root)
        for name in directory_names:
            child = current / name
            if child.is_symlink():
                raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_PATH_INVALID")
        for name in file_names:
            child = current / name
            metadata = child.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                raise HistoricalCatalogInvalid("HISTORICAL_NATIVE_PATH_INVALID")
            result.add(child.relative_to(root).as_posix())
    return result
