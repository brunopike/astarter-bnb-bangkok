"""Controlled synthetic S03 input. Quote admission happens before native matching."""

from __future__ import annotations

import hmac
from dataclasses import dataclass
from hashlib import sha256
from secrets import token_bytes
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, model_validator

from stark_trading_os.domain.astarter_simulation import (
    AstarterIntegrityError,
    amount,
    digest,
    text,
)
from stark_trading_os.domain.s03_bridge import (
    CASE_ID,
    S03BridgePlan,
    S03BridgeRejected,
    S03ControlledCase,
    S03DataManifest,
    S03Owner,
    S03RawNews,
    S03RunState,
    validate_s03_plan,
)
from stark_trading_os.runner.astarter_facts import NativeFactsSource

_QUOTE_AGE_NS = 2_000_000_000
_QUOTE_FUTURE_NS = 500_000_000
_MAX_NS = 2**64 - 1
_OPEN = object()
type QuoteIdentity = tuple[int, int, int, str, str, str, str, str]
type EventKind = Literal["BAR", "QUOTE", "NEWS", "TIMER", "NATIVE"]


class _ClosedModel(BaseModel):
    model_config = ConfigDict(
        frozen=True,
        strict=True,
        extra="forbid",
        revalidate_instances="always",
        validate_default=True,
    )


class S03QuoteBody(_ClosedModel):
    source_sequence: Annotated[StrictInt, Field(gt=0)]
    bid: StrictStr
    ask: StrictStr
    bid_size: StrictStr
    ask_size: StrictStr
    instrument_id: Literal["BTCUSDT.SIM"]


class S03NativeBody(_ClosedModel):
    capture_sequence: Annotated[StrictInt, Field(gt=0)]
    venue_session: StrictStr


class S03InputEvent(_ClosedModel):
    kind: EventKind
    event_key: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    source_event_time_ns: StrictInt
    received_time_ns: StrictInt
    available_at_ns: StrictInt
    quote: S03QuoteBody | None = None
    native: S03NativeBody | None = None
    news: S03RawNews | None = None

    @model_validator(mode="after")
    def _payload(self) -> S03InputEvent:
        if (self.kind == "QUOTE") != (self.quote is not None):
            raise ValueError("S03_EVENT_PAYLOAD_INVALID")
        if (self.kind == "NATIVE") != (self.native is not None):
            raise ValueError("S03_EVENT_PAYLOAD_INVALID")
        if (self.kind == "NEWS") != (self.news is not None):
            raise ValueError("S03_EVENT_PAYLOAD_INVALID")
        if self.news is not None and (
            self.source_event_time_ns != self.news.source_event_time_ns
            or self.received_time_ns != self.news.received_time_ns
            or self.available_at_ns != self.news.available_at_ns
        ):
            raise ValueError("S03_EVENT_PAYLOAD_INVALID")
        return self


@dataclass(frozen=True, slots=True)
class S03FeedRecord:
    disposition: Literal["ACCEPTED", "REJECTED"]
    reason: str
    kind: EventKind
    event_key: str
    source_event_time_ns: int
    received_time_ns: int
    source_sequence: int | None


def s03_event_key(event: S03InputEvent) -> str:
    checked = S03InputEvent.model_validate(event)
    return digest(checked.model_dump(mode="json", exclude={"event_key"}))


def _off_grid(value: str, unit: str) -> bool:
    if type(value) is not str:
        return True
    try:
        parsed = amount(value)
    except ValueError:
        return True
    return text(parsed) != value or parsed <= 0 or parsed % amount(unit) != 0


def _clock(now_ns: int, event_ns: int, age_code: str, future_code: str) -> str | None:
    if (
        type(now_ns) is not int
        or type(event_ns) is not int
        or now_ns < 0
        or event_ns < 0
        or now_ns > _MAX_NS
        or event_ns > _MAX_NS
    ):
        return age_code
    if event_ns > now_ns:
        if event_ns - now_ns > _QUOTE_FUTURE_NS:
            return future_code
        return None
    if now_ns - event_ns > _QUOTE_AGE_NS:
        return age_code
    return None


class S03SimulationInputSource:
    """Issues a simulated owner. Accepted quotes are not inserted into a native cache."""

    def __init__(
        self,
        plan: S03BridgePlan,
        manifest: S03DataManifest,
        profile: dict[str, str],
        native: NativeFactsSource,
        token: object,
    ) -> None:
        if token is not _OPEN:
            raise S03BridgeRejected("S03_CASE_UNCONTROLLED")
        self._plan = plan
        self._manifest = manifest
        self._profile = profile
        self._native = native
        self._records: list[S03FeedRecord] = []
        self._seen: set[QuoteIdentity] = set()
        self._watermark_seq: int | None = None
        self._watermark_time: int | None = None
        self._manifest_ids = {
            (
                quote.source_sequence,
                quote.source_event_time_ns,
                quote.received_time_ns,
                quote.bid,
                quote.ask,
                quote.bid_size,
                quote.ask_size,
                quote.instrument_id,
            )
            for quote in manifest.quotes
        }
        self._fence = 1
        self._run_id = digest(
            {
                "scope": plan.scope,
                "parameters_sha256": plan.parameters_sha256,
                "manifest_sha256": plan.manifest_sha256,
                "venue_session": profile["venue_session"],
                "instrument_sha256": profile["instrument_sha256"],
            }
        )
        self._owner = S03Owner(
            owner_id=digest({"run_id": self._run_id, "fence": self._fence, "kind": "owner-id"}),
            run_id=self._run_id,
            venue_session=profile["venue_session"],
            fence=self._fence,
            credential=hmac.new(
                token_bytes(32),
                f"{self._run_id}:{profile['venue_session']}:{self._fence}".encode(),
                sha256,
            ).hexdigest(),
        )

    @classmethod
    def open(
        cls,
        *,
        case_id: str,
        case: S03ControlledCase,
        plan: S03BridgePlan,
        manifest: S03DataManifest,
        native: NativeFactsSource,
    ) -> S03SimulationInputSource:
        if type(native) is not NativeFactsSource:
            raise S03BridgeRejected("S03_NATIVE_SOURCE_INVALID")
        if case_id != CASE_ID or manifest.case_id != CASE_ID:
            raise S03BridgeRejected("S03_CASE_UNCONTROLLED")
        plan = S03BridgePlan.model_validate(plan)
        manifest = S03DataManifest.model_validate(manifest)
        validate_s03_plan(plan, manifest, case)
        profile = native.bound_instrument()
        expected = {
            "instrument_id": plan.native_instrument_id,
            "base": "BTC",
            "quote": "USDT",
            "venue": plan.venue,
            "price_precision": "2",
            "price_increment": "0.01",
            "size_precision": "5",
            "size_increment": plan.overlay.step,
            "min_quantity": "0.00001",
            "min_notional": "unset",
            "quote_unit": plan.overlay.quote_unit,
            "maker_fee": plan.overlay.maker_fee,
            "taker_fee": plan.overlay.taker_fee,
            "account_id": plan.account_id,
        }
        if any(profile.get(key) != value for key, value in expected.items()):
            raise S03BridgeRejected("S03_PROFILE_MISMATCH")
        if len(profile["instrument_sha256"]) != 64 or profile["venue_session"] == "":
            raise S03BridgeRejected("S03_PROFILE_MISMATCH")
        return cls(plan, manifest, profile, native, _OPEN)

    @property
    def owner(self) -> S03Owner:
        return self._owner

    @property
    def raw_manifest(self) -> S03DataManifest:
        return self._manifest

    @property
    def accepted_quotes(self) -> tuple[S03FeedRecord, ...]:
        return tuple(
            record
            for record in self._records
            if record.disposition == "ACCEPTED" and record.kind == "QUOTE"
        )

    @property
    def rejected(self) -> tuple[S03FeedRecord, ...]:
        return tuple(record for record in self._records if record.disposition == "REJECTED")

    @property
    def quote_source_watermark(self) -> int | None:
        return self._watermark_seq

    def state(self) -> S03RunState:
        rejected = self.rejected
        return S03RunState(
            run_id=self._run_id,
            owner_id=self._owner.owner_id,
            fence=self._fence,
            venue_session=self._profile["venue_session"],
            input_reasons=tuple(record.reason for record in rejected),
            accepted_quote_count=len(self.accepted_quotes),
            rejected_count=len(rejected),
            quote_source_watermark=self._watermark_seq,
            quote_source_event_watermark_ns=self._watermark_time,
            instrument_sha256=self._profile["instrument_sha256"],
            profile_version=self._plan.profile_version,
        )

    def _session_problem(self) -> str | None:
        try:
            live = self._native.bound_instrument()
        except AstarterIntegrityError as error:
            code = str(error)
            if code == "ASTARTER_NATIVE_SOURCE_CLOSED":
                return "S03_NATIVE_SOURCE_CLOSED"
            if code == "ASTARTER_NATIVE_INSTRUMENT_CHANGED":
                return "S03_NATIVE_SOURCE_DRIFT"
            return "S03_NATIVE_SOURCE_INVALID"
        if (
            live["venue_session"] != self._profile["venue_session"]
            or live["instrument_sha256"] != self._profile["instrument_sha256"]
            or live["account_id"] != self._profile["account_id"]
        ):
            return "S03_NATIVE_SOURCE_DRIFT"
        return None

    def admit(self, event: S03InputEvent) -> S03FeedRecord:
        checked = S03InputEvent.model_validate(event)
        if not hmac.compare_digest(checked.event_key, s03_event_key(checked)):
            return self._reject(checked, "EVENT_KEY_MISMATCH", None)
        session_problem = self._session_problem()
        if session_problem is not None:
            return self._reject(checked, session_problem, None)
        if checked.kind == "NATIVE":
            return self._reject(checked, "CAPTURE_SEQUENCE_NOT_QUOTE_SOURCE_SEQUENCE", None)
        quote = checked.quote
        if checked.kind != "QUOTE" or quote is None:
            return self._reject(checked, "S03_EVENT_NOT_QUOTE", None)
        identity: QuoteIdentity = (
            quote.source_sequence,
            checked.source_event_time_ns,
            checked.received_time_ns,
            quote.bid,
            quote.ask,
            quote.bid_size,
            quote.ask_size,
            quote.instrument_id,
        )
        if identity not in self._manifest_ids:
            return self._reject(checked, "QUOTE_NOT_IN_MANIFEST", quote.source_sequence)
        if identity in self._seen:
            return self._reject(checked, "DUPLICATE_QUOTE", quote.source_sequence)
        if _off_grid(quote.bid, "0.01") or _off_grid(quote.ask, "0.01"):
            self._seen.add(identity)
            return self._reject(checked, "QUOTE_PRICE_INVALID", quote.source_sequence)
        if amount(quote.ask) < amount(quote.bid):
            self._seen.add(identity)
            return self._reject(checked, "QUOTE_PRICE_INVALID", quote.source_sequence)
        if _off_grid(quote.bid_size, "0.00001") or _off_grid(quote.ask_size, "0.00001"):
            self._seen.add(identity)
            return self._reject(checked, "QUOTE_SIZE_INVALID", quote.source_sequence)
        source_clock = _clock(
            checked.available_at_ns,
            checked.source_event_time_ns,
            "QUOTE_SOURCE_AGE",
            "QUOTE_SOURCE_FUTURE",
        )
        if source_clock is not None:
            self._seen.add(identity)
            return self._reject(checked, source_clock, quote.source_sequence)
        received_clock = _clock(
            checked.available_at_ns,
            checked.received_time_ns,
            "QUOTE_RECEIVED_AGE",
            "QUOTE_RECEIVED_FUTURE",
        )
        if received_clock is not None:
            self._seen.add(identity)
            return self._reject(checked, received_clock, quote.source_sequence)
        watermark = self._watermark_time
        late_time = watermark is not None and checked.source_event_time_ns <= watermark
        if late_time:
            self._seen.add(identity)
            return self._reject(checked, "QUOTE_LATE", quote.source_sequence)
        if self._watermark_seq is not None and quote.source_sequence <= self._watermark_seq:
            self._seen.add(identity)
            return self._reject(checked, "QUOTE_LATE", quote.source_sequence)
        self._seen.add(identity)
        self._watermark_seq = quote.source_sequence
        self._watermark_time = checked.source_event_time_ns
        record = S03FeedRecord(
            "ACCEPTED",
            "QUOTE_ACCEPTED",
            "QUOTE",
            checked.event_key,
            checked.source_event_time_ns,
            checked.received_time_ns,
            quote.source_sequence,
        )
        self._records.append(record)
        return record

    def _reject(
        self, event: S03InputEvent, reason: str, source_sequence: int | None
    ) -> S03FeedRecord:
        record = S03FeedRecord(
            "REJECTED",
            reason,
            event.kind,
            event.event_key,
            event.source_event_time_ns,
            event.received_time_ns,
            source_sequence,
        )
        self._records.append(record)
        return record
