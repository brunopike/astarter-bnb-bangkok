"""Explicit historical observer evidence; never interchangeable with v1 exit bytes."""

from __future__ import annotations

from hashlib import sha256
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    field_validator,
    model_validator,
)

from stark_trading_os.audit.historical_input import parse_input_manifest_bytes
from stark_trading_os.catalog.historical_catalog import (
    canonical_historical_bytes,
    parse_historical_model_bytes,
)
from stark_trading_os.control.process_identity import (
    CancelPhase,
    Sha256Digest,
    SupervisorClassification,
    SupervisorFailureCode,
)
from stark_trading_os.runner.historical_protocol import HistoricalRunnerIdentityV2, RunnerOutcomeV2


def historical_identity(run_id: str, raw: bytes, digest: str) -> HistoricalRunnerIdentityV2:
    manifest = parse_input_manifest_bytes(raw, expected_sha256=digest)
    return HistoricalRunnerIdentityV2(
        run_id=run_id,
        input_manifest_sha256=digest,
        catalog_revision=manifest.dataset.catalog_revision,
        cost_sha256=manifest.cost_sha256,
        engine_package_version=manifest.runtime.engine_package_version,
        account_id="SIM-001",
    )


class SupervisorExitV2(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        strict=True,
        serialize_by_alias=True,
        validate_by_name=True,
        revalidate_instances="always",
    )
    schema_: Literal["SupervisorExit.v2"] = Field(default="SupervisorExit.v2", alias="schema")
    identity: HistoricalRunnerIdentityV2
    run_id: StrictStr
    spawn_nonce: StrictStr | None
    process_identity_sha256: Sha256Digest | None
    launched_at_ns: StrictInt | None
    ended_at_ns: StrictInt = Field(ge=0)
    duration_ns: StrictInt = Field(ge=0)
    exit_code: StrictInt | None
    signal: StrictInt | None
    final_cancel_phase: CancelPhase
    cooperative_cancel_acknowledged: Literal[False] = False
    stdout_size_bytes: StrictInt = Field(ge=0)
    stderr_size_bytes: StrictInt = Field(ge=0)
    stderr_sha256: Sha256Digest
    stderr_truncated: StrictBool
    child_outcome: RunnerOutcomeV2 | None
    classification: SupervisorClassification
    failure_code: SupervisorFailureCode | None
    proposed_terminal_state: Literal["COMPLETED", "FAILED", "CANCELLED"]

    @field_validator("child_outcome", mode="before")
    @classmethod
    def revalidate_child_projection(cls, value: object) -> object:
        # Pydantic instance revalidation projects aliased schema_ as a field name.
        # Supply the existing wire model's alias projection, retaining full validation.
        if type(value) is RunnerOutcomeV2:
            return value.model_dump(warnings=False)
        return value

    @model_validator(mode="after")
    def historical_binding(self) -> SupervisorExitV2:
        if self.run_id != self.identity.run_id or (
            self.child_outcome is not None and self.child_outcome.identity != self.identity
        ):
            raise ValueError("HISTORICAL_OBSERVER_INVALID")
        if self.classification in {"NATURAL_SUCCESS", "NATURAL_FAILURE"} and (
            self.spawn_nonce is None
            or self.launched_at_ns is None
            or self.final_cancel_phase in {"TERM_SENT", "KILL_SENT"}
        ):
            raise ValueError("HISTORICAL_OBSERVER_INVALID")
        if self.classification == "NO_SPAWN_CANCELLED" and (
            self.final_cancel_phase != "NONE"
            or self.stdout_size_bytes != 0
            or self.stderr_size_bytes != 0
            or self.stderr_sha256 != sha256(b"").hexdigest()
            or self.stderr_truncated
        ):
            raise ValueError("HISTORICAL_OBSERVER_INVALID")
        return self

    @model_validator(mode="after")
    def require_consistent_exit_shape(self) -> SupervisorExitV2:
        if self.exit_code is not None and self.signal is not None:
            raise ValueError("Exit code and signal are mutually exclusive.")
        if self.launched_at_ns is None:
            if self.process_identity_sha256 is not None or self.duration_ns != 0:
                raise ValueError("An unlaunched observation cannot carry process identity.")
        elif (
            self.process_identity_sha256 is None
            or self.ended_at_ns < self.launched_at_ns
            or self.duration_ns != self.ended_at_ns - self.launched_at_ns
        ):
            raise ValueError("Launched observation timing or identity is inconsistent.")
        if self.classification == "NATURAL_SUCCESS":
            if (
                self.child_outcome is None
                or self.child_outcome.result != "SUCCEEDED"
                or self.exit_code != 0
                or self.signal is not None
                or self.failure_code is not None
                or self.proposed_terminal_state != "COMPLETED"
            ):
                raise ValueError("Natural success requires a clean successful child outcome.")
        elif self.classification == "NATURAL_FAILURE":
            if (
                self.child_outcome is None
                or self.child_outcome.result != "FAILED"
                or self.exit_code != 1
                or self.signal is not None
                or self.failure_code != "CHILD_REPORTED_FAILURE"
                or self.proposed_terminal_state != "FAILED"
            ):
                raise ValueError("Natural failure requires a failed child outcome.")
        elif self.classification == "NO_SPAWN_CANCELLED":
            if (
                self.spawn_nonce is not None
                or self.launched_at_ns is not None
                or self.exit_code is not None
                or self.signal is not None
                or self.child_outcome is not None
                or self.failure_code is not None
                or self.proposed_terminal_state != "CANCELLED"
            ):
                raise ValueError("Clean cancellation requires proof that no spawn claim exists.")
        elif self.failure_code is None or self.proposed_terminal_state != "FAILED":
            raise ValueError("Supervisor failure requires one closed failure code.")
        return self


def historical_exit_bytes(outcome: SupervisorExitV2) -> bytes:
    try:
        if type(outcome) is not SupervisorExitV2:
            raise ValueError("HISTORICAL_OBSERVER_INVALID")
        validated = SupervisorExitV2.model_validate(outcome.model_dump(warnings=False))
        return canonical_historical_bytes(validated)
    except Exception:
        raise ValueError("HISTORICAL_OBSERVER_INVALID") from None


def historical_exit_from_bytes(raw: bytes) -> SupervisorExitV2:
    try:
        return parse_historical_model_bytes(raw, SupervisorExitV2)
    except Exception:
        raise ValueError("HISTORICAL_OBSERVER_INVALID") from None


class HistoricalRunnerOutcomeRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    run_id: StrictStr
    outcome: SupervisorExitV2
    outcome_bytes: bytes
    outcome_hash: Sha256Digest
    recorded_at_ns: StrictInt = Field(ge=0)

    @model_validator(mode="after")
    def exact_bytes(self) -> HistoricalRunnerOutcomeRecord:
        if (
            self.outcome.run_id != self.run_id
            or historical_exit_bytes(self.outcome) != self.outcome_bytes
            or sha256(self.outcome_bytes).hexdigest() != self.outcome_hash
        ):
            raise ValueError("HISTORICAL_OBSERVER_INVALID")
        return self
