from __future__ import annotations

from pathlib import Path
from typing import cast

import pytest
from fastapi.testclient import TestClient

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.control.app import _freeze_agent_review_pairs, create_app

REPOSITORY_ROOT = Path(__file__).parents[4]


def _component_references(value: object) -> set[str]:
    prefix = "#/components/schemas/"
    if type(value) is dict:
        mapping = cast(dict[str, object], value)
        reference = mapping.get("$ref")
        references = (
            {reference.removeprefix(prefix)}
            if type(reference) is str and reference.startswith(prefix)
            else set()
        )
        for nested in mapping.values():
            references.update(_component_references(nested))
        return references
    if type(value) is list:
        return {
            reference
            for nested in cast(list[object], value)
            for reference in _component_references(nested)
        }
    return set()


def test_checked_in_openapi_is_canonical_and_byte_stable() -> None:
    generated = canonical_json_bytes(create_app(testing=True).openapi()) + b"\n"
    snapshot = (REPOSITORY_ROOT / "contracts" / "control.openapi.json").read_bytes()
    assert snapshot == generated


def test_openapi_is_idempotent_on_the_same_application() -> None:
    application = create_app(testing=True)

    first_schema = application.openapi()
    second_schema = application.openapi()
    third_schema = application.openapi()

    assert first_schema == second_schema == third_schema
    assert (
        canonical_json_bytes(first_schema)
        == canonical_json_bytes(second_schema)
        == canonical_json_bytes(third_schema)
    )


def test_agent_review_openapi_rejects_a_partially_frozen_schema() -> None:
    schema = create_app(testing=True).openapi()
    response_schema = schema["paths"]["/v1/agent/run-review"]["post"]["responses"]["200"][
        "content"
    ]["application/json"]["schema"]
    response_schema.pop("allOf")

    with pytest.raises(RuntimeError, match="Agent review response schema is unavailable"):
        _freeze_agent_review_pairs(schema)


def test_openapi_exposes_only_the_local_backtest_control_surface() -> None:
    schema = create_app(testing=True).openapi()
    paths = set(schema["paths"])
    assert paths == {
        "/v1/system/health",
        "/v1/system/capabilities",
        "/v1/catalogs/fixtures/{fixture_id}/publish",
        "/v1/catalogs/{catalog_revision}/instruments",
        "/v1/backtests/preflight",
        "/v1/backtests",
        "/v1/backtests/{run_id}",
        "/v1/backtests/{run_id}/cancel",
        "/v1/backtests/{run_id}/events",
        "/v1/backtests/{run_id}/artifacts",
        "/v1/backtests/{run_id}/artifacts/{artifact_name}",
        "/v1/backtests/{run_id}/configuration",
        "/v1/strategies",
        "/v1/strategy-drafts",
        "/v1/strategy-drafts/{draft_id}",
        "/v1/strategy-drafts/{draft_id}/publish",
        "/v1/strategy-drafts/{draft_id}/versions",
        "/v1/strategy-configurations/{configuration_id}",
        "/v1/strategy-configurations/{configuration_id}/preflight",
        "/v1/stream",
        "/v1/agent/run-review",
        "/v2/historical/capabilities",
        "/v2/historical/strategies",
        "/v2/historical/catalogs",
        "/v2/historical/catalogs/{catalog_revision}",
        "/v2/historical/configuration-drafts",
        "/v2/historical/configuration-drafts/{draft_id}",
        "/v2/historical/configuration-drafts/{draft_id}/publish",
        "/v2/historical/configurations",
        "/v2/historical/configurations/{configuration_id}",
        "/v2/historical/preflights",
        "/v2/historical/preflights/{preflight_id}",
        "/v2/historical/runs",
        "/v2/historical/runs/{run_id}",
        "/v2/historical/runs/{run_id}/cancel",
        "/v2/historical/runs/{run_id}/events",
        "/v2/historical/runs/{run_id}/artifacts",
        "/v2/historical/runs/{run_id}/report-summary",
        "/v2/historical/runs/{run_id}/artifacts/{artifact_name}",
    }
    forbidden_fragments = (
        "/orders",
        "/execute",
        "/wallet",
        "/sign",
        "/transaction",
        "/credentials",
        "/live",
        "/chain-observer",
    )
    assert not any(fragment in path for path in paths for fragment in forbidden_fragments)
    components = schema["components"]["schemas"]
    forbidden_component_fragments = (
        "Order",
        "Execute",
        "Wallet",
        "Sign",
        "Transaction",
        "Credential",
        "Live",
        "ChainObserver",
    )
    assert not any(
        fragment in name for name in components for fragment in forbidden_component_fragments
    )
    canonical = canonical_json_bytes(schema)
    for forbidden_path in (
        b'"/v1/orders',
        b'"/v1/execute',
        b'"/v1/wallet',
        b'"/v1/sign',
        b'"/v1/transaction',
        b'"/v1/credentials',
        b'"/v1/live',
        b'"/v1/chain-observer',
    ):
        assert forbidden_path not in canonical
    assert "200" in schema["paths"]["/v1/backtests/{run_id}/cancel"]["post"]["responses"]
    assert "503" in schema["paths"]["/v1/backtests/preflight"]["post"]["responses"]


def test_openapi_declares_every_success_status_media_type_and_schema() -> None:
    schema = create_app(testing=True).openapi()
    paths = schema["paths"]
    expected_json = {
        ("/v1/system/health", "get", "200"): "HealthResponse",
        ("/v1/system/capabilities", "get", "200"): "CapabilitiesResponse",
        ("/v1/catalogs/fixtures/{fixture_id}/publish", "post", "200"): "CatalogRevisionResponse",
        ("/v1/catalogs/fixtures/{fixture_id}/publish", "post", "201"): "CatalogRevisionResponse",
        ("/v1/catalogs/{catalog_revision}/instruments", "get", "200"): "InstrumentPage",
        ("/v1/backtests/preflight", "post", "200"): "PreflightApiResponse",
        ("/v1/backtests", "post", "202"): "RunCommandResponse",
        ("/v1/backtests/{run_id}", "get", "200"): "RunResponse",
        ("/v1/backtests/{run_id}/cancel", "post", "200"): "RunCommandResponse",
        ("/v1/backtests/{run_id}/cancel", "post", "202"): "RunCommandResponse",
        ("/v1/backtests/{run_id}/events", "get", "200"): "EventPage",
        ("/v1/backtests/{run_id}/artifacts", "get", "200"): "ArtifactIndex",
        ("/v1/strategies", "get", "200"): "StrategyDefinitionList",
        ("/v1/strategy-drafts", "get", "200"): "StrategyDraftList",
        ("/v1/strategy-drafts", "post", "201"): "StrategyDraft",
        ("/v1/strategy-drafts/{draft_id}", "get", "200"): "StrategyDraft",
        ("/v1/strategy-drafts/{draft_id}", "put", "200"): "StrategyDraft",
        (
            "/v1/strategy-drafts/{draft_id}/publish",
            "post",
            "201",
        ): "StrategyConfigurationVersion",
        (
            "/v1/strategy-drafts/{draft_id}/versions",
            "get",
            "200",
        ): "StrategyConfigurationVersionList",
        (
            "/v1/strategy-configurations/{configuration_id}",
            "get",
            "200",
        ): "StrategyConfigurationVersion",
        (
            "/v1/strategy-configurations/{configuration_id}/preflight",
            "post",
            "200",
        ): "PreflightApiResponse",
    }
    for (path, method, status), component in expected_json.items():
        response = paths[path][method]["responses"][status]
        assert response["content"]["application/json"]["schema"] == {
            "$ref": f"#/components/schemas/{component}"
        }

    run_configuration = paths["/v1/backtests/{run_id}/configuration"]["get"]["responses"]["200"][
        "content"
    ]["application/json"]["schema"]
    assert run_configuration == {
        "anyOf": [
            {"$ref": "#/components/schemas/StrategyConfigurationVersion"},
            {"type": "null"},
        ],
        "title": (
            "Response Get Backtest Strategy Configuration V1 Backtests  Run Id  Configuration Get"
        ),
    }

    artifact_response = paths["/v1/backtests/{run_id}/artifacts/{artifact_name}"]["get"][
        "responses"
    ]["200"]
    artifact_json_schema = {
        "anyOf": [
            {"type": "object"},
            {"items": {"type": "object"}, "type": "array"},
        ]
    }
    assert artifact_response["content"] == {
        "application/json": {"schema": artifact_json_schema},
        "application/x-ndjson": {"schema": {"type": "string"}},
        "text/plain": {"schema": {"type": "string"}},
    }
    stream_response = paths["/v1/stream"]["get"]["responses"]["200"]
    assert stream_response["content"] == {"text/event-stream": {"schema": {"type": "string"}}}

    capabilities = schema["components"]["schemas"]["CapabilitiesResponse"]
    modes = capabilities["properties"]["execution_modes"]
    assert modes["minItems"] == modes["maxItems"] == 1

    timestamp_schema = schema["components"]["schemas"]["UnixEpochNanosecondString"]
    assert timestamp_schema == {
        "pattern": "^[1-9][0-9]{18}$",
        "type": "string",
    }
    for component in ("HealthResponse", "CapabilitiesResponse"):
        response_schema = schema["components"]["schemas"][component]
        assert "observed_at_ns" in response_schema["required"]
        assert response_schema["properties"]["observed_at_ns"] == {
            "$ref": "#/components/schemas/UnixEpochNanosecondString"
        }

    check = schema["components"]["schemas"]["PreflightCheckResponse"]
    assert set(check["required"]) == {
        "checked_at_ns",
        "code",
        "evidence",
        "explanation",
        "passed",
    }
    assert check["properties"]["checked_at_ns"] == {
        "$ref": "#/components/schemas/UnixEpochNanosecondString"
    }
    assert check["properties"]["evidence"]["minItems"] == 1
    assert check["properties"]["explanation"]["minLength"] == 1


def test_agent_review_openapi_freezes_request_response_pairs_and_nested_reachability() -> None:
    schema = create_app(testing=True).openapi()
    operation = schema["paths"]["/v1/agent/run-review"]["post"]
    assert set(operation["responses"]) == {"200", "404", "409", "422"}
    request_schema = operation["requestBody"]["content"]["application/json"]["schema"]
    assert request_schema == {
        "$ref": "#/components/schemas/RunReviewRequest",
        "description": (
            "Manual sealed-run review request. The question is limited to 2,000 Unicode "
            "code points and 8,192 UTF-8 bytes."
        ),
    }
    response_schema = operation["responses"]["200"]["content"]["application/json"]["schema"]
    expected_pairs = [
        ("LOCAL_DETERMINISTIC", "AI_REVIEW_NOT_CONFIGURED"),
        ("LOCAL_DETERMINISTIC", "AI_REVIEW_REJECTED"),
        ("LOCAL_DETERMINISTIC", "AI_REVIEW_UNAVAILABLE"),
        ("OPENAI_AGENT", "COMPLETE"),
    ]
    assert set(response_schema) == {"allOf", "oneOf"}
    assert response_schema["allOf"] == [{"$ref": "#/components/schemas/RunReviewResponse"}]
    assert len(response_schema["oneOf"]) == 4
    assert [
        (
            branch["properties"]["mode"]["const"],
            branch["properties"]["status"]["const"],
        )
        for branch in response_schema["oneOf"]
    ] == expected_pairs
    assert all(set(branch["required"]) == {"mode", "status"} for branch in response_schema["oneOf"])
    for status in ("404", "409", "422"):
        assert operation["responses"][status]["content"]["application/json"]["schema"] == {
            "$ref": "#/components/schemas/ErrorResponse"
        }

    components = schema["components"]["schemas"]
    reachable: set[str] = set()
    pending = list(_component_references(response_schema))
    while pending:
        component = pending.pop()
        if component in reachable:
            continue
        reachable.add(component)
        for reference in _component_references(components[component]):
            if reference not in reachable:
                pending.append(reference)
    assert {
        "ReviewClaim",
        "ReviewNotice",
        "ReviewCitation",
        "ExactValueRef",
    } <= reachable


def test_openapi_get_run_and_artifact_index_have_no_phantom_validation_response() -> None:
    paths = create_app(testing=True).openapi()["paths"]
    expected = {
        "/v1/backtests/{run_id}": {"200", "404", "409"},
        "/v1/backtests/{run_id}/artifacts": {"200", "404", "409"},
        "/v1/backtests/{run_id}/configuration": {"200", "404", "409"},
        "/v1/strategy-drafts/{draft_id}": {"200", "404", "409"},
        "/v1/strategy-drafts/{draft_id}/versions": {"200", "404", "409"},
        "/v1/strategy-configurations/{configuration_id}": {"200", "404", "409"},
    }
    for path, statuses in expected.items():
        responses = paths[path]["get"]["responses"]
        assert set(responses) == statuses
        for status in statuses - {"200"}:
            assert responses[status]["content"]["application/json"]["schema"] == {
                "$ref": "#/components/schemas/ErrorResponse"
            }


def test_openapi_freezes_required_run_evidence_and_integrity_failure() -> None:
    """Catches evidence becoming optional/open or corruption escaping the safe 409."""

    schema = create_app(testing=True).openapi()
    components = schema["components"]["schemas"]
    run_response = components["RunResponse"]

    assert "evidence" in run_response["required"]
    assert run_response["properties"]["evidence"] == {
        "$ref": "#/components/schemas/RunEvidenceResponse"
    }
    assert set(components["RunEvidenceResponse"]["required"]) == {
        "input",
        "performance",
        "process_exit",
        "failure",
    }
    assert components["EvidenceAuthority"] == {
        "type": "string",
        "enum": [
            "CONTROL_SQLITE_INPUT_MANIFEST_AND_CATALOG",
            "CONTROL_SQLITE_RUNNER_OUTCOME",
            "CONTROL_SQLITE_FINALIZATION_FAULT",
            "SEALED_METRICS_ARTIFACT",
        ],
    }
    assert components["EvidenceCompleteness"] == {
        "type": "string",
        "enum": ["COMPLETE", "UNAVAILABLE"],
    }
    assert components["PerformanceEvidenceUnavailableReason"] == {
        "type": "string",
        "enum": [
            "RUN_NOT_VERIFIED",
            "METRICS_ARTIFACT_NOT_SEALED",
            "LEGACY_METRICS_SERIES_ABSENT",
        ],
    }
    closed_fields = {
        "EvidenceProvenanceResponse": {
            "authority",
            "artifact_name",
            "evidence_id",
            "seal_digest",
        },
        "RunInputEvidenceResponse": {
            "completeness",
            "unavailable_reason",
            "fixture_id",
            "fixture_label",
            "strategy_id",
            "strategy_version",
            "instrument_ids",
            "window_start_ns",
            "window_end_ns",
            "timezone",
            "provenance",
        },
        "PerformancePointResponse": {
            "point_index",
            "ts_event_ns",
            "equity_amount",
            "drawdown_pct",
            "is_stale",
            "stale_instruments",
            "stale_currencies",
            "unpriced_instruments",
        },
        "RunPerformanceEvidenceResponse": {
            "completeness",
            "unavailable_reason",
            "series_schema",
            "source",
            "selection",
            "calculation",
            "timestamp_unit",
            "equity_unit",
            "drawdown_unit",
            "account_id",
            "currency",
            "points",
            "provenance",
        },
        "ProcessExitEvidenceResponse": {
            "classification",
            "supervisor_failure_code",
            "exit_code",
            "signal",
            "ended_at_ns",
            "duration_ns",
            "final_cancel_phase",
            "stderr_sha256",
            "stderr_truncated",
            "provenance",
        },
        "RunnerFailureEvidence": {"source", "code", "message", "provenance"},
        "SupervisorFailureEvidence": {"source", "code", "provenance"},
        "FinalizationFailureEvidence": {
            "source",
            "category",
            "stage",
            "attempt_count",
            "observed_at_ns",
            "outcome_hash",
            "initial_event_digest",
            "provenance",
        },
        "RunEvidenceResponse": {"input", "performance", "process_exit", "failure"},
    }
    for component, fields in closed_fields.items():
        value = components[component]
        assert value["type"] == "object"
        assert value["additionalProperties"] is False
        assert set(value["properties"]) == fields
        assert set(value["required"]) == fields

    provenance = components["EvidenceProvenanceResponse"]
    assert provenance["properties"] == {
        "authority": {"$ref": "#/components/schemas/EvidenceAuthority"},
        "artifact_name": {
            "anyOf": [
                {"type": "string", "const": "metrics_report"},
                {"type": "null"},
            ],
            "title": "Artifact Name",
        },
        "evidence_id": {"$ref": "#/components/schemas/Sha256Digest"},
        "seal_digest": {
            "anyOf": [
                {"$ref": "#/components/schemas/Sha256Digest"},
                {"type": "null"},
            ]
        },
    }
    input_evidence = components["RunInputEvidenceResponse"]
    for field in ("fixture_id", "strategy_id", "strategy_version", "timezone"):
        assert input_evidence["properties"][field]["anyOf"] == [
            {"type": "string"},
            {"type": "null"},
        ]
    assert input_evidence["properties"]["fixture_label"]["anyOf"] == [
        {"type": "string", "const": "LOCAL QA FIXTURE"},
        {"type": "null"},
    ]
    for field in ("window_start_ns", "window_end_ns"):
        assert input_evidence["properties"][field]["anyOf"] == [
            {"$ref": "#/components/schemas/NanosecondString"},
            {"type": "null"},
        ]
    assert input_evidence["properties"]["completeness"] == {
        "$ref": "#/components/schemas/EvidenceCompleteness"
    }
    assert input_evidence["properties"]["unavailable_reason"]["anyOf"] == [
        {"$ref": "#/components/schemas/InputEvidenceUnavailableReason"},
        {"type": "null"},
    ]
    assert input_evidence["properties"]["instrument_ids"] == {
        "items": {"type": "string"},
        "title": "Instrument Ids",
        "type": "array",
    }
    assert input_evidence["properties"]["provenance"]["anyOf"] == [
        {"$ref": "#/components/schemas/EvidenceProvenanceResponse"},
        {"type": "null"},
    ]
    point = components["PerformancePointResponse"]
    assert point["properties"]["point_index"] == {
        "minimum": 0,
        "title": "Point Index",
        "type": "integer",
    }
    assert point["properties"]["is_stale"] == {
        "type": "boolean",
        "const": False,
        "title": "Is Stale",
    }
    for field in ("ts_event_ns", "equity_amount", "drawdown_pct"):
        referenced = "NanosecondString" if field == "ts_event_ns" else "CanonicalDecimalString"
        assert point["properties"][field] == {"$ref": f"#/components/schemas/{referenced}"}
    for field, title in (
        ("stale_instruments", "Stale Instruments"),
        ("stale_currencies", "Stale Currencies"),
        ("unpriced_instruments", "Unpriced Instruments"),
    ):
        assert point["properties"][field] == {
            "items": {"type": "string"},
            "title": title,
            "type": "array",
        }
    performance = components["RunPerformanceEvidenceResponse"]
    assert performance["additionalProperties"] is False
    assert set(performance["required"]) == set(performance["properties"])
    assert performance["properties"]["series_schema"]["anyOf"] == [
        {"type": "string", "const": "PortfolioEquitySeries.v1"},
        {"type": "null"},
    ]
    assert performance["properties"]["source"]["anyOf"] == [
        {"type": "string", "const": "NAUTILUS_PORTFOLIO_SNAPSHOTS"},
        {"type": "null"},
    ]
    assert performance["properties"]["selection"]["anyOf"] == [
        {"type": "string", "const": "SOLE_TOTAL_EQUITY"},
        {"type": "null"},
    ]
    assert performance["properties"]["calculation"]["anyOf"] == [
        {"type": "string", "const": "RUNNING_PEAK_DRAWDOWN_PERCENT_V1"},
        {"type": "null"},
    ]
    for field, literal in (
        ("timestamp_unit", "UNIX_EPOCH_NS"),
        ("equity_unit", "ACCOUNT_CURRENCY"),
        ("drawdown_unit", "PERCENT"),
    ):
        assert performance["properties"][field] == {
            "type": "string",
            "const": literal,
            "title": field.replace("_", " ").title(),
        }
    for field in ("account_id", "currency"):
        assert performance["properties"][field]["anyOf"] == [
            {"type": "string"},
            {"type": "null"},
        ]
    assert performance["properties"]["completeness"] == {
        "$ref": "#/components/schemas/EvidenceCompleteness"
    }
    assert performance["properties"]["unavailable_reason"]["anyOf"] == [
        {"$ref": "#/components/schemas/PerformanceEvidenceUnavailableReason"},
        {"type": "null"},
    ]
    assert performance["properties"]["points"] == {
        "items": {"$ref": "#/components/schemas/PerformancePointResponse"},
        "title": "Points",
        "type": "array",
    }
    assert performance["properties"]["provenance"]["anyOf"] == [
        {"$ref": "#/components/schemas/EvidenceProvenanceResponse"},
        {"type": "null"},
    ]
    assert components["RunEvidenceResponse"]["properties"]["input"] == {
        "$ref": "#/components/schemas/RunInputEvidenceResponse"
    }
    assert components["RunEvidenceResponse"]["properties"]["performance"] == {
        "$ref": "#/components/schemas/RunPerformanceEvidenceResponse"
    }
    assert components["RunEvidenceResponse"]["properties"]["process_exit"]["anyOf"] == [
        {"$ref": "#/components/schemas/ProcessExitEvidenceResponse"},
        {"type": "null"},
    ]
    assert components["RunEvidenceResponse"]["properties"]["failure"]["anyOf"] == [
        {"$ref": "#/components/schemas/RunFailureEvidence"},
        {"type": "null"},
    ]
    process_exit = components["ProcessExitEvidenceResponse"]
    assert process_exit["properties"]["supervisor_failure_code"]["anyOf"] == [
        {"$ref": "#/components/schemas/SupervisorFailureCode"},
        {"type": "null"},
    ]
    for field, title in (("exit_code", "Exit Code"), ("signal", "Signal")):
        assert process_exit["properties"][field] == {
            "anyOf": [{"type": "integer"}, {"type": "null"}],
            "title": title,
        }
    for field in ("ended_at_ns", "duration_ns"):
        assert process_exit["properties"][field] == {
            "$ref": "#/components/schemas/NanosecondString"
        }
    for field, referenced in (
        ("classification", "SupervisorClassification"),
        ("final_cancel_phase", "CancelPhase"),
        ("stderr_sha256", "Sha256Digest"),
        ("provenance", "EvidenceProvenanceResponse"),
    ):
        assert process_exit["properties"][field] == {"$ref": f"#/components/schemas/{referenced}"}
    assert process_exit["properties"]["stderr_truncated"] == {
        "title": "Stderr Truncated",
        "type": "boolean",
    }
    assert components["RunFailureEvidence"] == {
        "oneOf": [
            {"$ref": "#/components/schemas/RunnerFailureEvidence"},
            {"$ref": "#/components/schemas/SupervisorFailureEvidence"},
            {"$ref": "#/components/schemas/FinalizationFailureEvidence"},
        ],
        "discriminator": {
            "propertyName": "source",
            "mapping": {
                "FINALIZER": "#/components/schemas/FinalizationFailureEvidence",
                "RUNNER": "#/components/schemas/RunnerFailureEvidence",
                "SUPERVISOR": "#/components/schemas/SupervisorFailureEvidence",
            },
        },
    }
    for component, source in (
        ("RunnerFailureEvidence", "RUNNER"),
        ("SupervisorFailureEvidence", "SUPERVISOR"),
        ("FinalizationFailureEvidence", "FINALIZER"),
    ):
        failure = components[component]
        assert failure["additionalProperties"] is False
        assert set(failure["required"]) == set(failure["properties"])
        assert failure["properties"]["source"] == {
            "type": "string",
            "const": source,
            "title": "Source",
        }
        assert failure["properties"]["provenance"] == {
            "$ref": "#/components/schemas/EvidenceProvenanceResponse"
        }
    assert components["RunnerFailureEvidence"]["properties"]["code"] == {
        "type": "string",
        "enum": [
            "RUNNER_EXECUTION_FAILED",
            "REPORT_EXPORT_FAILED",
            "PROTOCOL_FAILED",
        ],
        "title": "Code",
    }
    assert components["RunnerFailureEvidence"]["properties"]["message"] == {
        "title": "Message",
        "type": "string",
    }
    assert components["SupervisorFailureEvidence"]["properties"]["code"] == {
        "$ref": "#/components/schemas/SupervisorFailureCode"
    }
    finalizer_failure = components["FinalizationFailureEvidence"]["properties"]
    assert finalizer_failure["category"] == {
        "$ref": "#/components/schemas/FinalizationFailureCategory"
    }
    assert finalizer_failure["stage"] == {"$ref": "#/components/schemas/FinalizationStage"}
    assert finalizer_failure["attempt_count"] == {
        "type": "integer",
        "const": 3,
        "title": "Attempt Count",
    }
    assert finalizer_failure["observed_at_ns"] == {"$ref": "#/components/schemas/NanosecondString"}
    for field in ("outcome_hash", "initial_event_digest"):
        assert finalizer_failure[field] == {"$ref": "#/components/schemas/Sha256Digest"}
    responses = schema["paths"]["/v1/backtests/{run_id}"]["get"]["responses"]
    assert set(responses) == {"200", "404", "409"}
    assert responses["409"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/ErrorResponse"
    }


def test_every_openapi_component_schema_is_reachable_from_a_path() -> None:
    schema = create_app(testing=True).openapi()
    components = cast(dict[str, object], schema["components"]["schemas"])
    reachable: set[str] = set()
    pending = list(_component_references(schema["paths"]))
    while pending:
        name = pending.pop()
        assert name in components
        if name in reachable:
            continue
        reachable.add(name)
        pending.extend(_component_references(components[name]) - reachable)

    assert set(components) == reachable


def test_historical_contract_has_exact_receipts_closed_inputs_and_explicit_evidence() -> None:
    schema = create_app(testing=True).openapi()
    prefix, paths = "/v2/historical", schema["paths"]
    components = schema["components"]["schemas"]
    expected = {
        ("/capabilities", "get", "200"): "HistoricalCapabilitiesResponse",
        ("/configuration-drafts", "get", "200"): "HistoricalDraftPage",
        ("/configuration-drafts", "post", "201"): "HistoricalStrategyDraftV2",
        ("/configuration-drafts/{draft_id}", "get", "200"): "HistoricalStrategyDraftV2",
        ("/configuration-drafts/{draft_id}", "put", "200"): "HistoricalStrategyDraftV2",
        (
            "/configuration-drafts/{draft_id}/publish",
            "post",
            "200",
        ): "HistoricalStrategyConfigurationVersionV2",
        ("/configurations", "get", "200"): "HistoricalConfigurationPage",
        (
            "/configurations/{configuration_id}",
            "get",
            "200",
        ): "HistoricalStrategyConfigurationVersionV2",
        ("/preflights", "post", "200"): "HistoricalPreflightReceiptV2",
        ("/preflights/{preflight_id}", "get", "200"): "HistoricalPreflightStatus",
        ("/runs", "post", "202"): "HistoricalStartResponse",
        ("/runs/{run_id}/cancel", "post", "202"): "RunCommandResponse",
        ("/runs/{run_id}/cancel", "post", "200"): "RunCommandResponse",
        ("/runs/{run_id}", "get", "200"): "HistoricalRunResponse",
        ("/runs/{run_id}/events", "get", "200"): "EventPage",
        ("/runs/{run_id}/artifacts", "get", "200"): "HistoricalArtifactIndex",
    }
    for (path, method, status), component in expected.items():
        assert paths[prefix + path][method]["responses"][status]["content"] == {
            "application/json": {"schema": {"$ref": f"#/components/schemas/{component}"}}
        }
    for name in (
        "SmaConfigurationInputV2",
        "HistoricalUpdateDraftRequest",
        "HistoricalPreflightRequest",
        "HistoricalStartRequest",
    ):
        assert components[name]["additionalProperties"] is False
    assert set(components["HistoricalStartRequest"]["properties"]) == {
        "preflight_id",
        "request_sha256",
    }
    assert components["HistoricalStartResponse"]["properties"]["state"]["const"] == "QUEUED"
    for path in ("/preflights", "/runs", "/runs/{run_id}/cancel"):
        headers = [
            item for item in paths[prefix + path]["post"]["parameters"] if item["in"] == "header"
        ]
        assert len(headers) == 1 and headers[0]["required"] is True
        assert headers[0]["name"] == "Idempotency-Key"
        assert headers[0]["schema"]["maxLength"] == 128
        assert headers[0]["schema"]["pattern"] == "^[!-~]+$"
    assert (
        components["HistoricalPreflightStatus"]["properties"]["current_eligibility"]["const"]
        == "NOT_RECHECKED"
    )
    assert (
        components["HistoricalPublicationStatus"]["properties"]["filesystem_verification"]["const"]
        == "NOT_CHECKED"
    )
    assert components["HistoricalArtifactName"]["enum"] == [
        "input_manifest",
        "catalog_manifest",
        "runner_exit",
        "stderr",
        "component_snapshot",
        "historical_report",
        "evidence_anchor",
        "events",
        "audit",
        "run",
        "seal",
    ]
    for path, methods in paths.items():
        if path.startswith(prefix):
            for operation in methods.values():
                for status in ("404", "409", "422", "503"):
                    assert operation["responses"][status]["content"]["application/json"][
                        "schema"
                    ] == {"$ref": "#/components/schemas/ErrorResponse"}


def test_framework_schema_and_docs_http_routes_are_disabled() -> None:
    app = create_app(testing=True)
    assert app.openapi()["paths"]
    with TestClient(app, headers={"Origin": "http://127.0.0.1:3000"}) as client:
        for path in ("/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"):
            assert client.get(path).status_code == 404
