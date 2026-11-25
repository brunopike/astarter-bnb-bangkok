"""Native PG D1 reference repository, not a Control/financial runtime port.

Inherits D1's typed read/restore/causal validation, overriding every database and
transaction operation. No SQLite connection is constructed or emulated. Internal
D1 predicates use '?' and are translated only at the private _row boundary; caller
values always go through Psycopg binding, identifiers through sql.Identifier.
"""
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from psycopg import Connection, sql

from stark_trading_os.control.astarter import strategy_repository as r
from stark_trading_os.domain import strategy_contracts as c

from .access import APPEND_TABLES, READ_TABLES
from .pool import PgRepositoryPool


class PostgresStrategyRepository(r.StrategyRepository):
    def __init__(self, pool: PgRepositoryPool, source: r.BackendScopeSource) -> None:
        self._pool = pool
        self._assignment = r._valid(source.resolve_scope(), r.ScopeAssignment)
        self._binding = self._assignment.binding
        self._scope_id = c.contract_hash(self._binding)
        self._connection: ContextVar[Connection[dict[str, Any]]] = ContextVar('pg2_connection')
        with self._read():
            pass

    @contextmanager
    def _transaction(self, *, write: bool) -> Iterator[None]:
        with self._pool.transaction(write=write, scope_id=self._scope_id) as connection:
            token = self._connection.set(connection)
            try:
                self._scope()
                yield
            finally:
                self._connection.reset(token)

    @contextmanager
    def _read(self) -> Iterator[None]:
        with self._transaction(write=False):
            yield

    def _scope(self) -> None:
        row = self._row('astarter_strategy_scopes',
                        'tenant_id=? AND account_id=? AND environment=?',
                        (self._binding.tenant_id, self._binding.account_id,
                         self._binding.environment))
        if row is None:
            raise r.ScopeDenied('BACKEND_SCOPE_NOT_PROVISIONED')
        if r._decode(row, r.ScopeAssignment, self._scope_id) != self._assignment:
            raise r.ScopeDenied('BACKEND_SCOPE_PROVENANCE_MISMATCH')

    def _row(self, table: str, where: str, args: tuple[r._Cell, ...]) -> dict[str, Any] | None:
        if table not in READ_TABLES:
            raise ValueError('PG2_TABLE')
        return self._connection.get().execute(
            sql.SQL('SELECT * FROM pg1_control.{} WHERE scope_id=%s AND ').format(
                sql.Identifier(table)) + sql.SQL(where.replace('?', '%s')),
            (self._scope_id, *args),
        ).fetchone()

    def _insert(self, table: str, value: c.Offline) -> None:
        if table not in APPEND_TABLES:
            raise ValueError('PG2_TABLE')
        fields = {'scope_id': self._scope_id, **r._columns(value),
                  'content_bytes': r._raw(value), 'content_sha256': r.reference_hash(value)}
        statement = sql.SQL('INSERT INTO pg1_control.{} ({}) VALUES ({})').format(
            sql.Identifier(table), sql.SQL(',').join(map(sql.Identifier, fields)),
            sql.SQL(',').join(sql.Placeholder() for _ in fields))
        self._connection.get().execute(statement, tuple(fields.values()))

    def save_plan(self, bundle: c.PreflightInput, *, request_key: str,
                  expected_revision: str | None, now_ms: int) -> r.PlanRecord:
        valid = r._valid(bundle, c.PreflightInput)
        self._binding_check(valid.plan.binding)
        for evidence in valid.evidence:
            self._evidence(evidence)
        c.preflight(valid, now_ms=now_ms)
        if valid.approval is not None:
            raise ValueError('APPROVAL_REQUIRES_PRIVATE_REFERENCE_TABLE')
        with self._transaction(write=True):
            prior = self._row('astarter_plan_versions', 'request_key=?', (request_key,))
            if prior is not None:
                saved = self._plan(str(prior['plan_id']), str(prior['revision']))
                if saved.bundle != valid or saved.previous_revision != expected_revision:
                    raise r.PersistenceConflict('REQUEST_PAYLOAD_CONFLICT')
                return saved
            try:
                old = self._plan(valid.plan.plan_id, None)
            except LookupError:
                old = None
            if (None if old is None else old.bundle.plan.revision) != expected_revision:
                raise r.PersistenceConflict('PLAN_CAS_CONFLICT')
            if old is not None:
                c.check_revision(old.bundle.plan, valid.plan)
            record = r.PlanRecord(request_key=request_key, previous_revision=expected_revision,
                                  ordinal=1 if old is None else old.ordinal + 1, bundle=valid)
            spec = valid.plan.spec
            existing = self._row('astarter_strategy_versions', 'content_sha256=?',
                                 (c.contract_hash(spec),))
            if existing is None:
                self._insert('astarter_strategy_versions', spec)
            elif r._decode(existing, c.StrategySpec, self._scope_id) != spec:
                raise r.StoredReferenceError('STRATEGY_VERSION_MISMATCH')
            self._insert('astarter_plan_versions', record)
            return record

    def save_approval(self, plan_id: str, approval: c.ApprovalSnapshot, *,
                      request_key: str, now_ms: int) -> r.ApprovalRecord:
        a = r._valid(approval, c.ApprovalSnapshot)
        self._binding_check(a.binding)
        for duty in a.duties:
            self._evidence(duty.source)
        value = r.ApprovalRecord(request_key=request_key, plan_id=plan_id, approval=a)
        with self._transaction(write=True):
            p = self._plan(plan_id, a.plan_revision).bundle.plan
            c.check_approval(p, a, now_ms=now_ms)
            if (a.plan_sha256 != c.contract_hash(p)
                    or a.risk_policy_revision != p.risk_policy_revision
                    or a.role_schema_revision != p.role_schema_revision):
                raise r.PersistenceConflict('APPROVAL_PLAN_MISMATCH')
            row = self._row('astarter_approval_references',
                            '(request_key=? OR reference_id=?)', (request_key, a.reference_id))
            if row is not None:
                old = r._decode(row, r.ApprovalRecord, self._scope_id)
                if old != value:
                    raise r.PersistenceConflict('REQUEST_PAYLOAD_CONFLICT')
                return old
            self._insert('astarter_approval_references', value)
            return value

    def list_plans(self, *, after: tuple[str, int] = ('', 0), limit: int = 100,
                   now_ms: int) -> tuple[r.RestoredPlan, ...]:
        c._clock(now_ms)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError('INVALID_PAGE_LIMIT')
        with self._read():
            rows = self._connection.get().execute(
                'SELECT plan_id,revision FROM pg1_control.astarter_plan_versions '
                'WHERE scope_id=%s AND (plan_id,ordinal)>(%s,%s) '
                'ORDER BY plan_id,ordinal LIMIT %s', (self._scope_id, *after, limit),
            ).fetchall()
            return tuple(self._restore(row['plan_id'], row['revision'], None, now_ms)
                         for row in rows)

    def _reference[T: c.Offline](self, table: str, where: str, args: tuple[r._Cell, ...],
                                value: T, cls: type[T]) -> T:
        row = self._row(table, where, args)
        if row is not None:
            old = r._decode(row, cls, self._scope_id)
            if old != value:
                raise r.PersistenceConflict('REFERENCE_PAYLOAD_CONFLICT')
            return old
        self._insert(table, value)
        return value

    def save_episode(self, value: r.EpisodeReference) -> r.EpisodeReference:
        item = r._valid(value, r.EpisodeReference)
        self._binding_check(item.binding)
        with self._transaction(write=True):
            p = self._plan(item.plan_id, item.revision).bundle.plan
            if c.contract_hash(p) != item.plan_sha256:
                raise r.PersistenceConflict('EPISODE_PLAN_MISMATCH')
            return self._reference('astarter_episode_references', 'episode_id=?',
                                   (item.episode_id,), item, r.EpisodeReference)

    def save_layer(self, value: r.LayerReference) -> r.LayerReference:
        item = r._valid(value, r.LayerReference)
        self._binding_check(item.binding)
        self._evidence(item.trigger)
        with self._transaction(write=True):
            self._episode(item.episode_id)
            return self._reference('astarter_layer_references', 'episode_id=? AND layer_index=?',
                                   (item.episode_id, item.layer_index), item, r.LayerReference)

    def save_recovery(self, value: r.RecoveryCheckpoint, *, now_ms: int) -> r.RecoveryCheckpoint:
        item = r._valid(value, r.RecoveryCheckpoint)
        c._clock(now_ms)
        self._binding_check(item.binding)
        self._evidence(item.causal)
        if item.observed_at_ms > now_ms:
            raise ValueError('RECOVERY_FROM_FUTURE')
        with self._transaction(write=True):
            p = self._plan(item.plan_id, item.revision).bundle.plan
            if item.plan_sha256 != c.contract_hash(p):
                raise r.PersistenceConflict('RECOVERY_PLAN_MISMATCH')
            replay = self._row('astarter_recovery_checkpoints', 'request_key=?',
                               (item.request_key,))
            if replay is not None:
                replayed = self._checkpoint(replay)
                if replayed != item:
                    raise r.PersistenceConflict('REQUEST_PAYLOAD_CONFLICT')
                return replayed
            row = self._row('astarter_recovery_checkpoints',
                            'plan_id=? AND revision=? ORDER BY seq DESC LIMIT 1',
                            (item.plan_id, item.revision))
            old = None if row is None else self._checkpoint(row)
            if (item.seq != (1 if old is None else old.seq + 1)
                    or item.previous_sha256 != (None if old is None else r.reference_hash(old))):
                raise r.PersistenceConflict('RECOVERY_CAS_CONFLICT')
            if old is not None:
                if item.observed_at_ms < old.observed_at_ms:
                    raise r.PersistenceConflict('RECOVERY_TIME_REGRESSION')
                if not set(old.reason_locks) <= set(item.reason_locks):
                    raise r.PersistenceConflict('D1_CANNOT_CLEAR_REASON_LOCKS')
                for name in ('order', 'protection', 'reconciliation'):
                    before = getattr(old.state, name)
                    if before in {'UNKNOWN', 'PARTIAL'} and getattr(item.state, name) != before:
                        raise r.PersistenceConflict('D1_CANNOT_RECONCILE_UNKNOWN_OR_PARTIAL')
                if (old.budgets.supplier.liability == 'UNKNOWN_PENDING_RECONCILE'
                        and item.budgets.supplier != old.budgets.supplier):
                    raise r.PersistenceConflict('D1_CANNOT_SETTLE_SUPPLIER_LIABILITY')
            self._insert('astarter_recovery_checkpoints', item)
            saved = self._row('astarter_recovery_checkpoints', 'request_key=?', (item.request_key,))
            assert saved is not None
            return self._checkpoint(saved)

    def reconcile_request(self, kind: str, request_key: str, expected_sha256: str) -> str:
        """Read-only evidence: missing is UNKNOWN, never permission to replay a write."""
        tables = {'plan': 'astarter_plan_versions', 'approval': 'astarter_approval_references',
                  'recovery': 'astarter_recovery_checkpoints'}
        classes: dict[str, type[c.Offline]] = {
            'plan': r.PlanRecord, 'approval': r.ApprovalRecord, 'recovery': r.RecoveryCheckpoint}
        if kind not in tables:
            raise ValueError('PG2_RECONCILE_KIND')
        with self._read():
            row = self._row(tables[kind], 'request_key=?', (request_key,))
            if row is None:
                return 'UNKNOWN'
            value = r._decode(row, classes[kind], self._scope_id)
            return 'CONFIRMED' if r.reference_hash(value) == expected_sha256 else 'CONFLICT'
