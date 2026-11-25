"""Explicit historical child-process wire contract; never a run or seal authority."""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, model_validator

from stark_trading_os.runner.protocol import (
    MAX_PROTOCOL_LINE_BYTES,
    ProtocolError,
    _canonical_wire_bytes,
    _decode_wire_object,
)

REPORT_FILES_V2 = (
    ("component_snapshot", "component-snapshot.json"),
    ("historical_report", "historical-report.json"),
)
MAX_ARTIFACT_BYTES_V2 = 128 * 1024 * 1024
_INVALID = "historical runner protocol is invalid"
type Digest = Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]
type ReportStatusV2 = Literal["INTERNAL_REPORT_CHECK_PASSED", "INTERNAL_REPORT_CHECK_FAILED"]
type FailureCodeV2 = Literal[
    "EXECUTION_FAILED",
    "EVIDENCE_INVALID",
    "PERSISTENCE_FAILED",
    "COMPONENT_CHECK_FAILED",
]


class _WireModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        revalidate_instances="always",
        serialize_by_alias=True,
    )


class HistoricalRunnerIdentityV2(_WireModel):
    run_id: Annotated[StrictStr, Field(pattern=r"^bt_[0-9a-f]{32}$")]
    input_manifest_sha256: Digest
    catalog_revision: Digest
    cost_sha256: Digest
    engine_package_version: Literal["2.0.0rc3"]
    account_id: Literal["SIM-001"]


class HistoricalReportArtifactV2(_WireModel):
    name: Literal["component_snapshot", "historical_report"]
    path: StrictStr
    sha256: Digest
    size_bytes: Annotated[StrictInt, Field(ge=1, le=MAX_ARTIFACT_BYTES_V2)]

    @model_validator(mode="after")
    def fixed_path(self) -> Self:
        if self.path != "reports/" + dict(REPORT_FILES_V2)[self.name]:
            raise ValueError(_INVALID)
        return self


class RunnerStartedV2(_WireModel):
    schema_: Literal["RunnerStarted.v2"] = Field(alias="schema")
    identity: HistoricalRunnerIdentityV2


class RunnerOutcomeV2(_WireModel):
    schema_: Literal["RunnerOutcome.v2"] = Field(alias="schema")
    identity: HistoricalRunnerIdentityV2
    result: Literal["SUCCEEDED", "FAILED"]
    artifacts: tuple[HistoricalReportArtifactV2, ...]
    report_status: ReportStatusV2 | None
    failure_code: FailureCodeV2 | None

    @model_validator(mode="after")
    def truthful_outcome(self) -> Self:
        validate_artifact_prefix(self.artifacts)
        full = len(self.artifacts) == len(REPORT_FILES_V2)
        if self.result == "SUCCEEDED":
            valid = full and self.report_status == "INTERNAL_REPORT_CHECK_PASSED"
            valid = valid and self.failure_code is None
        elif self.failure_code == "COMPONENT_CHECK_FAILED":
            valid = full and self.report_status == "INTERNAL_REPORT_CHECK_FAILED"
        elif self.failure_code == "PERSISTENCE_FAILED":
            valid = self.report_status is None
        else:
            valid = (
                self.failure_code in ("EXECUTION_FAILED", "EVIDENCE_INVALID")
                and not self.artifacts
                and self.report_status is None
            )
        if not valid:
            raise ValueError(_INVALID)
        return self


type HistoricalRunnerMessageV2 = RunnerStartedV2 | RunnerOutcomeV2


def validate_artifact_prefix(
    artifacts: tuple[HistoricalReportArtifactV2, ...],
) -> tuple[HistoricalReportArtifactV2, ...]:
    """Revalidate objects, including callers that bypassed Pydantic constructors."""
    try:
        if type(artifacts) is not tuple or len(artifacts) > len(REPORT_FILES_V2):
            raise ValueError(_INVALID)
        for i, artifact in enumerate(artifacts):
            if type(artifact) is not HistoricalReportArtifactV2:
                raise ValueError(_INVALID)
            HistoricalReportArtifactV2.model_validate(artifact.model_dump(warnings=False))
            if artifact.name != REPORT_FILES_V2[i][0]:
                raise ValueError(_INVALID)
    except (ValueError, TypeError, AttributeError, RecursionError) as error:
        raise ProtocolError(_INVALID) from error
    return artifacts


def _validated_message(message: HistoricalRunnerMessageV2) -> HistoricalRunnerMessageV2:
    if type(message) is RunnerStartedV2:
        return RunnerStartedV2.model_validate(message.model_dump(warnings=False))
    if type(message) is RunnerOutcomeV2:
        return RunnerOutcomeV2.model_validate(message.model_dump(warnings=False))
    raise ProtocolError(_INVALID)


def encode_historical_protocol_line(message: HistoricalRunnerMessageV2) -> bytes:
    try:
        validated = _validated_message(message)
        raw = _canonical_wire_bytes(validated.model_dump(mode="json")) + b"\n"
        if len(raw) > MAX_PROTOCOL_LINE_BYTES:
            raise ValueError(_INVALID)
        return raw
    except (ValueError, TypeError, AttributeError, RecursionError) as error:
        raise ProtocolError(_INVALID) from error


def parse_historical_protocol_line(raw: bytes) -> HistoricalRunnerMessageV2:
    try:
        value = _decode_wire_object(raw, max_bytes=MAX_PROTOCOL_LINE_BYTES)
        if value.get("schema") == "RunnerStarted.v2":
            parsed: HistoricalRunnerMessageV2 = RunnerStartedV2.model_validate(value)
        elif value.get("schema") == "RunnerOutcome.v2":
            parsed = RunnerOutcomeV2.model_validate(value)
        else:
            raise ValueError(_INVALID)
        if encode_historical_protocol_line(parsed) != raw:
            raise ValueError(_INVALID)
        return parsed
    except (ValueError, TypeError, AttributeError, RecursionError) as error:
        raise ProtocolError(_INVALID) from error


class HistoricalRunnerSequenceValidator:
    """One-use parent-side validator, poisoned on any invalid message or finish."""

    def __init__(self, *, expected: HistoricalRunnerIdentityV2) -> None:
        try:
            if type(expected) is not HistoricalRunnerIdentityV2:
                raise ValueError(_INVALID)
            self.expected = HistoricalRunnerIdentityV2.model_validate(
                expected.model_dump(warnings=False)
            )
        except (ValueError, TypeError, AttributeError) as error:
            raise ProtocolError(_INVALID) from error
        self._started = False
        self._closed = False
        self._outcome: RunnerOutcomeV2 | None = None

    def accept(self, message: HistoricalRunnerMessageV2) -> None:
        try:
            parsed = parse_historical_protocol_line(encode_historical_protocol_line(message))
            if self._closed or self._outcome or parsed.identity != self.expected:
                raise ProtocolError(_INVALID)
            if isinstance(parsed, RunnerStartedV2):
                if self._started:
                    raise ProtocolError(_INVALID)
                self._started = True
            else:
                if not self._started:
                    raise ProtocolError(_INVALID)
                self._outcome = parsed
        except ProtocolError:
            self._closed = True
            raise

    def finish(self, exit_code: int) -> RunnerOutcomeV2:
        closed, self._closed = self._closed, True
        if closed or not self._started or self._outcome is None or type(exit_code) is not int:
            raise ProtocolError(_INVALID)
        expected_exit = 0 if self._outcome.result == "SUCCEEDED" else 1
        if exit_code != expected_exit:
            raise ProtocolError(_INVALID)
        return self._outcome
