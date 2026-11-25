from __future__ import annotations

import hashlib
import signal
import subprocess
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

import stark_trading_os.control.process_identity as process_identity_module
from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.control.process_identity import (
    ProcessIdentityV1,
    ProcessObservation,
    RunnerOutcomeRecord,
    RunnerProcessRecord,
    SupervisorExitV1,
    UnresolvedProcessGroupV1,
    capture_process_identity,
    process_identity_bytes,
    process_identity_digest,
    unresolved_process_group_bytes,
    unresolved_process_group_from_bytes,
    verified_signal_process_group,
    verify_process_identity,
)


def _observation(
    *,
    pid: int = 501,
    ppid: int = 41,
    start_token: str = "darwin:1700000000:123456",
    executable_path: str = "/opt/stark/python3.12",
    executable_device: int = 7,
    executable_inode: int = 11,
    pgid: int = 501,
    sid: int = 501,
) -> ProcessObservation:
    return ProcessObservation(
        platform="darwin",
        pid=pid,
        ppid=ppid,
        pgid=pgid,
        sid=sid,
        start_token=start_token,
        executable_path=executable_path,
        executable_device=executable_device,
        executable_inode=executable_inode,
    )


def _identity() -> ProcessIdentityV1:
    return capture_process_identity(
        run_id="bt_identity",
        spawn_nonce="spawn-001",
        pid=501,
        configured_executable=Path("/service/venv/bin/python"),
        observer=lambda _pid, _path: _observation(),
    )


def _framework_executables(tmp_path: Path) -> tuple[Path, Path, Path]:
    framework = tmp_path / "Python.framework" / "Versions" / "3.12"
    launcher = framework / "bin" / "python3.12"
    python_app = framework / "Resources" / "Python.app" / "Contents" / "MacOS" / "Python"
    launcher.parent.mkdir(parents=True)
    python_app.parent.mkdir(parents=True)
    launcher.write_bytes(b"framework launcher")
    python_app.write_bytes(b"python app")
    configured_executable = tmp_path / "venv" / "bin" / "python"
    configured_executable.parent.mkdir(parents=True)
    configured_executable.symlink_to(launcher)
    return configured_executable, launcher, python_app


def _install_default_observations(
    monkeypatch: pytest.MonkeyPatch,
    observations: list[ProcessObservation],
) -> None:
    pending = iter(observations)
    monkeypatch.setattr(
        process_identity_module,
        "observe_process",
        lambda _pid, _path: next(pending),
    )


def test_capture_binds_new_session_and_exact_executable_identity() -> None:
    identity = _identity()

    assert identity.model_dump(mode="json") == {
        "schema_version": 1,
        "run_id": "bt_identity",
        "spawn_nonce": "spawn-001",
        "pid": 501,
        "ppid": 41,
        "pgid": 501,
        "sid": 501,
        "platform": "darwin",
        "start_token": "darwin:1700000000:123456",
        "configured_executable_path": "/service/venv/bin/python",
        "observed_executable_path": "/opt/stark/python3.12",
        "executable_device": 7,
        "executable_inode": 11,
    }
    assert process_identity_bytes(identity) == canonical_json_bytes(
        identity.model_dump(mode="json")
    )
    assert len(process_identity_digest(identity)) == 64


def test_capture_waits_for_darwin_framework_launcher_to_bind_python_app(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Catches removal of initial binding stabilization, which would bind the launcher.
    configured_executable, launcher, python_app = _framework_executables(tmp_path)
    launcher_stat = launcher.stat()
    python_app_stat = python_app.stat()
    _install_default_observations(
        monkeypatch,
        [
            _observation(
                executable_path=str(launcher),
                executable_device=launcher_stat.st_dev,
                executable_inode=launcher_stat.st_ino,
            ),
            _observation(
                executable_path=str(python_app),
                executable_device=python_app_stat.st_dev,
                executable_inode=python_app_stat.st_ino,
            ),
        ],
    )

    identity = capture_process_identity(
        run_id="bt_framework_transition",
        spawn_nonce="spawn-framework-transition",
        pid=501,
        configured_executable=configured_executable,
    )

    assert identity.observed_executable_path == str(python_app)
    assert identity.executable_device == python_app_stat.st_dev
    assert identity.executable_inode == python_app_stat.st_ino


def test_default_observer_accepts_bound_python_app_for_strict_verification(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configured_executable, launcher, python_app = _framework_executables(tmp_path)
    launcher_stat = launcher.stat()
    python_app_stat = python_app.stat()
    observations = iter(
        [
            _observation(
                executable_path=str(launcher),
                executable_device=launcher_stat.st_dev,
                executable_inode=launcher_stat.st_ino,
            ),
            _observation(
                executable_path=str(python_app),
                executable_device=python_app_stat.st_dev,
                executable_inode=python_app_stat.st_ino,
            ),
            _observation(
                executable_path=str(python_app),
                executable_device=python_app_stat.st_dev,
                executable_inode=python_app_stat.st_ino,
            ),
        ]
    )
    monkeypatch.setattr(process_identity_module, "sys", SimpleNamespace(platform="darwin"))
    monkeypatch.setattr(
        process_identity_module,
        "_observe_darwin_process",
        lambda _pid: next(observations),
    )

    identity = capture_process_identity(
        run_id="bt_framework_strict_verify",
        spawn_nonce="spawn-framework-strict-verify",
        pid=501,
        configured_executable=configured_executable,
    )

    assert identity.observed_executable_path == str(python_app)
    assert verify_process_identity(identity)


def test_default_observer_snapshots_framework_targets_before_process_observation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configured_executable, _launcher, python_app = _framework_executables(tmp_path)
    python_app_stat = python_app.stat()
    observation = _observation(
        executable_path=str(python_app),
        executable_device=python_app_stat.st_dev,
        executable_inode=python_app_stat.st_ino,
    )
    replacement = tmp_path / "replacement-python-app"
    replacement.write_bytes(b"replacement python app")

    def observe_after_replacement(_pid: int) -> ProcessObservation:
        replacement.replace(python_app)
        assert python_app.stat().st_ino != python_app_stat.st_ino
        return observation

    monkeypatch.setattr(process_identity_module, "sys", SimpleNamespace(platform="darwin"))
    monkeypatch.setattr(
        process_identity_module,
        "_observe_darwin_process",
        observe_after_replacement,
    )

    assert process_identity_module.observe_process(501, configured_executable) == observation


@pytest.mark.parametrize(
    ("companion_failure", "expected_error"),
    [
        ("missing", OSError),
        ("non-regular", RuntimeError),
        ("device-mismatch", RuntimeError),
    ],
)
def test_capture_propagates_canonical_framework_companion_snapshot_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    companion_failure: str,
    expected_error: type[Exception],
) -> None:
    # Catches downgrading a matched Framework's invalid companion to no transition.
    configured_executable, launcher, python_app = _framework_executables(tmp_path)
    launcher_stat = launcher.stat()
    launcher_observation = _observation(
        executable_path=str(launcher),
        executable_device=launcher_stat.st_dev,
        executable_inode=launcher_stat.st_ino,
    )
    replacement = tmp_path / "valid-python-app"
    replacement.write_bytes(b"valid python app")
    real_stat = process_identity_module.os.stat
    companion_stat_calls = 0

    if companion_failure == "missing":
        python_app.unlink()
    elif companion_failure == "non-regular":
        python_app.unlink()
        python_app.mkdir()
    else:

        def mismatched_device_once(
            path: str | bytes | int,
            *args: object,
            **kwargs: object,
        ) -> object:
            nonlocal companion_stat_calls
            result = real_stat(path, *args, **kwargs)
            if Path(path) == python_app and companion_stat_calls == 0:
                companion_stat_calls += 1
                values = list(result)
                values[2] = result.st_dev + 1
                return process_identity_module.os.stat_result(values)
            return result

        monkeypatch.setattr(process_identity_module.os, "stat", mismatched_device_once)

    def observe_after_companion_recovers(_pid: int, _path: Path) -> ProcessObservation:
        if companion_failure == "missing":
            replacement.replace(python_app)
        elif companion_failure == "non-regular":
            python_app.rmdir()
            replacement.replace(python_app)
        assert (
            process_identity_module._snapshot_darwin_executables(configured_executable).transition
            is not None
        )
        return launcher_observation

    monkeypatch.setattr(
        process_identity_module,
        "observe_process",
        observe_after_companion_recovers,
    )

    with pytest.raises(expected_error):
        capture_process_identity(
            run_id="bt_framework_companion_failure",
            spawn_nonce="spawn-framework-companion-failure",
            pid=501,
            configured_executable=configured_executable,
        )


@pytest.mark.parametrize("mutation", ["path", "device", "inode"])
def test_default_observer_requires_exact_framework_python_app_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mutation: str,
) -> None:
    configured_executable, _launcher, python_app = _framework_executables(tmp_path)
    python_app_alias = tmp_path / "python-app-hardlink"
    python_app_alias.hardlink_to(python_app)
    python_app_stat = python_app.stat()
    observation = _observation(
        executable_path=str(python_app),
        executable_device=python_app_stat.st_dev,
        executable_inode=python_app_stat.st_ino,
    )
    changes = {
        "path": {"executable_path": str(python_app_alias)},
        "device": {"executable_device": python_app_stat.st_dev + 1},
        "inode": {"executable_inode": python_app_stat.st_ino + 1},
    }
    monkeypatch.setattr(process_identity_module, "sys", SimpleNamespace(platform="darwin"))
    monkeypatch.setattr(
        process_identity_module,
        "_observe_darwin_process",
        lambda _pid: replace(observation, **changes[mutation]),
    )

    with pytest.raises(RuntimeError, match="does not match configured Python executable"):
        process_identity_module.observe_process(501, configured_executable)


def test_capture_stable_non_framework_identity_skips_stabilization_clock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        process_identity_module,
        "time",
        SimpleNamespace(
            monotonic=lambda: pytest.fail("stable capture must not start a deadline"),
            sleep=lambda _seconds: pytest.fail("stable capture must not poll"),
        ),
    )
    observations = iter([_observation()])

    identity = capture_process_identity(
        run_id="bt_stable_capture",
        spawn_nonce="spawn-stable-capture",
        pid=501,
        configured_executable=Path("/service/venv/bin/python"),
        observer=lambda _pid, _path: next(observations),
    )

    assert identity.observed_executable_path == "/opt/stark/python3.12"


def test_capture_custom_observer_remains_authoritative_for_framework_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configured_executable, launcher, _python_app = _framework_executables(tmp_path)
    launcher_stat = launcher.stat()
    observation = _observation(
        executable_path=str(launcher),
        executable_device=launcher_stat.st_dev,
        executable_inode=launcher_stat.st_ino,
    )
    monkeypatch.setattr(
        process_identity_module,
        "time",
        SimpleNamespace(
            monotonic=lambda: pytest.fail("custom observer must not start a deadline"),
            sleep=lambda _seconds: pytest.fail("custom observer must not poll"),
        ),
    )

    identity = capture_process_identity(
        run_id="bt_custom_framework_observer",
        spawn_nonce="spawn-custom-framework-observer",
        pid=501,
        configured_executable=configured_executable,
        observer=lambda _pid, _path: observation,
    )

    assert identity.observed_executable_path == str(launcher)


def test_capture_custom_observer_rejects_wrong_pid_only() -> None:
    with pytest.raises(RuntimeError, match="process session identity"):
        capture_process_identity(
            run_id="bt_wrong_pid_capture",
            spawn_nonce="spawn-wrong-pid-capture",
            pid=501,
            configured_executable=Path("/service/venv/bin/python"),
            observer=lambda _pid, _path: _observation(pid=502),
        )


@pytest.mark.parametrize(
    ("drift", "expected_error"),
    [
        ("pid", "process session identity"),
        ("pgid", "process session identity"),
        ("sid", "process session identity"),
        ("start_token", "identity changed during executable binding"),
    ],
)
def test_capture_rejects_process_identity_drift_during_framework_transition(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    drift: str,
    expected_error: str,
) -> None:
    configured_executable, launcher, _python_app = _framework_executables(tmp_path)
    launcher_stat = launcher.stat()
    initial = _observation(
        executable_path=str(launcher),
        executable_device=launcher_stat.st_dev,
        executable_inode=launcher_stat.st_ino,
    )
    changes = {
        "pid": {"pid": 502, "pgid": 502, "sid": 502},
        "pgid": {"pgid": 502},
        "sid": {"sid": 502},
        "start_token": {"start_token": "darwin:1700000000:123457"},
    }
    _install_default_observations(
        monkeypatch,
        [initial, replace(initial, **changes[drift])],
    )

    with pytest.raises(RuntimeError, match=expected_error):
        capture_process_identity(
            run_id="bt_framework_identity_drift",
            spawn_nonce="spawn-framework-identity-drift",
            pid=501,
            configured_executable=configured_executable,
        )


@pytest.mark.parametrize("mutation", ["path", "device", "inode"])
def test_capture_requires_exact_framework_launcher_before_polling(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mutation: str,
) -> None:
    configured_executable, launcher, _python_app = _framework_executables(tmp_path)
    launcher_alias = tmp_path / "framework-launcher-hardlink"
    launcher_alias.hardlink_to(launcher)
    launcher_stat = launcher.stat()
    observation = _observation(
        executable_path=str(launcher),
        executable_device=launcher_stat.st_dev,
        executable_inode=launcher_stat.st_ino,
    )
    changes = {
        "path": {"executable_path": str(launcher_alias)},
        "device": {"executable_device": launcher_stat.st_dev + 1},
        "inode": {"executable_inode": launcher_stat.st_ino + 1},
    }
    monkeypatch.setattr(
        process_identity_module,
        "time",
        SimpleNamespace(
            monotonic=lambda: 1.0,
            sleep=lambda _seconds: pytest.fail("unexpected executable must fail immediately"),
        ),
    )
    _install_default_observations(
        monkeypatch,
        [replace(observation, **changes[mutation])],
    )

    with pytest.raises(RuntimeError, match="not the configured Framework launcher"):
        capture_process_identity(
            run_id="bt_framework_unexpected",
            spawn_nonce="spawn-framework-unexpected",
            pid=501,
            configured_executable=configured_executable,
        )


def test_capture_persistent_framework_launcher_times_out_fail_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configured_executable, launcher, _python_app = _framework_executables(tmp_path)
    launcher_stat = launcher.stat()
    monkeypatch.setattr(
        process_identity_module,
        "_DARWIN_FRAMEWORK_BIND_TIMEOUT_SECONDS",
        0.0,
    )
    _install_default_observations(
        monkeypatch,
        [
            _observation(
                executable_path=str(launcher),
                executable_device=launcher_stat.st_dev,
                executable_inode=launcher_stat.st_ino,
            )
        ],
    )

    with pytest.raises(RuntimeError, match="did not stabilize before deadline"):
        capture_process_identity(
            run_id="bt_framework_timeout",
            spawn_nonce="spawn-framework-timeout",
            pid=501,
            configured_executable=configured_executable,
        )


def test_capture_accepts_valid_python_app_after_parent_scheduling_gap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configured_executable, launcher, python_app = _framework_executables(tmp_path)
    launcher_stat = launcher.stat()
    python_app_stat = python_app.stat()
    _install_default_observations(
        monkeypatch,
        [
            _observation(
                executable_path=str(launcher),
                executable_device=launcher_stat.st_dev,
                executable_inode=launcher_stat.st_ino,
            ),
            _observation(
                executable_path=str(python_app),
                executable_device=python_app_stat.st_dev,
                executable_inode=python_app_stat.st_ino,
            ),
        ],
    )
    moments = iter([0.0, 0.0, 0.04, 0.06])
    monkeypatch.setattr(
        process_identity_module,
        "time",
        SimpleNamespace(monotonic=lambda: next(moments), sleep=lambda _seconds: None),
    )

    identity = capture_process_identity(
        run_id="bt_framework_late_python_app",
        spawn_nonce="spawn-framework-late-python-app",
        pid=501,
        configured_executable=configured_executable,
    )

    assert identity.observed_executable_path == str(python_app)
    assert identity.executable_device == python_app_stat.st_dev
    assert identity.executable_inode == python_app_stat.st_ino


def test_capture_rejects_late_identity_drift_before_deadline_classification(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configured_executable, launcher, _python_app = _framework_executables(tmp_path)
    launcher_stat = launcher.stat()
    initial = _observation(
        executable_path=str(launcher),
        executable_device=launcher_stat.st_dev,
        executable_inode=launcher_stat.st_ino,
    )
    _install_default_observations(
        monkeypatch,
        [initial, replace(initial, start_token="darwin:1700000000:123457")],
    )
    moments = iter([0.0, 0.0, 0.06])
    monkeypatch.setattr(
        process_identity_module,
        "time",
        SimpleNamespace(monotonic=lambda: next(moments), sleep=lambda _seconds: None),
    )

    with pytest.raises(RuntimeError, match="identity changed during executable binding"):
        capture_process_identity(
            run_id="bt_framework_late_identity_drift",
            spawn_nonce="spawn-framework-late-identity-drift",
            pid=501,
            configured_executable=configured_executable,
        )


@pytest.mark.parametrize("mutation", ["path", "device", "inode"])
def test_capture_rejects_late_wrong_framework_target_before_deadline_classification(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mutation: str,
) -> None:
    configured_executable, launcher, _python_app = _framework_executables(tmp_path)
    unexpected = tmp_path / "unexpected-framework-target"
    unexpected.hardlink_to(launcher)
    launcher_stat = launcher.stat()
    initial = _observation(
        executable_path=str(launcher),
        executable_device=launcher_stat.st_dev,
        executable_inode=launcher_stat.st_ino,
    )
    changes = {
        "path": {"executable_path": str(unexpected)},
        "device": {"executable_device": launcher_stat.st_dev + 1},
        "inode": {"executable_inode": launcher_stat.st_ino + 1},
    }
    _install_default_observations(
        monkeypatch,
        [initial, replace(initial, **changes[mutation])],
    )
    moments = iter([0.0, 0.0, 0.06])
    monkeypatch.setattr(
        process_identity_module,
        "time",
        SimpleNamespace(monotonic=lambda: next(moments), sleep=lambda _seconds: None),
    )

    with pytest.raises(RuntimeError, match="not the configured Framework launcher"):
        capture_process_identity(
            run_id="bt_framework_late_wrong_target",
            spawn_nonce="spawn-framework-late-wrong-target",
            pid=501,
            configured_executable=configured_executable,
        )


def test_bound_python_app_rejects_launcher_reappearance_before_signaling(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configured_executable, launcher, python_app = _framework_executables(tmp_path)
    launcher_stat = launcher.stat()
    python_app_stat = python_app.stat()
    launcher_observation = _observation(
        executable_path=str(launcher),
        executable_device=launcher_stat.st_dev,
        executable_inode=launcher_stat.st_ino,
    )
    python_app_observation = _observation(
        executable_path=str(python_app),
        executable_device=python_app_stat.st_dev,
        executable_inode=python_app_stat.st_ino,
    )
    _install_default_observations(
        monkeypatch,
        [launcher_observation, python_app_observation],
    )
    identity = capture_process_identity(
        run_id="bt_framework_launcher_reappearance",
        spawn_nonce="spawn-framework-launcher-reappearance",
        pid=501,
        configured_executable=configured_executable,
    )
    sent: list[tuple[int, int]] = []

    assert not verify_process_identity(
        identity,
        observer=lambda _pid, _path: launcher_observation,
    )
    assert (
        verified_signal_process_group(
            identity,
            signal.SIGTERM,
            observer=lambda _pid, _path: launcher_observation,
            sender=lambda pgid, number: sent.append((pgid, number)),
        )
        == "IDENTITY_MISMATCH"
    )
    assert sent == []


@pytest.mark.parametrize("pgid,sid", [(500, 501), (501, 500)])
def test_capture_rejects_a_process_outside_its_own_session(pgid: int, sid: int) -> None:
    with pytest.raises(RuntimeError, match="process session"):
        capture_process_identity(
            run_id="bt_identity",
            spawn_nonce="spawn-001",
            pid=501,
            configured_executable=Path("/service/venv/bin/python"),
            observer=lambda _pid, _path: _observation(pgid=pgid, sid=sid),
        )


def test_restart_verification_treats_ppid_as_launch_only_evidence() -> None:
    identity = _identity()

    assert verify_process_identity(
        identity,
        observer=lambda _pid, _path: _observation(ppid=1),
    )


def test_restart_verification_rejects_wrong_pid_only() -> None:
    assert not verify_process_identity(
        _identity(),
        observer=lambda _pid, _path: _observation(pid=502),
    )


def test_signal_rejects_wrong_pid_only_without_delivery() -> None:
    sent: list[tuple[int, int]] = []

    assert (
        verified_signal_process_group(
            _identity(),
            signal.SIGTERM,
            observer=lambda _pid, _path: _observation(pid=502),
            sender=lambda pgid, number: sent.append((pgid, number)),
        )
        == "IDENTITY_MISMATCH"
    )
    assert sent == []


@pytest.mark.parametrize(
    "replacement",
    [
        _observation(start_token="darwin:1700000000:123457"),
        _observation(executable_path="/opt/stark/other-python"),
        _observation(executable_device=8),
        _observation(executable_inode=12),
        _observation(pgid=502, sid=502),
    ],
)
def test_restart_verification_rejects_same_second_pid_reuse_and_identity_drift(
    replacement: ProcessObservation,
) -> None:
    assert not verify_process_identity(
        _identity(),
        observer=lambda _pid, _path: replacement,
    )


def test_signal_is_sent_to_the_group_only_after_exact_identity_verification() -> None:
    sent: list[tuple[int, int]] = []
    identity = _identity()

    assert (
        verified_signal_process_group(
            identity,
            signal.SIGTERM,
            observer=lambda _pid, _path: _observation(ppid=1),
            sender=lambda pgid, number: sent.append((pgid, number)),
        )
        == "DELIVERED"
    )
    assert sent == [(501, signal.SIGTERM)]

    assert (
        verified_signal_process_group(
            identity,
            signal.SIGKILL,
            observer=lambda _pid, _path: _observation(start_token="darwin:1700000000:123457"),
            sender=lambda pgid, number: sent.append((pgid, number)),
        )
        == "IDENTITY_MISMATCH"
    )
    assert sent == [(501, signal.SIGTERM)]


def test_signal_reports_process_gone_when_group_disappears_after_verification() -> None:
    def disappeared(_pgid: int, _number: int) -> None:
        raise ProcessLookupError

    assert (
        verified_signal_process_group(
            _identity(),
            signal.SIGTERM,
            observer=lambda _pid, _path: _observation(ppid=1),
            sender=disappeared,
        )
        == "PROCESS_GONE"
    )


@pytest.mark.skipif(sys.platform != "darwin", reason="requires macOS libproc")
def test_real_darwin_libproc_captures_microsecond_session_identity() -> None:
    children = [
        subprocess.Popen(
            [sys.executable, "-s", "-P", "-B", "-c", "import time; time.sleep(10)"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
        for _ in range(2)
    ]
    try:
        identities = [
            capture_process_identity(
                run_id=f"bt_real_identity_{index}",
                spawn_nonce=f"spawn-real-{index}",
                pid=child.pid,
                configured_executable=Path(sys.executable),
            )
            for index, child in enumerate(children)
        ]
        assert all(identity.platform == "darwin" for identity in identities)
        assert all(identity.pgid == identity.pid == identity.sid for identity in identities)
        assert all(
            len(identity.start_token.rsplit(":", maxsplit=1)[1]) == 6 for identity in identities
        )
        assert all(verify_process_identity(identity) for identity in identities)
    finally:
        for child in children:
            child.terminate()
        for child in children:
            child.wait(timeout=5)


def test_process_record_requires_exact_bound_identity_and_closed_phase() -> None:
    identity = _identity()
    record = RunnerProcessRecord(
        run_id=identity.run_id,
        spawn_nonce=identity.spawn_nonce,
        pid=identity.pid,
        identity=identity,
        launched_at_ns=100,
        cancel_phase="REQUESTED",
        created_by_caller=True,
    )

    assert record.pid == identity.pid
    with pytest.raises(ValidationError):
        RunnerProcessRecord(
            run_id=identity.run_id,
            spawn_nonce=identity.spawn_nonce,
            pid=identity.pid,
            identity=identity,
            launched_at_ns=100,
            cancel_phase="ACKNOWLEDGED",
            created_by_caller=False,
        )
    with pytest.raises(ValidationError):
        RunnerProcessRecord(
            run_id=identity.run_id,
            spawn_nonce=identity.spawn_nonce,
            pid=999,
            identity=identity,
            launched_at_ns=100,
            cancel_phase="NONE",
            created_by_caller=False,
        )


def test_supervisor_exit_is_closed_and_outcome_record_binds_exact_digest() -> None:
    identity = _identity()
    exit_record = SupervisorExitV1(
        run_id=identity.run_id,
        spawn_nonce=identity.spawn_nonce,
        process_identity_sha256=process_identity_digest(identity),
        launched_at_ns=100,
        ended_at_ns=120,
        duration_ns=20,
        exit_code=None,
        signal=9,
        final_cancel_phase="KILL_SENT",
        stdout_size_bytes=0,
        stderr_size_bytes=0,
        stderr_sha256="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        stderr_truncated=False,
        child_outcome=None,
        classification="SUPERVISOR_FAILURE",
        failure_code="FORCED_TERMINATION",
        proposed_terminal_state="FAILED",
    )
    payload = canonical_json_bytes(exit_record.model_dump(mode="json"))
    persisted = RunnerOutcomeRecord(
        run_id=identity.run_id,
        outcome=exit_record,
        outcome_bytes=payload,
        outcome_hash=hashlib.sha256(payload).hexdigest(),
        recorded_at_ns=121,
    )

    assert persisted.outcome_bytes == payload
    with pytest.raises(ValidationError):
        SupervisorExitV1.model_validate({**exit_record.model_dump(), "unexpected": True})
    with pytest.raises(ValidationError):
        RunnerOutcomeRecord(
            run_id=identity.run_id,
            outcome=exit_record,
            outcome_bytes=payload + b" ",
            outcome_hash=persisted.outcome_hash,
            recorded_at_ns=121,
        )


def test_unresolved_process_group_diagnostic_is_closed_and_exact_canonical() -> None:
    identity = _identity()
    diagnostic = UnresolvedProcessGroupV1(
        run_id=identity.run_id,
        spawn_nonce=identity.spawn_nonce,
        process_identity_sha256=process_identity_digest(identity),
    )
    payload = unresolved_process_group_bytes(diagnostic)

    assert unresolved_process_group_from_bytes(payload) == diagnostic
    with pytest.raises(ValueError, match="canonical"):
        unresolved_process_group_from_bytes(payload + b" ")
    with pytest.raises(ValidationError):
        UnresolvedProcessGroupV1.model_validate(
            {**diagnostic.model_dump(mode="json"), "unexpected": True}
        )


@pytest.mark.parametrize("schema_version", [True, 1.0], ids=["boolean", "float"])
@pytest.mark.parametrize(
    "model_name",
    ["identity", "process", "unresolved", "exit", "outcome"],
)
def test_task8_models_require_a_strict_integer_schema_version(
    schema_version: object,
    model_name: str,
) -> None:
    identity = _identity()
    exit_record = SupervisorExitV1(
        run_id=identity.run_id,
        spawn_nonce=identity.spawn_nonce,
        process_identity_sha256=process_identity_digest(identity),
        launched_at_ns=100,
        ended_at_ns=120,
        duration_ns=20,
        exit_code=None,
        signal=9,
        final_cancel_phase="KILL_SENT",
        stdout_size_bytes=0,
        stderr_size_bytes=0,
        stderr_sha256="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        stderr_truncated=False,
        child_outcome=None,
        classification="SUPERVISOR_FAILURE",
        failure_code="FORCED_TERMINATION",
        proposed_terminal_state="FAILED",
    )
    payload = canonical_json_bytes(exit_record.model_dump(mode="json"))
    models = {
        "identity": (ProcessIdentityV1, identity.model_dump(mode="json")),
        "process": (
            RunnerProcessRecord,
            RunnerProcessRecord(
                run_id=identity.run_id,
                spawn_nonce=identity.spawn_nonce,
                pid=identity.pid,
                identity=identity,
                launched_at_ns=100,
                cancel_phase="NONE",
                created_by_caller=False,
            ).model_dump(mode="python"),
        ),
        "unresolved": (
            UnresolvedProcessGroupV1,
            UnresolvedProcessGroupV1(
                run_id=identity.run_id,
                spawn_nonce=identity.spawn_nonce,
                process_identity_sha256=process_identity_digest(identity),
            ).model_dump(mode="json"),
        ),
        "exit": (SupervisorExitV1, exit_record.model_dump(mode="json")),
        "outcome": (
            RunnerOutcomeRecord,
            RunnerOutcomeRecord(
                run_id=identity.run_id,
                outcome=exit_record,
                outcome_bytes=payload,
                outcome_hash=hashlib.sha256(payload).hexdigest(),
                recorded_at_ns=121,
            ).model_dump(mode="python"),
        ),
    }
    model, values = models[model_name]
    values["schema_version"] = schema_version
    with pytest.raises(ValidationError):
        model.model_validate(values)
