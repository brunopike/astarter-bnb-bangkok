"""Version-isolated v2 input bytes and consistency checks, without run authority."""

from __future__ import annotations

import re
from hashlib import sha256

from pydantic import BaseModel, ValidationError

from stark_trading_os.audit.canonical_json import CanonicalJSONError
from stark_trading_os.catalog.historical_catalog import (
    CatalogManifestV2,
    HistoricalCatalogInvalid,
    canonical_historical_bytes,
    parse_historical_manifest_bytes,
    parse_historical_model_bytes,
)
from stark_trading_os.catalog.historical_identity import validate_historical_catalog_identity
from stark_trading_os.domain.historical_input import (
    HistoricalDatasetBindingV2,
    HistoricalRuntimeV2,
    InputManifestV2,
    SmaConfigurationEnvelopeV2,
    SmaConfigurationInputV2,
)
from stark_trading_os.runner.historical_cost import historical_cost_bytes

_CONTRACT_BYTE_LIMIT = 64 * 1024
_CATALOG_BYTE_LIMIT = 4 * 1024 * 1024
_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_PLAIN_DECIMAL = re.compile(r"^[0-9]+(?:\.[0-9]+)?$")


class HistoricalInputInvalid(ValueError):
    """Stable content-free boundary error. Raw payloads never enter the message."""

    def __init__(self, code: str = "HISTORICAL_INPUT_INVALID") -> None:
        self.code = code
        super().__init__(code)


def _payload(value: BaseModel, expected: type[BaseModel]) -> dict[str, object]:
    if (
        type(value) is not expected
        or set(value.__dict__) != set(expected.model_fields)
        or value.__pydantic_extra__
    ):
        raise HistoricalInputInvalid()
    output: dict[str, object] = {}
    for name, field in expected.model_fields.items():
        item = getattr(value, name)
        child_type = field.annotation
        if isinstance(child_type, type) and issubclass(child_type, BaseModel):
            if not isinstance(item, BaseModel):
                raise HistoricalInputInvalid()
            item = _payload(item, child_type)
        output[field.alias or name] = item
    return output


def _checked[ModelT: BaseModel](value: ModelT, expected: type[ModelT]) -> ModelT:
    try:
        return expected.model_validate(_payload(value, expected))
    except (AttributeError, TypeError, ValidationError, ValueError) as error:
        raise HistoricalInputInvalid() from error


def _raw_hash(raw: bytes, expected: str, *, limit: int) -> None:
    if (
        type(raw) is not bytes
        or not raw
        or len(raw) > limit
        or type(expected) is not str
        or _DIGEST.fullmatch(expected) is None
        or sha256(raw).hexdigest() != expected
    ):
        raise HistoricalInputInvalid("HISTORICAL_INPUT_HASH_OR_SIZE_INVALID")


def configuration_bytes(configuration: SmaConfigurationInputV2) -> bytes:
    checked = _checked(configuration, SmaConfigurationInputV2)
    envelope = SmaConfigurationEnvelopeV2(
        kind="StrategyConfigurationInput.v2", configuration=checked
    )
    try:
        raw = canonical_historical_bytes(envelope)
        if len(raw) > _CONTRACT_BYTE_LIMIT:
            raise HistoricalInputInvalid()
        return raw
    except (CanonicalJSONError, HistoricalCatalogInvalid, ValueError) as error:
        raise HistoricalInputInvalid() from error


def parse_configuration_bytes(raw: bytes, *, expected_sha256: str) -> SmaConfigurationInputV2:
    _raw_hash(raw, expected_sha256, limit=_CONTRACT_BYTE_LIMIT)
    try:
        envelope = parse_historical_model_bytes(raw, SmaConfigurationEnvelopeV2)
        if configuration_bytes(envelope.configuration) != raw:
            raise HistoricalInputInvalid()
        return envelope.configuration
    except (HistoricalCatalogInvalid, ValidationError, ValueError) as error:
        raise HistoricalInputInvalid() from error


def _checked_manifest(manifest: InputManifestV2) -> InputManifestV2:
    checked = _checked(manifest, InputManifestV2)
    config = checked.configuration.configuration
    if (
        sha256(configuration_bytes(config)).hexdigest() != checked.configuration_content_sha256
        or sha256(historical_cost_bytes(config.execution_cost)).hexdigest() != checked.cost_sha256
    ):
        raise HistoricalInputInvalid("HISTORICAL_INPUT_CONTENT_BINDING_INVALID")
    return checked


def input_manifest_bytes(manifest: InputManifestV2) -> bytes:
    try:
        raw = canonical_historical_bytes(_checked_manifest(manifest))
        if len(raw) > _CONTRACT_BYTE_LIMIT:
            raise HistoricalInputInvalid()
        return raw
    except (CanonicalJSONError, HistoricalCatalogInvalid, ValidationError, ValueError) as error:
        raise HistoricalInputInvalid() from error


def parse_input_manifest_bytes(raw: bytes, *, expected_sha256: str) -> InputManifestV2:
    _raw_hash(raw, expected_sha256, limit=_CONTRACT_BYTE_LIMIT)
    try:
        manifest = parse_historical_model_bytes(raw, InputManifestV2)
        if input_manifest_bytes(manifest) != raw:
            raise HistoricalInputInvalid()
        return manifest
    except (HistoricalCatalogInvalid, ValidationError, ValueError) as error:
        raise HistoricalInputInvalid() from error


def _catalog(raw: bytes, revision: str) -> CatalogManifestV2:
    _raw_hash(raw, revision, limit=_CATALOG_BYTE_LIMIT)
    try:
        catalog = parse_historical_manifest_bytes(raw)
        validate_historical_catalog_identity(
            catalog, source_id=catalog.source_id, inventory_hash=catalog.inventory_hash
        )
        return catalog
    except (HistoricalCatalogInvalid, ValidationError, ValueError, TypeError) as error:
        raise HistoricalInputInvalid("HISTORICAL_CATALOG_BINDING_INVALID") from error


def dataset_binding_from_catalog(
    raw: bytes, *, expected_revision: str
) -> HistoricalDatasetBindingV2:
    """Bind catalog claims; callers separately revalidate actual publication files."""
    catalog = _catalog(raw, expected_revision)
    inventory = catalog.inventory
    try:
        return HistoricalDatasetBindingV2(
            selection="ENTIRE_PUBLISHED_CATALOG",
            catalog_revision=expected_revision,
            source_id=catalog.source_id,
            raw_sha256=catalog.raw_sha256,
            metadata_sha256=catalog.metadata_sha256,
            catalog_checksum=catalog.catalog_checksum,
            inventory_hash=catalog.inventory_hash,
            bar_values_sha256=inventory.readback.bar_values_sha256,
            instrument_id=inventory.instrument.instrument_id,
            bar_type=inventory.bar_type,
            timeframe_ns=inventory.timeframe_ns,
            record_count=inventory.record_count,
            window=inventory.window,
            base_currency=inventory.instrument.base_currency,
            quote_currency=inventory.instrument.quote_currency,
            purpose=inventory.metadata.purpose,
            availability_source=inventory.metadata.availability_source,
        )
    except (ValidationError, ValueError) as error:
        raise HistoricalInputInvalid("HISTORICAL_CATALOG_BINDING_INVALID") from error


def _scaled_quantity(value: str, precision: int) -> int:
    if not 0 <= precision <= 16 or _PLAIN_DECIMAL.fullmatch(value) is None:
        raise HistoricalInputInvalid("HISTORICAL_QUANTITY_INVALID")
    whole, _, fraction = value.partition(".")
    if len(fraction) > precision or len(whole) > 14:
        raise HistoricalInputInvalid("HISTORICAL_QUANTITY_INVALID")
    scale = int(10**precision)
    scaled = int(whole) * scale + int((fraction or "0").ljust(precision, "0"))
    if not 0 < scaled <= 34_028_236_692_093 * scale:
        raise HistoricalInputInvalid("HISTORICAL_QUANTITY_INVALID")
    return scaled


def validate_configuration_catalog_binding(
    configuration: SmaConfigurationInputV2, *, catalog_manifest_bytes: bytes
) -> HistoricalDatasetBindingV2:
    """Check config/catalog claims and native quantity; not publication or file authority."""
    config = _checked(configuration, SmaConfigurationInputV2)
    expected = dataset_binding_from_catalog(
        catalog_manifest_bytes, expected_revision=config.catalog_revision
    )
    catalog = _catalog(catalog_manifest_bytes, config.catalog_revision)
    instrument = catalog.inventory.instrument
    quantity = _scaled_quantity(config.parameters.order_quantity, instrument.size_precision)
    step = _scaled_quantity(instrument.size_increment, instrument.size_precision)
    minimum = _scaled_quantity(instrument.minimum_quantity, instrument.size_precision)
    if quantity < minimum or quantity % step:
        raise HistoricalInputInvalid("HISTORICAL_QUANTITY_INVALID")
    return expected


def validate_input_bindings(
    manifest: InputManifestV2,
    *,
    catalog_manifest_bytes: bytes,
    expected_runtime: HistoricalRuntimeV2,
) -> None:
    """Verify immutable claims, not database publication, native files or execution authority."""
    checked = _checked_manifest(manifest)
    trusted_runtime = _checked(expected_runtime, HistoricalRuntimeV2)
    expected = validate_configuration_catalog_binding(
        checked.configuration.configuration, catalog_manifest_bytes=catalog_manifest_bytes
    )
    if checked.dataset != expected or checked.runtime != trusted_runtime:
        raise HistoricalInputInvalid("HISTORICAL_INPUT_BINDING_MISMATCH")
