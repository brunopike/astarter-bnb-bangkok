from __future__ import annotations

import asyncio
import os
import stat
import sys
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace

import pytest

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.catalog.fixture_publisher import open_catalog_service
from stark_trading_os.control.cancellation import CancellationCoordinator
from stark_trading_os.control.preflight import RunReservation
from stark_trading_os.control.process_identity import ProcessObservation, SupervisorExitV1
from stark_trading_os.control.registry import ControlStore, EventCandidate, EventRejected
from stark_trading_os.control.supervisor import (
    RunnerSupervisor,
    SupervisorError,
    stage_input_manifest,
)
from stark_trading_os.domain.models import CatalogManifestV1, InputManifestV1, RunState
from stark_trading_os.runner.protocol import (
    RunnerOutcomeV1,
    RunnerReportCandidateV1,
    encode_protocol_line,
)

FIXTURE_ROOT = Path(__file__).resolve().parents[5] / "data" / "fixtures"
EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


class StepClock:
    def __init__(self, value: int = 10_000) -> None:
        self.value = value

    def __call__(self) -> int:
        value = self.value
        self.value += 1
        return value


class FakeProcess:
    def __init__(self, *, stdout: bytes, stderr: bytes = b"", returncode: int = 0) -> None:
        self.pid = 501
        self.stdout = asyncio.StreamReader(limit=65_537)
        self.stdout.feed_data(stdout)
        self.stdout.feed_eof()
        self.stderr = asyncio.StreamReader(limit=65_537)
        self.stderr.feed_data(stderr)
        self.stderr.feed_eof()
        self.returncode: int | None = None
        self._final_returncode = returncode

    async def wait(self) -> int:
        self.returncode = self._final_returncode
        return self._final_returncode


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


def prepare_reservation(
    tmp_path: Path,
    *,
    run_id: str,
    replay_seed: int = 7,
) -> tuple[ControlStore, RunReservation, Path, Path]:
    runtime = tmp_path / "runtime"
    publisher, store = open_catalog_service(
        fixture_root=FIXTURE_ROOT,
        runtime_root=runtime,
        clock=StepClock(),
    )
    publication = publisher.publish("determinism-probe-v1")
    catalog = CatalogManifestV1.model_validate_json(publication.publication_bytes)
    strategy = _strategy()
    risk = {"max_notional": "1600"}
    instrument = catalog.inventory.instrument
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
                "end_ns": catalog.inventory.readback.last_ts_init,
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
            "replay_seed": replay_seed,
        }
    )
    manifest_bytes = canonical_json_bytes(manifest.model_dump(mode="json", by_alias=True))
    manifest_hash = sha256(manifest_bytes).hexdigest()
    store.reserve_run(
        run_id=run_id,
        input_manifest_bytes=manifest_bytes,
        input_manifest_hash=manifest_hash,
        catalog_revision=publication.catalog_revision,
        catalog_inventory_hash=publication.inventory_hash,
    )
    store.commit_transition(
        run_id=run_id,
        expected_version=0,
        target=RunState.PREFLIGHT_READY,
        candidate=EventCandidate.control(type="preflight.passed", ts_event_ns="10", payload={}),
    )
    store.commit_transition(
        run_id=run_id,
        expected_version=1,
        target=RunState.QUEUED,
        candidate=EventCandidate.control(type="run.queued", ts_event_ns="11", payload={}),
    )
    service_cwd = runtime / "service-cwd"
    service_cwd.mkdir(mode=0o700)
    return (
        store,
        RunReservation(
            run_id=run_id,
            state=RunState.QUEUED,
            state_version=2,
            last_visible_seq=2,
            input_manifest_bytes=manifest_bytes,
            input_manifest_hash=manifest_hash,
        ),
        runtime,
        service_cwd,
    )


def fake_observation(pid: int = 501) -> ProcessObservation:
    return ProcessObservation(
        platform="darwin",
        pid=pid,
        ppid=os.getpid(),
        pgid=pid,
        sid=pid,
        start_token="darwin:1700000000:123456",
        executable_path=str(Path(sys.executable).resolve()),
        executable_device=os.stat(sys.executable).st_dev,
        executable_inode=os.stat(sys.executable).st_ino,
    )


def success_stdout(reservation: RunReservation, catalog_revision: str) -> bytes:
    reports = tuple(
        RunnerReportCandidateV1(
            name=name,
            relative_path=f"reports/{name}.json",
            sha256=str(index) * 64,
            size_bytes=index,
        )
        for index, name in enumerate(
            ("orders", "fills", "positions", "account", "metrics"), start=1
        )
    )
    outcome = RunnerOutcomeV1.model_validate(
        {
            "schema": "RunnerOutcome.v1",
            "run_id": reservation.run_id,
            "input_manifest_hash": reservation.input_manifest_hash,
            "catalog_revision": catalog_revision,
            "engine_package_version": "2.0.0rc3",
            "result": "SUCCEEDED",
            "last_source_seq": 0,
            "report_candidates": [item.model_dump(mode="json") for item in reports],
            "failure": None,
        }
    )
    return encode_protocol_line(outcome)


def make_supervisor(
    *,
    store: ControlStore,
    runtime: Path,
    service_cwd: Path,
    nonce: str = "spawn-supervisor",
) -> RunnerSupervisor:
    def forbid_fake_group_signal(_pgid: int, _number: int) -> None:
        raise AssertionError("a completed fake process must not be signaled")

    return RunnerSupervisor(
        control=store,
        runtime_root=runtime,
        python_executable=Path(sys.executable),
        runner_cwd=service_cwd,
        clock=StepClock(20_000),
        spawn_nonce_factory=lambda: nonce,
        identity_observer=lambda pid, _path: fake_observation(pid),
        cancellation=CancellationCoordinator(
            control=store,
            identity_observer=lambda pid, _path: fake_observation(pid),
            signal_sender=forbid_fake_group_signal,
            group_is_live=lambda _identity: False,
        ),
        run_timeout_seconds=5,
    )


def test_commit_and_claim_precede_exact_no_shell_minimal_environment_spawn(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_spawn", replay_seed=2**32 + 17
    )
    second = ControlStore.open(runtime / "control.sqlite")
    captured: list[tuple[tuple[object, ...], dict[str, object]]] = []
    catalog_revision = store.run(reservation.run_id).catalog_revision
    assert catalog_revision is not None

    async def launch(*args: object, **kwargs: object) -> FakeProcess:
        claim = second.runner_process(reservation.run_id)
        assert claim is not None and not claim.created_by_caller and claim.pid is None
        assert second.run(reservation.run_id).state is RunState.QUEUED
        captured.append((args, kwargs))
        return FakeProcess(stdout=success_stdout(reservation, catalog_revision))

    monkeypatch.setenv("OPENAI_API_KEY", "sk-parent-secret")
    monkeypatch.setenv("CHAIN_RPC_URL", "https://credential.invalid")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    try:
        result = asyncio.run(
            make_supervisor(
                store=store,
                runtime=runtime,
                service_cwd=service_cwd,
            ).run(reservation)
        )
        assert result.created_by_caller and result.spawned
        assert result.state is RunState.FINALIZING
        assert len(captured) == 1
        args, kwargs = captured[0]
        staging = runtime / "staging" / reservation.run_id
        assert args == (
            str(Path(sys.executable).absolute()),
            "-s",
            "-P",
            "-B",
            "-u",
            "-m",
            "stark_trading_os.runner.main",
            "--run-id",
            reservation.run_id,
            "--staging-dir",
            str(staging),
            "--input-manifest",
            str(staging / "input-manifest.json"),
        )
        assert kwargs["stdin"] is asyncio.subprocess.DEVNULL
        assert kwargs["stdout"] is asyncio.subprocess.PIPE
        assert kwargs["stderr"] is asyncio.subprocess.PIPE
        assert kwargs["close_fds"] is True
        assert kwargs["start_new_session"] is True
        assert kwargs["cwd"] == str(service_cwd)
        assert kwargs["env"] == {
            "LANG": "C",
            "LC_ALL": "C",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONHASHSEED": "17",
            "PYTHONNOUSERSITE": "1",
            "PYTHONUNBUFFERED": "1",
            "TZ": "UTC",
        }
    finally:
        second.close()
        store.close()


def test_manifest_is_exact_private_durable_and_extra_prelaunch_object_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(tmp_path, run_id="bt_staging")
    staging = stage_input_manifest(runtime_root=runtime, reservation=reservation)
    manifest_path = staging / "input-manifest.json"
    metadata = manifest_path.stat(follow_symlinks=False)
    assert manifest_path.read_bytes() == reservation.input_manifest_bytes
    assert stat.S_IMODE(metadata.st_mode) == 0o600
    assert metadata.st_nlink == 1
    assert stat.S_IMODE(staging.stat().st_mode) == 0o700
    assert stage_input_manifest(runtime_root=runtime, reservation=reservation) == staging

    (staging / "unexpected.txt").write_text("not trusted", encoding="utf-8")
    spawn_calls = 0

    async def forbidden_spawn(*_args: object, **_kwargs: object) -> FakeProcess:
        nonlocal spawn_calls
        spawn_calls += 1
        raise AssertionError("spawn must not occur")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", forbidden_spawn)
    try:
        with pytest.raises(SupervisorError, match="STAGING_INVALID"):
            asyncio.run(
                make_supervisor(
                    store=store,
                    runtime=runtime,
                    service_cwd=service_cwd,
                ).run(reservation)
            )
        assert spawn_calls == 0
        assert store.runner_process(reservation.run_id) is None
    finally:
        store.close()


@pytest.mark.parametrize("attack", ["symlink", "hardlink", "mode", "owner"])
def test_manifest_retry_rejects_unsafe_metadata(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    attack: str,
) -> None:
    case_root = tmp_path / attack
    case_root.mkdir()
    store, reservation, runtime, _service_cwd = prepare_reservation(
        case_root,
        run_id=f"bt_manifest_{attack}",
    )
    staging = stage_input_manifest(runtime_root=runtime, reservation=reservation)
    manifest_path = staging / "input-manifest.json"
    try:
        if attack == "symlink":
            target = runtime / "attacker-manifest.json"
            target.write_bytes(reservation.input_manifest_bytes)
            target.chmod(0o600)
            manifest_path.unlink()
            manifest_path.symlink_to(target)
        elif attack == "hardlink":
            os.link(manifest_path, runtime / "manifest-hardlink.json")
        elif attack == "mode":
            manifest_path.chmod(0o640)
        else:
            target_inode = manifest_path.stat().st_ino
            real_fstat = os.fstat

            def wrong_manifest_owner(descriptor: int):
                metadata = real_fstat(descriptor)
                if metadata.st_ino != target_inode:
                    return metadata
                return SimpleNamespace(
                    st_mode=metadata.st_mode,
                    st_uid=metadata.st_uid + 1,
                    st_nlink=metadata.st_nlink,
                    st_size=metadata.st_size,
                )

            monkeypatch.setattr(os, "fstat", wrong_manifest_owner)
        with pytest.raises(SupervisorError, match="STAGING_INVALID"):
            stage_input_manifest(runtime_root=runtime, reservation=reservation)
    finally:
        store.close()


def test_supervisor_timeout_rejects_nan_as_non_finite(tmp_path: Path) -> None:
    store, _reservation, runtime, service_cwd = prepare_reservation(
        tmp_path,
        run_id="bt_nan_timeout",
    )
    try:
        with pytest.raises(ValueError, match="positive finite"):
            RunnerSupervisor(
                control=store,
                runtime_root=runtime,
                python_executable=Path(sys.executable),
                runner_cwd=service_cwd,
                run_timeout_seconds=float("nan"),
            )
    finally:
        store.close()


def test_two_controllers_reuse_manifest_but_only_insert_winner_spawns(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(tmp_path, run_id="bt_duplicate")
    second = ControlStore.open(runtime / "control.sqlite", clock=StepClock(30_000))
    catalog_revision = store.run(reservation.run_id).catalog_revision
    assert catalog_revision is not None
    spawn_calls = 0

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        nonlocal spawn_calls
        spawn_calls += 1
        await asyncio.sleep(0)
        return FakeProcess(stdout=success_stdout(reservation, catalog_revision))

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)

    async def run_both():
        return await asyncio.gather(
            make_supervisor(
                store=store,
                runtime=runtime,
                service_cwd=service_cwd,
                nonce="spawn-left",
            ).run(reservation),
            make_supervisor(
                store=second,
                runtime=runtime,
                service_cwd=service_cwd,
                nonce="spawn-right",
            ).run(reservation),
        )

    try:
        results = asyncio.run(run_both())
        assert sum(result.created_by_caller for result in results) == 1
        assert sum(result.spawned for result in results) == 1
        assert spawn_calls == 1
        assert store.run(reservation.run_id).state is RunState.FINALIZING
    finally:
        second.close()
        store.close()


def test_real_task7_module_persists_candidates_exit_files_and_finalizing_only(
    tmp_path: Path,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_real_supervisor"
    )
    supervisor = RunnerSupervisor(
        control=store,
        runtime_root=runtime,
        python_executable=Path(sys.executable),
        runner_cwd=service_cwd,
        run_timeout_seconds=30,
    )
    try:
        result = asyncio.run(supervisor.run(reservation))
        staging = runtime / "staging" / reservation.run_id
        assert result.state is RunState.FINALIZING
        assert store.run(reservation.run_id).state is RunState.FINALIZING
        assert store.runner_outcome(reservation.run_id) is not None
        assert (staging / "stderr.txt").read_bytes() == b""
        assert (staging / "runner-exit.json").is_file()
        events = store.events(reservation.run_id)
        assert [event.type for event in events][-1] == "run.finalizing"
        runner_events = [event for event in events if event.source == "runner"]
        assert runner_events
        assert [event.source_seq for event in runner_events] == list(
            range(1, len(runner_events) + 1)
        )
        assert [event.seq for event in events] == list(range(1, len(events) + 1))
        assert all(event.visible for event in events)
        assert len(store.audit_intents(reservation.run_id)) == len(events)
        assert len(store.pending_outbox(reservation.run_id)) == len(events)
        persisted = store.runner_outcome(reservation.run_id)
        assert persisted is not None
        assert persisted.outcome.stderr_sha256 == EMPTY_SHA256
        event_count = len(events)
        assert store.record_runner_outcome(persisted.outcome) == persisted
        changed = persisted.outcome.model_dump(mode="json")
        changed["ended_at_ns"] += 1
        changed["duration_ns"] += 1
        with pytest.raises(EventRejected, match="different runner outcome"):
            store.record_runner_outcome(SupervisorExitV1.model_validate(changed))
        assert len(store.events(reservation.run_id)) == event_count
    finally:
        store.close()


def test_real_task7_exact_exit_recovery_allows_task7_reports_for_task9(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_real_exit_recovery"
    )
    supervisor = RunnerSupervisor(
        control=store,
        runtime_root=runtime,
        python_executable=Path(sys.executable),
        runner_cwd=service_cwd,
        run_timeout_seconds=30,
    )
    record_outcome = store.record_runner_outcome

    class ControllerCrash(RuntimeError):
        pass

    def crash_after_exact_files(_outcome: SupervisorExitV1) -> None:
        raise ControllerCrash("after exact files before SQLite outcome")

    monkeypatch.setattr(store, "record_runner_outcome", crash_after_exact_files)
    try:
        with pytest.raises(ControllerCrash, match="before SQLite outcome"):
            asyncio.run(supervisor.run(reservation))
        staging = runtime / "staging" / reservation.run_id
        assert {path.name for path in (staging / "reports").iterdir()} == {
            "account.json",
            "fills.json",
            "metrics.json",
            "orders.json",
            "positions.json",
        }
        assert (staging / "runner-exit.pending").is_file()
        assert not (staging / "runner-exit.json").exists()
        assert store.runner_outcome(reservation.run_id) is None

        monkeypatch.setattr(store, "record_runner_outcome", record_outcome)
        recovered = asyncio.run(supervisor.recover_one(reservation.run_id))
        assert recovered is not None
        assert recovered.state is RunState.FINALIZING
        assert recovered.outcome is not None
        assert recovered.outcome.outcome.classification == "NATURAL_SUCCESS"
        assert not (staging / "runner-exit.pending").exists()
        assert (staging / "runner-exit.json").read_bytes() == recovered.outcome.outcome_bytes
    finally:
        store.close()


def test_runner_supervisor_contract_is_available() -> None:
    assert RunnerSupervisor is not None
