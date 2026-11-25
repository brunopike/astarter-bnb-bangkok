"""The single CanonicalJSON.v1 encoder used by persisted evidence."""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal, cast

from pydantic import BaseModel, ValidationError

from stark_trading_os.domain.models import (
    BacktestDraftRequest,
    CatalogFileSetV1,
    CatalogFileV1,
    CatalogInventoryV1,
    CatalogManifestV1,
    CatalogMappingV1,
    CatalogNativeFingerprintV1,
    CatalogSourceRecordV1,
    CatalogValidatedAuditV1,
    CostFillModelV1,
    DuplicateV1,
    EvaluationProtocolV1,
    GapV1,
    InformationSetPolicyV1,
    InputManifestV1,
    InstrumentInputV1,
    RunRecordV1,
)

type JsonValue = None | bool | int | str | Decimal | list["JsonValue"] | dict[str, "JsonValue"]


class CanonicalJSONError(ValueError):
    """Raised when a value cannot be represented by CanonicalJSON.v1."""


@dataclass(frozen=True)
class _DeclaredSchema:
    fields: frozenset[str]
    set_fields: dict[str, _DeclaredSet]


@dataclass(frozen=True)
class _SortKey:
    name: str
    kind: Literal["string", "numeric-string", "integer"]


@dataclass(frozen=True)
class _DeclaredSet:
    item_fields: frozenset[str]
    sort_keys: tuple[_SortKey, ...]
    scalar_strings: bool = False


def _model_fields(model: type[BaseModel]) -> frozenset[str]:
    return frozenset(field.alias or name for name, field in model.model_fields.items())


_BACKTEST_DRAFT_FIELDS = _model_fields(BacktestDraftRequest)


_DECLARED_SCHEMAS: dict[str, _DeclaredSchema] = {
    # Task 6 schema evolution must add its production dump regression here too.
    # Fields come from the owning domain models so the two declarations cannot drift.
    "InputManifest.v1": _DeclaredSchema(
        fields=_model_fields(InputManifestV1),
        set_fields={
            "instruments": _DeclaredSet(
                item_fields=_model_fields(InstrumentInputV1),
                sort_keys=(_SortKey("instrument_id", "string"),),
            ),
            "data_types": _DeclaredSet(
                item_fields=frozenset(),
                sort_keys=(_SortKey("__item__", "string"),),
                scalar_strings=True,
            ),
            "gaps": _DeclaredSet(
                item_fields=_model_fields(GapV1),
                sort_keys=(
                    _SortKey("start_ns", "numeric-string"),
                    _SortKey("end_ns", "numeric-string"),
                    _SortKey("instrument_id", "string"),
                ),
            ),
            "duplicates": _DeclaredSet(
                item_fields=_model_fields(DuplicateV1),
                sort_keys=(
                    _SortKey("ts_event_ns", "numeric-string"),
                    _SortKey("source_seq", "integer"),
                    _SortKey("record_hash", "string"),
                ),
            ),
        },
    ),
    "CostFillModel.v1": _DeclaredSchema(
        fields=_model_fields(CostFillModelV1), set_fields={}
    ),
    "InformationSetPolicy.v1": _DeclaredSchema(
        fields=_model_fields(InformationSetPolicyV1), set_fields={}
    ),
    "EvaluationProtocol.v1": _DeclaredSchema(
        fields=_model_fields(EvaluationProtocolV1), set_fields={}
    ),
    "CatalogInventory.v1": _DeclaredSchema(
        fields=_model_fields(CatalogInventoryV1),
        set_fields={
            "catalog_files": _DeclaredSet(
                item_fields=_model_fields(CatalogFileV1),
                sort_keys=(_SortKey("relative_path", "string"),),
            ),
            "source_records": _DeclaredSet(
                item_fields=_model_fields(CatalogSourceRecordV1),
                sort_keys=(
                    _SortKey("ts_available_ns", "numeric-string"),
                    _SortKey("source_seq", "integer"),
                    _SortKey("record_hash", "string"),
                ),
            ),
            "gaps": _DeclaredSet(
                item_fields=_model_fields(GapV1),
                sort_keys=(
                    _SortKey("start_ns", "numeric-string"),
                    _SortKey("end_ns", "numeric-string"),
                    _SortKey("instrument_id", "string"),
                ),
            ),
            "duplicates": _DeclaredSet(
                item_fields=_model_fields(DuplicateV1),
                sort_keys=(
                    _SortKey("ts_event_ns", "numeric-string"),
                    _SortKey("source_seq", "integer"),
                    _SortKey("record_hash", "string"),
                ),
            ),
        },
    ),
    "CatalogFileSet.v1": _DeclaredSchema(
        fields=_model_fields(CatalogFileSetV1),
        set_fields={
            "catalog_files": _DeclaredSet(
                item_fields=_model_fields(CatalogFileV1),
                sort_keys=(_SortKey("relative_path", "string"),),
            )
        },
    ),
    "CatalogManifest.v1": _DeclaredSchema(
        fields=_model_fields(CatalogManifestV1), set_fields={}
    ),
    "CatalogValidatedAudit.v1": _DeclaredSchema(
        fields=_model_fields(CatalogValidatedAuditV1), set_fields={}
    ),
    "CatalogMapping.v1": _DeclaredSchema(
        fields=_model_fields(CatalogMappingV1),
        set_fields={},
    ),
    "CatalogNativeFingerprint.v1": _DeclaredSchema(
        fields=_model_fields(CatalogNativeFingerprintV1),
        set_fields={},
    ),
    "ReplayNormalization.v1": _DeclaredSchema(
        fields=frozenset(
            {
                "schema",
                "input_manifest_hash",
                "event_projection_hash",
                "report_projection_hashes",
            }
        ),
        set_fields={},
    ),
    "RunRecord.v1": _DeclaredSchema(
        fields=_model_fields(RunRecordV1),
        set_fields={},
    ),
    "RunSeal.v1": _DeclaredSchema(
        fields=frozenset(
            {
                "schema",
                "run_id",
                "terminal_state",
                "terminal_event_seq",
                "last_audit_seq",
                "audit_head_hash",
                "files",
            }
        ),
        set_fields={
            "files": _DeclaredSet(
                item_fields=frozenset({"relative_path", "sha256", "size_bytes"}),
                sort_keys=(_SortKey("relative_path", "string"),),
            )
        },
    ),
    "FinalizationFault.v1": _DeclaredSchema(
        fields=frozenset(
            {
                "schema",
                "run_id",
                "outcome_hash",
                "initial_event_digest",
                "category",
                "stage",
                "attempt_count",
                "observed_at_ns",
            }
        ),
        set_fields={},
    ),
    "SetFixture.v1": _DeclaredSchema(
        fields=frozenset({"schema", "items"}),
        set_fields={
            "items": _DeclaredSet(
                item_fields=frozenset({"id", "amount"}),
                sort_keys=(_SortKey("id", "string"),),
            )
        },
    ),
    "CompositeSetFixture.v1": _DeclaredSchema(
        fields=frozenset({"schema", "items"}),
        set_fields={
            "items": _DeclaredSet(
                item_fields=frozenset({"ts_ns", "source_seq", "name"}),
                sort_keys=(
                    _SortKey("ts_ns", "numeric-string"),
                    _SortKey("source_seq", "integer"),
                    _SortKey("name", "string"),
                ),
            )
        },
    ),
}
_SCHEMA_MODELS: dict[str, type[BaseModel]] = {
    "InputManifest.v1": InputManifestV1,
    "CostFillModel.v1": CostFillModelV1,
    "InformationSetPolicy.v1": InformationSetPolicyV1,
    "EvaluationProtocol.v1": EvaluationProtocolV1,
    "CatalogInventory.v1": CatalogInventoryV1,
    "CatalogFileSet.v1": CatalogFileSetV1,
    "CatalogManifest.v1": CatalogManifestV1,
    "CatalogValidatedAudit.v1": CatalogValidatedAuditV1,
    "CatalogMapping.v1": CatalogMappingV1,
    "CatalogNativeFingerprint.v1": CatalogNativeFingerprintV1,
    "RunRecord.v1": RunRecordV1,
}
_TASK9_SCHEMA_NAMES = frozenset(
    {"RunRecord.v1", "RunSeal.v1", "FinalizationFault.v1"}
)
_CHILD_SCHEMAS: dict[tuple[str, str], str] = {
    ("InputManifest.v1", "information_set_policy"): "InformationSetPolicy.v1",
    ("InputManifest.v1", "evaluation_protocol"): "EvaluationProtocol.v1",
    ("InputManifest.v1", "cost_fill_model"): "CostFillModel.v1",
    ("CatalogManifest.v1", "inventory"): "CatalogInventory.v1",
    ("CatalogInventory.v1", "information_set_policy"): "InformationSetPolicy.v1",
    ("CatalogInventory.v1", "evaluation_protocol"): "EvaluationProtocol.v1",
    ("CatalogInventory.v1", "mapping"): "CatalogMapping.v1",
    ("CatalogInventory.v1", "native_fingerprint"): "CatalogNativeFingerprint.v1",
}
# These schema-less Task 3 roots use only ``strategy_id`` from the current
# InputManifest field declaration (native report rows pass through here for
# their fingerprint). All remaining InputManifest root fields are reserved.
_INPUT_MANIFEST_SCHEMALESS_ROOT_OVERLAPS = frozenset({"strategy_id"})
_INPUT_MANIFEST_ROOT_SIGNATURE = _DECLARED_SCHEMAS["InputManifest.v1"].fields.difference(
    {"schema"} | _INPUT_MANIFEST_SCHEMALESS_ROOT_OVERLAPS
)
_INFORMATION_SET_POLICY_ROOT_SIGNATURE = _DECLARED_SCHEMAS[
    "InformationSetPolicy.v1"
].fields.difference({"schema"})
_EVALUATION_PROTOCOL_ROOT_SIGNATURE = _DECLARED_SCHEMAS[
    "EvaluationProtocol.v1"
].fields.difference({"schema"})
_CATALOG_MAPPING_ROOT_SIGNATURE = _DECLARED_SCHEMAS[
    "CatalogMapping.v1"
].fields.difference({"schema"})
_CATALOG_NATIVE_FINGERPRINT_ROOT_SIGNATURE = frozenset(
    {
        "installed_nautilus_version",
        "native_extension_sha256",
        "writer_class",
        "writer_options",
    }
)
_RUN_RECORD_ROOT_SIGNATURE = frozenset(
    {
        "idempotency_scope",
        "materialized_event_seq",
        "materialized_audit_seq",
        "prepared_terminal_state_version",
        "runner_exit",
    }
)
_RUN_SEAL_ROOT_SIGNATURE = frozenset(
    {"audit_head_hash", "terminal_event_seq", "last_audit_seq"}
)
_FINALIZATION_FAULT_ROOT_SIGNATURE = frozenset(
    {"initial_event_digest", "attempt_count", "observed_at_ns"}
)
_TERMINAL_STATE_NAMES = frozenset({"COMPLETED", "FAILED", "CANCELLED"})
_FINALIZATION_FAULT_CATEGORIES = frozenset(
    {"DETERMINISTIC_EVIDENCE_FAILURE", "OPERATIONAL_RETRY_EXHAUSTED"}
)
_FINALIZATION_FAULT_STAGES = frozenset(
    {
        "STAGING",
        "REPORTS",
        "RECONCILIATION",
        "MATERIALIZATION",
        "FSYNC",
        "RENAME",
        "SEAL",
        "PUBLICATION",
    }
)


def canonical_json_bytes(value: object) -> bytes:
    """Encode one validated JSON value as canonical UTF-8 bytes.

    Sorting and set-like array rules are module-owned declarations.  Callers
    cannot supply filters, sort functions, or type coercions.
    """

    normalized = _normalize(value, allow_declared_schema=True)
    try:
        return json.dumps(
            normalized,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except ValueError as error:
        raise CanonicalJSONError(
            "CanonicalJSON.v1 integer exceeds the Python runtime limit."
        ) from error


def parse_json_object(raw: str | bytes) -> dict[str, JsonValue]:
    """Parse raw JSON while rejecting duplicate object keys."""

    try:
        parsed = json.loads(raw, object_pairs_hook=_reject_duplicate_pairs)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise CanonicalJSONError(str(error)) from error
    if type(parsed) is not dict:
        raise CanonicalJSONError("CanonicalJSON.v1 raw input must be an object.")
    normalized = _normalize(parsed, allow_declared_schema=True)
    if type(normalized) is not dict:
        raise CanonicalJSONError("CanonicalJSON.v1 raw input must be an object.")
    return normalized


def canonical_decimal_string(value: Decimal) -> str:
    """Return a non-exponent canonical decimal string."""

    if not value.is_finite():
        raise CanonicalJSONError("Decimal values must be finite.")
    normalized = format(value, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    if normalized in {"", "-0"}:
        return "0"
    return normalized


def _reject_duplicate_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise CanonicalJSONError(f"duplicate key: {key}")
        result[key] = value
    return result


def _normalize(
    value: object,
    *,
    allow_declared_schema: bool = False,
    expected_schema: str | None = None,
) -> JsonValue:
    if expected_schema is not None and type(value) is not dict:
        raise CanonicalJSONError(f"{expected_schema} schema must be an object")
    if value is None or type(value) is bool or type(value) is str:
        return value
    if type(value) is int:
        return value
    if isinstance(value, Decimal):
        return canonical_decimal_string(value)
    if isinstance(value, float):
        raise CanonicalJSONError("Binary float values are not permitted.")
    if type(value) is list:
        return [_normalize(item) for item in value]
    if type(value) is dict:
        return _normalize_object(
            value,
            allow_declared_schema=allow_declared_schema,
            expected_schema=expected_schema,
        )
    raise CanonicalJSONError(f"Unsupported CanonicalJSON.v1 runtime type: {type(value).__name__}")


def _normalize_object(
    value: dict[object, object],
    *,
    allow_declared_schema: bool = False,
    expected_schema: str | None = None,
    validate_model: bool = True,
) -> dict[str, JsonValue]:
    if (
        allow_declared_schema
        and expected_schema is None
        and validate_model
        and set(value) == _BACKTEST_DRAFT_FIELDS
        and "schema" not in value
    ):
        try:
            validated_draft = BacktestDraftRequest.model_validate(value)
        except ValidationError as error:
            raise CanonicalJSONError(f"invalid BacktestDraftRequest: {error}") from error
        return _normalize_object(
            cast(
                dict[object, object],
                validated_draft.model_dump(mode="json", by_alias=True),
            ),
            allow_declared_schema=False,
            validate_model=False,
        )
    schema_name = value.get("schema")
    if expected_schema is not None:
        if type(schema_name) is not str:
            raise CanonicalJSONError(f"{expected_schema} schema must be a string")
        if schema_name != expected_schema:
            raise CanonicalJSONError(f"expected {expected_schema} schema")
    elif allow_declared_schema:
        shaped_schema = _shaped_root_schema(value)
        if shaped_schema is not None:
            if type(schema_name) is not str:
                raise CanonicalJSONError(f"{shaped_schema} schema must be a string")
            if schema_name != shaped_schema:
                raise CanonicalJSONError(f"expected {shaped_schema} schema")
        elif "schema" in value and type(schema_name) is not str:
            raise CanonicalJSONError("declared root schema must be a string")
    if (
        allow_declared_schema
        and validate_model
        and type(schema_name) is str
        and schema_name in _TASK9_SCHEMA_NAMES
    ):
        if not all(type(key) is str for key in value):
            raise CanonicalJSONError("JSON object keys must be strings.")
        raw_fields = cast(set[str], set(value))
        declaration = _DECLARED_SCHEMAS[schema_name]
        unknown = raw_fields.difference(declaration.fields)
        if unknown:
            raise CanonicalJSONError(f"unknown field for {schema_name}: {sorted(unknown)[0]}")
        missing = declaration.fields.difference(raw_fields)
        if missing:
            raise CanonicalJSONError(f"missing field for {schema_name}: {sorted(missing)[0]}")
    if allow_declared_schema and validate_model and type(schema_name) is str:
        model = _SCHEMA_MODELS.get(schema_name)
        if model is not None:
            try:
                validated = model.model_validate(value)
            except ValidationError as error:
                raise CanonicalJSONError(f"invalid {schema_name}: {error}") from error
            return _normalize_object(
                cast(dict[object, object], validated.model_dump(mode="json", by_alias=True)),
                allow_declared_schema=True,
                expected_schema=expected_schema,
                validate_model=False,
            )
    normalized: dict[str, JsonValue] = {}
    root_schema = (
        cast(str, value.get("schema")) if type(value.get("schema")) is str else None
    )
    for raw_key, item in value.items():
        if type(raw_key) is not str:
            raise CanonicalJSONError("JSON object keys must be strings.")
        expected_child_schema = (
            _CHILD_SCHEMAS.get((root_schema, raw_key)) if root_schema is not None else None
        )
        normalized[raw_key] = _normalize(
            item,
            allow_declared_schema=expected_child_schema is not None,
            expected_schema=expected_child_schema,
        )
    schema = normalized.get("schema")
    if allow_declared_schema and type(schema) is str:
        if schema not in _DECLARED_SCHEMAS:
            raise CanonicalJSONError(f"unregistered declared schema: {schema}")
        declaration = _DECLARED_SCHEMAS[schema]
        unknown = set(normalized).difference(declaration.fields)
        if unknown:
            raise CanonicalJSONError(f"unknown field for {schema}: {sorted(unknown)[0]}")
        missing = declaration.fields.difference(normalized)
        if missing:
            raise CanonicalJSONError(f"missing field for {schema}: {sorted(missing)[0]}")
        for field, set_declaration in declaration.set_fields.items():
            array = normalized[field]
            if type(array) is not list:
                raise CanonicalJSONError(f"{schema}.{field} requires an array")
            if set_declaration.scalar_strings:
                if not all(type(item) is str for item in array):
                    raise CanonicalJSONError(f"{schema}.{field} requires string items")
                if len(set(array)) != len(array):
                    raise CanonicalJSONError(f"{schema}.{field} has duplicate items")
                normalized[field] = cast(JsonValue, sorted(array))
                continue
            set_items: list[dict[str, JsonValue]] = []
            seen_keys: set[tuple[object, ...]] = set()
            for item in array:
                if type(item) is not dict or set(item) != set_declaration.item_fields:
                    raise CanonicalJSONError(
                        f"{schema}.{field} requires exact declared objects"
                    )
                set_item = cast(dict[str, JsonValue], item)
                sort_key = _declared_set_sort_value(set_item, set_declaration.sort_keys)
                if sort_key in seen_keys:
                    raise CanonicalJSONError(
                        f"{schema}.{field} has duplicate composite sort key"
                    )
                seen_keys.add(sort_key)
                set_items.append(set_item)
            set_items.sort(
                key=lambda item: _declared_set_sort_value(item, set_declaration.sort_keys)
            )
            normalized[field] = cast(JsonValue, set_items)
        _validate_task9_schema(schema, normalized)
    return normalized


def _shaped_root_schema(value: dict[object, object]) -> str | None:
    declared = value.get("schema")
    if type(declared) is str and declared in _DECLARED_SCHEMAS:
        return declared
    if any(field in value for field in _RUN_RECORD_ROOT_SIGNATURE):
        return "RunRecord.v1"
    if any(field in value for field in _RUN_SEAL_ROOT_SIGNATURE):
        return "RunSeal.v1"
    if any(field in value for field in _FINALIZATION_FAULT_ROOT_SIGNATURE):
        return "FinalizationFault.v1"
    if "inventory" in value or (
        value.get("label") == "LOCAL QA FIXTURE" and "inventory_hash" in value
    ):
        return "CatalogManifest.v1"
    if any(field in value for field in ("catalog_files", "source_records", "mapping")):
        if value.get("schema") == "CatalogFileSet.v1" or set(value) <= {"schema", "catalog_files"}:
            return "CatalogFileSet.v1"
        return "CatalogInventory.v1"
    if value.get("action") == "catalog.validated" or (
        "catalog_revision" in value and "inventory_hash" in value
    ):
        return "CatalogValidatedAudit.v1"
    if any(field in value for field in _CATALOG_MAPPING_ROOT_SIGNATURE):
        return "CatalogMapping.v1"
    if any(field in value for field in _CATALOG_NATIVE_FINGERPRINT_ROOT_SIGNATURE):
        return "CatalogNativeFingerprint.v1"
    if any(field in value for field in _INFORMATION_SET_POLICY_ROOT_SIGNATURE):
        return "InformationSetPolicy.v1"
    if any(field in value for field in _EVALUATION_PROTOCOL_ROOT_SIGNATURE):
        return "EvaluationProtocol.v1"
    if any(field in value for field in _INPUT_MANIFEST_ROOT_SIGNATURE):
        return "InputManifest.v1"
    return None


def _validate_task9_schema(schema: str, value: dict[str, JsonValue]) -> None:
    if schema == "RunSeal.v1":
        _require_nonempty_string(value, "run_id", schema=schema)
        if value["terminal_state"] not in _TERMINAL_STATE_NAMES:
            raise CanonicalJSONError("RunSeal.v1 terminal_state is invalid")
        for field in ("terminal_event_seq", "last_audit_seq"):
            if type(value[field]) is not int or cast(int, value[field]) <= 0:
                raise CanonicalJSONError(f"RunSeal.v1 {field} must be a positive integer")
        if value["terminal_event_seq"] != value["last_audit_seq"]:
            raise CanonicalJSONError("RunSeal.v1 terminal boundaries must be equal")
        _require_sha256(value, "audit_head_hash", schema=schema)
        files = value["files"]
        assert type(files) is list
        for item in files:
            assert type(item) is dict
            file_item = item
            _require_safe_relative_path(file_item["relative_path"])
            _require_sha256(file_item, "sha256", schema="RunSeal.v1 file")
            if type(file_item["size_bytes"]) is not int or file_item["size_bytes"] < 0:
                raise CanonicalJSONError(
                    "RunSeal.v1 file size_bytes must be a non-negative integer"
                )
    elif schema == "FinalizationFault.v1":
        _require_nonempty_string(value, "run_id", schema=schema)
        _require_sha256(value, "outcome_hash", schema=schema)
        _require_sha256(value, "initial_event_digest", schema=schema)
        if value["category"] not in _FINALIZATION_FAULT_CATEGORIES:
            raise CanonicalJSONError("FinalizationFault.v1 category is invalid")
        if value["stage"] not in _FINALIZATION_FAULT_STAGES:
            raise CanonicalJSONError("FinalizationFault.v1 stage is invalid")
        if type(value["attempt_count"]) is not int or value["attempt_count"] != 3:
            raise CanonicalJSONError("FinalizationFault.v1 attempt_count must equal 3")
        if type(value["observed_at_ns"]) is not int or value["observed_at_ns"] < 0:
            raise CanonicalJSONError(
                "FinalizationFault.v1 observed_at_ns must be a non-negative integer"
            )


def _require_nonempty_string(
    value: dict[str, JsonValue], field: str, *, schema: str
) -> str:
    candidate = value[field]
    if type(candidate) is not str or not candidate:
        raise CanonicalJSONError(f"{schema} {field} must be a non-empty string")
    return candidate


def _require_sha256(value: dict[str, JsonValue], field: str, *, schema: str) -> str:
    digest = value[field]
    if (
        type(digest) is not str
        or len(digest) != 64
        or any(character not in "0123456789abcdef" for character in digest)
    ):
        raise CanonicalJSONError(f"{schema} {field} must be lowercase SHA-256")
    return digest


def _require_safe_relative_path(value: JsonValue) -> str:
    if type(value) is not str or not value or value.startswith("/"):
        raise CanonicalJSONError("RunSeal.v1 relative_path is invalid")
    if "\\" in value or ":" in value or "\x00" in value or "//" in value:
        raise CanonicalJSONError("RunSeal.v1 relative_path is invalid")
    if any(component in {"", ".", ".."} for component in value.split("/")):
        raise CanonicalJSONError("RunSeal.v1 relative_path is invalid")
    return value


def _declared_set_sort_value(
    item: dict[str, JsonValue], keys: tuple[_SortKey, ...]
) -> tuple[object, ...]:
    result: list[object] = []
    for key in keys:
        value = item.get(key.name)
        if key.kind == "string":
            if type(value) is not str:
                raise CanonicalJSONError(f"Declared set key {key.name} must be a string.")
            result.append(value)
        elif key.kind == "numeric-string":
            if (
                type(value) is not str
                or not value.isascii()
                or not value.isdigit()
                or (len(value) > 1 and value.startswith("0"))
            ):
                raise CanonicalJSONError(
                    f"Declared set key {key.name} must be a non-negative integer string."
                )
            result.append((len(value), value))
        else:
            if type(value) is not int:
                raise CanonicalJSONError(f"Declared set key {key.name} must be an integer.")
            result.append(value)
    return tuple(result)
