"""Descriptor-safe, read-only acquisition for a local historical source."""

from __future__ import annotations

import json
import os
import stat
import sys
import time
from dataclasses import dataclass

from stark_trading_os.catalog.historical_source import (
    HistoricalSource,
    HistoricalSourceInvalid,
    validate_historical_source,
)

_CSV_FILENAME = "bars.csv"
_METADATA_FILENAME = "source.json"
_CSV_BYTE_LIMIT = 32 * 1024 * 1024
_METADATA_BYTE_LIMIT = 64 * 1024
_PATH_BYTE_LIMIT = 4096
_READ_CHUNK_LIMIT = 64 * 1024
_REQUIRED_FLAG_NAMES = ("O_CLOEXEC", "O_DIRECTORY", "O_NOFOLLOW", "O_NONBLOCK")
_PLATFORM_SUPPORTED = (
    all(hasattr(os, name) for name in _REQUIRED_FLAG_NAMES)
    and os.open in os.supports_dir_fd
    and os.stat in os.supports_dir_fd
    and os.stat in os.supports_follow_symlinks
)


class _AcquisitionFailure(Exception):
    code: str

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class _DirectoryNode:
    descriptor: int
    identity: tuple[int, int, int]
    parent_descriptor: int | None
    name: str | None


@dataclass(frozen=True, slots=True)
class _CapturedFile:
    descriptor: int
    parent_descriptor: int
    name: str
    snapshot: tuple[int, int, int, int, int, int, int]
    size: int


def load_historical_source_directory(
    source_directory: str,
    *,
    now_ns: int,
) -> HistoricalSource:
    """Acquire fixed source files without following links, then validate exact bytes."""

    parts = _canonical_absolute_parts(source_directory)
    flags = _required_platform_flags()
    if flags is None:
        raise HistoricalSourceInvalid("HISTORICAL_SOURCE_PLATFORM_UNSUPPORTED")

    failure_code: str | None = None
    csv_bytes = b""
    metadata_bytes = b""
    try:
        csv_bytes, metadata_bytes = _acquire_source_bytes(
            parts,
            directory_flags=flags[0],
            file_flags=flags[1],
        )
    except _AcquisitionFailure as error:
        failure_code = error.code
    if failure_code is not None:
        raise HistoricalSourceInvalid(failure_code)

    return validate_historical_source(csv_bytes, metadata_bytes, now_ns=now_ns)


def _canonical_absolute_parts(source_directory: str) -> tuple[str, ...]:
    invalid = type(source_directory) is not str
    encoded_length = 0
    if not invalid:
        try:
            encoded_length = len(source_directory.encode("utf-8"))
        except UnicodeEncodeError:
            invalid = True
    if (
        invalid
        or encoded_length > _PATH_BYTE_LIMIT
        or not source_directory.startswith("/")
        or "\x00" in source_directory
        or "\\" in source_directory
    ):
        raise HistoricalSourceInvalid("HISTORICAL_SOURCE_PATH_INVALID")
    if source_directory == "/":
        return ()
    if source_directory.endswith("/") or "//" in source_directory:
        raise HistoricalSourceInvalid("HISTORICAL_SOURCE_PATH_INVALID")
    parts = tuple(source_directory[1:].split("/"))
    if any(part in {"", ".", ".."} for part in parts):
        raise HistoricalSourceInvalid("HISTORICAL_SOURCE_PATH_INVALID")
    return parts


def _required_platform_flags() -> tuple[int, int] | None:
    if not _PLATFORM_SUPPORTED:
        return None
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    file_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    return directory_flags, file_flags


def _acquire_source_bytes(
    parts: tuple[str, ...],
    *,
    directory_flags: int,
    file_flags: int,
) -> tuple[bytes, bytes]:
    owned_descriptors: list[int] = []
    try:
        directories = _open_directory_chain(
            parts,
            directory_flags=directory_flags,
            owned_descriptors=owned_descriptors,
        )
        source_descriptor = directories[-1].descriptor
        csv_file = _capture_file(
            source_descriptor,
            _CSV_FILENAME,
            byte_limit=_CSV_BYTE_LIMIT,
            limit_code="HISTORICAL_CSV_LIMIT",
            file_flags=file_flags,
            owned_descriptors=owned_descriptors,
        )
        metadata_file = _capture_file(
            source_descriptor,
            _METADATA_FILENAME,
            byte_limit=_METADATA_BYTE_LIMIT,
            limit_code="HISTORICAL_METADATA_LIMIT",
            file_flags=file_flags,
            owned_descriptors=owned_descriptors,
        )
        csv_bytes = _read_exact_file(csv_file)
        metadata_bytes = _read_exact_file(metadata_file)
        _verify_captured_file(csv_file, csv_bytes)
        _verify_captured_file(metadata_file, metadata_bytes)
        _verify_directory_chain(directories)
        result = (csv_bytes, metadata_bytes)
    except BaseException:
        _close_descriptors(owned_descriptors)
        raise

    if not _close_descriptors(owned_descriptors):
        raise _AcquisitionFailure("HISTORICAL_SOURCE_UNREADABLE")
    return result


def _open_directory_chain(
    parts: tuple[str, ...],
    *,
    directory_flags: int,
    owned_descriptors: list[int],
) -> list[_DirectoryNode]:
    root_descriptor = _open_directory(
        "/",
        directory_flags,
        parent_descriptor=None,
        failure_code="HISTORICAL_SOURCE_PATH_INVALID",
    )
    owned_descriptors.append(root_descriptor)
    root_metadata = _fstat(
        root_descriptor,
        failure_code="HISTORICAL_SOURCE_PATH_INVALID",
    )
    if not stat.S_ISDIR(root_metadata.st_mode):
        raise _AcquisitionFailure("HISTORICAL_SOURCE_PATH_INVALID")
    directories = [
        _DirectoryNode(
            descriptor=root_descriptor,
            identity=_directory_identity(root_metadata),
            parent_descriptor=None,
            name=None,
        )
    ]

    for part in parts:
        parent_descriptor = directories[-1].descriptor
        before = _stat_at(
            parent_descriptor,
            part,
            failure_code="HISTORICAL_SOURCE_PATH_INVALID",
        )
        if not stat.S_ISDIR(before.st_mode):
            raise _AcquisitionFailure("HISTORICAL_SOURCE_PATH_INVALID")
        child_descriptor = _open_directory(
            part,
            directory_flags,
            parent_descriptor=parent_descriptor,
            failure_code="HISTORICAL_SOURCE_CHANGED",
        )
        owned_descriptors.append(child_descriptor)
        opened = _fstat(
            child_descriptor,
            failure_code="HISTORICAL_SOURCE_CHANGED",
        )
        if (
            not stat.S_ISDIR(opened.st_mode)
            or _directory_identity(before) != _directory_identity(opened)
        ):
            raise _AcquisitionFailure("HISTORICAL_SOURCE_CHANGED")
        directories.append(
            _DirectoryNode(
                descriptor=child_descriptor,
                identity=_directory_identity(opened),
                parent_descriptor=parent_descriptor,
                name=part,
            )
        )
    return directories


def _capture_file(
    parent_descriptor: int,
    name: str,
    *,
    byte_limit: int,
    limit_code: str,
    file_flags: int,
    owned_descriptors: list[int],
) -> _CapturedFile:
    before = _stat_at(
        parent_descriptor,
        name,
        failure_code="HISTORICAL_SOURCE_UNREADABLE",
    )
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise _AcquisitionFailure("HISTORICAL_SOURCE_UNREADABLE")
    if before.st_size <= 0 or before.st_size >= byte_limit:
        raise _AcquisitionFailure(limit_code)

    descriptor = _open_file(
        parent_descriptor,
        name,
        file_flags=file_flags,
        failure_code="HISTORICAL_SOURCE_CHANGED",
    )
    owned_descriptors.append(descriptor)
    opened = _fstat(descriptor, failure_code="HISTORICAL_SOURCE_CHANGED")
    if (
        not stat.S_ISREG(opened.st_mode)
        or opened.st_nlink != 1
        or _file_snapshot(before) != _file_snapshot(opened)
    ):
        raise _AcquisitionFailure("HISTORICAL_SOURCE_CHANGED")
    return _CapturedFile(
        descriptor=descriptor,
        parent_descriptor=parent_descriptor,
        name=name,
        snapshot=_file_snapshot(opened),
        size=opened.st_size,
    )


def _read_exact_file(captured: _CapturedFile) -> bytes:
    chunks: list[bytes] = []
    remaining = captured.size
    while remaining:
        request_size = min(remaining, _READ_CHUNK_LIMIT)
        chunk = _read(
            captured.descriptor,
            request_size,
            failure_code="HISTORICAL_SOURCE_UNREADABLE",
        )
        if not chunk or len(chunk) > request_size:
            raise _AcquisitionFailure("HISTORICAL_SOURCE_CHANGED")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _verify_captured_file(captured: _CapturedFile, payload: bytes) -> None:
    if len(payload) != captured.size:
        raise _AcquisitionFailure("HISTORICAL_SOURCE_CHANGED")
    opened = _fstat(captured.descriptor, failure_code="HISTORICAL_SOURCE_CHANGED")
    linked = _stat_at(
        captured.parent_descriptor,
        captured.name,
        failure_code="HISTORICAL_SOURCE_CHANGED",
    )
    if (
        _file_snapshot(opened) != captured.snapshot
        or _file_snapshot(linked) != captured.snapshot
    ):
        raise _AcquisitionFailure("HISTORICAL_SOURCE_CHANGED")


def _verify_directory_chain(directories: list[_DirectoryNode]) -> None:
    for node in directories:
        opened = _fstat(node.descriptor, failure_code="HISTORICAL_SOURCE_CHANGED")
        if _directory_identity(opened) != node.identity:
            raise _AcquisitionFailure("HISTORICAL_SOURCE_CHANGED")
        if node.parent_descriptor is None:
            linked = _stat_root(failure_code="HISTORICAL_SOURCE_CHANGED")
        else:
            assert node.name is not None
            linked = _stat_at(
                node.parent_descriptor,
                node.name,
                failure_code="HISTORICAL_SOURCE_CHANGED",
            )
        if _directory_identity(linked) != node.identity:
            raise _AcquisitionFailure("HISTORICAL_SOURCE_CHANGED")


def _directory_identity(metadata: os.stat_result) -> tuple[int, int, int]:
    return metadata.st_dev, metadata.st_ino, stat.S_IFMT(metadata.st_mode)


def _file_snapshot(metadata: os.stat_result) -> tuple[int, int, int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_nlink,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _open_directory(
    path: str,
    flags: int,
    *,
    parent_descriptor: int | None,
    failure_code: str,
) -> int:
    descriptor: int | None = None
    try:
        if parent_descriptor is None:
            descriptor = os.open(path, flags)
        else:
            descriptor = os.open(path, flags, dir_fd=parent_descriptor)
    except OSError:
        pass
    if descriptor is None:
        raise _AcquisitionFailure(failure_code)
    return descriptor


def _open_file(
    parent_descriptor: int,
    name: str,
    *,
    file_flags: int,
    failure_code: str,
) -> int:
    descriptor: int | None = None
    try:
        descriptor = os.open(name, file_flags, dir_fd=parent_descriptor)
    except OSError:
        pass
    if descriptor is None:
        raise _AcquisitionFailure(failure_code)
    return descriptor


def _fstat(descriptor: int, *, failure_code: str) -> os.stat_result:
    metadata: os.stat_result | None = None
    try:
        metadata = os.fstat(descriptor)
    except OSError:
        pass
    if metadata is None:
        raise _AcquisitionFailure(failure_code)
    return metadata


def _stat_at(parent_descriptor: int, name: str, *, failure_code: str) -> os.stat_result:
    metadata: os.stat_result | None = None
    try:
        metadata = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    except OSError:
        pass
    if metadata is None:
        raise _AcquisitionFailure(failure_code)
    return metadata


def _stat_root(*, failure_code: str) -> os.stat_result:
    metadata: os.stat_result | None = None
    try:
        metadata = os.stat("/", follow_symlinks=False)
    except OSError:
        pass
    if metadata is None:
        raise _AcquisitionFailure(failure_code)
    return metadata


def _read(descriptor: int, size: int, *, failure_code: str) -> bytes:
    chunk: bytes | None = None
    try:
        chunk = os.read(descriptor, size)
    except OSError:
        pass
    if chunk is None:
        raise _AcquisitionFailure(failure_code)
    return chunk


def _close_descriptors(descriptors: list[int]) -> bool:
    all_closed = True
    for descriptor in reversed(descriptors):
        try:
            os.close(descriptor)
        except OSError:
            all_closed = False
    return all_closed


def _print_json(payload: dict[str, object]) -> None:
    sys.stdout.write(
        json.dumps(
            payload,
            ensure_ascii=True,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    )


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    if len(arguments) != 1:
        _print_json(
            {
                "status": "REJECTED",
                "code": "HISTORICAL_SOURCE_USAGE_INVALID",
            }
        )
        return 2
    try:
        source = load_historical_source_directory(arguments[0], now_ns=time.time_ns())
    except HistoricalSourceInvalid as error:
        rejected: dict[str, object] = {
            "status": "REJECTED",
            "code": error.code,
        }
        if error.line is not None:
            rejected["line"] = error.line
        _print_json(rejected)
        return 2
    _print_json(
        {
            "status": "VALIDATED_NOT_PUBLISHED",
            "source_id": source.source_id,
            "raw_sha256": source.raw_sha256,
            "metadata_sha256": source.metadata_sha256,
            "record_count": source.record_count,
            "catalog_published": False,
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
