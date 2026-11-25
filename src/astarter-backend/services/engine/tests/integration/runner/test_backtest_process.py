from __future__ import annotations

import math
from dataclasses import dataclass, replace
from hashlib import sha256
from pathlib import Path

import pytest
from nautilus_trader.backtest import BacktestNode

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.catalog.fixture_publisher import open_catalog_service
from stark_trading_os.domain.models import (
    CatalogManifestV1,
    DeterminismProbeConfigV1,
    InputManifestV1,
)
from stark_trading_os.runner.determinism_probe import (
    ProbeObservationContext,
    build_probe_registration,
    clear_probe_observation_context,
    install_probe_observation_context,
)
from stark_trading_os.runner.input_adapter import LoadedRunnerInput, load_runner_input
from stark_trading_os.runner.nautilus_backtest import (
    NativeBacktestFailure,
    run_native_backtest,
)

_FIXTURE_ROOT = Path(__file__).resolve().parents[5] / "data" / "fixtures"


@dataclass(frozen=True)
class RealNodeResult:
    loaded: LoadedRunnerInput
    candidates: tuple[object, ...]
    orders: object
    results: tuple[object, ...]


def _strategy() -> dict[str, object]:
    return {
        "entry_limit_price": "100",
        "entry_quantity": "15",
        "metric_round_trip_quantity": "1",
        "metric_round_trips": 5,
        "risk_probe_quantity": "20",
        "venue_rejection_quantity": "1",
    }


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


def prepare_real_runner_input(
    tmp_path: Path,
    *,
    run_id: str = "bt_precision",
    window_end_ns: int | None = None,
) -> LoadedRunnerInput:
    runtime = tmp_path / "runtime"
    publisher, control = open_catalog_service(
        fixture_root=_FIXTURE_ROOT,
        runtime_root=runtime,
    )
    try:
        publication = publisher.publish("determinism-probe-v1")
    finally:
        control.close()
    catalog = CatalogManifestV1.model_validate_json(publication.publication_bytes)
    strategy = _strategy()
    risk = {"max_notional": "1600"}
    instrument = catalog.inventory.instrument
    end_ns = (
        int(catalog.inventory.readback.last_ts_init) if window_end_ns is None else window_end_ns
    )
    manifest = InputManifestV1.model_validate(
        {
            "schema": "InputManifest.v1",
            "environment": "BACKTEST",
            "strategy_id": "determinism-probe",
            "strategy_version": "v1",
            "canonical_config": strategy,
            "config_hash": sha256(canonical_json_bytes(strategy)).hexdigest(),
            "engine_package_version": "2.0.0rc3",
            "engine_tag_commit": "648970ce64a304d93da0a29320cb6e19b905fa39",
            "python_version": "3.12.4",
            "precision_mode": "FIXED_PRECISION_16",
            "fixture_id": catalog.fixture_id,
            "catalog_revision": publication.catalog_revision,
            "source_checksum": catalog.source_checksum,
            "catalog_checksum": catalog.catalog_checksum,
            "instruments": [
                {
                    "instrument_id": instrument.instrument_id,
                    "price_increment": instrument.price_increment,
                    "quantity_increment": instrument.size_increment,
                }
            ],
            "data_types": list(catalog.inventory.readback.data_types),
            "window": {
                "start_ns": catalog.inventory.readback.first_ts_init,
                "end_ns": str(end_ns),
            },
            "timezone": catalog.inventory.timezone,
            "gaps": catalog.inventory.gaps,
            "duplicates": catalog.inventory.duplicates,
            "ordering_result": catalog.inventory.ordering_result,
            "information_set_policy": catalog.inventory.information_set_policy,
            "evaluation_protocol": catalog.inventory.evaluation_protocol,
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
            "risk_policy_id": "probe-risk",
            "risk_policy_version": "v1",
            "canonical_risk_policy": risk,
            "risk_policy_hash": sha256(canonical_json_bytes(risk)).hexdigest(),
            "replay_seed": 7,
        }
    )
    staging_parent = runtime / "staging"
    staging_parent.mkdir(mode=0o700)
    staging = staging_parent / run_id
    staging.mkdir(mode=0o700)
    manifest_path = staging / "input-manifest.json"
    manifest_path.write_bytes(canonical_json_bytes(manifest.model_dump(mode="json", by_alias=True)))
    manifest_path.chmod(0o600)
    return load_runner_input(
        run_id=run_id,
        staging_dir=staging,
        input_manifest=manifest_path,
    )


def run_real_node_without_export(loaded: LoadedRunnerInput) -> RealNodeResult:
    definition = DeterminismProbeConfigV1.model_validate(loaded.manifest.canonical_config)
    registration = build_probe_registration(
        instrument_id=loaded.manifest.instruments[0].instrument_id,
        definition=definition,
    )
    records = tuple(
        record
        for record in loaded.catalog_manifest.inventory.source_records
        if int(loaded.manifest.window.start_ns)
        <= int(record.ts_available_ns)
        < int(loaded.manifest.window.end_ns)
    )
    context = ProbeObservationContext(
        run_id=loaded.run_id,
        input_manifest_hash=loaded.input_manifest_hash,
        catalog_revision=loaded.manifest.catalog_revision,
        instrument=loaded.catalog_manifest.inventory.instrument,
        records=records,
    )
    install_probe_observation_context(context)
    node = BacktestNode(configs=[loaded.run_config])
    try:
        node.build()
        node.add_strategy_from_config(loaded.run_config.id, registration)
        results = tuple(node.run())
        context.require_all_quotes_observed()
        orders = node.generate_orders_report(loaded.run_config.id)
        return RealNodeResult(
            loaded=loaded,
            candidates=tuple(context.candidates),
            orders=orders,
            results=results,
        )
    finally:
        node.dispose()
        clear_probe_observation_context()


def test_real_node_maps_manifest_literals_to_instrument_precision_before_submission(
    tmp_path: Path,
) -> None:
    result = run_real_node_without_export(prepare_real_runner_input(tmp_path))
    orders = result.orders

    assert str(orders.loc["ENTRY-PARTIAL", "status"]) == "CANCELED"
    assert str(orders.loc["ENTRY-PARTIAL", "filled_qty"]) == "10.000"
    assert str(orders.loc["RISK-PROBE", "status"]) == "DENIED"
    assert str(orders.loc["VENUE-REJECTION", "status"]) == "REJECTED"
    candidate_types = [candidate.type for candidate in result.candidates]
    assert "order.partially_filled" in candidate_types
    assert "order.cancelled" in candidate_types
    assert "risk.rejected" in candidate_types
    assert "order.rejected" in candidate_types
    expected_metric_prices = {
        "METRIC-OPEN-1": "101.00",
        "METRIC-CLOSE-1": "103.00",
        "METRIC-OPEN-2": "102.00",
        "METRIC-CLOSE-2": "100.00",
        "METRIC-OPEN-3": "101.00",
        "METRIC-CLOSE-3": "104.00",
        "METRIC-OPEN-4": "106.00",
        "METRIC-CLOSE-4": "101.00",
        "METRIC-OPEN-5": "108.00",
        "METRIC-CLOSE-5": "112.00",
    }
    for client_order_id, expected_price in expected_metric_prices.items():
        assert str(orders.loc[client_order_id, "status"]) == "FILLED"
        assert str(orders.loc[client_order_id, "avg_px"]) == expected_price
    assert candidate_types.count("position.closed") == 5
    progress = [candidate for candidate in result.candidates if candidate.type == "run.progress"]
    assert [candidate.payload["quote_identity"]["source_seq"] for candidate in progress] == list(
        range(1, 13)
    )
    assert all(
        int(candidate.payload["quote_identity"]["ts_available_ns"])
        <= int(candidate.payload["decision_ts_ns"])
        for candidate in progress
    )
    metrics = result.results[0]
    for group in (metrics.stats_pnls, metrics.stats_returns, metrics.stats_general):
        pending = [group]
        while pending:
            value = pending.pop()
            if isinstance(value, dict):
                pending.extend(value.values())
            elif isinstance(value, float):
                assert math.isfinite(value)


def test_real_node_binds_cached_native_instrument_to_verified_catalog_sidecar(
    tmp_path: Path,
) -> None:
    loaded = prepare_real_runner_input(tmp_path)
    drifted_instrument = loaded.catalog_manifest.inventory.instrument.model_copy(
        update={"maker_fee": "0.9"}
    )
    drifted_inventory = loaded.catalog_manifest.inventory.model_copy(
        update={"instrument": drifted_instrument}
    )
    drifted_catalog = loaded.catalog_manifest.model_copy(update={"inventory": drifted_inventory})

    with pytest.raises(RuntimeError, match="NATIVE_INSTRUMENT_CATALOG_MISMATCH"):
        run_real_node_without_export(replace(loaded, catalog_manifest=drifted_catalog))


def test_real_node_exports_all_five_finite_native_reports(tmp_path: Path) -> None:
    output = run_native_backtest(prepare_real_runner_input(tmp_path))

    assert set(output.reports) == {
        "orders",
        "fills",
        "positions",
        "account",
        "metrics",
    }
    assert output.node_construction_count == 1
    assert output.node_run_count == 1
    assert output.node_disposed is True
    assert len(output.reports["orders"]) == 13
    assert len(output.reports["fills"]) == 11
    assert len(output.reports["positions"]) == 6
    assert sum(position["ts_closed"] is not None for position in output.reports["positions"]) == 5
    assert len(output.reports["account"]) > 0


def test_real_node_exports_native_portfolio_equity_series(tmp_path: Path) -> None:
    """Catches losing native MTM snapshots or replacing them with derived returns."""

    output = run_native_backtest(prepare_real_runner_input(tmp_path))
    metrics = output.reports["metrics"]

    assert isinstance(metrics, dict)
    assert "performance_series" in metrics
    series = metrics["performance_series"]
    assert isinstance(series, dict)
    assert series == {
        **{key: series[key] for key in series if key == "points"},
        "schema": "PortfolioEquitySeries.v1",
        "source": "NAUTILUS_PORTFOLIO_SNAPSHOTS",
        "selection": "SOLE_TOTAL_EQUITY",
        "calculation": "RUNNING_PEAK_DRAWDOWN_PERCENT_V1",
        "timestamp_unit": "UNIX_EPOCH_NS",
        "equity_unit": "ACCOUNT_CURRENCY",
        "drawdown_unit": "PERCENT",
        "account_id": "SIM-001",
        "currency": "USDT",
    }
    points = series["points"]
    assert isinstance(points, list)
    assert len(points) == 12
    assert [point["point_index"] for point in points] == list(range(12))
    assert [int(point["ts_event_ns"]) for point in points] == sorted(
        int(point["ts_event_ns"]) for point in points
    )
    assert points[0]["equity_amount"] == "1000000"
    assert points[-1]["equity_amount"] == "1000119.962"
    assert all(
        point["is_stale"] is False
        and point["stale_instruments"] == []
        and point["stale_currencies"] == []
        and point["unpriced_instruments"] == []
        and isinstance(point["ts_event_ns"], str)
        and isinstance(point["equity_amount"], str)
        and isinstance(point["drawdown_pct"], str)
        for point in points
    )


def test_real_node_report_failure_preserves_candidate_cursor_and_disposes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_report_export(*args: object, **kwargs: object) -> dict[str, object]:
        raise RuntimeError("injected exporter failure")

    monkeypatch.setattr(
        "stark_trading_os.runner.nautilus_backtest.export_backtest_reports",
        fail_report_export,
    )

    with pytest.raises(NativeBacktestFailure) as captured:
        run_native_backtest(prepare_real_runner_input(tmp_path))

    failure = captured.value
    assert failure.code == "REPORT_EXPORT_FAILED"
    assert failure.node_disposed is True
    assert len(failure.candidates) > 0
    assert [candidate.source_seq for candidate in failure.candidates] == list(
        range(1, len(failure.candidates) + 1)
    )
