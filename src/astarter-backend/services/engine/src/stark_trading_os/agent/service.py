"""Two-snapshot lifecycle for manual read-only run review."""

from __future__ import annotations

import asyncio
import threading
from concurrent.futures import Future as ConcurrentFuture
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Any, Protocol, cast

from agents.exceptions import (
    MaxTurnsExceeded,
    ModelBehaviorError,
    ModelRefusalError,
    ModelTimeoutError,
)
from openai import APIConnectionError, APITimeoutError, InternalServerError, RateLimitError

from stark_trading_os.agent.evidence_scope import (
    DeterministicRatioRejected,
    EvidenceScope,
    RunEvidenceIntegrityFailed,
    RunEvidenceUnsealed,
    ScopeLookupError,
)
from stark_trading_os.agent.local_review import LocalReviewStatus, build_local_review
from stark_trading_os.agent.models import RunReviewRequest, RunReviewResponse
from stark_trading_os.agent.openai_review import (
    ReviewContractRejected,
    ReviewProposal,
    validate_untrusted_question,
)
from stark_trading_os.agent.post_validate import validate_candidate
from stark_trading_os.control.database import DatabaseConfigurationError
from stark_trading_os.control.registry import RunNotFound


class ScopeBuilder(Protocol):
    def build(self, primary_run_id: str, compare_run_id: str | None = None) -> EvidenceScope: ...


class Reviewer(Protocol):
    async def review(self, scope: EvidenceScope, untrusted_question: str) -> ReviewProposal: ...


_PROVIDER_OBSERVABLE_TYPES = (
    TimeoutError,
    ModelTimeoutError,
    APITimeoutError,
    APIConnectionError,
    RateLimitError,
    InternalServerError,
)
_PROVIDER_EXACT_TYPES = frozenset(_PROVIDER_OBSERVABLE_TYPES)
_CANDIDATE_OBSERVABLE_TYPES = (
    ReviewContractRejected,
    ScopeLookupError,
    DeterministicRatioRejected,
    MaxTurnsExceeded,
    ModelBehaviorError,
    ModelRefusalError,
)
_CANDIDATE_EXACT_TYPES = frozenset(_CANDIDATE_OBSERVABLE_TYPES)
_SERVER_REVIEW_DEADLINE_SECONDS = 8.0
_SCOPE_BUILD_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="run-review-scope")


class _ProcessReviewAdmission:
    """Grant at most one run-review lifecycle in this process."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._occupied = False

    def try_acquire(self) -> bool:
        with self._lock:
            if self._occupied:
                return False
            self._occupied = True
            return True

    def release(self) -> None:
        with self._lock:
            if not self._occupied:
                raise RuntimeError("Run review admission was released without an owner.")
            self._occupied = False


_PROCESS_REVIEW_ADMISSION = _ProcessReviewAdmission()


class RunReviewBusy(RuntimeError):
    """A bounded local review worker is already occupied."""


class RunReviewDeadlineExceeded(TimeoutError):
    """The complete local review lifecycle exceeded its server deadline."""


class RunReviewService:
    """Own mutable evidence access while giving the reviewer one immutable snapshot."""

    def __init__(self, *, builder: ScopeBuilder, reviewer: Reviewer | None) -> None:
        self._builder = builder
        self._reviewer = reviewer
        self._state_lock = threading.Lock()
        self._owns_admission = False
        self._active_builds = 0
        self._review_finished = False

    async def review(
        self,
        request: RunReviewRequest,
        *,
        allow_external: bool,
    ) -> RunReviewResponse:
        if type(request) is not RunReviewRequest:
            raise TypeError("review requires one exact RunReviewRequest")
        if type(allow_external) is not bool:
            raise TypeError("allow_external must be an exact boolean")
        if not _PROCESS_REVIEW_ADMISSION.try_acquire():
            raise RunReviewBusy("A run review is already in progress.")
        with self._state_lock:
            self._owns_admission = True
            self._review_finished = False
        deadline = asyncio.timeout(_SERVER_REVIEW_DEADLINE_SECONDS)
        try:
            try:
                async with deadline:
                    return await self._review_lifecycle(request, allow_external=allow_external)
            except TimeoutError as error:
                if not deadline.expired():
                    raise
                raise RunReviewDeadlineExceeded(
                    "Run review exceeded the server deadline."
                ) from error
        finally:
            with self._state_lock:
                self._review_finished = True
            self._release_admission_when_idle()

    async def _review_lifecycle(
        self,
        request: RunReviewRequest,
        *,
        allow_external: bool,
    ) -> RunReviewResponse:
        validated_question = validate_untrusted_question(request.question)
        if type(validated_question) is not str:
            raise TypeError("review question must be a string")

        original = await self._build_scope(request.run_id, request.compare_run_id)
        if type(original) is not EvidenceScope:
            raise TypeError("scope builder returned an unexpected object")

        proposal: ReviewProposal | None = None
        fallback_status: LocalReviewStatus | None = None
        if self._reviewer is None or not allow_external:
            fallback_status = "AI_REVIEW_NOT_CONFIGURED"
        else:
            try:
                proposal = await self._reviewer.review(original, validated_question)
            except asyncio.CancelledError:
                raise
            except _PROVIDER_OBSERVABLE_TYPES as error:
                if type(error) not in _PROVIDER_EXACT_TYPES:
                    raise
                fallback_status = "AI_REVIEW_UNAVAILABLE"
            except _CANDIDATE_OBSERVABLE_TYPES as error:
                if type(error) not in _CANDIDATE_EXACT_TYPES:
                    raise
                fallback_status = "AI_REVIEW_REJECTED"

        fresh = await self._fresh_scope(request)
        _require_identical_fresh_scope(original, fresh)
        if fallback_status is not None:
            return build_local_review(cast(Any, fresh), status=fallback_status)
        if proposal is None:
            raise RuntimeError("review lifecycle reached an impossible empty outcome")
        try:
            return validate_candidate(original, fresh, proposal)
        except _CANDIDATE_OBSERVABLE_TYPES as error:
            if type(error) not in _CANDIDATE_EXACT_TYPES:
                raise
            return build_local_review(cast(Any, fresh), status="AI_REVIEW_REJECTED")

    async def _fresh_scope(self, request: RunReviewRequest) -> EvidenceScope:
        try:
            fresh = await self._build_scope(request.run_id, request.compare_run_id)
        except (
            DatabaseConfigurationError,
            RunNotFound,
            RunEvidenceUnsealed,
            RunEvidenceIntegrityFailed,
        ) as error:
            raise RunEvidenceIntegrityFailed(
                "Selected evidence changed before review completion."
            ) from error
        if type(fresh) is not EvidenceScope:
            raise RunEvidenceIntegrityFailed(
                "Fresh evidence builder returned an invalid scope object."
            )
        return fresh

    async def _build_scope(self, primary_run_id: str, compare_run_id: str | None) -> EvidenceScope:
        with self._state_lock:
            self._active_builds += 1
        loop = asyncio.get_running_loop()
        try:
            worker_future = _SCOPE_BUILD_EXECUTOR.submit(
                partial(self._builder.build, primary_run_id, compare_run_id)
            )
        except BaseException:
            self._scope_build_completed()
            raise
        worker_future.add_done_callback(self._scope_build_finished)
        future = asyncio.wrap_future(worker_future, loop=loop)
        future.add_done_callback(self._consume_scope_build_exception)
        return await asyncio.shield(future)

    def _scope_build_finished(self, completed: ConcurrentFuture[EvidenceScope]) -> None:
        if not completed.cancelled():
            completed.exception()
        self._scope_build_completed()

    @staticmethod
    def _consume_scope_build_exception(completed: asyncio.Future[EvidenceScope]) -> None:
        if not completed.cancelled():
            completed.exception()

    def _scope_build_completed(self) -> None:
        with self._state_lock:
            self._active_builds -= 1
        self._release_admission_when_idle()

    def _release_admission_when_idle(self) -> None:
        should_release = False
        with self._state_lock:
            if self._review_finished and self._active_builds == 0 and self._owns_admission:
                self._owns_admission = False
                should_release = True
        if should_release:
            _PROCESS_REVIEW_ADMISSION.release()


def _require_identical_fresh_scope(original: EvidenceScope, fresh: EvidenceScope) -> None:
    if (
        original.scope_id != fresh.scope_id
        or original.canonical_bytes() != fresh.canonical_bytes()
        or original != fresh
    ):
        raise RunEvidenceIntegrityFailed("Selected evidence changed before review completion.")


__all__ = [
    "Reviewer",
    "RunReviewBusy",
    "RunReviewDeadlineExceeded",
    "RunReviewService",
    "ScopeBuilder",
]
