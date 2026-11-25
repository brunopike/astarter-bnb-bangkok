"""Content-only research artifacts and exact public/private reuse boundaries.

These pure checks never replace backend read/share authorization or settlement.
"""

from __future__ import annotations

from typing import Literal, Self

from pydantic import StrictBool, model_validator

from stark_trading_os.integrations.contracts import Identifier, ResearchOutput, RoleId, Timestamp
from stark_trading_os.integrations.research_egress import (
    Closed,
    Digest,
    EvidenceBinding,
    ModelProviderPolicy,
    PreparedResearchRequest,
    Reason,
    ResearchContext,
    ResearchRejected,
    canonical,
    check_request,
    check_structure,
    digest_text,
    encode,
)


class PublicScope(Closed):
    visibility: Literal["PUBLIC"] = "PUBLIC"


class PrivateScope(Closed):
    visibility: Literal["PRIVATE"] = "PRIVATE"
    tenant_id: Identifier
    principal_scope_id: Identifier
    account_scope_id: Identifier


class CacheDescriptor(Closed):
    format: Literal["FIXTURE_CACHE_V1"] = "FIXTURE_CACHE_V1"
    scope: PublicScope | PrivateScope
    context: ResearchContext
    role_id: RoleId
    profile_version: Identifier
    policy: ModelProviderPolicy
    bindings: tuple[EvidenceBinding, ...]


class ResearchArtifact(Closed):
    artifact_id: Identifier
    descriptor: CacheDescriptor
    semantic_key: Digest
    output: ResearchOutput
    output_sha256: Digest
    created_at_ms: Timestamp
    use_until_ms: Timestamp


class ResearchDelivery(Closed):
    status: Literal["READY", "WAIT", "DENIED", "FAILED"]
    origin: Literal["FRESH", "CACHE", "NONE"]
    artifact: ResearchArtifact | None = None
    reason: Reason
    dispatch_started: StrictBool

    @model_validator(mode="after")
    def consistent(self) -> Self:
        if self.status == "READY":
            if self.artifact is None or self.origin == "NONE" or self.reason != "OK":
                raise ValueError("invalid ready delivery")
        elif self.artifact is not None or self.origin != "NONE" or self.reason == "OK":
            raise ValueError("invalid unavailable delivery")
        if self.origin == "CACHE" and self.dispatch_started:
            raise ValueError("cache cannot start a dispatch")
        if self.origin == "FRESH" and not self.dispatch_started:
            raise ValueError("fresh output requires a dispatch")
        return self


DELIVERY_TYPES = (PublicScope, PrivateScope, CacheDescriptor, ResearchArtifact, ResearchDelivery)


def _descriptor(req: PreparedResearchRequest) -> CacheDescriptor:
    spec = req.spec
    scope: PublicScope | PrivateScope
    if spec.context.classification == "PUBLIC" and spec.context.funding == "PLATFORM":
        scope = PublicScope()
    else:
        scope = PrivateScope(
            tenant_id=spec.identity.tenant_id,
            principal_scope_id=spec.identity.principal_scope_id,
            account_scope_id=spec.identity.account_scope_id,
        )
    return CacheDescriptor(
        scope=scope,
        context=spec.context,
        role_id=spec.task.role_id,
        profile_version=spec.task.profile_version,
        policy=spec.policy,
        bindings=spec.bindings,
    )


def _key(descriptor: CacheDescriptor) -> str:
    return digest_text(encode(descriptor.model_dump(mode="json")))


def semantic_key(value: object) -> str:
    return _key(_descriptor(check_structure(value)))


def _output(value: object, req: PreparedResearchRequest) -> ResearchOutput:
    output = canonical(value, ResearchOutput)
    if not set(output.evidence_ids) <= {item.evidence_id for item in req.spec.bindings}:
        raise ResearchRejected("INVALID_OUTPUT")
    return output


def _use_until(req: PreparedResearchRequest) -> int:
    return min(req.spec.policy.valid_until_ms, *(item.valid_until_ms for item in req.spec.bindings))


def make_artifact(
    value: object,
    output: object,
    *,
    artifact_id: str,
    created_at_ms: int,
) -> ResearchArtifact:
    """Pure construction only; trusted caller must settle and authorize publication."""
    req = check_structure(value)
    req = check_request(
        req,
        now_ms=created_at_ms,
        clock_epoch=req.spec.clock_epoch,
        for_dispatch=False,
    )
    result = _output(output, req)
    descriptor = _descriptor(req)
    artifact: ResearchArtifact | None = None
    try:
        if type(artifact_id) is str:
            artifact = ResearchArtifact(
                artifact_id=artifact_id,
                descriptor=descriptor,
                semantic_key=_key(descriptor),
                output=result,
                output_sha256=digest_text(encode(result.model_dump(mode="json"))),
                created_at_ms=created_at_ms,
                use_until_ms=_use_until(req),
            )
    except Exception:
        pass
    if artifact is None:
        raise ResearchRejected
    return artifact


def check_artifact(
    value: object,
    artifact: object,
    *,
    now_ms: int,
    clock_epoch: str,
) -> ResearchArtifact:
    req = check_request(value, now_ms=now_ms, clock_epoch=clock_epoch, for_dispatch=False)
    item = canonical(artifact, ResearchArtifact, extra=DELIVERY_TYPES)
    descriptor = _descriptor(req)
    result = _output(item.output, req)
    if (
        item.descriptor != descriptor
        or item.semantic_key != _key(descriptor)
        or item.output_sha256 != digest_text(encode(result.model_dump(mode="json")))
        or not item.created_at_ms <= now_ms < item.use_until_ms <= _use_until(req)
    ):
        raise ResearchRejected("BINDING_MISMATCH")
    return item


def ready_delivery(
    artifact: object,
    *,
    origin: Literal["FRESH", "CACHE"],
    dispatch_started: bool,
) -> ResearchDelivery:
    item = canonical(artifact, ResearchArtifact, extra=DELIVERY_TYPES)
    result: ResearchDelivery | None = None
    try:
        if type(origin) is str and type(dispatch_started) is bool:
            result = ResearchDelivery(
                status="READY",
                origin=origin,
                artifact=item,
                reason="OK",
                dispatch_started=dispatch_started,
            )
    except Exception:
        pass
    if result is None:
        raise ResearchRejected
    return result
