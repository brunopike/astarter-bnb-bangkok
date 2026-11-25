"""Registry-only loading and exact-byte validation for synthetic QA fixtures."""

from __future__ import annotations

import json
import os
import re
import stat
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Annotated, Literal

from nautilus_trader.model import (
    FIXED_PRECISION,
    Currency,
    InstrumentId,
    Price,
    Quantity,
    Symbol,
    Venue,
)
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, ValidationError

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.catalog.information_set import (
    InformationSetViolation,
    validate_evaluation_protocol,
    validate_source_order,
)
from stark_trading_os.domain.models import (
    CatalogInstrumentV1,
    CatalogSourceRecordV1,
    DuplicateV1,
    EvaluationProtocolV1,
    GapV1,
    InformationSetPolicyV1,
    NanosecondString,
)

_FIXTURE_ID = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")
_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_READ_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_NONBLOCK", 0)
)
_DIRECTORY_FLAGS = _READ_FLAGS | getattr(os, "O_DIRECTORY", 0)


class FixtureRegistryError(RuntimeError):
    """Base stable registry failure."""


class FixtureUnknown(FixtureRegistryError):
    def __init__(self) -> None:
        super().__init__("FIXTURE_UNKNOWN")


class FixtureInvalid(FixtureRegistryError):
    """Fail-closed source validation error with a stable code."""


class _SourceModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid", frozen=True, populate_by_name=False, serialize_by_alias=True
    )


class _RegistryEntry(_SourceModel):
    label: Literal["LOCAL QA FIXTURE"]
    relative_path: StrictStr
    manifest_sha256: Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]


class _RegistryDocument(_SourceModel):
    schema_: Literal["FixtureRegistry.v1"] = Field(alias="schema")
    fixtures: dict[StrictStr, _RegistryEntry]


class _SourceFile(_SourceModel):
    relative_path: StrictStr
    sha256: Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]


class _QuoteShard(_SourceFile):
    start_ns: NanosecondString
    end_ns: NanosecondString


class _SourceManifest(_SourceModel):
    schema_: Literal["LocalFixtureManifest.v1"] = Field(alias="schema")
    fixture_id: StrictStr
    label: Literal["LOCAL QA FIXTURE"]
    source_revision: StrictStr
    timezone: Literal["UTC"]
    purpose: Literal["LOCAL_QA_ONLY"]
    information_set_policy: InformationSetPolicyV1
    evaluation_protocol: EvaluationProtocolV1
    instrument: _SourceFile
    quote_shards: tuple[_QuoteShard, ...]
    gaps: tuple[GapV1, ...]
    duplicates: tuple[DuplicateV1, ...]
    ordering_result: Literal["PASS"]


class _SourceInstrument(_SourceModel):
    schema_: Literal["LocalFixtureInstrument.v1"] = Field(alias="schema")
    instrument_id: StrictStr
    raw_symbol: StrictStr
    venue: StrictStr
    base_currency: StrictStr
    quote_currency: StrictStr
    price_precision: Annotated[StrictInt, Field(ge=0)]
    size_precision: Annotated[StrictInt, Field(ge=0)]
    price_increment: StrictStr
    size_increment: StrictStr
    minimum_quantity: StrictStr
    margin_init: StrictStr
    margin_maint: StrictStr
    maker_fee: StrictStr
    taker_fee: StrictStr
    ts_event_ns: NanosecondString
    ts_available_ns: NanosecondString


@dataclass(frozen=True)
class FixtureSource:
    fixture_id: str
    label: str
    source_revision: str
    timezone: str
    purpose: str
    source_checksum: str
    sha256sums_bytes: bytes
    instrument: CatalogInstrumentV1
    records: tuple[CatalogSourceRecordV1, ...]
    information_set_policy: InformationSetPolicyV1
    evaluation_protocol: EvaluationProtocolV1
    gaps: tuple[GapV1, ...]
    duplicates: tuple[DuplicateV1, ...]
    ordering_result: Literal["PASS"]
    file_bytes: Mapping[str, bytes]


class FixtureRegistry:
    """Resolve one server-owned fixture ID and retain the exact validated bytes."""

    def __init__(self, fixture_root: Path) -> None:
        self._root = fixture_root.absolute()

    def load(self, fixture_id: str) -> FixtureSource:
        if type(fixture_id) is not str or _FIXTURE_ID.fullmatch(fixture_id) is None:
            raise FixtureUnknown
        try:
            root_fd = os.open(self._root, _DIRECTORY_FLAGS)
        except OSError as error:
            raise FixtureInvalid("SOURCE_PATH_INVALID") from error
        try:
            with _managed_descriptor(root_fd):
                registry_bytes = _read_file_at(root_fd, ("registry.json",))
                registry = _validate(_RegistryDocument, registry_bytes, "REGISTRY_INVALID")
                if any(_FIXTURE_ID.fullmatch(key) is None for key in registry.fixtures):
                    raise FixtureInvalid("REGISTRY_INVALID")
                entry = registry.fixtures.get(fixture_id)
                if entry is None:
                    raise FixtureUnknown
                relative_dir = _relative_parts(entry.relative_path, allow_nested=False)
                fixture_fd = _open_directory_at(root_fd, relative_dir)
                with _managed_descriptor(fixture_fd):
                    return self._load_fixture(
                        fixture_fd=fixture_fd,
                        fixture_id=fixture_id,
                        entry=entry,
                    )
        except FixtureRegistryError:
            raise
        except (OSError, ValueError) as error:
            raise FixtureInvalid("SOURCE_PATH_INVALID") from error

    def _load_fixture(
        self,
        *,
        fixture_fd: int,
        fixture_id: str,
        entry: _RegistryEntry,
    ) -> FixtureSource:
        sums_bytes = _read_file_at(fixture_fd, ("SHA256SUMS",))
        checksums = _parse_sha256sums(sums_bytes)
        actual_names = set(os.listdir(fixture_fd))
        expected_names = set(checksums) | {"SHA256SUMS"}
        if actual_names != expected_names:
            raise FixtureInvalid("SOURCE_INVENTORY_INVALID")

        retained: dict[str, bytes] = {}
        for relative_path, expected_digest in checksums.items():
            parts = _relative_parts(relative_path, allow_nested=True)
            raw = _read_file_at(fixture_fd, parts)
            if sha256(raw).hexdigest() != expected_digest:
                raise FixtureInvalid("SOURCE_CHECKSUM_MISMATCH")
            retained[relative_path] = raw

        manifest_bytes = retained.get("manifest.json")
        if manifest_bytes is None or sha256(manifest_bytes).hexdigest() != entry.manifest_sha256:
            raise FixtureInvalid("MANIFEST_CHECKSUM_MISMATCH")
        manifest = _validate(_SourceManifest, manifest_bytes, "MANIFEST_INVALID")
        if (
            manifest.fixture_id != fixture_id
            or manifest.label != entry.label
            or not manifest.quote_shards
        ):
            raise FixtureInvalid("MANIFEST_IDENTITY_MISMATCH")
        _validate_shards(manifest.quote_shards)
        try:
            validate_evaluation_protocol(
                manifest.evaluation_protocol,
                catalog_start_ns=min(
                    manifest.quote_shards,
                    key=lambda shard: _timestamp_key(shard.start_ns),
                ).start_ns,
                catalog_end_ns=max(
                    manifest.quote_shards,
                    key=lambda shard: _timestamp_key(shard.end_ns),
                ).end_ns,
            )
        except InformationSetViolation as error:
            raise FixtureInvalid(str(error)) from error
        declared_paths = {"manifest.json", manifest.instrument.relative_path}
        declared_paths.update(shard.relative_path for shard in manifest.quote_shards)
        if declared_paths != set(checksums):
            raise FixtureInvalid("SOURCE_INVENTORY_INVALID")
        _require_declared_digest(manifest.instrument, checksums)
        for shard in manifest.quote_shards:
            _require_declared_digest(shard, checksums)

        instrument_bytes = retained[manifest.instrument.relative_path]
        source_instrument = _validate(
            _SourceInstrument, instrument_bytes, "INSTRUMENT_INVALID"
        )
        instrument = _validated_instrument(source_instrument)
        records: list[CatalogSourceRecordV1] = []
        for shard in manifest.quote_shards:
            shard_records = _parse_quote_shard(retained[shard.relative_path])
            for record in shard_records:
                available = _timestamp_key(record.ts_available_ns)
                if not (
                    _timestamp_key(shard.start_ns)
                    <= available
                    < _timestamp_key(shard.end_ns)
                ):
                    raise FixtureInvalid("SHARD_RANGE_INVALID")
                _validate_quote(
                    record,
                    instrument=instrument,
                    source_revision=manifest.source_revision,
                )
            records.extend(shard_records)
        try:
            validated_records = validate_source_order(
                records, source_revision=manifest.source_revision
            )
        except InformationSetViolation as error:
            raise FixtureInvalid(str(error)) from error
        _validate_declared_quality(
            manifest,
            instrument=instrument,
            records=validated_records,
        )

        return FixtureSource(
            fixture_id=fixture_id,
            label=manifest.label,
            source_revision=manifest.source_revision,
            timezone=manifest.timezone,
            purpose=manifest.purpose,
            source_checksum=sha256(sums_bytes).hexdigest(),
            sha256sums_bytes=sums_bytes,
            instrument=instrument,
            records=validated_records,
            information_set_policy=manifest.information_set_policy,
            evaluation_protocol=manifest.evaluation_protocol,
            gaps=manifest.gaps,
            duplicates=manifest.duplicates,
            ordering_result=manifest.ordering_result,
            file_bytes=MappingProxyType(retained),
        )


def _validate[ModelT: BaseModel](
    model: type[ModelT], raw: bytes, code: str
) -> ModelT:
    try:
        parsed = json.loads(raw, object_pairs_hook=_reject_duplicate_pairs)
        if type(parsed) is not dict:
            raise ValueError("root must be an object")
        return model.model_validate(parsed)
    except (UnicodeDecodeError, json.JSONDecodeError, ValidationError, ValueError) as error:
        raise FixtureInvalid(code) from error


def _reject_duplicate_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate key: {key}")
        result[key] = value
    return result


def _parse_sha256sums(raw: bytes) -> dict[str, str]:
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as error:
        raise FixtureInvalid("SHA256SUMS_INVALID") from error
    if not text or not text.endswith("\n") or "\r" in text:
        raise FixtureInvalid("SHA256SUMS_INVALID")
    result: dict[str, str] = {}
    for line in text.splitlines():
        if len(line) < 67 or line[64:66] != "  ":
            raise FixtureInvalid("SHA256SUMS_INVALID")
        digest, relative_path = line[:64], line[66:]
        if _DIGEST.fullmatch(digest) is None or relative_path in result:
            raise FixtureInvalid("SHA256SUMS_INVALID")
        _relative_parts(relative_path, allow_nested=True)
        if relative_path == "SHA256SUMS":
            raise FixtureInvalid("SHA256SUMS_INVALID")
        result[relative_path] = digest
    if list(result) != sorted(result):
        raise FixtureInvalid("SHA256SUMS_INVALID")
    canonical = "".join(f"{digest}  {path}\n" for path, digest in result.items()).encode("ascii")
    if canonical != raw:
        raise FixtureInvalid("SHA256SUMS_INVALID")
    return result


def _relative_parts(value: str, *, allow_nested: bool) -> tuple[str, ...]:
    if type(value) is not str or not value or "\\" in value or ":" in value:
        raise FixtureInvalid("SOURCE_PATH_INVALID")
    path = PurePosixPath(value)
    if value != path.as_posix():
        raise FixtureInvalid("SOURCE_PATH_INVALID")
    parts = path.parts
    if path.is_absolute() or any(part in {"", ".", ".."} for part in parts):
        raise FixtureInvalid("SOURCE_PATH_INVALID")
    if not allow_nested and len(parts) != 1:
        raise FixtureInvalid("SOURCE_PATH_INVALID")
    return parts


def _open_directory_at(parent_fd: int, parts: tuple[str, ...]) -> int:
    current = os.dup(parent_fd)
    for part in parts:
        try:
            next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=current)
        except BaseException as error:
            _close_descriptor(current, primary=error)
            raise
        try:
            _close_descriptor(current, primary=None)
        except BaseException as error:
            _close_descriptor(next_fd, primary=error)
            raise
        current = next_fd
    return current


def _read_file_at(parent_fd: int, parts: tuple[str, ...]) -> bytes:
    directory_fd = os.dup(parent_fd)
    for part in parts[:-1]:
        try:
            next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=directory_fd)
        except BaseException as error:
            _close_descriptor(directory_fd, primary=error)
            raise
        try:
            _close_descriptor(directory_fd, primary=None)
        except BaseException as error:
            _close_descriptor(next_fd, primary=error)
            raise
        directory_fd = next_fd
    try:
        file_fd = os.open(parts[-1], _READ_FLAGS, dir_fd=directory_fd)
    except BaseException as error:
        _close_descriptor(directory_fd, primary=error)
        raise
    try:
        with _managed_descriptor(file_fd):
            metadata = os.fstat(file_fd)
            if not stat.S_ISREG(metadata.st_mode):
                raise FixtureInvalid("SOURCE_PATH_INVALID")
            chunks: list[bytes] = []
            while chunk := os.read(file_fd, 1024 * 1024):
                chunks.append(chunk)
            result = b"".join(chunks)
    except BaseException as error:
        _close_descriptor(directory_fd, primary=error)
        raise
    _close_descriptor(directory_fd, primary=None)
    return result


def _require_declared_digest(item: _SourceFile, checksums: Mapping[str, str]) -> None:
    _relative_parts(item.relative_path, allow_nested=True)
    if checksums.get(item.relative_path) != item.sha256:
        raise FixtureInvalid("MANIFEST_CHECKSUM_MISMATCH")


def _validate_shards(shards: tuple[_QuoteShard, ...]) -> None:
    previous_end: tuple[int, str] | None = None
    seen_paths: set[str] = set()
    for shard in shards:
        start, end = _timestamp_key(shard.start_ns), _timestamp_key(shard.end_ns)
        if start >= end or (previous_end is not None and start < previous_end):
            raise FixtureInvalid("SHARD_RANGE_INVALID")
        if shard.relative_path in seen_paths:
            raise FixtureInvalid("SHARD_RANGE_INVALID")
        seen_paths.add(shard.relative_path)
        previous_end = end


def _validated_instrument(source: _SourceInstrument) -> CatalogInstrumentV1:
    for code in (source.base_currency, source.quote_currency):
        try:
            Currency.from_str(code, strict=True)
        except (KeyError, RuntimeError, ValueError) as error:
            raise FixtureInvalid("INSTRUMENT_CURRENCY_INVALID") from error
    if source.price_precision > FIXED_PRECISION:
        raise FixtureInvalid("PRICE_PRECISION_UNSUPPORTED")
    if source.size_precision > FIXED_PRECISION:
        raise FixtureInvalid("SIZE_PRECISION_UNSUPPORTED")
    _fixed_positive(
        source.price_increment,
        source.price_precision,
        "PRICE_INCREMENT_INVALID",
        native_type="price",
    )
    size_increment = _fixed_positive(
        source.size_increment,
        source.size_precision,
        "SIZE_INCREMENT_INVALID",
        native_type="quantity",
    )
    minimum_quantity = _fixed_positive(
        source.minimum_quantity,
        source.size_precision,
        "MINIMUM_QUANTITY_INVALID",
        native_type="quantity",
    )
    if str(InstrumentId(Symbol(source.raw_symbol), Venue(source.venue))) != source.instrument_id:
        raise FixtureInvalid("INSTRUMENT_ID_MISMATCH")
    if minimum_quantity % size_increment:
        raise FixtureInvalid("MINIMUM_QUANTITY_INVALID")
    if _timestamp_key(source.ts_event_ns) > _timestamp_key(source.ts_available_ns):
        raise FixtureInvalid("INSTRUMENT_EVENT_AFTER_AVAILABILITY")
    try:
        return CatalogInstrumentV1.model_validate(
            source.model_dump(exclude={"schema_"})
        )
    except ValidationError as error:
        raise FixtureInvalid("INSTRUMENT_INVALID") from error


def _parse_quote_shard(raw: bytes) -> tuple[CatalogSourceRecordV1, ...]:
    if not raw or not raw.endswith(b"\n") or b"\r" in raw:
        raise FixtureInvalid("QUOTE_SHARD_INVALID")
    records: list[CatalogSourceRecordV1] = []
    for line in raw.splitlines():
        try:
            parsed = json.loads(line, object_pairs_hook=_reject_duplicate_pairs)
            record = CatalogSourceRecordV1.model_validate(parsed)
        except (json.JSONDecodeError, ValidationError, ValueError) as error:
            raise FixtureInvalid("QUOTE_SHARD_INVALID") from error
        records.append(record)
    return tuple(records)


def _validate_quote(
    record: CatalogSourceRecordV1,
    *,
    instrument: CatalogInstrumentV1,
    source_revision: str,
) -> None:
    if record.instrument_id != instrument.instrument_id:
        raise FixtureInvalid("QUOTE_INSTRUMENT_MISMATCH")
    if record.source_revision != source_revision:
        raise FixtureInvalid("SOURCE_REVISION_MISMATCH")
    bid = _fixed_positive(
        record.bid_price,
        instrument.price_precision,
        "QUOTE_PRICE_INVALID",
        native_type="price",
    )
    ask = _fixed_positive(
        record.ask_price,
        instrument.price_precision,
        "QUOTE_PRICE_INVALID",
        native_type="price",
    )
    bid_size = _fixed_positive(
        record.bid_size,
        instrument.size_precision,
        "QUOTE_SIZE_INVALID",
        native_type="quantity",
    )
    ask_size = _fixed_positive(
        record.ask_size,
        instrument.size_precision,
        "QUOTE_SIZE_INVALID",
        native_type="quantity",
    )
    if bid > ask:
        raise FixtureInvalid("QUOTE_CROSSED")
    price_increment = _fixed_positive(
        instrument.price_increment,
        instrument.price_precision,
        "PRICE_INCREMENT_INVALID",
        native_type="price",
    )
    size_increment = _fixed_positive(
        instrument.size_increment,
        instrument.size_precision,
        "SIZE_INCREMENT_INVALID",
        native_type="quantity",
    )
    if bid % price_increment or ask % price_increment:
        raise FixtureInvalid("QUOTE_PRICE_GRID_INVALID")
    if bid_size % size_increment or ask_size % size_increment:
        raise FixtureInvalid("QUOTE_SIZE_GRID_INVALID")
    if _timestamp_key(record.ts_event_ns) > _timestamp_key(record.ts_available_ns):
        raise FixtureInvalid("EVENT_AFTER_AVAILABILITY")
    unhashed = record.model_dump(mode="json")
    del unhashed["record_hash"]
    if sha256(canonical_json_bytes(unhashed)).hexdigest() != record.record_hash:
        raise FixtureInvalid("RECORD_HASH_MISMATCH")


def _fixed_positive(
    value: str,
    precision: int,
    code: str,
    *,
    native_type: Literal["price", "quantity"],
) -> int:
    pattern = (
        r"^(?:0|[1-9][0-9]*)$"
        if precision == 0
        else rf"^(?:0|[1-9][0-9]*)\.[0-9]{{{precision}}}$"
    )
    if type(value) is not str or re.fullmatch(pattern, value) is None:
        raise FixtureInvalid(code)
    digits = value if precision == 0 else value.replace(".", "")
    if not any(character != "0" for character in digits):
        raise FixtureInvalid(code)
    try:
        if native_type == "price":
            Price.from_str(value)
        else:
            Quantity.from_str(value)
    except (ArithmeticError, RuntimeError, ValueError) as error:
        raise FixtureInvalid(code) from error
    try:
        return int(digits)
    except ValueError as error:
        raise FixtureInvalid(code) from error


def _validate_declared_quality(
    manifest: _SourceManifest,
    *,
    instrument: CatalogInstrumentV1,
    records: tuple[CatalogSourceRecordV1, ...],
) -> None:
    if manifest.duplicates:
        raise FixtureInvalid("DECLARED_DUPLICATES_INVALID")
    prior_key: tuple[tuple[int, str], tuple[int, str], str] | None = None
    prior_end: tuple[int, str] | None = None
    catalog_start = min(
        _timestamp_key(shard.start_ns) for shard in manifest.quote_shards
    )
    catalog_end = max(_timestamp_key(shard.end_ns) for shard in manifest.quote_shards)
    for gap in manifest.gaps:
        start, end = _timestamp_key(gap.start_ns), _timestamp_key(gap.end_ns)
        key = (start, end, gap.instrument_id)
        if (
            gap.instrument_id != instrument.instrument_id
            or start < catalog_start
            or end > catalog_end
            or (prior_key is not None and key <= prior_key)
            or (prior_end is not None and start < prior_end)
            or any(
                start <= _timestamp_key(record.ts_available_ns) < end
                for record in records
            )
        ):
            raise FixtureInvalid("DECLARED_GAP_INVALID")
        prior_key = key
        prior_end = end


def _timestamp_key(value: str) -> tuple[int, str]:
    return len(value), value


@contextmanager
def _managed_descriptor(descriptor: int) -> Iterator[int]:
    primary: BaseException | None = None
    try:
        yield descriptor
    except BaseException as error:
        primary = error
        raise
    finally:
        _close_descriptor(descriptor, primary=primary)


def _close_descriptor(descriptor: int, *, primary: BaseException | None) -> None:
    try:
        os.close(descriptor)
    except OSError as error:
        failure = FixtureInvalid("SOURCE_CLOSE_FAILED")
        if primary is None:
            raise failure from error
        primary.add_note("Secondary cleanup failure: SOURCE_CLOSE_FAILED")
