"""In-process HTTP contracts; no database, provider, paid model or TCP server."""

import subprocess
import sys

import pytest
from fastapi.testclient import TestClient

from stark_trading_os.control.app import create_app
from stark_trading_os.integrations.research_egress import ResearchRejected
from tests.unit.control.test_recommendation_readside import setup

PATH = "/v1/strategy-recommendations"
ORIGIN = "http://127.0.0.1:3000"


@pytest.mark.asyncio
async def test_routes_are_opt_in_and_reads_never_start_control_or_models(monkeypatch):
    side, _, executor, published, _, _ = await setup(monkeypatch)
    with TestClient(create_app(testing=True)) as client:
        assert client.get(PATH, headers={"Origin": ORIGIN}).status_code == 404
    with TestClient(create_app(testing=True, recommendation_readside=side)) as client:
        out = client.get(PATH, headers={"Origin": ORIGIN})
        assert out.status_code == 200 and out.headers["cache-control"] == "no-store"
        body = out.json()
        assert body["nextCursor"] is None and len(body["items"]) == 1
        row = body["items"][0]
        assert row["recommendationId"] == published.recommendationId
        assert row["provenance"]["modelCalls"] == 0
        assert row["authority"]["executionAuthorized"] is False
        assert client.get("/v1/backtests", headers={"Origin": ORIGIN}).status_code == 404
        denied_method = client.post(PATH, headers={"Origin": ORIGIN}, json={})
        assert denied_method.status_code == 405
        assert denied_method.headers["cache-control"] == "no-store"
        assert client.app.state.control_dependencies is None
    assert not executor.requests


@pytest.mark.asyncio
async def test_exact_revision_and_invalid_queries_cannot_supply_candidate_or_head(monkeypatch):
    side, _, _, published, _, _ = await setup(monkeypatch)
    with TestClient(create_app(testing=True, recommendation_readside=side)) as client:
        path = PATH + "/" + published.recommendationId
        out = client.get(path, params={"revision": published.revision}, headers={"Origin": ORIGIN})
        assert out.status_code == 200
        assert out.json()["revision"] == published.revision
        for query in [
            "",
            "?revision=x",
            f"?revision={published.revision}&revision={published.revision}",
            f"?revision={published.revision}&candidate=x",
            f"?revision={published.revision}&scope=PRIVATE",
        ]:
            assert client.get(path + query, headers={"Origin": ORIGIN}).status_code == 400
        assert (
            client.get(path, params={"revision": "f" * 64}, headers={"Origin": ORIGIN}).status_code
            == 404
        )
        assert (
            client.get(
                PATH + "/" + "f" * 64,
                params={"revision": published.revision},
                headers={"Origin": ORIGIN},
            ).status_code
            == 404
        )
        assert (
            client.get(PATH + "?current_candidate=old", headers={"Origin": ORIGIN}).status_code
            == 400
        )


@pytest.mark.asyncio
async def test_expired_get_keeps_hash_and_generation_time(monkeypatch):
    side, _, _, published, _, clock = await setup(monkeypatch)
    with TestClient(create_app(testing=True, recommendation_readside=side)) as client:
        path = PATH + "/" + published.recommendationId
        before = client.get(
            path, params={"revision": published.revision}, headers={"Origin": ORIGIN}
        ).json()
        clock["now"] = published.expiresAt
        after = client.get(
            path, params={"revision": published.revision}, headers={"Origin": ORIGIN}
        ).json()
        assert before["contentHash"] == after["contentHash"]
        assert before["generatedAt"] == after["generatedAt"]
        assert after["currentEligibility"]["status"] == "blocked"


@pytest.mark.asyncio
@pytest.mark.parametrize("denied", [True, False, "keyerror"])
async def test_unavailable_authority_never_serves_cached_success_or_leaks_errors(
    monkeypatch, denied
):
    side, reader, _, published, _, _ = await setup(monkeypatch)

    async def fail(job_id):
        if denied is True:
            raise ResearchRejected("DENIED")
        if denied == "keyerror":
            raise KeyError("PRIVATE_DETAIL_MUST_NOT_LEAK")
        raise RuntimeError("PRIVATE_DETAIL_MUST_NOT_LEAK")

    monkeypatch.setattr(reader._repository, "read_workflow", fail)
    with TestClient(create_app(testing=True, recommendation_readside=side)) as client:
        for path in [
            PATH,
            PATH + "/" + published.recommendationId + "?revision=" + published.revision,
        ]:
            out = client.get(path, headers={"Origin": ORIGIN})
            assert out.status_code == (404 if denied is True else 503)
            assert "PRIVATE_DETAIL" not in out.text and "items" not in out.json()
            assert out.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
async def test_origin_and_exclusive_assembly_keep_the_original_boundaries(monkeypatch):
    side, _, _, _, _, _ = await setup(monkeypatch)
    with TestClient(create_app(testing=True, recommendation_readside=side)) as client:
        wrong_origin = client.get(PATH, headers={"Origin": "https://untrusted.invalid"})
        assert wrong_origin.status_code == 403
        assert wrong_origin.headers["cache-control"] == "no-store"
        for headers, status in [({}, 403), ({"Origin": ORIGIN, "Forwarded": "host=evil"}, 400)]:
            out = client.get(PATH, headers=headers)
            assert out.status_code == status and out.headers["cache-control"] == "no-store"
        for method, url, status in [("HEAD", PATH, 405), ("GET", PATH + "/", 307)]:
            out = client.request(method, url, headers={"Origin": ORIGIN}, follow_redirects=False)
            assert out.status_code == status and out.headers["cache-control"] == "no-store"
    for options in [
        {"dependency_factory": lambda: None},
        {"public_data_enabled": True},
        {"strategy_reference_only": True},
    ]:
        with pytest.raises(ValueError):
            create_app(testing=True, recommendation_readside=side, **options)
    with pytest.raises(ValueError):
        create_app(testing=True, recommendation_readside=object())


def test_new_imports_are_cold_and_zero_io():
    code = """
import socket, sqlite3, threading, asyncio, psycopg
def forbidden(*a, **kw): raise AssertionError('UNEXPECTED_IO')
socket.getaddrinfo = socket.create_connection = socket.socket.connect = forbidden
sqlite3.connect = psycopg.connect = forbidden
threading.Thread.start = asyncio.create_task = forbidden
from stark_trading_os.control.research.recommendation_readside import RecommendationReadSide
from stark_trading_os.control.routes import recommendations
print('ZERO_IO')
"""
    result = subprocess.run(
        [sys.executable, "-B", "-c", code], capture_output=True, text=True, timeout=30
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ZERO_IO"
