"""Private saved original evidence must survive disposal and reject unsafe files."""

import json
import os
from dataclasses import replace

import pytest

from stark_trading_os.catalog.historical_catalog import canonical_historical_bytes
from stark_trading_os.runner import historical_report_files as files
from stark_trading_os.runner.historical_report_component import build_historical_report_component_v2
from stark_trading_os.runner.historical_report_reader import HistoricalReportExpectationV2
from stark_trading_os.runner.report_export import ReportSchemaError
from tests.integration.runner.historical_report_fixture import capture_case


@pytest.fixture(scope="module")
def evidence(tmp_path_factory):
    case = capture_case(tmp_path_factory.mktemp("file-evidence"), "entry")
    loaded = case["loaded"]
    expected = HistoricalReportExpectationV2(
        loaded.run_id,
        loaded.manifest_bytes,
        loaded.input_manifest_hash,
        loaded.catalog_manifest_bytes,
        "SIM-001",
    )
    good = dict(
        expected=expected,
        report_bytes=build_historical_report_component_v2(**case),
        component_snapshot_bytes=case["component_snapshot_bytes"],
    )
    raw = json.loads(case["component_snapshot_bytes"])
    raw["status"] = "COMPONENT_CHECK_FAILED"
    raw["failure_codes"] = ["NATIVE_CASH_RECONCILIATION_FAILED"]
    case = dict(case, component_snapshot_bytes=canonical_historical_bytes(raw))
    bad = dict(
        expected=expected,
        report_bytes=build_historical_report_component_v2(**case),
        component_snapshot_bytes=case["component_snapshot_bytes"],
    )
    return good, bad


@pytest.fixture
def staging(tmp_path):
    stage = tmp_path / "stage"
    stage.mkdir(mode=0o700)
    fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY)
    try:
        yield stage, fd
    finally:
        os.close(fd)


@pytest.mark.parametrize("index", [0, 1])
def test_save_reopen_original_bytes_and_diagnostic_failure(evidence, staging, index):
    path, fd = staging
    args = evidence[index]
    bundle = files.persist_historical_report_files(staging_fd=fd, **args)
    reopened = files.read_historical_report_files(
        staging_fd=fd, expected=args["expected"], artifacts=bundle.artifacts
    )
    assert reopened == bundle
    assert reopened.report_bytes == args["report_bytes"]
    assert reopened.component_snapshot_bytes == args["component_snapshot_bytes"]
    assert reopened.summary.status == (
        "INTERNAL_REPORT_CHECK_PASSED" if index == 0 else "INTERNAL_REPORT_CHECK_FAILED"
    )
    assert set(p.name for p in (path / "reports").iterdir()) == {
        "component-snapshot.json",
        "historical-report.json",
    }
    assert (path / "reports").stat().st_mode & 0o777 == 0o700
    for candidate in bundle.artifacts:
        assert (path / candidate.path).stat().st_mode & 0o777 == 0o600
        assert (path / candidate.path).stat().st_nlink == 1


def test_invalid_input_fails_before_creating_directory(evidence, staging):
    path, fd = staging
    args = evidence[0] | {"expected": replace(evidence[0]["expected"], run_id="bt_" + "c" * 32)}
    with pytest.raises(ReportSchemaError):
        files.persist_historical_report_files(staging_fd=fd, **args)
    assert not (path / "reports").exists()


def test_create_only_keeps_prior_files(evidence, staging):
    path, fd = staging
    (path / "reports").mkdir()
    marker = path / "reports/prior"
    marker.write_bytes(b"keep")
    with pytest.raises(files.HistoricalReportPersistenceError) as caught:
        files.persist_historical_report_files(staging_fd=fd, **evidence[0])
    assert caught.value.completed == () and marker.read_bytes() == b"keep"


@pytest.mark.parametrize(
    "fault",
    [
        "extra",
        "missing",
        "symlink",
        "hardlink",
        "fifo",
        "mode",
        "directory_mode",
        "digest",
        "truncated",
    ],
)
def test_reopen_rejects_changed_or_unsafe_files(evidence, staging, fault):
    path, fd = staging
    bundle = files.persist_historical_report_files(staging_fd=fd, **evidence[0])
    target = path / "reports/historical-report.json"
    if fault == "extra":
        (path / "reports/extra").write_bytes(b"x")
    elif fault == "missing":
        target.unlink()
    elif fault == "symlink":
        target.unlink()
        target.symlink_to(path / "outside")
    elif fault == "hardlink":
        os.link(target, path / "outside")
    elif fault == "fifo":
        target.unlink()
        os.mkfifo(target, 0o600)
    elif fault == "mode":
        target.chmod(0o644)
    elif fault == "directory_mode":
        target.parent.chmod(0o755)
    elif fault == "digest":
        target.write_bytes(target.read_bytes().replace(b"PASSED", b"FAILED"))
    else:
        target.write_bytes(b"{")
    with pytest.raises(ReportSchemaError, match="^historical report files are invalid$"):
        files.read_historical_report_files(
            staging_fd=fd, expected=evidence[0]["expected"], artifacts=bundle.artifacts
        )


def test_short_writes_are_completed(evidence, staging, monkeypatch):
    _, fd = staging
    original = os.write
    monkeypatch.setattr(files.os, "write", lambda descriptor, data: original(descriptor, data[:17]))
    saved = files.persist_historical_report_files(staging_fd=fd, **evidence[0])
    assert saved.report_bytes == evidence[0]["report_bytes"]


@pytest.mark.parametrize("call,completed", [(1, 0), (2, 0), (3, 0), (4, 1), (5, 1)])
def test_fsync_failure_never_reports_full_success(evidence, staging, monkeypatch, call, completed):
    path, fd = staging
    original = os.fsync
    count = 0

    def fail_at(descriptor):
        nonlocal count
        count += 1
        if count == call:
            raise OSError("private-secret-marker")
        original(descriptor)

    monkeypatch.setattr(files.os, "fsync", fail_at)
    with pytest.raises(files.HistoricalReportPersistenceError) as caught:
        files.persist_historical_report_files(staging_fd=fd, **evidence[0])
    assert len(caught.value.completed) == completed
    assert str(caught.value) == "historical report persistence failed"
    if completed:
        assert (path / "reports/component-snapshot.json").read_bytes() == evidence[0][
            "component_snapshot_bytes"
        ]


def test_directory_replacement_is_detected(evidence, staging, monkeypatch):
    path, fd = staging
    original = os.link

    def swap(*args, **kwargs):
        original(*args, **kwargs)
        (path / "reports").rename(path / "original-reports")
        (path / "reports").mkdir(mode=0o700)

    monkeypatch.setattr(files.os, "link", swap)
    with pytest.raises(files.HistoricalReportPersistenceError):
        files.persist_historical_report_files(staging_fd=fd, **evidence[0])
    assert not list((path / "reports").iterdir())


def test_reopen_requires_full_validated_metadata(evidence, staging):
    _, fd = staging
    bundle = files.persist_historical_report_files(staging_fd=fd, **evidence[0])
    for metadata in [
        (),
        bundle.artifacts[::-1],
        bundle.artifacts[:1],
        (bundle.artifacts[0].model_copy(update={"path": "../../secret"}), bundle.artifacts[1]),
        (bundle.artifacts[0].model_copy(update={"sha256": "e" * 64}), bundle.artifacts[1]),
    ]:
        with pytest.raises(ReportSchemaError):
            files.read_historical_report_files(
                staging_fd=fd, expected=evidence[0]["expected"], artifacts=metadata
            )
