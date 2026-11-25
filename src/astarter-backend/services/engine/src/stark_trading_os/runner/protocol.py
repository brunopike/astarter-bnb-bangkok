"""Closed canonical JSONL protocol between the runner and its controller."""

from __future__ import annotations

import json
import re
from decimal import Decimal, InvalidOperation
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, model_validator

from stark_trading_os.audit.canonical_json import (
    CanonicalJSONError,
    canonical_decimal_string,
)
from stark_trading_os.domain.models import (
    CanonicalDecimalString,
    NanosecondString,
    Sha256Digest,
)

MAX_PROTOCOL_LINE_BYTES = 64 * 1024
MAX_CONTROL_LINE_BYTES = 4 * 1024
MAX_NATIVE_REASON_CHARS = 256

type RunnerEventType = Literal[
    "run.progress",
    "order.submitted",
    "order.accepted",
    "order.rejected",
    "order.partially_filled",
    "order.filled",
    "order.cancel_pending",
    "order.cancelled",
    "position.opened",
    "position.changed",
    "position.closed",
    "risk.rejected",
]


class ProtocolError(ValueError):
    """Raised when a protocol line violates the frozen wire contract."""


class _ProtocolModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=False,
        serialize_by_alias=True,
    )


class _OptionalPayloadModel(_ProtocolModel):
    @model_validator(mode="after")
    def reject_explicit_nulls(self) -> Self:
        if any(getattr(self, field) is None for field in self.model_fields_set):
            raise ValueError("Optional payload fields must be omitted rather than null.")
        return self


class _QuoteIdentityV1(_ProtocolModel):
    instrument_id: StrictStr
    ts_event_ns: NanosecondString
    ts_available_ns: NanosecondString
    source_seq: Annotated[StrictInt, Field(ge=1)]
    source_revision: StrictStr
    record_hash: Sha256Digest


class _ProgressPayloadV1(_ProtocolModel):
    progress: Literal["decision"]
    decision_ts_ns: NanosecondString
    quote_identity: _QuoteIdentityV1

    @model_validator(mode="after")
    def require_visible_quote(self) -> _ProgressPayloadV1:
        available = self.quote_identity.ts_available_ns
        decision = self.decision_ts_ns
        if (len(available), available) > (len(decision), decision):
            raise ValueError("Quote availability cannot be after its decision timestamp.")
        return self


class _OrderSubmittedPayloadV1(_OptionalPayloadModel):
    client_order_id: StrictStr
    instrument_id: StrictStr
    side: Literal["BUY", "SELL"]
    type: Literal["LIMIT", "MARKET"]
    quantity: CanonicalDecimalString
    price: CanonicalDecimalString | None = None
    status: Literal["SUBMITTED"] | None = None

    @model_validator(mode="after")
    def require_type_aware_price(self) -> Self:
        if self.type == "LIMIT" and self.price is None:
            raise ValueError("LIMIT submission requires native price evidence.")
        if self.type == "MARKET" and "price" in self.model_fields_set:
            raise ValueError("MARKET submission must omit price.")
        return self


class _OrderAcceptedPayloadV1(_OptionalPayloadModel):
    client_order_id: StrictStr
    instrument_id: StrictStr
    venue_order_id: StrictStr
    status: Literal["ACCEPTED"] | None = None


class _OrderRejectedPayloadV1(_OptionalPayloadModel):
    client_order_id: StrictStr
    instrument_id: StrictStr
    reason: Annotated[StrictStr, Field(min_length=1, max_length=MAX_NATIVE_REASON_CHARS)]
    status: Literal["REJECTED"] | None = None

    @model_validator(mode="after")
    def require_sanitized_reason(self) -> Self:
        _require_sanitized_native_reason(self.reason)
        return self


class _OrderFilledPayloadV1(_ProtocolModel):
    client_order_id: StrictStr
    instrument_id: StrictStr
    last_qty: CanonicalDecimalString
    last_px: CanonicalDecimalString
    filled_qty: CanonicalDecimalString
    trade_id: StrictStr
    commission: StrictStr
    currency: Annotated[StrictStr, Field(pattern=r"^[A-Z][A-Z0-9]{1,15}$")]
    liquidity_side: Literal["MAKER", "TAKER"]

    @model_validator(mode="after")
    def require_canonical_commission(self) -> Self:
        _require_canonical_money(self.commission, currency=self.currency)
        return self


class _OrderCancelPayloadV1(_OptionalPayloadModel):
    client_order_id: StrictStr
    instrument_id: StrictStr
    status: Literal["PENDING_CANCEL", "CANCELED"] | None = None


class _OrderPendingCancelPayloadV1(_OrderCancelPayloadV1):
    status: Literal["PENDING_CANCEL"] | None = None


class _OrderCancelledPayloadV1(_OrderCancelPayloadV1):
    status: Literal["CANCELED"] | None = None


class _PositionOpenedPayloadV1(_ProtocolModel):
    position_id: StrictStr
    instrument_id: StrictStr
    side: Literal["LONG", "SHORT"]
    quantity: CanonicalDecimalString
    price: CanonicalDecimalString
    client_order_id: StrictStr


class _PositionChangedPayloadV1(_OptionalPayloadModel, _PositionOpenedPayloadV1):
    trade_id: StrictStr | None = None


class _PositionClosedPayloadV1(_OptionalPayloadModel):
    position_id: StrictStr
    instrument_id: StrictStr
    side: Literal["FLAT"]
    quantity: CanonicalDecimalString
    price: CanonicalDecimalString
    client_order_id: StrictStr
    trade_id: StrictStr | None = None
    realized_pnl: StrictStr

    @model_validator(mode="after")
    def require_canonical_realized_pnl(self) -> Self:
        _require_canonical_money(self.realized_pnl)
        return self


class _RiskRejectedPayloadV1(_ProtocolModel):
    rule_id: Literal["NAUTILUS_MAX_NOTIONAL_PER_ORDER"]
    reason: Annotated[StrictStr, Field(min_length=1, max_length=MAX_NATIVE_REASON_CHARS)]
    client_order_id: StrictStr
    instrument_id: StrictStr

    @model_validator(mode="after")
    def require_sanitized_reason(self) -> Self:
        _require_sanitized_native_reason(self.reason)
        return self


_PAYLOAD_MODELS: dict[str, type[_ProtocolModel]] = {
    "run.progress": _ProgressPayloadV1,
    "order.submitted": _OrderSubmittedPayloadV1,
    "order.accepted": _OrderAcceptedPayloadV1,
    "order.rejected": _OrderRejectedPayloadV1,
    "order.partially_filled": _OrderFilledPayloadV1,
    "order.filled": _OrderFilledPayloadV1,
    "order.cancel_pending": _OrderPendingCancelPayloadV1,
    "order.cancelled": _OrderCancelledPayloadV1,
    "position.opened": _PositionOpenedPayloadV1,
    "position.changed": _PositionChangedPayloadV1,
    "position.closed": _PositionClosedPayloadV1,
    "risk.rejected": _RiskRejectedPayloadV1,
}


class RunnerCandidateV1(_ProtocolModel):
    schema_: Literal["RunnerCandidate.v1"] = Field(alias="schema")
    run_id: StrictStr
    input_manifest_hash: Sha256Digest
    catalog_revision: Sha256Digest
    source_seq: Annotated[StrictInt, Field(ge=1)]
    ts_event_ns: NanosecondString
    type: RunnerEventType
    payload: dict[str, object]

    @model_validator(mode="after")
    def require_closed_payload(self) -> RunnerCandidateV1:
        _PAYLOAD_MODELS[self.type].model_validate(self.payload)
        return self


class RunnerReportCandidateV1(_ProtocolModel):
    name: Literal["orders", "fills", "positions", "account", "metrics"]
    relative_path: StrictStr
    sha256: Sha256Digest
    size_bytes: Annotated[StrictInt, Field(gt=0)]


class RunnerFailureV1(_ProtocolModel):
    code: Literal[
        "RUNNER_EXECUTION_FAILED",
        "REPORT_EXPORT_FAILED",
        "PROTOCOL_FAILED",
    ]
    message: Annotated[StrictStr, Field(min_length=1, max_length=MAX_NATIVE_REASON_CHARS)]

    @model_validator(mode="after")
    def require_sanitized_message(self) -> RunnerFailureV1:
        _require_sanitized_native_reason(self.message)
        return self


class RunnerOutcomeV1(_ProtocolModel):
    schema_: Literal["RunnerOutcome.v1"] = Field(alias="schema")
    run_id: StrictStr
    input_manifest_hash: Sha256Digest
    catalog_revision: Sha256Digest
    engine_package_version: Literal["2.0.0rc3"]
    result: Literal["SUCCEEDED", "FAILED"]
    last_source_seq: Annotated[StrictInt, Field(ge=0)]
    report_candidates: tuple[RunnerReportCandidateV1, ...]
    failure: RunnerFailureV1 | None

    @model_validator(mode="after")
    def require_result_shape(self) -> RunnerOutcomeV1:
        expected_names = ("orders", "fills", "positions", "account", "metrics")
        actual_names = tuple(item.name for item in self.report_candidates)
        if actual_names != expected_names[: len(actual_names)]:
            raise ValueError("Report candidates must be one fixed ordered prefix.")
        for item in self.report_candidates:
            if item.relative_path != f"reports/{item.name}.json":
                raise ValueError("Report candidate path does not match its report name.")
        if self.result == "FAILED":
            if self.failure is None:
                raise ValueError("FAILED outcome requires one failure.")
            return self
        if self.failure is not None or actual_names != expected_names:
            raise ValueError("SUCCEEDED outcome requires exactly five ordered reports.")
        return self


class RunnerControlV1(_ProtocolModel):
    schema_: Literal["RunnerControl.v1"] = Field(alias="schema")
    action: Literal["cancel.request"]


type ProtocolMessage = RunnerCandidateV1 | RunnerOutcomeV1


class RunnerSequenceValidator:
    def __init__(
        self,
        *,
        run_id: str,
        input_manifest_hash: str,
        catalog_revision: str,
        instrument_id: str,
        quote_currency: str,
    ) -> None:
        self._run_id = run_id
        self._input_manifest_hash = input_manifest_hash
        self._catalog_revision = catalog_revision
        self._instrument_id = instrument_id
        self._quote_currency = quote_currency
        self._last_source_seq = 0
        self._finished = False

    @property
    def last_source_seq(self) -> int:
        return self._last_source_seq

    def accept(self, candidate: RunnerCandidateV1) -> None:
        if self._finished:
            raise ProtocolError("Runner sequence is already finished.")
        if (
            candidate.run_id != self._run_id
            or candidate.input_manifest_hash != self._input_manifest_hash
            or candidate.catalog_revision != self._catalog_revision
        ):
            raise ProtocolError("Runner candidate identity does not match the active run.")
        if candidate.source_seq != self._last_source_seq + 1:
            raise ProtocolError("Runner source_seq must start at one and remain contiguous.")
        payload = candidate.payload
        if candidate.type == "run.progress":
            identity = payload["quote_identity"]
            if (
                not isinstance(identity, dict)
                or identity.get("instrument_id") != self._instrument_id
            ):
                raise ProtocolError("Runner candidate instrument does not match the manifest.")
        elif payload.get("instrument_id") != self._instrument_id:
            raise ProtocolError("Runner candidate instrument does not match the manifest.")
        if candidate.type in {"order.partially_filled", "order.filled"}:
            if payload.get("currency") != self._quote_currency:
                raise ProtocolError("Runner fill currency does not match the manifest.")
        if candidate.type == "position.closed":
            realized_pnl = payload.get("realized_pnl")
            if (
                type(realized_pnl) is not str
                or realized_pnl.rsplit(" ", maxsplit=1)[-1] != self._quote_currency
            ):
                raise ProtocolError("Runner PnL currency does not match the manifest.")
        self._last_source_seq = candidate.source_seq

    def finish(self, outcome: RunnerOutcomeV1) -> None:
        if self._finished:
            raise ProtocolError("Runner outcome may be accepted only once.")
        if (
            outcome.run_id != self._run_id
            or outcome.input_manifest_hash != self._input_manifest_hash
            or outcome.catalog_revision != self._catalog_revision
            or outcome.last_source_seq != self._last_source_seq
        ):
            raise ProtocolError("Runner outcome does not bind the active sequence cursor.")
        self._finished = True


def encode_protocol_line(message: ProtocolMessage) -> bytes:
    if type(message) not in {RunnerCandidateV1, RunnerOutcomeV1}:
        raise ProtocolError("Runner stdout accepts only Candidate or Outcome messages.")
    try:
        validated = type(message).model_validate(
            message.model_dump(mode="json", by_alias=True)
        )
        encoded = _canonical_wire_bytes(validated.model_dump(mode="json", by_alias=True))
    except (TypeError, ValueError) as error:
        raise ProtocolError("Protocol message is invalid.") from error
    line = encoded + b"\n"
    if len(line) > MAX_PROTOCOL_LINE_BYTES:
        raise ProtocolError("Protocol line exceeds 64 KiB.")
    return line


def parse_protocol_line(raw: bytes) -> RunnerCandidateV1 | RunnerOutcomeV1:
    value = _decode_wire_object(raw, max_bytes=MAX_PROTOCOL_LINE_BYTES)
    schema = value.get("schema")
    model: type[RunnerCandidateV1] | type[RunnerOutcomeV1]
    if schema == "RunnerCandidate.v1":
        model = RunnerCandidateV1
    elif schema == "RunnerOutcome.v1":
        model = RunnerOutcomeV1
    else:
        raise ProtocolError("Unknown runner protocol schema.")
    try:
        parsed = model.model_validate(value)
    except ValueError as error:
        raise ProtocolError("Runner protocol object is invalid.") from error
    _require_canonical_line(raw, parsed)
    return parsed


def parse_control_line(raw: bytes) -> RunnerControlV1:
    value = _decode_wire_object(raw, max_bytes=MAX_CONTROL_LINE_BYTES)
    try:
        parsed = RunnerControlV1.model_validate(value)
    except ValueError as error:
        raise ProtocolError("Runner control object is invalid.") from error
    _require_canonical_line(raw, parsed)
    return parsed


def _decode_wire_object(raw: bytes, *, max_bytes: int) -> dict[str, object]:
    if type(raw) is not bytes or not raw or len(raw) > max_bytes:
        raise ProtocolError("Protocol line is empty or exceeds its byte bound.")
    if raw.startswith(b"\xef\xbb\xbf") or b"\r" in raw:
        raise ProtocolError("Protocol line must be BOM-free UTF-8 with LF framing.")
    if not raw.endswith(b"\n") or raw.count(b"\n") != 1:
        raise ProtocolError("Protocol line must contain exactly one trailing LF.")
    try:
        value = json.loads(
            raw[:-1].decode("utf-8"),
            object_pairs_hook=_reject_duplicate_pairs,
            parse_float=_reject_float,
            parse_constant=_reject_float,
        )
    except (UnicodeDecodeError, TypeError, ValueError) as error:
        raise ProtocolError("Protocol line is not strict JSON.") from error
    if type(value) is not dict:
        raise ProtocolError("Protocol line must contain one JSON object.")
    return value


def _reject_duplicate_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ProtocolError(f"Duplicate protocol key: {key}.")
        value[key] = item
    return value


def _require_canonical_money(value: str, *, currency: str | None = None) -> None:
    parts = value.split(" ")
    if len(parts) != 2 or not re.fullmatch(r"[A-Z][A-Z0-9]{1,15}", parts[1]):
        raise ValueError("Money must be one canonical amount and currency.")
    if currency is not None and parts[1] != currency:
        raise ValueError("Money currency does not match the declared currency.")
    try:
        if canonical_decimal_string(Decimal(parts[0])) != parts[0]:
            raise ValueError("Money amount must already be canonical.")
    except (CanonicalJSONError, InvalidOperation, ValueError) as error:
        raise ValueError("Money amount must already be canonical.") from error


def _reject_float(value: str) -> object:
    raise ProtocolError(f"Binary or non-finite numeric value is forbidden: {value}.")


def _canonical_wire_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _require_canonical_line(raw: bytes, parsed: _ProtocolModel) -> None:
    expected = _canonical_wire_bytes(parsed.model_dump(mode="json", by_alias=True)) + b"\n"
    if raw != expected:
        raise ProtocolError("Protocol line is not canonical JSONL.")


def sanitize_native_reason(value: str) -> str:
    """Return the one bounded, path-redacted form allowed on protocol evidence."""

    printable = "".join(character if character.isprintable() else " " for character in value)
    without_secrets = re.sub(
        r"(?i)\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*\S+",
        r"\1=[redacted]",
        printable,
    )
    without_paths = re.sub(
        r"(?:[A-Za-z]:\\|/)(?:[^\s/\\]+[/\\])+[^\s]*",
        "[path]",
        without_secrets,
    )
    normalized = " ".join(without_paths.split()).strip()
    if not normalized:
        normalized = "NATIVE_REASON_UNAVAILABLE"
    return normalized[:MAX_NATIVE_REASON_CHARS]


def _require_sanitized_native_reason(value: str) -> None:
    if sanitize_native_reason(value) != value:
        raise ValueError("Native reason must be bounded and sanitized before protocol output.")
