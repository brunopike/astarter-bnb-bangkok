"""Q08 local research persistence; trusted server callers, no provider or trade IO.

The database login is a backend capability, not RLS. Model assertions are never
invoices. A one-shot DB send admission is not external exactly-once delivery.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
from typing import Annotated, Any, Literal
from uuid import uuid4

from psycopg import Connection, sql
from pydantic import BaseModel, Field, StrictInt, StrictStr, TypeAdapter

from stark_trading_os.control.astarter import strategy_repository as r
from stark_trading_os.domain import research_jobs as j
from stark_trading_os.domain import strategy_contracts as c
from stark_trading_os.integrations.contracts import Identifier, Timestamp
from stark_trading_os.integrations.research_delivery import (
    ResearchArtifact,
    check_artifact,
    make_artifact,
    semantic_key,
)
from stark_trading_os.integrations.research_egress import (
    ChargeObservation,
    Digest,
    EgressGrant,
    PreparedResearchRequest,
    Reason,
    ResearchIdentity,
    ResearchRejected,
    canonical,
    check_grant,
    check_request,
    check_structure,
    encode,
    request_deadline,
    request_digest,
)
from stark_trading_os.integrations.research_gate import (
    GATE_TYPES,
    BudgetReceipt,
    DispatchPermit,
    ExecutionObservation,
    OutcomeObservation,
    ResearchClaim,
)

from .access import RepositoryAccessContract
from .caller import owned_thread
from .identity import Principal
from .pool import PgRepositoryPool
from .synthetic_migration import TargetProfile

Conn = Connection[dict[str, Any]]
Row = dict[str, Any]
_IDENTIFIER = TypeAdapter(Identifier)
_REASON: TypeAdapter[Reason] = TypeAdapter(Reason)
_TABLES = frozenset(
    {
        "research_jobs",
        "research_role_attempts",
        "research_artifacts",
        "research_consumers",
        "research_budget_scopes",
        "research_reservations",
        "research_events_outbox",
    }
)
_BUDGET_REVISION = "Q08_SIM_BUDGET_V1"
_LEASE_MS = 30000


class JobRef(c.Offline):
    scope_key: Digest
    job_id: Identifier
    manifest_sha256: Digest


class AttemptClaim(c.Offline):
    ref: JobRef
    worker_id: Identifier
    owner_epoch: Annotated[StrictInt, Field(ge=1)]
    claim_id: Identifier = Field(repr=False)
    version: Annotated[StrictInt, Field(ge=0)]
    ready: j.ReadyRoleV1


class RoleState(c.Offline):
    role_id: Identifier
    state: Identifier
    owner_epoch: Annotated[StrictInt, Field(ge=0)]


class JobView(c.Offline):
    ref: JobRef
    manifest: j.JobManifestV1
    state: Identifier
    version: Annotated[StrictInt, Field(ge=0)]
    current_data: bool
    roles: tuple[RoleState, ...]
    reports: tuple[j.RoleReportV1, ...]
    costs: tuple[BudgetReceipt, ...]


class ResearchEvent(c.Offline):
    event_id: Identifier
    kind: Literal["QUESTION", "ANSWER", "NOTICE"]
    text: Annotated[StrictStr, Field(min_length=1, max_length=2000)] = Field(repr=False)
    cause_event_id: Identifier | None = None


class ResearchQuestion(c.Offline):
    question_id: Identifier
    kind: Literal["DATA", "BUDGET", "REVIEW"]
    nonce: Identifier = Field(repr=False)
    expected_version: Annotated[StrictInt, Field(ge=0)]
    not_before_ms: Timestamp
    deadline_ms: Timestamp
    public_source: JobRef | None = None


class ResearchAnswer(c.Offline):
    question_id: Identifier
    nonce: Identifier = Field(repr=False)
    choice: Literal["RESUME", "CANCEL"]
    expected_version: Annotated[StrictInt, Field(ge=0)]


class WorkflowView(c.Offline):
    job: JobView
    public_facts: tuple[j.PublicFactReferenceV1, ...] = ()
    question: ResearchQuestion | None = None
    question_state: Literal["OPEN", "ANSWERED", "EXPIRED", "CLOSED"] | None = None
    answer: Literal["RESUME", "CANCEL"] | None = None
    bundle: j.ResearchBundleV1 | None = None
    decision: j.ResearchDecision | None = None


_TYPES: tuple[type[BaseModel], ...] = (
    *j._TYPES,
    *GATE_TYPES,
    JobRef,
    AttemptClaim,
    RoleState,
    JobView,
    ResearchEvent,
    ResearchQuestion,
    ResearchAnswer,
    WorkflowView,
)


@dataclass(frozen=True)
class SyntheticAuthority:
    """Server fixture configuration only; never deserialize from requests/models."""

    policy: j.PolicySnapshotV1
    owner_cap: int = 100000
    day_cap: int = 100000
    platform_cap: int = 100000
    workers: tuple[str, ...] = ("worker-1", "worker-2")
    invoices: tuple[ChargeObservation, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "policy", j._valid(self.policy, j.PolicySnapshotV1))
        if (
            any(
                type(x) is not int or not 0 <= x < 2**127
                for x in (self.owner_cap, self.day_cap, self.platform_cap)
            )
            or type(self.workers) is not tuple
            or not 1 <= len(self.workers) <= 2
            or len(set(self.workers)) != len(self.workers)
            or type(self.invoices) is not tuple
        ):
            raise ValueError("Q08_AUTHORITY_CONFIGURATION")
        for worker in self.workers:
            _id(worker)
        invoices = tuple(canonical(x, ChargeObservation) for x in self.invoices)
        if len({x.event_id for x in invoices}) != len(invoices):
            raise ValueError("Q08_INVOICE_CONFLICT")
        object.__setattr__(self, "invoices", invoices)


def _id(value: object) -> str:
    try:
        return _IDENTIFIER.validate_python(value, strict=True)
    except Exception:
        raise ResearchRejected("INVALID_INPUT") from None


def _raw(value: BaseModel) -> bytes:
    return encode(value.model_dump(mode="json")).encode()


def _digest(value: object) -> str:
    return sha256(encode(value).encode()).hexdigest()


def _key(prefix: str, *parts: object) -> str:
    return prefix + "-" + _digest(parts)


def _tree(value: Any) -> Any:
    if type(value) is list:
        return tuple(_tree(x) for x in value)
    if type(value) is dict:
        return {k: _tree(v) for k, v in value.items()}
    return value


def _decode[T: BaseModel](raw: bytes, digest: str, cls: type[T]) -> T:
    result = None
    try:
        if type(raw) is bytes and 0 < len(raw) <= 2097152 and sha256(raw).hexdigest() == digest:
            candidate = cls.model_validate(_tree(json.loads(raw)), strict=True)
            result = canonical(candidate, cls, extra=_TYPES)
            if _raw(result) != raw:
                result = None
    except Exception:
        pass
    if result is None:
        raise ResearchRejected("BINDING_MISMATCH")
    return result


def _fact(row: Row) -> dict[str, Any]:
    raw = row["fact_bytes"]
    result = None
    try:
        if (
            type(raw) is bytes
            and len(raw) <= 2097152
            and sha256(raw).hexdigest() == row["fact_sha256"]
        ):
            value = json.loads(raw)
            if type(value) is dict and encode(value).encode() == raw:
                result = value
    except Exception:
        pass
    if result is None:
        raise ResearchRejected("BINDING_MISMATCH")
    return result


def _embedded[T: BaseModel](value: object, cls: type[T]) -> T:
    try:
        return canonical(cls.model_validate(_tree(value), strict=True), cls, extra=_TYPES)
    except Exception:
        raise ResearchRejected("BINDING_MISMATCH") from None


def _now_ms(conn: Conn) -> int:
    row = conn.execute(
        "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now"
    ).fetchone()
    if row is None:
        raise ResearchRejected("CLOCK_INVALID")
    return int(row["now"])


def _snapshot_deadline(m: j.JobManifestV1, role: str | None = None) -> int:
    models = (
        m.policy.models if role is None else tuple(x for x in m.policy.models if x.role_id == role)
    )
    if role is not None and len(models) != 1:
        raise ResearchRejected("BINDING_MISMATCH")
    ends = [m.policy.deadline_ms, m.policy.quote.valid_until_ms]
    ends.extend(min(x.quote.valid_until_ms, x.policy.valid_until_ms) for x in models)
    ends.extend(
        min(
            x.source.expires_at_ms,
            x.source.rights_until_ms,
            x.source.window_end_ms + x.source.max_age_ms + 1,
        )
        for x in m.trigger.evidence
    )
    if m.trigger.plan is not None:
        ends.append(m.trigger.plan.expires_at_ms)
    return min(ends)


def _insert(conn: Conn, table: str, values: Row) -> None:
    if table not in _TABLES:
        raise ValueError("Q08_TABLE")
    conn.execute(
        sql.SQL("INSERT INTO q08_research.{} ({}) VALUES ({})").format(
            sql.Identifier(table),
            sql.SQL(",").join(map(sql.Identifier, values)),
            sql.SQL(",").join(sql.Placeholder() for _ in values),
        ),
        tuple(values.values()),
    )


def _update(conn: Conn, table: str, row: Row, keys: tuple[str, ...], values: Row, now: int) -> Row:
    if table not in _TABLES:
        raise ValueError("Q08_TABLE")
    assignments = sql.SQL(",").join(sql.SQL("{}=%s").format(sql.Identifier(k)) for k in values)
    where = sql.SQL(" AND ").join(sql.SQL("{}=%s").format(sql.Identifier(k)) for k in keys)
    result = conn.execute(
        sql.SQL(
            "UPDATE q08_research.{} SET {},version=version+1,updated_at_ms=%s "
            "WHERE {} AND version=%s RETURNING *"
        ).format(sql.Identifier(table), assignments, where),
        (*values.values(), now, *(row[k] for k in keys), row["version"]),
    ).fetchone()
    if result is None:
        raise r.PersistenceConflict("Q08_CAS_CONFLICT")
    return result


class PostgresResearchRepository:
    """One immutable Principal/config, bounded transactions; no model execution."""

    _pool: PgRepositoryPool
    _principal: Principal
    _authority: SyntheticAuthority
    _public: bool
    _scope_key: str

    def __init__(
        self, pool: PgRepositoryPool, principal: Principal, authority: SyntheticAuthority
    ) -> None:
        if (
            type(pool) is not PgRepositoryPool
            or type(principal) is not Principal
            or type(authority) is not SyntheticAuthority
            or pool.access_contract is not RepositoryAccessContract.Q08_RESEARCH_STUB_V1
            or pool.profile is not TargetProfile.LOCAL_PG17
            or type(principal.role) is not str
            or principal.role not in {"reader", "writer"}
        ):
            raise ValueError("Q08_REPOSITORY_CONFIGURATION")
        _id(principal.subject)
        assignment = r._valid(principal.scope, r.ScopeAssignment)
        if assignment.binding.environment != "OFFLINE":
            raise ResearchRejected("DENIED")
        self._pool = pool
        self._principal = Principal(principal.subject, assignment, principal.role)
        self._authority = authority
        binding = assignment.binding
        self._public = (principal.subject, binding.tenant_id, binding.account_id) == (
            "platform-public-research",
            "platform",
            "public-research",
        )
        visibility = (
            {"visibility": "PUBLIC"}
            if self._public
            else dict(
                visibility="PRIVATE",
                tenant_id=binding.tenant_id,
                principal_scope_id=principal.subject,
                account_scope_id=binding.account_id,
            )
        )
        self._scope_key = _digest(visibility)

    @contextmanager
    def _transaction(self, write: bool) -> Iterator[tuple[Conn, int]]:
        if write and (self._principal.role != "writer" or not self._pool.writable):
            raise ResearchRejected("DENIED")
        # shortcut: one short mutation mutex; benchmark before scaling.
        with self._pool.transaction(write=write, scope_id="Q08_RESEARCH_MUTATION_V1") as conn:
            if not self._public:
                sid = c.contract_hash(self._principal.scope.binding)
                if write:
                    lock = int.from_bytes(sha256(sid.encode()).digest()[:8], signed=True)
                    conn.execute("SELECT pg_advisory_xact_lock(%s)", (lock,))
                row = conn.execute(
                    "SELECT * FROM pg1_control.astarter_strategy_scopes WHERE scope_id=%s", (sid,)
                ).fetchone()
                if row is None or r._decode(row, r.ScopeAssignment, sid) != self._principal.scope:
                    raise ResearchRejected("DENIED")
            yield conn, _now_ms(conn)

    async def _call[T](self, write: bool, operation: Callable[[Conn, int], T]) -> T:
        if write and (self._principal.role != "writer" or not self._pool.writable):
            raise ResearchRejected("DENIED")

        def run() -> T:
            with self._transaction(write) as (conn, now):
                return operation(conn, now)

        return await owned_thread(run)

    def _job(self, conn: Conn, job_id: str) -> tuple[Row, j.JobManifestV1]:
        _id(job_id)
        row = conn.execute(
            "SELECT * FROM q08_research.research_jobs WHERE scope_key=%s AND job_id=%s",
            (self._scope_key, job_id),
        ).fetchone()
        if row is None or row["principal_id"] != self._principal.subject:
            raise ResearchRejected("DENIED")
        m = j._check_manifest(
            _decode(row["manifest_bytes"], row["content_sha256"], j.JobManifestV1)
        )
        if (
            row["manifest_sha256"] != m.manifest_sha256
            or row["scope_key"] != _digest(m.visibility.model_dump(mode="json"))
            or m.principal_id != self._principal.subject
        ):
            raise ResearchRejected("BINDING_MISMATCH")
        return row, m

    def _current(
        self, conn: Conn, row: Row, m: j.JobManifestV1, now: int, *, dispatch: bool = True
    ) -> None:
        if now < row["updated_at_ms"]:
            raise ResearchRejected("CLOCK_INVALID")
        if row["state"] in {"CANCELLED", "FAILED_REFERENCE"}:
            raise ResearchRejected("DENIED")
        if dispatch and row["state"] == "UNKNOWN":
            raise ResearchRejected("UNKNOWN_CHARGE")
        if dispatch and row["state"] == "WAIT_REVIEW":
            raise ResearchRejected("DENIED")
        if m.policy != self._authority.policy:
            raise ResearchRejected("BINDING_MISMATCH")
        end = (
            min(m.policy.deadline_ms, m.policy.quote.valid_until_ms)
            if dispatch
            else m.policy.deadline_ms
        )
        if now >= end or not j._usable(m, now):
            raise ResearchRejected("EXPIRED")
        public = self._public_facts(conn, row)
        if public:
            for fact in public:
                source_manifest = fact.manifest
                if not j._usable(
                    source_manifest, now
                ) or not source_manifest.policy.now_ms <= now < min(
                    source_manifest.policy.deadline_ms,
                    source_manifest.policy.quote.valid_until_ms,
                    fact.report.artifact.use_until_ms,
                ):
                    raise ResearchRejected("EXPIRED")
                self._public_result(
                    conn,
                    JobRef(
                        scope_key=_digest({"visibility": "PUBLIC"}),
                        job_id=fact.manifest.trigger.job_id,
                        manifest_sha256=fact.manifest.manifest_sha256,
                    ),
                    fact.report.artifact.artifact_id,
                    active=True,
                    now=now,
                )
            j._references(m, self._reports(conn, row), now, public)
        if m.trigger.plan is not None:
            p = m.trigger.plan
            saved = conn.execute(
                "SELECT * FROM pg1_control.astarter_plan_versions WHERE scope_id=%s "
                "AND plan_id=%s ORDER BY ordinal DESC LIMIT 1",
                (row["source_scope_id"], p.plan_id),
            ).fetchone()
            if (
                saved is None
                or r._decode(saved, r.PlanRecord, row["source_scope_id"]).bundle.plan != p
            ):
                raise ResearchRejected("DENIED")

    def _event(
        self,
        conn: Conn,
        job: Row,
        kind: str,
        event_id: str,
        fact: dict[str, Any],
        now: int,
        cause: str | None = None,
    ) -> str:
        raw = encode(fact).encode()
        digest = sha256(raw).hexdigest()
        old = conn.execute(
            "SELECT * FROM q08_research.research_events_outbox WHERE scope_key=%s "
            "AND job_id=%s AND event_id=%s",
            (job["scope_key"], job["job_id"], event_id),
        ).fetchone()
        if old is not None:
            if old["fact_bytes"] != raw or old["kind"] != kind or old["cause_event_id"] != cause:
                raise r.PersistenceConflict("Q08_EVENT_CONFLICT")
            return event_id
        latest = conn.execute(
            "SELECT coalesce(max(seq),0)+1 AS seq FROM q08_research.research_events_outbox "
            "WHERE scope_key=%s AND job_id=%s",
            (job["scope_key"], job["job_id"]),
        ).fetchone()
        if latest is None:
            raise ResearchRejected("UNAVAILABLE")
        seq = latest["seq"]
        if seq > 4096:
            raise ResearchRejected("UNAVAILABLE")
        _insert(
            conn,
            "research_events_outbox",
            dict(
                scope_key=job["scope_key"],
                job_id=job["job_id"],
                seq=seq,
                event_id=event_id,
                kind=kind,
                cause_event_id=cause,
                fact_bytes=raw,
                fact_sha256=digest,
                created_at_ms=now,
                not_before_ms=now,
                updated_at_ms=now,
            ),
        )
        return event_id

    def _reports(self, conn: Conn, job: Row) -> tuple[j.RoleReportV1, ...]:
        rows = conn.execute(
            "SELECT * FROM q08_research.research_events_outbox WHERE scope_key=%s "
            "AND job_id=%s AND kind='ARTIFACT_PUBLISHED' ORDER BY seq LIMIT 19",
            (job["scope_key"], job["job_id"]),
        ).fetchall()
        result = []
        for row in rows:
            fact = _fact(row)
            if set(fact) != {"type", "report", "producer"} or fact["type"] != "PUBLISHED":
                raise ResearchRejected("BINDING_MISMATCH")
            report = _embedded(fact["report"], j.RoleReportV1)
            producer = fact["producer"]
            if type(producer) is not dict or set(producer) != {
                "scope_key",
                "job_id",
                "artifact_id",
            }:
                raise ResearchRejected("BINDING_MISMATCH")
            stored = conn.execute(
                "SELECT * FROM q08_research.research_artifacts WHERE scope_key=%s "
                "AND job_id=%s AND artifact_id=%s",
                tuple(producer[k] for k in ("scope_key", "job_id", "artifact_id")),
            ).fetchone()
            if (
                stored is None
                or stored["content_bytes"] != _raw(report.artifact)
                or stored["reuse_key"] != report.reuse_key
                or report.manifest_sha256 != job["manifest_sha256"]
                or (stored["visibility"] == "PRIVATE" and stored["scope_key"] != job["scope_key"])
            ):
                raise ResearchRejected("BINDING_MISMATCH")
            _decode(stored["content_bytes"], stored["content_sha256"], ResearchArtifact)
            result.append(report)
        if len(result) > 18:
            raise ResearchRejected("BINDING_MISMATCH")
        return tuple(result)

    def _attempts(self, conn: Conn, job: Row) -> list[Row]:
        return conn.execute(
            "SELECT * FROM q08_research.research_role_attempts WHERE scope_key=%s "
            "AND job_id=%s ORDER BY role_id",
            (job["scope_key"], job["job_id"]),
        ).fetchall()

    def _view(self, conn: Conn, job: Row, m: j.JobManifestV1, now: int) -> JobView:
        attempts = self._attempts(conn, job)
        costs = []
        for row in attempts:
            receipt, _ = self._receipt(conn, job, self._prepared(conn, job, m, row).request)
            if receipt is not None:
                costs.append(receipt)
        current = True
        try:
            self._current(conn, job, m, now, dispatch=False)
        except ResearchRejected:
            current = False
        return JobView(
            ref=JobRef(
                scope_key=job["scope_key"], job_id=job["job_id"], manifest_sha256=m.manifest_sha256
            ),
            manifest=m,
            state=job["state"],
            version=job["version"],
            current_data=current,
            roles=tuple(
                RoleState(role_id=x["role_id"], state=x["state"], owner_epoch=x["owner_epoch"])
                for x in attempts
            ),
            reports=self._reports(conn, job),
            costs=tuple(costs),
        )

    async def submit_job(self, manifest: j.JobManifestV1) -> JobRef:
        m = j._check_manifest(manifest)
        if j.compile_manifest(self._principal, m.trigger, self._authority.policy) != m:
            raise ResearchRejected("BINDING_MISMATCH")

        def operation(conn: Conn, now: int) -> JobRef:
            old = conn.execute(
                "SELECT * FROM q08_research.research_jobs WHERE scope_key=%s AND "
                "(job_id=%s OR logical_request_id=%s)",
                (self._scope_key, m.trigger.job_id, m.trigger.logical_request_id),
            ).fetchone()
            if old is not None:
                if old["manifest_bytes"] != _raw(m):
                    raise r.PersistenceConflict("Q08_REQUEST_CONFLICT")
                return JobRef(
                    scope_key=self._scope_key,
                    job_id=m.trigger.job_id,
                    manifest_sha256=m.manifest_sha256,
                )
            binding = self._principal.scope.binding
            p = m.trigger.plan
            raw = _raw(m)
            values = dict(
                scope_key=self._scope_key,
                job_id=m.trigger.job_id,
                visibility=m.visibility.visibility,
                tenant_id=binding.tenant_id,
                principal_id=m.principal_id,
                account_id=binding.account_id,
                source_scope_id=None if p is None else c.contract_hash(binding),
                plan_id=None if p is None else p.plan_id,
                plan_revision=None if p is None else p.revision,
                plan_sha256=None if p is None else m.subject_sha256,
                subject_sha256=m.subject_sha256,
                logical_request_id=m.trigger.logical_request_id,
                event_id=m.trigger.event_id,
                research_kind=m.trigger.kind,
                mode=m.trigger.mode,
                policy_revision=m.policy.revision,
                manifest_sha256=m.manifest_sha256,
                manifest_bytes=raw,
                content_sha256=sha256(raw).hexdigest(),
                created_at_ms=now,
                updated_at_ms=now,
                deadline_ms=m.policy.deadline_ms,
            )
            if not m.policy.now_ms <= now < m.policy.deadline_ms:
                raise ResearchRejected("EXPIRED")
            ready = j.plan_ready_roles(m, (), now_ms=now)
            values["state"] = self._state(ready.status)
            _insert(conn, "research_jobs", values)
            self._event(
                conn,
                values,
                "TRIGGER",
                m.trigger.event_id,
                dict(type="TRIGGER", manifest_sha256=m.manifest_sha256),
                now,
            )
            return JobRef(
                scope_key=self._scope_key,
                job_id=m.trigger.job_id,
                manifest_sha256=m.manifest_sha256,
            )

        return await self._call(True, operation)

    @staticmethod
    def _state(status: str) -> str:
        return {
            "RUNNABLE": "RUNNABLE",
            "WAIT_BUDGET": "WAIT_BUDGET",
            "WAIT_DATA": "WAIT_DATA",
            "BLOCKED": "FAILED_REFERENCE",
            "COMPLETE": "COMPLETED_REFERENCE",
            "FAST_PATH": "COMPLETED_REFERENCE",
        }[status]

    async def read_job(self, job_id: str) -> JobView:
        def operation(conn: Conn, now: int) -> JobView:
            row, m = self._job(conn, job_id)
            return self._view(conn, row, m, now)

        return await self._call(False, operation)

    async def append_event(self, job_id: str, event: ResearchEvent) -> str:
        item = canonical(event, ResearchEvent, extra=_TYPES)

        def operation(conn: Conn, now: int) -> str:
            row, m = self._job(conn, job_id)
            return self._event(
                conn,
                row,
                item.kind,
                item.event_id,
                dict(type="COMMENT", event=item.model_dump(mode="json")),
                now,
                item.cause_event_id,
            )

        return await self._call(True, operation)

    @staticmethod
    def _request(row: Row) -> PreparedResearchRequest:
        req = check_structure(
            _decode(row["request_bytes"], row["content_sha256"], PreparedResearchRequest)
        )
        if (
            request_digest(req) != row["request_sha256"]
            or req.payload_sha256 != row["payload_sha256"]
            or req.spec.identity.attempt_id != row["attempt_id"]
            or req.spec.task.role_id != row["role_id"]
            or row["model_id"] != req.spec.policy.model
            or row["profile_revision"] != req.spec.task.profile_version
            or row["policy_revision"] != req.spec.policy.revision
            or row["key_owner_id"] != req.spec.identity.key_owner_id
            or row["credential_revision"] != req.spec.identity.credential_binding_revision
            or row["funding"] != req.spec.context.funding
            or row["visibility"] != req.spec.context.classification
        ):
            raise ResearchRejected("BINDING_MISMATCH")
        return req

    def _prepared(self, conn: Conn, job: Row, m: j.JobManifestV1, row: Row) -> j.ReadyRoleV1:
        req = self._request(row)
        nodes = [n for n in m.nodes if n.role_id == row["role_id"]]
        if len(nodes) != 1 or row["manifest_sha256"] != m.manifest_sha256:
            raise ResearchRejected("BINDING_MISMATCH")
        refs = {x.report.role_id: x.report for x in self._public_facts(conn, job)}
        refs.update({x.role_id: x for x in self._reports(conn, job)})
        ready = j._prepare(m, nodes[0], refs)
        model = next(x for x in m.policy.models if x.role_id == ready.role_id)
        if ready.request != req or model.effort != row["effort"]:
            raise ResearchRejected("BINDING_MISMATCH")
        return ready

    def _receipt(
        self, conn: Conn, job: Row, req: PreparedResearchRequest
    ) -> tuple[BudgetReceipt | None, dict[str, Any] | None]:
        rows = conn.execute(
            "SELECT * FROM q08_research.research_events_outbox WHERE scope_key=%s AND job_id=%s "
            "AND kind='ROLE_RESULT' ORDER BY seq DESC LIMIT 4096",
            (job["scope_key"], job["job_id"]),
        ).fetchall()
        for row in rows:
            fact = _fact(row)
            if fact.get("type") != "BUDGET":
                continue
            receipt = _embedded(fact.get("receipt"), BudgetReceipt)
            if receipt.identity.attempt_id != req.spec.identity.attempt_id:
                continue
            if (
                receipt.identity != req.spec.identity
                or receipt.request_sha256 != request_digest(req)
                or receipt.reserve_atoms != req.spec.quote.reserve_atoms
            ):
                raise ResearchRejected("BINDING_MISMATCH")
            group = conn.execute(
                "SELECT * FROM q08_research.research_reservations WHERE reservation_id=%s",
                (receipt.reservation_id,),
            ).fetchall()
            if receipt.reservation_id != _key(
                "reservation", job["scope_key"], job["job_id"], req.spec.identity.attempt_id
            ):
                raise ResearchRejected("BINDING_MISMATCH")
            if len(group) != 5 or any(
                x["state"] != receipt.state
                or x["version"] != receipt.version
                or int(x["atoms"]) != receipt.reserve_atoms
                or x["scope_key"] != job["scope_key"]
                or x["job_id"] != job["job_id"]
                or x["attempt_id"] != req.spec.identity.attempt_id
                or x["created_at_ms"] != group[0]["created_at_ms"]
                or x["quote_sha256"] != _digest(req.spec.quote.model_dump(mode="json"))
                or x["request_sha256"] != receipt.request_sha256
                for x in group
            ):
                raise ResearchRejected("BINDING_MISMATCH")
            expected = {
                d["budget_scope_id"] for d in self._scope_defs(job, req, group[0]["created_at_ms"])
            }
            if {x["budget_scope_id"] for x in group} != expected:
                raise ResearchRejected("BINDING_MISMATCH")
            return receipt, fact
        if conn.execute(
            "SELECT 1 FROM q08_research.research_reservations WHERE scope_key=%s AND "
            "job_id=%s AND attempt_id=%s LIMIT 1",
            (job["scope_key"], job["job_id"], req.spec.identity.attempt_id),
        ).fetchone():
            raise ResearchRejected("BINDING_MISMATCH")
        return None, None

    def _worker(self, worker: str) -> None:
        if _id(worker) not in self._authority.workers:
            raise ResearchRejected("DENIED")

    @staticmethod
    def _attempt(conn: Conn, job: Row, attempt_id: str) -> Row | None:
        return conn.execute(
            "SELECT * FROM q08_research.research_role_attempts WHERE scope_key=%s "
            "AND job_id=%s AND attempt_id=%s",
            (job["scope_key"], job["job_id"], attempt_id),
        ).fetchone()

    def _cached(self, conn: Conn, job: Row, ready: j.ReadyRoleV1, now: int) -> Row | None:
        candidates = conn.execute(
            "SELECT * FROM q08_research.research_artifacts WHERE reuse_key=%s "
            "AND use_until_ms>%s ORDER BY created_at_ms DESC LIMIT 20",
            (ready.reuse_key, now),
        ).fetchall()
        req = ready.request
        for row in candidates:
            if row["visibility"] == "PRIVATE" and row["scope_key"] != job["scope_key"]:
                continue
            if (row["key_owner_id"], row["credential_revision"], row["funding"]) != (
                req.spec.identity.key_owner_id,
                req.spec.identity.credential_binding_revision,
                req.spec.context.funding,
            ):
                continue
            artifact = _decode(row["content_bytes"], row["content_sha256"], ResearchArtifact)
            check_artifact(req, artifact, now_ms=now, clock_epoch=req.spec.clock_epoch)
            return row
        return None

    def _liability_state(self, conn: Conn, job: Row, otherwise: str) -> str:
        if job["state"] in {"CANCELLED", "FAILED_REFERENCE"}:
            return str(job["state"])
        if any(row["state"] == "UNKNOWN_PENDING_RECONCILE" for row in self._attempts(conn, job)):
            return "UNKNOWN"
        return otherwise

    def _after_result(self, conn: Conn, job: Row, m: j.JobManifestV1, now: int) -> Row:
        ready = j.plan_ready_roles(
            m, self._reports(conn, job), now_ms=now, public_facts=self._public_facts(conn, job)
        )
        state = self._state(ready.status)
        if ready.status == "COMPLETE" and m.trigger.kind != "FACTS":
            state = "WAIT_REVIEW"
        if job["state"] == "WAIT_REVIEW":
            state = "WAIT_REVIEW"
        question, answer = self._question(conn, job)
        if question is not None and answer is None:
            state = "WAIT_" + question.kind
        if job["state"] == "WAIT_BUDGET" and not (
            question is not None and question.kind == "BUDGET" and answer is not None
        ):
            state = "WAIT_BUDGET"
        state = self._liability_state(conn, job, state)
        return _update(conn, "research_jobs", job, ("scope_key", "job_id"), dict(state=state), now)

    def _cached_use(
        self,
        conn: Conn,
        job: Row,
        m: j.JobManifestV1,
        ready: j.ReadyRoleV1,
        producer: Row,
        now: int,
    ) -> Row:
        artifact = _decode(producer["content_bytes"], producer["content_sha256"], ResearchArtifact)
        check_artifact(ready.request, artifact, now_ms=now, clock_epoch=m.policy.clock_epoch)
        if ready.role_id in {x.role_id for x in self._reports(conn, job)}:
            return job
        req = ready.request
        consumer = dict(
            scope_key=job["scope_key"],
            job_id=job["job_id"],
            consumer_id=_key(
                "use",
                job["job_id"],
                producer["scope_key"],
                producer["job_id"],
                artifact.artifact_id,
            ),
            principal_id=job["principal_id"],
            key_owner_id=req.spec.identity.key_owner_id,
            credential_revision=req.spec.identity.credential_binding_revision,
            producer_scope_key=producer["scope_key"],
            producer_job_id=producer["job_id"],
            artifact_id=artifact.artifact_id,
            producer_visibility=producer["visibility"],
            producer_principal_id=producer["principal_id"],
            producer_key_owner_id=producer["key_owner_id"],
            producer_credential_revision=producer["credential_revision"],
            created_at_ms=now,
            use_until_ms=min(artifact.use_until_ms, m.policy.deadline_ms),
        )
        _insert(conn, "research_consumers", consumer)
        report = j.RoleReportV1(
            manifest_sha256=m.manifest_sha256,
            role_id=ready.role_id,
            request_sha256=request_digest(req),
            reuse_key=ready.reuse_key,
            artifact=artifact,
            input_artifact_sha256s=ready.input_artifact_sha256s,
            outcome="WAIT" if artifact.output.stance == "WAIT" else "PASS",
            origin="CACHE",
            observation=None,
        )
        self._event(
            conn,
            job,
            "ARTIFACT_PUBLISHED",
            _key("published", req.spec.identity.attempt_id),
            dict(
                type="PUBLISHED",
                report=report.model_dump(mode="json"),
                producer={k: producer[k] for k in ("scope_key", "job_id", "artifact_id")},
            ),
            now,
        )
        return self._after_result(conn, job, m, now)

    async def claim_ready(
        self, job_id: str, worker: str, expected_version: int
    ) -> AttemptClaim | None:
        self._worker(worker)
        if type(expected_version) is not int or expected_version < 0:
            raise ResearchRejected("INVALID_INPUT")

        def operation(conn: Conn, now: int) -> AttemptClaim | None:
            job, m = self._job(conn, job_id)
            if job["version"] != expected_version:
                raise r.PersistenceConflict("Q08_JOB_CAS_CONFLICT")
            if job["state"] in {
                "CANCELLED",
                "FAILED_REFERENCE",
                "COMPLETED_REFERENCE",
                "UNKNOWN",
                "WAIT_REVIEW",
                "WAIT_BUDGET",
            }:
                return None
            question, answer = self._question(conn, job)
            if question is not None and (
                answer is None or now < question.not_before_ms or now >= question.deadline_ms
            ):
                return None
            try:
                self._current(conn, job, m, now)
            except ResearchRejected as exc:
                if exc.reason not in {"EXPIRED", "UNAVAILABLE"}:
                    raise
                self._event(
                    conn,
                    job,
                    "DEADLINE" if exc.reason == "EXPIRED" else "WAIT",
                    _key("source-wait", m.manifest_sha256, exc.reason),
                    dict(type="SOURCE_UNUSABLE", reason=exc.reason),
                    now,
                )
                if job["state"] != "WAIT_DATA":
                    _update(
                        conn,
                        "research_jobs",
                        job,
                        ("scope_key", "job_id"),
                        dict(state="WAIT_DATA"),
                        now,
                    )
                return None
            for _ in range(19):
                proposed = j.plan_ready_roles(
                    m,
                    self._reports(conn, job),
                    now_ms=now,
                    public_facts=self._public_facts(conn, job),
                )
                if proposed.status != "RUNNABLE":
                    target = self._state(proposed.status)
                    if proposed.status == "COMPLETE" and m.trigger.kind != "FACTS":
                        target = "WAIT_REVIEW"
                    if target != job["state"]:
                        _update(
                            conn,
                            "research_jobs",
                            job,
                            ("scope_key", "job_id"),
                            dict(state=target),
                            now,
                        )
                    return None
                used = False
                for ready in proposed.roles:
                    cached = self._cached(conn, job, ready, now)
                    if cached is not None:
                        job = self._cached_use(conn, job, m, ready, cached, now)
                        used = True
                        break
                if not used:
                    break
                if job["state"] in {"WAIT_REVIEW", "UNKNOWN"}:
                    return None
            active = (
                "(state IN ('DISPATCH_STARTED','UNKNOWN_PENDING_RECONCILE') OR "
                "(state IN ('CLAIMED','RESERVED') AND lease_until_ms>%s))"
            )
            total = conn.execute(
                "SELECT count(*) AS n FROM q08_research.research_role_attempts WHERE " + active,
                (now,),
            ).fetchone()
            if total is None or total["n"] >= 4:
                return None
            own = conn.execute(
                "SELECT count(*) AS n FROM q08_research.research_role_attempts WHERE scope_key=%s "
                "AND job_id=%s AND " + active,
                (job["scope_key"], job_id, now),
            ).fetchone()
            if own is None or own["n"] >= 2:
                return None
            for ready in proposed.roles:
                req = ready.request
                old = self._attempt(conn, job, req.spec.identity.attempt_id)
                if old is not None and (
                    old["state"] not in {"CLAIMED", "RESERVED", "PLANNED"}
                    or (old["lease_until_ms"] is not None and old["lease_until_ms"] > now)
                ):
                    continue
                prefix = "q08c-" + ready.reuse_key + "-"
                busy = conn.execute(
                    "SELECT a.* FROM q08_research.research_role_attempts a WHERE "
                    "claim_id LIKE %s AND NOT(scope_key=%s AND job_id=%s AND attempt_id=%s) AND "
                    + "("
                    + active
                    + " OR (state='SETTLED' AND NOT EXISTS "
                    "(SELECT 1 FROM q08_research.research_artifacts f "
                    "WHERE f.scope_key=a.scope_key "
                    "AND f.job_id=a.job_id AND f.attempt_id=a.attempt_id))) LIMIT 1",
                    (prefix + "%", job["scope_key"], job_id, req.spec.identity.attempt_id, now),
                ).fetchone()
                if busy is not None:
                    continue
                epoch = 1 if old is None else old["owner_epoch"] + 1
                claim_id = prefix + uuid4().hex
                owner = dict(
                    worker_id=worker,
                    claim_id=claim_id,
                    owner_epoch=epoch,
                    lease_until_ms=min(now + _LEASE_MS, request_deadline(req)),
                )
                if old is None:
                    raw = _raw(req)
                    model = next(x for x in m.policy.models if x.role_id == ready.role_id)
                    _insert(
                        conn,
                        "research_role_attempts",
                        dict(
                            scope_key=job["scope_key"],
                            job_id=job_id,
                            visibility=job["visibility"],
                            role_id=ready.role_id,
                            attempt_id=req.spec.identity.attempt_id,
                            manifest_sha256=m.manifest_sha256,
                            request_sha256=request_digest(req),
                            payload_sha256=req.payload_sha256,
                            request_bytes=raw,
                            content_sha256=sha256(raw).hexdigest(),
                            model_id=req.spec.policy.model,
                            profile_revision=req.spec.task.profile_version,
                            policy_revision=req.spec.policy.revision,
                            effort=model.effort,
                            key_owner_id=req.spec.identity.key_owner_id,
                            credential_revision=req.spec.identity.credential_binding_revision,
                            funding=req.spec.context.funding,
                            state="CLAIMED",
                            created_at_ms=now,
                            updated_at_ms=now,
                            **owner,
                        ),
                    )
                    version = 0
                else:
                    if self._request(old) != req:
                        raise ResearchRejected("BINDING_MISMATCH")
                    if old["state"] == "PLANNED":
                        owner["state"] = "CLAIMED"
                    old = _update(
                        conn,
                        "research_role_attempts",
                        old,
                        ("scope_key", "job_id", "attempt_id"),
                        owner,
                        now,
                    )
                    version = old["version"]
                _update(
                    conn, "research_jobs", job, ("scope_key", "job_id"), dict(state="RUNNING"), now
                )
                return AttemptClaim(
                    ref=JobRef(
                        scope_key=job["scope_key"], job_id=job_id, manifest_sha256=m.manifest_sha256
                    ),
                    worker_id=worker,
                    owner_epoch=epoch,
                    claim_id=claim_id,
                    version=version,
                    ready=ready,
                )
            return None

        return await self._call(True, operation)

    def _scope_defs(self, job: Row, req: PreparedResearchRequest, now: int) -> list[Row]:
        identity = req.spec.identity
        owner = _digest(
            dict(
                key_owner=identity.key_owner_id,
                funding=req.spec.context.funding,
                private=None
                if req.spec.context.funding == "PLATFORM"
                else (identity.tenant_id, identity.principal_scope_id, identity.account_scope_id),
            )
        )
        specs = [
            ("OWNER", owner, "life", self._authority.owner_cap),
            (
                "ROOT",
                _digest((job["scope_key"], identity.logical_request_id)),
                "life",
                self._authority.policy.quote.reserve_atoms,
            ),
            ("TASK", identity.task_id, "life", req.spec.quote.reserve_atoms),
            ("DAY", owner, "utc-" + str(now // 86400000), self._authority.day_cap),
            ("PLATFORM", "q08-platform-sim", "life", self._authority.platform_cap),
        ]
        return [
            dict(
                budget_scope_id=_digest(
                    (kind, who, period, _BUDGET_REVISION, "SIM_MODEL_CREDIT_V1", 6)
                ),
                scope_kind=kind,
                scope_owner=who,
                period_id=period,
                policy_revision=_BUDGET_REVISION,
                unit_id="SIM_MODEL_CREDIT_V1",
                scale=6,
                cap_atoms=cap,
                created_at_ms=now,
                updated_at_ms=now,
            )
            for kind, who, period, cap in specs
        ]

    def _scopes(self, conn: Conn, job: Row, req: PreparedResearchRequest, now: int) -> list[Row]:
        result = []
        for definition in self._scope_defs(job, req, now):
            conn.execute(
                "INSERT INTO q08_research.research_budget_scopes "
                "(budget_scope_id,scope_kind,scope_owner,period_id,policy_revision,unit_id,scale,"
                "cap_atoms,created_at_ms,updated_at_ms) "
                "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                tuple(definition.values()),
            )
            row = conn.execute(
                "SELECT * FROM q08_research.research_budget_scopes "
                "WHERE budget_scope_id=%s FOR UPDATE",
                (definition["budget_scope_id"],),
            ).fetchone()
            if row is None or any(
                row[k] != v
                for k, v in definition.items()
                if k not in {"created_at_ms", "updated_at_ms"}
            ):
                raise ResearchRejected("BINDING_MISMATCH")
            result.append(row)
        return result

    def _budget_event(
        self,
        conn: Conn,
        job: Row,
        receipt: BudgetReceipt,
        now: int,
        reason: Reason,
        observation: OutcomeObservation | None = None,
        permit_hash: str | None = None,
        dispatch_before_ms: int | None = None,
    ) -> None:
        self._event(
            conn,
            job,
            "ROLE_RESULT",
            _key("budget", receipt.identity.attempt_id, receipt.version),
            dict(
                type="BUDGET",
                receipt=receipt.model_dump(mode="json"),
                reason=reason,
                observation=None if observation is None else observation.model_dump(mode="json"),
                permit_hash=permit_hash,
                dispatch_before_ms=dispatch_before_ms,
            ),
            now,
        )

    def _transition(
        self,
        conn: Conn,
        job: Row,
        attempt: Row,
        req: PreparedResearchRequest,
        old: BudgetReceipt,
        state: Literal[
            "DISPATCH_STARTED", "UNKNOWN_PENDING_RECONCILE", "SETTLED", "RELEASED_UNSENT"
        ],
        now: int,
        reason: Reason,
        observation: OutcomeObservation | None = None,
        charge: ChargeObservation | None = None,
        permit_hash: str | None = None,
        dispatch_before_ms: int | None = None,
    ) -> BudgetReceipt:
        group = conn.execute(
            "SELECT r.*,b.scope_kind,b.scope_owner FROM q08_research.research_reservations r "
            "JOIN q08_research.research_budget_scopes b USING(budget_scope_id) "
            "WHERE reservation_id=%s "
            "ORDER BY CASE b.scope_kind WHEN 'OWNER' THEN 1 WHEN 'ROOT' THEN 2 WHEN 'TASK' THEN 3 "
            "WHEN 'DAY' THEN 4 ELSE 5 END,r.budget_scope_id FOR UPDATE OF r,b",
            (old.reservation_id,),
        ).fetchall()
        old_field = {
            "RESERVED": "reserved_atoms",
            "DISPATCH_STARTED": "reserved_atoms",
            "UNKNOWN_PENDING_RECONCILE": "unknown_atoms",
        }[old.state]
        target = {
            "DISPATCH_STARTED": "reserved_atoms",
            "UNKNOWN_PENDING_RECONCILE": "unknown_atoms",
            "SETTLED": "spent_atoms",
            "RELEASED_UNSENT": None,
        }[state]
        for reservation in group:
            scope = conn.execute(
                "SELECT * FROM q08_research.research_budget_scopes WHERE budget_scope_id=%s",
                (reservation["budget_scope_id"],),
            ).fetchone()
            if scope is None:
                raise ResearchRejected("BINDING_MISMATCH")
            values = {old_field: int(scope[old_field]) - old.reserve_atoms}
            if target is not None:
                values[target] = values.get(target, int(scope[target])) + (
                    charge.atoms if charge is not None else old.reserve_atoms
                )
            if any(v < 0 for v in values.values()):
                raise ResearchRejected("BINDING_MISMATCH")
            _update(conn, "research_budget_scopes", scope, ("budget_scope_id",), values, now)
            _update(
                conn,
                "research_reservations",
                reservation,
                ("reservation_id", "budget_scope_id"),
                dict(state=state),
                now,
            )
        _update(
            conn,
            "research_role_attempts",
            attempt,
            ("scope_key", "job_id", "attempt_id"),
            dict(state=state),
            now,
        )
        result = BudgetReceipt(
            reservation_id=old.reservation_id,
            identity=old.identity,
            request_sha256=old.request_sha256,
            version=old.version + 1,
            state=state,
            unit_id="SIM_MODEL_CREDIT_V1",
            scale=6,
            reserve_atoms=old.reserve_atoms,
            charged_atoms=None if charge is None else charge.atoms,
            settlement_ref=None if charge is None else self._settlement_id(charge),
        )
        self._budget_event(
            conn, job, result, now, reason, observation, permit_hash, dispatch_before_ms
        )
        return result

    async def inspect_attempt(self, job_id: str, attempt_id: str) -> BudgetReceipt | None:
        _id(attempt_id)

        def operation(conn: Conn, now: int) -> BudgetReceipt | None:
            job, m = self._job(conn, job_id)
            row = self._attempt(conn, job, attempt_id)
            return None if row is None else self._receipt(conn, job, self._request(row))[0]

        return await self._call(False, operation)

    async def heartbeat(self, claim: AttemptClaim) -> AttemptClaim:
        token = canonical(claim, AttemptClaim, extra=_TYPES)
        actor = self.backend(token)

        def operation(conn: Conn, now: int) -> AttemptClaim:
            job, m, row, _ = actor._load(conn, token.ready.request)
            self._current(conn, job, m, now, dispatch=False)
            actor._owned(row, now)
            if row["state"] not in {"CLAIMED", "RESERVED", "DISPATCH_STARTED"}:
                raise ResearchRejected("DENIED")
            row = _update(
                conn,
                "research_role_attempts",
                row,
                ("scope_key", "job_id", "attempt_id"),
                dict(
                    lease_until_ms=min(
                        now + _LEASE_MS, request_deadline(token.ready.request, for_dispatch=False)
                    )
                ),
                now,
            )
            return canonical(
                token.model_copy(update={"version": row["version"]}), AttemptClaim, extra=_TYPES
            )

        return await self._call(True, operation)

    async def reconcile_attempt(
        self, job_id: str, attempt_id: str, observation: OutcomeObservation
    ) -> BudgetReceipt:
        """Late server-registered invoice only; never issue a permit or publish here."""
        _id(attempt_id)
        obs = canonical(observation, OutcomeObservation, extra=_TYPES)

        def operation(conn: Conn, now: int) -> BudgetReceipt:
            job, m = self._job(conn, job_id)
            row = self._attempt(conn, job, attempt_id)
            if row is None:
                raise ResearchRejected("DENIED")
            req = self._prepared(conn, job, m, row).request
            receipt, fact = self._receipt(conn, job, req)
            if receipt is None:
                raise ResearchRejected("DENIED")
            outcome = self._merge_outcome(self._outcome(fact), obs)
            charge = self._invoice(req, outcome)
            if charge is None:
                raise ResearchRejected("UNKNOWN_CHARGE")
            if receipt.state == "SETTLED":
                if self._outcome(fact) != outcome:
                    raise r.PersistenceConflict("Q08_OUTCOME_CONFLICT")
                return receipt
            if (
                receipt.state not in {"DISPATCH_STARTED", "UNKNOWN_PENDING_RECONCILE"}
                or row["permit_id"] is None
            ):
                raise ResearchRejected("DENIED")
            self._check_invoice_once(conn, receipt, charge)
            return self._transition(
                conn, job, row, req, receipt, "SETTLED", now, "OK", outcome, charge
            )

        return await self._call(True, operation)

    async def attach_public_reference(
        self, job_id: str, producer: JobRef, artifact_id: str
    ) -> ResearchArtifact:
        """A public fact link, not a private RoleReport or execution permission."""
        source = canonical(producer, JobRef, extra=_TYPES)
        _id(artifact_id)

        def operation(conn: Conn, now: int) -> ResearchArtifact:
            job, m = self._job(conn, job_id)
            self._current(conn, job, m, now, dispatch=False)
            stored_job, public, report, row, _ = self._public_result(
                conn,
                source,
                artifact_id,
                active=True,
                now=now,
            )
            if j._instrument(public.trigger) != j._instrument(m.trigger):
                raise ResearchRejected("BINDING_MISMATCH")
            j._references(public, (report,), now)
            node = next(x for x in public.nodes if x.role_id == report.role_id)
            ready = j._prepare(public, node, {})
            artifact = _decode(row["content_bytes"], row["content_sha256"], ResearchArtifact)
            check_artifact(ready.request, artifact, now_ms=now, clock_epoch=m.policy.clock_epoch)
            if not j._usable(public, now):
                raise ResearchRejected("EXPIRED")
            inputs = {c.contract_hash(x.source) for x in m.trigger.evidence}
            if not {c.contract_hash(x.source) for x in public.trigger.evidence} <= inputs:
                raise ResearchRejected("BINDING_MISMATCH")
            old = conn.execute(
                "SELECT 1 FROM q08_research.research_consumers WHERE scope_key=%s AND "
                "job_id=%s AND producer_scope_key=%s AND producer_job_id=%s AND artifact_id=%s",
                (job["scope_key"], job_id, row["scope_key"], row["job_id"], artifact_id),
            ).fetchone()
            if old is None:
                role = next(x for x in m.policy.models if x.role_id == ready.role_id)
                _insert(
                    conn,
                    "research_consumers",
                    dict(
                        scope_key=job["scope_key"],
                        job_id=job_id,
                        consumer_id=_key(
                            "public-reference", job_id, row["scope_key"], row["job_id"], artifact_id
                        ),
                        principal_id=job["principal_id"],
                        key_owner_id=role.key_owner_id,
                        credential_revision=role.credential_binding_revision,
                        producer_scope_key=row["scope_key"],
                        producer_job_id=row["job_id"],
                        artifact_id=artifact_id,
                        producer_visibility="PUBLIC",
                        producer_principal_id=row["principal_id"],
                        producer_key_owner_id=row["key_owner_id"],
                        producer_credential_revision=row["credential_revision"],
                        created_at_ms=now,
                        use_until_ms=min(artifact.use_until_ms, m.policy.deadline_ms),
                    ),
                )
            return artifact

        return await self._call(True, operation)

    def _cancel(self, conn: Conn, job: Row, m: j.JobManifestV1, now: int) -> JobView:
        job_id = job["job_id"]
        for row in self._attempts(conn, job):
            req = self._request(row)
            receipt, _ = self._receipt(conn, job, req)
            if receipt is None:
                if row["state"] in {"CLAIMED", "PLANNED"}:
                    _update(
                        conn,
                        "research_role_attempts",
                        row,
                        ("scope_key", "job_id", "attempt_id"),
                        dict(state="FAILED"),
                        now,
                    )
            elif receipt.state == "RESERVED" and row["permit_id"] is None:
                self._transition(conn, job, row, req, receipt, "RELEASED_UNSENT", now, "CANCELLED")
            elif receipt.state == "DISPATCH_STARTED":
                self._transition(
                    conn, job, row, req, receipt, "UNKNOWN_PENDING_RECONCILE", now, "CANCELLED"
                )
        job = _update(
            conn, "research_jobs", job, ("scope_key", "job_id"), dict(state="CANCELLED"), now
        )
        self._event(conn, job, "CANCEL", _key("cancel", job_id), dict(type="CANCEL"), now)
        return self._view(conn, job, m, now)

    async def cancel_job(self, job_id: str, expected_version: int) -> JobView:
        if type(expected_version) is not int:
            raise ResearchRejected("INVALID_INPUT")

        def operation(conn: Conn, now: int) -> JobView:
            job, m = self._job(conn, job_id)
            if job["version"] != expected_version:
                raise r.PersistenceConflict("Q08_JOB_CAS_CONFLICT")
            return self._cancel(conn, job, m, now)

        return await self._call(True, operation)

    @staticmethod
    def _settlement_id(charge: ChargeObservation) -> str:
        return _key(
            "sim-settlement",
            charge.provider,
            charge.source_ref,
            charge.source_revision,
            charge.event_id,
        )

    def _invoice(
        self, req: PreparedResearchRequest, observation: OutcomeObservation | None
    ) -> ChargeObservation | None:
        if observation is None or observation.charge is None:
            return None
        charge = observation.charge
        if (
            charge not in self._authority.invoices
            or charge.task_id != req.spec.identity.task_id
            or charge.attempt_id != req.spec.identity.attempt_id
            or charge.key_owner_id != req.spec.identity.key_owner_id
            or charge.provider not in req.spec.policy.providers
            or charge.atoms > req.spec.quote.reserve_atoms
        ):
            return None
        return charge

    def _check_invoice_once(
        self, conn: Conn, receipt: BudgetReceipt, charge: ChargeObservation
    ) -> None:
        rows = conn.execute(
            "SELECT * FROM q08_research.research_events_outbox WHERE kind='ROLE_RESULT' AND "
            "convert_from(fact_bytes,'UTF8')::jsonb#>>'{receipt,settlement_ref}'=%s LIMIT 2",
            (self._settlement_id(charge),),
        ).fetchall()
        for row in rows:
            fact = _fact(row)
            if fact["receipt"]["reservation_id"] != receipt.reservation_id or fact["observation"][
                "charge"
            ] != charge.model_dump(mode="json"):
                raise r.PersistenceConflict("Q08_SETTLEMENT_CONFLICT")

    @staticmethod
    def _outcome(fact: dict[str, Any] | None) -> OutcomeObservation | None:
        if fact is None or fact.get("observation") is None:
            return None
        return _embedded(fact["observation"], OutcomeObservation)

    @staticmethod
    def _merge_outcome(
        previous: OutcomeObservation | None, incoming: OutcomeObservation | None
    ) -> OutcomeObservation | None:
        if previous is None:
            return incoming
        if incoming is None:
            return previous
        if previous.model_result is not None and incoming.model_result is not None:
            if (
                previous.model_result != incoming.model_result
                or previous.scenario_revision != incoming.scenario_revision
            ):
                raise r.PersistenceConflict("Q08_OUTCOME_CONFLICT")
        return OutcomeObservation(
            model_result=incoming.model_result or previous.model_result,
            charge=incoming.charge or previous.charge,
            scenario_revision=previous.scenario_revision
            if previous.model_result is not None
            else incoming.scenario_revision,
        )

    def _good_artifact(
        self,
        conn: Conn,
        job: Row,
        m: j.JobManifestV1,
        row: Row,
        req: PreparedResearchRequest,
        obs: OutcomeObservation | None,
        now: int,
    ) -> ResearchArtifact | None:
        if obs is None or obs.model_result is None or obs.charge is None:
            return None
        model = obs.model_result
        binding = next(x for x in m.policy.models if x.role_id == req.spec.task.role_id)
        if (
            model.status != "OK"
            or model.output is None
            or model.response_id != obs.charge.request_id
            or model.response_sha256 is None
            or model.task_id != req.spec.identity.task_id
            or model.role_id != req.spec.task.role_id
            or model.profile_version != req.spec.task.profile_version
            or model.requested_model != req.spec.policy.model
            or model.returned_model != req.spec.policy.model
            or model.returned_provider not in req.spec.policy.providers
            or model.returned_provider != obs.charge.provider
            or model.purpose != "OFFLINE_FIXTURE"
            or model.attempts != 1
            or model.completed_at_ms - model.started_at_ms > binding.max_latency_ms
        ):
            return None
        starts = conn.execute(
            "SELECT * FROM q08_research.research_events_outbox WHERE scope_key=%s AND "
            "job_id=%s AND kind='ROLE_RESULT' ORDER BY seq LIMIT 4096",
            (job["scope_key"], job["job_id"]),
        ).fetchall()
        start = None
        end = None
        for event in starts:
            fact = _fact(event)
            if fact.get("type") != "BUDGET":
                continue
            receipt = _embedded(fact.get("receipt"), BudgetReceipt)
            if (
                receipt.identity.attempt_id == row["attempt_id"]
                and receipt.state == "DISPATCH_STARTED"
            ):
                start = event["created_at_ms"]
                end = fact.get("dispatch_before_ms")
                break
        if (
            start is None
            or type(end) is not int
            or not start <= model.started_at_ms <= model.completed_at_ms <= min(now, end)
        ):
            return None
        try:
            return make_artifact(
                req,
                model.output,
                artifact_id=_key("artifact", request_digest(req)),
                created_at_ms=model.completed_at_ms,
            )
        except ResearchRejected:
            return None

    def _publish(
        self,
        conn: Conn,
        job: Row,
        m: j.JobManifestV1,
        row: Row,
        ready: j.ReadyRoleV1,
        item: ResearchArtifact,
        receipt: BudgetReceipt,
        obs: OutcomeObservation,
        now: int,
    ) -> ResearchArtifact:
        req = ready.request
        self._current(conn, job, m, now, dispatch=False)
        check_artifact(req, item, now_ms=now, clock_epoch=req.spec.clock_epoch)
        good = self._good_artifact(conn, job, m, row, req, obs, now)
        if (
            good is None
            or obs.model_result is None
            or good.output != item.output
            or item.created_at_ms < good.created_at_ms
        ):
            raise ResearchRejected("INVALID_OUTPUT")
        prior = conn.execute(
            "SELECT * FROM q08_research.research_artifacts WHERE scope_key=%s AND "
            "job_id=%s AND role_id=%s",
            (job["scope_key"], job["job_id"], ready.role_id),
        ).fetchone()
        if prior is not None:
            if prior["content_bytes"] != _raw(item):
                raise r.PersistenceConflict("Q08_ARTIFACT_CONFLICT")
            return item
        raw = _raw(item)
        _insert(
            conn,
            "research_artifacts",
            dict(
                scope_key=job["scope_key"],
                job_id=job["job_id"],
                artifact_id=item.artifact_id,
                principal_id=job["principal_id"],
                attempt_id=row["attempt_id"],
                role_id=ready.role_id,
                visibility=job["visibility"],
                funding=req.spec.context.funding,
                key_owner_id=req.spec.identity.key_owner_id,
                credential_revision=req.spec.identity.credential_binding_revision,
                reuse_key=ready.reuse_key,
                content_bytes=raw,
                content_sha256=sha256(raw).hexdigest(),
                output_sha256=item.output_sha256,
                created_at_ms=item.created_at_ms,
                use_until_ms=item.use_until_ms,
            ),
        )
        report = j.RoleReportV1(
            manifest_sha256=m.manifest_sha256,
            role_id=ready.role_id,
            request_sha256=request_digest(req),
            reuse_key=ready.reuse_key,
            artifact=item,
            input_artifact_sha256s=ready.input_artifact_sha256s,
            outcome="WAIT" if item.output.stance == "WAIT" else "PASS",
            origin="FRESH",
            observation=ExecutionObservation(
                model_result=obs.model_result,
                charge=obs.charge,
                scenario_revision=obs.scenario_revision,
            ),
        )
        self._event(
            conn,
            job,
            "ARTIFACT_PUBLISHED",
            _key("published", req.spec.identity.attempt_id),
            dict(
                type="PUBLISHED",
                report=report.model_dump(mode="json"),
                producer=dict(
                    scope_key=job["scope_key"], job_id=job["job_id"], artifact_id=item.artifact_id
                ),
            ),
            now,
        )
        self._event(
            conn,
            job,
            "NOTICE",
            _key("notice", req.spec.identity.attempt_id),
            dict(
                type="NOTICE_INTENT",
                artifact_id=item.artifact_id,
                reservation_id=receipt.reservation_id,
                receipt_version=receipt.version,
                execution_authorized=False,
            ),
            now,
        )
        self._after_result(conn, job, m, now)
        return item

    async def recover_job(self, job_id: str, worker: str) -> JobView:
        self._worker(worker)

        def operation(conn: Conn, now: int) -> JobView:
            job, m = self._job(conn, job_id)
            question, _ = self._question(conn, job)
            if (
                question is not None
                and now >= question.deadline_ms
                and job["state"] not in {"CANCELLED", "FAILED_REFERENCE", "COMPLETED_REFERENCE"}
            ):
                self._event(
                    conn,
                    job,
                    "DEADLINE",
                    _key("deadline", question.question_id),
                    dict(type="WAIT_EXPIRED", question_id=question.question_id),
                    now,
                    question.question_id,
                )
                state = self._liability_state(conn, job, "WAIT_DATA")
                if job["state"] != state:
                    job = _update(
                        conn, "research_jobs", job, ("scope_key", "job_id"), dict(state=state), now
                    )
            for row in self._attempts(conn, job):
                req = self._prepared(conn, job, m, row).request
                receipt, fact = self._receipt(conn, job, req)
                if receipt is None or row["lease_until_ms"] is None or row["lease_until_ms"] > now:
                    continue
                if receipt.state == "RESERVED" and row["permit_id"] is None:
                    why: Reason | None = None
                    try:
                        self._current(conn, job, m, now, dispatch=False)
                    except ResearchRejected as exc:
                        if exc.reason == "CLOCK_INVALID":
                            raise
                        why = exc.reason
                    if now >= request_deadline(req):
                        why = "EXPIRED"
                    if why is not None:
                        self._transition(conn, job, row, req, receipt, "RELEASED_UNSENT", now, why)
                        if job["state"] not in {"CANCELLED", "FAILED_REFERENCE", "UNKNOWN"}:
                            job = _update(
                                conn,
                                "research_jobs",
                                job,
                                ("scope_key", "job_id"),
                                dict(state="WAIT_DATA"),
                                now,
                            )
                elif receipt.state == "DISPATCH_STARTED":
                    self._transition(
                        conn,
                        job,
                        row,
                        req,
                        receipt,
                        "UNKNOWN_PENDING_RECONCILE",
                        now,
                        "UNKNOWN_CHARGE",
                    )
                    if job["state"] != "CANCELLED":
                        job = _update(
                            conn,
                            "research_jobs",
                            job,
                            ("scope_key", "job_id"),
                            dict(state="UNKNOWN"),
                            now,
                        )
                elif (
                    receipt.state == "SETTLED"
                    and not conn.execute(
                        "SELECT 1 FROM q08_research.research_artifacts "
                        "WHERE scope_key=%s AND job_id=%s AND role_id=%s",
                        (job["scope_key"], job["job_id"], row["role_id"]),
                    ).fetchone()
                ):
                    if job["state"] in {"CANCELLED", "FAILED_REFERENCE"}:
                        continue
                    obs = self._outcome(fact)
                    item = self._good_artifact(conn, job, m, row, req, obs, now)
                    if item is None:
                        self._event(
                            conn,
                            job,
                            "WAIT",
                            _key("invalid-result", row["attempt_id"]),
                            dict(
                                type="RECOVERY_REVIEW",
                                attempt_id=row["attempt_id"],
                                reason="INVALID_OUTPUT",
                            ),
                            now,
                        )
                        state = self._liability_state(conn, job, "WAIT_REVIEW")
                        if job["state"] != state:
                            job = _update(
                                conn,
                                "research_jobs",
                                job,
                                ("scope_key", "job_id"),
                                dict(state=state),
                                now,
                            )
                        continue
                    try:
                        self._current(conn, job, m, now, dispatch=False)
                    except ResearchRejected as exc:
                        if exc.reason == "CLOCK_INVALID":
                            raise
                        state = "WAIT_DATA" if exc.reason == "EXPIRED" else "WAIT_REVIEW"
                        state = self._liability_state(conn, job, state)
                        if job["state"] != state:
                            job = _update(
                                conn,
                                "research_jobs",
                                job,
                                ("scope_key", "job_id"),
                                dict(state=state),
                                now,
                            )
                        continue
                    row = _update(
                        conn,
                        "research_role_attempts",
                        row,
                        ("scope_key", "job_id", "attempt_id"),
                        dict(
                            worker_id=worker,
                            owner_epoch=row["owner_epoch"] + 1,
                            claim_id="q08c-"
                            + self._prepared(conn, job, m, row).reuse_key
                            + "-"
                            + uuid4().hex,
                            lease_until_ms=min(
                                now + _LEASE_MS, request_deadline(req, for_dispatch=False)
                            ),
                        ),
                        now,
                    )
                    assert obs is not None
                    self._publish(
                        conn,
                        job,
                        m,
                        row,
                        self._prepared(conn, job, m, row),
                        item,
                        receipt,
                        obs,
                        now,
                    )
                    job, m = self._job(conn, job_id)
            return self._view(conn, job, m, now)

        return await self._call(True, operation)

    def backend(self, claim: AttemptClaim) -> ResearchAttemptBackend:
        if self._principal.role != "writer":
            raise ResearchRejected("DENIED")
        return ResearchAttemptBackend(self, canonical(claim, AttemptClaim, extra=_TYPES))

    async def submit_trigger(self, trigger: j.ResearchTriggerV1) -> JobRef:
        return await self.submit_job(
            j.compile_manifest(
                self._principal,
                trigger,
                self._authority.policy,
            )
        )

    async def park_gate_failure(self, claim: AttemptClaim, reason: Reason) -> None:
        token = canonical(claim, AttemptClaim, extra=_TYPES)
        why = _REASON.validate_python(reason, strict=True)
        actor = self.backend(token)

        def operation(conn: Conn, now: int) -> None:
            job, m, row, _ = actor._load(conn, token.ready.request)
            if job["state"] in {"CANCELLED", "FAILED_REFERENCE", "UNKNOWN"}:
                return
            actor._owned(row, now)
            receipt, _ = self._receipt(conn, job, token.ready.request)
            state = "WAIT_REVIEW"
            if receipt is not None and receipt.state in {
                "DISPATCH_STARTED",
                "UNKNOWN_PENDING_RECONCILE",
            }:
                state = "UNKNOWN"
            elif why in {"BUDGET_DENIED", "UNKNOWN_CHARGE"} and receipt is None:
                state = "WAIT_BUDGET"
                if row["permit_id"] is None and row["state"] == "FAILED":
                    # No dispatch occurred; reuse the same attempt only after a resume event.
                    _update(
                        conn,
                        "research_role_attempts",
                        row,
                        ("scope_key", "job_id", "attempt_id"),
                        dict(state="PLANNED", lease_until_ms=now),
                        now,
                    )
            elif why == "EXPIRED":
                state = "WAIT_DATA"
            state = self._liability_state(conn, job, state)
            self._event(
                conn,
                job,
                "WAIT",
                _key("gate-wait", token.claim_id, why),
                dict(type="GATE_WAIT", attempt_id=row["attempt_id"], reason=why),
                now,
            )
            values: Row = dict(state=state)
            question, answer = self._question(conn, job)
            if (
                state == "WAIT_BUDGET"
                and question is not None
                and question.kind == "BUDGET"
                and answer is not None
            ):
                # One answer cannot authorize repeated budget probing.
                if now >= question.deadline_ms:
                    values["state"] = "WAIT_DATA"
                else:
                    renewed = canonical(
                        question.model_copy(
                            update=dict(
                                question_id=_key(
                                    "question", job["job_id"], "BUDGET", job["version"]
                                ),
                                nonce="q08-answer-" + uuid4().hex,
                                expected_version=job["version"] + 1,
                                not_before_ms=max(now, question.not_before_ms),
                            )
                        ),
                        ResearchQuestion,
                        extra=_TYPES,
                    )
                    self._event(
                        conn,
                        job,
                        "QUESTION",
                        renewed.question_id,
                        dict(type="WAIT_QUESTION", question=renewed.model_dump(mode="json")),
                        now,
                        _key("gate-wait", token.claim_id, why),
                    )
                    values.update(
                        resume_kind="BUDGET",
                        resume_event_id=renewed.question_id,
                        not_before_ms=renewed.not_before_ms,
                    )
            _update(conn, "research_jobs", job, ("scope_key", "job_id"), values, now)

        await self._call(True, operation)

    def _public_result(
        self,
        conn: Conn,
        producer: JobRef,
        artifact_id: str,
        *,
        active: bool = False,
        now: int | None = None,
    ) -> tuple[Row, j.JobManifestV1, j.RoleReportV1, Row, int | None]:
        source = conn.execute(
            "SELECT * FROM q08_research.research_jobs WHERE scope_key=%s AND job_id=%s",
            (producer.scope_key, producer.job_id),
        ).fetchone()
        if source is None or source["visibility"] != "PUBLIC":
            raise ResearchRejected("DENIED")
        manifest = j._check_manifest(
            _decode(
                source["manifest_bytes"],
                source["content_sha256"],
                j.JobManifestV1,
            )
        )
        reports = [x for x in self._reports(conn, source) if x.artifact.artifact_id == artifact_id]
        if manifest.manifest_sha256 != producer.manifest_sha256 or len(reports) != 1:
            raise ResearchRejected("BINDING_MISMATCH")
        # Cached jobs reference the original artifact row, never a recreated copy.
        events = conn.execute(
            "SELECT * FROM q08_research.research_events_outbox WHERE scope_key=%s AND job_id=%s "
            "AND kind='ARTIFACT_PUBLISHED' ORDER BY seq LIMIT 19",
            (producer.scope_key, producer.job_id),
        ).fetchall()
        artifact = None
        for event in events:
            fact = _fact(event)
            if _embedded(fact["report"], j.RoleReportV1) != reports[0]:
                continue
            origin = fact["producer"]
            artifact = conn.execute(
                "SELECT * FROM q08_research.research_artifacts WHERE scope_key=%s AND job_id=%s "
                "AND artifact_id=%s AND visibility='PUBLIC'",
                tuple(origin[k] for k in ("scope_key", "job_id", "artifact_id")),
            ).fetchone()
            break
        if artifact is None or artifact["content_bytes"] != _raw(reports[0].artifact):
            raise ResearchRejected("BINDING_MISMATCH")
        valid_until = None
        if active:
            backing = conn.execute(
                "SELECT * FROM q08_research.research_jobs WHERE scope_key=%s AND job_id=%s",
                (artifact["scope_key"], artifact["job_id"]),
            ).fetchone()
            if backing is None or any(
                x in {"CANCELLED", "FAILED_REFERENCE", "UNKNOWN"}
                for x in (source["state"], backing["state"])
            ):
                raise ResearchRejected("UNAVAILABLE")
            original = j._check_manifest(
                _decode(
                    backing["manifest_bytes"],
                    backing["content_sha256"],
                    j.JobManifestV1,
                )
            )
            if (
                original.manifest_sha256 != backing["manifest_sha256"]
                or original.visibility.visibility != "PUBLIC"
                or original.subject_sha256 != manifest.subject_sha256
                or original.policy.clock_epoch != manifest.policy.clock_epoch
            ):
                raise ResearchRejected("BINDING_MISMATCH")
            if type(now) is not int:
                raise ResearchRejected("CLOCK_INVALID")
            for candidate in (manifest, original):
                end = min(
                    _snapshot_deadline(candidate, reports[0].role_id),
                    reports[0].artifact.use_until_ms,
                )
                if not j._usable(candidate, now) or not candidate.policy.now_ms <= now < end:
                    raise ResearchRejected("EXPIRED")
                valid_until = end if valid_until is None else min(valid_until, end)
        return source, manifest, reports[0], artifact, valid_until

    def _public_fact(
        self,
        conn: Conn,
        job: Row,
        producer: JobRef,
        artifact_id: str,
        *,
        active: bool = False,
        now: int | None = None,
    ) -> j.PublicFactReferenceV1:
        _, manifest, report, artifact, _ = self._public_result(
            conn, producer, artifact_id, active=active, now=now
        )
        linked = conn.execute(
            "SELECT 1 FROM q08_research.research_consumers WHERE scope_key=%s AND job_id=%s "
            "AND producer_scope_key=%s AND producer_job_id=%s AND artifact_id=%s "
            "AND producer_visibility='PUBLIC'",
            (
                job["scope_key"],
                job["job_id"],
                artifact["scope_key"],
                artifact["job_id"],
                artifact_id,
            ),
        ).fetchone()
        if linked is None:
            raise ResearchRejected("DENIED")
        return j.PublicFactReferenceV1(manifest=manifest, report=report)

    def _public_facts(self, conn: Conn, job: Row) -> tuple[j.PublicFactReferenceV1, ...]:
        rows = conn.execute(
            "SELECT * FROM q08_research.research_events_outbox WHERE scope_key=%s AND job_id=%s "
            "AND kind='ROLE_READY' ORDER BY seq LIMIT 19",
            (job["scope_key"], job["job_id"]),
        ).fetchall()
        result = []
        for row in rows:
            fact = _fact(row)
            if (
                set(fact) != {"type", "producer", "artifact_id"}
                or fact["type"] != "PUBLIC_DEPENDENCY"
            ):
                raise ResearchRejected("BINDING_MISMATCH")
            result.append(
                self._public_fact(
                    conn,
                    job,
                    _embedded(fact["producer"], JobRef),
                    _id(fact["artifact_id"]),
                )
            )
        if len(result) > 2:
            raise ResearchRejected("BINDING_MISMATCH")
        return tuple(result)

    async def activate_public_reference(
        self, job_id: str, producer: JobRef, artifact_id: str
    ) -> None:
        source = canonical(producer, JobRef, extra=_TYPES)
        _id(artifact_id)

        def operation(conn: Conn, now: int) -> None:
            job, m = self._job(conn, job_id)
            self._current(conn, job, m, now, dispatch=False)
            question, _ = self._question(conn, job)
            if (
                question is not None
                and question.public_source is not None
                and source != question.public_source
            ):
                raise ResearchRejected("BINDING_MISMATCH")
            fact = self._public_fact(conn, job, source, artifact_id, active=True, now=now)
            existing = self._public_facts(conn, job)
            if fact in existing:
                return
            if any(x["role_id"] == fact.report.role_id for x in self._attempts(conn, job)):
                raise ResearchRejected("DENIED")
            j._references(m, self._reports(conn, job), now, (*existing, fact))
            self._event(
                conn,
                job,
                "ROLE_READY",
                _key("public-dependency", job_id, fact.report.role_id),
                dict(
                    type="PUBLIC_DEPENDENCY",
                    producer=source.model_dump(mode="json"),
                    artifact_id=artifact_id,
                ),
                now,
            )

        await self._call(True, operation)

    def _question(
        self, conn: Conn, job: Row
    ) -> tuple[ResearchQuestion | None, ResearchAnswer | None]:
        if job["resume_event_id"] is None:
            return None, None
        row = conn.execute(
            "SELECT * FROM q08_research.research_events_outbox WHERE scope_key=%s AND job_id=%s "
            "AND event_id=%s AND kind='QUESTION'",
            (job["scope_key"], job["job_id"], job["resume_event_id"]),
        ).fetchone()
        if row is None:
            raise ResearchRejected("BINDING_MISMATCH")
        fact = _fact(row)
        if set(fact) != {"type", "question"} or fact["type"] != "WAIT_QUESTION":
            raise ResearchRejected("BINDING_MISMATCH")
        question = _embedded(fact["question"], ResearchQuestion)
        answer_row = conn.execute(
            "SELECT * FROM q08_research.research_events_outbox WHERE scope_key=%s AND job_id=%s "
            "AND event_id=%s AND kind='ANSWER'",
            (job["scope_key"], job["job_id"], _key("answer", question.question_id)),
        ).fetchone()
        answer = None
        if answer_row is not None:
            fact = _fact(answer_row)
            if set(fact) != {"type", "answer"} or fact["type"] != "WAIT_ANSWER":
                raise ResearchRejected("BINDING_MISMATCH")
            answer = _embedded(fact["answer"], ResearchAnswer)
            if (answer.question_id, answer.nonce, answer.expected_version) != (
                question.question_id,
                question.nonce,
                question.expected_version,
            ):
                raise ResearchRejected("BINDING_MISMATCH")
        return question, answer

    async def wait_for(
        self,
        job_id: str,
        expected_version: int,
        kind: Literal["DATA", "BUDGET", "REVIEW"],
        *,
        not_before_ms: int | None = None,
        public_source: JobRef | None = None,
    ) -> ResearchQuestion:
        if (
            type(expected_version) is not int
            or type(kind) is not str
            or kind
            not in {
                "DATA",
                "BUDGET",
                "REVIEW",
            }
        ):
            raise ResearchRejected("INVALID_INPUT")
        selected = None if public_source is None else canonical(public_source, JobRef, extra=_TYPES)

        def operation(conn: Conn, now: int) -> ResearchQuestion:
            job, m = self._job(conn, job_id)
            if job["version"] != expected_version:
                raise r.PersistenceConflict("Q08_JOB_CAS_CONFLICT")
            old, _ = self._question(conn, job)
            source = (
                selected
                if selected is not None
                else (old.public_source if old is not None and old.kind == kind else None)
            )
            if old is not None and old.kind == kind and old.expected_version == job["version"]:
                if selected is not None and old.public_source != selected:
                    raise r.PersistenceConflict("Q08_WAIT_SOURCE_CONFLICT")
                return old
            source_manifest = None
            source_row = None
            if source is not None:
                if (
                    kind != "DATA"
                    or m.visibility.visibility != "PRIVATE"
                    or source.scope_key != _digest({"visibility": "PUBLIC"})
                ):
                    raise ResearchRejected("DENIED")
                row = conn.execute(
                    "SELECT * FROM q08_research.research_jobs WHERE scope_key=%s AND job_id=%s",
                    (source.scope_key, source.job_id),
                ).fetchone()
                if (
                    row is None
                    or row["visibility"] != "PUBLIC"
                    or row["state"]
                    in {
                        "CANCELLED",
                        "FAILED_REFERENCE",
                        "UNKNOWN",
                    }
                ):
                    raise ResearchRejected("UNAVAILABLE")
                source_manifest = j._check_manifest(
                    _decode(
                        row["manifest_bytes"],
                        row["content_sha256"],
                        j.JobManifestV1,
                    )
                )
                source_row = row
                if (
                    source_manifest.manifest_sha256 != source.manifest_sha256
                    or j._instrument(source_manifest.trigger) != j._instrument(m.trigger)
                    or not {"A01", "A02"} <= {x.role_id for x in m.nodes}
                    or {x.role_id for x in source_manifest.nodes} != {"A01", "A02"}
                ):
                    raise ResearchRejected("BINDING_MISMATCH")
            if job["state"] != "WAIT_" + kind:
                if (
                    source is None
                    or job["state"] != "RUNNABLE"
                    or self._attempts(conn, job)
                    or self._reports(conn, job)
                ):
                    raise ResearchRejected("DENIED")
                self._current(conn, job, m, now)
            end = _snapshot_deadline(m)
            if source_manifest is not None:
                end = min(
                    end,
                    *(
                        _snapshot_deadline(source_manifest, x.role_id)
                        for x in source_manifest.nodes
                    ),
                )
                if source_row is not None and source is not None:
                    for report in self._reports(conn, source_row):
                        _, _, _, _, origin_end = self._public_result(
                            conn,
                            source,
                            report.artifact.artifact_id,
                            active=True,
                            now=now,
                        )
                        if origin_end is None:
                            raise ResearchRejected("CLOCK_INVALID")
                        end = min(end, origin_end)
            if old is not None and old.kind == kind:
                end = min(end, old.deadline_ms)
            start = (
                (max(now, old.not_before_ms) if old is not None and old.kind == kind else now)
                if not_before_ms is None
                else not_before_ms
            )
            if type(start) is not int:
                raise ResearchRejected("INVALID_INPUT")
            if old is not None and old.kind == kind:
                start = max(start, old.not_before_ms)
            if not now <= start < end:
                raise ResearchRejected("EXPIRED")
            question = ResearchQuestion(
                question_id=_key("question", job_id, kind, expected_version),
                kind=kind,
                nonce="q08-answer-" + uuid4().hex,
                expected_version=expected_version + 1,
                not_before_ms=start,
                deadline_ms=end,
                public_source=source,
            )
            self._event(
                conn,
                job,
                "QUESTION",
                question.question_id,
                dict(type="WAIT_QUESTION", question=question.model_dump(mode="json")),
                now,
            )
            _update(
                conn,
                "research_jobs",
                job,
                ("scope_key", "job_id"),
                dict(
                    state="WAIT_" + kind,
                    resume_kind=kind,
                    resume_event_id=question.question_id,
                    not_before_ms=start,
                ),
                now,
            )
            return question

        return await self._call(True, operation)

    async def answer_question(
        self,
        question_id: str,
        nonce: str,
        choice: Literal["RESUME", "CANCEL"],
        expected_version: int,
    ) -> str:
        try:
            answer = canonical(
                ResearchAnswer(
                    question_id=question_id,
                    nonce=nonce,
                    choice=choice,
                    expected_version=expected_version,
                ),
                ResearchAnswer,
                extra=_TYPES,
            )
        except ValueError:
            raise ResearchRejected("INVALID_INPUT") from None

        def operation(conn: Conn, now: int) -> str:
            row = conn.execute(
                "SELECT job_id FROM q08_research.research_events_outbox WHERE scope_key=%s "
                "AND event_id=%s AND kind='QUESTION'",
                (self._scope_key, answer.question_id),
            ).fetchone()
            if row is None:
                raise ResearchRejected("DENIED")
            job, m = self._job(conn, row["job_id"])
            question, old = self._question(conn, job)
            if question is None or (
                question.question_id,
                question.nonce,
                question.expected_version,
            ) != (
                answer.question_id,
                answer.nonce,
                answer.expected_version,
            ):
                raise ResearchRejected("DENIED")
            if old is not None:
                if old != answer:
                    raise r.PersistenceConflict("Q08_ANSWER_CONFLICT")
                return str(job["job_id"])
            if job["version"] != answer.expected_version:
                raise r.PersistenceConflict("Q08_JOB_CAS_CONFLICT")
            if not question.not_before_ms <= now < question.deadline_ms:
                raise ResearchRejected("EXPIRED")
            if job["state"] != "WAIT_" + question.kind:
                raise ResearchRejected("DENIED")
            if answer.choice == "RESUME" and question.public_source is not None:
                facts = self._public_facts(conn, job)
                if {x.report.role_id for x in facts} != {"A01", "A02"} or any(
                    x.manifest.manifest_sha256 != question.public_source.manifest_sha256
                    or x.manifest.trigger.job_id != question.public_source.job_id
                    for x in facts
                ):
                    raise ResearchRejected("WAITING")
            self._event(
                conn,
                job,
                "ANSWER",
                _key("answer", question.question_id),
                dict(type="WAIT_ANSWER", answer=answer.model_dump(mode="json")),
                now,
                question.question_id,
            )
            if answer.choice == "RESUME":
                self._current(conn, job, m, now, dispatch=False)
                self._after_result(conn, job, m, now)
            else:
                self._cancel(conn, job, m, now)
            return str(job["job_id"])

        return await self._call(True, operation)

    def _approval(
        self, conn: Conn, job: Row, reference_id: str | None
    ) -> c.ApprovalSnapshot | None:
        if reference_id is None:
            return None
        row = conn.execute(
            "SELECT * FROM pg1_control.astarter_approval_references WHERE scope_id=%s "
            "AND reference_id=%s",
            (job["source_scope_id"], _id(reference_id)),
        ).fetchone()
        if row is None:
            raise ResearchRejected("DENIED")
        record = r._decode(row, r.ApprovalRecord, job["source_scope_id"])
        if record.plan_id != job["plan_id"]:
            raise ResearchRejected("BINDING_MISMATCH")
        return record.approval

    async def evaluate_job(
        self,
        job_id: str,
        expected_version: int,
        *,
        abc: j.ABCDraftV1 | None = None,
        disposition: Literal["RESEARCH_READY", "NO_TRADE"] = "RESEARCH_READY",
        approval_id: str | None = None,
    ) -> None:
        draft = None if abc is None else j._valid(abc, j.ABCDraftV1)
        if type(disposition) is not str or disposition not in {"RESEARCH_READY", "NO_TRADE"}:
            raise ResearchRejected("INVALID_INPUT")

        def operation(conn: Conn, now: int) -> None:
            job, m = self._job(conn, job_id)
            if type(expected_version) is not int or job["version"] != expected_version:
                raise r.PersistenceConflict("Q08_JOB_CAS_CONFLICT")
            self._current(conn, job, m, now, dispatch=False)
            if self._liability_state(conn, job, job["state"]) == "UNKNOWN":
                raise ResearchRejected("UNKNOWN_CHARGE")
            public = self._public_facts(conn, job)
            reports = self._reports(conn, job)
            ready = j.plan_ready_roles(m, reports, now_ms=now, public_facts=public)
            if ready.status not in {"COMPLETE", "FAST_PATH"}:
                raise ResearchRejected("WAITING")
            bundle = j.ResearchBundleV1(
                manifest_sha256=m.manifest_sha256,
                reports=reports,
                abc=draft,
                disposition=disposition,
                approval=self._approval(conn, job, approval_id),
            )
            decision = j.check_bundle(bundle, m, now_ms=now, public_facts=public)
            event_id = _key("bundle", m.manifest_sha256, _digest(bundle.model_dump(mode="json")))
            old = conn.execute(
                "SELECT 1 FROM q08_research.research_events_outbox "
                "WHERE scope_key=%s AND job_id=%s "
                "AND event_id=%s",
                (job["scope_key"], job_id, event_id),
            ).fetchone()
            if old is not None:
                return
            self._event(
                conn,
                job,
                "NOTICE",
                event_id,
                dict(
                    type="RESEARCH_BUNDLE",
                    bundle=bundle.model_dump(mode="json"),
                    decision=decision.model_dump(mode="json"),
                ),
                now,
            )
            state = {
                "RESEARCH_READY": "COMPLETED_REFERENCE",
                "NO_TRADE": "COMPLETED_REFERENCE",
                "FAST_PATH": "COMPLETED_REFERENCE",
                "BLOCKED": "FAILED_REFERENCE",
            }.get(decision.status, decision.status)
            _update(conn, "research_jobs", job, ("scope_key", "job_id"), dict(state=state), now)

        await self._call(True, operation)

    async def read_workflow(self, job_id: str) -> WorkflowView:
        def operation(conn: Conn, now: int) -> WorkflowView:
            job, m = self._job(conn, job_id)
            view = self._view(conn, job, m, now)
            public = self._public_facts(conn, job)
            question, answer = self._question(conn, job)
            rows = conn.execute(
                "SELECT * FROM q08_research.research_events_outbox "
                "WHERE scope_key=%s AND job_id=%s "
                "AND kind='NOTICE' ORDER BY seq DESC LIMIT 4096",
                (job["scope_key"], job_id),
            ).fetchall()
            bundle, decision = None, None
            for row in rows:
                fact = _fact(row)
                if fact.get("type") != "RESEARCH_BUNDLE":
                    continue
                if set(fact) != {"type", "bundle", "decision"}:
                    raise ResearchRejected("BINDING_MISMATCH")
                bundle = _embedded(fact["bundle"], j.ResearchBundleV1)
                _embedded(fact["decision"], j.ResearchDecision)
                if bundle.manifest_sha256 != m.manifest_sha256 or bundle.reports != view.reports:
                    raise ResearchRejected("BINDING_MISMATCH")
                if job["state"] == "FAILED_REFERENCE":
                    try:
                        decision = j.check_bundle(bundle, m, now_ms=now, public_facts=public)
                    except ResearchRejected:
                        decision = None
                    if decision is None or decision.status != "BLOCKED":
                        decision = j._decision(
                            m, status="BLOCKED", reasons=("RESEARCH_FAILED_REFERENCE",)
                        )
                elif job["state"] not in {"CANCELLED", "UNKNOWN"}:
                    if view.current_data:
                        if (
                            bundle.approval is not None
                            and self._approval(
                                conn,
                                job,
                                bundle.approval.reference_id,
                            )
                            != bundle.approval
                        ):
                            raise ResearchRejected("DENIED")
                        decision = j.check_bundle(bundle, m, now_ms=now, public_facts=public)
                    else:
                        decision = j._decision(
                            m, status="WAIT_DATA", reasons=("EXPIRED_FROZEN_SNAPSHOT",)
                        )
                break
            question_state: Literal["OPEN", "ANSWERED", "EXPIRED", "CLOSED"] | None = None
            if question is not None:
                question_state = (
                    "ANSWERED"
                    if answer is not None
                    else "CLOSED"
                    if job["state"] in {"COMPLETED_REFERENCE", "CANCELLED", "FAILED_REFERENCE"}
                    else "EXPIRED"
                    if now >= question.deadline_ms
                    else "OPEN"
                )
            return WorkflowView(
                job=view,
                public_facts=public,
                question=question,
                question_state=question_state,
                answer=None if answer is None else answer.choice,
                bundle=bundle,
                decision=decision,
            )

        return await self._call(False, operation)


class ResearchAttemptBackend:
    """Existing ResearchBackend port, permanently bound to one owner fence."""

    def __init__(self, repository: PostgresResearchRepository, claim: AttemptClaim):
        self._repo, self._claim = repository, claim

    def _load(
        self, conn: Conn, req: PreparedResearchRequest
    ) -> tuple[Row, j.JobManifestV1, Row, j.ReadyRoleV1]:
        claim = self._claim
        if claim.ref.scope_key != self._repo._scope_key:
            raise ResearchRejected("DENIED")
        job, m = self._repo._job(conn, claim.ref.job_id)
        row = self._repo._attempt(conn, job, req.spec.identity.attempt_id)
        if row is None or m.manifest_sha256 != claim.ref.manifest_sha256:
            raise ResearchRejected("DENIED")
        ready = self._repo._prepared(conn, job, m, row)
        if ready != claim.ready or req != ready.request:
            raise ResearchRejected("BINDING_MISMATCH")
        return job, m, row, ready

    def _owned(self, row: Row, now: int) -> None:
        c = self._claim
        self._repo._worker(c.worker_id)
        if (
            (row["worker_id"], row["owner_epoch"], row["claim_id"])
            != (c.worker_id, c.owner_epoch, c.claim_id)
            or row["lease_until_ms"] is None
            or now >= row["lease_until_ms"]
            or not c.claim_id.startswith("q08c-" + c.ready.reuse_key + "-")
        ):
            raise ResearchRejected("DENIED")

    def _grant(self, row: Row, req: PreparedResearchRequest) -> EgressGrant:
        return EgressGrant(
            grant_id=_key("grant", row["claim_id"], request_digest(req)),
            grant_revision="Q08_STUB_V1",
            issuer_revision="Q08_SYNTHETIC_ISSUER_V1",
            revocation_epoch=row["owner_epoch"],
            identity=req.spec.identity,
            request_sha256=request_digest(req),
            payload_sha256=req.payload_sha256,
            evidence=req.spec.bindings,
            model_policy_id=req.spec.policy.policy_id,
            model_policy_revision=req.spec.policy.revision,
            model=req.spec.policy.model,
            dispatch_before_ms=min(request_deadline(req), row["lease_until_ms"]),
            quote_id=req.spec.quote.quote_id,
            quote_revision=req.spec.quote.revision,
        )

    def _check_grant(
        self, row: Row, req: PreparedResearchRequest, grant: EgressGrant, now: int
    ) -> None:
        check_grant(req, grant, now_ms=now)
        expected = self._grant(row, req)
        if (
            grant.model_dump(exclude={"dispatch_before_ms"})
            != expected.model_dump(exclude={"dispatch_before_ms"})
            or grant.dispatch_before_ms > expected.dispatch_before_ms
        ):
            raise ResearchRejected("DENIED")

    async def read_artifact(
        self, request: PreparedResearchRequest, key: str
    ) -> ResearchArtifact | None:
        req = check_structure(request)
        if key != semantic_key(req):
            raise ResearchRejected("BINDING_MISMATCH")

        def operation(conn: Conn, now: int) -> ResearchArtifact | None:
            job, m, row, ready = self._load(conn, req)
            self._repo._current(conn, job, m, now, dispatch=False)
            found = self._repo._cached(conn, job, ready, now)
            return (
                None
                if found is None
                else _decode(found["content_bytes"], found["content_sha256"], ResearchArtifact)
            )

        return await self._repo._call(False, operation)

    async def authorize_use(
        self, request: PreparedResearchRequest, artifact: ResearchArtifact
    ) -> None:
        req = check_structure(request)
        item = canonical(artifact, ResearchArtifact, extra=_TYPES)

        def operation(conn: Conn, now: int) -> None:
            job, m, row, ready = self._load(conn, req)
            self._owned(row, now)
            self._repo._current(conn, job, m, now, dispatch=False)
            found = self._repo._cached(conn, job, ready, now)
            if found is None or found["content_bytes"] != _raw(item):
                raise ResearchRejected("DENIED")
            self._repo._cached_use(conn, job, m, ready, found, now)

        await self._repo._call(True, operation)

    async def claim_or_join(self, request: PreparedResearchRequest, key: str) -> ResearchClaim:
        req = check_structure(request)
        if key != semantic_key(req):
            raise ResearchRejected("BINDING_MISMATCH")

        def operation(conn: Conn, now: int) -> ResearchClaim:
            job, m, row, ready = self._load(conn, req)
            self._repo._current(conn, job, m, now)
            self._owned(row, now)
            return ResearchClaim(claim_id=row["claim_id"], semantic_key=key, kind="PRODUCER")

        return await self._repo._call(False, operation)

    async def issue_grant(self, request: PreparedResearchRequest) -> EgressGrant:
        req = check_structure(request)

        def operation(conn: Conn, now: int) -> EgressGrant:
            job, m, row, ready = self._load(conn, req)
            self._repo._current(conn, job, m, now)
            self._owned(row, now)
            check_request(req, now_ms=now, clock_epoch=m.policy.clock_epoch)
            if row["state"] not in {"CLAIMED", "RESERVED"}:
                raise ResearchRejected("ALREADY_STARTED")
            return self._grant(row, req)

        return await self._repo._call(False, operation)

    async def reserve(self, request: PreparedResearchRequest, grant: EgressGrant) -> BudgetReceipt:
        req = check_structure(request)
        granted = canonical(grant, EgressGrant)

        def operation(conn: Conn, now: int) -> BudgetReceipt:
            repo = self._repo
            job, m, row, ready = self._load(conn, req)
            repo._current(conn, job, m, now)
            self._owned(row, now)
            self._check_grant(row, req, granted, now)
            old, _ = repo._receipt(conn, job, req)
            if old is not None:
                return old
            if row["state"] != "CLAIMED":
                raise ResearchRejected("DENIED")
            scopes = repo._scopes(conn, job, req, now)
            atoms = req.spec.quote.reserve_atoms
            if any(
                int(s["reserved_atoms"]) + int(s["spent_atoms"]) + int(s["unknown_atoms"]) + atoms
                > int(s["cap_atoms"])
                for s in scopes
            ):
                raise ResearchRejected("BUDGET_DENIED")
            if any(s["scope_kind"] == "OWNER" and int(s["unknown_atoms"]) > 0 for s in scopes):
                raise ResearchRejected("UNKNOWN_CHARGE")
            receipt = BudgetReceipt(
                reservation_id=_key(
                    "reservation", job["scope_key"], job["job_id"], row["attempt_id"]
                ),
                identity=req.spec.identity,
                request_sha256=request_digest(req),
                version=1,
                state="RESERVED",
                unit_id="SIM_MODEL_CREDIT_V1",
                scale=6,
                reserve_atoms=atoms,
                charged_atoms=None,
                settlement_ref=None,
            )
            for scope in scopes:
                _update(
                    conn,
                    "research_budget_scopes",
                    scope,
                    ("budget_scope_id",),
                    dict(reserved_atoms=int(scope["reserved_atoms"]) + atoms),
                    now,
                )
                _insert(
                    conn,
                    "research_reservations",
                    dict(
                        reservation_id=receipt.reservation_id,
                        budget_scope_id=scope["budget_scope_id"],
                        scope_key=job["scope_key"],
                        job_id=job["job_id"],
                        attempt_id=row["attempt_id"],
                        request_sha256=request_digest(req),
                        quote_sha256=_digest(req.spec.quote.model_dump(mode="json")),
                        atoms=atoms,
                        state="RESERVED",
                        version=1,
                        created_at_ms=now,
                        updated_at_ms=now,
                    ),
                )
            _update(
                conn,
                "research_role_attempts",
                row,
                ("scope_key", "job_id", "attempt_id"),
                dict(state="RESERVED"),
                now,
            )
            repo._budget_event(conn, job, receipt, now, "OK")
            return receipt

        return await self._repo._call(True, operation)

    async def start_once(
        self,
        request: PreparedResearchRequest,
        grant: EgressGrant,
        receipt: BudgetReceipt,
        deadline_ms: int,
    ) -> DispatchPermit | None:
        req = check_structure(request)
        granted = canonical(grant, EgressGrant)
        sent = canonical(receipt, BudgetReceipt, extra=_TYPES)
        if type(deadline_ms) is not int:
            raise ResearchRejected("INVALID_INPUT")

        def operation(conn: Conn, now: int) -> DispatchPermit | None:
            repo = self._repo
            job, m, row, ready = self._load(conn, req)
            repo._current(conn, job, m, now)
            self._owned(row, now)
            old, _ = repo._receipt(conn, job, req)
            if old is None:
                raise ResearchRejected("DENIED")
            if old.state != "RESERVED" or old.version != sent.version:
                return None
            if old != sent:
                raise ResearchRejected("BINDING_MISMATCH")
            self._check_grant(row, req, granted, now)
            scopes = repo._scopes(conn, job, req, now)
            now = _now_ms(conn)
            repo._current(conn, job, m, now)
            self._owned(row, now)
            self._check_grant(row, req, granted, now)
            if any(x["scope_kind"] == "OWNER" and int(x["unknown_atoms"]) > 0 for x in scopes):
                raise ResearchRejected("UNKNOWN_CHARGE")
            end = min(
                deadline_ms,
                request_deadline(req),
                granted.dispatch_before_ms,
                row["lease_until_ms"],
                now + next(x.max_latency_ms for x in m.policy.models if x.role_id == ready.role_id),
            )
            if now >= end:
                raise ResearchRejected("EXPIRED")
            fence = uuid4().hex + uuid4().hex
            row = _update(
                conn,
                "research_role_attempts",
                row,
                ("scope_key", "job_id", "attempt_id"),
                dict(permit_id=uuid4().hex),
                now,
            )
            new = repo._transition(
                conn,
                job,
                row,
                req,
                old,
                "DISPATCH_STARTED",
                now,
                "OK",
                permit_hash=sha256(fence.encode()).hexdigest(),
                dispatch_before_ms=end,
            )
            return DispatchPermit(
                receipt=new, payload_sha256=req.payload_sha256, fence=fence, dispatch_before_ms=end
            )

        return await self._repo._call(True, operation)

    async def record_outcome(
        self,
        request: PreparedResearchRequest,
        receipt: BudgetReceipt,
        observation: OutcomeObservation | None,
        reason: Reason,
    ) -> BudgetReceipt:
        req = check_structure(request)
        sent = canonical(receipt, BudgetReceipt, extra=_TYPES)
        obs = (
            None
            if observation is None
            else canonical(observation, OutcomeObservation, extra=_TYPES)
        )
        why = _REASON.validate_python(reason, strict=True)

        def operation(conn: Conn, now: int) -> BudgetReceipt:
            repo = self._repo
            job, m, row, ready = self._load(conn, req)
            self._owned(row, now)
            old, fact = repo._receipt(conn, job, req)
            if old is None or (sent.reservation_id, sent.identity, sent.request_sha256) != (
                old.reservation_id,
                old.identity,
                old.request_sha256,
            ):
                raise ResearchRejected("BINDING_MISMATCH")
            previous = repo._outcome(fact)
            outcome = repo._merge_outcome(previous, obs)
            if old.state == "SETTLED":
                if outcome != previous:
                    raise r.PersistenceConflict("Q08_OUTCOME_CONFLICT")
                return old
            if old.state not in {"DISPATCH_STARTED", "UNKNOWN_PENDING_RECONCILE"}:
                raise ResearchRejected("DENIED")
            charge = repo._invoice(req, outcome)
            if charge is not None:
                repo._check_invoice_once(conn, old, charge)
                return repo._transition(
                    conn, job, row, req, old, "SETTLED", now, why, outcome, charge
                )
            if old.state == "UNKNOWN_PENDING_RECONCILE":
                if outcome == previous:
                    return old
                return repo._transition(
                    conn, job, row, req, old, "UNKNOWN_PENDING_RECONCILE", now, why, outcome
                )
            result = repo._transition(
                conn, job, row, req, old, "UNKNOWN_PENDING_RECONCILE", now, why, outcome
            )
            if job["state"] != "CANCELLED":
                _update(
                    conn, "research_jobs", job, ("scope_key", "job_id"), dict(state="UNKNOWN"), now
                )
            return result

        return await self._repo._call(True, operation)

    async def inspect_attempt(self, identity: ResearchIdentity) -> BudgetReceipt | None:
        ident = canonical(identity, ResearchIdentity)
        if ident != self._claim.ready.request.spec.identity:
            raise ResearchRejected("DENIED")
        return await self._repo.inspect_attempt(self._claim.ref.job_id, ident.attempt_id)

    async def release_unsent(
        self, request: PreparedResearchRequest, receipt: BudgetReceipt, reason: Reason
    ) -> BudgetReceipt:
        req = check_structure(request)
        sent = canonical(receipt, BudgetReceipt, extra=_TYPES)
        why = _REASON.validate_python(reason, strict=True)

        def operation(conn: Conn, now: int) -> BudgetReceipt:
            repo = self._repo
            job, m, row, ready = self._load(conn, req)
            self._owned(row, now)
            old, _ = repo._receipt(conn, job, req)
            if old is None or old.reservation_id != sent.reservation_id:
                raise ResearchRejected("BINDING_MISMATCH")
            if old.state == "RELEASED_UNSENT":
                return old
            if old != sent or old.state != "RESERVED" or row["permit_id"] is not None:
                raise ResearchRejected("DENIED")
            return repo._transition(conn, job, row, req, old, "RELEASED_UNSENT", now, why)

        return await self._repo._call(True, operation)

    async def publish_artifact(
        self,
        request: PreparedResearchRequest,
        claim: ResearchClaim,
        artifact: ResearchArtifact,
        receipt: BudgetReceipt,
    ) -> ResearchArtifact:
        req = check_structure(request)
        logical = canonical(claim, ResearchClaim, extra=_TYPES)
        item = canonical(artifact, ResearchArtifact, extra=_TYPES)
        sent = canonical(receipt, BudgetReceipt, extra=_TYPES)

        def operation(conn: Conn, now: int) -> ResearchArtifact:
            repo = self._repo
            job, m, row, ready = self._load(conn, req)
            self._owned(row, now)
            if (
                logical.claim_id != row["claim_id"]
                or logical.kind != "PRODUCER"
                or logical.semantic_key != semantic_key(req)
            ):
                raise ResearchRejected("DENIED")
            old, fact = repo._receipt(conn, job, req)
            obs = repo._outcome(fact)
            if old != sent or old is None or old.state != "SETTLED" or obs is None:
                raise ResearchRejected("DENIED")
            return repo._publish(conn, job, m, row, ready, item, old, obs, now)

        return await self._repo._call(True, operation)

    async def finish_claim(self, request: PreparedResearchRequest, claim: ResearchClaim) -> None:
        req = check_structure(request)
        logical = canonical(claim, ResearchClaim, extra=_TYPES)

        def operation(conn: Conn, now: int) -> None:
            repo = self._repo
            job, m, row, ready = self._load(conn, req)
            self._owned(row, now)
            if (
                logical.claim_id != row["claim_id"]
                or logical.kind != "PRODUCER"
                or logical.semantic_key != semantic_key(req)
            ):
                raise ResearchRejected("DENIED")
            receipt, _ = repo._receipt(conn, job, req)
            if receipt is None and row["state"] == "CLAIMED":
                _update(
                    conn,
                    "research_role_attempts",
                    row,
                    ("scope_key", "job_id", "attempt_id"),
                    dict(state="FAILED"),
                    now,
                )

        await self._repo._call(True, operation)
