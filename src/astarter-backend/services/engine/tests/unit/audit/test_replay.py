from __future__ import annotations

from copy import deepcopy
from decimal import ROUND_DOWN, Decimal, Inexact, Underflow, localcontext

import pytest

import stark_trading_os.runner.report_export as report_export_module
from stark_trading_os.audit.replay import ReplaySchemaError, project_events, replay_digest_v1
from stark_trading_os.runner.compat_probe import run_compat_probe
from stark_trading_os.runner.report_export import export_dataframe_report


def replay_fixture(**overrides: object) -> dict[str, object]:
    fixture: dict[str, object] = {
        "input_manifest_hash": "a" * 64,
        "events": [
            {
                "run_id": "bt_a",
                "event_id": "evt_a",
                "seq": 8,
                "source_seq": 1,
                "ts_event_ns": "20",
                "ts_ingest_ns": "200",
                "type": "order.filled",
                "source": "runner",
                "writer": "control-api",
                "schema_version": 1,
                "payload": {
                    "client_order_id": "order-1",
                    "instrument_id": "ETHUSDT.SIM",
                    "last_qty": "2",
                    "last_px": "100",
                    "filled_qty": "2",
                    "trade_id": "trade-1",
                    "commission": "0 USDT",
                    "currency": "USDT",
                    "liquidity_side": "TAKER",
                    "event_id": "native-event-a",
                },
            },
            {
                "run_id": "bt_a",
                "event_id": "evt_progress_a",
                "seq": 7,
                "source_seq": 2,
                "ts_event_ns": "10",
                "ts_ingest_ns": "100",
                "type": "run.progress",
                "source": "runner",
                "writer": "control-api",
                "schema_version": 1,
                "payload": {
                    "progress": "decision",
                    "decision_ts_ns": "10",
                    "quote_identity": {
                        "instrument_id": "ETHUSDT.SIM",
                        "ts_event_ns": "9",
                        "ts_available_ns": "10",
                        "source_seq": 1,
                        "source_revision": "determinism-probe-v1",
                        "record_hash": "b" * 64,
                    },
                },
            },
        ],
        "reports": {
            "orders": [
                {
                    "client_order_id": "order-1",
                    "trader_id": "TRADER-001",
                    "strategy_id": "probe",
                    "instrument_id": "ETHUSDT.SIM",
                    "side": "BUY",
                    "type": "LIMIT",
                    "quantity": "2",
                    "price": "100",
                    "status": "FILLED",
                    "time_in_force": "GTC",
                    "expire_time_ns": None,
                    "is_post_only": False,
                    "is_reduce_only": False,
                    "is_quote_quantity": False,
                    "filled_qty": "2",
                    "init_id": "init-1",
                    "ts_init": "1",
                    "ts_last": "20",
                    "commissions": [],
                    "venue_order_id": "venue-1",
                    "display_qty": None,
                    "emulation_trigger": "NO_TRIGGER",
                    "trigger_instrument_id": None,
                    "contingency_type": "NO_CONTINGENCY",
                    "order_list_id": None,
                    "linked_order_ids": [],
                    "parent_order_id": None,
                    "exec_algorithm_id": None,
                    "exec_algorithm_params": None,
                    "exec_spawn_id": None,
                    "tags": [],
                    "account_id": "SIM-001",
                    "slippage": None,
                    "position_id": "position-1",
                    "liquidity_side": "TAKER",
                    "last_trade_id": "trade-1",
                    "avg_px": "100",
                }
            ],
            "fills": [_fill_report_row()],
            "positions": [_position_report_row()],
            "account": [],
            "metrics": {
                "summary": _summary("1"),
                "stats_pnls": {"USDT": {"PnL (total)": "0", "PnL% (total)": "0"}},
                "stats_returns": {
                    "Sharpe Ratio (252 days)": "1",
                    "Sortino Ratio (252 days)": "1",
                    "Average (Return)": "0",
                    "Returns Skewness": "0",
                    "Average Win (Return)": "0",
                    "Tail Ratio": "1",
                    "Risk Return Ratio": "1",
                    "Returns Kurtosis": "0",
                    "Returns Volatility (252 days)": "0",
                    "Profit Factor": "1",
                    "Average Loss (Return)": "0",
                },
                "stats_general": {},
            },
        },
    }
    fixture.update(overrides)
    return fixture


def _performance_series() -> dict[str, object]:
    quality = {
        "is_stale": False,
        "stale_instruments": [],
        "stale_currencies": [],
        "unpriced_instruments": [],
    }
    return {
        "schema": "PortfolioEquitySeries.v1",
        "source": "NAUTILUS_PORTFOLIO_SNAPSHOTS",
        "selection": "SOLE_TOTAL_EQUITY",
        "calculation": "RUNNING_PEAK_DRAWDOWN_PERCENT_V1",
        "timestamp_unit": "UNIX_EPOCH_NS",
        "equity_unit": "ACCOUNT_CURRENCY",
        "drawdown_unit": "PERCENT",
        "account_id": "SIM-001",
        "currency": "USDT",
        "points": [
            {
                "point_index": 0,
                "ts_event_ns": "10",
                "equity_amount": "100",
                "drawdown_pct": "0",
                **quality,
            },
            {
                "point_index": 1,
                "ts_event_ns": "11",
                "equity_amount": "90",
                "drawdown_pct": "-10",
                **quality,
            },
        ],
    }


def test_same_inputs_ignore_only_schema_declared_operational_fields() -> None:
    left = replay_fixture()
    right = replay_fixture()
    right_events = deepcopy(right["events"])
    assert isinstance(right_events, list)
    right_events[0]["run_id"] = "bt_b"
    right_events[0]["event_id"] = "evt_b"
    right_events[0]["ts_ingest_ns"] = "999"
    right["events"] = right_events

    assert replay_digest_v1(left) == replay_digest_v1(right)


def test_progress_requires_the_closed_structured_information_set_shape() -> None:
    baseline = replay_fixture()
    changed = replay_fixture()
    changed_events = changed["events"]
    assert isinstance(changed_events, list)
    changed_events[1]["payload"]["quote_identity"]["record_hash"] = "c" * 64
    assert replay_digest_v1(baseline) == replay_digest_v1(changed)

    attacks = (
        {"progress": "decision"},
        {
            **baseline["events"][1]["payload"],
            "future": "not-authorized",
        },
        {
            **baseline["events"][1]["payload"],
            "decision_ts_ns": "9",
        },
        {
            **baseline["events"][1]["payload"],
            "quote_identity": {
                **baseline["events"][1]["payload"]["quote_identity"],
                "source_seq": 0,
            },
        },
    )
    for payload in attacks:
        fixture = replay_fixture()
        events = fixture["events"]
        assert isinstance(events, list)
        events[1]["payload"] = payload
        with pytest.raises(ReplaySchemaError):
            project_events(events)


def test_unknown_event_field_is_not_ad_hoc_filtered() -> None:
    fixture = replay_fixture()
    events = fixture["events"]
    assert isinstance(events, list)
    events[0]["surprise"] = "nope"

    with pytest.raises(ReplaySchemaError, match="unknown field"):
        replay_digest_v1(fixture)


def test_runner_economic_decimal_payloads_are_canonicalized_or_rejected() -> None:
    fixture = replay_fixture()
    events = fixture["events"]
    assert isinstance(events, list)
    events[0]["payload"]["last_qty"] = "2.0"
    events[0]["payload"]["last_px"] = "100.00"

    projection = project_events(events)

    assert projection[0]["normalized_payload"]["last_qty"] == "2"
    assert projection[0]["normalized_payload"]["last_px"] == "100"
    events[0]["payload"]["last_qty"] = 2.0
    with pytest.raises(ReplaySchemaError, match="decimal string"):
        project_events(events)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("client_order_id", 7),
        ("instrument_id", {}),
        ("currency", []),
        ("commission", {}),
        ("last_qty", "bad"),
    ],
)
def test_runner_economic_payload_field_types_are_closed(field: str, value: object) -> None:
    fixture = replay_fixture()
    events = fixture["events"]
    assert isinstance(events, list)
    payload = events[0]["payload"]
    assert isinstance(payload, dict)
    payload[field] = value
    if field == "currency":
        payload["commission"] = "0 USDT"
    if field == "commission":
        payload["currency"] = "USDT"

    with pytest.raises(ReplaySchemaError):
        project_events(events)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("liquidity_side", "UNKNOWN"),
        ("currency", "usd"),
        ("commission", "0.00000000 USDT"),
        ("commission", "0 USD"),
    ],
)
def test_replay_rejects_fill_value_domain_and_money_drift(
    field: str,
    value: str,
) -> None:
    fixture = replay_fixture()
    events = fixture["events"]
    assert isinstance(events, list)
    payload = events[0]["payload"]
    assert isinstance(payload, dict)
    payload[field] = value

    with pytest.raises(ReplaySchemaError):
        project_events(events)


def test_replay_binds_all_runner_payloads_to_one_instrument() -> None:
    fixture = replay_fixture()
    events = fixture["events"]
    assert isinstance(events, list)
    quote_identity = events[1]["payload"]["quote_identity"]
    assert isinstance(quote_identity, dict)
    quote_identity["instrument_id"] = "BTCUSDT.SIM"

    with pytest.raises(ReplaySchemaError, match="instrument"):
        project_events(events)


@pytest.mark.parametrize(
    ("payload", "accepted"),
    [
        (
            {
                "client_order_id": "order-market",
                "instrument_id": "ETHUSDT.SIM",
                "side": "BUY",
                "type": "MARKET",
                "quantity": "1",
                "status": "SUBMITTED",
            },
            True,
        ),
        (
            {
                "client_order_id": "order-market",
                "instrument_id": "ETHUSDT.SIM",
                "side": "BUY",
                "type": "MARKET",
                "quantity": "1",
                "price": "0",
                "status": "SUBMITTED",
            },
            False,
        ),
        (
            {
                "client_order_id": "order-limit",
                "instrument_id": "ETHUSDT.SIM",
                "side": "BUY",
                "type": "LIMIT",
                "quantity": "1",
                "status": "SUBMITTED",
            },
            False,
        ),
    ],
)
def test_replay_submitted_price_is_type_aware(
    payload: dict[str, object],
    accepted: bool,
) -> None:
    fixture = replay_fixture()
    events = fixture["events"]
    assert isinstance(events, list)
    events[0]["type"] = "order.submitted"
    events[0]["payload"] = payload

    if accepted:
        projection = project_events(events)
        assert "price" not in projection[0]["normalized_payload"]
    else:
        with pytest.raises(ReplaySchemaError):
            project_events(events)


@pytest.mark.parametrize(
    ("event_type", "field", "value"),
    [
        ("order.submitted", "side", "HOLD"),
        ("order.submitted", "type", "STOP_LIMIT"),
        ("order.submitted", "status", "PENDING"),
        ("order.accepted", "status", "FILLED"),
        ("order.rejected", "status", "DENIED"),
        ("order.cancel_pending", "status", "CANCELED"),
        ("order.cancelled", "status", "PENDING_CANCEL"),
        ("position.opened", "side", "FLAT"),
        ("position.changed", "side", "FLAT"),
        ("position.closed", "side", "LONG"),
    ],
)
def test_replay_economic_value_domains_are_closed_per_event(
    event_type: str,
    field: str,
    value: str,
) -> None:
    payloads = {
        "order.submitted": {
            "client_order_id": "order-1",
            "instrument_id": "ETHUSDT.SIM",
            "side": "BUY",
            "type": "LIMIT",
            "quantity": "1",
            "price": "100",
            "status": "SUBMITTED",
        },
        "order.accepted": {
            "client_order_id": "order-1",
            "instrument_id": "ETHUSDT.SIM",
            "venue_order_id": "venue-1",
            "status": "ACCEPTED",
        },
        "order.rejected": {
            "client_order_id": "order-1",
            "instrument_id": "ETHUSDT.SIM",
            "reason": "POST_ONLY_WOULD_TAKE",
            "status": "REJECTED",
        },
        "order.cancel_pending": {
            "client_order_id": "order-1",
            "instrument_id": "ETHUSDT.SIM",
            "status": "PENDING_CANCEL",
        },
        "order.cancelled": {
            "client_order_id": "order-1",
            "instrument_id": "ETHUSDT.SIM",
            "status": "CANCELED",
        },
        "position.opened": {
            "position_id": "position-1",
            "instrument_id": "ETHUSDT.SIM",
            "side": "LONG",
            "quantity": "1",
            "price": "100",
            "client_order_id": "order-1",
        },
        "position.changed": {
            "position_id": "position-1",
            "instrument_id": "ETHUSDT.SIM",
            "side": "LONG",
            "quantity": "1",
            "price": "100",
            "client_order_id": "order-1",
        },
        "position.closed": {
            "position_id": "position-1",
            "instrument_id": "ETHUSDT.SIM",
            "side": "FLAT",
            "quantity": "0",
            "price": "100",
            "client_order_id": "order-1",
            "realized_pnl": "0 USDT",
        },
    }
    payload = {**payloads[event_type], field: value}
    fixture = replay_fixture()
    events = fixture["events"]
    assert isinstance(events, list)
    events[0]["type"] = event_type
    events[0]["payload"] = payload

    with pytest.raises(ReplaySchemaError):
        project_events(events)


@pytest.mark.parametrize(
    ("kind", "field", "value"),
    [
        ("orders", "side", 7),
        ("positions", "currency", 7),
        ("positions", "commission", {}),
    ],
)
def test_persisted_report_rows_use_the_same_closed_normalizer(
    kind: str, field: str, value: object
) -> None:
    fixture = replay_fixture()
    reports = fixture["reports"]
    assert isinstance(reports, dict)
    rows = reports[kind]
    assert isinstance(rows, list)
    if kind == "positions":
        event = _rc3_order_filled_event()
        event[field] = value
        rows[0]["events"] = [event]
    else:
        rows[0][field] = value

    with pytest.raises(ReplaySchemaError):
        replay_digest_v1(fixture)


@pytest.mark.parametrize("field", ["seq", "source_seq"])
def test_runner_event_sequence_fields_must_be_non_negative(field: str) -> None:
    fixture = replay_fixture()
    events = fixture["events"]
    assert isinstance(events, list)
    events[0][field] = -1

    with pytest.raises(ReplaySchemaError, match="non-negative"):
        replay_digest_v1(fixture)


def test_duplicate_runner_source_sequence_is_rejected() -> None:
    fixture = replay_fixture()
    events = fixture["events"]
    assert isinstance(events, list)
    events[1]["source_seq"] = 1

    with pytest.raises(ReplaySchemaError, match="duplicate source_seq"):
        replay_digest_v1(fixture)


def test_missing_report_primary_key_and_different_manifest_are_rejected() -> None:
    fixture = replay_fixture()
    reports = fixture["reports"]
    assert isinstance(reports, dict)
    orders = reports["orders"]
    assert isinstance(orders, list)
    orders[0].pop("client_order_id")

    with pytest.raises(ReplaySchemaError, match="missing field client_order_id"):
        replay_digest_v1(fixture)

    with pytest.raises(ReplaySchemaError, match="input_manifest_hash"):
        replay_digest_v1(replay_fixture(input_manifest_hash="not-a-sha256"))


def test_source_sequence_regression_and_unknown_event_type_are_rejected() -> None:
    regressing = replay_fixture()
    events = regressing["events"]
    assert isinstance(events, list)
    events[1]["source_seq"] = 0
    with pytest.raises(ReplaySchemaError, match="source_seq regression"):
        replay_digest_v1(regressing)

    unknown_type = replay_fixture()
    unknown_events = unknown_type["events"]
    assert isinstance(unknown_events, list)
    unknown_events[0]["type"] = "order.repriced"
    with pytest.raises(ReplaySchemaError, match="unknown event type"):
        replay_digest_v1(unknown_type)


def test_unknown_metric_is_rejected_by_static_report_projection() -> None:
    fixture = replay_fixture()
    reports = fixture["reports"]
    assert isinstance(reports, dict)
    metrics = reports["metrics"]
    assert isinstance(metrics, dict)
    stats_returns = metrics["stats_returns"]
    assert isinstance(stats_returns, dict)
    stats_returns["Unlisted Metric"] = "1"

    with pytest.raises(ReplaySchemaError, match="unknown metric"):
        replay_digest_v1(fixture)


def test_performance_series_remains_inside_the_economic_replay_digest() -> None:
    baseline = replay_fixture()
    metrics = baseline["reports"]["metrics"]
    assert isinstance(metrics, dict)
    metrics["performance_series"] = _performance_series()
    changed = deepcopy(baseline)
    changed_series = changed["reports"]["metrics"]["performance_series"]
    assert isinstance(changed_series, dict)
    changed_points = changed_series["points"]
    assert isinstance(changed_points, list)
    changed_points[1]["equity_amount"] = "80"
    changed_points[1]["drawdown_pct"] = "-20"

    assert replay_digest_v1(baseline) != replay_digest_v1(changed)


def test_performance_series_replay_ignores_hostile_ambient_decimal_context() -> None:
    fixture = replay_fixture()
    metrics = fixture["reports"]["metrics"]
    assert isinstance(metrics, dict)
    series = _performance_series()
    points = series["points"]
    assert isinstance(points, list)
    points[:] = [
        {**points[0], "equity_amount": "3", "drawdown_pct": "0"},
        {
            **points[1],
            "equity_amount": "2",
            "drawdown_pct": "-33.33333333333333333333333333333333",
        },
    ]
    metrics["performance_series"] = series
    baseline = replay_digest_v1(fixture)

    with localcontext() as ambient:
        ambient.prec = 2
        ambient.rounding = ROUND_DOWN
        ambient.Emin = 0
        ambient.Emax = 9
        ambient.capitals = 0
        ambient.clamp = 1
        ambient.traps[Inexact] = True
        ambient.traps[Underflow] = True
        hostile = replay_digest_v1(fixture)

    assert hostile == baseline


@pytest.mark.parametrize(
    "equity_amount",
    ["1" + ("0" * 1_000_000), "-1" + ("0" * 1_000_000)],
    ids=["huge-positive", "huge-negative"],
)
def test_replay_closes_equity_outside_native_money_domain(
    equity_amount: str,
) -> None:
    fixture = replay_fixture()
    metrics = fixture["reports"]["metrics"]
    assert isinstance(metrics, dict)
    series = _performance_series()
    points = series["points"]
    assert isinstance(points, list)
    points[1]["equity_amount"] = equity_amount
    points[1]["drawdown_pct"] = "0"
    del points[2:]
    metrics["performance_series"] = series

    with pytest.raises(ReplaySchemaError, match="native Money domain"):
        replay_digest_v1(fixture)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("equity_amount", "1e999999999", "canonical"),
        ("equity_amount", "1e-999999999", "canonical"),
        ("drawdown_pct", "0e999999999", "canonical"),
        ("drawdown_pct", "0e-999999999", "canonical"),
        ("equity_amount", "1.000000001", "native Money"),
        ("ts_event_ns", str(2**64), "native timestamp domain"),
        ("ts_event_ns", "9" * 5_000, "native timestamp domain"),
    ],
)
def test_replay_closes_performance_native_domain_before_runtime_conversion(
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    value: str,
    message: str,
) -> None:
    real_formatter = report_export_module.canonical_decimal_string

    def expansion_guard(candidate: Decimal) -> str:
        exponent = candidate.as_tuple().exponent
        if isinstance(exponent, int) and abs(exponent) > 1_000:
            raise AssertionError("exponent input reached fixed-point formatting")
        return real_formatter(candidate)

    monkeypatch.setattr(report_export_module, "canonical_decimal_string", expansion_guard)
    fixture = replay_fixture()
    metrics = fixture["reports"]["metrics"]
    assert isinstance(metrics, dict)
    series = _performance_series()
    points = series["points"]
    assert isinstance(points, list)
    first = points[0]
    assert isinstance(first, dict)
    first[field] = value
    if field == "equity_amount":
        first["drawdown_pct"] = "0"
    del points[1:]
    metrics["performance_series"] = series

    with pytest.raises(ReplaySchemaError, match=message):
        replay_digest_v1(fixture)


def test_control_lifecycle_and_declared_report_operational_ids_do_not_change_digest() -> None:
    baseline = replay_fixture()
    changed = replay_fixture()
    changed_events = changed["events"]
    assert isinstance(changed_events, list)
    changed_events.append(
        {
            "run_id": "bt_b",
            "event_id": "controller-event",
            "seq": 99,
            "source_seq": 99,
            "ts_event_ns": "99",
            "ts_ingest_ns": "100",
            "type": "run.completed",
            "source": "control-api",
            "writer": "control-api",
            "schema_version": 1,
            "payload": {},
        }
    )
    changed_reports = changed["reports"]
    assert isinstance(changed_reports, dict)
    changed_orders = changed_reports["orders"]
    assert isinstance(changed_orders, list)
    changed_orders[0]["init_id"] = "different-native-init-id"
    changed_fills = changed_reports["fills"]
    assert isinstance(changed_fills, list)
    changed_fills[0]["event_id"] = "different-fill-event"
    changed_fills[0]["causation_id"] = "different-causation"
    changed_positions = changed_reports["positions"]
    assert isinstance(changed_positions, list)
    position_events = changed_positions[0]["events"]
    assert isinstance(position_events, list)
    position_events[0]["event_id"] = "different-position-event"
    position_events[0]["fills"] = [{"event_id": "different-full-fill"}]

    assert replay_digest_v1(baseline) == replay_digest_v1(changed)


def test_canonical_control_payload_is_validated_then_excluded_from_digest() -> None:
    baseline = replay_fixture()
    changed = replay_fixture()
    events = changed["events"]
    assert isinstance(events, list)
    events.append(
        {
            "run_id": "bt_a",
            "event_id": "controller-event",
            "seq": 99,
            "source_seq": 99,
            "ts_event_ns": "99",
            "ts_ingest_ns": "100",
            "type": "run.completed",
            "source": "control-api",
            "writer": "control-api",
            "schema_version": 1,
            "payload": {"evidence": {"state": "written"}},
        }
    )

    assert replay_digest_v1(baseline) == replay_digest_v1(changed)


def test_control_payload_owned_schema_marker_is_canonical_but_not_a_production_root() -> None:
    fixture = replay_fixture()
    events = fixture["events"]
    assert isinstance(events, list)
    events.append(
        {
            "run_id": "bt_a",
            "event_id": "controller-event",
            "seq": 99,
            "source_seq": 99,
            "ts_event_ns": "99",
            "ts_ingest_ns": "100",
            "type": "run.completed",
            "source": "control-api",
            "writer": "control-api",
            "schema_version": 1,
            "payload": {"schema": "task-4-controller-state.v1"},
        }
    )

    assert len(replay_digest_v1(fixture)) == 64


def test_control_payload_rejects_noncanonical_runtime_values() -> None:
    fixture = replay_fixture()
    events = fixture["events"]
    assert isinstance(events, list)
    events.append(
        {
            "run_id": "bt_a",
            "event_id": "controller-event",
            "seq": 99,
            "source_seq": 99,
            "ts_event_ns": "99",
            "ts_ingest_ns": "100",
            "type": "run.completed",
            "source": "control-api",
            "writer": "control-api",
            "schema_version": 1,
            "payload": {"duration": 1.0},
        }
    )

    with pytest.raises(ReplaySchemaError, match="Binary float"):
        replay_digest_v1(fixture)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("writer", "runner", "writer"),
        ("schema_version", 2, "schema_version"),
        ("seq", "8", "seq"),
        ("payload", {}, "missing payload field"),
    ],
)
def test_replay_requires_a_complete_control_written_event_envelope(
    field: str, value: object, message: str
) -> None:
    fixture = replay_fixture()
    events = fixture["events"]
    assert isinstance(events, list)
    events[0][field] = value

    with pytest.raises(ReplaySchemaError, match=message):
        replay_digest_v1(fixture)


def test_replay_projects_the_full_rc3_order_filled_position_event() -> None:
    fixture = replay_fixture()
    reports = fixture["reports"]
    assert isinstance(reports, dict)
    positions = reports["positions"]
    assert isinstance(positions, list)
    positions[0]["events"] = [_rc3_order_filled_event()]

    assert len(replay_digest_v1(fixture)) == 64


def test_replay_rejects_duplicate_report_primary_keys() -> None:
    fixture = replay_fixture()
    reports = fixture["reports"]
    assert isinstance(reports, dict)
    orders = reports["orders"]
    assert isinstance(orders, list)
    orders.append(deepcopy(orders[0]))

    with pytest.raises(ReplaySchemaError, match="duplicate"):
        replay_digest_v1(fixture)


def test_fresh_rc3_exported_reports_replay_with_full_position_events(tmp_path) -> None:
    result = run_compat_probe(tmp_path)
    fixture = replay_fixture()
    reports = fixture["reports"]
    assert isinstance(reports, dict)
    reports["orders"] = export_dataframe_report("orders", result.orders)
    reports["fills"] = export_dataframe_report("fills", result.fills)
    reports["positions"] = export_dataframe_report("positions", result.positions)
    reports["account"] = export_dataframe_report("account", result.account)

    assert len(replay_digest_v1(fixture)) == 64


def _fill_report_row() -> dict[str, object]:
    return {
        "client_order_id": "order-1",
        "trader_id": "TRADER-001",
        "strategy_id": "probe",
        "instrument_id": "ETHUSDT.SIM",
        "venue_order_id": "venue-1",
        "account_id": "SIM-001",
        "trade_id": "trade-1",
        "order_side": "BUY",
        "order_type": "LIMIT",
        "last_qty": "2",
        "last_px": "100",
        "currency": "USDT",
        "liquidity_side": "TAKER",
        "event_id": "fill-event",
        "ts_event": "20",
        "ts_init": "20",
        "reconciliation": False,
        "info": {},
        "position_id": "position-1",
        "commission": "0 USDT",
        "causation_id": "cause-a",
    }


def _position_report_row() -> dict[str, object]:
    return {
        "position_id": "position-1",
        "type": "Position",
        "events": [_rc3_order_filled_event()],
        "adjustments": [],
        "trader_id": "TRADER-001",
        "strategy_id": "probe",
        "instrument_id": "ETHUSDT.SIM",
        "account_id": "SIM-001",
        "opening_order_id": "order-1",
        "closing_order_id": None,
        "entry": "BUY",
        "side": "LONG",
        "quantity": "2",
        "peak_qty": "2",
        "price_precision": 2,
        "size_precision": 3,
        "multiplier": "1",
        "is_inverse": False,
        "ts_init": "20",
        "ts_opened": "20",
        "ts_last": "20",
        "ts_closed": None,
        "duration_ns": "0",
        "avg_px_open": "100",
        "avg_px_close": None,
        "realized_return": "0",
        "realized_pnl": "0 USDT",
        "venue_order_ids": ["venue-1"],
        "trade_ids": ["trade-1"],
        "buy_qty": "2",
        "sell_qty": "0",
        "commissions": [],
        "is_snapshot": False,
    }


def _rc3_order_filled_event() -> dict[str, object]:
    return {
        "type": "OrderFilled",
        "trader_id": "TRADER-001",
        "strategy_id": "Rc3ProbeStrategy-000",
        "instrument_id": "ETH/USDT.SIM",
        "client_order_id": "Rc3ProbeStrategy-000-partial",
        "venue_order_id": "SIM-1-1",
        "account_id": "SIM-001",
        "trade_id": "T-probe-001",
        "order_side": "BUY",
        "order_type": "LIMIT",
        "last_qty": "5.000",
        "last_px": "100.00",
        "currency": "USDT",
        "liquidity_side": "TAKER",
        "event_id": "native-event",
        "ts_event": 1700000000000000000,
        "ts_init": 1700000000000000000,
        "reconciliation": False,
        "info": None,
        "position_id": "SIM-1-1",
        "commission": "0.00000000 USDT",
        "causation_id": None,
    }


def _summary(order_total: str) -> dict[str, str]:
    return {
        "orders.total": order_total,
        "orders.closed": order_total,
        "orders.inflight": "0",
        "orders.emulated": "0",
        "orders.open": "0",
        "positions.total": "1",
        "positions.total_with_snapshots": "1",
        "positions.open": "1",
        "positions.closed": "0",
        "positions.snapshots": "0",
        "total_events": "1",
        "iterations": "2",
        "venues.total": "1",
        "account.SIM.id": "SIM-001",
        "account.SIM.type": "MARGIN",
        "account.SIM.event_count": "1",
        "account.SIM.base_currency": "None",
        "account.SIM.balance.USDT.total": "1000000.00000000 USDT",
        "account.SIM.balance.USDT.locked": "0.00000000 USDT",
        "account.SIM.balance.USDT.free": "1000000.00000000 USDT",
    }
