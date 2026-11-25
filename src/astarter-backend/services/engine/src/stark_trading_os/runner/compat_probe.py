from __future__ import annotations

import gc
import importlib
import json
import multiprocessing
import os
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

from nautilus_trader.backtest import (
    BacktestDataConfig,
    BacktestEngineConfig,
    BacktestNode,
    BacktestRunConfig,
    BacktestVenueConfig,
)
from nautilus_trader.core import UUID4
from nautilus_trader.execution import LimitOrderPartialFillModel
from nautilus_trader.model import (
    AccountType,
    BookType,
    ClientOrderId,
    Currency,
    CurrencyPair,
    InstrumentId,
    LimitOrder,
    OmsType,
    OrderFilled,
    OrderSide,
    OrderStatus,
    Price,
    Quantity,
    QuoteTick,
    Symbol,
    TimeInForce,
    Venue,
)
from nautilus_trader.persistence import ParquetDataCatalog
from nautilus_trader.trading import ImportableStrategyConfig, Strategy, StrategyConfig

_VENUE = Venue("SIM")
_BASE_NS = 1_700_000_000_000_000_000
_COOPERATIVE_CANCEL_CALLBACK_OBSERVED = False
_COOPERATIVE_CANCEL_TOKEN = threading.Event()


@dataclass
class CompatProbeResult:
    orders: Any
    fills: Any
    positions: Any
    account: Any
    metrics_source: set[str]
    native_float_fields: dict[str, float]
    order_status_path: tuple[str, ...]
    child_backtest_node_instances: int
    child_backtest_node_observations: tuple[tuple[str, int, bool], ...]
    cooperative_cancel_callback_attempted: bool
    child_process_id: int
    child_lifecycle_trace: list[str]
    parent_backtest_node_instances: int = 0


class Rc3ProbeConfig(StrategyConfig):
    _CUSTOM_FIELDS = ("instrument_id", "trade_size")

    def __new__(cls, *args: Any, **kwargs: Any) -> Rc3ProbeConfig:
        for key in cls._CUSTOM_FIELDS:
            kwargs.pop(key, None)
        return super().__new__(cls, *args, **kwargs)

    def __init__(
        self,
        instrument_id: str,
        trade_size: str,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.instrument_id = instrument_id
        self.trade_size = trade_size


class _ChildNodeLifecycleObserver:
    """Observes construction and ownership of the native child-process node."""

    def __init__(self) -> None:
        self.constructor_calls = 0
        self.owned_node: BacktestNode | None = None
        self.observations: list[tuple[str, int, bool]] = []

    def observe(self, phase: str) -> None:
        self.observations.append(
            (phase, self.constructor_calls, self.owned_node is not None),
        )

    def construct(self, configs: list[BacktestRunConfig]) -> BacktestNode:
        node = BacktestNode(configs=configs)
        self.constructor_calls += 1
        self.owned_node = node
        return node

    def release(self) -> None:
        self.owned_node = None


class Rc3ProbeStrategy(Strategy):
    observed_status_path: list[str] = []
    cooperative_cancel_callback_attempted = False

    def __init__(self, config: Rc3ProbeConfig) -> None:
        super().__init__(config)
        self._instrument_id = InstrumentId.from_str(config.instrument_id)
        self._trade_size = Quantity.from_str(config.trade_size)
        self._submitted = False

    def on_start(self) -> None:
        global _COOPERATIVE_CANCEL_CALLBACK_OBSERVED

        type(self).observed_status_path = []
        type(self).cooperative_cancel_callback_attempted = False
        if _COOPERATIVE_CANCEL_TOKEN.is_set():
            type(self).cooperative_cancel_callback_attempted = True
            _COOPERATIVE_CANCEL_CALLBACK_OBSERVED = True
            self.stop()
            return
        self.subscribe_quotes(self._instrument_id)

    def on_quote(self, quote: QuoteTick) -> None:
        if not self._submitted:
            trader_id = self.trader_id
            if trader_id is None:
                raise RuntimeError("rc3 probe strategy has no trader ID")
            self._submitted = True
            self.submit_order(
                LimitOrder(
                    trader_id=trader_id,
                    strategy_id=self.strategy_id,
                    instrument_id=self._instrument_id,
                    client_order_id=ClientOrderId(f"{self.strategy_id}-partial"),
                    order_side=OrderSide.BUY,
                    quantity=self._trade_size,
                    price=Price.from_str("100.00"),
                    time_in_force=TimeInForce.GTC,
                    post_only=False,
                    reduce_only=False,
                    quote_quantity=False,
                    init_id=UUID4(),
                    ts_init=self.clock.timestamp_ns(),
                ),
            )

    def on_order_filled(self, event: OrderFilled) -> None:
        order = self.cache.order(event.client_order_id)
        if order is None:
            raise RuntimeError("rc3 probe could not resolve filled order from the native cache")
        status = order.status
        if status not in (OrderStatus.PARTIALLY_FILLED, OrderStatus.FILLED):
            raise RuntimeError(f"unexpected native status after fill: {status}")
        type(self).observed_status_path.append(status.name)


def run_compat_probe(tmp_path: Path) -> CompatProbeResult:
    parent_node_count_before = _observed_backtest_node_instances()
    parent, child = multiprocessing.get_context("spawn").Pipe(duplex=False)
    process = multiprocessing.get_context("spawn").Process(
        target=_run_probe_child,
        args=(str(tmp_path), child),
    )
    process.start()
    child.close()
    if not parent.poll(15):
        process.terminate()
        process.join(timeout=5)
        raise TimeoutError("rc3 probe child exceeded the 15 second receive bound")
    result = parent.recv()
    process.join(timeout=15)
    if process.is_alive():
        process.terminate()
        process.join(timeout=5)
        raise TimeoutError("rc3 probe child exceeded the 15 second join bound")
    if process.exitcode != 0:
        raise RuntimeError(f"rc3 probe child exited with {process.exitcode}: {result}")
    if isinstance(result, Exception):
        raise result
    if not isinstance(result, CompatProbeResult):
        raise RuntimeError(f"rc3 probe child returned an unexpected payload: {result!r}")
    parent_node_count_after = _observed_backtest_node_instances()
    if parent_node_count_after != parent_node_count_before:
        raise RuntimeError("parent process constructed a BacktestNode during the rc3 probe")
    result.parent_backtest_node_instances = parent_node_count_after
    return result


def run_compat_probe_in_child(tmp_path: Path, request_cancel: bool = False) -> dict[str, Any]:
    if not request_cancel:
        result = run_compat_probe(tmp_path)
        return {
            "parent_backtest_node_instances": result.parent_backtest_node_instances,
            "child_backtest_node_instances": result.child_backtest_node_instances,
            "child_backtest_node_observations": result.child_backtest_node_observations,
            "child_process_id": result.child_process_id,
            "child_lifecycle_trace": result.child_lifecycle_trace,
        }

    completed = subprocess.run(
        [sys.executable, "-m", "stark_trading_os.runner.compat_probe", "--stdin-cancel-spike"],
        input="CANCEL\n",
        capture_output=True,
        check=False,
        text=True,
        timeout=10,
    )
    payload_line = next(
        (line for line in reversed(completed.stdout.splitlines()) if line.startswith("{")),
        None,
    )
    if payload_line is None:
        raise RuntimeError(f"stdin cancel spike returned no payload: {completed.stdout}")
    payload = cast(dict[str, Any], json.loads(payload_line))
    if completed.returncode != 0:
        raise RuntimeError(f"stdin cancel spike failed: {completed.stderr}")
    return payload


def _run_probe_child(catalog_dir: str, connection: Any) -> None:
    try:
        connection.send(_execute_compat_probe(Path(catalog_dir)))
    except Exception as error:  # pragma: no cover - propagated to the parent assertion
        connection.send(error)
        raise
    finally:
        connection.close()


def _execute_compat_probe(tmp_path: Path, preserve_cancel_token: bool = False) -> CompatProbeResult:
    global _COOPERATIVE_CANCEL_CALLBACK_OBSERVED

    _COOPERATIVE_CANCEL_CALLBACK_OBSERVED = False
    if not preserve_cancel_token:
        _COOPERATIVE_CANCEL_TOKEN.clear()
    catalog_path, instrument = _write_catalog(tmp_path)
    run_config = BacktestRunConfig(
        venues=[
            BacktestVenueConfig(
                name="SIM",
                oms_type=OmsType.HEDGING,
                account_type=AccountType.MARGIN,
                book_type=BookType.L1_MBP,
                starting_balances=["1_000_000 USDT"],
                fill_model=LimitOrderPartialFillModel(
                    prob_fill_on_limit=1.0,
                    prob_slippage=0.0,
                    random_seed=42,
                ),
            ),
        ],
        data=[
            BacktestDataConfig(
                data_type="QuoteTick",
                catalog_path=str(catalog_path),
                instrument_id=instrument.id,
            ),
        ],
        engine=BacktestEngineConfig(bypass_logging=True, run_analysis=True),
        dispose_on_completion=False,
        id="rc3-compat-probe",
    )
    strategy_config = ImportableStrategyConfig(
        strategy_path="stark_trading_os.runner.compat_probe:Rc3ProbeStrategy",
        config_path="stark_trading_os.runner.compat_probe:Rc3ProbeConfig",
        config={"instrument_id": instrument.id.value, "trade_size": "6.000"},
    )
    lifecycle_trace: list[str] = []
    node_observer = _ChildNodeLifecycleObserver()
    node_observer.observe("before_construction")
    node = node_observer.construct([run_config])
    node_observer.observe("during_execution")
    lifecycle_trace.append("node_constructed")
    try:
        node.build()
        node.add_strategy_from_config(run_config.id, strategy_config)
        backtest_result = node.run()[0]
        orders = node.generate_orders_report(run_config.id)
        fills = node.generate_fills_report(run_config.id)
        positions = node.generate_positions_report(run_config.id)
        account = node.generate_account_report(run_config.id, venue=_VENUE)
        metrics = {
            "summary": backtest_result.summary,
            "stats_pnls": backtest_result.stats_pnls,
            "stats_returns": backtest_result.stats_returns,
            "stats_general": backtest_result.stats_general,
        }
    finally:
        node.dispose()
        lifecycle_trace.append("node_disposed")
        node_observer.release()
        del node
        gc.collect()
        node_observer.observe("after_disposal")
    return CompatProbeResult(
        orders=orders,
        fills=fills,
        positions=positions,
        account=account,
        metrics_source=set(metrics),
        native_float_fields=_native_float_fields(metrics, orders, fills, positions, account),
        order_status_path=tuple(Rc3ProbeStrategy.observed_status_path),
        child_backtest_node_instances=node_observer.constructor_calls,
        child_backtest_node_observations=tuple(node_observer.observations),
        cooperative_cancel_callback_attempted=Rc3ProbeStrategy.cooperative_cancel_callback_attempted,
        child_process_id=os.getpid(),
        child_lifecycle_trace=lifecycle_trace,
    )


def _write_catalog(tmp_path: Path) -> tuple[Path, CurrencyPair]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    catalog_path = tmp_path / "catalog"
    catalog_path.mkdir()
    instrument = CurrencyPair(
        instrument_id=InstrumentId(Symbol("ETH/USDT"), _VENUE),
        raw_symbol=Symbol("ETH/USDT"),
        base_currency=Currency.from_str("ETH"),
        quote_currency=Currency.from_str("USDT"),
        price_precision=2,
        size_precision=3,
        price_increment=Price.from_str("0.01"),
        size_increment=Quantity.from_str("0.001"),
        ts_event=_BASE_NS,
        ts_init=_BASE_NS,
        min_quantity=Quantity.from_str("0.001"),
        margin_init=Decimal("0.10"),
        margin_maint=Decimal("0.05"),
        maker_fee=Decimal("0"),
        taker_fee=Decimal("0"),
    )
    catalog = ParquetDataCatalog(str(catalog_path))
    catalog.write_instruments([instrument])
    catalog.write_quote_ticks(
        [
            QuoteTick(
                instrument.id,
                Price.from_str("99.00"),
                Price.from_str("100.00"),
                Quantity.from_str("10.000"),
                Quantity.from_str("10.000"),
                _BASE_NS,
                _BASE_NS,
            ),
            QuoteTick(
                instrument.id,
                Price.from_str("99.00"),
                Price.from_str("100.00"),
                Quantity.from_str("10.000"),
                Quantity.from_str("10.000"),
                _BASE_NS + 1,
                _BASE_NS + 1,
            ),
        ],
    )
    return catalog_path, instrument


def _native_float_fields(metrics: dict[str, Any], *reports: Any) -> dict[str, float]:
    found: dict[str, float] = {}

    def visit(value: Any, path: str) -> None:
        if isinstance(value, float):
            found[path] = value
        elif isinstance(value, dict):
            for key, nested in value.items():
                visit(nested, f"{path}.{key}")

    for name, value in metrics.items():
        visit(value, name)
    for index, report in enumerate(reports):
        for column in report.select_dtypes(include=["float", "float32", "float64"]):
            for row_index, value in report[column].items():
                found[f"report_{index}.{column}[{row_index}]"] = float(value)
    return found


def _observed_backtest_node_instances() -> int:
    return sum(type(value) is BacktestNode for value in gc.get_objects())


def _stdin_cancel_spike() -> int:
    request = sys.stdin.readline().strip()
    node_completed_after_strategy_stop = False
    failure_category = "clean_outcome"
    failure_type: str | None = None
    strategy_module = importlib.import_module("stark_trading_os.runner.compat_probe")
    if request == "CANCEL":
        strategy_module._COOPERATIVE_CANCEL_TOKEN.set()
    try:
        strategy_module._execute_compat_probe(
            Path(tempfile.mkdtemp()),
            preserve_cancel_token=request == "CANCEL",
        )
        node_completed_after_strategy_stop = True
    except Exception as error:
        failure_category = "strategy_stop_faulted_before_clean_outcome"
        failure_type = type(error).__name__
    callback_observed = strategy_module._COOPERATIVE_CANCEL_CALLBACK_OBSERVED
    cooperative_cancel_proven = callback_observed and node_completed_after_strategy_stop
    payload = {
        "stdin_cancel_attempted": request == "CANCEL",
        "strategy_callback_observed": callback_observed,
        "node_completed_after_strategy_stop": node_completed_after_strategy_stop,
        "failure_category": failure_category,
        "failure_type": failure_type,
        "cooperative_cancel_proven": cooperative_cancel_proven,
        "cancel_mode": (
            "COOPERATIVE -> CANCELLED"
            if cooperative_cancel_proven
            else "SIGTERM/SIGKILL -> FAILED"
        ),
    }
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--stdin-cancel-spike":
        raise SystemExit(_stdin_cancel_spike())
    raise SystemExit("unsupported compat probe invocation")
