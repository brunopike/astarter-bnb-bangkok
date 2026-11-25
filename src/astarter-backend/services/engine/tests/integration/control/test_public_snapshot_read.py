"""PUBLIC GET uses one checked transaction, without caching identity or source time."""
# ruff: noqa: F401, F811 -- imported pytest fixture
import os
from contextlib import contextmanager

import pytest

if "PG2_TEST_SOCKET" not in os.environ:
    pytest.skip("Explicit synthetic PG required", allow_module_level=True)

from fastapi.testclient import TestClient

from stark_trading_os.control.public_data_shared import create_shared_public_app
from stark_trading_os.control.public_data_store import StoredPublicData
from tests.integration.control.test_public_pg import MODE, pool, public_db, seed
from tests.unit.control.test_public_data_persistence import synthetic_payload


@pytest.mark.parametrize("stored", [False, True])
def test_get_one_checked_transaction_and_db_clock(public_db, monkeypatch, stored):
    owner, _, reader = public_db
    now = owner.execute("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint").fetchone()[0]
    old = synthetic_payload("markets", now=now - 120000)
    seed(owner, snapshots={"markets": StoredPublicData(old, old, now-120000, now-1000, 1)}
         if stored else None)
    p = pool(reader, False)
    app = create_shared_public_app(reader_pool=p, mode=MODE)
    with TestClient(app) as client:
        original, calls = p.transaction, []

        @contextmanager
        def counted(**kwargs):
            calls.append(kwargs)
            with original(**kwargs) as c:
                yield c

        monkeypatch.setattr(p, "transaction", counted)
        monkeypatch.setattr("stark_trading_os.control.public_data_service.time.time_ns", lambda: 1)
        for _ in range(2):
            calls.clear()
            value = client.get("/v1/data/markets?asset_ids=bitcoin").json()
            assert value["requested_at_ms"] >= now
            assert value["quality"] == ("stale" if stored else "unavailable")
            assert value["as_of_ms"] == (old.as_of_ms if stored else None)
            assert len(calls) == 1
        # A warmed read must still notice privileges changing.
        owner.execute("GRANT TEMP ON DATABASE " + owner.info.dbname + " TO r22_reader")
        assert client.get("/v1/data/markets").status_code == 503

