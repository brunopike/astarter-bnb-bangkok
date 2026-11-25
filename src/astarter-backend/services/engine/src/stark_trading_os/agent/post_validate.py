"""Fresh-scope validation and deterministic rendering of provider selections."""

from __future__ import annotations

from pydantic import ValidationError

from stark_trading_os.agent.evidence_scope import (
    DeterministicRatioRejected,
    EvidenceScope,
)
from stark_trading_os.agent.models import (
    ExactValueRef,
    RatioCalculation,
    ReviewCitation,
    ReviewClaim,
    ReviewNotice,
    RunReviewResponse,
    StatementOption,
)
from stark_trading_os.agent.openai_review import ReviewContractRejected, ReviewProposal


def validate_candidate(
    original_scope: EvidenceScope,
    fresh_scope: EvidenceScope,
    proposal: ReviewProposal,
) -> RunReviewResponse:
    """Revalidate, recompute, and render exclusively from the fresh server scope."""

    if type(original_scope) is not EvidenceScope or type(fresh_scope) is not EvidenceScope:
        raise ReviewContractRejected("candidate validation requires exact evidence scopes")
    if (
        original_scope.scope_id != fresh_scope.scope_id
        or original_scope.canonical_bytes() != fresh_scope.canonical_bytes()
        or original_scope != fresh_scope
    ):
        raise ReviewContractRejected("fresh evidence scope differs from the original scope")
    checked = _revalidate_proposal(proposal)
    candidate = checked.candidate
    if candidate.scope_id != fresh_scope.scope_id:
        raise ReviewContractRejected("candidate belongs to another evidence scope")

    recomputed = _recompute_complete_ledger(fresh_scope, checked.ratio_ledger)
    statements = _statement_registry(fresh_scope)
    _require_statement_section(candidate.observed_fact_ids, "OBSERVED_FACT", statements)
    _require_statement_section(candidate.inference_ids, "INFERENCE", statements)
    _require_statement_section(candidate.risk_ids, "RISK", statements)

    calculations = {item.calculation_id: item for item in recomputed}
    if (
        len(calculations) != len(recomputed)
        or not set(candidate.calculation_ids) <= calculations.keys()
    ):
        raise ReviewContractRejected("candidate selected an unavailable deterministic calculation")

    fact_ids = set(candidate.observed_fact_ids)
    calculation_ids = set(candidate.calculation_ids)
    inference_ids = set(candidate.inference_ids)
    risk_ids = set(candidate.risk_ids)
    facts = tuple(
        item
        for item in fresh_scope.statement_options
        if item.section == "OBSERVED_FACT" and item.statement_id in fact_ids
    )
    selected_calculations = tuple(
        item for item in recomputed if item.calculation_id in calculation_ids
    )
    calculation_statements = tuple(
        fresh_scope.ratio_statement(item) for item in selected_calculations
    )
    inferences = tuple(
        item
        for item in fresh_scope.statement_options
        if item.section == "INFERENCE" and item.statement_id in inference_ids
    )
    risks = tuple(
        item
        for item in fresh_scope.statement_options
        if item.section == "RISK" and item.statement_id in risk_ids
    )
    claims = (
        *(_claim(item) for item in facts),
        *(
            _claim(statement, calculation_id=calculation.calculation_id)
            for statement, calculation in zip(
                calculation_statements,
                selected_calculations,
                strict=True,
            )
        ),
        *(_claim(item) for item in inferences),
        *(_claim(item) for item in risks),
    )
    if not 1 <= len(claims) <= 32:
        raise ReviewContractRejected("candidate rendered an invalid claim count")

    calculation_citations = tuple(
        fresh_scope.ratio_citation(item) for item in selected_calculations
    )
    calculation_values = tuple(fresh_scope.ratio_value_ref(item) for item in selected_calculations)
    citations, values = _reachable_registries(
        claims=claims,
        notices=fresh_scope.notices,
        citations=(*fresh_scope.citations, *calculation_citations),
        values=(*fresh_scope.value_refs, *calculation_values),
    )
    try:
        return RunReviewResponse(
            scope_id=fresh_scope.scope_id,
            mode="OPENAI_AGENT",
            status="COMPLETE",
            claims=claims,
            notices=fresh_scope.notices,
            citations=citations,
            value_refs=values,
        )
    except ValidationError as error:
        raise ReviewContractRejected(
            "server rendering violated the closed response contract"
        ) from error


def _revalidate_proposal(proposal: ReviewProposal) -> ReviewProposal:
    if type(proposal) is not ReviewProposal:
        raise ReviewContractRejected("candidate validator requires one exact review proposal")
    checked = ReviewProposal(
        candidate=proposal.candidate,
        ratio_ledger=proposal.ratio_ledger,
        tool_call_count=proposal.tool_call_count,
    )
    if checked != proposal:
        raise ReviewContractRejected("review proposal differs after exact revalidation")
    return checked


def _recompute_complete_ledger(
    scope: EvidenceScope,
    ledger: tuple[RatioCalculation, ...],
) -> tuple[RatioCalculation, ...]:
    recomputed: list[RatioCalculation] = []
    for recorded in ledger:
        try:
            current = scope.deterministic_ratio(
                recorded.numerator_value_ref_id,
                recorded.denominator_value_ref_id,
                tool_call_ordinal=recorded.tool_call_ordinal,
            )
        except DeterministicRatioRejected as error:
            if type(error) is not DeterministicRatioRejected:
                raise
            raise ReviewContractRejected(
                "ratio ledger is incompatible with the fresh evidence scope"
            ) from error
        if current != recorded:
            raise ReviewContractRejected("ratio ledger differs from fresh recomputation")
        recomputed.append(current)
    return tuple(recomputed)


def _statement_registry(scope: EvidenceScope) -> dict[str, StatementOption]:
    registry = {item.statement_id: item for item in scope.statement_options}
    if len(registry) != len(scope.statement_options):
        raise ReviewContractRejected("fresh statement registry contains duplicate identities")
    return registry


def _require_statement_section(
    statement_ids: tuple[str, ...],
    section: str,
    statements: dict[str, StatementOption],
) -> None:
    for statement_id in statement_ids:
        statement = statements.get(statement_id)
        if statement is None or statement.section != section:
            raise ReviewContractRejected("candidate selected an unknown or wrong-section statement")


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


def _reachable_registries(
    *,
    claims: tuple[ReviewClaim, ...],
    notices: tuple[ReviewNotice, ...],
    citations: tuple[ReviewCitation, ...],
    values: tuple[ExactValueRef, ...],
) -> tuple[tuple[ReviewCitation, ...], tuple[ExactValueRef, ...]]:
    citation_ids = [item.citation_id for item in citations]
    value_ids = [item.value_ref_id for item in values]
    if len(set(citation_ids)) != len(citation_ids) or len(set(value_ids)) != len(value_ids):
        raise ReviewContractRejected("server registries contain duplicate identities")

    used_citations: set[str] = set()
    used_values: set[str] = set()
    for claim in claims:
        used_citations.update(claim.citation_ids)
        used_values.update(claim.value_ref_ids)
    for notice in notices:
        used_citations.update(notice.citation_ids)

    changed = True
    while changed:
        before = (len(used_citations), len(used_values))
        for citation in citations:
            if citation.citation_id in used_citations:
                used_values.update(citation.value_ref_ids)
        for value in values:
            if value.value_ref_id in used_values:
                used_citations.add(value.citation_id)
        changed = before != (len(used_citations), len(used_values))
    if not used_citations <= set(citation_ids) or not used_values <= set(value_ids):
        raise ReviewContractRejected("rendered response contains an unresolved server reference")
    return (
        tuple(item for item in citations if item.citation_id in used_citations),
        tuple(item for item in values if item.value_ref_id in used_values),
    )


__all__ = ["validate_candidate"]
