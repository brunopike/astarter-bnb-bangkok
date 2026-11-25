from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

from stark_trading_os.catalog.fixture_publisher import FixturePublisher
from stark_trading_os.catalog.fixture_registry import FixtureRegistry
from stark_trading_os.control.database import open_control_database
from stark_trading_os.control.registry import CatalogPublication, ControlStore

REPOSITORY_ROOT = Path(__file__).parents[5]


def test_two_independent_connections_converge_on_one_publication_and_audit(
    tmp_path: Path,
) -> None:
    seed = ControlStore.open(tmp_path / "seed.sqlite", clock=lambda: 50)
    try:
        identity = FixturePublisher(
            registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
            control=seed,
            runtime_root=tmp_path / "seed-runtime",
        ).publish("local-qa-v1")
    finally:
        seed.close()
    assert identity.audit_intent_bytes is not None

    database = tmp_path / "control.sqlite"
    revision = identity.catalog_revision
    inventory_hash = identity.inventory_hash
    publication_bytes = identity.publication_bytes
    audit_bytes = identity.audit_intent_bytes
    barrier = Barrier(2)

    def publish(now: int) -> CatalogPublication:
        store = ControlStore.open(database, clock=lambda: now)
        try:
            barrier.wait()
            prepared = store.prepare_catalog_publication(
                catalog_revision=revision, fixture_id="local-qa-v1",
                inventory_hash=inventory_hash, publication_bytes=publication_bytes,
                staging_identity=f"prepared-{revision}",
            )
            return store.publish_catalog_publication(
                catalog_revision=revision, fixture_id=prepared.fixture_id,
                inventory_hash=inventory_hash, publication_bytes=publication_bytes,
                staging_identity=prepared.staging_identity, audit_intent_bytes=audit_bytes,
            )
        finally:
            store.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = tuple(executor.map(publish, (100, 200)))
    assert results[0] == results[1]
    assert results[0].status == "PUBLISHED"

    inspection = open_control_database(database)
    try:
        assert inspection.execute("SELECT count(*) FROM catalog_publications").fetchone()[0] == 1
        assert inspection.execute("SELECT count(*) FROM catalog_audit_intents").fetchone()[0] == 1
    finally:
        inspection.close()
