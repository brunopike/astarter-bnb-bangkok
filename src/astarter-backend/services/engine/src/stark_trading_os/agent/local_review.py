"""Byte-stable local fallback rendered only from server-owned scope registries."""

from __future__ import annotations

from typing import Literal, Protocol

from stark_trading_os.agent.evidence_scope import DeterministicRatioRejected
from stark_trading_os.agent.models import (
    ExactValueRef,
    RatioCalculation,
    ReviewCitation,
    ReviewClaim,
    ReviewNotice,
    RunReviewResponse,
    StatementOption,
)

type LocalReviewStatus = Literal[
    "AI_REVIEW_NOT_CONFIGURED",
    "AI_REVIEW_REJECTED",
    "AI_REVIEW_UNAVAILABLE",
]

_LOCAL_STATUSES = frozenset(
    {
        "AI_REVIEW_NOT_CONFIGURED",
        "AI_REVIEW_REJECTED",
        "AI_REVIEW_UNAVAILABLE",
    }
)


class _LocalScope(Protocol):
    scope_id: str
    statement_options: tuple[StatementOption, ...]
    notices: tuple[ReviewNotice, ...]
    citations: tuple[ReviewCitation, ...]
    value_refs: tuple[ExactValueRef, ...]
    allowed_ratio_pairs: tuple[tuple[str, str], ...]

    def deterministic_ratio(
        self,
        numerator_value_ref_id: str,
        denominator_value_ref_id: str,
        *,
        tool_call_ordinal: int,
    ) -> RatioCalculation: ...

    def ratio_statement(self, calculation: RatioCalculation) -> StatementOption: ...

    def ratio_citation(self, calculation: RatioCalculation) -> ReviewCitation: ...

    def ratio_value_ref(self, calculation: RatioCalculation) -> ExactValueRef: ...


def build_local_review(
    scope: _LocalScope,
    *,
    status: LocalReviewStatus,
) -> RunReviewResponse:
    """Build one fixed-order fallback without consulting ambient state."""

    if status not in _LOCAL_STATUSES:
        raise ValueError("status must be one closed local fallback status.")

    facts = _section(scope.statement_options, "OBSERVED_FACT", limit=12)
    inferences = _section(scope.statement_options, "INFERENCE", limit=8)
    risks = _section(scope.statement_options, "RISK", limit=8)

    calculations: list[RatioCalculation] = []
    calculation_statements: list[StatementOption] = []
    calculation_citations: list[ReviewCitation] = []
    calculation_values: list[ExactValueRef] = []
    for ordinal, pair in enumerate(_selected_ratio_pairs(scope), start=1):
        try:
            calculation = scope.deterministic_ratio(pair[0], pair[1], tool_call_ordinal=ordinal)
        except DeterministicRatioRejected:
            continue
        calculations.append(calculation)
        calculation_statements.append(scope.ratio_statement(calculation))
        calculation_citations.append(scope.ratio_citation(calculation))
        calculation_values.append(scope.ratio_value_ref(calculation))

    ordered_claims = (
        *(_claim(statement) for statement in facts),
        *(
            _claim(statement, calculation_id=calculation.calculation_id)
            for statement, calculation in zip(calculation_statements, calculations, strict=True)
        ),
        *(_claim(statement) for statement in inferences),
        *(_claim(statement) for statement in risks),
    )
    claims = tuple(ordered_claims[:32])

    all_citations = (*scope.citations, *calculation_citations)
    all_values = (*scope.value_refs, *calculation_values)
    used_citations: set[str] = set()
    used_values: set[str] = set()
    for claim in claims:
        used_citations.update(claim.citation_ids)
        used_values.update(claim.value_ref_ids)
    for notice in scope.notices:
        used_citations.update(notice.citation_ids)

    changed = True
    while changed:
        before = (len(used_citations), len(used_values))
        for citation in all_citations:
            if citation.citation_id in used_citations:
                used_values.update(citation.value_ref_ids)
        for value in all_values:
            if value.value_ref_id in used_values:
                used_citations.add(value.citation_id)
        changed = before != (len(used_citations), len(used_values))

    citations = tuple(item for item in all_citations if item.citation_id in used_citations)
    values = tuple(item for item in all_values if item.value_ref_id in used_values)
    return RunReviewResponse(
        scope_id=scope.scope_id,
        mode="LOCAL_DETERMINISTIC",
        status=status,
        claims=claims,
        notices=scope.notices,
        citations=citations,
        value_refs=values,
    )


def _selected_ratio_pairs(scope: _LocalScope) -> tuple[tuple[str, str], ...]:
    if not any(value.run_role == "COMPARE" for value in scope.value_refs):
        return scope.allowed_ratio_pairs[:8]

    values_by_id = {value.value_ref_id: value for value in scope.value_refs}
    cross_run: list[tuple[str, str]] = []
    primary: list[tuple[str, str]] = []
    compare: list[tuple[str, str]] = []
    for pair in scope.allowed_ratio_pairs:
        numerator = values_by_id[pair[0]]
        denominator = values_by_id[pair[1]]
        roles = (numerator.run_role, denominator.run_role)
        if roles == ("PRIMARY", "COMPARE"):
            cross_run.append(pair)
        elif roles == ("PRIMARY", "PRIMARY"):
            primary.append(pair)
        elif roles == ("COMPARE", "COMPARE"):
            compare.append(pair)

    selected = cross_run[:4]
    balanced_count = min(len(primary), len(compare), (8 - len(selected)) // 2)
    for index in range(balanced_count):
        selected.extend((primary[index], compare[index]))
    selected.extend(cross_run[4 : 4 + (8 - len(selected))])
    return tuple(selected)


def _section(
    statements: tuple[StatementOption, ...],
    section: str,
    *,
    limit: int,
) -> tuple[StatementOption, ...]:
    return tuple(item for item in statements if item.section == section)[:limit]


def _claim(
    statement: StatementOption,
    *,
    calculation_id: str | None = None,
) -> ReviewClaim:
    return ReviewClaim(
        statement_id=statement.statement_id,
        section=statement.section,
        text=statement.text,
        citation_ids=statement.citation_ids,
        value_ref_ids=statement.value_ref_ids,
        calculation_id=calculation_id,
    )


__all__ = ["LocalReviewStatus", "build_local_review"]
