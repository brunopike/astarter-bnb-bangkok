from __future__ import annotations

import json
from copy import deepcopy
from types import MappingProxyType
from typing import cast

import pytest
from pydantic import BaseModel, ValidationError

from stark_trading_os.domain.models import (
    BacktestDraftRequest,
    CatalogFileSetV1,
    CatalogFileV1,
    CatalogInstrumentV1,
    CatalogInventoryV1,
    CatalogManifestV1,
    CatalogMappingV1,
    CatalogNativeFingerprintV1,
    CatalogReadbackV1,
    CatalogSourceRecordV1,
    CatalogValidatedAuditV1,
    CostFillModelV1,
    DeterminismProbeConfigV1,
    DraftCostFillModelV1,
    DuplicateV1,
    ErrorResponse,
    EvaluationProtocolV1,
    EventEnvelopeV1,
    FrozenJsonArray,
    FrozenJsonObject,
    GapV1,
    InformationSetPolicyV1,
    InputManifestV1,
    ProbeRiskPolicyV1,
    RunRecordV1,
    TimeWindowV1,
    VenueAccountModelV1,
)


def valid_information_set_policy() -> dict[str, object]:
    return {
        "schema": "InformationSetPolicy.v1",
        "availability_field": "ts_available_ns",
        "nautilus_timestamp_field": "ts_init",
        "visibility_rule": "AVAILABLE_AT_OR_BEFORE_DECISION",
        "tie_breakers": ["ts_available_ns", "source_seq", "record_hash"],
        "bar_rule": "CLOSED_AND_AVAILABLE",
        "source_revision_rule": "SINGLE_IMMUTABLE_REVISION",
    }


def valid_evaluation_protocol(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schema": "EvaluationProtocol.v1",
        "mode": "fixture_only",
        "train": None,
        "tune": None,
        "out_of_sample": None,
        "purge_ns": "0",
        "embargo_ns": "0",
    }
    value.update(overrides)
    return value


class ForgedJsonObject(FrozenJsonObject):
    def __iter__(self):
        return iter(("forged",))

    def __getitem__(self, key: str) -> object:
        return 0.1


class ForgedJsonArray(FrozenJsonArray):
    def __iter__(self):
        return iter((object(),))

    def __getitem__(self, index: int) -> object:
        return object()


def valid_costs(**overrides: object) -> dict[str, object]:
    costs: dict[str, object] = {
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
    costs.update(overrides)
    return costs


def valid_draft(**overrides: object) -> dict[str, object]:
    draft: dict[str, object] = {
        "environment": "BACKTEST",
        "strategy_ref": "determinism-probe@v1",
        "catalog_revision": "a" * 64,
        "window": {"start_ns": "1735689600000000000", "end_ns": "1735776000000000000"},
        "information_set_policy": valid_information_set_policy(),
        "evaluation_protocol": valid_evaluation_protocol(),
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
        "cost_fill_model": valid_costs(),
        "risk_policy_ref": "probe-risk@v1",
        "replay_seed": 7,
    }
    draft.update(overrides)
    return draft


def valid_manifest(**overrides: object) -> dict[str, object]:
    manifest: dict[str, object] = {
        "schema": "InputManifest.v1",
        "environment": "BACKTEST",
        "strategy_id": "determinism-probe",
        "strategy_version": "v1",
        "canonical_config": {
            "entry_limit_price": "100",
            "entry_quantity": "15",
            "metric_round_trip_quantity": "1",
            "metric_round_trips": 5,
            "risk_probe_quantity": "20",
            "venue_rejection_quantity": "1",
        },
        "config_hash": "a" * 64,
        "engine_package_version": "2.0.0rc3",
        "engine_tag_commit": "648970ce64a304d93da0a29320cb6e19b905fa39",
        "python_version": "3.12.0",
        "precision_mode": "DECIMAL",
        "fixture_id": "qa-probe-v1",
        "catalog_revision": "e" * 64,
        "source_checksum": "b" * 64,
        "catalog_checksum": "c" * 64,
        "instruments": [
            {
                "instrument_id": "BTCUSDT.SIM",
                "price_increment": "0.01",
                "quantity_increment": "0.001",
            }
        ],
        "data_types": ["QuoteTick"],
        "window": {"start_ns": "1735689600000000000", "end_ns": "1735776000000000000"},
        "timezone": "UTC",
        "gaps": [],
        "duplicates": [],
        "ordering_result": "PASS",
        "information_set_policy": valid_information_set_policy(),
        "evaluation_protocol": valid_evaluation_protocol(),
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
        "cost_fill_model": valid_costs(),
        "risk_policy_id": "probe-risk",
        "risk_policy_version": "v1",
        "canonical_risk_policy": {"max_notional": "1600"},
        "risk_policy_hash": "d" * 64,
        "replay_seed": 7,
    }
    manifest.update(overrides)
    return manifest


def valid_run_record(**overrides: object) -> dict[str, object]:
    record: dict[str, object] = {
        "schema": "RunRecord.v1",
        "run_id": "bt_01",
        "preflight_id": "pf_01",
        "idempotency_scope": "backtest.create",
        "idempotency_key": "create-01",
        "state": "QUEUED",
        "state_version": 3,
        "created_at_ns": "1735689600000000000",
    }
    record.update(overrides)
    return record


def test_task5_closed_information_set_domain_contracts() -> None:
    policy = InformationSetPolicyV1.model_validate(valid_information_set_policy())
    protocol = EvaluationProtocolV1.model_validate(valid_evaluation_protocol())
    gap = GapV1.model_validate({"start_ns": "2", "end_ns": "10", "instrument_id": "η"})
    duplicate = DuplicateV1.model_validate(
        {"ts_event_ns": "10", "source_seq": 2, "record_hash": "a" * 64}
    )

    assert policy.tie_breakers == ("ts_available_ns", "source_seq", "record_hash")
    assert protocol.mode == "fixture_only"
    assert gap.start_ns == "2"
    assert duplicate.source_seq == 2
    draft = BacktestDraftRequest.model_validate(valid_draft())
    manifest = InputManifestV1.model_validate(valid_manifest())
    assert isinstance(draft.information_set_policy, InformationSetPolicyV1)
    assert isinstance(manifest.evaluation_protocol, EvaluationProtocolV1)


def test_gap_accepts_arbitrary_size_half_open_nanosecond_range() -> None:
    start = "1" + ("0" * 4_999)
    end = "2" + ("0" * 4_999)

    assert (
        GapV1.model_validate(
            {"start_ns": start, "end_ns": end, "instrument_id": "ETH/USDT.SIM"}
        ).end_ns
        == end
    )
    with pytest.raises(ValidationError, match="non-empty half-open"):
        GapV1.model_validate({"start_ns": end, "end_ns": start, "instrument_id": "ETH/USDT.SIM"})


@pytest.mark.parametrize(
    ("model", "value"),
    [
        (GapV1, {"start_ns": "10", "end_ns": "2", "instrument_id": "ETH/USDT.SIM"}),
        (GapV1, {"start_ns": True, "end_ns": "2", "instrument_id": "ETH/USDT.SIM"}),
        (DuplicateV1, {"ts_event_ns": "1", "source_seq": -1, "record_hash": "a" * 64}),
        (DuplicateV1, {"ts_event_ns": "1", "source_seq": True, "record_hash": "A" * 64}),
        (EvaluationProtocolV1, valid_evaluation_protocol(purge_ns="1")),
        (
            EvaluationProtocolV1,
            valid_evaluation_protocol(mode="explicit", train={"start_ns": "1", "end_ns": "2"}),
        ),
    ],
)
def test_task5_closed_domain_contracts_reject_bad_shapes(
    model: type[BaseModel], value: dict[str, object]
) -> None:
    with pytest.raises(ValidationError):
        model.model_validate(value)


def test_task5_catalog_evidence_models_are_closed_and_composable() -> None:
    instrument = CatalogInstrumentV1(
        instrument_id="ETH/USDT.SIM",
        raw_symbol="ETH/USDT",
        venue="SIM",
        base_currency="ETH",
        quote_currency="USDT",
        price_precision=2,
        size_precision=3,
        price_increment="0.01",
        size_increment="0.001",
        minimum_quantity="0.001",
        margin_init="0.1",
        margin_maint="0.05",
        maker_fee="0",
        taker_fee="0",
        ts_event_ns="1",
        ts_available_ns="1",
    )
    record = CatalogSourceRecordV1(
        instrument_id=instrument.instrument_id,
        bid_price="99.00",
        ask_price="100.00",
        bid_size="10.000",
        ask_size="10.000",
        ts_event_ns="1",
        ts_available_ns="1",
        source_seq=1,
        source_revision="local-qa-v1",
        record_hash="b" * 64,
    )
    inventory = CatalogInventoryV1(
        schema="CatalogInventory.v1",
        fixture_id="local-qa-v1",
        label="LOCAL QA FIXTURE",
        source_revision="local-qa-v1",
        timezone="UTC",
        purpose="LOCAL_QA_ONLY",
        source_checksum="c" * 64,
        catalog_checksum="d" * 64,
        catalog_files=(
            CatalogFileV1(relative_path="data/x.parquet", size_bytes=1, sha256="e" * 64),
        ),
        instrument=instrument,
        source_records=(record,),
        readback=CatalogReadbackV1(
            instrument=instrument,
            quote_count=1,
            first_ts_init="1",
            last_ts_init="1",
            data_types=("instruments", "quotes"),
        ),
        mapping=CatalogMappingV1(
            schema="CatalogMapping.v1",
            event_timestamp="ts_event_ns -> QuoteTick.ts_event",
            availability_timestamp="ts_available_ns -> QuoteTick.ts_init",
            source_identity=("source_seq/source_revision/record_hash -> catalog-manifest.json"),
        ),
        native_fingerprint=CatalogNativeFingerprintV1(
            schema="CatalogNativeFingerprint.v1",
            installed_nautilus_version="2.0.0rc3",
            python_version="3.12.4",
            platform_system="Darwin",
            platform_machine="arm64",
            native_extension_sha256="9" * 64,
            writer_class="nautilus_trader.persistence.ParquetDataCatalog",
            writer_options=(
                "batch_size=null;compression=null;max_row_group_size=null;storage_options=null"
            ),
        ),
        information_set_policy=InformationSetPolicyV1.model_validate(
            valid_information_set_policy()
        ),
        evaluation_protocol=EvaluationProtocolV1.model_validate(valid_evaluation_protocol()),
        gaps=(),
        duplicates=(),
        ordering_result="PASS",
    )
    manifest = CatalogManifestV1(
        schema="CatalogManifest.v1",
        fixture_id="local-qa-v1",
        label="LOCAL QA FIXTURE",
        source_checksum="c" * 64,
        catalog_checksum="d" * 64,
        inventory_hash="f" * 64,
        inventory=inventory,
    )
    audit = CatalogValidatedAuditV1(
        schema="CatalogValidatedAudit.v1",
        action="catalog.validated",
        fixture_id="local-qa-v1",
        catalog_revision="a" * 64,
        inventory_hash="f" * 64,
        source_checksum="c" * 64,
        catalog_checksum="d" * 64,
    )

    assert manifest.inventory.source_records[0].source_seq == 1
    assert audit.action == "catalog.validated"
    assert (
        CatalogFileSetV1(
            schema="CatalogFileSet.v1", catalog_files=inventory.catalog_files
        ).catalog_files
        == inventory.catalog_files
    )


def test_fixed_catalog_children_require_every_field_explicitly() -> None:
    mapping: dict[str, object] = {
        "schema": "CatalogMapping.v1",
        "event_timestamp": "ts_event_ns -> QuoteTick.ts_event",
        "availability_timestamp": "ts_available_ns -> QuoteTick.ts_init",
        "source_identity": ("source_seq/source_revision/record_hash -> catalog-manifest.json"),
    }
    fingerprint: dict[str, object] = {
        "schema": "CatalogNativeFingerprint.v1",
        "installed_nautilus_version": "2.0.0rc3",
        "python_version": "3.12.4",
        "platform_system": "Darwin",
        "platform_machine": "arm64",
        "native_extension_sha256": "9" * 64,
        "writer_class": "nautilus_trader.persistence.ParquetDataCatalog",
        "writer_options": (
            "batch_size=null;compression=null;max_row_group_size=null;storage_options=null"
        ),
    }
    for model, value in (
        (InformationSetPolicyV1, valid_information_set_policy()),
        (CatalogMappingV1, mapping),
        (CatalogNativeFingerprintV1, fingerprint),
    ):
        for field in tuple(value):
            missing = {key: item for key, item in value.items() if key != field}
            with pytest.raises(ValidationError):
                model.model_validate(missing)


@pytest.mark.parametrize("value", ["LIVE", "PAPER", "SANDBOX", "SEMI_AUTO", "AUTO_API"])
def test_environment_rejects_non_backtest(value: str) -> None:
    with pytest.raises(ValidationError):
        BacktestDraftRequest.model_validate(valid_draft(environment=value))


def test_v01_strategy_risk_and_venue_profiles_are_exact_and_closed() -> None:
    strategy = DeterminismProbeConfigV1.model_validate(valid_manifest()["canonical_config"])
    risk = ProbeRiskPolicyV1.model_validate({"max_notional": "1600"})
    venue = VenueAccountModelV1.model_validate(valid_manifest()["venue_account_model"])

    assert strategy.metric_round_trips == 5
    assert strategy.entry_quantity == "15"
    assert risk.max_notional == "1600"
    assert venue.venue_id == "SIM"
    assert venue.oms_type == "HEDGING"
    assert venue.account_type == "MARGIN"
    assert venue.book_type == "L1_MBP"
    assert venue.routing is False
    assert venue.use_random_ids is False
    assert venue.use_position_ids is True
    assert venue.allow_cash_borrowing is False
    assert venue.starting_balance == "1000000"
    assert venue.currency == "USDT"


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value.pop("venue_rejection_quantity"),
        lambda value: value.update({"metric_round_trips": True}),
        lambda value: value.update({"entry_quantity": "14"}),
        lambda value: value.update({"unexpected": "1"}),
    ],
)
def test_v01_strategy_profile_rejects_missing_wrong_typed_drift_and_unknown_fields(
    mutation: object,
) -> None:
    value = deepcopy(valid_manifest()["canonical_config"])
    assert isinstance(value, dict) and callable(mutation)
    mutation(value)

    with pytest.raises(ValidationError):
        DeterminismProbeConfigV1.model_validate(value)


@pytest.mark.parametrize(
    "value",
    [
        {"max_notional": "0"},
        {"max_notional": "1600", "max_position": "10"},
        {"max_notional": 1600},
    ],
)
def test_v01_risk_profile_rejects_non_authoritative_shapes(value: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        ProbeRiskPolicyV1.model_validate(value)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("oms_type", "NETTING"),
        ("account_type", "CASH"),
        ("book_type", "L2_MBP"),
        ("routing", True),
        ("use_random_ids", True),
        ("use_position_ids", False),
        ("allow_cash_borrowing", True),
        ("starting_balance", "999999"),
        ("currency", "USD"),
    ],
)
def test_v01_venue_profile_rejects_semantic_drift(field: str, value: object) -> None:
    profile = deepcopy(valid_manifest()["venue_account_model"])
    assert isinstance(profile, dict)
    profile[field] = value

    with pytest.raises(ValidationError):
        VenueAccountModelV1.model_validate(profile)


@pytest.mark.parametrize("value", [0.1, float("nan"), float("inf")])
def test_cost_model_rejects_binary_float_values(value: float) -> None:
    costs = valid_costs()
    slippage = cast(dict[str, object], costs["slippage"])
    slippage["prob_slippage"] = value

    with pytest.raises(ValidationError):
        CostFillModelV1.model_validate(costs)


@pytest.mark.parametrize("value", ["+1", "01", "1.0", "-0", "-0.0", "1e-2", ".1"])
def test_cost_model_rejects_noncanonical_decimal_strings(value: str) -> None:
    costs = valid_costs()
    fee = cast(dict[str, object], costs["fee"])
    fee["minimum_fee"] = value

    with pytest.raises(ValidationError):
        CostFillModelV1.model_validate(costs)


@pytest.mark.parametrize(
    ("section", "field", "value"),
    [
        ("fee", "minimum_fee", "-0.1"),
        ("slippage", "prob_fill_on_limit", "-0.1"),
        ("slippage", "prob_slippage", "1.1"),
        ("slippage", "maximum_book_walk_ticks", "-1"),
        ("slippage", "maximum_book_walk_ticks", "0.5"),
    ],
)
def test_draft_rejects_impossible_field_local_cost_values(
    section: str, field: str, value: str
) -> None:
    draft = valid_draft()
    costs = cast(dict[str, object], draft["cost_fill_model"])
    policy = cast(dict[str, object], costs[section])
    policy[field] = value

    with pytest.raises(ValidationError):
        BacktestDraftRequest.model_validate(draft)


def test_draft_accepts_valid_but_unsupported_cost_values_for_preflight() -> None:
    draft = valid_draft()
    costs = cast(dict[str, object], draft["cost_fill_model"])
    fee = cast(dict[str, object], costs["fee"])
    slippage = cast(dict[str, object], costs["slippage"])
    latency = cast(dict[str, object], costs["latency"])
    fee["minimum_fee"] = "0.01"
    slippage["prob_slippage"] = "0.5"
    latency["insert_latency_ns"] = "1"

    parsed = BacktestDraftRequest.model_validate(draft)

    assert parsed.cost_fill_model.fee is not None
    assert parsed.cost_fill_model.fee.minimum_fee == "0.01"
    assert parsed.cost_fill_model.slippage is not None
    assert parsed.cost_fill_model.slippage.prob_slippage == "0.5"
    assert parsed.cost_fill_model.latency is not None
    assert parsed.cost_fill_model.latency.insert_latency_ns == "1"


@pytest.mark.parametrize("value", [1, 0, "true", None])
@pytest.mark.parametrize("field", ["allow_partial_fills", "liquidity_consumption"])
def test_cost_liquidity_flags_are_strict_booleans(field: str, value: object) -> None:
    draft = valid_draft()
    costs = cast(dict[str, object], draft["cost_fill_model"])
    liquidity = cast(dict[str, object], costs["liquidity"])
    liquidity[field] = value

    with pytest.raises(ValidationError):
        BacktestDraftRequest.model_validate(draft)


@pytest.mark.parametrize("value", [True, -1, 2**64])
def test_input_manifest_replay_seed_is_a_strict_u64(value: object) -> None:
    with pytest.raises(ValidationError):
        InputManifestV1.model_validate(valid_manifest(replay_seed=value))


@pytest.mark.parametrize(
    "field",
    ["config_hash", "catalog_revision", "source_checksum", "catalog_checksum", "risk_policy_hash"],
)
@pytest.mark.parametrize("value", ["short", "A" * 64])
def test_input_manifest_digest_fields_are_exact_sha256(field: str, value: str) -> None:
    with pytest.raises(ValidationError):
        InputManifestV1.model_validate(valid_manifest(**{field: value}))


@pytest.mark.parametrize("field", ["price_increment", "quantity_increment"])
def test_manifest_rejects_binary_float_economic_values(field: str) -> None:
    manifest = valid_manifest()
    instruments = deepcopy(manifest["instruments"])
    assert isinstance(instruments, list)
    instruments[0][field] = 0.1
    manifest["instruments"] = instruments

    with pytest.raises(ValidationError):
        InputManifestV1.model_validate(manifest)


def test_manifest_rejects_binary_float_in_canonical_economic_config() -> None:
    manifest = valid_manifest(canonical_config={"limit_price": 100.25})

    with pytest.raises(ValidationError):
        InputManifestV1.model_validate(manifest)


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (BacktestDraftRequest, valid_draft(unexpected="value")),
        (InputManifestV1, valid_manifest(unexpected="value")),
        (
            RunRecordV1,
            valid_run_record(unexpected="value"),
        ),
        (
            EventEnvelopeV1,
            {
                "event_id": "evt_bt_01_000042",
                "run_id": "bt_01",
                "seq": 42,
                "source_seq": 17,
                "ts_event_ns": "1735689600000000000",
                "ts_ingest_ns": "1735689600000000000",
                "type": "order.filled",
                "source": "runner",
                "writer": "control-api",
                "schema_version": 1,
                "payload": {},
                "unexpected": "value",
            },
        ),
        (
            ErrorResponse,
            {
                "code": "REQUEST_INVALID",
                "message": "invalid",
                "retryable": False,
                "unexpected": "value",
            },
        ),
    ],
)
def test_public_contracts_forbid_unknown_fields(
    model: type[BaseModel], payload: dict[str, object]
) -> None:
    with pytest.raises(ValidationError):
        model.model_validate(payload)


@pytest.mark.parametrize(
    ("model", "payload", "field", "value"),
    [
        (BacktestDraftRequest, valid_draft(), "environment", "BACKTEST"),
        (InputManifestV1, valid_manifest(), "strategy_id", "changed"),
        (
            RunRecordV1,
            valid_run_record(),
            "run_id",
            "changed",
        ),
        (
            EventEnvelopeV1,
            {
                "event_id": "evt_bt_01_000042",
                "run_id": "bt_01",
                "seq": 42,
                "source_seq": 17,
                "ts_event_ns": "1735689600000000000",
                "ts_ingest_ns": "1735689600000000000",
                "type": "order.filled",
                "source": "runner",
                "writer": "control-api",
                "schema_version": 1,
                "payload": {},
            },
            "event_id",
            "changed",
        ),
        (
            ErrorResponse,
            {"code": "REQUEST_INVALID", "message": "invalid", "retryable": False},
            "message",
            "changed",
        ),
    ],
)
def test_models_are_frozen(
    model: type[BaseModel], payload: dict[str, object], field: str, value: object
) -> None:
    instance = model.model_validate(payload)
    with pytest.raises(ValidationError):
        setattr(instance, field, value)


@pytest.mark.parametrize("value", [1735689600000000000, 0.1, "-1", "01", "1.0", "1e3"])
@pytest.mark.parametrize("field", ["created_at_ns", "started_at_ns", "completed_at_ns"])
def test_run_record_uses_nanosecond_integer_strings(field: str, value: object) -> None:
    record = valid_run_record(**{field: value})
    with pytest.raises(ValidationError):
        RunRecordV1.model_validate(record)


def test_run_record_carries_operational_identity_and_evidence_boundaries() -> None:
    record = RunRecordV1.model_validate(
        valid_run_record(
            prepared_terminal_state="COMPLETED",
            prepared_terminal_state_version=7,
            started_at_ns="1735689600000000001",
            completed_at_ns="1735689600000000002",
            duration_ns="1",
            runner_identity={"pid": 1234, "process_start_ns": "1735689600000000001"},
            runner_exit={"exit_code": 0, "signal": None},
            materialized_event_seq=42,
            materialized_audit_seq=42,
            evidence_status="VERIFIED",
        )
    )

    assert record.preflight_id == "pf_01"
    assert record.evidence_status == "VERIFIED"


@pytest.mark.parametrize(
    "payload", [{"payload": {"amount": object()}}, {"details": {"amount": 0.1}}]
)
def test_json_slots_reject_non_json_values_and_binary_floats(payload: dict[str, object]) -> None:
    if "payload" in payload:
        envelope = {
            "event_id": "evt_bt_01_000042",
            "run_id": "bt_01",
            "seq": 42,
            "source_seq": 17,
            "ts_event_ns": "1735689600000000000",
            "ts_ingest_ns": "1735689600000000000",
            "type": "order.filled",
            "source": "runner",
            "writer": "control-api",
            "schema_version": 1,
            **payload,
        }
        with pytest.raises(ValidationError):
            EventEnvelopeV1.model_validate(envelope)
    else:
        with pytest.raises(ValidationError):
            ErrorResponse.model_validate(
                {"code": "REQUEST_INVALID", "message": "invalid", "retryable": False, **payload}
            )


def test_run_record_forbids_seal_hash() -> None:
    with pytest.raises(ValidationError):
        RunRecordV1.model_validate(valid_run_record(seal_hash="never-here"))


def test_json_slots_and_persistent_collections_are_deeply_immutable() -> None:
    costs = CostFillModelV1.model_validate(valid_costs())
    draft = BacktestDraftRequest.model_validate(valid_draft())
    manifest = InputManifestV1.model_validate(
        valid_manifest(
            canonical_config={"nested": {"limit_price": "100.25"}},
            gaps=[{"start_ns": "1", "end_ns": "2", "instrument_id": "ETH/USDT.SIM"}],
        )
    )
    envelope = EventEnvelopeV1.model_validate(
        {
            "event_id": "evt_bt_01_000042",
            "run_id": "bt_01",
            "seq": 42,
            "source_seq": 17,
            "ts_event_ns": "1735689600000000000",
            "ts_ingest_ns": "1735689600000000000",
            "type": "order.filled",
            "source": "runner",
            "writer": "control-api",
            "schema_version": 1,
            "payload": {"fills": [{"quantity": "2"}]},
        }
    )

    with pytest.raises(ValidationError):
        costs.fee.minimum_fee = "0.1"
    with pytest.raises(ValidationError):
        draft.information_set_policy.availability_field = "future"
    with pytest.raises(TypeError):
        manifest.canonical_config["nested"]["limit_price"] = "0"
    with pytest.raises(AttributeError):
        manifest.instruments.append(manifest.instruments[0])
    with pytest.raises(AttributeError):
        manifest.gaps.append({"start_ns": "3", "end_ns": "4"})
    with pytest.raises(TypeError):
        envelope.payload["fills"][0]["quantity"] = "3"


def test_typed_children_compose_without_json_slot_scanning() -> None:
    window = TimeWindowV1(start_ns="1735689600000000000", end_ns="1735776000000000000")
    venue = VenueAccountModelV1(
        venue_id="SIM",
        oms_type="HEDGING",
        account_type="MARGIN",
        book_type="L1_MBP",
        routing=False,
        use_random_ids=False,
        use_position_ids=True,
        allow_cash_borrowing=False,
        starting_balance="1000000",
        currency="USDT",
    )
    costs = DraftCostFillModelV1.model_validate(valid_costs())

    draft = BacktestDraftRequest.model_validate(
        valid_draft(window=window, venue_account_model=venue, cost_fill_model=costs)
    )

    assert draft.window is window
    assert draft.venue_account_model is venue
    assert draft.cost_fill_model is costs


def test_json_slot_dumps_are_standard_json_objects_and_arrays() -> None:
    manifest = InputManifestV1.model_validate(
        valid_manifest(canonical_config={"rules": [{"limit_price": "100.25"}]})
    )

    dumped = manifest.model_dump(mode="json")
    parsed = json.loads(manifest.model_dump_json())

    assert isinstance(dumped["canonical_config"], dict)
    assert isinstance(dumped["canonical_config"]["rules"], list)
    assert isinstance(dumped["instruments"], list)
    assert isinstance(parsed["canonical_config"], dict)
    assert isinstance(parsed["canonical_config"]["rules"], list)
    assert isinstance(parsed["gaps"], list)


def test_json_slot_and_decimal_map_schemas_match_runtime_validation() -> None:
    manifest_schema = InputManifestV1.model_json_schema()
    cost_schema = CostFillModelV1.model_json_schema()

    json_value_schema = manifest_schema["$defs"]["JsonObject"]["additionalProperties"]

    assert "number" not in json.dumps(json_value_schema, sort_keys=True)
    assert {item["type"] for item in json_value_schema["anyOf"][:4]} == {
        "null",
        "boolean",
        "integer",
        "string",
    }
    assert set(cost_schema["required"]) == {
        "schema",
        "fee",
        "spread",
        "slippage",
        "latency",
        "liquidity",
        "cancel",
    }
    assert cost_schema["additionalProperties"] is False


@pytest.mark.parametrize(
    ("model", "payload", "schema"),
    [
        (CostFillModelV1, valid_costs(), "CostFillModel.v1"),
        (InputManifestV1, valid_manifest(), "InputManifest.v1"),
        (RunRecordV1, valid_run_record(), "RunRecord.v1"),
    ],
)
def test_schema_alias_is_the_only_external_name(
    model: type[BaseModel], payload: dict[str, object], schema: str
) -> None:
    instance = model.model_validate(payload)
    field_name_payload = {key: value for key, value in payload.items() if key != "schema"}
    field_name_payload["schema_"] = schema

    assert instance.model_dump()["schema"] == schema
    assert json.loads(instance.model_dump_json())["schema"] == schema
    with pytest.raises(ValidationError):
        model.model_validate(field_name_payload)


def test_validated_contract_values_compose_by_identity() -> None:
    draft = BacktestDraftRequest.model_validate(valid_draft())
    complete_costs = CostFillModelV1.model_validate(
        draft.cost_fill_model.model_dump(mode="json", by_alias=True)
    )
    assert draft.venue_account_model is not None
    complete_account = VenueAccountModelV1.model_validate(
        draft.venue_account_model.model_dump(mode="json", by_alias=True)
    )
    manifest = InputManifestV1.model_validate(
        valid_manifest(
            information_set_policy=draft.information_set_policy,
            evaluation_protocol=draft.evaluation_protocol,
            window=draft.window,
            venue_account_model=complete_account,
            cost_fill_model=complete_costs,
        )
    )

    assert manifest.information_set_policy is draft.information_set_policy
    assert manifest.evaluation_protocol is draft.evaluation_protocol
    assert manifest.window is draft.window
    assert manifest.venue_account_model is complete_account
    assert manifest.venue_account_model.model_dump() == draft.venue_account_model.model_dump()
    assert manifest.cost_fill_model is complete_costs


@pytest.mark.parametrize("forged", [ForgedJsonObject({}), ForgedJsonArray([])])
def test_json_slots_reject_forged_frozen_subclasses(forged: object) -> None:
    payload = forged if isinstance(forged, ForgedJsonObject) else {"nested": forged}

    with pytest.raises(ValidationError):
        BacktestDraftRequest.model_validate(valid_draft(information_set_policy=payload))


@pytest.mark.parametrize(
    "value",
    [
        ("not", "json"),
        MappingProxyType({"not": "json"}),
        object(),
        0.1,
    ],
)
def test_json_slots_reject_raw_non_json_python_values(value: object) -> None:
    with pytest.raises(ValidationError):
        BacktestDraftRequest.model_validate(valid_draft(information_set_policy={"value": value}))


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
        "probe @v1",
        "probe@ v1",
        "Probe@v1",
        "probe@V1",
        "probe_name@v1",
    ],
)
def test_draft_registry_references_reject_paths_urls_modules_and_ambiguous_ids(
    field: str,
    value: str,
) -> None:
    with pytest.raises(ValidationError):
        BacktestDraftRequest.model_validate(valid_draft(**{field: value}))


@pytest.mark.parametrize(
    "window",
    [
        {"start_ns": "0", "end_ns": "0"},
        {"start_ns": "1735689600000000000", "end_ns": "1735689600000000000"},
        {"start_ns": "1735776000000000000", "end_ns": "1735689600000000000"},
    ],
)
def test_draft_and_manifest_top_level_windows_must_be_nonempty_half_open(
    window: dict[str, str],
) -> None:
    assert TimeWindowV1.model_validate(window).start_ns == window["start_ns"]
    with pytest.raises(ValidationError, match="top-level window"):
        BacktestDraftRequest.model_validate(valid_draft(window=window))
    with pytest.raises(ValidationError, match="top-level window"):
        InputManifestV1.model_validate(valid_manifest(window=window))
