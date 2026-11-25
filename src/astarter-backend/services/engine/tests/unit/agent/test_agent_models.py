from __future__ import annotations

import importlib
from typing import Any

import pytest
from pydantic import ValidationError


def _models() -> Any:
    return importlib.import_module("stark_trading_os.agent.models")


def _id(prefix: str, digit: str) -> str:
    return f"{prefix}{digit * 64}"


def test_review_request_is_closed_frozen_unicode_bounded_and_secret_safe() -> None:
    models = _models()
    astral_question = "\U0001f600" * 2_000

    request = models.RunReviewRequest(run_id="bt_primary", question=astral_question)
    compared = models.RunReviewRequest(
        run_id="bt_primary",
        compare_run_id="bt_compare",
        question="Compare the sealed runs",
    )

    assert request.compare_run_id is None
    assert compared.compare_run_id == "bt_compare"
    assert len(astral_question) == 2_000
    assert len(astral_question.encode("utf-8")) == 8_000
    assert 2_000 * 4 <= 8_192
    assert astral_question not in repr(request)
    assert astral_question not in str(request)
    with pytest.raises(ValidationError):
        models.RunReviewRequest(run_id="bt_primary", question="ok", surprise=True)
    with pytest.raises(ValidationError):
        models.RunReviewRequest(
            run_id="bt_primary",
            compare_run_id="bt_primary",
            question="Compare",
        )
    with pytest.raises(ValidationError):
        request.question = "changed"


def test_model_tuples_detach_from_caller_owned_mutable_collections() -> None:
    models = _models()
    observed = [_id("stmt_", "1")]

    candidate = models.CandidateReview(
        scope_id=_id("scope_", "a"),
        observed_fact_ids=observed,
    )
    observed.append(_id("stmt_", "2"))

    assert candidate.observed_fact_ids == (_id("stmt_", "1"),)
    assert isinstance(candidate.observed_fact_ids, tuple)


@pytest.mark.parametrize(
    "question",
    [
        "",
        "   \t",
        "contains\x00control",
        "\ud800",
        "a" * 2_001,
    ],
)
def test_review_request_rejects_invalid_question_text(question: str) -> None:
    models = _models()

    with pytest.raises(ValidationError):
        models.RunReviewRequest(run_id="bt_primary", question=question)


def test_candidate_review_accepts_only_bounded_unique_closed_ids() -> None:
    models = _models()
    candidate = models.CandidateReview(
        scope_id=_id("scope_", "a"),
        observed_fact_ids=(_id("stmt_", "1"),),
        calculation_ids=(_id("calc_", "2"),),
        inference_ids=(_id("stmt_", "3"),),
        risk_ids=(_id("stmt_", "4"),),
    )

    assert tuple(candidate.model_fields_set) != ()
    assert set(candidate.model_dump()) == {
        "scope_id",
        "observed_fact_ids",
        "calculation_ids",
        "inference_ids",
        "risk_ids",
    }
    with pytest.raises(ValidationError):
        models.CandidateReview(
            scope_id=_id("scope_", "a"),
            observed_fact_ids=(),
        )
    with pytest.raises(ValidationError):
        models.CandidateReview(
            scope_id=_id("scope_", "a"),
            observed_fact_ids=tuple(_id("stmt_", f"{index:x}") for index in range(13)),
        )
    duplicate = _id("stmt_", "b")
    with pytest.raises(ValidationError):
        models.CandidateReview(
            scope_id=_id("scope_", "a"),
            observed_fact_ids=(duplicate,),
            inference_ids=(duplicate,),
        )
    with pytest.raises(ValidationError):
        models.CandidateReview(
            scope_id=_id("scope_", "a"),
            observed_fact_ids=(_id("art_", "1"),),
        )
    with pytest.raises(ValidationError):
        models.CandidateReview(
            scope_id=_id("scope_", "a"),
            observed_fact_ids=(_id("stmt_", "1"),),
            text="model-authored prose is forbidden",
        )


def _valid_response(models: Any, *, mode: str, status: str) -> Any:
    scope_id = _id("scope_", "a")
    artifact_id = _id("art_", "b")
    citation_id = _id("cit_", "c")
    value_ref_id = _id("val_", "d")
    statement_id = _id("stmt_", "e")
    return models.RunReviewResponse(
        scope_id=scope_id,
        mode=mode,
        status=status,
        claims=(
            models.ReviewClaim(
                statement_id=statement_id,
                section="OBSERVED_FACT",
                text="The primary sealed run contains 2 recorded events.",
                citation_ids=(citation_id,),
                value_ref_ids=(value_ref_id,),
            ),
        ),
        notices=(),
        citations=(
            models.ReviewCitation(
                citation_id=citation_id,
                scope_id=scope_id,
                kind="ARTIFACT",
                run_role="PRIMARY",
                source_kind="EVENTS",
                artifact_id=artifact_id,
                label="Primary sealed events projection",
            ),
        ),
        value_refs=(
            models.ExactValueRef(
                value_ref_id=value_ref_id,
                scope_id=scope_id,
                run_role="PRIMARY",
                semantic="TOTAL_EVENTS",
                value="2",
                unit="COUNT",
                currency=None,
                citation_id=citation_id,
                origin="SOURCE",
            ),
        ),
    )


@pytest.mark.parametrize(
    ("mode", "status"),
    [
        ("LOCAL_DETERMINISTIC", "AI_REVIEW_NOT_CONFIGURED"),
        ("LOCAL_DETERMINISTIC", "AI_REVIEW_REJECTED"),
        ("LOCAL_DETERMINISTIC", "AI_REVIEW_UNAVAILABLE"),
        ("OPENAI_AGENT", "COMPLETE"),
    ],
)
def test_review_response_accepts_only_the_four_legal_mode_status_pairs(
    mode: str,
    status: str,
) -> None:
    models = _models()

    response = _valid_response(models, mode=mode, status=status)

    assert response.mode == mode
    assert response.status == status


@pytest.mark.parametrize(
    ("mode", "status"),
    [
        ("LOCAL_DETERMINISTIC", "COMPLETE"),
        ("OPENAI_AGENT", "AI_REVIEW_UNAVAILABLE"),
    ],
)
def test_review_response_rejects_illegal_mode_status_pairs(mode: str, status: str) -> None:
    models = _models()

    with pytest.raises(ValidationError):
        _valid_response(models, mode=mode, status=status)


def test_review_response_requires_closed_reachable_and_used_registries() -> None:
    models = _models()
    response = _valid_response(
        models,
        mode="LOCAL_DETERMINISTIC",
        status="AI_REVIEW_NOT_CONFIGURED",
    )
    unknown_citation = _id("cit_", "f")
    unused_value = response.value_refs[0].model_copy(update={"value_ref_id": _id("val_", "f")})

    with pytest.raises(ValidationError):
        models.RunReviewResponse.model_validate(
            {
                **response.model_dump(),
                "claims": [
                    {
                        **response.claims[0].model_dump(),
                        "citation_ids": [unknown_citation],
                    }
                ],
            }
        )
    with pytest.raises(ValidationError):
        models.RunReviewResponse.model_validate(
            {
                **response.model_dump(),
                "value_refs": [
                    response.value_refs[0].model_dump(),
                    unused_value.model_dump(),
                ],
            }
        )
    with pytest.raises(ValidationError):
        models.RunReviewResponse.model_validate(
            {
                **response.model_dump(),
                "citations": [
                    *[item.model_dump() for item in response.citations],
                    models.ReviewCitation(
                        citation_id=unknown_citation,
                        scope_id=response.scope_id,
                        kind="SCOPE_ATTESTATION",
                        run_role=None,
                        source_kind=None,
                        label="Unused scope attestation",
                    ).model_dump(),
                ],
            }
        )
    with pytest.raises(ValidationError):
        response.claims += response.claims


def test_review_response_rejects_an_unreachable_calculation_registry_cycle() -> None:
    models = _models()
    response = _valid_response(
        models,
        mode="LOCAL_DETERMINISTIC",
        status="AI_REVIEW_NOT_CONFIGURED",
    )
    orphan_citation_id = _id("cit_", "1")
    orphan_value_ids = (_id("val_", "2"), _id("val_", "3"))
    orphan_citation = models.ReviewCitation(
        citation_id=orphan_citation_id,
        scope_id=response.scope_id,
        kind="CALCULATION",
        run_role=None,
        source_kind=None,
        value_ref_ids=orphan_value_ids,
        label="Unreachable calculation citation",
    )
    orphan_values = tuple(
        models.ExactValueRef(
            value_ref_id=value_ref_id,
            scope_id=response.scope_id,
            run_role=None,
            semantic=f"ORPHAN_RATIO_{index}",
            value=str(index),
            unit="RATIO",
            currency=None,
            citation_id=orphan_citation_id,
            origin="CALCULATION",
        )
        for index, value_ref_id in enumerate(orphan_value_ids, start=1)
    )

    with pytest.raises(ValidationError, match="registry entry must be used"):
        models.RunReviewResponse(
            **{
                **response.model_dump(),
                "citations": (*response.citations, orphan_citation),
                "value_refs": (*response.value_refs, *orphan_values),
            }
        )


@pytest.mark.parametrize(
    ("model_name", "field_name", "wrong_value"),
    [
        ("EvidenceManifestV1", "scope_id", "scope_A" + "a" * 63),
        ("ReviewCitation", "citation_id", "cit_" + "A" * 64),
        ("ExactValueRef", "value_ref_id", "val_" + "0" * 63),
        ("StatementOption", "statement_id", "stmt_" + "g" * 64),
        ("RatioCalculation", "calculation_id", "calc_" + "a" * 65),
    ],
)
def test_all_opaque_identifier_formats_are_exact(
    model_name: str,
    field_name: str,
    wrong_value: str,
) -> None:
    models = _models()
    factories = {
        "EvidenceManifestV1": lambda: models.EvidenceManifestV1.model_construct(
            contract_version="EvidenceManifest.v1",
            scope_id=_id("scope_", "a"),
            runs=(),
        ),
        "ReviewCitation": lambda: models.ReviewCitation(
            citation_id=_id("cit_", "a"),
            scope_id=_id("scope_", "b"),
            kind="SCOPE_ATTESTATION",
            run_role=None,
            source_kind=None,
            label="Selected sealed evidence scope",
        ),
        "ExactValueRef": lambda: models.ExactValueRef(
            value_ref_id=_id("val_", "a"),
            scope_id=_id("scope_", "b"),
            run_role="PRIMARY",
            semantic="TOTAL_EVENTS",
            value="1",
            unit="COUNT",
            currency=None,
            citation_id=_id("cit_", "c"),
            origin="SOURCE",
        ),
        "StatementOption": lambda: models.StatementOption(
            statement_id=_id("stmt_", "a"),
            scope_id=_id("scope_", "b"),
            section="OBSERVED_FACT",
            text="The selected run is sealed.",
            citation_ids=(_id("cit_", "c"),),
            value_ref_ids=(),
            run_role="PRIMARY",
        ),
        "RatioCalculation": lambda: models.RatioCalculation(
            calculation_id=_id("calc_", "a"),
            scope_id=_id("scope_", "b"),
            tool_call_ordinal=1,
            numerator_value_ref_id=_id("val_", "c"),
            denominator_value_ref_id=_id("val_", "d"),
            result="0.5",
            rule="DECIMAL34_HALF_EVEN_RATIO_V1",
            result_value_ref_id=_id("val_", "e"),
            citation_id=_id("cit_", "f"),
            statement_id=_id("stmt_", "1"),
        ),
    }
    value = factories[model_name]().model_dump()
    value[field_name] = wrong_value

    with pytest.raises(ValidationError):
        getattr(models, model_name).model_validate(value)
