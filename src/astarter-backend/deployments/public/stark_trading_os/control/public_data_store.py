"""Explicit, bounded SQLite PUBLIC projections; never a Control database or ledger."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import Protocol

from stark_trading_os.control.public_data_models import PublicDataPayload, PublicDataResource
from stark_trading_os.integrations.public_data.models import (
    AssetData,
    ExplorerCapability,
    MarketData,
    Mode,
    NewsData,
)

_SCHEMA_VERSION = "AstarterPublicData.v1"
_PROJECTION_VERSION = "public-data-projection.v1"
_APPLICATION_ID = 0x41504443
_MAX_TIME = 253402300799999
_RESOURCES = {"markets", "assets", "news", "explorer/capabilities"}
_DDL = """CREATE TABLE public_data_cache (
    resource TEXT NOT NULL CHECK(resource IN ('markets','assets','news','explorer/capabilities')),
    mode TEXT NOT NULL CHECK(mode IN ('offline_fixture','live_readonly')),
    tenant_scope TEXT NOT NULL CHECK(tenant_scope = 'PUBLIC'),
    schema_version TEXT NOT NULL CHECK(schema_version = 'AstarterPublicData.v1'),
    projection_version TEXT NOT NULL CHECK(projection_version = 'public-data-projection.v1'),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9223372036854775807),
    fetched_at_ms INTEGER NOT NULL CHECK(fetched_at_ms BETWEEN 0 AND 253402300799999),
    refresh_at_ms INTEGER NOT NULL CHECK(refresh_at_ms BETWEEN fetched_at_ms AND 253402300799999),
    payload_json TEXT NOT NULL CHECK(length(payload_json) <= 1048576 AND json_valid(payload_json)),
    last_good_json TEXT CHECK(last_good_json IS NULL OR
        (length(last_good_json) <= 1048576 AND json_valid(last_good_json))),
    CHECK(COALESCE(json_type(payload_json) = 'object'
        AND json_extract(payload_json, '$.mode') = mode
        AND json_extract(payload_json, '$.quality') IN ('fresh','partial','stale','unavailable')
        AND json_type(payload_json, '$.items') = 'array'
        AND json_type(payload_json, '$.sources') = 'array'
        AND json_type(payload_json, '$.coverage') = 'object', 0)),
    CHECK(last_good_json IS NULL OR COALESCE(json_type(last_good_json) = 'object'
        AND json_extract(last_good_json, '$.mode') = mode
        AND json_extract(last_good_json, '$.quality') IN ('fresh','partial','stale')
        AND json_type(last_good_json, '$.items') = 'array'
        AND json_type(last_good_json, '$.sources') = 'array'
        AND json_type(last_good_json, '$.coverage') = 'object', 0)),
    CHECK((json_extract(payload_json, '$.quality') = 'unavailable' AND last_good_json IS NULL)
        OR (json_extract(payload_json, '$.quality') != 'unavailable'
            AND last_good_json IS NOT NULL)),
    PRIMARY KEY(resource, mode, tenant_scope, schema_version, projection_version)
) STRICT, WITHOUT ROWID"""


class PublicDataStoreError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("PUBLIC_DATA_STORE_FAILED")


@dataclass(frozen=True, slots=True)
class StoredPublicData:
    payload: PublicDataPayload
    last_good: PublicDataPayload | None
    fetched_at_ms: int
    refresh_at_ms: int
    revision: int


class PublicSnapshotStore(Protocol):
    @property
    def mode(self) -> Mode: ...

    def load(self, resource: PublicDataResource) -> StoredPublicData | None: ...

    def validate_payload(
        self, resource: PublicDataResource, payload: PublicDataPayload,
    ) -> None: ...

    def save(self, resource: PublicDataResource, *, payload: PublicDataPayload,
             last_good: PublicDataPayload | None, fetched_at_ms: int, refresh_at_ms: int,
             expected_revision: int) -> StoredPublicData | None: ...


def _payload(resource: str, mode: str, value: PublicDataPayload) -> PublicDataPayload:
    result = PublicDataPayload.model_validate(value)
    if resource not in _RESOURCES or result.mode != mode:
        raise PublicDataStoreError()
    expected, maximum = {
        "markets": (MarketData, 3), "assets": (AssetData, 3),
        "news": (NewsData, 50), "explorer/capabilities": (ExplorerCapability, 12),
    }[resource]
    subjects = (
        {"news"} if resource == "news" else
        {"bitcoin", "ethereum", "solana"} if resource in {"markets", "assets"} else
        {"1", "56", "8453", "42161", "137", "10"}
    )
    if (
        len(result.items) > maximum or len(result.sources) > 16
        or len({item.record_id for item in result.items}) != len(result.items)
        or any(not isinstance(item.data, expected) or item.subject_id not in subjects
               for item in result.items)
        or not set(result.coverage.requested_subjects) <= subjects
        or not set(result.coverage.returned_subjects) <= subjects
        or not set(result.coverage.gaps) <= subjects
        or (resource != "news" and not result.items and result.quality != "unavailable")
    ):
        raise PublicDataStoreError()
    return result


def _observation(payload: PublicDataPayload) -> dict[str, object]:
    value = payload.model_dump(exclude={"quality", "sources", "items"})
    value["items"] = [item.model_dump(exclude={"quality"}) for item in payload.items]
    return value


def _state(
    resource: str, mode: str, payload: PublicDataPayload, last_good: PublicDataPayload | None,
    fetched_at_ms: int, refresh_at_ms: int, revision: int,
) -> StoredPublicData:
    if (
        type(fetched_at_ms) is not int or type(refresh_at_ms) is not int
        or type(revision) is not int or not 0 < revision <= 9223372036854775807
        or not 0 <= fetched_at_ms <= refresh_at_ms <= _MAX_TIME
    ):
        raise PublicDataStoreError()
    payload = _payload(resource, mode, payload)
    if last_good is not None:
        last_good = _payload(resource, mode, last_good)
        if (
            last_good.quality == "unavailable"
            or _observation(payload) != _observation(last_good)
        ):
            raise PublicDataStoreError()
    if (payload.quality == "unavailable") != (last_good is None):
        raise PublicDataStoreError()
    return StoredPublicData(payload, last_good, fetched_at_ms, refresh_at_ms, revision)


class PublicDataStore:
    """One explicit mode per connection. App lifespan, not the service, owns close.

    CAS is completion fencing, not a cross-worker fetch lease. Only short SQLite
    transactions are held; callers fetch outside them. No repair or migration.
    """

    def __init__(self, path: Path, *, mode: Mode) -> None:
        if not path.is_absolute() or mode not in {"offline_fixture", "live_readonly"}:
            raise PublicDataStoreError()
        self._mode: Mode = mode
        self.path = path.resolve()
        self._lock = RLock()
        self._closed = False
        try:
            self._db = sqlite3.connect(path, timeout=0, check_same_thread=False,
                                       isolation_level=None)
        except (sqlite3.Error, OSError):
            raise PublicDataStoreError() from None
        self._db.row_factory = sqlite3.Row
        try:
            with self._operation():
                # Check identity BEFORE any schema/pragma writes. Even an empty
                # foreign DB with a nonzero application/version marker is rejected.
                self._db.execute("BEGIN IMMEDIATE")
                objects = self._db.execute("SELECT name FROM sqlite_schema").fetchall()
                app_id = self._db.execute("PRAGMA application_id").fetchone()[0]
                version = self._db.execute("PRAGMA user_version").fetchone()[0]
                if not objects and app_id == 0 and version == 0:
                    self._db.execute(_DDL)
                    self._db.execute(f"PRAGMA application_id = {_APPLICATION_ID}")
                    self._db.execute("PRAGMA user_version = 1")
                self._verify_schema()
                if [tuple(row) for row in self._db.execute("PRAGMA quick_check")] != [("ok",)]:
                    raise PublicDataStoreError()
                for row in self._db.execute("SELECT * FROM public_data_cache"):
                    self._decode(row)
                self._db.commit()
        except Exception:
            self._db.close()
            self._closed = True
            raise

    @property
    def mode(self) -> Mode:
        return self._mode

    @contextmanager
    def _operation(self) -> Iterator[None]:
        with self._lock:
            if self._closed:
                raise PublicDataStoreError()
            try:
                yield
            except (sqlite3.Error, ValueError, TypeError, OverflowError):
                raise PublicDataStoreError() from None
            finally:
                try:
                    if self._db.in_transaction:
                        self._db.rollback()
                except sqlite3.Error:
                    raise PublicDataStoreError() from None

    def _verify_schema(self) -> None:
        objects = [tuple(row) for row in self._db.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name"
        )]
        if (
            objects != [("table", "public_data_cache", "public_data_cache", _DDL)]
            or self._db.execute("PRAGMA application_id").fetchone()[0] != _APPLICATION_ID
            or self._db.execute("PRAGMA user_version").fetchone()[0] != 1
        ):
            raise PublicDataStoreError()

    @staticmethod
    def _decode(row: sqlite3.Row) -> StoredPublicData:
        if (
            row["tenant_scope"] != "PUBLIC" or row["schema_version"] != _SCHEMA_VERSION
            or row["projection_version"] != _PROJECTION_VERSION
            or row["mode"] not in {"offline_fixture", "live_readonly"}
        ):
            raise PublicDataStoreError()
        return _state(
            row["resource"], row["mode"],
            PublicDataPayload.model_validate_json(row["payload_json"]),
            None if row["last_good_json"] is None else
            PublicDataPayload.model_validate_json(row["last_good_json"]),
            row["fetched_at_ms"], row["refresh_at_ms"], row["revision"],
        )

    def _read(self, resource: PublicDataResource) -> StoredPublicData | None:
        if resource not in _RESOURCES:
            raise PublicDataStoreError()
        row = self._db.execute(
            "SELECT * FROM public_data_cache WHERE resource = ? AND mode = ? "
            "AND tenant_scope = 'PUBLIC' AND schema_version = ? AND projection_version = ?",
            (resource, self.mode, _SCHEMA_VERSION, _PROJECTION_VERSION),
        ).fetchone()
        return None if row is None else self._decode(row)

    def load(self, resource: PublicDataResource) -> StoredPublicData | None:
        with self._operation():
            self._db.execute("BEGIN")
            self._verify_schema()
            return self._read(resource)

    def validate_payload(
        self, resource: PublicDataResource, payload: PublicDataPayload,
    ) -> None:
        """Validate a collector observation before replacing its last-good snapshot."""
        _payload(resource, self.mode, payload)

    def save(
        self, resource: PublicDataResource, *, payload: PublicDataPayload,
        last_good: PublicDataPayload | None, fetched_at_ms: int, refresh_at_ms: int,
        expected_revision: int,
    ) -> StoredPublicData | None:
        """Atomically save all state, or return None if another completion won."""
        with self._operation():
            if type(expected_revision) is not int or expected_revision < 0:
                raise PublicDataStoreError()
            state = _state(resource, self.mode, payload, last_good, fetched_at_ms,
                           refresh_at_ms, expected_revision + 1)
            self._db.execute("BEGIN IMMEDIATE")
            self._verify_schema()
            previous = self._read(resource)
            if (0 if previous is None else previous.revision) != expected_revision:
                return None
            self._db.execute(
                "INSERT INTO public_data_cache VALUES (?, ?, 'PUBLIC', ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(resource, mode, tenant_scope, schema_version, projection_version) "
                "DO UPDATE SET revision=excluded.revision, fetched_at_ms=excluded.fetched_at_ms, "
                "refresh_at_ms=excluded.refresh_at_ms, payload_json=excluded.payload_json, "
                "last_good_json=excluded.last_good_json",
                (resource, self.mode, _SCHEMA_VERSION, _PROJECTION_VERSION, state.revision,
                 fetched_at_ms, refresh_at_ms, state.payload.model_dump_json(),
                 None if state.last_good is None else state.last_good.model_dump_json()),
            )
            self._db.commit()
            return state

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                try:
                    self._db.close()
                except sqlite3.Error:
                    raise PublicDataStoreError() from None
                finally:
                    self._closed = True
