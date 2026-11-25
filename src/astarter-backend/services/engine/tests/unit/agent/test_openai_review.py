from __future__ import annotations

import inspect
import json
import socket
from dataclasses import FrozenInstanceError, fields
from hashlib import sha256
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from agents import Agent, Runner
from agents.exceptions import ModelBehaviorError
from agents.models.multi_provider import MultiProvider
from agents.tool import FunctionTool
from agents.tool_context import ToolContext

from stark_trading_os.agent import openai_review as openai_review_module
from stark_trading_os.agent.evidence_scope import (
    DeterministicRatioRejected,
    EvidenceScope,
    ScopeLookupError,
    _ArtifactRecord,
    _EventRecord,
)
from stark_trading_os.agent.models import (
    SOURCE_KINDS,
    CandidateReview,
    EvidenceManifestV1,
    EvidenceRunV1,
    EvidenceSourceV1,
    ExactValueRef,
    RatioCalculation,
    ReviewCitation,
    ReviewNotice,
    StatementOption,
)
from stark_trading_os.agent.openai_review import (
    CANDIDATE_MAX_BYTES,
    MODEL_TIMEOUT_SECONDS,
    TOOL_CALL_LIMIT,
    TOOL_ENVELOPE_MAX_BYTES,
    ReviewContractRejected,
    ReviewProposal,
    RunReviewer,
    SensitiveQuestionRejected,
    validate_model_name,
)
from stark_trading_os.audit.canonical_json import canonical_json_bytes


@pytest.fixture(autouse=True)
def _forbid_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def blocked(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("Task 2 tests must not open a network connection.")

    async def blocked_http(*_args: object, **_kwargs: object) -> None:
        blocked()

    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(httpx.AsyncClient, "send", blocked_http)


def _opaque(prefix: str, number: int) -> str:
    return f"{prefix}{number:064x}"


def make_scope(*, marker: str = "sealed", scope_number: int = 1) -> EvidenceScope:
    scope_id = _opaque("scope_", scope_number)
    artifact_records: list[_ArtifactRecord] = []
    sources: list[EvidenceSourceV1] = []
    citations: list[ReviewCitation] = []
    for index, source_kind in enumerate(SOURCE_KINDS, start=1):
        artifact_id = _opaque("art_", scope_number * 100 + index)
        projection = canonical_json_bytes(
            {"marker": marker if source_kind == "METRICS" else "sealed", "source": source_kind}
        )
        artifact_records.append(
            _ArtifactRecord(
                artifact_id=artifact_id,
                role="PRIMARY",
                source_kind=source_kind,
                available=True,
                projection_bytes=projection,
            )
        )
        sources.append(
            EvidenceSourceV1(
                source_kind=source_kind,
                artifact_id=artifact_id,
                available=True,
                raw_sha256=sha256(projection).hexdigest(),
                raw_size_bytes=len(projection),
                projection_sha256=sha256(projection).hexdigest(),
                projection_size_bytes=len(projection),
                coverage="FULL",
                record_count=1,
                sample_count=1,
                omitted_count=0,
            )
        )
        citations.append(
            ReviewCitation(
                citation_id=_opaque("cit_", scope_number * 100 + index),
                scope_id=scope_id,
                kind="ARTIFACT",
                run_role="PRIMARY",
                source_kind=source_kind,
                artifact_id=artifact_id,
                label=f"Primary {source_kind} projection",
            )
        )

    event_id = _opaque("evt_", scope_number)
    event_projection = canonical_json_bytes({"marker": marker, "type": "run.completed"})
    event_citation = ReviewCitation(
        citation_id=_opaque("cit_", scope_number * 100 + 20),
        scope_id=scope_id,
        kind="EVENT",
        run_role="PRIMARY",
        source_kind="EVENTS",
        event_id=event_id,
        label="Primary sealed event projection",
    )
    scope_citation = ReviewCitation(
        citation_id=_opaque("cit_", scope_number * 100 + 21),
        scope_id=scope_id,
        kind="SCOPE_ATTESTATION",
        run_role=None,
        source_kind=None,
        label="Selected sealed evidence scope",
    )
    citations.extend((event_citation, scope_citation))

    metrics_citation_id = citations[SOURCE_KINDS.index("METRICS")].citation_id
    orders_citation_id = citations[SOURCE_KINDS.index("ORDERS")].citation_id
    values = (
        ExactValueRef(
            value_ref_id=_opaque("val_", scope_number * 100 + 1),
            scope_id=scope_id,
            run_role="PRIMARY",
            semantic="START_EQUITY",
            value="100",
            unit="ACCOUNT_CURRENCY",
            currency="USDT",
            citation_id=metrics_citation_id,
            origin="SOURCE",
        ),
        ExactValueRef(
            value_ref_id=_opaque("val_", scope_number * 100 + 2),
            scope_id=scope_id,
            run_role="PRIMARY",
            semantic="END_EQUITY",
            value="110",
            unit="ACCOUNT_CURRENCY",
            currency="USDT",
            citation_id=metrics_citation_id,
            origin="SOURCE",
        ),
        ExactValueRef(
            value_ref_id=_opaque("val_", scope_number * 100 + 3),
            scope_id=scope_id,
            run_role="PRIMARY",
            semantic="ORDER_COUNT",
            value="2",
            unit="COUNT",
            currency=None,
            citation_id=orders_citation_id,
            origin="SOURCE",
        ),
        ExactValueRef(
            value_ref_id=_opaque("val_", scope_number * 100 + 4),
            scope_id=scope_id,
            run_role="PRIMARY",
            semantic="POINT_COUNT",
            value="10",
            unit="COUNT",
            currency=None,
            citation_id=metrics_citation_id,
            origin="SOURCE",
        ),
    )
    statements = (
        StatementOption(
            statement_id=_opaque("stmt_", scope_number * 100 + 1),
            scope_id=scope_id,
            section="OBSERVED_FACT",
            text="The sealed run finished with end equity 110 USDT.",
            citation_ids=(metrics_citation_id,),
            value_ref_ids=(values[1].value_ref_id,),
            run_role="PRIMARY",
        ),
        StatementOption(
            statement_id=_opaque("stmt_", scope_number * 100 + 2),
            scope_id=scope_id,
            section="OBSERVED_FACT",
            text="The sealed run contains two orders.",
            citation_ids=(orders_citation_id,),
            value_ref_ids=(values[2].value_ref_id,),
            run_role="PRIMARY",
        ),
        StatementOption(
            statement_id=_opaque("stmt_", scope_number * 100 + 3),
            scope_id=scope_id,
            section="INFERENCE",
            text="The selected evidence supports only a backtest interpretation.",
            citation_ids=(scope_citation.citation_id,),
            run_role=None,
        ),
        StatementOption(
            statement_id=_opaque("stmt_", scope_number * 100 + 4),
            scope_id=scope_id,
            section="RISK",
            text="No execution or live-market capability is available.",
            citation_ids=(scope_citation.citation_id,),
            run_role=None,
        ),
    )
    notice = ReviewNotice(
        notice_id=_opaque("stmt_", scope_number * 100 + 30),
        kind="LIMITATION",
        text="The reviewer sees only selected sealed evidence.",
        citation_ids=(scope_citation.citation_id,),
    )
    manifest = EvidenceManifestV1(
        scope_id=scope_id,
        runs=(
            EvidenceRunV1(
                role="PRIMARY",
                terminal_state="COMPLETED",
                state_version=5,
                last_visible_seq=1,
                terminal_event_seq=1,
                materialized_event_seq=1,
                materialized_audit_seq=1,
                published_at_ns=22,
                seal_digest=f"{scope_number:064x}",
                sources=tuple(sources),
            ),
        ),
    )
    return EvidenceScope(
        manifest=manifest,
        citations=tuple(citations),
        value_refs=values,
        statement_options=statements,
        notices=(notice,),
        allowed_ratio_pairs=(
            (values[1].value_ref_id, values[0].value_ref_id),
            (values[3].value_ref_id, values[2].value_ref_id),
        ),
        retained_size_bytes=1_024,
        _artifact_records=tuple(artifact_records),
        _event_records=(
            _EventRecord(
                event_id=event_id,
                role="PRIMARY",
                projection_bytes=event_projection,
            ),
        ),
    )


def make_candidate(
    scope: EvidenceScope, *, calculation_ids: tuple[str, ...] = ()
) -> CandidateReview:
    facts = tuple(
        statement.statement_id
        for statement in scope.statement_options
        if statement.section == "OBSERVED_FACT"
    )
    inferences = tuple(
        statement.statement_id
        for statement in scope.statement_options
        if statement.section == "INFERENCE"
    )
    risks = tuple(
        statement.statement_id
        for statement in scope.statement_options
        if statement.section == "RISK"
    )
    return CandidateReview(
        scope_id=scope.scope_id,
        observed_fact_ids=facts,
        calculation_ids=calculation_ids,
        inference_ids=inferences,
        risk_ids=risks,
    )


def _context(tool: FunctionTool, arguments: str, *, index: int = 1) -> ToolContext[Any]:
    return ToolContext(
        context=None,
        tool_name=tool.name,
        tool_call_id=f"call-{index}",
        tool_arguments=arguments,
    )


@pytest.mark.asyncio
async def test_reviewer_builds_one_closed_agent_and_returns_utf8_tool_envelopes() -> None:
    scope = make_scope(marker="projection-secret-needle")
    captured: dict[str, object] = {}

    async def fake_runner(
        agent: Agent[Any],
        input: str,
        *,
        max_turns: int,
        run_config: Any,
    ) -> SimpleNamespace:
        captured.update(
            agent=agent,
            input=input,
            max_turns=max_turns,
            run_config=run_config,
        )
        tools = {tool.name: tool for tool in agent.tools}
        artifact_output = await tools["read_artifact"].on_invoke_tool(
            _context(tools["read_artifact"], "{}"),
            json.dumps({"artifact_id": scope.artifact_ids[0]}),
        )
        event_output = await tools["read_event"].on_invoke_tool(
            _context(tools["read_event"], "{}", index=2),
            json.dumps({"event_id": scope.event_ids[0]}),
        )
        numerator, denominator = scope.allowed_ratio_pairs[0]
        ratio_output = await tools["deterministic_ratio"].on_invoke_tool(
            _context(tools["deterministic_ratio"], "{}", index=3),
            json.dumps(
                {
                    "numerator_value_ref_id": numerator,
                    "denominator_value_ref_id": denominator,
                }
            ),
        )
        assert all(type(value) is str for value in (artifact_output, event_output, ratio_output))
        assert all(
            len(value.encode("utf-8")) <= TOOL_ENVELOPE_MAX_BYTES
            for value in (artifact_output, event_output, ratio_output)
        )
        calculation_id = json.loads(ratio_output)["calculation"]["calculation_id"]
        return SimpleNamespace(
            final_output=make_candidate(scope, calculation_ids=(calculation_id,))
        )

    reviewer = RunReviewer(model_name="gpt-5.6-mini", runner=fake_runner)
    proposal = await reviewer.review(scope, "Which sealed facts matter?")

    assert TOOL_CALL_LIMIT == 8
    assert TOOL_ENVELOPE_MAX_BYTES == 65_536
    assert CANDIDATE_MAX_BYTES == 65_536
    assert MODEL_TIMEOUT_SECONDS == 6
    agent = captured["agent"]
    assert type(agent) is Agent
    assert {field.name for field in fields(agent)} == {
        "name",
        "handoff_description",
        "tools",
        "mcp_servers",
        "mcp_config",
        "instructions",
        "prompt",
        "handoffs",
        "model",
        "model_settings",
        "input_guardrails",
        "output_guardrails",
        "output_type",
        "hooks",
        "tool_use_behavior",
        "reset_tool_choice",
    }
    assert agent.model == "gpt-5.6-mini"
    assert agent.name == "sealed_run_statement_selector"
    assert agent.instructions == openai_review_module._AGENT_INSTRUCTIONS
    assert agent.output_type is CandidateReview
    assert agent.handoff_description is None
    assert agent.prompt is None
    assert agent.handoffs == []
    assert agent.mcp_servers == []
    assert agent.mcp_config == {}
    assert agent.input_guardrails == []
    assert agent.output_guardrails == []
    assert agent.hooks is None
    assert agent.tool_use_behavior == "run_llm_again"
    assert agent.reset_tool_choice is True
    assert agent.model_settings.tool_choice is None
    assert agent.model_settings.parallel_tool_calls is None
    assert agent.model_settings.extra_query is None
    assert agent.model_settings.extra_body is None
    assert agent.model_settings.extra_headers is None
    assert agent.model_settings.store is None
    assert agent.model_settings.timeout is None
    assert {field.name for field in fields(agent.model_settings)} == {
        "temperature",
        "top_p",
        "frequency_penalty",
        "presence_penalty",
        "tool_choice",
        "parallel_tool_calls",
        "truncation",
        "max_tokens",
        "reasoning",
        "verbosity",
        "metadata",
        "store",
        "prompt_cache_retention",
        "include_usage",
        "response_include",
        "top_logprobs",
        "extra_query",
        "extra_body",
        "extra_headers",
        "extra_args",
        "retry",
        "context_management",
        "prompt_cache_options",
        "preserve_raw_usage",
        "timeout",
    }
    assert agent.model_settings.verbosity == "low"
    for field in fields(agent.model_settings):
        if field.name != "verbosity":
            assert getattr(agent.model_settings, field.name) is None
    assert [tool.name for tool in agent.tools] == [
        "read_artifact",
        "read_event",
        "deterministic_ratio",
    ]
    assert all(type(tool) is FunctionTool for tool in agent.tools)
    assert all(tool.strict_json_schema for tool in agent.tools)
    assert all(tool._failure_error_function is None for tool in agent.tools)
    assert all(not tool._use_default_failure_error_function for tool in agent.tools)
    assert all(tool.description for tool in agent.tools)
    assert agent.tools[0].params_json_schema["properties"]["artifact_id"]["pattern"]
    assert agent.tools[1].params_json_schema["properties"]["event_id"]["pattern"]
    assert all(item["pattern"] for item in agent.tools[2].params_json_schema["properties"].values())
    assert captured["max_turns"] == 4
    run_config = captured["run_config"]
    assert {field.name for field in fields(run_config)} == {
        "model",
        "model_provider",
        "model_settings",
        "handoff_input_filter",
        "nest_handoff_history",
        "handoff_history_mapper",
        "input_guardrails",
        "output_guardrails",
        "tracing_disabled",
        "tracing",
        "trace_include_sensitive_data",
        "workflow_name",
        "trace_id",
        "group_id",
        "trace_metadata",
        "session_input_callback",
        "call_model_input_filter",
        "tool_error_formatter",
        "session_settings",
        "reasoning_item_id_policy",
        "sandbox",
        "tool_execution",
        "tool_not_found_behavior",
        "tool_name_collision_policy",
    }
    assert run_config.model is None
    assert type(run_config.model_provider) is MultiProvider
    assert run_config.model_settings is None
    assert run_config.handoff_input_filter is None
    assert run_config.nest_handoff_history is False
    assert run_config.handoff_history_mapper is None
    assert run_config.input_guardrails is None
    assert run_config.output_guardrails is None
    assert run_config.tracing_disabled is True
    assert run_config.tracing is None
    assert run_config.trace_include_sensitive_data is False
    assert run_config.trace_id is None
    assert run_config.group_id is None
    assert run_config.trace_metadata is None
    assert run_config.session_input_callback is None
    assert run_config.call_model_input_filter is None
    assert run_config.tool_error_formatter is None
    assert run_config.session_settings is None
    assert run_config.reasoning_item_id_policy is None
    assert run_config.sandbox is None
    assert run_config.tool_not_found_behavior == "raise_error"
    assert run_config.tool_name_collision_policy == "warn"
    assert run_config.workflow_name == "Agent workflow"
    assert run_config.tool_execution.max_function_tool_concurrency == 1
    assert run_config.tool_execution.pre_approval_tool_input_guardrails is False
    assert {field.name for field in fields(run_config.tool_execution)} == {
        "max_function_tool_concurrency",
        "pre_approval_tool_input_guardrails",
    }
    payload = json.loads(captured["input"])
    assert set(payload) == {
        "contract",
        "untrusted_question",
        "evidence_manifest",
        "artifact_ids",
        "event_ids",
        "allowed_ratio_pairs",
    }
    assert payload["contract"] == "RunReviewerInput.v1"
    assert payload["untrusted_question"] == "Which sealed facts matter?"
    assert payload["evidence_manifest"] == scope.manifest.model_dump(mode="json", by_alias=True)
    assert payload["artifact_ids"] == list(scope.artifact_ids)
    assert payload["event_ids"] == list(scope.event_ids)
    assert payload["allowed_ratio_pairs"] == [list(pair) for pair in scope.allowed_ratio_pairs]
    assert "projection-secret-needle" not in captured["input"]
    assert proposal.tool_call_count == 3
    assert len(proposal.ratio_ledger) == 1
    assert proposal.ratio_ledger[0].tool_call_ordinal == 3
    assert (
        len(canonical_json_bytes(proposal.candidate.model_dump(mode="json"))) <= CANDIDATE_MAX_BYTES
    )
    assert set(vars(reviewer)) == {"_model_name", "_runner"}


@pytest.mark.asyncio
async def test_tool_factories_pin_exact_public_schema_and_decorator_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scope = make_scope()
    captured_options: list[dict[str, object]] = []
    captured_callables: list[object] = []
    captured_agent: list[Agent[Any]] = []
    real_function_tool = openai_review_module.function_tool

    def observed_function_tool(*args: object, **kwargs: object) -> Any:
        captured_options.append(dict(kwargs))
        real_decorator = real_function_tool(*args, **kwargs)

        def observed_decorator(function: object) -> FunctionTool:
            captured_callables.append(function)
            return real_decorator(function)  # type: ignore[arg-type]

        return observed_decorator

    async def fake_runner(agent: Agent[Any], _input: str, **_kwargs: object) -> SimpleNamespace:
        captured_agent.append(agent)
        return SimpleNamespace(final_output=make_candidate(scope))

    monkeypatch.setattr(openai_review_module, "function_tool", observed_function_tool)

    await RunReviewer(model_name="gpt-5.6", runner=fake_runner).review(scope, "facts")

    assert captured_options == [
        {
            "name_override": "read_artifact",
            "description_override": (
                "Read one server-issued artifact projection from the selected sealed "
                "evidence scope."
            ),
            "use_docstring_info": False,
            "failure_error_function": None,
            "strict_mode": True,
        },
        {
            "name_override": "read_event",
            "description_override": (
                "Read one server-issued event projection from the selected sealed evidence scope."
            ),
            "use_docstring_info": False,
            "failure_error_function": None,
            "strict_mode": True,
        },
        {
            "name_override": "deterministic_ratio",
            "description_override": (
                "Compute one allowlisted ratio between two server-issued source value references."
            ),
            "use_docstring_info": False,
            "failure_error_function": None,
            "strict_mode": True,
        },
    ]
    tools = captured_agent[0].tools
    assert len(captured_callables) == 3
    assert all(inspect.iscoroutinefunction(function) for function in captured_callables)
    assert all(
        {field.name for field in fields(tool)}
        == {
            "name",
            "description",
            "params_json_schema",
            "on_invoke_tool",
            "strict_json_schema",
            "is_enabled",
            "tool_input_guardrails",
            "tool_output_guardrails",
            "needs_approval",
            "timeout_seconds",
            "timeout_behavior",
            "timeout_error_function",
            "defer_loading",
            "custom_data_extractor",
            "allowed_callers",
            "output_json_schema",
            "_output_type_adapter",
            "_failure_error_function",
            "_use_default_failure_error_function",
            "_is_agent_tool",
            "_agent_tool_default_identity",
            "_is_codex_tool",
            "_agent_instance",
            "_tool_namespace",
            "_tool_namespace_description",
            "_mcp_title",
            "_tool_origin",
            "_emit_tool_origin",
        }
        for tool in tools
    )
    assert all(tool.is_enabled is True for tool in tools)
    assert all(tool.tool_input_guardrails is None for tool in tools)
    assert all(tool.tool_output_guardrails is None for tool in tools)
    assert all(tool.needs_approval is False for tool in tools)
    assert all(tool.timeout_seconds is None for tool in tools)
    assert all(tool.timeout_behavior == "error_as_result" for tool in tools)
    assert all(tool.timeout_error_function is None for tool in tools)
    assert all(tool.defer_loading is False for tool in tools)
    assert all(tool.custom_data_extractor is None for tool in tools)
    assert all(tool.allowed_callers is None for tool in tools)
    assert all(tool.output_json_schema is None for tool in tools)
    assert all(tool._output_type_adapter is None for tool in tools)
    assert all(tool._failure_error_function is None for tool in tools)
    assert all(tool._use_default_failure_error_function is False for tool in tools)
    assert all(tool._is_agent_tool is False for tool in tools)
    assert all(tool._agent_tool_default_identity is None for tool in tools)
    assert all(tool._is_codex_tool is False for tool in tools)
    assert all(tool._agent_instance is None for tool in tools)
    assert all(tool._tool_namespace is None for tool in tools)
    assert all(tool._tool_namespace_description is None for tool in tools)
    assert all(tool._mcp_title is None for tool in tools)
    assert all(tool._tool_origin is None for tool in tools)
    assert all(tool._emit_tool_origin is True for tool in tools)
    assert [tool.name for tool in tools] == [
        "read_artifact",
        "read_event",
        "deterministic_ratio",
    ]
    assert [tool.description for tool in tools] == [
        options["description_override"] for options in captured_options
    ]
    assert all(tool.strict_json_schema is True for tool in tools)
    assert [tool.params_json_schema for tool in tools] == [
        {
            "properties": {
                "artifact_id": {
                    "pattern": "^art_[0-9a-f]{64}$",
                    "title": "Artifact Id",
                    "type": "string",
                }
            },
            "required": ["artifact_id"],
            "title": "read_artifact_args",
            "type": "object",
            "additionalProperties": False,
        },
        {
            "properties": {
                "event_id": {
                    "pattern": "^evt_[0-9a-f]{64}$",
                    "title": "Event Id",
                    "type": "string",
                }
            },
            "required": ["event_id"],
            "title": "read_event_args",
            "type": "object",
            "additionalProperties": False,
        },
        {
            "properties": {
                "numerator_value_ref_id": {
                    "pattern": "^val_[0-9a-f]{64}$",
                    "title": "Numerator Value Ref Id",
                    "type": "string",
                },
                "denominator_value_ref_id": {
                    "pattern": "^val_[0-9a-f]{64}$",
                    "title": "Denominator Value Ref Id",
                    "type": "string",
                },
            },
            "required": ["numerator_value_ref_id", "denominator_value_ref_id"],
            "title": "deterministic_ratio_args",
            "type": "object",
            "additionalProperties": False,
        },
    ]
    assert all(inspect.iscoroutinefunction(tool.on_invoke_tool) for tool in tools)


@pytest.mark.asyncio
async def test_candidate_cap_is_applied_to_sdk_output_canonical_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scope = make_scope()
    candidate = make_candidate(scope)
    canonical_size = len(canonical_json_bytes(candidate.model_dump(mode="json", by_alias=True)))

    async def fake_runner(_agent: Agent[Any], _input: str, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(final_output=candidate)

    monkeypatch.setattr(openai_review_module, "CANDIDATE_MAX_BYTES", canonical_size - 1)

    with pytest.raises(ReviewContractRejected, match="candidate exceeds"):
        await RunReviewer(model_name="gpt-5.6", runner=fake_runner).review(scope, "facts")


@pytest.mark.asyncio
async def test_reviewer_enters_exact_six_second_asyncio_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scope = make_scope()
    observed: list[float] = []

    class _ObservedTimeout:
        async def __aenter__(self) -> None:
            return None

        async def __aexit__(
            self,
            _exception_type: type[BaseException] | None,
            _exception: BaseException | None,
            _traceback: object,
        ) -> bool:
            return False

    def observed_timeout(seconds: float) -> _ObservedTimeout:
        observed.append(seconds)
        return _ObservedTimeout()

    async def fake_runner(_agent: Agent[Any], _input: str, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(final_output=make_candidate(scope))

    monkeypatch.setattr(openai_review_module.asyncio, "timeout", observed_timeout)

    await RunReviewer(model_name="gpt-5.6", runner=fake_runner).review(scope, "facts")

    assert observed == [6]


@pytest.mark.asyncio
async def test_tool_schema_failures_precede_accounting_and_repeated_reads_are_allowed() -> None:
    scope = make_scope()

    async def fake_runner(agent: Agent[Any], _input: str, **_kwargs: object) -> SimpleNamespace:
        tools = {tool.name: tool for tool in agent.tools}
        artifact = tools["read_artifact"]
        malformed = (
            "{",
            "{}",
            json.dumps({"artifact_id": 1}),
            json.dumps({"artifact_id": "art_" + "A" * 64}),
            json.dumps({"artifact_id": scope.artifact_ids[0], "extra": scope.artifact_ids[0]}),
        )
        for index, arguments in enumerate(malformed, start=1):
            with pytest.raises(ModelBehaviorError):
                await artifact.on_invoke_tool(_context(artifact, arguments, index=index), arguments)
        for index in range(2):
            arguments = json.dumps({"artifact_id": scope.artifact_ids[0]})
            await artifact.on_invoke_tool(
                _context(artifact, arguments, index=index + 10), arguments
            )
        event = tools["read_event"]
        for index in range(2):
            arguments = json.dumps({"event_id": scope.event_ids[0]})
            await event.on_invoke_tool(_context(event, arguments, index=index + 20), arguments)
        return SimpleNamespace(final_output=make_candidate(scope))

    proposal = await RunReviewer(model_name="gpt-5.6", runner=fake_runner).review(scope, "facts")
    assert proposal.tool_call_count == 4
    assert proposal.ratio_ledger == ()


@pytest.mark.asyncio
async def test_unknown_lookup_consumes_ordinal_before_a_successful_ratio() -> None:
    scope = make_scope()

    async def fake_runner(agent: Agent[Any], _input: str, **_kwargs: object) -> SimpleNamespace:
        tools = {tool.name: tool for tool in agent.tools}
        artifact = tools["read_artifact"]
        unknown = json.dumps({"artifact_id": _opaque("art_", 9999)})
        with pytest.raises(ScopeLookupError):
            await artifact.on_invoke_tool(_context(artifact, unknown), unknown)

        ratio = tools["deterministic_ratio"]
        numerator, denominator = scope.allowed_ratio_pairs[0]
        arguments = json.dumps(
            {
                "numerator_value_ref_id": numerator,
                "denominator_value_ref_id": denominator,
            }
        )
        output = await ratio.on_invoke_tool(_context(ratio, arguments, index=2), arguments)
        calculation_id = json.loads(output)["calculation"]["calculation_id"]
        return SimpleNamespace(
            final_output=make_candidate(scope, calculation_ids=(calculation_id,))
        )

    proposal = await RunReviewer(model_name="gpt-5.6", runner=fake_runner).review(scope, "facts")

    assert proposal.tool_call_count == 2
    assert tuple(item.tool_call_ordinal for item in proposal.ratio_ledger) == (2,)


@pytest.mark.asyncio
@pytest.mark.parametrize("first_succeeds", (True, False))
async def test_successful_and_failed_ratio_pairs_cannot_repeat_and_both_attempts_count(
    first_succeeds: bool,
) -> None:
    scope = make_scope()

    async def fake_runner(agent: Agent[Any], _input: str, **_kwargs: object) -> SimpleNamespace:
        ratio = next(tool for tool in agent.tools if tool.name == "deterministic_ratio")
        if first_succeeds:
            numerator, denominator = scope.allowed_ratio_pairs[0]
        else:
            numerator, denominator = _opaque("val_", 8888), _opaque("val_", 8889)
        pair = {
            "numerator_value_ref_id": numerator,
            "denominator_value_ref_id": denominator,
        }
        arguments = json.dumps(pair)
        calculation_id: str | None = None
        if first_succeeds:
            output = await ratio.on_invoke_tool(_context(ratio, arguments), arguments)
            calculation_id = json.loads(output)["calculation"]["calculation_id"]
        else:
            with pytest.raises(DeterministicRatioRejected):
                await ratio.on_invoke_tool(_context(ratio, arguments), arguments)
        with pytest.raises(ReviewContractRejected, match="ratio pair"):
            await ratio.on_invoke_tool(_context(ratio, arguments, index=2), arguments)
        selected = () if calculation_id is None else (calculation_id,)
        return SimpleNamespace(final_output=make_candidate(scope, calculation_ids=selected))

    proposal = await RunReviewer(model_name="gpt-5.6", runner=fake_runner).review(scope, "facts")

    assert proposal.tool_call_count == 2
    assert len(proposal.ratio_ledger) == int(first_succeeds)
    if first_succeeds:
        assert proposal.ratio_ledger[0].tool_call_ordinal == 1


@pytest.mark.asyncio
async def test_ninth_schema_valid_call_is_rejected_after_consuming_its_ordinal() -> None:
    scope = make_scope()

    async def fake_runner(agent: Agent[Any], _input: str, **_kwargs: object) -> SimpleNamespace:
        tool = next(item for item in agent.tools if item.name == "read_artifact")
        arguments = json.dumps({"artifact_id": scope.artifact_ids[0]})
        for index in range(1, TOOL_CALL_LIMIT + 1):
            await tool.on_invoke_tool(_context(tool, arguments, index=index), arguments)
        with pytest.raises(ReviewContractRejected, match="tool-call budget"):
            await tool.on_invoke_tool(_context(tool, arguments, index=9), arguments)
        return SimpleNamespace(final_output=make_candidate(scope))

    with pytest.raises(ReviewContractRejected, match="tool-call count"):
        await RunReviewer(model_name="gpt-5.6", runner=fake_runner).review(scope, "facts")


@pytest.mark.asyncio
async def test_default_runner_is_resolved_at_review_time(monkeypatch: pytest.MonkeyPatch) -> None:
    scope = make_scope()
    calls: list[Agent[Any]] = []

    async def fake_public_runner(
        agent: Agent[Any], _input: str, **_kwargs: object
    ) -> SimpleNamespace:
        calls.append(agent)
        return SimpleNamespace(final_output=make_candidate(scope))

    reviewer = RunReviewer(model_name="gpt-5.6")
    monkeypatch.setattr(Runner, "run", staticmethod(fake_public_runner))

    proposal = await reviewer.review(scope, "facts")

    assert len(calls) == 1
    assert proposal.tool_call_count == 0
    assert vars(reviewer)["_runner"] is None


@pytest.mark.asyncio
async def test_direct_reviewer_rejects_sensitive_question_before_runner() -> None:
    scope = make_scope()
    calls = 0
    secret = "".join(("api ", "key", "=", "x" * 8))

    async def fake_runner(_agent: Agent[Any], _input: str, **_kwargs: object) -> SimpleNamespace:
        nonlocal calls
        calls += 1
        return SimpleNamespace(final_output=make_candidate(scope))

    with pytest.raises(SensitiveQuestionRejected) as captured:
        await RunReviewer(model_name="gpt-5.6", runner=fake_runner).review(scope, secret)

    assert captured.value.field == "question"
    assert captured.value.reason == "SENSITIVE_INPUT_NOT_ACCEPTED"
    assert calls == 0


@pytest.mark.parametrize(
    "model_name",
    ["", "-gpt", "provider/gpt", "gpt model", "gpt@5", "a" * 129, 7, True],
)
def test_model_name_is_startup_validated_without_environment_reads(model_name: object) -> None:
    with pytest.raises(ValueError, match="model name"):
        validate_model_name(model_name)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="model name"):
        RunReviewer(model_name=model_name)  # type: ignore[arg-type]


def test_public_model_name_validator_returns_only_provider_prefix_free_names() -> None:
    for model_name in ("gpt-5.6", "gpt_5:review.v1", "A1"):
        assert validate_model_name(model_name) == model_name


def test_review_proposal_revalidates_constructed_models_and_closed_ledger() -> None:
    scope = make_scope()
    candidate = make_candidate(scope)
    valid = ReviewProposal(candidate=candidate, ratio_ledger=(), tool_call_count=0)
    assert valid.candidate is candidate

    forged = CandidateReview.model_construct(
        scope_id=scope.scope_id,
        observed_fact_ids=(),
        calculation_ids=(),
        inference_ids=(),
        risk_ids=(),
    )
    with pytest.raises(ReviewContractRejected):
        ReviewProposal(candidate=forged, ratio_ledger=(), tool_call_count=0)

    with pytest.raises(ReviewContractRejected):
        ReviewProposal(candidate=candidate, ratio_ledger=(), tool_call_count=True)
    with pytest.raises(ReviewContractRejected):
        ReviewProposal(candidate=candidate, ratio_ledger=(), tool_call_count=9)

    calculation = scope.deterministic_ratio(*scope.allowed_ratio_pairs[0], tool_call_ordinal=1)
    forged_identity = calculation.model_copy(update={"statement_id": _opaque("stmt_", 9999)})
    with pytest.raises(ReviewContractRejected, match="derived identities"):
        ReviewProposal(
            candidate=candidate,
            ratio_ledger=(forged_identity,),
            tool_call_count=1,
        )


def test_review_proposal_is_frozen_and_rejects_non_exact_ledger_models() -> None:
    scope = make_scope()
    candidate = make_candidate(scope)
    calculation = scope.deterministic_ratio(*scope.allowed_ratio_pairs[0], tool_call_ordinal=1)
    proposal = ReviewProposal(candidate=candidate, ratio_ledger=(calculation,), tool_call_count=1)

    with pytest.raises(FrozenInstanceError):
        proposal.tool_call_count = 2  # type: ignore[misc]
    with pytest.raises(ReviewContractRejected, match="exact tuple"):
        ReviewProposal(
            candidate=candidate,
            ratio_ledger=[calculation],  # type: ignore[arg-type]
            tool_call_count=1,
        )

    class DerivedCandidate(CandidateReview):
        pass

    class DerivedRatio(RatioCalculation):
        pass

    derived_candidate = DerivedCandidate.model_validate(candidate.model_dump(mode="python"))
    derived_ratio = DerivedRatio.model_validate(calculation.model_dump(mode="python"))
    forged_ratio = RatioCalculation.model_construct(
        **{**calculation.model_dump(mode="python"), "result": "not-a-decimal"}
    )
    for candidate_value, ledger in (
        (derived_candidate, (calculation,)),
        (candidate, (derived_ratio,)),
        (candidate, (forged_ratio,)),
    ):
        with pytest.raises(ReviewContractRejected):
            ReviewProposal(
                candidate=candidate_value,
                ratio_ledger=ledger,
                tool_call_count=1,
            )


def test_review_proposal_rejects_every_ledger_ordinal_and_identity_collision() -> None:
    scope = make_scope()
    candidate = make_candidate(scope)
    first = scope.deterministic_ratio(*scope.allowed_ratio_pairs[0], tool_call_ordinal=1)
    second = scope.deterministic_ratio(*scope.allowed_ratio_pairs[1], tool_call_ordinal=2)
    repeated_ordinal = scope.deterministic_ratio(*scope.allowed_ratio_pairs[1], tool_call_ordinal=1)

    with pytest.raises(ReviewContractRejected, match="ordinals"):
        ReviewProposal(
            candidate=candidate,
            ratio_ledger=(first, repeated_ordinal),
            tool_call_count=2,
        )
    with pytest.raises(ReviewContractRejected, match="ordinal exceeds"):
        ReviewProposal(candidate=candidate, ratio_ledger=(second,), tool_call_count=1)

    for attribute in (
        "calculation_id",
        "result_value_ref_id",
        "citation_id",
        "statement_id",
    ):
        duplicate_identity = second.model_copy(update={attribute: getattr(first, attribute)})
        with pytest.raises(ReviewContractRejected, match="identities"):
            ReviewProposal(
                candidate=candidate,
                ratio_ledger=(first, duplicate_identity),
                tool_call_count=2,
            )


@pytest.mark.asyncio
async def test_non_model_or_raw_dict_final_output_is_a_closed_rejection() -> None:
    scope = make_scope()

    async def fake_runner(_agent: Agent[Any], _input: str, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(final_output=make_candidate(scope).model_dump(mode="python"))

    with pytest.raises(ReviewContractRejected):
        await RunReviewer(model_name="gpt-5.6", runner=fake_runner).review(scope, "facts")
