from __future__ import annotations

import json
import shutil
import threading
from collections.abc import Callable
from hashlib import sha256
from pathlib import Path

import pytest
from pydantic import ValidationError

import stark_trading_os.control.preflight as preflight_module
import stark_trading_os.control.transactions as transactions_module
from stark_trading_os.audit.canonical_json import canonical_json_bytes, parse_json_object
from stark_trading_os.catalog.fixture_publisher import FixturePublisher
from stark_trading_os.catalog.fixture_registry import FixtureRegistry
from stark_trading_os.control.preflight import (
    EngineIdentity,
    PreflightResponse,
    PreflightService,
    PreflightStale,
    RegisteredDefinition,
)
from stark_trading_os.control.registry import (
    CatalogPublication,
    ControlStore,
    ControlStoreError,
    ControlTransaction,
    EventCandidate,
    EventRejected,
    IdempotencyCommand,
    IdempotentResponse,
    PreflightReadyEvidence,
    PreflightSnapshot,
)
from stark_trading_os.domain.models import (
    BacktestDraftRequest,
    CatalogManifestV1,
    InputManifestV1,
    RunState,
)

REPOSITORY_ROOT = Path(__file__).parents[5]


class MutableClock:
    def __init__(self, value: int = 1_800_000_000_000_000_000) -> None:
        self.value = value
        self.calls = 0

    def __call__(self) -> int:
        self.calls += 1
        return self.value


class SequentialIds:
    def __init__(self, prefix: str) -> None:
        self.prefix = prefix
        self.calls = 0

    def __call__(self) -> str:
        self.calls += 1
        return f"{self.prefix}_{self.calls:03d}"


class CountingCatalog:
    def __init__(self, publisher: FixturePublisher) -> None:
        self.publisher = publisher
        self.calls: list[str] = []

    def revalidate(self, catalog_revision: str):
        self.calls.append(catalog_revision)
        return self.publisher.revalidate(catalog_revision)


def _definition(identifier: str, version: str, value: dict[str, object]) -> RegisteredDefinition:
    raw = canonical_json_bytes(value)
    return RegisteredDefinition(
        identifier=identifier,
        version=version,
        canonical_bytes=raw,
        sha256=sha256(raw).hexdigest(),
    )


def _schema_less_bytes(value: dict[str, object]) -> bytes:
    wrapped = canonical_json_bytes({"value": value})
    prefix = b'{"value":'
    assert wrapped.startswith(prefix) and wrapped.endswith(b"}")
    return wrapped[len(prefix) : -1]


def _schema_less_object(value: bytes) -> dict[str, object]:
    wrapped = parse_json_object(b'{"value":' + value + b"}")
    parsed = wrapped["value"]
    assert isinstance(parsed, dict)
    return parsed


def _cost_fill() -> dict[str, object]:
    return {
        "schema": "CostFillModel.v1",
        "fee": {
            "model": "MakerTakerFeeModel",
            "rate_source": "INSTRUMENT_MAKER_TAKER",
            "rate_unit": "NOTIONAL_DECIMAL_FRACTION",
            "charge_currency": "INSTRUMENT_QUOTE_CURRENCY",
            "minimum_fee": "0",
            "application": "PER_FILL",
            "decimal_precision": 8,
            "rounding_mode": "MIDPOINT_NEAREST_EVEN",
        },
        "spread": {"authority": "FIXTURE_BID_ASK"},
        "slippage": {
            "model": "DefaultFillModel",
            "prob_fill_on_limit": "1",
            "prob_slippage": "0",
            "random_seed_source": "INPUT_MANIFEST_REPLAY_SEED",
            "probabilistic_slippage": "DISABLED",
            "depth_price_impact": "DISABLED",
            "maximum_book_walk_ticks": "0",
        },
        "latency": {
            "model": "StaticLatencyModel",
            "decision_to_submit_ns": "0",
            "submit_to_venue_ns": "0",
            "base_latency_ns": "0",
            "insert_latency_ns": "0",
            "update_latency_ns": "0",
            "cancel_latency_ns": "0",
        },
        "liquidity": {
            "available_size_source": "RECORDED_QUOTE_TICK_BID_ASK_SIZE",
            "queue_assumption": "NOT_MODELED_AT_L1",
            "allocation_order": "SINGLE_ORDER_NO_ALLOCATION_COMPETITION",
            "partial_fill_schedule": "ON_RECORDED_QUOTE",
            "price_selection": "NATIVE_L1_BID_ASK_CROSS",
            "allow_partial_fills": True,
            "liquidity_consumption": True,
        },
        "cancel": {
            "acknowledgment_rule": "NATIVE",
            "remaining_quantity_disposition": "CANCEL_OPEN_REMAINDER",
            "time_in_force": "GTC",
        },
    }


def _draft(catalog_revision: str) -> BacktestDraftRequest:
    return BacktestDraftRequest.model_validate(
        {
            "environment": "BACKTEST",
            "strategy_ref": "determinism-probe@v1",
            "catalog_revision": catalog_revision,
            "window": {
                "start_ns": "1700000000000000000",
                "end_ns": "1700000000000000002",
            },
            "information_set_policy": {
                "schema": "InformationSetPolicy.v1",
                "availability_field": "ts_available_ns",
                "nautilus_timestamp_field": "ts_init",
                "visibility_rule": "AVAILABLE_AT_OR_BEFORE_DECISION",
                "tie_breakers": ["ts_available_ns", "source_seq", "record_hash"],
                "bar_rule": "CLOSED_AND_AVAILABLE",
                "source_revision_rule": "SINGLE_IMMUTABLE_REVISION",
            },
            "evaluation_protocol": {
                "schema": "EvaluationProtocol.v1",
                "mode": "fixture_only",
                "train": None,
                "tune": None,
                "out_of_sample": None,
                "purge_ns": "0",
                "embargo_ns": "0",
            },
            "venue_account_model": {
                "venue_id": "SIM",
                "oms_type": "HEDGING",
                "account_type": "MARGIN",
                "book_type": "L1_MBP",
                "routing": False,
                "use_random_ids": False,
                "use_position_ids": True,
                "allow_cash_borrowing": False,
                "starting_balance": "1000000",
                "currency": "USDT",
            },
            "cost_fill_model": _cost_fill(),
            "risk_policy_ref": "probe-risk@v1",
            "replay_seed": 7,
        }
    )


def _engine() -> EngineIdentity:
    return EngineIdentity(
        package_version="2.0.0rc3",
        tag_commit="648970ce64a304d93da0a29320cb6e19b905fa39",
        python_version="3.12.4",
        precision_mode="FIXED_PRECISION_16",
    )


def _service(
    *,
    control: ControlStore,
    catalog: CountingCatalog,
    clock: MutableClock,
    run_root: Path,
    engine: EngineIdentity | None = None,
    risk: RegisteredDefinition | None = None,
    run_id_factory: Callable[[], str] | None = None,
    preflight_id_factory: Callable[[], str] | None = None,
) -> PreflightService:
    strategy = _definition(
        "determinism-probe",
        "v1",
        {
            "entry_limit_price": "100",
            "entry_quantity": "15",
            "metric_round_trip_quantity": "1",
            "metric_round_trips": 5,
            "risk_probe_quantity": "20",
            "venue_rejection_quantity": "1",
        },
    )
    risk_definition = risk or _definition("probe-risk", "v1", {"max_notional": "1600"})
    return PreflightService(
        control=control,
        catalog=catalog,
        engine=engine or _engine(),
        strategy_resolver=lambda ref: strategy if ref == "determinism-probe@v1" else None,
        risk_resolver=lambda ref: risk_definition if ref == "probe-risk@v1" else None,
        clock=clock,
        run_id_factory=run_id_factory or SequentialIds("bt"),
        preflight_id_factory=preflight_id_factory or SequentialIds("pf"),
        token_ttl_ns=100,
        run_root=run_root,
    )


def _published_service(
    tmp_path: Path,
) -> tuple[PreflightService, ControlStore, CountingCatalog, MutableClock, CatalogPublication]:
    database = tmp_path / "control.sqlite"
    runtime = tmp_path / "trading"
    run_root = tmp_path / "runs"
    run_root.mkdir()
    control = ControlStore.open(database, clock=lambda: 10_000)
    publisher = FixturePublisher(
        registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
        control=control,
        runtime_root=runtime,
    )
    publication = publisher.publish("local-qa-v1")
    catalog = CountingCatalog(publisher)
    clock = MutableClock()
    return (
        _service(
            control=control,
            catalog=catalog,
            clock=clock,
            run_root=run_root,
        ),
        control,
        catalog,
        clock,
        publication,
    )


def _published_service_with_increment(
    tmp_path: Path,
    *,
    field: str,
    value: str,
) -> tuple[PreflightService, ControlStore, CatalogPublication]:
    fixture_root = tmp_path / "fixtures"
    shutil.copytree(REPOSITORY_ROOT / "data" / "fixtures", fixture_root)
    fixture = fixture_root / "local-qa-v1"
    instrument_path = fixture / "instrument.json"
    instrument = json.loads(instrument_path.read_bytes())
    instrument[field] = value
    if field == "size_increment":
        instrument["minimum_quantity"] = value
    instrument_bytes = json.dumps(
        instrument,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")
    instrument_path.write_bytes(instrument_bytes)

    quote_path = fixture / "quotes.jsonl"
    quotes = [json.loads(line) for line in quote_path.read_bytes().splitlines()]
    for quote in quotes:
        if field == "price_increment":
            quote["ask_price"] = "100.02"
        else:
            quote["bid_size"] = "9.999"
            quote["ask_size"] = "9.999"
        quote_without_hash = {key: item for key, item in quote.items() if key != "record_hash"}
        quote["record_hash"] = sha256(canonical_json_bytes(quote_without_hash)).hexdigest()
    quote_bytes = b"".join(
        json.dumps(
            quote,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
        + b"\n"
        for quote in quotes
    )
    quote_path.write_bytes(quote_bytes)

    manifest_path = fixture / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    manifest["instrument"]["sha256"] = sha256(instrument_bytes).hexdigest()
    manifest["quote_shards"][0]["sha256"] = sha256(quote_bytes).hexdigest()
    manifest_bytes = json.dumps(
        manifest,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")
    manifest_path.write_bytes(manifest_bytes)
    sums = "".join(
        f"{sha256((fixture / relative_path).read_bytes()).hexdigest()}  {relative_path}\n"
        for relative_path in ("instrument.json", "manifest.json", "quotes.jsonl")
    )
    (fixture / "SHA256SUMS").write_text(sums, encoding="ascii")
    registry_path = fixture_root / "registry.json"
    registry = json.loads(registry_path.read_bytes())
    registry["fixtures"]["local-qa-v1"]["manifest_sha256"] = sha256(manifest_bytes).hexdigest()
    registry_path.write_bytes(
        json.dumps(
            registry,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
    )

    control = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: 10_000)
    run_root = tmp_path / "runs"
    run_root.mkdir()
    publisher = FixturePublisher(
        registry=FixtureRegistry(fixture_root),
        control=control,
        runtime_root=tmp_path / "trading",
    )
    publication = publisher.publish("local-qa-v1")
    service = _service(
        control=control,
        catalog=CountingCatalog(publisher),
        clock=MutableClock(),
        run_root=run_root,
    )
    return service, control, publication


@pytest.mark.parametrize(
    ("field", "value"),
    [("price_increment", "0.03"), ("size_increment", "0.003")],
)
def test_preflight_blocks_strategy_values_not_aligned_to_catalog_increments(
    tmp_path: Path, field: str, value: str
) -> None:
    service, control, publication = _published_service_with_increment(
        tmp_path,
        field=field,
        value=value,
    )
    try:
        result = service.run(
            _draft(publication.catalog_revision),
            idempotency_key=f"strategy-increment-{field}",
        )

        assert result.state is RunState.PREFLIGHT_BLOCKED
        assert "STRATEGY_UNSUPPORTED" in {check.code for check in result.checks if not check.passed}
        assert "STRATEGY_VALID" not in {check.code for check in result.checks}
    finally:
        control.close()


@pytest.mark.parametrize("read_kind", ["preflight", "idempotent", "service_replay"])
def test_misaligned_strategy_check_cannot_be_flipped_and_relinked_to_valid(
    tmp_path: Path, read_kind: str
) -> None:
    service, control, publication = _published_service_with_increment(
        tmp_path,
        field="price_increment",
        value="0.03",
    )
    draft = _draft(publication.catalog_revision)
    key = f"misaligned-strategy-flip-{read_kind}"
    blocked = service.run(draft, idempotency_key=key)
    stored = control.preflight(blocked.preflight_id)
    assert stored is not None
    result = _schema_less_object(stored.result_bytes)
    checks = result["checks"]
    assert isinstance(checks, list)
    check_index = next(
        index for index, item in enumerate(checks) if item["code"] == "STRATEGY_UNSUPPORTED"
    )
    checks[check_index] = {"code": "STRATEGY_VALID", "passed": True}
    cover_index = next(
        index for index, item in enumerate(checks) if item["code"] == "RISK_POLICY_VALID"
    )
    checks[cover_index] = {"code": "RISK_POLICY_HASH_MISMATCH", "passed": False}
    tampered_bytes = _schema_less_bytes(result)
    control._connection.execute(
        "UPDATE preflights SET result_bytes = ? WHERE preflight_id = ?",
        (tampered_bytes, blocked.preflight_id),
    )
    control._connection.execute(
        "UPDATE idempotency_records SET response_body = ? WHERE idempotency_key = ?",
        (tampered_bytes, key),
    )
    command = IdempotencyCommand.preflight(
        key=key,
        canonical_request_bytes=stored.request_bytes,
    )

    try:
        with pytest.raises((ControlStoreError, ValueError), match="preflight|Preflight"):
            if read_kind == "preflight":
                control.preflight(blocked.preflight_id)
            elif read_kind == "idempotent":
                control.idempotent_response(command)
            else:
                service.run(draft, idempotency_key=key)
    finally:
        control.close()


def _consume_exact(
    transaction: ControlTransaction,
    *,
    stored: PreflightSnapshot,
    publication: CatalogPublication,
    consumed_at_ns: int,
) -> None:
    assert stored.input_manifest_bytes is not None
    assert stored.input_manifest_hash is not None
    assert stored.catalog_revision is not None
    assert stored.catalog_inventory_hash is not None
    assert stored.engine_package_version is not None
    assert stored.engine_tag_commit is not None
    assert stored.risk_policy_hash is not None
    manifest = InputManifestV1.model_validate_json(stored.input_manifest_bytes)
    transaction.consume_preflight(
        preflight_id=stored.preflight_id,
        expected_request_hash=stored.request_hash,
        expected_manifest_bytes=stored.input_manifest_bytes,
        expected_manifest_hash=stored.input_manifest_hash,
        expected_catalog_revision=stored.catalog_revision,
        expected_catalog_inventory_hash=stored.catalog_inventory_hash,
        expected_catalog_publication_bytes=publication.publication_bytes,
        expected_engine_package_version=stored.engine_package_version,
        expected_engine_tag_commit=stored.engine_tag_commit,
        expected_python_version=manifest.python_version,
        expected_precision_mode=manifest.precision_mode,
        expected_risk_policy_hash=stored.risk_policy_hash,
        consumed_at_ns=consumed_at_ns,
    )


def _tampered_create_response(
    stored: PreflightSnapshot,
    attack: str,
) -> bytes:
    assert stored.input_manifest_hash is not None
    value: dict[str, object] = {
        "input_manifest_hash": stored.input_manifest_hash,
        "last_visible_seq": 2,
        "run_id": stored.run_id,
        "state": "QUEUED",
        "state_version": 2,
    }
    if attack == "extra":
        value["extra"] = True
    elif attack == "missing":
        del value["input_manifest_hash"]
    elif attack == "input_manifest_hash_value":
        value["input_manifest_hash"] = "f" * 64
    elif attack == "input_manifest_hash_type":
        value["input_manifest_hash"] = 7
    elif attack == "last_visible_seq_value":
        value["last_visible_seq"] = 3
    elif attack == "last_visible_seq_type":
        value["last_visible_seq"] = "2"
    elif attack == "run_id_value":
        value["run_id"] = "bt_other"
    elif attack == "run_id_type":
        value["run_id"] = 7
    elif attack == "state_value":
        value["state"] = "PREFLIGHT_READY"
    elif attack == "state_type":
        value["state"] = 7
    elif attack == "state_version_value":
        value["state_version"] = 3
    elif attack == "state_version_type":
        value["state_version"] = "2"
    else:
        raise AssertionError(f"Unknown create response attack: {attack}")
    return _schema_less_bytes(value)


def test_ready_persists_one_exact_manifest_and_consumes_same_bytes_to_queued(
    tmp_path: Path,
) -> None:
    service, control, catalog, _clock, publication = _published_service(tmp_path)
    run_root = tmp_path / "runs"
    draft = _draft(publication.catalog_revision)
    bare_request_bytes = canonical_json_bytes(draft.model_dump(mode="json", by_alias=True))
    command = IdempotencyCommand.preflight(
        key="preflight-ready",
        canonical_request_bytes=bare_request_bytes,
    )
    try:
        preflight = service.run(draft, idempotency_key="preflight-ready")
        assert preflight.state is RunState.PREFLIGHT_READY
        assert preflight.input_manifest_hash is not None
        stored = control.preflight(preflight.preflight_id)
        assert stored is not None and stored.input_manifest_bytes is not None
        assert stored.request_bytes == bare_request_bytes
        assert stored.request_hash == sha256(bare_request_bytes).hexdigest()
        assert preflight.canonical_request_hash == stored.request_hash
        assert sha256(stored.input_manifest_bytes).hexdigest() == stored.input_manifest_hash
        assert stored.catalog_revision == publication.catalog_revision
        assert stored.catalog_inventory_hash == publication.inventory_hash
        assert control.run(preflight.run_id).input_manifest_bytes == stored.input_manifest_bytes
        manifest = InputManifestV1.model_validate_json(stored.input_manifest_bytes)
        catalog_manifest = CatalogManifestV1.model_validate_json(publication.publication_bytes)
        assert manifest.replay_seed == 7
        assert manifest.catalog_revision == sha256(publication.publication_bytes).hexdigest()
        assert catalog_manifest.inventory_hash == publication.inventory_hash
        assert manifest.source_checksum == catalog_manifest.source_checksum
        assert manifest.catalog_checksum == catalog_manifest.catalog_checksum
        assert manifest.fixture_id == catalog_manifest.fixture_id
        assert manifest.instruments[0].instrument_id == (
            catalog_manifest.inventory.instrument.instrument_id
        )
        assert not hasattr(manifest.cost_fill_model, "replay_seed")
        assert manifest.cost_fill_model.liquidity.available_size_source == (
            "RECORDED_QUOTE_TICK_BID_ASK_SIZE"
        )
        assert manifest.cost_fill_model.liquidity.liquidity_consumption is True
        assert manifest.cost_fill_model.slippage.prob_slippage == "0"
        assert manifest.cost_fill_model.cancel.time_in_force == "GTC"
        assert list(run_root.iterdir()) == []
        preflight_record = control._connection.execute(
            """
            SELECT request_body, response_body
            FROM idempotency_records
            WHERE idempotency_scope = 'backtest.preflight'
            """
        ).fetchone()
        assert preflight_record is not None
        assert preflight_record["request_body"] == command.logical_request_bytes
        assert preflight_record["request_body"] != stored.request_bytes
        assert preflight_record["response_body"] == stored.result_bytes

        reservation = service.consume_ready(
            preflight.preflight_id,
            preflight.canonical_request_hash,
            idempotency_key="create-ready",
        )

        assert reservation.state is RunState.QUEUED
        assert reservation.run_id == preflight.run_id
        assert reservation.input_manifest_bytes == stored.input_manifest_bytes
        assert reservation.input_manifest_hash == stored.input_manifest_hash
        assert control.run(preflight.run_id).state is RunState.QUEUED
        assert [event.type for event in control.events(preflight.run_id)] == [
            "preflight.passed",
            "run.queued",
        ]
        assert list(run_root.iterdir()) == []
        assert catalog.calls == [publication.catalog_revision, publication.catalog_revision]
        create_record = control._connection.execute(
            """
            SELECT request_body
            FROM idempotency_records
            WHERE idempotency_scope = 'backtest.create'
            """
        ).fetchone()
        assert create_record is not None
        create_bare_request = canonical_json_bytes(
            {
                "canonical_request_hash": preflight.canonical_request_hash,
                "preflight_id": preflight.preflight_id,
            }
        )
        create_command = IdempotencyCommand.create(
            key="create-ready",
            canonical_request_bytes=create_bare_request,
        )
        assert create_record["request_body"] == create_command.logical_request_bytes
        assert create_record["request_body"] != create_bare_request
    finally:
        control.close()


def test_enriched_preflight_result_bytes_are_persisted_and_replayed_exactly(
    tmp_path: Path,
) -> None:
    service, control, _catalog, clock, publication = _published_service(tmp_path)
    key = "enriched-preflight-response"
    draft = _draft(publication.catalog_revision)

    try:
        first = service.run(draft, idempotency_key=key)
        stored = control.preflight(first.preflight_id)
        assert stored is not None
        persisted = control._connection.execute(
            """
            SELECT response_body
            FROM idempotency_records
            WHERE idempotency_scope = 'backtest.preflight' AND idempotency_key = ?
            """,
            (key,),
        ).fetchone()
        assert persisted is not None
        assert persisted["response_body"] == stored.result_bytes

        result_object = _schema_less_object(stored.result_bytes)
        checks = result_object["checks"]
        assert isinstance(checks, list) and checks
        assert all(
            isinstance(check, dict)
            and set(check) == {"checked_at_ns", "code", "evidence", "explanation", "passed"}
            for check in checks
        )
        assert {check["checked_at_ns"] for check in checks if isinstance(check, dict)} == {
            1_800_000_000_000_000_000
        }
        assert all(
            isinstance(check["explanation"], str)
            and bool(check["explanation"])
            and isinstance(check["evidence"], list)
            and bool(check["evidence"])
            for check in checks
            if isinstance(check, dict)
        )

        before_replay = stored.result_bytes
        clock_calls = clock.calls
        assert service.run(draft, idempotency_key=key) == first
        replayed = control.preflight(first.preflight_id)
        assert replayed is not None
        assert replayed.result_bytes == before_replay
        assert clock.calls == clock_calls
    finally:
        control.close()


def test_published_catalog_engine_drift_persists_blocked_historical_evidence(
    tmp_path: Path,
) -> None:
    service, control, _catalog, clock, publication = _published_service(tmp_path)
    service._engine = EngineIdentity(
        package_version="2.0.0rc2",
        tag_commit="648970ce64a304d93da0a29320cb6e19b905fa39",
        python_version="3.12.4",
        precision_mode="FIXED_PRECISION_16",
    )
    key = "published-engine-drift"
    draft = _draft(publication.catalog_revision)

    try:
        first = service.run(draft, idempotency_key=key)
        assert first.state is RunState.PREFLIGHT_BLOCKED
        assert {check.code for check in first.checks if not check.passed} >= {
            "ENGINE_VERSION_MISMATCH",
            "PRECISION_MISMATCH",
        }
        stored = control.preflight(first.preflight_id)
        assert stored is not None
        exact_bytes = stored.result_bytes
        clock_calls = clock.calls

        service._engine = _engine()
        replay = service.run(draft, idempotency_key=key)

        assert replay == first
        replayed = control.preflight(first.preflight_id)
        assert replayed is not None
        assert replayed.result_bytes == exact_bytes
        assert clock.calls == clock_calls
    finally:
        control.close()


def test_historical_ready_replay_survives_pin_upgrade_but_consume_stays_stale(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, control, _catalog, clock, publication = _published_service(tmp_path)
    key = "historical-ready-pin-upgrade"
    draft = _draft(publication.catalog_revision)

    try:
        first = service.run(draft, idempotency_key=key)
        stored = control.preflight(first.preflight_id)
        assert stored is not None
        exact_bytes = stored.result_bytes
        clock_calls = clock.calls

        for module in (preflight_module, transactions_module):
            monkeypatch.setattr(module, "PINNED_ENGINE_PACKAGE_VERSION", "2.0.0rc4")
            monkeypatch.setattr(module, "PINNED_ENGINE_TAG_COMMIT", "f" * 40)
            monkeypatch.setattr(module, "PINNED_ENGINE_PYTHON_VERSION", "3.12.5")
            monkeypatch.setattr(module, "PINNED_ENGINE_PRECISION_MODE", "FIXED_PRECISION_32")

        replay = service.run(draft, idempotency_key=key)
        reread = control.preflight(first.preflight_id)
        assert replay == first
        assert reread is not None and reread.result_bytes == exact_bytes
        assert clock.calls == clock_calls

        with pytest.raises(PreflightStale, match="PREFLIGHT_STALE"):
            service.consume_ready(
                first.preflight_id,
                first.canonical_request_hash,
                idempotency_key="historical-ready-consume",
            )

        retained = control.preflight(first.preflight_id)
        assert retained is not None and retained.consumed_at_ns is None
        assert control.run(first.run_id).state is RunState.PREFLIGHT_READY
        assert [event.type for event in control.events(first.run_id)] == ["preflight.passed"]
        assert control.runner_process(first.run_id) is None
        create_records = control._connection.execute(
            "SELECT COUNT(*) FROM idempotency_records WHERE idempotency_scope = 'backtest.create'"
        ).fetchone()
        assert create_records is not None and create_records[0] == 0
    finally:
        control.close()


def test_long_nanosecond_window_is_persisted_as_blocked_evidence_and_replayed(
    tmp_path: Path,
) -> None:
    service, control, _catalog, clock, publication = _published_service(tmp_path)
    draft_object = _draft(publication.catalog_revision).model_dump(mode="json", by_alias=True)
    draft_object["window"] = {
        "start_ns": "1" + ("0" * 128),
        "end_ns": "2" + ("0" * 128),
    }
    draft = BacktestDraftRequest.model_validate(draft_object)
    key = "long-nanosecond-window"

    try:
        first = service.run(draft, idempotency_key=key)
        check = next(item for item in first.checks if item.code == "WINDOW_OUT_OF_RANGE")
        assert first.state is RunState.PREFLIGHT_BLOCKED
        assert [fact.value for fact in check.evidence[:2]] == [
            draft.window.start_ns,
            draft.window.end_ns,
        ]
        stored = control.preflight(first.preflight_id)
        assert stored is not None
        exact_bytes = stored.result_bytes
        clock_calls = clock.calls

        assert service.run(draft, idempotency_key=key) == first
        replayed = control.preflight(first.preflight_id)
        assert replayed is not None and replayed.result_bytes == exact_bytes
        assert clock.calls == clock_calls
    finally:
        control.close()


@pytest.mark.parametrize("attack", ["supported_model", "missing_section", "balance"])
def test_request_bound_cost_and_balance_fact_tamper_fails_closed(
    tmp_path: Path,
    attack: str,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    draft_object = _draft(publication.catalog_revision).model_dump(mode="json", by_alias=True)
    if attack == "missing_section":
        cost_fill = draft_object["cost_fill_model"]
        assert isinstance(cost_fill, dict)
        cost_fill["fee"] = None
    elif attack == "balance":
        account = draft_object["venue_account_model"]
        assert isinstance(account, dict)
        account["starting_balance"] = "-1"
    draft = BacktestDraftRequest.model_validate(draft_object)
    key = f"request-bound-tamper-{attack}"
    response = service.run(draft, idempotency_key=key)
    stored = control.preflight(response.preflight_id)
    assert stored is not None
    result = _schema_less_object(stored.result_bytes)
    checks = result["checks"]
    assert isinstance(checks, list)
    if attack == "supported_model":
        code = "COST_FILL_SUPPORTED"
        fact_name = "fee_model"
        replacement = "FixedFeeModel"
    elif attack == "missing_section":
        code = "COST_FEE_MISSING"
        fact_name = "required_section"
        replacement = "spread"
    else:
        code = "BALANCE_INVALID"
        fact_name = "starting_balance"
        replacement = "-2"
    target = next(item for item in checks if item["code"] == code)
    evidence = target["evidence"]
    fact = next(item for item in evidence if item["name"] == fact_name)
    fact["value"] = replacement
    tampered_bytes = _schema_less_bytes(result)
    control._connection.execute(
        "UPDATE preflights SET result_bytes = ? WHERE preflight_id = ?",
        (tampered_bytes, stored.preflight_id),
    )
    control._connection.execute(
        "UPDATE idempotency_records SET response_body = ? WHERE idempotency_key = ?",
        (tampered_bytes, key),
    )

    try:
        with pytest.raises(ControlStoreError, match="preflight|Preflight"):
            control.preflight(stored.preflight_id)
    finally:
        control.close()


@pytest.mark.parametrize("read_kind", ["preflight", "idempotent", "service_replay"])
def test_legacy_code_passed_only_preflight_bytes_fail_closed(
    tmp_path: Path,
    read_kind: str,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    key = f"legacy-preflight-{read_kind}"
    draft = _draft(publication.catalog_revision)
    response = service.run(draft, idempotency_key=key)
    stored = control.preflight(response.preflight_id)
    assert stored is not None
    result = _schema_less_object(stored.result_bytes)
    checks = result["checks"]
    assert isinstance(checks, list) and checks
    result["checks"] = [
        {"code": check["code"], "passed": check["passed"]}
        for check in checks
        if isinstance(check, dict)
    ]
    legacy_bytes = _schema_less_bytes(result)
    control._connection.execute(
        "UPDATE preflights SET result_bytes = ? WHERE preflight_id = ?",
        (legacy_bytes, stored.preflight_id),
    )
    control._connection.execute(
        "UPDATE idempotency_records SET response_body = ? WHERE idempotency_key = ?",
        (legacy_bytes, key),
    )
    command = IdempotencyCommand.preflight(
        key=key,
        canonical_request_bytes=stored.request_bytes,
    )

    try:
        with pytest.raises(ControlStoreError, match="preflight|Preflight"):
            if read_kind == "preflight":
                control.preflight(stored.preflight_id)
            elif read_kind == "idempotent":
                control.idempotent_response(command)
            else:
                service.run(draft, idempotency_key=key)
    finally:
        control.close()


@pytest.mark.parametrize(
    "attack",
    [
        "missing_fact",
        "extra_fact",
        "unknown_fact",
        "tampered_fact",
        "reordered_facts",
        "explanation_swap",
        "code_swap",
    ],
)
def test_enriched_preflight_fact_tamper_fails_closed(
    tmp_path: Path,
    attack: str,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    key = f"enriched-tamper-{attack}"
    draft = _draft(publication.catalog_revision)
    response = service.run(draft, idempotency_key=key)
    stored = control.preflight(response.preflight_id)
    assert stored is not None
    result = _schema_less_object(stored.result_bytes)
    checks = result["checks"]
    assert isinstance(checks, list) and checks
    target = next(
        (
            check
            for check in checks
            if isinstance(check, dict) and check.get("code") == "WINDOW_VALID"
        ),
        None,
    )
    assert isinstance(target, dict)
    assert set(target) == {"checked_at_ns", "code", "evidence", "explanation", "passed"}
    evidence = target["evidence"]
    assert isinstance(evidence, list) and len(evidence) >= 2
    first_fact = evidence[0]
    assert isinstance(first_fact, dict)
    assert first_fact == {
        "name": "requested_start_ns",
        "value": draft.window.start_ns,
    }

    if attack == "missing_fact":
        evidence.pop()
    elif attack == "extra_fact":
        evidence.append({"name": "extra_authority", "value": "FORGED"})
    elif attack == "unknown_fact":
        first_fact["name"] = "unknown_authority"
    elif attack == "tampered_fact":
        first_fact["value"] = "1800000000000000000"
    elif attack == "reordered_facts":
        evidence[0], evidence[1] = evidence[1], evidence[0]
    elif attack == "explanation_swap":
        target["explanation"] = "The requested window is outside the published catalog range."
    elif attack == "code_swap":
        target["code"] = "WINDOW_OUT_OF_RANGE"
        target["passed"] = False
    else:
        raise AssertionError(f"Unknown rich-check attack: {attack}")

    tampered_bytes = _schema_less_bytes(result)
    control._connection.execute(
        "UPDATE preflights SET result_bytes = ? WHERE preflight_id = ?",
        (tampered_bytes, stored.preflight_id),
    )
    control._connection.execute(
        "UPDATE idempotency_records SET response_body = ? WHERE idempotency_key = ?",
        (tampered_bytes, key),
    )

    try:
        with pytest.raises(ControlStoreError, match="preflight|Preflight"):
            control.preflight(stored.preflight_id)
    finally:
        control.close()


@pytest.mark.parametrize(
    "invalid_checked_at_ns",
    [
        1_800_000_000,
        1_800_000_000_000,
        1_800_000_000_000_000,
        True,
        -1,
        9_223_372_036_854_775_808,
    ],
    ids=["seconds", "milliseconds", "microseconds", "bool", "negative", "int64-overflow"],
)
def test_persisted_preflight_rejects_invalid_checked_at_ns(
    tmp_path: Path,
    invalid_checked_at_ns: object,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    key = f"persisted-invalid-clock-{type(invalid_checked_at_ns).__name__}"
    response = service.run(_draft(publication.catalog_revision), idempotency_key=key)
    stored = control.preflight(response.preflight_id)
    assert stored is not None
    result = _schema_less_object(stored.result_bytes)
    checks = result["checks"]
    assert isinstance(checks, list) and checks
    assert all(isinstance(check, dict) and "checked_at_ns" in check for check in checks)
    for check in checks:
        assert isinstance(check, dict)
        check["checked_at_ns"] = invalid_checked_at_ns
    tampered_bytes = _schema_less_bytes(result)
    control._connection.execute(
        "UPDATE preflights SET result_bytes = ? WHERE preflight_id = ?",
        (tampered_bytes, stored.preflight_id),
    )
    control._connection.execute(
        "UPDATE idempotency_records SET response_body = ? WHERE idempotency_key = ?",
        (tampered_bytes, key),
    )

    try:
        with pytest.raises(ControlStoreError, match="preflight|Preflight"):
            control.preflight(stored.preflight_id)
    finally:
        control.close()


def test_valid_range_checked_at_tamper_cannot_replace_seq1_evaluation_time(
    tmp_path: Path,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    key = "valid-range-checked-at-tamper"
    response = service.run(_draft(publication.catalog_revision), idempotency_key=key)
    stored = control.preflight(response.preflight_id)
    assert stored is not None
    result = _schema_less_object(stored.result_bytes)
    checks = result["checks"]
    assert isinstance(checks, list) and checks
    original_checked_at_ns = checks[0]["checked_at_ns"]
    assert isinstance(original_checked_at_ns, int)
    for check in checks:
        assert isinstance(check, dict)
        check["checked_at_ns"] = original_checked_at_ns + 1
    tampered_bytes = _schema_less_bytes(result)
    control._connection.execute(
        "UPDATE preflights SET result_bytes = ? WHERE preflight_id = ?",
        (tampered_bytes, stored.preflight_id),
    )
    control._connection.execute(
        "UPDATE idempotency_records SET response_body = ? WHERE idempotency_key = ?",
        (tampered_bytes, key),
    )
    event_count = len(control.events(response.run_id))

    try:
        with pytest.raises(ControlStoreError, match="preflight|Preflight"):
            control.preflight(stored.preflight_id)
        raw = control._connection.execute(
            "SELECT consumed_at_ns FROM preflights WHERE preflight_id = ?",
            (stored.preflight_id,),
        ).fetchone()
        assert raw is not None and raw["consumed_at_ns"] is None
        assert control.run(response.run_id).state is RunState.PREFLIGHT_READY
        assert len(control.events(response.run_id)) == event_count
    finally:
        control.close()


@pytest.mark.parametrize(
    ("field", "forged_value"),
    [
        ("engine_package_version", "2.0.0rc2"),
        ("engine_tag_commit", "f" * 40),
        ("python_version", "3.12.5"),
        ("precision_mode", "FIXED_PRECISION_8"),
    ],
)
def test_ready_transaction_rejects_engine_identity_not_bound_to_catalog_and_native_pin(
    tmp_path: Path,
    field: str,
    forged_value: str,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    first = service.run(
        _draft(publication.catalog_revision),
        idempotency_key=f"engine-source-{field}",
    )
    stored = control.preflight(first.preflight_id)
    assert stored is not None and stored.input_manifest_bytes is not None
    manifest_object = parse_json_object(stored.input_manifest_bytes)
    manifest_object[field] = forged_value
    manifest_bytes = canonical_json_bytes(manifest_object)
    manifest_hash = sha256(manifest_bytes).hexdigest()
    command = IdempotencyCommand.preflight(
        key=f"forged-engine-{field}",
        canonical_request_bytes=stored.request_bytes,
    )
    response_bytes = b'{"run_id":"bt_forged_engine"}'
    strategy = _definition(
        "determinism-probe",
        "v1",
        {
            "entry_limit_price": "100",
            "entry_quantity": "15",
            "metric_round_trip_quantity": "1",
            "metric_round_trips": 5,
            "risk_probe_quantity": "20",
            "venue_rejection_quantity": "1",
        },
    )
    risk = _definition(
        "probe-risk",
        "v1",
        {"max_notional": "1600"},
    )
    engine = _engine()
    engine_package_version = (
        forged_value if field == "engine_package_version" else engine.package_version
    )
    engine_tag_commit = forged_value if field == "engine_tag_commit" else engine.tag_commit
    python_version = forged_value if field == "python_version" else engine.python_version
    precision_mode = forged_value if field == "precision_mode" else engine.precision_mode

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        transaction.reserve_run(
            run_id="bt_forged_engine",
            input_manifest_bytes=manifest_bytes,
            input_manifest_hash=manifest_hash,
            catalog_revision=publication.catalog_revision,
            catalog_inventory_hash=publication.inventory_hash,
        )
        transaction.persist_preflight(
            preflight_id="pf_forged_engine",
            run_id="bt_forged_engine",
            status="PREFLIGHT_READY",
            request_bytes=command.canonical_request_bytes,
            request_hash=sha256(command.canonical_request_bytes).hexdigest(),
            result_bytes=response_bytes,
            input_manifest_bytes=manifest_bytes,
            input_manifest_hash=manifest_hash,
            catalog_revision=publication.catalog_revision,
            catalog_inventory_hash=publication.inventory_hash,
            engine_package_version=engine_package_version,
            engine_tag_commit=engine_tag_commit,
            risk_policy_hash=risk.sha256,
            expires_at_ns=10_000,
            ready_evidence=PreflightReadyEvidence(
                catalog_publication_bytes=publication.publication_bytes,
                strategy_id=strategy.identifier,
                strategy_version=strategy.version,
                strategy_bytes=strategy.canonical_bytes,
                strategy_hash=strategy.sha256,
                risk_policy_id=risk.identifier,
                risk_policy_version=risk.version,
                risk_policy_bytes=risk.canonical_bytes,
                risk_policy_hash=risk.sha256,
                engine_python_version=python_version,
                engine_precision_mode=precision_mode,
            ),
        )
        transaction.commit_transition(
            run_id="bt_forged_engine",
            expected_version=0,
            target=RunState.PREFLIGHT_READY,
            candidate=EventCandidate.control(
                type="preflight.passed",
                ts_event_ns="1000",
                payload={"preflight_id": "pf_forged_engine"},
            ),
        )
        return IdempotentResponse(
            status_code=200,
            body=response_bytes,
            run_id="bt_forged_engine",
        )

    try:
        with pytest.raises(EventRejected, match="engine identity"):
            control.execute_idempotent(command=command, handler=handler)
        assert control.preflight("pf_forged_engine") is None
        assert control.idempotent_response(command) is None
    finally:
        control.close()


@pytest.mark.parametrize("read_kind", ["preflight", "idempotent"])
@pytest.mark.parametrize(
    ("field", "tampered_value"),
    [
        ("preflight_id", "pf_other"),
        ("canonical_request_hash", "f" * 64),
        ("state", "PREFLIGHT_BLOCKED"),
        ("state_version", 2),
        ("expires_at_ns", 9_999),
        ("input_manifest_hash", "f" * 64),
        ("catalog_revision", "f" * 64),
    ],
)
def test_fixed_reads_reject_semantically_tampered_preflight_result_even_when_bytes_relinked(
    tmp_path: Path,
    read_kind: str,
    field: str,
    tampered_value: object,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    key = f"result-tamper-{read_kind}-{field}"
    ready = service.run(_draft(publication.catalog_revision), idempotency_key=key)
    stored = control.preflight(ready.preflight_id)
    assert stored is not None
    result_object = _schema_less_object(stored.result_bytes)
    result_object[field] = tampered_value
    tampered_bytes = _schema_less_bytes(result_object)
    control._connection.execute(
        "UPDATE preflights SET result_bytes = ? WHERE preflight_id = ?",
        (tampered_bytes, stored.preflight_id),
    )
    control._connection.execute(
        "UPDATE idempotency_records SET response_body = ? WHERE idempotency_key = ?",
        (tampered_bytes, key),
    )
    command = IdempotencyCommand.preflight(
        key=key,
        canonical_request_bytes=stored.request_bytes,
    )

    try:
        with pytest.raises(ControlStoreError, match="preflight"):
            if read_kind == "preflight":
                control.preflight(stored.preflight_id)
            else:
                control.idempotent_response(command)
    finally:
        control.close()


def _draft_for_preflight_state(
    catalog_revision: str,
    state: str,
) -> BacktestDraftRequest:
    draft = _draft(catalog_revision)
    if state == "ready":
        return draft
    value = draft.model_dump(mode="json", by_alias=True)
    account = value["venue_account_model"]
    assert isinstance(account, dict)
    account["currency"] = "USD"
    return BacktestDraftRequest.model_validate(value)


@pytest.mark.parametrize("read_kind", ["preflight", "idempotent", "service_replay"])
@pytest.mark.parametrize("state", ["ready", "blocked"])
@pytest.mark.parametrize("field", ["state_version", "expires_at_ns"])
def test_preflight_result_rejects_boolean_integer_fields_at_every_read_layer(
    tmp_path: Path,
    read_kind: str,
    state: str,
    field: str,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    key = f"preflight-bool-{state}-{field}-{read_kind}"
    draft = _draft_for_preflight_state(publication.catalog_revision, state)
    response = service.run(draft, idempotency_key=key)
    stored = control.preflight(response.preflight_id)
    assert stored is not None
    result_object = _schema_less_object(stored.result_bytes)
    result_object[field] = True
    if field == "expires_at_ns":
        control._connection.execute(
            "UPDATE preflights SET expires_at_ns = 1 WHERE preflight_id = ?",
            (stored.preflight_id,),
        )
    tampered_bytes = _schema_less_bytes(result_object)
    control._connection.execute(
        "UPDATE preflights SET result_bytes = ? WHERE preflight_id = ?",
        (tampered_bytes, stored.preflight_id),
    )
    control._connection.execute(
        "UPDATE idempotency_records SET response_body = ? WHERE idempotency_key = ?",
        (tampered_bytes, key),
    )
    command = IdempotencyCommand.preflight(
        key=key,
        canonical_request_bytes=stored.request_bytes,
    )

    try:
        with pytest.raises((ControlStoreError, ValueError), match="preflight|Preflight"):
            if read_kind == "preflight":
                control.preflight(stored.preflight_id)
            elif read_kind == "idempotent":
                control.idempotent_response(command)
            else:
                service.run(draft, idempotency_key=key)
    finally:
        control.close()


@pytest.mark.parametrize("read_kind", ["preflight", "idempotent", "service_replay"])
@pytest.mark.parametrize(
    ("state", "attack"),
    [
        ("ready", "missing"),
        ("ready", "reordered"),
        ("ready", "flipped"),
        ("ready", "subset"),
        ("blocked", "missing_base"),
        ("blocked", "reordered"),
        ("blocked", "subset"),
        ("blocked", "wrong_missing"),
    ],
)
def test_preflight_result_requires_the_deterministic_checklist_contract(
    tmp_path: Path,
    read_kind: str,
    state: str,
    attack: str,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    key = f"preflight-checklist-{state}-{attack}-{read_kind}"
    draft = _draft_for_preflight_state(publication.catalog_revision, state)
    response = service.run(draft, idempotency_key=key)
    stored = control.preflight(response.preflight_id)
    assert stored is not None
    result_object = _schema_less_object(stored.result_bytes)
    checks = result_object["checks"]
    assert isinstance(checks, list) and checks
    if attack in {"missing", "missing_base"}:
        checks.pop(
            next(index for index, item in enumerate(checks) if item["code"] == "RUN_ROOT_VALID")
        )
    elif attack == "reordered":
        checks[0], checks[1] = checks[1], checks[0]
    elif attack == "flipped":
        checks[0] = {"code": checks[0]["code"], "passed": False}
    elif attack == "subset":
        checks[:] = (
            checks[:1]
            if state == "ready"
            else [next(item for item in checks if not item["passed"])]
        )
    else:
        cost_index = next(
            index for index, item in enumerate(checks) if item["code"] == "COST_FILL_SUPPORTED"
        )
        checks[cost_index] = {"code": "COST_FEE_MISSING", "passed": False}
    tampered_bytes = _schema_less_bytes(result_object)
    control._connection.execute(
        "UPDATE preflights SET result_bytes = ? WHERE preflight_id = ?",
        (tampered_bytes, stored.preflight_id),
    )
    control._connection.execute(
        "UPDATE idempotency_records SET response_body = ? WHERE idempotency_key = ?",
        (tampered_bytes, key),
    )
    command = IdempotencyCommand.preflight(
        key=key,
        canonical_request_bytes=stored.request_bytes,
    )

    try:
        with pytest.raises((ControlStoreError, ValueError), match="preflight|Preflight"):
            if read_kind == "preflight":
                control.preflight(stored.preflight_id)
            elif read_kind == "idempotent":
                control.idempotent_response(command)
            else:
                service.run(draft, idempotency_key=key)
    finally:
        control.close()


@pytest.mark.parametrize("read_kind", ["preflight", "idempotent", "service_replay"])
@pytest.mark.parametrize(
    ("original_code", "replacement_code", "replacement_passed"),
    [
        ("CURRENCY_MISMATCH", "CURRENCY_MATCH", True),
        ("INFORMATION_SET_MATCH", "INFORMATION_SET_MISMATCH", False),
        ("EVALUATION_PROTOCOL_MATCH", "EVALUATION_PROTOCOL_MISMATCH", False),
        ("WINDOW_VALID", "WINDOW_OUT_OF_RANGE", False),
        ("PRECISION_VALID", "PRECISION_MISMATCH", False),
    ],
)
def test_published_catalog_checks_are_recomputed_from_bound_inventory(
    tmp_path: Path,
    read_kind: str,
    original_code: str,
    replacement_code: str,
    replacement_passed: bool,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    draft_value = _draft_for_preflight_state(
        publication.catalog_revision,
        "blocked",
    ).model_dump(mode="json", by_alias=True)
    draft_value["strategy_ref"] = "unknown-strategy@v1"
    draft = BacktestDraftRequest.model_validate(draft_value)
    key = f"published-recompute-{original_code}-{read_kind}"
    blocked = service.run(draft, idempotency_key=key)
    stored = control.preflight(blocked.preflight_id)
    assert stored is not None
    result = _schema_less_object(stored.result_bytes)
    checks = result["checks"]
    assert isinstance(checks, list)
    check_index = next(index for index, item in enumerate(checks) if item["code"] == original_code)
    checks[check_index] = {
        "code": replacement_code,
        "passed": replacement_passed,
    }
    tampered_bytes = _schema_less_bytes(result)
    control._connection.execute(
        "UPDATE preflights SET result_bytes = ? WHERE preflight_id = ?",
        (tampered_bytes, blocked.preflight_id),
    )
    control._connection.execute(
        "UPDATE idempotency_records SET response_body = ? WHERE idempotency_key = ?",
        (tampered_bytes, key),
    )
    command = IdempotencyCommand.preflight(
        key=key,
        canonical_request_bytes=stored.request_bytes,
    )

    try:
        with pytest.raises(ControlStoreError, match="preflight|Preflight"):
            if read_kind == "preflight":
                control.preflight(blocked.preflight_id)
            elif read_kind == "idempotent":
                control.idempotent_response(command)
            else:
                service.run(draft, idempotency_key=key)
    finally:
        control.close()


@pytest.mark.parametrize(
    ("state", "attack"),
    [
        ("ready", "state_version"),
        ("ready", "last_event_seq"),
        ("blocked", "last_audit_seq"),
        ("consumed", "wrong_post_queue_state"),
        ("ready", "missing_event"),
        ("ready", "missing_audit"),
        ("ready", "missing_outbox"),
        ("ready", "wrong_event_type"),
        ("ready", "hidden_event"),
        ("ready", "wrong_event_payload"),
    ],
)
def test_preflight_replay_requires_exact_lifecycle_and_seq1_history(
    tmp_path: Path,
    state: str,
    attack: str,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    key = f"preflight-history-{state}-{attack}"
    draft_state = "blocked" if state == "blocked" else "ready"
    draft = _draft_for_preflight_state(publication.catalog_revision, draft_state)
    response = service.run(draft, idempotency_key=key)
    if state == "consumed":
        service.consume_ready(
            response.preflight_id,
            response.canonical_request_hash,
            idempotency_key=f"create-history-{attack}",
        )

    if attack in {"state_version", "last_event_seq", "last_audit_seq"}:
        control._connection.execute(
            f"UPDATE runs SET {attack} = 2 WHERE run_id = ?",
            (response.run_id,),
        )
    elif attack == "wrong_post_queue_state":
        control._connection.execute(
            "UPDATE runs SET state = 'PREFLIGHT_BLOCKED' WHERE run_id = ?",
            (response.run_id,),
        )
    elif attack == "missing_event":
        control._connection.execute("PRAGMA foreign_keys = OFF")
        control._connection.execute("DROP TRIGGER trg_events_immutable_delete")
        control._connection.execute(
            "DELETE FROM outbox WHERE run_id = ? AND seq = 1",
            (response.run_id,),
        )
        control._connection.execute(
            "DELETE FROM audit_intents WHERE run_id = ? AND event_seq = 1",
            (response.run_id,),
        )
        control._connection.execute(
            "DELETE FROM events WHERE run_id = ? AND seq = 1",
            (response.run_id,),
        )
        control._connection.execute("PRAGMA foreign_keys = ON")
    elif attack == "missing_audit":
        control._connection.execute("PRAGMA foreign_keys = OFF")
        control._connection.execute(
            "DELETE FROM outbox WHERE run_id = ? AND seq = 1",
            (response.run_id,),
        )
        control._connection.execute(
            "DELETE FROM audit_intents WHERE run_id = ? AND event_seq = 1",
            (response.run_id,),
        )
        control._connection.execute("PRAGMA foreign_keys = ON")
    elif attack == "missing_outbox":
        control._connection.execute(
            "DELETE FROM outbox WHERE run_id = ? AND seq = 1",
            (response.run_id,),
        )
    elif attack in {"wrong_event_type", "hidden_event"}:
        control._connection.execute("DROP TRIGGER trg_events_immutable_update")
        assignment = (
            "type = 'report.generated'"
            if attack == "wrong_event_type"
            else "type = 'run.failed', visible = 0"
        )
        control._connection.execute(
            f"UPDATE events SET {assignment} WHERE run_id = ? AND seq = 1",
            (response.run_id,),
        )
    else:
        row = control._connection.execute(
            "SELECT envelope_bytes FROM events WHERE run_id = ? AND seq = 1",
            (response.run_id,),
        ).fetchone()
        assert row is not None
        envelope = _schema_less_object(row["envelope_bytes"])
        envelope["payload"] = {
            "canonical_request_hash": response.canonical_request_hash,
            "preflight_id": "pf_wrong",
        }
        control._connection.execute("DROP TRIGGER trg_events_immutable_update")
        control._connection.execute(
            "UPDATE events SET envelope_bytes = ? WHERE run_id = ? AND seq = 1",
            (_schema_less_bytes(envelope), response.run_id),
        )

    try:
        with pytest.raises(ControlStoreError, match="preflight|Preflight"):
            service.run(draft, idempotency_key=key)
    finally:
        control.close()


def test_preflight_write_rolls_back_when_seq1_payload_does_not_bind_result(
    tmp_path: Path,
) -> None:
    _service_value, control, _catalog, _clock, publication = _published_service(tmp_path)
    draft = _draft_for_preflight_state(publication.catalog_revision, "blocked")
    request_bytes = canonical_json_bytes(draft.model_dump(mode="json", by_alias=True))
    request_hash = sha256(request_bytes).hexdigest()
    result_bytes = _schema_less_bytes(
        {
            "canonical_request_hash": request_hash,
            "catalog_revision": None,
            "checks": [
                {"code": "ENGINE_VERSION_VALID", "passed": True},
                {"code": "ENGINE_TAG_VALID", "passed": True},
                {"code": "PYTHON_VERSION_VALID", "passed": True},
                {"code": "PRECISION_MODE_VALID", "passed": True},
                {"code": "STRATEGY_VALID", "passed": True},
                {"code": "CATALOG_PUBLISHED", "passed": True},
                {"code": "COST_FILL_SUPPORTED", "passed": True},
                {"code": "RISK_POLICY_VALID", "passed": True},
                {"code": "BALANCE_VALID", "passed": True},
                {"code": "CURRENCY_MISMATCH", "passed": False},
                {"code": "RUN_ROOT_VALID", "passed": True},
                {"code": "INFORMATION_SET_MATCH", "passed": True},
                {"code": "EVALUATION_PROTOCOL_MATCH", "passed": True},
                {"code": "WINDOW_VALID", "passed": True},
                {"code": "PRECISION_VALID", "passed": True},
            ],
            "expires_at_ns": 1_100,
            "input_manifest_hash": None,
            "preflight_id": "pf_wrong_seq1",
            "run_id": "bt_wrong_seq1",
            "state": "PREFLIGHT_BLOCKED",
            "state_version": 1,
        }
    )
    command = IdempotencyCommand.preflight(
        key="wrong-seq1-payload",
        canonical_request_bytes=request_bytes,
    )

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        transaction.reserve_run(run_id="bt_wrong_seq1")
        transaction.persist_preflight(
            preflight_id="pf_wrong_seq1",
            run_id="bt_wrong_seq1",
            status="PREFLIGHT_BLOCKED",
            request_bytes=request_bytes,
            request_hash=request_hash,
            result_bytes=result_bytes,
            input_manifest_bytes=None,
            input_manifest_hash=None,
            catalog_revision=None,
            catalog_inventory_hash=None,
            engine_package_version=None,
            engine_tag_commit=None,
            risk_policy_hash=None,
            expires_at_ns=1_100,
            ready_evidence=None,
        )
        transaction.commit_transition(
            run_id="bt_wrong_seq1",
            expected_version=0,
            target=RunState.PREFLIGHT_BLOCKED,
            candidate=EventCandidate.control(
                type="preflight.blocked",
                ts_event_ns="1000",
                payload={"preflight_id": "pf_wrong_seq1"},
            ),
        )
        return IdempotentResponse(
            status_code=200,
            body=result_bytes,
            run_id="bt_wrong_seq1",
        )

    try:
        with pytest.raises(ControlStoreError, match="preflight|Preflight"):
            control.execute_idempotent(command=command, handler=handler)
        for table in (
            "runs",
            "preflights",
            "events",
            "audit_intents",
            "outbox",
            "idempotency_records",
        ):
            assert control._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    finally:
        control.close()


def test_blocked_preflight_replay_rejects_manifest_identity_copied_to_its_run(
    tmp_path: Path,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    blocked_draft = _draft_for_preflight_state(publication.catalog_revision, "blocked")
    blocked = service.run(blocked_draft, idempotency_key="blocked-run-null-identity")
    ready = service.run(
        _draft(publication.catalog_revision),
        idempotency_key="ready-run-identity-source",
    )
    control._connection.execute(
        """
        UPDATE runs
        SET input_manifest_bytes = source.input_manifest_bytes,
            input_manifest_hash = source.input_manifest_hash,
            catalog_revision = source.catalog_revision,
            catalog_inventory_hash = source.catalog_inventory_hash
        FROM runs AS source
        WHERE runs.run_id = ? AND source.run_id = ?
        """,
        (blocked.run_id, ready.run_id),
    )

    try:
        with pytest.raises(ControlStoreError, match="preflight|Preflight"):
            service.run(blocked_draft, idempotency_key="blocked-run-null-identity")
    finally:
        control.close()


@pytest.mark.parametrize("read_kind", ["preflight", "idempotent", "service_replay"])
def test_preflight_reads_require_exact_200_status(
    tmp_path: Path,
    read_kind: str,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    key = f"preflight-status-{read_kind}"
    draft = _draft(publication.catalog_revision)
    ready = service.run(draft, idempotency_key=key)
    stored = control.preflight(ready.preflight_id)
    assert stored is not None
    control._connection.execute(
        "UPDATE idempotency_records SET response_status = 201 WHERE idempotency_key = ?",
        (key,),
    )
    command = IdempotencyCommand.preflight(
        key=key,
        canonical_request_bytes=stored.request_bytes,
    )

    try:
        with pytest.raises(ControlStoreError, match="status|idempotency"):
            if read_kind == "preflight":
                control.preflight(stored.preflight_id)
            elif read_kind == "idempotent":
                control.idempotent_response(command)
            else:
                service.run(draft, idempotency_key=key)
    finally:
        control.close()


@pytest.mark.parametrize("read_kind", ["preflight", "idempotent", "service_replay"])
@pytest.mark.parametrize("attack", ["unknown", "duplicate"])
def test_preflight_reads_reject_unknown_or_duplicate_check_codes_when_bytes_relinked(
    tmp_path: Path,
    read_kind: str,
    attack: str,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    key = f"preflight-check-{attack}-{read_kind}"
    draft = _draft(publication.catalog_revision)
    ready = service.run(draft, idempotency_key=key)
    stored = control.preflight(ready.preflight_id)
    assert stored is not None
    result_object = _schema_less_object(stored.result_bytes)
    checks = result_object["checks"]
    assert isinstance(checks, list) and checks
    if attack == "unknown":
        first = checks[0]
        assert isinstance(first, dict)
        first["code"] = "UNREGISTERED_CHECK_CODE"
    else:
        checks.append(dict(checks[0]))
    tampered_bytes = _schema_less_bytes(result_object)
    control._connection.execute(
        "UPDATE preflights SET result_bytes = ? WHERE preflight_id = ?",
        (tampered_bytes, stored.preflight_id),
    )
    control._connection.execute(
        "UPDATE idempotency_records SET response_body = ? WHERE idempotency_key = ?",
        (tampered_bytes, key),
    )
    command = IdempotencyCommand.preflight(
        key=key,
        canonical_request_bytes=stored.request_bytes,
    )

    try:
        with pytest.raises(ControlStoreError, match="preflight"):
            if read_kind == "preflight":
                control.preflight(stored.preflight_id)
            elif read_kind == "idempotent":
                control.idempotent_response(command)
            else:
                service.run(draft, idempotency_key=key)
    finally:
        control.close()


def test_fixed_preflight_read_rejects_orphan_without_committed_idempotency_link(
    tmp_path: Path,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    ready = service.run(
        _draft(publication.catalog_revision),
        idempotency_key="orphan-source",
    )
    control._connection.execute(
        "DELETE FROM idempotency_records WHERE idempotency_scope = 'backtest.preflight'"
    )

    try:
        with pytest.raises(ControlStoreError, match="idempotency"):
            control.preflight(ready.preflight_id)
    finally:
        control.close()


@pytest.mark.parametrize("attack", ["wrong_hash", "wrong_id", "extra_field"])
def test_create_command_request_must_exactly_equal_its_consume_arguments(
    tmp_path: Path,
    attack: str,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    ready = service.run(
        _draft(publication.catalog_revision),
        idempotency_key=f"create-binding-source-{attack}",
    )
    stored = control.preflight(ready.preflight_id)
    assert stored is not None
    command_object: dict[str, object] = {
        "canonical_request_hash": stored.request_hash,
        "preflight_id": stored.preflight_id,
    }
    if attack == "wrong_hash":
        command_object["canonical_request_hash"] = "f" * 64
    elif attack == "wrong_id":
        command_object["preflight_id"] = "pf_other"
    else:
        command_object["extra"] = True
    command = IdempotencyCommand.create(
        key=f"create-binding-{attack}",
        canonical_request_bytes=canonical_json_bytes(command_object),
    )

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        try:
            _consume_exact(
                transaction,
                stored=stored,
                publication=publication,
                consumed_at_ns=1_001,
            )
        except EventRejected:
            pass
        return IdempotentResponse(
            status_code=202,
            body=f'{{"run_id":"{stored.run_id}"}}'.encode(),
            run_id=stored.run_id,
        )

    try:
        with pytest.raises(ControlStoreError, match="poisoned"):
            control.execute_idempotent(command=command, handler=handler)
        retained = control.preflight(stored.preflight_id)
        assert retained is not None and retained.consumed_at_ns is None
        assert control.run(stored.run_id).state is RunState.PREFLIGHT_READY
        assert [event.type for event in control.events(stored.run_id)] == ["preflight.passed"]
        assert control.idempotent_response(command) is None
    finally:
        control.close()


def test_create_completion_requires_queue_after_exact_consumption(tmp_path: Path) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    ready = service.run(
        _draft(publication.catalog_revision),
        idempotency_key="create-completion-source",
    )
    stored = control.preflight(ready.preflight_id)
    assert stored is not None
    command = IdempotencyCommand.create(
        key="create-without-queue",
        canonical_request_bytes=canonical_json_bytes(
            {
                "canonical_request_hash": stored.request_hash,
                "preflight_id": stored.preflight_id,
            }
        ),
    )

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        _consume_exact(
            transaction,
            stored=stored,
            publication=publication,
            consumed_at_ns=1_001,
        )
        return IdempotentResponse(
            status_code=202,
            body=_schema_less_bytes(
                {
                    "input_manifest_hash": stored.input_manifest_hash,
                    "last_visible_seq": 2,
                    "run_id": stored.run_id,
                    "state": "QUEUED",
                    "state_version": 2,
                }
            ),
            run_id=stored.run_id,
        )

    try:
        with pytest.raises(EventRejected, match="must consume one preflight and queue"):
            control.execute_idempotent(command=command, handler=handler)
        retained = control.preflight(stored.preflight_id)
        assert retained is not None and retained.consumed_at_ns is None
        assert control.run(stored.run_id).state is RunState.PREFLIGHT_READY
        assert [event.type for event in control.events(stored.run_id)] == ["preflight.passed"]
        assert control.idempotent_response(command) is None
    finally:
        control.close()


@pytest.mark.parametrize(
    "attack",
    [
        "extra",
        "missing",
        "input_manifest_hash_value",
        "input_manifest_hash_type",
        "last_visible_seq_value",
        "last_visible_seq_type",
        "run_id_value",
        "run_id_type",
        "state_value",
        "state_type",
        "state_version_value",
        "state_version_type",
    ],
)
def test_create_write_rejects_invalid_response_and_rolls_back(
    tmp_path: Path,
    attack: str,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    ready = service.run(
        _draft(publication.catalog_revision),
        idempotency_key=f"create-write-response-source-{attack}",
    )
    stored = control.preflight(ready.preflight_id)
    assert stored is not None
    command = IdempotencyCommand.create(
        key=f"create-write-response-{attack}",
        canonical_request_bytes=canonical_json_bytes(
            {
                "canonical_request_hash": stored.request_hash,
                "preflight_id": stored.preflight_id,
            }
        ),
    )

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        _consume_exact(
            transaction,
            stored=stored,
            publication=publication,
            consumed_at_ns=1_001,
        )
        transaction.commit_transition(
            run_id=stored.run_id,
            expected_version=1,
            target=RunState.QUEUED,
            candidate=EventCandidate.control(
                type="run.queued",
                ts_event_ns="1001",
                payload={"preflight_id": stored.preflight_id},
            ),
        )
        return IdempotentResponse(
            status_code=202,
            body=_tampered_create_response(stored, attack),
            run_id=stored.run_id,
        )

    try:
        with pytest.raises(ControlStoreError, match="response|run_id"):
            control.execute_idempotent(command=command, handler=handler)
        retained = control.preflight(stored.preflight_id)
        assert retained is not None and retained.consumed_at_ns is None
        assert control.run(stored.run_id).state is RunState.PREFLIGHT_READY
        assert [event.type for event in control.events(stored.run_id)] == ["preflight.passed"]
        assert control.idempotent_response(command) is None
    finally:
        control.close()


@pytest.mark.parametrize(
    ("section", "field"),
    [
        ("slippage", "maximum_book_walk_ticks"),
    ],
)
def test_fractional_tick_count_is_request_invalid_before_any_command_write(
    tmp_path: Path,
    section: str,
    field: str,
) -> None:
    _service_value, control, _catalog, _clock, publication = _published_service(tmp_path)
    draft_object = _draft(publication.catalog_revision).model_dump(mode="json", by_alias=True)
    cost_fill = draft_object["cost_fill_model"]
    assert isinstance(cost_fill, dict)
    cost_section = cost_fill[section]
    assert isinstance(cost_section, dict)
    cost_section[field] = "0.5"

    try:
        with pytest.raises(ValidationError):
            BacktestDraftRequest.model_validate(draft_object)
        for table in ("runs", "preflights", "events", "idempotency_records"):
            assert control._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    finally:
        control.close()


@pytest.mark.parametrize("field", ["strategy_ref", "risk_policy_ref"])
@pytest.mark.parametrize(
    "value",
    [
        " ",
        "../probe@v1",
        "https://example.test/probe@v1",
        "package.module@v1",
        "package:Class@v1",
        "probe@v1@extra",
    ],
)
def test_invalid_registry_reference_is_rejected_before_any_command_write(
    tmp_path: Path,
    field: str,
    value: str,
) -> None:
    _service_value, control, _catalog, _clock, publication = _published_service(tmp_path)
    draft_object = _draft(publication.catalog_revision).model_dump(mode="json", by_alias=True)
    draft_object[field] = value

    try:
        with pytest.raises(ValidationError):
            BacktestDraftRequest.model_validate(draft_object)
        for table in ("runs", "preflights", "events", "idempotency_records"):
            assert control._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    finally:
        control.close()


@pytest.mark.parametrize(
    "window",
    [
        {"start_ns": "0", "end_ns": "0"},
        {"start_ns": "1700000000000000000", "end_ns": "1700000000000000000"},
        {"start_ns": "1700000000000000002", "end_ns": "1700000000000000000"},
    ],
)
def test_invalid_top_level_window_is_rejected_before_any_command_write(
    tmp_path: Path,
    window: dict[str, str],
) -> None:
    _service_value, control, _catalog, _clock, publication = _published_service(tmp_path)
    draft_object = _draft(publication.catalog_revision).model_dump(mode="json", by_alias=True)
    draft_object["window"] = window

    try:
        with pytest.raises(ValidationError, match="top-level window"):
            BacktestDraftRequest.model_validate(draft_object)
        for table in ("runs", "preflights", "events", "idempotency_records"):
            assert control._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    finally:
        control.close()


def test_same_create_key_replays_exact_reservation_without_filesystem_revalidation(
    tmp_path: Path,
) -> None:
    service, control, catalog, clock, publication = _published_service(tmp_path)
    try:
        preflight = service.run(
            _draft(publication.catalog_revision), idempotency_key="preflight-replay"
        )
        first = service.consume_ready(
            preflight.preflight_id,
            preflight.canonical_request_hash,
            idempotency_key="create-replay",
        )
        control.commit_transition(
            run_id=preflight.run_id,
            expected_version=2,
            target=RunState.RUNNING,
            candidate=EventCandidate.control(
                type="run.started",
                ts_event_ns="1002",
                payload={"reason": "test"},
            ),
        )
        calls = list(catalog.calls)
        clock_calls = clock.calls
        before = {
            table: control._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in (
                "runs",
                "preflights",
                "events",
                "audit_intents",
                "outbox",
                "idempotency_records",
            )
        }

        second = service.consume_ready(
            preflight.preflight_id,
            preflight.canonical_request_hash,
            idempotency_key="create-replay",
        )

        assert second == first
        assert catalog.calls == calls
        assert clock.calls == clock_calls
        assert control.run(preflight.run_id).state is RunState.RUNNING
        assert len(control.events(preflight.run_id)) == 3
        assert {
            table: control._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in before
        } == before
    finally:
        control.close()


@pytest.mark.parametrize("read_kind", ["idempotent", "service_replay"])
def test_create_reads_require_exact_202_status(tmp_path: Path, read_kind: str) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    preflight = service.run(
        _draft(publication.catalog_revision), idempotency_key=f"create-status-source-{read_kind}"
    )
    key = f"create-status-{read_kind}"
    service.consume_ready(
        preflight.preflight_id,
        preflight.canonical_request_hash,
        idempotency_key=key,
    )
    control._connection.execute(
        "UPDATE idempotency_records SET response_status = 200 WHERE idempotency_key = ?",
        (key,),
    )
    command = IdempotencyCommand.create(
        key=key,
        canonical_request_bytes=canonical_json_bytes(
            {
                "canonical_request_hash": preflight.canonical_request_hash,
                "preflight_id": preflight.preflight_id,
            }
        ),
    )

    try:
        with pytest.raises(ControlStoreError, match="status"):
            if read_kind == "idempotent":
                control.idempotent_response(command)
            else:
                service.consume_ready(
                    preflight.preflight_id,
                    preflight.canonical_request_hash,
                    idempotency_key=key,
                )
    finally:
        control.close()


@pytest.mark.parametrize("read_kind", ["idempotent", "service_replay"])
@pytest.mark.parametrize(
    "attack",
    [
        "extra",
        "missing",
        "input_manifest_hash_value",
        "input_manifest_hash_type",
        "last_visible_seq_value",
        "last_visible_seq_type",
        "run_id_value",
        "run_id_type",
        "state_value",
        "state_type",
        "state_version_value",
        "state_version_type",
    ],
)
def test_create_reads_reject_invalid_persisted_response_fields(
    tmp_path: Path,
    read_kind: str,
    attack: str,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    preflight = service.run(
        _draft(publication.catalog_revision),
        idempotency_key=f"create-read-response-source-{read_kind}-{attack}",
    )
    stored = control.preflight(preflight.preflight_id)
    assert stored is not None
    key = f"create-read-response-{read_kind}-{attack}"
    service.consume_ready(
        preflight.preflight_id,
        preflight.canonical_request_hash,
        idempotency_key=key,
    )
    control._connection.execute(
        "UPDATE idempotency_records SET response_body = ? WHERE idempotency_key = ?",
        (_tampered_create_response(stored, attack), key),
    )
    command = IdempotencyCommand.create(
        key=key,
        canonical_request_bytes=canonical_json_bytes(
            {
                "canonical_request_hash": preflight.canonical_request_hash,
                "preflight_id": preflight.preflight_id,
            }
        ),
    )

    try:
        with pytest.raises((ControlStoreError, ValueError), match="response|run_id"):
            if read_kind == "idempotent":
                control.idempotent_response(command)
            else:
                service.consume_ready(
                    preflight.preflight_id,
                    preflight.canonical_request_hash,
                    idempotency_key=key,
                )
    finally:
        control.close()


@pytest.mark.parametrize("attack", ["missing", "tampered"])
def test_create_replay_requires_immutable_queued_event_evidence(
    tmp_path: Path,
    attack: str,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    preflight = service.run(
        _draft(publication.catalog_revision),
        idempotency_key=f"queued-event-source-{attack}",
    )
    key = f"queued-event-create-{attack}"
    service.consume_ready(
        preflight.preflight_id,
        preflight.canonical_request_hash,
        idempotency_key=key,
    )
    if attack == "missing":
        control._connection.execute("PRAGMA foreign_keys = OFF")
        control._connection.execute("DROP TRIGGER trg_events_immutable_delete")
        control._connection.execute(
            "DELETE FROM events WHERE run_id = ? AND seq = 2",
            (preflight.run_id,),
        )
        control._connection.execute("PRAGMA foreign_keys = ON")
    else:
        control._connection.execute("DROP TRIGGER trg_events_immutable_update")
        control._connection.execute(
            "UPDATE events SET type = 'report.generated' WHERE run_id = ? AND seq = 2",
            (preflight.run_id,),
        )
    command = IdempotencyCommand.create(
        key=key,
        canonical_request_bytes=canonical_json_bytes(
            {
                "canonical_request_hash": preflight.canonical_request_hash,
                "preflight_id": preflight.preflight_id,
            }
        ),
    )

    try:
        with pytest.raises(ControlStoreError, match="response|queued"):
            control.idempotent_response(command)
    finally:
        control.close()


def test_published_currency_mismatch_emits_each_registered_check_once(tmp_path: Path) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    draft_object = _draft(publication.catalog_revision).model_dump(mode="json", by_alias=True)
    account = draft_object["venue_account_model"]
    assert isinstance(account, dict)
    account["currency"] = "USD"

    try:
        blocked = service.run(
            BacktestDraftRequest.model_validate(draft_object),
            idempotency_key="currency-check-unique",
        )
        codes = [check.code for check in blocked.checks]
        assert codes.count("CURRENCY_MISMATCH") == 1
        assert len(codes) == len(set(codes))
    finally:
        control.close()


@pytest.mark.parametrize(
    "stale",
    ["expired", "engine", "tag", "python", "precision", "risk", "wrong_hash"],
)
def test_expiry_hash_engine_and_risk_drift_leave_token_unconsumed(
    tmp_path: Path, stale: str
) -> None:
    service, control, catalog, clock, publication = _published_service(tmp_path)
    try:
        preflight = service.run(
            _draft(publication.catalog_revision), idempotency_key=f"preflight-{stale}"
        )
        consume_service = service
        request_hash = preflight.canonical_request_hash
        if stale == "expired":
            clock.value = preflight.expires_at_ns
        elif stale in {"engine", "tag", "python", "precision"}:
            engine = _engine()
            consume_service = _service(
                control=control,
                catalog=catalog,
                clock=clock,
                run_root=tmp_path / "runs",
                engine=EngineIdentity(
                    package_version=("2.0.0rc2" if stale == "engine" else engine.package_version),
                    tag_commit=("f" * 40 if stale == "tag" else engine.tag_commit),
                    python_version=("3.12.5" if stale == "python" else engine.python_version),
                    precision_mode=(
                        "FIXED_PRECISION_8" if stale == "precision" else engine.precision_mode
                    ),
                ),
            )
        elif stale == "risk":
            consume_service = _service(
                control=control,
                catalog=catalog,
                clock=clock,
                run_root=tmp_path / "runs",
                risk=_definition("probe-risk", "v2", {"max_notional": "1"}),
            )
        else:
            request_hash = "f" * 64

        with pytest.raises(PreflightStale, match="PREFLIGHT_STALE"):
            consume_service.consume_ready(
                preflight.preflight_id,
                request_hash,
                idempotency_key=f"create-{stale}",
            )

        retained = control.preflight(preflight.preflight_id)
        assert retained is not None and retained.consumed_at_ns is None
        assert control.run(preflight.run_id).state is RunState.PREFLIGHT_READY
        assert len(control.events(preflight.run_id)) == 1
    finally:
        control.close()


@pytest.mark.parametrize(
    "attack",
    [
        "engine_tag",
        "risk_hash",
        "catalog_missing",
        "catalog_prepared",
        "catalog_integrity_failed",
    ],
)
def test_persisted_ready_identity_drift_is_stale_without_consume_side_effects(
    tmp_path: Path,
    attack: str,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    preflight = service.run(
        _draft(publication.catalog_revision),
        idempotency_key=f"persisted-stale-source-{attack}",
    )
    if attack == "engine_tag":
        control._connection.execute(
            "UPDATE preflights SET engine_tag_commit = ? WHERE preflight_id = ?",
            ("f" * 40, preflight.preflight_id),
        )
    elif attack == "risk_hash":
        control._connection.execute(
            "UPDATE preflights SET risk_policy_hash = ? WHERE preflight_id = ?",
            ("f" * 64, preflight.preflight_id),
        )
    elif attack == "catalog_missing":
        control._connection.execute("PRAGMA foreign_keys = OFF")
        control._connection.execute(
            "DELETE FROM catalog_audit_intents WHERE catalog_revision = ?",
            (publication.catalog_revision,),
        )
        control._connection.execute(
            "DELETE FROM catalog_publications WHERE catalog_revision = ?",
            (publication.catalog_revision,),
        )
        control._connection.execute("PRAGMA foreign_keys = ON")
    elif attack == "catalog_prepared":
        control._connection.execute(
            """
            UPDATE catalog_publications
            SET status = 'PREPARED', published_at_ns = NULL
            WHERE catalog_revision = ?
            """,
            (publication.catalog_revision,),
        )
    else:
        control._connection.execute(
            """
            UPDATE catalog_publications
            SET status = 'INTEGRITY_FAILED'
            WHERE catalog_revision = ?
            """,
            (publication.catalog_revision,),
        )

    try:
        with pytest.raises(PreflightStale, match="PREFLIGHT_STALE"):
            service.consume_ready(
                preflight.preflight_id,
                preflight.canonical_request_hash,
                idempotency_key=f"persisted-stale-create-{attack}",
            )
        raw_preflight = control._connection.execute(
            "SELECT consumed_at_ns FROM preflights WHERE preflight_id = ?",
            (preflight.preflight_id,),
        ).fetchone()
        assert raw_preflight is not None and raw_preflight["consumed_at_ns"] is None
        assert (
            control._connection.execute(
                "SELECT state FROM runs WHERE run_id = ?",
                (preflight.run_id,),
            ).fetchone()["state"]
            == "PREFLIGHT_READY"
        )
        assert (
            control._connection.execute(
                "SELECT COUNT(*) FROM events WHERE run_id = ?",
                (preflight.run_id,),
            ).fetchone()[0]
            == 1
        )
        assert (
            control._connection.execute(
                """
                SELECT COUNT(*)
                FROM idempotency_records
                WHERE idempotency_scope = 'backtest.create'
                """
            ).fetchone()[0]
            == 0
        )
        assert list((tmp_path / "runs").iterdir()) == []
    finally:
        control.close()


@pytest.mark.parametrize("read_kind", ["preflight", "service_replay"])
def test_ready_history_rejects_catalog_rewritten_to_consistent_prepared_state(
    tmp_path: Path,
    read_kind: str,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    key = f"ready-prepared-history-{read_kind}"
    draft = _draft(publication.catalog_revision)
    ready = service.run(draft, idempotency_key=key)
    control._connection.execute(
        "DELETE FROM catalog_audit_intents WHERE catalog_revision = ?",
        (publication.catalog_revision,),
    )
    control._connection.execute(
        """
        UPDATE catalog_publications
        SET status = 'PREPARED', published_at_ns = NULL
        WHERE catalog_revision = ?
        """,
        (publication.catalog_revision,),
    )

    try:
        with pytest.raises(ControlStoreError, match="preflight|catalog|Catalog"):
            if read_kind == "preflight":
                control.preflight(ready.preflight_id)
            else:
                service.run(draft, idempotency_key=key)
    finally:
        control.close()


@pytest.mark.parametrize("status", ["PUBLISHED", "INTEGRITY_FAILED"])
def test_ready_exact_replay_accepts_only_valid_historical_catalog_statuses(
    tmp_path: Path,
    status: str,
) -> None:
    service, control, catalog, clock, publication = _published_service(tmp_path)
    key = f"ready-historical-catalog-{status}"
    draft = _draft(publication.catalog_revision)
    first = service.run(draft, idempotency_key=key)
    if status == "INTEGRITY_FAILED":
        control._connection.execute(
            "UPDATE catalog_publications SET status = ? WHERE catalog_revision = ?",
            (status, publication.catalog_revision),
        )
    tables = (
        "runs",
        "preflights",
        "events",
        "audit_intents",
        "outbox",
        "idempotency_records",
    )
    counts = {
        table: control._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in tables
    }
    catalog_calls = list(catalog.calls)
    clock_calls = clock.calls

    try:
        assert service.run(draft, idempotency_key=key) == first
        assert catalog.calls == catalog_calls
        assert clock.calls == clock_calls
        assert {
            table: control._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in tables
        } == counts
    finally:
        control.close()


@pytest.mark.parametrize("read_kind", ["preflight", "service_replay", "fresh_consume"])
def test_ready_catalog_audit_must_be_exact_and_bound_at_every_read_layer(
    tmp_path: Path,
    read_kind: str,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    key = f"ready-catalog-audit-{read_kind}"
    draft = _draft(publication.catalog_revision)
    ready = service.run(draft, idempotency_key=key)
    control._connection.execute(
        "UPDATE catalog_audit_intents SET intent_bytes = ? WHERE catalog_revision = ?",
        (b"{}", publication.catalog_revision),
    )

    try:
        if read_kind == "fresh_consume":
            with pytest.raises(PreflightStale, match="PREFLIGHT_STALE"):
                service.consume_ready(
                    ready.preflight_id,
                    ready.canonical_request_hash,
                    idempotency_key="create-after-catalog-audit-tamper",
                )
            row = control._connection.execute(
                "SELECT consumed_at_ns FROM preflights WHERE preflight_id = ?",
                (ready.preflight_id,),
            ).fetchone()
            assert row is not None and row["consumed_at_ns"] is None
            assert (
                control._connection.execute(
                    "SELECT COUNT(*) FROM events WHERE run_id = ?",
                    (ready.run_id,),
                ).fetchone()[0]
                == 1
            )
            assert (
                control._connection.execute(
                    """
                SELECT COUNT(*) FROM idempotency_records
                WHERE idempotency_scope = 'backtest.create'
                """
                ).fetchone()[0]
                == 0
            )
            assert list((tmp_path / "runs").iterdir()) == []
        else:
            with pytest.raises(ControlStoreError, match="preflight|catalog|Catalog"):
                if read_kind == "preflight":
                    control.preflight(ready.preflight_id)
                else:
                    service.run(draft, idempotency_key=key)
    finally:
        control.close()


def test_catalog_final_byte_failure_leaves_ready_token_unconsumed_and_no_runner_side_effect(
    tmp_path: Path,
) -> None:
    service, control, _catalog, _clock, publication = _published_service(tmp_path)
    try:
        preflight = service.run(
            _draft(publication.catalog_revision), idempotency_key="preflight-tamper"
        )
        assert preflight.state is RunState.PREFLIGHT_READY
        target = tmp_path / "trading" / "catalogs" / publication.catalog_revision
        manifest_path = target / "catalog-manifest.json"
        manifest_path.chmod(0o600)

        with pytest.raises(PreflightStale, match="PREFLIGHT_STALE"):
            service.consume_ready(
                preflight.preflight_id,
                preflight.canonical_request_hash,
                idempotency_key="create-after-tamper",
            )

        retained = control.preflight(preflight.preflight_id)
        assert retained is not None and retained.consumed_at_ns is None
        assert control.run(preflight.run_id).state is RunState.PREFLIGHT_READY
        assert [event.type for event in control.events(preflight.run_id)] == ["preflight.passed"]
        assert list((tmp_path / "runs").iterdir()) == []
    finally:
        manifest_path = (
            tmp_path
            / "trading"
            / "catalogs"
            / publication.catalog_revision
            / "catalog-manifest.json"
        )
        if manifest_path.exists():
            manifest_path.chmod(0o400)
        control.close()


def test_preflight_and_create_replay_exactly_after_database_close_reopen(
    tmp_path: Path,
) -> None:
    service, control, _catalog, clock, publication = _published_service(tmp_path)
    draft = _draft(publication.catalog_revision)
    first_preflight = service.run(draft, idempotency_key="close-preflight")
    first_reservation = service.consume_ready(
        first_preflight.preflight_id,
        first_preflight.canonical_request_hash,
        idempotency_key="close-create",
    )
    control.close()

    reopened = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: 30_000)
    publisher = FixturePublisher(
        registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
        control=reopened,
        runtime_root=tmp_path / "trading",
    )
    catalog = CountingCatalog(publisher)
    replay_clock = MutableClock(9_000)
    replay_service = _service(
        control=reopened,
        catalog=catalog,
        clock=replay_clock,
        run_root=tmp_path / "runs",
    )
    try:
        assert replay_service.run(draft, idempotency_key="close-preflight") == (first_preflight)
        assert (
            replay_service.consume_ready(
                first_preflight.preflight_id,
                first_preflight.canonical_request_hash,
                idempotency_key="close-create",
            )
            == first_reservation
        )
        assert catalog.calls == []
        assert replay_clock.calls == 0
        assert list((tmp_path / "runs").iterdir()) == []
    finally:
        reopened.close()


def _run_two_workers(
    first: Callable[[], object], second: Callable[[], object]
) -> tuple[list[object], list[BaseException]]:
    barrier = threading.Barrier(2)
    results: list[object] = []
    errors: list[BaseException] = []
    lock = threading.Lock()

    def invoke(callback: Callable[[], object]) -> None:
        barrier.wait(timeout=5)
        try:
            result = callback()
        except BaseException as error:
            with lock:
                errors.append(error)
        else:
            with lock:
                results.append(result)

    threads = [
        threading.Thread(target=invoke, args=(first,)),
        threading.Thread(target=invoke, args=(second,)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=15)
        assert not thread.is_alive()
    return results, errors


class BarrierCatalog:
    def __init__(
        self,
        *,
        publisher: FixturePublisher,
        control: ControlStore,
        barrier: threading.Barrier,
    ) -> None:
        self._publisher = publisher
        self._control = control
        self._barrier = barrier
        self.calls: list[str] = []

    def revalidate(self, catalog_revision: str) -> CatalogPublication:
        assert not self._control._connection.in_transaction
        self.calls.append(catalog_revision)
        self._barrier.wait(timeout=10)
        return self._publisher.revalidate(catalog_revision)


def test_two_connections_same_preflight_key_miss_then_second_hit_replays_one_write(
    tmp_path: Path,
) -> None:
    _setup_service, setup_store, _setup_catalog, _clock, publication = _published_service(tmp_path)
    setup_store.close()
    barrier = threading.Barrier(2)
    counters: list[tuple[int, int, int, tuple[str, ...]]] = []
    counter_lock = threading.Lock()

    def run(label: str) -> PreflightResponse:
        worker_store = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: 20_000)
        publisher = FixturePublisher(
            registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
            control=worker_store,
            runtime_root=tmp_path / "trading",
        )
        catalog = BarrierCatalog(
            publisher=publisher,
            control=worker_store,
            barrier=barrier,
        )
        clock = MutableClock(1_800_000_000_000_000_000)
        run_ids = SequentialIds(f"bt_{label}")
        preflight_ids = SequentialIds(f"pf_{label}")
        worker_service = _service(
            control=worker_store,
            catalog=catalog,
            clock=clock,
            run_root=tmp_path / "runs",
            run_id_factory=run_ids,
            preflight_id_factory=preflight_ids,
        )
        try:
            return worker_service.run(
                _draft(publication.catalog_revision),
                idempotency_key="same-preflight-race",
            )
        finally:
            with counter_lock:
                counters.append(
                    (
                        run_ids.calls,
                        preflight_ids.calls,
                        clock.calls,
                        tuple(catalog.calls),
                    )
                )
            worker_store.close()

    results, errors = _run_two_workers(lambda: run("a"), lambda: run("b"))

    assert errors == []
    assert len(results) == 2
    assert isinstance(results[0], PreflightResponse)
    assert results[1] == results[0]
    assert sum(item[0] for item in counters) == 1
    assert sum(item[1] for item in counters) == 1
    assert sum(item[2] for item in counters) == 2
    assert all(item[3] == (publication.catalog_revision,) for item in counters)
    verify = ControlStore.open(tmp_path / "control.sqlite")
    try:
        assert verify.run(results[0].run_id).state is RunState.PREFLIGHT_READY
        assert len(verify.events(results[0].run_id)) == 1
        assert len(list((tmp_path / "runs").iterdir())) == 0
    finally:
        verify.close()


def test_two_connections_same_create_key_miss_then_second_hit_replays_one_consume(
    tmp_path: Path,
) -> None:
    service, setup_store, _setup_catalog, _clock, publication = _published_service(tmp_path)
    preflight = service.run(
        _draft(publication.catalog_revision),
        idempotency_key="same-create-source",
    )
    setup_store.close()
    barrier = threading.Barrier(2)
    counters: list[tuple[int, tuple[str, ...]]] = []
    counter_lock = threading.Lock()

    def consume() -> object:
        worker_store = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: 20_000)
        publisher = FixturePublisher(
            registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
            control=worker_store,
            runtime_root=tmp_path / "trading",
        )
        catalog = BarrierCatalog(
            publisher=publisher,
            control=worker_store,
            barrier=barrier,
        )
        clock = MutableClock(1_001)
        worker_service = _service(
            control=worker_store,
            catalog=catalog,
            clock=clock,
            run_root=tmp_path / "runs",
        )
        try:
            return worker_service.consume_ready(
                preflight.preflight_id,
                preflight.canonical_request_hash,
                idempotency_key="same-create-race",
            )
        finally:
            with counter_lock:
                counters.append((clock.calls, tuple(catalog.calls)))
            worker_store.close()

    results, errors = _run_two_workers(consume, consume)

    assert errors == []
    assert len(results) == 2
    assert results[1] == results[0]
    assert sum(item[0] for item in counters) == 1
    assert all(item[1] == (publication.catalog_revision,) for item in counters)
    verify = ControlStore.open(tmp_path / "control.sqlite")
    try:
        assert verify.run(preflight.run_id).state is RunState.QUEUED
        retained = verify.preflight(preflight.preflight_id)
        assert retained is not None and retained.consumed_at_ns == 1_001
        assert [event.type for event in verify.events(preflight.run_id)] == [
            "preflight.passed",
            "run.queued",
        ]
        assert len(list((tmp_path / "runs").iterdir())) == 0
    finally:
        verify.close()


def test_two_connections_and_different_create_keys_have_exactly_one_consumer(
    tmp_path: Path,
) -> None:
    first_service, first_store, _first_catalog, clock, publication = _published_service(tmp_path)
    preflight = first_service.run(
        _draft(publication.catalog_revision), idempotency_key="preflight-race"
    )
    worker_catalog_calls: list[tuple[str, ...]] = []

    def consume(label: str):
        worker_store = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: 20_000)
        worker_publisher = FixturePublisher(
            registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
            control=worker_store,
            runtime_root=tmp_path / "trading",
        )
        worker_catalog = CountingCatalog(worker_publisher)
        worker_service = _service(
            control=worker_store,
            catalog=worker_catalog,
            clock=clock,
            run_root=tmp_path / "runs",
        )
        try:
            return worker_service.consume_ready(
                preflight.preflight_id,
                preflight.canonical_request_hash,
                idempotency_key=f"create-race-{label}",
            )
        finally:
            worker_catalog_calls.append(tuple(worker_catalog.calls))
            worker_store.close()

    try:
        results, errors = _run_two_workers(
            lambda: consume("a"),
            lambda: consume("b"),
        )

        assert len(results) == 1, repr(errors)
        assert len(errors) == 1
        assert isinstance(errors[0], PreflightStale)
        assert first_store.run(preflight.run_id).state is RunState.QUEUED
        assert [event.type for event in first_store.events(preflight.run_id)] == [
            "preflight.passed",
            "run.queued",
        ]
        assert list((tmp_path / "runs").iterdir()) == []
        assert len(worker_catalog_calls) == 2
        assert all(calls == (publication.catalog_revision,) for calls in worker_catalog_calls)
    finally:
        first_store.close()
