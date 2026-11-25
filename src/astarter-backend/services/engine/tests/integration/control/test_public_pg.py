"""R2.2 real local PG17, owned synthetic DBs and stub providers only."""

# ruff: noqa: E402 -- opt-in before driver imports.
import asyncio
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Barrier
from uuid import uuid4

import pytest

if "PG2_TEST_SOCKET" not in os.environ:
    pytest.skip("Explicit owned synthetic cluster required", allow_module_level=True)

import psycopg
from fastapi.testclient import TestClient
from psycopg.conninfo import make_conninfo

from stark_trading_os.control.postgres import public_repository as pr
from stark_trading_os.control.postgres.access import AccessRejected, RepositoryAccessContract
from stark_trading_os.control.postgres.pool import CommitUnknown, PgRepositoryPool, PoolSettings
from stark_trading_os.control.postgres.public_access import (
    PUBLIC_CATALOG_PIN,
    catalog_digest,
    install_public,
    seed_public,
)
from stark_trading_os.control.public_data_models import PublicDataQuery
from stark_trading_os.control.public_data_policy import MIN_INTERVAL, PolicySnapshot, ProviderPolicy
from stark_trading_os.control.public_data_service import PublicDataService
from stark_trading_os.control.public_data_shared import (
    RefreshRequest,
    create_shared_public_app,
    refresh_once,
)
from stark_trading_os.control.public_data_store import PublicDataStore, PublicDataStoreError
from tests.unit.control.test_public_data_persistence import forbidden_fetch, synthetic_payload

MODE = "offline_fixture"
TOKEN = "synthetic-refresh-token-with-no-real-permissions"


@pytest.fixture
def public_db():
    root = Path(os.environ["PG2_TEST_ROOT"])
    a = json.loads((root / "root-socket-authorization.json").read_text())
    socket = Path(os.environ["PG2_TEST_SOCKET"])
    assert (
        socket.is_symlink()
        and str(socket) == a["alias"]
        and socket.lstat().st_ino == a["alias_inode"]
        and a["uid"] == os.getuid()
        and socket.resolve() == root / "socket"
        and a["pgdata"] == str(root / "pgdata")
    )
    base = dict(
        host=str(socket),
        port=55439,
        connect_timeout=3,
        password="fixture",
        passfile="/dev/null",
        sslmode="disable",
    )
    db = "r22_" + uuid4().hex
    with psycopg.connect(**base, dbname="postgres", user="pg1_owner", autocommit=True) as admin:
        assert admin.execute("SHOW data_directory").fetchone()[0] == a["pgdata"]
        assert admin.execute("SHOW listen_addresses").fetchone()[0] == ""
        for role, login in [
            ("r22_owner", True),
            ("r22_reader", True),
            ("r22_collector", True),
            ("public_data_read", False),
            ("public_data_collect", False),
        ]:
            if not admin.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (role,)).fetchone():
                admin.execute(
                    psycopg.sql.SQL("CREATE ROLE {} {}").format(
                        psycopg.sql.Identifier(role),
                        psycopg.sql.SQL("LOGIN" if login else "NOLOGIN"),
                    )
                )
        admin.execute("GRANT public_data_read TO r22_reader")
        admin.execute("GRANT public_data_collect TO r22_collector")
        admin.execute(
            psycopg.sql.SQL("CREATE DATABASE {} OWNER r22_owner TEMPLATE template0").format(
                psycopg.sql.Identifier(db)
            )
        )
    owner = psycopg.connect(**base, dbname=db, user="r22_owner", autocommit=True)
    install_public(owner)
    yield (
        owner,
        make_conninfo(**base, dbname=db, user="r22_collector"),
        make_conninfo(**base, dbname=db, user="r22_reader"),
    )
    owner.close()


def seed(owner, *, cap=100, total=100, snapshots=None, legacy=None):
    seed_public(
        owner,
        mode=MODE,
        policies=tuple(ProviderPolicy(s, cap, n) for s, n in MIN_INTERVAL.items()),
        total_caps={s: total for s in MIN_INTERVAL},
        valid_until_ms=time.time_ns() // 1000000 + 86400000,
        snapshots=snapshots,
        legacy=legacy,
    )


def pool(dsn, writable=True):
    return PgRepositoryPool(
        dsn,
        writable=writable,
        settings=PoolSettings(max_size=2),
        access_contract=RepositoryAccessContract.PUBLIC_DATA_V1,
    )


@pytest.fixture
def shared(public_db):
    owner, writer, reader = public_db
    seed(owner)
    p1, p2, rd = pool(writer), pool(writer), pool(reader, False)
    for p in (p1, p2, rd):
        p.open()
    yield (
        owner,
        pr.PublicRepository(p1, mode=MODE),
        pr.PublicRepository(p2, mode=MODE),
        pr.PgPublicStore(pr.PublicRepository(rd, mode=MODE)),
    )
    for p in (p1, p2, rd):
        p.close()
        assert p._pool.closed


def test_install_pin_replay_and_no_reseed(public_db):
    owner, _, _ = public_db
    with owner.transaction():
        owner.execute("SET LOCAL search_path=pg_catalog")
        assert catalog_digest(owner) == PUBLIC_CATALOG_PIN
    seed(owner)
    owner.execute(
        "UPDATE public_data.budgets SET reserved=3,total_reserved=3 WHERE scope='binance'"
    )
    install_public(owner)
    with pytest.raises(AccessRejected, match="ALREADY_INITIALIZED"):
        seed(owner)
    assert (
        owner.execute("SELECT reserved FROM public_data.budgets WHERE scope='binance'").fetchone()[
            0
        ]
        == 3
    )


def test_two_instances_only_one_atomic_admission(shared):
    owner, a, b, _ = shared
    barrier = Barrier(2)

    def acquire(repo):
        barrier.wait()
        return repo.reserve("binance", uuid4(), uuid4())

    with ThreadPoolExecutor(2) as threads:
        results = list(threads.map(acquire, (a, b)))
    assert sorted(r.state for r in results) == ["BUSY", "RESERVED"]
    assert owner.execute(
        "SELECT reserved,total_reserved FROM public_data.budgets WHERE scope='binance'"
    ).fetchone() == (3, 3)
    assert owner.execute("SELECT count(*) FROM public_data.attempts").fetchone()[0] == 1


def test_replay_conflict_unknown_no_refund(shared):
    owner, a, b, _ = shared
    req = uuid4()
    t = a.reserve("binance", req, uuid4()).ticket
    assert t and b.reserve("binance", req, uuid4()).ticket is None
    with pytest.raises(ValueError, match="CONFLICT"):
        b.reserve("coingecko", req, uuid4())
    a.unknown(t)
    assert b.reserve("binance", req, uuid4()).state == "UNKNOWN"
    assert b.reserve("binance", uuid4(), uuid4()).state == "NOT_DUE"
    assert owner.execute(
        "SELECT reserved,total_reserved FROM public_data.budgets WHERE scope='binance'"
    ).fetchone() == (3, 3)


def test_recovery_expired_owner_cannot_write(shared, monkeypatch):
    owner, a, b, _ = shared
    t = a.reserve("binance", uuid4(), uuid4()).ticket
    assert t
    monkeypatch.setattr(pr, "_now", lambda c: t.lease_until_ms + 1)
    fresh = b.reserve("binance", uuid4(), uuid4()).ticket
    assert fresh and fresh.epoch == t.epoch + 1
    with pytest.raises(ValueError, match="STALE_OWNER"):
        a.deadline(t, t.lease_until_ms + 100000)
    payload = synthetic_payload("markets")
    with pytest.raises(ValueError, match="STALE_OWNER"):
        pr.PgPublicStore(a, ticket=t).save(
            "markets",
            payload=payload,
            last_good=payload,
            fetched_at_ms=1000,
            refresh_at_ms=1001,
            expected_revision=0,
        )
    assert a.status(t.request_id).state == "EXPIRED"
    assert (
        owner.execute("SELECT reserved FROM public_data.budgets WHERE scope='binance'").fetchone()[
            0
        ]
        == 6
    )


def test_daily_total_expiry_and_backwards_clock(public_db, monkeypatch):
    owner, writer, _ = public_db
    seed(owner, cap=3, total=3)
    p = pool(writer)
    p.open()
    try:
        a = pr.PublicRepository(p, mode=MODE)
        t = a.reserve("binance", uuid4(), uuid4()).ticket
        assert t
        a.unknown(t)
        monkeypatch.setattr(pr, "_now", lambda c: t.lease_until_ms + 1)
        assert a.reserve("binance", uuid4(), uuid4()).state == "TOTAL_CAP"
        owner.execute("UPDATE public_data.budgets SET total_cap=6 WHERE scope='binance'")
        assert a.reserve("binance", uuid4(), uuid4()).state == "DAILY_CAP"
        monkeypatch.setattr(pr, "_now", lambda c: 0)
        assert a.reserve("coingecko", uuid4(), uuid4()).state == "RESERVED"
        # Expiry is checked on server time and cannot be silently extended by a worker.
        monkeypatch.setattr(pr, "_now", lambda c: 253402300700000)
        assert a.reserve("blockbeats", uuid4(), uuid4()).state == "BUDGET_EXPIRED"
    finally:
        p.close()


def test_completed_snapshot_receipt_atomic_and_readonly_projection(shared):
    owner, a, b, store = shared
    t = a.reserve("binance", uuid4(), uuid4()).ticket
    assert t
    now = time.time_ns() // 1000000
    payload = synthetic_payload("markets", now=now)
    a.deadline(t, now + 10000)
    saved = pr.PgPublicStore(a, ticket=t).save(
        "markets",
        payload=payload,
        last_good=payload,
        fetched_at_ms=now,
        refresh_at_ms=now + 10000,
        expected_revision=0,
    )
    assert saved and store.load("markets") == saved
    assert b.status(t.request_id).state == "COMPLETED"
    assert b.reserve("binance", t.request_id, uuid4()).revision == 1
    service = PublicDataService(
        forbidden_fetch, store=store, snapshot_only=True, clock_ms=lambda: now + 50000
    )
    data = asyncio.run(service.read(PublicDataQuery("markets", asset_ids=("bitcoin",))))
    assert data.quality == "stale" and len(data.items) == 1
    assert data.items[0].event_time_ms == payload.items[0].event_time_ms
    assert data.items[0].data == payload.items[0].data
    assert owner.execute("SELECT count(*) FROM public_data.attempts").fetchone()[0] == 1
    with pytest.raises(PublicDataStoreError):
        store.save(
            "markets",
            payload=payload,
            last_good=payload,
            fetched_at_ms=now,
            refresh_at_ms=now + 10000,
            expected_revision=1,
        )


def test_commit_unknown_reservation_no_repeat_io(shared, monkeypatch):
    _, a, b, _ = shared
    calls = []

    @asynccontextmanager
    async def factory():
        calls.append("forbidden")
        yield forbidden_fetch

    original = a.pool._commit

    def lose_ack(c):
        original(c)
        raise psycopg.OperationalError("synthetic lost acknowledgement")

    monkeypatch.setattr(a.pool, "_commit", lose_ack)
    req = RefreshRequest(request_id=uuid4(), scope="binance")
    assert asyncio.run(refresh_once(a, factory, req)).state == "UNKNOWN"
    assert calls == []
    assert b.reserve("binance", req.request_id, uuid4()).state == "RESERVED"


def test_commit_unknown_snapshot_reconciles_without_replay(shared, monkeypatch):
    _, a, b, store = shared
    t = a.reserve("binance", uuid4(), uuid4()).ticket
    assert t
    now = time.time_ns() // 1000000
    payload = synthetic_payload("markets", now=now)
    a.deadline(t, now + 10000)
    original = a.pool._commit

    def lose_ack(c):
        original(c)
        raise psycopg.OperationalError("synthetic commit unknown")

    monkeypatch.setattr(a.pool, "_commit", lose_ack)
    with pytest.raises(CommitUnknown):
        pr.PgPublicStore(a, ticket=t).save(
            "markets",
            payload=payload,
            last_good=payload,
            fetched_at_ms=now,
            refresh_at_ms=now + 10000,
            expected_revision=0,
        )
    assert store.load("markets").revision == 1
    assert b.reserve("binance", t.request_id, uuid4()).state == "COMPLETED"


def test_populated_sqlite_import_preserves_revision_times_and_charge(public_db, tmp_path):
    owner, _, reader = public_db
    now = time.time_ns() // 1000000
    payload = synthetic_payload("markets", now=now - 120000)
    old = PublicDataStore(tmp_path / "legacy.sqlite", mode=MODE)
    saved = old.save(
        "markets",
        payload=payload,
        last_good=payload,
        fetched_at_ms=now - 120000,
        refresh_at_ms=now - 110000,
        expected_revision=0,
    )
    old.close()
    history = {
        s: PolicySnapshot(
            now // 86400000, 6 if s == "binance" else 2, now - 1000, now + 10000, True
        )
        for s in MIN_INTERVAL
    }
    seed(owner, snapshots={"markets": saved}, legacy=history)
    p = pool(reader, False)
    p.open()
    try:
        assert pr.PgPublicStore(pr.PublicRepository(p, mode=MODE)).load("markets") == saved
    finally:
        p.close()
    row = owner.execute(
        "SELECT reserved,total_reserved,next_at_ms FROM public_data.budgets WHERE scope='binance'"
    ).fetchone()
    assert row[:2] == (6, 6) and row[2] >= now + 60000


def test_role_denies_private_quota_edits_and_catalog_drift(shared, public_db):
    owner, a, _, reader = shared
    _, writer_dsn, reader_dsn = public_db
    with psycopg.connect(writer_dsn, autocommit=True) as raw:
        for sql in (
            "UPDATE public_data.budgets SET daily_cap=999999",
            "DELETE FROM public_data.attempts",
            "CREATE TABLE public_data.evil(a int)",
            "CREATE SCHEMA evil",
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                raw.execute(sql)
    owner.execute("CREATE SCHEMA private_fixture")
    owner.execute("CREATE TABLE private_fixture.strategy(secret text)")
    with psycopg.connect(writer_dsn) as raw:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            raw.execute("SELECT * FROM private_fixture.strategy")
    with pytest.raises(AccessRejected):
        a.reserve("binance", uuid4(), uuid4())
    with pytest.raises(PublicDataStoreError):
        reader.load("markets")
    owner.execute("DROP TABLE private_fixture.strategy")
    owner.execute("DROP SCHEMA private_fixture")
    with psycopg.connect(reader_dsn) as raw:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            raw.execute("SELECT * FROM public_data.budgets")


def test_actual_bff_auth_share_canonical_query_replay_and_close(public_db):
    owner, writer_dsn, reader_dsn = public_db
    seed(owner)
    calls, closed = [], []

    @asynccontextmanager
    async def factory():
        try:

            async def fetch(query):
                calls.append(query)
                return synthetic_payload(query.resource, now=time.time_ns() // 1000000)

            yield fetch
        finally:
            closed.append(True)

    r1, r2, w = pool(reader_dsn, False), pool(reader_dsn, False), pool(writer_dsn)
    one = create_shared_public_app(
        reader_pool=r1, mode=MODE, collector_pool=w, fetcher_factory=factory, refresh_token=TOKEN
    )
    two = create_shared_public_app(reader_pool=r2, mode=MODE)
    with TestClient(one) as c1, TestClient(two) as c2:
        assert c2.get("/v1/data/markets").json()["quality"] == "unavailable"
        req = {"request_id": str(uuid4()), "scope": "binance"}
        assert c1.post("/internal/public-data/refresh", json=req).status_code == 403
        assert (
            c2.post(
                "/internal/public-data/refresh",
                json=req,
                headers={"authorization": "Bearer " + TOKEN},
            ).status_code
            == 403
        )
        headers = {"authorization": "Bearer " + TOKEN}
        first = c1.post("/internal/public-data/refresh", json=req, headers=headers)
        assert first.status_code == 200 and first.json()["state"] == "COMPLETED"
        assert (
            c1.post("/internal/public-data/refresh", json=req, headers=headers).json()
            == first.json()
        )
        result = c2.get("/v1/data/markets?asset_ids=bitcoin&selection_version=3").json()
        assert result["tenant_scope"] == "PUBLIC" and result["selection_version"] == 3
        assert result["real_trading_connected"] is False and len(result["items"]) == 1
        assert result["coverage"]["returned_subjects"] == ["bitcoin"]
        assert len(calls) == 1 and len(closed) == 1
        assert (
            c1.post(
                "/internal/public-data/refresh",
                json=req,
                headers={**headers, "Origin": "https://untrusted.invalid"},
            ).status_code
            == 403
        )
        assert (
            c1.post(
                "/internal/public-data/refresh", json={**req, "daily_cap": 999}, headers=headers
            ).status_code
            == 400
        )
    assert all(p._pool.closed for p in (r1, r2, w))


@pytest.mark.asyncio
async def test_cancel_keeps_charge_closes_owned_fetcher(shared):
    owner, a, b, _ = shared
    entered, closed = asyncio.Event(), []

    @asynccontextmanager
    async def factory():
        try:

            async def fetch(query):
                entered.set()
                await asyncio.Event().wait()

            yield fetch
        finally:
            closed.append(True)

    req = RefreshRequest(request_id=uuid4(), scope="binance")
    task = asyncio.create_task(refresh_once(a, factory, req))
    await asyncio.wait_for(entered.wait(), 3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert closed == [True] and b.status(req.request_id).state == "UNKNOWN"
    assert (
        owner.execute("SELECT reserved FROM public_data.budgets WHERE scope='binance'").fetchone()[
            0
        ]
        == 3
    )
    assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]


def test_retry_after_is_durable_monotone_and_receipt_not_freshness(shared, monkeypatch):
    owner, a, b, store = shared
    t = a.reserve("binance", uuid4(), uuid4()).ticket
    assert t
    now = time.time_ns() // 1000000
    original = synthetic_payload("markets", now=now)
    long_deadline = now + 300000
    a.deadline(t, long_deadline)
    a.deadline(t, now + 10000)  # Cannot shorten already observed RetryAfter.
    pr.PgPublicStore(a, ticket=t).save(
        "markets",
        payload=original,
        last_good=original,
        fetched_at_ms=now,
        refresh_at_ms=now + 10000,
        expected_revision=0,
    )
    monkeypatch.setattr(pr, "_now", lambda c: t.lease_until_ms + 1)
    result = b.reserve("binance", uuid4(), uuid4())
    assert result.state == "NOT_DUE" and result.next_at_ms == long_deadline
    assert store.load("markets").payload.as_of_ms == original.as_of_ms
    assert (
        owner.execute("SELECT reserved FROM public_data.budgets WHERE scope='binance'").fetchone()[
            0
        ]
        == 3
    )


def test_snapshot_and_receipt_rollback_together(shared, monkeypatch):
    owner, a, b, store = shared
    t = a.reserve("binance", uuid4(), uuid4()).ticket
    assert t
    now = time.time_ns() // 1000000
    payload = synthetic_payload("markets", now=now)
    a.deadline(t, now + 200000)

    def lost_before_commit(c):
        raise psycopg.OperationalError("synthetic disconnect before commit")

    monkeypatch.setattr(a.pool, "_commit", lost_before_commit)
    with pytest.raises(CommitUnknown):
        pr.PgPublicStore(a, ticket=t).save(
            "markets",
            payload=payload,
            last_good=payload,
            fetched_at_ms=now,
            refresh_at_ms=now + 10000,
            expected_revision=0,
        )
    assert store.load("markets") is None and b.status(t.request_id).state == "RESERVED"
    assert owner.execute(
        "SELECT reserved,next_at_ms FROM public_data.budgets WHERE scope='binance'"
    ).fetchone() == (3, now + 200000)


def test_backward_clock_rejects_and_next_day_does_not_refund_total(shared, monkeypatch):
    owner, a, b, _ = shared
    t = a.reserve("binance", uuid4(), uuid4()).ticket
    assert t
    a.unknown(t)
    monkeypatch.setattr(pr, "_now", lambda c: 1)
    assert b.reserve("binance", uuid4(), uuid4()).state == "NOT_DUE"
    row = owner.execute(
        "SELECT day,reserved,total_reserved,last_wall_ms FROM public_data.budgets "
        "WHERE scope='binance'"
    ).fetchone()
    next_day = (row[0] + 1) * 86400000 + 100000
    owner.execute(
        "UPDATE public_data.budgets SET valid_until_ms=%s WHERE scope='binance'",
        (next_day + 86400000,),
    )
    monkeypatch.setattr(pr, "_now", lambda c: next_day)
    assert b.reserve("binance", uuid4(), uuid4()).ticket
    assert owner.execute(
        "SELECT reserved,total_reserved FROM public_data.budgets WHERE scope='binance'"
    ).fetchone() == (3, 6)


def test_failed_migration_atomic_and_canonical_legacy_policy(public_db, tmp_path):
    from stark_trading_os.control.public_data_policy import PublicPolicyStore

    owner, _, _ = public_db
    now = time.time_ns() // 1000000
    path = tmp_path / "legacy-public.sqlite"
    store = PublicDataStore(path, mode=MODE)
    policy = PublicPolicyStore(
        path, mode=MODE, policies=tuple(ProviderPolicy(s, 100, n) for s, n in MIN_INTERVAL.items())
    )
    assert policy.reserve("binance", now, 0) is None
    policy.record_deadline("binance", now, now + 3600000)
    history = {s: policy.snapshot(s) for s in MIN_INTERVAL}
    payload = synthetic_payload("markets", now=now)
    stored = store.save(
        "markets",
        payload=payload,
        last_good=payload,
        fetched_at_ms=now,
        refresh_at_ms=now + 10000,
        expected_revision=0,
    )
    policy.close()
    store.close()
    with pytest.raises(PublicDataStoreError):
        seed(owner, snapshots={"news": stored}, legacy=history)
    assert owner.execute("SELECT count(*) FROM public_data.budgets").fetchone()[0] == 0
    seed(owner, snapshots={"markets": stored}, legacy=history)
    row = owner.execute(
        "SELECT reserved,total_reserved,next_at_ms FROM public_data.budgets WHERE scope='binance'"
    ).fetchone()
    assert row[:2] == (3, 3) and row[2] >= now + 3600000


@pytest.mark.asyncio
async def test_stub_failure_and_timeout_are_observations_with_closed_transport(shared):
    _, a, _, store = shared
    closed = []

    @asynccontextmanager
    async def factory():
        try:

            async def fetch(query):
                raise TimeoutError("synthetic")

            yield fetch
        finally:
            closed.append(True)

    result = await refresh_once(a, factory, RefreshRequest(request_id=uuid4(), scope="binance"))
    assert result.state == "COMPLETED"  # Terminal receipt, not a data success assertion.
    assert closed == [True] and store.load("markets").payload.quality == "unavailable"
    assert store.load("markets").refresh_at_ms - store.load("markets").fetched_at_ms >= 60000


def test_empty_reader_four_routes_and_pool_failure_closed(public_db):
    owner, _, reader = public_db
    seed(owner)
    p = pool(reader, False)
    app = create_shared_public_app(reader_pool=p, mode=MODE)
    with TestClient(app) as client:
        for resource in ["markets", "assets", "news", "explorer/capabilities"]:
            result = client.get("/v1/data/" + resource)
            assert result.status_code == 200 and result.json()["quality"] == "unavailable"
        p.close()
        assert client.get("/v1/data/markets").status_code == 503
    assert p._pool.closed


@pytest.mark.asyncio
async def test_fetch_timeout_is_finite_and_leaves_no_task(shared):
    _, a, b, store = shared
    closed = []

    @asynccontextmanager
    async def factory():
        try:

            async def fetch(query):
                await asyncio.Event().wait()

            yield fetch
        finally:
            closed.append(True)

    req = RefreshRequest(request_id=uuid4(), scope="binance")
    start = time.monotonic()
    result = await refresh_once(a, factory, req)
    assert 5.8 <= time.monotonic() - start < 15
    assert result.state == "COMPLETED" and b.status(req.request_id).revision == 1
    assert store.load("markets").payload.quality == "unavailable" and closed == [True]
    assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]


@pytest.mark.asyncio
async def test_worker_clock_cannot_shorten_retry_after(shared, monkeypatch):
    owner, a, b, _ = shared
    db_now = owner.execute(
        "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint"
    ).fetchone()[0]
    monkeypatch.setattr(
        "stark_trading_os.control.public_data_service.time.time_ns",
        lambda: (db_now - 600000) * 1000000,
    )

    @asynccontextmanager
    async def factory():
        async def fetch(query):
            from stark_trading_os.control.public_data_models import PublicDataPayload

            return PublicDataPayload.model_validate(
                {
                    "mode": MODE,
                    "as_of_ms": None,
                    "quality": "unavailable",
                    "items": [],
                    "coverage": {
                        "scope": "BINANCE_SPOT_24H_STATISTICS",
                        "requested_subjects": list(query.asset_ids),
                        "returned_subjects": [],
                        "gaps": list(query.asset_ids),
                    },
                    "sources": [
                        {
                            "provider_id": "binance-spot-ticker-v1",
                            "status": "UNAVAILABLE",
                            "retry_after_seconds": 120,
                        }
                    ],
                }
            )

        yield fetch

    result = await refresh_once(a, factory, RefreshRequest(request_id=uuid4(), scope="binance"))
    assert result.state == "COMPLETED"
    deadline = owner.execute(
        "SELECT next_at_ms FROM public_data.budgets WHERE scope='binance'"
    ).fetchone()[0]
    assert deadline - db_now >= 120000
    monkeypatch.setattr(pr, "_now", lambda c: db_now + 11000)
    assert b.reserve("binance", uuid4(), uuid4()).state == "NOT_DUE"


@pytest.mark.asyncio
async def test_due_snapshot_uses_shared_clock_not_worker_clock(public_db, monkeypatch):
    from stark_trading_os.control.public_data_store import StoredPublicData

    owner, writer, _ = public_db
    now = owner.execute(
        "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint"
    ).fetchone()[0]
    old = synthetic_payload("markets", now=now - 120000)
    seed(owner, snapshots={"markets": StoredPublicData(old, old, now - 120000, now - 1000, 1)})
    p = pool(writer)
    p.open()
    calls = []
    fresh = synthetic_payload("markets", now=now)

    @asynccontextmanager
    async def factory():
        async def fetch(query):
            calls.append(query.resource)
            return fresh

        yield fetch

    monkeypatch.setattr(
        "stark_trading_os.control.public_data_service.time.time_ns",
        lambda: (now - 600000) * 1000000,
    )
    try:
        result = await refresh_once(
            pr.PublicRepository(p, mode=MODE),
            factory,
            RefreshRequest(request_id=uuid4(), scope="binance"),
        )
        assert result.state == "COMPLETED" and result.revision == 2 and calls == ["markets"]
        assert pr.PgPublicStore(pr.PublicRepository(p, mode=MODE)).load("markets").payload == fresh
    finally:
        p.close()


def test_schema_grant_option_is_drift_and_effective_permission_refused(shared):
    owner, a, _, reader = shared
    owner.execute("GRANT USAGE ON SCHEMA public_data TO public_data_read WITH GRANT OPTION")
    with owner.transaction():
        owner.execute("SET LOCAL search_path=pg_catalog")
        assert catalog_digest(owner) != PUBLIC_CATALOG_PIN
    with pytest.raises(AccessRejected):
        with reader.repository.pool.transaction():
            pass
    with pytest.raises(AccessRejected):
        a.reserve("binance", uuid4(), uuid4())
    owner.execute("REVOKE GRANT OPTION FOR USAGE ON SCHEMA public_data FROM public_data_read")
    assert reader.load("markets") is None


@pytest.mark.asyncio
async def test_http_loop_responsive_and_disconnected_db_call_drained(public_db):
    import httpx

    owner, _, reader = public_db
    seed(owner)
    p = pool(reader, False)
    app = create_shared_public_app(reader_pool=p, mode=MODE)
    async with app.router.lifespan_context(app):
        owner.execute("BEGIN")
        owner.execute("LOCK TABLE public_data.snapshots IN ACCESS EXCLUSIVE MODE")
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://testserver"
            ) as client:
                task = asyncio.create_task(client.get("/v1/data/markets"))
                start = time.monotonic()
                await asyncio.sleep(0.05)
                assert time.monotonic() - start < 0.4 and not task.done()
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
                assert app.state.public_data_calls.pending  # still owned, not abandoned
        finally:
            owner.execute("ROLLBACK")
    assert p._pool.closed and not app.state.public_data_calls.pending


@pytest.mark.asyncio
async def test_full_worker_admission_returns_retryable_503(public_db):
    import httpx

    owner, _, reader = public_db
    seed(owner)
    p = pool(reader, False)
    app = create_shared_public_app(reader_pool=p, mode=MODE)
    async with app.router.lifespan_context(app):
        calls = app.state.public_data_calls
        for _ in range(4):
            await calls.slots.acquire()
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://testserver"
            ) as client:
                result = await client.get("/v1/data/markets")
                assert result.status_code == 503
                assert result.json()["retryable"] is True
                assert result.json()["code"] == "DATA_SERVICE_UNAVAILABLE"
        finally:
            for _ in range(4):
                calls.slots.release()
    assert p._pool.closed and not calls.pending
