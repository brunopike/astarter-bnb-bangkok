"""Q08-A1 pure research contracts and scheduling proposals, not dispatch permits.

No IO, implicit clock, model adapter, durable claim, budget ledger or execution
registration. A SYNTHETIC_REFERENCE is checked for consistency, not authenticated.
The backend must authorize use and atomically reserve/start in later slices.
"""

from __future__ import annotations

from graphlib import CycleError, TopologicalSorter
from typing import TYPE_CHECKING, Annotated, Final, Literal, Self

from pydantic import BaseModel, Field, StrictBool, StrictInt, StrictStr, model_validator

from stark_trading_os.domain import strategy_contracts as c
from stark_trading_os.integrations.contracts import Evidence, Identifier, RoleId, Timestamp
from stark_trading_os.integrations.research_delivery import (
    DELIVERY_TYPES,
    PrivateScope,
    PublicScope,
    ResearchArtifact,
    check_artifact,
    semantic_key,
)
from stark_trading_os.integrations.research_egress import (
    BudgetQuote,
    Digest,
    EvidenceBinding,
    ModelProviderPolicy,
    PreparedResearchRequest,
    ResearchRejected,
    canonical,
    digest_text,
    encode,
    prepare_fixture,
    request_digest,
)
from stark_trading_os.integrations.research_gate import GATE_TYPES, ExecutionObservation

if TYPE_CHECKING:
    from stark_trading_os.control.postgres.identity import Principal

ROLE_SEMANTICS_REVISION: Final = "Q08_RESEARCH_18_REF_V1"
type Kind = Literal[
    "FACTS", "PROPOSAL", "REVISION", "CONTRADICTION", "ANOMALY", "POSTMORTEM", "FAST_EVENT"
]
type Mode = Literal["FAST", "BALANCED", "ADAPTIVE"]
type ResultLevel = Literal[
    "FACTS_REFERENCE", "PROPOSAL_REFERENCE", "EVENT_REFERENCE", "FAST_PATH_REFERENCE"
]
type DecisionStatus = Literal[
    "RESEARCH_READY", "WAIT_DATA", "WAIT_BUDGET", "WAIT_REVIEW", "NO_TRADE", "BLOCKED", "FAST_PATH"
]
type Group = Literal["EVIDENCE", "ARGUMENT", "REVIEW", "INTEGRATION", "PRIVATE", "POST_EVENT"]
type Rule = Literal[
    "CURRENT_DATA_REQUIRED",
    "RISK_LIMITS_REQUIRED",
    "ENTRY_GATES_REQUIRED",
    "STRATEGY_EXIT_SOURCE_RULES",
    "PAUSE_NEW_RISK_KEEP_PROTECTION",
]
Roles = Annotated[tuple[RoleId, ...], Field(max_length=18)]
_DEFINITIONS: tuple[tuple[str, str, Group], ...] = (
    ("A01", "市场环境", "EVIDENCE"),
    ("A02", "多周期趋势", "EVIDENCE"),
    ("A03", "价格行为与形态", "EVIDENCE"),
    ("A04", "成交量与量价", "EVIDENCE"),
    ("A05", "盘口与流动性", "EVIDENCE"),
    ("A06", "波动与异常", "EVIDENCE"),
    ("A07", "策略规则映射", "ARGUMENT"),
    ("A08", "做多论证", "ARGUMENT"),
    ("A09", "减仓与退出论证", "ARGUMENT"),
    ("A10", "反证质询", "REVIEW"),
    ("A11", "等待与不交易", "ARGUMENT"),
    ("A12", "情景路径", "ARGUMENT"),
    ("A13", "决策整合", "INTEGRATION"),
    ("A14", "组合与敞口", "PRIVATE"),
    ("A15", "资本保护审阅", "REVIEW"),
    ("A16", "执行质量评估", "PRIVATE"),
    ("A17", "运行异常诊断", "POST_EVENT"),
    ("A18", "归因复盘", "POST_EVENT"),
)
_FULL = frozenset({"PROPOSAL", "REVISION", "CONTRADICTION"})


class RoleDefinitionV1(c.Offline):
    role_id: RoleId
    name: Annotated[StrictStr, Field(min_length=1, max_length=80)]
    group: Group
    role_semantics_revision: Literal["Q08_RESEARCH_18_REF_V1"] = ROLE_SEMANTICS_REVISION
    public_eligible: StrictBool


def role_registry() -> tuple[RoleDefinitionV1, ...]:
    return tuple(
        RoleDefinitionV1(role_id=r, name=n, group=g, public_eligible=r in {"A01", "A02"})
        for r, n, g in _DEFINITIONS
    )


def role_definition(role_id: str) -> RoleDefinitionV1:
    if type(role_id) is not str:
        raise ResearchRejected
    for item in role_registry():
        if item.role_id == role_id:
            return item
    raise ResearchRejected


class JobEvidenceV1(c.Offline):
    source: c.EvidenceSnapshot
    text: Annotated[StrictStr, Field(min_length=1, max_length=8000)] = Field(repr=False)
    egress_allowed: StrictBool

    @model_validator(mode="after")
    def content(self) -> Self:
        if digest_text(
            self.text
        ) != self.source.content_sha256 or self.source.evidence_id.startswith("q08.dep."):
            raise ValueError("EVIDENCE_CONTENT_MISMATCH")
        return self


class PublicSubjectV1(c.Offline):
    template_id: Identifier
    revision: Identifier
    strategy_revision: Identifier
    instrument: c.InstrumentProfile


class RoleModelBindingV1(c.Offline):
    role_id: RoleId
    profile_version: Identifier
    policy: ModelProviderPolicy
    quote: BudgetQuote
    effort: Literal["LOW", "MEDIUM", "HIGH"]
    max_latency_ms: Annotated[StrictInt, Field(gt=0, le=30000)]
    funding: Literal["PLATFORM", "BYOK"]
    key_owner_id: Identifier
    credential_binding_revision: Identifier

    @model_validator(mode="after")
    def fixed_provider(self) -> Self:
        if self.policy.allow_fallbacks or len(set(self.policy.providers)) != len(
            self.policy.providers
        ):
            raise ValueError("FROZEN_MODEL_POLICY_REQUIRED")
        return self


class PolicySnapshotV1(c.Offline):
    policy_id: Identifier
    revision: Identifier
    now_ms: Timestamp
    clock_epoch: Identifier
    deadline_ms: Timestamp
    quote: BudgetQuote
    models: Annotated[tuple[RoleModelBindingV1, ...], Field(max_length=18)]
    fixture_issuer_reference: Identifier

    @model_validator(mode="after")
    def unique_models(self) -> Self:
        if len({m.role_id for m in self.models}) != len(self.models):
            raise ValueError("DUPLICATE_MODEL_BINDING")
        return self


class ResearchTriggerV1(c.Offline):
    job_id: Identifier
    logical_request_id: Identifier
    event_id: Identifier
    kind: Kind
    mode: Mode
    plan: c.PlanRevision | None = None
    public_subject: PublicSubjectV1 | None = None
    evidence: Annotated[tuple[JobEvidenceV1, ...], Field(max_length=8)]
    requested_roles: Roles = ()

    @model_validator(mode="after")
    def shape(self) -> Self:
        if (
            (self.plan is None) == (self.public_subject is None)
            or len(set(self.requested_roles)) != len(self.requested_roles)
            or len({x.source.evidence_id for x in self.evidence}) != len(self.evidence)
        ):
            raise ValueError("UNIQUE_SUBJECT_ROLES_AND_EVIDENCE_REQUIRED")
        return self


class RoleNodeV1(c.Offline):
    role_id: RoleId
    depends_on: Roles


class JobManifestV1(c.Offline):
    role_semantics_revision: Literal["Q08_RESEARCH_18_REF_V1"] = ROLE_SEMANTICS_REVISION
    principal_id: Identifier
    visibility: PublicScope | PrivateScope
    trigger: ResearchTriggerV1
    policy: PolicySnapshotV1
    subject_sha256: Digest
    nodes: Annotated[tuple[RoleNodeV1, ...], Field(max_length=18)]
    manifest_sha256: Digest

    @model_validator(mode="after")
    def closed_dag(self) -> Self:
        ids = {n.role_id for n in self.nodes}
        if len(ids) != len(self.nodes) or any(
            len(set(n.depends_on)) != len(n.depends_on) or not set(n.depends_on) <= ids
            for n in self.nodes
        ):
            raise ValueError("INVALID_ROLE_DAG")
        try:
            tuple(TopologicalSorter({n.role_id: n.depends_on for n in self.nodes}).static_order())
        except CycleError:
            raise ValueError("CYCLIC_ROLE_DAG") from None
        return self


class ReadyRoleV1(c.Offline):
    role_id: RoleId
    request: PreparedResearchRequest
    reuse_key: Digest
    input_artifact_sha256s: Annotated[tuple[Digest, ...], Field(max_length=18)]


class ReadyRolesV1(c.Offline):
    status: Literal["RUNNABLE", "WAIT_DATA", "WAIT_BUDGET", "BLOCKED", "COMPLETE", "FAST_PATH"]
    reasons: tuple[Identifier, ...]
    roles: Annotated[tuple[ReadyRoleV1, ...], Field(max_length=2)] = ()
    pending: Roles = ()


class RoleReportV1(c.Offline):
    role_semantics_revision: Literal["Q08_RESEARCH_18_REF_V1"] = ROLE_SEMANTICS_REVISION
    reference_origin: Literal["SYNTHETIC_REFERENCE"] = "SYNTHETIC_REFERENCE"
    manifest_sha256: Digest
    role_id: RoleId
    request_sha256: Digest
    reuse_key: Digest
    artifact: ResearchArtifact
    input_artifact_sha256s: Annotated[tuple[Digest, ...], Field(max_length=18)]
    outcome: Literal["PASS", "WAIT", "BLOCK"]
    origin: Literal["FRESH", "CACHE"]
    observation: ExecutionObservation | None = None


class PublicFactReferenceV1(c.Offline):
    """Explicit source snapshot; never relabel a public report as private."""

    manifest: JobManifestV1
    report: RoleReportV1


class ABCBranchV1(c.Offline):
    branch: Literal["A", "B", "C"]
    condition: Rule
    invalidation: Rule
    response: Rule
    explanation: Annotated[StrictStr, Field(min_length=1, max_length=1000)] = Field(repr=False)
    evidence_ids: Annotated[tuple[Identifier, ...], Field(min_length=1, max_length=8)]

    @model_validator(mode="after")
    def meaningful_reference(self) -> Self:
        if not self.explanation.strip() or len(set(self.evidence_ids)) != len(self.evidence_ids):
            raise ValueError("SCENARIO_EXPLANATION_AND_UNIQUE_REFERENCES_REQUIRED")
        return self


class ABCDraftV1(c.Offline):
    source_sha256: Literal["976970573ca0ac333656ae800c1129430901d402ee80980637a8e6994c170742"] = (
        c.SOURCE_SHA256
    )
    subject_sha256: Digest
    branches: Annotated[tuple[ABCBranchV1, ...], Field(min_length=3, max_length=3)]

    @model_validator(mode="after")
    def three_scenarios(self) -> Self:
        if tuple(b.branch for b in self.branches) != ("A", "B", "C"):
            raise ValueError("ABC_REQUIRED")
        expected = (
            "ENTRY_GATES_REQUIRED",
            "STRATEGY_EXIT_SOURCE_RULES",
            "PAUSE_NEW_RISK_KEEP_PROTECTION",
        )
        if tuple(b.response for b in self.branches) != expected:
            raise ValueError("REGISTERED_SCENARIO_RESPONSES_REQUIRED")
        return self


class ResearchBundleV1(c.Offline):
    manifest_sha256: Digest
    reports: Annotated[tuple[RoleReportV1, ...], Field(max_length=18)]
    abc: ABCDraftV1 | None = None
    approval: c.ApprovalSnapshot | None = None
    disposition: Literal["RESEARCH_READY", "WAIT", "NO_TRADE", "BLOCKED"]


class ResearchDecision(c.Offline):
    reference_only: Literal[True] = True
    research_kind: Kind
    result_level: ResultLevel
    status: DecisionStatus
    reasons: tuple[Identifier, ...]
    missing_roles: Roles = ()

    @model_validator(mode="after")
    def scoped_result(self) -> Self:
        if self.result_level != _result_level(self.research_kind):
            raise ValueError("RESULT_KIND_LEVEL_MISMATCH")
        return self


def _result_level(kind: Kind) -> ResultLevel:
    if kind in _FULL:
        return "PROPOSAL_REFERENCE"
    if kind == "FACTS":
        return "FACTS_REFERENCE"
    if kind == "FAST_EVENT":
        return "FAST_PATH_REFERENCE"
    return "EVENT_REFERENCE"


_TYPES: tuple[type[BaseModel], ...] = (
    *c._TYPES,
    *DELIVERY_TYPES,
    *GATE_TYPES,
    RoleDefinitionV1,
    JobEvidenceV1,
    PublicSubjectV1,
    RoleModelBindingV1,
    PolicySnapshotV1,
    ResearchTriggerV1,
    RoleNodeV1,
    JobManifestV1,
    ReadyRoleV1,
    ReadyRolesV1,
    RoleReportV1,
    PublicFactReferenceV1,
    ABCBranchV1,
    ABCDraftV1,
    ResearchBundleV1,
    ResearchDecision,
)


def _valid[T: BaseModel](value: object, cls: type[T]) -> T:
    return canonical(value, cls, extra=_TYPES)


def _hash(value: BaseModel) -> str:
    return digest_text(encode(value.model_dump(mode="json")))


def _graph(t: ResearchTriggerV1) -> tuple[RoleNodeV1, ...]:
    requested = set(t.requested_roles)
    graph: dict[str, tuple[str, ...]]
    if t.kind == "FAST_EVENT":
        if requested:
            raise ResearchRejected
        graph = {}
    elif t.kind == "FACTS":
        selected = requested or {"A01", "A02"}
        if not selected <= {"A01", "A02", "A03", "A04", "A05", "A06", "A07", "A11"}:
            raise ResearchRejected
        graph = {r: () for r in selected}
    elif t.kind == "ANOMALY":
        if requested - {"A01", "A05", "A06", "A17"}:
            raise ResearchRejected
        graph = {r: () for r in requested | {"A06"} if r != "A17"}
        graph["A17"] = tuple(sorted(graph))
    elif t.kind == "POSTMORTEM":
        if requested - {"A16", "A17", "A18"}:
            raise ResearchRejected
        graph = {"A16": ()}
        if "A17" in requested:
            graph["A17"] = ("A16",)
        graph["A18"] = tuple(graph)
    else:
        if requested - {f"A{i:02}" for i in range(1, 17)}:
            raise ResearchRejected
        bilateral = t.mode != "FAST" or t.kind == "CONTRADICTION"
        graph = {"A01": (), "A02": ()} if bilateral else {"A01": (), "A07": ()}
        for r in sorted(requested & {"A02", "A03", "A04", "A05", "A06", "A07"}):
            graph[r] = ()
        if bilateral or requested & {"A08", "A09"}:
            roots = tuple(sorted(graph))
            graph.update(A08=roots, A09=roots)
            graph["A12"] = ("A08", "A09")
        else:
            graph["A12"] = tuple(sorted(graph))
        reviews = ("A08", "A09", "A12") if "A08" in graph else ("A12",)
        graph.update(A10=reviews, A15=reviews)
        extras = tuple(sorted(requested & {"A11", "A14", "A16"}))
        graph.update({r: ("A12",) for r in extras})
        graph["A13"] = ("A10", "A15", *extras)
    ordered: list[RoleNodeV1] = []
    done: set[str] = set()
    while len(done) < len(graph):
        ready = sorted(r for r, deps in graph.items() if r not in done and set(deps) <= done)
        if not ready:
            raise ResearchRejected
        ordered.extend(RoleNodeV1(role_id=r, depends_on=graph[r]) for r in ready)
        done.update(ready)
    return tuple(ordered)


def _subject(t: ResearchTriggerV1) -> c.PlanRevision | PublicSubjectV1:
    if t.plan is not None:
        return t.plan
    assert t.public_subject is not None
    return t.public_subject


def _instrument(t: ResearchTriggerV1) -> c.InstrumentProfile:
    subject = _subject(t)
    if subject.instrument is None:
        raise ResearchRejected
    return subject.instrument


def _body(m: JobManifestV1) -> str:
    return digest_text(encode(m.model_dump(mode="json", exclude={"manifest_sha256"})))


def _check_manifest(value: object) -> JobManifestV1:
    m = _valid(value, JobManifestV1)
    if m.manifest_sha256 != _body(m) or m.nodes != _graph(m.trigger):
        raise ResearchRejected("BINDING_MISMATCH")
    if m.subject_sha256 != _hash(_subject(m.trigger)):
        raise ResearchRejected("BINDING_MISMATCH")
    _check_context(m)
    return m


def _check_context(m: JobManifestV1) -> None:
    t, p = m.trigger, m.policy
    if t.public_subject is not None:
        if (
            type(m.visibility) is not PublicScope
            or m.principal_id != "platform-public-research"
            or t.kind != "FACTS"
            or {n.role_id for n in m.nodes} - {"A01", "A02"}
        ):
            raise ResearchRejected("DENIED")
        binding = c.PrivateBinding(
            tenant_id="platform", account_id="public-research", environment="OFFLINE"
        )
    else:
        assert t.plan is not None
        binding = t.plan.binding
        if (
            type(m.visibility) is not PrivateScope
            or (
                m.visibility.tenant_id,
                m.visibility.account_scope_id,
                m.visibility.principal_scope_id,
            )
            != (binding.tenant_id, binding.account_id, m.principal_id)
            or binding.environment != "OFFLINE"
            or t.plan.spec.identity.kind != "S03_ORIGINAL"
        ):
            raise ResearchRejected("DENIED")
    instrument = _instrument(t)
    if (instrument.base, instrument.product) != ("BTC", "SPOT"):
        raise ResearchRejected("DENIED")
    for e in t.evidence:
        if type(m.visibility) is PublicScope and (
            e.source.classification != "PUBLIC" or not e.source.share_allowed
        ):
            raise ResearchRejected("DENIED")
        if e.source.binding is not None and e.source.binding != binding:
            raise ResearchRejected("DENIED")
    for model in p.models:
        if model.role_id in {n.role_id for n in m.nodes} and (
            (type(m.visibility) is PublicScope and model.funding != "PLATFORM")
            or (model.funding == "BYOK" and model.key_owner_id != m.principal_id)
        ):
            raise ResearchRejected("DENIED")


def compile_manifest(
    principal: Principal,
    trigger: ResearchTriggerV1,
    policy_snapshot: PolicySnapshotV1,
) -> JobManifestV1:
    """Accept a server-selected Principal, never request identity dictionaries."""
    from stark_trading_os.control.astarter.strategy_repository import ScopeAssignment
    from stark_trading_os.control.postgres.identity import Principal

    t, p = _valid(trigger, ResearchTriggerV1), _valid(policy_snapshot, PolicySnapshotV1)
    if (
        type(principal) is not Principal
        or type(principal.role) is not str
        or principal.role != "writer"
        or type(principal.subject) is not str
    ):
        raise ResearchRejected("DENIED")
    assignment = canonical(principal.scope, ScopeAssignment, extra=(*_TYPES, ScopeAssignment))
    public = t.public_subject is not None
    visibility: PublicScope | PrivateScope
    if public:
        b = assignment.binding
        if (
            (principal.subject, b.tenant_id, b.account_id, b.environment)
            != ("platform-public-research", "platform", "public-research", "OFFLINE")
            or t.kind != "FACTS"
            or set(t.requested_roles) - {"A01", "A02"}
        ):
            raise ResearchRejected("DENIED")
        visibility = PublicScope()
    else:
        if t.plan is None or t.plan.binding != assignment.binding:
            raise ResearchRejected("DENIED")
        if t.plan.binding.environment != "OFFLINE" or t.plan.spec.identity.kind != "S03_ORIGINAL":
            raise ResearchRejected("DENIED")
        visibility = PrivateScope(
            tenant_id=assignment.binding.tenant_id,
            principal_scope_id=principal.subject,
            account_scope_id=assignment.binding.account_id,
        )
    selected = _graph(t)
    m = JobManifestV1(
        principal_id=principal.subject,
        visibility=visibility,
        trigger=t,
        policy=p,
        subject_sha256=_hash(_subject(t)),
        nodes=selected,
        manifest_sha256="0" * 64,
    )
    return _check_manifest(m.model_copy(update={"manifest_sha256": _body(m)}))


def _usable(m: JobManifestV1, now: int) -> bool:
    if len(m.trigger.evidence) + max((len(n.depends_on) for n in m.nodes), default=0) > 8:
        return False
    if m.trigger.plan is not None and not (
        m.trigger.plan.starts_at_ms <= now < m.trigger.plan.expires_at_ms
    ):
        return False
    if m.trigger.plan is not None and any(
        c.contract_hash(e.source) not in m.trigger.plan.evidence_sha256s for e in m.trigger.evidence
    ):
        return False
    instrument = _instrument(m.trigger)
    return bool(m.trigger.evidence) and all(
        e.egress_allowed
        and e.source.origin == "SYNTHETIC_REFERENCE"
        and e.source.status == "PASS"
        and e.source.coverage == "COMPLETE_REFERENCE"
        and e.source.use_allowed
        and e.source.received_at_ms <= now < min(e.source.expires_at_ms, e.source.rights_until_ms)
        and now - e.source.window_end_ms <= e.source.max_age_ms
        and e.source.subject_sha256 == c.contract_hash(instrument)
        and (e.source.source_venue, e.source.source_instrument_id, e.source.source_product)
        == (instrument.venue, instrument.native_id, instrument.product)
        for e in m.trigger.evidence
    )


def _prepare(m: JobManifestV1, node: RoleNodeV1, refs: dict[str, RoleReportV1]) -> ReadyRoleV1:
    model = next(x for x in m.policy.models if x.role_id == node.role_id)
    evidence: list[Evidence] = []
    bindings: list[EvidenceBinding] = []
    for item in m.trigger.evidence:
        s = item.source
        end = min(s.expires_at_ms, s.rights_until_ms)
        evidence.append(
            Evidence(
                evidence_id=s.evidence_id,
                text=item.text,
                available_at_ms=s.available_at_ms,
                valid_until_ms=end,
            )
        )
        bindings.append(
            EvidenceBinding(
                evidence_id=s.evidence_id,
                utf8_sha256=s.content_sha256,
                source_id=s.source_id,
                source_revision=s.source_revision,
                evidence_revision=s.profile_revision,
                rights_revision=s.rights_revision,
                available_at_ms=s.available_at_ms,
                valid_until_ms=end,
                classification=s.classification,
                use_allowed=s.use_allowed,
                share_allowed=s.share_allowed,
                egress_allowed=item.egress_allowed,
            )
        )
    dependencies = tuple(refs[r].artifact for r in node.depends_on)
    for role, artifact in zip(node.depends_on, dependencies, strict=True):
        key, text = "q08.dep." + role, artifact.output.summary
        evidence.append(
            Evidence(
                evidence_id=key,
                text=text,
                available_at_ms=artifact.created_at_ms,
                valid_until_ms=artifact.use_until_ms,
            )
        )
        bindings.append(
            EvidenceBinding(
                evidence_id=key,
                utf8_sha256=digest_text(text),
                source_id="q08-role-" + role,
                source_revision=artifact.output_sha256,
                evidence_revision=ROLE_SEMANTICS_REVISION,
                rights_revision=m.policy.revision,
                available_at_ms=artifact.created_at_ms,
                valid_until_ms=artifact.use_until_ms,
                classification=m.visibility.visibility,
                use_allowed=True,
                share_allowed=m.visibility.visibility == "PUBLIC",
                egress_allowed=True,
            )
        )
    ident = digest_text(m.manifest_sha256 + node.role_id)
    instrument = _instrument(m.trigger)
    private = m.visibility if type(m.visibility) is PrivateScope else None
    req = prepare_fixture(
        dict(
            identity=dict(
                logical_request_id=m.trigger.logical_request_id,
                task_id="q08-task-" + ident,
                attempt_id="q08-attempt-" + ident,
                parent_attempt_id=None,
                tenant_id=private.tenant_id if private else "platform",
                principal_scope_id=m.principal_id,
                account_scope_id=private.account_scope_id if private else "public-research",
                key_owner_id=model.key_owner_id,
                credential_binding_revision=model.credential_binding_revision,
                purpose="OFFLINE_FIXTURE",
            ),
            task=dict(
                task_id="q08-task-" + ident,
                role_id=node.role_id,
                profile_version=model.profile_version,
                evidence=tuple(e.model_dump() for e in evidence),
            ),
            bindings=tuple(b.model_dump() for b in bindings),
            policy=model.policy.model_dump(),
            quote=model.quote.model_dump(),
            context=dict(
                asset=instrument.base,
                venue=instrument.venue,
                market=instrument.product,
                strategy_revision=m.trigger.plan.revision
                if m.trigger.plan
                else m.trigger.public_subject.strategy_revision,  # type: ignore[union-attr]
                classification=m.visibility.visibility,
                funding=model.funding,
                sharing_revision=m.policy.revision,
                use_policy_revision=m.policy.revision,
            ),
            enqueued_at_ms=m.policy.now_ms,
            deadline_ms=m.policy.deadline_ms,
            clock_epoch=m.policy.clock_epoch,
        )
    )
    reuse = digest_text(
        encode(
            dict(
                legacy=semantic_key(req),
                subject=m.subject_sha256,
                semantics=ROLE_SEMANTICS_REVISION,
                payer_scope=model.funding,
                key_owner=model.key_owner_id,
                credential_revision=model.credential_binding_revision,
                role_configuration=model.model_dump(mode="json", exclude={"quote"}),
            )
        )
    )
    return ReadyRoleV1(
        role_id=node.role_id,
        request=req,
        reuse_key=reuse,
        input_artifact_sha256s=tuple(_hash(a) for a in dependencies),
    )


def _references(
    m: JobManifestV1,
    values: tuple[RoleReportV1, ...],
    now: int,
    public_facts: tuple[PublicFactReferenceV1, ...] = (),
) -> dict[str, RoleReportV1]:
    if type(values) is not tuple or len(values) > 18:
        raise ResearchRejected
    all_refs = tuple(_valid(v, RoleReportV1) for v in values)
    refs = {r.role_id: r for r in all_refs}
    if len(refs) != len(all_refs) or not set(refs) <= {n.role_id for n in m.nodes}:
        raise ResearchRejected("BINDING_MISMATCH")
    if type(public_facts) is not tuple or len(public_facts) > 2:
        raise ResearchRejected("BINDING_MISMATCH")
    for value in public_facts:
        fact = _valid(value, PublicFactReferenceV1)
        source, report = _check_manifest(fact.manifest), fact.report
        role = report.role_id
        consumer_model = next((x for x in m.policy.models if x.role_id == role), None)
        source_model = next((x for x in source.policy.models if x.role_id == role), None)
        if (
            m.visibility.visibility != "PRIVATE"
            or source.visibility.visibility != "PUBLIC"
            or source.trigger.kind != "FACTS"
            or role not in {"A01", "A02"}
            or role in refs
            or not any(n.role_id == role and not n.depends_on for n in m.nodes)
            or _instrument(source.trigger) != _instrument(m.trigger)
            or source.policy.revision != m.policy.revision
            or source.policy.clock_epoch != m.policy.clock_epoch
            or consumer_model is None
            or source_model is None
            or source_model.model_dump(exclude={"quote"})
            != consumer_model.model_dump(exclude={"quote"})
            or not set(_hash(e) for e in source.trigger.evidence)
            <= set(_hash(e) for e in m.trigger.evidence)
            or not _usable(source, now)
            or not source.policy.now_ms
            <= now
            < min(
                source.policy.deadline_ms,
                source.policy.quote.valid_until_ms,
                source_model.quote.valid_until_ms,
                source_model.policy.valid_until_ms,
            )
        ):
            raise ResearchRejected("BINDING_MISMATCH")
        _references(source, (report,), now)
        refs[role] = report
    for node in m.nodes:
        if node.role_id not in {x.role_id for x in all_refs}:
            continue
        r = refs[node.role_id]
        if not set(node.depends_on) <= refs.keys():
            raise ResearchRejected("BINDING_MISMATCH")
        prepared = _prepare(m, node, refs)
        check_artifact(prepared.request, r.artifact, now_ms=now, clock_epoch=m.policy.clock_epoch)
        available = max(x.available_at_ms for x in prepared.request.spec.bindings)
        if r.artifact.created_at_ms < available:
            raise ResearchRejected("INVALID_OUTPUT")
        _check_observation(m, prepared, r, available)
        if (
            r.manifest_sha256 != m.manifest_sha256
            or r.reuse_key != prepared.reuse_key
            or r.input_artifact_sha256s != prepared.input_artifact_sha256s
            or (r.origin == "FRESH" and r.request_sha256 != request_digest(prepared.request))
            or (r.artifact.output.stance == "WAIT" and r.outcome == "PASS")
        ):
            raise ResearchRejected("BINDING_MISMATCH")
    return refs


def _check_observation(
    m: JobManifestV1,
    prepared: ReadyRoleV1,
    report: RoleReportV1,
    available: int,
) -> None:
    if report.observation is None:
        if report.origin == "FRESH":
            raise ResearchRejected("INVALID_OUTPUT")
        return
    charge = report.observation.charge
    if report.origin == "CACHE" and charge is not None:
        raise ResearchRejected("INVALID_OUTPUT")
    model = report.observation.model_result
    spec = prepared.request.spec
    binding = next(x for x in m.policy.models if x.role_id == prepared.role_id)
    if (
        model.status != "OK"
        or model.purpose != "OFFLINE_FIXTURE"
        or model.attempts != 1
        or model.role_id != spec.task.role_id
        or model.profile_version != spec.task.profile_version
        or model.requested_model != spec.policy.model
        or model.returned_model != spec.policy.model
        or model.returned_provider not in spec.policy.providers
        or model.output != report.artifact.output
        or model.response_id is None
        or model.response_sha256 is None
        or not available
        <= model.started_at_ms
        <= model.completed_at_ms
        <= report.artifact.created_at_ms
        or model.completed_at_ms - model.started_at_ms > binding.max_latency_ms
        or (
            report.origin == "FRESH"
            and (model.task_id != spec.task.task_id or model.started_at_ms < spec.enqueued_at_ms)
        )
    ):
        raise ResearchRejected("INVALID_OUTPUT")
    if charge is not None and (
        charge.task_id != spec.identity.task_id
        or charge.attempt_id != spec.identity.attempt_id
        or charge.key_owner_id != spec.identity.key_owner_id
        or charge.provider not in spec.policy.providers
        or charge.provider != model.returned_provider
        or charge.request_id != model.response_id
    ):
        raise ResearchRejected("BINDING_MISMATCH")


def plan_ready_roles(
    manifest: JobManifestV1,
    verified_refs: tuple[RoleReportV1, ...],
    *,
    now_ms: int,
    public_facts: tuple[PublicFactReferenceV1, ...] = (),
) -> ReadyRolesV1:
    """Return at most two proposals; repeated calls do not claim or spend anything."""
    m = _check_manifest(manifest)
    if type(now_ms) is not int or not m.policy.now_ms <= now_ms <= 253402300799999:
        raise ResearchRejected("CLOCK_INVALID")
    if m.trigger.kind == "FAST_EVENT":
        if verified_refs or public_facts:
            raise ResearchRejected
        return ReadyRolesV1(status="FAST_PATH", reasons=("ZERO_LLM_FAST_PATH",))
    # Validate explicit cross-job inputs even if the consumer itself must wait.
    refs = _references(m, verified_refs, now_ms, public_facts) if public_facts else None
    models = {x.role_id: x for x in m.policy.models}
    if not {n.role_id for n in m.nodes} <= models.keys() or not _usable(m, now_ms):
        return ReadyRolesV1(status="WAIT_DATA", reasons=("INPUT_OR_MODEL_BINDING_UNUSABLE",))
    ends = [m.policy.deadline_ms, m.policy.quote.valid_until_ms]
    if m.trigger.plan is not None:
        ends.append(m.trigger.plan.expires_at_ms)
    ends.extend(
        min(models[n.role_id].policy.valid_until_ms, models[n.role_id].quote.valid_until_ms)
        for n in m.nodes
    )
    if now_ms >= min(ends):
        return ReadyRolesV1(status="WAIT_DATA", reasons=("EXPIRED_FROZEN_SNAPSHOT",))
    refs = _references(m, verified_refs, now_ms) if refs is None else refs
    if any(r.outcome == "BLOCK" for r in refs.values()):
        return ReadyRolesV1(status="BLOCKED", reasons=("ROLE_OBJECTION",))
    if any(r.outcome == "WAIT" for r in refs.values()):
        return ReadyRolesV1(status="WAIT_DATA", reasons=("ROLE_WAIT",))
    pending = tuple(n.role_id for n in m.nodes if n.role_id not in refs)
    cap = {"FAST": 6, "BALANCED": 8, "ADAPTIVE": 12}[m.trigger.mode]
    fresh = tuple(r.role_id for r in verified_refs if r.origin == "FRESH")
    if (
        len(pending) + len(fresh) > cap
        or sum(models[r].quote.reserve_atoms for r in (*pending, *fresh))
        > m.policy.quote.reserve_atoms
    ):
        return ReadyRolesV1(status="WAIT_BUDGET", reasons=("REQUOTE_REQUIRED",), pending=pending)
    if not pending:
        return ReadyRolesV1(status="COMPLETE", reasons=("REFERENCE_RESULTS_COMPLETE",))
    ready = tuple(
        _prepare(m, n, refs)
        for n in m.nodes
        if n.role_id in pending and set(n.depends_on) <= refs.keys()
    )[:2]
    return ReadyRolesV1(
        status="RUNNABLE", reasons=("PROPOSAL_ONLY_NO_PERMIT",), roles=ready, pending=pending
    )


def _decision(
    m: JobManifestV1,
    status: DecisionStatus,
    reasons: tuple[str, ...],
    missing_roles: tuple[str, ...] = (),
) -> ResearchDecision:
    return ResearchDecision(
        research_kind=m.trigger.kind,
        result_level=_result_level(m.trigger.kind),
        status=status,
        reasons=reasons,
        missing_roles=missing_roles,
    )


def check_bundle(
    bundle: ResearchBundleV1,
    manifest: JobManifestV1,
    *,
    now_ms: int,
    public_facts: tuple[PublicFactReferenceV1, ...] = (),
) -> ResearchDecision:
    m, b = _check_manifest(manifest), _valid(bundle, ResearchBundleV1)
    if b.manifest_sha256 != m.manifest_sha256:
        raise ResearchRejected("BINDING_MISMATCH")
    if m.trigger.kind not in _FULL and (b.abc is not None or b.approval is not None):
        raise ResearchRejected("DENIED")
    ready = plan_ready_roles(m, b.reports, now_ms=now_ms, public_facts=public_facts)
    if ready.status in {"FAST_PATH", "WAIT_DATA", "WAIT_BUDGET", "BLOCKED"}:
        return _decision(m, status=ready.status, reasons=ready.reasons)
    if ready.status != "COMPLETE":
        return _decision(
            m, status="WAIT_DATA", reasons=("ROLE_RESULTS_MISSING",), missing_roles=ready.pending
        )
    if b.disposition == "BLOCKED":
        return _decision(m, status="BLOCKED", reasons=("BUNDLE_BLOCKED",))
    if b.disposition == "WAIT":
        return _decision(m, status="WAIT_DATA", reasons=("BUNDLE_WAIT",))
    if m.trigger.kind in _FULL:
        allowed = {e.source.evidence_id for e in m.trigger.evidence}
        if (
            b.abc is None
            or b.abc.subject_sha256 != m.subject_sha256
            or any(not set(x.evidence_ids) <= allowed for x in b.abc.branches)
        ):
            return _decision(m, status="BLOCKED", reasons=("ABC_DRAFT_REQUIRED",))
        if b.disposition == "NO_TRADE":
            return _decision(m, status="NO_TRADE", reasons=("VALID_RESEARCH_NO_TRADE",))
        if b.approval is None or b.approval.issuer_reference != m.policy.fixture_issuer_reference:
            return _decision(
                m,
                status="WAIT_REVIEW",
                reasons=("PRIVATE_REFERENCE_REQUIRED",),
                missing_roles=c.S03_DUTIES,
            )
        assert m.trigger.plan is not None
        coverage = c.check_approval(m.trigger.plan, b.approval, now_ms=now_ms)
        if coverage.status != "ELIGIBLE":
            return _decision(
                m,
                status="WAIT_REVIEW",
                reasons=coverage.reasons,
                missing_roles=coverage.missing_roles,
            )
    elif b.approval is not None:
        raise ResearchRejected("DENIED")
    if b.disposition == "NO_TRADE":
        return _decision(m, status="NO_TRADE", reasons=("VALID_RESEARCH_NO_TRADE",))
    return _decision(m, status="RESEARCH_READY", reasons=("OFFLINE_REFERENCE_MATCH_ONLY",))
