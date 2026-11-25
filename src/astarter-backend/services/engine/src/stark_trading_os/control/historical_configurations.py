"""Audited v2 configuration rows in the shared single-writer Control database."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from hashlib import sha256

from pydantic import TypeAdapter, ValidationError

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.audit.historical_input import (
    HistoricalInputInvalid,
    configuration_bytes,
    parse_configuration_bytes,
    validate_configuration_catalog_binding,
)
from stark_trading_os.control.database import _immediate_transaction, _verify_write_connection
from stark_trading_os.control.historical_configuration_models import (
    HistoricalStrategyConfigurationVersionV2,
    HistoricalStrategyDraftV2,
)
from stark_trading_os.control.strategy_configurations import (
    StrategyConfigurationError,
    StrategyConfigurationIntegrityError,
    StrategyConfigurationStorageError,
    StrategyConfigurationUnknown,
    StrategyDraftUnknown,
    StrategyRevisionConflict,
    _append_audit,
    _row_bytes,
    _row_int,
    _row_str,
)
from stark_trading_os.control.strategy_models import (
    PositiveRevision,
    StrategyConfigurationId,
    StrategyDraftId,
)
from stark_trading_os.control.transactions import ControlStoreError, read_catalog_publication
from stark_trading_os.domain.historical_input import SmaConfigurationInputV2

_DRAFT_ID: TypeAdapter[str] = TypeAdapter(StrategyDraftId)
_CONFIGURATION_ID: TypeAdapter[str] = TypeAdapter(StrategyConfigurationId)
_REVISION: TypeAdapter[int] = TypeAdapter(PositiveRevision)
_KIND = "StrategyConfigurationInput.v2"


class HistoricalConfigurationCatalogError(StrategyConfigurationError):
    """Stored catalog evidence is not a usable historical publication."""

    def __init__(self) -> None:
        super().__init__("HISTORICAL_CONFIGURATION_CATALOG_INVALID")


def _identity(*, draft_id: str, revision: int | None = None) -> None:
    try:
        _DRAFT_ID.validate_python(draft_id, strict=True)
        if revision is not None:
            _REVISION.validate_python(revision, strict=True)
    except ValidationError:
        raise StrategyConfigurationIntegrityError("HISTORICAL_CONFIGURATION_ID_INVALID") from None


def _configuration_id(value: str) -> None:
    try:
        _CONFIGURATION_ID.validate_python(value, strict=True)
    except ValidationError:
        raise StrategyConfigurationIntegrityError("HISTORICAL_CONFIGURATION_ID_INVALID") from None


def _encode(configuration: SmaConfigurationInputV2) -> bytes:
    try:
        return configuration_bytes(configuration)
    except HistoricalInputInvalid:
        raise StrategyConfigurationIntegrityError(
            "HISTORICAL_CONFIGURATION_INPUT_INVALID"
        ) from None


def _now(clock: Callable[[], int]) -> int:
    value = clock()
    if type(value) is not int or not 10**18 <= value <= 2**63 - 1:
        raise StrategyConfigurationIntegrityError("HISTORICAL_CONFIGURATION_CLOCK_INVALID")
    return value


@contextmanager
def _read_snapshot(connection: sqlite3.Connection) -> Iterator[None]:
    _verify_write_connection(connection)
    if connection.in_transaction:
        raise RuntimeError("Nested configuration read transactions are not permitted.")
    try:
        connection.execute("BEGIN")
        yield
        connection.commit()
    except BaseException:
        if connection.in_transaction:
            connection.rollback()
        raise


def _configuration(row: sqlite3.Row) -> SmaConfigurationInputV2:
    try:
        if _row_str(row, "content_schema") != _KIND:
            raise HistoricalInputInvalid()
        return parse_configuration_bytes(
            _row_bytes(row, "content_bytes"), expected_sha256=_row_str(row, "content_sha256")
        )
    except HistoricalInputInvalid:
        raise StrategyConfigurationIntegrityError(
            "HISTORICAL_CONFIGURATION_CONTENT_INVALID"
        ) from None


def _audit(
    connection: sqlite3.Connection,
    *,
    action: str,
    draft_id: str,
    configuration_id: str | None,
    revision: int,
    content_sha256: str,
    created_at_ns: int | None = None,
) -> int:
    rows = connection.execute(
        """SELECT * FROM strategy_configuration_audit_entries
           WHERE action=? AND draft_id=? AND configuration_id IS ? AND revision=?""",
        (action, draft_id, configuration_id, revision),
    ).fetchall()
    if len(rows) != 1:
        raise StrategyConfigurationIntegrityError("HISTORICAL_CONFIGURATION_AUDIT_INVALID")
    row = rows[0]
    expected = canonical_json_bytes(
        dict(
            action=action,
            configuration_id=configuration_id,
            content_sha256=content_sha256,
            draft_id=draft_id,
            revision=revision,
        )
    )
    timestamp = _row_int(row, "created_at_ns")
    if (
        _row_bytes(row, "entry_bytes") != expected
        or _row_str(row, "entry_sha256") != sha256(expected).hexdigest()
        or _row_str(row, "content_sha256") != content_sha256
        or not 10**18 <= timestamp <= 2**63 - 1
        or (created_at_ns is not None and timestamp != created_at_ns)
    ):
        raise StrategyConfigurationIntegrityError("HISTORICAL_CONFIGURATION_AUDIT_INVALID")
    return timestamp


def _draft_from_row(connection: sqlite3.Connection, row: sqlite3.Row) -> HistoricalStrategyDraftV2:
    try:
        value = HistoricalStrategyDraftV2(
            configuration=_configuration(row),
            draft_id=_row_str(row, "draft_id"),
            revision=_row_int(row, "revision"),
            created_at_ns=str(_row_int(row, "created_at_ns")),
            updated_at_ns=str(_row_int(row, "updated_at_ns")),
        )
    except ValidationError:
        raise StrategyConfigurationIntegrityError(
            "HISTORICAL_CONFIGURATION_DRAFT_INVALID"
        ) from None
    _audit(
        connection,
        action="strategy_draft.created" if value.revision == 1 else "strategy_draft.updated",
        draft_id=value.draft_id,
        configuration_id=None,
        revision=value.revision,
        content_sha256=_row_str(row, "content_sha256"),
        created_at_ns=int(value.updated_at_ns),
    )
    initial = connection.execute(
        """SELECT content_sha256 FROM strategy_configuration_audit_entries
           WHERE action='strategy_draft.created' AND draft_id=? AND revision=1""",
        (value.draft_id,),
    ).fetchall()
    if len(initial) != 1:
        raise StrategyConfigurationIntegrityError("HISTORICAL_CONFIGURATION_AUDIT_INVALID")
    _audit(
        connection,
        action="strategy_draft.created",
        draft_id=value.draft_id,
        configuration_id=None,
        revision=1,
        content_sha256=_row_str(initial[0], "content_sha256"),
        created_at_ns=int(value.created_at_ns),
    )
    return value


def _validate_publication_order(connection: sqlite3.Connection, draft_id: str) -> None:
    """Bind persisted ordinals to the independently append-only publication log."""

    versions = connection.execute(
        "SELECT * FROM strategy_configuration_versions WHERE draft_id=? ORDER BY version",
        (draft_id,),
    ).fetchall()
    audits = connection.execute(
        "SELECT * FROM strategy_configuration_audit_entries WHERE draft_id=? "
        "AND action='strategy_configuration.published' ORDER BY audit_seq",
        (draft_id,),
    ).fetchall()
    if len(versions) != len(audits):
        raise StrategyConfigurationIntegrityError("HISTORICAL_CONFIGURATION_LINEAGE_INVALID")
    previous_revision = 0
    for ordinal, (version, audit) in enumerate(zip(versions, audits, strict=True), start=1):
        revision = _row_int(version, "source_revision")
        configuration_id = _row_str(version, "configuration_id")
        digest = _row_str(version, "content_sha256")
        timestamp = _row_int(version, "created_at_ns")
        if (
            _row_str(version, "content_schema") != _KIND
            or _row_int(version, "version") != ordinal
            or revision <= previous_revision
            or _row_str(audit, "configuration_id") != configuration_id
            or _row_int(audit, "revision") != revision
        ):
            raise StrategyConfigurationIntegrityError("HISTORICAL_CONFIGURATION_LINEAGE_INVALID")
        _audit(
            connection,
            action="strategy_configuration.published",
            draft_id=draft_id,
            configuration_id=configuration_id,
            revision=revision,
            content_sha256=digest,
            created_at_ns=timestamp,
        )
        previous_revision = revision


def _version_from_row(
    connection: sqlite3.Connection, row: sqlite3.Row
) -> HistoricalStrategyConfigurationVersionV2:
    try:
        value = HistoricalStrategyConfigurationVersionV2(
            configuration=_configuration(row),
            configuration_id=_row_str(row, "configuration_id"),
            draft_id=_row_str(row, "draft_id"),
            version=_row_int(row, "version"),
            source_revision=_row_int(row, "source_revision"),
            content_sha256=_row_str(row, "content_sha256"),
            created_at_ns=str(_row_int(row, "created_at_ns")),
        )
    except ValidationError:
        raise StrategyConfigurationIntegrityError(
            "HISTORICAL_CONFIGURATION_VERSION_INVALID"
        ) from None
    parent = connection.execute(
        "SELECT content_schema,revision FROM strategy_drafts WHERE draft_id=?", (value.draft_id,)
    ).fetchone()
    if (
        parent is None
        or parent["content_schema"] != _KIND
        or parent["revision"] < value.source_revision
    ):
        raise StrategyConfigurationIntegrityError("HISTORICAL_CONFIGURATION_LINEAGE_INVALID")
    _validate_publication_order(connection, value.draft_id)
    source_time = _audit(
        connection,
        action="strategy_draft.created" if value.source_revision == 1 else "strategy_draft.updated",
        draft_id=value.draft_id,
        configuration_id=None,
        revision=value.source_revision,
        content_sha256=value.content_sha256,
    )
    if source_time > int(value.created_at_ns):
        raise StrategyConfigurationIntegrityError("HISTORICAL_CONFIGURATION_LINEAGE_INVALID")
    return value


def _draft(connection: sqlite3.Connection, draft_id: str) -> HistoricalStrategyDraftV2 | None:
    row = connection.execute(
        "SELECT * FROM strategy_drafts WHERE content_schema=? AND draft_id=?", (_KIND, draft_id)
    ).fetchone()
    return None if row is None else _draft_from_row(connection, row)


def _version(
    connection: sqlite3.Connection, configuration_id: str
) -> HistoricalStrategyConfigurationVersionV2 | None:
    row = connection.execute(
        "SELECT * FROM strategy_configuration_versions "
        "WHERE content_schema=? AND configuration_id=?",
        (_KIND, configuration_id),
    ).fetchone()
    return None if row is None else _version_from_row(connection, row)


def create_historical_strategy_draft(
    connection: sqlite3.Connection,
    *,
    clock: Callable[[], int],
    draft_id: str,
    configuration: SmaConfigurationInputV2,
) -> HistoricalStrategyDraftV2:
    _identity(draft_id=draft_id)
    raw = _encode(configuration)
    digest = sha256(raw).hexdigest()
    try:
        with _immediate_transaction(connection):
            now = _now(clock)
            connection.execute(
                """INSERT INTO strategy_drafts(draft_id,content_bytes,content_sha256,
                   revision,created_at_ns,updated_at_ns,content_schema) VALUES(?,?,?,1,?,?,?)""",
                (draft_id, raw, digest, now, now, _KIND),
            )
            _append_audit(
                connection,
                action="strategy_draft.created",
                draft_id=draft_id,
                configuration_id=None,
                revision=1,
                content_sha256=digest,
                created_at_ns=now,
            )
            result = _draft(connection, draft_id)
            assert result is not None
            return result
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error


def update_historical_strategy_draft(
    connection: sqlite3.Connection,
    *,
    clock: Callable[[], int],
    draft_id: str,
    expected_revision: int,
    configuration: SmaConfigurationInputV2,
) -> HistoricalStrategyDraftV2:
    _identity(draft_id=draft_id, revision=expected_revision)
    raw = _encode(configuration)
    digest = sha256(raw).hexdigest()
    try:
        with _immediate_transaction(connection):
            current = _draft(connection, draft_id)
            if current is None:
                raise StrategyDraftUnknown(draft_id)
            if current.revision != expected_revision:
                raise StrategyRevisionConflict(draft_id)
            _identity(draft_id=draft_id, revision=expected_revision + 1)
            now = _now(clock)
            if now < int(current.updated_at_ns):
                raise StrategyConfigurationIntegrityError("HISTORICAL_CONFIGURATION_CLOCK_INVALID")
            updated = connection.execute(
                """UPDATE strategy_drafts SET content_bytes=?,content_sha256=?,revision=?,
                   updated_at_ns=? WHERE content_schema=? AND draft_id=? AND revision=?""",
                (raw, digest, expected_revision + 1, now, _KIND, draft_id, expected_revision),
            )
            if updated.rowcount != 1:
                raise StrategyRevisionConflict(draft_id)
            _append_audit(
                connection,
                action="strategy_draft.updated",
                draft_id=draft_id,
                configuration_id=None,
                revision=expected_revision + 1,
                content_sha256=digest,
                created_at_ns=now,
            )
            result = _draft(connection, draft_id)
            assert result is not None
            return result
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error


def _require_published_catalog(
    connection: sqlite3.Connection, configuration: SmaConfigurationInputV2
) -> None:
    try:
        publication = read_catalog_publication(connection, configuration.catalog_revision)
        if publication is None or publication.status != "PUBLISHED":
            raise HistoricalConfigurationCatalogError()
        validate_configuration_catalog_binding(
            configuration, catalog_manifest_bytes=publication.publication_bytes
        )
    except (ControlStoreError, HistoricalInputInvalid, ValueError):
        raise HistoricalConfigurationCatalogError() from None


def publish_historical_strategy_draft(
    connection: sqlite3.Connection,
    *,
    clock: Callable[[], int],
    draft_id: str,
    expected_revision: int,
    configuration_id: str,
) -> HistoricalStrategyConfigurationVersionV2:
    _identity(draft_id=draft_id, revision=expected_revision)
    _configuration_id(configuration_id)
    try:
        with _immediate_transaction(connection):
            existing = connection.execute(
                """SELECT * FROM strategy_configuration_versions
                   WHERE content_schema=? AND draft_id=? AND source_revision=?""",
                (_KIND, draft_id, expected_revision),
            ).fetchone()
            if existing is not None:
                return _version_from_row(connection, existing)
            current = _draft(connection, draft_id)
            if current is None:
                raise StrategyDraftUnknown(draft_id)
            if current.revision != expected_revision:
                raise StrategyRevisionConflict(draft_id)
            _require_published_catalog(connection, current.configuration)
            prior = connection.execute(
                """SELECT * FROM strategy_configuration_versions
                   WHERE content_schema=? AND draft_id=? ORDER BY version""",
                (_KIND, draft_id),
            ).fetchall()
            versions = tuple(_version_from_row(connection, row) for row in prior)
            if tuple(v.version for v in versions) != tuple(range(1, len(versions) + 1)):
                raise StrategyConfigurationIntegrityError(
                    "HISTORICAL_CONFIGURATION_LINEAGE_INVALID"
                )
            number = len(versions) + 1
            raw = _encode(current.configuration)
            digest, now = sha256(raw).hexdigest(), _now(clock)
            if now < int(current.updated_at_ns):
                raise StrategyConfigurationIntegrityError("HISTORICAL_CONFIGURATION_CLOCK_INVALID")
            connection.execute(
                """INSERT INTO strategy_configuration_versions(configuration_id,draft_id,
                   version,source_revision,content_bytes,content_sha256,created_at_ns,content_schema)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (configuration_id, draft_id, number, expected_revision, raw, digest, now, _KIND),
            )
            _append_audit(
                connection,
                action="strategy_configuration.published",
                draft_id=draft_id,
                configuration_id=configuration_id,
                revision=expected_revision,
                content_sha256=digest,
                created_at_ns=now,
            )
            result = _version(connection, configuration_id)
            assert result is not None
            return result
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error


def read_historical_strategy_draft(
    connection: sqlite3.Connection, draft_id: str
) -> HistoricalStrategyDraftV2 | None:
    _identity(draft_id=draft_id)
    try:
        with _read_snapshot(connection):
            return _draft(connection, draft_id)
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error


def read_historical_strategy_drafts(
    connection: sqlite3.Connection,
) -> tuple[HistoricalStrategyDraftV2, ...]:
    try:
        with _read_snapshot(connection):
            rows = connection.execute(
                """SELECT * FROM strategy_drafts WHERE content_schema=?
                   ORDER BY updated_at_ns DESC,draft_id ASC""",
                (_KIND,),
            ).fetchall()
            return tuple(_draft_from_row(connection, row) for row in rows)
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error


def read_historical_strategy_configuration(
    connection: sqlite3.Connection, configuration_id: str
) -> HistoricalStrategyConfigurationVersionV2 | None:
    _configuration_id(configuration_id)
    try:
        with _read_snapshot(connection):
            return _version(connection, configuration_id)
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error


def read_historical_strategy_configuration_versions(
    connection: sqlite3.Connection, draft_id: str
) -> tuple[HistoricalStrategyConfigurationVersionV2, ...]:
    _identity(draft_id=draft_id)
    try:
        with _read_snapshot(connection):
            rows = connection.execute(
                """SELECT * FROM strategy_configuration_versions
                   WHERE content_schema=? AND draft_id=? ORDER BY version DESC""",
                (_KIND, draft_id),
            ).fetchall()
            versions = tuple(_version_from_row(connection, row) for row in rows)
            if tuple(v.version for v in versions) != tuple(range(len(versions), 0, -1)):
                raise StrategyConfigurationIntegrityError(
                    "HISTORICAL_CONFIGURATION_LINEAGE_INVALID"
                )
            return versions
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error


def _page_limit(limit: int) -> None:
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("Historical page limit must be an integer from 1 to 100.")


def read_historical_strategy_draft_page(
    connection: sqlite3.Connection,
    *,
    after_id: str | None,
    limit: int,
) -> tuple[tuple[HistoricalStrategyDraftV2, ...], str | None]:
    _page_limit(limit)
    if after_id is not None:
        _identity(draft_id=after_id)
    try:
        with _read_snapshot(connection):
            if after_id is not None and _draft(connection, after_id) is None:
                raise StrategyDraftUnknown(after_id)
            rows = connection.execute(
                "SELECT * FROM strategy_drafts WHERE content_schema=? AND draft_id>? "
                "ORDER BY draft_id ASC LIMIT ?",
                (_KIND, after_id or "", limit + 1),
            ).fetchall()
            items = tuple(_draft_from_row(connection, row) for row in rows[:limit])
            return items, items[-1].draft_id if len(rows) > limit else None
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error


def read_historical_strategy_configuration_page(
    connection: sqlite3.Connection,
    *,
    after_id: str | None,
    limit: int,
) -> tuple[tuple[HistoricalStrategyConfigurationVersionV2, ...], str | None]:
    _page_limit(limit)
    if after_id is not None:
        _configuration_id(after_id)
    try:
        with _read_snapshot(connection):
            if after_id is not None and _version(connection, after_id) is None:
                raise StrategyConfigurationUnknown(after_id)
            rows = connection.execute(
                "SELECT * FROM strategy_configuration_versions "
                "WHERE content_schema=? AND configuration_id>? "
                "ORDER BY configuration_id ASC LIMIT ?",
                (_KIND, after_id or "", limit + 1),
            ).fetchall()
            items = tuple(_version_from_row(connection, row) for row in rows[:limit])
            return items, items[-1].configuration_id if len(rows) > limit else None
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error
