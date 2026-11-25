"""Discovery exposes committed metadata without pretending it rechecked files."""

import asyncio
import json

import pytest

from stark_trading_os.catalog.historical_source import validate_historical_source
from tests.integration.api.test_historical import PREFIX, HistoricalHttpHarness
from tests.integration.catalog.test_historical_publication import (
    NOW_NS,
    _csv_bytes,
    _metadata_bytes,
    _source,
)
from tests.integration.runner.sma_component_fixture import prepare_sma_case


@pytest.fixture(name="historical_http")
def historical_http_fixture(tmp_path):
    *_, config = prepare_sma_case(tmp_path, [100, 100, 100, 110, 100, 90])
    return HistoricalHttpHarness(tmp_path, config)


def test_discovery_exposes_published_historical_metadata_without_writes(historical_http):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            before = tuple(dependencies.store._connection.iterdump())
            response = await client.get(PREFIX + "/catalogs")
            assert response.status_code == 200, response.text
            page = response.json()
            assert page["next_cursor"] is None and len(page["items"]) == 1
            item = page["items"][0]
            assert item["dataset"]["catalog_revision"] == historical_http.config.catalog_revision
            assert item["dataset"]["record_count"] == 6
            assert item["dataset"]["timeframe_ns"] == "60000000000"
            assert item["dataset"]["window"]["first_open_ns"] == "1700000000000000000"
            assert item["dataset"]["window"]["last_close_ns"] == "1700000360000000000"
            assert item["dataset"]["purpose"] == "SYNTHETIC_QA"
            assert item["dataset"]["availability_source"] == "ASSUMED_AT_CLOSE"
            assert item["source_market"] == "SYNTHETIC"
            assert item["source_symbol"] == "ETHUSDT"
            assert item["price_increment"] == "0.01"
            assert item["size_increment"] == item["minimum_quantity"] == "0.001"
            assert item["price_precision"] == 2 and item["size_precision"] == 3
            assert item["authority"] == "CONTROL_SQLITE"
            assert item["filesystem_verification"] == "NOT_CHECKED"
            assert item["current_eligibility"] == "NOT_RECHECKED"
            assert item["published_at_ns"].isdigit()
            assert not {"origin", "catalog_files", "source_files", "native_fingerprint"} & set(item)
            assert str(historical_http.root) not in response.text
            detail = await client.get(
                PREFIX + "/catalogs/" + historical_http.config.catalog_revision
            )
            assert detail.status_code == 200 and detail.json() == item
            assert tuple(dependencies.store._connection.iterdump()) == before

    asyncio.run(exercise())


def test_definition_is_explicit_engineering_workflow_not_live_or_admission(historical_http):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            before = tuple(dependencies.store._connection.iterdump())
            response = await client.get(PREFIX + "/strategies")
            assert response.status_code == 200, response.text
            assert response.json() == {
                "items": [
                    {
                        "strategy_ref": "sma-cross-long-flat@v1",
                        "name": "SMA 多头/空仓工程基准",
                        "purpose": "ENGINEERING_BASELINE",
                        "environment": "BACKTEST",
                        "contract_kind": "HISTORICAL_SMA_V2",
                        "data_selection": "ENTIRE_PUBLISHED_CATALOG",
                        "availability": "HTTP_WORKFLOW_IMPLEMENTED",
                        "admission": "PREFLIGHT_REQUIRED",
                        "live_available": False,
                    }
                ]
            }
            assert tuple(dependencies.store._connection.iterdump()) == before

    asyncio.run(exercise())


@pytest.mark.parametrize("suffix", ["/catalogs", "/catalogs/" + "a" * 64, "/strategies"])
def test_discovery_is_default_off(historical_http, suffix):
    async def exercise():
        async with historical_http.open(enabled=False) as (client, dependencies):
            before = tuple(dependencies.store._connection.iterdump())
            response = await client.get(PREFIX + suffix)
            assert response.status_code == 503, response.text
            assert response.json()["code"] == "CAPABILITY_DISABLED"
            assert tuple(dependencies.store._connection.iterdump()) == before

    asyncio.run(exercise())


def test_mixed_paging_is_bounded_and_does_not_stop_at_an_empty_filtered_page(
    historical_http, monkeypatch
):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            for fixture_id in ("determinism-probe-v1", "local-qa-v1"):
                dependencies.fixture_publisher.publish(fixture_id)
            # Add another genuine historical publication to exercise page continuation.
            second = dependencies.fixture_publisher.publish_historical(
                _source(name="Paging source")
            )
            revisions = [
                row[0]
                for row in dependencies.store._connection.execute(
                    "SELECT catalog_revision FROM catalog_publications "
                    "WHERE status='PUBLISHED' ORDER BY catalog_revision"
                )
            ]
            read = dependencies.store.catalog_publication
            visited = []

            def observed(revision):
                visited.append(revision)
                return read(revision)

            monkeypatch.setattr(dependencies.store, "catalog_publication", observed)
            cursor = None
            items, empty_with_continuation = [], False
            before = tuple(dependencies.store._connection.iterdump())
            for index, revision in enumerate(revisions):
                params = {"limit": "1"}
                if cursor:
                    params["after_revision"] = cursor
                response = await client.get(PREFIX + "/catalogs", params=params)
                assert response.status_code == 200, response.text
                page = response.json()
                assert visited == [
                    revision
                ]  # No validation of the entire registry or lookahead row.
                visited.clear()
                cursor = page["next_cursor"]
                assert cursor == (revision if index + 1 < len(revisions) else None)
                items.extend(page["items"])
                empty_with_continuation |= not page["items"] and cursor is not None
            assert {item["dataset"]["catalog_revision"] for item in items} == {
                historical_http.config.catalog_revision,
                second.catalog_revision,
            }
            assert empty_with_continuation
            assert tuple(dependencies.store._connection.iterdump()) == before
            beyond = await client.get(PREFIX + "/catalogs", params={"after_revision": "f" * 64})
            assert beyond.status_code == 200 and beyond.json() == {"items": [], "next_cursor": None}

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "query",
    [
        "limit=0",
        "limit=101",
        "limit=1.5",
        "after_revision=bad",
        "after_revision=" + "A" * 64,
    ],
)
def test_catalog_query_rejects_unbounded_or_malformed_inputs(historical_http, query):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            before = tuple(dependencies.store._connection.iterdump())
            response = await client.get(PREFIX + "/catalogs?" + query)
            assert response.status_code == 422, response.text
            assert tuple(dependencies.store._connection.iterdump()) == before

    asyncio.run(exercise())


def test_metadata_read_does_not_inspect_or_repair_missing_catalog_files(historical_http):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            path = (
                historical_http.root / "runtime/catalogs" / historical_http.config.catalog_revision
            )
            held = path.with_name(path.name + ".held")
            path.rename(held)
            try:
                before = tuple(dependencies.store._connection.iterdump())
                for suffix in ("/catalogs", "/catalogs/" + historical_http.config.catalog_revision):
                    response = await client.get(PREFIX + suffix)
                    assert response.status_code == 200, response.text
                    assert '"filesystem_verification":"NOT_CHECKED"' in response.text
                assert not path.exists()
                assert tuple(dependencies.store._connection.iterdump()) == before
            finally:
                held.rename(path)

    asyncio.run(exercise())


def test_catalog_grid_preserves_declared_fixed_precision(historical_http):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            raw = _csv_bytes().replace(b".00,", b".000,")
            metadata = json.loads(_metadata_bytes(raw))
            metadata["instrument"].update(
                price_precision=3, price_increment="0.010", minimum_quantity="1.000"
            )
            source = validate_historical_source(raw, json.dumps(metadata).encode(), now_ns=NOW_NS)
            publication = dependencies.fixture_publisher.publish_historical(source)
            response = await client.get(PREFIX + "/catalogs/" + publication.catalog_revision)
            assert response.status_code == 200, response.text
            assert response.json()["price_increment"] == "0.010"
            assert response.json()["minimum_quantity"] == "1.000"
            assert response.json()["price_precision"] == 3

    asyncio.run(exercise())


def test_nonhistorical_unknown_and_failed_publications_are_not_selectable(historical_http):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            legacy = dependencies.fixture_publisher.publish("determinism-probe-v1")
            publication = dependencies.store.catalog_publication(
                historical_http.config.catalog_revision
            )
            dependencies.store.mark_catalog_integrity_failed(
                catalog_revision=publication.catalog_revision,
                fixture_id=publication.fixture_id,
                inventory_hash=publication.inventory_hash,
                publication_bytes=publication.publication_bytes,
                staging_identity=publication.staging_identity,
            )
            before = tuple(dependencies.store._connection.iterdump())
            for revision in (legacy.catalog_revision, publication.catalog_revision, "f" * 64):
                response = await client.get(PREFIX + "/catalogs/" + revision)
                assert response.status_code == 404 and response.json()["code"] == "CATALOG_UNKNOWN"
            page = await client.get(PREFIX + "/catalogs")
            assert page.status_code == 200 and page.json() == {"items": [], "next_cursor": None}
            assert tuple(dependencies.store._connection.iterdump()) == before

    asyncio.run(exercise())


def test_prepared_publication_is_not_discovered(historical_http, monkeypatch):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            original = dependencies.store.publish_catalog_publication

            def interrupted(**kwargs):
                raise RuntimeError("test interrupted before publication commit")

            monkeypatch.setattr(dependencies.store, "publish_catalog_publication", interrupted)
            with pytest.raises(RuntimeError, match="test interrupted"):
                dependencies.fixture_publisher.publish_historical(_source(name="Unpublished"))
            monkeypatch.setattr(dependencies.store, "publish_catalog_publication", original)
            row = dependencies.store._connection.execute(
                "SELECT catalog_revision FROM catalog_publications WHERE status='PREPARED'"
            ).fetchone()
            assert row is not None
            before = tuple(dependencies.store._connection.iterdump())
            response = await client.get(PREFIX + "/catalogs/" + row[0])
            assert response.status_code == 404 and response.json()["code"] == "CATALOG_UNKNOWN"
            page = await client.get(PREFIX + "/catalogs")
            assert page.status_code == 200
            assert [x["dataset"]["catalog_revision"] for x in page.json()["items"]] == [
                historical_http.config.catalog_revision
            ]
            assert tuple(dependencies.store._connection.iterdump()) == before

    asyncio.run(exercise())


def test_catalog_corrupt_audit_is_visible_failure_without_repair(historical_http):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            connection = dependencies.store._connection
            connection.execute("UPDATE catalog_audit_intents SET intent_bytes=?", (b"{}",))
            before = tuple(connection.iterdump())
            for suffix in ("/catalogs", "/catalogs/" + historical_http.config.catalog_revision):
                response = await client.get(PREFIX + suffix)
                assert response.status_code == 409, response.text
                assert response.json()["code"] == "CATALOG_INTEGRITY_FAILED"
                assert str(historical_http.root) not in response.text
            assert tuple(connection.iterdump()) == before

    asyncio.run(exercise())


def test_catalog_storage_unavailable_is_not_unknown_or_bad_input(historical_http):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            dependencies.store.close()
            for suffix in ("/catalogs", "/catalogs/" + historical_http.config.catalog_revision):
                response = await client.get(PREFIX + suffix)
                assert response.status_code == 503, response.text
                assert response.json()["code"] == "CONTROL_UNAVAILABLE"
                assert "closed database" not in response.text

    asyncio.run(exercise())


@pytest.mark.parametrize("status", ["PUBLISHED", "PREPARED"])
def test_catalog_sql_work_is_bounded_for_deep_cursor_and_unpublished_prefix(
    historical_http, status
):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            connection = dependencies.store._connection
            # These records must never be decoded: before the deep cursor, or filtered
            # inside the bounded registry window. The real selected row remains audited.
            connection.executemany(
                """INSERT INTO catalog_publications
                   (catalog_revision, fixture_id, status, inventory_hash, publication_bytes,
                    staging_identity, prepared_at_ns, published_at_ns)
                   VALUES (?, 'unselected-scale-record', ?, ?, ?, ?, 0, ?)""",
                [
                    (
                        f"{index:064x}",
                        status,
                        "0" * 64,
                        b"{}",
                        f"scale-{index}",
                        1 if status == "PUBLISHED" else None,
                    )
                    for index in range(1, 10001)
                ],
            )
            vm_batches = 0

            def count_work():
                nonlocal vm_batches
                vm_batches += 1
                return int(vm_batches > 20)  # Stop at 2,100 SQLite VM instructions.

            params = {"limit": "1"}
            if status == "PUBLISHED":
                params["after_revision"] = f"{10000:064x}"
            connection.set_progress_handler(count_work, 100)
            try:
                response = await client.get(PREFIX + "/catalogs", params=params)
            finally:
                connection.set_progress_handler(None, 0)
            assert response.status_code == 200, response.text
            assert vm_batches <= 20
            page = response.json()
            if status == "PUBLISHED":
                assert [x["dataset"]["catalog_revision"] for x in page["items"]] == [
                    historical_http.config.catalog_revision
                ]
                assert page["next_cursor"] is None
            else:
                assert page == {"items": [], "next_cursor": f"{1:064x}"}

    asyncio.run(exercise())
