"""HTTP models for the server-owned strategy configuration workflow."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StrictStr,
    field_validator,
)

from stark_trading_os.control.preflight_contract import validate_unix_epoch_ns
from stark_trading_os.domain.models import (
    DeterminismProbeConfigV1,
    JsonObject,
    RegistryReference,
    Sha256Digest,
)

type StrategyDraftId = Annotated[
    StrictStr,
    Field(pattern=r"^sd_[0-9a-f]{32}$", description="Server-generated strategy draft ID."),
]
type StrategyConfigurationId = Annotated[
    StrictStr,
    Field(pattern=r"^cfg_[0-9a-f]{32}$", description="Server-generated configuration version ID."),
]
type SavedReplaySeed = Annotated[StrictInt, Field(ge=0, le=(2**31) - 1)]
type PositiveRevision = Annotated[StrictInt, Field(ge=1, le=(2**53) - 1)]


def _validate_unix_epoch_ns_string(value: str) -> str:
    validate_unix_epoch_ns(int(value), label="HTTP observation timestamp")
    return value


type UnixEpochNanosecondString = Annotated[
    StrictStr,
    Field(pattern=r"^[1-9][0-9]{18}$"),
    AfterValidator(_validate_unix_epoch_ns_string),
]


class StrategyApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ConfigurationInput(StrategyApiModel):
    name: StrictStr = Field(min_length=1, max_length=120)
    strategy_ref: RegistryReference
    parameters: DeterminismProbeConfigV1
    replay_seed: SavedReplaySeed

    @field_validator("name", mode="before")
    @classmethod
    def normalize_name(cls, value: object) -> object:
        return value.strip() if type(value) is str else value


class StrategyDraft(ConfigurationInput):
    draft_id: StrategyDraftId
    revision: PositiveRevision
    created_at_ns: UnixEpochNanosecondString
    updated_at_ns: UnixEpochNanosecondString


class UpdateStrategyDraftRequest(ConfigurationInput):
    expected_revision: PositiveRevision


class PublishStrategyDraftRequest(StrategyApiModel):
    expected_revision: PositiveRevision


class StrategyConfigurationVersion(ConfigurationInput):
    configuration_id: StrategyConfigurationId
    draft_id: StrategyDraftId
    version: PositiveRevision
    source_revision: PositiveRevision
    content_sha256: Sha256Digest
    created_at_ns: UnixEpochNanosecondString


class StrategyDataRequirements(StrategyApiModel):
    catalog_purpose: Literal["LOCAL_QA_ONLY"]
    fixture_label: Literal["LOCAL QA FIXTURE"]
    data_types: tuple[Literal["instruments"], Literal["quotes"]]
    timezone: Literal["UTC"]


class StrategyDefinition(StrategyApiModel):
    strategy_ref: RegistryReference
    name: StrictStr
    purpose: Literal["QA_PROBE"]
    description: StrictStr
    parameters_schema: JsonObject
    default_parameters: DeterminismProbeConfigV1
    default_replay_seed: SavedReplaySeed
    execution_modes: tuple[Literal["BACKTEST"]]
    data_requirements: StrategyDataRequirements


class StrategyDefinitionList(StrategyApiModel):
    items: tuple[StrategyDefinition, ...]


class StrategyDraftList(StrategyApiModel):
    items: tuple[StrategyDraft, ...]


class StrategyConfigurationVersionList(StrategyApiModel):
    items: tuple[StrategyConfigurationVersion, ...]
