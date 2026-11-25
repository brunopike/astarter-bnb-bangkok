from __future__ import annotations

import json
import os
import shutil
from hashlib import sha256
from multiprocessing import get_context
from pathlib import Path
from typing import Protocol

import pytest

import stark_trading_os.catalog.fixture_registry as fixture_registry_module
from stark_trading_os.catalog.fixture_registry import (
    FixtureInvalid,
    FixtureRegistry,
    FixtureUnknown,
)

REPOSITORY_ROOT = Path(__file__).parents[5]


class ResultQueue(Protocol):
    def put(self, value: object) -> None: ...


def _load_registry_worker(fixture_root: str, results: ResultQueue) -> None:
    try:
        FixtureRegistry(Path(fixture_root)).load("local-qa-v1")
        results.put(("ok", ""))
    except BaseException as error:
        results.put((type(error).__name__, str(error)))


def registry() -> FixtureRegistry:
    return FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures")


def test_checked_in_fixture_loads_from_registry_only_with_exact_source_identity() -> None:
    source = registry().load("local-qa-v1")

    assert source.fixture_id == "local-qa-v1"
    assert source.label == "LOCAL QA FIXTURE"
    assert source.source_revision == "local-qa-v1"
    assert source.timezone == "UTC"
    assert source.purpose == "LOCAL_QA_ONLY"
    assert source.instrument.instrument_id == "ETH/USDT.SIM"
    assert len(source.records) == 2
    assert [record.source_seq for record in source.records] == [1, 2]
    assert source.sha256sums_bytes.endswith(b"\n")


def test_signed_source_accepts_arbitrary_size_nanosecond_strings(tmp_path: Path) -> None:
    root = copied_fixture(tmp_path)
    fixture = root / "local-qa-v1"
    start = "1" + ("0" * 4_999)
    first = "2" + ("0" * 4_999)
    second = "3" + ("0" * 4_999)
    gap_start = "4" + ("0" * 4_999)
    gap_end = "5" + ("0" * 4_999)
    end = "9" + ("0" * 4_999)

    instrument_path = fixture / "instrument.json"
    instrument = json.loads(instrument_path.read_bytes())
    instrument["ts_event_ns"] = start
    instrument["ts_available_ns"] = start
    write_json(instrument_path, instrument)

    quote_path = fixture / "quotes.jsonl"
    records = [json.loads(line) for line in quote_path.read_text().splitlines()]
    for record, timestamp in zip(records, (first, second), strict=True):
        record["ts_event_ns"] = timestamp
        record["ts_available_ns"] = timestamp
        record["record_hash"] = record_hash(record)
    write_jsonl(quote_path, records)

    manifest_path = fixture / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    manifest["quote_shards"][0]["start_ns"] = start
    manifest["quote_shards"][0]["end_ns"] = end
    manifest["gaps"] = [
        {
            "start_ns": gap_start,
            "end_ns": gap_end,
            "instrument_id": "ETH/USDT.SIM",
        }
    ]
    write_json(manifest_path, manifest)
    resign(root)

    source = FixtureRegistry(root).load("local-qa-v1")

    assert [record.ts_available_ns for record in source.records] == [first, second]


def test_public_registry_load_maps_arbitrary_size_fixed_decimal_to_stable_error(
    tmp_path: Path,
) -> None:
    root = copied_fixture(tmp_path)
    quote_path = root / "local-qa-v1" / "quotes.jsonl"
    records = [json.loads(line) for line in quote_path.read_text().splitlines()]
    huge_price = ("9" * 5_000) + ".00"
    records[0]["bid_price"] = huge_price
    records[0]["ask_price"] = huge_price
    records[0]["record_hash"] = record_hash(records[0])
    write_jsonl(quote_path, records)
    resign(root)

    with pytest.raises(FixtureInvalid, match="QUOTE_PRICE_INVALID"):
        FixtureRegistry(root).load("local-qa-v1")


def test_fixture_descriptor_close_only_failure_is_stable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = copied_fixture(tmp_path)
    real_open = os.open
    real_close = os.close
    root_fds: set[int] = set()

    def track_root_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        descriptor = real_open(path, flags, mode, dir_fd=dir_fd)
        if dir_fd is None and Path(path) == root.absolute():
            root_fds.add(descriptor)
        return descriptor

    def fail_root_close(descriptor: int) -> None:
        if descriptor in root_fds:
            raise OSError("injected descriptor close failure")
        real_close(descriptor)

    try:
        try:
            raise ValueError("handled outer exception")
        except ValueError as outer:
            handled = outer
            with monkeypatch.context() as patch:
                patch.setattr(fixture_registry_module.os, "open", track_root_open)
                patch.setattr(fixture_registry_module.os, "close", fail_root_close)
                with pytest.raises(FixtureInvalid, match="SOURCE_CLOSE_FAILED"):
                    FixtureRegistry(root).load("local-qa-v1")
        assert getattr(handled, "__notes__", ()) == ()
    finally:
        for descriptor in root_fds:
            real_close(descriptor)


def test_fixture_descriptor_close_preserves_primary_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = copied_fixture(tmp_path)
    real_open = os.open
    real_close = os.close
    root_fds: set[int] = set()

    def track_root_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        descriptor = real_open(path, flags, mode, dir_fd=dir_fd)
        if dir_fd is None and Path(path) == root.absolute():
            root_fds.add(descriptor)
        return descriptor

    def fail_root_close(descriptor: int) -> None:
        if descriptor in root_fds:
            raise OSError("injected descriptor close failure")
        real_close(descriptor)

    try:
        with monkeypatch.context() as patch:
            patch.setattr(fixture_registry_module.os, "open", track_root_open)
            patch.setattr(fixture_registry_module.os, "close", fail_root_close)
            with pytest.raises(FixtureUnknown) as caught:
                FixtureRegistry(root).load("unknown")
        assert any(
            "SOURCE_CLOSE_FAILED" in note
            for note in getattr(caught.value, "__notes__", ())
        )
    finally:
        for descriptor in root_fds:
            real_close(descriptor)


@pytest.mark.parametrize(
    "fixture_id",
    ["unknown", "../../private", "/tmp/private", "https://evil.test/x", "file:///tmp/x", "a\\b"],
)
def test_client_input_is_always_interpreted_as_a_fixture_id(fixture_id: str) -> None:
    with pytest.raises(FixtureUnknown):
        registry().load(fixture_id)


def test_duplicate_registry_json_keys_fail_closed(tmp_path: Path) -> None:
    root = tmp_path / "fixtures"
    root.mkdir()
    (root / "registry.json").write_text(
        '{"schema":"FixtureRegistry.v1","fixtures":{"same":{},"same":{}}}', encoding="utf-8"
    )
    with pytest.raises(FixtureInvalid, match="REGISTRY_INVALID"):
        FixtureRegistry(root).load("same")


def test_source_mutation_after_checksums_is_rejected(tmp_path: Path) -> None:
    root = tmp_path / "fixtures"
    shutil.copytree(REPOSITORY_ROOT / "data" / "fixtures", root)
    quote_path = root / "local-qa-v1" / "quotes.jsonl"
    quote_path.write_bytes(quote_path.read_bytes() + b"\n")

    with pytest.raises(FixtureInvalid, match="SOURCE_CHECKSUM_MISMATCH"):
        FixtureRegistry(root).load("local-qa-v1")


def test_loaded_source_retains_the_exact_validated_bytes_after_disk_mutation(
    tmp_path: Path,
) -> None:
    root = copied_fixture(tmp_path)
    source = FixtureRegistry(root).load("local-qa-v1")
    retained = source.file_bytes["quotes.jsonl"]
    quote_path = root / "local-qa-v1" / "quotes.jsonl"

    quote_path.write_bytes(b"substituted after validation\n")

    assert source.file_bytes["quotes.jsonl"] == retained
    assert source.file_bytes["quotes.jsonl"] != quote_path.read_bytes()
    assert [record.source_seq for record in source.records] == [1, 2]


def test_symlinked_fixture_component_is_rejected(tmp_path: Path) -> None:
    root = tmp_path / "fixtures"
    shutil.copytree(REPOSITORY_ROOT / "data" / "fixtures", root)
    fixture = root / "local-qa-v1"
    real_fixture = root / "real-fixture"
    fixture.rename(real_fixture)
    fixture.symlink_to(real_fixture, target_is_directory=True)

    with pytest.raises(FixtureInvalid, match="SOURCE_PATH_INVALID"):
        FixtureRegistry(root).load("local-qa-v1")


@pytest.mark.parametrize(
    "relative_path",
    ["registry.json", "local-qa-v1/SHA256SUMS", "local-qa-v1/quotes.jsonl"],
)
def test_fifo_source_components_fail_fast_without_blocking(
    tmp_path: Path, relative_path: str
) -> None:
    root = copied_fixture(tmp_path)
    fifo = root / relative_path
    fifo.unlink()
    os.mkfifo(fifo, mode=0o600)
    context = get_context("spawn")
    results = context.Queue()
    process = context.Process(
        target=_load_registry_worker,
        args=(str(root), results),
    )

    process.start()
    process.join(timeout=3)
    timed_out = process.is_alive()
    if timed_out:
        process.terminate()
        process.join(timeout=3)

    assert not timed_out, f"source FIFO blocked while opening {relative_path}"
    assert process.exitcode == 0
    assert results.get(timeout=1) == ("FixtureInvalid", "SOURCE_PATH_INVALID")


def test_manifest_declared_shard_range_and_record_order_are_enforced(tmp_path: Path) -> None:
    root = tmp_path / "fixtures"
    shutil.copytree(REPOSITORY_ROOT / "data" / "fixtures", root)
    # A byte mutation is rejected before potentially attacker-controlled content is parsed.
    manifest_path = root / "local-qa-v1" / "manifest.json"
    manifest_path.write_bytes(
        manifest_path.read_bytes().replace(
            b'"end_ns":"1700000000000000002"',
            b'"end_ns":"1700000000000000001"',
        )
    )

    with pytest.raises(FixtureInvalid, match="SOURCE_CHECKSUM_MISMATCH"):
        FixtureRegistry(root).load("local-qa-v1")


def test_noncanonical_posix_paths_are_rejected_before_normalization(tmp_path: Path) -> None:
    root = copied_fixture(tmp_path)
    registry_document = json.loads((root / "registry.json").read_bytes())
    registry_document["fixtures"]["local-qa-v1"]["relative_path"] = "./local-qa-v1"
    write_json(root / "registry.json", registry_document)

    with pytest.raises(FixtureInvalid, match="SOURCE_PATH_INVALID"):
        FixtureRegistry(root).load("local-qa-v1")


@pytest.mark.parametrize("bad_path", ["./instrument.json", "a//b", "instrument.json/"])
def test_sha256sums_rejects_noncanonical_paths(tmp_path: Path, bad_path: str) -> None:
    root = copied_fixture(tmp_path)
    sums = root / "local-qa-v1" / "SHA256SUMS"
    lines = sums.read_text(encoding="ascii").splitlines()
    lines[0] = f"{lines[0][:64]}  {bad_path}"
    sums.write_text("\n".join(lines) + "\n", encoding="ascii")

    with pytest.raises(FixtureInvalid, match="SOURCE_PATH_INVALID"):
        FixtureRegistry(root).load("local-qa-v1")


def test_resigned_regressing_source_sequence_is_rejected(tmp_path: Path) -> None:
    root = copied_fixture(tmp_path)
    quote_path = root / "local-qa-v1" / "quotes.jsonl"
    records = [json.loads(line) for line in quote_path.read_text().splitlines()]
    records.reverse()
    write_jsonl(quote_path, records)
    resign(root)

    with pytest.raises(FixtureInvalid, match="SOURCE_ORDER_INVALID|SOURCE_SEQUENCE_INVALID"):
        FixtureRegistry(root).load("local-qa-v1")


@pytest.mark.parametrize(
    ("field", "value", "error"),
    [
        ("ask_price", "98.00", "QUOTE_CROSSED"),
        ("bid_price", "9.9e1", "QUOTE_PRICE_INVALID"),
        ("bid_size", "0.000", "QUOTE_SIZE_INVALID"),
        ("bid_price", "99.001", "QUOTE_PRICE_INVALID"),
    ],
)
def test_resigned_semantically_invalid_quotes_are_rejected(
    tmp_path: Path, field: str, value: str, error: str
) -> None:
    root = copied_fixture(tmp_path)
    quote_path = root / "local-qa-v1" / "quotes.jsonl"
    records = [json.loads(line) for line in quote_path.read_text().splitlines()]
    records[0][field] = value
    records[0]["record_hash"] = record_hash(records[0])
    write_jsonl(quote_path, records)
    resign(root)

    with pytest.raises(FixtureInvalid, match=error):
        FixtureRegistry(root).load("local-qa-v1")


def test_resigned_unknown_currency_is_rejected(tmp_path: Path) -> None:
    root = copied_fixture(tmp_path)
    instrument_path = root / "local-qa-v1" / "instrument.json"
    instrument = json.loads(instrument_path.read_bytes())
    instrument["base_currency"] = "NOT_A_CURRENCY"
    write_json(instrument_path, instrument)
    resign(root)

    with pytest.raises(FixtureInvalid, match="INSTRUMENT_CURRENCY_INVALID"):
        FixtureRegistry(root).load("local-qa-v1")


def test_resigned_record_outside_half_open_shard_is_rejected(tmp_path: Path) -> None:
    root = copied_fixture(tmp_path)
    manifest_path = root / "local-qa-v1" / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    manifest["quote_shards"][0]["end_ns"] = "1700000000000000001"
    write_json(manifest_path, manifest)
    resign(root)

    with pytest.raises(FixtureInvalid, match="SHARD_RANGE_INVALID"):
        FixtureRegistry(root).load("local-qa-v1")


def test_resigned_raw_symbol_identity_mismatch_is_rejected(tmp_path: Path) -> None:
    root = copied_fixture(tmp_path)
    instrument_path = root / "local-qa-v1" / "instrument.json"
    instrument = json.loads(instrument_path.read_bytes())
    instrument["raw_symbol"] = "ETHUSDT"
    write_json(instrument_path, instrument)
    resign(root)

    with pytest.raises(FixtureInvalid, match="INSTRUMENT_ID_MISMATCH"):
        FixtureRegistry(root).load("local-qa-v1")


def test_fabricated_duplicate_and_gap_declarations_are_rejected(tmp_path: Path) -> None:
    for field in ("duplicates", "gaps"):
        root = copied_fixture(tmp_path / field)
        manifest_path = root / "local-qa-v1" / "manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        if field == "duplicates":
            manifest[field] = [
                {"ts_event_ns": "1700000000000000000", "source_seq": 1,
                 "record_hash": "23a6e69b3097b3aa35cfb93317eb01cf12156e78ec086a4d5fd03ef716fc5550"}
            ]
            error = "DECLARED_DUPLICATES_INVALID"
        else:
            manifest[field] = [
                {"start_ns": "1700000000000000000", "end_ns": "1700000000000000001",
                 "instrument_id": "ETH/USDT.SIM"}
            ]
            error = "DECLARED_GAP_INVALID"
        write_json(manifest_path, manifest)
        resign(root)
        with pytest.raises(FixtureInvalid, match=error):
            FixtureRegistry(root).load("local-qa-v1")


def copied_fixture(tmp_path: Path) -> Path:
    root = tmp_path / "fixtures"
    shutil.copytree(REPOSITORY_ROOT / "data" / "fixtures", root)
    return root


def write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def write_jsonl(path: Path, values: list[dict[str, object]]) -> None:
    path.write_text(
        "".join(
            json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
            for value in values
        ),
        encoding="utf-8",
    )


def record_hash(record: dict[str, object]) -> str:
    from stark_trading_os.audit.canonical_json import canonical_json_bytes

    unhashed = {key: value for key, value in record.items() if key != "record_hash"}
    return sha256(canonical_json_bytes(unhashed)).hexdigest()


def resign(root: Path) -> None:
    fixture = root / "local-qa-v1"
    manifest_path = fixture / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    instrument_path = fixture / manifest["instrument"]["relative_path"]
    manifest["instrument"]["sha256"] = sha256(instrument_path.read_bytes()).hexdigest()
    for shard in manifest["quote_shards"]:
        shard_path = fixture / shard["relative_path"]
        shard["sha256"] = sha256(shard_path.read_bytes()).hexdigest()
    write_json(manifest_path, manifest)
    source_paths = ["instrument.json", "manifest.json", "quotes.jsonl"]
    sums = "".join(
        f"{sha256((fixture / path).read_bytes()).hexdigest()}  {path}\n"
        for path in source_paths
    )
    (fixture / "SHA256SUMS").write_text(sums, encoding="ascii")
    registry_document = json.loads((root / "registry.json").read_bytes())
    registry_document["fixtures"]["local-qa-v1"]["manifest_sha256"] = sha256(
        manifest_path.read_bytes()
    ).hexdigest()
    write_json(root / "registry.json", registry_document)
