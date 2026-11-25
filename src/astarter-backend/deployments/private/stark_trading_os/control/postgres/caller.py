"""Explicit single-lifespan owner and per-request typed reference caller."""
import asyncio
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

from stark_trading_os.control.astarter import strategy_repository as r
from stark_trading_os.domain import strategy_contracts as c

from .identity import IdentityRegistry, Principal
from .pool import PgRepositoryPool, PoolSettings
from .strategy_repository import PostgresStrategyRepository
from .synthetic_migration import TargetProfile


async def owned_thread[T](call: Callable[[], T]) -> T:
    """Cancellation waits for bounded synchronous DAL work before releasing ownership."""
    task = asyncio.create_task(asyncio.to_thread(call))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        # Retrieve any exception, without logging data/driver diagnostics.
        if not task.cancelled():
            task.exception()
        raise


class ReferenceRuntime:
    def __init__(self, identities: IdentityRegistry, *, reader_conninfo: str,
                 writer_conninfo: str, settings: PoolSettings = PoolSettings(),
                 profile: TargetProfile = TargetProfile.LOCAL_PG17) -> None:
        if type(identities) is not IdentityRegistry:
            raise ValueError('REFERENCE_CONFIGURATION')
        self.identities = identities
        self.reader = PgRepositoryPool(reader_conninfo, settings=settings,
                                       writable=False, profile=profile)
        self.writer = PgRepositoryPool(writer_conninfo, settings=settings,
                                       writable=True, profile=profile)
        self._active = False
        self._used = False

    def _open(self) -> None:
        self.reader.open()
        self.writer.open()
        self._active = True

    def _close(self) -> None:
        self._active = False
        try:
            self.writer.close()
        finally:
            self.reader.close()

    @asynccontextmanager
    async def lifespan(self) -> AsyncIterator[None]:
        if self._used:
            raise RuntimeError('REFERENCE_RUNTIME_ALREADY_USED')
        self._used = True
        try:
            await owned_thread(self._open)
            yield
        finally:
            await owned_thread(self._close)

    def admit(self, headers: tuple[str, ...], *, write: bool) -> 'ReferenceCaller':
        principal = self.identities.authenticate(headers)
        if write and principal.role != 'writer':
            raise PermissionError('REFERENCE_FORBIDDEN')
        if not self._active:
            raise RuntimeError('REFERENCE_UNAVAILABLE')
        pool = self.writer if principal.role == 'writer' else self.reader
        return ReferenceCaller(pool, principal)


class ReferenceCaller:
    """One admission, one immutable scope; never share a repository between requests."""
    def __init__(self, pool: PgRepositoryPool, principal: Principal) -> None:
        self._pool, self._principal = pool, principal

    def _repo(self, *, write: bool = False) -> PostgresStrategyRepository:
        if write and self._principal.role != 'writer':
            raise PermissionError('REFERENCE_FORBIDDEN')
        return PostgresStrategyRepository(self._pool, self._principal)

    def _binding(self, binding: c.PrivateBinding | None) -> None:
        if binding is not None and binding != self._principal.scope.binding:
            raise r.ScopeDenied('PRIVATE_SCOPE_MISMATCH')

    def list_plans(self, *, after: tuple[str, int], limit: int) -> tuple[r.RestoredPlan, ...]:
        return self._repo().list_plans(after=after, limit=limit, now_ms=_now())

    def read_plan(self, plan_id: str, *, revision: str | None,
                  approval_id: str | None) -> r.RestoredPlan:
        return self._repo().read_plan(plan_id, revision=revision,
                                      approval_id=approval_id, now_ms=_now())

    def save_plan(self, bundle: c.PreflightInput, *, request_key: str,
                  expected_revision: str | None) -> r.PlanRecord:
        bundle = r._valid(bundle, c.PreflightInput)
        self._binding(bundle.plan.binding)
        for evidence in bundle.evidence:
            self._binding(evidence.binding)
        return self._repo(write=True).save_plan(bundle, request_key=request_key,
                                               expected_revision=expected_revision, now_ms=_now())

    def save_approval(self, plan_id: str, approval: c.ApprovalSnapshot, *,
                      request_key: str) -> r.ApprovalRecord:
        approval = r._valid(approval, c.ApprovalSnapshot)
        self._binding(approval.binding)
        for duty in approval.duties:
            self._binding(duty.source.binding)
        return self._repo(write=True).save_approval(plan_id, approval,
                                                   request_key=request_key, now_ms=_now())

    def save_recovery(self, checkpoint: r.RecoveryCheckpoint) -> r.RecoveryCheckpoint:
        checkpoint = r._valid(checkpoint, r.RecoveryCheckpoint)
        self._binding(checkpoint.binding)
        self._binding(checkpoint.causal.binding)
        return self._repo(write=True).save_recovery(checkpoint, now_ms=_now())

    def read_recovery(self, plan_id: str, revision: str, *, seq: int | None,
                      approval_id: str | None) -> r.RestoredRecovery:
        return self._repo().read_recovery(plan_id, revision, seq=seq,
                                          approval_id=approval_id, now_ms=_now())


def _now() -> int:
    return time.time_ns() // 1_000_000
