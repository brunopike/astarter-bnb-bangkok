"""Immutable, bounded projections of freshly verified sealed run evidence."""

from __future__ import annotations

import json
import re
from collections import Counter
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from decimal import (
    ROUND_HALF_EVEN,
    Context,
    Decimal,
    DecimalException,
    DivisionByZero,
    InvalidOperation,
    localcontext,
)
from enum import Enum
from hashlib import sha256
from pathlib import Path
from typing import Any, Literal, cast

from pydantic import ValidationError

from stark_trading_os.agent.models import (
    SOURCE_KINDS,
    EvidenceManifestV1,
    EvidenceRunV1,
    EvidenceSourceV1,
    ExactValueRef,
    RatioCalculation,
    ReviewCitation,
    ReviewNotice,
    SourceKind,
    StatementOption,
)
from stark_trading_os.audit.canonical_json import (
    CanonicalJSONError,
    canonical_decimal_string,
    canonical_json_bytes,
    parse_json_object,
)
from stark_trading_os.control.process_identity import (
    SupervisorExitV1,
    supervisor_exit_from_bytes,
)
from stark_trading_os.control.recovery import ArtifactIntegrityError, FinalizationRecovery
from stark_trading_os.control.registry import (
    AuditIntent,
    CatalogPublication,
    ControlStore,
    PersistedEvent,
    RunEvidenceSnapshot,
    RunNotFound,
    RunSnapshot,
    TerminalIntegrityError,
    TerminalPreparation,
    TerminalPublication,
)
from stark_trading_os.domain.models import EventEnvelopeV1, InputManifestV1, RunRecordV1
from stark_trading_os.runner.protocol import RunnerReportCandidateV1
from stark_trading_os.runner.report_export import (
    REPORT_SCHEMAS,
    ReportSchemaError,
    export_metrics,
    normalize_report_row,
)

type _RunRole = Literal["PRIMARY", "COMPARE"]
type _ReportKind = Literal["orders", "fills", "positions", "account", "metrics"]

PRIVATE_ARTIFACT_PATHS: tuple[str, ...] = (
    "input-manifest.json",
    "run-record.json",
    "events.ndjson",
    "runner-exit.json",
    "reports/orders.json",
    "reports/fills.json",
    "reports/positions.json",
    "reports/account.json",
    "reports/metrics.json",
)

_RUN_ROLES: tuple[_RunRole, ...] = ("PRIMARY", "COMPARE")
_REPORT_KINDS: tuple[_ReportKind, ...] = (
    "orders",
    "fills",
    "positions",
    "account",
    "metrics",
)
_REPORT_SOURCE_KINDS = ("ORDERS", "FILLS", "POSITIONS", "ACCOUNT", "METRICS")
_KNOWN_EVENT_TYPES = (
    "preflight.passed",
    "preflight.blocked",
    "run.queued",
    "run.started",
    "run.cancel_requested",
    "run.cancel_pending",
    "run.finalizing",
    "report.generated",
    "run.completed",
    "run.failed",
    "run.cancelled",
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
)
_KNOWN_EVENT_TYPE_SET = frozenset(_KNOWN_EVENT_TYPES)
_ID_PATTERNS = {
    "artifact": re.compile(r"^art_[0-9a-f]{64}$"),
    "event": re.compile(r"^evt_[0-9a-f]{64}$"),
}
_ARTIFACT_PROJECTION_MAX_BYTES = 61_440
_EVENT_PROJECTION_MAX_BYTES = 4_096
_TOOL_ENVELOPE_MAX_BYTES = 65_536
# ``read_artifact`` adds its closed registry metadata after the projection. Per artifact that is
# one citation plus, at worst, 46 role-local event IDs and one value/statement (EVENTS), or three
# bounded source values and four statements (METRICS). Opaque IDs have fixed lengths, source
# decimals are at most 256 ASCII characters, and all labels/text come from fixed templates.
_ARTIFACT_ENVELOPE_METADATA_RESERVE_BYTES = 8_192
_ARTIFACT_EFFECTIVE_PROJECTION_MAX_BYTES = (
    _TOOL_ENVELOPE_MAX_BYTES - _ARTIFACT_ENVELOPE_METADATA_RESERVE_BYTES
)
_RETAINED_BUDGET_BYTES = 2_097_152
_LONG_TEXT_MAX_BYTES = 512

_SAMPLE_FIELDS: dict[str, tuple[str, ...]] = {
    "orders": (
        "client_order_id",
        "instrument_id",
        "side",
        "type",
        "quantity",
        "price",
        "status",
        "filled_qty",
        "ts_init",
        "ts_last",
    ),
    "fills": (
        "client_order_id",
        "instrument_id",
        "trade_id",
        "order_side",
        "order_type",
        "last_qty",
        "last_px",
        "currency",
        "liquidity_side",
        "ts_event",
    ),
    "positions": (
        "position_id",
        "instrument_id",
        "entry",
        "side",
        "quantity",
        "ts_opened",
        "ts_closed",
        "realized_return",
        "realized_pnl",
    ),
    "account": (
        "ts_event_ns",
        "account_id",
        "account_type",
        "currency",
        "total",
        "locked",
        "free",
        "base_currency",
    ),
}

_SAME_RUN_RATIO_SEMANTICS = (
    ("ORDERS_CLOSED", "ORDERS_TOTAL"),
    ("FILLS_TOTAL", "ORDERS_TOTAL"),
    ("POSITIONS_CLOSED", "POSITIONS_TOTAL"),
    ("END_EQUITY", "START_EQUITY"),
)
_CROSS_RUN_RATIO_SEMANTICS = (
    "ORDERS_TOTAL",
    "ORDERS_CLOSED",
    "FILLS_TOTAL",
    "POSITIONS_TOTAL",
    "POSITIONS_CLOSED",
    "TOTAL_EVENTS",
    "ITERATIONS",
    "START_EQUITY",
    "END_EQUITY",
)


class RunEvidenceUnsealed(RuntimeError):
    """The selected run has no verified terminal publication."""


class RunEvidenceIntegrityFailed(RuntimeError):
    """Selected sealed evidence disagrees with its captured authority."""


class ScopeLookupError(LookupError):
    """An opaque lookup identifier is malformed or outside this scope."""


class DeterministicRatioRejected(ValueError):
    """A requested ratio is outside the closed deterministic allowlist."""


@dataclass(frozen=True, slots=True)
class _PreparedSource:
    source_kind: SourceKind
    available: bool
    raw_sha256: str | None
    raw_size_bytes: int | None
    projection_bytes: bytes
    coverage: Literal["FULL", "AGGREGATED_WITH_SAMPLES", "MISSING"]
    record_count: int
    sample_count: int
    omitted_count: int


@dataclass(frozen=True, slots=True)
class _PreparedEvent:
    envelope_sha256: str
    projection_bytes: bytes


@dataclass(frozen=True, slots=True)
class _SemanticValue:
    role: _RunRole
    semantic: str
    value: str
    unit: Literal["COUNT", "ACCOUNT_CURRENCY"]
    currency: str | None
    source_kind: SourceKind


@dataclass(frozen=True, slots=True)
class _PreparedRun:
    role: _RunRole
    terminal_state: Literal["COMPLETED", "FAILED", "CANCELLED"]
    state_version: int
    last_visible_seq: int
    terminal_event_seq: int
    materialized_event_seq: int
    materialized_audit_seq: int
    published_at_ns: int
    seal_digest: str
    sources: tuple[_PreparedSource, ...]
    events: tuple[_PreparedEvent, ...]
    semantics: tuple[_SemanticValue, ...]
    missing_sources: tuple[SourceKind, ...]
    authority: dict[str, object]


@dataclass(frozen=True, slots=True)
class _ArtifactRecord:
    artifact_id: str
    role: _RunRole
    source_kind: SourceKind
    available: bool
    projection_bytes: bytes


@dataclass(frozen=True, slots=True)
class _EventRecord:
    event_id: str
    role: _RunRole
    projection_bytes: bytes


@dataclass(frozen=True, slots=True)
class EvidenceScope:
    """A deeply immutable, store-free capability over one sealed evidence scope."""

    manifest: EvidenceManifestV1
    citations: tuple[ReviewCitation, ...]
    value_refs: tuple[ExactValueRef, ...]
    statement_options: tuple[StatementOption, ...]
    notices: tuple[ReviewNotice, ...]
    allowed_ratio_pairs: tuple[tuple[str, str], ...]
    retained_size_bytes: int
    _artifact_records: tuple[_ArtifactRecord, ...]
    _event_records: tuple[_EventRecord, ...]

    def __post_init__(self) -> None:
        tuple_fields = (
            self.citations,
            self.value_refs,
            self.statement_options,
            self.notices,
            self.allowed_ratio_pairs,
            self._artifact_records,
            self._event_records,
        )
        if any(type(value) is not tuple for value in tuple_fields) or any(
            type(pair) is not tuple for pair in self.allowed_ratio_pairs
        ):
            raise TypeError("EvidenceScope accepts only deeply immutable tuple registries.")
        exact_registries = (
            (self.citations, ReviewCitation),
            (self.value_refs, ExactValueRef),
            (self.statement_options, StatementOption),
            (self.notices, ReviewNotice),
            (self._artifact_records, _ArtifactRecord),
            (self._event_records, _EventRecord),
        )
        if type(self.manifest) is not EvidenceManifestV1 or any(
            type(item) is not expected
            for registry, expected in exact_registries
            for item in registry
        ):
            raise TypeError("EvidenceScope registries require exact immutable item types.")
        if any(
            len(pair) != 2 or any(type(item) is not str for item in pair)
            for pair in self.allowed_ratio_pairs
        ):
            raise TypeError("EvidenceScope ratio pairs require exact immutable IDs.")
        if type(self.retained_size_bytes) is not int or self.retained_size_bytes < 0:
            raise TypeError("EvidenceScope retained size must be a non-negative integer.")

    @property
    def scope_id(self) -> str:
        return self.manifest.scope_id

    @property
    def artifact_ids(self) -> tuple[str, ...]:
        return tuple(record.artifact_id for record in self._artifact_records)

    @property
    def event_ids(self) -> tuple[str, ...]:
        return tuple(record.event_id for record in self._event_records)

    def canonical_bytes(self) -> bytes:
        """Return the complete public, retained scope in canonical form."""

        return canonical_json_bytes(
            {
                "scope_id": self.scope_id,
                "manifest": self.manifest.model_dump(mode="json", by_alias=True),
                "citations": [item.model_dump(mode="json") for item in self.citations],
                "value_refs": [item.model_dump(mode="json") for item in self.value_refs],
                "statement_options": [
                    item.model_dump(mode="json") for item in self.statement_options
                ],
                "notices": [item.model_dump(mode="json") for item in self.notices],
                "allowed_ratio_pairs": [list(pair) for pair in self.allowed_ratio_pairs],
                "artifact_projections": [
                    {
                        "artifact_id": record.artifact_id,
                        "run_role": record.role,
                        "source_kind": record.source_kind,
                        "available": record.available,
                        "projection_sha256": sha256(record.projection_bytes).hexdigest(),
                    }
                    for record in self._artifact_records
                ],
                "event_projections": [
                    {
                        "event_id": record.event_id,
                        "run_role": record.role,
                        "projection_sha256": sha256(record.projection_bytes).hexdigest(),
                    }
                    for record in self._event_records
                ],
            }
        )

    def read_artifact(self, artifact_id: str) -> bytes:
        """Resolve one exact opaque artifact ID from retained projection memory."""

        record = self._artifact_record(artifact_id)
        citation_ids = tuple(
            item.citation_id
            for item in self.citations
            if item.kind == "ARTIFACT" and item.artifact_id == record.artifact_id
        )
        value_refs = tuple(item for item in self.value_refs if item.citation_id in citation_ids)
        value_ids = {item.value_ref_id for item in value_refs}
        statements = tuple(
            item
            for item in self.statement_options
            if set(item.citation_ids) & set(citation_ids) or set(item.value_ref_ids) & value_ids
        )
        event_ids = tuple(
            event.event_id
            for event in self._event_records
            if event.role == record.role and record.source_kind == "EVENTS"
        )
        envelope = canonical_json_bytes(
            {
                "scope_id": self.scope_id,
                "artifact_id": record.artifact_id,
                "run_role": record.role,
                "source_kind": record.source_kind,
                "available": record.available,
                "projection": parse_json_object(record.projection_bytes),
                "event_ids": list(event_ids),
                "citations": [
                    item.model_dump(mode="json")
                    for item in self.citations
                    if item.citation_id in citation_ids
                ],
                "value_refs": [item.model_dump(mode="json") for item in value_refs],
                "statement_options": [item.model_dump(mode="json") for item in statements],
            }
        )
        if len(envelope) > _TOOL_ENVELOPE_MAX_BYTES:
            raise RunEvidenceIntegrityFailed("Bounded artifact envelope exceeded its cap.")
        return envelope

    def read_event(self, event_id: str) -> bytes:
        """Resolve one exact opaque event ID from retained projection memory."""

        record = self._event_record(event_id)
        citations = tuple(
            item
            for item in self.citations
            if item.kind == "EVENT" and item.event_id == record.event_id
        )
        envelope = canonical_json_bytes(
            {
                "scope_id": self.scope_id,
                "event_id": record.event_id,
                "run_role": record.role,
                "projection": parse_json_object(record.projection_bytes),
                "citations": [item.model_dump(mode="json") for item in citations],
                "statement_options": [],
                "value_refs": [],
            }
        )
        if len(envelope) > _TOOL_ENVELOPE_MAX_BYTES:
            raise RunEvidenceIntegrityFailed("Bounded event envelope exceeded its cap.")
        return envelope

    def deterministic_ratio(
        self,
        numerator_value_ref_id: str,
        denominator_value_ref_id: str,
        *,
        tool_call_ordinal: int,
    ) -> RatioCalculation:
        """Purely derive one allowlisted decimal34 ratio for an explicit call ordinal."""

        if type(tool_call_ordinal) is not int or not 1 <= tool_call_ordinal <= 8:
            raise DeterministicRatioRejected("Ratio call ordinal is outside the closed budget.")
        pair = (numerator_value_ref_id, denominator_value_ref_id)
        if pair not in self.allowed_ratio_pairs:
            raise DeterministicRatioRejected("Ratio pair is not allowlisted for this scope.")
        numerator = self._source_value(numerator_value_ref_id)
        denominator = self._source_value(denominator_value_ref_id)
        if (
            numerator.origin != "SOURCE"
            or denominator.origin != "SOURCE"
            or numerator.unit != denominator.unit
            or numerator.currency != denominator.currency
        ):
            raise DeterministicRatioRejected("Ratio source values are incompatible.")
        try:
            with localcontext(_ratio_context()):
                denominator_decimal = Decimal(denominator.value)
                if denominator_decimal == 0:
                    raise DivisionByZero
                result = Decimal(numerator.value) / denominator_decimal
                result_text = canonical_decimal_string(result)
        except (CanonicalJSONError, DecimalException, InvalidOperation, ValueError) as error:
            raise DeterministicRatioRejected("Ratio cannot be represented exactly.") from error
        if len(result_text) > 256:
            raise DeterministicRatioRejected("Ratio result exceeds the closed value bound.")

        identity = (
            self.scope_id,
            str(tool_call_ordinal),
            numerator.value_ref_id,
            denominator.value_ref_id,
            result_text,
        )
        return RatioCalculation(
            calculation_id=_opaque_id("calc_", "ratio-calculation", *identity),
            scope_id=self.scope_id,
            tool_call_ordinal=tool_call_ordinal,
            numerator_value_ref_id=numerator.value_ref_id,
            denominator_value_ref_id=denominator.value_ref_id,
            result=result_text,
            rule="DECIMAL34_HALF_EVEN_RATIO_V1",
            result_value_ref_id=_opaque_id("val_", "ratio-result-value", *identity),
            citation_id=_opaque_id("cit_", "ratio-citation", *identity),
            statement_id=_opaque_id("stmt_", "ratio-statement", *identity),
        )

    def ratio_value_ref(self, calculation: RatioCalculation) -> ExactValueRef:
        numerator, denominator = self._validated_ratio_sources(calculation)
        role = numerator.run_role if numerator.run_role == denominator.run_role else None
        return ExactValueRef(
            value_ref_id=calculation.result_value_ref_id,
            scope_id=self.scope_id,
            run_role=role,
            semantic=f"{numerator.semantic}_OVER_{denominator.semantic}",
            value=calculation.result,
            unit="RATIO",
            currency=None,
            citation_id=calculation.citation_id,
            origin="CALCULATION",
        )

    def ratio_citation(self, calculation: RatioCalculation) -> ReviewCitation:
        numerator, denominator = self._validated_ratio_sources(calculation)
        role = numerator.run_role if numerator.run_role == denominator.run_role else None
        return ReviewCitation(
            citation_id=calculation.citation_id,
            scope_id=self.scope_id,
            kind="CALCULATION",
            run_role=role,
            source_kind=None,
            value_ref_ids=(numerator.value_ref_id, denominator.value_ref_id),
            label=(
                f"Decimal34 ratio of {_semantic_label(numerator.semantic)} over "
                f"{_semantic_label(denominator.semantic)}"
            ),
        )

    def ratio_statement(self, calculation: RatioCalculation) -> StatementOption:
        numerator, denominator = self._validated_ratio_sources(calculation)
        role = numerator.run_role if numerator.run_role == denominator.run_role else None
        prefix = _role_label(role) if role is not None else "Primary-over-compare"
        return StatementOption(
            statement_id=calculation.statement_id,
            scope_id=self.scope_id,
            section="DETERMINISTIC_CALCULATION",
            text=(
                f"{prefix} {_semantic_label(numerator.semantic)} divided by "
                f"{_semantic_label(denominator.semantic)} is {calculation.result} "
                "(decimal34 half-even)."
            ),
            citation_ids=(calculation.citation_id,),
            value_ref_ids=(calculation.result_value_ref_id,),
            run_role=role,
        )

    def ratio_envelope(self, calculation: RatioCalculation) -> bytes:
        numerator, denominator = self._validated_ratio_sources(calculation)
        citation = self.ratio_citation(calculation)
        value = self.ratio_value_ref(calculation)
        statement = self.ratio_statement(calculation)
        envelope = canonical_json_bytes(
            {
                "scope_id": self.scope_id,
                "calculation": calculation.model_dump(mode="json"),
                "citation": citation.model_dump(mode="json"),
                "source_value_refs": [
                    numerator.model_dump(mode="json"),
                    denominator.model_dump(mode="json"),
                ],
                "result_value_ref": value.model_dump(mode="json"),
                "statement_option": statement.model_dump(mode="json"),
            }
        )
        if len(envelope) > _TOOL_ENVELOPE_MAX_BYTES:
            raise RunEvidenceIntegrityFailed("Bounded ratio envelope exceeded its cap.")
        return envelope

    def _artifact_record(self, artifact_id: str) -> _ArtifactRecord:
        if type(artifact_id) is not str or _ID_PATTERNS["artifact"].fullmatch(artifact_id) is None:
            raise ScopeLookupError("Artifact lookup requires one opaque scope identifier.")
        for record in self._artifact_records:
            if record.artifact_id == artifact_id:
                return record
        raise ScopeLookupError("Artifact identifier is outside this evidence scope.")

    def _event_record(self, event_id: str) -> _EventRecord:
        if type(event_id) is not str or _ID_PATTERNS["event"].fullmatch(event_id) is None:
            raise ScopeLookupError("Event lookup requires one opaque scope identifier.")
        for record in self._event_records:
            if record.event_id == event_id:
                return record
        raise ScopeLookupError("Event identifier is outside this evidence scope.")

    def _source_value(self, value_ref_id: str) -> ExactValueRef:
        if type(value_ref_id) is not str:
            raise DeterministicRatioRejected("Ratio operands must be opaque value-ref IDs.")
        for value in self.value_refs:
            if value.value_ref_id == value_ref_id and value.origin == "SOURCE":
                return value
        raise DeterministicRatioRejected("Ratio value ref is outside the source registry.")

    def _validated_ratio_sources(
        self, calculation: RatioCalculation
    ) -> tuple[ExactValueRef, ExactValueRef]:
        if calculation.scope_id != self.scope_id:
            raise DeterministicRatioRejected("Ratio calculation belongs to another scope.")
        expected = self.deterministic_ratio(
            calculation.numerator_value_ref_id,
            calculation.denominator_value_ref_id,
            tool_call_ordinal=calculation.tool_call_ordinal,
        )
        if expected != calculation:
            raise DeterministicRatioRejected("Ratio calculation differs from recomputation.")
        return (
            self._source_value(calculation.numerator_value_ref_id),
            self._source_value(calculation.denominator_value_ref_id),
        )


class IndependentEvidenceScopeBuilder:
    """Build one scope from a worker-owned, short-lived ControlStore connection."""

    def __init__(self, *, control_database: Path, runtime_root: Path) -> None:
        self._control_database = Path(control_database)
        self._runtime_root = Path(runtime_root)

    def build(self, primary_run_id: str, compare_run_id: str | None = None) -> EvidenceScope:
        store = ControlStore.open(self._control_database)
        try:
            recovery = FinalizationRecovery(store=store, runtime_root=self._runtime_root)
            return EvidenceScopeBuilder(store=store, recovery=recovery).build(
                primary_run_id,
                compare_run_id,
            )
        finally:
            store.close()


class EvidenceScopeBuilder:
    """Capture exact Control authority, then discard all mutable capabilities."""

    def __init__(self, *, store: ControlStore, recovery: FinalizationRecovery) -> None:
        self._store = store
        self._recovery = recovery

    def build(self, primary_run_id: str, compare_run_id: str | None = None) -> EvidenceScope:
        if type(primary_run_id) is not str or not primary_run_id:
            raise ValueError("primary_run_id must be a non-empty string.")
        if compare_run_id is not None and (
            type(compare_run_id) is not str
            or not compare_run_id
            or compare_run_id == primary_run_id
        ):
            raise ValueError("compare_run_id must be a distinct non-empty string.")

        run_ids = (primary_run_id,) if compare_run_id is None else (primary_run_id, compare_run_id)
        prepared: list[_PreparedRun] = []
        for index, run_id in enumerate(run_ids):
            role = _RUN_ROLES[index]
            prepared.append(self._capture_run(run_id=run_id, role=role))

        scope_descriptor = {
            "contract": "EvidenceScope.v1",
            "runs": [
                {
                    "role": run.role,
                    "authority": run.authority,
                    "sources": [
                        {
                            "source_kind": source.source_kind,
                            "available": source.available,
                            "raw_sha256": source.raw_sha256,
                            "raw_size_bytes": source.raw_size_bytes,
                            "projection_sha256": sha256(source.projection_bytes).hexdigest(),
                            "projection_size_bytes": len(source.projection_bytes),
                            "coverage": source.coverage,
                            "record_count": source.record_count,
                            "sample_count": source.sample_count,
                            "omitted_count": source.omitted_count,
                        }
                        for source in run.sources
                    ],
                    "projected_events": [
                        {
                            "envelope_sha256": event.envelope_sha256,
                            "projection_sha256": sha256(event.projection_bytes).hexdigest(),
                            "projection_size_bytes": len(event.projection_bytes),
                        }
                        for event in run.events
                    ],
                }
                for run in prepared
            ],
        }
        scope_id = f"scope_{sha256(canonical_json_bytes(scope_descriptor)).hexdigest()}"
        return self._assemble_scope(scope_id=scope_id, prepared=tuple(prepared))

    def _capture_run(
        self,
        *,
        run_id: str,
        role: _RunRole,
    ) -> _PreparedRun:
        try:
            snapshot = self._store.run_evidence_snapshot(run_id)
        except RunNotFound:
            raise
        except TerminalIntegrityError as error:
            raise RunEvidenceIntegrityFailed("Captured Control authority is invalid.") from error
        publication = snapshot.terminal_finalization
        if type(publication) is not TerminalPublication:
            raise RunEvidenceUnsealed("Selected run is not a verified sealed terminal run.")
        try:
            artifacts = self._recovery.read_artifacts(
                publication=publication,
                relative_paths=PRIVATE_ARTIFACT_PATHS,
            )
        except ArtifactIntegrityError as error:
            raise RunEvidenceIntegrityFailed("Sealed artifact verification failed.") from error
        try:
            return _prepare_run(snapshot, publication, artifacts, role=role)
        except (
            CanonicalJSONError,
            ValidationError,
            ReportSchemaError,
            ValueError,
            TypeError,
        ) as error:
            raise RunEvidenceIntegrityFailed(
                "Sealed evidence differs from captured authority."
            ) from error

    def _assemble_scope(
        self,
        *,
        scope_id: str,
        prepared: tuple[_PreparedRun, ...],
    ) -> EvidenceScope:
        artifact_records: list[_ArtifactRecord] = []
        event_records: list[_EventRecord] = []
        evidence_runs: list[EvidenceRunV1] = []
        citations: list[ReviewCitation] = []
        source_citation_ids: dict[tuple[str, str], str] = {}

        for run in prepared:
            evidence_sources: list[EvidenceSourceV1] = []
            for source in run.sources:
                projection_sha = sha256(source.projection_bytes).hexdigest()
                artifact_id = _opaque_id(
                    "art_",
                    "artifact",
                    scope_id,
                    run.role,
                    run.seal_digest,
                    source.source_kind,
                    source.raw_sha256 or "MISSING",
                    projection_sha,
                )
                artifact_records.append(
                    _ArtifactRecord(
                        artifact_id=artifact_id,
                        role=run.role,
                        source_kind=source.source_kind,
                        available=source.available,
                        projection_bytes=source.projection_bytes,
                    )
                )
                evidence_sources.append(
                    EvidenceSourceV1(
                        source_kind=source.source_kind,
                        artifact_id=artifact_id,
                        available=source.available,
                        raw_sha256=source.raw_sha256,
                        raw_size_bytes=source.raw_size_bytes,
                        projection_sha256=projection_sha,
                        projection_size_bytes=len(source.projection_bytes),
                        coverage=source.coverage,
                        record_count=source.record_count,
                        sample_count=source.sample_count,
                        omitted_count=source.omitted_count,
                    )
                )
                citation_id = _opaque_id(
                    "cit_", "artifact-citation", scope_id, run.role, source.source_kind, artifact_id
                )
                source_citation_ids[(run.role, source.source_kind)] = citation_id
                citations.append(
                    ReviewCitation(
                        citation_id=citation_id,
                        scope_id=scope_id,
                        kind="ARTIFACT",
                        run_role=run.role,
                        source_kind=source.source_kind,
                        artifact_id=artifact_id,
                        label=(
                            f"{_role_label(run.role)} sealed "
                            f"{_source_label(source.source_kind)} projection"
                        ),
                    )
                )

            evidence_runs.append(
                EvidenceRunV1(
                    role=run.role,
                    terminal_state=run.terminal_state,
                    state_version=run.state_version,
                    last_visible_seq=run.last_visible_seq,
                    terminal_event_seq=run.terminal_event_seq,
                    materialized_event_seq=run.materialized_event_seq,
                    materialized_audit_seq=run.materialized_audit_seq,
                    published_at_ns=run.published_at_ns,
                    seal_digest=run.seal_digest,
                    sources=tuple(evidence_sources),
                )
            )
            for event_index, event in enumerate(run.events):
                event_id = _opaque_id(
                    "evt_",
                    "event",
                    scope_id,
                    run.role,
                    event.envelope_sha256,
                    sha256(event.projection_bytes).hexdigest(),
                    str(event_index),
                )
                event_records.append(
                    _EventRecord(
                        event_id=event_id,
                        role=run.role,
                        projection_bytes=event.projection_bytes,
                    )
                )
                citations.append(
                    ReviewCitation(
                        citation_id=_opaque_id(
                            "cit_", "event-citation", scope_id, run.role, event_id
                        ),
                        scope_id=scope_id,
                        kind="EVENT",
                        run_role=run.role,
                        source_kind="EVENTS",
                        event_id=event_id,
                        label=f"{_role_label(run.role)} sealed event projection",
                    )
                )

        manifest = EvidenceManifestV1(scope_id=scope_id, runs=tuple(evidence_runs))
        scope_citation = ReviewCitation(
            citation_id=_opaque_id("cit_", "scope-attestation", scope_id),
            scope_id=scope_id,
            kind="SCOPE_ATTESTATION",
            run_role=None,
            source_kind=None,
            label="Selected sealed evidence scope",
        )
        citations.append(scope_citation)

        value_refs: list[ExactValueRef] = []
        for run in prepared:
            for semantic in run.semantics:
                if len(semantic.value) > 256 or len(semantic.value.encode("utf-8")) > 1_024:
                    continue
                citation_id = source_citation_ids[(run.role, semantic.source_kind)]
                value_refs.append(
                    ExactValueRef(
                        value_ref_id=_opaque_id(
                            "val_",
                            "source-value",
                            scope_id,
                            run.role,
                            semantic.source_kind,
                            semantic.semantic,
                            semantic.value,
                            semantic.unit,
                            semantic.currency or "NONE",
                        ),
                        scope_id=scope_id,
                        run_role=run.role,
                        semantic=semantic.semantic,
                        value=semantic.value,
                        unit=semantic.unit,
                        currency=semantic.currency,
                        citation_id=citation_id,
                        origin="SOURCE",
                    )
                )
        if len(value_refs) > 256:
            value_refs = value_refs[:256]

        statements = _build_statements(
            scope_id=scope_id,
            runs=prepared,
            values=tuple(value_refs),
            source_citation_ids=source_citation_ids,
            scope_citation_id=scope_citation.citation_id,
        )
        notices = _build_notices(
            scope_id=scope_id,
            runs=prepared,
            scope_citation_id=scope_citation.citation_id,
        )
        allowed_pairs = _build_allowed_ratio_pairs(tuple(value_refs))

        provisional = EvidenceScope(
            manifest=manifest,
            citations=tuple(citations),
            value_refs=tuple(value_refs),
            statement_options=statements,
            notices=notices,
            allowed_ratio_pairs=allowed_pairs,
            retained_size_bytes=0,
            _artifact_records=tuple(artifact_records),
            _event_records=tuple(event_records),
        )
        retained_size = _retained_size(provisional)
        scope = EvidenceScope(
            manifest=manifest,
            citations=provisional.citations,
            value_refs=provisional.value_refs,
            statement_options=provisional.statement_options,
            notices=provisional.notices,
            allowed_ratio_pairs=provisional.allowed_ratio_pairs,
            retained_size_bytes=retained_size,
            _artifact_records=provisional._artifact_records,
            _event_records=provisional._event_records,
        )
        _validate_scope_caps(scope)
        return scope


def _prepare_run(
    snapshot: RunEvidenceSnapshot,
    publication: TerminalPublication,
    artifacts: tuple[bytes | None, ...],
    *,
    role: _RunRole,
) -> _PreparedRun:
    if len(artifacts) != len(PRIVATE_ARTIFACT_PATHS):
        raise ValueError("Verified artifact bundle has the wrong inventory length.")
    if any(type(artifacts[index]) is not bytes for index in range(4)):
        raise ValueError("The four mandatory sealed sources must be present.")
    manifest_raw, run_record_raw, events_raw, runner_exit_raw = cast(
        tuple[bytes, bytes, bytes, bytes], artifacts[:4]
    )
    _validate_publication(snapshot, publication)
    manifest = _parse_exact_model(manifest_raw, InputManifestV1)
    run_record = _parse_exact_model(run_record_raw, RunRecordV1)
    runner_exit = supervisor_exit_from_bytes(runner_exit_raw)
    events = _parse_exact_events(snapshot, publication, events_raw)
    _validate_mandatory_identities(
        snapshot=snapshot,
        publication=publication,
        manifest=manifest,
        manifest_raw=manifest_raw,
        run_record=run_record,
        runner_exit=runner_exit,
        runner_exit_raw=runner_exit_raw,
    )

    report_rows: dict[str, list[dict[str, object]] | dict[str, object] | None] = {}
    child = runner_exit.child_outcome
    candidate_by_name: dict[str, RunnerReportCandidateV1] = {
        item.name: item for item in (() if child is None else child.report_candidates)
    }
    for index, report_kind in enumerate(_REPORT_KINDS, start=4):
        raw = artifacts[index]
        candidate = candidate_by_name.get(report_kind)
        if raw is None:
            if candidate is not None:
                raise ValueError("Declared sealed report is missing from the verified bundle.")
            report_rows[report_kind] = None
            continue
        if type(raw) is not bytes or candidate is None:
            raise ValueError("Verified report presence differs from the runner outcome.")
        if (
            candidate.relative_path != PRIVATE_ARTIFACT_PATHS[index]
            or candidate.size_bytes != len(raw)
            or candidate.sha256 != sha256(raw).hexdigest()
        ):
            raise ValueError("Verified report differs from its runner candidate identity.")
        report_rows[report_kind] = (
            _parse_exact_metrics(raw)
            if report_kind == "metrics"
            else _parse_exact_report_rows(report_kind, raw)
        )

    prepared_sources: list[_PreparedSource] = []
    prepared_sources.append(
        _source_from_projection(
            "INPUT_MANIFEST",
            manifest_raw,
            _manifest_projection(manifest),
            record_count=1,
            sample_count=1,
        )
    )
    prepared_sources.append(
        _source_from_projection(
            "RUN_RECORD",
            run_record_raw,
            _run_record_projection(run_record),
            record_count=1,
            sample_count=1,
        )
    )
    event_projection, event_samples = _events_projection(events)
    prepared_sources.append(
        _source_from_projection(
            "EVENTS",
            events_raw,
            event_projection,
            record_count=len(events),
            sample_count=len(event_samples),
        )
    )
    prepared_sources.append(
        _source_from_projection(
            "RUNNER_EXIT",
            runner_exit_raw,
            _runner_exit_projection(runner_exit),
            record_count=1,
            sample_count=1,
        )
    )

    missing_sources: list[SourceKind] = []
    for report_kind, source_kind in zip(_REPORT_KINDS, _REPORT_SOURCE_KINDS, strict=True):
        parsed = report_rows[report_kind]
        raw = artifacts[4 + _REPORT_KINDS.index(report_kind)]
        if parsed is None or raw is None:
            missing_sources.append(cast(SourceKind, source_kind))
            prepared_sources.append(_missing_source(cast(SourceKind, source_kind)))
            continue
        if report_kind == "metrics":
            metrics = cast(dict[str, object], parsed)
            projection, record_count, sample_count = _metrics_projection(metrics)
        else:
            rows = cast(list[dict[str, object]], parsed)
            projection, sample_count = _report_projection(report_kind, rows)
            record_count = len(rows)
        prepared_sources.append(
            _source_from_projection(
                cast(SourceKind, source_kind),
                raw,
                projection,
                record_count=record_count,
                sample_count=sample_count,
            )
        )

    if tuple(source.source_kind for source in prepared_sources) != SOURCE_KINDS:
        raise ValueError("Private source inventory drifted.")
    semantics = _semantic_values(
        role=role,
        events=events,
        reports=report_rows,
    )
    return _PreparedRun(
        role=role,
        terminal_state=cast(Literal["COMPLETED", "FAILED", "CANCELLED"], publication.state.value),
        state_version=publication.state_version,
        last_visible_seq=snapshot.last_visible_seq,
        terminal_event_seq=publication.event.seq,
        materialized_event_seq=publication.materialized_event_seq,
        materialized_audit_seq=publication.materialized_audit_seq,
        published_at_ns=publication.published_at_ns,
        seal_digest=publication.seal_digest,
        sources=tuple(prepared_sources),
        events=tuple(event_samples),
        semantics=semantics,
        missing_sources=tuple(missing_sources),
        authority=_authority_descriptor(snapshot, publication),
    )


def _validate_publication(snapshot: RunEvidenceSnapshot, publication: TerminalPublication) -> None:
    run = snapshot.run
    terminal_event_type = {
        "COMPLETED": "run.completed",
        "FAILED": "run.failed",
        "CANCELLED": "run.cancelled",
    }[publication.state.value]
    if (
        publication.run_id != run.run_id
        or publication.state != run.state
        or publication.state_version != run.state_version
        or publication.event.run_id != run.run_id
        or publication.audit_intent.run_id != run.run_id
        or publication.event.seq != snapshot.last_visible_seq
        or snapshot.last_visible_seq != run.last_event_seq
        or publication.audit_intent.event_seq != publication.event.seq
        or publication.audit_intent.audit_seq != run.last_audit_seq
        or publication.materialized_event_seq != publication.event.seq
        or publication.materialized_audit_seq != publication.audit_intent.audit_seq
        or publication.event.type != terminal_event_type
        or publication.event.source != "control-api"
        or run.evidence_status != "VERIFIED"
        or not snapshot.events
        or snapshot.events[-1] != publication.event
    ):
        raise ValueError("Terminal publication does not match the captured run authority.")
    if (
        sha256(publication.event.envelope_bytes).hexdigest()
        != publication.audit_intent.event_digest
    ):
        raise ValueError("Terminal audit intent does not bind the exact event bytes.")


def _validate_mandatory_identities(
    *,
    snapshot: RunEvidenceSnapshot,
    publication: TerminalPublication,
    manifest: InputManifestV1,
    manifest_raw: bytes,
    run_record: RunRecordV1,
    runner_exit: SupervisorExitV1,
    runner_exit_raw: bytes,
) -> None:
    run = snapshot.run
    catalog = snapshot.catalog_publication
    recorded_outcome = snapshot.runner_outcome
    run_record_exit = run_record.model_dump(mode="json", by_alias=True)["runner_exit"]
    child = runner_exit.child_outcome
    if (
        run.input_manifest_bytes != manifest_raw
        or run.input_manifest_hash != sha256(manifest_raw).hexdigest()
        or run.catalog_revision != manifest.catalog_revision
        or run_record.run_id != run.run_id
        or run_record.state != run.state
        or run_record.state_version != run.state_version
        or run_record.prepared_terminal_state != publication.state
        or run_record.prepared_terminal_state_version != publication.state_version
        or run_record.created_at_ns != str(run.created_at_ns)
        or run_record.materialized_event_seq != publication.materialized_event_seq
        or run_record.materialized_audit_seq != publication.materialized_audit_seq
        or run_record.evidence_status != "VERIFIED"
        or runner_exit.run_id != run.run_id
        or runner_exit.proposed_terminal_state != publication.state.value
        or run_record_exit != runner_exit.model_dump(mode="json", by_alias=True)
        or (
            child is not None
            and (
                child.run_id != run.run_id
                or child.input_manifest_hash != run.input_manifest_hash
                or child.catalog_revision != run.catalog_revision
                or child.engine_package_version != manifest.engine_package_version
            )
        )
        or (
            child is None
            and runner_exit.classification not in {"NO_SPAWN_CANCELLED", "SUPERVISOR_FAILURE"}
        )
        or catalog is None
        or catalog.status != "PUBLISHED"
        or catalog.catalog_revision != run.catalog_revision
        or catalog.inventory_hash != run.catalog_inventory_hash
        or catalog.fixture_id != manifest.fixture_id
        or recorded_outcome is None
        or recorded_outcome.run_id != run.run_id
        or recorded_outcome.outcome != runner_exit
        or recorded_outcome.outcome_bytes != runner_exit_raw
        or recorded_outcome.outcome_hash != sha256(runner_exit_raw).hexdigest()
    ):
        raise ValueError("Mandatory artifacts do not match the captured run authority.")
    if type(runner_exit_raw) is not bytes:
        raise TypeError("Runner exit must be exact bytes.")


def _parse_exact_model(raw: bytes, model: type[Any]) -> Any:
    value = parse_json_object(raw)
    parsed = model.model_validate(value)
    if canonical_json_bytes(parsed.model_dump(mode="json", by_alias=True)) != raw:
        raise ValueError("Stored model is not exact canonical bytes.")
    return parsed


def _parse_exact_events(
    snapshot: RunEvidenceSnapshot,
    publication: TerminalPublication,
    raw: bytes,
) -> tuple[tuple[PersistedEvent, EventEnvelopeV1, str], ...]:
    expected = b"".join(event.envelope_bytes + b"\n" for event in snapshot.events)
    if raw != expected:
        raise ValueError("Sealed events do not equal captured event envelopes byte-for-byte.")
    parsed: list[tuple[PersistedEvent, EventEnvelopeV1, str]] = []
    previous_seq = 0
    for expected_seq, persisted in enumerate(snapshot.events, start=1):
        value = parse_json_object(persisted.envelope_bytes)
        envelope = EventEnvelopeV1.model_validate(value)
        if canonical_json_bytes(envelope.model_dump(mode="json")) != persisted.envelope_bytes:
            raise ValueError("Captured event envelope is not exact canonical bytes.")
        if (
            persisted.visible is not True
            or persisted.type not in _KNOWN_EVENT_TYPE_SET
            or persisted.seq != expected_seq
            or persisted.seq <= previous_seq
            or persisted.run_id != snapshot.run.run_id
            or envelope.event_id != persisted.event_id
            or envelope.run_id != persisted.run_id
            or envelope.seq != persisted.seq
            or envelope.source_seq != persisted.source_seq
            or envelope.source != persisted.source
            or envelope.type != persisted.type
            or envelope.ts_event_ns != persisted.ts_event_ns
            or envelope.ts_ingest_ns != persisted.ts_ingest_ns
        ):
            raise ValueError("Captured event row differs from its exact envelope.")
        previous_seq = persisted.seq
        parsed.append((persisted, envelope, sha256(persisted.envelope_bytes).hexdigest()))
    if parsed[-1][0] != publication.event:
        raise ValueError("Terminal publication event is not the captured terminal event.")
    return tuple(parsed)


def _parse_exact_report_rows(kind: str, raw: bytes) -> list[dict[str, object]]:
    value = _strict_json_loads(raw)
    if type(value) is not list:
        raise ReportSchemaError(f"{kind} report must be an array")
    rows: list[dict[str, object]] = []
    for item in value:
        if type(item) is not dict:
            raise ReportSchemaError(f"{kind} report rows must be objects")
        rows.append(normalize_report_row(kind, cast(dict[str, object], item)))
    if canonical_json_bytes(rows) != raw:
        raise ReportSchemaError(f"{kind} report is not exact canonical bytes")
    _validate_report_order_and_uniqueness(kind, rows)
    return rows


def _parse_exact_metrics(raw: bytes) -> dict[str, object]:
    value = _strict_json_loads(raw)
    if type(value) is not dict:
        raise ReportSchemaError("metrics report must be an object")
    metrics = export_metrics(cast(dict[str, object], value))
    if canonical_json_bytes(metrics) != raw:
        raise ReportSchemaError("metrics report is not exact canonical bytes")
    return metrics


def _strict_json_loads(raw: bytes) -> object:
    try:
        return json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_pairs,
            parse_float=_reject_float,
            parse_constant=_reject_float,
        )
    except (UnicodeDecodeError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise ReportSchemaError("report is not strict JSON") from error


def _reject_duplicate_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ReportSchemaError("report contains a duplicate object key")
        value[key] = item
    return value


def _reject_float(_value: str) -> object:
    raise ReportSchemaError("binary floating-point JSON numbers are not accepted")


def _validate_report_order_and_uniqueness(kind: str, rows: list[dict[str, object]]) -> None:
    schema = REPORT_SCHEMAS[kind]
    primary_fields = {
        "orders": ("client_order_id",),
        "fills": ("ts_event", "client_order_id", "trade_id"),
        "positions": ("position_id",),
        "account": ("ts_event_ns", "account_id", "currency"),
    }[kind]
    seen: set[tuple[str, ...]] = set()
    previous: tuple[tuple[int, object], ...] | None = None
    for row in rows:
        key = tuple(str(row[field]) for field in primary_fields)
        if kind == "account":
            key = (*key, canonical_json_bytes(row).hex())
        if key in seen:
            raise ReportSchemaError(f"{kind} report contains a duplicate row identity")
        seen.add(key)
        ordering = tuple(_sort_value(row[field]) for field in schema.sort_keys)
        if kind == "account":
            ordering = (*ordering, _sort_value(canonical_json_bytes(row).hex()))
        if previous is not None and ordering < previous:
            raise ReportSchemaError(f"{kind} report rows are not in committed order")
        previous = ordering


def _sort_value(value: object) -> tuple[int, object]:
    if type(value) is str and value.isdecimal():
        return (0, int(value))
    if type(value) is int:
        return (0, value)
    if value is None:
        return (1, "")
    return (2, str(value))


def _manifest_projection(manifest: InputManifestV1) -> dict[str, object]:
    instruments = [item.model_dump(mode="json") for item in manifest.instruments]
    return {
        "projection_version": "EvidenceProjection.v1",
        "source_kind": "INPUT_MANIFEST",
        "content": {
            "environment": manifest.environment,
            "strategy": {
                "id": _bounded_value(manifest.strategy_id),
                "version": _bounded_value(manifest.strategy_version),
            },
            "engine": {
                "package_version": _bounded_value(manifest.engine_package_version),
                "tag_commit": _bounded_value(manifest.engine_tag_commit),
                "python_version": _bounded_value(manifest.python_version),
                "precision_mode": _bounded_value(manifest.precision_mode),
            },
            "fixture_id": _bounded_value(manifest.fixture_id),
            "catalog": {
                "revision": manifest.catalog_revision,
                "source_checksum": manifest.source_checksum,
                "catalog_checksum": manifest.catalog_checksum,
            },
            "instruments": _bounded_sequence(instruments),
            "data_types": _bounded_sequence(list(manifest.data_types)),
            "window": manifest.window.model_dump(mode="json"),
            "timezone": _bounded_value(manifest.timezone),
            "data_quality": {
                "ordering_result": manifest.ordering_result,
                "gaps": _bounded_sequence([item.model_dump(mode="json") for item in manifest.gaps]),
                "duplicates": _bounded_sequence(
                    [item.model_dump(mode="json") for item in manifest.duplicates]
                ),
            },
            "evaluation": _bounded_value(
                manifest.evaluation_protocol.model_dump(mode="json", by_alias=True)
            ),
            "information_set": _bounded_value(
                manifest.information_set_policy.model_dump(mode="json", by_alias=True)
            ),
            "cost": _bounded_value(manifest.cost_fill_model.model_dump(mode="json", by_alias=True)),
            "risk": {
                "policy_id": _bounded_value(manifest.risk_policy_id),
                "policy_version": _bounded_value(manifest.risk_policy_version),
                "policy_hash": manifest.risk_policy_hash,
            },
            "replay_seed": manifest.replay_seed,
        },
    }


def _run_record_projection(run_record: RunRecordV1) -> dict[str, object]:
    return {
        "projection_version": "EvidenceProjection.v1",
        "source_kind": "RUN_RECORD",
        "content": {
            "state": run_record.state.value,
            "state_version": run_record.state_version,
            "prepared_terminal_state": (
                None
                if run_record.prepared_terminal_state is None
                else run_record.prepared_terminal_state.value
            ),
            "prepared_terminal_state_version": run_record.prepared_terminal_state_version,
            "created_at_ns": run_record.created_at_ns,
            "started_at_ns": run_record.started_at_ns,
            "completed_at_ns": run_record.completed_at_ns,
            "duration_ns": run_record.duration_ns,
            "materialized_event_seq": run_record.materialized_event_seq,
            "materialized_audit_seq": run_record.materialized_audit_seq,
            "evidence_status": run_record.evidence_status,
        },
    }


def _runner_exit_projection(outcome: SupervisorExitV1) -> dict[str, object]:
    child = outcome.child_outcome
    return {
        "projection_version": "EvidenceProjection.v1",
        "source_kind": "RUNNER_EXIT",
        "content": {
            "classification": outcome.classification,
            "failure_code": outcome.failure_code,
            "exit_code": outcome.exit_code,
            "signal": outcome.signal,
            "duration_ns": outcome.duration_ns,
            "final_cancel_phase": outcome.final_cancel_phase,
            "stdout_size_bytes": outcome.stdout_size_bytes,
            "stderr_size_bytes": outcome.stderr_size_bytes,
            "stderr_sha256": outcome.stderr_sha256,
            "stderr_truncated": outcome.stderr_truncated,
            "proposed_terminal_state": outcome.proposed_terminal_state,
            "child_result": None if child is None else child.result,
            "child_failure_code": (
                None if child is None or child.failure is None else child.failure.code
            ),
            "last_source_seq": None if child is None else child.last_source_seq,
            "report_kinds": (
                [] if child is None else [item.name for item in child.report_candidates]
            ),
        },
    }


def _events_projection(
    events: tuple[tuple[PersistedEvent, EventEnvelopeV1, str], ...],
) -> tuple[dict[str, object], tuple[_PreparedEvent, ...]]:
    type_counts = Counter(persisted.type for persisted, _, _ in events)
    source_counts = Counter(str(persisted.source) for persisted, _, _ in events)
    selected_indexes: list[int] = []
    for event_type in _KNOWN_EVENT_TYPES:
        matches = [
            index for index, (persisted, _, _) in enumerate(events) if persisted.type == event_type
        ]
        if matches:
            selected_indexes.append(matches[0])
            selected_indexes.append(matches[-1])
    selected_indexes = sorted(set(selected_indexes))[:46]
    samples: list[_PreparedEvent] = []
    sample_summaries: list[dict[str, object]] = []
    for index in selected_indexes:
        persisted, envelope, digest = events[index]
        projection = _event_projection(envelope, digest=digest)
        projection_bytes = canonical_json_bytes(projection)
        if len(projection_bytes) > _EVENT_PROJECTION_MAX_BYTES:
            raise ValueError("Event projection exceeded its closed byte cap.")
        samples.append(_PreparedEvent(envelope_sha256=digest, projection_bytes=projection_bytes))
        sample_summaries.append(
            {
                "seq": persisted.seq,
                "type": persisted.type,
                "source": persisted.source,
                "envelope_sha256": digest,
                "projection_sha256": sha256(projection_bytes).hexdigest(),
            }
        )
    return (
        {
            "projection_version": "EvidenceProjection.v1",
            "source_kind": "EVENTS",
            "content": {
                "record_count": len(events),
                "sequence_range": {"first": events[0][0].seq, "last": events[-1][0].seq},
                "event_time_range_ns": {
                    "first": _bounded_value(events[0][0].ts_event_ns),
                    "last": _bounded_value(events[-1][0].ts_event_ns),
                },
                "type_counts": _bounded_counts(type_counts),
                "source_counts": _bounded_counts(source_counts),
                "samples": sample_summaries,
                "omitted_count": len(events) - len(samples),
            },
        },
        tuple(samples),
    )


def _event_projection(envelope: EventEnvelopeV1, *, digest: str) -> dict[str, object]:
    base: dict[str, object] = {
        "projection_version": "EventProjection.v1",
        "sequence": _bounded_value(envelope.seq),
        "source_sequence": _bounded_value(envelope.source_seq),
        "event_time_ns": _bounded_value(envelope.ts_event_ns),
        "ingest_time_ns": _bounded_value(envelope.ts_ingest_ns),
        "type": _bounded_value(envelope.type),
        "source": _bounded_value(envelope.source),
        "schema_version": _bounded_value(envelope.schema_version),
        "envelope_sha256": digest,
        "payload": _bounded_value(dict(envelope.payload)),
    }
    if len(canonical_json_bytes(base)) <= _EVENT_PROJECTION_MAX_BYTES:
        return base
    payload_bytes = canonical_json_bytes(_json_compatible(dict(envelope.payload)))
    base["payload"] = _digest_only(payload_bytes)
    if len(canonical_json_bytes(base)) > _EVENT_PROJECTION_MAX_BYTES:
        raise ValueError("Minimal event projection exceeded its closed byte cap.")
    return base


def _report_projection(kind: str, rows: list[dict[str, object]]) -> tuple[dict[str, object], int]:
    sample_indexes = _first_last_indexes(len(rows), edge=4)
    fields = _SAMPLE_FIELDS[kind]
    samples = [
        {field: _bounded_value(rows[index][field]) for field in fields} for index in sample_indexes
    ]
    aggregates: dict[str, object] = {"record_count": len(rows)}
    if kind == "orders":
        aggregates.update(
            {
                "status_counts": _bounded_counts(Counter(str(row["status"]) for row in rows)),
                "side_counts": _bounded_counts(Counter(str(row["side"]) for row in rows)),
                "type_counts": _bounded_counts(Counter(str(row["type"]) for row in rows)),
                "quantity_total": _bounded_value(_sum_decimal(rows, "quantity")),
                "filled_quantity_total": _bounded_value(_sum_decimal(rows, "filled_qty")),
            }
        )
    elif kind == "fills":
        aggregates.update(
            {
                "side_counts": _bounded_counts(Counter(str(row["order_side"]) for row in rows)),
                "type_counts": _bounded_counts(Counter(str(row["order_type"]) for row in rows)),
                "currency_counts": _bounded_counts(Counter(str(row["currency"]) for row in rows)),
                "liquidity_counts": _bounded_counts(
                    Counter(str(row["liquidity_side"]) for row in rows)
                ),
                "quantity_total": _bounded_value(_sum_decimal(rows, "last_qty")),
            }
        )
    elif kind == "positions":
        aggregates.update(
            {
                "side_counts": _bounded_counts(Counter(str(row["side"]) for row in rows)),
                "entry_counts": _bounded_counts(Counter(str(row["entry"]) for row in rows)),
                "closed_count": sum(row["ts_closed"] is not None for row in rows),
                "snapshot_count": sum(row["is_snapshot"] is True for row in rows),
                "quantity_total": _bounded_value(_sum_decimal(rows, "quantity")),
            }
        )
    else:
        aggregates.update(
            {
                "currency_counts": _bounded_counts(Counter(str(row["currency"]) for row in rows)),
                "account_type_counts": _bounded_counts(
                    Counter(str(row["account_type"]) for row in rows)
                ),
            }
        )
    projection: dict[str, object] = {
        "projection_version": "EvidenceProjection.v1",
        "source_kind": kind.upper(),
        "content": {
            "aggregates": aggregates,
            "samples": samples,
            "sample_count": len(samples),
            "omitted_count": len(rows) - len(samples),
        },
    }
    return _fit_projection(projection, kind.upper(), len(rows), len(samples))


def _metrics_projection(metrics: dict[str, object]) -> tuple[dict[str, object], int, int]:
    summary = cast(dict[str, str], metrics["summary"])
    performance = cast(dict[str, object] | None, metrics.get("performance_series"))
    points = [] if performance is None else cast(list[dict[str, object]], performance["points"])
    indexes = _metric_sample_indexes(points)
    samples = [_bounded_value(points[index]) for index in indexes]
    performance_projection: dict[str, object] | None
    if performance is None:
        performance_projection = None
    else:
        max_equity_index = max(
            range(len(points)), key=lambda index: Decimal(cast(str, points[index]["equity_amount"]))
        )
        max_drawdown_index = min(
            range(len(points)), key=lambda index: Decimal(cast(str, points[index]["drawdown_pct"]))
        )
        performance_projection = {
            "account_id": _bounded_value(performance["account_id"]),
            "currency": performance["currency"],
            "point_count": len(points),
            "first": _bounded_value(points[0]),
            "last": _bounded_value(points[-1]),
            "max_equity": _bounded_value(points[max_equity_index]),
            "max_drawdown": _bounded_value(points[max_drawdown_index]),
            "samples": samples,
            "sample_count": len(samples),
            "omitted_count": len(points) - len(samples),
        }
    projection: dict[str, object] = {
        "projection_version": "EvidenceProjection.v1",
        "source_kind": "METRICS",
        "content": {
            "summary": _bounded_mapping_entries(summary),
            "stats_pnls": _bounded_nested_metric_entries(
                cast(dict[str, object], metrics["stats_pnls"])
            ),
            "stats_returns": _bounded_mapping_entries(
                cast(dict[str, object], metrics["stats_returns"])
            ),
            "stats_general": _bounded_mapping_entries(
                cast(dict[str, object], metrics["stats_general"])
            ),
            "performance": performance_projection,
        },
    }
    fitted, fitted_samples = _fit_projection(projection, "METRICS", len(points), len(samples))
    return fitted, len(points), fitted_samples


def _source_from_projection(
    source_kind: SourceKind,
    raw: bytes,
    projection: dict[str, object],
    *,
    record_count: int,
    sample_count: int,
) -> _PreparedSource:
    projection, sample_count = _fit_projection(projection, source_kind, record_count, sample_count)
    projection_bytes = canonical_json_bytes(projection)
    coverage: Literal["FULL", "AGGREGATED_WITH_SAMPLES"] = (
        "FULL" if sample_count == record_count else "AGGREGATED_WITH_SAMPLES"
    )
    return _PreparedSource(
        source_kind=source_kind,
        available=True,
        raw_sha256=sha256(raw).hexdigest(),
        raw_size_bytes=len(raw),
        projection_bytes=projection_bytes,
        coverage=coverage,
        record_count=record_count,
        sample_count=sample_count,
        omitted_count=record_count - sample_count,
    )


def _missing_source(source_kind: SourceKind) -> _PreparedSource:
    projection_bytes = canonical_json_bytes(
        {
            "projection_version": "EvidenceProjection.v1",
            "source_kind": source_kind,
            "content": {"availability": "MISSING", "zero_inferred": False},
        }
    )
    return _PreparedSource(
        source_kind=source_kind,
        available=False,
        raw_sha256=None,
        raw_size_bytes=None,
        projection_bytes=projection_bytes,
        coverage="MISSING",
        record_count=0,
        sample_count=0,
        omitted_count=0,
    )


def _fit_projection(
    projection: dict[str, object],
    source_kind: str,
    record_count: int,
    sample_count: int,
) -> tuple[dict[str, object], int]:
    encoded = canonical_json_bytes(projection)
    if len(encoded) <= _ARTIFACT_EFFECTIVE_PROJECTION_MAX_BYTES:
        return projection, sample_count
    if source_kind == "METRICS":
        return _fit_metrics_projection(projection, sample_count)
    reduced: dict[str, object] = {
        "projection_version": "EvidenceProjection.v1",
        "source_kind": source_kind,
        "content": {
            "record_count": record_count,
            "bounded_projection": "DIGEST_ONLY",
            "full_projection": _digest_only(encoded),
            "sample_count": 0,
            "omitted_count": record_count,
        },
    }
    if len(canonical_json_bytes(reduced)) > _ARTIFACT_EFFECTIVE_PROJECTION_MAX_BYTES:
        raise ValueError("Minimal artifact projection exceeded its byte cap.")
    return reduced, 0


def _fit_metrics_projection(
    projection: dict[str, object], sample_count: int
) -> tuple[dict[str, object], int]:
    content = cast(dict[str, object], projection["content"])
    performance = cast(dict[str, object] | None, content["performance"])
    if performance is not None:
        samples = cast(list[object], performance["samples"])
        point_count = cast(int, performance["point_count"])
        while (
            samples
            and len(canonical_json_bytes(projection)) > _ARTIFACT_EFFECTIVE_PROJECTION_MAX_BYTES
        ):
            samples.pop()
            performance["sample_count"] = len(samples)
            performance["omitted_count"] = point_count - len(samples)
        sample_count = len(samples)

    for group_name in ("stats_pnls", "stats_returns", "stats_general"):
        group = cast(dict[str, object], content[group_name])
        entries = cast(list[object], group["entries"])
        entry_count = cast(int, group["entry_count"])
        while (
            entries
            and len(canonical_json_bytes(projection)) > _ARTIFACT_EFFECTIVE_PROJECTION_MAX_BYTES
        ):
            entries.pop()
            group["omitted_count"] = entry_count - len(entries)

    if len(canonical_json_bytes(projection)) > _ARTIFACT_EFFECTIVE_PROJECTION_MAX_BYTES:
        raise ValueError("Mandatory metrics projection exceeded its byte cap.")
    return projection, sample_count


def _semantic_values(
    *,
    role: _RunRole,
    events: tuple[tuple[PersistedEvent, EventEnvelopeV1, str], ...],
    reports: dict[str, list[dict[str, object]] | dict[str, object] | None],
) -> tuple[_SemanticValue, ...]:
    values: list[_SemanticValue] = [
        _SemanticValue(role, "TOTAL_EVENTS", str(len(events)), "COUNT", None, "EVENTS")
    ]
    orders = reports["orders"]
    if type(orders) is list:
        terminal_statuses = {
            "FILLED",
            "CANCELED",
            "REJECTED",
            "DENIED",
            "EXPIRED",
            "VOIDED",
        }
        closed = sum(str(row["status"]) in terminal_statuses for row in orders)
        values.extend(
            (
                _SemanticValue(role, "ORDERS_TOTAL", str(len(orders)), "COUNT", None, "ORDERS"),
                _SemanticValue(role, "ORDERS_CLOSED", str(closed), "COUNT", None, "ORDERS"),
            )
        )
    fills = reports["fills"]
    if type(fills) is list:
        values.append(_SemanticValue(role, "FILLS_TOTAL", str(len(fills)), "COUNT", None, "FILLS"))
    positions = reports["positions"]
    if type(positions) is list:
        closed_positions = sum(row["ts_closed"] is not None for row in positions)
        values.extend(
            (
                _SemanticValue(
                    role, "POSITIONS_TOTAL", str(len(positions)), "COUNT", None, "POSITIONS"
                ),
                _SemanticValue(
                    role,
                    "POSITIONS_CLOSED",
                    str(closed_positions),
                    "COUNT",
                    None,
                    "POSITIONS",
                ),
            )
        )
    metrics = reports["metrics"]
    if type(metrics) is dict:
        summary = cast(dict[str, str], metrics["summary"])
        values.append(
            _SemanticValue(role, "ITERATIONS", summary["iterations"], "COUNT", None, "METRICS")
        )
        performance = cast(dict[str, object] | None, metrics.get("performance_series"))
        if performance is not None:
            points = cast(list[dict[str, object]], performance["points"])
            currency = cast(str, performance["currency"])
            values.extend(
                (
                    _SemanticValue(
                        role,
                        "START_EQUITY",
                        cast(str, points[0]["equity_amount"]),
                        "ACCOUNT_CURRENCY",
                        currency,
                        "METRICS",
                    ),
                    _SemanticValue(
                        role,
                        "END_EQUITY",
                        cast(str, points[-1]["equity_amount"]),
                        "ACCOUNT_CURRENCY",
                        currency,
                        "METRICS",
                    ),
                )
            )
    semantic_order = {
        name: index
        for index, name in enumerate(
            (
                "ORDERS_TOTAL",
                "ORDERS_CLOSED",
                "FILLS_TOTAL",
                "POSITIONS_TOTAL",
                "POSITIONS_CLOSED",
                "TOTAL_EVENTS",
                "ITERATIONS",
                "START_EQUITY",
                "END_EQUITY",
            )
        )
    }
    return tuple(sorted(values, key=lambda item: semantic_order[item.semantic]))


def _build_statements(
    *,
    scope_id: str,
    runs: tuple[_PreparedRun, ...],
    values: tuple[ExactValueRef, ...],
    source_citation_ids: dict[tuple[str, str], str],
    scope_citation_id: str,
) -> tuple[StatementOption, ...]:
    statements: list[StatementOption] = []
    for run in runs:
        run_record_citation = source_citation_ids[(run.role, "RUN_RECORD")]
        statements.append(
            StatementOption(
                statement_id=_opaque_id(
                    "stmt_", "terminal-fact", scope_id, run.role, run.terminal_state
                ),
                scope_id=scope_id,
                section="OBSERVED_FACT",
                text=(
                    f"The {_role_label(run.role).lower()} run is a verified sealed "
                    f"BACKTEST run in terminal state {run.terminal_state}."
                ),
                citation_ids=(run_record_citation,),
                value_ref_ids=(),
                run_role=run.role,
            )
        )
        run_values = tuple(value for value in values if value.run_role == run.role)
        for value in run_values:
            statements.append(
                StatementOption(
                    statement_id=_opaque_id(
                        "stmt_", "observed-value", scope_id, run.role, value.semantic, value.value
                    ),
                    scope_id=scope_id,
                    section="OBSERVED_FACT",
                    text=_value_statement(run.role, value),
                    citation_ids=(value.citation_id,),
                    value_ref_ids=(value.value_ref_id,),
                    run_role=run.role,
                )
            )
        start = _find_semantic(run_values, "START_EQUITY")
        end = _find_semantic(run_values, "END_EQUITY")
        if start is not None and end is not None and Decimal(end.value) > Decimal(start.value):
            statements.append(
                StatementOption(
                    statement_id=_opaque_id(
                        "stmt_", "equity-higher", scope_id, run.role, start.value, end.value
                    ),
                    scope_id=scope_id,
                    section="INFERENCE",
                    text=(
                        f"The {_role_label(run.role).lower()} run's recorded end equity is "
                        "higher than its recorded start equity."
                    ),
                    citation_ids=(end.citation_id,),
                    value_ref_ids=(start.value_ref_id, end.value_ref_id),
                    run_role=run.role,
                )
            )
        statements.append(
            StatementOption(
                statement_id=_opaque_id("stmt_", "run-risk", scope_id, run.role),
                scope_id=scope_id,
                section="RISK",
                text=(
                    f"The {_role_label(run.role).lower()} fixture result does not establish "
                    "live-market performance."
                ),
                citation_ids=(scope_citation_id,),
                value_ref_ids=(),
                run_role=run.role,
            )
        )
    return tuple(statements[:256])


def _build_notices(
    *,
    scope_id: str,
    runs: tuple[_PreparedRun, ...],
    scope_citation_id: str,
) -> tuple[ReviewNotice, ...]:
    notices: list[ReviewNotice] = []
    for run in runs:
        for source_kind in run.missing_sources:
            text = (
                f"The {_role_label(run.role).lower()} {_source_label(source_kind)} is not present "
                "in the selected sealed evidence; no zero is inferred."
            )
            notices.append(
                ReviewNotice(
                    notice_id=_opaque_id(
                        "stmt_", "missing-evidence", scope_id, run.role, source_kind
                    ),
                    kind="MISSING_EVIDENCE",
                    text=text,
                    citation_ids=(scope_citation_id,),
                )
            )
    mandatory = (
        "Evidence is labelled LOCAL QA FIXTURE and is not live-market evidence.",
        "This review sees only the explicitly selected sealed evidence.",
        "The reviewer is read-only and has no execution capability.",
        "BACKTEST ONLY · LIVE NOT AVAILABLE IN V0.1; the reviewer has no live-market access.",
    )
    for index, text in enumerate(mandatory):
        notices.append(
            ReviewNotice(
                notice_id=_opaque_id("stmt_", "mandatory-limitation", scope_id, str(index)),
                kind="LIMITATION",
                text=text,
                citation_ids=(scope_citation_id,),
            )
        )
    return tuple(notices)


def _build_allowed_ratio_pairs(
    values: tuple[ExactValueRef, ...],
) -> tuple[tuple[str, str], ...]:
    by_key = {(value.run_role, value.semantic): value for value in values}
    pairs: list[tuple[str, str]] = []
    for role in _RUN_ROLES:
        for numerator_semantic, denominator_semantic in _SAME_RUN_RATIO_SEMANTICS:
            numerator = by_key.get((role, numerator_semantic))
            denominator = by_key.get((role, denominator_semantic))
            if (
                numerator is not None
                and denominator is not None
                and _ratio_compatible(numerator, denominator)
            ):
                pairs.append((numerator.value_ref_id, denominator.value_ref_id))
    for semantic in _CROSS_RUN_RATIO_SEMANTICS:
        numerator = by_key.get(("PRIMARY", semantic))
        denominator = by_key.get(("COMPARE", semantic))
        if (
            numerator is not None
            and denominator is not None
            and _ratio_compatible(numerator, denominator)
        ):
            pairs.append((numerator.value_ref_id, denominator.value_ref_id))
    return tuple(pairs)


def _ratio_compatible(numerator: ExactValueRef, denominator: ExactValueRef) -> bool:
    return numerator.unit == denominator.unit and numerator.currency == denominator.currency


def _authority_descriptor(
    snapshot: RunEvidenceSnapshot, publication: TerminalPublication
) -> dict[str, object]:
    return {
        "run_snapshot": _run_snapshot_descriptor(snapshot.run),
        "last_visible_seq": snapshot.last_visible_seq,
        "events": [_event_authority(event) for event in snapshot.events],
        "catalog_publication": _catalog_authority(snapshot.catalog_publication),
        "runner_outcome": _runner_outcome_authority(snapshot.runner_outcome),
        "terminal_preparation": _terminal_preparation_authority(snapshot.terminal_preparation),
        "terminal_publication": _terminal_publication_authority(publication),
    }


def _run_snapshot_descriptor(run: RunSnapshot) -> dict[str, object]:
    return {
        "run_id": run.run_id,
        "state": run.state.value,
        "state_version": run.state_version,
        "last_event_seq": run.last_event_seq,
        "last_audit_seq": run.last_audit_seq,
        "input_manifest_bytes": _optional_bytes_identity(run.input_manifest_bytes),
        "input_manifest_hash": run.input_manifest_hash,
        "catalog_revision": run.catalog_revision,
        "catalog_inventory_hash": run.catalog_inventory_hash,
        "created_at_ns": run.created_at_ns,
        "evidence_status": run.evidence_status,
    }


def _terminal_publication_authority(
    publication: TerminalPublication,
) -> dict[str, object]:
    return {
        "run_id": publication.run_id,
        "state": publication.state.value,
        "state_version": publication.state_version,
        "event": _event_authority(publication.event),
        "audit_intent": _audit_authority(publication.audit_intent),
        "seal_digest": publication.seal_digest,
        "published_at_ns": publication.published_at_ns,
        "materialized_event_seq": publication.materialized_event_seq,
        "materialized_audit_seq": publication.materialized_audit_seq,
    }


def _event_authority(event: PersistedEvent) -> dict[str, object]:
    return {
        "event_id": event.event_id,
        "run_id": event.run_id,
        "seq": event.seq,
        "source_seq": event.source_seq,
        "source": event.source,
        "type": event.type,
        "ts_event_ns": event.ts_event_ns,
        "ts_ingest_ns": event.ts_ingest_ns,
        "visible": event.visible,
        "envelope_bytes": _bytes_identity(event.envelope_bytes),
    }


def _audit_authority(intent: AuditIntent) -> dict[str, object]:
    return {
        "run_id": intent.run_id,
        "audit_seq": intent.audit_seq,
        "event_seq": intent.event_seq,
        "event_digest": intent.event_digest,
        "intent_bytes": _bytes_identity(intent.intent_bytes),
        "created_at_ns": intent.created_at_ns,
    }


def _catalog_authority(publication: CatalogPublication | None) -> object:
    if publication is None:
        return None
    return {
        "catalog_revision": publication.catalog_revision,
        "fixture_id": publication.fixture_id,
        "status": publication.status,
        "inventory_hash": publication.inventory_hash,
        "publication_bytes": _bytes_identity(publication.publication_bytes),
        "staging_identity": publication.staging_identity,
        "prepared_at_ns": publication.prepared_at_ns,
        "published_at_ns": publication.published_at_ns,
        "audit_intent_bytes": _optional_bytes_identity(publication.audit_intent_bytes),
    }


def _runner_outcome_authority(outcome: Any) -> object:
    if outcome is None:
        return None
    return {
        "schema_version": outcome.schema_version,
        "run_id": outcome.run_id,
        "outcome_bytes": _bytes_identity(outcome.outcome_bytes),
        "outcome_hash": outcome.outcome_hash,
        "recorded_at_ns": outcome.recorded_at_ns,
    }


def _terminal_preparation_authority(preparation: TerminalPreparation | None) -> object:
    if preparation is None:
        return None
    run_record_bytes = (
        None
        if preparation.run_record is None
        else canonical_json_bytes(preparation.run_record.model_dump(mode="json", by_alias=True))
    )
    return {
        "run_id": preparation.run_id,
        "outcome": _runner_outcome_authority(preparation.outcome),
        "run_record": _optional_bytes_identity(run_record_bytes),
        "terminal_state": preparation.terminal_state.value,
        "terminal_state_version": preparation.terminal_state_version,
        "event": _event_authority(preparation.event),
        "audit_intent": _audit_authority(preparation.audit_intent),
        "disposition": _enum_value(preparation.disposition),
        "initial_event_digest": preparation.initial_event_digest,
        "failure_attempt_count": preparation.failure_attempt_count,
        "last_failure_at_ns": preparation.last_failure_at_ns,
        "last_failure_stage": preparation.last_failure_stage,
        "conversion_fault_hash": preparation.conversion_fault_hash,
        "prepared_at_ns": preparation.prepared_at_ns,
        "converted_at_ns": preparation.converted_at_ns,
    }


def _enum_value(value: object) -> object:
    return value.value if isinstance(value, Enum) else value


def _bytes_identity(raw: bytes) -> dict[str, object]:
    return {"size_bytes": len(raw), "sha256": sha256(raw).hexdigest()}


def _optional_bytes_identity(raw: bytes | None) -> object:
    return None if raw is None else _bytes_identity(raw)


def _bounded_value(value: object) -> object:
    if value is None or type(value) is bool or type(value) is int:
        return value
    if isinstance(value, Enum):
        return _bounded_value(value.value)
    if type(value) is str:
        encoded = value.encode("utf-8")
        return value if len(encoded) <= _LONG_TEXT_MAX_BYTES else _digest_only(encoded)
    if isinstance(value, Mapping):
        entries: list[dict[str, object]] = []
        for key in sorted(value, key=str):
            entries.append(
                {
                    "key": _bounded_value(str(key)),
                    "value": _bounded_value(value[key]),
                }
            )
        if len(entries) <= 64:
            return {"entries": entries}
        full = canonical_json_bytes(_json_compatible(value))
        return {
            "entry_count": len(entries),
            "entries": entries[:32] + entries[-32:],
            "omitted_count": len(entries) - 64,
            "full_sha256": sha256(full).hexdigest(),
        }
    if isinstance(value, Collection) and not isinstance(value, Mapping | bytes | bytearray | str):
        return _bounded_sequence(list(value))
    if isinstance(value, Decimal):
        return _bounded_value(canonical_decimal_string(value))
    raise ValueError("Projection value is outside the JSON domain.")


def _json_compatible(value: object) -> object:
    if value is None or type(value) in {bool, int, str}:
        return value
    if isinstance(value, Enum):
        return _json_compatible(value.value)
    if isinstance(value, Decimal):
        return canonical_decimal_string(value)
    if isinstance(value, Mapping):
        return {str(key): _json_compatible(item) for key, item in value.items()}
    if isinstance(value, Collection) and not isinstance(value, Mapping | bytes | bytearray | str):
        return [_json_compatible(item) for item in value]
    raise ValueError("Value is outside the JSON domain.")


def _bounded_sequence(items: Sequence[object]) -> dict[str, object]:
    compatible = [_json_compatible(item) for item in items]
    indexes = _first_last_indexes(len(items), edge=4)
    return {
        "record_count": len(items),
        "samples": [_bounded_value(items[index]) for index in indexes],
        "sample_count": len(indexes),
        "omitted_count": len(items) - len(indexes),
        "full_sha256": sha256(canonical_json_bytes(compatible)).hexdigest(),
    }


def _bounded_counts(counter: Mapping[str, int]) -> dict[str, object]:
    entries = [
        {"value": _bounded_value(value), "count": counter[value]} for value in sorted(counter)
    ]
    encoded = canonical_json_bytes(entries)
    retained = entries if len(entries) <= 64 else entries[:32] + entries[-32:]
    return {
        "distinct_count": len(entries),
        "entries": retained,
        "omitted_count": len(entries) - len(retained),
        "full_sha256": sha256(encoded).hexdigest(),
    }


def _bounded_mapping_entries(values: Mapping[str, object]) -> dict[str, object]:
    entries = [
        {"key": _bounded_value(key), "value": _bounded_value(values[key])} for key in sorted(values)
    ]
    full = canonical_json_bytes(_json_compatible(values))
    retained = entries if len(entries) <= 64 else entries[:32] + entries[-32:]
    return {
        "entry_count": len(entries),
        "entries": retained,
        "omitted_count": len(entries) - len(retained),
        "full_sha256": sha256(full).hexdigest(),
    }


def _bounded_nested_metric_entries(values: Mapping[str, object]) -> dict[str, object]:
    entries = [
        {
            "key": _bounded_value(key),
            "values": _bounded_mapping_entries(cast(Mapping[str, object], values[key])),
        }
        for key in sorted(values)
    ]
    full = canonical_json_bytes(_json_compatible(values))
    retained = entries if len(entries) <= 16 else entries[:8] + entries[-8:]
    return {
        "entry_count": len(entries),
        "entries": retained,
        "omitted_count": len(entries) - len(retained),
        "full_sha256": sha256(full).hexdigest(),
    }


def _digest_only(raw: bytes) -> dict[str, object]:
    return {"kind": "DIGEST_ONLY", "utf8_bytes": len(raw), "sha256": sha256(raw).hexdigest()}


def _first_last_indexes(length: int, *, edge: int) -> list[int]:
    if length <= edge * 2:
        return list(range(length))
    return [*range(edge), *range(length - edge, length)]


def _metric_sample_indexes(points: list[dict[str, object]]) -> list[int]:
    if not points:
        return []
    indexes = {
        0,
        len(points) - 1,
        max(
            range(len(points)), key=lambda index: Decimal(cast(str, points[index]["equity_amount"]))
        ),
        min(
            range(len(points)), key=lambda index: Decimal(cast(str, points[index]["drawdown_pct"]))
        ),
    }
    return sorted(indexes)[:4]


def _sum_decimal(rows: list[dict[str, object]], field: str) -> str:
    components: list[tuple[int, tuple[int, ...], int]] = []
    for row in rows:
        sign, digits, exponent = Decimal(cast(str, row[field])).as_tuple()
        if not isinstance(exponent, int):
            raise ValueError("Report decimal aggregate must be finite.")
        components.append((sign, digits, exponent))
    if not components:
        return "0"

    common_exponent = min(exponent for _, _, exponent in components)
    total_coefficient = 0
    for sign, digits, exponent in components:
        coefficient = 0
        for digit in digits:
            coefficient = (coefficient * 10) + digit
        if sign:
            coefficient = -coefficient
        total_coefficient += coefficient * (10 ** (exponent - common_exponent))

    total_tuple = Decimal(total_coefficient).as_tuple()
    total = Decimal((total_tuple.sign, total_tuple.digits, common_exponent))
    return canonical_decimal_string(total)


def _opaque_id(prefix: str, domain: str, *parts: str) -> str:
    payload = canonical_json_bytes({"domain": domain, "parts": list(parts)})
    return f"{prefix}{sha256(payload).hexdigest()}"


def _ratio_context() -> Context:
    context = Context(prec=34, rounding=ROUND_HALF_EVEN)
    context.traps[DivisionByZero] = True
    context.traps[InvalidOperation] = True
    return context


def _source_label(source_kind: str) -> str:
    return source_kind.lower().replace("_", " ")


def _semantic_label(semantic: str) -> str:
    return semantic.lower().replace("_", " ")


def _role_label(role: str | None) -> str:
    if role == "PRIMARY":
        return "Primary"
    if role == "COMPARE":
        return "Compare"
    return "Cross-run"


def _value_statement(role: str, value: ExactValueRef) -> str:
    role_text = _role_label(role).lower()
    templates = {
        "ORDERS_TOTAL": f"The {role_text} sealed orders report records {value.value} orders.",
        "ORDERS_CLOSED": (
            f"The {role_text} sealed orders report records {value.value} closed orders."
        ),
        "FILLS_TOTAL": f"The {role_text} sealed fills report records {value.value} fills.",
        "POSITIONS_TOTAL": (
            f"The {role_text} sealed positions report records {value.value} positions."
        ),
        "POSITIONS_CLOSED": (
            f"The {role_text} sealed positions report records {value.value} closed positions."
        ),
        "TOTAL_EVENTS": f"The {role_text} sealed event log records {value.value} events.",
        "ITERATIONS": f"The {role_text} sealed metrics report records {value.value} iterations.",
        "START_EQUITY": (
            f"The {role_text} sealed performance series starts at {value.value} {value.currency}."
        ),
        "END_EQUITY": (
            f"The {role_text} sealed performance series ends at {value.value} {value.currency}."
        ),
    }
    return templates[value.semantic]


def _find_semantic(values: tuple[ExactValueRef, ...], semantic: str) -> ExactValueRef | None:
    for value in values:
        if value.semantic == semantic:
            return value
    return None


def _retained_size(scope: EvidenceScope) -> int:
    registry_bytes = scope.canonical_bytes()
    artifact_bytes = sum(len(record.projection_bytes) for record in scope._artifact_records)
    event_bytes = sum(len(record.projection_bytes) for record in scope._event_records)
    return len(registry_bytes) + artifact_bytes + event_bytes


def _validate_scope_caps(scope: EvidenceScope) -> None:
    if (
        len(scope.statement_options) > 256
        or len(scope.value_refs) > 256
        or len(scope.citations) > 128
        or len(scope.artifact_ids) > 18
        or len(scope.event_ids) > 92
        or scope.retained_size_bytes > _RETAINED_BUDGET_BYTES
    ):
        raise RunEvidenceIntegrityFailed("Retained evidence scope exceeded a closed cap.")
    for source in (item for run in scope.manifest.runs for item in run.sources):
        if source.projection_size_bytes > _ARTIFACT_PROJECTION_MAX_BYTES:
            raise RunEvidenceIntegrityFailed("Artifact projection exceeded its closed cap.")
    for artifact_id in scope.artifact_ids:
        scope.read_artifact(artifact_id)
    for event_id in scope.event_ids:
        scope.read_event(event_id)


__all__ = [
    "DeterministicRatioRejected",
    "EvidenceScope",
    "EvidenceScopeBuilder",
    "PRIVATE_ARTIFACT_PATHS",
    "RunEvidenceIntegrityFailed",
    "RunEvidenceUnsealed",
    "ScopeLookupError",
]
