"""Own one finite internal historical check; no Control, CLI or report authority.

The caller must eventually supply a DB-authorized expected hash and supervise this
function in a bounded child process. The immutable output is a component snapshot,
not a published backtest report, replay seal or authorization to trade.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from nautilus_trader.backtest import BacktestEngine, BacktestEngineConfig
from nautilus_trader.common import LoggerConfig
from nautilus_trader.model import Money
from nautilus_trader.risk import RiskEngineConfig

from stark_trading_os.audit.canonical_json import parse_json_object
from stark_trading_os.catalog.historical_catalog import canonical_historical_bytes
from stark_trading_os.runner.historical_input_adapter import load_historical_runner_input
from stark_trading_os.runner.historical_report_component import build_historical_report_component_v2
from stark_trading_os.runner.historical_sma import HistoricalSmaStrategy

type ComponentStatus = Literal["COMPONENT_CHECK_PASSED", "COMPONENT_CHECK_FAILED"]
type ReportStatus = Literal["INTERNAL_REPORT_CHECK_PASSED", "INTERNAL_REPORT_CHECK_FAILED"]
type ComponentFailureCode = Literal[
    "HISTORICAL_COMPONENT_SETUP_FAILED",
    "HISTORICAL_COMPONENT_RUN_FAILED",
    "HISTORICAL_COMPONENT_FINALIZE_FAILED",
    "HISTORICAL_COMPONENT_REPORT_FAILED",
    "HISTORICAL_COMPONENT_DISPOSE_FAILED",
]


@dataclass(frozen=True, slots=True)
class HistoricalComponentOutput:
    run_id: str
    input_manifest_sha256: str
    catalog_revision: str
    cost_sha256: str
    component_status: ComponentStatus
    component_snapshot_bytes: bytes
    engine_construction_count: int
    engine_run_count: int
    engine_disposed: bool


@dataclass(frozen=True, slots=True)
class HistoricalReportComponentOutput:
    component: HistoricalComponentOutput
    report_bytes: bytes
    report_status: ReportStatus


class HistoricalComponentFailure(RuntimeError):
    """Stable failure; disposed means the native cleanup call returned successfully."""

    def __init__(self, code: ComponentFailureCode, *, engine_disposed: bool) -> None:
        super().__init__(code)
        self.code = code
        self.engine_disposed = engine_disposed


def run_historical_sma_component(
    *,
    run_id: str,
    staging_dir: Path,
    input_manifest: Path,
    expected_input_sha256: str,
) -> HistoricalComponentOutput:
    """Validate actual files first, run once, finalize while alive, then dispose."""
    component, _, _ = _run_historical_component(
        run_id=run_id,
        staging_dir=staging_dir,
        input_manifest=input_manifest,
        expected_input_sha256=expected_input_sha256,
        capture_report=False,
    )
    return component


def run_historical_report_component(
    *,
    run_id: str,
    staging_dir: Path,
    input_manifest: Path,
    expected_input_sha256: str,
) -> HistoricalReportComponentOutput:
    """Capture the same engine's native reports before disposal, returning only bytes."""
    component, report_bytes, report_status = _run_historical_component(
        run_id=run_id,
        staging_dir=staging_dir,
        input_manifest=input_manifest,
        expected_input_sha256=expected_input_sha256,
        capture_report=True,
    )
    if report_bytes is None or report_status is None:
        raise HistoricalComponentFailure(
            "HISTORICAL_COMPONENT_REPORT_FAILED", engine_disposed=component.engine_disposed
        )
    return HistoricalReportComponentOutput(component, report_bytes, report_status)


def _run_historical_component(
    *,
    run_id: str,
    staging_dir: Path,
    input_manifest: Path,
    expected_input_sha256: str,
    capture_report: bool,
) -> tuple[HistoricalComponentOutput, bytes | None, ReportStatus | None]:
    loaded = load_historical_runner_input(
        run_id=run_id,
        staging_dir=staging_dir,
        input_manifest=input_manifest,
        expected_input_sha256=expected_input_sha256,
    )
    profile = loaded.execution_profile
    engine: BacktestEngine | None = None
    constructed = runs = 0
    disposed = False
    snapshot_bytes: bytes | None = None
    status: ComponentStatus | None = None
    report_bytes: bytes | None = None
    report_status: ReportStatus | None = None
    stage: ComponentFailureCode = "HISTORICAL_COMPONENT_SETUP_FAILED"
    failure_code: ComponentFailureCode | None = None
    failure_cause: Exception | None = None
    try:
        strategy = HistoricalSmaStrategy(
            input_bytes=loaded.manifest_bytes,
            expected_input_sha256=loaded.input_manifest_hash,
            catalog_manifest_bytes=loaded.catalog_manifest_bytes,
            bars=loaded.bars,
        )
        engine = BacktestEngine(
            config=BacktestEngineConfig(
                bypass_logging=True,
                run_analysis=False,
                logging=LoggerConfig(bypass_logging=True),
                risk_engine=RiskEngineConfig(
                    max_notional_per_order={
                        str(profile.instrument.id): (
                            loaded.manifest.configuration.configuration.risk.max_order_notional
                        )
                    }
                ),
            )
        )
        constructed += 1
        engine.add_venue(
            venue=profile.instrument.id.venue,
            base_currency=None,
            starting_balances=[
                Money.zero(profile.instrument.base_currency),
                profile.starting_quote_balance,
            ],
            oms_type=profile.oms_type,
            account_type=profile.account_type,
            fill_model=profile.fill_model,
            fee_model=profile.fee_model,
            latency_model=profile.latency_model,
            book_type=profile.book_type,
            routing=profile.routing,
            use_position_ids=profile.use_position_ids,
            use_random_ids=profile.use_random_ids,
            use_reduce_only=profile.use_reduce_only,
            use_market_order_acks=profile.use_market_order_acks,
            bar_execution=profile.bar_execution,
            bar_adaptive_high_low_ordering=profile.bar_adaptive_high_low_ordering,
            trade_execution=profile.trade_execution,
            liquidity_consumption=profile.liquidity_consumption,
            allow_cash_borrowing=profile.allow_cash_borrowing,
        )
        engine.add_instrument(profile.instrument)
        engine.add_strategy(strategy)
        engine.add_data(list(loaded.bars))
        stage = "HISTORICAL_COMPONENT_RUN_FAILED"
        runs += 1
        engine.run()
        stage = "HISTORICAL_COMPONENT_FINALIZE_FAILED"
        snapshot = strategy.finalize_component()
        if (
            snapshot.get("scope") != "IN_MEMORY_COMPONENT_CHECK"
            or snapshot.get("input_manifest_sha256") != loaded.input_manifest_hash
            or snapshot.get("status") not in {"COMPONENT_CHECK_PASSED", "COMPONENT_CHECK_FAILED"}
        ):
            raise ValueError("HISTORICAL_COMPONENT_RESULT_INVALID")
        status = snapshot["status"]
        snapshot_bytes = canonical_historical_bytes(snapshot)
        if capture_report:
            stage = "HISTORICAL_COMPONENT_REPORT_FAILED"
            account = engine.cache.account_for_venue(profile.instrument.id.venue)
            if account is None:
                raise ValueError("HISTORICAL_COMPONENT_ACCOUNT_MISSING")
            report_bytes = build_historical_report_component_v2(
                loaded=loaded,
                component_snapshot_bytes=snapshot_bytes,
                account_id=str(account.id),
                orders=engine.generate_orders_report(),
                fills=engine.generate_fills_report(),
                positions=engine.generate_positions_report(),
                account=engine.generate_account_report(profile.instrument.id.venue),
            )
            value = parse_json_object(report_bytes)["status"]
            if value == "INTERNAL_REPORT_CHECK_PASSED":
                report_status = "INTERNAL_REPORT_CHECK_PASSED"
            elif value == "INTERNAL_REPORT_CHECK_FAILED":
                report_status = "INTERNAL_REPORT_CHECK_FAILED"
            else:
                raise ValueError("HISTORICAL_COMPONENT_REPORT_STATUS_INVALID")
    except Exception as error:
        failure_code, failure_cause = stage, error
    finally:
        if engine is not None:
            try:
                engine.dispose()
                disposed = True
            except Exception as error:
                failure_code = "HISTORICAL_COMPONENT_DISPOSE_FAILED"
                failure_cause = error
    if failure_code is not None:
        raise HistoricalComponentFailure(failure_code, engine_disposed=disposed) from failure_cause
    if snapshot_bytes is None or status is None or not disposed:
        raise HistoricalComponentFailure(
            "HISTORICAL_COMPONENT_FINALIZE_FAILED", engine_disposed=disposed
        )
    component = HistoricalComponentOutput(
        run_id=loaded.run_id,
        input_manifest_sha256=loaded.input_manifest_hash,
        catalog_revision=loaded.manifest.dataset.catalog_revision,
        cost_sha256=profile.cost_sha256,
        component_status=status,
        component_snapshot_bytes=snapshot_bytes,
        engine_construction_count=constructed,
        engine_run_count=runs,
        engine_disposed=disposed,
    )
    return component, report_bytes, report_status
