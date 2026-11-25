"""The trusted wait transition cannot move an existing hold earlier."""

import pytest

from stark_trading_os.control.postgres import research_repository as r
from tests.unit.domain.test_research_jobs import manifest


@pytest.mark.asyncio
async def test_refreshing_a_question_cannot_reduce_its_not_before(monkeypatch):
    m = manifest()
    job = {"job_id": m.trigger.job_id, "scope_key": "a" * 64, "state": "WAIT_REVIEW", "version": 2}
    old = r.ResearchQuestion(
        question_id="old-question",
        kind="REVIEW",
        nonce="old-nonce",
        expected_version=1,
        not_before_ms=1100,
        deadline_ms=4000,
    )
    # Unit isolation of this transition, not a database/authorization substitute.
    repo = object.__new__(r.PostgresResearchRepository)
    repo._job = lambda conn, key: (job, m)
    repo._question = lambda conn, row: (old, None)
    repo._event = lambda *args: None

    async def call(write, operation):
        return operation(None, 1000)

    repo._call = call
    monkeypatch.setattr(r, "_update", lambda *args: None)
    result = await repo.wait_for(m.trigger.job_id, 2, "REVIEW", not_before_ms=1000)
    # Frozen evidence: window_end=800, max_age=2000, inclusive age bound.
    assert result.not_before_ms == 1100 and result.deadline_ms == 2801
    assert result.expected_version == 3


@pytest.mark.asyncio
async def test_budget_wait_without_question_cannot_reclaim_after_restart():
    m = manifest(kind="FACTS")
    job = {"job_id": m.trigger.job_id, "state": "WAIT_BUDGET", "version": 2}
    repo = object.__new__(r.PostgresResearchRepository)
    repo._worker = lambda worker: None
    repo._job = lambda conn, key: (job, m)
    repo._question = lambda conn, row: (None, None)

    def no_admission(*args, **kwargs):
        raise AssertionError("WAIT_BUDGET must stop before another admission")

    repo._current = no_admission

    async def call(write, operation):
        return operation(None, 1000)

    repo._call = call
    assert await repo.claim_ready(m.trigger.job_id, "worker-2", 2) is None


@pytest.mark.parametrize(
    "answered_kind,want",
    [
        (None, "WAIT_BUDGET"),
        ("DATA", "WAIT_BUDGET"),
        ("BUDGET", "RUNNABLE"),
    ],
)
def test_sibling_result_preserves_budget_wait_until_its_own_answer(
    monkeypatch, answered_kind, want
):
    m = manifest(kind="FACTS")
    job = {"job_id": m.trigger.job_id, "state": "WAIT_BUDGET", "version": 2}
    repo = object.__new__(r.PostgresResearchRepository)
    repo._reports = lambda *args: ()
    repo._public_facts = lambda *args: ()
    q = (
        None
        if answered_kind is None
        else r.ResearchQuestion(
            question_id="question",
            kind=answered_kind,
            nonce="nonce",
            expected_version=2,
            not_before_ms=1000,
            deadline_ms=4000,
        )
    )
    answer = (
        None
        if q is None
        else r.ResearchAnswer(
            question_id=q.question_id,
            nonce=q.nonce,
            choice="RESUME",
            expected_version=2,
        )
    )
    repo._question = lambda *args: (q, answer)
    repo._liability_state = lambda conn, row, otherwise: otherwise
    monkeypatch.setattr(r, "_update", lambda conn, table, row, keys, values, now: values)
    assert repo._after_result(None, job, m, 1000)["state"] == want
