from __future__ import annotations

import importlib
from dataclasses import FrozenInstanceError, dataclass, replace
from decimal import Decimal, localcontext
from hashlib import sha256
from typing import Any

import pytest
from pydantic import ValidationError

from stark_trading_os.agent.models import ExactValueRef
from stark_trading_os.audit.canonical_json import canonical_json_bytes, parse_json_object
from stark_trading_os.control.process_identity import (
    RunnerOutcomeRecord,
    SupervisorExitV1,
    supervisor_exit_bytes,
)
from stark_trading_os.control.recovery import ArtifactIntegrityError
from stark_trading_os.control.registry import (
    AuditIntent,
    CatalogPublication,
    PersistedEvent,
    RunEvidenceSnapshot,
    RunNotFound,
    RunSnapshot,
    TerminalPublication,
)
from stark_trading_os.domain.models import EventEnvelopeV1, InputManifestV1, RunRecordV1, RunState
from stark_trading_os.runner.protocol import RunnerOutcomeV1, RunnerReportCandidateV1
from stark_trading_os.runner.report_export import export_metrics, normalize_report_row


def _scope_module() -> Any:
    return importlib.import_module("stark_trading_os.agent.evidence_scope")


@dataclass
class _Fixture:
    snapshot: RunEvidenceSnapshot
    artifacts: tuple[bytes | None, ...]


class _MemoryStore:
    def __init__(self, fixtures: dict[str, _Fixture]) -> None:
        self.fixtures = fixtures
        self.calls: list[str] = []

    def run_evidence_snapshot(self, run_id: str) -> RunEvidenceSnapshot:
        self.calls.append(run_id)
        try:
            return self.fixtures[run_id].snapshot
        except KeyError as error:
            raise RunNotFound(run_id) from error


class _MemoryRecovery:
    def __init__(self, fixtures: dict[str, _Fixture]) -> None:
        self.fixtures = fixtures
        self.calls: list[tuple[TerminalPublication, tuple[str, ...]]] = []
        self.error: Exception | None = None

    def read_artifacts(
        self,
        *,
        publication: TerminalPublication,
        relative_paths: tuple[str, ...],
    ) -> tuple[bytes | None, ...]:
        self.calls.append((publication, relative_paths))
        if self.error is not None:
            raise self.error
        return self.fixtures[publication.run_id].artifacts


def _input_manifest_bytes() -> bytes:
    costs = {
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
    config = {
        "entry_limit_price": "100",
        "entry_quantity": "1",
        "metric_round_trip_quantity": "1",
        "metric_round_trips": 1,
        "risk_probe_quantity": "1",
        "venue_rejection_quantity": "1",
    }
    risk = {"max_notional": "1000"}
    manifest = InputManifestV1.model_validate(
        {
            "schema": "InputManifest.v1",
            "environment": "BACKTEST",
            "strategy_id": "determinism-probe",
            "strategy_version": "v1",
            "canonical_config": config,
            "config_hash": sha256(canonical_json_bytes(config)).hexdigest(),
            "engine_package_version": "2.0.0rc3",
            "engine_tag_commit": "648970ce64a304d93da0a29320cb6e19b905fa39",
            "python_version": "3.12.4",
            "precision_mode": "FIXED_PRECISION_16",
            "fixture_id": "local-qa-v1",
            "catalog_revision": "a" * 64,
            "source_checksum": "b" * 64,
            "catalog_checksum": "c" * 64,
            "instruments": [
                {
                    "instrument_id": "ETHUSDT.SIM",
                    "price_increment": "0.01",
                    "quantity_increment": "0.001",
                }
            ],
            "data_types": ["instruments", "quotes"],
            "window": {"start_ns": "10", "end_ns": "20"},
            "timezone": "UTC",
            "gaps": [],
            "duplicates": [],
            "ordering_result": "PASS",
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
            "cost_fill_model": costs,
            "risk_policy_id": "probe-risk",
            "risk_policy_version": "v1",
            "canonical_risk_policy": risk,
            "risk_policy_hash": sha256(canonical_json_bytes(risk)).hexdigest(),
            "replay_seed": 7,
        }
    )
    return canonical_json_bytes(manifest.model_dump(mode="json", by_alias=True))


def _order_row(order_id: str, *, padding: str = "") -> dict[str, object]:
    row = {
        "client_order_id": order_id,
        "trader_id": padding or "TRADER-001",
        "strategy_id": "probe",
        "instrument_id": "ETHUSDT.SIM",
        "side": "BUY",
        "type": "LIMIT",
        "quantity": "1",
        "price": "100",
        "status": "FILLED",
        "time_in_force": "GTC",
        "expire_time_ns": None,
        "is_post_only": False,
        "is_reduce_only": False,
        "is_quote_quantity": False,
        "filled_qty": "1",
        "init_id": "init-1",
        "ts_init": "1",
        "ts_last": "2",
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
    return normalize_report_row("orders", row)


def _fill_row(*, padding: str = "") -> dict[str, object]:
    return normalize_report_row(
        "fills",
        {
            "client_order_id": "order-1",
            "trader_id": padding or "TRADER-001",
            "strategy_id": "probe",
            "instrument_id": "ETHUSDT.SIM",
            "venue_order_id": "venue-1",
            "account_id": "SIM-001",
            "trade_id": "trade-1",
            "order_side": "BUY",
            "order_type": "LIMIT",
            "last_qty": "1",
            "last_px": "100",
            "currency": "USDT",
            "liquidity_side": "TAKER",
            "event_id": "native-event",
            "ts_event": "2",
            "ts_init": "2",
            "reconciliation": False,
            "info": {},
            "position_id": "position-1",
            "commission": "0 USDT",
            "causation_id": "cause-1",
        },
    )


def _position_row(*, padding: str = "") -> dict[str, object]:
    return normalize_report_row(
        "positions",
        {
            "position_id": "position-1",
            "type": "Position",
            "events": [],
            "adjustments": [],
            "trader_id": padding or "TRADER-001",
            "strategy_id": "probe",
            "instrument_id": "ETHUSDT.SIM",
            "account_id": "SIM-001",
            "opening_order_id": "order-1",
            "closing_order_id": "order-2",
            "entry": "BUY",
            "side": "FLAT",
            "quantity": "0",
            "peak_qty": "1",
            "price_precision": 2,
            "size_precision": 3,
            "multiplier": "1",
            "is_inverse": False,
            "ts_init": "1",
            "ts_opened": "1",
            "ts_last": "3",
            "ts_closed": "3",
            "duration_ns": "2",
            "avg_px_open": "100",
            "avg_px_close": "101",
            "realized_return": "0.01",
            "realized_pnl": "1 USDT",
            "venue_order_ids": ["venue-1"],
            "trade_ids": ["trade-1"],
            "buy_qty": "1",
            "sell_qty": "1",
            "commissions": [],
            "is_snapshot": False,
        },
    )


def _account_row(*, padding: str = "") -> dict[str, object]:
    return normalize_report_row(
        "account",
        {
            "ts_event_ns": "3",
            "total": "101",
            "locked": "0",
            "free": "101",
            "currency": "USDT",
            "account_id": padding or "SIM-001",
            "account_type": "MARGIN",
            "margins": [],
            "reported": True,
            "info": {},
            "base_currency": None,
        },
    )


def _metrics_bytes(
    *,
    order_count: int,
    end_equity: str,
    currency: str,
    padding: str = "",
) -> bytes:
    summary = {
        "orders.total": str(order_count),
        "orders.closed": str(order_count),
        "orders.inflight": "0",
        "orders.emulated": "0",
        "orders.open": "0",
        "positions.total": "1",
        "positions.total_with_snapshots": "1",
        "positions.open": "0",
        "positions.closed": "1",
        "positions.snapshots": "0",
        "total_events": "1",
        "iterations": "2",
        "venues.total": "1",
        "account.SIM.id": "SIM-001",
        "account.SIM.type": "MARGIN",
        "account.SIM.event_count": "1",
        "account.SIM.base_currency": currency,
        f"account.SIM.balance.{currency}.total": f"{end_equity} {currency}",
        f"account.SIM.balance.{currency}.locked": f"0 {currency}",
        f"account.SIM.balance.{currency}.free": f"{end_equity} {currency}",
    }
    stats_pnls = {
        padding or currency: {
            "Max Winner": 0.0,
            "Win Rate": 0.0,
            "PnL% (total)": 0.0,
            "Min Winner": 0.0,
            "PnL (total)": 0.0,
            "Avg Winner": 0.0,
            "Expectancy": 0.0,
            "Avg Loser": 0.0,
            "Min Loser": 0.0,
            "Max Loser": 0.0,
        }
    }
    zero_returns = {
        name: 0.0
        for name in (
            "Sortino Ratio (252 days)",
            "Tail Ratio",
            "Average Loss (Return)",
            "Average (Return)",
            "Sharpe Ratio (252 days)",
            "Average Win (Return)",
            "Returns Kurtosis",
            "Profit Factor",
            "Returns Volatility (252 days)",
            "Risk Return Ratio",
            "Returns Skewness",
        )
    }
    performance = {
        "schema": "PortfolioEquitySeries.v1",
        "source": "NAUTILUS_PORTFOLIO_SNAPSHOTS",
        "selection": "SOLE_TOTAL_EQUITY",
        "calculation": "RUNNING_PEAK_DRAWDOWN_PERCENT_V1",
        "timestamp_unit": "UNIX_EPOCH_NS",
        "equity_unit": "ACCOUNT_CURRENCY",
        "drawdown_unit": "PERCENT",
        "account_id": "SIM-001",
        "currency": currency,
        "points": [
            {
                "point_index": 0,
                "ts_event_ns": "10",
                "equity_amount": "100",
                "drawdown_pct": "0",
                "is_stale": False,
                "stale_instruments": [],
                "stale_currencies": [],
                "unpriced_instruments": [],
            },
            {
                "point_index": 1,
                "ts_event_ns": "20",
                "equity_amount": end_equity,
                "drawdown_pct": "0" if Decimal(end_equity) >= 100 else "-10",
                "is_stale": False,
                "stale_instruments": [],
                "stale_currencies": [],
                "unpriced_instruments": [],
            },
        ],
    }
    normalized = export_metrics(
        {
            "summary": summary,
            "stats_pnls": stats_pnls,
            "stats_returns": zero_returns,
            "stats_general": {},
            "performance_series": performance,
        }
    )
    return canonical_json_bytes(normalized)


def _fixture(
    run_id: str,
    *,
    end_equity: str = "110",
    currency: str = "USDT",
    state: RunState = RunState.COMPLETED,
    order_rows: list[dict[str, object]] | None = None,
    metrics_raw: bytes | None = None,
    oversized: bool = False,
    event_payload: dict[str, object] | None = None,
    event_time_ns: str = "20",
    ingest_time_ns: str = "21",
) -> _Fixture:
    padding = "x" * 2_097_300 if oversized else ""
    manifest_bytes = _input_manifest_bytes()
    orders = [_order_row("order-0001", padding=padding)] if order_rows is None else order_rows
    report_values: dict[str, object] = {
        "orders": orders,
        "fills": [_fill_row(padding=padding)],
        "positions": [_position_row(padding=padding)],
        "account": [_account_row(padding=padding)],
    }
    report_bytes = {name: canonical_json_bytes(value) for name, value in report_values.items()}
    report_bytes["metrics"] = (
        _metrics_bytes(
            order_count=len(orders),
            end_equity=end_equity,
            currency=currency,
            padding=padding,
        )
        if metrics_raw is None
        else metrics_raw
    )
    report_names = ("orders", "fills", "positions", "account", "metrics")
    report_count = (
        len(report_names)
        if state is RunState.COMPLETED
        else 0
        if state is RunState.CANCELLED
        else 1
    )
    candidates = tuple(
        RunnerReportCandidateV1(
            name=name,
            relative_path=f"reports/{name}.json",
            sha256=sha256(report_bytes[name]).hexdigest(),
            size_bytes=len(report_bytes[name]),
        )
        for name in report_names[:report_count]
    )
    child = (
        None
        if state is RunState.CANCELLED
        else RunnerOutcomeV1.model_validate(
            {
                "schema": "RunnerOutcome.v1",
                "run_id": run_id,
                "input_manifest_hash": sha256(manifest_bytes).hexdigest(),
                "catalog_revision": "a" * 64,
                "engine_package_version": "2.0.0rc3",
                "result": "SUCCEEDED" if state is RunState.COMPLETED else "FAILED",
                "last_source_seq": 0,
                "report_candidates": [
                    item.model_dump(mode="json", by_alias=True) for item in candidates
                ],
                "failure": (
                    None
                    if state is RunState.COMPLETED
                    else {"code": "RUNNER_EXECUTION_FAILED", "message": "expected failure"}
                ),
            }
        )
    )
    supervisor = SupervisorExitV1(
        run_id=run_id,
        spawn_nonce=None if state is RunState.CANCELLED else "spawn-1",
        process_identity_sha256=None if state is RunState.CANCELLED else "d" * 64,
        launched_at_ns=None if state is RunState.CANCELLED else 10,
        ended_at_ns=20,
        duration_ns=0 if state is RunState.CANCELLED else 10,
        exit_code=(
            0 if state is RunState.COMPLETED else None if state is RunState.CANCELLED else 1
        ),
        signal=None,
        final_cancel_phase="NONE",
        stdout_size_bytes=1,
        stderr_size_bytes=0,
        stderr_sha256=sha256(b"").hexdigest(),
        stderr_truncated=False,
        child_outcome=child,
        classification=(
            "NATURAL_SUCCESS"
            if state is RunState.COMPLETED
            else "NO_SPAWN_CANCELLED"
            if state is RunState.CANCELLED
            else "NATURAL_FAILURE"
        ),
        failure_code=("CHILD_REPORTED_FAILURE" if state is RunState.FAILED else None),
        proposed_terminal_state=state.value,
    )
    supervisor_bytes = supervisor_exit_bytes(supervisor)
    event = EventEnvelopeV1.model_validate(
        {
            "event_id": f"event-{run_id}",
            "run_id": run_id,
            "seq": 1,
            "source_seq": 1,
            "ts_event_ns": event_time_ns,
            "ts_ingest_ns": ingest_time_ns,
            "type": f"run.{state.value.lower()}",
            "source": "control-api",
            "writer": "control-api",
            "schema_version": 1,
            "payload": ({"note": padding or "sealed"} if event_payload is None else event_payload),
        }
    )
    event_bytes = canonical_json_bytes(event.model_dump(mode="json", by_alias=True))
    persisted_event = PersistedEvent(
        event_id=event.event_id,
        run_id=run_id,
        seq=1,
        source_seq=1,
        source="control-api",
        type=event.type,
        ts_event_ns=event_time_ns,
        ts_ingest_ns=ingest_time_ns,
        visible=True,
        envelope_bytes=event_bytes,
    )
    run_record = RunRecordV1.model_validate(
        {
            "schema": "RunRecord.v1",
            "run_id": run_id,
            "preflight_id": f"pf-{run_id}",
            "idempotency_scope": "backtest.create",
            "idempotency_key": f"create-{run_id}",
            "state": state,
            "state_version": 5,
            "prepared_terminal_state": state,
            "prepared_terminal_state_version": 5,
            "created_at_ns": "1",
            "started_at_ns": "10",
            "completed_at_ns": "20",
            "duration_ns": "10",
            "runner_identity": None,
            "runner_exit": supervisor.model_dump(mode="json", by_alias=True),
            "materialized_event_seq": 1,
            "materialized_audit_seq": 1,
            "evidence_status": "VERIFIED",
        }
    )
    run_record_bytes = canonical_json_bytes(run_record.model_dump(mode="json", by_alias=True))
    audit_intent = AuditIntent(
        run_id=run_id,
        audit_seq=1,
        event_seq=1,
        event_digest=sha256(event_bytes).hexdigest(),
        intent_bytes=canonical_json_bytes({"event_seq": 1, "run_id": run_id}),
        created_at_ns=21,
    )
    publication = TerminalPublication(
        run_id=run_id,
        state=state,
        state_version=5,
        event=persisted_event,
        audit_intent=audit_intent,
        seal_digest="e" * 64,
        published_at_ns=22,
        materialized_event_seq=1,
        materialized_audit_seq=1,
    )
    run = RunSnapshot(
        run_id=run_id,
        state=state,
        state_version=5,
        last_event_seq=1,
        last_audit_seq=1,
        input_manifest_bytes=manifest_bytes,
        input_manifest_hash=sha256(manifest_bytes).hexdigest(),
        catalog_revision="a" * 64,
        catalog_inventory_hash="f" * 64,
        created_at_ns=1,
        evidence_status="VERIFIED",
    )
    catalog = CatalogPublication(
        catalog_revision="a" * 64,
        fixture_id="local-qa-v1",
        status="PUBLISHED",
        inventory_hash="f" * 64,
        publication_bytes=canonical_json_bytes({"catalog": "local-qa-v1"}),
        staging_identity="catalog-staging",
        prepared_at_ns=1,
        published_at_ns=2,
        audit_intent_bytes=canonical_json_bytes({"catalog": "published"}),
    )
    outcome_record = RunnerOutcomeRecord(
        run_id=run_id,
        outcome=supervisor,
        outcome_bytes=supervisor_bytes,
        outcome_hash=sha256(supervisor_bytes).hexdigest(),
        recorded_at_ns=21,
    )
    snapshot = RunEvidenceSnapshot(
        run=run,
        last_visible_seq=1,
        events=(persisted_event,),
        catalog_publication=catalog,
        runner_outcome=outcome_record,
        terminal_preparation=None,
        terminal_finalization=publication,
    )
    raw_reports: list[bytes | None] = [
        report_bytes[name] if index < report_count else None
        for index, name in enumerate(report_names)
    ]
    artifacts = (
        manifest_bytes,
        run_record_bytes,
        event_bytes + b"\n",
        supervisor_bytes,
        *raw_reports,
    )
    return _Fixture(snapshot=snapshot, artifacts=artifacts)


def _with_closed_maximum_projected_events(fixture: _Fixture, *, run_id: str) -> _Fixture:
    event_types = (
        "preflight.passed",
        "preflight.blocked",
        "run.queued",
        "run.started",
        "run.cancel_requested",
        "run.cancel_pending",
        "run.finalizing",
        "report.generated",
        "run.failed",
        "run.cancelled",
        "run.progress",
        "order.submitted",
        "order.accepted",
        "order.rejected",
        "order.partially_filled",
        "order.filled",
        "order.cancel_pending",
        "order.cancelled",
        "position.opened",
        "position.changed",
        "position.closed",
        "risk.rejected",
        "run.completed",
    )
    events: list[PersistedEvent] = []
    for event_type in event_types:
        for occurrence in range(2):
            seq = len(events) + 1
            envelope = EventEnvelopeV1.model_validate(
                {
                    "event_id": f"event-{seq:02d}",
                    "run_id": run_id,
                    "seq": seq,
                    "source_seq": seq,
                    "ts_event_ns": str(seq),
                    "ts_ingest_ns": str(seq),
                    "type": event_type,
                    "source": "control-api",
                    "writer": "control-api",
                    "schema_version": 1,
                    "payload": {"occurrence": occurrence},
                }
            )
            envelope_bytes = canonical_json_bytes(envelope.model_dump(mode="json", by_alias=True))
            events.append(
                PersistedEvent(
                    event_id=envelope.event_id,
                    run_id=envelope.run_id,
                    seq=seq,
                    source_seq=seq,
                    source=envelope.source,
                    type=envelope.type,
                    ts_event_ns=envelope.ts_event_ns,
                    ts_ingest_ns=envelope.ts_ingest_ns,
                    visible=True,
                    envelope_bytes=envelope_bytes,
                )
            )

    terminal_event = events[-1]
    publication = fixture.snapshot.terminal_finalization
    assert isinstance(publication, TerminalPublication)
    audit_intent = replace(
        publication.audit_intent,
        event_seq=terminal_event.seq,
        event_digest=sha256(terminal_event.envelope_bytes).hexdigest(),
    )
    updated_publication = replace(
        publication,
        event=terminal_event,
        audit_intent=audit_intent,
        materialized_event_seq=terminal_event.seq,
    )
    snapshot = replace(
        fixture.snapshot,
        run=replace(fixture.snapshot.run, last_event_seq=terminal_event.seq),
        last_visible_seq=terminal_event.seq,
        events=tuple(events),
        terminal_finalization=updated_publication,
    )
    run_record_raw = fixture.artifacts[1]
    assert isinstance(run_record_raw, bytes)
    run_record = RunRecordV1.model_validate(parse_json_object(run_record_raw))
    updated_run_record = RunRecordV1.model_validate(
        {
            **run_record.model_dump(mode="json", by_alias=True),
            "materialized_event_seq": terminal_event.seq,
        }
    )
    artifacts = list(fixture.artifacts)
    artifacts[1] = canonical_json_bytes(updated_run_record.model_dump(mode="json", by_alias=True))
    artifacts[2] = b"".join(event.envelope_bytes + b"\n" for event in events)
    return _Fixture(snapshot=snapshot, artifacts=tuple(artifacts))


def _launch_failed_fixture(run_id: str) -> _Fixture:
    fixture = _fixture(run_id, state=RunState.FAILED)
    runner_exit = SupervisorExitV1(
        run_id=run_id,
        spawn_nonce="spawn-1",
        process_identity_sha256=None,
        launched_at_ns=None,
        ended_at_ns=20,
        duration_ns=0,
        exit_code=None,
        signal=None,
        final_cancel_phase="NONE",
        stdout_size_bytes=0,
        stderr_size_bytes=0,
        stderr_sha256=sha256(b"").hexdigest(),
        stderr_truncated=False,
        child_outcome=None,
        classification="SUPERVISOR_FAILURE",
        failure_code="LAUNCH_FAILED",
        proposed_terminal_state="FAILED",
    )
    runner_exit_raw = supervisor_exit_bytes(runner_exit)
    run_record_raw = fixture.artifacts[1]
    assert isinstance(run_record_raw, bytes)
    run_record = RunRecordV1.model_validate(parse_json_object(run_record_raw))
    updated_run_record = RunRecordV1.model_validate(
        {
            **run_record.model_dump(mode="json", by_alias=True),
            "runner_exit": runner_exit.model_dump(mode="json", by_alias=True),
        }
    )
    outcome_record = RunnerOutcomeRecord(
        run_id=run_id,
        outcome=runner_exit,
        outcome_bytes=runner_exit_raw,
        outcome_hash=sha256(runner_exit_raw).hexdigest(),
        recorded_at_ns=21,
    )
    snapshot = replace(fixture.snapshot, runner_outcome=outcome_record)
    artifacts = (
        fixture.artifacts[0],
        canonical_json_bytes(updated_run_record.model_dump(mode="json", by_alias=True)),
        fixture.artifacts[2],
        runner_exit_raw,
        None,
        None,
        None,
        None,
        None,
    )
    return _Fixture(snapshot=snapshot, artifacts=artifacts)


def _build(
    fixtures: dict[str, _Fixture],
    *,
    primary: str,
    compare: str | None = None,
) -> tuple[Any, _MemoryStore, _MemoryRecovery]:
    module = _scope_module()
    store = _MemoryStore(fixtures)
    recovery = _MemoryRecovery(fixtures)
    builder = module.EvidenceScopeBuilder(store=store, recovery=recovery)
    return builder.build(primary, compare), store, recovery


def _source(scope: Any, role: str, kind: str) -> Any:
    run = next(item for item in scope.manifest.runs if item.role == role)
    return next(item for item in run.sources if item.source_kind == kind)


def _value(scope: Any, role: str, semantic: str) -> ExactValueRef:
    return next(
        item for item in scope.value_refs if item.run_role == role and item.semantic == semantic
    )


def test_builder_uses_exact_snapshot_publication_and_private_inventory() -> None:
    module = _scope_module()
    primary = _fixture("bt_primary")
    compare = _fixture("bt_compare", end_equity="220")
    fixtures = {"bt_primary": primary, "bt_compare": compare}

    scope, store, recovery = _build(fixtures, primary="bt_primary", compare="bt_compare")
    rebuilt, _, _ = _build(fixtures, primary="bt_primary", compare="bt_compare")

    assert module.PRIVATE_ARTIFACT_PATHS == (
        "input-manifest.json",
        "run-record.json",
        "events.ndjson",
        "runner-exit.json",
        "reports/orders.json",
        "reports/fills.json",
        "reports/positions.json",
        "reports/account.json",
        "reports/metrics.json",
    )
    assert store.calls == ["bt_primary", "bt_compare"]
    assert len(recovery.calls) == 2
    assert recovery.calls[0][0] is primary.snapshot.terminal_finalization
    assert recovery.calls[1][0] is compare.snapshot.terminal_finalization
    assert all(call[1] == module.PRIVATE_ARTIFACT_PATHS for call in recovery.calls)
    assert tuple(run.role for run in scope.manifest.runs) == ("PRIMARY", "COMPARE")
    assert scope == rebuilt
    assert scope.canonical_bytes() == rebuilt.canonical_bytes()
    assert b"bt_primary" not in scope.canonical_bytes()
    assert b"reports/" not in scope.canonical_bytes()
    assert len(scope.artifact_ids) == 18
    assert len(scope.event_ids) <= 92
    assert len(scope.statement_options) <= 256
    assert len(scope.value_refs) <= 256
    assert len(scope.citations) <= 128


def test_scope_is_deeply_immutable_and_reads_only_retained_memory() -> None:
    primary = _fixture("bt_immutable")
    fixtures = {"bt_immutable": primary}
    scope, store, recovery = _build(fixtures, primary="bt_immutable")
    artifact_id = scope.artifact_ids[0]
    event_id = scope.event_ids[0]
    artifact_before = scope.read_artifact(artifact_id)
    event_before = scope.read_event(event_id)
    calls_before = (tuple(store.calls), tuple(recovery.calls))

    fixtures["bt_immutable"] = replace(primary, artifacts=(None,) * 9)

    assert scope.read_artifact(artifact_id) == artifact_before
    assert scope.read_event(event_id) == event_before
    assert (tuple(store.calls), tuple(recovery.calls)) == calls_before
    with pytest.raises((FrozenInstanceError, ValidationError)):
        scope.manifest.runs[0].state_version = 99
    with pytest.raises(FrozenInstanceError):
        scope._artifact_records = ()
    with pytest.raises(TypeError, match="immutable tuple"):
        replace(scope, citations=list(scope.citations))
    field_names = set(scope.__dataclass_fields__)
    assert not field_names & {
        "store",
        "recovery",
        "path",
        "environment",
        "process",
        "scheduler",
        "cancellation",
    }
    assert all(
        isinstance(value, tuple)
        for value in (
            scope.citations,
            scope.value_refs,
            scope.statement_options,
            scope.notices,
            scope.allowed_ratio_pairs,
            scope._artifact_records,
            scope._event_records,
        )
    )


@pytest.mark.parametrize(
    "hostile_identifier",
    [
        "reports/orders.json",
        "../run-record.json",
        "https://example.invalid/evidence",
        "/events/0",
        "offset=0&limit=10",
        "art_" + "A" * 64,
    ],
)
def test_scope_rejects_raw_path_url_pointer_and_offset_lookups(
    hostile_identifier: str,
) -> None:
    module = _scope_module()
    scope, _, _ = _build({"bt_lookup": _fixture("bt_lookup")}, primary="bt_lookup")

    with pytest.raises(module.ScopeLookupError):
        scope.read_artifact(hostile_identifier)
    with pytest.raises(module.ScopeLookupError):
        scope.read_event(hostile_identifier)


def test_scope_rejects_unknown_unsealed_cross_scope_and_integrity_drift() -> None:
    module = _scope_module()
    primary = _fixture("bt_guard")
    fixtures = {"bt_guard": primary}
    store = _MemoryStore(fixtures)
    recovery = _MemoryRecovery(fixtures)
    builder = module.EvidenceScopeBuilder(store=store, recovery=recovery)

    with pytest.raises(RunNotFound):
        builder.build("bt_unknown")

    unsealed = replace(primary.snapshot, terminal_finalization=None)
    fixtures["bt_guard"] = replace(primary, snapshot=unsealed)
    with pytest.raises(module.RunEvidenceUnsealed):
        builder.build("bt_guard")

    fixtures["bt_guard"] = primary
    recovery.error = ArtifactIntegrityError("seal.json")
    with pytest.raises(module.RunEvidenceIntegrityFailed):
        builder.build("bt_guard")

    recovery.error = None
    scope = builder.build("bt_guard")
    other_fixture = _fixture("bt_guard", end_equity="111")
    other_scope, _, _ = _build({"bt_guard": other_fixture}, primary="bt_guard")
    with pytest.raises(module.ScopeLookupError):
        scope.read_artifact(other_scope.artifact_ids[0])


def test_builder_requires_exact_event_bytes_and_valid_committed_schemas() -> None:
    module = _scope_module()
    primary = _fixture("bt_exact")
    fixtures = {"bt_exact": primary}
    store = _MemoryStore(fixtures)
    recovery = _MemoryRecovery(fixtures)
    builder = module.EvidenceScopeBuilder(store=store, recovery=recovery)

    tampered = list(primary.artifacts)
    assert isinstance(tampered[2], bytes)
    tampered[2] += b"\n"
    fixtures["bt_exact"] = replace(primary, artifacts=tuple(tampered))
    with pytest.raises(module.RunEvidenceIntegrityFailed):
        builder.build("bt_exact")

    missing_required = list(primary.artifacts)
    missing_required[8] = None
    fixtures["bt_exact"] = replace(primary, artifacts=tuple(missing_required))
    with pytest.raises(module.RunEvidenceIntegrityFailed):
        builder.build("bt_exact")

    malformed = list(primary.artifacts)
    malformed[4] = canonical_json_bytes({"not": "a report array"})
    fixtures["bt_exact"] = replace(primary, artifacts=tuple(malformed))
    with pytest.raises(module.RunEvidenceIntegrityFailed):
        builder.build("bt_exact")

    malformed_exit = list(primary.artifacts)
    assert isinstance(malformed_exit[3], bytes)
    malformed_exit[3] += b" "
    fixtures["bt_exact"] = replace(primary, artifacts=tuple(malformed_exit))
    with pytest.raises(module.RunEvidenceIntegrityFailed):
        builder.build("bt_exact")


def test_event_projection_accepts_nested_frozen_json_arrays_without_retaining_handles() -> None:
    scope, _, _ = _build(
        {
            "bt_nested_event": _fixture(
                "bt_nested_event",
                event_payload={"items": [{"value": "sealed"}]},
            )
        },
        primary="bt_nested_event",
    )

    envelope = parse_json_object(scope.read_event(scope.event_ids[0]))
    projection = envelope["projection"]
    assert isinstance(projection, dict)
    assert projection["payload"]


def test_large_nested_event_projection_falls_back_to_full_payload_digest() -> None:
    payload = {f"field-{index:02d}": [{"value": "x" * 500}] for index in range(32)}
    scope, _, _ = _build(
        {
            "bt_nested_digest": _fixture(
                "bt_nested_digest",
                event_payload=payload,
            )
        },
        primary="bt_nested_digest",
    )

    envelope = parse_json_object(scope.read_event(scope.event_ids[0]))
    projection = envelope["projection"]
    assert isinstance(projection, dict)
    projected_payload = projection["payload"]
    assert isinstance(projected_payload, dict)
    assert projected_payload["kind"] == "DIGEST_ONLY"
    assert projected_payload["utf8_bytes"] == len(canonical_json_bytes(payload))


def test_owner_valid_long_event_timestamps_are_bounded_without_losing_raw_identity() -> None:
    event_time_ns = "1" + ("0" * 3_799)
    ingest_time_ns = "2" + ("0" * 3_799)
    fixture = _fixture(
        "bt_long_event_time",
        event_time_ns=event_time_ns,
        ingest_time_ns=ingest_time_ns,
    )

    scope, _, _ = _build({"bt_long_event_time": fixture}, primary="bt_long_event_time")

    events_source = _source(scope, "PRIMARY", "EVENTS")
    events_raw = fixture.artifacts[2]
    assert isinstance(events_raw, bytes)
    assert events_source.raw_sha256 == sha256(events_raw).hexdigest()
    aggregate_envelope = parse_json_object(scope.read_artifact(events_source.artifact_id))
    aggregate_projection = aggregate_envelope["projection"]
    assert isinstance(aggregate_projection, dict)
    aggregate_content = aggregate_projection["content"]
    assert isinstance(aggregate_content, dict)
    event_range = aggregate_content["event_time_range_ns"]
    assert isinstance(event_range, dict)
    assert (
        event_range["first"]
        == event_range["last"]
        == {
            "kind": "DIGEST_ONLY",
            "utf8_bytes": len(event_time_ns),
            "sha256": sha256(event_time_ns.encode()).hexdigest(),
        }
    )

    event_envelope = parse_json_object(scope.read_event(scope.event_ids[0]))
    event_projection = event_envelope["projection"]
    assert isinstance(event_projection, dict)
    assert event_projection["event_time_ns"] == event_range["first"]
    assert event_projection["ingest_time_ns"] == {
        "kind": "DIGEST_ONLY",
        "utf8_bytes": len(ingest_time_ns),
        "sha256": sha256(ingest_time_ns.encode()).hexdigest(),
    }
    assert event_projection["envelope_sha256"] == sha256(events_raw[:-1]).hexdigest()
    assert len(canonical_json_bytes(event_projection)) <= 4_096


def test_scope_id_binds_full_authority_and_unsampled_raw_digests() -> None:
    rows = [_order_row(f"order-{index:04d}") for index in range(10)]
    baseline = _fixture("bt_bound", order_rows=rows)
    mutated_rows = list(rows)
    mutated_rows[5] = _order_row("order-0005", padding="unsampled mutation")
    mutated = _fixture("bt_bound", order_rows=mutated_rows)
    baseline_scope, _, _ = _build({"bt_bound": baseline}, primary="bt_bound")
    mutated_scope, _, _ = _build({"bt_bound": mutated}, primary="bt_bound")

    baseline_orders = _source(baseline_scope, "PRIMARY", "ORDERS")
    mutated_orders = _source(mutated_scope, "PRIMARY", "ORDERS")
    assert baseline_orders.projection_sha256 == mutated_orders.projection_sha256
    assert baseline_orders.raw_sha256 != mutated_orders.raw_sha256
    assert baseline_scope.scope_id != mutated_scope.scope_id

    publication = baseline.snapshot.terminal_finalization
    assert isinstance(publication, TerminalPublication)
    changed_publication = replace(publication, published_at_ns=publication.published_at_ns + 1)
    changed_snapshot = replace(
        baseline.snapshot,
        terminal_finalization=changed_publication,
    )
    authority_scope, _, _ = _build(
        {"bt_bound": replace(baseline, snapshot=changed_snapshot)},
        primary="bt_bound",
    )
    assert authority_scope.scope_id != baseline_scope.scope_id

    invalid_run_authority = replace(
        baseline.snapshot,
        run=replace(baseline.snapshot.run, created_at_ns=2),
    )
    with pytest.raises(_scope_module().RunEvidenceIntegrityFailed):
        _build(
            {"bt_bound": replace(baseline, snapshot=invalid_run_authority)},
            primary="bt_bound",
        )


def test_present_empty_report_is_zero_while_missing_report_is_a_notice() -> None:
    empty = _fixture("bt_empty", order_rows=[])
    missing = _fixture("bt_missing", state=RunState.FAILED, order_rows=[])
    empty_scope, _, _ = _build({"bt_empty": empty}, primary="bt_empty")
    missing_scope, _, _ = _build({"bt_missing": missing}, primary="bt_missing")

    empty_orders = _source(empty_scope, "PRIMARY", "ORDERS")
    missing_fills = _source(missing_scope, "PRIMARY", "FILLS")
    assert empty_orders.available is True
    assert empty_orders.record_count == 0
    assert _value(empty_scope, "PRIMARY", "ORDERS_TOTAL").value == "0"
    assert missing_fills.available is False
    assert not any(value.semantic == "FILLS_TOTAL" for value in missing_scope.value_refs)
    assert any(
        notice.kind == "MISSING_EVIDENCE" and "fills" in notice.text.lower()
        for notice in missing_scope.notices
    )


def test_verified_no_spawn_cancelled_run_remains_reviewable_without_invented_zeros() -> None:
    cancelled = _fixture("bt_cancelled", state=RunState.CANCELLED)
    scope, _, _ = _build({"bt_cancelled": cancelled}, primary="bt_cancelled")

    run = scope.manifest.runs[0]
    assert run.terminal_state == "CANCELLED"
    assert all(not source.available for source in run.sources[4:])
    assert {value.semantic for value in scope.value_refs} == {"TOTAL_EVENTS"}
    missing_notices = [notice for notice in scope.notices if notice.kind == "MISSING_EVIDENCE"]
    assert len(missing_notices) == 5
    assert all("no zero is inferred" in notice.text for notice in missing_notices)


def test_verified_launch_failure_without_child_or_reports_remains_reviewable() -> None:
    failed = _launch_failed_fixture("bt_launch_failed")

    scope, _, _ = _build({"bt_launch_failed": failed}, primary="bt_launch_failed")

    run = scope.manifest.runs[0]
    assert run.terminal_state == "FAILED"
    assert all(not source.available for source in run.sources[4:])
    assert {value.semantic for value in scope.value_refs} == {"TOTAL_EVENTS"}
    runner_exit = _source(scope, "PRIMARY", "RUNNER_EXIT")
    envelope = parse_json_object(scope.read_artifact(runner_exit.artifact_id))
    projection = envelope["projection"]
    assert isinstance(projection, dict)
    content = projection["content"]
    assert isinstance(content, dict)
    assert content["classification"] == "SUPERVISOR_FAILURE"
    assert content["failure_code"] == "LAUNCH_FAILED"
    assert content["child_result"] is None
    assert content["report_kinds"] == []


def test_oversized_raw_reports_and_events_are_projected_with_actual_byte_caps() -> None:
    primary = _fixture("bt_oversized", oversized=True)
    scope, _, _ = _build({"bt_oversized": primary}, primary="bt_oversized")

    for kind in ("EVENTS", "ORDERS", "FILLS", "POSITIONS", "ACCOUNT", "METRICS"):
        source = _source(scope, "PRIMARY", kind)
        assert source.raw_size_bytes is not None and source.raw_size_bytes > 2_097_152
        assert source.projection_size_bytes <= 61_440
    assert scope.retained_size_bytes <= 2_097_152
    for artifact_id in scope.artifact_ids:
        raw = scope.read_artifact(artifact_id)
        assert len(raw) <= 65_536
        assert canonical_json_bytes(parse_json_object(raw)) == raw
    for event_id in scope.event_ids:
        raw = scope.read_event(event_id)
        assert len(raw) <= 65_536
        envelope = parse_json_object(raw)
        assert canonical_json_bytes(envelope) == raw
        projection = envelope["projection"]
        assert isinstance(projection, dict)
        assert len(canonical_json_bytes(projection)) <= 4_096
    retained_tool_bytes = b"".join(
        scope.read_artifact(artifact_id) for artifact_id in scope.artifact_ids
    ) + b"".join(scope.read_event(event_id) for event_id in scope.event_ids)
    assert b'"kind":"DIGEST_ONLY"' in retained_tool_bytes
    assert b"x" * 64 not in retained_tool_bytes
    assert all("x" * 64 not in value.value for value in scope.value_refs)
    assert all("x" * 64 not in item.text for item in scope.statement_options)
    notice_text = "\n".join(item.text for item in scope.notices)
    assert "LOCAL QA FIXTURE" in notice_text
    assert "only the explicitly selected sealed evidence" in notice_text
    assert "read-only" in notice_text and "no execution" in notice_text
    assert "BACKTEST ONLY · LIVE NOT AVAILABLE IN V0.1" in notice_text


def test_large_owner_valid_metrics_keep_summary_performance_and_auditable_omissions() -> None:
    metric_names = (
        "Max Winner",
        "Win Rate",
        "PnL% (total)",
        "Min Winner",
        "PnL (total)",
        "Avg Winner",
        "Expectancy",
        "Avg Loser",
        "Min Loser",
        "Max Loser",
    )
    large_decimal = "9" * 512
    metrics = parse_json_object(_metrics_bytes(order_count=1, end_equity="110", currency="USDT"))
    metrics["stats_pnls"] = {
        f"CUR{index:02d}": {name: large_decimal for name in metric_names} for index in range(16)
    }
    normalized_metrics = export_metrics(metrics)
    metrics_raw = canonical_json_bytes(normalized_metrics)
    assert len(metrics_raw) > 61_440
    fixture = _fixture("bt_large_metrics", metrics_raw=metrics_raw)

    scope, _, _ = _build({"bt_large_metrics": fixture}, primary="bt_large_metrics")

    source = _source(scope, "PRIMARY", "METRICS")
    artifact = scope.read_artifact(source.artifact_id)
    envelope = parse_json_object(artifact)
    projection = envelope["projection"]
    assert isinstance(projection, dict)
    content = projection["content"]
    assert isinstance(content, dict)
    assert "bounded_projection" not in content
    summary = content["summary"]
    assert isinstance(summary, dict)
    summary_entry_count = summary["entry_count"]
    assert isinstance(summary_entry_count, int)
    assert summary_entry_count > 0
    assert (
        summary["full_sha256"]
        == sha256(canonical_json_bytes(normalized_metrics["summary"])).hexdigest()
    )
    performance = content["performance"]
    assert isinstance(performance, dict)
    for anchor in ("point_count", "first", "last", "max_equity", "max_drawdown"):
        assert anchor in performance
    performance_sample_count = performance["sample_count"]
    performance_omitted_count = performance["omitted_count"]
    performance_point_count = performance["point_count"]
    assert isinstance(performance_sample_count, int)
    assert isinstance(performance_omitted_count, int)
    assert isinstance(performance_point_count, int)
    assert performance_sample_count + performance_omitted_count == performance_point_count

    expected_counts = {"stats_pnls": 16, "stats_returns": 11, "stats_general": 0}
    for group_name, expected_count in expected_counts.items():
        group = content[group_name]
        assert isinstance(group, dict)
        entries = group["entries"]
        assert isinstance(entries, list)
        assert group["entry_count"] == expected_count
        assert group["omitted_count"] == expected_count - len(entries)
        assert (
            group["full_sha256"]
            == sha256(canonical_json_bytes(normalized_metrics[group_name])).hexdigest()
        )
    pnl_group = content["stats_pnls"]
    assert isinstance(pnl_group, dict)
    pnl_omitted_count = pnl_group["omitted_count"]
    assert isinstance(pnl_omitted_count, int)
    assert pnl_omitted_count > 0
    assert len(canonical_json_bytes(projection)) <= 61_440
    assert len(artifact) <= 65_536


def test_artifact_projections_reserve_complete_envelope_budget_at_closed_metadata_edges() -> None:
    metric_names = (
        "Max Winner",
        "Win Rate",
        "PnL% (total)",
        "Min Winner",
        "PnL (total)",
        "Avg Winner",
        "Expectancy",
        "Avg Loser",
        "Min Loser",
        "Max Loser",
    )
    metrics = parse_json_object(_metrics_bytes(order_count=1, end_equity="110", currency="USDT"))
    summary = metrics["summary"]
    assert isinstance(summary, dict)

    summary["iterations"] = "9" * 256
    metrics["stats_pnls"] = {
        f"CUR{index:02d}-{'X' * 80}": {name: "9" * 505 for name in metric_names}
        for index in range(24)
    }
    normalized_metrics = export_metrics(metrics)
    metrics_raw = canonical_json_bytes(normalized_metrics)
    fixture = _with_closed_maximum_projected_events(
        _fixture("bt_metrics_envelope", metrics_raw=metrics_raw),
        run_id="bt_metrics_envelope",
    )

    scope, _, _ = _build({"bt_metrics_envelope": fixture}, primary="bt_metrics_envelope")

    assert len(scope.event_ids) == 46
    source = _source(scope, "PRIMARY", "METRICS")
    artifact = scope.read_artifact(source.artifact_id)
    envelope = parse_json_object(artifact)
    projection = envelope["projection"]
    assert isinstance(projection, dict)
    content = projection["content"]
    assert isinstance(content, dict)
    assert source.raw_sha256 == sha256(metrics_raw).hexdigest()
    assert len(envelope["value_refs"]) == 3
    assert len(envelope["statement_options"]) == 4
    assert len(canonical_json_bytes(projection)) <= 57_344
    assert len(canonical_json_bytes(projection)) <= 61_440
    assert len(artifact) <= 65_536

    projected_summary = content["summary"]
    projected_performance = content["performance"]
    assert isinstance(projected_summary, dict)
    assert isinstance(projected_performance, dict)
    summary_entries = projected_summary["entries"]
    assert isinstance(summary_entries, list)
    assert projected_summary["entry_count"] == len(normalized_metrics["summary"])
    assert projected_summary["omitted_count"] == len(normalized_metrics["summary"]) - len(
        summary_entries
    )
    assert (
        projected_summary["full_sha256"]
        == sha256(canonical_json_bytes(normalized_metrics["summary"])).hexdigest()
    )
    for anchor in ("point_count", "first", "last", "max_equity", "max_drawdown"):
        assert anchor in projected_performance
    performance_sample_count = projected_performance["sample_count"]
    performance_omitted_count = projected_performance["omitted_count"]
    performance_point_count = projected_performance["point_count"]
    assert isinstance(performance_sample_count, int)
    assert isinstance(performance_omitted_count, int)
    assert isinstance(performance_point_count, int)
    assert performance_sample_count + performance_omitted_count == performance_point_count

    expected_counts = {"stats_pnls": 24, "stats_returns": 11, "stats_general": 0}
    for group_name, expected_count in expected_counts.items():
        group = content[group_name]
        assert isinstance(group, dict)
        entries = group["entries"]
        assert isinstance(entries, list)
        assert group["entry_count"] == expected_count
        assert group["omitted_count"] == expected_count - len(entries)
        assert (
            group["full_sha256"]
            == sha256(canonical_json_bytes(normalized_metrics[group_name])).hexdigest()
        )
    pnl_group = content["stats_pnls"]
    assert isinstance(pnl_group, dict)
    assert isinstance(pnl_group["omitted_count"], int)
    assert pnl_group["omitted_count"] > 0

    run = scope.manifest.runs[0]
    assert len(run.sources) == 9
    for artifact_source in run.sources:
        artifact_bytes = scope.read_artifact(artifact_source.artifact_id)
        artifact_envelope = parse_json_object(artifact_bytes)
        artifact_projection = artifact_envelope["projection"]
        assert isinstance(artifact_projection, dict)
        assert len(artifact_envelope["event_ids"]) == (
            46 if artifact_source.source_kind == "EVENTS" else 0
        )
        projection_size = len(canonical_json_bytes(artifact_projection))
        assert projection_size <= 61_440
        assert len(artifact_bytes) - projection_size <= 8_192
        assert len(artifact_bytes) <= 65_536


@pytest.mark.parametrize("row_count", [0, 1, 4, 5, 7, 8, 9])
def test_report_sampling_boundaries_have_exact_stable_counts(row_count: int) -> None:
    rows = [_order_row(f"order-{index:04d}") for index in range(row_count)]
    scope, _, _ = _build(
        {"bt_sampling": _fixture("bt_sampling", order_rows=rows)},
        primary="bt_sampling",
    )
    source = _source(scope, "PRIMARY", "ORDERS")
    envelope = parse_json_object(scope.read_artifact(source.artifact_id))
    projection = envelope["projection"]
    assert isinstance(projection, dict)
    content = projection["content"]
    assert isinstance(content, dict)
    samples = content["samples"]
    assert isinstance(samples, list)
    expected_indexes = list(range(row_count))
    if row_count == 9:
        expected_indexes = [0, 1, 2, 3, 5, 6, 7, 8]
    assert [sample["client_order_id"] for sample in samples] == [
        f"order-{index:04d}" for index in expected_indexes
    ]
    assert source.record_count == row_count
    assert source.sample_count == len(expected_indexes)
    assert source.omitted_count == row_count - len(expected_indexes)


def test_closed_order_count_uses_only_the_exact_terminal_status_set() -> None:
    released = _order_row("order-0001")
    released["status"] = "RELEASED"
    filled = _order_row("order-0002")
    scope, _, _ = _build(
        {
            "bt_terminal_status": _fixture(
                "bt_terminal_status",
                order_rows=[
                    normalize_report_row("orders", released),
                    normalize_report_row("orders", filled),
                ],
            )
        },
        primary="bt_terminal_status",
    )

    assert _value(scope, "PRIMARY", "ORDERS_CLOSED").value == "1"


def test_scope_identity_binds_selection_order_and_role_even_for_equal_sources() -> None:
    first = _fixture("bt_first")
    second = _fixture("bt_second")
    fixtures = {"bt_first": first, "bt_second": second}
    forward, _, _ = _build(fixtures, primary="bt_first", compare="bt_second")
    reversed_scope, _, _ = _build(fixtures, primary="bt_second", compare="bt_first")
    one_run, _, _ = _build(fixtures, primary="bt_first")

    assert forward.scope_id != reversed_scope.scope_id
    assert forward.scope_id != one_run.scope_id
    primary_input = _source(forward, "PRIMARY", "INPUT_MANIFEST")
    compare_input = _source(forward, "COMPARE", "INPUT_MANIFEST")
    assert primary_input.raw_sha256 == compare_input.raw_sha256
    assert primary_input.projection_sha256 == compare_input.projection_sha256
    assert primary_input.artifact_id != compare_input.artifact_id
    with pytest.raises(ValueError, match="distinct"):
        _build(fixtures, primary="bt_first", compare="bt_first")


def test_report_decimal_totals_are_exact_under_every_ambient_precision() -> None:
    quantities = (
        "1.2345678901234567890123456789012345",
        "2.3456789012345678901234567890123456",
    )
    rows: list[dict[str, object]] = []
    for index, quantity in enumerate(quantities):
        row = _order_row(f"order-{index:04d}")
        row["quantity"] = quantity
        row["filled_qty"] = quantity
        rows.append(normalize_report_row("orders", row))
    fixture = _fixture("bt_exact_sum", order_rows=rows)
    scope_ids: list[str] = []
    projection_bytes: list[bytes] = []
    totals: list[object] = []

    for precision in (6, 28, 50):
        with localcontext() as context:
            context.prec = precision
            scope, _, _ = _build({"bt_exact_sum": fixture}, primary="bt_exact_sum")
        source = _source(scope, "PRIMARY", "ORDERS")
        envelope = parse_json_object(scope.read_artifact(source.artifact_id))
        projection = envelope["projection"]
        assert isinstance(projection, dict)
        content = projection["content"]
        assert isinstance(content, dict)
        aggregates = content["aggregates"]
        assert isinstance(aggregates, dict)
        scope_ids.append(scope.scope_id)
        projection_bytes.append(canonical_json_bytes(projection))
        totals.append(aggregates["quantity_total"])

    expected = "3.5802467913580246791358024679135801"
    assert totals == [expected, expected, expected]
    assert len(set(scope_ids)) == 1
    assert len(set(projection_bytes)) == 1


def test_decimal34_half_even_regression_is_exact_and_recomputable() -> None:
    scope, _, _ = _build({"bt_rounding": _fixture("bt_rounding")}, primary="bt_rounding")
    end_ref = _value(scope, "PRIMARY", "END_EQUITY")
    start_ref = _value(scope, "PRIMARY", "START_EQUITY")
    replacement_values = tuple(
        value.model_copy(
            update={
                "value": (
                    "1.2345678901234567890123456789012345"
                    if value.value_ref_id == end_ref.value_ref_id
                    else "1"
                )
            }
        )
        if value.value_ref_id in {end_ref.value_ref_id, start_ref.value_ref_id}
        else value
        for value in scope.value_refs
    )
    altered = replace(scope, value_refs=replacement_values)

    calculation = altered.deterministic_ratio(
        end_ref.value_ref_id,
        start_ref.value_ref_id,
        tool_call_ordinal=8,
    )

    assert calculation.result == "1.234567890123456789012345678901234"
    assert calculation == altered.deterministic_ratio(
        end_ref.value_ref_id,
        start_ref.value_ref_id,
        tool_call_ordinal=8,
    )


def test_ratio_rejects_a_canonical_result_that_cannot_fit_the_closed_envelope() -> None:
    module = _scope_module()
    scope, _, _ = _build({"bt_ratio_bound": _fixture("bt_ratio_bound")}, primary="bt_ratio_bound")
    end_ref = _value(scope, "PRIMARY", "END_EQUITY")
    start_ref = _value(scope, "PRIMARY", "START_EQUITY")
    numerator = "9" * 256
    denominator = "0." + ("0" * 253) + "1"
    replacement_values = tuple(
        value.model_copy(
            update={
                "value": (numerator if value.value_ref_id == end_ref.value_ref_id else denominator)
            }
        )
        if value.value_ref_id in {end_ref.value_ref_id, start_ref.value_ref_id}
        else value
        for value in scope.value_refs
    )
    altered = replace(scope, value_refs=replacement_values)

    with pytest.raises(module.DeterministicRatioRejected):
        altered.deterministic_ratio(
            end_ref.value_ref_id,
            start_ref.value_ref_id,
            tool_call_ordinal=1,
        )


def test_decimal34_ratio_is_allowlisted_directional_non_chainable_and_bounded() -> None:
    module = _scope_module()
    primary = _fixture("bt_ratio", end_equity="110")
    compare = _fixture("bt_ratio_compare", end_equity="220")
    scope, _, _ = _build(
        {"bt_ratio": primary, "bt_ratio_compare": compare},
        primary="bt_ratio",
        compare="bt_ratio_compare",
    )
    end_ref = _value(scope, "PRIMARY", "END_EQUITY")
    start_ref = _value(scope, "PRIMARY", "START_EQUITY")

    calculation = scope.deterministic_ratio(
        end_ref.value_ref_id,
        start_ref.value_ref_id,
        tool_call_ordinal=3,
    )

    assert calculation.result == "1.1"
    assert calculation.rule == "DECIMAL34_HALF_EVEN_RATIO_V1"
    assert calculation == scope.deterministic_ratio(
        end_ref.value_ref_id,
        start_ref.value_ref_id,
        tool_call_ordinal=3,
    )
    assert calculation.result_value_ref_id not in {value.value_ref_id for value in scope.value_refs}
    envelope = scope.ratio_envelope(calculation)
    assert len(envelope) <= 65_536
    assert canonical_json_bytes(parse_json_object(envelope)) == envelope

    orders_total = _value(scope, "PRIMARY", "ORDERS_TOTAL")
    with pytest.raises(module.DeterministicRatioRejected):
        scope.deterministic_ratio("1", start_ref.value_ref_id, tool_call_ordinal=1)
    with pytest.raises(module.DeterministicRatioRejected):
        scope.deterministic_ratio(
            calculation.result_value_ref_id,
            start_ref.value_ref_id,
            tool_call_ordinal=2,
        )
    with pytest.raises(module.DeterministicRatioRejected):
        scope.deterministic_ratio(
            start_ref.value_ref_id,
            end_ref.value_ref_id,
            tool_call_ordinal=2,
        )
    with pytest.raises(module.DeterministicRatioRejected):
        scope.deterministic_ratio(
            end_ref.value_ref_id,
            orders_total.value_ref_id,
            tool_call_ordinal=2,
        )

    empty_scope, _, _ = _build(
        {"bt_zero": _fixture("bt_zero", order_rows=[])},
        primary="bt_zero",
    )
    closed_zero = _value(empty_scope, "PRIMARY", "ORDERS_CLOSED")
    total_zero = _value(empty_scope, "PRIMARY", "ORDERS_TOTAL")
    with pytest.raises(module.DeterministicRatioRejected):
        empty_scope.deterministic_ratio(
            closed_zero.value_ref_id,
            total_zero.value_ref_id,
            tool_call_ordinal=1,
        )

    primary_total = _value(scope, "PRIMARY", "ORDERS_TOTAL")
    compare_total = _value(scope, "COMPARE", "ORDERS_TOTAL")
    cross = scope.deterministic_ratio(
        primary_total.value_ref_id,
        compare_total.value_ref_id,
        tool_call_ordinal=4,
    )
    assert cross.result == "1"
    with pytest.raises(module.DeterministicRatioRejected):
        scope.deterministic_ratio(
            compare_total.value_ref_id,
            primary_total.value_ref_id,
            tool_call_ordinal=5,
        )


def test_cross_run_equity_ratio_requires_exact_currency_equality() -> None:
    module = _scope_module()
    scope, _, _ = _build(
        {
            "bt_usdt": _fixture("bt_usdt", currency="USDT"),
            "bt_usd": _fixture("bt_usd", currency="USD"),
        },
        primary="bt_usdt",
        compare="bt_usd",
    )
    primary_end = _value(scope, "PRIMARY", "END_EQUITY")
    compare_end = _value(scope, "COMPARE", "END_EQUITY")

    with pytest.raises(module.DeterministicRatioRejected):
        scope.deterministic_ratio(
            primary_end.value_ref_id,
            compare_end.value_ref_id,
            tool_call_ordinal=1,
        )
