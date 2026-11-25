"""A child must bind exactly one truthful outcome to the caller's identity."""

import json
import warnings

import pytest

from stark_trading_os.runner import historical_protocol as wire
from stark_trading_os.runner.protocol import ProtocolError, parse_protocol_line


def identity(**changes):
    return wire.HistoricalRunnerIdentityV2(
        **(
            dict(
                run_id="bt_" + "b" * 32,
                input_manifest_sha256="a" * 64,
                catalog_revision="c" * 64,
                cost_sha256="d" * 64,
                engine_package_version="2.0.0rc3",
                account_id="SIM-001",
            )
            | changes
        )
    )


def artifacts():
    return tuple(
        wire.HistoricalReportArtifactV2(
            name=name, path=f"reports/{filename}", sha256=str(i + 1) * 64, size_bytes=100
        )
        for i, (name, filename) in enumerate(wire.REPORT_FILES_V2)
    )


def started():
    return wire.RunnerStartedV2(schema="RunnerStarted.v2", identity=identity())


def outcome(**changes):
    return wire.RunnerOutcomeV2(
        **(
            dict(
                schema="RunnerOutcome.v2",
                identity=identity(),
                result="SUCCEEDED",
                artifacts=artifacts(),
                report_status="INTERNAL_REPORT_CHECK_PASSED",
                failure_code=None,
            )
            | changes
        )
    )


@pytest.mark.parametrize("message", [started, outcome])
def test_canonical_v2_roundtrip_cannot_enter_v1(message):
    value = message()
    raw = wire.encode_historical_protocol_line(value)
    assert wire.parse_historical_protocol_line(raw) == value
    assert raw.endswith(b"\n") and raw.count(b"\n") == 1
    with pytest.raises(ProtocolError):
        parse_protocol_line(raw)


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"{}",
        b"{}\r\n",
        b"{}\n\n",
        b"\xef\xbb\xbf{}\n",
        b'{"schema":"RunnerOutcome.v1"}\n',
        b'{"private-token":1,"private-token":2}\n',
        b'{"a":1.1}\n',
        b"[" * 2000 + b"]" * 2000 + b"\n",
        b"x" * 65537,
    ],
)
def test_bad_wire_is_bounded_and_content_free(raw):
    with pytest.raises(ProtocolError, match="^historical runner protocol is invalid$"):
        wire.parse_historical_protocol_line(raw)


def test_noncanonical_and_extra_fields_reject():
    value = json.loads(wire.encode_historical_protocol_line(started()))
    for raw in [
        json.dumps(value).encode() + b"\n",
        json.dumps(
            value | {"secret": "example"}, sort_keys=True, separators=(",", ":")
        ).encode()
        + b"\n",
    ]:
        with pytest.raises(ProtocolError):
            wire.parse_historical_protocol_line(raw)


@pytest.mark.parametrize(
    "changes",
    [
        dict(artifacts=()),
        dict(report_status="INTERNAL_REPORT_CHECK_FAILED"),
        dict(failure_code="EXECUTION_FAILED"),
        dict(artifacts=artifacts()[::-1]),
        dict(result="FAILED"),
        dict(result="FAILED", failure_code="EXECUTION_FAILED"),
    ],
)
def test_false_success_or_impossible_failure_rejects(changes):
    with pytest.raises(ValueError):
        outcome(**changes)


@pytest.mark.parametrize(
    "failure,status,count",
    [
        ("EXECUTION_FAILED", None, 0),
        ("EVIDENCE_INVALID", None, 0),
        ("PERSISTENCE_FAILED", None, 0),
        ("PERSISTENCE_FAILED", None, 1),
        ("PERSISTENCE_FAILED", None, 2),
        ("COMPONENT_CHECK_FAILED", "INTERNAL_REPORT_CHECK_FAILED", 2),
    ],
)
def test_truthful_failure_prefix_and_exit(failure, status, count):
    value = outcome(
        result="FAILED", failure_code=failure, report_status=status, artifacts=artifacts()[:count]
    )
    validator = wire.HistoricalRunnerSequenceValidator(expected=identity())
    validator.accept(started())
    validator.accept(
        wire.parse_historical_protocol_line(wire.encode_historical_protocol_line(value))
    )
    assert validator.finish(1) == value


@pytest.mark.parametrize(
    "field,value",
    [
        ("run_id", "bt_" + "e" * 32),
        ("input_manifest_sha256", "e" * 64),
        ("catalog_revision", "e" * 64),
        ("cost_sha256", "e" * 64),
    ],
)
def test_separately_trusted_identity_is_mandatory(field, value):
    validator = wire.HistoricalRunnerSequenceValidator(expected=identity(**{field: value}))
    with pytest.raises(ProtocolError):
        validator.accept(started())


@pytest.mark.parametrize(
    "messages,exit_code",
    [
        ([], 0),
        ([started()], 0),
        ([outcome()], 0),
        ([started(), started()], 0),
        ([started(), outcome(), outcome()], 0),
        ([started(), outcome()], 1),
        ([started(), outcome()], True),
    ],
)
def test_sequence_or_exit_mismatch_never_succeeds(messages, exit_code):
    validator = wire.HistoricalRunnerSequenceValidator(expected=identity())
    with pytest.raises(ProtocolError):
        for message in messages:
            validator.accept(message)
        validator.finish(exit_code)


def test_finish_once_and_revalidate_model_construct():
    validator = wire.HistoricalRunnerSequenceValidator(expected=identity())
    validator.accept(started())
    validator.accept(outcome())
    assert validator.finish(0) == outcome()
    with pytest.raises(ProtocolError):
        validator.finish(0)
    bad = outcome().model_copy(update={"artifacts": ()})
    with pytest.raises(ProtocolError):
        wire.encode_historical_protocol_line(bad)


@pytest.mark.parametrize(
    "changes",
    [
        dict(run_id="../other"),
        dict(input_manifest_sha256="A" * 64),
        dict(engine_package_version="other"),
        dict(account_id="SIM-002"),
    ],
)
def test_closed_native_identity(changes):
    with pytest.raises(ValueError):
        identity(**changes)


@pytest.mark.parametrize("boundary", ["artifact", "started", "outcome", "expected_identity"])
def test_invalid_constructed_values_do_not_leak_through_serialization_warnings(boundary):
    marker = "private-secret-marker"
    bad_artifact = artifacts()[0].model_copy(update={"size_bytes": marker})
    bad_identity = identity().model_copy(update={"input_manifest_sha256": {marker: True}})
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        with pytest.raises(ProtocolError, match="^historical runner protocol is invalid$"):
            if boundary == "artifact":
                wire.validate_artifact_prefix((bad_artifact,))
            elif boundary == "started":
                wire.encode_historical_protocol_line(
                    started().model_copy(update={"identity": marker})
                )
            elif boundary == "outcome":
                wire.encode_historical_protocol_line(
                    outcome().model_copy(update={"artifacts": (bad_artifact, artifacts()[1])})
                )
            else:
                wire.HistoricalRunnerSequenceValidator(expected=bad_identity)
    assert not captured
