"""Closed historical Control transactions; public execution capability stays closed.

The service accepts immutable configuration IDs, never a caller's input candidate.
Native/file observation occurs outside the writer lock. The same Control database
owns the rechecked identity, receipt, run, lifecycle events and idempotency records.
"""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr

from stark_trading_os.audit.canonical_json import canonical_json_bytes, parse_json_object
from stark_trading_os.audit.historical_input import (
    parse_input_manifest_bytes,
    validate_input_bindings,
)
from stark_trading_os.catalog.historical_catalog import (
    canonical_historical_bytes,
    parse_historical_model_bytes,
)
from stark_trading_os.control.database import _immediate_transaction, _verify_write_connection
from stark_trading_os.control.historical_configuration_service import (
    HistoricalConfigurationService,
    HistoricalInputCandidateV2,
)
from stark_trading_os.control.historical_configurations import _version
from stark_trading_os.control.preflight import RunReservation
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.run_contract import RunContractKind, require_historical_contract
from stark_trading_os.control.transactions import (
    EventCandidate,
    IdempotencyConflict,
    IdempotentResponse,
    _mutate_event,
    _read_catalog_publication,
    read_run,
)
from stark_trading_os.domain.historical_input import Digest, InputManifestV2
from stark_trading_os.domain.models import EventEnvelopeV1, RunState

_READY = "historical.preflight"
_CREATE = "historical.create"
_AFTER_CONSUME = frozenset(
    {
        RunState.QUEUED,
        RunState.RUNNING,
        RunState.CANCEL_REQUESTED,
        RunState.CANCEL_PENDING,
        RunState.FINALIZING,
        RunState.COMPLETED,
        RunState.FAILED,
        RunState.CANCELLED,
    }
)


class HistoricalPreflightStale(ValueError):
    def __init__(self) -> None:
        super().__init__("HISTORICAL_PREFLIGHT_STALE")


class HistoricalPreflightInvalid(ValueError):
    def __init__(self) -> None:
        super().__init__("HISTORICAL_PREFLIGHT_INVALID")


class HistoricalPreflightReceiptV2(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, serialize_by_alias=True)
    schema_: Literal["HistoricalPreflightReceipt.v2"] = Field(alias="schema")
    preflight_id: Annotated[StrictStr, Field(pattern=r"^pfh_[0-9a-f]{32}$")]
    run_id: Annotated[StrictStr, Field(pattern=r"^bt_[0-9a-f]{32}$")]
    state: Literal["PREFLIGHT_READY"]
    state_version: Literal[1]
    configuration_id: Annotated[StrictStr, Field(pattern=r"^cfg_[0-9a-f]{32}$")]
    configuration_version: Annotated[StrictInt, Field(ge=1)]
    configuration_content_sha256: Digest
    input_manifest_sha256: Digest
    request_sha256: Digest
    checked_at_ns: Annotated[StrictStr, Field(pattern=r"^[1-9][0-9]{18}$")]
    expires_at_ns: Annotated[StrictStr, Field(pattern=r"^[1-9][0-9]{18}$")]


@dataclass(frozen=True)
class HistoricalPreflightRecord:
    receipt: HistoricalPreflightReceiptV2
    input_manifest_bytes: bytes
    catalog_publication_bytes: bytes
    consumed_at_ns: int | None


def _hash(raw: bytes) -> str:
    return sha256(raw).hexdigest()


def _identifier(value: str, prefix: str) -> None:
    if type(value) is not str or re.fullmatch(prefix + r"_[0-9a-f]{32}", value) is None:
        raise HistoricalPreflightInvalid()


def _key(value: str) -> None:
    if type(value) is not str or re.fullmatch(r"[!-~]{1,128}", value) is None:
        raise HistoricalPreflightInvalid()


def _now(clock: Callable[[], int]) -> int:
    value = clock()
    if type(value) is not int or not 10**18 <= value < 2**63 - 300_000_000_000:
        raise HistoricalPreflightInvalid()
    return value


def _request(configuration_id: str) -> bytes:
    _identifier(configuration_id, "cfg")
    return canonical_json_bytes({"configuration_id": configuration_id})


def _consume_request(preflight_id: str, request_sha256: str) -> bytes:
    _identifier(preflight_id, "pfh")
    if type(request_sha256) is not str or re.fullmatch(r"[0-9a-f]{64}", request_sha256) is None:
        raise HistoricalPreflightInvalid()
    return canonical_json_bytes({"preflight_id": preflight_id, "request_sha256": request_sha256})


def _logical(scope: str, request: bytes) -> bytes:
    return canonical_json_bytes({"command": scope, "request": parse_json_object(request)})


@contextmanager
def _snapshot(connection: sqlite3.Connection) -> Iterator[None]:
    _verify_write_connection(connection)
    if connection.in_transaction:
        raise RuntimeError("Historical preflight reads cannot nest a transaction.")
    try:
        connection.execute("BEGIN")
        yield
    finally:
        if connection.in_transaction:
            connection.rollback()


def _boundary(
    connection: sqlite3.Connection,
    run_id: str,
    seq: int,
    kind: str,
    at_ns: int,
    payload: dict[str, object],
) -> None:
    event = connection.execute(
        "SELECT * FROM events WHERE run_id=? AND seq=?", (run_id, seq)
    ).fetchone()
    audit = connection.execute(
        "SELECT * FROM audit_intents WHERE run_id=? AND audit_seq=?", (run_id, seq)
    ).fetchone()
    outbox = connection.execute(
        "SELECT * FROM outbox WHERE run_id=? AND seq=?", (run_id, seq)
    ).fetchone()
    if event is None or audit is None or outbox is None:
        raise HistoricalPreflightInvalid()
    raw = event["envelope_bytes"]
    envelope = EventEnvelopeV1.model_validate(parse_json_object(raw))
    expected = {
        "event_id": event["event_id"],
        "run_id": run_id,
        "seq": seq,
        "source_seq": seq,
        "ts_event_ns": str(at_ns),
        "ts_ingest_ns": event["ts_ingest_ns"],
        "type": kind,
        "source": "control-api",
        "writer": "control-api",
        "schema_version": 1,
        "payload": payload,
    }
    if (
        envelope.model_dump(mode="json", by_alias=True) != expected
        or canonical_json_bytes(expected) != raw
        or event["type"] != kind
        or event["source"] != "control-api"
        or event["source_seq"] != seq
        or event["writer"] != "control-api"
        or event["schema_version"] != 1
        or event["visible"] != 1
        or event["ts_event_ns"] != str(at_ns)
        or audit["event_seq"] != seq
        or str(audit["created_at_ns"]) != envelope.ts_ingest_ns
        or audit["event_digest"] != _hash(raw)
        or outbox["audit_seq"] != seq
        or outbox["materialized"] not in {0, 1}
        or (outbox["materialized"] == 0) != (outbox["materialized_at_ns"] is None)
        or audit["intent_bytes"]
        != canonical_json_bytes(
            {
                "seq": seq,
                "run_id": run_id,
                "event_seq": seq,
                "event_digest": _hash(raw),
            }
        )
    ):
        raise HistoricalPreflightInvalid()


def _queue_body(record: HistoricalPreflightRecord) -> bytes:
    return canonical_json_bytes(
        {
            "run_id": record.receipt.run_id,
            "state": "QUEUED",
            "state_version": 2,
            "last_visible_seq": 2,
            "input_manifest_hash": record.receipt.input_manifest_sha256,
        }
    )


def _validate_idempotency_rows(
    connection: sqlite3.Connection, record: HistoricalPreflightRecord
) -> None:
    receipt = record.receipt
    run = read_run(connection, receipt.run_id)
    requests = [
        (_READY, _request(receipt.configuration_id), 200, canonical_historical_bytes(receipt))
    ]
    if record.consumed_at_ns is not None:
        requests.append(
            (
                _CREATE,
                _consume_request(receipt.preflight_id, receipt.request_sha256),
                202,
                _queue_body(record),
            )
        )
    for scope, request, status, body in requests:
        rows = connection.execute(
            "SELECT * FROM idempotency_records WHERE idempotency_scope=? AND run_id=?",
            (scope, receipt.run_id),
        ).fetchall()
        logical = _logical(scope, request)
        if len(rows) != 1 or (
            rows[0]["request_body"] != logical
            or rows[0]["request_hash"] != _hash(logical)
            or rows[0]["response_body"] != body
            or rows[0]["response_status"] != status
            or rows[0]["target_run_id"] is not None
            or rows[0]["created_at_ns"]
            != (run.created_at_ns if scope == _READY else record.consumed_at_ns)
        ):
            raise HistoricalPreflightInvalid()
        _key(rows[0]["idempotency_key"])
    if (
        record.consumed_at_ns is None
        and connection.execute(
            "SELECT 1 FROM idempotency_records WHERE idempotency_scope=? AND run_id=?",
            (_CREATE, receipt.run_id),
        ).fetchone()
        is not None
    ):
        raise HistoricalPreflightInvalid()


def _record(connection: sqlite3.Connection, preflight_id: str) -> HistoricalPreflightRecord | None:
    row = connection.execute(
        "SELECT * FROM historical_preflights WHERE preflight_id=?", (preflight_id,)
    ).fetchone()
    if row is None:
        return None
    try:
        receipt = parse_historical_model_bytes(row["result_bytes"], HistoricalPreflightReceiptV2)
        run = read_run(connection, receipt.run_id)
        if run.input_manifest_bytes is None or run.input_manifest_hash is None:
            raise HistoricalPreflightInvalid()
        manifest = parse_input_manifest_bytes(
            run.input_manifest_bytes, expected_sha256=run.input_manifest_hash
        )
        version = _version(connection, receipt.configuration_id)
        publication = _read_catalog_publication(connection, manifest.dataset.catalog_revision)
        request = _request(receipt.configuration_id)
        checked, expires, consumed = (
            row["checked_at_ns"],
            row["expires_at_ns"],
            row["consumed_at_ns"],
        )
        if (
            canonical_historical_bytes(receipt) != row["result_bytes"]
            or receipt.preflight_id != preflight_id
            or receipt.run_id != row["run_id"]
            or receipt.configuration_id != row["configuration_id"]
            or row["request_bytes"] != request
            or row["request_hash"] != _hash(request)
            or receipt.request_sha256 != _hash(request)
            or run.contract_kind is not RunContractKind.HISTORICAL_SMA_V2
            or run.input_manifest_hash != receipt.input_manifest_sha256
            or run.catalog_revision != manifest.dataset.catalog_revision
            or run.catalog_inventory_hash != manifest.dataset.inventory_hash
            or manifest.configuration_id != receipt.configuration_id
            or manifest.configuration_version != receipt.configuration_version
            or manifest.configuration_content_sha256 != receipt.configuration_content_sha256
            or version is None
            or version.version != receipt.configuration_version
            or version.content_sha256 != receipt.configuration_content_sha256
            or version.configuration != manifest.configuration.configuration
            or publication is None
            or publication.publication_bytes != row["catalog_publication_bytes"]
            or _hash(canonical_historical_bytes(manifest.configuration.configuration.risk))
            != row["risk_sha256"]
            or _hash(canonical_historical_bytes(manifest.runtime)) != row["runtime_sha256"]
            or row["account_id"] != "SIM-001"
            or str(checked) != receipt.checked_at_ns
            or str(expires) != receipt.expires_at_ns
            or not 0 < checked < expires
            or not checked <= run.created_at_ns < expires
        ):
            raise HistoricalPreflightInvalid()
        validate_input_bindings(
            manifest,
            catalog_manifest_bytes=row["catalog_publication_bytes"],
            expected_runtime=manifest.runtime,
        )
        if consumed is None:
            if (
                run.state is not RunState.PREFLIGHT_READY
                or run.state_version != 1
                or run.last_event_seq != 1
                or run.last_audit_seq != 1
            ):
                raise HistoricalPreflightInvalid()
        elif (
            not checked <= consumed < expires
            or run.state not in _AFTER_CONSUME
            or run.state_version < 2
            or run.last_event_seq < 2
            or run.last_audit_seq < 2
        ):
            raise HistoricalPreflightInvalid()
        _boundary(
            connection,
            receipt.run_id,
            1,
            "preflight.passed",
            checked,
            {
                "canonical_request_hash": receipt.request_sha256,
                "preflight_id": preflight_id,
            },
        )
        if consumed is not None:
            _boundary(
                connection,
                receipt.run_id,
                2,
                "run.queued",
                consumed,
                {"preflight_id": preflight_id},
            )
        result = HistoricalPreflightRecord(
            receipt, run.input_manifest_bytes, row["catalog_publication_bytes"], consumed
        )
        _validate_idempotency_rows(connection, result)
        return result
    except Exception:
        raise HistoricalPreflightInvalid() from None


class HistoricalPreflightService:
    """Internal preflight capability. Queueing remains unavailable to public callers."""

    def __init__(
        self,
        *,
        store: ControlStore,
        configurations: HistoricalConfigurationService,
        clock: Callable[[], int],
        ttl_ns: int = 60_000_000_000,
    ) -> None:
        if (
            type(store) is not ControlStore
            or type(configurations) is not HistoricalConfigurationService
        ):
            raise TypeError("Historical preflight requires exact Control services.")
        if (
            configurations._store is not store
            or type(ttl_ns) is not int
            or not 0 < ttl_ns <= 300_000_000_000
        ):
            raise HistoricalPreflightInvalid()
        self._store, self._configurations, self._clock, self._ttl_ns = (
            store,
            configurations,
            clock,
            ttl_ns,
        )

    def record(self, preflight_id: str) -> HistoricalPreflightRecord | None:
        _identifier(preflight_id, "pfh")
        with _snapshot(self._store._connection):
            return _record(self._store._connection, preflight_id)

    def record_for_run(self, run_id: str) -> HistoricalPreflightRecord:
        """Read a consumed admission with its original event and receipt bindings."""
        _identifier(run_id, "bt")
        connection = self._store._connection
        with _snapshot(connection):
            require_historical_contract(read_run(connection, run_id).contract_kind)
            row = connection.execute(
                "SELECT preflight_id FROM historical_preflights WHERE run_id=?", (run_id,)
            ).fetchone()
            if row is None:
                raise HistoricalPreflightInvalid()
            record = _record(connection, row["preflight_id"])
            if record is None or record.consumed_at_ns is None or record.receipt.run_id != run_id:
                raise HistoricalPreflightInvalid()
            return record

    def _replay(self, scope: str, key: str, request: bytes) -> HistoricalPreflightRecord | None:
        connection = self._store._connection
        row = connection.execute(
            "SELECT * FROM idempotency_records WHERE idempotency_scope=? AND idempotency_key=?",
            (scope, key),
        ).fetchone()
        if row is None:
            return None
        logical = _logical(scope, request)
        if row["request_body"] != logical or row["request_hash"] != _hash(logical):
            raise IdempotencyConflict
        identity = connection.execute(
            "SELECT preflight_id FROM historical_preflights WHERE run_id=?", (row["run_id"],)
        ).fetchone()
        if identity is None:
            raise HistoricalPreflightInvalid()
        record = _record(connection, identity["preflight_id"])
        if record is None or (scope == _CREATE and record.consumed_at_ns is None):
            raise HistoricalPreflightInvalid()
        return record

    def _save(
        self, scope: str, key: str, request: bytes, response: IdempotentResponse, now: int
    ) -> None:
        logical = _logical(scope, request)
        self._store._connection.execute(
            "INSERT INTO idempotency_records("
            "idempotency_scope,idempotency_key,request_hash,request_body,"
            "response_status,response_body,target_run_id,run_id,created_at_ns) "
            "VALUES(?,?,?,?,?,?,NULL,?,?)",
            (
                scope,
                key,
                _hash(logical),
                logical,
                response.status_code,
                response.body,
                response.run_id,
                now,
            ),
        )

    def _validate_current(
        self, candidate: HistoricalInputCandidateV2
    ) -> tuple[InputManifestV2, bytes]:
        if type(candidate) is not HistoricalInputCandidateV2:
            raise HistoricalPreflightStale()
        manifest = parse_input_manifest_bytes(
            candidate.input_manifest_bytes, expected_sha256=candidate.input_manifest_sha256
        )
        connection = self._store._connection
        version = _version(connection, candidate.configuration_id)
        publication = _read_catalog_publication(connection, candidate.catalog_revision)
        if (
            version is None
            or publication is None
            or publication.status != "PUBLISHED"
            or version.version != candidate.configuration_version
            or version.content_sha256 != candidate.configuration_content_sha256
            or manifest.configuration.configuration != version.configuration
            or manifest.configuration_id != candidate.configuration_id
            or manifest.configuration_version != candidate.configuration_version
            or manifest.configuration_content_sha256 != candidate.configuration_content_sha256
            or manifest.dataset.catalog_revision != candidate.catalog_revision
            or manifest.dataset.inventory_hash != publication.inventory_hash
        ):
            raise HistoricalPreflightStale()
        validate_input_bindings(
            manifest,
            catalog_manifest_bytes=publication.publication_bytes,
            expected_runtime=manifest.runtime,
        )
        return manifest, publication.publication_bytes

    def preflight(
        self, *, configuration_id: str, idempotency_key: str
    ) -> HistoricalPreflightReceiptV2:
        _key(idempotency_key)
        request = _request(configuration_id)
        connection = self._store._connection
        with _snapshot(connection):
            replay = self._replay(_READY, idempotency_key, request)
            if replay is not None:
                return replay.receipt
        checked = _now(self._clock)
        candidate = self._configurations.build_input_candidate(configuration_id)
        with _immediate_transaction(connection):
            replay = self._replay(_READY, idempotency_key, request)
            if replay is not None:
                return replay.receipt
            manifest, publication_bytes = self._validate_current(candidate)
            now, expires = _now(self._clock), checked + self._ttl_ns
            if not checked <= now < expires:
                raise HistoricalPreflightStale()
            receipt = HistoricalPreflightReceiptV2(
                schema="HistoricalPreflightReceipt.v2",
                preflight_id="pfh_" + uuid4().hex,
                run_id="bt_" + uuid4().hex,
                state="PREFLIGHT_READY",
                state_version=1,
                configuration_id=configuration_id,
                configuration_version=candidate.configuration_version,
                configuration_content_sha256=candidate.configuration_content_sha256,
                input_manifest_sha256=candidate.input_manifest_sha256,
                request_sha256=_hash(request),
                checked_at_ns=str(checked),
                expires_at_ns=str(expires),
            )
            body = canonical_historical_bytes(receipt)
            connection.execute(
                "INSERT INTO runs(run_id,state,created_at_ns,"
                "input_manifest_bytes,input_manifest_hash,"
                "catalog_revision,catalog_inventory_hash,contract_kind) "
                "VALUES(?,'DRAFT',?,?,?,?,?,'HISTORICAL_SMA_V2')",
                (
                    receipt.run_id,
                    now,
                    candidate.input_manifest_bytes,
                    candidate.input_manifest_sha256,
                    candidate.catalog_revision,
                    manifest.dataset.inventory_hash,
                ),
            )
            connection.execute(
                "INSERT INTO historical_preflights VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)",
                (
                    receipt.preflight_id,
                    receipt.run_id,
                    configuration_id,
                    request,
                    _hash(request),
                    body,
                    publication_bytes,
                    _hash(canonical_historical_bytes(manifest.configuration.configuration.risk)),
                    _hash(canonical_historical_bytes(manifest.runtime)),
                    "SIM-001",
                    checked,
                    expires,
                ),
            )
            _mutate_event(
                connection,
                clock=self._clock,
                event_id_factory=self._store._event_id_factory,
                run_id=receipt.run_id,
                expected_version=0,
                target=RunState.PREFLIGHT_READY,
                candidate=EventCandidate.control(
                    type="preflight.passed",
                    ts_event_ns=str(checked),
                    payload={
                        "canonical_request_hash": receipt.request_sha256,
                        "preflight_id": receipt.preflight_id,
                    },
                ),
            )
            self._save(
                _READY, idempotency_key, request, IdempotentResponse(200, body, receipt.run_id), now
            )
            validated = _record(connection, receipt.preflight_id)
            if validated is None:
                raise HistoricalPreflightInvalid()
            return validated.receipt

    def consume_ready(
        self, preflight_id: str, request_sha256: str, idempotency_key: str
    ) -> RunReservation:
        raise RuntimeError("HISTORICAL_CONSUMER_UNAVAILABLE")

    def _consume_ready_for_control(
        self, preflight_id: str, request_sha256: str, idempotency_key: str
    ) -> RunReservation:
        """Internal transaction; only fixtures and the complete future facade may call it."""
        _key(idempotency_key)
        request = _consume_request(preflight_id, request_sha256)
        connection = self._store._connection
        with _snapshot(connection):
            replay = self._replay(_CREATE, idempotency_key, request)
            if replay is not None:
                return self._reservation(replay)
            record = _record(connection, preflight_id)
            self._eligible(record, request_sha256)
        assert record is not None
        candidate = self._configurations.build_input_candidate(record.receipt.configuration_id)
        with _immediate_transaction(connection):
            replay = self._replay(_CREATE, idempotency_key, request)
            if replay is not None:
                return self._reservation(replay)
            current = _record(connection, preflight_id)
            now = self._eligible(current, request_sha256)
            assert current is not None
            _, publication_bytes = self._validate_current(candidate)
            if (
                candidate.input_manifest_bytes != current.input_manifest_bytes
                or publication_bytes != current.catalog_publication_bytes
            ):
                raise HistoricalPreflightStale()
            changed = connection.execute(
                "UPDATE historical_preflights SET consumed_at_ns=? "
                "WHERE preflight_id=? AND consumed_at_ns IS NULL",
                (now, preflight_id),
            )
            if changed.rowcount != 1:
                raise HistoricalPreflightStale()
            _mutate_event(
                connection,
                clock=self._clock,
                event_id_factory=self._store._event_id_factory,
                run_id=current.receipt.run_id,
                expected_version=1,
                target=RunState.QUEUED,
                candidate=EventCandidate.control(
                    type="run.queued", ts_event_ns=str(now), payload={"preflight_id": preflight_id}
                ),
            )
            self._save(
                _CREATE,
                idempotency_key,
                request,
                IdempotentResponse(202, _queue_body(current), current.receipt.run_id),
                now,
            )
            validated = _record(connection, preflight_id)
            if validated is None:
                raise HistoricalPreflightInvalid()
            return self._reservation(validated)

    def _eligible(self, record: HistoricalPreflightRecord | None, request_sha256: str) -> int:
        now = _now(self._clock)
        if record is None or (
            record.consumed_at_ns is not None
            or record.receipt.request_sha256 != request_sha256
            or not int(record.receipt.checked_at_ns) <= now < int(record.receipt.expires_at_ns)
        ):
            raise HistoricalPreflightStale()
        return now

    @staticmethod
    def _reservation(record: HistoricalPreflightRecord) -> RunReservation:
        return RunReservation(
            run_id=record.receipt.run_id,
            state=RunState.QUEUED,
            state_version=2,
            last_visible_seq=2,
            input_manifest_bytes=record.input_manifest_bytes,
            input_manifest_hash=record.receipt.input_manifest_sha256,
        )
