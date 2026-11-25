"""Read-only analysis contracts over selected sealed backtest evidence."""

from stark_trading_os.agent.evidence_scope import (
    DeterministicRatioRejected,
    EvidenceScope,
    EvidenceScopeBuilder,
    RunEvidenceIntegrityFailed,
    RunEvidenceUnsealed,
    ScopeLookupError,
)
from stark_trading_os.agent.local_review import build_local_review
from stark_trading_os.agent.models import (
    CandidateReview,
    EvidenceManifestV1,
    EvidenceRunV1,
    EvidenceSourceV1,
    ExactValueRef,
    RatioCalculation,
    ReviewCitation,
    ReviewClaim,
    ReviewNotice,
    RunReviewRequest,
    RunReviewResponse,
    StatementOption,
)

__all__ = [
    "CandidateReview",
    "DeterministicRatioRejected",
    "EvidenceManifestV1",
    "EvidenceRunV1",
    "EvidenceScope",
    "EvidenceScopeBuilder",
    "EvidenceSourceV1",
    "ExactValueRef",
    "RatioCalculation",
    "ReviewCitation",
    "ReviewClaim",
    "ReviewNotice",
    "RunEvidenceIntegrityFailed",
    "RunEvidenceUnsealed",
    "RunReviewRequest",
    "RunReviewResponse",
    "ScopeLookupError",
    "StatementOption",
    "build_local_review",
]
