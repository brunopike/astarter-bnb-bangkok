from __future__ import annotations

import copy
import json
from decimal import Decimal
from pathlib import Path

import pytest
from pydantic import ValidationError

from stark_trading_os.audit.canonical_json import (
    CanonicalJSONError,
    canonical_json_bytes,
    parse_json_object,
)
from stark_trading_os.domain.models import BacktestDraftRequest, InputManifestV1, RunRecordV1

_INPUT_MANIFEST_FIELDS = tuple(
    sorted(field.alias or name for name, field in InputManifestV1.model_fields.items())
)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        pytest.param(
            RunRecordV1(
                schema="RunRecord.v1",
                run_id="run-1",
                preflight_id="preflight-1",
                idempotency_scope="backtest.create",
                idempotency_key="create-1",
                state="COMPLETED",
                state_version=8,
                prepared_terminal_state="COMPLETED",
                prepared_terminal_state_version=8,
                created_at_ns="100",
                started_at_ns="110",
                completed_at_ns="140",
                duration_ns="30",
                runner_identity={"spawn_nonce": "nonce-1", "pid": 7},
                runner_exit={
                    "proposed_terminal_state": "COMPLETED",
                    "classification": "NATURAL_SUCCESS",
                },
                materialized_event_seq=9,
                materialized_audit_seq=9,
                evidence_status="VERIFIED",
            ).model_dump(mode="json", by_alias=True),
            b'{"completed_at_ns":"140","created_at_ns":"100","duration_ns":"30",'
            b'"evidence_status":"VERIFIED","idempotency_key":"create-1",'
            b'"idempotency_scope":"backtest.create","materialized_audit_seq":9,'
            b'"materialized_event_seq":9,"preflight_id":"preflight-1",'
            b'"prepared_terminal_state":"COMPLETED",'
            b'"prepared_terminal_state_version":8,"run_id":"run-1",'
            b'"runner_exit":{"classification":"NATURAL_SUCCESS",'
            b'"proposed_terminal_state":"COMPLETED"},'
            b'"runner_identity":{"pid":7,"spawn_nonce":"nonce-1"},'
            b'"schema":"RunRecord.v1","started_at_ns":"110",'
            b'"state":"COMPLETED","state_version":8}',
            id="run-record",
        ),
        pytest.param(
            {
                "schema": "RunSeal.v1",
                "run_id": "run-1",
                "terminal_state": "COMPLETED",
                "terminal_event_seq": 9,
                "last_audit_seq": 9,
                "audit_head_hash": "a" * 64,
                "files": [
                    {
                        "relative_path": "request.json",
                        "sha256": "b" * 64,
                        "size_bytes": 7,
                    },
                    {
                        "relative_path": "audit.ndjson",
                        "sha256": "c" * 64,
                        "size_bytes": 11,
                    },
                ],
            },
            b'{"audit_head_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
            b'"files":[{"relative_path":"audit.ndjson",'
            b'"sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",'
            b'"size_bytes":11},{"relative_path":"request.json",'
            b'"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",'
            b'"size_bytes":7}],"last_audit_seq":9,"run_id":"run-1",'
            b'"schema":"RunSeal.v1","terminal_event_seq":9,"terminal_state":"COMPLETED"}',
            id="run-seal",
        ),
        pytest.param(
            {
                "schema": "FinalizationFault.v1",
                "run_id": "run-1",
                "outcome_hash": "d" * 64,
                "initial_event_digest": "e" * 64,
                "category": "DETERMINISTIC_EVIDENCE_FAILURE",
                "stage": "SEAL",
                "attempt_count": 3,
                "observed_at_ns": 150,
            },
            b'{"attempt_count":3,"category":"DETERMINISTIC_EVIDENCE_FAILURE",'
            b'"initial_event_digest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",'
            b'"observed_at_ns":150,'
            b'"outcome_hash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",'
            b'"run_id":"run-1","schema":"FinalizationFault.v1","stage":"SEAL"}',
            id="finalization-fault",
        ),
    ],
)
def test_task9_registered_evidence_has_exact_canonical_bytes(
    value: object, expected: bytes
) -> None:
    try:
        actual = canonical_json_bytes(value)
    except CanonicalJSONError as error:
        actual = f"unregistered: {error}".encode()

    assert actual == expected


def _complete_run_record() -> dict[str, object]:
    return RunRecordV1(
        schema="RunRecord.v1",
        run_id="run-1",
        preflight_id="preflight-1",
        idempotency_scope="backtest.create",
        idempotency_key="create-1",
        state="COMPLETED",
        state_version=8,
        prepared_terminal_state="COMPLETED",
        prepared_terminal_state_version=8,
        created_at_ns="100",
        started_at_ns="110",
        completed_at_ns="140",
        duration_ns="30",
        runner_identity={"spawn_nonce": "nonce-1", "pid": 7},
        runner_exit={"classification": "NATURAL_SUCCESS"},
        materialized_event_seq=9,
        materialized_audit_seq=9,
        evidence_status="VERIFIED",
    ).model_dump(mode="json", by_alias=True)


def _complete_run_seal() -> dict[str, object]:
    return {
        "schema": "RunSeal.v1",
        "run_id": "run-1",
        "terminal_state": "FAILED",
        "terminal_event_seq": 9,
        "last_audit_seq": 9,
        "audit_head_hash": "a" * 64,
        "files": [
            {
                "relative_path": "request.json",
                "sha256": "b" * 64,
                "size_bytes": 7,
            }
        ],
    }


def _complete_finalization_fault() -> dict[str, object]:
    return {
        "schema": "FinalizationFault.v1",
        "run_id": "run-1",
        "outcome_hash": "d" * 64,
        "initial_event_digest": "e" * 64,
        "category": "DETERMINISTIC_EVIDENCE_FAILURE",
        "stage": "SEAL",
        "attempt_count": 3,
        "observed_at_ns": 150,
    }


@pytest.mark.parametrize("field", tuple(_complete_run_record()))
def test_run_record_rejects_every_missing_declared_field(field: str) -> None:
    incomplete = _complete_run_record()
    del incomplete[field]

    expected = (
        "RunRecord.v1 schema"
        if field == "schema"
        else f"missing field for RunRecord.v1: {field}"
    )
    with pytest.raises(CanonicalJSONError, match=expected):
        canonical_json_bytes(incomplete)


@pytest.mark.parametrize(
    ("schema", "factory"),
    (
        ("RunSeal.v1", _complete_run_seal),
        ("FinalizationFault.v1", _complete_finalization_fault),
    ),
)
def test_task9_roots_reject_every_missing_declared_field(
    schema: str,
    factory: object,
) -> None:
    complete = factory()
    for field in tuple(complete):
        incomplete = copy.deepcopy(complete)
        del incomplete[field]
        with pytest.raises(CanonicalJSONError):
            canonical_json_bytes(incomplete)


@pytest.mark.parametrize("field", ("relative_path", "sha256", "size_bytes"))
def test_run_seal_files_reject_every_missing_declared_field(field: str) -> None:
    incomplete = _complete_run_seal()
    del incomplete["files"][0][field]

    with pytest.raises(CanonicalJSONError, match="exact declared objects"):
        canonical_json_bytes(incomplete)


@pytest.mark.parametrize(
    "value",
    (
        {**_complete_run_record(), "unexpected": True},
        {**_complete_run_seal(), "unexpected": True},
        {**_complete_finalization_fault(), "unexpected": True},
        {
            **_complete_run_seal(),
            "files": [
                {
                    **_complete_run_seal()["files"][0],
                    "unexpected": True,
                }
            ],
        },
    ),
)
def test_task9_roots_and_items_reject_extra_fields(value: dict[str, object]) -> None:
    with pytest.raises(CanonicalJSONError):
        canonical_json_bytes(value)


@pytest.mark.parametrize(
    "value",
    (
        {**_complete_run_record(), "state_version": 8.0},
        {**_complete_run_seal(), "terminal_event_seq": 9.0},
        {
            **_complete_run_seal(),
            "files": [
                {
                    **_complete_run_seal()["files"][0],
                    "size_bytes": 7.0,
                }
            ],
        },
        {**_complete_finalization_fault(), "attempt_count": 3.0},
        {**_complete_finalization_fault(), "observed_at_ns": 150.0},
    ),
)
def test_task9_roots_reject_floats_without_coercion(value: dict[str, object]) -> None:
    with pytest.raises(CanonicalJSONError):
        canonical_json_bytes(value)


@pytest.mark.parametrize(
    "value",
    [
        pytest.param(
            {
                "run_id": "run-1",
                "preflight_id": "preflight-1",
                "idempotency_scope": "backtest.create",
                "idempotency_key": "create-1",
                "state": "COMPLETED",
                "state_version": 8,
                "prepared_terminal_state": "COMPLETED",
                "prepared_terminal_state_version": 8,
                "created_at_ns": "100",
                "started_at_ns": "110",
                "completed_at_ns": "140",
                "duration_ns": "30",
                "runner_identity": None,
                "runner_exit": None,
                "materialized_event_seq": 9,
                "materialized_audit_seq": 9,
                "evidence_status": "VERIFIED",
            },
            id="run-record-missing-schema",
        ),
        pytest.param(
            {
                "schema": "RunSeal.v1",
                "run_id": "run-1",
                "terminal_state": "FINALIZING",
                "terminal_event_seq": 9,
                "last_audit_seq": 9,
                "audit_head_hash": "a" * 64,
                "files": [],
            },
            id="seal-nonterminal-state",
        ),
        pytest.param(
            {
                "schema": "RunSeal.v1",
                "run_id": "run-1",
                "terminal_state": "FAILED",
                "terminal_event_seq": 0,
                "last_audit_seq": 1,
                "audit_head_hash": "a" * 64,
                "files": [],
            },
            id="seal-zero-event-boundary",
        ),
        pytest.param(
            {
                "schema": "RunSeal.v1",
                "run_id": "run-1",
                "terminal_state": "FAILED",
                "terminal_event_seq": 1,
                "last_audit_seq": 1,
                "audit_head_hash": "A" * 64,
                "files": [],
            },
            id="seal-uppercase-digest",
        ),
        pytest.param(
            {
                "schema": "RunSeal.v1",
                "run_id": "run-1",
                "terminal_state": "FAILED",
                "terminal_event_seq": 1,
                "last_audit_seq": 1,
                "audit_head_hash": "a" * 64,
                "files": [
                    {
                        "relative_path": "request.json",
                        "sha256": "b" * 64,
                        "size_bytes": -1,
                    }
                ],
            },
            id="seal-negative-size",
        ),
        pytest.param(
            {
                "schema": "RunSeal.v1",
                "run_id": "run-1",
                "terminal_state": "FAILED",
                "terminal_event_seq": 1,
                "last_audit_seq": 1,
                "audit_head_hash": "a" * 64,
                "files": [
                    {
                        "relative_path": "../request.json",
                        "sha256": "b" * 64,
                        "size_bytes": 1,
                    }
                ],
            },
            id="seal-parent-path",
        ),
        pytest.param(
            {
                "run_id": "run-1",
                "terminal_state": "FAILED",
                "terminal_event_seq": 1,
                "last_audit_seq": 1,
                "audit_head_hash": "a" * 64,
                "files": [],
            },
            id="seal-missing-schema",
        ),
        pytest.param(
            {
                "schema": "FinalizationFault.v1",
                "run_id": "run-1",
                "outcome_hash": "d" * 64,
                "initial_event_digest": "e" * 64,
                "category": "RETRY_LATER",
                "stage": "SEAL",
                "attempt_count": 3,
                "observed_at_ns": 150,
            },
            id="fault-open-category",
        ),
        pytest.param(
            {
                "schema": "FinalizationFault.v1",
                "run_id": "run-1",
                "outcome_hash": "d" * 64,
                "initial_event_digest": "e" * 64,
                "category": "OPERATIONAL_RETRY_EXHAUSTED",
                "stage": "UNKNOWN",
                "attempt_count": 3,
                "observed_at_ns": 150,
            },
            id="fault-open-stage",
        ),
        pytest.param(
            {
                "schema": "FinalizationFault.v1",
                "run_id": "run-1",
                "outcome_hash": "d" * 64,
                "initial_event_digest": "e" * 64,
                "category": "OPERATIONAL_RETRY_EXHAUSTED",
                "stage": "FSYNC",
                "attempt_count": 2,
                "observed_at_ns": 150,
            },
            id="fault-wrong-attempt-count",
        ),
        pytest.param(
            {
                "schema": "FinalizationFault.v1",
                "run_id": "run-1",
                "outcome_hash": "d" * 63,
                "initial_event_digest": "e" * 64,
                "category": "OPERATIONAL_RETRY_EXHAUSTED",
                "stage": "FSYNC",
                "attempt_count": 3,
                "observed_at_ns": -1,
            },
            id="fault-bad-digest-and-time",
        ),
        pytest.param(
            {
                "run_id": "run-1",
                "outcome_hash": "d" * 64,
                "initial_event_digest": "e" * 64,
                "category": "OPERATIONAL_RETRY_EXHAUSTED",
                "stage": "FSYNC",
                "attempt_count": 3,
                "observed_at_ns": 150,
            },
            id="fault-missing-schema",
        ),
    ],
)
def test_task9_registered_evidence_rejects_invalid_roots(value: object) -> None:
    rejected = False
    try:
        canonical_json_bytes(value)
    except CanonicalJSONError:
        rejected = True

    assert rejected is True


def test_run_seal_rejects_duplicate_paths_and_is_order_independent() -> None:
    first = {
        "schema": "RunSeal.v1",
        "run_id": "run-1",
        "terminal_state": "FAILED",
        "terminal_event_seq": 2,
        "last_audit_seq": 2,
        "audit_head_hash": "a" * 64,
        "files": [
            {"relative_path": "request.json", "sha256": "b" * 64, "size_bytes": 2},
            {"relative_path": "audit.ndjson", "sha256": "c" * 64, "size_bytes": 3},
        ],
    }
    reversed_value = copy.deepcopy(first)
    reversed_value["files"].reverse()
    duplicate = copy.deepcopy(first)
    duplicate["files"][1]["relative_path"] = "request.json"

    assert canonical_json_bytes(first) == canonical_json_bytes(reversed_value)
    rejected = False
    try:
        canonical_json_bytes(duplicate)
    except CanonicalJSONError:
        rejected = True
    assert rejected is True


def test_checked_in_fixture_defines_unicode_integer_and_declared_set_bytes() -> None:
    fixture = json.loads(
        (Path(__file__).parents[2] / "fixtures" / "canonical-json-v1.json").read_text()
    )

    for case in (
        fixture["unicode_and_integers"],
        fixture["declared_set"],
        fixture["composite_numeric_set"],
        fixture["composite_numeric_set_reversed"],
    ):
        assert canonical_json_bytes(case["value"]).decode() == case["expected"]

    with pytest.raises(CanonicalJSONError, match="duplicate composite sort key"):
        canonical_json_bytes(fixture["duplicate_composite_key"])


def test_decimal_values_become_non_exponent_canonical_strings() -> None:
    assert canonical_json_bytes({"negative": Decimal("-0.0100"), "value": Decimal("1E+3")}) == (
        b'{"negative":"-0.01","value":"1000"}'
    )


@pytest.mark.parametrize("value", [0.1, float("nan"), float("inf"), {"bad": object()}])
def test_runtime_floats_and_unknown_types_are_rejected(value: object) -> None:
    with pytest.raises(CanonicalJSONError):
        canonical_json_bytes({"value": value})


def test_arbitrary_size_python_integer_has_stable_canonical_error() -> None:
    with pytest.raises(CanonicalJSONError, match="integer.*runtime limit"):
        canonical_json_bytes({"value": 10**5_000})


def test_raw_json_duplicate_keys_are_rejected() -> None:
    with pytest.raises(CanonicalJSONError, match="duplicate key"):
        parse_json_object('{"same": 1, "same": 2}')


def test_declared_schema_rejects_unknown_fields_instead_of_filtering_them() -> None:
    with pytest.raises(CanonicalJSONError, match="unknown field"):
        canonical_json_bytes({"schema": "SetFixture.v1", "items": [], "surprise": True})


@pytest.mark.parametrize(
    "value",
    [
        {"schema": "Unregistered.v1"},
        {"schema": "SetFixture.v1", "items": [{"id": "a", "surprise": "x"}]},
        {"schema": "SetFixture.v1", "items": [{"id": "a"}, {"id": "a"}]},
    ],
)
def test_declared_schemas_and_set_keys_are_closed(value: object) -> None:
    with pytest.raises(CanonicalJSONError):
        canonical_json_bytes(value)


@pytest.mark.parametrize(
    "value",
    [
        {"schema": "SetFixture.v1"},
        {"schema": "ReplayNormalization.v1", "input_manifest_hash": "a" * 64},
    ],
)
def test_declared_schema_roots_require_all_static_fields(value: object) -> None:
    with pytest.raises(CanonicalJSONError, match="missing field"):
        canonical_json_bytes(value)


def test_current_input_manifest_dump_has_one_deterministic_production_encoding() -> None:
    manifest = InputManifestV1.model_validate(_current_manifest())
    dumped = manifest.model_dump(mode="json", by_alias=True)

    assert canonical_json_bytes(dumped) == canonical_json_bytes(dumped)


def test_validated_draft_dump_is_the_exact_bare_canonical_request_body() -> None:
    draft = BacktestDraftRequest.model_validate(_current_draft())
    dumped = draft.model_dump(mode="json", by_alias=True)

    encoded = canonical_json_bytes(dumped)

    assert (
        encoded
        == json.dumps(
            dumped,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    )
    assert canonical_json_bytes(dumped) == encoded
    assert json.loads(encoded) == dumped


@pytest.mark.parametrize("field", tuple(BacktestDraftRequest.model_fields))
def test_draft_root_missing_any_field_cannot_fall_through_to_generic_json(field: str) -> None:
    dumped = BacktestDraftRequest.model_validate(_current_draft()).model_dump(
        mode="json", by_alias=True
    )
    alias = BacktestDraftRequest.model_fields[field].alias or field
    del dumped[alias]

    with pytest.raises(CanonicalJSONError):
        canonical_json_bytes(dumped)


def test_draft_root_extra_field_and_manifest_shape_collision_stay_fail_closed() -> None:
    dumped = BacktestDraftRequest.model_validate(_current_draft()).model_dump(
        mode="json", by_alias=True
    )
    dumped["surprise"] = "not-authorized"
    with pytest.raises(CanonicalJSONError):
        canonical_json_bytes(dumped)

    manifest = _current_manifest()
    del manifest["schema"]
    with pytest.raises(CanonicalJSONError, match="InputManifest.v1 schema"):
        canonical_json_bytes(manifest)


def test_draft_root_missing_both_reference_signatures_cannot_fall_through() -> None:
    dumped = BacktestDraftRequest.model_validate(_current_draft()).model_dump(
        mode="json", by_alias=True
    )
    del dumped["strategy_ref"]
    del dumped["risk_policy_ref"]

    with pytest.raises(CanonicalJSONError):
        canonical_json_bytes(dumped)


def test_draft_validation_rejects_unknown_float_and_duplicate_raw_keys_before_hashing() -> None:
    unknown = _current_draft()
    unknown["surprise"] = True
    with pytest.raises(ValidationError):
        BacktestDraftRequest.model_validate(unknown)

    floating = _current_draft()
    floating["replay_seed"] = 1.0
    with pytest.raises(ValidationError):
        BacktestDraftRequest.model_validate(floating)

    with pytest.raises(CanonicalJSONError, match="duplicate key"):
        parse_json_object('{"catalog_revision":"a","catalog_revision":"b"}')


def test_input_manifest_declared_sets_are_sorted_without_mutating_the_caller() -> None:
    first = _current_manifest()
    first["instruments"] = [
        {
            "instrument_id": "ETH/USDT.SIM",
            "price_increment": "0.01",
            "quantity_increment": "0.001",
        },
        {
            "instrument_id": "BTC/USDT.SIM",
            "price_increment": "0.1",
            "quantity_increment": "0.01",
        },
    ]
    first["data_types"] = ["QuoteTick", "TradeTick"]
    second = copy.deepcopy(first)
    instruments = second["instruments"]
    data_types = second["data_types"]
    assert isinstance(instruments, list)
    assert isinstance(data_types, list)
    instruments.reverse()
    data_types.reverse()
    before = copy.deepcopy(first)

    assert canonical_json_bytes(first) == canonical_json_bytes(second)
    assert first == before


def test_input_manifest_composite_sets_use_numeric_then_string_order() -> None:
    first = _current_manifest()
    first["gaps"] = [
        {"start_ns": "10", "end_ns": "20", "instrument_id": "η"},
        {"start_ns": "2", "end_ns": "10", "instrument_id": "ETH/USDT.SIM"},
    ]
    first["duplicates"] = [
        {"ts_event_ns": "10", "source_seq": 2, "record_hash": "b" * 64},
        {"ts_event_ns": "2", "source_seq": 10, "record_hash": "a" * 64},
    ]
    second = copy.deepcopy(first)
    assert isinstance(second["gaps"], list)
    assert isinstance(second["duplicates"], list)
    second["gaps"].reverse()
    second["duplicates"].reverse()

    encoded = canonical_json_bytes(first)
    assert encoded == canonical_json_bytes(second)
    assert encoded.index(b'"start_ns":"2"') < encoded.index(b'"start_ns":"10"')
    assert encoded.index(b'"ts_event_ns":"2"') < encoded.index(b'"ts_event_ns":"10"')


@pytest.mark.parametrize("field", ["gaps", "duplicates"])
def test_input_manifest_composite_sets_reject_duplicate_keys(field: str) -> None:
    manifest = _current_manifest()
    item: dict[str, object]
    if field == "gaps":
        item = {"start_ns": "2", "end_ns": "10", "instrument_id": "ETH/USDT.SIM"}
    else:
        item = {"ts_event_ns": "2", "source_seq": 10, "record_hash": "a" * 64}
    manifest[field] = [item, copy.deepcopy(item)]

    with pytest.raises(CanonicalJSONError, match="duplicate composite sort key"):
        canonical_json_bytes(manifest)


def test_declared_numeric_set_orders_arbitrary_size_unsigned_strings() -> None:
    lower = "1" + ("0" * 4_999)
    higher = "9" * 5_000
    first = {
        "schema": "CompositeSetFixture.v1",
        "items": [
            {"ts_ns": higher, "source_seq": 1, "name": "higher"},
            {"ts_ns": lower, "source_seq": 1, "name": "lower"},
        ],
    }
    second = copy.deepcopy(first)
    second["items"].reverse()

    encoded = canonical_json_bytes(first)

    assert encoded == canonical_json_bytes(second)
    assert [item["name"] for item in json.loads(encoded)["items"]] == [
        "lower",
        "higher",
    ]


def test_declared_numeric_set_rejects_arbitrary_size_duplicate_keys() -> None:
    timestamp = "1" + ("0" * 4_999)
    item = {"ts_ns": timestamp, "source_seq": 1, "name": "same"}

    with pytest.raises(CanonicalJSONError, match="duplicate composite sort key"):
        canonical_json_bytes(
            {
                "schema": "CompositeSetFixture.v1",
                "items": [item, copy.deepcopy(item)],
            }
        )


def test_duplicate_integer_sort_key_does_not_leak_python_digit_limit() -> None:
    item = {"ts_ns": "1", "source_seq": 10**5_000, "name": "same"}

    with pytest.raises(CanonicalJSONError, match="duplicate composite sort key"):
        canonical_json_bytes(
            {
                "schema": "CompositeSetFixture.v1",
                "items": [item, copy.deepcopy(item)],
            }
        )


@pytest.mark.parametrize("field", ["instruments", "data_types"])
def test_input_manifest_declared_sets_reject_duplicate_members(field: str) -> None:
    manifest = _current_manifest()
    if field == "instruments":
        instruments = manifest[field]
        assert isinstance(instruments, list)
        manifest[field] = [instruments[0], instruments[0]]
    else:
        manifest[field] = ["QuoteTick", "QuoteTick"]

    with pytest.raises(CanonicalJSONError, match="duplicate"):
        canonical_json_bytes(manifest)


def test_input_manifest_only_validates_declared_nested_schema_paths() -> None:
    manifest = _current_manifest()
    manifest["canonical_config"] = {"schema": "strategy-owned.v1"}
    manifest["canonical_risk_policy"] = {"schema": "risk-owned.v1"}

    assert canonical_json_bytes(manifest)


def test_input_manifest_pydantic_validation_is_wrapped() -> None:
    manifest = _current_manifest()
    manifest["strategy_id"] = 7

    with pytest.raises(CanonicalJSONError, match="invalid InputManifest.v1"):
        canonical_json_bytes(manifest)


@pytest.mark.parametrize("schema", [pytest.param("missing", id="missing"), 7, None, {}, []])
def test_input_manifest_shaped_root_requires_its_string_discriminator(schema: object) -> None:
    manifest = _current_manifest()
    if schema == "missing":
        del manifest["schema"]
    else:
        manifest["schema"] = schema

    with pytest.raises(CanonicalJSONError, match="InputManifest.v1 schema"):
        canonical_json_bytes(manifest)


@pytest.mark.parametrize(
    ("field", "expected_schema"),
    [
        ("information_set_policy", "InformationSetPolicy.v1"),
        ("evaluation_protocol", "EvaluationProtocol.v1"),
    ],
)
@pytest.mark.parametrize(
    "child",
    [
        {},
        {"other": "x"},
        {"schema": 7},
        {"schema": "OtherPolicy.v1"},
        {"schema": "InformationSetPolicy.v1", "extra": "x"},
    ],
)
def test_input_manifest_declared_children_require_exact_schema_markers(
    field: str, expected_schema: str, child: dict[str, object]
) -> None:
    manifest = _current_manifest()
    if field == "evaluation_protocol" and child.get("schema") == "InformationSetPolicy.v1":
        child = {"schema": expected_schema, "extra": "x"}
    manifest[field] = child

    with pytest.raises(CanonicalJSONError, match="schema|unknown field|invalid"):
        canonical_json_bytes(manifest)


def test_schema_less_audit_and_report_objects_remain_canonical_json() -> None:
    audit_entry = {"seq": 1, "action": "preflight.passed", "prev_hash": "0" * 64}
    report_row = {"client_order_id": "order-1", "strategy_id": "probe", "side": "BUY"}
    report_document = {"orders": [report_row]}

    for value in (audit_entry, report_row, report_document):
        assert canonical_json_bytes(value) == canonical_json_bytes(value)


@pytest.mark.parametrize(
    ("value", "schema"),
    [
        ({"inventory": {}}, "CatalogManifest.v1"),
        ({"catalog_files": []}, "CatalogFileSet.v1"),
        ({"source_records": []}, "CatalogInventory.v1"),
        ({"action": "catalog.validated"}, "CatalogValidatedAudit.v1"),
    ],
)
def test_catalog_production_root_signatures_cannot_lose_discriminator(
    value: dict[str, object], schema: str
) -> None:
    with pytest.raises(CanonicalJSONError, match=rf"{schema} schema"):
        canonical_json_bytes(value)


@pytest.mark.parametrize(
    ("value", "schema"),
    [
        (
            {
                "availability_field": "ts_available_ns",
                "nautilus_timestamp_field": "ts_init",
                "visibility_rule": "AVAILABLE_AT_OR_BEFORE_DECISION",
                "tie_breakers": ["ts_available_ns", "source_seq", "record_hash"],
                "bar_rule": "CLOSED_AND_AVAILABLE",
                "source_revision_rule": "SINGLE_IMMUTABLE_REVISION",
            },
            "InformationSetPolicy.v1",
        ),
        (
            {
                "mode": "fixture_only",
                "train": None,
                "tune": None,
                "out_of_sample": None,
                "purge_ns": "0",
                "embargo_ns": "0",
            },
            "EvaluationProtocol.v1",
        ),
        (
            {
                "event_timestamp": "ts_event_ns -> QuoteTick.ts_event",
                "availability_timestamp": "ts_available_ns -> QuoteTick.ts_init",
                "source_identity": (
                    "source_seq/source_revision/record_hash -> catalog-manifest.json"
                ),
            },
            "CatalogMapping.v1",
        ),
        (
            {
                "installed_nautilus_version": "2.0.0rc3",
                "python_version": "3.12.4",
                "platform_system": "Darwin",
                "platform_machine": "arm64",
                "native_extension_sha256": "9" * 64,
                "writer_class": "nautilus_trader.persistence.ParquetDataCatalog",
                "writer_options": (
                    "batch_size=null;compression=null;max_row_group_size=null;storage_options=null"
                ),
            },
            "CatalogNativeFingerprint.v1",
        ),
    ],
)
def test_fixed_registered_root_evidence_cannot_omit_schema(
    value: dict[str, object], schema: str
) -> None:
    with pytest.raises(CanonicalJSONError, match=rf"{schema} schema"):
        canonical_json_bytes(value)


def test_catalog_manifest_without_schema_and_inventory_stays_reserved() -> None:
    value = {
        "fixture_id": "local-qa-v1",
        "label": "LOCAL QA FIXTURE",
        "source_checksum": "a" * 64,
        "catalog_checksum": "b" * 64,
        "inventory_hash": "c" * 64,
    }

    with pytest.raises(CanonicalJSONError, match=r"CatalogManifest.v1 schema"):
        canonical_json_bytes(value)


def test_catalog_registered_roots_missing_schema_and_each_other_field_fail_closed() -> None:
    for schema, root in _catalog_registered_root_examples().items():
        for field in tuple(root):
            if field == "schema":
                continue
            if schema == "CatalogFileSet.v1" and field == "catalog_files":
                # Removing both fields is the generic empty JSON object; the
                # non-empty discriminator attack is covered above.
                continue
            attack = copy.deepcopy(root)
            del attack["schema"]
            del attack[field]

            with pytest.raises(CanonicalJSONError, match="schema"):
                canonical_json_bytes(attack)


@pytest.mark.parametrize("field", [field for field in _INPUT_MANIFEST_FIELDS if field != "schema"])
def test_production_manifest_dump_missing_schema_and_any_other_required_field_is_rejected(
    field: str,
) -> None:
    dumped = _production_manifest_dump()
    del dumped["schema"]
    del dumped[field]

    with pytest.raises(CanonicalJSONError, match="InputManifest.v1 schema"):
        canonical_json_bytes(dumped)


def test_production_manifest_dump_missing_schema_and_multiple_required_fields_is_rejected() -> None:
    dumped = _production_manifest_dump()
    for field in ("schema", "environment", "strategy_id", "cost_fill_model"):
        del dumped[field]

    with pytest.raises(CanonicalJSONError, match="InputManifest.v1 schema"):
        canonical_json_bytes(dumped)


def test_near_complete_production_manifest_without_schema_cannot_be_bypassed_by_unknown_field() -> (
    None
):
    dumped = _production_manifest_dump()
    del dumped["schema"]
    dumped["surprise"] = "not-a-manifest"

    with pytest.raises(CanonicalJSONError, match="InputManifest.v1 schema"):
        canonical_json_bytes(dumped)


def test_production_manifest_wrong_typed_marker_with_missing_fields_is_rejected_as_manifest() -> (
    None
):
    dumped = _production_manifest_dump()
    dumped["schema"] = 7
    del dumped["strategy_id"]

    with pytest.raises(CanonicalJSONError, match="InputManifest.v1 schema"):
        canonical_json_bytes(dumped)


def _current_manifest() -> dict[str, object]:
    return {
        "schema": "InputManifest.v1",
        "environment": "BACKTEST",
        "strategy_id": "determinism-probe",
        "strategy_version": "v1",
        "canonical_config": {
            "entry_limit_price": "100",
            "entry_quantity": "15",
            "metric_round_trip_quantity": "1",
            "metric_round_trips": 5,
            "risk_probe_quantity": "20",
            "venue_rejection_quantity": "1",
        },
        "config_hash": "a" * 64,
        "engine_package_version": "2.0.0rc3",
        "engine_tag_commit": "b" * 40,
        "python_version": "3.12.4",
        "precision_mode": "high",
        "fixture_id": "rc3-fixture",
        "catalog_revision": "f" * 64,
        "source_checksum": "c" * 64,
        "catalog_checksum": "d" * 64,
        "instruments": [
            {
                "instrument_id": "ETH/USDT.SIM",
                "price_increment": "0.01",
                "quantity_increment": "0.001",
            }
        ],
        "data_types": ["QuoteTick"],
        "window": {"start_ns": "1", "end_ns": "2"},
        "timezone": "UTC",
        "gaps": [],
        "duplicates": [],
        "ordering_result": "PASS",
        "information_set_policy": {
            "schema": "InformationSetPolicy.v1",
            "availability_field": "ts_available_ns",
            "nautilus_timestamp_field": "ts_init",
            "visibility_rule": "AVAILABLE_AT_OR_BEFORE_DECISION",
            "tie_breakers": ["ts_available_ns", "source_seq", "record_hash"],
            "bar_rule": "CLOSED_AND_AVAILABLE",
            "source_revision_rule": "SINGLE_IMMUTABLE_REVISION",
        },
        "evaluation_protocol": {
            "schema": "EvaluationProtocol.v1",
            "mode": "fixture_only",
            "train": None,
            "tune": None,
            "out_of_sample": None,
            "purge_ns": "0",
            "embargo_ns": "0",
        },
        "venue_account_model": {
            "venue_id": "SIM",
            "oms_type": "HEDGING",
            "account_type": "MARGIN",
            "book_type": "L1_MBP",
            "routing": False,
            "use_random_ids": False,
            "use_position_ids": True,
            "allow_cash_borrowing": False,
            "starting_balance": "1000000",
            "currency": "USDT",
        },
        "cost_fill_model": _supported_cost_fill(),
        "risk_policy_id": "probe-risk",
        "risk_policy_version": "v1",
        "canonical_risk_policy": {"max_notional": "1600"},
        "risk_policy_hash": "e" * 64,
        "replay_seed": 7,
    }


def _production_manifest_dump() -> dict[str, object]:
    manifest = InputManifestV1.model_validate(_current_manifest())
    return manifest.model_dump(mode="json", by_alias=True)


def _current_draft() -> dict[str, object]:
    manifest = _current_manifest()
    return {
        "environment": "BACKTEST",
        "strategy_ref": "determinism-probe@v1",
        "catalog_revision": "a" * 64,
        "window": {"start_ns": "1700000000000000000", "end_ns": "1700000000000000002"},
        "information_set_policy": manifest["information_set_policy"],
        "evaluation_protocol": manifest["evaluation_protocol"],
        "venue_account_model": {
            "venue_id": "SIM",
            "oms_type": "HEDGING",
            "account_type": "MARGIN",
            "book_type": "L1_MBP",
            "routing": False,
            "use_random_ids": False,
            "use_position_ids": True,
            "allow_cash_borrowing": False,
            "starting_balance": "1000000",
            "currency": "USDT",
        },
        "cost_fill_model": _supported_cost_fill(),
        "risk_policy_ref": "probe-risk@v1",
        "replay_seed": 7,
    }


def _supported_cost_fill() -> dict[str, object]:
    return {
        "schema": "CostFillModel.v1",
        "fee": {
            "model": "MakerTakerFeeModel",
            "rate_source": "INSTRUMENT_MAKER_TAKER",
            "rate_unit": "NOTIONAL_DECIMAL_FRACTION",
            "charge_currency": "INSTRUMENT_QUOTE_CURRENCY",
            "minimum_fee": "0",
            "application": "PER_FILL",
            "decimal_precision": 8,
            "rounding_mode": "MIDPOINT_NEAREST_EVEN",
        },
        "spread": {"authority": "FIXTURE_BID_ASK"},
        "slippage": {
            "model": "DefaultFillModel",
            "prob_fill_on_limit": "1",
            "prob_slippage": "0",
            "random_seed_source": "INPUT_MANIFEST_REPLAY_SEED",
            "probabilistic_slippage": "DISABLED",
            "depth_price_impact": "DISABLED",
            "maximum_book_walk_ticks": "0",
        },
        "latency": {
            "model": "StaticLatencyModel",
            "decision_to_submit_ns": "0",
            "submit_to_venue_ns": "0",
            "base_latency_ns": "0",
            "insert_latency_ns": "0",
            "update_latency_ns": "0",
            "cancel_latency_ns": "0",
        },
        "liquidity": {
            "available_size_source": "RECORDED_QUOTE_TICK_BID_ASK_SIZE",
            "queue_assumption": "NOT_MODELED_AT_L1",
            "allocation_order": "SINGLE_ORDER_NO_ALLOCATION_COMPETITION",
            "partial_fill_schedule": "ON_RECORDED_QUOTE",
            "price_selection": "NATIVE_L1_BID_ASK_CROSS",
            "allow_partial_fills": True,
            "liquidity_consumption": True,
        },
        "cancel": {
            "acknowledgment_rule": "NATIVE",
            "remaining_quantity_disposition": "CANCEL_OPEN_REMAINDER",
            "time_in_force": "GTC",
        },
    }


def _catalog_registered_root_examples() -> dict[str, dict[str, object]]:
    instrument = {
        "instrument_id": "ETH/USDT.SIM",
        "raw_symbol": "ETH/USDT",
        "venue": "SIM",
        "base_currency": "ETH",
        "quote_currency": "USDT",
        "price_precision": 2,
        "size_precision": 3,
        "price_increment": "0.01",
        "size_increment": "0.001",
        "minimum_quantity": "0.001",
        "margin_init": "0.1",
        "margin_maint": "0.05",
        "maker_fee": "0",
        "taker_fee": "0",
        "ts_event_ns": "1",
        "ts_available_ns": "1",
    }
    policy = {
        "schema": "InformationSetPolicy.v1",
        "availability_field": "ts_available_ns",
        "nautilus_timestamp_field": "ts_init",
        "visibility_rule": "AVAILABLE_AT_OR_BEFORE_DECISION",
        "tie_breakers": ["ts_available_ns", "source_seq", "record_hash"],
        "bar_rule": "CLOSED_AND_AVAILABLE",
        "source_revision_rule": "SINGLE_IMMUTABLE_REVISION",
    }
    evaluation = {
        "schema": "EvaluationProtocol.v1",
        "mode": "fixture_only",
        "train": None,
        "tune": None,
        "out_of_sample": None,
        "purge_ns": "0",
        "embargo_ns": "0",
    }
    mapping = {
        "schema": "CatalogMapping.v1",
        "event_timestamp": "ts_event_ns -> QuoteTick.ts_event",
        "availability_timestamp": "ts_available_ns -> QuoteTick.ts_init",
        "source_identity": ("source_seq/source_revision/record_hash -> catalog-manifest.json"),
    }
    fingerprint = {
        "schema": "CatalogNativeFingerprint.v1",
        "installed_nautilus_version": "2.0.0rc3",
        "python_version": "3.12.4",
        "platform_system": "Darwin",
        "platform_machine": "arm64",
        "native_extension_sha256": "9" * 64,
        "writer_class": "nautilus_trader.persistence.ParquetDataCatalog",
        "writer_options": (
            "batch_size=null;compression=null;max_row_group_size=null;storage_options=null"
        ),
    }
    catalog_file = {
        "relative_path": "data/x.parquet",
        "size_bytes": 1,
        "sha256": "e" * 64,
    }
    inventory = {
        "schema": "CatalogInventory.v1",
        "fixture_id": "local-qa-v1",
        "label": "LOCAL QA FIXTURE",
        "source_revision": "local-qa-v1",
        "timezone": "UTC",
        "purpose": "LOCAL_QA_ONLY",
        "source_checksum": "a" * 64,
        "catalog_checksum": "b" * 64,
        "catalog_files": [catalog_file],
        "instrument": instrument,
        "source_records": [
            {
                "instrument_id": "ETH/USDT.SIM",
                "bid_price": "99.00",
                "ask_price": "100.00",
                "bid_size": "10.000",
                "ask_size": "10.000",
                "ts_event_ns": "1",
                "ts_available_ns": "1",
                "source_seq": 1,
                "source_revision": "local-qa-v1",
                "record_hash": "c" * 64,
            }
        ],
        "readback": {
            "instrument": instrument,
            "quote_count": 1,
            "first_ts_init": "1",
            "last_ts_init": "1",
            "data_types": ["instruments", "quotes"],
        },
        "mapping": mapping,
        "native_fingerprint": fingerprint,
        "information_set_policy": policy,
        "evaluation_protocol": evaluation,
        "gaps": [],
        "duplicates": [],
        "ordering_result": "PASS",
    }
    manifest = {
        "schema": "CatalogManifest.v1",
        "fixture_id": "local-qa-v1",
        "label": "LOCAL QA FIXTURE",
        "source_checksum": "a" * 64,
        "catalog_checksum": "b" * 64,
        "inventory_hash": "d" * 64,
        "inventory": inventory,
    }
    audit = {
        "schema": "CatalogValidatedAudit.v1",
        "action": "catalog.validated",
        "fixture_id": "local-qa-v1",
        "catalog_revision": "f" * 64,
        "inventory_hash": "d" * 64,
        "source_checksum": "a" * 64,
        "catalog_checksum": "b" * 64,
    }
    return {
        "InformationSetPolicy.v1": policy,
        "EvaluationProtocol.v1": evaluation,
        "CatalogFileSet.v1": {
            "schema": "CatalogFileSet.v1",
            "catalog_files": [catalog_file],
        },
        "CatalogInventory.v1": inventory,
        "CatalogManifest.v1": manifest,
        "CatalogValidatedAudit.v1": audit,
        "CatalogMapping.v1": mapping,
        "CatalogNativeFingerprint.v1": fingerprint,
    }


@pytest.mark.parametrize(
    "window",
    [
        {"start_ns": "0", "end_ns": "0"},
        {"start_ns": "2", "end_ns": "1"},
    ],
)
def test_manifest_canonicalization_rejects_invalid_top_level_window(
    window: dict[str, str],
) -> None:
    value = _current_manifest()
    value["window"] = window

    with pytest.raises(CanonicalJSONError, match="top-level window"):
        canonical_json_bytes(value)
