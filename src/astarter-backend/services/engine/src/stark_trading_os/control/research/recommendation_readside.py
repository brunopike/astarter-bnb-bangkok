"""Explicit PUBLIC publication reads; no persistent head, workers or new research.

The composition root supplies a bounded, immutable publication catalog. Current
evidence and job state still come from the original authorized ResearchService.
"""

from collections.abc import Callable

from stark_trading_os.control.research.opportunity_reader import read_recommendation
from stark_trading_os.control.research.service import ResearchService
from stark_trading_os.domain import opportunity_recommendations as r
from stark_trading_os.integrations.research_delivery import PublicScope
from stark_trading_os.integrations.research_egress import canonical


class RecommendationNotFound(LookupError):
    """The exact server-registered publication/version is absent."""


class RecommendationReadSide:
    def __init__(
        self,
        service: ResearchService,
        publications: tuple[r.StrategyRecommendationV1, ...],
        *,
        clock_ms: Callable[[], int],
    ) -> None:
        if (
            type(service) is not ResearchService
            or type(publications) is not tuple
            or len(publications) > 50
            or not callable(clock_ms)
        ):
            raise ValueError("RECOMMENDATION_CONFIGURATION")
        rows = tuple(
            canonical(row, r.StrategyRecommendationV1, extra=r._TYPES) for row in publications
        )
        if len({row.recommendationId for row in rows}) != len(rows) or any(
            type(row.candidate.visibility) is not PublicScope
            or type(row.context.visibility) is not PublicScope
            or row.candidate.sourceRef.type != "research"
            or row.candidate.sourceRef.sourceId != "astarter-research-dal"
            or row.candidate.sourceRef.taskId is None
            for row in rows
        ):
            raise ValueError("RECOMMENDATION_CONFIGURATION")
        self._rows = tuple(sorted(rows, key=lambda row: row.recommendationId))
        self._service, self._clock = service, clock_ms

    def _now(self) -> int:
        now = self._clock()
        if type(now) is not int or not 0 <= now <= 253402300799999:
            raise ValueError("RECOMMENDATION_CLOCK")
        return now

    async def _read(self, row: r.StrategyRecommendationV1, now: int) -> dict[str, object]:
        if now < row.publishedAt:
            raise ValueError("RECOMMENDATION_CLOCK")
        job_id = row.candidate.sourceRef.taskId
        assert job_id is not None
        current = await read_recommendation(
            self._service,
            job_id=job_id,
            candidate=row.candidate,
            context=row.context,
            now_ms=now,
        )
        return r.to_wire(row, current.context, current_candidate=current.candidate, now_ms=now)

    async def list(self) -> tuple[dict[str, object], ...]:
        now = self._now()
        return tuple([await self._read(row, now) for row in self._rows])

    async def read(self, identifier: str, revision: str) -> dict[str, object]:
        row = next(
            (
                row
                for row in self._rows
                if row.recommendationId == identifier and row.revision == revision
            ),
            None,
        )
        if row is None:
            raise RecommendationNotFound("RECOMMENDATION_NOT_FOUND")
        return await self._read(row, self._now())
