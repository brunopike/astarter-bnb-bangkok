"""Real, disposable SQLite evidence for the bounded PUBLIC projection store."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from stark_trading_os.control.public_data_models import PublicDataPayload
from stark_trading_os.control.public_data_store import PublicDataStore, PublicDataStoreError

NOW = 1793268000000


def empty_news(mode: str = "offline_fixture") -> PublicDataPayload:
    return PublicDataPayload.model_validate({
        "mode": mode, "as_of_ms": NOW, "quality": "fresh",
        "coverage": {"scope": "NEWS_FEED", "requested_subjects": ["news"],
                     "returned_subjects": [], "gaps": []},
        "sources": [{"provider_id": "synthetic-news", "status": "OK",
                     "last_success_at_ms": NOW}], "items": [],
    })


def save_news(store: PublicDataStore, *, revision: int = 0, now: int = NOW) -> None:
    result = store.save(
        "news", payload=empty_news(store.mode), last_good=empty_news(store.mode),
        fetched_at_ms=now, refresh_at_ms=now + 60000, expected_revision=revision,
    )
    assert result is not None
    assert result.revision == revision + 1


def test_new_empty_and_populated_schema_reopen(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    store = PublicDataStore(path, mode="offline_fixture")
    assert store.load("news") is None
    store.close()
    store = PublicDataStore(path, mode="offline_fixture")
    save_news(store)
    original = store.load("news")
    store.close()
    reopened = PublicDataStore(path, mode="offline_fixture")
    assert reopened.load("news") == original
    assert original is not None and original.last_good == empty_news()
    assert original.payload.items == ()
    assert original.refresh_at_ms == NOW + 60000
    reopened.close()


def test_two_connections_reject_late_completion_atomically(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    older = PublicDataStore(path, mode="offline_fixture")
    newer = PublicDataStore(path, mode="offline_fixture")
    assert older.load("news") is newer.load("news") is None
    save_news(newer, now=NOW + 100)
    winner = newer.load("news")
    assert older.save(
        "news", payload=empty_news(), last_good=empty_news(),
        fetched_at_ms=NOW, refresh_at_ms=NOW + 999999, expected_revision=0,
    ) is None
    assert older.load("news") == winner
    save_news(newer, revision=1, now=NOW + 200)
    assert older.save(
        "news", payload=empty_news(), last_good=empty_news(),
        fetched_at_ms=NOW, refresh_at_ms=NOW + 999999, expected_revision=1,
    ) is None
    assert older.load("news") == newer.load("news")
    assert older.load("news") != winner
    older.close()
    newer.close()


def test_modes_are_separate_and_mismatch_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    fixture = PublicDataStore(path, mode="offline_fixture")
    live = PublicDataStore(path, mode="live_readonly")
    save_news(fixture)
    assert live.load("news") is None
    with pytest.raises(PublicDataStoreError, match="^PUBLIC_DATA_STORE_FAILED$"):
        live.save("news", payload=empty_news(), last_good=empty_news(),
                  fetched_at_ms=NOW, refresh_at_ms=NOW + 60000, expected_revision=0)
    save_news(live)
    assert fixture.load("news") != live.load("news")
    fixture.close()
    live.close()


@pytest.mark.parametrize("kind", ["control", "corrupt", "version", "foreign_empty"])
def test_foreign_or_corrupt_database_is_rejected_without_repair(
    tmp_path: Path, kind: str,
) -> None:
    path = tmp_path / "private-location.sqlite"
    if kind == "corrupt":
        path.write_bytes(b"not a database; synthetic private diagnostic")
    else:
        with sqlite3.connect(path) as db:
            if kind == "control":
                db.execute("CREATE TABLE control_commands (id TEXT PRIMARY KEY)")
                db.execute("INSERT INTO control_commands VALUES ('synthetic-command')")
            elif kind == "version":
                db.execute("PRAGMA user_version = 77")
            else:
                db.execute("PRAGMA application_id = 77")
    before = path.read_bytes()
    with pytest.raises(PublicDataStoreError, match="^PUBLIC_DATA_STORE_FAILED$"):
        PublicDataStore(path, mode="offline_fixture")
    assert path.read_bytes() == before


@pytest.mark.parametrize("column,value", [
    ("resource", "private"), ("mode", "paper"), ("tenant_scope", "PRIVATE"),
    ("schema_version", "AstarterPublicData.v2"),
    ("projection_version", "public-data-projection.v2"),
    ("revision", 0), ("revision", 1.5), ("fetched_at_ms", -1),
    ("refresh_at_ms", NOW - 1), ("payload_json", "{}"),
    ("payload_json", "not json"), ("last_good_json", "{}"),
    ("payload_json", None), ("last_good_json", None), ("refresh_at_ms", 253402300800000),
])
def test_actual_sql_constraints(tmp_path: Path, column: str, value: object) -> None:
    path = tmp_path / "public.sqlite"
    store = PublicDataStore(path, mode="offline_fixture")
    save_news(store)
    before = store.load("news")
    with sqlite3.connect(path) as db:
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(f"UPDATE public_data_cache SET {column} = ?", (value,))
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("INSERT INTO public_data_cache SELECT * FROM public_data_cache")
    assert store.load("news") == before
    store.close()


@pytest.mark.parametrize("column", ["payload_json", "last_good_json"])
def test_typed_json_corruption_fails_closed_on_read_and_reopen(
    tmp_path: Path, column: str,
) -> None:
    path = tmp_path / "public.sqlite"
    store = PublicDataStore(path, mode="offline_fixture")
    save_news(store)
    with sqlite3.connect(path) as db:
        db.execute(f"UPDATE public_data_cache SET {column} = "
                   f"json_set({column}, '$.as_of_ms', 'bad-timestamp')")
    before = path.read_bytes()
    with pytest.raises(PublicDataStoreError, match="^PUBLIC_DATA_STORE_FAILED$"):
        store.load("news")
    store.close()
    with pytest.raises(PublicDataStoreError, match="^PUBLIC_DATA_STORE_FAILED$"):
        PublicDataStore(path, mode="offline_fixture")
    assert path.read_bytes() == before


def test_lock_failure_rolls_back_entire_state_and_is_sanitized(tmp_path: Path) -> None:
    path = tmp_path / "private-location.sqlite"
    store = PublicDataStore(path, mode="offline_fixture")
    save_news(store)
    original = store.load("news")
    with sqlite3.connect(path) as blocker:
        blocker.execute("BEGIN IMMEDIATE")
        with pytest.raises(PublicDataStoreError, match="^PUBLIC_DATA_STORE_FAILED$"):
            save_news(store, revision=1, now=NOW + 10)
    assert store.load("news") == original
    save_news(store, revision=1, now=NOW + 10)
    store.close()


def test_bounded_resource_and_typed_input_validation(tmp_path: Path) -> None:
    store = PublicDataStore(tmp_path / "public.sqlite", mode="offline_fixture")
    with pytest.raises(PublicDataStoreError):
        store.save("markets", payload=empty_news(), last_good=empty_news(),
                   fetched_at_ms=NOW, refresh_at_ms=NOW + 60000, expected_revision=0)
    invalid = empty_news().model_copy(update={"as_of_ms": "bad"})
    with pytest.raises(PublicDataStoreError):
        store.save("news", payload=invalid, last_good=empty_news(),
                   fetched_at_ms=NOW, refresh_at_ms=NOW + 60000, expected_revision=0)
    with pytest.raises(PublicDataStoreError):
        store.save("news", payload=empty_news(), last_good=empty_news(),
                   fetched_at_ms=True, refresh_at_ms=NOW + 60000, expected_revision=0)
    assert store.load("news") is None
    store.close()
    with pytest.raises(PublicDataStoreError, match="^PUBLIC_DATA_STORE_FAILED$"):
        store.load("news")


@pytest.mark.parametrize("mutation", [
    "PRAGMA user_version = 2", "PRAGMA application_id = 77",
    "CREATE TABLE extra_private_table (id TEXT)",
])
def test_owned_schema_changes_are_rejected_without_migration(
    tmp_path: Path, mutation: str,
) -> None:
    path = tmp_path / "public.sqlite"
    store = PublicDataStore(path, mode="offline_fixture")
    save_news(store)
    with sqlite3.connect(path) as db:
        db.execute(mutation)
    before = path.read_bytes()
    with pytest.raises(PublicDataStoreError):
        store.load("news")
    store.close()
    with pytest.raises(PublicDataStoreError):
        PublicDataStore(path, mode="offline_fixture")
    assert path.read_bytes() == before


def test_current_and_last_good_cannot_disagree_on_observation(tmp_path: Path) -> None:
    store = PublicDataStore(tmp_path / "public.sqlite", mode="offline_fixture")
    changed = empty_news().model_copy(update={"as_of_ms": NOW - 1})
    with pytest.raises(PublicDataStoreError):
        store.save("news", payload=changed, last_good=empty_news(), fetched_at_ms=NOW,
                   refresh_at_ms=NOW + 60000, expected_revision=0)
    assert store.load("news") is None
    store.close()
