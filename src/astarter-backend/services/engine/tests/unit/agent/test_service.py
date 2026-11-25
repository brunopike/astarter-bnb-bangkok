from __future__ import annotations

import asyncio
import gc
import logging
import socket
import threading
import time
from dataclasses import dataclass, replace
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from agents.exceptions import (
    MaxTurnsExceeded,
    ModelBehaviorError,
    ModelRefusalError,
    ModelTimeoutError,
    UserError,
)
from openai import (
    APIConnectionError,
    APIResponseValidationError,
    APITimeoutError,
    AuthenticationError,
    BadRequestError,
    ConflictError,
    InternalServerError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    UnprocessableEntityError,
)
from test_openai_review import _opaque, make_candidate, make_scope

from stark_trading_os.agent import evidence_scope as evidence_scope_module
from stark_trading_os.agent import service as service_module
from stark_trading_os.agent.evidence_scope import (
    PRIVATE_ARTIFACT_PATHS,
    DeterministicRatioRejected,
    EvidenceScope,
    EvidenceScopeBuilder,
    IndependentEvidenceScopeBuilder,
    RunEvidenceIntegrityFailed,
    RunEvidenceUnsealed,
    ScopeLookupError,
    _PreparedEvent,
    _PreparedRun,
    _PreparedSource,
)
from stark_trading_os.agent.models import SOURCE_KINDS, RunReviewRequest
from stark_trading_os.agent.openai_review import (
    ReviewContractRejected,
    ReviewProposal,
    SensitiveQuestionRejected,
)
from stark_trading_os.agent.service import (
    RunReviewBusy,
    RunReviewDeadlineExceeded,
    RunReviewService,
)
from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.control.registry import (
    AuditIntent,
    PersistedEvent,
    RunNotFound,
    TerminalPublication,
)
from stark_trading_os.domain.models import RunState


@pytest.fixture(autouse=True)
def _forbid_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def blocked(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("service unit tests must not use the network")

    async def blocked_http(*_args: object, **_kwargs: object) -> None:
        blocked()

    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(httpx.AsyncClient, "send", blocked_http)


class _Builder:
    def __init__(self, outcomes: list[EvidenceScope | BaseException]) -> None:
        self.outcomes = outcomes
        self.calls: list[tuple[str, str | None]] = []

    def build(self, primary_run_id: str, compare_run_id: str | None = None) -> EvidenceScope:
        self.calls.append((primary_run_id, compare_run_id))
        outcome = self.outcomes[len(self.calls) - 1]
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


class _Reviewer:
    def __init__(self, outcome: ReviewProposal | BaseException) -> None:
        self.outcome = outcome
        self.calls: list[tuple[EvidenceScope, str]] = []

    async def review(self, scope: EvidenceScope, untrusted_question: str) -> ReviewProposal:
        self.calls.append((scope, untrusted_question))
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome


class _SlowBuilder:
    def __init__(self, scope: EvidenceScope, delay_seconds: float = 0.12) -> None:
        self.scope = scope
        self.delay_seconds = delay_seconds
        self.calls = 0

    def build(self, primary_run_id: str, compare_run_id: str | None = None) -> EvidenceScope:
        del primary_run_id, compare_run_id
        self.calls += 1
        time.sleep(self.delay_seconds)
        return self.scope


class _BlockingBuilder:
    def __init__(self, scope: EvidenceScope, *, block_on_call: int = 1) -> None:
        self.scope = scope
        self.block_on_call = block_on_call
        self.calls: list[tuple[str, str | None]] = []
        self.started = threading.Event()
        self.finished = threading.Event()
        self.release = threading.Event()

    def build(self, primary_run_id: str, compare_run_id: str | None = None) -> EvidenceScope:
        self.calls.append((primary_run_id, compare_run_id))
        if len(self.calls) != self.block_on_call:
            return self.scope
        self.started.set()
        assert self.release.wait(timeout=1.0)
        self.finished.set()
        return self.scope


class _BlockingFailingBuilder:
    def __init__(self, error: BaseException) -> None:
        self.error = error
        self.calls = 0
        self.started = threading.Event()
        self.finished = threading.Event()
        self.release = threading.Event()

    def build(self, primary_run_id: str, compare_run_id: str | None = None) -> EvidenceScope:
        del primary_run_id, compare_run_id
        self.calls += 1
        self.started.set()
        assert self.release.wait(timeout=1.0)
        self.finished.set()
        raise self.error


class _BlockingReviewer:
    def __init__(self, proposal: ReviewProposal) -> None:
        self.proposal = proposal
        self.calls: list[tuple[EvidenceScope, str]] = []
        self.started = asyncio.Event()

    async def review(self, scope: EvidenceScope, question: str) -> ReviewProposal:
        self.calls.append((scope, question))
        self.started.set()
        await asyncio.Event().wait()
        raise AssertionError("cancelled reviewer resumed")


def _request(question: str = "Review the sealed run") -> RunReviewRequest:
    return RunReviewRequest(run_id="bt_primary", compare_run_id=None, question=question)


def _valid_proposal(scope: EvidenceScope) -> ReviewProposal:
    return ReviewProposal(candidate=make_candidate(scope), ratio_ledger=(), tool_call_count=0)


@pytest.mark.asyncio
async def test_scope_build_does_not_block_the_event_loop() -> None:
    scope = make_scope()
    builder = _SlowBuilder(scope)
    loop = asyncio.get_running_loop()
    heartbeat_at: list[float] = []

    async def heartbeat() -> None:
        await asyncio.sleep(0.01)
        heartbeat_at.append(loop.time())

    heartbeat_task = asyncio.create_task(heartbeat())
    await asyncio.sleep(0)
    started_at = loop.time()
    response = await RunReviewService(builder=builder, reviewer=None).review(
        _request(),
        allow_external=False,
    )
    await heartbeat_task

    assert response.status == "AI_REVIEW_NOT_CONFIGURED"
    assert builder.calls == 2
    assert heartbeat_at[0] - started_at < 0.08


@pytest.mark.asyncio
async def test_busy_review_is_rejected_while_a_blocking_scope_build_owns_capacity() -> None:
    scope = make_scope()
    builder = _BlockingBuilder(scope)
    service = RunReviewService(builder=builder, reviewer=None)
    first = asyncio.create_task(service.review(_request(), allow_external=False))
    assert await asyncio.to_thread(builder.started.wait, 0.5)

    with pytest.raises(RunReviewBusy):
        await service.review(_request(), allow_external=False)

    builder.release.set()
    response = await first
    assert response.status == "AI_REVIEW_NOT_CONFIGURED"
    assert builder.calls == [("bt_primary", None), ("bt_primary", None)]


@pytest.mark.asyncio
async def test_review_admission_is_process_wide_while_another_service_builds() -> None:
    scope = make_scope()
    blocking_builder = _BlockingBuilder(scope)
    first_service = RunReviewService(builder=blocking_builder, reviewer=None)
    second_builder = _Builder([scope, scope])
    second_service = RunReviewService(builder=second_builder, reviewer=None)
    first = asyncio.create_task(first_service.review(_request(), allow_external=False))
    assert await asyncio.to_thread(blocking_builder.started.wait, 0.5)

    second = asyncio.create_task(second_service.review(_request(), allow_external=False))
    try:
        with pytest.raises(RunReviewBusy):
            await asyncio.wait_for(asyncio.shield(second), timeout=0.05)
    finally:
        if not second.done():
            second.cancel()
            with pytest.raises(asyncio.CancelledError):
                await second
        blocking_builder.release.set()
        await first

    assert second_builder.calls == []


@pytest.mark.asyncio
async def test_review_admission_is_process_wide_during_provider_review() -> None:
    scope = make_scope()
    blocking_reviewer = _BlockingReviewer(_valid_proposal(scope))
    first_service = RunReviewService(
        builder=_Builder([scope, scope]),
        reviewer=blocking_reviewer,
    )
    second_builder = _Builder([scope, scope])
    second_service = RunReviewService(builder=second_builder, reviewer=None)
    first = asyncio.create_task(first_service.review(_request(), allow_external=True))
    await asyncio.wait_for(blocking_reviewer.started.wait(), timeout=0.5)

    try:
        with pytest.raises(RunReviewBusy):
            await second_service.review(_request(), allow_external=False)
    finally:
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first

    response = await second_service.review(_request(), allow_external=False)
    assert response.status == "AI_REVIEW_NOT_CONFIGURED"
    assert second_builder.calls == [("bt_primary", None), ("bt_primary", None)]


@pytest.mark.asyncio
async def test_synchronous_executor_submission_failure_releases_review_capacity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scope = make_scope()
    builder = _Builder([scope, scope])
    service = RunReviewService(builder=builder, reviewer=None)
    submission_error = RuntimeError("executor submission failed")

    def fail_submission(*_args: object, **_kwargs: object) -> object:
        raise submission_error

    with monkeypatch.context() as submission_patch:
        submission_patch.setattr(service_module._SCOPE_BUILD_EXECUTOR, "submit", fail_submission)
        with pytest.raises(RuntimeError) as captured:
            await service.review(_request(), allow_external=False)
    assert captured.value is submission_error
    assert builder.calls == []

    response = await service.review(_request(), allow_external=False)

    assert response.status == "AI_REVIEW_NOT_CONFIGURED"
    assert builder.calls == [("bt_primary", None), ("bt_primary", None)]


@pytest.mark.asyncio
async def test_cancelled_review_keeps_capacity_until_its_blocking_build_really_finishes() -> None:
    scope = make_scope()
    builder = _BlockingBuilder(scope)
    reviewer = _Reviewer(_valid_proposal(scope))
    service = RunReviewService(builder=builder, reviewer=reviewer)
    first = asyncio.create_task(service.review(_request(), allow_external=True))
    assert await asyncio.to_thread(builder.started.wait, 0.5)
    cancelled_at = asyncio.get_running_loop().time()
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert asyncio.get_running_loop().time() - cancelled_at < 0.1

    with pytest.raises(RunReviewBusy):
        await service.review(_request(), allow_external=True)
    assert reviewer.calls == []
    assert builder.calls == [("bt_primary", None)]

    builder.release.set()
    assert await asyncio.to_thread(builder.finished.wait, 0.5)
    await asyncio.sleep(0)
    assert reviewer.calls == []


@pytest.mark.asyncio
async def test_cancelled_review_consumes_detached_worker_failure_and_releases_capacity() -> None:
    scope = make_scope()
    builder = _BlockingFailingBuilder(RuntimeError("worker failed after cancellation"))
    service = RunReviewService(builder=builder, reviewer=None)
    loop = asyncio.get_running_loop()
    prior_handler = loop.get_exception_handler()
    loop_errors: list[dict[str, object]] = []
    loop.set_exception_handler(lambda _loop, context: loop_errors.append(context))
    first = asyncio.create_task(service.review(_request(), allow_external=False))
    assert await asyncio.to_thread(builder.started.wait, 0.5)

    try:
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        builder.release.set()
        assert await asyncio.to_thread(builder.finished.wait, 0.5)
        await asyncio.sleep(0)
        gc.collect()
        await asyncio.sleep(0)

        response = await RunReviewService(
            builder=_Builder([scope, scope]),
            reviewer=None,
        ).review(_request(), allow_external=False)
        assert response.status == "AI_REVIEW_NOT_CONFIGURED"
        assert loop_errors == []
    finally:
        loop.set_exception_handler(prior_handler)


def test_cancelled_review_releases_capacity_after_originating_loop_closes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    isolated_admission = service_module._ProcessReviewAdmission()
    monkeypatch.setattr(service_module, "_PROCESS_REVIEW_ADMISSION", isolated_admission)
    scope = make_scope()
    blocking_builder = _BlockingBuilder(scope)
    first_service = RunReviewService(builder=blocking_builder, reviewer=None)
    originating_loops: list[asyncio.AbstractEventLoop] = []

    async def cancel_while_worker_is_blocked() -> None:
        originating_loops.append(asyncio.get_running_loop())
        review = asyncio.create_task(first_service.review(_request(), allow_external=False))
        assert await asyncio.to_thread(blocking_builder.started.wait, 0.5)
        review.cancel()
        with pytest.raises(asyncio.CancelledError):
            await review

    try:
        asyncio.run(cancel_while_worker_is_blocked())
        assert originating_loops[0].is_closed()
        assert not blocking_builder.finished.is_set()
    finally:
        blocking_builder.release.set()

    assert blocking_builder.finished.wait(timeout=0.5)
    service_module._SCOPE_BUILD_EXECUTOR.submit(lambda: None).result(timeout=0.5)

    second_builder = _Builder([scope, scope])
    response = asyncio.run(
        RunReviewService(builder=second_builder, reviewer=None).review(
            _request(),
            allow_external=False,
        )
    )

    assert response.status == "AI_REVIEW_NOT_CONFIGURED"
    assert blocking_builder.calls == [("bt_primary", None)]
    assert second_builder.calls == [("bt_primary", None), ("bt_primary", None)]


@pytest.mark.asyncio
async def test_server_deadline_prevents_fresh_scope_and_holds_capacity_until_worker_finishes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(service_module, "_SERVER_REVIEW_DEADLINE_SECONDS", 0.01)
    scope = make_scope()
    builder = _BlockingBuilder(scope)
    reviewer = _Reviewer(_valid_proposal(scope))
    service = RunReviewService(builder=builder, reviewer=reviewer)
    first = asyncio.create_task(service.review(_request(), allow_external=True))
    assert await asyncio.to_thread(builder.started.wait, 0.5)
    timed_out_at = asyncio.get_running_loop().time()

    with pytest.raises(RunReviewDeadlineExceeded):
        await first
    assert asyncio.get_running_loop().time() - timed_out_at < 0.1
    with pytest.raises(RunReviewBusy):
        await service.review(_request(), allow_external=True)
    assert builder.calls == [("bt_primary", None)]
    assert reviewer.calls == []

    builder.release.set()
    assert await asyncio.to_thread(builder.finished.wait, 0.5)
    await asyncio.sleep(0)
    assert reviewer.calls == []


@pytest.mark.asyncio
async def test_server_deadline_covers_provider_and_prevents_fresh_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(service_module, "_SERVER_REVIEW_DEADLINE_SECONDS", 0.01)
    scope = make_scope()
    builder = _Builder([scope, scope])
    reviewer = _BlockingReviewer(_valid_proposal(scope))
    service = RunReviewService(builder=builder, reviewer=reviewer)

    with pytest.raises(RunReviewDeadlineExceeded):
        await service.review(_request(), allow_external=True)

    assert reviewer.started.is_set()
    assert len(reviewer.calls) == 1
    assert builder.calls == [("bt_primary", None)]


@pytest.mark.asyncio
async def test_server_deadline_during_fresh_scope_keeps_capacity_until_worker_finishes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(service_module, "_SERVER_REVIEW_DEADLINE_SECONDS", 0.01)
    scope = make_scope()
    builder = _BlockingBuilder(scope, block_on_call=2)
    service = RunReviewService(builder=builder, reviewer=None)
    first = asyncio.create_task(service.review(_request(), allow_external=False))
    assert await asyncio.to_thread(builder.started.wait, 0.5)

    with pytest.raises(RunReviewDeadlineExceeded):
        await first
    with pytest.raises(RunReviewBusy):
        await service.review(_request(), allow_external=False)
    assert builder.calls == [("bt_primary", None), ("bt_primary", None)]

    builder.release.set()
    assert await asyncio.to_thread(builder.finished.wait, 0.5)


@pytest.mark.asyncio
async def test_independent_builder_opens_and_closes_a_worker_owned_store(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    scope = make_scope()
    opened: list[object] = []

    class Store:
        def __init__(self) -> None:
            self.closed = False
            self.thread_id = threading.get_ident()

        def close(self) -> None:
            self.closed = True

    class Recovery:
        def __init__(self, *, store: Store, runtime_root: object) -> None:
            assert runtime_root == tmp_path
            opened.append(store)

    class Builder:
        def __init__(self, *, store: Store, recovery: Recovery) -> None:
            assert recovery is not None
            opened.append(store)

        def build(self, primary_run_id: str, compare_run_id: str | None = None) -> EvidenceScope:
            assert (primary_run_id, compare_run_id) == ("bt_primary", None)
            return scope

    stores: list[Store] = []

    def open_store(_path: object) -> Store:
        store = Store()
        stores.append(store)
        return store

    monkeypatch.setattr(evidence_scope_module.ControlStore, "open", staticmethod(open_store))
    monkeypatch.setattr(evidence_scope_module, "FinalizationRecovery", Recovery)
    monkeypatch.setattr(evidence_scope_module, "EvidenceScopeBuilder", Builder)
    builder = IndependentEvidenceScopeBuilder(
        control_database=tmp_path / "control.sqlite",
        runtime_root=tmp_path,
    )

    response = await RunReviewService(builder=builder, reviewer=None).review(
        _request(),
        allow_external=False,
    )

    assert response.status == "AI_REVIEW_NOT_CONFIGURED"
    assert len(stores) == 2
    assert all(store.closed for store in stores)
    assert all(store.thread_id != threading.get_ident() for store in stores)


@pytest.mark.asyncio
async def test_sensitive_question_stops_before_scope_and_reviewer_without_echo(
    caplog: pytest.LogCaptureFixture,
) -> None:
    scope = make_scope()
    builder = _Builder([scope])
    reviewer = _Reviewer(_valid_proposal(scope))
    secret = "".join(("api ", "key", "=", "x" * 8))
    secret_digest = sha256(secret.encode("utf-8")).hexdigest()
    caplog.set_level(logging.DEBUG)

    with pytest.raises(SensitiveQuestionRejected) as captured:
        await RunReviewService(builder=builder, reviewer=reviewer).review(
            _request(secret),
            allow_external=True,
        )

    assert builder.calls == []
    assert reviewer.calls == []
    assert captured.value.field == "question"
    assert captured.value.reason == "SENSITIVE_INPUT_NOT_ACCEPTED"
    assert secret not in str(captured.value)
    assert secret not in repr(captured.value)
    assert secret not in caplog.text
    assert secret_digest not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error",
    (RunNotFound("missing"), RunEvidenceUnsealed("unsealed"), RunEvidenceIntegrityFailed("bad")),
)
async def test_initial_scope_failures_propagate_after_one_build(error: BaseException) -> None:
    builder = _Builder([error])
    reviewer = _Reviewer(ReviewContractRejected("must not run"))

    with pytest.raises(type(error)) as captured:
        await RunReviewService(builder=builder, reviewer=reviewer).review(
            _request(),
            allow_external=True,
        )

    assert captured.value is error
    assert len(builder.calls) == 1
    assert reviewer.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("configured", (False, True))
async def test_not_configured_or_external_prohibited_uses_one_fresh_local_scope(
    configured: bool,
) -> None:
    scope = make_scope()
    builder = _Builder([scope, scope])
    reviewer = _Reviewer(_valid_proposal(scope)) if configured else None

    response = await RunReviewService(builder=builder, reviewer=reviewer).review(
        _request(),
        allow_external=False if configured else True,
    )

    assert response.mode == "LOCAL_DETERMINISTIC"
    assert response.status == "AI_REVIEW_NOT_CONFIGURED"
    assert len(builder.calls) == 2
    if configured:
        assert reviewer is not None
        assert reviewer.calls == []


def _provider_errors() -> tuple[BaseException, ...]:
    request = httpx.Request("POST", "https://example.invalid")
    rate_response = httpx.Response(429, request=request)
    server_response = httpx.Response(500, request=request)
    return (
        TimeoutError("deadline"),
        ModelTimeoutError(6.0),
        APITimeoutError(request=request),
        APIConnectionError(request=request),
        RateLimitError("rate", response=rate_response, body=None),
        InternalServerError("service", response=server_response, body=None),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("error", _provider_errors())
async def test_only_exact_provider_unavailable_errors_use_local_unavailable(
    error: BaseException,
) -> None:
    scope = make_scope()
    builder = _Builder([scope, scope])
    reviewer = _Reviewer(error)

    response = await RunReviewService(builder=builder, reviewer=reviewer).review(
        _request(),
        allow_external=True,
    )

    assert response.mode == "LOCAL_DETERMINISTIC"
    assert response.status == "AI_REVIEW_UNAVAILABLE"
    assert len(builder.calls) == 2
    assert reviewer.calls == [(scope, _request().question)]


def _candidate_errors() -> tuple[BaseException, ...]:
    return (
        ReviewContractRejected("candidate"),
        ScopeLookupError("scope"),
        DeterministicRatioRejected("ratio"),
        MaxTurnsExceeded("turns"),
        ModelBehaviorError("behavior"),
        ModelRefusalError("refusal"),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("error", _candidate_errors())
async def test_only_exact_candidate_errors_use_local_rejected(error: BaseException) -> None:
    scope = make_scope()
    builder = _Builder([scope, scope])

    response = await RunReviewService(builder=builder, reviewer=_Reviewer(error)).review(
        _request(),
        allow_external=True,
    )

    assert response.mode == "LOCAL_DETERMINISTIC"
    assert response.status == "AI_REVIEW_REJECTED"
    assert len(builder.calls) == 2


_OBSERVABLE_BASE_TYPES: tuple[type[BaseException], ...] = (
    TimeoutError,
    ModelTimeoutError,
    APITimeoutError,
    APIConnectionError,
    RateLimitError,
    InternalServerError,
    ReviewContractRejected,
    ScopeLookupError,
    DeterministicRatioRejected,
    MaxTurnsExceeded,
    ModelBehaviorError,
    ModelRefusalError,
)


def _derived_observable(base_type: type[BaseException]) -> BaseException:
    derived_type = type(f"Derived{base_type.__name__}", (base_type,), {})
    request = httpx.Request("POST", "https://example.invalid")
    if issubclass(derived_type, ModelTimeoutError):
        return derived_type(6.0)
    if issubclass(derived_type, ModelRefusalError):
        return derived_type("derived refusal")
    if issubclass(derived_type, APITimeoutError):
        return derived_type(request=request)
    if issubclass(derived_type, APIConnectionError):
        return derived_type(request=request)
    if issubclass(derived_type, (RateLimitError, InternalServerError)):
        response = httpx.Response(500, request=request)
        return derived_type("derived status", response=response, body=None)
    return derived_type("derived")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "base_type",
    _OBSERVABLE_BASE_TYPES,
    ids=lambda base_type: base_type.__name__,
)
async def test_every_unlisted_observable_subclass_propagates_same_object_without_fresh_build(
    base_type: type[BaseException],
) -> None:
    error = _derived_observable(base_type)
    scope = make_scope()
    builder = _Builder([scope, scope])

    with pytest.raises(type(error)) as captured:
        await RunReviewService(builder=builder, reviewer=_Reviewer(error)).review(
            _request(),
            allow_external=True,
        )

    assert captured.value is error
    assert len(builder.calls) == 1


def _non_fallback_errors() -> tuple[BaseException, ...]:
    request = httpx.Request("POST", "https://example.invalid")

    def response(status_code: int) -> httpx.Response:
        return httpx.Response(status_code, request=request)

    return (
        AuthenticationError("authentication", response=response(401), body=None),
        PermissionDeniedError("permission", response=response(403), body=None),
        BadRequestError("bad request", response=response(400), body=None),
        NotFoundError("not found", response=response(404), body=None),
        ConflictError("conflict", response=response(409), body=None),
        UnprocessableEntityError("unprocessable", response=response(422), body=None),
        APIResponseValidationError(response=response(200), body=None),
        UserError("sdk configuration"),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("error", _non_fallback_errors())
async def test_configuration_and_non_allowlisted_api_errors_propagate_without_fresh_build(
    error: BaseException,
) -> None:
    scope = make_scope()
    builder = _Builder([scope, scope])

    with pytest.raises(type(error)) as captured:
        await RunReviewService(builder=builder, reviewer=_Reviewer(error)).review(
            _request(),
            allow_external=True,
        )

    assert captured.value is error
    assert len(builder.calls) == 1


@pytest.mark.asyncio
async def test_cancellation_and_unexpected_errors_propagate_without_fresh_build() -> None:
    for error in (asyncio.CancelledError(), RuntimeError("implementation defect")):
        scope = make_scope()
        builder = _Builder([scope, scope])
        with pytest.raises(type(error)) as captured:
            await RunReviewService(builder=builder, reviewer=_Reviewer(error)).review(
                _request(),
                allow_external=True,
            )
        assert captured.value is error
        assert len(builder.calls) == 1


def _drifted_scopes(scope: EvidenceScope) -> tuple[EvidenceScope, ...]:
    cited = replace(
        scope,
        _artifact_records=(
            replace(scope._artifact_records[0], projection_bytes=b'{"cited":"changed"}'),
            *scope._artifact_records[1:],
        ),
    )

    uncited = replace(
        scope,
        _artifact_records=(
            *scope._artifact_records[:-1],
            replace(scope._artifact_records[-1], projection_bytes=b'{"uncited":"changed"}'),
        ),
    )
    event = replace(
        scope,
        _event_records=(replace(scope._event_records[0], projection_bytes=b'{"event":"changed"}'),),
    )
    run = scope.manifest.runs[0]
    seal_manifest = scope.manifest.model_copy(
        update={"runs": (run.model_copy(update={"seal_digest": "f" * 64}),)}
    )
    authority_manifest = scope.manifest.model_copy(
        update={"runs": (run.model_copy(update={"state_version": run.state_version + 1}),)}
    )
    return (
        cited,
        uncited,
        event,
        replace(scope, manifest=seal_manifest),
        replace(scope, manifest=authority_manifest),
        replace(scope, retained_size_bytes=scope.retained_size_bytes + 1),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("fallback", ("not_configured", "provider", "candidate"))
@pytest.mark.parametrize("drift_index", range(6))
async def test_every_fallback_rejects_each_fresh_scope_drift(
    fallback: str,
    drift_index: int,
) -> None:
    original = make_scope()
    builder = _Builder([original, _drifted_scopes(original)[drift_index]])
    reviewer: _Reviewer | None
    if fallback == "not_configured":
        reviewer = None
    elif fallback == "provider":
        reviewer = _Reviewer(TimeoutError("provider unavailable"))
    else:
        reviewer = _Reviewer(ReviewContractRejected("candidate rejected"))

    with pytest.raises(RunEvidenceIntegrityFailed):
        await RunReviewService(builder=builder, reviewer=reviewer).review(
            _request(),
            allow_external=True,
        )

    assert len(builder.calls) == 2
    if reviewer is not None:
        assert len(reviewer.calls) == 1


@pytest.mark.asyncio
async def test_service_post_validation_propagates_ratio_rejection_subclass_by_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = make_scope()
    fresh = make_scope()
    calculation = original.deterministic_ratio(
        *original.allowed_ratio_pairs[0],
        tool_call_ordinal=1,
    )
    proposal = ReviewProposal(
        candidate=make_candidate(original),
        ratio_ledger=(calculation,),
        tool_call_count=1,
    )
    reviewer = _Reviewer(proposal)
    builder = _Builder([original, fresh])
    derived_type = type(
        "DerivedPostValidationRatioRejected",
        (DeterministicRatioRejected,),
        {},
    )
    error = derived_type("derived post-validation rejection")

    def reject(*_args: object, **_kwargs: object) -> object:
        raise error

    monkeypatch.setattr(EvidenceScope, "deterministic_ratio", reject)

    with pytest.raises(derived_type) as captured:
        await RunReviewService(builder=builder, reviewer=reviewer).review(
            _request(),
            allow_external=True,
        )

    assert captured.value is error
    assert len(builder.calls) == 2
    assert len(reviewer.calls) == 1


@pytest.mark.asyncio
async def test_any_fresh_scope_drift_returns_integrity_error_and_no_stale_report() -> None:
    scope = make_scope()
    for fresh in _drifted_scopes(scope):
        builder = _Builder([scope, fresh])
        reviewer = _Reviewer(_valid_proposal(scope))
        with pytest.raises(RunEvidenceIntegrityFailed):
            await RunReviewService(builder=builder, reviewer=reviewer).review(
                _request(),
                allow_external=True,
            )
        assert len(builder.calls) == 2
        assert len(reviewer.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fresh_error",
    (RunNotFound("gone"), RunEvidenceUnsealed("changed"), RunEvidenceIntegrityFailed("changed")),
)
async def test_fresh_domain_failure_is_integrity_failure(fresh_error: BaseException) -> None:
    scope = make_scope()
    builder = _Builder([scope, fresh_error])

    with pytest.raises(RunEvidenceIntegrityFailed) as captured:
        await RunReviewService(builder=builder, reviewer=_Reviewer(_valid_proposal(scope))).review(
            _request(),
            allow_external=True,
        )

    assert captured.value is not fresh_error
    assert captured.value.__cause__ is fresh_error
    assert len(builder.calls) == 2


@pytest.mark.asyncio
async def test_valid_proposal_returns_agent_response_after_exactly_two_builds() -> None:
    scope = make_scope()
    builder = _Builder([scope, scope])

    response = await RunReviewService(
        builder=builder,
        reviewer=_Reviewer(_valid_proposal(scope)),
    ).review(_request(), allow_external=True)

    assert response.mode == "OPENAI_AGENT"
    assert response.status == "COMPLETE"
    assert len(builder.calls) == 2


@pytest.mark.asyncio
async def test_distinct_but_equal_fresh_scope_and_compare_arguments_are_accepted() -> None:
    original = make_scope()
    fresh = make_scope()
    assert fresh is not original
    assert fresh == original
    builder = _Builder([original, fresh])
    request = RunReviewRequest(
        run_id="bt_primary",
        compare_run_id="bt_compare",
        question="Review both sealed runs",
    )

    response = await RunReviewService(
        builder=builder,
        reviewer=_Reviewer(_valid_proposal(original)),
    ).review(request, allow_external=True)

    assert response.mode == "OPENAI_AGENT"
    assert builder.calls == [
        ("bt_primary", "bt_compare"),
        ("bt_primary", "bt_compare"),
    ]


@dataclass
class _MutableAuthority:
    cited_artifact: str = "cited-v1"
    uncited_artifact: str = "uncited-v1"
    event: str = "event-v1"
    seal_digest: str = "e" * 64
    sqlite_state_version: int = 5


def _terminal_publication(run_id: str, authority: _MutableAuthority) -> TerminalPublication:
    envelope_bytes = canonical_json_bytes({"run_id": run_id, "terminal": "COMPLETED"})
    event = PersistedEvent(
        event_id=f"event-{run_id}",
        run_id=run_id,
        seq=1,
        source_seq=1,
        source="control-api",
        type="run.completed",
        ts_event_ns="1",
        ts_ingest_ns="1",
        visible=True,
        envelope_bytes=envelope_bytes,
    )
    audit = AuditIntent(
        run_id=run_id,
        audit_seq=1,
        event_seq=1,
        event_digest=sha256(envelope_bytes).hexdigest(),
        intent_bytes=canonical_json_bytes({"run_id": run_id}),
        created_at_ns=1,
    )
    return TerminalPublication(
        run_id=run_id,
        state=RunState.COMPLETED,
        state_version=authority.sqlite_state_version,
        event=event,
        audit_intent=audit,
        seal_digest=authority.seal_digest,
        published_at_ns=2,
        materialized_event_seq=1,
        materialized_audit_seq=1,
    )


class _StatefulAuthorityStore:
    def __init__(self, authority: _MutableAuthority) -> None:
        self.authority = authority
        self.calls: list[str] = []

    def run_evidence_snapshot(self, run_id: str) -> SimpleNamespace:
        self.calls.append(run_id)
        return SimpleNamespace(
            terminal_finalization=_terminal_publication(run_id, self.authority),
            sqlite_state_version=self.authority.sqlite_state_version,
        )


class _StatefulRecovery:
    def __init__(self, authority: _MutableAuthority) -> None:
        self.authority = authority
        self.calls: list[tuple[TerminalPublication, tuple[str, ...]]] = []

    def read_artifacts(
        self,
        *,
        publication: TerminalPublication,
        relative_paths: tuple[str, ...],
    ) -> tuple[bytes, ...]:
        self.calls.append((publication, relative_paths))
        return (
            canonical_json_bytes({"marker": self.authority.cited_artifact}),
            canonical_json_bytes({"marker": self.authority.uncited_artifact}),
            canonical_json_bytes({"marker": self.authority.event}),
        )


class _RecordingEvidenceBuilder:
    def __init__(self, delegate: EvidenceScopeBuilder) -> None:
        self.delegate = delegate
        self.scopes: list[EvidenceScope] = []

    def build(self, primary_run_id: str, compare_run_id: str | None = None) -> EvidenceScope:
        scope = self.delegate.build(primary_run_id, compare_run_id)
        self.scopes.append(scope)
        return scope


def _minimal_prepared_run(
    snapshot: SimpleNamespace,
    publication: TerminalPublication,
    artifacts: tuple[bytes, ...],
    *,
    role: str,
) -> _PreparedRun:
    cited_raw, uncited_raw, event_raw = artifacts
    sources = tuple(
        _PreparedSource(
            source_kind=source_kind,
            available=False,
            raw_sha256=None,
            raw_size_bytes=None,
            projection_bytes=(
                cited_raw
                if source_kind == "RUN_RECORD"
                else uncited_raw
                if source_kind == "METRICS"
                else canonical_json_bytes({"source_kind": source_kind})
            ),
            coverage="MISSING",
            record_count=0,
            sample_count=0,
            omitted_count=0,
        )
        for source_kind in SOURCE_KINDS
    )
    return _PreparedRun(
        role=role,
        terminal_state="COMPLETED",
        state_version=publication.state_version,
        last_visible_seq=1,
        terminal_event_seq=1,
        materialized_event_seq=1,
        materialized_audit_seq=1,
        published_at_ns=publication.published_at_ns,
        seal_digest=publication.seal_digest,
        sources=sources,
        events=(
            _PreparedEvent(
                envelope_sha256=sha256(event_raw).hexdigest(),
                projection_bytes=event_raw,
            ),
        ),
        semantics=(),
        missing_sources=SOURCE_KINDS,
        authority={
            "run_id": publication.run_id,
            "state_version": snapshot.sqlite_state_version,
        },
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "drift",
    (None, "cited_artifact", "uncited_artifact", "event", "seal_digest", "sqlite"),
)
async def test_public_evidence_builder_rebuilds_mutable_authority_after_reviewer_callback(
    drift: str | None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    authority = _MutableAuthority()
    store = _StatefulAuthorityStore(authority)
    recovery = _StatefulRecovery(authority)
    builder = _RecordingEvidenceBuilder(
        EvidenceScopeBuilder(store=store, recovery=recovery)  # type: ignore[arg-type]
    )

    def mutate() -> None:
        if drift == "sqlite":
            authority.sqlite_state_version += 1
        elif drift is not None:
            current = getattr(authority, drift)
            setattr(authority, drift, "f" * 64 if drift == "seal_digest" else f"{current}-v2")

    class _MutatingReviewer:
        async def review(self, scope: EvidenceScope, _untrusted_question: str) -> ReviewProposal:
            proposal = _valid_proposal(scope)
            mutate()
            return proposal

    monkeypatch.setattr(evidence_scope_module, "_prepare_run", _minimal_prepared_run)
    service = RunReviewService(builder=builder, reviewer=_MutatingReviewer())

    if drift is None:
        response = await service.review(_request(), allow_external=True)
        assert response.mode == "OPENAI_AGENT"
        assert builder.scopes[0] is not builder.scopes[1]
        assert builder.scopes[0] == builder.scopes[1]
    else:
        with pytest.raises(RunEvidenceIntegrityFailed):
            await service.review(_request(), allow_external=True)

    assert store.calls == ["bt_primary", "bt_primary"]
    assert len(recovery.calls) == 2
    assert all(relative_paths == PRIVATE_ARTIFACT_PATHS for _, relative_paths in recovery.calls)


@pytest.mark.asyncio
async def test_post_validation_rejection_reuses_fresh_scope_without_third_build() -> None:
    scope = make_scope()
    candidate = make_candidate(scope).model_copy(
        update={"calculation_ids": (_opaque("calc_", 999),)}
    )
    proposal = ReviewProposal(candidate=candidate, ratio_ledger=(), tool_call_count=0)
    builder = _Builder([scope, scope])

    response = await RunReviewService(builder=builder, reviewer=_Reviewer(proposal)).review(
        _request(),
        allow_external=True,
    )

    assert response.mode == "LOCAL_DETERMINISTIC"
    assert response.status == "AI_REVIEW_REJECTED"
    assert len(builder.calls) == 2


@pytest.mark.asyncio
async def test_unexpected_fresh_builder_error_is_not_hidden() -> None:
    scope = make_scope()
    error = RuntimeError("fresh implementation defect")
    builder = _Builder([scope, error])

    with pytest.raises(RuntimeError) as captured:
        await RunReviewService(builder=builder, reviewer=None).review(
            _request(),
            allow_external=False,
        )

    assert captured.value is error
    assert len(builder.calls) == 2
