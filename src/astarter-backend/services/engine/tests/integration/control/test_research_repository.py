"""Task3: real isolated PG17 transactions, synthetic time/receipts, no providers."""

# ruff: noqa: E402
import asyncio
import hashlib
import importlib
import importlib.util
import json
import os
import re
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import pytest

if not os.environ.get("Q08_TEST_ROOT"):
    pytest.skip("owned Q08 local fixture required", allow_module_level=True)

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

from stark_trading_os.control.astarter import strategy_repository as r
from stark_trading_os.control.postgres.identity import Principal
from stark_trading_os.control.postgres.strategy_repository import PostgresStrategyRepository
from stark_trading_os.domain import research_jobs as j
from stark_trading_os.domain import strategy_contracts as c
from stark_trading_os.integrations.contracts import ModelResult, Usage
from stark_trading_os.integrations.research_delivery import make_artifact, semantic_key
from stark_trading_os.integrations.research_egress import ChargeObservation, ResearchRejected
from stark_trading_os.integrations.research_gate import OutcomeObservation, ResearchClaim
from tests.integration.control.test_research_schema import baseline as baseline
from tests.integration.control.test_research_schema import migrate, open_pool
from tests.unit.domain.test_research_jobs import dict_to_output, policy, principal, trigger


def api():
    name = "stark_trading_os.control.postgres.research_repository"
    assert importlib.util.find_spec(name) is not None, "persistent ResearchBackend is missing"
    return importlib.import_module(name)


@dataclass
class Clock:
    now: int = 1000


@pytest.fixture
def db(baseline):
    migrate(baseline)
    try:
        yield baseline
    finally:
        baseline.owner.close()
        root = Path(os.environ["Q08_TEST_ROOT"])
        a = json.loads((root / "root-socket-authorization.json").read_text())
        alias = Path(os.environ["Q08_TEST_SOCKET"])
        assert alias.is_symlink() and alias.resolve() == root / "socket"
        assert alias.lstat().st_ino == a["alias_inode"] and alias.lstat().st_uid == os.getuid()
        assert re.fullmatch(r"q08_[0-9a-f]{32}", baseline.database)
        with psycopg.connect(
            **baseline.base, user="pg1_owner", dbname="postgres", autocommit=True
        ) as admin:
            assert admin.execute("SHOW data_directory").fetchone()[0] == str(root / "pgdata")
            assert admin.execute("SHOW listen_addresses").fetchone()[0] == ""
            admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(baseline.database)))


@pytest.fixture
def rig(db, monkeypatch):
    clock = Clock()
    pools = []

    def make(who, m, **kw):
        q = api()
        monkeypatch.setattr(q, "_now_ms", lambda connection: clock.now)
        p = open_pool(db, reader=who.role == "reader")
        pools.append(p)
        authority = q.SyntheticAuthority(policy=m.policy, **kw)
        return q.PostgresResearchRepository(p, who, authority)

    yield api, clock, make
    for p in pools:
        p.close()


def manifest(db, *, public=True, key="job-1", subject="principal-a", kind="FACTS"):
    model_policy = policy().model_dump()
    model_policy["deadline_ms"] = 100000
    model_policy["quote"]["valid_until_ms"] = 120000
    for model in model_policy["models"]:
        model["policy"]["valid_until_ms"] = 120000
        model["quote"]["valid_until_ms"] = 120000
    model_policy = j.PolicySnapshotV1.model_validate(model_policy)
    original = trigger(kind="FACTS", public=True).evidence[0]
    source = original.source.model_dump() | {
        "expires_at_ms": 120000,
        "rights_until_ms": 120000,
        "max_age_ms": 120000,
    }
    if public:
        who = principal(True)
        cur = db.owner.cursor(row_factory=dict_row)
        row = cur.execute(
            "SELECT * FROM pg1_control.astarter_plan_versions ORDER BY ordinal LIMIT 1"
        ).fetchone()
        instrument = r._decode(row, r.PlanRecord, row["scope_id"]).bundle.plan.instrument
        source["subject_sha256"] = c.contract_hash(instrument)
        public_subject = trigger(public=True).public_subject.model_copy(
            update={"instrument": instrument}
        )
        evidence = (
            j.JobEvidenceV1(
                source=c.EvidenceSnapshot.model_validate(source),
                text=original.text,
                egress_allowed=True,
            ),
        )
        t = trigger(
            public=True,
            kind=kind,
            job_id=key,
            event_id="event-" + key,
            logical_request_id="request-" + key,
            evidence=evidence,
            public_subject=public_subject,
        )
    else:
        cur = db.owner.cursor(row_factory=dict_row)
        row = cur.execute("SELECT * FROM pg1_control.astarter_strategy_scopes LIMIT 1").fetchone()
        assignment = r._decode(row, r.ScopeAssignment, row["scope_id"])
        saved = cur.execute(
            "SELECT * FROM pg1_control.astarter_plan_versions ORDER BY ordinal LIMIT 1"
        ).fetchone()
        old = r._decode(saved, r.PlanRecord, row["scope_id"]).bundle.plan
        source["subject_sha256"] = c.contract_hash(old.instrument)
        evidence = (
            j.JobEvidenceV1(
                source=c.EvidenceSnapshot.model_validate(source),
                text=original.text,
                egress_allowed=True,
            ),
        )
        plan = c.PlanRevision.model_validate(
            old.model_dump()
            | {
                "plan_id": "plan-" + key,
                "expires_at_ms": 120000,
                "evidence_sha256s": tuple(c.contract_hash(e.source) for e in evidence),
            }
        )
        p = open_pool(db)
        try:
            repo = PostgresStrategyRepository(
                p, principal_source := Principal(subject, assignment, "writer")
            )
            repo.save_plan(
                c.PreflightInput(plan=plan, evidence=tuple(e.source for e in evidence)),
                request_key="plan-" + key,
                expected_revision=None,
                now_ms=1000,
            )
        finally:
            p.close()
        who = principal_source
        t = trigger(
            plan=plan,
            public=False,
            kind=kind,
            job_id=key,
            event_id="event-" + key,
            logical_request_id="request-" + key,
            evidence=evidence,
        )
    return who, j.compile_manifest(who, t, model_policy)


async def claimed(repo, m, worker="worker-1"):
    ref = await repo.submit_job(m)
    view = await repo.read_job(ref.job_id)
    claim = await repo.claim_ready(ref.job_id, worker, view.version)
    assert claim is not None
    return ref, claim, repo.backend(claim)


@pytest.mark.asyncio
async def test_submit_replay_is_immutable_and_private_reader_is_scoped(db, rig):
    q, clock, make = rig
    q = q()
    who, m = manifest(db, public=False)
    repo = make(who, m)
    ref = await repo.submit_job(m)
    assert await repo.submit_job(m) == ref
    view = await repo.read_job(ref.job_id)
    assert view.manifest == m and not view.execution_authorized and view.state == "RUNNABLE"
    other = make(Principal("principal-b", who.scope, "writer"), m)
    with pytest.raises(ResearchRejected):
        await other.read_job(ref.job_id)
    reader = make(Principal(who.subject, who.scope, "reader"), m)
    assert (await reader.read_job(ref.job_id)).manifest == m
    with pytest.raises(ResearchRejected):
        await reader.submit_job(m)


@pytest.mark.asyncio
async def test_only_one_public_producer_and_stale_claim_cannot_start_after_takeover(db, rig):
    q, clock, make = rig
    q = q()
    who, m = manifest(db)
    repo = make(who, m)
    ref, claim, backend = await claimed(repo, m)
    who2, m2 = manifest(db, key="job-2")
    other = make(who2, m2)
    ref2 = await other.submit_job(m2)
    other_claim = await other.claim_ready(
        ref2.job_id, "worker-2", (await other.read_job(ref2.job_id)).version
    )
    assert other_claim is not None and other_claim.ready.role_id != claim.ready.role_id
    clock.now = 32000
    takeover = await repo.claim_ready(
        ref.job_id, "worker-2", (await repo.read_job(ref.job_id)).version
    )
    assert takeover is not None and takeover.owner_epoch > claim.owner_epoch
    with pytest.raises(ResearchRejected):
        await backend.issue_grant(claim.ready.request)


@pytest.mark.asyncio
async def test_reserve_start_once_and_reopen_never_reissues_a_permit(db, rig):
    q, clock, make = rig
    q = q()
    who, m = manifest(db)
    repo = make(who, m)
    ref, claim, backend = await claimed(repo, m)
    req = claim.ready.request
    granted = await backend.issue_grant(req)
    receipt = await backend.reserve(req, granted)
    assert await backend.reserve(req, granted) == receipt
    permit = await backend.start_once(req, granted, receipt, 90000)
    assert permit and permit.receipt.state == "DISPATCH_STARTED"
    assert await backend.start_once(req, granted, receipt, 90000) is None
    reopened = make(who, m)
    clock.now = 32000
    recovered = await reopened.recover_job(ref.job_id, "worker-2")
    assert recovered.state == "UNKNOWN"
    assert (
        await reopened.inspect_attempt(ref.job_id, req.spec.identity.attempt_id)
    ).state == "UNKNOWN_PENDING_RECONCILE"
    assert await reopened.claim_ready(ref.job_id, "worker-2", recovered.version) is None


@pytest.mark.asyncio
async def test_insufficient_single_scope_rolls_back_the_entire_sim_reservation(db, rig):
    q, clock, make = rig
    q = q()
    who, m = manifest(db)
    repo = make(who, m, owner_cap=0)
    _, claim, backend = await claimed(repo, m)
    req = claim.ready.request
    with pytest.raises(ResearchRejected, match="BUDGET_DENIED"):
        await backend.reserve(req, await backend.issue_grant(req))
    assert await repo.inspect_attempt(m.trigger.job_id, req.spec.identity.attempt_id) is None
    assert (
        db.owner.execute("SELECT count(*) FROM q08_research.research_reservations").fetchone()[0]
        == 0
    )


def bill(req, atoms=35):
    return ChargeObservation(
        task_id=req.spec.identity.task_id,
        attempt_id=req.spec.identity.attempt_id,
        key_owner_id=req.spec.identity.key_owner_id,
        provider=req.spec.policy.providers[0],
        request_id="response-" + hashlib.sha256(req.spec.identity.attempt_id.encode()).hexdigest(),
        unit_id="SIM_MODEL_CREDIT_V1",
        scale=6,
        atoms=atoms,
        source_ref="synthetic-invoice",
        source_revision="invoice-v1",
        event_id="invoice-" + hashlib.sha256(req.spec.identity.attempt_id.encode()).hexdigest(),
    )


def observed(req, charge, now=1000):
    out = dict_to_output("REVIEW", tuple(e.evidence_id for e in req.spec.task.evidence))
    model = ModelResult(
        task_id=req.spec.identity.task_id,
        role_id=req.spec.task.role_id,
        profile_version=req.spec.task.profile_version,
        requested_model=req.spec.policy.model,
        status="OK",
        purpose="OFFLINE_FIXTURE",
        started_at_ms=now,
        completed_at_ms=now,
        output=out,
        usage=Usage(status="REPORTED", cost_credits="0"),
        response_id=charge.request_id,
        returned_provider=charge.provider,
        returned_model=req.spec.policy.model,
        attempts=1,
        response_sha256=hashlib.sha256(charge.request_id.encode()).hexdigest(),
    )
    return OutcomeObservation(model_result=model, charge=charge, scenario_revision="q08-fixture-v1")


async def started(repo, m):
    ref, claim, backend = await claimed(repo, m)
    req = claim.ready.request
    granted = await backend.issue_grant(req)
    receipt = await backend.reserve(req, granted)
    permit = await backend.start_once(req, granted, receipt, 90000)
    assert permit is not None
    return ref, claim, backend, permit.receipt


@pytest.mark.asyncio
async def test_trusted_settlement_publication_cache_and_logical_cost_are_not_duplicated(db, rig):
    q, clock, make = rig
    q = q()
    who, m = manifest(db)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    repo = make(who, m, invoices=(invoice,))
    ref, claim, backend, receipt = await started(repo, m)
    obs = observed(req, invoice)
    settled = await backend.record_outcome(req, receipt, obs, "OK")
    assert settled.state == "SETTLED" and settled.charged_atoms == 35
    assert await backend.record_outcome(req, receipt, obs, "OK") == settled
    art = make_artifact(
        req, obs.model_result.output, artifact_id="artifact-a01", created_at_ms=1000
    )
    logical = await backend.claim_or_join(req, art.semantic_key)
    assert await backend.publish_artifact(req, logical, art, settled) == art
    assert await backend.publish_artifact(req, logical, art, settled) == art
    view = await repo.read_job(ref.job_id)
    assert len(view.costs) == 1 and view.costs[0].charged_atoms == 35
    rows = db.owner.execute(
        "SELECT spent_atoms FROM q08_research.research_budget_scopes"
    ).fetchall()
    assert len(rows) == 5 and {x[0] for x in rows} == {35}
    who2, m2 = manifest(db, key="job-cache")
    cached = make(who2, m2)
    ref2 = await cached.submit_job(m2)
    next_claim = await cached.claim_ready(
        ref2.job_id, "worker-2", (await cached.read_job(ref2.job_id)).version
    )
    assert next_claim is not None and next_claim.ready.role_id == "A02"
    assert len((await cached.read_job(ref2.job_id)).costs) == 0
    assert (
        db.owner.execute("SELECT count(*) FROM q08_research.research_consumers").fetchone()[0] == 1
    )


@pytest.mark.asyncio
async def test_untrusted_charge_stays_unknown_and_cancel_only_releases_unsent(db, rig):
    q, clock, make = rig
    q = q()
    who, m = manifest(db)
    repo = make(who, m)
    ref, claim, backend, receipt = await started(repo, m)
    req = claim.ready.request
    unknown = await backend.record_outcome(req, receipt, observed(req, bill(req)), "OK")
    assert unknown.state == "UNKNOWN_PENDING_RECONCILE" and unknown.charged_atoms is None
    cancelled = await repo.cancel_job(ref.job_id, (await repo.read_job(ref.job_id)).version)
    assert cancelled.state == "CANCELLED"
    assert (
        await repo.inspect_attempt(ref.job_id, req.spec.identity.attempt_id)
    ).state == "UNKNOWN_PENDING_RECONCILE"
    assert {
        x[0]
        for x in db.owner.execute("SELECT unknown_atoms FROM q08_research.research_budget_scopes")
    } == {100}


@pytest.mark.asyncio
async def test_reopen_can_finish_known_outcome_without_model_or_second_charge(db, rig):
    q, clock, make = rig
    q = q()
    who, m = manifest(db)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    repo = make(who, m, invoices=(invoice,))
    ref, claim, backend, receipt = await started(repo, m)
    await backend.record_outcome(req, receipt, observed(req, invoice), "OK")
    reopened = make(who, m, invoices=(invoice,))
    clock.now = 32000
    view = await reopened.recover_job(ref.job_id, "worker-2")
    assert view.state == "RUNNABLE"
    assert (
        db.owner.execute("SELECT count(*) FROM q08_research.research_artifacts").fetchone()[0] == 1
    )
    assert {
        x[0]
        for x in db.owner.execute("SELECT spent_atoms FROM q08_research.research_budget_scopes")
    } == {35}
    with pytest.raises(ResearchRejected):
        await backend.issue_grant(req)


@pytest.mark.asyncio
async def test_publication_commit_rejection_leaves_cost_but_no_half_result(db, rig, monkeypatch):
    q, clock, make = rig
    q = q()
    who, m = manifest(db)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    repo = make(who, m, invoices=(invoice,))
    ref, claim, backend, receipt = await started(repo, m)
    obs = observed(req, invoice)
    settled = await backend.record_outcome(req, receipt, obs, "OK")
    art = make_artifact(
        req, obs.model_result.output, artifact_id="artifact-rollback", created_at_ms=1000
    )
    logical = await backend.claim_or_join(req, art.semantic_key)

    def reject(connection):
        connection.execute("ROLLBACK")
        raise psycopg.errors.CheckViolation()

    monkeypatch.setattr(repo._pool, "_commit", reject)
    from stark_trading_os.control.postgres.pool import PersistenceUnavailable

    with pytest.raises(PersistenceUnavailable):
        await backend.publish_artifact(req, logical, art, settled)
    assert (
        db.owner.execute("SELECT count(*) FROM q08_research.research_artifacts").fetchone()[0] == 0
    )
    assert (
        db.owner.execute(
            "SELECT count(*) FROM q08_research.research_events_outbox "
            "WHERE kind='ARTIFACT_PUBLISHED'"
        ).fetchone()[0]
        == 0
    )
    assert {
        x[0]
        for x in db.owner.execute("SELECT spent_atoms FROM q08_research.research_budget_scopes")
    } == {35}


@pytest.mark.asyncio
async def test_two_pools_claim_same_job_cas_and_last_owner_budget_atomically(db, rig):
    _, clock, make = rig
    who, m = manifest(db, public=False)
    repo = make(who, m, owner_cap=100)
    peer = make(who, m, owner_cap=100)
    ref = await repo.submit_job(m)
    version = (await repo.read_job(ref.job_id)).version
    outcomes = await asyncio.gather(
        repo.claim_ready(ref.job_id, "worker-1", version),
        peer.claim_ready(ref.job_id, "worker-2", version),
        return_exceptions=True,
    )
    assert sum(type(x).__name__ == "AttemptClaim" for x in outcomes) == 1
    assert sum(isinstance(x, r.PersistenceConflict) for x in outcomes) == 1
    first = next(x for x in outcomes if type(x).__name__ == "AttemptClaim")
    who2, m2 = manifest(db, public=False, key="job-two")
    other = make(who2, m2, owner_cap=100)
    _, second, backend2 = await claimed(other, m2)
    backends = (repo.backend(first), backend2)
    requests = (first.ready.request, second.ready.request)
    grants = await asyncio.gather(*(b.issue_grant(req) for b, req in zip(backends, requests)))
    reserves = await asyncio.gather(
        *(b.reserve(req, g) for b, req, g in zip(backends, requests, grants)),
        return_exceptions=True,
    )
    assert sum(type(x).__name__ == "BudgetReceipt" for x in reserves) == 1
    assert (
        sum(isinstance(x, ResearchRejected) and x.reason == "BUDGET_DENIED" for x in reserves) == 1
    )
    assert (
        db.owner.execute("SELECT count(*) FROM q08_research.research_reservations").fetchone()[0]
        == 5
    )
    assert (
        db.owner.execute(
            "SELECT reserved_atoms FROM q08_research.research_budget_scopes "
            "WHERE scope_kind='OWNER'"
        ).fetchone()[0]
        == 100
    )


@pytest.mark.asyncio
async def test_heartbeat_preserves_epoch_but_never_revives_an_expired_owner(db, rig):
    _, clock, make = rig
    who, m = manifest(db)
    repo = make(who, m)
    ref, claim, backend = await claimed(repo, m)
    clock.now = 25000
    renewed = await repo.heartbeat(claim)
    assert renewed.owner_epoch == claim.owner_epoch and renewed.claim_id == claim.claim_id
    clock.now = 32000
    other = await repo.claim_ready(
        ref.job_id, "worker-2", (await repo.read_job(ref.job_id)).version
    )
    assert other is not None and other.ready.role_id == "A02"
    owner = db.owner.execute(
        "SELECT owner_epoch,lease_until_ms FROM q08_research.research_role_attempts "
        "WHERE attempt_id=%s",
        (claim.ready.request.spec.identity.attempt_id,),
    ).fetchone()
    assert owner == (claim.owner_epoch, 55000)
    assert await backend.issue_grant(claim.ready.request)
    clock.now = 56000
    with pytest.raises(ResearchRejected):
        await repo.heartbeat(claim)


@pytest.mark.asyncio
async def test_late_registered_invoice_reconciles_unknown_without_a_new_permit(db, rig):
    _, clock, make = rig
    who, m = manifest(db)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    repo = make(who, m)
    ref, claim, backend, receipt = await started(repo, m)
    invoice = bill(req)
    await backend.record_outcome(req, receipt, None, "UNAVAILABLE")
    clock.now = 32000
    late = make(who, m, invoices=(invoice,))
    settled = await late.reconcile_attempt(
        ref.job_id, req.spec.identity.attempt_id, observed(req, invoice)
    )
    assert settled.state == "SETTLED" and settled.charged_atoms == 35
    assert (
        await late.reconcile_attempt(
            ref.job_id, req.spec.identity.attempt_id, observed(req, invoice)
        )
        == settled
    )
    view = await late.recover_job(ref.job_id, "worker-2")
    assert len(view.reports) == 1 and view.state == "RUNNABLE"
    assert {
        x[0]
        for x in db.owner.execute("SELECT unknown_atoms FROM q08_research.research_budget_scopes")
    } == {0}
    assert {
        x[0]
        for x in db.owner.execute("SELECT spent_atoms FROM q08_research.research_budget_scopes")
    } == {35}
    with pytest.raises(ResearchRejected):
        await backend.start_once(req, await backend.issue_grant(req), receipt, 90000)


@pytest.mark.asyncio
async def test_cancel_then_late_invoice_keeps_cost_and_blocks_publication(db, rig):
    _, clock, make = rig
    who, m = manifest(db)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    repo = make(who, m, invoices=(invoice,))
    ref, claim, backend, receipt = await started(repo, m)
    await repo.cancel_job(ref.job_id, (await repo.read_job(ref.job_id)).version)
    await repo.reconcile_attempt(ref.job_id, req.spec.identity.attempt_id, observed(req, invoice))
    clock.now = 32000
    view = await repo.recover_job(ref.job_id, "worker-2")
    assert view.state == "CANCELLED" and view.costs[0].charged_atoms == 35 and not view.reports
    assert (
        db.owner.execute("SELECT count(*) FROM q08_research.research_artifacts").fetchone()[0] == 0
    )


@pytest.mark.asyncio
async def test_public_facts_can_be_referenced_privately_without_relabel_or_new_bill(db, rig):
    _, clock, make = rig
    who, m = manifest(db)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    public = make(who, m, invoices=(invoice,))
    source, claim, backend, receipt = await started(public, m)
    obs = observed(req, invoice)
    settled = await backend.record_outcome(req, receipt, obs, "OK")
    art = make_artifact(
        req, obs.model_result.output, artifact_id="shared-public", created_at_ms=1000
    )
    logical = await backend.claim_or_join(req, art.semantic_key)
    await backend.publish_artifact(req, logical, art, settled)
    private_who, private_m = manifest(db, public=False, key="private-job")
    private = make(private_who, private_m)
    target = await private.submit_job(private_m)
    for _ in range(2):
        result = await private.attach_public_reference(target.job_id, source, art.artifact_id)
        assert result == art and result.descriptor.scope.visibility == "PUBLIC"
    view = await private.read_job(target.job_id)
    assert not view.reports and not view.costs and view.state == "RUNNABLE"
    assert (
        db.owner.execute("SELECT count(*) FROM q08_research.research_consumers").fetchone()[0] == 1
    )
    clock.now = 120001
    with pytest.raises(ResearchRejected):
        await private.attach_public_reference(target.job_id, source, art.artifact_id)


@pytest.mark.asyncio
async def test_one_unknown_attempt_cannot_be_cleared_by_another_successful_role(db, rig):
    _, clock, make = rig
    who, m = manifest(db)
    requests = j.plan_ready_roles(m, (), now_ms=1000).roles
    invoices = tuple(bill(x.request) for x in requests)
    repo = make(who, m, invoices=invoices)
    ref, first, back1, receipt1 = await started(repo, m)
    second = await repo.claim_ready(
        ref.job_id, "worker-2", (await repo.read_job(ref.job_id)).version
    )
    assert second is not None
    req2 = second.ready.request
    back2 = repo.backend(second)
    g2 = await back2.issue_grant(req2)
    r2 = await back2.reserve(req2, g2)
    sent2 = await back2.start_once(req2, g2, r2, 90000)
    await back1.record_outcome(first.ready.request, receipt1, None, "UNAVAILABLE")
    obs = observed(req2, bill(req2))
    settled = await back2.record_outcome(req2, sent2.receipt, obs, "OK")
    item = make_artifact(req2, obs.model_result.output, artifact_id="role-two", created_at_ms=1000)
    logical = ResearchClaim(
        claim_id=second.claim_id, semantic_key=item.semantic_key, kind="PRODUCER"
    )
    await back2.publish_artifact(req2, logical, item, settled)
    view = await repo.read_job(ref.job_id)
    assert (
        view.state == "UNKNOWN"
        and await repo.claim_ready(ref.job_id, "worker-1", view.version) is None
    )


@pytest.mark.asyncio
async def test_expired_unsent_reservation_recovers_without_leaking_budget(db, rig):
    _, clock, make = rig
    who, m = manifest(db)
    repo = make(who, m)
    ref, claim, backend = await claimed(repo, m)
    req = claim.ready.request
    reserved = await backend.reserve(req, await backend.issue_grant(req))
    assert reserved.state == "RESERVED"
    clock.now = 120001
    view = await repo.recover_job(ref.job_id, "worker-2")
    assert view.costs[0].state == "RELEASED_UNSENT" and view.state == "WAIT_DATA"
    assert not view.current_data
    assert {
        x[0]
        for x in db.owner.execute(
            "SELECT reserved_atoms+unknown_atoms+spent_atoms "
            "FROM q08_research.research_budget_scopes"
        )
    } == {0}
    assert (
        db.owner.execute("SELECT permit_id FROM q08_research.research_role_attempts").fetchone()[0]
        is None
    )


@pytest.mark.asyncio
async def test_old_actor_cannot_authorize_cached_use_after_owner_takeover(db, rig):
    _, clock, make = rig
    who, m = manifest(db)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    repo = make(who, m, invoices=(invoice,))
    ref, claim, backend, receipt = await started(repo, m)
    obs = observed(req, invoice)
    settled = await backend.record_outcome(req, receipt, obs, "OK")
    item = make_artifact(
        req, obs.model_result.output, artifact_id="public-cache", created_at_ms=1000
    )
    await backend.publish_artifact(
        req,
        ResearchClaim(claim_id=claim.claim_id, semantic_key=item.semantic_key, kind="PRODUCER"),
        item,
        settled,
    )
    clock.now = 32000
    with pytest.raises(ResearchRejected):
        await backend.authorize_use(req, item)


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["reserve", "start", "outcome", "publish"])
async def test_commit_ack_loss_is_inspected_and_never_repeats_send_or_charge(
    db, rig, monkeypatch, stage
):
    from stark_trading_os.control.postgres.pool import CommitUnknown

    _, clock, make = rig
    who, m = manifest(db)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    repo = make(who, m, invoices=(invoice,))
    ref, claim, backend = await claimed(repo, m)
    grant = await backend.issue_grant(req)
    receipt = None
    sent = None
    settled = None
    if stage != "reserve":
        receipt = await backend.reserve(req, grant)
    if stage in {"outcome", "publish"}:
        sent = await backend.start_once(req, grant, receipt, 90000)
    obs = observed(req, invoice)
    if stage == "publish":
        settled = await backend.record_outcome(req, sent.receipt, obs, "OK")
    original = repo._pool._commit

    def lose_ack(connection):
        original(connection)
        raise psycopg.OperationalError("SYNTHETIC_ACK_LOSS")

    monkeypatch.setattr(repo._pool, "_commit", lose_ack)
    item = make_artifact(
        req, obs.model_result.output, artifact_id="ack-artifact", created_at_ms=1000
    )
    logical = ResearchClaim(
        claim_id=claim.claim_id, semantic_key=item.semantic_key, kind="PRODUCER"
    )
    with pytest.raises(CommitUnknown):
        if stage == "reserve":
            await backend.reserve(req, grant)
        elif stage == "start":
            await backend.start_once(req, grant, receipt, 90000)
        elif stage == "outcome":
            await backend.record_outcome(req, sent.receipt, obs, "OK")
        else:
            await backend.publish_artifact(req, logical, item, settled)
    monkeypatch.setattr(repo._pool, "_commit", original)
    reopened = make(who, m, invoices=(invoice,))
    actual = await reopened.inspect_attempt(ref.job_id, req.spec.identity.attempt_id)
    assert (
        actual.state
        == {
            "reserve": "RESERVED",
            "start": "DISPATCH_STARTED",
            "outcome": "SETTLED",
            "publish": "SETTLED",
        }[stage]
    )
    assert (
        db.owner.execute("SELECT count(*) FROM q08_research.research_reservations").fetchone()[0]
        == 5
    )
    if stage == "start":
        assert await backend.start_once(req, grant, receipt, 90000) is None
    if stage in {"outcome", "publish"}:
        assert actual.charged_atoms == 35
        assert await backend.record_outcome(req, sent.receipt, obs, "OK") == actual
    if stage == "publish":
        assert await backend.publish_artifact(req, logical, item, actual) == item
        assert (
            db.owner.execute("SELECT count(*) FROM q08_research.research_artifacts").fetchone()[0]
            == 1
        )
        assert (
            db.owner.execute(
                "SELECT count(*) FROM q08_research.research_events_outbox WHERE kind='NOTICE'"
            ).fetchone()[0]
            == 1
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("advance", [False, True])
async def test_existing_offline_gate_uses_persistent_port_without_new_service(db, rig, advance):
    from stark_trading_os.integrations.research_gate import (
        ExecutionObservation,
        OfflineResearchGate,
    )

    _, clock, make = rig
    who, m = manifest(db)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    repo = make(who, m, invoices=(invoice,))
    _, claim, backend = await claimed(repo, m)

    class Executor:
        calls = 0

        async def execute_once(self, request, permit, remaining_seconds):
            assert (
                request == req
                and permit.receipt.state == "DISPATCH_STARTED"
                and remaining_seconds > 0
            )
            self.calls += 1
            obs = observed(req, invoice)
            if advance:
                clock.now += 1
            return ExecutionObservation(
                model_result=obs.model_result,
                charge=obs.charge,
                scenario_revision=obs.scenario_revision,
            )

    executor = Executor()
    gate = OfflineResearchGate(
        backend=backend, executor=executor, clock=lambda: (clock.now, m.policy.clock_epoch)
    )
    result = await gate.run(req)
    assert result.status == "READY" and result.origin == "FRESH"
    assert not (await repo.read_job(m.trigger.job_id)).execution_authorized
    assert executor.calls == 1
    cached = await gate.run(req)
    assert cached.status == "READY" and cached.origin == "CACHE" and executor.calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", ["day_cap", "platform_cap"])
async def test_each_global_guard_can_deny_atomically_without_partial_rows(db, rig, scope):
    _, clock, make = rig
    who, m = manifest(db)
    repo = make(who, m, **{scope: 0})
    _, claim, backend = await claimed(repo, m)
    req = claim.ready.request
    with pytest.raises(ResearchRejected, match="BUDGET_DENIED"):
        await backend.reserve(req, await backend.issue_grant(req))
    assert (
        db.owner.execute("SELECT count(*) FROM q08_research.research_budget_scopes").fetchone()[0]
        == 0
    )
    assert (
        db.owner.execute("SELECT count(*) FROM q08_research.research_reservations").fetchone()[0]
        == 0
    )


@pytest.mark.asyncio
async def test_invalid_model_result_still_costs_and_does_not_auto_resume(db, rig):
    _, clock, make = rig
    who, m = manifest(db)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    repo = make(who, m, invoices=(invoice,))
    ref, claim, backend, receipt = await started(repo, m)
    obs = observed(req, invoice)
    invalid = obs.model_copy(
        update={
            "model_result": obs.model_result.model_copy(update={"returned_model": "wrong-model"})
        }
    )
    settled = await backend.record_outcome(req, receipt, invalid, "INVALID_OUTPUT")
    assert settled.charged_atoms == 35
    clock.now = 32000
    view = await repo.recover_job(ref.job_id, "worker-2")
    assert view.state == "WAIT_REVIEW" and not view.reports
    assert await repo.claim_ready(ref.job_id, "worker-2", view.version) is None


@pytest.mark.asyncio
async def test_late_valid_but_expired_result_retains_known_cost_without_publication(db, rig):
    _, clock, make = rig
    who, m = manifest(db)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    repo = make(who, m, invoices=(invoice,))
    ref, claim, backend, receipt = await started(repo, m)
    await backend.record_outcome(req, receipt, observed(req, invoice), "OK")
    clock.now = 120001
    view = await repo.recover_job(ref.job_id, "worker-2")
    assert view.state == "WAIT_DATA" and not view.current_data and not view.reports
    assert view.costs[0].charged_atoms == 35
    assert (
        db.owner.execute("SELECT count(*) FROM q08_research.research_artifacts").fetchone()[0] == 0
    )


@pytest.mark.asyncio
async def test_plan_revision_before_dispatch_denies_old_grant_and_keeps_history(db, rig):
    _, clock, make = rig
    who, m = manifest(db, public=False)
    repo = make(who, m)
    ref, claim, backend = await claimed(repo, m)
    req = claim.ready.request
    grant = await backend.issue_grant(req)
    receipt = await backend.reserve(req, grant)
    prior = m.trigger.plan
    new = c.PlanRevision.model_validate(prior.model_dump() | {"revision": "new-plan-revision"})
    pool = open_pool(db)
    try:
        PostgresStrategyRepository(pool, who).save_plan(
            c.PreflightInput(plan=new, evidence=tuple(x.source for x in m.trigger.evidence)),
            request_key="revision-before-start",
            expected_revision=prior.revision,
            now_ms=1000,
        )
    finally:
        pool.close()
    with pytest.raises(ResearchRejected, match="DENIED"):
        await backend.start_once(req, grant, receipt, 90000)
    view = await repo.read_job(ref.job_id)
    assert not view.current_data and view.manifest == m
    assert view.costs[0].state == "RESERVED"
    assert (
        db.owner.execute("SELECT permit_id FROM q08_research.research_role_attempts").fetchone()[0]
        is None
    )
    cancelled = await repo.cancel_job(ref.job_id, view.version)
    assert cancelled.costs[0].state == "RELEASED_UNSENT"


@pytest.mark.asyncio
async def test_public_reuse_singleflight_is_atomic_across_distinct_jobs_and_pools(db, rig):
    _, clock, make = rig
    who, m = manifest(db)
    who2, m2 = manifest(db, key="parallel-public")
    a, b = make(who, m), make(who2, m2)
    ra, rb = await asyncio.gather(a.submit_job(m), b.submit_job(m2))
    va, vb = await asyncio.gather(a.read_job(ra.job_id), b.read_job(rb.job_id))
    claims = await asyncio.gather(
        a.claim_ready(ra.job_id, "worker-1", va.version),
        b.claim_ready(rb.job_id, "worker-2", vb.version),
    )
    assert all(x is not None for x in claims)
    assert {x.ready.role_id for x in claims} == {"A01", "A02"}
    assert len({x.ready.reuse_key for x in claims}) == 2
    assert (
        db.owner.execute("SELECT count(*) FROM q08_research.research_role_attempts").fetchone()[0]
        == 2
    )


@pytest.mark.asyncio
async def test_private_cache_reuses_only_exact_principal_payer_and_credential(db, rig):
    _, clock, make = rig
    who, m = manifest(db, public=False)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    repo = make(who, m, invoices=(invoice,))
    ref, claim, backend, receipt = await started(repo, m)
    obs = observed(req, invoice)
    settled = await backend.record_outcome(req, receipt, obs, "OK")
    item = make_artifact(
        req, obs.model_result.output, artifact_id="private-result", created_at_ms=1000
    )
    await backend.publish_artifact(
        req,
        ResearchClaim(claim_id=claim.claim_id, semantic_key=item.semantic_key, kind="PRODUCER"),
        item,
        settled,
    )
    t = m.trigger.model_copy(
        update={
            "job_id": "same-private",
            "logical_request_id": "same-request",
            "event_id": "same-event",
        }
    )
    same = j.compile_manifest(who, t, m.policy)
    cached = make(who, same)
    same_ref = await cached.submit_job(same)
    next_claim = await cached.claim_ready(
        same_ref.job_id, "worker-2", (await cached.read_job(same_ref.job_id)).version
    )
    assert next_claim.ready.role_id == "A02"
    assert (await cached.read_job(same_ref.job_id)).reports[0].origin == "CACHE"
    other_who = Principal("principal-b", who.scope, "writer")
    t2 = t.model_copy(
        update={
            "job_id": "other-private",
            "logical_request_id": "other-request",
            "event_id": "other-event",
        }
    )
    other_m = j.compile_manifest(other_who, t2, m.policy)
    other = make(other_who, other_m)
    other_ref = await other.submit_job(other_m)
    for job_id in (ref.job_id, same_ref.job_id):
        with pytest.raises(ResearchRejected):
            await other.read_job(job_id)
    with pytest.raises(ResearchRejected):
        await repo.read_job(other_ref.job_id)
    with pytest.raises(ResearchRejected):
        await other.attach_public_reference(other_ref.job_id, ref, item.artifact_id)
    newclaim = await other.claim_ready(
        other_ref.job_id, "worker-2", (await other.read_job(other_ref.job_id)).version
    )
    assert newclaim.ready.role_id == "A01"
    assert not (await other.read_job(other_ref.job_id)).reports
    models = tuple(
        x.model_copy(
            update={
                "funding": "BYOK",
                "key_owner_id": who.subject,
                "credential_binding_revision": "byok-key-v1",
            }
        )
        for x in m.policy.models
    )
    byok_policy = j.PolicySnapshotV1.model_validate(m.policy.model_dump() | {"models": models})
    byok_trigger = t.model_copy(
        update={
            "job_id": "byok-private",
            "logical_request_id": "byok-request",
            "event_id": "byok-event",
        }
    )
    byok_m = j.compile_manifest(who, byok_trigger, byok_policy)
    byok = make(who, byok_m)
    byok_ref, byok_claim, byok_backend = await claimed(byok, byok_m)
    assert byok_claim.ready.role_id == "A01" and byok_claim.ready.reuse_key != claim.ready.reuse_key
    byok_req = byok_claim.ready.request
    own = await byok_backend.reserve(byok_req, await byok_backend.issue_grant(byok_req))
    assert own.state == "RESERVED" and not (await byok.read_job(byok_ref.job_id)).reports
    await byok.cancel_job(byok_ref.job_id, (await byok.read_job(byok_ref.job_id)).version)


@pytest.mark.asyncio
async def test_frozen_manifest_conflicts_and_config_changes_cannot_hit_old_cache(db, rig):
    _, clock, make = rig
    who, m = manifest(db)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    repo = make(who, m, invoices=(invoice,))
    ref, claim, backend, receipt = await started(repo, m)
    obs = observed(req, invoice)
    settled = await backend.record_outcome(req, receipt, obs, "OK")
    item = make_artifact(
        req, obs.model_result.output, artifact_id="frozen-result", created_at_ms=1000
    )
    await backend.publish_artifact(
        req,
        ResearchClaim(claim_id=claim.claim_id, semantic_key=item.semantic_key, kind="PRODUCER"),
        item,
        settled,
    )
    changes = (
        {"profile_version": "new-profile"},
        {"credential_binding_revision": "new-credential"},
        {"effort": "LOW"},
        {"policy": m.policy.models[0].policy.model_copy(update={"model": "new-model"})},
    )
    for index, change in enumerate(changes):
        models = tuple(
            x.model_copy(update=change) if x.role_id == "A01" else x for x in m.policy.models
        )
        p = j.PolicySnapshotV1.model_validate(m.policy.model_dump() | {"models": models})
        conflict = j.compile_manifest(who, m.trigger, p)
        bad = make(who, conflict)
        with pytest.raises(r.PersistenceConflict):
            await bad.submit_job(conflict)
        t = m.trigger.model_copy(
            update={
                "job_id": f"config-{index}",
                "logical_request_id": f"request-{index}",
                "event_id": f"config-event-{index}",
            }
        )
        different = j.compile_manifest(who, t, p)
        changed = make(who, different)
        newref = await changed.submit_job(different)
        fresh = await changed.claim_ready(
            newref.job_id, "worker-2", (await changed.read_job(newref.job_id)).version
        )
        assert fresh is not None and fresh.ready.role_id == "A01"
        assert (
            fresh.ready.reuse_key != claim.ready.reuse_key
            and not (await changed.read_job(newref.job_id)).reports
        )
        logical = ResearchClaim(
            claim_id=fresh.claim_id, semantic_key=semantic_key(fresh.ready.request), kind="PRODUCER"
        )
        await changed.backend(fresh).finish_claim(fresh.ready.request, logical)


@pytest.mark.asyncio
async def test_settled_unpublished_producer_keeps_singleflight_until_recovery(db, rig):
    _, clock, make = rig
    who, m = manifest(db)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    repo = make(who, m, invoices=(invoice,))
    ref, claim, backend, receipt = await started(repo, m)
    await backend.record_outcome(req, receipt, observed(req, invoice), "OK")
    who2, m2 = manifest(db, key="waiting-public")
    waiter = make(who2, m2)
    otherref = await waiter.submit_job(m2)
    other = await waiter.claim_ready(
        otherref.job_id, "worker-2", (await waiter.read_job(otherref.job_id)).version
    )
    assert other is not None and other.ready.role_id == "A02"
    assert (
        db.owner.execute(
            "SELECT count(*) FROM q08_research.research_role_attempts WHERE role_id='A01'"
        ).fetchone()[0]
        == 1
    )


@pytest.mark.asyncio
async def test_same_invoice_token_different_attempt_is_a_conflict_not_new_cost(db, rig):
    _, clock, make = rig
    who, m = manifest(db, public=False)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    repo = make(who, m, invoices=(invoice,))
    _, claim, backend, receipt = await started(repo, m)
    await backend.record_outcome(req, receipt, observed(req, invoice), "OK")
    who2, m2 = manifest(db, public=False, key="invoice-conflict-job")
    req2 = j.plan_ready_roles(m2, (), now_ms=1000).roles[0].request
    replay = bill(req2).model_copy(update={"event_id": invoice.event_id})
    other = make(who2, m2, invoices=(replay,))
    ref2, claim2, backend2, receipt2 = await started(other, m2)
    with pytest.raises(r.PersistenceConflict, match="SETTLEMENT_CONFLICT"):
        await backend2.record_outcome(req2, receipt2, observed(req2, replay), "OK")
    actual = await other.inspect_attempt(ref2.job_id, req2.spec.identity.attempt_id)
    assert actual.state == "DISPATCH_STARTED" and actual.charged_atoms is None
    assert (
        db.owner.execute(
            "SELECT count(DISTINCT reservation_id) FROM q08_research.research_reservations "
            "WHERE state='SETTLED'"
        ).fetchone()[0]
        == 1
    )


@pytest.mark.asyncio
async def test_cancelled_async_caller_joins_real_commit_and_cannot_resend(db, rig, monkeypatch):
    _, clock, make = rig
    who, m = manifest(db)
    repo = make(who, m)
    ref, claim, backend = await claimed(repo, m)
    req = claim.ready.request
    grant = await backend.issue_grant(req)
    receipt = await backend.reserve(req, grant)
    entered, release = threading.Event(), threading.Event()
    original = repo._pool._commit

    def blocked(connection):
        entered.set()
        assert release.wait(3)
        original(connection)

    monkeypatch.setattr(repo._pool, "_commit", blocked)
    task = asyncio.create_task(backend.start_once(req, grant, receipt, 90000))
    try:
        assert await asyncio.to_thread(entered.wait, 3)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    monkeypatch.setattr(repo._pool, "_commit", original)
    actual = await repo.inspect_attempt(ref.job_id, req.spec.identity.attempt_id)
    assert actual.state == "DISPATCH_STARTED"
    assert await backend.start_once(req, grant, receipt, 90000) is None


@pytest.mark.asyncio
async def test_global_four_live_claims_block_split_jobs_and_cancel_frees_only_unsent(db, rig):
    _, clock, make = rig
    repos = []
    for i in range(3):
        who, m = manifest(db, public=False, key=f"concurrent-{i}")
        repo = make(who, m)
        ref = await repo.submit_job(m)
        repos.append((repo, ref))
    for repo, ref in repos[:2]:
        for i in range(2):
            claim = await repo.claim_ready(
                ref.job_id, f"worker-{i + 1}", (await repo.read_job(ref.job_id)).version
            )
            assert claim is not None
        assert (
            await repo.claim_ready(
                ref.job_id, "worker-1", (await repo.read_job(ref.job_id)).version
            )
            is None
        )
    third, ref3 = repos[2]
    assert (
        await third.claim_ready(
            ref3.job_id, "worker-1", (await third.read_job(ref3.job_id)).version
        )
        is None
    )
    first, ref1 = repos[0]
    cancelled = await first.cancel_job(ref1.job_id, (await first.read_job(ref1.job_id)).version)
    assert cancelled.state == "CANCELLED" and not cancelled.costs
    new = await third.claim_ready(
        ref3.job_id, "worker-1", (await third.read_job(ref3.job_id)).version
    )
    assert new is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", ["permit_deadline", "provider_binding"])
async def test_output_must_match_persisted_permit_time_and_actual_invoice_provider(db, rig, bad):
    _, clock, make = rig
    who, m = manifest(db)
    models = tuple(
        x.model_copy(
            update={
                "policy": x.policy.model_copy(
                    update={"providers": ("fixture-provider", "other-allowed-provider")}
                )
            }
        )
        for x in m.policy.models
    )
    p = j.PolicySnapshotV1.model_validate(m.policy.model_dump() | {"models": models})
    m = j.compile_manifest(who, m.trigger, p)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    repo = make(who, m, invoices=(invoice,))
    ref, claim, backend = await claimed(repo, m)
    grant = await backend.issue_grant(req)
    reserved = await backend.reserve(req, grant)
    permit = await backend.start_once(req, grant, reserved, 2000)
    obs = observed(req, invoice)
    if bad == "permit_deadline":
        clock.now = 2100
        obs = obs.model_copy(
            update={"model_result": obs.model_result.model_copy(update={"completed_at_ms": 2100})}
        )
    else:
        obs = obs.model_copy(
            update={
                "model_result": obs.model_result.model_copy(
                    update={"returned_provider": "other-allowed-provider"}
                )
            }
        )
    settled = await backend.record_outcome(req, permit.receipt, obs, "OK")
    assert settled.charged_atoms == 35
    item = make_artifact(
        req,
        obs.model_result.output,
        artifact_id="ineligible-result",
        created_at_ms=obs.model_result.completed_at_ms,
    )
    with pytest.raises(ResearchRejected, match="INVALID_OUTPUT"):
        await backend.publish_artifact(
            req,
            ResearchClaim(claim_id=claim.claim_id, semantic_key=item.semantic_key, kind="PRODUCER"),
            item,
            settled,
        )
    assert (
        db.owner.execute("SELECT count(*) FROM q08_research.research_artifacts").fetchone()[0] == 0
    )


@pytest.mark.asyncio
async def test_malformed_persisted_budget_fact_raises_fixed_error_without_input_echo(db, rig):
    _, clock, make = rig
    who, m = manifest(db)
    repo = make(who, m)
    ref, claim, backend = await claimed(repo, m)

    def malformed(conn, now):
        job, _ = repo._job(conn, ref.job_id)
        repo._event(
            conn,
            job,
            "ROLE_RESULT",
            "malformed-fact",
            {"type": "BUDGET", "receipt": {"unexpected": "SYNTHETIC_PRIVATE_TEXT"}},
            now,
        )

    await repo._call(True, malformed)
    with pytest.raises(ResearchRejected, match="BINDING_MISMATCH") as caught:
        await repo.inspect_attempt(ref.job_id, claim.ready.request.spec.identity.attempt_id)
    assert "SYNTHETIC_PRIVATE_TEXT" not in str(caught.value)


@pytest.mark.asyncio
async def test_unknown_replay_conflicts_but_trusted_invoice_only_can_enrich_original_result(
    db, rig
):
    _, clock, make = rig
    who, m = manifest(db)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    repo = make(who, m)
    ref, claim, backend, receipt = await started(repo, m)
    obs = observed(req, invoice)
    empty = await backend.record_outcome(req, receipt, None, "UNAVAILABLE")
    unknown = await backend.record_outcome(req, receipt, obs, "OK")
    assert unknown.version == empty.version + 1
    assert await backend.record_outcome(req, unknown, obs, "OK") == unknown
    changed = obs.model_copy(
        update={"model_result": obs.model_result.model_copy(update={"response_sha256": "f" * 64})}
    )
    with pytest.raises(r.PersistenceConflict, match="OUTCOME_CONFLICT"):
        await backend.record_outcome(req, unknown, changed, "OK")
    clock.now = 32000
    reopened = make(who, m, invoices=(invoice,))
    invoice_only = OutcomeObservation(
        model_result=None, charge=invoice, scenario_revision="late-invoice"
    )
    settled = await reopened.reconcile_attempt(
        ref.job_id, req.spec.identity.attempt_id, invoice_only
    )
    assert settled.state == "SETTLED" and settled.charged_atoms == 35
    view = await reopened.recover_job(ref.job_id, "worker-2")
    assert len(view.reports) == 1 and view.reports[0].observation.model_result == obs.model_result


@pytest.mark.asyncio
async def test_over_latency_known_result_recovers_to_review_without_rollback(db, rig):
    _, clock, make = rig
    who, m = manifest(db)
    req = j.plan_ready_roles(m, (), now_ms=1000).roles[0].request
    invoice = bill(req)
    repo = make(who, m, invoices=(invoice,))
    ref, claim, backend = await claimed(repo, m)
    grant = await backend.issue_grant(req)
    reserved = await backend.reserve(req, grant)
    permit = await backend.start_once(req, grant, reserved, 90000)
    obs = observed(req, invoice)
    late = obs.model_copy(
        update={"model_result": obs.model_result.model_copy(update={"completed_at_ms": 7001})}
    )
    clock.now = 7001
    settled = await backend.record_outcome(req, permit.receipt, late, "INVALID_OUTPUT")
    assert settled.charged_atoms == 35
    clock.now = 32000
    view = await repo.recover_job(ref.job_id, "worker-2")
    assert view.state == "WAIT_REVIEW" and not view.reports and view.costs[0] == settled
    assert permit.dispatch_before_ms == 7000


@pytest.mark.asyncio
async def test_invalid_settled_recovery_cannot_mask_other_unknown_liability(db, rig):
    _, clock, make = rig
    who, m = manifest(db)
    invoices = tuple(bill(x.request) for x in j.plan_ready_roles(m, (), now_ms=1000).roles)
    repo = make(who, m, invoices=invoices)
    ref, first, b1, sent1 = await started(repo, m)
    second = await repo.claim_ready(
        ref.job_id, "worker-2", (await repo.read_job(ref.job_id)).version
    )
    b2 = repo.backend(second)
    req2 = second.ready.request
    g2 = await b2.issue_grant(req2)
    r2 = await b2.reserve(req2, g2)
    p2 = await b2.start_once(req2, g2, r2, 90000)
    await b1.record_outcome(first.ready.request, sent1, None, "UNAVAILABLE")
    await b2.record_outcome(
        req2,
        p2.receipt,
        OutcomeObservation(
            model_result=None, charge=bill(req2), scenario_revision="invalid-result"
        ),
        "INVALID_OUTPUT",
    )
    clock.now = 32000
    view = await repo.recover_job(ref.job_id, "worker-2")
    assert view.state == "UNKNOWN" and not view.reports
    assert {x.state for x in view.costs} == {"UNKNOWN_PENDING_RECONCILE", "SETTLED"}
    assert await repo.claim_ready(ref.job_id, "worker-2", view.version) is None
    assert (
        db.owner.execute(
            "SELECT unknown_atoms FROM q08_research.research_budget_scopes WHERE scope_kind='OWNER'"
        ).fetchone()[0]
        == 100
    )


@pytest.mark.asyncio
async def test_dispatch_time_is_sampled_after_required_scope_lock_wait(db, rig, monkeypatch):
    _, clock, make = rig
    who, m = manifest(db, public=False)
    repo = make(who, m)
    ref, claim, backend = await claimed(repo, m)
    req = claim.ready.request
    grant = await backend.issue_grant(req)
    reserved = await backend.reserve(req, grant)
    original = repo._pool.transaction

    class AfterScopeLock:
        def __init__(self, connection):
            self.connection = connection

        def __getattr__(self, name):
            return getattr(self.connection, name)

        def execute(self, statement, *args, **kwargs):
            result = self.connection.execute(statement, *args, **kwargs)
            if statement == "SELECT pg_advisory_xact_lock(%s)":
                clock.now = 32000
            return result

    @contextmanager
    def with_wait(**kwargs):
        with original(**kwargs) as connection:
            yield AfterScopeLock(connection)

    monkeypatch.setattr(repo._pool, "transaction", with_wait)
    with pytest.raises(ResearchRejected):
        await backend.start_once(req, grant, reserved, 90000)
    monkeypatch.setattr(repo._pool, "transaction", original)
    actual = await repo.inspect_attempt(ref.job_id, req.spec.identity.attempt_id)
    assert actual.state == "RESERVED"
    assert (
        db.owner.execute("SELECT permit_id FROM q08_research.research_role_attempts").fetchone()[0]
        is None
    )


@pytest.mark.asyncio
async def test_busy_global_mutex_fails_closed_without_any_partial_claim(db, rig):
    from stark_trading_os.control.postgres.pool import PersistenceUnavailable

    _, clock, make = rig
    who, m = manifest(db)
    repo = make(who, m)
    ref = await repo.submit_job(m)
    before = await repo.read_job(ref.job_id)
    key = int.from_bytes(hashlib.sha256(b"Q08_RESEARCH_MUTATION_V1").digest()[:8], signed=True)
    unsigned = key & ((1 << 64) - 1)
    seen = False
    with db.owner.transaction():
        db.owner.execute("SELECT pg_advisory_xact_lock(%s)", (key,))
        task = asyncio.create_task(repo.claim_ready(ref.job_id, "worker-1", before.version))
        try:
            for _ in range(160):
                seen = db.owner.execute(
                    "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' "
                    "AND classid=%s::oid AND objid=%s::oid AND objsubid=1 AND NOT granted)",
                    (unsigned >> 32, unsigned & ((1 << 32) - 1)),
                ).fetchone()[0]
                if seen or task.done():
                    break
                await asyncio.sleep(0.01)
            with pytest.raises(PersistenceUnavailable, match="PG2_TRANSACTION_FAILED"):
                await task
        finally:
            if not task.done():
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
    assert seen
    after = await repo.read_job(ref.job_id)
    assert after.version == before.version and not after.roles and not after.costs
    assert (
        db.owner.execute("SELECT count(*) FROM q08_research.research_reservations").fetchone()[0]
        == 0
    )
    claim = await repo.claim_ready(ref.job_id, "worker-1", after.version)
    assert claim is not None
