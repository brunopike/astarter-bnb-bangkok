from __future__ import annotations

import importlib
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Literal

import pytest

from stark_trading_os.agent.models import (
    ExactValueRef,
    RatioCalculation,
    ReviewCitation,
    ReviewNotice,
    StatementOption,
)
from stark_trading_os.audit.canonical_json import canonical_json_bytes


def _local_module() -> Any:
    return importlib.import_module("stark_trading_os.agent.local_review")


def _id(prefix: str, digit: str) -> str:
    return f"{prefix}{digit * 64}"


def _hashed_id(prefix: str, identity: str) -> str:
    return f"{prefix}{sha256(identity.encode()).hexdigest()}"


@dataclass(frozen=True)
class _MemoryScope:
    scope_id: str
    statement_options: tuple[StatementOption, ...]
    notices: tuple[ReviewNotice, ...]
    citations: tuple[ReviewCitation, ...]
    value_refs: tuple[ExactValueRef, ...]
    allowed_ratio_pairs: tuple[tuple[str, str], ...]
    calculation: RatioCalculation
    calculation_statement: StatementOption
    calculation_citation: ReviewCitation
    calculation_value: ExactValueRef

    def deterministic_ratio(
        self,
        numerator_value_ref_id: str,
        denominator_value_ref_id: str,
        *,
        tool_call_ordinal: int,
    ) -> RatioCalculation:
        assert (numerator_value_ref_id, denominator_value_ref_id) in self.allowed_ratio_pairs
        assert tool_call_ordinal == 1
        return self.calculation

    def ratio_statement(self, calculation: RatioCalculation) -> StatementOption:
        assert calculation == self.calculation
        return self.calculation_statement

    def ratio_citation(self, calculation: RatioCalculation) -> ReviewCitation:
        assert calculation == self.calculation
        return self.calculation_citation

    def ratio_value_ref(self, calculation: RatioCalculation) -> ExactValueRef:
        assert calculation == self.calculation
        return self.calculation_value


@dataclass(frozen=True)
class _ComparisonScope:
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
    ) -> RatioCalculation:
        pair = (numerator_value_ref_id, denominator_value_ref_id)
        assert pair in self.allowed_ratio_pairs
        identity = f"{tool_call_ordinal}:{numerator_value_ref_id}:{denominator_value_ref_id}"
        return RatioCalculation(
            calculation_id=_hashed_id("calc_", f"calculation:{identity}"),
            scope_id=self.scope_id,
            tool_call_ordinal=tool_call_ordinal,
            numerator_value_ref_id=numerator_value_ref_id,
            denominator_value_ref_id=denominator_value_ref_id,
            result="1",
            rule="DECIMAL34_HALF_EVEN_RATIO_V1",
            result_value_ref_id=_hashed_id("val_", f"result:{identity}"),
            citation_id=_hashed_id("cit_", f"calculation:{identity}"),
            statement_id=_hashed_id("stmt_", f"calculation:{identity}"),
        )

    def ratio_statement(self, calculation: RatioCalculation) -> StatementOption:
        numerator = self._value(calculation.numerator_value_ref_id)
        denominator = self._value(calculation.denominator_value_ref_id)
        role = numerator.run_role if numerator.run_role == denominator.run_role else None
        return StatementOption(
            statement_id=calculation.statement_id,
            scope_id=self.scope_id,
            section="DETERMINISTIC_CALCULATION",
            text=f"{numerator.semantic} divided by {denominator.semantic} is 1.",
            citation_ids=(calculation.citation_id,),
            value_ref_ids=(calculation.result_value_ref_id,),
            run_role=role,
        )

    def ratio_citation(self, calculation: RatioCalculation) -> ReviewCitation:
        numerator = self._value(calculation.numerator_value_ref_id)
        denominator = self._value(calculation.denominator_value_ref_id)
        role = numerator.run_role if numerator.run_role == denominator.run_role else None
        return ReviewCitation(
            citation_id=calculation.citation_id,
            scope_id=self.scope_id,
            kind="CALCULATION",
            run_role=role,
            source_kind=None,
            value_ref_ids=(numerator.value_ref_id, denominator.value_ref_id),
            label=f"Ratio of {numerator.semantic} over {denominator.semantic}",
        )

    def ratio_value_ref(self, calculation: RatioCalculation) -> ExactValueRef:
        numerator = self._value(calculation.numerator_value_ref_id)
        denominator = self._value(calculation.denominator_value_ref_id)
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

    def _value(self, value_ref_id: str) -> ExactValueRef:
        return next(value for value in self.value_refs if value.value_ref_id == value_ref_id)


def _comparison_scope() -> _ComparisonScope:
    scope_id = _hashed_id("scope_", "comparison-scope")
    semantics = (
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
    citations: list[ReviewCitation] = []
    values: list[ExactValueRef] = []
    by_key: dict[tuple[str, str], ExactValueRef] = {}
    for role in ("PRIMARY", "COMPARE"):
        citation_id = _hashed_id("cit_", f"source:{role}")
        citations.append(
            ReviewCitation(
                citation_id=citation_id,
                scope_id=scope_id,
                kind="ARTIFACT",
                run_role=role,
                source_kind="METRICS",
                artifact_id=_hashed_id("art_", f"source:{role}"),
                label=f"{role.title()} sealed source values",
            )
        )
        for semantic in semantics:
            unit: Literal["COUNT", "ACCOUNT_CURRENCY"] = (
                "ACCOUNT_CURRENCY" if semantic in {"START_EQUITY", "END_EQUITY"} else "COUNT"
            )
            value = ExactValueRef(
                value_ref_id=_hashed_id("val_", f"source:{role}:{semantic}"),
                scope_id=scope_id,
                run_role=role,
                semantic=semantic,
                value="1",
                unit=unit,
                currency="USDT" if unit == "ACCOUNT_CURRENCY" else None,
                citation_id=citation_id,
                origin="SOURCE",
            )
            values.append(value)
            by_key[(role, semantic)] = value

    same_run_semantics = (
        ("ORDERS_CLOSED", "ORDERS_TOTAL"),
        ("FILLS_TOTAL", "ORDERS_TOTAL"),
        ("POSITIONS_CLOSED", "POSITIONS_TOTAL"),
        ("END_EQUITY", "START_EQUITY"),
    )
    pairs: list[tuple[str, str]] = []
    for role in ("PRIMARY", "COMPARE"):
        pairs.extend(
            (by_key[(role, numerator)].value_ref_id, by_key[(role, denominator)].value_ref_id)
            for numerator, denominator in same_run_semantics
        )
    pairs.extend(
        (by_key[("PRIMARY", semantic)].value_ref_id, by_key[("COMPARE", semantic)].value_ref_id)
        for semantic in semantics
    )
    return _ComparisonScope(
        scope_id=scope_id,
        statement_options=(),
        notices=(),
        citations=tuple(citations),
        value_refs=tuple(values),
        allowed_ratio_pairs=tuple(pairs),
    )


def _scope() -> _MemoryScope:
    scope_id = _id("scope_", "a")
    artifact_id = _id("art_", "b")
    artifact_citation_id = _id("cit_", "1")
    scope_citation_id = _id("cit_", "2")
    calculation_citation_id = _id("cit_", "3")
    unused_citation_id = _id("cit_", "4")
    start_ref_id = _id("val_", "1")
    end_ref_id = _id("val_", "2")
    result_ref_id = _id("val_", "3")
    unused_ref_id = _id("val_", "4")
    artifact_citation = ReviewCitation(
        citation_id=artifact_citation_id,
        scope_id=scope_id,
        kind="ARTIFACT",
        run_role="PRIMARY",
        source_kind="METRICS",
        artifact_id=artifact_id,
        label="Primary sealed metrics projection",
    )
    scope_citation = ReviewCitation(
        citation_id=scope_citation_id,
        scope_id=scope_id,
        kind="SCOPE_ATTESTATION",
        run_role=None,
        source_kind=None,
        label="Selected sealed evidence scope",
    )
    start = ExactValueRef(
        value_ref_id=start_ref_id,
        scope_id=scope_id,
        run_role="PRIMARY",
        semantic="START_EQUITY",
        value="100",
        unit="ACCOUNT_CURRENCY",
        currency="USDT",
        citation_id=artifact_citation_id,
        origin="SOURCE",
    )
    end = start.model_copy(
        update={"value_ref_id": end_ref_id, "semantic": "END_EQUITY", "value": "110"}
    )
    result = ExactValueRef(
        value_ref_id=result_ref_id,
        scope_id=scope_id,
        run_role="PRIMARY",
        semantic="END_EQUITY_OVER_START_EQUITY",
        value="1.1",
        unit="RATIO",
        currency=None,
        citation_id=calculation_citation_id,
        origin="CALCULATION",
    )
    calculation_citation = ReviewCitation(
        citation_id=calculation_citation_id,
        scope_id=scope_id,
        kind="CALCULATION",
        run_role="PRIMARY",
        source_kind=None,
        value_ref_ids=(end_ref_id, start_ref_id),
        label="Decimal34 ratio of primary end equity over start equity",
    )
    calculation = RatioCalculation(
        calculation_id=_id("calc_", "1"),
        scope_id=scope_id,
        tool_call_ordinal=1,
        numerator_value_ref_id=end_ref_id,
        denominator_value_ref_id=start_ref_id,
        result="1.1",
        rule="DECIMAL34_HALF_EVEN_RATIO_V1",
        result_value_ref_id=result_ref_id,
        citation_id=calculation_citation_id,
        statement_id=_id("stmt_", "2"),
    )
    statements = (
        StatementOption(
            statement_id=_id("stmt_", "1"),
            scope_id=scope_id,
            section="OBSERVED_FACT",
            text="The primary run is a verified sealed BACKTEST run.",
            citation_ids=(artifact_citation_id,),
            value_ref_ids=(end_ref_id,),
            run_role="PRIMARY",
        ),
        StatementOption(
            statement_id=_id("stmt_", "3"),
            scope_id=scope_id,
            section="INFERENCE",
            text="The recorded end equity is higher than the recorded start equity.",
            citation_ids=(artifact_citation_id,),
            value_ref_ids=(start_ref_id, end_ref_id),
            run_role="PRIMARY",
        ),
        StatementOption(
            statement_id=_id("stmt_", "4"),
            scope_id=scope_id,
            section="RISK",
            text="Fixture results do not establish live-market performance.",
            citation_ids=(scope_citation_id,),
            value_ref_ids=(),
            run_role="PRIMARY",
        ),
    )
    calculation_statement = StatementOption(
        statement_id=calculation.statement_id,
        scope_id=scope_id,
        section="DETERMINISTIC_CALCULATION",
        text="Primary end equity divided by start equity is 1.1 (decimal34 half-even).",
        citation_ids=(calculation_citation_id,),
        value_ref_ids=(result_ref_id,),
        run_role="PRIMARY",
    )
    notices = (
        ReviewNotice(
            notice_id=_id("stmt_", "5"),
            kind="MISSING_EVIDENCE",
            text=(
                "The fills report is not present in the selected sealed evidence; "
                "no zero is inferred."
            ),
            citation_ids=(scope_citation_id,),
        ),
        ReviewNotice(
            notice_id=_id("stmt_", "6"),
            kind="LIMITATION",
            text="Evidence is labelled LOCAL QA FIXTURE and is not live-market evidence.",
            citation_ids=(scope_citation_id,),
        ),
        ReviewNotice(
            notice_id=_id("stmt_", "7"),
            kind="LIMITATION",
            text="This review sees only the explicitly selected sealed evidence.",
            citation_ids=(scope_citation_id,),
        ),
        ReviewNotice(
            notice_id=_id("stmt_", "8"),
            kind="LIMITATION",
            text="The reviewer is read-only and has no execution capability.",
            citation_ids=(scope_citation_id,),
        ),
        ReviewNotice(
            notice_id=_id("stmt_", "a"),
            kind="LIMITATION",
            text=(
                "BACKTEST ONLY · LIVE NOT AVAILABLE IN V0.1; "
                "the reviewer has no live-market access."
            ),
            citation_ids=(scope_citation_id,),
        ),
    )
    unused_citation = ReviewCitation(
        citation_id=unused_citation_id,
        scope_id=scope_id,
        kind="ARTIFACT",
        run_role="PRIMARY",
        source_kind="ACCOUNT",
        artifact_id=_id("art_", "c"),
        label="Unused account projection",
    )
    unused_value = ExactValueRef(
        value_ref_id=unused_ref_id,
        scope_id=scope_id,
        run_role="PRIMARY",
        semantic="ITERATIONS",
        value="2",
        unit="COUNT",
        currency=None,
        citation_id=unused_citation_id,
        origin="SOURCE",
    )
    return _MemoryScope(
        scope_id=scope_id,
        statement_options=statements,
        notices=notices,
        citations=(artifact_citation, scope_citation, unused_citation),
        value_refs=(start, end, unused_value),
        allowed_ratio_pairs=((end_ref_id, start_ref_id),),
        calculation=calculation,
        calculation_statement=calculation_statement,
        calculation_citation=calculation_citation,
        calculation_value=result,
    )


@pytest.mark.parametrize(
    "status",
    [
        "AI_REVIEW_NOT_CONFIGURED",
        "AI_REVIEW_REJECTED",
        "AI_REVIEW_UNAVAILABLE",
    ],
)
def test_local_review_is_fixed_order_byte_stable_and_uses_only_reachable_entries(
    status: str,
) -> None:
    module = _local_module()
    scope = _scope()

    first = module.build_local_review(scope, status=status)
    second = module.build_local_review(scope, status=status)

    assert first == second
    assert canonical_json_bytes(
        {"review_response": first.model_dump(mode="json")}
    ) == canonical_json_bytes({"review_response": second.model_dump(mode="json")})
    assert first.mode == "LOCAL_DETERMINISTIC"
    assert first.status == status
    assert tuple(claim.section for claim in first.claims) == (
        "OBSERVED_FACT",
        "DETERMINISTIC_CALCULATION",
        "INFERENCE",
        "RISK",
    )
    assert first.claims[1].calculation_id == scope.calculation.calculation_id
    assert {item.citation_id for item in first.citations} == {
        _id("cit_", "1"),
        _id("cit_", "2"),
        _id("cit_", "3"),
    }
    assert {item.value_ref_id for item in first.value_refs} == {
        _id("val_", "1"),
        _id("val_", "2"),
        _id("val_", "3"),
    }


def test_compare_review_selects_cross_run_ratios_then_balanced_same_run_pairs() -> None:
    module = _local_module()
    scope = _comparison_scope()
    assert len(scope.allowed_ratio_pairs) == 17

    first = module.build_local_review(scope, status="AI_REVIEW_NOT_CONFIGURED")
    second = module.build_local_review(scope, status="AI_REVIEW_NOT_CONFIGURED")

    first_bytes = canonical_json_bytes({"review_response": first.model_dump(mode="json")})
    second_bytes = canonical_json_bytes({"review_response": second.model_dump(mode="json")})
    assert first == second
    assert first_bytes == second_bytes
    calculation_citations = tuple(
        citation for citation in first.citations if citation.kind == "CALCULATION"
    )
    values_by_id = {value.value_ref_id: value for value in scope.value_refs}
    selected = tuple(
        (
            values_by_id[citation.value_ref_ids[0]].run_role,
            values_by_id[citation.value_ref_ids[1]].run_role,
            values_by_id[citation.value_ref_ids[0]].semantic,
            values_by_id[citation.value_ref_ids[1]].semantic,
        )
        for citation in calculation_citations
    )
    assert selected == (
        ("PRIMARY", "COMPARE", "ORDERS_TOTAL", "ORDERS_TOTAL"),
        ("PRIMARY", "COMPARE", "ORDERS_CLOSED", "ORDERS_CLOSED"),
        ("PRIMARY", "COMPARE", "FILLS_TOTAL", "FILLS_TOTAL"),
        ("PRIMARY", "COMPARE", "POSITIONS_TOTAL", "POSITIONS_TOTAL"),
        ("PRIMARY", "PRIMARY", "ORDERS_CLOSED", "ORDERS_TOTAL"),
        ("COMPARE", "COMPARE", "ORDERS_CLOSED", "ORDERS_TOTAL"),
        ("PRIMARY", "PRIMARY", "FILLS_TOTAL", "ORDERS_TOTAL"),
        ("COMPARE", "COMPARE", "FILLS_TOTAL", "ORDERS_TOTAL"),
    )
    same_run_roles = [
        numerator_role
        for numerator_role, denominator_role, *_ in selected
        if numerator_role == denominator_role
    ]
    assert same_run_roles.count("PRIMARY") == same_run_roles.count("COMPARE") == 2
    assert len(first.claims) == 8
    assert all(claim.section == "DETERMINISTIC_CALCULATION" for claim in first.claims)
    assert sum(value.origin == "CALCULATION" for value in first.value_refs) == 8
    assert len(first.claims) <= 32
    assert len(first.citations) <= 128
    assert len(first.value_refs) <= 264
    assert len(first_bytes) <= 65_536


def test_local_review_preserves_missing_not_zero_and_all_mandatory_limitations() -> None:
    response = _local_module().build_local_review(
        _scope(),
        status="AI_REVIEW_NOT_CONFIGURED",
    )
    notice_text = "\n".join(notice.text for notice in response.notices)

    assert "not present" in notice_text
    assert "no zero is inferred" in notice_text
    assert "LOCAL QA FIXTURE" in notice_text
    assert "only the explicitly selected sealed evidence" in notice_text
    assert "read-only" in notice_text
    assert "no execution" in notice_text
    assert "BACKTEST ONLY · LIVE NOT AVAILABLE IN V0.1" in notice_text
    assert "no live-market access" in notice_text


def test_local_review_rejects_non_local_status_without_reading_ambient_state() -> None:
    module = _local_module()

    with pytest.raises(ValueError, match="local fallback status"):
        module.build_local_review(_scope(), status="COMPLETE")
