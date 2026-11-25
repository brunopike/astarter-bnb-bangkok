"""Closed immutable contracts for sealed run review."""

from __future__ import annotations

import unicodedata
from decimal import Decimal, InvalidOperation
from typing import Annotated, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    field_validator,
    model_validator,
)

from stark_trading_os.audit.canonical_json import (
    CanonicalJSONError,
    canonical_decimal_string,
)

type RunRole = Literal["PRIMARY", "COMPARE"]
type SourceKind = Literal[
    "INPUT_MANIFEST",
    "RUN_RECORD",
    "EVENTS",
    "RUNNER_EXIT",
    "ORDERS",
    "FILLS",
    "POSITIONS",
    "ACCOUNT",
    "METRICS",
]
type StatementSection = Literal[
    "OBSERVED_FACT",
    "DETERMINISTIC_CALCULATION",
    "INFERENCE",
    "RISK",
]
type ReviewMode = Literal["LOCAL_DETERMINISTIC", "OPENAI_AGENT"]
type ReviewStatus = Literal[
    "AI_REVIEW_NOT_CONFIGURED",
    "AI_REVIEW_REJECTED",
    "AI_REVIEW_UNAVAILABLE",
    "COMPLETE",
]
type NoticeKind = Literal["MISSING_EVIDENCE", "LIMITATION", "REFUSAL"]
type CitationKind = Literal[
    "ARTIFACT",
    "EVENT",
    "SCOPE_ATTESTATION",
    "CALCULATION",
]
type ValueOrigin = Literal["SOURCE", "CALCULATION"]
type ValueUnit = Literal["COUNT", "ACCOUNT_CURRENCY", "RATIO"]

ScopeId = Annotated[StrictStr, Field(pattern=r"^scope_[0-9a-f]{64}$")]
ArtifactId = Annotated[StrictStr, Field(pattern=r"^art_[0-9a-f]{64}$")]
EventId = Annotated[StrictStr, Field(pattern=r"^evt_[0-9a-f]{64}$")]
CitationId = Annotated[StrictStr, Field(pattern=r"^cit_[0-9a-f]{64}$")]
ValueRefId = Annotated[StrictStr, Field(pattern=r"^val_[0-9a-f]{64}$")]
StatementId = Annotated[StrictStr, Field(pattern=r"^stmt_[0-9a-f]{64}$")]
CalculationId = Annotated[StrictStr, Field(pattern=r"^calc_[0-9a-f]{64}$")]
Sha256Digest = Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]

SOURCE_KINDS: tuple[SourceKind, ...] = (
    "INPUT_MANIFEST",
    "RUN_RECORD",
    "EVENTS",
    "RUNNER_EXIT",
    "ORDERS",
    "FILLS",
    "POSITIONS",
    "ACCOUNT",
    "METRICS",
)


class ReviewModel(BaseModel):
    """Base for contracts whose nested fields are also immutable models or tuples."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=False,
        serialize_by_alias=True,
    )


def _validate_bounded_text(
    value: str,
    *,
    label: str,
    max_code_points: int,
    max_utf8_bytes: int,
) -> str:
    if not value or value.isspace():
        raise ValueError(f"{label} must contain visible text.")
    if len(value) > max_code_points:
        raise ValueError(f"{label} exceeds its Unicode code-point limit.")
    if any(unicodedata.category(character) in {"Cc", "Cs"} for character in value):
        raise ValueError(f"{label} contains a disallowed control or surrogate code point.")
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as error:
        raise ValueError(f"{label} is not valid Unicode text.") from error
    if len(encoded) > max_utf8_bytes:
        raise ValueError(f"{label} exceeds its UTF-8 byte limit.")
    return value


class RunReviewRequest(ReviewModel):
    run_id: Annotated[StrictStr, Field(min_length=1, max_length=128)]
    compare_run_id: Annotated[StrictStr, Field(min_length=1, max_length=128)] | None = None
    question: StrictStr = Field(repr=False)

    @field_validator("run_id", "compare_run_id")
    @classmethod
    def validate_run_identifier(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _validate_bounded_text(
            value,
            label="run_id",
            max_code_points=128,
            max_utf8_bytes=512,
        )

    @field_validator("question")
    @classmethod
    def validate_question(cls, value: str) -> str:
        return _validate_bounded_text(
            value,
            label="question",
            max_code_points=2_000,
            max_utf8_bytes=8_192,
        )

    @model_validator(mode="after")
    def require_distinct_comparison(self) -> Self:
        if self.compare_run_id is not None and self.compare_run_id == self.run_id:
            raise ValueError("compare_run_id must identify a different run.")
        return self


class CandidateReview(ReviewModel):
    """Provider candidate: IDs only, with no model-authored visible content."""

    scope_id: ScopeId
    observed_fact_ids: tuple[StatementId, ...] = Field(min_length=1, max_length=12)
    calculation_ids: tuple[CalculationId, ...] = Field(default=(), max_length=8)
    inference_ids: tuple[StatementId, ...] = Field(default=(), max_length=8)
    risk_ids: tuple[StatementId, ...] = Field(default=(), max_length=8)

    @model_validator(mode="after")
    def require_unique_bounded_selection(self) -> Self:
        selected = (
            *self.observed_fact_ids,
            *self.calculation_ids,
            *self.inference_ids,
            *self.risk_ids,
        )
        if len(selected) > 32:
            raise ValueError("Candidate selection exceeds 32 total IDs.")
        if len(set(selected)) != len(selected):
            raise ValueError("Candidate IDs must be globally unique.")
        return self


class EvidenceSourceV1(ReviewModel):
    source_kind: SourceKind
    artifact_id: ArtifactId
    available: StrictBool
    raw_sha256: Sha256Digest | None
    raw_size_bytes: Annotated[StrictInt, Field(ge=0)] | None
    projection_sha256: Sha256Digest
    projection_size_bytes: Annotated[StrictInt, Field(ge=0, le=61_440)]
    coverage: Literal["FULL", "AGGREGATED_WITH_SAMPLES", "MISSING"]
    record_count: Annotated[StrictInt, Field(ge=0)]
    sample_count: Annotated[StrictInt, Field(ge=0)]
    omitted_count: Annotated[StrictInt, Field(ge=0)]

    @model_validator(mode="after")
    def require_availability_shape(self) -> Self:
        if self.available:
            if self.raw_sha256 is None or self.raw_size_bytes is None:
                raise ValueError("Available evidence requires exact raw identity.")
            if self.coverage == "MISSING":
                raise ValueError("Available evidence cannot claim missing coverage.")
            if self.sample_count + self.omitted_count != self.record_count:
                raise ValueError("Evidence sample and omission counts must cover every record.")
        elif (
            self.raw_sha256 is not None
            or self.raw_size_bytes is not None
            or self.coverage != "MISSING"
            or self.record_count != 0
            or self.sample_count != 0
            or self.omitted_count != 0
        ):
            raise ValueError("Missing evidence cannot carry raw values or record counts.")
        return self


class EvidenceRunV1(ReviewModel):
    role: RunRole
    terminal_state: Literal["COMPLETED", "FAILED", "CANCELLED"]
    state_version: Annotated[StrictInt, Field(ge=0)]
    last_visible_seq: Annotated[StrictInt, Field(ge=1)]
    terminal_event_seq: Annotated[StrictInt, Field(ge=1)]
    materialized_event_seq: Annotated[StrictInt, Field(ge=1)]
    materialized_audit_seq: Annotated[StrictInt, Field(ge=1)]
    published_at_ns: Annotated[StrictInt, Field(ge=0)]
    seal_digest: Sha256Digest
    sources: tuple[EvidenceSourceV1, ...] = Field(min_length=9, max_length=9)

    @model_validator(mode="after")
    def require_closed_source_inventory(self) -> Self:
        if tuple(source.source_kind for source in self.sources) != SOURCE_KINDS:
            raise ValueError("Evidence sources must use the exact private inventory order.")
        if self.last_visible_seq != self.terminal_event_seq:
            raise ValueError("Terminal publication must match the visible event boundary.")
        if self.materialized_event_seq != self.terminal_event_seq:
            raise ValueError("Materialized and terminal event boundaries must match.")
        return self


class EvidenceManifestV1(ReviewModel):
    contract_version: Literal["EvidenceManifest.v1"] = "EvidenceManifest.v1"
    scope_id: ScopeId
    runs: tuple[EvidenceRunV1, ...] = Field(min_length=1, max_length=2)
    retained_budget_bytes: Literal[2_097_152] = 2_097_152
    tool_envelope_max_bytes: Literal[65_536] = 65_536
    artifact_projection_max_bytes: Literal[61_440] = 61_440
    event_projection_max_bytes: Literal[4_096] = 4_096

    @model_validator(mode="after")
    def require_run_roles(self) -> Self:
        expected = ("PRIMARY",) if len(self.runs) == 1 else ("PRIMARY", "COMPARE")
        if tuple(run.role for run in self.runs) != expected:
            raise ValueError("Evidence runs must be PRIMARY then optional COMPARE.")
        return self


class ReviewCitation(ReviewModel):
    citation_id: CitationId
    scope_id: ScopeId
    kind: CitationKind
    run_role: RunRole | None
    source_kind: SourceKind | None
    artifact_id: ArtifactId | None = None
    event_id: EventId | None = None
    value_ref_ids: tuple[ValueRefId, ...] = Field(default=(), max_length=2)
    label: Annotated[StrictStr, Field(min_length=1, max_length=256)]

    @field_validator("label")
    @classmethod
    def validate_label(cls, value: str) -> str:
        return _validate_bounded_text(
            value,
            label="citation label",
            max_code_points=256,
            max_utf8_bytes=1_024,
        )

    @model_validator(mode="after")
    def require_citation_shape(self) -> Self:
        if self.kind == "ARTIFACT":
            valid = (
                self.run_role is not None
                and self.source_kind is not None
                and self.artifact_id is not None
                and self.event_id is None
                and not self.value_ref_ids
            )
        elif self.kind == "EVENT":
            valid = (
                self.run_role is not None
                and self.source_kind == "EVENTS"
                and self.artifact_id is None
                and self.event_id is not None
                and not self.value_ref_ids
            )
        elif self.kind == "SCOPE_ATTESTATION":
            valid = (
                self.run_role is None
                and self.source_kind is None
                and self.artifact_id is None
                and self.event_id is None
                and not self.value_ref_ids
            )
        else:
            valid = (
                self.source_kind is None
                and self.artifact_id is None
                and self.event_id is None
                and len(self.value_ref_ids) == 2
            )
        if not valid:
            raise ValueError("Citation fields do not match the closed citation kind.")
        return self


class ExactValueRef(ReviewModel):
    value_ref_id: ValueRefId
    scope_id: ScopeId
    run_role: RunRole | None
    semantic: Annotated[StrictStr, Field(pattern=r"^[A-Z][A-Z0-9_]{0,95}$")]
    value: Annotated[StrictStr, Field(min_length=1, max_length=256)]
    unit: ValueUnit
    currency: Annotated[StrictStr, Field(pattern=r"^[A-Z][A-Z0-9]{1,15}$")] | None
    citation_id: CitationId
    origin: ValueOrigin

    @field_validator("value")
    @classmethod
    def validate_exact_decimal(cls, value: str) -> str:
        try:
            parsed = Decimal(value)
            normalized = canonical_decimal_string(parsed)
        except (CanonicalJSONError, InvalidOperation, ValueError) as error:
            raise ValueError("Exact values must be finite canonical decimals.") from error
        if normalized != value:
            raise ValueError("Exact values must be finite canonical decimals.")
        return value

    @model_validator(mode="after")
    def require_unit_currency_shape(self) -> Self:
        if self.unit == "ACCOUNT_CURRENCY":
            if self.currency is None:
                raise ValueError("Account-currency values require a currency.")
        elif self.currency is not None:
            raise ValueError("Count and ratio values cannot carry a currency.")
        if self.origin == "SOURCE" and self.run_role is None:
            raise ValueError("Source values require one run role.")
        return self


class StatementOption(ReviewModel):
    statement_id: StatementId
    scope_id: ScopeId
    section: StatementSection
    text: Annotated[StrictStr, Field(min_length=1, max_length=2_048)]
    citation_ids: tuple[CitationId, ...] = Field(min_length=1, max_length=4)
    value_ref_ids: tuple[ValueRefId, ...] = Field(default=(), max_length=4)
    run_role: RunRole | None

    @field_validator("text")
    @classmethod
    def validate_server_text(cls, value: str) -> str:
        return _validate_bounded_text(
            value,
            label="statement text",
            max_code_points=2_048,
            max_utf8_bytes=8_192,
        )

    @model_validator(mode="after")
    def require_unique_references(self) -> Self:
        if len(set(self.citation_ids)) != len(self.citation_ids):
            raise ValueError("Statement citation IDs must be unique.")
        if len(set(self.value_ref_ids)) != len(self.value_ref_ids):
            raise ValueError("Statement value-ref IDs must be unique.")
        return self


class RatioCalculation(ReviewModel):
    calculation_id: CalculationId
    scope_id: ScopeId
    tool_call_ordinal: Annotated[StrictInt, Field(ge=1, le=8)]
    numerator_value_ref_id: ValueRefId
    denominator_value_ref_id: ValueRefId
    result: Annotated[StrictStr, Field(min_length=1, max_length=256)]
    rule: Literal["DECIMAL34_HALF_EVEN_RATIO_V1"]
    result_value_ref_id: ValueRefId
    citation_id: CitationId
    statement_id: StatementId

    @field_validator("result")
    @classmethod
    def validate_result(cls, value: str) -> str:
        return ExactValueRef.validate_exact_decimal(value)

    @model_validator(mode="after")
    def require_distinct_source_refs(self) -> Self:
        if self.numerator_value_ref_id == self.denominator_value_ref_id:
            raise ValueError("A ratio requires two distinct source value refs.")
        return self


class ReviewClaim(ReviewModel):
    statement_id: StatementId
    section: StatementSection
    text: Annotated[StrictStr, Field(min_length=1, max_length=2_048)]
    citation_ids: tuple[CitationId, ...] = Field(min_length=1, max_length=4)
    value_ref_ids: tuple[ValueRefId, ...] = Field(default=(), max_length=4)
    calculation_id: CalculationId | None = None

    @field_validator("text")
    @classmethod
    def validate_server_text(cls, value: str) -> str:
        return StatementOption.validate_server_text(value)

    @model_validator(mode="after")
    def require_claim_shape(self) -> Self:
        if len(set(self.citation_ids)) != len(self.citation_ids):
            raise ValueError("Claim citation IDs must be unique.")
        if len(set(self.value_ref_ids)) != len(self.value_ref_ids):
            raise ValueError("Claim value-ref IDs must be unique.")
        if self.calculation_id is not None and self.section != "DETERMINISTIC_CALCULATION":
            raise ValueError("Only deterministic calculations may carry calculation_id.")
        return self


class ReviewNotice(ReviewModel):
    notice_id: StatementId
    kind: NoticeKind
    text: Annotated[StrictStr, Field(min_length=1, max_length=2_048)]
    citation_ids: tuple[CitationId, ...] = Field(min_length=1, max_length=4)

    @field_validator("text")
    @classmethod
    def validate_server_text(cls, value: str) -> str:
        return StatementOption.validate_server_text(value)

    @model_validator(mode="after")
    def require_unique_citations(self) -> Self:
        if len(set(self.citation_ids)) != len(self.citation_ids):
            raise ValueError("Notice citation IDs must be unique.")
        return self


class RunReviewResponse(ReviewModel):
    scope_id: ScopeId
    mode: ReviewMode
    status: ReviewStatus
    claims: tuple[ReviewClaim, ...] = Field(min_length=1, max_length=32)
    notices: tuple[ReviewNotice, ...] = Field(default=(), max_length=32)
    citations: tuple[ReviewCitation, ...] = Field(min_length=1, max_length=128)
    value_refs: tuple[ExactValueRef, ...] = Field(default=(), max_length=264)

    @model_validator(mode="after")
    def require_closed_response(self) -> Self:
        legal_pairs = {
            ("LOCAL_DETERMINISTIC", "AI_REVIEW_NOT_CONFIGURED"),
            ("LOCAL_DETERMINISTIC", "AI_REVIEW_REJECTED"),
            ("LOCAL_DETERMINISTIC", "AI_REVIEW_UNAVAILABLE"),
            ("OPENAI_AGENT", "COMPLETE"),
        }
        if (self.mode, self.status) not in legal_pairs:
            raise ValueError("Review mode and status pair is not legal.")

        citations = {item.citation_id: item for item in self.citations}
        values = {item.value_ref_id: item for item in self.value_refs}
        if len(citations) != len(self.citations) or len(values) != len(self.value_refs):
            raise ValueError("Response registries require globally unique IDs.")
        if sum(value.origin == "SOURCE" for value in self.value_refs) > 256:
            raise ValueError("Response exceeds the source value-ref cap.")
        if sum(value.origin == "CALCULATION" for value in self.value_refs) > 8:
            raise ValueError("Response exceeds the derived ratio overlay cap.")
        if any(item.scope_id != self.scope_id for item in self.citations) or any(
            item.scope_id != self.scope_id for item in self.value_refs
        ):
            raise ValueError("Response registry item belongs to another scope.")

        statement_ids = [item.statement_id for item in self.claims]
        statement_ids.extend(item.notice_id for item in self.notices)
        if len(statement_ids) != len(set(statement_ids)):
            raise ValueError("Response statement IDs must be globally unique.")
        calculation_ids = [
            item.calculation_id for item in self.claims if item.calculation_id is not None
        ]
        if len(calculation_ids) != len(set(calculation_ids)):
            raise ValueError("Response calculation IDs must be unique.")

        used_citations: set[str] = set()
        used_values: set[str] = set()
        for claim in self.claims:
            used_citations.update(claim.citation_ids)
            used_values.update(claim.value_ref_ids)
        for notice in self.notices:
            used_citations.update(notice.citation_ids)
        changed = True
        while changed:
            before = (len(used_citations), len(used_values))
            for citation in self.citations:
                if citation.citation_id in used_citations:
                    used_values.update(citation.value_ref_ids)
            for value in self.value_refs:
                if value.value_ref_id in used_values:
                    used_citations.add(value.citation_id)
            changed = before != (len(used_citations), len(used_values))

        if not used_citations <= citations.keys() or not used_values <= values.keys():
            raise ValueError("Every claim and notice reference must resolve in this response.")
        if set(citations) != used_citations or set(values) != used_values:
            raise ValueError("Every response registry entry must be used.")
        return self


__all__ = [
    "ArtifactId",
    "CalculationId",
    "CandidateReview",
    "CitationId",
    "EvidenceManifestV1",
    "EvidenceRunV1",
    "EvidenceSourceV1",
    "EventId",
    "ExactValueRef",
    "RatioCalculation",
    "ReviewCitation",
    "ReviewClaim",
    "ReviewNotice",
    "RunReviewRequest",
    "RunReviewResponse",
    "SOURCE_KINDS",
    "ScopeId",
    "SourceKind",
    "StatementId",
    "StatementOption",
    "ValueRefId",
]
