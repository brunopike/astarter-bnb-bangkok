"""Closed PRIVATE UI DTOs. No connections, credentials or authority issuance."""

import re
from typing import Annotated, Any, Literal

from pydantic import ConfigDict, Field, field_validator, model_validator

from .private_research_contracts import MAX_SAFE_INTEGER, Identifier, Millis, PrivateDTO

UI_PERMISSIONS = (
    "research:analyze", "notifications:read", "notifications:write",
    "workspace:read", "workspace:write",
)
STRATEGY_IDS = frozenset({"S00", "S01", "S02", "S03", "S04", "S05", "S06", "S07",
                          "S08", "S09-A", "S09-L", "RX01", "RX02-P", "RX02-A", "RX03-S",
                          "RX03-B", "RX04", "RX05"})
Revision = Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER)]
RequestId = Annotated[str, Field(pattern=r"^[A-Za-z0-9:_-]{8,96}$", max_length=96)]
EventId = Annotated[str, Field(pattern=r"^[A-Za-z0-9:._-]{1,128}$", max_length=128)]
EventType = Literal["orders", "risk", "research"]
EVENTS: tuple[EventType, ...] = ("orders", "risk", "research")
Domain = Literal["notifications", "workspace"]
_SECRET = re.compile(
    r"\bBearer\s+[A-Za-z0-9._-]{16,}|\bsk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{16,}|"
    r"(?:https?|postgres(?:ql)?)://[^\s/@:]+:[^\s/@]+@|\b0x[0-9a-fA-F]{64}\b"
)


class UIContract(PrivateDTO):
    # Server wire DTOs accept aliases only, including nested objects.
    model_config = ConfigDict(
        strict=True, frozen=True, extra="forbid", populate_by_name=False,
        validate_by_name=False, validate_by_alias=True,
    )


def plain_text(value: str) -> str:
    if re.search(r"[\x00-\x1f\x7f]", value) or _SECRET.search(value):
        raise ValueError("PRIVATE_UI_TEXT_REJECTED")
    return value


def _events(value: list[EventType]) -> list[EventType]:
    if len(set(value)) != len(value):
        raise ValueError("PRIVATE_UI_DUPLICATE")
    return [event for event in EVENTS if event in value]


class UIBinding(UIContract):
    lease_id: Identifier = Field(alias="leaseId")
    target_id: Identifier = Field(alias="targetId")
    audience: Literal["astarter-research"]


class UIRequest(UIBinding):
    request_id: RequestId = Field(alias="requestId")

    _plain_request_id = field_validator("request_id")(plain_text)


class UIWrite(UIRequest):
    base_revision: Revision = Field(alias="baseRevision")


class NotificationRead(UIBinding):
    cursor: Annotated[str, Field(min_length=1, max_length=512, pattern=r"^[A-Za-z0-9_-]+$")] | None
    limit: Annotated[int, Field(ge=1, le=50)]
    response_version: Literal[2] | None = Field(default=None, alias="responseVersion")

    @field_validator("response_version", mode="before")
    @classmethod
    def explicit_response_version(cls, value: Any) -> Any:
        if type(value) is not int or value != 2:
            raise ValueError("PRIVATE_UI_RESPONSE_VERSION")
        return value


class ChannelsEnabled(UIContract):
    telegram: bool
    email: bool


class NotificationPreferences(UIContract):
    events: Annotated[list[EventType], Field(max_length=3)]
    enabled: ChannelsEnabled
    inapp: bool

    _canonical_events = field_validator("events")(_events)


class MarkRead(UIContract):
    ids: Annotated[list[EventId], Field(min_length=1, max_length=50)]

    @field_validator("ids")
    @classmethod
    def unique_ids(cls, value: list[str]) -> list[str]:
        for item in value:
            plain_text(item)
        if len(set(value)) != len(value):
            raise ValueError("PRIVATE_UI_DUPLICATE")
        return sorted(value)


class NotificationCommand(UIWrite):
    action: Literal["save", "mark-read"]
    payload: NotificationPreferences | MarkRead

    @model_validator(mode="after")
    def matching_action(self) -> "NotificationCommand":
        if (self.action == "save") != isinstance(self.payload, NotificationPreferences):
            raise ValueError("PRIVATE_UI_ACTION")
        return self


class WorkspacePreferences(UIContract):
    workbench_filter: Literal["all", "scan", "tracked"] = Field(alias="workbenchFilter")
    workbench_focus_asset: Annotated[
        str, Field(pattern=r"^[A-Z0-9][A-Z0-9._-]{0,31}$", max_length=32)
    ] | None = Field(alias="workbenchFocusAsset")
    watched_assets: Annotated[list[str], Field(max_length=200)] = Field(alias="watchedAssets")

    @field_validator("watched_assets")
    @classmethod
    def watch_keys(cls, value: list[str]) -> list[str]:
        for key in value:
            if len(key) > 256:
                raise ValueError("PRIVATE_UI_WATCH_KEY")
            parts = key.split(":")
            valid = bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,149}", key))
            if len(parts) == 2 and parts[0] == "coin":
                valid = bool(re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,149}", parts[1]))
            elif len(parts) == 3 and parts[0] == "ca":
                valid = bool(
                    re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,149}", parts[1])
                    and (re.fullmatch(r"0x(?:[0-9a-f]{40}|[0-9a-f]{64})", parts[2], re.I)
                         or re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{32,44}", parts[2]))
                )
            if not valid:
                raise ValueError("PRIVATE_UI_WATCH_KEY")
            # A typed CA may legitimately contain a 32-byte address, not a secret.
            plain_text(parts[1] if len(parts) == 3 and parts[0] == "ca" else key)
        if len(set(value)) != len(value):
            raise ValueError("PRIVATE_UI_DUPLICATE")
        return value


class DraftMetadata(UIContract):
    id: Annotated[str, Field(pattern=r"^[A-Za-z0-9:_-]{1,96}$", max_length=96)]
    strategy_id: Annotated[str, Field(max_length=16)] = Field(alias="strategyId")
    name: Annotated[str, Field(min_length=1, max_length=120)]

    _plain_metadata = field_validator("id", "name")(plain_text)

    @field_validator("strategy_id")
    @classmethod
    def known_strategy(cls, value: str) -> str:
        if value not in STRATEGY_IDS:
            raise ValueError("PRIVATE_UI_STRATEGY")
        return value


class WorkspaceFields(UIContract):
    preferences: WorkspacePreferences
    drafts: Annotated[list[DraftMetadata], Field(max_length=50)]
    selected_draft_id: Annotated[str, Field(max_length=96)] | None = Field(alias="selectedDraftId")

    @field_validator("selected_draft_id")
    @classmethod
    def plain_selection(cls, value: str | None) -> str | None:
        return plain_text(value) if value is not None else None

    @model_validator(mode="after")
    def draft_selection(self) -> "WorkspaceFields":
        ids = [draft.id for draft in self.drafts]
        if len(set(ids)) != len(ids) or (
            self.selected_draft_id is not None and self.selected_draft_id not in ids
        ):
            raise ValueError("PRIVATE_UI_DRAFT_SELECTION")
        return self


class WorkspaceSave(UIWrite, WorkspaceFields):
    pass


class ChannelState(UIContract):
    channel: Literal["telegram", "email"]
    label: Annotated[str, Field(max_length=160)]
    enabled: Annotated[int, Field(ge=0, le=1)]
    verified: Millis


class ChannelStates(UIContract):
    telegram: ChannelState
    email: ChannelState


class ServiceState(UIContract):
    available: bool
    error: Literal["CHANNEL_DISABLED"] | None


class Services(UIContract):
    telegram: ServiceState
    email: ServiceState


class InboxItem(UIContract):
    id: EventId
    type: Literal["research", "risk"]
    title: Annotated[str, Field(min_length=1, max_length=160)]
    body: Annotated[str, Field(min_length=1, max_length=1200)]
    source: Literal["server-research"]
    request_id: RequestId = Field(alias="requestId")
    created_at: Millis = Field(alias="createdAt")
    read_at: Millis | None = Field(alias="readAt")
    execution_authority: Literal["NONE"] = Field(alias="executionAuthority")

    _plain_content = field_validator("title", "body")(plain_text)


class _NotificationStateFields(UIContract):
    schema_name: str = Field(alias="schema")
    scope: Identifier
    revision: Revision
    updated_at: Millis = Field(alias="updatedAt")
    inapp: bool
    events: Annotated[list[EventType], Field(max_length=3)]
    services: Services
    channels: ChannelStates
    deliveries: Annotated[list[Any], Field(max_length=0)]
    inbox: Annotated[list[InboxItem], Field(max_length=50)]
    unread_count: Revision = Field(alias="unreadCount")
    next_cursor: Annotated[str, Field(max_length=512)] | None = Field(alias="nextCursor")
    mode: Literal["server-research-only"]

    _canonical_events = field_validator("events")(_events)

    @model_validator(mode="after")
    def no_external_delivery(self) -> "_NotificationStateFields":
        for name in ("telegram", "email"):
            service = getattr(self.services, name)
            channel = getattr(self.channels, name)
            if (service.available or service.error != "CHANNEL_DISABLED" or channel.label
                    or channel.enabled != 0 or channel.verified != 0 or channel.channel != name):
                raise ValueError("PRIVATE_UI_DELIVERY_DISABLED")
        return self


class NotificationState(_NotificationStateFields):
    schema_name: Literal["private-notifications-v1"] = Field(alias="schema")


class NotificationStateV2(_NotificationStateFields):
    schema_name: Literal["private-notifications-v2"] = Field(alias="schema")
    reminder_unread_count: Revision = Field(alias="reminderUnreadCount")

    @model_validator(mode="after")
    def bounded_reminder_count(self) -> "NotificationStateV2":
        if (self.reminder_unread_count > self.unread_count
                or (not self.inapp or not self.events) and self.reminder_unread_count != 0):
            raise ValueError("PRIVATE_UI_REMINDER_COUNT")
        return self


class WorkspaceState(WorkspaceFields):
    schema_name: Literal["private-workspace-v1"] = Field(alias="schema")
    scope: Identifier
    revision: Revision
    updated_at: Millis = Field(alias="updatedAt")
    execution_authority: Literal["NONE"] = Field(alias="executionAuthority")


class MutationReceipt(UIContract):
    schema_name: Literal["private-ui-command-v1"] = Field(alias="schema")
    domain: Domain
    request_id: RequestId = Field(alias="requestId")
    status: Literal["applied"]
    base_revision: Revision = Field(alias="baseRevision")
    revision: Revision
    applied_at: Millis = Field(alias="appliedAt")


class CommandResult(UIContract):
    request: MutationReceipt
    state: NotificationState | WorkspaceState

    @model_validator(mode="after")
    def consistent_result(self) -> "CommandResult":
        if (self.request.domain == "notifications") != isinstance(self.state, NotificationState):
            raise ValueError("PRIVATE_UI_DOMAIN")
        if self.request.revision != self.state.revision:
            raise ValueError("PRIVATE_UI_REVISION")
        return self


UI_METHODS: dict[str, type[PrivateDTO]] = {
    "notifications/state": NotificationRead, "notifications/command": NotificationCommand,
    "notifications/request": UIRequest, "workspace/state": UIBinding,
    "workspace/save": WorkspaceSave, "workspace/request": UIRequest,
}


def ui_input(operation: str, payload: dict[str, Any]) -> PrivateDTO:
    model = UI_METHODS.get(operation)
    if model is None:
        raise ValueError("PRIVATE_REQUEST_INVALID")
    return model.model_validate(payload)
