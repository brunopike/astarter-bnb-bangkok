"""No model/client/credential imports; deterministic signed-off SIM fixtures."""

import asyncio
from collections.abc import Callable

from stark_trading_os.domain import research_jobs as j
from stark_trading_os.integrations.contracts import ModelResult, ResearchOutput, Usage
from stark_trading_os.integrations.research_egress import ChargeObservation, digest_text
from stark_trading_os.integrations.research_gate import ExecutionObservation


def invoices(manifest):
    result = []
    for node in manifest.nodes:
        key = digest_text(manifest.manifest_sha256 + node.role_id)
        model = next(m for m in manifest.policy.models if m.role_id == node.role_id)
        result.append(
            ChargeObservation(
                event_id="stub-invoice-" + key,
                provider=model.policy.providers[0],
                task_id="q08-task-" + key,
                attempt_id="q08-attempt-" + key,
                key_owner_id=model.key_owner_id,
                request_id="stub-response-" + key,
                unit_id="SIM_MODEL_CREDIT_V1",
                scale=6,
                atoms=10,
                source_ref="synthetic-invoice",
                source_revision="stub-invoice-v1",
            )
        )
    return tuple(result)


def abc(manifest):
    return j.ABCDraftV1(
        subject_sha256=manifest.subject_sha256,
        branches=tuple(
            j.ABCBranchV1(
                branch=key,
                condition="CURRENT_DATA_REQUIRED",
                invalidation="RISK_LIMITS_REQUIRED",
                response=response,
                explanation="Synthetic ABC draft; no execution or forecast.",
                evidence_ids=(manifest.trigger.evidence[0].source.evidence_id,),
            )
            for key, response in (
                ("A", "ENTRY_GATES_REQUIRED"),
                ("B", "STRATEGY_EXIT_SOURCE_RULES"),
                ("C", "PAUSE_NEW_RISK_KEEP_PROTECTION"),
            )
        ),
    )


class StubResearchExecutor:
    def __init__(self, *, clock: Callable[[], int], lose_role=None, wait_role=None):
        self.clock = clock
        self.lose_role, self.wait_role = lose_role, wait_role
        self.requests = []
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.block = False

    async def execute_once(self, request, permit, timeout_seconds):
        assert permit.receipt.state == "DISPATCH_STARTED" and timeout_seconds > 0
        self.requests.append(request)
        self.entered.set()
        if self.block:
            await self.release.wait()
        if request.spec.task.role_id == self.lose_role:
            raise ConnectionError("fixture interruption")
        now = self.clock()
        task, identity, policy = request.spec.task, request.spec.identity, request.spec.policy
        # Invoice identities are manifest-role digests, independent of returned text.
        key = identity.task_id.removeprefix("q08-task-")
        output = ResearchOutput(
            stance="WAIT" if task.role_id == self.wait_role else "REVIEW",
            summary="Synthetic research " + task.role_id,
            evidence_ids=tuple(e.evidence_id for e in task.evidence),
        )
        model = ModelResult(
            status="OK",
            task_id=task.task_id,
            role_id=task.role_id,
            profile_version=task.profile_version,
            requested_model=policy.model,
            returned_model=policy.model,
            returned_provider=policy.providers[0],
            response_id="stub-response-" + key,
            response_sha256=digest_text(output.summary),
            purpose="OFFLINE_FIXTURE",
            attempts=1,
            started_at_ms=now,
            completed_at_ms=now,
            usage=Usage(status="REPORTED", cost_credits="0"),
            output=output,
        )
        charge = ChargeObservation(
            event_id="stub-invoice-" + key,
            provider=policy.providers[0],
            task_id=task.task_id,
            attempt_id=identity.attempt_id,
            key_owner_id=identity.key_owner_id,
            request_id=model.response_id,
            unit_id="SIM_MODEL_CREDIT_V1",
            scale=6,
            atoms=10,
            source_ref="synthetic-invoice",
            source_revision="stub-invoice-v1",
        )
        return ExecutionObservation(
            model_result=model, charge=charge, scenario_revision="stub-scenario-v1"
        )
