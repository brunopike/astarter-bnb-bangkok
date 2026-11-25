"""R3 PRIVATE draft data, not strategy compilation, approval or execution."""

import json
import math
import re
from decimal import Decimal
from hashlib import sha256
from typing import Annotated, Any, Literal

from pydantic import Field, field_validator, model_validator

from .private_research_contracts import Identifier, Millis
from .private_ui_contracts import RequestId, Revision, UIBinding, UIContract, UIRequest, plain_text

Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$", max_length=64)]
DraftId = Annotated[str, Field(pattern=r"^[A-Za-z0-9:_-]{1,96}$", max_length=96)]
Price = Annotated[float, Field(gt=0, le=1e12, allow_inf_nan=False)]
Market = Literal["BTC/USDT", "ETH/USDT", "SOL/USDT"]
CATALOG_VERSION = "private-paper-draft-v1"


def canonical(value: Any) -> str:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def digest(value: Any) -> str:
    return sha256(canonical(value).encode()).hexdigest()


class GridParameters(UIContract):
    lower: Price | None
    upper: Price | None
    count: Annotated[int, Field(ge=2, le=100)] | None
    spacing: Literal["arithmetic", "geometric"] | None
    trigger_price: Price | None = Field(alias="triggerPrice")
    take_profit_price: Price | None = Field(alias="takeProfitPrice")
    stop_loss_price: Price | None = Field(alias="stopLossPrice")

    @model_validator(mode="after")
    def ordered(self) -> "GridParameters":
        if (
            self.lower is not None
            and self.upper is not None
            and self.upper <= self.lower
            or self.lower is not None
            and self.stop_loss_price is not None
            and self.stop_loss_price >= self.lower
            or self.upper is not None
            and self.take_profit_price is not None
            and self.take_profit_price <= self.upper
            or self.trigger_price is not None
            and (
                self.lower is not None
                and self.trigger_price < self.lower
                or self.upper is not None
                and self.trigger_price > self.upper
            )
        ):
            raise ValueError("PRIVATE_DRAFT_PARAMETER_RANGE")
        return self


class BasketParameters(UIContract):
    deviation_pct: Annotated[float, Field(gt=0, lt=100, allow_inf_nan=False)] | None = Field(
        alias="deviationPct"
    )
    size_multiplier: Annotated[float, Field(ge=1, le=10, allow_inf_nan=False)] | None = Field(
        alias="sizeMultiplier"
    )
    max_entries: Annotated[int, Field(ge=1, le=3)] | None = Field(alias="maxEntries")
    take_profit_pct: Annotated[float, Field(gt=0, le=1000, allow_inf_nan=False)] | None = Field(
        alias="takeProfitPct"
    )
    stop_loss_pct: Annotated[float, Field(gt=0, lt=100, allow_inf_nan=False)] | None = Field(
        alias="stopLossPct"
    )
    trigger_price: Price | None = Field(alias="triggerPrice")


class OriginalProtection(UIContract):
    id: Literal["original"]
    version: Literal["strategy-original"]


class LegacyProtection(UIContract):
    id: Literal["astarter"]
    version: Literal["astarter-research-v0.1/sim-2"]
    mode: Literal["normal", "conservative"]


class ProtectionParameters(UIContract):
    episode: Annotated[float, Field(gt=0, le=0.0025, allow_inf_nan=False)]
    notional: Annotated[float, Field(gt=0, le=0.10, allow_inf_nan=False)]
    daily: Annotated[float, Field(gt=0, le=0.02, allow_inf_nan=False)]
    epoch: Annotated[float, Field(gt=0, le=0.05, allow_inf_nan=False)]
    soft: Annotated[float, Field(gt=0, le=0.03, allow_inf_nan=False)]
    hard: Annotated[float, Field(gt=0, le=0.08, allow_inf_nan=False)]

    @model_validator(mode="after")
    def thresholds(self) -> "ProtectionParameters":
        if self.soft >= self.hard:
            raise ValueError("PRIVATE_DRAFT_PROTECTION_RANGE")
        return self


class ParameterProtection(UIContract):
    id: Literal["astarter"]
    version: Literal["astarter-research-v0.1/sim-3"]
    mode: Literal["normal", "conservative"]
    parameters: ProtectionParameters


class DemoRoute(UIContract):
    profile_id: Literal["cex-spot"] = Field(alias="profileId")
    venue_id: Literal["binance"] = Field(alias="venueId")
    account_id: Literal["SIM-01"] = Field(alias="accountId")
    connection_id: Annotated[
        str, Field(pattern=r"^[A-Za-z0-9_][A-Za-z0-9_:.-]{0,79}$", max_length=80)
    ] = Field(alias="connectionId")
    chain_id: Literal[""] = Field(alias="chainId")

    _plain_connection = field_validator("connection_id")(plain_text)


class DraftFields(UIContract):
    name: Annotated[str, Field(min_length=1, max_length=120)]
    strategy: Literal["S01", "S02"]
    plan_variant: Literal["S01-SIM", "S02-SIM"] = Field(alias="planVariant")
    market: Market
    environment: Literal["DEMO"]
    mode: Literal["auto"]
    amount: Annotated[float, Field(ge=10, le=1000, allow_inf_nan=False)] | None
    cap: Annotated[float, Field(ge=10, le=3000, allow_inf_nan=False)] | None
    research_budget: Annotated[int, Field(ge=0, le=10000)] | None = Field(alias="researchBudget")
    bot_parameters: GridParameters | BasketParameters | None = Field(alias="botParameters")
    protection: OriginalProtection | LegacyProtection | ParameterProtection | None
    execution_route: DemoRoute | None = Field(alias="executionRoute")

    _plain_name = field_validator("name")(plain_text)

    @model_validator(mode="after")
    def selected_variant(self) -> "DraftFields":
        params = self.bot_parameters
        if (
            self.plan_variant != self.strategy + "-SIM"
            or params is not None
            and isinstance(params, GridParameters) != (self.strategy == "S01")
        ):
            raise ValueError("PRIVATE_DRAFT_VARIANT")
        if self.amount is not None and self.cap is not None:
            amount, cap = Decimal(str(self.amount)), Decimal(str(self.cap))
            required = amount
            if isinstance(params, GridParameters) and params.count is not None:
                required = amount * params.count * Decimal("1.001")
            elif (
                isinstance(params, BasketParameters)
                and params.max_entries is not None
                and params.size_multiplier is not None
            ):
                multiplier = Decimal(str(params.size_multiplier))
                required = sum(
                    (amount * multiplier**i * Decimal("1.001") for i in range(params.max_entries)),
                    Decimal(0),
                )
            if required > cap:
                raise ValueError("PRIVATE_DRAFT_CAP_EXCEEDED")
        return self


def missing_fields(fields: DraftFields) -> list[str]:
    value = fields.model_dump(by_alias=True)
    missing = [key for key, item in value.items() if item is None]
    params = fields.bot_parameters
    if params is not None:
        required = (
            ["lower", "upper", "count", "spacing"]
            if isinstance(params, GridParameters)
            else ["deviationPct", "sizeMultiplier", "maxEntries", "takeProfitPct", "stopLossPct"]
        )
        if (
            isinstance(params, GridParameters)
            and fields.protection is not None
            and (fields.protection.id == "astarter")
        ):
            required.append("stopLossPrice")
        missing.extend(
            "botParameters." + key
            for key in required
            if params.model_dump(by_alias=True)[key] is None
        )
    return sorted(missing)


class SourceClock(UIContract):
    unit: Literal["seconds"]
    sample_at: Annotated[int, Field(ge=0, le=253402300799)] = Field(alias="sampleAt")
    closed_at: Annotated[int, Field(ge=0, le=253402300799)] = Field(alias="closedAt")
    valid_until: Annotated[int, Field(ge=0, le=253402300799)] = Field(alias="validUntil")

    @model_validator(mode="after")
    def closed_day(self) -> "SourceClock":
        if (
            self.sample_at % 86400
            or self.closed_at != self.sample_at + 86400
            or self.valid_until != self.closed_at + 86400
        ):
            raise ValueError("PRIVATE_DRAFT_CLOCK")
        return self


class ReportSource(UIContract):
    kind: Literal["private-research-request"]
    source_request_id: RequestId = Field(alias="sourceRequestId")
    request_fingerprint: Digest = Field(alias="requestFingerprint")
    report_revision: Digest = Field(alias="reportRevision")
    evidence_revision: Digest = Field(alias="evidenceRevision")
    symbol: Literal["BTC", "ETH", "SOL"]
    evidence_id: Annotated[str, Field(pattern=r"^market-[a-f0-9]{32}$")] = Field(alias="evidenceId")
    method_version: Literal["closed-market-research-v1"] = Field(alias="methodVersion")
    created_at: Millis = Field(alias="createdAt")
    valid_until: Millis = Field(alias="validUntil")
    source_clock: SourceClock = Field(alias="sourceClock")

    @model_validator(mode="after")
    def original_times(self) -> "ReportSource":
        if not (
            self.source_clock.closed_at * 1000
            <= self.created_at
            < self.valid_until
            <= self.source_clock.valid_until * 1000
        ):
            raise ValueError("PRIVATE_DRAFT_CLOCK")
        return self


def _keys(value: Any, names: str) -> bool:
    return type(value) is dict and set(value) == set(names.split())


def _integer(value: Any) -> bool:
    return type(value) is int and 0 <= value <= 253402300799999


def _text(value: Any, maximum: int) -> bool:
    return (
        type(value) is str
        and 0 < len(value) <= maximum
        and bool(value.strip())
        and not re.search(r"[\x00-\x1f\x7f]", value)
    )


def _source_valid(source: Any, created: int) -> bool:
    if not _keys(
        source,
        "id symbol source timezone unit period methodVersion sampleAt closedAt "
        "validUntil metrics bars",
    ):
        return False
    metrics = source["metrics"]
    return bool(
        type(source["id"]) is str
        and re.fullmatch(r"market-[a-f0-9]{32}", source["id"])
        and all(_text(source[k], 80) for k in ("symbol", "source", "timezone", "unit"))
        and source["period"] == "1D"
        and source["methodVersion"] == "ema20-atr14-rsi14-v1"
        and all(_integer(source[k]) for k in ("sampleAt", "closedAt", "validUntil", "bars"))
        and source["sampleAt"] < source["closedAt"] < source["validUntil"]
        and source["closedAt"] * 1000 <= created
        and 250 <= source["bars"] <= 500
        and _keys(metrics, "close changePercent ema20DeviationAtr14 rsi14")
        and all(type(v) in (int, float) and math.isfinite(v) for v in metrics.values())
        and metrics["close"] > 0
        and metrics["changePercent"] > -100
        and 0 <= metrics["rsi14"] <= 100
    )


def report_source(
    row: dict[str, Any], *, owner: tuple[str, str], lease_id: str, market: Market, now: int
) -> ReportSource:
    """Bind the trusted stored report, never client prose or the mutable billing columns."""
    try:
        result = row["result"]
        if (
            market not in ("BTC/USDT", "ETH/USDT", "SOL/USDT")
            or not _integer(now)
            or (row["tenant_id"], row["subject_id"]) != owner
            or row["lease_id"] != lease_id
            or row["state"] != "complete"
            or row["error_code"] is not None
            or not _keys(
                result,
                "method model responseId usage billing output sources "
                "missingDimensions createdAt validUntil executionAuthority methodVersion",
            )
            or len(canonical(result).encode()) > 65536
            or result["method"] != "ai"
            or result["model"] != "openai/gpt-4.1-mini"
            or result["methodVersion"] != "closed-market-research-v1"
            or result["executionAuthority"] != "NONE"
            or not _text(result["responseId"], 160)
            or not all(
                _integer(v)
                for v in (
                    row["created_at_ms"],
                    row["finished_at_ms"],
                    result["createdAt"],
                    result["validUntil"],
                )
            )
            or not row["created_at_ms"] <= row["finished_at_ms"] <= now
            # Node report time and PG completion time use independent clocks.
            or not row["created_at_ms"] <= result["createdAt"] <= now
            or not result["createdAt"] < result["validUntil"]
            or result["validUntil"] <= now
        ):
            raise ValueError()
        usage, output, sources = result["usage"], result["output"], result["sources"]
        if (
            not _keys(usage, "inputTokens outputTokens totalTokens")
            or not all(_integer(v) for v in usage.values())
            or usage["outputTokens"] > 800
            or usage["totalTokens"] != usage["inputTokens"] + usage["outputTokens"]
            or usage["totalTokens"] > 13056
            or type(result["missingDimensions"]) is not list
            or sorted(result["missingDimensions"]) != ["chain", "depth", "macro", "risk", "social"]
            or not _keys(output, "outcome headline summary claims")
            or output["outcome"] not in ("watch", "conflict", "insufficient")
            or not _text(output["headline"], 120)
            or not _text(output["summary"], 1200)
            or type(sources) is not list
            or not 1 <= len(sources) <= 8
            or not all(_source_valid(s, result["createdAt"]) for s in sources)
            or len({s["id"] for s in sources}) != len(sources)
            or len({s["symbol"] for s in sources}) != len(sources)
            or result["validUntil"] != min(s["validUntil"] * 1000 for s in sources)
        ):
            raise ValueError()
        claims, ids = output["claims"], {s["id"] for s in sources}
        if type(claims) is not list or not 1 <= len(claims) <= 6:
            raise ValueError()
        for claim in claims:
            if (
                not _keys(claim, "text evidenceIds")
                or not _text(claim["text"], 500)
                or type(claim["evidenceIds"]) is not list
                or not 1 <= len(claim["evidenceIds"]) <= len(ids)
                or not all(type(v) is str for v in claim["evidenceIds"])
                or len(set(claim["evidenceIds"])) != len(claim["evidenceIds"])
                or not set(claim["evidenceIds"]) <= ids
            ):
                raise ValueError()
        billing = result["billing"]
        if billing is not None and (
            not _keys(billing, "provider responseId model costMicrousd isByok")
            or billing["provider"] != "openrouter"
            or billing["responseId"] != result["responseId"]
            or billing["model"] != result["model"]
            or not _integer(billing["costMicrousd"])
            or billing["isByok"] is not False
        ):
            raise ValueError()
        symbol = market.split("/")[0]
        selected = next(s for s in sources if s["symbol"] == symbol)
        if (
            (selected["source"], selected["timezone"], selected["unit"])
            != ("Binance Spot", "UTC", "USDT")
            or selected["sampleAt"] % 86400
            or selected["closedAt"] != selected["sampleAt"] + 86400
            or selected["validUntil"] != selected["closedAt"] + 86400
        ):
            raise ValueError()
        return ReportSource.model_validate(
            {
                "kind": "private-research-request",
                "sourceRequestId": row["request_id"],
                "requestFingerprint": row["fingerprint"],
                "reportRevision": digest(result),
                "evidenceRevision": digest(sources),
                "symbol": symbol,
                "evidenceId": selected["id"],
                "methodVersion": result["methodVersion"],
                "createdAt": result["createdAt"],
                "validUntil": result["validUntil"],
                "sourceClock": {
                    "unit": "seconds",
                    **{k: selected[k] for k in ("sampleAt", "closedAt", "validUntil")},
                },
            }
        )
    except (
        KeyError,
        ValueError,
        TypeError,
        StopIteration,
        OverflowError,
        UnicodeError,
        RecursionError,
    ):
        raise ValueError("PRIVATE_DRAFT_SOURCE_INVALID") from None


class DraftRead(UIBinding):
    draft_id: DraftId = Field(alias="draftId")

    _plain_id = field_validator("draft_id")(plain_text)


class DraftPreview(DraftRead):
    source_request_id: RequestId = Field(alias="sourceRequestId")
    fields: DraftFields

    _plain_source = field_validator("source_request_id")(plain_text)


class DraftAdopt(DraftPreview):
    request_id: RequestId = Field(alias="requestId")
    expected_revision: Revision = Field(alias="expectedRevision")
    workspace_revision: Revision = Field(alias="workspaceRevision")
    proposal_revision: Digest = Field(alias="proposalRevision")

    _plain_request = field_validator("request_id")(plain_text)


class DraftContent(UIContract):
    catalog_version: Literal["private-paper-draft-v1"] = Field(alias="catalogVersion")
    template_version: Literal["S01-SIM@paper-v1", "S02-SIM@paper-v1"] = Field(
        alias="templateVersion"
    )
    parameter_origin: Literal["user-confirmed"] = Field(alias="parameterOrigin")
    source: ReportSource
    fields: DraftFields
    missing_fields: Annotated[list[str], Field(max_length=24)] = Field(alias="missingFields")
    execution_authority: Literal["NONE"] = Field(alias="executionAuthority")

    @model_validator(mode="after")
    def consistent(self) -> "DraftContent":
        if (
            self.template_version != self.fields.plan_variant + "@paper-v1"
            or self.missing_fields != missing_fields(self.fields)
            or self.source.symbol + "/USDT" != self.fields.market
        ):
            raise ValueError("PRIVATE_DRAFT_CONTENT")
        return self


class DraftDocument(UIContract):
    schema_name: Literal["private-strategy-draft-v1"] = Field(alias="schema")
    scope: Identifier
    draft_id: DraftId = Field(alias="draftId")
    revision: Annotated[int, Field(ge=1, le=9007199254740991)]
    saved_at: Millis = Field(alias="savedAt")
    content: DraftContent

    @model_validator(mode="after")
    def saved_while_current(self) -> "DraftDocument":
        if not self.content.source.created_at <= self.saved_at < self.content.source.valid_until:
            raise ValueError("PRIVATE_DRAFT_SAVED_TIME")
        return self


def changed_groups(current: DraftContent | None, proposal: DraftContent) -> list[str]:
    old = None if current is None else current.model_dump(by_alias=True)
    new = proposal.model_dump(by_alias=True)
    groups = ["source"] if old is None or old["source"] != new["source"] else []
    return groups + [
        "fields." + key
        for key in new["fields"]
        if old is None or old["fields"][key] != new["fields"][key]
    ]


class DraftPreviewResult(UIContract):
    schema_name: Literal["private-draft-preview-v1"] = Field(alias="schema")
    scope: Identifier
    draft_id: DraftId = Field(alias="draftId")
    expected_revision: Revision = Field(alias="expectedRevision")
    workspace_revision: Revision = Field(alias="workspaceRevision")
    proposal_revision: Digest = Field(alias="proposalRevision")
    listed: bool
    current: DraftDocument | None
    proposal: DraftContent
    changed_fields: Annotated[list[str], Field(max_length=13)] = Field(alias="changedFields")

    @model_validator(mode="after")
    def current_binding(self) -> "DraftPreviewResult":
        old = self.current
        if (
            self.expected_revision != (0 if old is None else old.revision)
            or old is not None
            and (old.scope != self.scope or old.draft_id != self.draft_id)
            or self.changed_fields
            != changed_groups(None if old is None else old.content, self.proposal)
        ):
            raise ValueError("PRIVATE_DRAFT_PREVIEW")
        return self


class DraftReceipt(UIContract):
    request_id: RequestId = Field(alias="requestId")
    draft_id: DraftId = Field(alias="draftId")
    status: Literal["applied"]
    expected_revision: Revision = Field(alias="expectedRevision")
    revision: Revision
    workspace_base_revision: Revision = Field(alias="workspaceBaseRevision")
    workspace_revision: Revision = Field(alias="workspaceRevision")
    applied_at: Millis = Field(alias="appliedAt")


class DraftCommandResult(UIContract):
    schema_name: Literal["private-draft-command-v1"] = Field(alias="schema")
    scope: Identifier
    request: DraftReceipt
    draft: DraftDocument

    @model_validator(mode="after")
    def original(self) -> "DraftCommandResult":
        r, d = self.request, self.draft
        if (
            self.scope != d.scope
            or r.draft_id != d.draft_id
            or r.revision != d.revision
            or r.expected_revision + 1 != r.revision
            or r.applied_at != d.saved_at
            or not r.workspace_base_revision
            <= r.workspace_revision
            <= r.workspace_base_revision + 1
        ):
            raise ValueError("PRIVATE_DRAFT_RECEIPT")
        return self


DRAFT_METHODS: dict[str, type[UIBinding]] = {
    "drafts/preview": DraftPreview,
    "drafts/get": DraftRead,
    "drafts/adopt": DraftAdopt,
    "drafts/request": UIRequest,
}


def draft_input(operation: str, payload: dict[str, Any]) -> UIBinding:
    model = DRAFT_METHODS.get(operation)
    if model is None:
        raise ValueError("PRIVATE_REQUEST_INVALID")
    return model.model_validate(payload)
