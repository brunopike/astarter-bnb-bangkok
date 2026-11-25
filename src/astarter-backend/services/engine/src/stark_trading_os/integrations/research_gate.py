"""Explicit offline orchestration over trusted backend ports.

No backend/ledger/cache/issuer/executor implementation or runtime registration.
Port transactions and persistent recovery belong to the backend. A Python
Protocol or OFFLINE_FIXTURE label is not an execution sandbox.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Literal, Protocol, Self, cast

from pydantic import Field, StrictInt, model_validator

from stark_trading_os.integrations.contracts import Identifier, ModelResult, RoleId, Timestamp
from stark_trading_os.integrations.research_delivery import (
    DELIVERY_TYPES,
    ResearchArtifact,
    ResearchDelivery,
    check_artifact,
    make_artifact,
    ready_delivery,
    semantic_key,
)
from stark_trading_os.integrations.research_egress import (
    Atoms,
    ChargeObservation,
    Closed,
    Digest,
    EgressGrant,
    PreparedResearchRequest,
    Reason,
    ResearchIdentity,
    ResearchRejected,
    Version,
    canonical,
    check_grant,
    check_request,
    closed_fields,
    request_deadline,
    request_digest,
)

type BudgetState = Literal[
    "RESERVED",
    "DISPATCH_STARTED",
    "UNKNOWN_PENDING_RECONCILE",
    "SETTLED",
    "RELEASED_UNSENT",
]


class BudgetReceipt(Closed):
    reservation_id: Identifier
    identity: ResearchIdentity
    request_sha256: Digest
    version: Version
    state: BudgetState
    unit_id: Literal["SIM_MODEL_CREDIT_V1"]
    scale: Annotated[StrictInt, Field(ge=6, le=6)]
    reserve_atoms: Atoms
    charged_atoms: Atoms | None
    settlement_ref: Identifier | None

    @model_validator(mode="after")
    def consistent(self) -> Self:
        if self.state == "SETTLED":
            if self.charged_atoms is None or self.settlement_ref is None:
                raise ValueError("settlement requires a backend receipt")
        elif self.charged_atoms is not None or self.settlement_ref is not None:
            raise ValueError("unsettled charge must remain unknown")
        return self


class DispatchPermit(Closed):
    receipt: BudgetReceipt
    payload_sha256: Digest
    fence: Identifier = Field(repr=False)
    dispatch_before_ms: Timestamp


class ResearchClaim(Closed):
    claim_id: Identifier
    semantic_key: Digest
    kind: Literal["PRODUCER", "WAITER"]


class ExecutionObservation(Closed):
    model_result: ModelResult
    charge: ChargeObservation | None
    scenario_revision: Identifier


class OutcomeObservation(Closed):
    """Independently validated data for backend billing, never a settlement receipt."""

    model_result: ModelResult | None
    charge: ChargeObservation | None
    scenario_revision: Identifier


class _ResponseBinding(Closed):
    task_id: Identifier
    role_id: RoleId
    profile_version: Identifier
    requested_model: Identifier
    purpose: Literal["OFFLINE_FIXTURE"]
    response_id: Identifier
    attempts: Annotated[StrictInt, Field(ge=1, le=1)]


GATE_TYPES = (
    BudgetReceipt,
    DispatchPermit,
    ResearchClaim,
    ExecutionObservation,
    OutcomeObservation,
    _ResponseBinding,
    *DELIVERY_TYPES,
)


def _outcome(req: PreparedResearchRequest, value: object) -> OutcomeObservation:
    # Snapshot once: no property access or re-reading the executor's original DTO
    # after validation. Invalid field values may fail one schema independently;
    # unsafe shapes, subclasses and model-level extra fields fail the whole boundary.
    raw = closed_fields(value, ExecutionObservation, extra=GATE_TYPES)
    model_raw = raw["model_result"]
    if type(model_raw) is not dict:
        raise ResearchRejected
    model_fields = cast(dict[str, object], model_raw)
    if set(model_fields) != set(ModelResult.model_fields):
        raise ResearchRejected
    model: ModelResult | None = None
    binding: _ResponseBinding | None = None
    charge: ChargeObservation | None = None
    try:
        model = ModelResult.model_validate(model_fields, strict=True)
    except Exception:
        pass
    try:
        binding = _ResponseBinding.model_validate(
            {key: model_fields[key] for key in _ResponseBinding.model_fields},
            strict=True,
        )
    except Exception:
        pass
    try:
        if raw["charge"] is not None:
            charge = ChargeObservation.model_validate(raw["charge"], strict=True)
    except Exception:
        pass
    if charge is not None and (
        binding is None
        or binding.task_id != req.spec.identity.task_id
        or binding.role_id != req.spec.task.role_id
        or binding.profile_version != req.spec.task.profile_version
        or binding.requested_model != req.spec.policy.model
        or charge.task_id != req.spec.identity.task_id
        or charge.attempt_id != req.spec.identity.attempt_id
        or charge.key_owner_id != req.spec.identity.key_owner_id
        or charge.provider not in req.spec.policy.providers
        or charge.request_id != binding.response_id
    ):
        charge = None
    # Provider policy membership binds the charge; the independent returned_provider
    # claim can still invalidate output. Only the backend can validate an invoice.
    result: OutcomeObservation | None = None
    try:
        result = OutcomeObservation.model_validate(
            {
                "model_result": model,
                "charge": charge,
                "scenario_revision": raw["scenario_revision"],
            },
            strict=True,
        )
    except Exception:
        pass
    if result is None:
        raise ResearchRejected
    return result


class ResearchBackend(Protocol):
    """Trusted server operations. Implementations must provide the documented CAS.

    read/use/publication enforce current source rights and consumer scope. reserve
    atomically charges all owner/root/task/day/platform scopes; start_once checks
    revocation/expiry and emits a permit only to the unique CAS winner. No permit
    can be recovered/reissued after an uncertain acknowledgement. Outcomes and
    reconciliation use trusted billing receipts, not executor assertions.
    """

    async def read_artifact(
        self,
        request: PreparedResearchRequest,
        key: str,
    ) -> ResearchArtifact | None: ...
    async def authorize_use(
        self,
        request: PreparedResearchRequest,
        artifact: ResearchArtifact,
    ) -> None: ...
    async def claim_or_join(
        self,
        request: PreparedResearchRequest,
        key: str,
    ) -> ResearchClaim: ...
    async def issue_grant(self, request: PreparedResearchRequest) -> EgressGrant: ...
    async def reserve(
        self,
        request: PreparedResearchRequest,
        grant: EgressGrant,
    ) -> BudgetReceipt: ...
    async def start_once(
        self,
        request: PreparedResearchRequest,
        grant: EgressGrant,
        receipt: BudgetReceipt,
        deadline_ms: int,
    ) -> DispatchPermit | None: ...
    async def record_outcome(
        self,
        request: PreparedResearchRequest,
        receipt: BudgetReceipt,
        observation: OutcomeObservation | None,
        reason: Reason,
    ) -> BudgetReceipt: ...
    async def inspect_attempt(self, identity: ResearchIdentity) -> BudgetReceipt | None: ...
    async def release_unsent(
        self,
        request: PreparedResearchRequest,
        receipt: BudgetReceipt,
        reason: Reason,
    ) -> BudgetReceipt: ...
    async def publish_artifact(
        self,
        request: PreparedResearchRequest,
        claim: ResearchClaim,
        artifact: ResearchArtifact,
        receipt: BudgetReceipt,
    ) -> ResearchArtifact: ...
    async def finish_claim(
        self,
        request: PreparedResearchRequest,
        claim: ResearchClaim,
    ) -> None: ...


class FixtureExecutor(Protocol):
    """Trusted fixture-only composition; consume the fence once, without retries."""

    async def execute_once(
        self,
        request: PreparedResearchRequest,
        permit: DispatchPermit,
        remaining_seconds: float,
    ) -> ExecutionObservation: ...


@dataclass
class _Attempt:
    request: PreparedResearchRequest
    last_now: int
    monotonic_deadline: float
    claim: ResearchClaim | None = None
    reserve_attempted: bool = False
    receipt: BudgetReceipt | None = None
    permit: DispatchPermit | None = None
    observation: OutcomeObservation | None = None


def _unavailable(
    reason: Reason,
    *,
    started: bool,
    status: Literal["WAIT", "DENIED", "FAILED"] = "WAIT",
) -> ResearchDelivery:
    return ResearchDelivery(status=status, origin="NONE", reason=reason, dispatch_started=started)


def _receipt(
    req: PreparedResearchRequest,
    raw: object,
    previous: BudgetReceipt | None = None,
) -> BudgetReceipt:
    receipt = canonical(raw, BudgetReceipt, extra=GATE_TYPES)
    if (
        receipt.identity != req.spec.identity
        or receipt.request_sha256 != request_digest(req)
        or receipt.reserve_atoms != req.spec.quote.reserve_atoms
        or (
            previous is not None
            and (
                receipt.reservation_id != previous.reservation_id
                or receipt.version < previous.version
            )
        )
    ):
        raise ResearchRejected("BINDING_MISMATCH")
    return receipt


def _started(state: _Attempt) -> bool:
    return state.permit is not None or (
        state.receipt is not None
        and state.receipt.state in {"DISPATCH_STARTED", "UNKNOWN_PENDING_RECONCILE", "SETTLED"}
    )


class OfflineResearchGate:
    """No implicit services, keys or configuration. All dependencies are explicit.

    Concurrent calls keep per-request state. Backend/executor async operations must
    be cancellation-cooperative; the owned finalizer has a separate one-second
    deadline and is joined even when the caller cancels repeatedly. Persistent
    DISPATCH_STARTED remains the recovery anchor when the backend is unavailable.
    """

    def __init__(
        self,
        *,
        backend: ResearchBackend | None,
        executor: FixtureExecutor | None,
        clock: Callable[[], tuple[int, str]],
    ) -> None:
        self._backend = backend
        self._executor = executor
        self._clock = clock

    def _now(self, state: _Attempt, *, dispatch: bool = False) -> int:
        now, epoch = self._clock()
        if type(now) is not int or now < state.last_now:
            raise ResearchRejected("CLOCK_INVALID")
        check_request(state.request, now_ms=now, clock_epoch=epoch, for_dispatch=dispatch)
        state.last_now = now
        return now

    async def run(self, value: object) -> ResearchDelivery:
        backend, executor = self._backend, self._executor
        if backend is None or executor is None:
            return _unavailable("UNAVAILABLE", started=False, status="FAILED")
        try:
            now, epoch = self._clock()
            req = check_request(value, now_ms=now, clock_epoch=epoch, for_dispatch=False)
        except ResearchRejected as exc:
            return _unavailable(exc.reason, started=False, status="DENIED")
        except Exception:
            return _unavailable("INVALID_INPUT", started=False, status="DENIED")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + (request_deadline(req, for_dispatch=False) - now) / 1000
        state = _Attempt(req, now, deadline)
        cancelled = False
        result = _unavailable("UNAVAILABLE", started=False, status="FAILED")
        try:
            async with asyncio.timeout_at(deadline):
                result = await self._run(state, backend, executor)
        except asyncio.CancelledError:
            cancelled = True
            result = _unavailable("CANCELLED", started=_started(state), status="FAILED")
        except ResearchRejected as exc:
            result = _unavailable(exc.reason, started=_started(state), status="DENIED")
        except TimeoutError:
            result = _unavailable("TIMEOUT", started=_started(state), status="FAILED")
        except Exception:
            result = _unavailable("UNAVAILABLE", started=_started(state), status="FAILED")
        cancelled = await self._finalize_owned(state, backend, result.reason) or cancelled
        if cancelled:
            raise asyncio.CancelledError
        if result.status == "READY":
            try:
                result = await self._deliver_ready(state, backend, result)
            except ResearchRejected as exc:
                result = _unavailable(exc.reason, started=_started(state), status="DENIED")
            except TimeoutError:
                result = _unavailable("TIMEOUT", started=_started(state), status="FAILED")
            except Exception:
                result = _unavailable("UNAVAILABLE", started=_started(state), status="FAILED")
        # Finalization may discover that a lost start acknowledgement did commit.
        if result.status != "READY" and result.dispatch_started != _started(state):
            result = _unavailable(result.reason, started=_started(state), status=result.status)
        return result

    async def _deliver_ready(
        self,
        state: _Attempt,
        backend: ResearchBackend,
        candidate: ResearchDelivery,
    ) -> ResearchDelivery:
        """The cleanup budget never extends the original delivery lifetime."""
        if candidate.artifact is None or candidate.origin == "NONE":
            raise ResearchRejected("INVALID_OUTPUT")

        def current(item: ResearchArtifact) -> ResearchArtifact:
            if asyncio.get_running_loop().time() >= state.monotonic_deadline:
                raise ResearchRejected("EXPIRED")
            now = self._now(state)
            return check_artifact(
                state.request,
                item,
                now_ms=now,
                clock_epoch=state.request.spec.clock_epoch,
            )

        item = current(candidate.artifact)
        async with asyncio.timeout_at(state.monotonic_deadline):
            await backend.authorize_use(state.request, item)
        item = current(item)
        delivered = ready_delivery(
            item,
            origin=candidate.origin,
            dispatch_started=candidate.dispatch_started,
        )
        if asyncio.get_running_loop().time() >= state.monotonic_deadline:
            raise ResearchRejected("EXPIRED")
        return delivered

    async def _run(
        self,
        state: _Attempt,
        backend: ResearchBackend,
        executor: FixtureExecutor,
    ) -> ResearchDelivery:
        req = state.request
        key = semantic_key(req)
        cached = await backend.read_artifact(req, key)
        if cached is not None:
            now = self._now(state)
            item = check_artifact(req, cached, now_ms=now, clock_epoch=req.spec.clock_epoch)
            return ready_delivery(item, origin="CACHE", dispatch_started=False)
        claim = canonical(await backend.claim_or_join(req, key), ResearchClaim, extra=GATE_TYPES)
        if claim.semantic_key != key:
            raise ResearchRejected("BINDING_MISMATCH")
        if claim.kind == "WAITER":
            return _unavailable("WAITING", started=False)
        state.claim = claim
        self._now(state, dispatch=True)
        granted = await backend.issue_grant(req)
        granted = check_grant(req, granted, now_ms=self._now(state, dispatch=True))
        state.reserve_attempted = True
        state.receipt = _receipt(req, await backend.reserve(req, granted))
        if state.receipt.state != "RESERVED":
            return _unavailable("ALREADY_STARTED", started=_started(state))
        now = self._now(state, dispatch=True)
        granted = check_grant(req, granted, now_ms=now)
        dispatch_deadline = min(request_deadline(req), granted.dispatch_before_ms)
        raw_permit = await backend.start_once(req, granted, state.receipt, dispatch_deadline)
        if raw_permit is None:
            return _unavailable("ALREADY_STARTED", started=False)
        permit = canonical(raw_permit, DispatchPermit, extra=GATE_TYPES)
        started = _receipt(req, permit.receipt, state.receipt)
        if (
            started.state != "DISPATCH_STARTED"
            or started.version <= state.receipt.version
            or permit.payload_sha256 != req.payload_sha256
            or permit.dispatch_before_ms > dispatch_deadline
        ):
            raise ResearchRejected("BINDING_MISMATCH")
        state.receipt, state.permit = started, permit
        now = self._now(state, dispatch=True)
        remaining = min(
            state.monotonic_deadline - asyncio.get_running_loop().time(),
            (permit.dispatch_before_ms - now) / 1000,
        )
        if remaining <= 0:
            raise ResearchRejected("EXPIRED")
        dispatch_started_ms = now
        async with asyncio.timeout(remaining):
            observed = await executor.execute_once(req, permit, remaining)
        observation = _outcome(req, observed)
        state.observation = observation
        state.receipt = _receipt(
            req,
            await backend.record_outcome(
                req,
                state.receipt,
                observation,
                "OK" if observation.model_result is not None else "INVALID_OUTPUT",
            ),
            state.receipt,
        )
        if state.receipt.state != "SETTLED":
            if state.receipt.state != "UNKNOWN_PENDING_RECONCILE":
                raise ResearchRejected("BINDING_MISMATCH")
            return _unavailable("UNKNOWN_CHARGE", started=True)
        model = observation.model_result
        now = self._now(state)
        if (
            model is None
            or model.status != "OK"
            or model.output is None
            or model.task_id != req.spec.identity.task_id
            or model.role_id != req.spec.task.role_id
            or model.profile_version != req.spec.task.profile_version
            or model.requested_model != req.spec.policy.model
            or model.returned_model != req.spec.policy.model
            or model.returned_provider not in req.spec.policy.providers
            or model.purpose != "OFFLINE_FIXTURE"
            or not dispatch_started_ms <= model.started_at_ms <= model.completed_at_ms <= now
        ):
            raise ResearchRejected("INVALID_OUTPUT")
        item = make_artifact(req, model.output, artifact_id="fixture-" + key, created_at_ms=now)
        item = await backend.publish_artifact(req, claim, item, state.receipt)
        now = self._now(state)
        item = check_artifact(req, item, now_ms=now, clock_epoch=req.spec.clock_epoch)
        return ready_delivery(item, origin="FRESH", dispatch_started=True)

    async def _finalize(
        self,
        state: _Attempt,
        backend: ResearchBackend,
        reason: Reason,
        deadline: float,
    ) -> None:
        req = state.request
        try:
            if state.reserve_attempted and (
                state.receipt is None or state.receipt.state in {"RESERVED", "DISPATCH_STARTED"}
            ):
                snapshot = await backend.inspect_attempt(req.spec.identity)
                if snapshot is not None:
                    current = _receipt(req, snapshot, state.receipt)
                    state.receipt = current
                    if current.state == "RESERVED":
                        state.receipt = _receipt(
                            req,
                            await backend.release_unsent(
                                req,
                                current,
                                reason,
                            ),
                            current,
                        )
                    elif current.state == "DISPATCH_STARTED":
                        state.receipt = _receipt(
                            req,
                            await backend.record_outcome(
                                req,
                                current,
                                state.observation,
                                reason,
                            ),
                            current,
                        )
        finally:
            if state.claim is not None and asyncio.get_running_loop().time() < deadline:
                async with asyncio.timeout_at(deadline):
                    await backend.finish_claim(req, state.claim)

    async def _finalize_owned(
        self,
        state: _Attempt,
        backend: ResearchBackend,
        reason: Reason,
    ) -> bool:
        if state.claim is None and not state.reserve_attempted:
            return False

        async def bounded() -> None:
            deadline = asyncio.get_running_loop().time() + 1.0
            try:
                async with asyncio.timeout_at(deadline):
                    await self._finalize(state, backend, reason, deadline)
            except Exception:
                # Durable started/reserved records remain for authoritative recovery.
                pass

        owned = asyncio.create_task(bounded(), name="t3-finalize")
        cancelled = False
        while not owned.done():
            try:
                await asyncio.shield(owned)
            except asyncio.CancelledError:
                cancelled = True
        # A trusted port cancelling itself does not detach this task or swallow cancellation.
        if owned.cancelled():
            cancelled = True
        else:
            owned.result()
        return cancelled
