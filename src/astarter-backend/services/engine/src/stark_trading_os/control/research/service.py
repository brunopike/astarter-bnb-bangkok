"""Finite stub orchestration; all durable authority stays in the existing DAL.

Construct only in a trusted offline composition root. An injected executor is not
a sandbox; this module registers no providers, routes, daemons or trade adapters.
"""

from collections.abc import Callable
from typing import Literal

from stark_trading_os.control.postgres.research_repository import (
    JobRef,
    PostgresResearchRepository,
    WorkflowView,
)
from stark_trading_os.domain import research_jobs as j
from stark_trading_os.integrations.research_egress import ResearchRejected
from stark_trading_os.integrations.research_gate import FixtureExecutor, OfflineResearchGate


class ResearchService:
    def __init__(
        self,
        repository: PostgresResearchRepository,
        *,
        executor: FixtureExecutor,
        clock: Callable[[], tuple[int, str]],
        drafts: tuple[tuple[str, j.ABCDraftV1], ...] = (),
    ) -> None:
        if type(repository) is not PostgresResearchRepository or type(drafts) is not tuple:
            raise ValueError("Q08_SERVICE_CONFIGURATION")
        self._repository = repository
        self._executor, self._clock = executor, clock
        self._drafts = {key: j._valid(draft, j.ABCDraftV1) for key, draft in drafts}
        if len(self._drafts) != len(drafts):
            raise ValueError("Q08_SERVICE_CONFIGURATION")

    async def submit(self, trigger: j.ResearchTriggerV1) -> JobRef:
        return await self._repository.submit_trigger(trigger)

    async def read(self, job_id: str) -> WorkflowView:
        return await self._repository.read_workflow(job_id)

    async def cancel(self, job_id: str, expected_version: int) -> WorkflowView:
        await self._repository.cancel_job(job_id, expected_version)
        return await self.read(job_id)

    async def answer(
        self,
        question_id: str,
        nonce: str,
        choice: Literal["RESUME", "CANCEL"],
        expected_version: int,
    ) -> WorkflowView:
        job_id = await self._repository.answer_question(
            question_id, nonce, choice, expected_version
        )
        return await self.read(job_id)

    async def attach_public(self, job_id: str, source: JobRef, artifact_id: str) -> None:
        # A crash between link and activation leaves a harmless, replayable link.
        await self._repository.attach_public_reference(job_id, source, artifact_id)
        await self._repository.activate_public_reference(job_id, source, artifact_id)

    async def wait_for_public(
        self,
        job_id: str,
        expected_version: int,
        source: JobRef,
        *,
        not_before_ms: int | None = None,
    ) -> WorkflowView:
        await self._repository.wait_for(
            job_id, expected_version, "DATA", public_source=source, not_before_ms=not_before_ms
        )
        return await self.read(job_id)

    async def recover(self, job_id: str, worker: str) -> WorkflowView:
        await self._repository.recover_job(job_id, worker)
        return await self.read(job_id)

    async def review(self, job_id: str, expected_version: int, approval_id: str) -> WorkflowView:
        view = await self.read(job_id)
        await self._repository.evaluate_job(
            job_id,
            expected_version,
            abc=self._drafts.get(view.job.ref.manifest_sha256),
            approval_id=approval_id,
        )
        return await self._wait(await self.read(job_id))

    async def _wait(self, view: WorkflowView) -> WorkflowView:
        if view.job.state not in {"WAIT_DATA", "WAIT_BUDGET", "WAIT_REVIEW"}:
            return view
        kind = _kind(view.job.state)
        if (
            view.question is None
            or view.question.kind != kind
            or (
                view.question_state == "OPEN" and view.question.expected_version != view.job.version
            )
        ):
            try:
                await self._repository.wait_for(view.job.ref.job_id, view.job.version, kind)
            except ResearchRejected as exc:
                if exc.reason != "EXPIRED":
                    raise
            return await self.read(view.job.ref.job_id)
        return view

    async def run_once(self, job_id: str, worker: str) -> WorkflowView:
        """At most one role; callers explicitly schedule later work after WAIT."""
        repo = self._repository
        view = await self.recover(job_id, worker)
        if view.job.state in {"CANCELLED", "UNKNOWN", "FAILED_REFERENCE"}:
            return view
        if view.question is not None and view.answer is None:
            return await self._wait(view)
        if view.job.state != "COMPLETED_REFERENCE":
            claim = await repo.claim_ready(job_id, worker, view.job.version)
            if claim is not None:
                gate = OfflineResearchGate(
                    backend=repo.backend(claim), executor=self._executor, clock=self._clock
                )
                delivery = await gate.run(claim.ready.request)
                if delivery.status != "READY":
                    await repo.park_gate_failure(claim, delivery.reason)
            view = await self.read(job_id)
        if view.job.state in {"WAIT_REVIEW", "COMPLETED_REFERENCE"} and view.bundle is None:
            try:
                await repo.evaluate_job(
                    job_id, view.job.version, abc=self._drafts.get(view.job.ref.manifest_sha256)
                )
            except ResearchRejected as exc:
                if exc.reason not in {"WAITING", "EXPIRED"}:
                    raise
            view = await self.read(job_id)
        return await self._wait(view)


def _kind(state: str) -> Literal["DATA", "BUDGET", "REVIEW"]:
    if state == "WAIT_DATA":
        return "DATA"
    if state == "WAIT_BUDGET":
        return "BUDGET"
    if state == "WAIT_REVIEW":
        return "REVIEW"
    raise ResearchRejected("INVALID_INPUT")
