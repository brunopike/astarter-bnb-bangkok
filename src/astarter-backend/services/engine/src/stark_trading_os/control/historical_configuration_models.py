"""Typed historical configuration records, separate from legacy HTTP models."""

from typing import Self

from pydantic import BaseModel, ConfigDict, model_validator

from stark_trading_os.control.strategy_models import (
    PositiveRevision,
    StrategyConfigurationId,
    StrategyDraftId,
    UnixEpochNanosecondString,
)
from stark_trading_os.domain.historical_input import Digest, SmaConfigurationInputV2


class _HistoricalConfigurationRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    configuration: SmaConfigurationInputV2
    draft_id: StrategyDraftId
    created_at_ns: UnixEpochNanosecondString


class HistoricalStrategyDraftV2(_HistoricalConfigurationRecord):
    revision: PositiveRevision
    updated_at_ns: UnixEpochNanosecondString

    @model_validator(mode="after")
    def ordered_times(self) -> Self:
        if int(self.updated_at_ns) < int(self.created_at_ns):
            raise ValueError("Historical draft timestamps are reversed.")
        return self


class HistoricalStrategyConfigurationVersionV2(_HistoricalConfigurationRecord):
    configuration_id: StrategyConfigurationId
    version: PositiveRevision
    source_revision: PositiveRevision
    content_sha256: Digest

    @model_validator(mode="after")
    def ordered_revisions(self) -> Self:
        if self.version > self.source_revision:
            raise ValueError("Published version cannot exceed source revision.")
        return self
