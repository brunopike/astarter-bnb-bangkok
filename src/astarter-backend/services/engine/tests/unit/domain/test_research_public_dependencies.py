"""Public facts remain public inputs, never private role reports or charges."""

import pytest

from stark_trading_os.domain import research_jobs as j
from stark_trading_os.integrations.research_egress import ResearchRejected
from tests.unit.domain.test_research_jobs import changed, manifest, next_reports, principal


def public_facts():
    source = manifest(public=True, kind="FACTS")
    assert hasattr(j, "PublicFactReferenceV1"), "explicit public dependencies missing"
    return tuple(j.PublicFactReferenceV1(manifest=source, report=r) for r in next_reports(source))


def test_public_dependencies_unlock_only_private_arguments_without_relabel():
    private = manifest()
    facts = public_facts()
    ready = j.plan_ready_roles(private, (), now_ms=1000, public_facts=facts)
    assert tuple(r.role_id for r in ready.roles) == ("A08", "A09")
    assert all(f.report.artifact.descriptor.scope.visibility == "PUBLIC" for f in facts)
    for role in ready.roles:
        assert role.request.spec.context.classification == "PRIVATE"
        assert {e.evidence_id for e in role.request.spec.task.evidence} == {
            "fixture-MARKET_WINDOW",
            "q08.dep.A01",
            "q08.dep.A02",
        }


@pytest.mark.parametrize("damage", ["private", "credential", "instrument", "expired", "duplicate"])
def test_public_dependency_compatibility_cannot_skip_existing_boundaries(damage):
    private = manifest()
    facts = public_facts()
    if damage == "private":
        facts = (j.PublicFactReferenceV1(manifest=private, report=next_reports(private)[0]),)
    elif damage == "credential":
        p = private.policy
        models = tuple(changed(m, credential_binding_revision="new-key") for m in p.models)
        private = j.compile_manifest(
            principal(),
            private.trigger,
            changed(p, models=models),
        )
    elif damage == "instrument":
        t = private.trigger
        plan = changed(t.plan, instrument=changed(t.plan.instrument, native_id="BTC-OTHER"))
        private = j.compile_manifest(principal(), changed(t, plan=plan), private.policy)
    elif damage == "duplicate":
        facts = (facts[0], facts[0])
    with pytest.raises(ResearchRejected):
        j.plan_ready_roles(
            private, (), now_ms=5001 if damage == "expired" else 1000, public_facts=facts
        )
