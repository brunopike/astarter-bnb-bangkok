"""R1 explicit, read-only projection over ResearchService and its existing DAL.

No route/worker is registered and no research is submitted, recovered or executed.
The existing offline repository remains the authority for scope and reads.
"""

from typing import Literal

from stark_trading_os.control.postgres import research_repository as repository
from stark_trading_os.control.research.service import ResearchService
from stark_trading_os.domain import opportunity_recommendations as r
from stark_trading_os.domain import research_jobs as j
from stark_trading_os.integrations.research_delivery import PrivateScope, PublicScope
from stark_trading_os.integrations.research_egress import (
    ResearchRejected,
    canonical,
    digest_text,
    encode,
)


def _evidence(
    manifest: j.JobManifestV1,
    clock: r.ClockRefV1,
) -> tuple[r.RecommendationEvidenceV1, ...]:
    instrument = j._instrument(manifest.trigger)
    result = []
    for fact in manifest.trigger.evidence:
        source = fact.source
        if (source.source_instrument_id, source.source_venue, source.source_product) != (
            instrument.native_id,
            instrument.venue,
            instrument.product,
        ):
            raise ResearchRejected("BINDING_MISMATCH")
        visibility = PublicScope() if source.classification == "PUBLIC" else manifest.visibility
        quality = "unknown"
        if source.status == "PASS" and source.origin == "SYNTHETIC_REFERENCE":
            quality = "fresh" if source.coverage == "COMPLETE_REFERENCE" else "partial"
        result.append(
            r.RecommendationEvidenceV1.model_validate(
                dict(
                    evidenceId=source.evidence_id,
                    dataKind=source.name,
                    instrument=instrument,
                    sourceRef=r.SourceRefV1(
                        type="research",
                        sourceId=source.source_id,
                        revision=source.source_revision,
                        recordId=source.evidence_id,
                        taskId=manifest.trigger.job_id,
                    ),
                    rawHash=None,
                    contentHash=source.content_sha256,
                    clock=r.SourceClockV1(
                        clockRef=clock,
                        eventAt=source.event_at_ms,
                        receivedAt=source.received_at_ms,
                        availableAt=source.available_at_ms,
                        validUntil=source.expires_at_ms,
                        windowStart=source.window_start_ms,
                        windowEnd=source.window_end_ms,
                        confirmedAt=None,
                        availabilityKind="SOURCE",
                        maxAgeMs=source.max_age_ms,
                    ),
                    visibility=visibility,
                    rightsUntil=source.rights_until_ms,
                    useAllowed=source.use_allowed,
                    shareAllowed=source.share_allowed,
                    funding=source.funding,
                    coverage={
                        "COMPLETE_REFERENCE": "complete",
                        "INCOMPLETE": "partial",
                        "UNKNOWN": "unknown",
                    }[source.coverage],
                    quality=quality,
                )
            )
        )
    return tuple(result)


async def read_recommendation(
    service: ResearchService,
    *,
    job_id: str,
    candidate: object,
    context: object,
    now_ms: int,
) -> r.StrategyRecommendationV1:
    """Perform one authorized DAL read, retaining its original evidence and version."""
    if type(service) is not ResearchService:
        raise ResearchRejected("DENIED")
    item = canonical(candidate, r.RecommendationCandidateV1, extra=r._TYPES)
    ctx = canonical(context, r.RecommendationContextV1, extra=r._TYPES)
    view = canonical(await service.read(job_id), repository.WorkflowView, extra=repository._TYPES)
    manifest = j._check_manifest(view.job.manifest)
    if (
        view.job.ref.job_id != job_id
        or manifest.trigger.job_id != job_id
        or view.job.ref.manifest_sha256 != manifest.manifest_sha256
        or view.job.ref.scope_key != digest_text(encode(manifest.visibility.model_dump()))
    ):
        raise ResearchRejected("BINDING_MISMATCH")
    if (
        manifest.visibility != item.visibility
        or manifest.visibility != ctx.visibility
        or j._instrument(manifest.trigger) != item.instrument
    ):
        raise ResearchRejected("DENIED")
    if type(manifest.visibility) is PrivateScope and (
        manifest.trigger.plan is None
        or manifest.trigger.plan.spec.identity.strategy_id != item.strategy.strategy
    ):
        raise ResearchRejected("BINDING_MISMATCH")
    if ctx.clockRef.ref != manifest.policy.clock_epoch:
        raise ResearchRejected("CLOCK_INVALID")
    state: Literal["READY", "WAIT", "BLOCKED"] = "WAIT"
    if (
        view.job.state in {"CANCELLED", "UNKNOWN", "FAILED_REFERENCE"}
        or not view.job.current_data
        or any(e.source.status == "BLOCK" for e in manifest.trigger.evidence)
    ):
        state = "BLOCKED"
    elif view.bundle is not None and view.job.state == "COMPLETED_REFERENCE":
        try:
            decision = j.check_bundle(
                view.bundle, manifest, now_ms=now_ms, public_facts=view.public_facts
            )
            if decision.status in {"BLOCKED", "NO_TRADE"}:
                state = "BLOCKED"
            elif decision.status == "RESEARCH_READY":
                state = "READY"
        except ResearchRejected as exc:
            if exc.reason != "EXPIRED":
                raise
            state = "BLOCKED"
    profile = r.FitProfileV1.model_validate(
        ctx.profile.model_dump()
        | dict(
            validUntil=min(
                ctx.profile.validUntil,
                manifest.policy.deadline_ms,
                *(m.policy.valid_until_ms for m in manifest.policy.models),
            )
        )
    )
    ctx = r.RecommendationContextV1.model_validate(
        ctx.model_dump()
        | dict(
            profile=profile,
            researchState=state,
        )
    )
    item = r.RecommendationCandidateV1.model_validate(
        item.model_dump()
        | dict(
            sourceRef=r.SourceRefV1(
                type="research",
                sourceId="astarter-research-dal",
                revision=str(view.job.version),
                taskId=job_id,
            ),
            evidence=_evidence(manifest, ctx.clockRef),
        )
    )
    return r.build_recommendation(item, ctx, now_ms=now_ms)
