"""Frozen SIWE issuer wire validation; cryptographic authority stays with the issuer."""

from typing import Annotated, Any, ClassVar, Literal

from pydantic import (
    Field,
    SerializerFunctionWrapHandler,
    field_validator,
    model_serializer,
    model_validator,
)

from .private_research_contracts import Millis, PrivateDTO
from .private_ui_contracts import UI_PERMISSIONS

Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$", max_length=64)]
Address = Annotated[str, Field(pattern=r"^0x[0-9a-fA-F]{40}$", max_length=42)]
Chain = Annotated[int, Field(ge=56, le=56)]
Origin = Literal["https://astarter.imstark.site"]
Message = Annotated[str, Field(min_length=1, max_length=4096)]
UI_RESOURCE = "- urn:astarter:permission-profile:private-ui-v2"


class _Authority(PrivateDTO):
    auth_version: Literal[1, 2] = Field(default=1, alias="authVersion")
    permission_profile: Literal["research-v1", "private-ui-v2"] = Field(
        default="research-v1", alias="permissionProfile"
    )

    @model_validator(mode="before")
    @classmethod
    def exact_authority_wire(cls, value: Any) -> Any:
        if type(value) is not dict or {"auth_version", "permission_profile"} & value.keys():
            raise ValueError("PRIVATE_REQUEST_INVALID")
        extension = {"authVersion", "permissionProfile"} & value.keys()
        if extension and (
            extension != {"authVersion", "permissionProfile"}
            or type(value["authVersion"]) is not int or value["authVersion"] != 2
            or value["permissionProfile"] != "private-ui-v2"
        ):
            raise ValueError("PRIVATE_REQUEST_INVALID")
        return value

    @field_validator("auth_version", mode="before")
    @classmethod
    def integer_version(cls, value: object) -> object:
        if type(value) is not int:
            raise ValueError("PRIVATE_REQUEST_INVALID")
        return value

    @model_validator(mode="after")
    def fixed_profile(self) -> "_Authority":
        expected = "research-v1" if self.auth_version == 1 else "private-ui-v2"
        if self.permission_profile != expected:
            raise ValueError("PRIVATE_REQUEST_INVALID")
        return self

    @model_serializer(mode="wrap")
    def wire_profile(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        result: dict[str, Any] = handler(self)
        if self.auth_version == 1:
            for key in ("authVersion", "permissionProfile", "auth_version", "permission_profile"):
                result.pop(key, None)
        return result


class _Window(PrivateDTO):
    lifetime_ms: ClassVar[int]
    issued_at: Millis = Field(alias="issuedAt")
    expires: Millis

    @model_validator(mode="after")
    def exact_window(self) -> "_Window":
        if self.expires - self.issued_at != self.lifetime_ms:
            raise ValueError("PRIVATE_REQUEST_INVALID")
        return self


class IssueChallenge(_Window, _Authority):
    lifetime_ms = 300_000
    challenge_hash: Digest = Field(alias="challengeHash")
    nonce: Digest
    origin: Origin
    address: None
    chain: None
    message: None


class ChallengeKey(PrivateDTO):
    challenge_hash: Digest = Field(alias="challengeHash")
    now: Millis


class ChallengeBinding(ChallengeKey, _Authority):
    nonce: Digest
    address: Address
    chain: Chain
    message: Message

    @field_validator("message")
    @classmethod
    def bounded_message_bytes(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 4096:
            raise ValueError("PRIVATE_REQUEST_INVALID")
        return value

    @model_validator(mode="after")
    def explicit_ui_consent(self) -> "ChallengeBinding":
        if self.auth_version == 2 and UI_RESOURCE not in self.message.splitlines():
            raise ValueError("PRIVATE_REQUEST_INVALID")
        return self


class SessionKey(PrivateDTO):
    token_hash: Digest = Field(alias="tokenHash")
    now: Millis


class IssueSession(_Window, _Authority):
    lifetime_ms = 604_800_000
    token_hash: Digest = Field(alias="tokenHash")
    previous_token_hash: Digest | None = Field(alias="previousTokenHash")
    challenge_hash: Digest = Field(alias="challengeHash")
    claim_token: Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{32,128}$", max_length=128)] = Field(
        alias="claimToken"
    )
    address: Address
    chain: Chain
    origin: Origin
    permissions: tuple[str, ...] = Field(min_length=1, max_length=5)

    @field_validator("permissions", mode="before")
    @classmethod
    def json_permissions(cls, value: object) -> object:
        return tuple(value) if type(value) is list else value

    @model_validator(mode="after")
    def exact_authority(self) -> "IssueSession":
        expected = UI_PERMISSIONS if self.auth_version == 2 else ("research:analyze",)
        if self.permissions != expected or self.previous_token_hash == self.token_hash:
            raise ValueError("PRIVATE_REQUEST_INVALID")
        return self


_ISSUER_INPUTS: dict[str, type[PrivateDTO]] = {
    "auth/challenge/issue": IssueChallenge,
    "auth/challenge/get": ChallengeKey,
    "auth/challenge/prepare": ChallengeBinding,
    "auth/challenge/consume": ChallengeBinding,
    "auth/challenge/revoke": ChallengeKey,
    "auth/session/issue": IssueSession,
    "auth/session/resolve": SessionKey,
    "auth/session/revoke": SessionKey,
}


def issuer_input(operation: str, payload: dict[str, object]) -> PrivateDTO:
    model = _ISSUER_INPUTS.get(operation)
    if model is None:
        raise ValueError("PRIVATE_REQUEST_INVALID")
    return model.model_validate(payload)
