"""File-backed v2 loader security and identity checks; no engine execution here."""

from __future__ import annotations

import json
import os
from hashlib import sha256
from pathlib import Path

import pytest

from stark_trading_os.audit.historical_input import (
    configuration_bytes,
    dataset_binding_from_catalog,
    input_manifest_bytes,
)
from stark_trading_os.catalog.historical_catalog import canonical_historical_bytes
from stark_trading_os.domain.historical_input import InputManifestV2, SmaConfigurationInputV2
from stark_trading_os.runner.historical_input_adapter import load_historical_runner_input
from stark_trading_os.runner.input_adapter import InputAdapterError, load_runner_input
from tests.integration.runner.sma_component_fixture import prepare_sma_case


def _prepared(tmp_path: Path):
    _, _, _, raw, _ = prepare_sma_case(tmp_path, [100, 100, 100, 110])
    runtime = tmp_path / "runtime"
    run_id = "bt_" + "a" * 32
    stage = runtime / "staging" / run_id
    stage.mkdir(mode=0o700, parents=True)
    os.chmod(stage.parent, 0o700)
    path = stage / "input-manifest.json"
    path.write_bytes(raw)
    path.chmod(0o600)
    args = dict(
        run_id=run_id,
        staging_dir=stage,
        input_manifest=path,
        expected_input_sha256=sha256(raw).hexdigest(),
    )
    catalog = runtime / "catalogs" / json.loads(raw)["dataset"]["catalog_revision"]
    return args, catalog


def _replace_input(args, payload):
    raw = input_manifest_bytes(InputManifestV2.model_validate(payload))
    args["input_manifest"].write_bytes(raw)
    args["expected_input_sha256"] = sha256(raw).hexdigest()


def _replace_catalog(args, old_catalog, payload):
    inventory = payload["inventory"]
    checksum = sha256(
        canonical_historical_bytes(
            {"schema": "CatalogFileSet.v2", "catalog_files": inventory["catalog_files"]}
        )
    ).hexdigest()
    inventory["catalog_checksum"] = payload["catalog_checksum"] = checksum
    payload["inventory_hash"] = sha256(canonical_historical_bytes(inventory)).hexdigest()
    catalog_raw = canonical_historical_bytes(payload)
    revision = sha256(catalog_raw).hexdigest()
    manifest_path = old_catalog / "catalog-manifest.json"
    manifest_path.chmod(0o600)
    manifest_path.write_bytes(catalog_raw)
    manifest_path.chmod(0o400)
    old_catalog.rename(old_catalog.with_name(revision))
    input_payload = json.loads(args["input_manifest"].read_bytes())
    input_payload["configuration"]["configuration"]["catalog_revision"] = revision
    config = SmaConfigurationInputV2.model_validate(input_payload["configuration"]["configuration"])
    input_payload["configuration_content_sha256"] = sha256(configuration_bytes(config)).hexdigest()
    input_payload["dataset"] = dataset_binding_from_catalog(
        catalog_raw, expected_revision=revision
    ).model_dump(mode="json", by_alias=True)
    _replace_input(args, input_payload)


def test_loads_actual_bound_source_bars_runtime_and_run_local_fees(tmp_path: Path) -> None:
    args, catalog = _prepared(tmp_path)
    loaded = load_historical_runner_input(**args)
    assert loaded.input_manifest_hash == args["expected_input_sha256"]
    assert loaded.catalog_dir == catalog
    assert len(loaded.bars) == loaded.manifest.dataset.record_count == 4
    assert str(loaded.bars[-1].close) == "110.00"
    assert str(loaded.instrument.maker_fee) == str(loaded.instrument.taker_fee) == "0"
    assert str(loaded.execution_profile.instrument.taker_fee) == "0.001"
    assert loaded.source.source_id == loaded.manifest.dataset.source_id
    assert loaded.runtime == loaded.manifest.runtime
    assert loaded.execution_profile.instrument is not loaded.instrument


def test_expected_input_hash_is_checked_before_native_readback(tmp_path: Path, monkeypatch) -> None:
    import stark_trading_os.runner.historical_input_adapter as module

    args, _ = _prepared(tmp_path)
    args["expected_input_sha256"] = "f" * 64
    monkeypatch.setattr(
        module,
        "readback_historical_native",
        lambda *_, **__: pytest.fail("must fail before native readback"),
    )
    with pytest.raises(InputAdapterError):
        load_historical_runner_input(**args)


@pytest.mark.parametrize(
    "mutation", ["source", "extra", "input_mode", "input_hardlink", "stage_symlink"]
)
def test_mutated_or_nonprivate_files_are_rejected(tmp_path: Path, mutation: str) -> None:
    args, catalog = _prepared(tmp_path)
    if mutation == "source":
        path = catalog / "source/bars.csv"
        path.chmod(0o600)
        path.write_bytes(path.read_bytes() + b"private-marker\n")
        path.chmod(0o400)
    elif mutation == "extra":
        catalog.chmod(0o700)
        extra = catalog / "unexpected.txt"
        extra.write_text("private-marker")
        extra.chmod(0o400)
        catalog.chmod(0o500)
    elif mutation == "input_mode":
        args["input_manifest"].chmod(0o644)
    elif mutation == "input_hardlink":
        os.link(args["input_manifest"], tmp_path / "linked-input")
    else:
        moved = args["staging_dir"].with_name("moved")
        args["staging_dir"].rename(moved)
        args["staging_dir"].symlink_to(moved, target_is_directory=True)
    with pytest.raises(InputAdapterError) as caught:
        load_historical_runner_input(**args)
    assert "private-marker" not in str(caught.value)


def test_current_runtime_is_observed_instead_of_trusting_input_claim(tmp_path: Path) -> None:
    args, _ = _prepared(tmp_path)
    payload = json.loads(args["input_manifest"].read_bytes())
    payload["runtime"]["native_extension_sha256"] = "f" * 64
    _replace_input(args, payload)
    with pytest.raises(InputAdapterError, match="RUNTIME"):
        load_historical_runner_input(**args)


def test_rehashed_metadata_and_catalog_cannot_forge_retained_source_identity(
    tmp_path: Path,
) -> None:
    args, old_catalog = _prepared(tmp_path)
    payload = json.loads((old_catalog / "catalog-manifest.json").read_bytes())
    inventory = payload["inventory"]
    meta_path = old_catalog / "source/source.json"
    metadata = json.loads(meta_path.read_bytes())
    metadata["source"]["name"] = "changed source identity after publication"
    metadata_raw = json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode()
    meta_path.chmod(0o600)
    meta_path.write_bytes(metadata_raw)
    meta_path.chmod(0o400)
    metadata_hash = sha256(metadata_raw).hexdigest()
    inventory["metadata"] = metadata
    inventory["metadata_sha256"] = payload["metadata_sha256"] = metadata_hash
    for name in ("catalog_files", "source_files"):
        for item in inventory[name]:
            if item["relative_path"] == "source/source.json":
                item.update(sha256=metadata_hash, size_bytes=len(metadata_raw))
    _replace_catalog(args, old_catalog, payload)
    with pytest.raises(InputAdapterError, match="SOURCE_IDENTITY"):
        load_historical_runner_input(**args)


@pytest.mark.parametrize("oversized", ["csv", "metadata", "native", "total"])
def test_rehashed_oversized_inventory_is_rejected_before_file_tree_reads(
    tmp_path: Path, monkeypatch, oversized: str
) -> None:
    import stark_trading_os.runner.historical_input_adapter as module

    args, catalog = _prepared(tmp_path)
    payload = json.loads((catalog / "catalog-manifest.json").read_bytes())
    inventory = payload["inventory"]
    native_paths = [item["relative_path"] for item in inventory["native_returned_files"]]
    if oversized == "csv":
        changes = {"source/bars.csv": 32 * 1024 * 1024}
    elif oversized == "metadata":
        changes = {"source/source.json": 64 * 1024}
    elif oversized == "native":
        changes = {native_paths[0]: 64 * 1024 * 1024 + 1}
    else:
        changes = {path: 64 * 1024 * 1024 for path in native_paths}
    for name in ("catalog_files", "source_files", "native_returned_files"):
        for item in inventory[name]:
            if item["relative_path"] in changes:
                item["size_bytes"] = changes[item["relative_path"]]
    _replace_catalog(args, catalog, payload)
    monkeypatch.setattr(
        module,
        "_verify_catalog_tree",
        lambda *_: pytest.fail("oversized declarations must fail before file content reads"),
    )
    with pytest.raises(InputAdapterError, match="HISTORICAL_CATALOG_BYTE_BUDGET"):
        load_historical_runner_input(**args)


def test_v1_loader_remains_closed_to_v2_input(tmp_path: Path) -> None:
    args, _ = _prepared(tmp_path)
    del args["expected_input_sha256"]
    with pytest.raises(InputAdapterError):
        load_runner_input(**args)


@pytest.mark.parametrize("sidecar", ["input", "catalog"])
def test_changed_sidecar_after_native_readback_is_rejected(tmp_path: Path, monkeypatch, sidecar):
    import stark_trading_os.runner.historical_input_adapter as module

    args, catalog = _prepared(tmp_path)
    original = module._read_native

    def change_after_readback(*positional):
        result = original(*positional)
        path = args["input_manifest"] if sidecar == "input" else catalog / "catalog-manifest.json"
        mode = path.stat().st_mode & 0o777
        path.chmod(0o600)
        path.write_bytes(path.read_bytes() + b"\n")
        path.chmod(mode)
        return result

    monkeypatch.setattr(module, "_read_native", change_after_readback)
    with pytest.raises(InputAdapterError, match="CHANGED_DURING_LOAD"):
        load_historical_runner_input(**args)


def test_all_owned_directory_descriptors_close_after_native_readback_failure(tmp_path, monkeypatch):
    import stark_trading_os.runner.historical_input_adapter as module

    args, _ = _prepared(tmp_path)
    opened = []
    for name in ("_open_absolute_directory", "_open_child_directory"):
        original = getattr(module, name)

        def tracked(*args, _original=original, **kwargs):
            descriptor = _original(*args, **kwargs)
            opened.append(descriptor)
            return descriptor

        monkeypatch.setattr(module, name, tracked)

    def failed_readback(*args, **kwargs):
        raise ValueError("private-marker")

    monkeypatch.setattr(module, "readback_historical_native", failed_readback)
    with pytest.raises(InputAdapterError) as caught:
        load_historical_runner_input(**args)
    assert str(caught.value) == "HISTORICAL_RUNNER_INPUT_INVALID"
    assert len(opened) == 6
    for descriptor in set(opened):
        with pytest.raises(OSError):
            os.fstat(descriptor)
