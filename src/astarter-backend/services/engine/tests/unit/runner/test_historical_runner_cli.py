"""The CLI cannot infer trusted hashes or promote failed native runs to success."""

import io
from dataclasses import replace

import pytest

from stark_trading_os.runner import historical_main as cli
from stark_trading_os.runner.historical_component_run import run_historical_report_component
from stark_trading_os.runner.historical_protocol import parse_historical_protocol_line
from tests.integration.runner.historical_report_fixture import stage_prepared
from tests.integration.runner.sma_component_fixture import prepare_sma_case


def argv(args):
    return [
        "--run-id",
        args["run_id"],
        "--staging-dir",
        str(args["staging_dir"]),
        "--input-manifest",
        str(args["input_manifest"]),
        "--expected-input-sha256",
        args["expected_input_sha256"],
    ]


@pytest.fixture
def prepared(tmp_path):
    prepared = prepare_sma_case(tmp_path, [100, 100, 100, 110])
    args = stage_prepared(tmp_path, prepared)
    return args


@pytest.mark.parametrize(
    "mutation",
    ["missing", "duplicate", "abbreviated", "unknown", "bad_hash", "bad_run", "relative", "equals"],
)
def test_cli_exact_flags_and_trusted_hash(prepared, mutation, monkeypatch):
    args = argv(prepared)
    monkeypatch.setenv("EXPECTED_INPUT_SHA256", prepared["expected_input_sha256"])
    if mutation == "missing":
        args = args[:-2]
    elif mutation == "duplicate":
        args += args[-2:]
    elif mutation == "abbreviated":
        args[-2] = "--expected-input-sha"
    elif mutation == "unknown":
        args += ["--other", "value"]
    elif mutation == "bad_hash":
        args[-1] = "A" * 64
    elif mutation == "bad_run":
        args[1] = "../other"
    elif mutation == "relative":
        args[3] = "runtime/staging"
    else:
        args = ["--run-id=" + args[1], *args[2:]]
    with pytest.raises(cli.HistoricalRunnerCliError):
        cli.parse_historical_runner_cli(args)


def test_invalid_input_has_no_start_or_artifacts(prepared, monkeypatch):
    args = cli.parse_historical_runner_cli(argv(prepared))
    args = replace(args, expected_input_sha256="f" * 64)
    monkeypatch.setattr(
        cli,
        "run_historical_report_component",
        lambda **kwargs: pytest.fail("engine called on invalid input"),
    )
    output = io.BytesIO()
    assert cli.execute_historical_runner(args, stdout=output) == 2
    assert output.getvalue() == b""
    assert not (prepared["staging_dir"] / "reports").exists()


@pytest.mark.parametrize(
    "fault,expected",
    [
        ("throw", "EXECUTION_FAILED"),
        ("not_disposed", "EVIDENCE_INVALID"),
        ("wrong_run", "EVIDENCE_INVALID"),
        ("wrong_count", "EVIDENCE_INVALID"),
        ("bad_bytes", "EVIDENCE_INVALID"),
        ("false_status", "EVIDENCE_INVALID"),
        ("replace_stage", "EVIDENCE_INVALID"),
        ("persist", "PERSISTENCE_FAILED"),
    ],
)
def test_native_or_storage_fault_cannot_emit_success(prepared, monkeypatch, fault, expected):
    result = run_historical_report_component(**prepared)
    if fault == "not_disposed":
        result = replace(result, component=replace(result.component, engine_disposed=False))
    elif fault == "wrong_run":
        result = replace(result, component=replace(result.component, run_id="bt_" + "e" * 32))
    elif fault == "wrong_count":
        result = replace(result, component=replace(result.component, engine_run_count=2))
    elif fault == "bad_bytes":
        result = replace(result, report_bytes=b"{private-secret}")
    elif fault == "false_status":
        result = replace(result, report_status="INTERNAL_REPORT_CHECK_FAILED")

    def owner(**kwargs):
        if fault == "throw":
            raise RuntimeError("private-secret-marker")
        if fault == "replace_stage":
            stage = prepared["staging_dir"]
            stage.rename(stage.with_name("original"))
            stage.mkdir(mode=0o700)
        return result

    monkeypatch.setattr(cli, "run_historical_report_component", owner)
    if fault == "persist":
        (prepared["staging_dir"] / "reports").mkdir(mode=0o700)
    output = io.BytesIO()
    assert (
        cli.execute_historical_runner(
            cli.parse_historical_runner_cli(argv(prepared)), stdout=output
        )
        == 1
    )
    lines = output.getvalue().splitlines(keepends=True)
    assert len(lines) == 2
    value = parse_historical_protocol_line(lines[-1])
    assert value.result == "FAILED" and value.failure_code == expected
    assert b"private-secret" not in output.getvalue()


def test_output_transport_failure_cannot_exit_success(prepared):
    class BrokenOutput(io.BytesIO):
        def write(self, value):
            raise OSError("private-token")

    assert (
        cli.execute_historical_runner(
            cli.parse_historical_runner_cli(argv(prepared)), stdout=BrokenOutput()
        )
        == 1
    )
    assert not (prepared["staging_dir"] / "reports").exists()
