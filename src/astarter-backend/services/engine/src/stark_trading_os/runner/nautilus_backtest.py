"""One real pinned Nautilus backtest node and its native observations."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from nautilus_trader.backtest import BacktestNode
from nautilus_trader.model import Venue

from stark_trading_os.domain.models import DeterminismProbeConfigV1
from stark_trading_os.runner.determinism_probe import (
    ProbeObservationContext,
    build_probe_registration,
    clear_probe_observation_context,
    install_probe_observation_context,
)
from stark_trading_os.runner.input_adapter import LoadedRunnerInput
from stark_trading_os.runner.protocol import RunnerCandidateV1
from stark_trading_os.runner.report_export import export_backtest_reports

type NativeFailureCode = Literal["RUNNER_EXECUTION_FAILED", "REPORT_EXPORT_FAILED"]


@dataclass(frozen=True)
class NativeBacktestOutput:
    candidates: tuple[RunnerCandidateV1, ...]
    reports: dict[str, object]
    node_construction_count: int
    node_run_count: int
    node_disposed: bool


class NativeBacktestFailure(RuntimeError):
    """Stable native failure plus the valid candidate prefix produced before it."""

    def __init__(
        self,
        *,
        code: NativeFailureCode,
        candidates: tuple[RunnerCandidateV1, ...],
        node_disposed: bool,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.candidates = candidates
        self.node_disposed = node_disposed


def run_native_backtest(loaded: LoadedRunnerInput) -> NativeBacktestOutput:
    definition = DeterminismProbeConfigV1.model_validate(
        loaded.manifest.canonical_config
    )
    registration = build_probe_registration(
        instrument_id=loaded.manifest.instruments[0].instrument_id,
        definition=definition,
    )
    context = ProbeObservationContext(
        run_id=loaded.run_id,
        input_manifest_hash=loaded.input_manifest_hash,
        catalog_revision=loaded.manifest.catalog_revision,
        instrument=loaded.catalog_manifest.inventory.instrument,
        records=tuple(
            record
            for record in loaded.catalog_manifest.inventory.source_records
            if int(loaded.manifest.window.start_ns)
            <= int(record.ts_available_ns)
            < int(loaded.manifest.window.end_ns)
        ),
    )
    node: BacktestNode | None = None
    node_construction_count = 0
    node_run_count = 0
    node_disposed = False
    reports: dict[str, object] | None = None
    candidates: tuple[RunnerCandidateV1, ...] = ()
    failure_code: NativeFailureCode | None = None
    failure_cause: Exception | None = None
    install_probe_observation_context(context)
    try:
        try:
            node = BacktestNode(configs=[loaded.run_config])
            node_construction_count += 1
            node.build()
            node.add_strategy_from_config(loaded.run_config.id, registration)
            results = node.run()
            node_run_count += 1
            if len(results) != 1:
                raise RuntimeError("NATIVE_RUN_RESULT_CARDINALITY_INVALID")
            context.require_all_quotes_observed()
            candidates = tuple(context.candidates)
            try:
                reports = export_backtest_reports(
                    node,
                    loaded.run_config.id,
                    Venue(loaded.manifest.venue_account_model.venue_id),
                    results[0],
                )
            except Exception as error:
                failure_code = "REPORT_EXPORT_FAILED"
                failure_cause = error
        except Exception as error:
            candidates = tuple(context.candidates)
            failure_code = "RUNNER_EXECUTION_FAILED"
            failure_cause = error
    finally:
        if node is not None:
            try:
                node.dispose()
                node_disposed = True
            except Exception as error:
                failure_code = "RUNNER_EXECUTION_FAILED"
                failure_cause = error
        clear_probe_observation_context()
    if failure_code is not None:
        failure = NativeBacktestFailure(
            code=failure_code,
            candidates=candidates,
            node_disposed=node_disposed,
        )
        if failure_cause is not None:
            raise failure from failure_cause
        raise failure
    if reports is None:
        raise NativeBacktestFailure(
            code="RUNNER_EXECUTION_FAILED",
            candidates=candidates,
            node_disposed=node_disposed,
        )
    return NativeBacktestOutput(
        candidates=candidates,
        reports=reports,
        node_construction_count=node_construction_count,
        node_run_count=node_run_count,
        node_disposed=node_disposed,
    )
