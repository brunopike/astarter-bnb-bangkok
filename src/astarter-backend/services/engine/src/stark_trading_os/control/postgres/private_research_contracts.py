"""PRIVATE research v1 units and server-owned identity DTOs; no IO or authority issuance."""

from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

CONTRACT = "ASTARTER_PRIVATE_RESEARCH_V1"
AUDIENCE = "astarter-research"
SCHEMA = "astarter_private"
MODEL = "openai/gpt-4.1-mini"
MONTHLY_MAX_MICROUSD = 50_000_000
RESERVED_TOKENS = 13_056  # 12,000 serialized UTF8 bytes + 256 framing + 800 output.
PROMPT_MICROUSD_PER_MILLION = 400_000
COMPLETION_MICROUSD_PER_MILLION = 1_600_000
MAX_SAFE_INTEGER = 2**53 - 1

Identifier = Annotated[str, Field(pattern=r"^[A-Za-z0-9:_-]{1,128}$", max_length=128)]
SqlIdentifier = Annotated[str, Field(pattern=r"^[a-z_][a-z0-9_]{0,62}$", max_length=63)]
Millis = Annotated[int, Field(ge=0, le=253402300799999)]


class PrivateDTO(BaseModel):
    model_config = ConfigDict(strict=True, frozen=True, extra="forbid", populate_by_name=True)


class PrivateLease(PrivateDTO):
    lease_id: Identifier = Field(alias="leaseId")
    target_id: Identifier = Field(alias="targetId")
    database: SqlIdentifier
    schema_name: Literal["astarter_private"] = Field(alias="schema")
    runtime_role: SqlIdentifier = Field(alias="runtimeRole")
    audience: Literal["astarter-research"]
    budget_id: Identifier = Field(alias="budgetId")
    model: Literal["openai/gpt-4.1-mini"]
    expires_at: Millis = Field(alias="expiresAt")


class PrivatePrincipal(PrivateDTO):
    """Only trusted session resolution constructs this; request body fields cannot authenticate."""

    subject_id: Identifier = Field(alias="subjectId")
    tenant_id: Identifier = Field(alias="tenantId")
    scope_id: Identifier = Field(alias="scopeId")
    audience: Literal["astarter-research"]
    expires_at: Millis = Field(alias="expiresAt")
    permissions: tuple[Literal["research:analyze"], ...]

    @field_validator("permissions", mode="before")
    @classmethod
    def json_permissions(cls, value: Any) -> Any:
        return tuple(value) if type(value) is list else value

    @model_validator(mode="after")
    def canonical_scope(self) -> "PrivatePrincipal":
        if self.scope_id != self.tenant_id or self.permissions != ("research:analyze",):
            raise ValueError("PRIVATE_IDENTITY_REJECTED")
        return self


class RequestIdentity(PrivateDTO):
    subject_id: Identifier = Field(alias="subjectId")
    tenant_id: Identifier = Field(alias="tenantId")
    scope_id: Identifier = Field(alias="scopeId")
    request_id: Annotated[str, Field(pattern=r"^[A-Za-z0-9:_-]{8,96}$", max_length=96)] = Field(
        alias="requestId"
    )

    @model_validator(mode="after")
    def canonical_scope(self) -> "RequestIdentity":
        if self.scope_id != self.tenant_id:
            raise ValueError("PRIVATE_SCOPE_REJECTED")
        return self


def reserve_microusd(tokens: int = RESERVED_TOKENS) -> int:
    """Integer ceiling at the approved higher price; never accept a client-supplied price."""
    if type(tokens) is not int or not 0 < tokens <= RESERVED_TOKENS:
        raise ValueError("PRIVATE_BUDGET_REJECTED")
    return (tokens * COMPLETION_MICROUSD_PER_MILLION + 999_999) // 1_000_000


def utc_month_bounds(now_ms: int) -> tuple[int, int]:
    if type(now_ms) is not int or not 0 <= now_ms <= 253402300799999:
        raise ValueError("PRIVATE_CLOCK_REJECTED")
    current = datetime.fromtimestamp(now_ms / 1000, UTC)
    if current.year == 9999 and current.month == 12:
        raise ValueError("PRIVATE_CLOCK_REJECTED")
    start = datetime(current.year, current.month, 1, tzinfo=UTC)
    end = datetime(current.year + (current.month == 12), current.month % 12 + 1, 1, tzinfo=UTC)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)
