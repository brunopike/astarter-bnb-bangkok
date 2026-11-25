"""Q05-D1 private offline references; not an issuer, ledger or execution adapter.

BackendScopeSource is an injected *trusted backend* dependency, not authentication.
Never implement it from request tenant strings. Provisioning is a separate privileged
step; constructing a repository cannot claim an existing v6 account. No public cache
or global-ID read API is provided. All SQL values are scoped and parameterized.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from hashlib import sha256
from typing import Annotated, Literal, Protocol, Self, cast

from pydantic import BaseModel, Field, StrictInt, model_validator

from stark_trading_os.control.database import _immediate_transaction, verify_control_connection
from stark_trading_os.domain import strategy_contracts as c
from stark_trading_os.integrations.contracts import Identifier, Timestamp
from stark_trading_os.integrations.research_egress import Digest, canonical, encode


class PersistenceConflict(ValueError):
    """Immutable identity, replay or predecessor mismatch."""


class ScopeDenied(ValueError):
    """No trusted assignment or payload outside the backend-selected scope."""


class StoredReferenceError(ValueError):
    """Stored bytes, typed payload or relational columns disagree."""


class ScopeAssignment(c.Offline):
    binding: c.PrivateBinding
    venue_session: Annotated[str, Field(pattern=r"^[0-9a-f-]{36}$")]
    authority_ref: Identifier


class BackendScopeSource(Protocol):
    def resolve_scope(self) -> ScopeAssignment:
        """Return ownership resolved by backend policy, never client claims."""
        ...


class PlanRecord(c.Offline):
    request_key: Identifier
    previous_revision: Identifier | None
    ordinal: Annotated[StrictInt, Field(gt=0)]
    bundle: c.PreflightInput

    @model_validator(mode="after")
    def shape(self) -> Self:
        if self.bundle.approval is not None:
            raise ValueError("APPROVAL_REQUIRES_PRIVATE_REFERENCE_TABLE")
        if (self.ordinal == 1) != (self.previous_revision is None):
            raise ValueError("PLAN_PREDECESSOR_REQUIRED")
        return self


class ApprovalRecord(c.Offline):
    request_key: Identifier
    plan_id: Identifier
    authority: Literal["OFFLINE_REFERENCE"] = "OFFLINE_REFERENCE"
    approval: c.ApprovalSnapshot


class EpisodeReference(c.Offline):
    binding: c.PrivateBinding
    episode_id: Identifier
    plan_id: Identifier
    revision: Identifier
    plan_sha256: Digest
    binding_id: Identifier | None = None


class LayerReference(c.Offline):
    binding: c.PrivateBinding
    episode_id: Identifier
    layer_index: Annotated[StrictInt, Field(ge=0, le=127)]
    mode: Literal["VIRTUAL", "ACTUAL_REFERENCE"]
    action_id: Identifier
    trigger: c.EvidenceSnapshot
    disposition: Literal["TRIGGERED_REFERENCE", "SKIPPED", "NO_FILL_REFERENCE", "UNKNOWN"]


class RecoveryCheckpoint(c.Offline):
    binding: c.PrivateBinding
    request_key: Identifier
    plan_id: Identifier
    revision: Identifier
    plan_sha256: Digest
    seq: Annotated[StrictInt, Field(gt=0)]
    previous_sha256: Digest | None
    state: c.StateSnapshot
    reason_locks: c.Names
    causal: c.EvidenceSnapshot
    observed_at_ms: Timestamp
    budgets: c.BudgetSnapshot
    episode_id: Identifier | None = None
    layer_index: Annotated[StrictInt, Field(ge=0, le=127)] | None = None
    audit_seq: Annotated[StrictInt, Field(gt=0)] | None = None

    @model_validator(mode="after")
    def shape(self) -> Self:
        if (self.seq == 1) != (self.previous_sha256 is None):
            raise ValueError("RECOVERY_PREDECESSOR_REQUIRED")
        if self.layer_index is not None and self.episode_id is None:
            raise ValueError("LAYER_REQUIRES_EPISODE")
        if self.observed_at_ms < self.causal.received_at_ms:
            raise ValueError("CAUSAL_REFERENCE_FROM_FUTURE")
        if len(set(self.reason_locks)) != len(self.reason_locks):
            raise ValueError("DUPLICATE_REASON_LOCK")
        return self


# Reuse the frozen Q01 exact-tree boundary; do not weaken it via model_dump first.
_TYPES: tuple[type[BaseModel], ...] = (
    *c._TYPES, ScopeAssignment, PlanRecord, ApprovalRecord, EpisodeReference,
    LayerReference, RecoveryCheckpoint,
)
type _Cell = str | int | bytes | None


class ReferenceRow(Protocol):
    """Named cells shared by SQLite Row and native PostgreSQL dict_row."""

    def __getitem__(self, key: str, /) -> object: ...


def _valid[T: BaseModel](value: object, cls: type[T]) -> T:
    return canonical(value, cls, extra=_TYPES)


def reference_hash(value: c.Offline) -> str:
    if type(value) not in _TYPES:
        raise ValueError("UNKNOWN_REFERENCE_TYPE")
    return sha256(_raw(_valid(value, type(value)))).hexdigest()


def _raw(value: BaseModel) -> bytes:
    return encode(value.model_dump(mode="json")).encode("utf-8")


def _columns(value: c.Offline) -> dict[str, _Cell]:
    if isinstance(value, ScopeAssignment):
        return dict(scope_id=c.contract_hash(value.binding), tenant_id=value.binding.tenant_id,
                    account_id=value.binding.account_id, environment=value.binding.environment,
                    venue_session=value.venue_session, authority_ref=value.authority_ref)
    if isinstance(value, c.StrategySpec):
        return dict(strategy_id=value.identity.strategy_id, kind=value.identity.kind,
                    version=value.identity.version, profile_revision=value.profile.revision,
                    parameter_revision=value.parameter_revision)
    if isinstance(value, PlanRecord):
        p = value.bundle.plan
        return dict(plan_id=p.plan_id, revision=p.revision, ordinal=value.ordinal,
                    previous_revision=value.previous_revision, request_key=value.request_key,
                    plan_sha256=c.contract_hash(p), spec_sha256=c.contract_hash(p.spec),
                    risk_policy_revision=p.risk_policy_revision,
                    role_schema_revision=p.role_schema_revision, starts_at_ms=p.starts_at_ms,
                    expires_at_ms=p.expires_at_ms)
    if isinstance(value, ApprovalRecord):
        a = value.approval
        return dict(plan_id=value.plan_id, revision=a.plan_revision, plan_sha256=a.plan_sha256,
                    reference_id=a.reference_id, request_key=value.request_key,
                    authority=value.authority, risk_policy_revision=a.risk_policy_revision,
                    role_schema_revision=a.role_schema_revision, starts_at_ms=a.starts_at_ms,
                    expires_at_ms=a.expires_at_ms)
    if isinstance(value, EpisodeReference):
        return dict(account_id=value.binding.account_id, episode_id=value.episode_id,
                    plan_id=value.plan_id, revision=value.revision, plan_sha256=value.plan_sha256,
                    binding_id=value.binding_id)
    if isinstance(value, LayerReference):
        return dict(episode_id=value.episode_id, layer_index=value.layer_index, mode=value.mode,
                    action_id=value.action_id, trigger_id=value.trigger.evidence_id)
    if isinstance(value, RecoveryCheckpoint):
        return dict(account_id=value.binding.account_id, plan_id=value.plan_id,
                    revision=value.revision, plan_sha256=value.plan_sha256, seq=value.seq,
                    previous_sha256=value.previous_sha256, request_key=value.request_key,
                    state_sha256=c.contract_hash(value.state), lifecycle=value.state.lifecycle,
                    order_state=value.state.order, protection=value.state.protection,
                    reconciliation=value.state.reconciliation, causal_id=value.causal.evidence_id,
                    observed_at_ms=value.observed_at_ms, episode_id=value.episode_id,
                    layer_index=value.layer_index, audit_seq=value.audit_seq)
    raise ValueError("UNKNOWN_REFERENCE_TYPE")


def _json_tree(value: object, depth: int = 0) -> object:
    # Q01 has tuple-only arrays. Its before validators switch JSON validation to
    # Python mode, so decode arrays explicitly, without coercing any scalar.
    if depth > 32:
        raise ValueError("REFERENCE_TOO_DEEP")
    if isinstance(value, list):
        return tuple(_json_tree(v, depth + 1) for v in value)
    if isinstance(value, dict):
        return {k: _json_tree(v, depth + 1) for k, v in value.items()}
    return value


def _decode[T: c.Offline](row: ReferenceRow, cls: type[T], scope_id: str) -> T:
    try:
        raw = row["content_bytes"]
        if type(raw) is not bytes or len(raw) > 262144:
            raise ValueError
        value = _valid(cls.model_validate(_json_tree(json.loads(raw)), strict=True), cls)
        if (_raw(value) != raw or reference_hash(value) != row["content_sha256"]
                or row["scope_id"] != scope_id
                or any(row[k] != v for k, v in _columns(value).items())):
            raise ValueError
        return value
    except (ValueError, TypeError, KeyError) as error:
        raise StoredReferenceError("D1_STORED_REFERENCE_MISMATCH") from error


def _insert(connection: sqlite3.Connection, table: str, scope_id: str, value: c.Offline) -> None:
    # Identifiers come only from this module, never from caller-supplied SQL.
    fields: dict[str, _Cell] = {"scope_id": scope_id, **_columns(value)}
    fields.update(content_bytes=_raw(value), content_sha256=reference_hash(value))
    connection.execute(
        f"INSERT INTO {table} ({','.join(fields)}) VALUES ({','.join('?' for _ in fields)})",
        tuple(fields.values()),
    )


def provision_account_scope(connection: sqlite3.Connection, source: BackendScopeSource) -> None:
    """Privileged backend wiring only; NOT a client account-claim command.

    D1 supplies no authenticated implementation. Synthetic fixtures implement the
    trust interface explicitly. Unassigned legacy accounts remain inaccessible.
    """
    assignment = _valid(source.resolve_scope(), ScopeAssignment)
    sid = c.contract_hash(assignment.binding)
    verify_control_connection(connection)
    with _immediate_transaction(connection):
        row = connection.execute(
            "SELECT * FROM astarter_strategy_scopes WHERE account_id=?",
            (assignment.binding.account_id,),
        ).fetchone()
        if row is not None:
            if _decode(row, ScopeAssignment, sid) != assignment:
                raise ScopeDenied("ACCOUNT_ALREADY_ASSIGNED")
            return
        _insert(connection, "astarter_strategy_scopes", sid, assignment)


@dataclass(frozen=True)
class RestoredPlan:
    record: PlanRecord
    approval: ApprovalRecord | None
    decision: c.Decision
    current: bool


@dataclass(frozen=True)
class RestoredRecovery:
    """Typed archive view, never aggregate recovery readiness or execution authority."""

    checkpoint: RecoveryCheckpoint
    plan: RestoredPlan
    state_policy: c.StatePolicy
    budget_policy: c.BudgetPolicy
    checkpoint_current: bool
    reference_only: Literal[True] = field(default=True, init=False)


class StrategyRepository:
    def __init__(self, connection: sqlite3.Connection, source: BackendScopeSource) -> None:
        verify_control_connection(connection)
        self._c = connection
        self._assignment = _valid(source.resolve_scope(), ScopeAssignment)
        self._binding = self._assignment.binding
        self._scope_id = c.contract_hash(self._binding)
        self._scope()

    def _scope(self) -> None:
        row = self._c.execute(
            "SELECT * FROM astarter_strategy_scopes WHERE scope_id=? AND tenant_id=? "
            "AND account_id=? AND environment=?",
            (self._scope_id, self._binding.tenant_id, self._binding.account_id,
             self._binding.environment),
        ).fetchone()
        if row is None:
            raise ScopeDenied("BACKEND_SCOPE_NOT_PROVISIONED")
        if _decode(row, ScopeAssignment, self._scope_id) != self._assignment:
            raise ScopeDenied("BACKEND_SCOPE_PROVENANCE_MISMATCH")

    def _binding_check(self, binding: c.PrivateBinding) -> None:
        if binding != self._binding:
            raise ScopeDenied("PRIVATE_SCOPE_MISMATCH")

    def _evidence(self, evidence: c.EvidenceSnapshot) -> None:
        if evidence.binding is not None:
            self._binding_check(evidence.binding)

    @contextmanager
    def _read(self) -> Iterator[None]:
        if self._c.in_transaction:
            raise RuntimeError("Nested repository transaction")
        self._c.execute("BEGIN")
        try:
            self._scope()
            yield
        finally:
            self._c.rollback()

    def _row(self, table: str, where: str, args: tuple[_Cell, ...]) -> ReferenceRow | None:
        return cast(sqlite3.Row | None, self._c.execute(
            f"SELECT * FROM {table} WHERE scope_id=? AND {where}",
            (self._scope_id, *args),
        ).fetchone())

    def _plan(self, plan_id: str, revision: str | None) -> PlanRecord:
        if revision is None:
            row = self._row("astarter_plan_versions", "plan_id=? ORDER BY ordinal DESC LIMIT 1",
                            (plan_id,))
        else:
            row = self._row("astarter_plan_versions", "plan_id=? AND revision=?",
                            (plan_id, revision))
        if row is None:
            raise LookupError("PRIVATE_PLAN_NOT_FOUND")
        result = _decode(row, PlanRecord, self._scope_id)
        self._binding_check(result.bundle.plan.binding)
        for evidence in result.bundle.evidence:
            self._evidence(evidence)
        spec = self._row("astarter_strategy_versions", "content_sha256=?",
                         (c.contract_hash(result.bundle.plan.spec),))
        if spec is None or _decode(spec, c.StrategySpec, self._scope_id) != result.bundle.plan.spec:
            raise StoredReferenceError("STRATEGY_VERSION_MISMATCH")
        return result

    def save_plan(self, bundle: c.PreflightInput, *, request_key: str,
                  expected_revision: str | None, now_ms: int) -> PlanRecord:
        valid = _valid(bundle, c.PreflightInput)
        self._binding_check(valid.plan.binding)
        for evidence in valid.evidence:
            self._evidence(evidence)
        # Blocked/expired references may be archived, never activated.
        c.preflight(valid, now_ms=now_ms)
        if valid.approval is not None:
            raise ValueError("APPROVAL_REQUIRES_PRIVATE_REFERENCE_TABLE")
        with _immediate_transaction(self._c):
            self._scope()
            prior = self._row("astarter_plan_versions", "request_key=?", (request_key,))
            if prior is not None:
                saved = self._plan(str(prior["plan_id"]), str(prior["revision"]))
                if saved.bundle != valid or saved.previous_revision != expected_revision:
                    raise PersistenceConflict("REQUEST_PAYLOAD_CONFLICT")
                return saved
            try:
                old = self._plan(valid.plan.plan_id, None)
            except LookupError:
                old = None
            if (None if old is None else old.bundle.plan.revision) != expected_revision:
                raise PersistenceConflict("PLAN_CAS_CONFLICT")
            if old is not None:
                c.check_revision(old.bundle.plan, valid.plan)
            record = PlanRecord(request_key=request_key, previous_revision=expected_revision,
                                ordinal=1 if old is None else old.ordinal + 1, bundle=valid)
            spec = valid.plan.spec
            existing = self._row("astarter_strategy_versions", "content_sha256=?",
                                 (c.contract_hash(spec),))
            if existing is None:
                _insert(self._c, "astarter_strategy_versions", self._scope_id, spec)
            elif _decode(existing, c.StrategySpec, self._scope_id) != spec:
                raise StoredReferenceError("STRATEGY_VERSION_MISMATCH")
            _insert(self._c, "astarter_plan_versions", self._scope_id, record)
            return record

    def save_approval(self, plan_id: str, approval: c.ApprovalSnapshot, *,
                      request_key: str, now_ms: int) -> ApprovalRecord:
        a = _valid(approval, c.ApprovalSnapshot)
        self._binding_check(a.binding)
        for duty in a.duties:
            self._evidence(duty.source)
        value = ApprovalRecord(request_key=request_key, plan_id=plan_id, approval=a)
        with _immediate_transaction(self._c):
            self._scope()
            p = self._plan(plan_id, a.plan_revision).bundle.plan
            c.check_approval(p, a, now_ms=now_ms)
            if (a.plan_sha256 != c.contract_hash(p)
                    or a.risk_policy_revision != p.risk_policy_revision
                    or a.role_schema_revision != p.role_schema_revision):
                raise PersistenceConflict("APPROVAL_PLAN_MISMATCH")
            row = self._row("astarter_approval_references", "(request_key=? OR reference_id=?)",
                            (request_key, a.reference_id))
            if row is not None:
                old = _decode(row, ApprovalRecord, self._scope_id)
                if old != value:
                    raise PersistenceConflict("REQUEST_PAYLOAD_CONFLICT")
                return old
            _insert(self._c, "astarter_approval_references", self._scope_id, value)
            return value

    def _restore(self, plan_id: str, revision: str | None, approval_id: str | None,
                 now_ms: int) -> RestoredPlan:
        record = self._plan(plan_id, revision)
        approval = None
        if approval_id is not None:
            row = self._row("astarter_approval_references", "reference_id=?", (approval_id,))
            if row is None:
                raise LookupError("PRIVATE_APPROVAL_NOT_FOUND")
            approval = _decode(row, ApprovalRecord, self._scope_id)
            self._binding_check(approval.approval.binding)
            for duty in approval.approval.duties:
                self._evidence(duty.source)
            if approval.plan_id != plan_id:
                raise PersistenceConflict("APPROVAL_PLAN_MISMATCH")
        bundle = c.PreflightInput(plan=record.bundle.plan, evidence=record.bundle.evidence,
                                  approval=None if approval is None else approval.approval)
        decision = c.preflight(bundle, now_ms=now_ms)
        current = self._plan(plan_id, None).ordinal == record.ordinal
        if not current:
            decision = c.Decision(status="BLOCKED", reasons=("PLAN_SUPERSEDED",))
        return RestoredPlan(record, approval, decision, current)

    def read_plan(self, plan_id: str, *, revision: str | None = None,
                  approval_id: str | None = None, now_ms: int) -> RestoredPlan:
        """Read an offline plan; current means latest plan version in this scope only."""
        with self._read():
            return self._restore(plan_id, revision, approval_id, now_ms)

    def list_plans(self, *, after: tuple[str, int] = ("", 0), limit: int = 100,
                   now_ms: int) -> tuple[RestoredPlan, ...]:
        c._clock(now_ms)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("INVALID_PAGE_LIMIT")
        with self._read():
            rows = self._c.execute(
                "SELECT plan_id,revision FROM astarter_plan_versions WHERE scope_id=? "
                "AND (plan_id,ordinal)>(?,?) ORDER BY plan_id,ordinal LIMIT ?",
                (self._scope_id, *after, limit),
            ).fetchall()
            return tuple(self._restore(r[0], r[1], None, now_ms) for r in rows)

    def save_episode(self, value: EpisodeReference) -> EpisodeReference:
        item = _valid(value, EpisodeReference)
        self._binding_check(item.binding)
        with _immediate_transaction(self._c):
            self._scope()
            p = self._plan(item.plan_id, item.revision).bundle.plan
            if c.contract_hash(p) != item.plan_sha256:
                raise PersistenceConflict("EPISODE_PLAN_MISMATCH")
            return self._reference("astarter_episode_references", "episode_id=?",
                                   (item.episode_id,), item, EpisodeReference)

    def save_layer(self, value: LayerReference) -> LayerReference:
        item = _valid(value, LayerReference)
        self._binding_check(item.binding)
        self._evidence(item.trigger)
        with _immediate_transaction(self._c):
            self._scope()
            self._episode(item.episode_id)
            return self._reference("astarter_layer_references", "episode_id=? AND layer_index=?",
                                   (item.episode_id, item.layer_index), item, LayerReference)

    def _reference[T: c.Offline](self, table: str, where: str, args: tuple[_Cell, ...],
                                value: T, cls: type[T]) -> T:
        row = self._row(table, where, args)
        if row is not None:
            old = _decode(row, cls, self._scope_id)
            if old != value:
                raise PersistenceConflict("REFERENCE_PAYLOAD_CONFLICT")
            return old
        _insert(self._c, table, self._scope_id, value)
        return value

    def _episode(self, episode_id: str) -> EpisodeReference:
        row = self._row("astarter_episode_references", "episode_id=?", (episode_id,))
        if row is None:
            raise LookupError("PRIVATE_EPISODE_NOT_FOUND")
        value = _decode(row, EpisodeReference, self._scope_id)
        self._binding_check(value.binding)
        p = self._plan(value.plan_id, value.revision).bundle.plan
        if value.plan_sha256 != c.contract_hash(p):
            raise StoredReferenceError("EPISODE_PLAN_MISMATCH")
        return value

    def read_episode(self, episode_id: str) -> EpisodeReference:
        with self._read():
            return self._episode(episode_id)

    def _layer(self, episode_id: str, layer_index: int) -> LayerReference:
        self._episode(episode_id)
        row = self._row("astarter_layer_references", "episode_id=? AND layer_index=?",
                        (episode_id, layer_index))
        if row is None:
            raise LookupError("PRIVATE_LAYER_NOT_FOUND")
        value = _decode(row, LayerReference, self._scope_id)
        self._binding_check(value.binding)
        self._evidence(value.trigger)
        return value

    def read_layer(self, episode_id: str, layer_index: int) -> LayerReference:
        with self._read():
            return self._layer(episode_id, layer_index)

    def _checkpoint(self, row: ReferenceRow) -> RecoveryCheckpoint:
        item = _decode(row, RecoveryCheckpoint, self._scope_id)
        self._binding_check(item.binding)
        self._evidence(item.causal)
        p = self._plan(item.plan_id, item.revision).bundle.plan
        if item.plan_sha256 != c.contract_hash(p):
            raise StoredReferenceError("RECOVERY_PLAN_MISMATCH")
        if item.seq > 1:
            previous = self._row("astarter_recovery_checkpoints",
                                 "plan_id=? AND revision=? AND seq=?",
                                 (item.plan_id, item.revision, item.seq - 1))
            if previous is None:
                raise StoredReferenceError("RECOVERY_PREDECESSOR_MISSING")
            prior = _decode(previous, RecoveryCheckpoint, self._scope_id)
            if reference_hash(prior) != item.previous_sha256:
                raise StoredReferenceError("RECOVERY_PREDECESSOR_MISMATCH")
        if item.episode_id is not None:
            episode = self._episode(item.episode_id)
            if (episode.plan_id, episode.revision) != (item.plan_id, item.revision):
                raise StoredReferenceError("RECOVERY_EPISODE_MISMATCH")
            if item.layer_index is not None:
                layer = self._layer(item.episode_id, item.layer_index)
                if layer.trigger.received_at_ms > item.observed_at_ms:
                    raise StoredReferenceError("LAYER_TRIGGER_FROM_FUTURE")
        return item

    def save_recovery(self, value: RecoveryCheckpoint, *, now_ms: int) -> RecoveryCheckpoint:
        """Append offline history, never authorize recovery or clear account risk.

        UNKNOWN/PARTIAL, reason locks and unknown supplier liability are monotonic
        only within this (scope, plan, revision) chain. A new revision does not
        resolve obligations retained in old chains. Causal and linked trigger
        references must have been received by observed_at_ms; a later now cannot
        repair history. Reference consistency does not prove an actual trigger.
        """
        item = _valid(value, RecoveryCheckpoint)
        c._clock(now_ms)
        self._binding_check(item.binding)
        self._evidence(item.causal)
        if item.observed_at_ms > now_ms:
            raise ValueError("RECOVERY_FROM_FUTURE")
        with _immediate_transaction(self._c):
            self._scope()
            p = self._plan(item.plan_id, item.revision).bundle.plan
            if item.plan_sha256 != c.contract_hash(p):
                raise PersistenceConflict("RECOVERY_PLAN_MISMATCH")
            replay = self._row("astarter_recovery_checkpoints", "request_key=?",
                               (item.request_key,))
            if replay is not None:
                replayed = self._checkpoint(replay)
                if replayed != item:
                    raise PersistenceConflict("REQUEST_PAYLOAD_CONFLICT")
                return replayed
            row = self._row("astarter_recovery_checkpoints",
                            "plan_id=? AND revision=? ORDER BY seq DESC LIMIT 1",
                            (item.plan_id, item.revision))
            old = None if row is None else self._checkpoint(row)
            if (item.seq != (1 if old is None else old.seq + 1)
                    or item.previous_sha256 != (None if old is None else reference_hash(old))):
                raise PersistenceConflict("RECOVERY_CAS_CONFLICT")
            if old is not None:
                if item.observed_at_ms < old.observed_at_ms:
                    raise PersistenceConflict("RECOVERY_TIME_REGRESSION")
                if not set(old.reason_locks) <= set(item.reason_locks):
                    raise PersistenceConflict("D1_CANNOT_CLEAR_REASON_LOCKS")
                for name in ("order", "protection", "reconciliation"):
                    before = getattr(old.state, name)
                    if before in {"UNKNOWN", "PARTIAL"} and getattr(item.state, name) != before:
                        raise PersistenceConflict("D1_CANNOT_RECONCILE_UNKNOWN_OR_PARTIAL")
                if (old.budgets.supplier.liability == "UNKNOWN_PENDING_RECONCILE"
                        and item.budgets.supplier != old.budgets.supplier):
                    raise PersistenceConflict("D1_CANNOT_SETTLE_SUPPLIER_LIABILITY")
            _insert(self._c, "astarter_recovery_checkpoints", self._scope_id, item)
            # Validate every linked reference before committing the new checkpoint.
            saved = self._row("astarter_recovery_checkpoints", "request_key=?", (item.request_key,))
            assert saved is not None
            return self._checkpoint(saved)

    def read_recovery(self, plan_id: str, revision: str, *, seq: int | None = None,
                      approval_id: str | None = None, now_ms: int) -> RestoredRecovery:
        """Read reference-only history, not a D2 aggregate recovery gate.

        reason_locks remain on checkpoint; raw Q01 state_policy does not merge
        them. new_risk_blocked=False is not permission. Explicit seq selects
        history; checkpoint_current means latest seq in (scope, plan, revision)
        at this read snapshot, while plan.current means latest plan version.
        UNKNOWN/locks/unknown supplier monotonicity is revision-local: old chain
        obligations remain, and a new revision is no account-wide recovery verdict.
        Causal/trigger checks cover reference bytes, scope, time and rights, not
        proof that the subject actually triggered this strategy. Subject binding
        and trusted-source rules are prerequisites for later wiring, not supplied
        here. Even healthy-looking metadata/policies never grant execution,
        release risk or clear locks. TTL/rights are rechecked at explicit now_ms.
        """
        with self._read():
            latest = self._row("astarter_recovery_checkpoints",
                               "plan_id=? AND revision=? ORDER BY seq DESC LIMIT 1",
                               (plan_id, revision))
            if latest is None:
                raise LookupError("PRIVATE_RECOVERY_NOT_FOUND")
            row = latest if seq is None else self._row(
                "astarter_recovery_checkpoints", "plan_id=? AND revision=? AND seq=?",
                (plan_id, revision, seq),
            )
            if row is None:
                raise LookupError("PRIVATE_RECOVERY_NOT_FOUND")
            item = self._checkpoint(row)
            c._clock(now_ms)
            if item.observed_at_ms > now_ms:
                raise ValueError("RECOVERY_FROM_FUTURE")
            restored = self._restore(plan_id, revision, approval_id, now_ms)
            usable = c._usable(item.causal, self._binding, now_ms)
            if item.episode_id is not None and item.layer_index is not None:
                layer = self._layer(item.episode_id, item.layer_index)
                usable = usable and c._usable(layer.trigger, self._binding, now_ms)
            if not usable:
                restored = RestoredPlan(
                    restored.record, restored.approval,
                    c.Decision(status="BLOCKED", reasons=("CAUSAL_REFERENCE_UNUSABLE",)),
                    restored.current,
                )
            return RestoredRecovery(item, restored, c.state_policy(item.state),
                                    c.budget_policy(item.budgets),
                                    checkpoint_current=item.seq == latest["seq"])
