"""Application-owned service graph for one local control process."""

from __future__ import annotations

import asyncio
import importlib.metadata
import os
import secrets
import sys
import time
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Protocol

from fastapi import Request
from nautilus_trader.model import FIXED_PRECISION, HIGH_PRECISION

from stark_trading_os.agent.evidence_scope import IndependentEvidenceScopeBuilder
from stark_trading_os.agent.openai_review import RunReviewer, validate_model_name
from stark_trading_os.agent.service import RunReviewService
from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.catalog.fixture_publisher import FixturePublisher
from stark_trading_os.catalog.fixture_registry import FixtureRegistry
from stark_trading_os.control.cancellation import CancellationCoordinator
from stark_trading_os.control.database import _SCHEMA_VERSION
from stark_trading_os.control.historical_configuration_service import HistoricalConfigurationService
from stark_trading_os.control.historical_control import HistoricalControl
from stark_trading_os.control.preflight import (
    EngineIdentity,
    PreflightService,
    RunReservation,
)
from stark_trading_os.control.recovery import FinalizationRecovery
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.run_contract import RunContractKind, require_probe_contract
from stark_trading_os.control.strategy_configurations import (
    RegisteredDefinition,
    StrategyCatalog,
    StrategyConfigurationService,
)
from stark_trading_os.control.supervisor import RunnerSupervisor
from stark_trading_os.control.transactions import (
    PINNED_ENGINE_PACKAGE_VERSION,
    PINNED_ENGINE_PRECISION_MODE,
    PINNED_ENGINE_PYTHON_VERSION,
    PINNED_ENGINE_TAG_COMMIT,
    PersistedCancelRequest,
    RunSnapshot,
)
from stark_trading_os.domain.models import TERMINAL_STATES, RunState

CONTROL_SCHEMA_VERSION = _SCHEMA_VERSION
DEFAULT_SSE_HEARTBEAT_SECONDS = 15.0


class CommandScheduler(Protocol):
    def schedule_run(self, reservation: RunReservation) -> None: ...

    def schedule_cancel(self, decision: PersistedCancelRequest) -> None: ...

    def reconcile_run(self, run_id: str) -> None: ...

    def unavailable_reason(self) -> str | None: ...


class EventRetentionFloor(Protocol):
    def minimum_available_seq(self, run_id: str) -> int: ...


class ApiCommandScheduler:
    """Own and reconcile committed control work for the application lifetime."""

    def __init__(
        self,
        *,
        store: ControlStore,
        supervisor: RunnerSupervisor,
        cancellation: CancellationCoordinator,
        recovery: FinalizationRecovery,
        engine_identity: EngineIdentity,
        historical: HistoricalControl | None = None,
    ) -> None:
        if historical is not None and (
            type(historical) is not HistoricalControl or historical._store is not store
        ):
            raise ValueError("Historical scheduler must share its Control store.")
        self._store = store
        self._supervisor = supervisor
        self._cancellation = cancellation
        self._recovery = recovery
        self._engine_identity = engine_identity
        self._historical = historical
        self._historical_execute_requested: set[str] = set()
        self._tasks: dict[tuple[str, str], asyncio.Task[None]] = {}
        self._accepting = True
        self._unavailable: str | None = None

    async def start(self) -> None:
        if not self._accepting:
            raise RuntimeError("Scheduler admission is closed.")
        for snapshot in self._store.recoverable_active_runs():
            if snapshot.contract_kind is RunContractKind.PROBE_V1:
                self.reconcile_run(snapshot.run_id)
            elif self._historical is not None:
                self.reconcile_historical_run(snapshot.run_id)

    def schedule_run(self, reservation: RunReservation) -> None:
        require_probe_contract(self._store.run(reservation.run_id).contract_kind)
        self._start(
            "owner",
            reservation.run_id,
            lambda: self._run_new_reservation(reservation),
        )

    def schedule_cancel(self, decision: PersistedCancelRequest) -> None:
        if not decision.created_by_caller:
            return
        run_id = decision.response.run_id
        if run_id is None:
            raise RuntimeError("Persisted cancellation is missing its run identity.")
        require_probe_contract(self._store.run(run_id).contract_kind)
        if decision.clean_no_claim:
            self._start(
                "cancel",
                run_id,
                lambda: self._continue_after(
                    run_id,
                    self._finalize_clean_cancel(decision),
                ),
            )
        elif decision.signal_required:
            self._start(
                "cancel",
                run_id,
                lambda: self._terminate(decision),
            )

    def reconcile_run(self, run_id: str) -> None:
        require_probe_contract(self._store.run(run_id).contract_kind)
        self._start("owner", run_id, lambda: self._reconcile_owned(run_id))

    def unavailable_reason(self) -> str | None:
        return self._unavailable

    def command_unavailable_reason(self) -> str | None:
        return "CONTROL_CLOSING" if not self._accepting else self._unavailable

    def schedule_historical_run(self, run_id: str) -> None:
        self._require_historical(run_id)
        # An explicit retry arriving during startup recovery must not lose its
        # permission to prepare verified evidence when the owner is coalesced.
        self._historical_execute_requested.add(run_id)
        self._start("owner", run_id, lambda: self._historical_owned(run_id))

    def reconcile_historical_run(self, run_id: str) -> None:
        self._require_historical(run_id)
        self._start("owner", run_id, lambda: self._historical_owned(run_id))

    def schedule_historical_cancel(self, decision: PersistedCancelRequest) -> None:
        if type(decision) is not PersistedCancelRequest or decision.response.run_id is None:
            raise TypeError("Historical cancellation requires a persisted run decision.")
        run_id = decision.response.run_id
        self._require_historical(run_id)
        # Replayed cancellation can finish accepted work after a crash; its
        # immutable receipt does not grant a second signal or a new run.
        self._start("cancel", run_id, lambda: self._historical_cancel(decision, run_id))

    def _require_historical(self, run_id: str) -> HistoricalControl:
        if self.command_unavailable_reason() is not None:
            raise RuntimeError("Scheduler admission is unavailable.")
        historical = self._historical
        if historical is None:
            raise RuntimeError("Historical scheduler is unavailable.")
        historical._preflights.record_for_run(run_id)
        return historical

    async def _historical_owned(self, run_id: str) -> None:
        historical = self._historical
        assert historical is not None
        try:
            explicit = run_id in self._historical_execute_requested
            self._historical_execute_requested.discard(run_id)
            snapshot = self._store.run(run_id)
            unclaimed_queue = (
                snapshot.state is RunState.QUEUED
                and self._store.runner_process(run_id) is None
                and self._store.historical_runner_outcome(run_id) is None
            )
            if explicit or unclaimed_queue:
                await self._run_historical(run_id)
            else:
                # Expected unknown ownership / missing anchor remains pending;
                # no busy loop and no global failure for those valid states.
                await historical.recover_one(run_id)
            if run_id in self._historical_execute_requested:
                self._historical_execute_requested.discard(run_id)
                await self._run_historical(run_id)
        finally:
            self._historical_execute_requested.discard(run_id)

    async def _run_historical(self, run_id: str) -> None:
        historical = self._historical
        assert historical is not None
        if self._engine_run_available():
            await historical.run_reserved(run_id)

    async def _historical_cancel(self, decision: PersistedCancelRequest, run_id: str) -> None:
        historical = self._historical
        assert historical is not None
        if decision.clean_no_claim:
            historical.finalize_clean_cancel(decision)
        elif decision.created_by_caller and decision.signal_required:
            # A natural exit may beat signal admission. The shared coordinator
            # verifies signal ownership; the persisted outcome decides the end.
            await self._cancellation.terminate(decision)
        else:
            # The receipt may have committed before its signal task existed.
            # Resume only a persisted cancel phase; recover() preserves TERM
            # idempotency and rechecks identity before any further signal.
            process = self._store.runner_process(run_id)
            if process is not None and process.cancel_phase in {
                "REQUESTED",
                "TERM_SENT",
                "KILL_SENT",
            }:
                await self._cancellation.recover(process)
        owner = self._tasks.get(("owner", run_id))
        if owner is not None:
            await asyncio.shield(owner)
        if self._store.run(run_id).state in TERMINAL_STATES:
            return
        recovered = await historical.recover_one(run_id)
        if recovered.pending_reason == "EVIDENCE_NOT_ANCHORED":
            # Explicit accepted cancel, unlike startup recovery, can complete
            # normal preparation after all committed input/outcome checks.
            await historical.run_reserved(run_id)

    async def close(self) -> None:
        self._accepting = False
        tasks = tuple(self._tasks.values())
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def _start(
        self,
        operation: str,
        run_id: str,
        operation_factory: Callable[[], Coroutine[object, object, None]],
    ) -> None:
        if not self._accepting:
            raise RuntimeError("Scheduler admission is closed.")
        key = (operation, run_id)
        active = self._tasks.get(key)
        if active is not None and not active.done():
            return
        task = asyncio.create_task(operation_factory())
        self._tasks[key] = task
        task.add_done_callback(lambda completed: self._consume(key, completed))

    def _consume(self, key: tuple[str, str], task: asyncio.Task[None]) -> None:
        if self._tasks.get(key) is task:
            del self._tasks[key]
        try:
            task.result()
        except BaseException:
            self._unavailable = "BACKGROUND_RECOVERY_FAILED"

    async def _continue_after(
        self,
        run_id: str,
        operation: Awaitable[object],
    ) -> None:
        try:
            await operation
        except Exception:
            pass
        await self._reconcile_owned(run_id)

    async def _run_new_reservation(self, reservation: RunReservation) -> None:
        if not self._engine_run_available():
            return
        await self._continue_after(
            reservation.run_id,
            self._supervisor.run(reservation),
        )

    async def _reconcile_owned(self, run_id: str) -> None:
        if not await self._reconcile_control_work(run_id) and self._unavailable is None:
            self._unavailable = "BACKGROUND_RECOVERY_FAILED"

    async def _reconcile_control_work(self, run_id: str) -> bool:
        for _attempt in range(3):
            snapshot = self._store.run(run_id)
            if snapshot.state in TERMINAL_STATES:
                return True
            if snapshot.state is RunState.FINALIZING:
                return self._recover_finalization(run_id)
            try:
                if (
                    snapshot.state is RunState.QUEUED
                    and self._store.runner_process(run_id) is None
                    and self._store.runner_outcome(run_id) is None
                ):
                    if not self._engine_run_available():
                        return False
                    await self._supervisor.run(_reservation(snapshot))
                else:
                    await self._supervisor.recover_one(run_id)
            except Exception:
                continue
        snapshot = self._store.run(run_id)
        if snapshot.state in TERMINAL_STATES:
            return True
        if snapshot.state is RunState.FINALIZING:
            return self._recover_finalization(run_id)
        return False

    def _engine_run_available(self) -> bool:
        failure = engine_identity_check(self._engine_identity)
        if failure is None:
            return True
        self._unavailable = failure
        return False

    def _recover_finalization(self, run_id: str) -> bool:
        for _attempt in range(3):
            try:
                self._recovery.recover()
            except Exception:
                continue
            if self._store.run(run_id).state in TERMINAL_STATES:
                return True
        return self._store.run(run_id).state in TERMINAL_STATES

    async def _finalize_clean_cancel(self, decision: PersistedCancelRequest) -> None:
        self._supervisor.finalize_clean_cancel(decision)

    async def _terminate(self, decision: PersistedCancelRequest) -> None:
        observation = await self._cancellation.terminate(decision)
        if not observation.identity_verified or not observation.group_dead:
            raise RuntimeError("Persisted cancellation did not prove process-group exit.")


def _reservation(snapshot: RunSnapshot) -> RunReservation:
    if snapshot.input_manifest_bytes is None or snapshot.input_manifest_hash is None:
        raise RuntimeError("Recoverable run is missing its committed reservation.")
    return RunReservation(
        run_id=snapshot.run_id,
        state=snapshot.state,
        state_version=snapshot.state_version,
        last_visible_seq=snapshot.last_event_seq,
        input_manifest_bytes=snapshot.input_manifest_bytes,
        input_manifest_hash=snapshot.input_manifest_hash,
    )


@dataclass(frozen=True)
class ControlDependencies:
    store: ControlStore
    preflight: PreflightService
    strategy_configurations: StrategyConfigurationService
    clock: Callable[[], int]
    fixture_publisher: FixturePublisher
    cancellation: CancellationCoordinator
    recovery: FinalizationRecovery
    scheduler: CommandScheduler
    engine_identity: EngineIdentity
    event_retention_floor: EventRetentionFloor | None = None
    sse_heartbeat_seconds: float = DEFAULT_SSE_HEARTBEAT_SECONDS
    sse_heartbeat_limit: int | None = None
    run_review_service: RunReviewService | None = None
    historical: HistoricalControl | None = None


type DependencyFactory = Callable[[], ControlDependencies]


def get_dependencies(request: Request) -> ControlDependencies:
    dependencies = getattr(request.app.state, "control_dependencies", None)
    if type(dependencies) is not ControlDependencies:
        raise RuntimeError("Control dependencies are unavailable.")
    return dependencies


def historical_api_enabled() -> bool:
    value = os.environ.get("HISTORICAL_API_ENABLED", "0")
    if value not in {"0", "1"}:
        raise ValueError("HISTORICAL_API_ENABLED must be unset, 0 or 1.")
    return value == "1"


def validate_historical_dependencies(dependencies: ControlDependencies) -> None:
    """Reject split authority before the scheduler can recover any stored work."""
    historical = dependencies.historical
    if historical is None:
        return
    scheduler, store = dependencies.scheduler, dependencies.store
    if type(historical) is not HistoricalControl or type(scheduler) is not ApiCommandScheduler:
        raise ValueError("Historical HTTP requires the shared Control scheduler.")
    configurations = historical._preflights._configurations
    runtime = configurations._runtime_root
    if (
        historical._store is not store
        or historical._preflights._store is not store
        or configurations._store is not store
        or historical._supervisor._control is not store
        or historical._supervisor._cancellation._control is not store
        or historical._finalizer._store is not store
        or scheduler._store is not store
        or scheduler._historical is not historical
        or scheduler._cancellation is not dependencies.cancellation
        or dependencies.cancellation._control is not store
        or scheduler._recovery is not dependencies.recovery
        or dependencies.recovery._store is not store
        or scheduler._supervisor._control is not store
        or scheduler._supervisor._cancellation is not dependencies.cancellation
        or scheduler._engine_identity != dependencies.engine_identity
        or historical._supervisor._runtime_root != runtime
        or historical._finalizer._runtime != runtime
        or scheduler._supervisor._runtime_root != runtime
        or dependencies.recovery._runtime_root != runtime
    ):
        raise ValueError("Historical HTTP must share its store, runtime and scheduler graph.")


def build_default_dependencies(
    repository_root: Path, *, historical_enabled: bool | None = None
) -> ControlDependencies:
    """Build the single local authority from repository-contained paths."""

    enabled = historical_api_enabled() if historical_enabled is None else historical_enabled
    if type(enabled) is not bool:
        raise ValueError("Historical enablement must be an explicit boolean.")
    root = repository_root.resolve()
    runtime_root = root / "var" / "trading"
    run_root = runtime_root / "runs"
    runner_cwd = runtime_root / "runner-cwd"
    runtime_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    run_root.mkdir(mode=0o700, exist_ok=True)
    runner_cwd.mkdir(mode=0o700, exist_ok=True)
    runtime_root.chmod(0o700)
    run_root.chmod(0o700)
    runner_cwd.chmod(0o700)
    control_clock = time.time_ns
    store = ControlStore.open(runtime_root / "control.sqlite", clock=control_clock)
    try:
        publisher = FixturePublisher(
            registry=FixtureRegistry(root / "data" / "fixtures"),
            control=store,
            runtime_root=runtime_root,
        )
        engine = current_engine_identity()
        strategy_catalog = StrategyCatalog()
        strategy_configurations = StrategyConfigurationService(
            store=store,
            catalog=strategy_catalog,
            draft_id_factory=lambda: f"sd_{secrets.token_hex(16)}",
            configuration_id_factory=lambda: f"cfg_{secrets.token_hex(16)}",
        )
        risk = _definition("probe-risk", "v1", {"max_notional": "1600"})
        preflight = PreflightService(
            control=store,
            catalog=publisher,
            engine=engine,
            strategy_resolver=strategy_catalog.resolve,
            risk_resolver=lambda ref: risk if ref == "probe-risk@v1" else None,
            clock=control_clock,
            run_id_factory=lambda: f"bt_{secrets.token_hex(16)}",
            preflight_id_factory=lambda: f"pf_{secrets.token_hex(16)}",
            token_ttl_ns=300_000_000_000,
            run_root=run_root,
        )
        recovery = FinalizationRecovery(store=store, runtime_root=runtime_root)
        configured_model = os.environ.get("OPENAI_AGENT_MODEL")
        model_name = validate_model_name(configured_model) if configured_model is not None else None
        key_present = bool(os.environ.get("OPENAI_API_KEY"))
        reviewer = RunReviewer(model_name=model_name) if key_present and model_name else None
        run_review_service = RunReviewService(
            builder=IndependentEvidenceScopeBuilder(
                control_database=runtime_root / "control.sqlite",
                runtime_root=runtime_root,
            ),
            reviewer=reviewer,
        )
        cancellation = CancellationCoordinator(control=store)
        supervisor = RunnerSupervisor(
            control=store,
            runtime_root=runtime_root,
            python_executable=Path(sys.executable).absolute(),
            runner_cwd=runner_cwd,
            cancellation=cancellation,
        )
        historical = None
        if enabled:
            historical = HistoricalControl(
                store=store,
                configurations=HistoricalConfigurationService(
                    store=store,
                    runtime_root=runtime_root,
                    draft_id_factory=lambda: f"sd_{secrets.token_hex(16)}",
                    configuration_id_factory=lambda: f"cfg_{secrets.token_hex(16)}",
                ),
                runtime_root=runtime_root,
                python_executable=Path(sys.executable).absolute(),
                runner_cwd=runner_cwd,
            )
        scheduler = ApiCommandScheduler(
            store=store,
            supervisor=supervisor,
            cancellation=cancellation,
            recovery=recovery,
            engine_identity=engine,
            historical=historical,
        )
        return ControlDependencies(
            store=store,
            preflight=preflight,
            strategy_configurations=strategy_configurations,
            clock=control_clock,
            fixture_publisher=publisher,
            cancellation=cancellation,
            recovery=recovery,
            scheduler=scheduler,
            engine_identity=engine,
            run_review_service=run_review_service,
            historical=historical,
        )
    except BaseException:
        store.close()
        raise


def current_engine_identity() -> EngineIdentity:
    precision_mode = f"FIXED_PRECISION_{FIXED_PRECISION}"
    return EngineIdentity(
        package_version=importlib.metadata.version("nautilus_trader"),
        tag_commit=PINNED_ENGINE_TAG_COMMIT,
        python_version=".".join(str(item) for item in sys.version_info[:3]),
        precision_mode=precision_mode,
    )


def engine_identity_check(identity: EngineIdentity) -> str | None:
    if identity.package_version != PINNED_ENGINE_PACKAGE_VERSION:
        return "ENGINE_VERSION_MISMATCH"
    if identity.tag_commit != PINNED_ENGINE_TAG_COMMIT:
        return "ENGINE_TAG_MISMATCH"
    if identity.python_version != PINNED_ENGINE_PYTHON_VERSION:
        return "PYTHON_VERSION_MISMATCH"
    runtime = current_engine_identity()
    if identity.package_version != runtime.package_version:
        return "ENGINE_VERSION_MISMATCH"
    if identity.python_version != runtime.python_version:
        return "PYTHON_VERSION_MISMATCH"
    if (
        identity.precision_mode != PINNED_ENGINE_PRECISION_MODE
        or identity.precision_mode != runtime.precision_mode
        or HIGH_PRECISION != 1
    ):
        return "PRECISION_MODE_MISMATCH"
    return None


def control_package_version() -> str:
    return importlib.metadata.version("stark-trading-os-engine")


def _definition(identifier: str, version: str, value: dict[str, object]) -> RegisteredDefinition:
    raw = canonical_json_bytes(value)
    return RegisteredDefinition(
        identifier=identifier,
        version=version,
        canonical_bytes=raw,
        sha256=sha256(raw).hexdigest(),
    )
