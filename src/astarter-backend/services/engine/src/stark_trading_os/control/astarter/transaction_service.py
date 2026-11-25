"""D2 controller trust boundary, not authentication or plan execution authority.

Only a backend may inject BackendControllerSource. Resolution happens once, outside
transactions. The finite runner supplies an explicitly synthetic implementation.
An OFFLINE_REFERENCE scope identifies ownership; it does not approve an entry.
Controller generations reuse the existing account fence and append-only audit
sequence. No second cash ledger, credentials or external callbacks are introduced.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import asdict, dataclass, replace
from hashlib import sha256
from typing import Protocol

from stark_trading_os.control.astarter import strategy_repository as references
from stark_trading_os.domain import strategy_contracts as contracts
from stark_trading_os.domain.astarter_simulation import (
    AstarterBlocked,
    AstarterConflict,
    AstarterIntegrityError,
    SimulationPolicy,
    digest,
    encode,
    policy_bytes,
)

LEASE_EVENT = "D2_CONTROLLER_LEASE"


@dataclass(frozen=True, slots=True)
class ControllerIdentity:
    assignment: references.ScopeAssignment
    owner_id: str
    fence: int


class BackendControllerSource(Protocol):
    def resolve_controller(self) -> ControllerIdentity:
        """Backend-owned local identity, never a request's tenant/fence claims."""
        ...


class ControllerAccess:
    def __init__(self, connection: sqlite3.Connection,
                 backend: BackendControllerSource | None) -> None:
        self.connection = connection
        self.identity: ControllerIdentity | None = None
        if backend is not None:
            identity = backend.resolve_controller()
            if (type(identity) is not ControllerIdentity
                    or type(identity.owner_id) is not str
                    or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identity.owner_id) is None
                    or type(identity.fence) is not int
                    or not 0 < identity.fence < 2**63):
                raise AstarterBlocked("ASTARTER_BACKEND_IDENTITY_INVALID")
            assignment = references._valid(identity.assignment, references.ScopeAssignment)
            if assignment.binding.environment != "OFFLINE":
                raise AstarterBlocked("ASTARTER_FINITE_OFFLINE_ONLY")
            self.identity = replace(identity, assignment=assignment)

    def required(self) -> ControllerIdentity:
        if self.identity is None:
            raise AstarterBlocked("ASTARTER_BACKEND_IDENTITY_REQUIRED")
        return self.identity

    def check_source(self, account_id: str, venue_session: str) -> None:
        identity = self.required()
        if (identity.assignment.binding.account_id != account_id
                or identity.assignment.venue_session != venue_session):
            raise AstarterIntegrityError("ASTARTER_ACCOUNT_SOURCE_CONFLICT")

    def scope(self, account_id: str) -> None:
        identity = self.required()
        assignment = identity.assignment
        if account_id != assignment.binding.account_id:
            raise AstarterBlocked("ASTARTER_SCOPE_DENIED")
        sid = contracts.contract_hash(assignment.binding)
        row = self.connection.execute(
            "SELECT * FROM astarter_strategy_scopes WHERE scope_id=? AND account_id=?",
            (sid, account_id),
        ).fetchone()
        if row is None or references._decode(row, references.ScopeAssignment, sid) != assignment:
            raise AstarterBlocked("ASTARTER_SCOPE_DENIED")

    def establish_new_account(self, account_id: str, venue_session: str) -> None:
        """Called only in the transaction which inserted a new native account."""
        self.check_source(account_id, venue_session)
        identity = self.required()
        if identity.fence != 1:
            raise AstarterConflict("ASTARTER_CONTROLLER_FENCED")
        assignment = identity.assignment
        references._insert(self.connection, "astarter_strategy_scopes",
                           contracts.contract_hash(assignment.binding), assignment)

    def lease_fact(self, *, fence: int | None = None) -> dict[str, str | int]:
        identity = self.required()
        return dict(owner_id=identity.owner_id, fence=identity.fence if fence is None else fence)

    def writer(self, account_id: str, fence: int) -> None:
        self.scope(account_id)
        identity = self.required()
        if fence != identity.fence:
            raise AstarterConflict("ASTARTER_CONTROLLER_FENCED")
        row = self.connection.execute(
            "SELECT fact_bytes,fact_sha256 FROM astarter_audit "
            "WHERE account_id=? AND kind=? ORDER BY seq DESC LIMIT 1",
            (account_id, LEASE_EVENT),
        ).fetchone()
        if row is None:
            # Existing unassigned/legacy accounts cannot be claimed on reopen.
            raise AstarterBlocked("ASTARTER_CONTROLLER_NOT_ESTABLISHED")
        raw = row["fact_bytes"]
        fact = json.loads(raw)
        if (sha256(raw).hexdigest() != row["fact_sha256"] or encode(fact) != raw
                or type(fact) is not dict or type(fact.get("fence")) is not int):
            raise AstarterIntegrityError("ASTARTER_CONTROLLER_HISTORY_INVALID")
        if fact != self.lease_fact():
            raise AstarterConflict("ASTARTER_CONTROLLER_FENCED")

    def advance_after_commit(self) -> None:
        identity = self.required()
        self.identity = replace(identity, fence=identity.fence + 1)


@dataclass(frozen=True, slots=True)
class AdmissionContext:
    """Backend wiring, not request data. Product Q01 has no execution adapter."""

    account_id: str
    venue_session: str
    authority_id: str
    purpose: str


@dataclass(frozen=True, slots=True)
class AdmissionUpdate:
    """Backend-owned local state publication; contains no cash or approved bool."""

    admission_id: str
    previous_generation: int
    episode_id: str
    approval_id: str
    dependency_sha256: str
    policy_sha256: str
    starts_at_ms: int
    expires_at_ms: int
    state: str


class BackendAdmissionSource(Protocol):
    def resolve_context(self) -> AdmissionContext:
        """Resolve backend purpose/authority outside any transaction."""
        ...

    def resolve_update(self) -> AdmissionUpdate:
        """Read controlled local dependency/revocation state, outside write lock."""
        ...


def admission_dependencies(bundle: contracts.PreflightInput) -> str:
    # Identity of the complete frozen reference tree, not an authorization hash.
    return contracts.contract_hash(bundle)


class AdmissionAccess:
    """SQL-local admission guard. No source callback is invoked while locked.

    PLAN_FINITE_ATOMICITY proves economic-intent atomicity only. The S03 reference
    schema is checked as a dependency; it is NOT translated into S03 signals/ABC.
    Q01_PRODUCT remains unsupported, including with a valid offline reference.
    """

    def __init__(self, connection: sqlite3.Connection,
                 backend: BackendAdmissionSource | None) -> None:
        self.connection = connection
        self.backend = backend
        self.context = None if backend is None else backend.resolve_context()
        ctx = self.context
        if ctx is not None and (
            type(ctx) is not AdmissionContext
            or any(type(v) is not str or not 1 <= len(v) <= 128
                   for v in (ctx.account_id, ctx.venue_session, ctx.authority_id))
            or ctx.purpose not in {"LEGACY_FINITE", "PLAN_FINITE_ATOMICITY", "Q01_PRODUCT"}
        ):
            raise AstarterBlocked("ASTARTER_ADMISSION_CONTEXT_INVALID")

    def required(self, identity: ControllerIdentity) -> AdmissionContext:
        ctx = self.context
        if ctx is None:
            raise AstarterBlocked("ASTARTER_ADMISSION_SOURCE_REQUIRED")
        if (ctx.account_id != identity.assignment.binding.account_id
                or ctx.venue_session != identity.assignment.venue_session):
            raise AstarterBlocked("ASTARTER_ADMISSION_SCOPE_DENIED")
        if ctx.purpose == "Q01_PRODUCT":
            raise AstarterBlocked("ASTARTER_Q01_PRODUCT_ADMISSION_UNIMPLEMENTED")
        return ctx

    def establish(self, identity: ControllerIdentity) -> None:
        ctx = self.required(identity)
        self.connection.execute(
            "INSERT INTO astarter_admission_heads "
            "(account_id,scope_id,purpose,authority_id) VALUES(?,?,?,?)",
            (ctx.account_id, contracts.contract_hash(identity.assignment.binding),
             ctx.purpose, ctx.authority_id),
        )

    def head(self, identity: ControllerIdentity) -> sqlite3.Row:
        ctx = self.required(identity)
        row = self.connection.execute(
            "SELECT * FROM astarter_admission_heads WHERE account_id=?", (ctx.account_id,),
        ).fetchone()
        if (row is None or row["scope_id"] != contracts.contract_hash(identity.assignment.binding)
                or row["purpose"] != ctx.purpose or row["authority_id"] != ctx.authority_id):
            raise AstarterBlocked("ASTARTER_ADMISSION_PURPOSE_OR_AUTHORITY_CONFLICT")
        return row  # type: ignore[no-any-return]

    def update_outside_transaction(self) -> AdmissionUpdate:
        if self.connection.in_transaction:
            raise RuntimeError("Admission callback inside transaction")
        if self.backend is None:
            raise AstarterBlocked("ASTARTER_ADMISSION_SOURCE_REQUIRED")
        value = self.backend.resolve_update()
        if (type(value) is not AdmissionUpdate
                or type(value.previous_generation) is not int
                or not 0 <= value.previous_generation < 2**63 - 1
                or any(type(v) is not int or not 0 <= v < 2**63
                       for v in (value.starts_at_ms, value.expires_at_ms))
                or value.starts_at_ms >= value.expires_at_ms
                or any(type(v) is not str or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", v) is None
                       for v in (value.admission_id, value.episode_id, value.approval_id))
                or any(type(v) is not str or re.fullmatch(r"[0-9a-f]{64}", v) is None
                       for v in (value.dependency_sha256, value.policy_sha256))
                or value.state not in {"READY", "REVOKED", "DEPENDENCY_CHANGED"}):
            raise AstarterBlocked("ASTARTER_ADMISSION_UPDATE_INVALID")
        return value

    def publish(self, identity: ControllerIdentity, value: AdmissionUpdate) -> str:
        head = self.head(identity)
        if head["purpose"] != "PLAN_FINITE_ATOMICITY":
            raise AstarterBlocked("ASTARTER_ADMISSION_PLAN_PURPOSE_REQUIRED")
        sid = head["scope_id"]
        prior = self.connection.execute(
            "SELECT * FROM astarter_admissions WHERE admission_id=?", (value.admission_id,),
        ).fetchone()
        if prior is not None:
            if (prior["account_id"] != head["account_id"]
                    or prior["update_sha256"] != digest(asdict(value))
                    or head["admission_id"] != value.admission_id):
                raise AstarterConflict("ASTARTER_ADMISSION_UPDATE_CONFLICT")
            return value.admission_id
        if head["generation"] != value.previous_generation:
            raise AstarterConflict("ASTARTER_ADMISSION_GENERATION_CONFLICT")
        ep = self.connection.execute(
            "SELECT * FROM astarter_episode_references WHERE scope_id=? AND episode_id=?",
            (sid, value.episode_id),
        ).fetchone()
        if ep is None:
            raise AstarterBlocked("ASTARTER_ADMISSION_EPISODE_REQUIRED")
        episode = references._decode(ep, references.EpisodeReference, sid)
        if episode.binding != identity.assignment.binding or episode.binding_id is None:
            raise AstarterBlocked("ASTARTER_ADMISSION_BINDING_REQUIRED")
        # FK/trigger checks additionally bind approval to this exact episode's plan.
        self.connection.execute(
            "INSERT INTO astarter_admissions "
            "(admission_id,account_id,scope_id,binding_id,episode_id,plan_id,revision,approval_id,"
            "generation,dependency_sha256,policy_sha256,starts_at_ms,expires_at_ms,state,"
            "update_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (value.admission_id, head["account_id"], sid, episode.binding_id, episode.episode_id,
             episode.plan_id, episode.revision, value.approval_id, value.previous_generation + 1,
             value.dependency_sha256, value.policy_sha256, value.starts_at_ms,
             value.expires_at_ms, value.state, digest(asdict(value))),
        )
        self.connection.execute(
            "UPDATE astarter_admission_heads SET admission_id=?,generation=? WHERE account_id=?",
            (value.admission_id, value.previous_generation + 1, head["account_id"]),
        )
        return value.admission_id

    def check(self, identity: ControllerIdentity, binding: sqlite3.Row,
              policy: SimulationPolicy, admission_id: str | None, *, now_ms: int) -> None:
        head = self.head(identity)
        if head["purpose"] == "LEGACY_FINITE":
            if admission_id is not None:
                raise AstarterBlocked("ASTARTER_LEGACY_NOT_PLAN_ADMISSION")
            return
        if type(admission_id) is not str or not admission_id:
            raise AstarterBlocked("ASTARTER_ADMISSION_REQUIRED")
        row = self.connection.execute(
            "SELECT * FROM astarter_admissions WHERE admission_id=? AND account_id=? "
            "AND binding_id=?", (admission_id, head["account_id"], binding["binding_id"]),
        ).fetchone()
        if (row is None or head["admission_id"] != admission_id
                or row["generation"] != head["generation"] or row["state"] != "READY"):
            raise AstarterBlocked("ASTARTER_ADMISSION_NOT_CURRENT_OR_REVOKED")
        if type(now_ms) is not int or not row["starts_at_ms"] <= now_ms < row["expires_at_ms"]:
            raise AstarterBlocked("ASTARTER_ADMISSION_WINDOW")
        sid = head["scope_id"]
        plan_row = self.connection.execute(
            "SELECT * FROM astarter_plan_versions WHERE scope_id=? AND plan_id=? "
            "ORDER BY ordinal DESC LIMIT 1", (sid, row["plan_id"]),
        ).fetchone()
        approval_row = self.connection.execute(
            "SELECT * FROM astarter_approval_references WHERE scope_id=? AND reference_id=?",
            (sid, row["approval_id"]),
        ).fetchone()
        if plan_row is None or approval_row is None or plan_row["revision"] != row["revision"]:
            raise AstarterBlocked("ASTARTER_ADMISSION_PLAN_SUPERSEDED")
        record = references._decode(plan_row, references.PlanRecord, sid)
        approval = references._decode(approval_row, references.ApprovalRecord, sid)
        p, a = record.bundle.plan, approval.approval
        if (p.binding != identity.assignment.binding or a.binding != p.binding
                or approval.plan_id != p.plan_id or a.plan_revision != p.revision):
            raise AstarterBlocked("ASTARTER_ADMISSION_PRIVATE_REFERENCE_MISMATCH")
        spec_row = self.connection.execute(
            "SELECT * FROM astarter_strategy_versions WHERE scope_id=? AND content_sha256=?",
            (sid, contracts.contract_hash(p.spec)),
        ).fetchone()
        ep_row = self.connection.execute(
            "SELECT * FROM astarter_episode_references WHERE scope_id=? AND episode_id=?",
            (sid, row["episode_id"]),
        ).fetchone()
        if spec_row is None or ep_row is None:
            raise AstarterBlocked("ASTARTER_ADMISSION_HISTORY_REQUIRED")
        spec = references._decode(spec_row, contracts.StrategySpec, sid)
        ep = references._decode(ep_row, references.EpisodeReference, sid)
        if (spec != p.spec or ep.binding != p.binding or ep.binding_id != binding["binding_id"]
                or ep.plan_id != p.plan_id or ep.revision != p.revision
                or ep.plan_sha256 != contracts.contract_hash(p)):
            raise AstarterIntegrityError("ASTARTER_ADMISSION_REFERENCE_CONFLICT")
        bundle = contracts.PreflightInput(plan=p, evidence=record.bundle.evidence, approval=a)
        if (admission_dependencies(bundle) != row["dependency_sha256"]
                or binding["policy_sha256"] != row["policy_sha256"]
                or contracts.preflight(bundle, now_ms=now_ms).status != "ELIGIBLE"):
            raise AstarterBlocked("ASTARTER_ADMISSION_DEPENDENCIES_INVALID")
        # This is a deliberately closed economic fixture mapping, NOT an adapter
        # for the S03 signal lifecycle. Q06 must prove that separately.
        i = p.instrument
        if (p.spec.identity.kind != "S03_ORIGINAL" or i is None
                or (i.native_id, i.venue, i.base, i.quote, i.product, i.fee_currency,
                    i.tick, i.step, i.min_quantity, i.min_notional, i.multiplier,
                    i.maker_fee, i.taker_fee) !=
                   ("BTC/USDT.SIM", "SIM", "BTC", "USDT", "SPOT", "USDT", "0.01",
                    "0.00001", "0.00001", "5", "1", "0.001", "0.001")
                or policy_bytes(policy) != policy_bytes(SimulationPolicy())):
            raise AstarterBlocked("ASTARTER_ADMISSION_NATIVE_MAPPING_UNSUPPORTED")

    def link(self, intent_id: str, binding: sqlite3.Row, admission_id: str | None) -> None:
        if admission_id is not None:
            self.connection.execute(
                "INSERT INTO astarter_intent_admissions VALUES(?,?,?,?)",
                (intent_id, binding["account_id"], binding["binding_id"], admission_id),
            )

    def intent_admission(self, intent_id: str) -> str | None:
        row = self.connection.execute(
            "SELECT admission_id FROM astarter_intent_admissions WHERE intent_id=?", (intent_id,),
        ).fetchone()
        return None if row is None else str(row[0])
