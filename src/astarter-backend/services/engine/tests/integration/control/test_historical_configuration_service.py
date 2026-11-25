"""Stored configuration to actual catalog/runtime-bound input, without run authority."""

import json
from hashlib import sha256

import pytest

from stark_trading_os.audit.historical_input import parse_input_manifest_bytes
from stark_trading_os.catalog.fixture_publisher import FixturePublisher
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.strategy_configurations import (
    StrategyConfigurationIntegrityError,
    StrategyConfigurationUnknown,
)
from stark_trading_os.runner.historical_cost import historical_cost_bytes
from stark_trading_os.runner.historical_input_adapter import load_historical_runner_input
from tests.integration.catalog.test_historical_publication import _source
from tests.integration.control.test_historical_configurations import DRAFT, NOW, VERSION, config


@pytest.fixture
def setup(tmp_path):
    store = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: NOW)
    publisher = FixturePublisher(registry=None, control=store, runtime_root=tmp_path / "runtime")
    publication = publisher.publish_historical(_source())
    try:
        yield store, publisher, publication
    finally:
        store.close()


def service_for(store, root, *, draft_id=DRAFT, version_id=VERSION):
    from stark_trading_os.control.historical_configuration_service import (
        HistoricalConfigurationService,
    )

    return HistoricalConfigurationService(
        store=store,
        runtime_root=root,
        draft_id_factory=lambda: draft_id,
        configuration_id_factory=lambda: version_id,
    )


def prepared(setup, tmp_path):
    store, _, publication = setup
    service = service_for(store, tmp_path / "runtime")
    draft = service.create_draft(config(publication.catalog_revision))
    version = service.publish_draft(draft_id=draft.draft_id, expected_revision=draft.revision)
    return service, draft, version


def assert_no_run(store):
    assert tuple(
        store._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in ("runs", "preflights", "runner_processes", "runner_outcomes")
    ) == (0, 0, 0, 0)


def test_candidate_rejects_corrupted_version_ordinal(setup, tmp_path):
    from stark_trading_os.control.historical_configuration_service import (
        HistoricalInputCandidateError,
    )

    store, _, publication = setup
    service = service_for(store, tmp_path / "runtime")
    draft = service.create_draft(config(publication.catalog_revision))
    service.update_draft(
        draft_id=draft.draft_id, expected_revision=1, configuration=draft.configuration
    )
    version = service.publish_draft(draft_id=draft.draft_id, expected_revision=2)
    assert version.version == 1 and version.source_revision == 2
    store._connection.execute("DROP TRIGGER trg_historical_strategy_versions_reject_update")
    store._connection.execute("UPDATE strategy_configuration_versions SET version=2")
    with pytest.raises(HistoricalInputCandidateError):
        service.build_input_candidate(version.configuration_id)
    assert_no_run(store)


def test_server_ids_and_stored_version_produce_loader_compatible_input(setup, tmp_path):
    store, _, publication = setup
    service, draft, version = prepared(setup, tmp_path)
    candidate = service.build_input_candidate(VERSION)
    assert draft.draft_id == DRAFT and version.configuration_id == VERSION
    assert service.drafts() == (draft,) and service.versions(DRAFT) == (version,)
    assert service.draft(DRAFT) == draft and service.configuration(VERSION) == version
    assert candidate.configuration_id == VERSION and candidate.configuration_version == 1
    assert candidate.configuration_content_sha256 == version.content_sha256
    assert candidate.catalog_revision == publication.catalog_revision
    assert candidate.input_manifest_sha256 == sha256(candidate.input_manifest_bytes).hexdigest()
    manifest = parse_input_manifest_bytes(
        candidate.input_manifest_bytes, expected_sha256=candidate.input_manifest_sha256
    )
    assert manifest.configuration.configuration == version.configuration
    assert manifest.configuration_id == VERSION and manifest.configuration_version == 1
    assert manifest.dataset.record_count == 2 and manifest.dataset.purpose == "SYNTHETIC_QA"
    assert (
        manifest.cost_sha256
        == sha256(historical_cost_bytes(version.configuration.execution_cost)).hexdigest()
    )
    assert (
        manifest.runtime.native_extension_sha256
        == json.loads(publication.publication_bytes)["inventory"]["native_fingerprint"][
            "native_extension_sha256"
        ]
    )
    assert manifest.execution.account_type == "CASH" and manifest.execution.oms_type == "NETTING"
    assert manifest.execution.allow_cash_borrowing is False
    assert_no_run(store)
    # Staging is a test-owned loader fixture, not service-created run state.
    run_id = "bt_" + "1" * 32
    staging = tmp_path / "runtime/staging" / run_id
    staging.mkdir(parents=True, mode=0o700)
    staging.parent.chmod(0o700)
    path = staging / "input-manifest.json"
    path.write_bytes(candidate.input_manifest_bytes)
    path.chmod(0o600)
    loaded = load_historical_runner_input(
        run_id=run_id,
        staging_dir=staging,
        input_manifest=path,
        expected_input_sha256=candidate.input_manifest_sha256,
    )
    assert len(loaded.bars) == 2
    assert (
        loaded.manifest == manifest
        and loaded.input_manifest_hash == candidate.input_manifest_sha256
    )
    assert_no_run(store)


def test_draft_changes_and_publish_retries_preserve_previous_candidate(setup, tmp_path):
    store, _, publication = setup
    service, draft, version = prepared(setup, tmp_path)
    first = service.build_input_candidate(VERSION)
    updated = service.update_draft(
        draft_id=DRAFT,
        expected_revision=1,
        configuration=config(publication.catalog_revision, name="Later draft"),
    )
    assert updated.revision == 2 and updated.configuration.name == "Later draft"
    assert service.publish_draft(draft_id=DRAFT, expected_revision=1) == version
    assert service.build_input_candidate(VERSION) == first
    assert_no_run(store)


@pytest.mark.parametrize("file_kind", ["source", "native", "manifest"])
def test_candidate_rejects_real_published_file_corruption(setup, tmp_path, file_kind):
    from stark_trading_os.control.historical_configuration_service import (
        HistoricalInputCandidateError,
    )

    store, _, publication = setup
    service, _, _ = prepared(setup, tmp_path)
    directory = tmp_path / "runtime/catalogs" / publication.catalog_revision
    path = (
        directory / "source/bars.csv"
        if file_kind == "source"
        else directory / "catalog-manifest.json"
    )
    if file_kind == "native":
        path = next(directory.rglob("*.parquet"))
    path.chmod(0o600)
    path.write_bytes(path.read_bytes() + b"private-test-marker")
    path.chmod(0o400)
    with pytest.raises(HistoricalInputCandidateError) as caught:
        service.build_input_candidate(VERSION)
    assert "private-test-marker" not in str(caught.value)
    assert store.catalog_publication(publication.catalog_revision).status == "INTEGRITY_FAILED"
    assert_no_run(store)


@pytest.mark.parametrize(
    "change", ["runtime", "status_during", "file_during", "already_failed", "configuration"]
)
def test_candidate_rejects_changed_authority_and_runtime(setup, tmp_path, monkeypatch, change):
    import stark_trading_os.control.historical_configuration_service as module

    store, _, publication = setup
    service, _, _ = prepared(setup, tmp_path)

    def fail_catalog():
        store.mark_catalog_integrity_failed(
            **{
                name: getattr(publication, name)
                for name in (
                    "catalog_revision",
                    "fixture_id",
                    "inventory_hash",
                    "publication_bytes",
                    "staging_identity",
                )
            }
        )

    observe = module.observe_historical_runtime

    def changed_runtime():
        actual = observe()
        if change == "runtime":
            return actual.model_copy(update={"native_extension_sha256": "f" * 64})
        if change == "status_during":
            fail_catalog()
        if change == "file_during":
            path = tmp_path / "runtime/catalogs" / publication.catalog_revision / "source/bars.csv"
            path.chmod(0o600)
            path.write_bytes(path.read_bytes() + b"changed during observation")
            path.chmod(0o400)
        return actual

    if change == "already_failed":
        fail_catalog()
    elif change == "configuration":
        store._connection.execute("DROP TRIGGER trg_historical_strategy_versions_reject_update")
        store._connection.execute(
            "UPDATE strategy_configuration_versions SET content_sha256=?", ("f" * 64,)
        )
    else:
        monkeypatch.setattr(module, "observe_historical_runtime", changed_runtime)
    with pytest.raises(module.HistoricalInputCandidateError):
        service.build_input_candidate(VERSION)
    assert_no_run(store)


def test_candidate_cannot_substitute_another_control_database_or_runtime(setup, tmp_path):
    from stark_trading_os.control.historical_configuration_service import (
        HistoricalInputCandidateError,
    )

    store, _, _ = setup
    prepared(setup, tmp_path)
    other = ControlStore.open(tmp_path / "other.sqlite")
    try:
        with pytest.raises(HistoricalInputCandidateError):
            service_for(other, tmp_path / "runtime").build_input_candidate(VERSION)
        assert_no_run(other)
    finally:
        other.close()
    with pytest.raises(HistoricalInputCandidateError):
        service_for(store, tmp_path / "missing-runtime").build_input_candidate(VERSION)
    assert_no_run(store)


def test_invalid_server_generated_id_cannot_persist_draft(setup, tmp_path):
    store, _, publication = setup
    service = service_for(store, tmp_path / "runtime", draft_id="private-invalid-id")
    with pytest.raises(StrategyConfigurationIntegrityError):
        service.create_draft(config(publication.catalog_revision))
    assert store.historical_strategy_drafts() == ()
    with pytest.raises(StrategyConfigurationUnknown):
        service.configuration(VERSION)
    assert_no_run(store)
