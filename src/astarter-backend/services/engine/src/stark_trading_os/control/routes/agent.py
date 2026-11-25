"""Manual read-only review of verified terminal run evidence."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Body, Depends, Request
from pydantic import BeforeValidator
from pydantic_core import PydanticCustomError

from stark_trading_os.agent.evidence_scope import (
    RunEvidenceIntegrityFailed,
    RunEvidenceUnsealed,
)
from stark_trading_os.agent.models import RunReviewRequest, RunReviewResponse
from stark_trading_os.agent.openai_review import (
    SensitiveQuestionRejected,
    validate_untrusted_question,
)
from stark_trading_os.agent.service import RunReviewBusy, RunReviewDeadlineExceeded
from stark_trading_os.control.api_models import ApiError
from stark_trading_os.control.dependencies import ControlDependencies, get_dependencies
from stark_trading_os.control.registry import RunNotFound
from stark_trading_os.domain.models import ErrorResponse

router = APIRouter(prefix="/v1/agent", tags=["agent"])
Dependencies = Annotated[ControlDependencies, Depends(get_dependencies)]
ReviewRequestBody = Annotated[
    RunReviewRequest,
    BeforeValidator(lambda value: _classify_review_request(value)),
    Body(
        description=(
            "Manual sealed-run review request. The question is limited to 2,000 Unicode "
            "code points and 8,192 UTF-8 bytes."
        )
    ),
]


def _classify_review_request(value: object) -> object:
    if type(value) is not dict:
        return value
    question = value.get("question")
    if type(question) is not str:
        return value
    try:
        validate_untrusted_question(question)
    except SensitiveQuestionRejected as error:
        if type(error) is not SensitiveQuestionRejected:
            raise
        raise PydanticCustomError(
            "review_sensitive_input_not_accepted",
            "Sensitive input is not accepted.",
        ) from error
    return value


@router.post(
    "/run-review",
    response_model=RunReviewResponse,
    responses={
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
    },
)
async def review_run(
    review_request: ReviewRequestBody,
    http_request: Request,
    dependencies: Dependencies,
) -> RunReviewResponse:
    service = dependencies.run_review_service
    if service is None:
        raise RuntimeError("Run review service is unavailable.")
    allow_external = getattr(http_request.app.state, "allow_external_agent_review", None)
    if type(allow_external) is not bool:
        raise RuntimeError("Run review external-call policy is unavailable.")
    try:
        return await service.review(review_request, allow_external=allow_external)
    except RunNotFound as error:
        raise ApiError(
            status_code=404,
            code="RUN_UNKNOWN",
            message="The selected run does not exist.",
            run_id=error.run_id,
        ) from error
    except RunEvidenceUnsealed as error:
        raise ApiError(
            status_code=409,
            code="RUN_UNSEALED",
            message="The selected run evidence is not sealed and verified.",
        ) from error
    except RunEvidenceIntegrityFailed as error:
        raise ApiError(
            status_code=409,
            code="RUN_EVIDENCE_INTEGRITY_FAILED",
            message="The selected run evidence failed authoritative integrity verification.",
        ) from error
    except RunReviewBusy as error:
        raise ApiError(
            status_code=409,
            code="RUN_REVIEW_BUSY",
            message="A run review is already in progress.",
            retryable=True,
        ) from error
    except RunReviewDeadlineExceeded as error:
        raise ApiError(
            status_code=409,
            code="RUN_REVIEW_TIMED_OUT",
            message="The run review exceeded its server deadline.",
            retryable=True,
        ) from error
