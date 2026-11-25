"""Closed, offline research inputs. DTOs and hashes do not issue authorization.

Only a trusted backend may issue/resolve grants. FIXTURE_REQUEST_V1 is not the
OpenRouter wire renderer. No keys, network, ledger or production defaults here.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Annotated, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr

from stark_trading_os.integrations.contracts import (
    Contract,
    Evidence,
    Identifier,
    ModelResult,
    ResearchOutput,
    ResearchTask,
    Timestamp,
    Usage,
)

Digest = Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]
Atoms = Annotated[StrictInt, Field(ge=0, lt=2**127)]
Version = Annotated[StrictInt, Field(ge=0, lt=2**63)]
type Reason = Literal[
    "INVALID_INPUT",
    "BINDING_MISMATCH",
    "EXPIRED",
    "CLOCK_INVALID",
    "CANCELLED",
    "DENIED",
    "WAITING",
    "UNKNOWN_CHARGE",
    "UNAVAILABLE",
    "TIMEOUT",
    "INVALID_OUTPUT",
    "ALREADY_STARTED",
    "BUDGET_DENIED",
    "OK",
]
_REASONS = frozenset(
    {
        "INVALID_INPUT",
        "BINDING_MISMATCH",
        "EXPIRED",
        "CLOCK_INVALID",
        "CANCELLED",
        "DENIED",
        "WAITING",
        "UNKNOWN_CHARGE",
        "UNAVAILABLE",
        "TIMEOUT",
        "INVALID_OUTPUT",
        "ALREADY_STARTED",
        "BUDGET_DENIED",
        "OK",
    }
)


class ResearchRejected(ValueError):
    def __init__(self, reason: Reason = "INVALID_INPUT") -> None:
        self.reason: Reason = (
            reason if type(reason) is str and reason in _REASONS else "INVALID_INPUT"
        )
        super().__init__(self.reason)


class Closed(Contract):
    model_config = ConfigDict(hide_input_in_errors=True)


class ResearchIdentity(Closed):
    logical_request_id: Identifier
    task_id: Identifier
    attempt_id: Identifier
    parent_attempt_id: Identifier | None
    tenant_id: Identifier
    principal_scope_id: Identifier
    account_scope_id: Identifier
    key_owner_id: Identifier
    credential_binding_revision: Identifier
    purpose: Literal["OFFLINE_FIXTURE"]


class EvidenceBinding(Closed):
    evidence_id: Identifier
    utf8_sha256: Digest
    source_id: Identifier
    source_revision: Identifier
    evidence_revision: Identifier
    rights_revision: Identifier
    available_at_ms: Timestamp
    valid_until_ms: Timestamp
    classification: Literal["PUBLIC", "PRIVATE"]
    use_allowed: StrictBool
    share_allowed: StrictBool
    egress_allowed: StrictBool


class ModelProviderPolicy(Closed):
    policy_id: Identifier
    revision: Identifier
    model: Identifier
    providers: Annotated[tuple[Identifier, ...], Field(min_length=1, max_length=8)]
    data_policy_revision: Identifier
    renderer_revision: Literal["FIXTURE_REQUEST_V1"]
    system_sha256: Digest
    schema_sha256: Digest
    max_output_tokens: Annotated[StrictInt, Field(ge=1, le=4096)]
    valid_until_ms: Timestamp
    allow_fallbacks: StrictBool


class BudgetQuote(Closed):
    quote_id: Identifier
    revision: Identifier
    unit_id: Literal["SIM_MODEL_CREDIT_V1"]
    scale: Annotated[StrictInt, Field(ge=6, le=6)]
    reserve_atoms: Atoms
    pricing_revision: Identifier
    coverage_revision: Identifier
    valid_until_ms: Timestamp


class ResearchContext(Closed):
    asset: Identifier
    venue: Identifier
    market: Literal["SPOT", "PERP"]
    strategy_revision: Identifier
    classification: Literal["PUBLIC", "PRIVATE"]
    funding: Literal["PLATFORM", "BYOK"]
    sharing_revision: Identifier
    use_policy_revision: Identifier


class RequestSpec(Closed):
    identity: ResearchIdentity
    task: ResearchTask
    bindings: Annotated[tuple[EvidenceBinding, ...], Field(min_length=1, max_length=8)]
    policy: ModelProviderPolicy
    quote: BudgetQuote
    context: ResearchContext
    enqueued_at_ms: Timestamp
    deadline_ms: Timestamp
    clock_epoch: Identifier


class PreparedResearchRequest(Closed):
    spec: RequestSpec
    payload: Annotated[StrictStr, Field(min_length=1, max_length=131072)] = Field(repr=False)
    payload_sha256: Digest


class EgressGrant(Closed):
    grant_id: Identifier
    grant_revision: Identifier
    issuer_revision: Identifier
    revocation_epoch: Version
    identity: ResearchIdentity
    request_sha256: Digest
    payload_sha256: Digest
    evidence: tuple[EvidenceBinding, ...]
    model_policy_id: Identifier
    model_policy_revision: Identifier
    model: Identifier
    dispatch_before_ms: Timestamp
    quote_id: Identifier
    quote_revision: Identifier


class ChargeObservation(Closed):
    """Untrusted charge claim until the backend resolves its source/receipt."""

    task_id: Identifier
    attempt_id: Identifier
    key_owner_id: Identifier
    provider: Identifier
    request_id: Identifier
    unit_id: Literal["SIM_MODEL_CREDIT_V1"]
    scale: Annotated[StrictInt, Field(ge=6, le=6)]
    atoms: Atoms
    source_ref: Identifier
    source_revision: Identifier
    event_id: Identifier


_CLOSED: frozenset[type[BaseModel]] = frozenset(
    {
        ResearchIdentity,
        EvidenceBinding,
        ModelProviderPolicy,
        BudgetQuote,
        ResearchContext,
        RequestSpec,
        PreparedResearchRequest,
        EgressGrant,
        ChargeObservation,
        Evidence,
        ResearchTask,
        ResearchOutput,
        ModelResult,
        Usage,
    }
)


def _plain(value: object, allowed: frozenset[type[BaseModel]]) -> object:
    """Copy a bounded exact-type tree without invoking user equality/serialization."""
    remaining = [10000]

    def visit(item: object, depth: int) -> object:
        remaining[0] -= 1
        if depth > 20 or remaining[0] < 0:
            raise ValueError
        kind = type(item)
        if item is None or kind in {bool, int}:
            return item
        if kind is str:
            if len(cast(str, item)) > 131072:
                raise ValueError
            return item
        if kind is float:
            if not math.isfinite(cast(float, item)):
                raise ValueError
            return item
        if kind in allowed:
            data = object.__getattribute__(item, "__dict__")
            extra = object.__getattribute__(item, "__pydantic_extra__")
            if type(data) is not dict or extra is not None:
                raise ValueError
            if any(type(key) is not str for key in data):
                raise ValueError
            if set(data) != set(kind.model_fields):
                raise ValueError
            return {key: visit(val, depth + 1) for key, val in data.items()}
        if kind is dict:
            mapping = cast(dict[object, object], item)
            if len(mapping) > 64:
                raise ValueError
            if any(type(key) is not str for key in mapping):
                raise ValueError
            return {cast(str, key): visit(val, depth + 1) for key, val in mapping.items()}
        if kind in {tuple, list}:
            sequence = cast(tuple[object, ...] | list[object], item)
            if len(sequence) > 256:
                raise ValueError
            values = [visit(val, depth + 1) for val in sequence]
            return tuple(values) if kind is tuple else values
        raise ValueError

    return visit(value, 0)


def closed_fields(
    value: object,
    cls: type[BaseModel],
    *,
    extra: tuple[type[BaseModel], ...] = (),
) -> dict[str, object]:
    """One bounded exact-type snapshot; field values still need schema validation."""
    result: object = None
    try:
        if type(value) is cls:
            result = _plain(value, _CLOSED | frozenset(extra))
    except Exception:
        pass
    if type(result) is not dict:
        raise ResearchRejected
    return cast(dict[str, object], result)


def canonical[T: BaseModel](
    value: object,
    cls: type[T],
    *,
    extra: tuple[type[BaseModel], ...] = (),
) -> T:
    """Safe public boundary for exact internal DTOs, not arbitrary Python objects."""
    result: T | None = None
    try:
        result = cls.model_validate(closed_fields(value, cls, extra=extra), strict=True)
    except Exception:
        pass
    if result is None:
        raise ResearchRejected
    return result


def digest_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def encode(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _validate_spec(spec: RequestSpec) -> None:
    if (
        spec.task.task_id != spec.identity.task_id
        or spec.identity.parent_attempt_id == spec.identity.attempt_id
        or spec.deadline_ms <= spec.enqueued_at_ms
        or spec.policy.allow_fallbacks
        or len(set(spec.policy.providers)) != len(spec.policy.providers)
        or len(spec.bindings) != len(spec.task.evidence)
    ):
        raise ResearchRejected
    seen: set[str] = set()
    for evidence, binding in zip(spec.task.evidence, spec.bindings, strict=True):
        if (
            binding.evidence_id in seen
            or binding.evidence_id != evidence.evidence_id
            or binding.utf8_sha256 != digest_text(evidence.text)
            or binding.available_at_ms != evidence.available_at_ms
            or binding.valid_until_ms != evidence.valid_until_ms
            or not binding.use_allowed
            or not binding.egress_allowed
            or (spec.context.classification == "PUBLIC" and binding.classification != "PUBLIC")
            or (
                spec.context.classification == "PUBLIC"
                and spec.context.funding == "PLATFORM"
                and not binding.share_allowed
            )
        ):
            raise ResearchRejected
        seen.add(binding.evidence_id)


def _render(spec: RequestSpec) -> str:
    return encode(
        {
            "format": "FIXTURE_REQUEST_V1",
            "task": spec.task.model_dump(mode="json"),
            "policy": spec.policy.model_dump(mode="json"),
        }
    )


def prepare_fixture(raw: object) -> PreparedResearchRequest:
    """Build the approved simulation format from bounded primitive inputs."""
    result: PreparedResearchRequest | None = None
    try:
        if type(raw) is dict:
            spec = RequestSpec.model_validate(_plain(raw, frozenset()))
            _validate_spec(spec)
            payload = _render(spec)
            result = PreparedResearchRequest(
                spec=spec,
                payload=payload,
                payload_sha256=digest_text(payload),
            )
    except Exception:
        pass
    if result is None:
        raise ResearchRejected
    return result


def check_structure(value: object) -> PreparedResearchRequest:
    req = canonical(value, PreparedResearchRequest)
    # Sanitize encoding/validator failures without keeping the original exception context.
    valid = False
    try:
        _validate_spec(req.spec)
        valid = req.payload == _render(req.spec) and req.payload_sha256 == digest_text(req.payload)
    except Exception:
        pass
    if not valid:
        raise ResearchRejected("BINDING_MISMATCH")
    return req


def check_request(
    value: object,
    *,
    now_ms: int,
    clock_epoch: str,
    for_dispatch: bool = True,
) -> PreparedResearchRequest:
    req = check_structure(value)
    if (
        type(now_ms) is not int
        or type(clock_epoch) is not str
        or clock_epoch != req.spec.clock_epoch
        or now_ms < req.spec.enqueued_at_ms
    ):
        raise ResearchRejected("CLOCK_INVALID")
    if any(now_ms < item.available_at_ms for item in req.spec.bindings):
        raise ResearchRejected("CLOCK_INVALID")
    if now_ms >= request_deadline(req, for_dispatch=for_dispatch):
        raise ResearchRejected("EXPIRED")
    return req


def request_deadline(req: PreparedResearchRequest, *, for_dispatch: bool = True) -> int:
    deadline = min(
        req.spec.deadline_ms,
        req.spec.policy.valid_until_ms,
        *(item.valid_until_ms for item in req.spec.bindings),
    )
    return min(deadline, req.spec.quote.valid_until_ms) if for_dispatch else deadline


def request_digest(value: object) -> str:
    req = canonical(value, PreparedResearchRequest)
    return digest_text(
        encode(
            {
                "spec": req.spec.model_dump(mode="json"),
                "payload_sha256": req.payload_sha256,
            }
        )
    )


def check_grant(value: object, granted: object, *, now_ms: int) -> EgressGrant:
    req = canonical(value, PreparedResearchRequest)
    req = check_request(req, now_ms=now_ms, clock_epoch=req.spec.clock_epoch)
    grant = canonical(granted, EgressGrant)
    if (
        grant.identity != req.spec.identity
        or grant.request_sha256 != request_digest(req)
        or grant.payload_sha256 != req.payload_sha256
        or grant.evidence != req.spec.bindings
        or grant.model_policy_id != req.spec.policy.policy_id
        or grant.model_policy_revision != req.spec.policy.revision
        or grant.model != req.spec.policy.model
        or grant.quote_id != req.spec.quote.quote_id
        or grant.quote_revision != req.spec.quote.revision
    ):
        raise ResearchRejected("BINDING_MISMATCH")
    if now_ms >= grant.dispatch_before_ms:
        raise ResearchRejected("EXPIRED")
    return grant
