"""T3 gate behavior against an explicit synthetic backend contract.

The fake below is NOT a production ledger/CAS/recovery implementation. Assertions
on gate output, dispatch and port arguments detect gate mistakes; fake-only ledger
characterizations are labeled separately and do not certify a database.
"""

from __future__ import annotations

import asyncio
import socket
from typing import Any

import pytest
from test_research_delivery import another, artifact, output
from test_research_egress import api, grant, raw_request, request


class Clock:
    def __init__(self) -> None:
        self.now = 2000
        self.epoch = "fixture-clock-v1"

    def read(self) -> tuple[int, str]:
        return self.now, self.epoch


class FixtureBackend:
    """One-loop contract double. No DB, real credentials or runtime registration."""

    def __init__(self, clock: Clock) -> None:
        self.e, self.g = api(), api("research_gate")
        self.clock = clock
        self.events: list[str] = []
        self.outcome_reasons: list[str] = []
        self.lock = asyncio.Lock()
        self.rows: dict[str, Any] = {}
        self.requests: dict[str, Any] = {}
        self.claims: dict[str, str] = {}
        self.cache: dict[str, Any] = {}
        self.revoked = False
        self.read_denied = False
        self.unknown_owners: set[str] = set()
        self.limits: dict[str, int] = {}
        self.buckets: dict[str, int] = {}
        self.charged: dict[str, int] = {}
        self.receipt_events: dict[str, int] = {}
        self.invoices: dict[str, int] = {"fixture-charge-1": 35}
        self.start_ack_lost = False
        self.reserve_ack_lost = False
        self.advance_before_start: int | None = None
        self.revoke_after_reserve = False
        self.block_record: asyncio.Event | None = None
        self.block_finish: asyncio.Event | None = None
        self.record_entered = asyncio.Event()
        self.fail_record = False
        self.forge_grant = False

    def scopes(self, req: Any) -> tuple[str, ...]:
        ident = req.spec.identity
        return (
            "platform",
            "day-0",
            "owner:" + ident.key_owner_id,
            "root:" + ident.logical_request_id,
            "task:" + ident.task_id,
        )

    def current(self, req: Any, *, dispatch: bool = True) -> None:
        self.e.check_request(
            req, now_ms=self.clock.now, clock_epoch=self.clock.epoch, for_dispatch=dispatch
        )
        if self.revoked:
            raise self.e.ResearchRejected("DENIED")

    async def read_artifact(self, req: Any, key: str) -> Any:
        self.events.append("read")
        self.current(req, dispatch=False)
        if self.read_denied:
            raise self.e.ResearchRejected("DENIED")
        return self.cache.get(key)

    async def authorize_use(self, req: Any, item: Any) -> None:
        self.events.append("use")
        self.current(req, dispatch=False)
        if self.read_denied:
            raise self.e.ResearchRejected("DENIED")

    async def claim_or_join(self, req: Any, key: str) -> Any:
        self.events.append("claim")
        async with self.lock:
            owner = self.claims.get(key)
            kind = "PRODUCER" if owner is None else "WAITER"
            if owner is None:
                self.claims[key] = req.spec.identity.task_id
            return self.g.ResearchClaim(claim_id="fixture-claim", semantic_key=key, kind=kind)

    async def issue_grant(self, req: Any) -> Any:
        self.events.append("grant")
        self.current(req)
        return grant(req, request_sha256="0" * 64) if self.forge_grant else grant(req)

    async def reserve(self, req: Any, granted: Any) -> Any:
        self.events.append("reserve")
        async with self.lock:
            self.current(req)
            self.e.check_grant(req, granted, now_ms=self.clock.now)
            ident = req.spec.identity
            existing = self.rows.get(ident.task_id)
            if existing is not None:
                if existing.request_sha256 != self.e.request_digest(req):
                    raise self.e.ResearchRejected("BINDING_MISMATCH")
                return existing
            if ident.key_owner_id in self.unknown_owners:
                raise self.e.ResearchRejected("UNKNOWN_CHARGE")
            atoms = req.spec.quote.reserve_atoms
            scopes = self.scopes(req)
            if any(
                self.buckets.get(scope, 0) + atoms > self.limits.get(scope, 1000)
                for scope in scopes
            ):
                raise self.e.ResearchRejected("BUDGET_DENIED")
            for scope in scopes:
                self.buckets[scope] = self.buckets.get(scope, 0) + atoms
            receipt = self.g.BudgetReceipt(
                reservation_id="fixture-res-" + ident.task_id,
                identity=ident,
                request_sha256=self.e.request_digest(req),
                version=1,
                state="RESERVED",
                unit_id="SIM_MODEL_CREDIT_V1",
                scale=6,
                reserve_atoms=atoms,
                charged_atoms=None,
                settlement_ref=None,
            )
            self.rows[ident.task_id] = receipt
            self.requests[ident.task_id] = req
            if self.revoke_after_reserve:
                self.revoked = True
            if self.reserve_ack_lost:
                raise RuntimeError("fixture-sensitive-backend-detail")
            return receipt

    async def start_once(self, req: Any, granted: Any, receipt: Any, deadline_ms: int) -> Any:
        self.events.append("start")
        async with self.lock:
            if self.advance_before_start is not None:
                self.clock.now = self.advance_before_start
            self.current(req)
            self.e.check_grant(req, granted, now_ms=self.clock.now)
            old = self.rows[req.spec.identity.task_id]
            if old.state != "RESERVED" or old.version != receipt.version:
                return None
            if self.clock.now >= deadline_ms:
                raise self.e.ResearchRejected("EXPIRED")
            started = old.model_copy(update={"state": "DISPATCH_STARTED", "version": 2})
            self.rows[req.spec.identity.task_id] = started
            if self.start_ack_lost:
                raise RuntimeError("fixture-sensitive-backend-detail")
            return self.g.DispatchPermit(
                receipt=started,
                payload_sha256=req.payload_sha256,
                fence="fixture-fence-" + req.spec.identity.task_id,
                dispatch_before_ms=deadline_ms,
            )

    def settle(self, req: Any, old: Any, atoms: int, event: str) -> Any:
        if event in self.receipt_events and self.receipt_events[event] != atoms:
            raise self.e.ResearchRejected("BINDING_MISMATCH")
        if old.state == "SETTLED":
            if old.charged_atoms != atoms:
                raise self.e.ResearchRejected("BINDING_MISMATCH")
            return old
        for scope in self.scopes(req):
            self.buckets[scope] += atoms - old.reserve_atoms
        self.receipt_events[event] = atoms
        self.charged[req.spec.identity.task_id] = atoms
        settled = old.model_copy(
            update={
                "state": "SETTLED",
                "version": old.version + 1,
                "charged_atoms": atoms,
                "settlement_ref": event,
            }
        )
        self.rows[req.spec.identity.task_id] = settled
        if not any(
            row.state == "UNKNOWN_PENDING_RECONCILE"
            and row.identity.key_owner_id == req.spec.identity.key_owner_id
            for row in self.rows.values()
        ):
            self.unknown_owners.discard(req.spec.identity.key_owner_id)
        return settled

    async def record_outcome(self, req: Any, receipt: Any, observed: Any, reason: str) -> Any:
        self.events.append("record")
        self.outcome_reasons.append(reason)
        self.record_entered.set()
        if self.fail_record:
            raise RuntimeError("fixture-sensitive-backend-detail")
        if self.block_record is not None:
            await self.block_record.wait()
        async with self.lock:
            old = self.rows[req.spec.identity.task_id]
            if old.state == "SETTLED":
                return old
            charge = None if observed is None else observed.charge
            if charge is not None and self.invoices.get(charge.event_id) == charge.atoms:
                if (
                    charge.task_id != req.spec.identity.task_id
                    or charge.attempt_id != req.spec.identity.attempt_id
                    or charge.key_owner_id != req.spec.identity.key_owner_id
                    or charge.source_ref != "fixture-trusted-receipt"
                    or charge.provider not in req.spec.policy.providers
                ):
                    raise self.e.ResearchRejected("BINDING_MISMATCH")
                return self.settle(req, old, charge.atoms, charge.event_id)
            unknown = old.model_copy(
                update={
                    "state": "UNKNOWN_PENDING_RECONCILE",
                    "version": old.version + 1,
                }
            )
            self.rows[req.spec.identity.task_id] = unknown
            self.unknown_owners.add(req.spec.identity.key_owner_id)
            return unknown

    async def inspect_attempt(self, identity: Any) -> Any:
        self.events.append("inspect")
        return self.rows.get(identity.task_id)

    async def release_unsent(self, req: Any, receipt: Any, reason: str) -> Any:
        self.events.append("release")
        async with self.lock:
            old = self.rows[req.spec.identity.task_id]
            assert old.state == "RESERVED" and old.version == receipt.version
            for scope in self.scopes(req):
                self.buckets[scope] -= old.reserve_atoms
            released = old.model_copy(update={"state": "RELEASED_UNSENT", "version": 2})
            self.rows[req.spec.identity.task_id] = released
            return released

    async def publish_artifact(self, req: Any, claim: Any, item: Any, receipt: Any) -> Any:
        self.events.append("publish")
        self.current(req, dispatch=False)
        assert self.rows[req.spec.identity.task_id].state == "SETTLED"
        self.cache[claim.semantic_key] = item
        return item

    async def finish_claim(self, req: Any, claim: Any) -> None:
        self.events.append("finish")
        if self.block_finish is not None:
            await self.block_finish.wait()
        row = self.rows.get(req.spec.identity.task_id)
        if row is None or row.state in {"SETTLED", "RELEASED_UNSENT"}:
            if self.claims.get(claim.semantic_key) == req.spec.identity.task_id:
                self.claims.pop(claim.semantic_key)


class FixtureExecutor:
    def __init__(self, backend: FixtureBackend, clock: Clock) -> None:
        self.backend, self.clock = backend, clock
        self.calls = 0
        self.permits: set[str] = set()
        self.started = asyncio.Event()
        self.block: asyncio.Event | None = None
        self.failure: Exception | None = None
        self.cost: int | None = 35
        self.returned_provider = "fixture-provider"
        self.returned_model = "fixture/model-v1"
        self.status = "OK"
        self.revoke_after = False
        self.finish_now: int | None = None
        self.observed: Any = None
        self.transform: Any = None
        self.remaining: float | None = None

    async def execute_once(self, req: Any, permit: Any, remaining_seconds: float) -> Any:
        from stark_trading_os.integrations.contracts import ModelResult, Usage

        assert permit.fence not in self.permits
        assert permit.payload_sha256 == req.payload_sha256
        assert permit.receipt.state == "DISPATCH_STARTED"
        assert self.backend.rows[req.spec.identity.task_id].state == "DISPATCH_STARTED"
        assert self.clock.now < permit.dispatch_before_ms
        self.permits.add(permit.fence)
        self.calls += 1
        self.remaining = remaining_seconds
        self.started.set()
        if self.block is not None:
            await self.block.wait()
        if self.failure is not None:
            raise self.failure
        if self.finish_now is not None:
            self.clock.now = self.finish_now
        if self.revoke_after:
            self.backend.revoked = True
        result = ModelResult(
            task_id=req.spec.identity.task_id,
            role_id=req.spec.task.role_id,
            profile_version=req.spec.task.profile_version,
            requested_model=req.spec.policy.model,
            status=self.status,
            purpose="OFFLINE_FIXTURE",
            started_at_ms=2000,
            completed_at_ms=max(2000, self.clock.now),
            output=output() if self.status == "OK" else None,
            usage=Usage(status="REPORTED", cost_credits="0"),
            response_id="fixture-response",
            returned_provider=self.returned_provider,
            returned_model=self.returned_model,
            attempts=1,
        )
        charge = (
            None
            if self.cost is None
            else api().ChargeObservation(
                task_id=req.spec.identity.task_id,
                attempt_id=req.spec.identity.attempt_id,
                key_owner_id=req.spec.identity.key_owner_id,
                provider="fixture-provider",
                request_id="fixture-response",
                unit_id="SIM_MODEL_CREDIT_V1",
                scale=6,
                atoms=self.cost,
                source_ref="fixture-trusted-receipt",
                source_revision="v1",
                event_id="fixture-charge-1",
            )
        )
        self.observed = api("research_gate").ExecutionObservation(
            model_result=result,
            charge=charge,
            scenario_revision="fixture-scenario-v1",
        )
        if self.transform is not None:
            self.observed = self.transform(self.observed)
        return self.observed


def rig() -> tuple[Any, FixtureBackend, FixtureExecutor, Clock]:
    g = api("research_gate")
    clock = Clock()
    backend = FixtureBackend(clock)
    executor = FixtureExecutor(backend, clock)
    gate = g.OfflineResearchGate(backend=backend, executor=executor, clock=clock.read)
    return gate, backend, executor, clock


def distinct_task(*, role: str = "A02", root: str = "fixture-root-2") -> Any:
    raw = raw_request()
    raw["identity"].update(
        task_id="fixture-task-2",
        attempt_id="fixture-attempt-2",
        parent_attempt_id="fixture-attempt-1",
        logical_request_id=root,
    )
    raw["task"].update(task_id="fixture-task-2", role_id=role)
    return api().prepare_fixture(raw)


@pytest.mark.asyncio
async def test_t3_05_gate_reserves_before_dispatch_and_settles_via_backend_receipt() -> None:
    gate, backend, wire, _ = rig()
    result = await gate.run(request())
    assert result.status == "READY" and result.origin == "FRESH"
    assert wire.calls == 1
    assert backend.events.index("reserve") < backend.events.index("start")
    assert backend.events.index("start") < backend.events.index("record")
    assert backend.events.index("record") < backend.events.index("publish")
    assert backend.charged == {"fixture-task-1": 35}
    assert backend.buckets["platform"] == 35


@pytest.mark.asyncio
async def test_t3_01_gate_rejects_a_structurally_valid_but_wrong_authority_grant() -> None:
    gate, backend, wire, _ = rig()
    backend.forge_grant = True
    result = await gate.run(request())
    assert result.status == "DENIED" and wire.calls == 0
    assert "reserve" not in backend.events


@pytest.mark.asyncio
async def test_t3_03_revocation_before_dispatch_releases_only_unsent_reservation() -> None:
    gate, backend, wire, _ = rig()
    backend.revoke_after_reserve = True
    result = await gate.run(request())
    assert result.status == "DENIED" and wire.calls == 0
    assert backend.rows["fixture-task-1"].state == "RELEASED_UNSENT"
    assert backend.buckets["platform"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["revoked", "expired", "wrong_provider", "wrong_model"])
async def test_t3_03_unusable_output_preserves_known_billing(kind: str) -> None:
    gate, backend, wire, _ = rig()
    if kind == "revoked":
        wire.revoke_after = True
    elif kind == "expired":
        wire.finish_now = 11000
    elif kind == "wrong_provider":
        wire.returned_provider = "fixture-unapproved"
    else:
        wire.returned_model = "fixture/other"
    result = await gate.run(request())
    assert result.status != "READY" and result.artifact is None
    assert backend.rows["fixture-task-1"].state == "SETTLED"
    assert backend.charged["fixture-task-1"] == 35
    assert backend.cache == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("advanced", [9000, 11000, 1500])
async def test_t3_04_queue_expiry_and_clock_rollback_cannot_dispatch(advanced: int) -> None:
    gate, backend, wire, _ = rig()
    backend.advance_before_start = advanced
    result = await gate.run(request())
    assert result.status != "READY" and wire.calls == 0
    # CAS may have started before the caller detects rollback; no unsafe release.
    assert backend.rows["fixture-task-1"].state in {
        "RELEASED_UNSENT",
        "UNKNOWN_PENDING_RECONCILE",
    }


@pytest.mark.asyncio
async def test_t3_04_remaining_deadline_is_not_reset_to_default_model_timeout() -> None:
    gate, _, wire, _ = rig()
    req = request(deadline_ms=2200)
    result = await gate.run(req)
    assert result.status == "READY"
    assert wire.remaining is not None and 0 < wire.remaining <= 0.2


@pytest.mark.asyncio
async def test_t3_05_budget_denial_prevents_executor_and_does_not_leave_partial_reserve() -> None:
    gate, backend, wire, _ = rig()
    backend.limits["root:fixture-root-1"] = 99
    result = await gate.run(request())
    assert result.reason == "BUDGET_DENIED" and wire.calls == 0
    assert backend.buckets == {} and backend.rows == {}


@pytest.mark.asyncio
async def test_t3_05_two_different_research_jobs_compete_for_last_budget_through_port() -> None:
    gate, backend, wire, _ = rig()
    backend.limits["platform"] = 100
    wire.block = asyncio.Event()
    first = asyncio.create_task(gate.run(request()))
    await wire.started.wait()
    second = await gate.run(distinct_task())
    assert second.reason == "BUDGET_DENIED" and wire.calls == 1
    wire.block.set()
    assert (await first).status == "READY"


@pytest.mark.asyncio
@pytest.mark.parametrize("lost", ["reserve", "start"])
async def test_t3_06_lost_transaction_ack_is_inspected_not_retried(lost: str) -> None:
    gate, backend, wire, _ = rig()
    setattr(backend, lost + "_ack_lost", True)
    result = await gate.run(request())
    assert result.status != "READY" and wire.calls == 0
    assert backend.events.count(lost) == 1 and "inspect" in backend.events
    expected = "RELEASED_UNSENT" if lost == "reserve" else "UNKNOWN_PENDING_RECONCILE"
    assert backend.rows["fixture-task-1"].state == expected
    again = await gate.run(request())
    assert again.status != "READY" and wire.calls == 0


@pytest.mark.asyncio
async def test_t3_06_worker_restart_does_not_reissue_started_attempt() -> None:
    gate, backend, wire, _ = rig()
    backend.start_ack_lost = True
    await gate.run(request())
    backend.start_ack_lost = False
    backend.claims.clear()  # simulate a lost/expired singleflight lease
    result = await gate.run(request())
    assert result.status == "WAIT" and wire.calls == 0
    assert backend.events.count("start") == 1


@pytest.mark.asyncio
async def test_t3_08_shared_waiters_and_cache_hits_never_duplicate_model_charges() -> None:
    gate, backend, wire, _ = rig()
    wire.block = asyncio.Event()
    first = asyncio.create_task(gate.run(request()))
    await wire.started.wait()
    waiting = await asyncio.gather(*(gate.run(another()) for _ in range(8)))
    assert all(item.status == "WAIT" for item in waiting)
    assert wire.calls == 1
    wire.block.set()
    assert (await first).origin == "FRESH"
    cached = await gate.run(another())
    assert cached.origin == "CACHE" and cached.dispatch_started is False
    assert wire.calls == 1 and len(backend.charged) == 1
    assert "fixture-tenant-a" not in cached.model_dump_json()


@pytest.mark.asyncio
async def test_t3_07_current_read_denial_blocks_cached_output_without_paid_fallback() -> None:
    gate, backend, wire, _ = rig()
    item = artifact()
    backend.cache[item.semantic_key] = item
    backend.read_denied = True
    result = await gate.run(request())
    assert result.status == "DENIED" and wire.calls == 0
    assert "grant" not in backend.events


@pytest.mark.asyncio
async def test_t3_07_unvalidated_cache_object_is_not_forwarded_to_authorization_port() -> None:
    gate, backend, wire, clock = rig()
    clock.now = 2300
    item = artifact()
    backend.cache[item.semantic_key] = item.model_copy(update={"unexpected": "fixture-private"})
    result = await gate.run(request())
    assert result.status == "DENIED" and wire.calls == 0
    assert "use" not in backend.events and "grant" not in backend.events


@pytest.mark.asyncio
async def test_t3_08_expired_quote_still_allows_valid_cache_and_unknown_owner_cache() -> None:
    gate, backend, wire, clock = rig()
    clock.now = 2300
    item = artifact()
    backend.cache[item.semantic_key] = item
    backend.unknown_owners.add("fixture-platform")
    raw = raw_request()
    raw["quote"]["valid_until_ms"] = 2100
    result = await gate.run(api().prepare_fixture(raw))
    assert result.status == "READY" and result.origin == "CACHE"
    assert wire.calls == 0 and "reserve" not in backend.events


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["timeout", "exception", "429", "invalid_output", "no_cost"])
async def test_t3_09_failed_or_uncosted_dispatch_is_unknown_never_free(mode: str) -> None:
    gate, backend, wire, _ = rig()
    wire.cost = None
    if mode == "timeout":
        wire.failure = TimeoutError("fixture-sensitive-executor-detail")
    elif mode == "exception":
        wire.failure = RuntimeError("fixture-sensitive-executor-detail")
    elif mode == "429":
        wire.status = "RATE_LIMITED"
    elif mode == "invalid_output":
        wire.status = "INVALID_RESPONSE"
    result = await gate.run(request())
    assert result.status != "READY"
    assert "fixture-sensitive" not in result.model_dump_json()
    assert backend.rows["fixture-task-1"].state == "UNKNOWN_PENDING_RECONCILE"
    assert backend.buckets["platform"] == 100 and backend.charged == {}
    denied = await gate.run(distinct_task())
    assert denied.reason == "UNKNOWN_CHARGE" and wire.calls == 1


@pytest.mark.asyncio
async def test_t3_09_cancellation_is_joined_and_unknown_reservation_retained() -> None:
    gate, backend, wire, _ = rig()
    wire.block = asyncio.Event()
    backend.block_record = asyncio.Event()
    running = asyncio.create_task(gate.run(request()))
    await wire.started.wait()
    running.cancel()
    await backend.record_entered.wait()
    running.cancel()  # a second cancellation must not detach finalization
    backend.block_record.set()
    with pytest.raises(asyncio.CancelledError):
        await running
    assert backend.outcome_reasons == ["CANCELLED"]
    assert backend.rows["fixture-task-1"].state == "UNKNOWN_PENDING_RECONCILE"
    assert not any(
        t.get_name().startswith("t3-finalize") for t in asyncio.all_tasks() if not t.done()
    )


@pytest.mark.asyncio
async def test_t3_09_unavailable_ledger_keeps_durable_started_for_backend_recovery() -> None:
    gate, backend, wire, _ = rig()
    backend.fail_record = True
    result = await gate.run(request())
    assert result.status != "READY" and wire.calls == 1
    assert backend.rows["fixture-task-1"].state == "DISPATCH_STARTED"
    assert backend.buckets["platform"] == 100 and "release" not in backend.events


@pytest.mark.asyncio
async def test_t3_09_cleanup_deadline_covers_finish_after_record_timeout() -> None:
    gate, backend, wire, _ = rig()
    wire.failure = TimeoutError()
    backend.block_record = asyncio.Event()
    backend.block_finish = asyncio.Event()
    loop = asyncio.get_running_loop()
    escape = loop.call_later(1.6, backend.block_finish.set)
    started = loop.time()
    try:
        result = await gate.run(request())
    finally:
        escape.cancel()
    assert loop.time() - started < 1.3
    assert result.status != "READY"
    assert backend.rows["fixture-task-1"].state == "DISPATCH_STARTED"
    assert not any(
        t.get_name().startswith("t3-finalize") for t in asyncio.all_tasks() if not t.done()
    )


@pytest.mark.asyncio
async def test_t3_09_actual_request_timeout_does_not_detach_executor() -> None:
    gate, backend, wire, _ = rig()
    wire.block = asyncio.Event()
    result = await gate.run(request(deadline_ms=2020))
    assert result.reason == "TIMEOUT" and wire.calls == 1
    assert backend.rows["fixture-task-1"].state == "UNKNOWN_PENDING_RECONCILE"


@pytest.mark.asyncio
async def test_t3_09_malformed_model_output_can_still_have_trusted_known_charge() -> None:
    gate, backend, wire, _ = rig()
    wire.status = "INVALID_RESPONSE"
    result = await gate.run(request())
    assert result.status != "READY"
    assert backend.charged["fixture-task-1"] == 35
    assert backend.cache == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("atoms", [0, 250])
async def test_t3_10_trusted_zero_and_overrun_are_recorded_exactly(atoms: int) -> None:
    gate, backend, wire, _ = rig()
    wire.cost = atoms
    backend.invoices["fixture-charge-1"] = atoms
    backend.limits["platform"] = 200
    result = await gate.run(request())
    assert result.status == "READY"
    assert backend.charged["fixture-task-1"] == atoms
    if atoms > 100:
        assert (await gate.run(distinct_task())).reason == "BUDGET_DENIED"
        assert wire.calls == 1


@pytest.mark.asyncio
async def test_t3_10_executor_cost_claim_without_backend_invoice_cannot_settle() -> None:
    gate, backend, wire, _ = rig()
    backend.invoices.clear()
    result = await gate.run(request())
    assert result.status == "WAIT" and result.reason == "UNKNOWN_CHARGE"
    assert backend.rows["fixture-task-1"].state == "UNKNOWN_PENDING_RECONCILE"
    assert backend.charged == {} and wire.calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field,value",
    [
        ("atoms", -1),
        ("atoms", 0.1),
        ("unit_id", "USD"),
        ("task_id", "fixture-other"),
        ("key_owner_id", "fixture-other"),
        ("provider", "fixture-other"),
        ("confirmed", True),
    ],
)
async def test_t3_10_invalid_or_rebound_executor_claim_is_never_used_to_settle(
    field: str,
    value: Any,
) -> None:
    gate, backend, wire, _ = rig()
    wire.transform = lambda observed: observed.model_copy(
        update={
            "charge": observed.charge.model_copy(update={field: value}),
        }
    )
    result = await gate.run(request())
    assert result.status != "READY"
    assert backend.rows["fixture-task-1"].state == "UNKNOWN_PENDING_RECONCILE"
    assert backend.charged == {} and backend.buckets["platform"] == 100


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [("started_at_ms", 999), ("completed_at_ms", 3000)])
async def test_t3_04_untrusted_result_times_cannot_make_output_usable(
    field: str,
    value: int,
) -> None:
    gate, backend, wire, _ = rig()
    wire.transform = lambda observed: observed.model_copy(
        update={
            "model_result": observed.model_result.model_copy(update={field: value}),
        }
    )
    result = await gate.run(request())
    assert result.status != "READY" and result.artifact is None
    assert backend.charged["fixture-task-1"] == 35


@pytest.mark.asyncio
async def test_t3_11_gate_never_releases_unknown_when_later_run_is_expired() -> None:
    gate, backend, wire, clock = rig()
    wire.cost = None
    await gate.run(request())
    clock.now = 12000
    result = await gate.run(request())
    assert result.status == "DENIED" and wire.calls == 1
    assert "release" not in backend.events
    assert backend.rows["fixture-task-1"].state == "UNKNOWN_PENDING_RECONCILE"


@pytest.mark.asyncio
async def test_t3_11_fake_only_reconciliation_receipt_idempotency_and_original_day_bucket() -> None:
    gate, backend, wire, clock = rig()
    req = request()
    wire.cost = None
    await gate.run(req)
    clock.now = 86400000
    old = backend.rows["fixture-task-1"]
    first = backend.settle(req, old, 35, "fixture-reconciliation")
    assert backend.settle(req, first, 35, "fixture-reconciliation").charged_atoms == 35
    assert backend.buckets["day-0"] == 35
    with pytest.raises(api().ResearchRejected):
        backend.settle(req, first, 36, "fixture-reconciliation")
    assert wire.calls == 1  # gate has not silently retried during reconciliation


@pytest.mark.asyncio
async def test_t3_12_retry_child_cannot_bypass_original_logical_budget() -> None:
    gate, backend, wire, _ = rig()
    backend.limits["root:fixture-root-1"] = 100
    await gate.run(request())
    child = distinct_task(root="fixture-root-1")
    result = await gate.run(child)
    assert result.reason == "BUDGET_DENIED" and wire.calls == 1
    assert backend.events.count("grant") == 2


@pytest.mark.asyncio
async def test_t3_12_unconfigured_gate_has_no_network_or_environment_key_use(
    monkeypatch: Any,
) -> None:
    g = api("research_gate")

    def forbidden(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("network attempted")

    monkeypatch.setenv("OPENROUTER_API_KEY", "fixture-never-use-environment")
    monkeypatch.setattr(socket, "socket", forbidden)
    gate = g.OfflineResearchGate(backend=None, executor=None, clock=Clock().read)
    result = await gate.run(request())
    assert result.status == "FAILED" and result.reason == "UNAVAILABLE"


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["request", "artifact", "epoch", "rollback", "valid"])
async def test_repair_h1_fresh_rechecks_trusted_time_after_joined_cleanup(change: str) -> None:
    gate, backend, wire, clock = rig()
    finished = backend.finish_claim

    async def finish(req: Any, claim: Any) -> None:
        await finished(req, claim)
        if change == "epoch":
            clock.epoch = "fixture-clock-v2"
        else:
            clock.now = {"request": 10000, "artifact": 11000, "rollback": 1999, "valid": 2300}[
                change
            ]

    backend.finish_claim = finish
    result = await gate.run(request())
    assert wire.calls == 1 and backend.charged["fixture-task-1"] == 35
    assert result.dispatch_started is True
    if change == "valid":
        assert result.status == "READY" and result.artifact is not None
    else:
        assert result.status != "READY" and result.artifact is None
        assert result.reason in {"EXPIRED", "CLOCK_INVALID", "TIMEOUT"}
    assert "release" not in backend.events


@pytest.mark.asyncio
async def test_repair_h1_cleanup_does_not_extend_monotonic_delivery_lifetime() -> None:
    gate, backend, wire, _ = rig()
    finished = backend.finish_claim

    async def finish(req: Any, claim: Any) -> None:
        await asyncio.sleep(0.04)
        await finished(req, claim)

    backend.finish_claim = finish
    result = await gate.run(request(deadline_ms=2020))
    assert result.status != "READY" and result.artifact is None
    assert result.dispatch_started is True
    assert backend.charged["fixture-task-1"] == 35 and wire.calls == 1


@pytest.mark.asyncio
async def test_repair_h1_final_use_authorization_stays_within_original_deadline() -> None:
    gate, backend, wire, _ = rig()
    finished = backend.finish_claim
    authorized = backend.authorize_use
    closed = False
    use_after_close = False

    async def finish(req: Any, claim: Any) -> None:
        nonlocal closed
        await finished(req, claim)
        closed = True

    async def authorize(req: Any, item: Any) -> None:
        nonlocal use_after_close
        if closed:
            use_after_close = True
            await asyncio.sleep(0.04)
        await authorized(req, item)

    backend.finish_claim, backend.authorize_use = finish, authorize
    result = await gate.run(request(deadline_ms=2020))
    assert use_after_close
    assert result.status != "READY" and result.artifact is None
    assert backend.charged["fixture-task-1"] == 35 and wire.calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["request", "artifact", "epoch", "monotonic", "valid"])
async def test_repair_h1_cache_delivery_obeys_the_same_final_use_boundary(change: str) -> None:
    gate, backend, wire, clock = rig()
    clock.now = 2300
    item = artifact()
    backend.cache[item.semantic_key] = item
    authorized = backend.authorize_use

    async def authorize(req: Any, cached: Any) -> None:
        await authorized(req, cached)
        if change == "monotonic":
            await asyncio.sleep(0.04)
        elif change == "epoch":
            clock.epoch = "fixture-clock-v2"
        else:
            clock.now = {"request": req.spec.deadline_ms, "artifact": 11000, "valid": 2400}[change]

    backend.authorize_use = authorize
    result = await gate.run(request(deadline_ms=2320 if change == "monotonic" else 10000))
    assert wire.calls == 0 and backend.charged == {} and not result.dispatch_started
    if change == "valid":
        assert result.status == "READY" and result.origin == "CACHE"
    else:
        assert result.status != "READY" and result.artifact is None


@pytest.mark.asyncio
async def test_repair_h1_shorter_artifact_use_limit_is_rechecked_independently() -> None:
    gate, backend, wire, clock = rig()
    publish = backend.publish_artifact
    finish = backend.finish_claim

    async def publish_short(req: Any, claim: Any, item: Any, receipt: Any) -> Any:
        return await publish(req, claim, item.model_copy(update={"use_until_ms": 2300}), receipt)

    async def finish_at_limit(req: Any, claim: Any) -> None:
        await finish(req, claim)
        clock.now = 2300  # request and evidence are still valid

    backend.publish_artifact, backend.finish_claim = publish_short, finish_at_limit
    result = await gate.run(request())
    assert result.status != "READY" and result.artifact is None
    assert backend.charged["fixture-task-1"] == 35 and wire.calls == 1


@pytest.mark.asyncio
async def test_repair_h1_cancel_during_final_use_preserves_joined_cleanup_and_charge() -> None:
    gate, backend, wire, _ = rig()
    authorize = backend.authorize_use
    entered = asyncio.Event()
    blocked = asyncio.Event()

    async def authorize_blocked(req: Any, item: Any) -> None:
        assert "finish" in backend.events
        await authorize(req, item)
        entered.set()
        await blocked.wait()

    backend.authorize_use = authorize_blocked
    running = asyncio.create_task(gate.run(request()))
    await asyncio.wait_for(entered.wait(), 0.5)
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    assert backend.charged["fixture-task-1"] == 35 and wire.calls == 1
    assert "release" not in backend.events
    assert not any(
        t.get_name().startswith("t3-finalize") for t in asyncio.all_tasks() if not t.done()
    )


def malformed_output(observed: Any, field: str = "summary", value: Any = "") -> Any:
    model = observed.model_result
    return observed.model_copy(
        update={
            "model_result": model.model_copy(
                update={
                    "output": model.output.model_copy(update={field: value}),
                }
            ),
        }
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [("summary", ""), ("stance", "BUY")])
async def test_repair_m1_damaged_output_preserves_independent_valid_billing(
    field: str,
    value: Any,
) -> None:
    gate, backend, wire, _ = rig()
    wire.transform = lambda observed: malformed_output(observed, field, value)
    result = await gate.run(request())
    assert result.status != "READY" and result.artifact is None
    assert backend.rows["fixture-task-1"].state == "SETTLED"
    assert backend.charged["fixture-task-1"] == 35 and wire.calls == 1
    assert backend.cache == {} and "release" not in backend.events
    assert "fixture-platform" not in backend.unknown_owners


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field", ["task_id", "attempt_id", "key_owner_id", "provider", "request_id"]
)
async def test_repair_m1_damaged_output_cannot_authorize_a_rebound_charge(field: str) -> None:
    gate, backend, wire, _ = rig()

    def transform(observed: Any) -> Any:
        damaged = malformed_output(observed)
        return damaged.model_copy(
            update={
                "charge": damaged.charge.model_copy(update={field: "fixture-other"}),
            }
        )

    wire.transform = transform
    result = await gate.run(request())
    assert result.status != "READY" and result.artifact is None
    assert backend.rows["fixture-task-1"].state == "UNKNOWN_PENDING_RECONCILE"
    assert backend.charged == {} and backend.buckets["platform"] == 100


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field,value",
    [
        ("task_id", "fixture-other"),
        ("response_id", None),
        ("response_id", ""),
        ("role_id", "A02"),
        ("profile_version", "fixture-other"),
        ("requested_model", "fixture/other"),
        ("purpose", "EXTERNAL_OBSERVATION"),
    ],
)
async def test_repair_m1_missing_or_wrong_model_binding_cannot_be_guessed(
    field: str,
    value: Any,
) -> None:
    gate, backend, wire, _ = rig()

    def transform(observed: Any) -> Any:
        damaged = malformed_output(observed)
        return damaged.model_copy(
            update={
                "model_result": damaged.model_result.model_copy(update={field: value}),
            }
        )

    wire.transform = transform
    result = await gate.run(request())
    assert result.status != "READY" and backend.charged == {}
    assert backend.rows["fixture-task-1"].state == "UNKNOWN_PENDING_RECONCILE"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind",
    [
        "root_subclass",
        "model_subclass",
        "charge_subclass",
        "container",
        "extra",
        "model_extra",
        "primitive_subclass",
    ],
)
async def test_repair_m1_unsafe_shapes_are_not_consumed_to_salvage_charges(kind: str) -> None:
    gate, backend, wire, _ = rig()
    called: list[str] = []

    def transform(observed: Any) -> Any:
        damaged = malformed_output(observed)
        if kind.endswith("subclass") and kind != "primitive_subclass":
            target = (
                damaged
                if kind == "root_subclass"
                else getattr(
                    damaged,
                    {
                        "model_subclass": "model_result",
                        "charge_subclass": "charge",
                    }[kind],
                )
            )
            derived = type("IllegalFixtureSubclass", (type(target),), {})
            replacement = derived.model_construct(**object.__getattribute__(target, "__dict__"))
            if kind == "root_subclass":
                return replacement
            return damaged.model_copy(
                update={
                    "model_result" if kind == "model_subclass" else "charge": replacement,
                }
            )
        if kind == "container":

            class HostileDict(dict):
                def items(self) -> Any:
                    called.append("items")
                    raise AssertionError("untrusted method called")

            return damaged.model_copy(update={"model_result": HostileDict()})
        if kind == "primitive_subclass":

            class HostileText(str):
                def __eq__(self, other: object) -> bool:
                    called.append("eq")
                    return True

            return damaged.model_copy(
                update={
                    "charge": damaged.charge.model_copy(update={"task_id": HostileText("x")}),
                }
            )
        if kind == "model_extra":
            return damaged.model_copy(
                update={
                    "model_result": damaged.model_result.model_copy(update={"unexpected": "x"}),
                }
            )
        return damaged.model_copy(update={"confirmed": True})

    wire.transform = transform
    result = await gate.run(request())
    assert result.status != "READY" and backend.charged == {} and called == []
    assert backend.rows["fixture-task-1"].state == "UNKNOWN_PENDING_RECONCILE"


@pytest.mark.asyncio
async def test_repair_m1_damaged_output_charge_still_requires_a_trusted_receipt() -> None:
    gate, backend, wire, _ = rig()
    backend.invoices.clear()
    wire.transform = malformed_output
    result = await gate.run(request())
    assert result.status != "READY" and result.artifact is None
    assert backend.rows["fixture-task-1"].state == "UNKNOWN_PENDING_RECONCILE"
    assert backend.charged == {} and backend.buckets["platform"] == 100
