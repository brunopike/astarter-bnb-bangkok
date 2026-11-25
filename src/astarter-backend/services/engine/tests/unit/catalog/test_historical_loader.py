from __future__ import annotations

import errno
import json
import os
import subprocess
from hashlib import sha256
from pathlib import Path
from typing import Any

import pytest
from test_historical_source import NOW_NS, _csv_bytes, _metadata_bytes

import stark_trading_os.catalog.historical_loader as historical_loader_module
from stark_trading_os.catalog.historical_loader import load_historical_source_directory
from stark_trading_os.catalog.historical_source import HistoricalSourceInvalid

ENGINE_ROOT = Path(__file__).parents[3]
PYTHON = ENGINE_ROOT / ".venv" / "bin" / "python"
MODULE = "stark_trading_os.catalog.historical_loader"
CSV_BYTE_LIMIT = 32 * 1024 * 1024
METADATA_BYTE_LIMIT = 64 * 1024
READ_CHUNK_LIMIT = 64 * 1024


def _write_source(
    root: Path,
    *,
    csv_bytes: bytes | None = None,
    metadata_bytes: bytes | None = None,
) -> tuple[bytes, bytes]:
    root.mkdir(parents=True, exist_ok=True)
    raw = _csv_bytes() if csv_bytes is None else csv_bytes
    metadata = _metadata_bytes(raw) if metadata_bytes is None else metadata_bytes
    (root / "bars.csv").write_bytes(raw)
    (root / "source.json").write_bytes(metadata)
    return raw, metadata


def _assert_invalid(
    source_directory: object,
    code: str,
    *,
    line: int | None = None,
) -> HistoricalSourceInvalid:
    with pytest.raises(HistoricalSourceInvalid) as caught:
        load_historical_source_directory(  # type: ignore[arg-type]
            source_directory,
            now_ns=NOW_NS,
        )
    error = caught.value
    assert error.code == code
    assert error.line == line
    assert str(error) == (code if line is None else f"{code}:line={line}")
    return error


def _assert_content_free(error: HistoricalSourceInvalid, *sentinels: str) -> None:
    assert error.__cause__ is None
    assert error.__context__ is None
    rendered = f"{error!r}\n{error}"
    for sentinel in sentinels:
        assert sentinel not in rendered


def _run_cli(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(PYTHON), "-m", MODULE, *arguments],
        cwd=ENGINE_ROOT,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )


def _parse_single_json_line(completed: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    assert completed.stderr == ""
    lines = completed.stdout.splitlines()
    assert len(lines) == 1
    parsed = json.loads(lines[0])
    assert type(parsed) is dict
    return parsed


def test_loads_real_directory_retaining_exact_bytes_and_ignoring_other_entries(
    tmp_path: Path,
) -> None:
    root = tmp_path.resolve()
    raw, metadata = _write_source(root)
    (root / "ignored-directory").mkdir()
    (root / "ignored-directory" / "do-not-read").write_text("sentinel-source-content")
    (root / "ignored-link").symlink_to(root / "missing-target")

    source = load_historical_source_directory(str(root), now_ns=NOW_NS)

    assert source.record_count == 2
    assert source.csv_bytes == raw
    assert source.metadata_bytes == metadata
    assert source.records[0].close == "105.00"
    assert (root / "bars.csv").read_bytes() == raw
    assert (root / "source.json").read_bytes() == metadata


@pytest.mark.parametrize(
    "source_directory",
    [
        None,
        b"/tmp/source",
        Path("/tmp/source"),
        7,
        "relative/source",
        "/tmp/source/",
        "//tmp/source",
        "/tmp//source",
        "/tmp/./source",
        "/tmp/../source",
        "/tmp/source\x00sentinel",
        "/tmp/source\\sentinel",
        "/" + ("a" * 4096),
    ],
    ids=[
        "none",
        "bytes",
        "path-object",
        "integer",
        "relative",
        "trailing-slash",
        "double-leading-slash",
        "duplicate-slash",
        "dot-component",
        "dot-dot-component",
        "nul",
        "backslash",
        "over-4096-bytes",
    ],
)
def test_rejects_noncanonical_or_non_string_source_paths(source_directory: object) -> None:
    error = _assert_invalid(source_directory, "HISTORICAL_SOURCE_PATH_INVALID")
    _assert_content_free(error, "sentinel")


def test_root_is_canonical_even_when_required_files_are_absent() -> None:
    error = _assert_invalid("/", "HISTORICAL_SOURCE_UNREADABLE")
    _assert_content_free(error)


def test_rejects_missing_directory_and_missing_fixed_file(tmp_path: Path) -> None:
    physical = tmp_path.resolve()
    missing_directory = physical / "missing-directory-sentinel"
    directory_error = _assert_invalid(
        str(missing_directory),
        "HISTORICAL_SOURCE_PATH_INVALID",
    )
    _assert_content_free(directory_error, "missing-directory-sentinel", str(physical))

    root = physical / "missing-file-sentinel"
    root.mkdir()
    (root / "bars.csv").write_bytes(_csv_bytes())
    file_error = _assert_invalid(str(root), "HISTORICAL_SOURCE_UNREADABLE")
    _assert_content_free(file_error, "missing-file-sentinel", str(physical))


@pytest.mark.parametrize("symlink_position", ["leaf", "ancestor"])
def test_rejects_directory_symlink_components(
    tmp_path: Path,
    symlink_position: str,
) -> None:
    physical = tmp_path.resolve()
    real_parent = physical / "real-parent"
    real_source = real_parent / "source"
    _write_source(real_source)
    if symlink_position == "leaf":
        supplied = physical / "source-link"
        supplied.symlink_to(real_source, target_is_directory=True)
    else:
        supplied_parent = physical / "parent-link"
        supplied_parent.symlink_to(real_parent, target_is_directory=True)
        supplied = supplied_parent / "source"

    error = _assert_invalid(str(supplied), "HISTORICAL_SOURCE_PATH_INVALID")

    _assert_content_free(error, "source-link", "parent-link", str(physical))


@pytest.mark.parametrize("filename", ["bars.csv", "source.json"])
def test_rejects_leaf_file_symlinks(tmp_path: Path, filename: str) -> None:
    root = (tmp_path / "source").resolve()
    raw, metadata = _write_source(root)
    target = root / f"real-{filename}"
    (root / filename).replace(target)
    (root / filename).symlink_to(target)
    assert raw and metadata

    error = _assert_invalid(str(root), "HISTORICAL_SOURCE_UNREADABLE")

    _assert_content_free(error, filename, str(root))


@pytest.mark.parametrize("filename", ["bars.csv", "source.json"])
def test_rejects_directory_instead_of_required_file(tmp_path: Path, filename: str) -> None:
    root = (tmp_path / "source").resolve()
    _write_source(root)
    (root / filename).unlink()
    (root / filename).mkdir()

    _assert_invalid(str(root), "HISTORICAL_SOURCE_UNREADABLE")


def test_rejects_fifo_without_opening_a_writer(tmp_path: Path) -> None:
    root = (tmp_path / "source").resolve()
    _write_source(root)
    (root / "bars.csv").unlink()
    os.mkfifo(root / "bars.csv")

    _assert_invalid(str(root), "HISTORICAL_SOURCE_UNREADABLE")


def test_rejects_regular_file_with_multiple_hard_links(tmp_path: Path) -> None:
    physical = tmp_path.resolve()
    root = physical / "source"
    raw, _ = _write_source(root)
    other_link = physical / "second-bars-link"
    os.link(root / "bars.csv", other_link)
    assert other_link.read_bytes() == raw

    _assert_invalid(str(root), "HISTORICAL_SOURCE_UNREADABLE")


@pytest.mark.parametrize(
    ("filename", "size", "code"),
    [
        ("bars.csv", 0, "HISTORICAL_CSV_LIMIT"),
        ("bars.csv", CSV_BYTE_LIMIT, "HISTORICAL_CSV_LIMIT"),
        ("source.json", 0, "HISTORICAL_METADATA_LIMIT"),
        ("source.json", METADATA_BYTE_LIMIT, "HISTORICAL_METADATA_LIMIT"),
    ],
    ids=["empty-csv", "csv-at-limit", "empty-metadata", "metadata-at-limit"],
)
def test_rejects_empty_and_exact_limit_files_before_reading(
    tmp_path: Path,
    filename: str,
    size: int,
    code: str,
) -> None:
    root = (tmp_path / "source").resolve()
    _write_source(root)
    with (root / filename).open("wb") as sparse:
        sparse.truncate(size)

    _assert_invalid(str(root), code)


@pytest.mark.parametrize(
    ("filename", "size", "expected_code"),
    [
        ("bars.csv", CSV_BYTE_LIMIT - 1, "HISTORICAL_SOURCE_CHECKSUM_MISMATCH"),
        ("source.json", METADATA_BYTE_LIMIT - 1, "HISTORICAL_METADATA_INVALID"),
    ],
    ids=["csv-below-limit", "metadata-below-limit"],
)
def test_reads_files_strictly_below_byte_limits(
    tmp_path: Path,
    filename: str,
    size: int,
    expected_code: str,
) -> None:
    root = (tmp_path / "source").resolve()
    _write_source(root)
    with (root / filename).open("wb") as sparse:
        sparse.truncate(size)

    _assert_invalid(str(root), expected_code)


def test_opens_both_files_before_chunked_short_reads_with_required_flags(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = (tmp_path / "source").resolve()
    raw, metadata = _write_source(root)
    real_open = os.open
    real_read = os.read
    leaf_opens: list[tuple[str, int]] = []
    read_requests: list[int] = []

    def tracking_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        descriptor = real_open(path, flags, mode, dir_fd=dir_fd)
        if path in {"bars.csv", "source.json"}:
            leaf_opens.append((str(path), flags))
        else:
            assert flags & os.O_DIRECTORY
            assert flags & os.O_NOFOLLOW
            assert flags & os.O_CLOEXEC
        return descriptor

    def short_read(descriptor: int, size: int) -> bytes:
        assert [name for name, _ in leaf_opens] == ["bars.csv", "source.json"]
        read_requests.append(size)
        return real_read(descriptor, min(size, 7))

    monkeypatch.setattr(historical_loader_module.os, "open", tracking_open)
    monkeypatch.setattr(historical_loader_module.os, "read", short_read)

    source = load_historical_source_directory(str(root), now_ns=NOW_NS)

    assert source.csv_bytes == raw
    assert source.metadata_bytes == metadata
    assert read_requests
    assert max(read_requests) <= READ_CHUNK_LIMIT
    for _, flags in leaf_opens:
        assert flags & os.O_NOFOLLOW
        assert flags & os.O_NONBLOCK
        assert flags & os.O_CLOEXEC
        assert not flags & os.O_DIRECTORY


def test_rejects_file_replacement_between_stat_and_open(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = (tmp_path / "source").resolve()
    raw, _ = _write_source(root)
    replacement = root / "replacement"
    replacement.write_bytes(raw)
    real_open = os.open
    replaced = False

    def replacing_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        nonlocal replaced
        if path == "bars.csv" and not replaced:
            replaced = True
            os.replace(replacement, root / "bars.csv")
        return real_open(path, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(historical_loader_module.os, "open", replacing_open)

    _assert_invalid(str(root), "HISTORICAL_SOURCE_CHANGED")
    assert replaced


def test_rejects_file_replacement_while_reading(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = (tmp_path / "source").resolve()
    raw, _ = _write_source(root)
    replacement = root / "replacement"
    replacement.write_bytes(raw)
    real_open = os.open
    real_read = os.read
    bars_fd: int | None = None
    replaced = False

    def tracking_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        nonlocal bars_fd
        descriptor = real_open(path, flags, mode, dir_fd=dir_fd)
        if path == "bars.csv":
            bars_fd = descriptor
        return descriptor

    def replacing_read(descriptor: int, size: int) -> bytes:
        nonlocal replaced
        chunk = real_read(descriptor, size)
        if descriptor == bars_fd and not replaced:
            replaced = True
            os.replace(replacement, root / "bars.csv")
        return chunk

    monkeypatch.setattr(historical_loader_module.os, "open", tracking_open)
    monkeypatch.setattr(historical_loader_module.os, "read", replacing_read)

    _assert_invalid(str(root), "HISTORICAL_SOURCE_CHANGED")
    assert replaced


def test_rejects_same_size_in_place_mutation_while_reading(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = (tmp_path / "source").resolve()
    _write_source(root)
    real_open = os.open
    real_read = os.read
    bars_fd: int | None = None
    mutated = False

    def tracking_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        nonlocal bars_fd
        descriptor = real_open(path, flags, mode, dir_fd=dir_fd)
        if path == "bars.csv":
            bars_fd = descriptor
        return descriptor

    def mutating_read(descriptor: int, size: int) -> bytes:
        nonlocal mutated
        chunk = real_read(descriptor, size)
        if descriptor == bars_fd and not mutated:
            mutated = True
            before = (root / "bars.csv").stat()
            with (root / "bars.csv").open("r+b") as handle:
                first = handle.read(1)
                handle.seek(0)
                handle.write(b"X" if first != b"X" else b"Y")
                handle.flush()
                os.fsync(handle.fileno())
            os.utime(
                root / "bars.csv",
                ns=(before.st_atime_ns, before.st_mtime_ns + 1_000_000),
            )
        return chunk

    monkeypatch.setattr(historical_loader_module.os, "open", tracking_open)
    monkeypatch.setattr(historical_loader_module.os, "read", mutating_read)

    _assert_invalid(str(root), "HISTORICAL_SOURCE_CHANGED")
    assert mutated


@pytest.mark.parametrize("mutation", ["truncate", "grow"])
def test_rejects_size_change_while_reading(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mutation: str,
) -> None:
    root = (tmp_path / "source").resolve()
    raw, _ = _write_source(root)
    real_open = os.open
    real_read = os.read
    bars_fd: int | None = None
    mutated = False

    def tracking_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        nonlocal bars_fd
        descriptor = real_open(path, flags, mode, dir_fd=dir_fd)
        if path == "bars.csv":
            bars_fd = descriptor
        return descriptor

    def changing_read(descriptor: int, size: int) -> bytes:
        nonlocal mutated
        if descriptor == bars_fd and not mutated:
            mutated = True
            if mutation == "truncate":
                with (root / "bars.csv").open("r+b") as handle:
                    handle.truncate(len(raw) // 2)
            else:
                with (root / "bars.csv").open("ab") as handle:
                    handle.write(b"growth")
        return real_read(descriptor, size)

    monkeypatch.setattr(historical_loader_module.os, "open", tracking_open)
    monkeypatch.setattr(historical_loader_module.os, "read", changing_read)

    _assert_invalid(str(root), "HISTORICAL_SOURCE_CHANGED")
    assert mutated


@pytest.mark.parametrize("rename_target", ["source", "ancestor"])
def test_rejects_directory_chain_rename_while_reading(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    rename_target: str,
) -> None:
    physical = tmp_path.resolve()
    ancestor = physical / "ancestor"
    root = ancestor / "source"
    _write_source(root)
    real_read = os.read
    renamed = False

    def renaming_read(descriptor: int, size: int) -> bytes:
        nonlocal renamed
        chunk = real_read(descriptor, size)
        if not renamed:
            renamed = True
            target = root if rename_target == "source" else ancestor
            target.rename(target.with_name(f"moved-{target.name}"))
        return chunk

    monkeypatch.setattr(historical_loader_module.os, "read", renaming_read)

    _assert_invalid(str(root), "HISTORICAL_SOURCE_CHANGED")
    assert renamed


@pytest.mark.parametrize("valid_source", [True, False], ids=["success", "validator-error"])
def test_closes_every_owned_descriptor_on_success_and_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    valid_source: bool,
) -> None:
    root = (tmp_path / "source").resolve()
    raw = _csv_bytes()
    if not valid_source:
        raw = raw.replace(b"105.00", b"999.00", 1)
    _write_source(root, csv_bytes=raw)
    real_open = os.open
    real_fstat = os.fstat
    opened: list[int] = []

    def tracking_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        descriptor = real_open(path, flags, mode, dir_fd=dir_fd)
        opened.append(descriptor)
        return descriptor

    monkeypatch.setattr(historical_loader_module.os, "open", tracking_open)

    if valid_source:
        load_historical_source_directory(str(root), now_ns=NOW_NS)
    else:
        _assert_invalid(str(root), "HISTORICAL_OHLC_INVALID", line=2)

    assert opened
    for descriptor in opened:
        with pytest.raises(OSError) as closed:
            real_fstat(descriptor)
        assert closed.value.errno == errno.EBADF


def test_closes_every_owned_descriptor_on_acquisition_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = (tmp_path / "source").resolve()
    _write_source(root)
    (root / "source.json").unlink()
    real_open = os.open
    real_fstat = os.fstat
    opened: list[int] = []

    def tracking_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        descriptor = real_open(path, flags, mode, dir_fd=dir_fd)
        opened.append(descriptor)
        return descriptor

    monkeypatch.setattr(historical_loader_module.os, "open", tracking_open)

    _assert_invalid(str(root), "HISTORICAL_SOURCE_UNREADABLE")

    assert opened
    for descriptor in opened:
        with pytest.raises(OSError) as closed:
            real_fstat(descriptor)
        assert closed.value.errno == errno.EBADF


def test_preserves_validator_error_code_line_and_content_free_chain(tmp_path: Path) -> None:
    root = (tmp_path / "validator-sentinel-directory").resolve()
    raw = _csv_bytes().replace(b"105.00", b"999.00", 1)
    _write_source(root, csv_bytes=raw)

    error = _assert_invalid(
        str(root),
        "HISTORICAL_OHLC_INVALID",
        line=2,
    )

    _assert_content_free(error, "validator-sentinel-directory", str(root), "999.00")


def test_maps_missing_platform_capability_to_stable_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = (tmp_path / "source").resolve()
    _write_source(root)
    monkeypatch.setattr(historical_loader_module, "_PLATFORM_SUPPORTED", False)

    error = _assert_invalid(str(root), "HISTORICAL_SOURCE_PLATFORM_UNSUPPORTED")

    _assert_content_free(error, str(root))


def test_cli_success_prints_validated_not_published_json(tmp_path: Path) -> None:
    root = (tmp_path / "cli-success").resolve()
    raw, metadata = _write_source(root)

    completed = _run_cli(str(root))

    assert completed.returncode == 0
    payload = _parse_single_json_line(completed)
    assert payload == {
        "catalog_published": False,
        "metadata_sha256": sha256(metadata).hexdigest(),
        "raw_sha256": sha256(raw).hexdigest(),
        "record_count": 2,
        "source_id": payload["source_id"],
        "status": "VALIDATED_NOT_PUBLISHED",
    }
    assert len(payload["source_id"]) == 64


def test_cli_validator_failure_keeps_line_and_hides_path_and_content(tmp_path: Path) -> None:
    root = (tmp_path / "cli-validator-path-sentinel").resolve()
    raw = _csv_bytes().replace(b"105.00", b"999.00", 1)
    _write_source(root, csv_bytes=raw)

    completed = _run_cli(str(root))

    assert completed.returncode == 2
    assert _parse_single_json_line(completed) == {
        "code": "HISTORICAL_OHLC_INVALID",
        "line": 2,
        "status": "REJECTED",
    }
    combined = completed.stdout + completed.stderr
    assert "cli-validator-path-sentinel" not in combined
    assert str(root) not in combined
    assert "999.00" not in combined
    assert "Traceback" not in combined


def test_cli_filesystem_failure_hides_os_path_and_filename(tmp_path: Path) -> None:
    root = (tmp_path / "cli-filesystem-path-sentinel").resolve()
    root.mkdir()

    completed = _run_cli(str(root))

    assert completed.returncode == 2
    assert _parse_single_json_line(completed) == {
        "code": "HISTORICAL_SOURCE_UNREADABLE",
        "status": "REJECTED",
    }
    combined = completed.stdout + completed.stderr
    for sentinel in ("cli-filesystem-path-sentinel", str(root), "bars.csv", "source.json"):
        assert sentinel not in combined
    assert "Traceback" not in combined


@pytest.mark.parametrize(
    "arguments",
    [(), ("first-argument-sentinel", "second-argument-sentinel")],
    ids=["missing", "extra"],
)
def test_cli_arity_failure_is_stable_json_without_argument_echo(
    arguments: tuple[str, ...],
) -> None:
    completed = _run_cli(*arguments)

    assert completed.returncode == 2
    assert _parse_single_json_line(completed) == {
        "code": "HISTORICAL_SOURCE_USAGE_INVALID",
        "status": "REJECTED",
    }
    combined = completed.stdout + completed.stderr
    for argument in arguments:
        assert argument not in combined
    assert "Traceback" not in combined
