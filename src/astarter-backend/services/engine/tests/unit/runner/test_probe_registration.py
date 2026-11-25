from __future__ import annotations

import inspect
from copy import deepcopy

import pytest
from nautilus_trader.model import InstrumentId, Price, Quantity, QuoteTick
from nautilus_trader.risk import RiskEngineConfig
from nautilus_trader.trading import ImportableStrategyConfig, Strategy
from pydantic import ValidationError

from stark_trading_os.domain.models import (
    CatalogInstrumentV1,
    CatalogSourceRecordV1,
    DeterminismProbeConfigV1,
    ProbeRiskPolicyV1,
)
from stark_trading_os.runner.determinism_probe import (
    PROBE_CONFIG_PATH,
    PROBE_STRATEGY_PATH,
    DeterminismProbeConfig,
    DeterminismProbeStrategy,
    ProbeObservationContext,
    build_probe_registration,
    build_probe_risk_config,
)


def _strategy_value() -> dict[str, object]:
    return {
        "entry_limit_price": "100",
        "entry_quantity": "15",
        "metric_round_trip_quantity": "1",
        "metric_round_trips": 5,
        "risk_probe_quantity": "20",
        "venue_rejection_quantity": "1",
    }


def test_registration_uses_only_the_approved_import_paths_and_manifest_instrument() -> None:
    definition = DeterminismProbeConfigV1.model_validate(_strategy_value())

    registration = build_probe_registration(
        instrument_id="ETH/USDT.SIM",
        definition=definition,
    )

    assert type(registration) is ImportableStrategyConfig
    assert registration.strategy_path == PROBE_STRATEGY_PATH == (
        "stark_trading_os.runner.determinism_probe:DeterminismProbeStrategy"
    )
    assert registration.config_path == PROBE_CONFIG_PATH == (
        "stark_trading_os.runner.determinism_probe:DeterminismProbeConfig"
    )
    assert registration.config == {"instrument_id": "ETH/USDT.SIM", **_strategy_value()}
    assert issubclass(DeterminismProbeStrategy, Strategy)
    assert "strategy_path" not in inspect.signature(build_probe_registration).parameters
    assert "config_path" not in inspect.signature(build_probe_registration).parameters


def test_rc3_custom_strategy_config_preserves_only_validated_runtime_fields() -> None:
    config = DeterminismProbeConfig(
        instrument_id="ETH/USDT.SIM",
        **_strategy_value(),
    )

    assert config.instrument_id == "ETH/USDT.SIM"
    assert config.entry_limit_price == "100"
    assert config.entry_quantity == "15"
    assert config.metric_round_trip_quantity == "1"
    assert config.metric_round_trips == 5
    assert config.risk_probe_quantity == "20"
    assert config.venue_rejection_quantity == "1"


def test_risk_definition_maps_to_the_single_native_max_notional_entry() -> None:
    policy = ProbeRiskPolicyV1.model_validate({"max_notional": "1600"})

    risk = build_probe_risk_config(
        instrument_id="ETH/USDT.SIM",
        policy=policy,
    )

    assert type(risk) is RiskEngineConfig
    assert risk.max_notional_per_order == {"ETH/USDT.SIM": "1600"}
    assert risk.bypass is False


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("entry_limit_price", "100.01"),
        ("entry_quantity", "14"),
        ("metric_round_trip_quantity", "2"),
        ("metric_round_trips", 4),
        ("metric_round_trips", True),
        ("risk_probe_quantity", "19"),
        ("venue_rejection_quantity", "2"),
    ],
)
def test_every_frozen_strategy_literal_rejects_drift(field: str, value: object) -> None:
    definition = deepcopy(_strategy_value())
    definition[field] = value

    with pytest.raises(ValidationError):
        DeterminismProbeConfigV1.model_validate(definition)


@pytest.mark.parametrize(
    "value",
    ["0", "1599", "1600.0", 1600, True],
)
def test_frozen_risk_literal_and_type_reject_drift(value: object) -> None:
    with pytest.raises(ValidationError):
        ProbeRiskPolicyV1.model_validate({"max_notional": value})


def _source_record(
    *,
    source_seq: int,
    bid_price: str,
    ask_price: str,
    ts_event_ns: int,
    ts_available_ns: int,
) -> CatalogSourceRecordV1:
    return CatalogSourceRecordV1(
        instrument_id="ETH/USDT.SIM",
        bid_price=bid_price,
        ask_price=ask_price,
        bid_size="10.000",
        ask_size="10.000",
        ts_event_ns=str(ts_event_ns),
        ts_available_ns=str(ts_available_ns),
        source_seq=source_seq,
        source_revision="determinism-probe-v1",
        record_hash=f"{source_seq:064x}",
    )


def _native_quote(record: CatalogSourceRecordV1) -> QuoteTick:
    return QuoteTick(
        InstrumentId.from_str(record.instrument_id),
        Price.from_str(record.bid_price),
        Price.from_str(record.ask_price),
        Quantity.from_str(record.bid_size),
        Quantity.from_str(record.ask_size),
        int(record.ts_event_ns),
        int(record.ts_available_ns),
    )


def _observation_context(
    records: tuple[CatalogSourceRecordV1, ...],
) -> ProbeObservationContext:
    return ProbeObservationContext(
        run_id="bt_001",
        input_manifest_hash="a" * 64,
        catalog_revision="b" * 64,
        instrument=CatalogInstrumentV1(
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
            maker_fee="0.0002",
            taker_fee="0.001",
            ts_event_ns="1",
            ts_available_ns="1",
        ),
        records=records,
    )


def test_equal_availability_callbacks_must_follow_catalog_source_order() -> None:
    records = (
        _source_record(
            source_seq=1,
            bid_price="99.00",
            ask_price="100.00",
            ts_event_ns=101,
            ts_available_ns=200,
        ),
        _source_record(
            source_seq=2,
            bid_price="101.00",
            ask_price="102.00",
            ts_event_ns=100,
            ts_available_ns=200,
        ),
    )
    context = _observation_context(records)

    with pytest.raises(RuntimeError, match="QUOTE_SOURCE_ORDER_INVALID"):
        context.observe_quote(_native_quote(records[1]), decision_ts_ns=200)


def test_skipped_source_record_is_rejected_before_progress_emission() -> None:
    records = (
        _source_record(
            source_seq=1,
            bid_price="99.00",
            ask_price="100.00",
            ts_event_ns=100,
            ts_available_ns=200,
        ),
        _source_record(
            source_seq=2,
            bid_price="101.00",
            ask_price="102.00",
            ts_event_ns=201,
            ts_available_ns=201,
        ),
    )
    context = _observation_context(records)

    with pytest.raises(RuntimeError, match="QUOTE_SOURCE_ORDER_INVALID"):
        context.observe_quote(_native_quote(records[1]), decision_ts_ns=201)
    assert context.candidates == []


def test_duplicate_callback_is_rejected_and_correct_order_is_exact() -> None:
    records = (
        _source_record(
            source_seq=1,
            bid_price="99.00",
            ask_price="100.00",
            ts_event_ns=100,
            ts_available_ns=200,
        ),
        _source_record(
            source_seq=2,
            bid_price="101.00",
            ask_price="102.00",
            ts_event_ns=201,
            ts_available_ns=201,
        ),
    )
    context = _observation_context(records)
    context.observe_quote(_native_quote(records[0]), decision_ts_ns=200)
    context.observe_quote(_native_quote(records[1]), decision_ts_ns=201)
    context.require_all_quotes_observed()

    progress_source_sequences = [
        candidate.payload["quote_identity"]["source_seq"]
        for candidate in context.candidates
    ]
    assert progress_source_sequences == [1, 2]
    with pytest.raises(RuntimeError, match="QUOTE_IDENTITY_UNMAPPED"):
        context.observe_quote(_native_quote(records[1]), decision_ts_ns=201)
