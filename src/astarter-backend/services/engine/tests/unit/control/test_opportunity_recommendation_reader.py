"""R1 read adapter uses the existing service and enforces its DAL identity."""

import importlib
import importlib.util
import socket
import sqlite3
import subprocess
import sys

import pytest

from stark_trading_os.control.postgres import research_repository as repo
from stark_trading_os.control.research.service import ResearchService
from stark_trading_os.domain import research_jobs as jobs
from stark_trading_os.integrations.research_egress import ResearchRejected, digest_text, encode
from tests.stubs.research_executor import StubResearchExecutor
from tests.unit.domain.test_opportunity_recommendations import candidate, change, clock_ref, context
from tests.unit.domain.test_research_jobs import all_reports, manifest


def api():
    name = "stark_trading_os.control.research.opportunity_reader"
    assert importlib.util.find_spec(name) is not None, "R1 read-only adapter is missing"
    return importlib.import_module(name)


def workflow(*, public=True, state="COMPLETED_REFERENCE", current=True):
    m = manifest(public=public, kind="FACTS")
    bundle = jobs.ResearchBundleV1(
        manifest_sha256=m.manifest_sha256, reports=all_reports(m), disposition="RESEARCH_READY"
    )
    view = repo.WorkflowView(
        job=repo.JobView(
            ref=repo.JobRef(
                scope_key=digest_text(encode(m.visibility.model_dump(mode="json"))),
                job_id=m.trigger.job_id,
                manifest_sha256=m.manifest_sha256,
            ),
            manifest=m,
            state=state,
            version=1,
            current_data=current,
            roles=(),
            reports=bundle.reports,
            costs=(),
        ),
        bundle=bundle,
        decision=jobs.check_bundle(bundle, m, now_ms=1200),
    )
    return view


def request(view):
    m = view.job.manifest
    clock = clock_ref("SIM", m.policy.clock_epoch)
    value = candidate(
        clockRef=clock,
        generatedAt=1100,
        opportunityExpiresAt=3500,
        entry=None,
        invalidation=None,
        exits=None,
        protection=None,
        rationale=(
            dict(
                text="Legacy reference, not an entry approval",
                evidenceRefs=(m.trigger.evidence[0].source.evidence_id,),
            ),
        ),
    )
    value = change(value, costs=change(value.costs, state="UNKNOWN", feeBps=None, evidenceRefs=()))
    ctx = context(clockRef=clock)
    return value, ctx


def service(monkeypatch, view, *, denied=False):
    repository = object.__new__(repo.PostgresResearchRepository)

    async def read(job_id):
        assert job_id == "fixture-job"
        if denied:
            raise ResearchRejected("DENIED")
        return view

    monkeypatch.setattr(repository, "read_workflow", read)

    def forbidden(*args, **kwargs):
        raise AssertionError("R1 must never dispatch or open a database/network")

    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    monkeypatch.setattr(sqlite3, "connect", forbidden)
    for name in ["submit_trigger", "claim_ready", "recover_job", "cancel_job", "evaluate_job"]:
        monkeypatch.setattr(repository, name, forbidden)
    executor = StubResearchExecutor(clock=forbidden)
    return ResearchService(repository, executor=executor, clock=forbidden), executor


@pytest.mark.asyncio
async def test_actual_service_read_preserves_reference_clocks_and_never_starts_work(monkeypatch):
    view = workflow()
    reader, executor = service(monkeypatch, view)
    value, ctx = request(view)
    out = await api().read_recommendation(
        reader, job_id="fixture-job", candidate=value, context=ctx, now_ms=1200
    )
    assert out.status == "research" and not out.canPrepare
    assert out.candidate.sourceRef.taskId == "fixture-job"
    assert out.candidate.sourceRef.type == "research"
    original = view.job.manifest.trigger.evidence[0].source
    copied = out.candidate.evidence[0]
    assert (copied.clock.eventAt, copied.clock.availableAt, copied.clock.receivedAt) == (
        original.event_at_ms,
        original.available_at_ms,
        original.received_at_ms,
    )
    assert copied.clock.availabilityKind == "SOURCE"
    assert copied.contentHash == original.content_sha256 and copied.rawHash is None
    assert not executor.requests and not out.authority.executionAuthorized


@pytest.mark.asyncio
async def test_existing_dal_denial_is_not_replaced_by_a_public_result(monkeypatch):
    view = workflow()
    reader, executor = service(monkeypatch, view, denied=True)
    value, ctx = request(view)
    with pytest.raises(ResearchRejected, match="DENIED"):
        await api().read_recommendation(
            reader, job_id="fixture-job", candidate=value, context=ctx, now_ms=1200
        )
    assert not executor.requests


@pytest.mark.asyncio
async def test_private_workflow_cannot_be_relabelled_as_public(monkeypatch):
    view = workflow(public=False)
    reader, _ = service(monkeypatch, view)
    value, ctx = request(view)
    with pytest.raises(ResearchRejected):
        await api().read_recommendation(
            reader, job_id="fixture-job", candidate=value, context=ctx, now_ms=1200
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["CANCELLED", "UNKNOWN", "FAILED_REFERENCE"])
async def test_cancelled_or_unknown_job_never_resurrects_from_its_old_bundle(monkeypatch, state):
    view = workflow(state=state)
    reader, _ = service(monkeypatch, view)
    value, ctx = request(view)
    out = await api().read_recommendation(
        reader, job_id="fixture-job", candidate=value, context=ctx, now_ms=1200
    )
    assert out.status == "blocked" and "RESEARCH_BLOCKED" in out.reasonCodes


@pytest.mark.asyncio
async def test_not_current_job_preserves_history_but_blocks_preparation(monkeypatch):
    view = workflow(current=False)
    reader, _ = service(monkeypatch, view)
    value, ctx = request(view)
    out = await api().read_recommendation(
        reader, job_id="fixture-job", candidate=value, context=ctx, now_ms=1200
    )
    assert out.status == "blocked" and out.candidate.evidence


@pytest.mark.asyncio
async def test_wrong_job_or_tampered_manifest_is_not_a_different_recommendation(monkeypatch):
    view = workflow()
    view = change(view, job=change(view.job, ref=change(view.job.ref, job_id="other-job")))
    reader, _ = service(monkeypatch, view)
    value, ctx = request(view)
    with pytest.raises(ResearchRejected):
        await api().read_recommendation(
            reader, job_id="fixture-job", candidate=value, context=ctx, now_ms=1200
        )


@pytest.mark.asyncio
async def test_rationale_cannot_borrow_evidence_outside_the_authorized_job(monkeypatch):
    view = workflow()
    reader, _ = service(monkeypatch, view)
    value, ctx = request(view)
    value = change(value, rationale=(dict(text="Unrelated result", evidenceRefs=("foreign",)),))
    with pytest.raises(ResearchRejected, match="BINDING_MISMATCH"):
        await api().read_recommendation(
            reader, job_id="fixture-job", candidate=value, context=ctx, now_ms=1200
        )


def test_cold_import_opens_no_network_database_workers_or_research():
    code = """
import asyncio, socket, sqlite3, threading, psycopg
def forbidden(*args, **kwargs):
    raise AssertionError("unexpected IO or scheduler during R1 import")
socket.getaddrinfo = socket.create_connection = socket.socket.connect = forbidden
sqlite3.connect = psycopg.connect = forbidden
asyncio.create_task = threading.Thread.start = forbidden
from stark_trading_os.domain import opportunity_recommendations
from stark_trading_os.control.research import opportunity_reader
print("ZERO_IO")
"""
    result = subprocess.run(
        [sys.executable, "-c", code], text=True, capture_output=True, timeout=30
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ZERO_IO"
