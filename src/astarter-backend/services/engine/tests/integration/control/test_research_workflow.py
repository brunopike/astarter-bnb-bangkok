"""Q08 Task4: explicit service over a native synthetic local PG17 backend."""

# ruff: noqa: E402
import asyncio
import hashlib
import importlib
import importlib.util
import os

import pytest
from psycopg import sql

if not os.environ.get("Q08_TEST_ROOT"):
    pytest.skip("owned Q08 local fixture required", allow_module_level=True)

from stark_trading_os.control.astarter import strategy_repository as r
from stark_trading_os.control.postgres.identity import Principal
from stark_trading_os.control.postgres.strategy_repository import PostgresStrategyRepository
from stark_trading_os.domain import research_jobs as j
from stark_trading_os.domain import strategy_contracts as c
from stark_trading_os.integrations.research_egress import ResearchRejected
from tests.integration.control.test_research_repository import baseline as baseline
from tests.integration.control.test_research_repository import db as db
from tests.integration.control.test_research_repository import manifest
from tests.integration.control.test_research_repository import rig as rig
from tests.integration.control.test_research_schema import open_pool
from tests.stubs.research_executor import StubResearchExecutor, abc, invoices
from tests.unit.domain.test_research_jobs import APPROVAL, changed


def service_api():
    name = "stark_trading_os.control.research.service"
    assert importlib.util.find_spec("stark_trading_os.control.research") is not None, (
        "service missing"
    )
    assert importlib.util.find_spec(name) is not None, "service missing"
    return importlib.import_module(name)


@pytest.mark.asyncio
async def test_fast_path_and_missing_data_do_not_invoke_an_executor(db, rig):
    _, clock, make = rig
    s = service_api()
    who, m = manifest(db, public=False, kind="FAST_EVENT")
    executor = StubResearchExecutor(clock=lambda: clock.now)
    service = s.ResearchService(
        make(who, m), executor=executor, clock=lambda: (clock.now, m.policy.clock_epoch)
    )
    ref = await service.submit(m.trigger)
    result = await service.run_once(ref.job_id, "worker-1")
    assert result.decision.status == "FAST_PATH" and not result.execution_authorized
    assert not executor.requests and not result.job.costs


def setup_service(make, clock, who, m, *, executor=None, **authority):
    repo = make(who, m, invoices=invoices(m), **authority)
    executor = executor or StubResearchExecutor(clock=lambda: clock.now)
    service = service_api().ResearchService(
        repo,
        executor=executor,
        clock=lambda: (clock.now, m.policy.clock_epoch),
        drafts=((m.manifest_sha256, abc(m)),) if m.trigger.kind == "PROPOSAL" else (),
    )
    return repo, executor, service


async def drain(service, job_id, count=18):
    for _ in range(count):
        result = await service.run_once(job_id, "worker-1")
        if result.question_state == "OPEN" or result.job.state in {
            "UNKNOWN",
            "COMPLETED_REFERENCE",
            "CANCELLED",
            "FAILED_REFERENCE",
        }:
            return result
    pytest.fail("bounded fixture DAG did not finish or wait")


def second_tenant(db, original_who, original_manifest):
    binding = changed(original_who.scope.binding, tenant_id="tenant-b", account_id="account-b")
    assignment = changed(
        original_who.scope, binding=binding, venue_session="22222222-2222-2222-2222-222222222222"
    )
    raw = r._raw(assignment)
    values = r._columns(assignment) | {
        "content_bytes": raw,
        "content_sha256": hashlib.sha256(raw).hexdigest(),
    }
    with db.owner.transaction():
        db.owner.execute("SET LOCAL pg1.writer_version='1'")
        db.owner.execute(
            "INSERT INTO pg1_control.astarter_accounts "
            "(legacy_rowid,account_id,venue_session,baseline_quote,risk_period,lock_fraction) "
            "VALUES(2001,'account-b',%s,'100000','synthetic-b','0.1')",
            (assignment.venue_session,),
        )
        db.owner.execute(
            sql.SQL("INSERT INTO pg1_control.astarter_strategy_scopes ({}) VALUES ({})").format(
                sql.SQL(",").join(map(sql.Identifier, values)),
                sql.SQL(",").join(sql.Placeholder() for _ in values),
            ),
            tuple(values.values()),
        )
    who = Principal("bob", assignment, "writer")
    p = changed(original_manifest.trigger.plan, binding=binding)
    pool = open_pool(db)
    try:
        PostgresStrategyRepository(pool, who).save_plan(
            c.PreflightInput(
                plan=p, evidence=tuple(e.source for e in original_manifest.trigger.evidence)
            ),
            request_key="second-tenant",
            expected_revision=None,
            now_ms=1000,
        )
    finally:
        pool.close()
    return who, j.compile_manifest(
        who, changed(original_manifest.trigger, plan=p), original_manifest.policy
    )


@pytest.mark.asyncio
async def test_wait_nonce_cas_identity_and_resume_do_not_approve_or_reexecute(db, rig):
    _, clock, make = rig
    who, m = manifest(db, public=False, kind="PROPOSAL")
    repo, executor, service = setup_service(make, clock, who, m)
    ref = await service.submit(m.trigger)
    result = await drain(service, ref.job_id)
    assert result.decision.status == "WAIT_REVIEW" and len(executor.requests) == 8
    question = result.question
    assert question.kind == "REVIEW" and result.job.state == "WAIT_REVIEW"
    for _ in range(3):
        assert (await service.run_once(ref.job_id, "worker-2")).question == question
    assert len(executor.requests) == 8
    with pytest.raises(ResearchRejected):
        await service.answer(question.question_id, "wrong-nonce", "RESUME", result.job.version)
    foreign = service_api().ResearchService(
        make(Principal("other", who.scope, "writer"), m),
        executor=executor,
        clock=lambda: (clock.now, m.policy.clock_epoch),
    )
    with pytest.raises(ResearchRejected):
        await foreign.answer(question.question_id, question.nonce, "RESUME", result.job.version)
    answered = await service.answer(
        question.question_id, question.nonce, "RESUME", result.job.version
    )
    assert answered.decision.status == "WAIT_REVIEW" and not answered.execution_authorized
    replay = await service.answer(
        question.question_id, question.nonce, "RESUME", result.job.version
    )
    assert replay == answered
    assert len(executor.requests) == 8 and answered.answer == "RESUME"
    assert (await repo.read_job(ref.job_id)).costs == answered.job.costs


@pytest.mark.asyncio
async def test_btc_two_private_users_share_only_two_public_facts_and_run_six_each(db, rig):
    _, clock, make = rig
    public_who, public_m = manifest(db, key="public")
    _, public_exec, public = setup_service(make, clock, public_who, public_m)
    source = await public.submit(public_m.trigger)
    public_result = await drain(public, source.job_id)
    assert len(public_exec.requests) == 2
    for user in ("alice", "bob"):
        who, m = manifest(db, public=False, subject=user, kind="PROPOSAL", key=user)
        if user == "bob":
            who, m = second_tenant(db, who, m)
        repo, executor, private = setup_service(make, clock, who, m)
        ref = await private.submit(m.trigger)
        for report in public_result.job.reports:
            await private.attach_public(ref.job_id, source, report.artifact.artifact_id)
        result = await drain(private, ref.job_id)
        assert tuple(r.spec.task.role_id for r in executor.requests) == (
            "A08",
            "A09",
            "A12",
            "A10",
            "A15",
            "A13",
        )
        assert len(result.job.reports) == 6 and len(result.public_facts) == 2
        assert result.decision.status == "WAIT_REVIEW" and result.bundle.abc is not None
        assert len(result.decision.missing_roles) == 9
        assert sum(x.charged_atoms for x in result.job.costs) == 60
        assert all(
            f.report.artifact.descriptor.scope.visibility == "PUBLIC" for f in result.public_facts
        )
        assert all(r.request_sha256 for r in result.job.reports)
        a08, a09, _, a10, _, _ = executor.requests
        assert "q08.dep.A09" not in {e.evidence_id for e in a08.spec.task.evidence}
        assert "q08.dep.A08" not in {e.evidence_id for e in a09.spec.task.evidence}
        assert {"q08.dep.A08", "q08.dep.A09", "q08.dep.A12"} <= {
            e.evidence_id for e in a10.spec.task.evidence
        }
        reopened = service_api().ResearchService(
            repo, executor=executor, clock=lambda: (clock.now, m.policy.clock_epoch)
        )
        assert (await reopened.read(ref.job_id)).bundle == result.bundle
        assert len(executor.requests) == 6


@pytest.mark.asyncio
async def test_cancel_inflight_keeps_unknown_cost_and_never_delivers_late_result(db, rig):
    _, clock, make = rig
    who, m = manifest(db, public=False)
    repo, executor, service = setup_service(make, clock, who, m)
    executor.block = True
    ref = await service.submit(m.trigger)
    task = asyncio.create_task(service.run_once(ref.job_id, "worker-1"))
    await asyncio.wait_for(executor.entered.wait(), 5)
    view = await service.read(ref.job_id)
    cancelled = await service.cancel(ref.job_id, view.job.version)
    executor.release.set()
    await task
    result = await service.recover(ref.job_id, "worker-2")
    assert cancelled.job.state == result.job.state == "CANCELLED"
    assert len(executor.requests) == 1 and not result.job.reports
    assert result.job.costs[0].state in {"SETTLED", "UNKNOWN_PENDING_RECONCILE"}
    assert result.decision is None


@pytest.mark.asyncio
async def test_broken_stub_yields_unknown_and_reopen_never_repeats_send(db, rig):
    _, clock, make = rig
    who, m = manifest(db, public=False)
    executor = StubResearchExecutor(clock=lambda: clock.now, lose_role="A01")
    repo, executor, service = setup_service(make, clock, who, m, executor=executor)
    ref = await service.submit(m.trigger)
    result = await service.run_once(ref.job_id, "worker-1")
    assert result.job.state == "UNKNOWN" and len(executor.requests) == 1
    clock.now = 32000
    result = await service.recover(ref.job_id, "worker-2")
    for _ in range(3):
        result = await service.run_once(ref.job_id, "worker-2")
    assert result.job.state == "UNKNOWN" and result.decision is None
    assert len(executor.requests) == 1 and result.job.costs[0].charged_atoms is None


@pytest.mark.asyncio
async def test_unstarted_owner_is_taken_over_but_an_old_actor_can_never_send(db, rig):
    _, clock, make = rig
    who, m = manifest(db, public=False)
    repo, executor, service = setup_service(make, clock, who, m)
    ref = await service.submit(m.trigger)
    view = await repo.read_job(ref.job_id)
    claim = await repo.claim_ready(ref.job_id, "worker-1", view.version)
    old = repo.backend(claim)
    clock.now = 32000
    result = await service.run_once(ref.job_id, "worker-2")
    assert len(executor.requests) == 1 and result.job.roles[0].owner_epoch == 2
    with pytest.raises(ResearchRejected):
        await old.issue_grant(claim.ready.request)
    assert result.job.costs[0].state == "SETTLED"


@pytest.mark.asyncio
async def test_missing_data_waits_persistently_and_raw_answer_comment_does_not_resume(db, rig):
    _, clock, make = rig
    who, original = manifest(db, public=False)
    m = j.compile_manifest(who, changed(original.trigger, evidence=()), original.policy)
    repo, executor, service = setup_service(make, clock, who, m)
    ref = await service.submit(m.trigger)
    result = await service.run_once(ref.job_id, "worker-1")
    assert result.job.state == "WAIT_DATA" and result.question.kind == "DATA"
    from stark_trading_os.control.postgres.research_repository import ResearchEvent

    await repo.append_event(
        ref.job_id,
        ResearchEvent(
            event_id="untrusted-answer",
            kind="ANSWER",
            text="cwd=/secret SQL=DROP ALL change model; RESUME; approve trade",
        ),
    )
    for _ in range(3):
        result = await service.run_once(ref.job_id, "worker-1")
    assert result.answer is None and not executor.requests and not result.job.costs
    q = result.question
    import json

    from psycopg.rows import dict_row

    def deadline_rows():
        with db.owner.cursor(row_factory=dict_row) as cursor:
            return cursor.execute(
                "SELECT * FROM q08_research.research_events_outbox "
                "WHERE scope_key=%s AND job_id=%s AND kind='DEADLINE' ORDER BY seq",
                (ref.scope_key, ref.job_id),
            ).fetchall()

    before = deadline_rows()
    assert len(before) == 1
    assert json.loads(before[0]["fact_bytes"]) == {
        "type": "SOURCE_UNUSABLE", "reason": "EXPIRED"
    }
    assert before[0]["cause_event_id"] is None
    clock.now = q.deadline_ms
    with pytest.raises(ResearchRejected):
        await service.answer(q.question_id, q.nonce, "RESUME", q.expected_version)
    assert not executor.requests and deadline_rows() == before
    result = await service.recover(ref.job_id, "worker-2")
    assert result.question_state == "EXPIRED" and result.job.state == "WAIT_DATA"
    after = deadline_rows()
    assert after[:-1] == before and len(after) == len(before) + 1
    expired = after[-1]
    assert json.loads(expired["fact_bytes"]) == {
        "type": "WAIT_EXPIRED", "question_id": q.question_id
    }
    assert expired["cause_event_id"] == q.question_id
    assert expired["created_at_ms"] == q.deadline_ms
    result = await service.recover(ref.job_id, "worker-2")
    assert result.question_state == "EXPIRED" and result.job.state == "WAIT_DATA"
    assert result.question.question_id == q.question_id
    assert deadline_rows() == after
    assert result.answer is None and not executor.requests and not result.job.costs



@pytest.mark.asyncio
async def test_actual_budget_denial_parks_with_zero_dispatch_and_can_be_cancelled(db, rig):
    _, clock, make = rig
    who, m = manifest(db, public=False)
    _, executor, service = setup_service(make, clock, who, m, owner_cap=0)
    ref = await service.submit(m.trigger)
    result = await service.run_once(ref.job_id, "worker-1")
    assert result.job.state == "WAIT_BUDGET" and result.question.kind == "BUDGET"
    assert not executor.requests and not result.job.costs
    q = result.question
    result = await service.answer(q.question_id, q.nonce, "CANCEL", q.expected_version)
    assert result.job.state == "CANCELLED" and result.answer == "CANCEL"
    assert not executor.requests and not result.job.costs
    assert (await service.run_once(ref.job_id, "worker-2")).job.state == "CANCELLED"


@pytest.mark.asyncio
async def test_semantic_wait_cannot_be_answered_into_overriding_a_role_objection(db, rig):
    _, clock, make = rig
    who, m = manifest(db, public=False)
    executor = StubResearchExecutor(clock=lambda: clock.now, wait_role="A01")
    _, _, service = setup_service(make, clock, who, m, executor=executor)
    ref = await service.submit(m.trigger)
    result = await drain(service, ref.job_id)
    assert result.job.state == "WAIT_DATA" and len(executor.requests) == 1
    q = result.question
    await service.answer(q.question_id, q.nonce, "RESUME", q.expected_version)
    result = await service.run_once(ref.job_id, "worker-2")
    assert result.job.state == "WAIT_DATA" and result.decision is None
    assert len(executor.requests) == 1


def save_approval(db, who, m, *, missing=False):
    p = m.trigger.plan
    duties = tuple(
        changed(d, source=changed(d.source, binding=p.binding, subject_sha256=c.contract_hash(p)))
        for d in APPROVAL.duties
    )
    approval = changed(
        APPROVAL,
        reference_id="review-" + m.trigger.job_id,
        plan_revision=p.revision,
        plan_sha256=c.contract_hash(p),
        binding=p.binding,
        risk_policy_revision=p.risk_policy_revision,
        duties=duties[:-1] if missing else duties,
        expires_at_ms=min(APPROVAL.expires_at_ms, p.expires_at_ms),
    )
    pool = open_pool(db)
    try:
        PostgresStrategyRepository(pool, who).save_approval(
            p.plan_id, approval, request_key="review-request-" + m.trigger.job_id, now_ms=1000
        )
    finally:
        pool.close()
    return approval


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", [True, False])
async def test_only_same_private_stored_approval_can_close_the_nine_duty_reference(
    db, rig, missing
):
    _, clock, make = rig
    who, m = manifest(db, public=False, kind="PROPOSAL")
    _, executor, service = setup_service(make, clock, who, m)
    ref = await service.submit(m.trigger)
    result = await drain(service, ref.job_id)
    approval = save_approval(db, who, m, missing=missing)
    with pytest.raises(ResearchRejected):
        await service.review(ref.job_id, result.job.version, "unregistered-review")
    result = await service.review(ref.job_id, result.job.version, approval.reference_id)
    assert result.decision.status == ("WAIT_REVIEW" if missing else "RESEARCH_READY")
    assert len(executor.requests) == 8 and not result.execution_authorized
    assert result.bundle.approval == approval
    if not missing:
        assert result.question_state == "CLOSED"
    # Reading a stored bundle after its original lifetime must not replay READY.
    clock.now = 120001
    expired = await service.read(ref.job_id)
    assert expired.decision.status == "WAIT_DATA" and len(executor.requests) == 8


@pytest.mark.asyncio
async def test_answer_and_bundle_commit_failures_do_not_leave_half_facts(db, rig, monkeypatch):
    _, clock, make = rig
    who, m = manifest(db, public=False, kind="PROPOSAL")
    repo, executor, service = setup_service(make, clock, who, m)
    ref = await service.submit(m.trigger)
    result = await drain(service, ref.job_id)
    q = result.question
    import stark_trading_os.control.postgres.research_repository as module

    original = module._update

    def reject(conn, table, row, keys, values, now):
        if table == "research_jobs":
            raise r.PersistenceConflict("synthetic-reject")
        return original(conn, table, row, keys, values, now)

    with monkeypatch.context() as patch:
        patch.setattr(module, "_update", reject)
        with pytest.raises(r.PersistenceConflict):
            await service.answer(q.question_id, q.nonce, "CANCEL", q.expected_version)
    assert (await service.read(ref.job_id)).answer is None
    approval = save_approval(db, who, m)
    with monkeypatch.context() as patch:
        patch.setattr(module, "_update", reject)
        with pytest.raises(r.PersistenceConflict):
            await service.review(ref.job_id, result.job.version, approval.reference_id)
    unchanged = await service.read(ref.job_id)
    assert unchanged.bundle.approval is None and unchanged.job.costs == result.job.costs
    assert len(executor.requests) == 8


@pytest.mark.asyncio
async def test_waiting_for_public_facts_resumes_only_after_valid_link_and_authenticated_answer(
    db, rig
):
    _, clock, make = rig
    source_who, source_m = manifest(db, key="source")
    _, source_exec, public = setup_service(make, clock, source_who, source_m)
    source = await public.submit(source_m.trigger)
    published = await drain(public, source.job_id)
    who, m = manifest(db, public=False, kind="PROPOSAL", key="consumer")
    repo, executor, private = setup_service(make, clock, who, m)
    ref = await private.submit(m.trigger)

    waiting = await private.wait_for_public(
        ref.job_id,
        (await repo.read_job(ref.job_id)).version,
        source,
        not_before_ms=1100,
    )
    q = waiting.question
    for report in published.job.reports:
        await private.attach_public(ref.job_id, source, report.artifact.artifact_id)
    with pytest.raises(ResearchRejected):
        await private.answer(q.question_id, q.nonce, "RESUME", q.expected_version)
    assert not executor.requests
    clock.now = 1100
    await private.answer(q.question_id, q.nonce, "RESUME", q.expected_version)
    result = await drain(private, ref.job_id)
    assert len(executor.requests) == 6 and len(source_exec.requests) == 2
    assert result.decision.status == "WAIT_REVIEW" and result.question.kind == "REVIEW"


@pytest.mark.asyncio
async def test_unchecked_answer_shapes_have_fixed_errors_without_echo(db, rig):
    _, clock, make = rig
    who, m = manifest(db, public=False)
    _, _, service = setup_service(make, clock, who, m)
    for nonce, version, choice in (
        ("sensitive raw data!", True, "approve"),
        ({"cwd": "/secret"}, 0, "RESUME"),
    ):
        with pytest.raises(ResearchRejected) as caught:
            await service.answer("question", nonce, choice, version)
        assert "sensitive" not in str(caught.value) and "/secret" not in str(caught.value)


@pytest.mark.asyncio
async def test_notice_replay_and_no_trade_are_references_without_new_calls_or_delivery(db, rig):
    _, clock, make = rig
    who, m = manifest(db, public=False, kind="PROPOSAL")
    repo, executor, service = setup_service(make, clock, who, m)
    ref = await service.submit(m.trigger)
    result = await drain(service, ref.job_id)
    await repo.evaluate_job(ref.job_id, result.job.version, abc=abc(m), disposition="NO_TRADE")
    before = db.owner.execute(
        "SELECT count(*) FROM q08_research.research_events_outbox"
    ).fetchone()[0]
    for _ in range(3):
        assert await service.submit(m.trigger) == ref
        result = await service.run_once(ref.job_id, "worker-2")
    assert result.decision.status == "NO_TRADE" and not result.execution_authorized
    assert len(executor.requests) == 8 and sum(x.charged_atoms for x in result.job.costs) == 80
    assert (
        db.owner.execute("SELECT count(*) FROM q08_research.research_events_outbox").fetchone()[0]
        == before
    )
    assert (
        db.owner.execute(
            "SELECT count(*) FROM q08_research.research_events_outbox "
            "WHERE delivery_state<>'PENDING' OR delivery_attempts<>0"
        ).fetchone()[0]
        == 0
    )


@pytest.mark.asyncio
async def test_cancelled_public_producer_cannot_be_activated_as_a_new_private_dependency(db, rig):
    _, clock, make = rig
    public_who, public_m = manifest(db, key="public")
    _, _, public = setup_service(make, clock, public_who, public_m)
    source = await public.submit(public_m.trigger)
    published = await drain(public, source.job_id)
    await public.cancel(source.job_id, published.job.version)
    who, m = manifest(db, public=False, key="consumer", kind="PROPOSAL")
    _, executor, private = setup_service(make, clock, who, m)
    ref = await private.submit(m.trigger)
    with pytest.raises(ResearchRejected):
        await private.attach_public(
            ref.job_id, source, published.job.reports[0].artifact.artifact_id
        )
    assert not (await private.read(ref.job_id)).public_facts and not executor.requests


@pytest.mark.asyncio
async def test_missing_abc_is_a_visible_blocked_result_not_a_ready_proposal(db, rig):
    _, clock, make = rig
    who, m = manifest(db, public=False, kind="PROPOSAL")
    repo = make(who, m, invoices=invoices(m))
    executor = StubResearchExecutor(clock=lambda: clock.now)
    service = service_api().ResearchService(
        repo, executor=executor, clock=lambda: (clock.now, m.policy.clock_epoch)
    )
    ref = await service.submit(m.trigger)
    result = await drain(service, ref.job_id)
    assert result.job.state == "FAILED_REFERENCE" and result.decision.status == "BLOCKED"
    assert result.decision.reasons == ("ABC_DRAFT_REQUIRED",)
    assert len(executor.requests) == 8 and not result.execution_authorized


@pytest.mark.asyncio
async def test_released_shared_capacity_allows_one_original_unsent_dispatch(db, rig):
    _, clock, make = rig
    hwho, hm = manifest(db, key="hold")
    holder, _, hs = setup_service(make, clock, hwho, hm, owner_cap=100)
    href = await hs.submit(hm.trigger)
    claim = await holder.claim_ready(
        href.job_id, "worker-1", (await holder.read_job(href.job_id)).version
    )
    backend = holder.backend(claim)
    await backend.reserve(claim.ready.request, await backend.issue_grant(claim.ready.request))
    who, m = manifest(db, public=False, key="resume")
    repo, executor, s = setup_service(make, clock, who, m, owner_cap=100)
    ref = await s.submit(m.trigger)
    wait = await s.run_once(ref.job_id, "worker-2")
    q = wait.question
    assert wait.job.state == "WAIT_BUDGET"
    await hs.cancel(href.job_id, (await holder.read_job(href.job_id)).version)
    assert (await holder.read_job(href.job_id)).costs[0].state == "RELEASED_UNSENT"
    await s.answer(q.question_id, q.nonce, "RESUME", q.expected_version)
    result = await s.run_once(ref.job_id, "worker-2")
    assert len(executor.requests) == 1 and result.job.costs[0].state == "SETTLED"
    assert len(result.job.roles) == 1 and result.job.roles[0].owner_epoch == 2


@pytest.mark.asyncio
async def test_partial_review_refreshes_question_then_cancel_remains_actionable(db, rig):
    _, clock, make = rig
    who, m = manifest(db, public=False, kind="PROPOSAL")
    _, executor, s = setup_service(make, clock, who, m)
    ref = await s.submit(m.trigger)
    wait = await drain(s, ref.job_id)
    old = wait.question
    partial = save_approval(db, who, m, missing=True)
    result = await s.review(ref.job_id, wait.job.version, partial.reference_id)
    assert result.question.question_id != old.question_id
    assert result.question.expected_version == result.job.version
    q = result.question
    cancelled = await s.answer(q.question_id, q.nonce, "CANCEL", q.expected_version)
    assert cancelled.job.state == "CANCELLED" and len(executor.requests) == 8


@pytest.mark.asyncio
async def test_expired_public_dependency_becomes_persistent_wait_without_dispatch(db, rig):
    _, clock, make = rig
    pwho, pm = manifest(db, key="short-public")
    pm = j.compile_manifest(
        pwho,
        pm.trigger,
        changed(
            pm.policy,
            models=tuple(
                changed(x, policy=changed(x.policy, valid_until_ms=2000)) for x in pm.policy.models
            ),
        ),
    )
    _, _, public = setup_service(make, clock, pwho, pm)
    source = await public.submit(pm.trigger)
    published = await drain(public, source.job_id)
    who, m = manifest(db, public=False, key="long-private", kind="PROPOSAL")
    # Source/consumer per-role model contracts must match. Their respective job deadlines differ.
    m = j.compile_manifest(who, m.trigger, changed(m.policy, models=pm.policy.models))
    _, executor, s = setup_service(make, clock, who, m)
    ref = await s.submit(m.trigger)
    for report in published.job.reports:
        await s.attach_public(ref.job_id, source, report.artifact.artifact_id)
    clock.now = 2000
    result = await s.run_once(ref.job_id, "worker-1")
    assert result.job.state == "WAIT_DATA" and not executor.requests
    assert not result.job.current_data


@pytest.mark.asyncio
async def test_public_dependency_wait_has_a_native_service_entry_not_sql_injection(db, rig):
    _, clock, make = rig
    pwho, pm = manifest(db, key="public")
    _, _, p = setup_service(make, clock, pwho, pm)
    source = await p.submit(pm.trigger)
    who, m = manifest(db, public=False, key="private", kind="PROPOSAL")
    _, executor, s = setup_service(make, clock, who, m)
    ref = await s.submit(m.trigger)
    wait = await s.wait_for_public(ref.job_id, (await s.read(ref.job_id)).job.version, source)
    assert wait.job.state == "WAIT_DATA" and wait.question.public_source == source
    for _ in range(2):
        await s.run_once(ref.job_id, "worker-1")
    assert not executor.requests


@pytest.mark.asyncio
async def test_sibling_result_cannot_erase_an_unanswered_budget_wait(db, rig):
    import asyncio

    _, clock, make = rig
    who, m = manifest(db, public=False)
    _, executor, s = setup_service(make, clock, who, m, owner_cap=100)
    executor.block = True
    ref = await s.submit(m.trigger)
    active = asyncio.create_task(s.run_once(ref.job_id, "worker-1"))
    await asyncio.wait_for(executor.entered.wait(), 5)
    wait = await s.run_once(ref.job_id, "worker-2")
    assert wait.job.state == "WAIT_BUDGET" and wait.question_state == "OPEN"
    executor.release.set()
    result = await active
    assert result.job.state == "WAIT_BUDGET" and result.question_state == "OPEN"
    assert result.question.expected_version == result.job.version
    q = result.question
    assert (
        await s.answer(q.question_id, q.nonce, "CANCEL", q.expected_version)
    ).job.state == "CANCELLED"
    assert len(executor.requests) == 1


@pytest.mark.asyncio
async def test_public_source_served_from_cache_can_feed_a_private_consumer(db, rig):
    _, clock, make = rig
    who, original = manifest(db, key="public-original")
    _, _, first = setup_service(make, clock, who, original)
    ref = await first.submit(original.trigger)
    await drain(first, ref.job_id)
    who, cached = manifest(db, key="public-cache")
    _, cached_executor, second = setup_service(make, clock, who, cached)
    proxy = await second.submit(cached.trigger)
    published = await drain(second, proxy.job_id)
    assert not cached_executor.requests and all(r.origin == "CACHE" for r in published.job.reports)
    who, m = manifest(db, public=False, key="private-proxy", kind="PROPOSAL")
    _, executor, s = setup_service(make, clock, who, m)
    private = await s.submit(m.trigger)
    wait = await s.wait_for_public(
        private.job_id, (await s.read(private.job_id)).job.version, proxy
    )
    for report in published.job.reports:
        await s.attach_public(private.job_id, proxy, report.artifact.artifact_id)
    q = wait.question
    await s.answer(q.question_id, q.nonce, "RESUME", q.expected_version)
    result = await drain(s, private.job_id)
    assert len(executor.requests) == 6 and result.decision.status == "WAIT_REVIEW"
    assert all(x.manifest.manifest_sha256 == cached.manifest_sha256 for x in result.public_facts)


@pytest.mark.asyncio
@pytest.mark.parametrize("bound", ["deadline", "root_quote", "role_quote"])
async def test_cached_proxy_does_not_extend_original_producer_bounds(db, rig, bound):
    _, clock, make = rig
    who, m = manifest(db, key="original")
    p = m.policy
    if bound == "deadline":
        p = changed(p, deadline_ms=1500)
    elif bound == "root_quote":
        p = changed(p, quote=changed(p.quote, valid_until_ms=1500))
    else:
        p = changed(
            p,
            models=tuple(
                changed(x, quote=changed(x.quote, valid_until_ms=1500))
                if x.role_id in {"A01", "A02"}
                else x
                for x in p.models
            ),
        )
    m = j.compile_manifest(who, m.trigger, p)
    _, _, first = setup_service(make, clock, who, m)
    a = await first.submit(m.trigger)
    await drain(first, a.job_id)
    who, proxy_m = manifest(db, key="proxy")
    _, proxy_exec, proxy = setup_service(make, clock, who, proxy_m)
    b = await proxy.submit(proxy_m.trigger)
    published = await drain(proxy, b.job_id)
    assert not proxy_exec.requests
    who, private = manifest(db, public=False, key="consumer", kind="PROPOSAL")
    _, executor, s = setup_service(make, clock, who, private)
    ref = await s.submit(private.trigger)
    for report in published.job.reports:
        await s.attach_public(ref.job_id, b, report.artifact.artifact_id)
    clock.now = 2000
    result = await s.run_once(ref.job_id, "worker-1")
    assert not executor.requests and result.job.state == "WAIT_DATA" and not result.job.current_data


@pytest.mark.asyncio
async def test_each_new_budget_denial_requires_a_fresh_authenticated_resume(db, rig):
    _, clock, make = rig
    who, m = manifest(db, public=False)
    _, executor, s = setup_service(make, clock, who, m, owner_cap=0)
    ref = await s.submit(m.trigger)
    wait = await s.run_once(ref.job_id, "worker-1")
    q = wait.question
    await s.answer(q.question_id, q.nonce, "RESUME", q.expected_version)
    again = await s.run_once(ref.job_id, "worker-2")
    assert again.question_state == "OPEN" and again.question.question_id != q.question_id
    epoch = again.job.roles[0].owner_epoch
    for _ in range(2):
        unchanged = await s.run_once(ref.job_id, "worker-1")
        assert unchanged.job.roles[0].owner_epoch == epoch
    assert not executor.requests
