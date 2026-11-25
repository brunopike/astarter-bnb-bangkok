"""Existing adapters through shared DAL; native synthetic PG and fixture wire only."""

# ruff: noqa: E402
import json
import os
import time
from contextlib import asynccontextmanager
from uuid import uuid4

import pytest

if "PG2_TEST_SOCKET" not in os.environ:
    pytest.skip("Explicit owned synthetic cluster required", allow_module_level=True)

from fastapi.testclient import TestClient

from stark_trading_os.control.postgres import public_repository as pr
from stark_trading_os.control.public_data_providers import SharedPublicProviders
from stark_trading_os.control.public_data_shared import create_shared_public_app
from stark_trading_os.integrations.public_data import PublicDataCredentials
from stark_trading_os.integrations.public_data.network import _request_policy
from stark_trading_os.integrations.public_data.response_policy import public_response_headers
from stark_trading_os.integrations.transport import HttpResponse
from tests.integration.control.test_public_pg import MODE, TOKEN, pool, seed
from tests.integration.control.test_public_pg import public_db as public_db


def assets(n=3):
    now = time.time_ns() // 1000000 - 1000
    return [
        dict(
            id=a,
            symbol=s,
            name=s,
            last_updated=now,
            market_cap="1200.250",
            circulating_supply="12.500",
            total_volume=None,
        )
        for a, s in [("bitcoin", "BTC"), ("ethereum", "ETH"), ("solana", "SOL")]
    ][:n]


def news(n=50):
    now = time.time_ns() // 1000000 - 1000
    return {
        "status": 200,
        "data": {
            "data": [
                dict(
                    id=str(i),
                    title=f"{'BTC' if i % 2 else 'ETH'} synthetic {i}",
                    content="fixture",
                    create_time=now - i * 1000,
                    url=f"https://www.theblockbeats.info/flash/{i}",
                )
                for i in range(n)
            ]
        },
    }


def response(body, status=200, headers=()):
    return HttpResponse(status, json.dumps(body).encode(), headers)


class Wire:
    purpose = "OFFLINE_FIXTURE"

    def __init__(self, replies):
        self.replies = replies
        self.sent, self.opened, self.closed = [], [], []

    @asynccontextmanager
    async def factory(self, service):
        wire = self
        self.opened.append(service)

        class Transport:
            purpose = wire.purpose

            async def send(self, request):
                _request_policy(service, request)
                wire.sent.append((service, request.url))  # Fixed URLs only, never headers.
                item = wire.replies[service].pop(0)
                if isinstance(item, Exception):
                    raise item
                _, headers = public_response_headers(
                    service, [(k.encode(), v.encode()) for k, v in item.headers]
                )
                return HttpResponse(item.status, item.body, headers)

        try:
            yield Transport()
        finally:
            self.closed.append(service)


def configured(wire):
    return SharedPublicProviders(
        mode=MODE,
        enabled_scopes=("coingecko", "blockbeats"),
        credentials=PublicDataCredentials(
            coingecko_api_key="synthetic-cg-key", blockbeats_api_key="synthetic-bb-key"
        ),
        transport_factory=wire.factory,
    )


def application(reader, writer=None, config=None):
    return create_shared_public_app(
        reader_pool=pool(reader, False),
        collector_pool=pool(writer) if writer else None,
        mode=MODE,
        providers=config,
        refresh_token=TOKEN if writer else None,
    )


def refresh(client, scope, request_id=None):
    return client.post(
        "/internal/public-data/refresh",
        json={
            "request_id": request_id or str(uuid4()),
            "scope": scope,
        },
        headers={"Authorization": "Bearer " + TOKEN},
    )


def spent(owner, scope):
    return owner.execute(
        "SELECT reserved,total_reserved FROM public_data.budgets WHERE scope=%s", (scope,)
    ).fetchone()


def advance(monkeypatch, owner, scope, extra=1):
    due = owner.execute(
        "SELECT next_at_ms FROM public_data.budgets WHERE scope=%s", (scope,)
    ).fetchone()[0]
    monkeypatch.setattr(pr, "_now", lambda c: due + extra)
    return due + extra


def test_two_instances_share_real_adapter_projection(public_db):
    owner, writer, reader = public_db
    seed(owner)
    wire = Wire({"COINGECKO_ASSETS": [response(assets())], "BLOCKBEATS_NEWS": [response(news())]})
    first, second = application(reader, writer, configured(wire)), application(reader)
    with TestClient(first) as a, TestClient(second) as b:
        for resource in ("assets", "news"):
            assert b.get("/v1/data/" + resource).json()["quality"] == "unavailable"
        for scope in ("coingecko", "blockbeats"):
            req = str(uuid4())
            result = refresh(a, scope, req)
            assert result.status_code == 200 and result.json()["state"] == "COMPLETED"
            assert refresh(a, scope, req).json() == result.json()
            assert spent(owner, scope) == (1, 1)
        all_assets = b.get("/v1/data/assets").json()
        assert all_assets["quality"] == "fresh" and len(all_assets["items"]) == 3
        assert all_assets["mode"] == MODE and all_assets["real_trading_connected"] is False
        btc = a.get("/v1/data/assets?asset_ids=bitcoin&selection_version=7").json()
        assert btc["selection_version"] == 7 and len(btc["items"]) == 1
        assert btc["items"][0]["data"]["market_cap"] == "1200.250"
        assert btc["items"][0]["data"]["total_volume"] is None
        assert btc["items"][0]["event_time_ms"] < btc["items"][0]["received_at_ms"]
        fifty = b.get("/v1/data/news?limit=50").json()
        twenty = a.get("/v1/data/news?limit=20").json()
        assert fifty["items"][:20] == twenty["items"] and len(fifty["items"]) == 50
        assert len([x for x in fifty["items"] if "BTC" in x["data"]["title"]]) == 25
        assert len(wire.sent) == 2 and wire.opened == wire.closed
        assert "size=50" in wire.sent[1][1]
        assert b.post("/internal/public-data/refresh", json={}).status_code == 403
    assert first.state.public_data_calls.pending == set()


@pytest.mark.parametrize(
    "kind,expected",
    [
        ("429", "RATE_LIMITED"),
        ("timeout", "TIMEOUT"),
        ("duplicate", "INVALID_RESPONSE"),
        ("bad-json", "INVALID_RESPONSE"),
        ("future", "INVALID_RESPONSE"),
        ("401", "UNAUTHORIZED"),
    ],
)
@pytest.mark.parametrize(
    "scope,service,resource",
    [
        ("coingecko", "COINGECKO_ASSETS", "assets"),
        ("blockbeats", "BLOCKBEATS_NEWS", "news"),
    ],
)
def test_failure_retains_old_times_and_shared_deadline(
    public_db, monkeypatch, kind, expected, scope, service, resource
):
    owner, writer, reader = public_db
    seed(owner)
    good = assets() if scope == "coingecko" else news()
    if kind == "429":
        bad = response({}, 429, (("retry-after", "900"),))
    elif kind == "timeout":
        bad = TimeoutError()
    elif kind == "duplicate":
        bad = response(good, headers=(("x-unrecognized", "one"), ("X-Unrecognized", "two")))
    elif kind == "401":
        bad = response({}, 401)
    elif kind == "future":
        bad_body = assets() if scope == "coingecko" else news()
        if scope == "coingecko":
            bad_body[0]["last_updated"] = time.time_ns() // 1000000 + 86400000
        else:
            bad_body["data"]["data"][0]["create_time"] = time.time_ns() // 1000000 + 86400000
        bad = response(bad_body)
    else:
        bad = HttpResponse(200, b"{not-json")
    wire = Wire({service: [response(good), bad, response(good)]})
    with TestClient(application(reader, writer, configured(wire))) as a:
        assert refresh(a, scope).json()["state"] == "COMPLETED"
        original = a.get("/v1/data/" + resource).json()
        now = advance(monkeypatch, owner, scope)
        assert refresh(a, scope).json()["state"] == "COMPLETED"
        with TestClient(application(reader)) as b:
            degraded = b.get("/v1/data/" + resource).json()
        assert degraded["quality"] == "stale"
        assert degraded["as_of_ms"] == original["as_of_ms"]
        for new, old in zip(degraded["items"], original["items"], strict=True):
            assert new == {**old, "quality": "stale"}
        assert degraded["sources"][0]["status"] == expected
        assert (
            degraded["sources"][0]["last_success_at_ms"]
            == original["sources"][0]["last_success_at_ms"]
        )
        denied = refresh(a, scope).json()
        assert denied["state"] == "NOT_DUE"
        if kind == "429":
            assert denied["next_at_ms"] >= now + 900000
        assert spent(owner, scope) == (2, 2) and len(wire.sent) == 2
        advance(monkeypatch, owner, scope)
        assert refresh(a, scope).json()["state"] == "COMPLETED"
        assert a.get("/v1/data/" + resource).json()["sources"][0]["status"] == "OK"
        assert spent(owner, scope) == (3, 3) and len(wire.sent) == 3
    assert wire.opened == wire.closed


@pytest.mark.parametrize("missing_key", [True, False])
def test_unconfigured_before_reservation_and_io(public_db, missing_key):
    owner, writer, reader = public_db
    seed(owner)
    wire = Wire({})
    config = SharedPublicProviders(
        mode=MODE,
        enabled_scopes=("blockbeats",) if missing_key else (),
        credentials=PublicDataCredentials(blockbeats_api_key=None if missing_key else "synthetic"),
        transport_factory=wire.factory,
    )
    with TestClient(application(reader, writer, config)) as a:
        assert refresh(a, "blockbeats").json()["state"] == "UNCONFIGURED"
        body = a.get("/v1/data/news").json()
        assert body["quality"] == "unavailable" and body["as_of_ms"] is None
        assert spent(owner, "blockbeats") == (0, 0)
        assert owner.execute("SELECT count(*) FROM public_data.attempts").fetchone()[0] == 0
        assert not wire.opened and not wire.sent


def test_budget_exhaustion_keeps_snapshot_no_new_transport(public_db, monkeypatch):
    owner, writer, reader = public_db
    seed(owner, cap=1, total=1)
    wire = Wire({"COINGECKO_ASSETS": [response(assets())]})
    with TestClient(application(reader, writer, configured(wire))) as a:
        assert refresh(a, "coingecko").json()["state"] == "COMPLETED"
        old = a.get("/v1/data/assets").json()
        advance(monkeypatch, owner, "coingecko", extra=10000)
        assert refresh(a, "coingecko").json()["state"] == "TOTAL_CAP"
        new = a.get("/v1/data/assets").json()
        assert new["quality"] == "stale" and new["as_of_ms"] == old["as_of_ms"]
        assert len(wire.opened) == len(wire.sent) == 1 and spent(owner, "coingecko") == (1, 1)


def test_partial_cg_and_empty_news_are_truthful(public_db):
    owner, writer, reader = public_db
    seed(owner)
    wire = Wire({"COINGECKO_ASSETS": [response(assets(2))], "BLOCKBEATS_NEWS": [response(news(0))]})
    with TestClient(application(reader, writer, configured(wire))) as a:
        assert refresh(a, "coingecko").json()["state"] == "COMPLETED"
        result = a.get("/v1/data/assets").json()
        assert result["quality"] == "partial" and result["coverage"]["gaps"] == ["solana"]
        assert len(result["items"]) == 2
        assert a.get("/v1/data/assets?asset_ids=solana").json()["quality"] == "unavailable"
        assert refresh(a, "blockbeats").json()["state"] == "COMPLETED"
        empty = a.get("/v1/data/news?limit=50").json()
        assert empty["quality"] == "fresh" and not empty["items"] and empty["as_of_ms"] is not None
        assert empty["coverage"]["gaps"] == []
        assert wire.opened == wire.closed and len(wire.sent) == 2


@pytest.mark.parametrize("prior_state", ["COMPLETED", "RESERVED", "UNKNOWN"])
def test_disabled_scope_reads_existing_receipt_and_rejects_conflicting_scope(
    public_db, prior_state
):
    owner, writer, reader = public_db
    seed(owner)
    wire = Wire({"COINGECKO_ASSETS": [response(assets())]})
    request_id = uuid4()
    if prior_state == "COMPLETED":
        with TestClient(application(reader, writer, configured(wire))) as a:
            before = refresh(a, "coingecko", str(request_id)).json()
    else:
        p = pool(writer)
        p.open()
        try:
            repository = pr.PublicRepository(p, mode=MODE)
            admission = repository.reserve("coingecko", request_id, uuid4())
            assert admission.ticket
            if prior_state == "UNKNOWN":
                repository.unknown(admission.ticket)
            before = {"state": prior_state, "next_at_ms": None, "revision": None}
        finally:
            p.close()
    disabled = SharedPublicProviders(mode=MODE)
    with TestClient(application(reader, writer, disabled)) as b:
        result = refresh(b, "coingecko", str(request_id))
        assert result.json() == before
        assert result.status_code == (202 if prior_state in {"RESERVED", "UNKNOWN"} else 200)
        assert refresh(b, "blockbeats", str(request_id)).status_code == 503
        assert refresh(b, "coingecko").json()["state"] == "UNCONFIGURED"
        assert spent(owner, "coingecko") == (1, 1) and spent(owner, "blockbeats") == (0, 0)
        assert owner.execute("SELECT count(*) FROM public_data.attempts").fetchone()[0] == 1
        assert len(wire.sent) == (1 if prior_state == "COMPLETED" else 0)
