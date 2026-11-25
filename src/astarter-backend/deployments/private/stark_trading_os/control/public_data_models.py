"""Public HTTP metadata over provider-owned immutable observation contracts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Literal, Self

from pydantic import Field, StrictInt, model_validator

from stark_trading_os.integrations.public_data import PublicDataBatch

type PublicDataResource = Literal["markets", "assets", "news", "explorer/capabilities"]


@dataclass(frozen=True, slots=True)
class PublicDataQuery:
    resource: PublicDataResource
    asset_ids: tuple[str, ...] = ("bitcoin", "ethereum", "solana")
    limit: int = 20
    chain_id: str | None = None


class PublicDataPayload(PublicDataBatch):
    @model_validator(mode="after")
    def require_observation_evidence(self) -> Self:
        if not self.sources:
            raise ValueError("SOURCE_EVIDENCE_REQUIRED")
        if self.quality == "unavailable":
            if self.items or self.as_of_ms is not None:
                raise ValueError("UNAVAILABLE_CANNOT_CARRY_SNAPSHOT")
        elif self.as_of_ms is None:
            raise ValueError("OBSERVATION_TIME_REQUIRED")
        if not self.items and self.quality != "unavailable":
            if (
                self.coverage.scope != "NEWS_FEED"
                or self.coverage.requested_subjects != ("news",)
                or self.coverage.gaps
            ):
                raise ValueError("EMPTY_FEED_COVERAGE_REQUIRED")
            if self.quality == "fresh" and not any(s.status == "OK" for s in self.sources):
                raise ValueError("EMPTY_FEED_SUCCESS_REQUIRED")
            if not any(s.last_success_at_ms is not None for s in self.sources):
                raise ValueError("EMPTY_FEED_SUCCESS_TIME_REQUIRED")
        return self


class PublicDataResponse(PublicDataPayload):
    schema_version: Literal["AstarterPublicData.v1"] = "AstarterPublicData.v1"
    tenant_scope: Literal["PUBLIC"] = "PUBLIC"
    projection_version: Literal["public-data-projection.v1"] = "public-data-projection.v1"
    real_trading_connected: Literal[False] = False
    execution_binding: Literal["NONE"] = "NONE"
    request_id: str
    selection_version: Annotated[StrictInt, Field(ge=0, le=2147483647)]
    requested_at_ms: Annotated[StrictInt, Field(ge=0, le=253402300799999)]
