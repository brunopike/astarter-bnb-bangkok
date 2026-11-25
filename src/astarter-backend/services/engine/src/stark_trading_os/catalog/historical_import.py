"""Bounded local operator CLI for immutable historical catalog publication."""

from __future__ import annotations

import json
import re
import stat
import sys
import time
from collections.abc import Sequence
from pathlib import Path

from stark_trading_os.catalog.fixture_publisher import (
    CatalogPublishError,
    open_catalog_service,
)
from stark_trading_os.catalog.historical_loader import load_historical_source_directory
from stark_trading_os.catalog.historical_source import HistoricalSourceInvalid
from stark_trading_os.control.registry import CatalogStorageFailed, ControlStore

_PATH_BYTE_LIMIT = 4096
_STABLE_CODE = re.compile(r"^[A-Z][A-Z0-9_]{2,127}$")


class _ImportFailure(RuntimeError):
    code: str

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def main(argv: Sequence[str] | None = None) -> int:
    """Run one validate/recover/publish/revalidate operation."""

    arguments = tuple(sys.argv[1:] if argv is None else argv)
    if len(arguments) != 2:
        _emit({"code": "HISTORICAL_IMPORT_USAGE_INVALID", "status": "REJECTED"})
        return 2
    try:
        result = _publish(arguments[0], arguments[1])
    except Exception as error:
        _emit({"code": _failure_code(error), "status": "REJECTED"})
        return 2
    _emit(result)
    return 0


def _publish(source_directory: str, runtime_directory: str) -> dict[str, object]:
    source = load_historical_source_directory(source_directory, now_ns=time.time_ns())
    runtime_root = _validated_runtime_root(source_directory, runtime_directory)
    service, store = open_catalog_service(fixture_root=None, runtime_root=runtime_root)
    primary: BaseException | None = None
    try:
        service.recover()
        published = service.publish_historical(source)
        revalidated = service.revalidate(published.catalog_revision)
        if (
            revalidated != published
            or revalidated.status != "PUBLISHED"
            or revalidated.fixture_id != source.source_id
        ):
            raise CatalogPublishError("HISTORICAL_FINAL_REVALIDATION_FAILED")
        return {
            "catalog_published": True,
            "catalog_revision": revalidated.catalog_revision,
            "inventory_hash": revalidated.inventory_hash,
            "record_count": source.record_count,
            "source_id": source.source_id,
            "status": "PUBLISHED",
        }
    except BaseException as error:
        primary = error
        raise
    finally:
        _close_store(store, primary=primary)


def _validated_runtime_root(source_directory: str, runtime_directory: str) -> Path:
    source_parts = _canonical_absolute_parts(
        source_directory,
        code="HISTORICAL_SOURCE_PATH_INVALID",
    )
    runtime_parts = _canonical_absolute_parts(
        runtime_directory,
        code="HISTORICAL_RUNTIME_PATH_INVALID",
    )
    _require_physical_directory_chain(
        source_parts,
        leaf_may_be_missing=False,
        code="HISTORICAL_SOURCE_PATH_INVALID",
    )
    _require_physical_directory_chain(
        runtime_parts,
        leaf_may_be_missing=True,
        code="HISTORICAL_RUNTIME_PATH_INVALID",
    )
    if _is_prefix(source_parts, runtime_parts) or _is_prefix(runtime_parts, source_parts):
        raise _ImportFailure("HISTORICAL_RUNTIME_OVERLAP")
    return Path("/", *runtime_parts)


def _canonical_absolute_parts(
    value: str,
    *,
    code: str,
) -> tuple[str, ...]:
    invalid = type(value) is not str
    encoded_length = 0
    if not invalid:
        try:
            encoded_length = len(value.encode("utf-8"))
        except UnicodeEncodeError:
            invalid = True
    if (
        invalid
        or encoded_length > _PATH_BYTE_LIMIT
        or not value.startswith("/")
        or value == "/"
        or "\x00" in value
        or "\\" in value
        or value.endswith("/")
        or "//" in value
    ):
        raise _ImportFailure(code)
    parts = tuple(value[1:].split("/"))
    if any(part in {"", ".", ".."} for part in parts):
        raise _ImportFailure(code)
    return parts


def _require_physical_directory_chain(
    parts: tuple[str, ...],
    *,
    leaf_may_be_missing: bool,
    code: str,
) -> None:
    current = Path("/")
    for index, part in enumerate(parts):
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            if leaf_may_be_missing and index == len(parts) - 1:
                return
            raise _ImportFailure(code) from None
        except OSError:
            raise _ImportFailure(code) from None
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise _ImportFailure(code)


def _is_prefix(left: tuple[str, ...], right: tuple[str, ...]) -> bool:
    return len(left) <= len(right) and right[: len(left)] == left


def _close_store(store: ControlStore, *, primary: BaseException | None) -> None:
    try:
        store.close()
    except BaseException as error:
        if primary is None:
            if isinstance(error, Exception):
                raise CatalogStorageFailed from error
            raise
        primary.add_note("Secondary cleanup failure: CATALOG_STORAGE_FAILED")


def _failure_code(error: Exception) -> str:
    if isinstance(error, HistoricalSourceInvalid):
        code = error.code
    elif isinstance(error, _ImportFailure):
        code = error.code
    else:
        code = str(error)
    if _STABLE_CODE.fullmatch(code) is None:
        return "HISTORICAL_IMPORT_FAILED"
    return code


def _emit(value: dict[str, object]) -> None:
    rendered = json.dumps(value, sort_keys=True, separators=(",", ":"))
    sys.stdout.write(f"{rendered}\n")


if __name__ == "__main__":
    raise SystemExit(main())
