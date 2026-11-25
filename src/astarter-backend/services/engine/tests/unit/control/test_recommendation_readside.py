"""Public read composition over the real service, with only DAL IO replaced."""

import importlib

import pytest

from stark_trading_os.control.research.opportunity_reader import read_recommendation
from stark_trading_os.integrations.research_egress import ResearchRejected
from tests.unit.control.test_opportunity_recommendation_reader import request, service, workflow
from tests.unit.domain.test_opportunity_recommendations import change


def api():
    name = "stark_trading_os.control.research.recommendation_readside"
    assert importlib.util.find_spec(name), "public recommendation readside is missing"
    return importlib.import_module(name)


async def setup(monkeypatch):
    view = workflow()
    reader, executor = service(monkeypatch, view)
    value, ctx = request(view)
    published = await read_recommendation(
        reader, job_id="fixture-job", candidate=value, context=ctx, now_ms=1200
    )
    clock = {"now": 1200}
    side = api().RecommendationReadSide(reader, (published,), clock_ms=lambda: clock["now"])
    return side, reader, executor, published, view, clock


@pytest.mark.asyncio
async def test_exact_read_preserves_publication_and_reads_dal_once(monkeypatch):
    side, reader, executor, published, view, clock = await setup(monkeypatch)
    calls = []

    async def read(job_id):
        calls.append(job_id)
        return view

    monkeypatch.setattr(reader._repository, "read_workflow", read)
    clock["now"] = 1300
    row = await side.read(published.recommendationId, published.revision)
    assert calls == ["fixture-job"]
    assert row["provenance"]["decisionAt"] == 1200 and row["generatedAt"] == 1100
    assert row["currentEligibility"]["evaluatedAt"] == 1300
    assert not row["currentEligibility"]["canPrepare"] and not executor.requests
    assert row == await side.read(published.recommendationId, published.revision)


@pytest.mark.asyncio
async def test_missing_or_wrong_revision_never_substitutes_current_result(monkeypatch):
    side, reader, _, published, _, _ = await setup(monkeypatch)

    async def forbidden(job_id):
        raise AssertionError("lookup must fail before DAL")

    monkeypatch.setattr(reader._repository, "read_workflow", forbidden)
    for identifier, revision in [
        ("f" * 64, published.revision),
        (published.recommendationId, "f" * 64),
    ]:
        with pytest.raises(api().RecommendationNotFound):
            await side.read(identifier, revision)


@pytest.mark.asyncio
async def test_current_source_revision_cannot_upgrade_or_replace_old_content(monkeypatch):
    side, reader, _, published, view, _ = await setup(monkeypatch)
    before = await side.read(published.recommendationId, published.revision)

    async def read(job_id):
        return change(view, job=change(view.job, version=view.job.version + 1))

    monkeypatch.setattr(reader._repository, "read_workflow", read)
    after = await side.read(published.recommendationId, published.revision)
    assert after["contentHash"] == before["contentHash"]
    assert after["currentEligibility"]["status"] == "blocked"
    assert "RECOMMENDATION_REVISION_CHANGED" in after["currentEligibility"]["reasonCodes"]
    assert {k: v for k, v in after.items() if k != "currentEligibility"} == {
        k: v for k, v in before.items() if k != "currentEligibility"
    }


@pytest.mark.asyncio
async def test_expiry_and_cancel_preserve_history_but_block_current_use(monkeypatch):
    side, reader, _, published, view, clock = await setup(monkeypatch)
    before = await side.read(published.recommendationId, published.revision)
    clock["now"] = published.expiresAt
    after = await side.read(published.recommendationId, published.revision)
    assert not after["currentEligibility"]["canPrepare"]
    assert after["contentHash"] == before["contentHash"]
    assert after["currentEligibility"]["status"] == "blocked"
    clock["now"] = 1200

    async def read(job_id):
        return change(view, job=change(view.job, state="CANCELLED"))

    monkeypatch.setattr(reader._repository, "read_workflow", read)
    after = await side.read(published.recommendationId, published.revision)
    assert "RESEARCH_BLOCKED" in after["currentEligibility"]["reasonCodes"]
    assert after["contentHash"] == before["contentHash"]


@pytest.mark.asyncio
async def test_dal_denial_does_not_fallback_to_published_content(monkeypatch):
    side, reader, _, published, _, _ = await setup(monkeypatch)

    async def read(job_id):
        raise ResearchRejected("DENIED")

    monkeypatch.setattr(reader._repository, "read_workflow", read)
    with pytest.raises(ResearchRejected, match="DENIED"):
        await side.read(published.recommendationId, published.revision)
    with pytest.raises(ResearchRejected, match="DENIED"):
        await side.list()


@pytest.mark.asyncio
async def test_catalog_configuration_is_bounded_exact_and_never_private(monkeypatch):
    side, reader, _, published, _, _ = await setup(monkeypatch)
    assert len(await side.list()) == 1
    for rows in [(published, published), tuple([published] * 51), [published]]:
        with pytest.raises(ValueError):
            api().RecommendationReadSide(reader, rows, clock_ms=lambda: 1200)
    with pytest.raises(ValueError):
        api().RecommendationReadSide(object(), (published,), clock_ms=lambda: 1200)
    private = published.model_dump(mode="json")
    private["candidate"]["visibility"] = {"visibility": "PRIVATE", "owner": "other"}
    with pytest.raises(ValueError):
        api().RecommendationReadSide(reader, (private,), clock_ms=lambda: 1200)


@pytest.mark.asyncio
async def test_read_clock_is_server_bound_and_strict(monkeypatch):
    side, _, _, published, _, clock = await setup(monkeypatch)
    for invalid in [True, 1200.0, -1, 1199]:
        clock["now"] = invalid
        with pytest.raises((ValueError, ResearchRejected)):
            await side.read(published.recommendationId, published.revision)
