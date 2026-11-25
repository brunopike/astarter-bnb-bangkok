from __future__ import annotations

import json
from copy import deepcopy
from hashlib import sha256
from pathlib import Path

import pytest

from stark_trading_os.audit.canonical_json import CanonicalJSONError, canonical_json_bytes
from stark_trading_os.audit.historical_input import (
    HistoricalInputInvalid,
    configuration_bytes,
    dataset_binding_from_catalog,
    input_manifest_bytes,
    parse_configuration_bytes,
    parse_input_manifest_bytes,
    validate_input_bindings,
)
from stark_trading_os.catalog.historical_catalog import canonical_historical_bytes
from stark_trading_os.control.strategy_configurations import (
    StrategyConfigurationIntegrityError,
    _configuration_bytes,
    _configuration_from_bytes,
)
from stark_trading_os.control.strategy_models import ConfigurationInput
from stark_trading_os.domain.historical_input import (
    HistoricalRuntimeV2,
    InputManifestV2,
    SmaConfigurationInputV2,
)
from stark_trading_os.runner.historical_cost import historical_cost_bytes
from tests.integration.catalog.test_historical_publication import _publisher, _source
from tests.unit.audit.test_canonical_json import _production_manifest_dump
from tests.unit.domain.test_historical_input import (
    config_payload,
    execution_payload,
    runtime_payload,
)


@pytest.fixture
def catalog_raw(tmp_path: Path) -> bytes:
    publisher, store = _publisher(tmp_path)
    try:
        publication = publisher.publish_historical(_source())
        publisher.revalidate(publication.catalog_revision)
        return (
            tmp_path / "runtime/catalogs" / publication.catalog_revision / "catalog-manifest.json"
        ).read_bytes()
    finally:
        store.close()


def manifest_for(raw: bytes) -> InputManifestV2:
    revision = sha256(raw).hexdigest()
    payload = config_payload()
    payload["catalog_revision"] = revision
    config = SmaConfigurationInputV2.model_validate(payload)
    encoded = configuration_bytes(config)
    return InputManifestV2.model_validate(
        {
            "schema": "InputManifest.v2",
            "environment": "BACKTEST",
            "configuration_id": "cfg_" + "1" * 32,
            "configuration_version": 1,
            "configuration": json.loads(encoded),
            "configuration_content_sha256": sha256(encoded).hexdigest(),
            "dataset": dataset_binding_from_catalog(raw, expected_revision=revision),
            "cost_sha256": sha256(historical_cost_bytes(config.execution_cost)).hexdigest(),
            "runtime": runtime_payload(),
            "execution": execution_payload(),
        }
    )


def test_configuration_round_trip_binds_all_decision_inputs() -> None:
    config = SmaConfigurationInputV2.model_validate(config_payload())
    raw = configuration_bytes(config)
    assert raw == configuration_bytes(config)
    assert json.loads(raw) == {
        "kind": "StrategyConfigurationInput.v2",
        "configuration": config_payload(),
    }
    assert parse_configuration_bytes(raw, expected_sha256=sha256(raw).hexdigest()) == config
    for path, value in (
        (("name",), "renamed"),
        (("catalog_revision",), "c" * 64),
        (("parameters", "fast_period"), 10),
        (("parameters", "slow_period"), 30),
        (("risk", "max_order_notional"), "2000"),
        (("execution_cost", "fee_source"), "different explicit assumption"),
        (("execution_cost", "taker_fee"), "0.002"),
    ):
        payload = config_payload()
        target = payload
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
        changed = configuration_bytes(SmaConfigurationInputV2.model_validate(payload))
        assert sha256(changed).digest() != sha256(raw).digest()


@pytest.mark.parametrize("mutation", ["duplicate", "space", "float", "unknown", "v1", "oversized"])
def test_configuration_parser_rejects_noncanonical_or_unsupported_bytes(mutation: str) -> None:
    raw = configuration_bytes(SmaConfigurationInputV2.model_validate(config_payload()))
    if mutation == "duplicate":
        raw = raw.replace(b'"fast_period":5', b'"fast_period":5,"fast_period":5')
    elif mutation == "space":
        raw += b"\n"
    elif mutation == "float":
        raw = raw.replace(b'"fast_period":5', b'"fast_period":5.0')
    elif mutation == "unknown":
        raw = raw[:-1] + b',"private-marker":"secret-looking-value"}'
    elif mutation == "v1":
        raw = raw.replace(b"StrategyConfigurationInput.v2", b"StrategyConfigurationInput.v1")
    else:
        raw = b" " * (65 * 1024)
    with pytest.raises(HistoricalInputInvalid) as error:
        parse_configuration_bytes(raw, expected_sha256=sha256(raw).hexdigest())
    assert str(error.value) == error.value.code
    assert "secret-looking-value" not in str(error.value)


def test_hash_mismatch_and_forged_nested_objects_fail_closed() -> None:
    config = SmaConfigurationInputV2.model_validate(config_payload())
    raw = configuration_bytes(config)
    with pytest.raises(HistoricalInputInvalid):
        parse_configuration_bytes(raw, expected_sha256="0" * 64)
    for forged in (
        config.model_copy(update={"private-marker": "do-not-leak"}),
        config.model_copy(
            update={"parameters": config.parameters.model_copy(update={"slow_period": 1})}
        ),
        config.model_copy(
            update={"execution_cost": config.execution_cost.model_copy(update={"random_seed": 7})}
        ),
        config.model_copy(
            update={"parameters": {"fast_period": 5, "slow_period": 20, "order_quantity": "1"}}
        ),
    ):
        with pytest.raises(HistoricalInputInvalid):
            configuration_bytes(forged)


def test_manifest_binds_publication_runtime_and_entire_catalog(catalog_raw: bytes) -> None:
    manifest = manifest_for(catalog_raw)
    runtime = HistoricalRuntimeV2.model_validate(runtime_payload())
    validate_input_bindings(manifest, catalog_manifest_bytes=catalog_raw, expected_runtime=runtime)
    assert manifest.dataset.record_count == 2  # A short warmup dataset is legal.
    assert manifest.dataset.selection == "ENTIRE_PUBLISHED_CATALOG"
    assert manifest.dataset.window.first_close_ns == "1700000060000000000"
    assert manifest.dataset.window.last_close_ns == "1700000120000000000"
    raw = input_manifest_bytes(manifest)
    assert parse_input_manifest_bytes(raw, expected_sha256=sha256(raw).hexdigest()) == manifest
    for changes in ({"configuration_id": "cfg_" + "2" * 32}, {"configuration_version": 2}):
        changed = manifest.model_copy(update=changes)
        assert changed.configuration_content_sha256 == manifest.configuration_content_sha256
        assert input_manifest_bytes(changed) != raw


@pytest.mark.parametrize(
    "field",
    [
        "source_id",
        "raw_sha256",
        "metadata_sha256",
        "catalog_checksum",
        "inventory_hash",
        "bar_values_sha256",
        "base_currency",
        "quote_currency",
        "purpose",
        "availability_source",
        "instrument_id",
        "bar_type",
    ],
)
def test_each_dataset_identity_field_is_checked_against_catalog(
    catalog_raw: bytes, field: str
) -> None:
    manifest = manifest_for(catalog_raw)
    replacement = {
        "base_currency": "BTC",
        "quote_currency": "USDC",
        "purpose": "HISTORICAL_MARKET",
        "availability_source": "RECORDED_AT_CLOSE",
        "instrument_id": "HIST" + "F" * 20 + ".SIM",
        "bar_type": "HIST" + "F" * 20 + ".SIM-1-MINUTE-LAST-EXTERNAL",
    }.get(field, "f" * 64)
    forged = manifest.model_copy(
        update={"dataset": manifest.dataset.model_copy(update={field: replacement})}
    )
    with pytest.raises(HistoricalInputInvalid):
        validate_input_bindings(
            forged,
            catalog_manifest_bytes=catalog_raw,
            expected_runtime=HistoricalRuntimeV2.model_validate(runtime_payload()),
        )


def test_stale_cost_configuration_hash_and_runtime_are_rejected(catalog_raw: bytes) -> None:
    manifest = manifest_for(catalog_raw)
    for changes in ({"cost_sha256": "0" * 64}, {"configuration_content_sha256": "0" * 64}):
        forged = manifest.model_copy(update=changes)
        with pytest.raises(HistoricalInputInvalid):
            input_manifest_bytes(forged)
    other_runtime = HistoricalRuntimeV2.model_validate(
        dict(runtime_payload(), native_extension_sha256="f" * 64)
    )
    with pytest.raises(HistoricalInputInvalid):
        validate_input_bindings(
            manifest, catalog_manifest_bytes=catalog_raw, expected_runtime=other_runtime
        )


def test_catalog_internal_identity_and_inventory_hash_are_checked(catalog_raw: bytes) -> None:
    for field in (
        "source_id",
        "raw_sha256",
        "metadata_sha256",
        "catalog_checksum",
        "inventory_hash",
    ):
        payload = json.loads(catalog_raw)
        payload[field] = "0" * 64
        raw = canonical_historical_bytes(payload)
        with pytest.raises(HistoricalInputInvalid):
            dataset_binding_from_catalog(raw, expected_revision=sha256(raw).hexdigest())


@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("minimum_quantity", "2"),
        ("market", "other-market"),
        ("raw_symbol", "BTCUSDT"),
        ("price_precision", 3),
        ("size_precision", 4),
        ("price_increment", "0.02"),
        ("size_increment", "0.002"),
    ],
)
def test_rehashed_source_declaration_must_match_native_instrument(
    catalog_raw: bytes, field: str, replacement: object
) -> None:
    payload = json.loads(catalog_raw)
    payload["inventory"]["metadata"]["instrument"][field] = replacement
    raw = _rehash_catalog(payload)
    with pytest.raises(HistoricalInputInvalid, match="HISTORICAL_CATALOG_BINDING_INVALID"):
        dataset_binding_from_catalog(raw, expected_revision=sha256(raw).hexdigest())


@pytest.mark.parametrize(
    "mutation",
    [
        "source_csv_hash",
        "source_metadata_hash",
        "source_size",
        "source_order",
        "native_hash",
        "native_missing",
        "native_duplicate",
        "unlisted_file",
        "unsorted_files",
        "unsafe_path",
        "absolute_path",
        "first_bar_event",
        "first_bar_init",
        "last_bar_event",
        "last_bar_init",
        "instrument_event",
        "instrument_init",
        "derived_symbol",
        "derived_id",
    ],
)
def test_rehashed_catalog_rejects_internal_file_time_and_symbol_drift(
    catalog_raw: bytes, mutation: str
) -> None:
    payload = json.loads(catalog_raw)
    inventory = payload["inventory"]
    if mutation == "source_csv_hash":
        inventory["source_files"][0]["sha256"] = "b" * 64
    elif mutation == "source_metadata_hash":
        inventory["source_files"][1]["sha256"] = "c" * 64
    elif mutation == "source_size":
        inventory["source_files"][0]["size_bytes"] = 0
    elif mutation == "source_order":
        inventory["source_files"].reverse()
    elif mutation == "native_hash":
        inventory["native_returned_files"][0]["sha256"] = "d" * 64
    elif mutation == "native_missing":
        inventory["native_returned_files"] = []
    elif mutation == "native_duplicate":
        inventory["native_returned_files"].append(inventory["native_returned_files"][0])
    elif mutation == "unlisted_file":
        inventory["catalog_files"].append(
            {"relative_path": "unlisted.bin", "size_bytes": 1, "sha256": "e" * 64}
        )
        inventory["catalog_files"].sort(key=lambda entry: entry["relative_path"])
    elif mutation == "unsorted_files":
        inventory["catalog_files"].reverse()
    elif mutation in {"unsafe_path", "absolute_path"}:
        original = inventory["native_returned_files"][0]["relative_path"]
        replacement = "../outside.parquet" if mutation == "unsafe_path" else "/outside.parquet"
        for collection in ("catalog_files", "native_returned_files"):
            for entry in inventory[collection]:
                if entry["relative_path"] == original:
                    entry["relative_path"] = replacement
            inventory[collection].sort(key=lambda entry: entry["relative_path"])
    elif mutation in {"first_bar_event", "first_bar_init", "last_bar_event", "last_bar_init"}:
        edge, _, clock = mutation.partition("_bar_")
        bar = inventory["readback"][f"{edge}_bar"]
        bar[f"ts_{clock}"] = str(int(bar[f"ts_{clock}"]) + 1)
    elif mutation in {"instrument_event", "instrument_init"}:
        field = f"ts_{mutation.removeprefix('instrument_')}_ns"
        for instrument in (inventory["instrument"], inventory["readback"]["instrument"]):
            instrument[field] = str(int(instrument[field]) + 1)
    elif mutation == "derived_symbol":
        for instrument in (inventory["instrument"], inventory["readback"]["instrument"]):
            instrument["native_symbol"] = "HIST" + "0" * 20
    else:
        replacement = "HIST" + "0" * 20 + ".SIM"
        for instrument in (inventory["instrument"], inventory["readback"]["instrument"]):
            instrument["instrument_id"] = replacement
        inventory["bar_type"] = replacement + "-1-MINUTE-LAST-EXTERNAL"
        inventory["readback"]["bar_type"] = inventory["bar_type"]
    raw = _rehash_catalog(payload)
    with pytest.raises(HistoricalInputInvalid, match="HISTORICAL_CATALOG_BINDING_INVALID"):
        dataset_binding_from_catalog(raw, expected_revision=sha256(raw).hexdigest())


def _rehash_catalog(payload: dict[str, object]) -> bytes:
    inventory = payload["inventory"]
    checksum = sha256(
        canonical_historical_bytes(
            {"schema": "CatalogFileSet.v2", "catalog_files": inventory["catalog_files"]}
        )
    ).hexdigest()
    inventory["catalog_checksum"] = checksum
    payload["catalog_checksum"] = checksum
    payload["inventory_hash"] = sha256(canonical_historical_bytes(inventory)).hexdigest()
    return canonical_historical_bytes(payload)


def test_order_quantity_must_fit_source_precision_step_and_minimum(catalog_raw: bytes) -> None:
    manifest = manifest_for(catalog_raw)
    payload = manifest.model_dump(mode="json", by_alias=True)
    payload["configuration"]["configuration"]["parameters"]["order_quantity"] = "0.0001"
    config = SmaConfigurationInputV2.model_validate(payload["configuration"]["configuration"])
    payload["configuration_content_sha256"] = sha256(configuration_bytes(config)).hexdigest()
    invalid = InputManifestV2.model_validate(payload)
    with pytest.raises(HistoricalInputInvalid):
        validate_input_bindings(
            invalid,
            catalog_manifest_bytes=catalog_raw,
            expected_runtime=HistoricalRuntimeV2.model_validate(runtime_payload()),
        )


def test_v1_and_v2_are_rejected_by_the_opposite_parsers(catalog_raw: bytes) -> None:
    config = SmaConfigurationInputV2.model_validate(config_payload())
    v2 = configuration_bytes(config)
    with pytest.raises(StrategyConfigurationIntegrityError):
        _configuration_from_bytes(v2, expected_sha256=sha256(v2).hexdigest())
    old_manifest = _production_manifest_dump()
    v1 = canonical_json_bytes(old_manifest)
    assert canonical_json_bytes(deepcopy(old_manifest)) == v1
    with pytest.raises(HistoricalInputInvalid):
        parse_input_manifest_bytes(v1, expected_sha256=sha256(v1).hexdigest())
    with pytest.raises(CanonicalJSONError):
        canonical_json_bytes(json.loads(input_manifest_bytes(manifest_for(catalog_raw))))
    old = ConfigurationInput(
        name="legacy",
        strategy_ref="determinism-probe@v1",
        parameters=old_manifest["canonical_config"],
        replay_seed=1,
    )
    old_bytes = _configuration_bytes(old)
    assert (
        _configuration_from_bytes(old_bytes, expected_sha256=sha256(old_bytes).hexdigest()) == old
    )
    with pytest.raises(HistoricalInputInvalid):
        parse_configuration_bytes(old_bytes, expected_sha256=sha256(old_bytes).hexdigest())
