from __future__ import annotations

import shutil
from collections.abc import Iterator
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path
from typing import Literal, cast

import pytest
from fastapi.testclient import TestClient

from stark_trading_os.agent.evidence_scope import IndependentEvidenceScopeBuilder
from stark_trading_os.agent.service import RunReviewService
from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.audit.materializer import CanonicalMaterializer
from stark_trading_os.catalog.fixture_publisher import FixturePublisher
from stark_trading_os.catalog.fixture_registry import FixtureRegistry
from stark_trading_os.control.app import create_app
from stark_trading_os.control.cancellation import (
    CancellationCoordinator,
    TerminationObservation,
)
from stark_trading_os.control.dependencies import ControlDependencies
from stark_trading_os.control.finalizer import Finalizer
from stark_trading_os.control.preflight import (
    EngineIdentity,
    PreflightService,
    RegisteredDefinition,
    RunReservation,
)
from stark_trading_os.control.process_identity import (
    ProcessIdentityV1,
    SupervisorExitV1,
    process_identity_digest,
)
from stark_trading_os.control.recovery import FinalizationRecovery
from stark_trading_os.control.registry import CatalogPublication, ControlStore
from stark_trading_os.control.strategy_configurations import (
    StrategyCatalog,
    StrategyConfigurationService,
)
from stark_trading_os.control.transactions import IdempotencyCommand, PersistedCancelRequest
from stark_trading_os.domain.models import BacktestDraftRequest
from stark_trading_os.runner.protocol import RunnerOutcomeV1, RunnerReportCandidateV1
from stark_trading_os.runner.report_export import export_metrics, normalize_report_row

ORIGIN = "http://127.0.0.1:3000"
REPOSITORY_ROOT = Path(__file__).parents[5]


class SequentialIds:
    def __init__(self, prefix: str) -> None:
        self.prefix = prefix
        self.calls = 0

    def __call__(self) -> str:
        self.calls += 1
        return f"{self.prefix}_{self.calls:03d}"


class SequentialHexIds(SequentialIds):
    def __call__(self) -> str:
        self.calls += 1
        return f"{self.prefix}_{self.calls:032x}"


class CountingCatalog:
    def __init__(self, publisher: FixturePublisher) -> None:
        self.publisher = publisher

    def revalidate(self, catalog_revision: str) -> CatalogPublication:
        return self.publisher.revalidate(catalog_revision)


@dataclass
class RecordingScheduler:
    store: ControlStore
    reservations: list[RunReservation] = field(default_factory=list)
    cancellations: list[PersistedCancelRequest] = field(default_factory=list)
    reconciliations: list[str] = field(default_factory=list)

    def schedule_run(self, reservation: RunReservation) -> None:
        assert self.store.run(reservation.run_id).state.value == "QUEUED"
        self.reservations.append(reservation)

    def schedule_cancel(self, decision: PersistedCancelRequest) -> None:
        assert self.store.run(decision.response.run_id or "").state == decision.state
        self.cancellations.append(decision)

    def reconcile_run(self, run_id: str) -> None:
        assert self.store.run(run_id).run_id == run_id
        self.reconciliations.append(run_id)

    def unavailable_reason(self) -> str | None:
        return None


class RecordingCancellation(CancellationCoordinator):
    def __init__(self, *, control: ControlStore) -> None:
        super().__init__(control=control)
        self.request_calls = 0
        self.terminate_calls = 0

    def request(
        self,
        *,
        run_id: str,
        idempotency_key: str,
        reason: str,
    ) -> PersistedCancelRequest:
        self.request_calls += 1
        return super().request(
            run_id=run_id,
            idempotency_key=idempotency_key,
            reason=reason,
        )

    async def terminate(self, decision: PersistedCancelRequest) -> TerminationObservation:
        self.terminate_calls += 1
        return await super().terminate(decision)


@dataclass
class ApiHarness:
    database: Path
    runtime_root: Path
    run_root: Path
    scheduler: RecordingScheduler | None = None
    cancellation: RecordingCancellation | None = None


def _definition(identifier: str, version: str, value: dict[str, object]) -> RegisteredDefinition:
    raw = canonical_json_bytes(value)
    return RegisteredDefinition(
        identifier=identifier,
        version=version,
        canonical_bytes=raw,
        sha256=sha256(raw).hexdigest(),
    )


def _dependencies(harness: ApiHarness) -> ControlDependencies:
    harness.runtime_root.mkdir(parents=True, exist_ok=True)
    harness.run_root.mkdir(parents=True, exist_ok=True)
    harness.runtime_root.chmod(0o700)
    harness.run_root.chmod(0o700)
    application_clock = SequentialIdsAsClock(1_700_000_000_000_000_000)
    store = ControlStore.open(harness.database, clock=application_clock)
    publisher = FixturePublisher(
        registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
        control=store,
        runtime_root=harness.runtime_root,
    )
    engine = EngineIdentity(
        package_version="2.0.0rc3",
        tag_commit="648970ce64a304d93da0a29320cb6e19b905fa39",
        python_version="3.12.4",
        precision_mode="FIXED_PRECISION_16",
    )
    strategy_catalog = StrategyCatalog()
    strategy_configurations = StrategyConfigurationService(
        store=store,
        catalog=strategy_catalog,
        draft_id_factory=SequentialHexIds("sd"),
        configuration_id_factory=SequentialHexIds("cfg"),
    )
    risk = _definition("probe-risk", "v1", {"max_notional": "1600"})
    preflight = PreflightService(
        control=store,
        catalog=CountingCatalog(publisher),
        engine=engine,
        strategy_resolver=strategy_catalog.resolve,
        risk_resolver=lambda ref: risk if ref == "probe-risk@v1" else None,
        clock=application_clock,
        run_id_factory=SequentialIds("bt"),
        preflight_id_factory=SequentialIds("pf"),
        token_ttl_ns=1_000_000,
        run_root=harness.run_root,
    )
    scheduler = RecordingScheduler(store)
    cancellation = RecordingCancellation(control=store)
    harness.scheduler = scheduler
    harness.cancellation = cancellation
    recovery = FinalizationRecovery(store=store, runtime_root=harness.runtime_root)
    return ControlDependencies(
        store=store,
        preflight=preflight,
        strategy_configurations=strategy_configurations,
        clock=application_clock,
        fixture_publisher=publisher,
        cancellation=cancellation,
        recovery=recovery,
        scheduler=scheduler,
        engine_identity=engine,
        run_review_service=RunReviewService(
            builder=IndependentEvidenceScopeBuilder(
                control_database=harness.database,
                runtime_root=harness.runtime_root,
            ),
            reviewer=None,
        ),
        sse_heartbeat_seconds=0.001,
        sse_heartbeat_limit=1,
    )


class SequentialIdsAsClock:
    def __init__(self, value: int = 1_700_000_000_000_000_000) -> None:
        self.value = value
        self.calls = 0

    def __call__(self) -> int:
        value = self.value
        self.value += 1
        self.calls += 1
        return value


@pytest.fixture
def api_harness(tmp_path: Path) -> ApiHarness:
    runtime_root = tmp_path / "runtime"
    return ApiHarness(
        database=tmp_path / "control.sqlite",
        runtime_root=runtime_root,
        run_root=runtime_root / "runs",
    )


@pytest.fixture
def client(api_harness: ApiHarness) -> Iterator[TestClient]:
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as active:
        yield active


@pytest.fixture
def draft() -> dict[str, object]:
    return {
        "environment": "BACKTEST",
        "strategy_ref": "determinism-probe@v1",
        "catalog_revision": "a" * 64,
        "window": {"start_ns": "1700000000000000000", "end_ns": "1700000000000000002"},
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
        "cost_fill_model": {
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
        },
        "risk_policy_ref": "probe-risk@v1",
        "replay_seed": 7,
    }


def publish(client: TestClient) -> dict[str, object]:
    response = client.post("/v1/catalogs/fixtures/local-qa-v1/publish")
    assert response.status_code == 201
    return cast(dict[str, object], response.json())


def ready_preflight(client: TestClient, draft: dict[str, object]) -> dict[str, object]:
    publication = publish(client)
    request = dict(draft)
    request["catalog_revision"] = publication["catalog_revision"]
    response = client.post(
        "/v1/backtests/preflight",
        headers={"Idempotency-Key": "preflight-ready"},
        json=request,
    )
    assert response.status_code == 200
    assert response.json()["state"] == "PREFLIGHT_READY"
    return cast(dict[str, object], response.json())


def queued_run(client: TestClient, draft: dict[str, object]) -> dict[str, object]:
    preflight = ready_preflight(client, draft)
    response = client.post(
        "/v1/backtests",
        headers={"Idempotency-Key": "create-ready"},
        json={
            "preflight_id": preflight["preflight_id"],
            "canonical_request_hash": preflight["canonical_request_hash"],
        },
    )
    assert response.status_code == 202
    return cast(dict[str, object], response.json())


def seed_verified_cancelled_run(harness: ApiHarness, *, run_id: str) -> bytes:
    actual_run_id, expected = _seed_cancelled_run(harness, run_id=run_id, verified=True)
    assert actual_run_id
    assert expected is not None
    return expected


def seed_verified_terminal_run(
    harness: ApiHarness,
    *,
    run_id: str,
    terminal_state: Literal["COMPLETED", "FAILED"],
) -> str:
    if terminal_state not in {"COMPLETED", "FAILED"}:
        raise ValueError("terminal_state must be COMPLETED or FAILED")
    dependencies = _dependencies(harness)
    try:
        publication = dependencies.fixture_publisher.publish("local-qa-v1")
        request = draft_payload()
        request["catalog_revision"] = publication.catalog_revision
        preflight = dependencies.preflight.run(
            BacktestDraftRequest.model_validate(request),
            idempotency_key=f"preflight-{run_id}",
        )
        reservation = dependencies.preflight.consume_ready(
            preflight.preflight_id,
            preflight.canonical_request_hash,
            idempotency_key=f"create-{run_id}",
        )
        actual_run_id = reservation.run_id
        spawn_nonce = f"spawn-{run_id}"
        dependencies.store.claim_runner_process(
            run_id=actual_run_id,
            spawn_nonce=spawn_nonce,
        )
        identity = ProcessIdentityV1(
            run_id=actual_run_id,
            spawn_nonce=spawn_nonce,
            pid=701,
            ppid=1,
            pgid=701,
            sid=701,
            platform="darwin",
            start_token="darwin:1700000000:123456",
            configured_executable_path="/service/venv/bin/python",
            observed_executable_path="/service/venv/bin/python",
            executable_device=7,
            executable_inode=11,
        )
        attached = dependencies.store.attach_runner_process(identity=identity)
        report_bytes = _analyst_report_bytes() if terminal_state == "COMPLETED" else {}
        candidates = [
            RunnerReportCandidateV1(
                name=relative_path.removeprefix("reports/").removesuffix(".json"),  # type: ignore[arg-type]
                relative_path=relative_path,
                sha256=sha256(payload).hexdigest(),
                size_bytes=len(payload),
            )
            for relative_path, payload in report_bytes.items()
        ]
        child = RunnerOutcomeV1.model_validate(
            {
                "schema": "RunnerOutcome.v1",
                "run_id": actual_run_id,
                "input_manifest_hash": reservation.input_manifest_hash,
                "catalog_revision": publication.catalog_revision,
                "engine_package_version": "2.0.0rc3",
                "result": "SUCCEEDED" if terminal_state == "COMPLETED" else "FAILED",
                "last_source_seq": 0,
                "report_candidates": [
                    candidate.model_dump(mode="json", by_alias=True) for candidate in candidates
                ],
                "failure": (
                    None
                    if terminal_state == "COMPLETED"
                    else {"code": "RUNNER_EXECUTION_FAILED", "message": "fixture failure"}
                ),
            }
        )
        outcome = SupervisorExitV1(
            run_id=actual_run_id,
            spawn_nonce=spawn_nonce,
            process_identity_sha256=process_identity_digest(identity),
            launched_at_ns=attached.launched_at_ns,
            ended_at_ns=(attached.launched_at_ns or 100) + 1,
            duration_ns=1,
            exit_code=0 if terminal_state == "COMPLETED" else 1,
            signal=None,
            final_cancel_phase="NONE",
            stdout_size_bytes=0,
            stderr_size_bytes=0,
            stderr_sha256=sha256(b"").hexdigest(),
            stderr_truncated=False,
            child_outcome=child,
            classification=(
                "NATURAL_SUCCESS" if terminal_state == "COMPLETED" else "NATURAL_FAILURE"
            ),
            failure_code=None if terminal_state == "COMPLETED" else "CHILD_REPORTED_FAILURE",
            proposed_terminal_state=terminal_state,
        )
        dependencies.store.record_runner_outcome(outcome)
        preparation = dependencies.store.prepare_terminal(run_id=actual_run_id)
        snapshot = dependencies.store.run(actual_run_id)
        assert snapshot.input_manifest_bytes is not None
        staging = harness.runtime_root / "staging" / actual_run_id
        staging.mkdir(parents=True, mode=0o700)
        staging.parent.chmod(0o700)
        for name, payload in (
            ("input-manifest.json", snapshot.input_manifest_bytes),
            ("runner-exit.json", preparation.outcome.outcome_bytes),
            ("stderr.txt", b""),
        ):
            path = staging / name
            path.write_bytes(payload)
            path.chmod(0o600)
        for relative_path, payload in report_bytes.items():
            path = staging / relative_path
            path.parent.mkdir(mode=0o700, exist_ok=True)
            path.write_bytes(payload)
            path.chmod(0o600)
        if terminal_state == "COMPLETED":
            CanonicalMaterializer(
                store=dependencies.store,
                runtime_root=harness.runtime_root,
            ).build_verify_and_rename(preparation=preparation)
            shutil.rmtree(staging)
            result = next(
                item for item in dependencies.recovery.recover() if item.run_id == actual_run_id
            )
        else:
            result = Finalizer(
                store=dependencies.store,
                runtime_root=harness.runtime_root,
            ).finalize(actual_run_id)
        assert dependencies.store.run(actual_run_id).state.value == terminal_state, result
        return actual_run_id
    finally:
        dependencies.store.close()


def _analyst_report_bytes() -> dict[str, bytes]:
    account = normalize_report_row(
        "account",
        {
            "ts_event_ns": "100",
            "total": "1000000",
            "locked": "0",
            "free": "1000000",
            "currency": "USDT",
            "account_id": "SIM-001",
            "account_type": "MARGIN",
            "margins": [
                {
                    "type": "MarginBalance",
                    "initial": "0",
                    "maintenance": "0",
                    "currency": "USDT",
                    "instrument_id": "ETH/USDT.SIM",
                }
            ],
            "reported": True,
            "info": {},
            "base_currency": "None",
        },
    )
    metrics = export_metrics(
        {
            "summary": {
                "orders.total": "0",
                "orders.closed": "0",
                "orders.inflight": "0",
                "orders.emulated": "0",
                "orders.open": "0",
                "positions.total": "0",
                "positions.total_with_snapshots": "0",
                "positions.open": "0",
                "positions.closed": "0",
                "positions.snapshots": "0",
                "total_events": "1",
                "iterations": "1",
                "venues.total": "1",
                "account.SIM.id": "SIM-001",
                "account.SIM.type": "MARGIN",
                "account.SIM.event_count": "1",
                "account.SIM.base_currency": "None",
                "account.SIM.balance.USDT.total": "1000000 USDT",
                "account.SIM.balance.USDT.locked": "0 USDT",
                "account.SIM.balance.USDT.free": "1000000 USDT",
            },
            "stats_pnls": {"USDT": {"PnL (total)": "0", "PnL% (total)": "0"}},
            "stats_returns": {
                "Sortino Ratio (252 days)": "0",
                "Tail Ratio": "0",
                "Average Loss (Return)": "0",
                "Average (Return)": "0",
                "Sharpe Ratio (252 days)": "0",
                "Average Win (Return)": "0",
                "Returns Kurtosis": "0",
                "Profit Factor": "0",
                "Returns Volatility (252 days)": "0",
                "Risk Return Ratio": "0",
                "Returns Skewness": "0",
            },
            "stats_general": {},
            "performance_series": {
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
                        "ts_event_ns": "100",
                        "equity_amount": "1000000",
                        "drawdown_pct": "0",
                        "is_stale": False,
                        "stale_instruments": [],
                        "stale_currencies": [],
                        "unpriced_instruments": [],
                    }
                ],
            },
        }
    )
    return {
        "reports/orders.json": canonical_json_bytes([]),
        "reports/fills.json": canonical_json_bytes([]),
        "reports/positions.json": canonical_json_bytes([]),
        "reports/account.json": canonical_json_bytes([account]),
        "reports/metrics.json": canonical_json_bytes(metrics),
    }


def seed_hidden_cancelled_run(harness: ApiHarness, *, run_id: str) -> str:
    actual_run_id, expected = _seed_cancelled_run(harness, run_id=run_id, verified=False)
    assert expected is None
    return actual_run_id


def seed_cancelled_runs(
    harness: ApiHarness,
    *,
    verified: tuple[bool, ...],
) -> tuple[str, ...]:
    dependencies = _dependencies(harness)
    try:
        return tuple(
            _seed_cancelled_run_on_dependencies(
                harness,
                dependencies,
                run_id=f"review-set-{index}",
                verified=is_verified,
            )[0]
            for index, is_verified in enumerate(verified, start=1)
        )
    finally:
        dependencies.store.close()


def seed_staged_finalizing_run(harness: ApiHarness, *, run_id: str) -> str:
    actual_run_id, expected = _seed_cancelled_run(
        harness,
        run_id=run_id,
        verified=False,
        stage=True,
    )
    assert expected is None
    return actual_run_id


def _seed_cancelled_run(
    harness: ApiHarness,
    *,
    run_id: str,
    verified: bool,
    stage: bool = False,
) -> tuple[str, bytes | None]:
    dependencies = _dependencies(harness)
    try:
        return _seed_cancelled_run_on_dependencies(
            harness,
            dependencies,
            run_id=run_id,
            verified=verified,
            stage=stage,
        )
    finally:
        dependencies.store.close()


def _seed_cancelled_run_on_dependencies(
    harness: ApiHarness,
    dependencies: ControlDependencies,
    *,
    run_id: str,
    verified: bool,
    stage: bool = False,
) -> tuple[str, bytes | None]:
    publication = dependencies.fixture_publisher.publish("local-qa-v1")
    request = draft_payload()
    request["catalog_revision"] = publication.catalog_revision
    preflight = dependencies.preflight.run(
        BacktestDraftRequest.model_validate(request),
        idempotency_key=f"preflight-{run_id}",
    )
    reservation = dependencies.preflight.consume_ready(
        preflight.preflight_id,
        preflight.canonical_request_hash,
        idempotency_key=f"create-{run_id}",
    )
    assert reservation.run_id.startswith("bt_")
    actual_run_id = reservation.run_id
    decision = dependencies.store.request_runner_cancel(
        command=IdempotencyCommand.cancel(
            run_id=actual_run_id,
            key=f"cancel-{run_id}",
            canonical_request_bytes=canonical_json_bytes({"reason": "test"}),
        ),
        reason="test",
    )
    assert decision.clean_no_claim
    outcome = SupervisorExitV1(
        run_id=actual_run_id,
        spawn_nonce=None,
        process_identity_sha256=None,
        launched_at_ns=None,
        ended_at_ns=100,
        duration_ns=0,
        exit_code=None,
        signal=None,
        final_cancel_phase="REQUESTED",
        stdout_size_bytes=0,
        stderr_size_bytes=0,
        stderr_sha256=sha256(b"").hexdigest(),
        stderr_truncated=False,
        child_outcome=None,
        classification="NO_SPAWN_CANCELLED",
        failure_code=None,
        proposed_terminal_state="CANCELLED",
    )
    dependencies.store.record_runner_outcome(outcome)
    preparation = dependencies.store.prepare_terminal(run_id=actual_run_id)
    if not verified and not stage:
        return actual_run_id, None
    snapshot = dependencies.store.run(actual_run_id)
    assert snapshot.input_manifest_bytes is not None
    staging = harness.runtime_root / "staging" / actual_run_id
    staging.mkdir(parents=True, mode=0o700)
    staging.parent.chmod(0o700)
    staging.chmod(0o700)
    expected = preparation.run_record
    assert expected is not None
    for name, payload in (
        ("input-manifest.json", snapshot.input_manifest_bytes),
        ("runner-exit.json", preparation.outcome.outcome_bytes),
        ("stderr.txt", b""),
    ):
        path = staging / name
        path.write_bytes(payload)
        path.chmod(0o600)
    if not verified:
        return actual_run_id, None
    publication_result = Finalizer(
        store=dependencies.store,
        runtime_root=harness.runtime_root,
    ).finalize(actual_run_id)
    assert publication_result.run_id == actual_run_id
    return (
        actual_run_id,
        canonical_json_bytes(expected.model_dump(mode="json", by_alias=True)),
    )


def draft_payload() -> dict[str, object]:
    # Keep one literal constructor so non-fixture setup can seed real authority.
    return {
        "environment": "BACKTEST",
        "strategy_ref": "determinism-probe@v1",
        "catalog_revision": "a" * 64,
        "window": {"start_ns": "1700000000000000000", "end_ns": "1700000000000000002"},
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
        "cost_fill_model": {
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
        },
        "risk_policy_ref": "probe-risk@v1",
        "replay_seed": 7,
    }
