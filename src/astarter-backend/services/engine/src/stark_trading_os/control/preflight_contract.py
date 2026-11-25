"""Closed no-I/O contract for authoritative preflight check evidence."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from types import MappingProxyType

PREFLIGHT_CHECK_CODES = frozenset(
    {
        "BALANCE_INVALID",
        "BALANCE_MODEL_MISSING",
        "BALANCE_VALID",
        "CATALOG_INTEGRITY_FAILED",
        "CATALOG_NOT_PUBLISHED",
        "CATALOG_PUBLISHED",
        "CATALOG_UNKNOWN",
        "CATALOG_UNREADABLE",
        "COST_FEE_MISSING",
        "COST_FILL_SUPPORTED",
        "COST_LATENCY_MISSING",
        "COST_SLIPPAGE_MISSING",
        "COST_SPREAD_MISSING",
        "CURRENCY_MATCH",
        "CURRENCY_MISMATCH",
        "ENGINE_TAG_MISMATCH",
        "ENGINE_TAG_VALID",
        "ENGINE_VERSION_MISMATCH",
        "ENGINE_VERSION_VALID",
        "EVALUATION_PROTOCOL_MATCH",
        "EVALUATION_PROTOCOL_MISMATCH",
        "FILL_CANCEL_MISSING",
        "FILL_LIQUIDITY_MISSING",
        "INFORMATION_SET_MATCH",
        "INFORMATION_SET_MISMATCH",
        "PRECISION_MISMATCH",
        "PRECISION_MODE_MISMATCH",
        "PRECISION_MODE_VALID",
        "PRECISION_VALID",
        "PYTHON_VERSION_MISMATCH",
        "PYTHON_VERSION_VALID",
        "RISK_POLICY_HASH_MISMATCH",
        "RISK_POLICY_MISSING",
        "RISK_POLICY_UNSUPPORTED",
        "RISK_POLICY_UNKNOWN",
        "RISK_POLICY_VALID",
        "RUN_ROOT_INVALID",
        "RUN_ROOT_VALID",
        "STRATEGY_HASH_MISMATCH",
        "STRATEGY_UNSUPPORTED",
        "STRATEGY_UNKNOWN",
        "STRATEGY_VALID",
        "UNSUPPORTED_COST_FILL_MODEL",
        "VENUE_ACCOUNT_UNSUPPORTED",
        "WINDOW_OUT_OF_RANGE",
        "WINDOW_VALID",
    }
)
PREFLIGHT_CHECK_EXPLANATIONS: Mapping[str, str] = MappingProxyType(
    {
        "BALANCE_INVALID": "The configured starting balance must be greater than zero.",
        "BALANCE_MODEL_MISSING": "The draft does not include a venue account balance model.",
        "BALANCE_VALID": "The venue account balance model is complete and supported.",
        "CATALOG_INTEGRITY_FAILED": "The requested catalog revision failed integrity validation.",
        "CATALOG_NOT_PUBLISHED": "The requested catalog revision is not in the published state.",
        "CATALOG_PUBLISHED": "The requested immutable catalog revision is published and verified.",
        "CATALOG_UNKNOWN": "The requested catalog revision is not registered.",
        "CATALOG_UNREADABLE": "The requested catalog revision could not be read safely.",
        "COST_FEE_MISSING": "The cost and fill model is missing its fee policy.",
        "COST_FILL_SUPPORTED": "The complete cost and fill model maps to supported native models.",
        "COST_LATENCY_MISSING": "The cost and fill model is missing its latency policy.",
        "COST_SLIPPAGE_MISSING": "The cost and fill model is missing its slippage policy.",
        "COST_SPREAD_MISSING": "The cost and fill model is missing its spread policy.",
        "CURRENCY_MATCH": "The account venue and currency match the catalog instrument.",
        "CURRENCY_MISMATCH": "The account venue or currency does not match the catalog instrument.",
        "ENGINE_TAG_MISMATCH": (
            "The configured engine commit does not match the locked release commit."
        ),
        "ENGINE_TAG_VALID": "The configured engine commit matches the locked release commit.",
        "ENGINE_VERSION_MISMATCH": (
            "The installed Nautilus package version does not match the locked engine pin."
        ),
        "ENGINE_VERSION_VALID": (
            "The installed Nautilus package version matches the locked engine pin."
        ),
        "EVALUATION_PROTOCOL_MATCH": (
            "The requested evaluation protocol matches the catalog authority."
        ),
        "EVALUATION_PROTOCOL_MISMATCH": (
            "The requested evaluation protocol differs from the catalog authority."
        ),
        "FILL_CANCEL_MISSING": "The cost and fill model is missing its cancellation policy.",
        "FILL_LIQUIDITY_MISSING": "The cost and fill model is missing its liquidity policy.",
        "INFORMATION_SET_MATCH": (
            "The requested information-set policy matches the catalog authority."
        ),
        "INFORMATION_SET_MISMATCH": (
            "The requested information-set policy differs from the catalog authority."
        ),
        "PRECISION_MISMATCH": (
            "The instrument or runtime precision does not satisfy the fixed precision contract."
        ),
        "PRECISION_MODE_MISMATCH": (
            "The runtime precision mode does not match the locked engine mode."
        ),
        "PRECISION_MODE_VALID": "The runtime precision mode matches the locked engine mode.",
        "PRECISION_VALID": (
            "The instrument and runtime precision satisfy the fixed precision contract."
        ),
        "PYTHON_VERSION_MISMATCH": (
            "The runtime Python version does not match the locked engine environment."
        ),
        "PYTHON_VERSION_VALID": "The runtime Python version matches the locked engine environment.",
        "RISK_POLICY_HASH_MISMATCH": (
            "The registered risk policy bytes do not match their declared hash."
        ),
        "RISK_POLICY_MISSING": "The draft does not reference a risk policy.",
        "RISK_POLICY_UNSUPPORTED": (
            "The registered risk policy is not supported by this backtest release."
        ),
        "RISK_POLICY_UNKNOWN": "The requested risk policy is not registered.",
        "RISK_POLICY_VALID": "The requested risk policy is registered, canonical, and supported.",
        "RUN_ROOT_INVALID": "The server-owned run root is unavailable or invalid.",
        "RUN_ROOT_VALID": "The server-owned run root is an available directory.",
        "STRATEGY_HASH_MISMATCH": "The registered strategy bytes do not match their declared hash.",
        "STRATEGY_UNSUPPORTED": (
            "The registered strategy is not supported by this backtest release."
        ),
        "STRATEGY_UNKNOWN": "The requested strategy is not registered.",
        "STRATEGY_VALID": "The requested strategy is registered, canonical, and supported.",
        "UNSUPPORTED_COST_FILL_MODEL": (
            "The cost and fill model cannot map exactly to supported native models."
        ),
        "VENUE_ACCOUNT_UNSUPPORTED": (
            "The venue account semantics are not supported by this backtest release."
        ),
        "WINDOW_OUT_OF_RANGE": "The requested window is outside the published catalog range.",
        "WINDOW_VALID": "The requested window is fully contained by the published catalog range.",
    }
)
if set(PREFLIGHT_CHECK_EXPLANATIONS) != set(PREFLIGHT_CHECK_CODES):
    raise RuntimeError("Every preflight check code must have one stable explanation.")
PREFLIGHT_EVIDENCE_NAMES: Mapping[str, tuple[str, ...]] = MappingProxyType(
    {
        "BALANCE_INVALID": (
            "account_model_sha256",
            "starting_balance",
            "starting_balance_status",
        ),
        "BALANCE_MODEL_MISSING": ("account_model_status",),
        "BALANCE_VALID": (
            "account_model_sha256",
            "starting_balance",
            "native_profile_status",
        ),
        "CATALOG_INTEGRITY_FAILED": (
            "requested_revision",
            "observed_revision",
            "observed_status",
            "publication_bytes_sha256",
            "declared_inventory_digest",
            "observed_inventory_digest",
            "integrity_status",
        ),
        "CATALOG_NOT_PUBLISHED": (
            "requested_revision",
            "observed_revision",
            "observed_status",
            "publication_status",
        ),
        "CATALOG_PUBLISHED": (
            "catalog_revision",
            "inventory_hash",
            "publication_status",
        ),
        "CATALOG_UNKNOWN": ("catalog_revision", "lookup_status"),
        "CATALOG_UNREADABLE": ("catalog_revision", "read_status"),
        "COST_FEE_MISSING": ("cost_fill_sha256", "required_section", "section_status"),
        "COST_FILL_SUPPORTED": (
            "cost_fill_sha256",
            "fee_model",
            "slippage_model",
            "latency_model",
            "liquidity_source",
            "cancel_rule",
            "replay_seed",
        ),
        "COST_LATENCY_MISSING": (
            "cost_fill_sha256",
            "required_section",
            "section_status",
        ),
        "COST_SLIPPAGE_MISSING": (
            "cost_fill_sha256",
            "required_section",
            "section_status",
        ),
        "COST_SPREAD_MISSING": (
            "cost_fill_sha256",
            "required_section",
            "section_status",
        ),
        "CURRENCY_MATCH": (
            "account_model_sha256",
            "currency_authority_sha256",
            "venue_match",
            "currency_match",
        ),
        "CURRENCY_MISMATCH": (
            "account_model_sha256",
            "currency_authority_sha256",
            "venue_match",
            "currency_match",
        ),
        "ENGINE_TAG_MISMATCH": ("expected_commit", "observed_commit"),
        "ENGINE_TAG_VALID": ("expected_commit", "observed_commit"),
        "ENGINE_VERSION_MISMATCH": (
            "expected_version",
            "configured_version",
            "runtime_version",
        ),
        "ENGINE_VERSION_VALID": ("expected_version", "observed_version"),
        "EVALUATION_PROTOCOL_MATCH": (
            "requested_protocol_sha256",
            "catalog_protocol_sha256",
        ),
        "EVALUATION_PROTOCOL_MISMATCH": (
            "requested_protocol_sha256",
            "catalog_protocol_sha256",
        ),
        "FILL_CANCEL_MISSING": ("cost_fill_sha256", "required_section", "section_status"),
        "FILL_LIQUIDITY_MISSING": (
            "cost_fill_sha256",
            "required_section",
            "section_status",
        ),
        "INFORMATION_SET_MATCH": (
            "requested_policy_sha256",
            "catalog_policy_sha256",
        ),
        "INFORMATION_SET_MISMATCH": (
            "requested_policy_sha256",
            "catalog_policy_sha256",
        ),
        "PRECISION_MISMATCH": (
            "price_precision",
            "size_precision",
            "fixed_precision_limit",
            "catalog_engine_version",
            "catalog_python_version",
            "evaluated_engine_version",
            "evaluated_python_version",
            "validation_status",
        ),
        "PRECISION_MODE_MISMATCH": (
            "expected_mode",
            "configured_mode",
            "runtime_mode",
            "high_precision",
        ),
        "PRECISION_MODE_VALID": ("expected_mode", "observed_mode", "high_precision"),
        "PRECISION_VALID": (
            "price_precision",
            "size_precision",
            "fixed_precision_limit",
            "catalog_engine_version",
            "catalog_python_version",
            "evaluated_engine_version",
            "evaluated_python_version",
            "validation_status",
        ),
        "PYTHON_VERSION_MISMATCH": (
            "expected_version",
            "configured_version",
            "runtime_version",
        ),
        "PYTHON_VERSION_VALID": ("expected_version", "observed_version"),
        "RISK_POLICY_HASH_MISMATCH": (
            "risk_policy_ref",
            "declared_digest",
            "computed_sha256",
            "hash_status",
        ),
        "RISK_POLICY_MISSING": ("risk_policy_ref", "registry_status"),
        "RISK_POLICY_UNSUPPORTED": (
            "risk_policy_ref",
            "definition_sha256",
            "support_status",
        ),
        "RISK_POLICY_UNKNOWN": ("risk_policy_ref", "resolved_ref", "lookup_status"),
        "RISK_POLICY_VALID": (
            "risk_policy_ref",
            "definition_sha256",
            "support_status",
        ),
        "RUN_ROOT_INVALID": ("authority", "directory_status"),
        "RUN_ROOT_VALID": ("authority", "directory_status"),
        "STRATEGY_HASH_MISMATCH": (
            "strategy_ref",
            "declared_digest",
            "computed_sha256",
            "hash_status",
        ),
        "STRATEGY_UNSUPPORTED": (
            "strategy_ref",
            "definition_sha256",
            "support_status",
        ),
        "STRATEGY_UNKNOWN": ("strategy_ref", "resolved_ref", "lookup_status"),
        "STRATEGY_VALID": (
            "strategy_ref",
            "definition_sha256",
            "support_status",
        ),
        "UNSUPPORTED_COST_FILL_MODEL": (
            "cost_fill_sha256",
            "native_mapping_status",
            "replay_seed",
        ),
        "VENUE_ACCOUNT_UNSUPPORTED": ("account_model_sha256", "native_profile_status"),
        "WINDOW_OUT_OF_RANGE": (
            "requested_start_ns",
            "requested_end_ns",
            "catalog_start_ns",
            "catalog_end_ns",
            "range_status",
        ),
        "WINDOW_VALID": (
            "requested_start_ns",
            "requested_end_ns",
            "catalog_start_ns",
            "catalog_end_ns",
            "range_status",
        ),
    }
)
if set(PREFLIGHT_EVIDENCE_NAMES) != set(PREFLIGHT_CHECK_CODES):
    raise RuntimeError("Every preflight check code must have one closed evidence schema.")
PREFLIGHT_PASSING_CHECK_CODES = frozenset(
    {
        "BALANCE_VALID",
        "CATALOG_PUBLISHED",
        "COST_FILL_SUPPORTED",
        "CURRENCY_MATCH",
        "ENGINE_TAG_VALID",
        "ENGINE_VERSION_VALID",
        "EVALUATION_PROTOCOL_MATCH",
        "INFORMATION_SET_MATCH",
        "PRECISION_MODE_VALID",
        "PRECISION_VALID",
        "PYTHON_VERSION_VALID",
        "RISK_POLICY_VALID",
        "RUN_ROOT_VALID",
        "STRATEGY_VALID",
        "WINDOW_VALID",
    }
)
PREFLIGHT_READY_CHECKLIST = (
    "ENGINE_VERSION_VALID",
    "ENGINE_TAG_VALID",
    "PYTHON_VERSION_VALID",
    "PRECISION_MODE_VALID",
    "STRATEGY_VALID",
    "CATALOG_PUBLISHED",
    "COST_FILL_SUPPORTED",
    "RISK_POLICY_VALID",
    "BALANCE_VALID",
    "CURRENCY_MATCH",
    "RUN_ROOT_VALID",
    "INFORMATION_SET_MATCH",
    "EVALUATION_PROTOCOL_MATCH",
    "WINDOW_VALID",
    "PRECISION_VALID",
)

UNIX_EPOCH_NS_MIN = 1_000_000_000_000_000_000
UNIX_EPOCH_NS_MAX = 9_223_372_036_854_775_807
_CANONICAL_DECIMAL_PATTERN = re.compile(
    r"^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?|"
    r"-(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?))$"
)
_REGISTRY_REFERENCE_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*@[a-z0-9]+(?:-[a-z0-9]+)*$")


def validate_unix_epoch_ns(value: object, *, label: str) -> int:
    if type(value) is not int or not UNIX_EPOCH_NS_MIN <= value <= UNIX_EPOCH_NS_MAX:
        raise ValueError(
            f"{label} must be Unix epoch nanoseconds in the signed 64-bit absolute range."
        )
    return value


def sanitize_preflight_evidence_value(value: str) -> str:
    """Keep benign identifiers readable without retaining unsafe input or a derived digest."""

    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:@+-"
    upper = value.upper()
    if (
        value
        and len(value) <= 128
        and all(character in allowed for character in value)
        and not any(
            marker in upper for marker in ("API_KEY", "PASSWORD", "SECRET", "TOKEN", "CREDENTIAL")
        )
        and not upper.startswith("SK-")
    ):
        return value
    return "REDACTED"


def sanitize_preflight_registry_reference_value(value: object) -> str:
    if type(value) is str and _REGISTRY_REFERENCE_PATTERN.fullmatch(value) is not None:
        return value
    return "REDACTED" if type(value) is str else "UNAVAILABLE"


def validate_preflight_evidence(
    code: str,
    evidence: Sequence[tuple[str, str]],
) -> tuple[tuple[str, str], ...]:
    if code not in PREFLIGHT_EVIDENCE_NAMES:
        raise ValueError("Preflight check code is invalid.")
    validated = tuple(evidence)
    if tuple(name for name, _value in validated) != PREFLIGHT_EVIDENCE_NAMES[code]:
        raise ValueError("Preflight check evidence schema is invalid.")
    for name, value in validated:
        if type(name) is not str or type(value) is not str or not value:
            raise ValueError("Preflight check evidence value is invalid.")
        if name in {"risk_policy_ref", "strategy_ref"}:
            if value != "NONE" and _REGISTRY_REFERENCE_PATTERN.fullmatch(value) is None:
                raise ValueError("Preflight registry-reference evidence is invalid.")
        elif name == "resolved_ref":
            if value not in {"NONE", "REDACTED", "UNAVAILABLE"} and (
                _REGISTRY_REFERENCE_PATTERN.fullmatch(value) is None
            ):
                raise ValueError("Preflight resolved-reference evidence is invalid.")
        elif name in {
            "declared_inventory_digest",
            "observed_inventory_digest",
            "observed_revision",
        }:
            if len(value) > 128 or sanitize_preflight_evidence_value(value) != value:
                raise ValueError("Preflight observed catalog evidence is unsafe.")
        elif name.endswith("_ns"):
            if not value.isascii() or not value.isdecimal():
                raise ValueError("Preflight nanosecond evidence value is invalid.")
        elif name == "starting_balance":
            if _CANONICAL_DECIMAL_PATTERN.fullmatch(value) is None:
                raise ValueError("Preflight decimal evidence value is invalid.")
        elif len(value) > 128 or sanitize_preflight_evidence_value(value) != value:
            raise ValueError("Preflight check evidence contains unsafe context.")
        if name.endswith("sha256") and value not in {"INVALID", "NONE", "UNAVAILABLE"}:
            if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
                raise ValueError("Preflight digest evidence value is invalid.")
        if name == "expected_commit":
            if len(value) != 40 or any(character not in "0123456789abcdef" for character in value):
                raise ValueError("Preflight commit evidence value is invalid.")
        if name == "expected_version":
            if not value[0].isdigit():
                raise ValueError("Preflight version evidence value is invalid.")
        if name in {
            "fixed_precision_limit",
            "price_precision",
            "replay_seed",
            "size_precision",
        } and (not value.isascii() or not value.isdecimal()):
            raise ValueError("Preflight integer evidence value is invalid.")
    _validate_preflight_evidence_relationships(code, dict(validated))
    return validated


def _validate_preflight_evidence_relationships(code: str, facts: Mapping[str, str]) -> None:
    if code in {"ENGINE_VERSION_VALID", "PYTHON_VERSION_VALID"} and (
        facts["expected_version"] != facts["observed_version"]
    ):
        raise ValueError("Preflight version evidence is internally inconsistent.")
    if code in {"ENGINE_VERSION_MISMATCH", "PYTHON_VERSION_MISMATCH"} and (
        facts["expected_version"] == facts["configured_version"] == facts["runtime_version"]
    ):
        raise ValueError("Preflight version mismatch evidence reports no mismatch.")
    if code == "ENGINE_TAG_VALID" and facts["expected_commit"] != facts["observed_commit"]:
        raise ValueError("Preflight commit evidence is internally inconsistent.")
    if code == "ENGINE_TAG_MISMATCH" and facts["expected_commit"] == facts["observed_commit"]:
        raise ValueError("Preflight commit mismatch evidence reports no mismatch.")
    if code == "PRECISION_MODE_VALID" and (
        facts["expected_mode"] != facts["observed_mode"] or facts["high_precision"] != "ENABLED"
    ):
        raise ValueError("Preflight precision-mode evidence is internally inconsistent.")
    if code == "PRECISION_MODE_MISMATCH" and (
        facts["expected_mode"] == facts["configured_mode"] == facts["runtime_mode"]
        and facts["high_precision"] == "ENABLED"
    ):
        raise ValueError("Preflight precision-mode mismatch evidence reports no mismatch.")
    if code in {"STRATEGY_UNKNOWN", "RISK_POLICY_UNKNOWN"} and facts["lookup_status"] not in {
        "NOT_FOUND",
        "REFERENCE_MISMATCH",
    }:
        raise ValueError("Preflight registry lookup evidence is invalid.")
    if code in {"STRATEGY_UNKNOWN", "RISK_POLICY_UNKNOWN"} and (
        (facts["lookup_status"] == "NOT_FOUND") != (facts["resolved_ref"] == "NONE")
    ):
        raise ValueError("Preflight resolved-reference evidence is internally inconsistent.")
    if code in {"STRATEGY_HASH_MISMATCH", "RISK_POLICY_HASH_MISMATCH"} and (
        facts["hash_status"] != "MISMATCH" or facts["declared_digest"] == facts["computed_sha256"]
    ):
        raise ValueError("Preflight definition hash evidence is internally inconsistent.")
    if code in {"STRATEGY_VALID", "RISK_POLICY_VALID"} and (facts["support_status"] != "SUPPORTED"):
        raise ValueError("Preflight definition support evidence is invalid.")
    if code in {"STRATEGY_UNSUPPORTED", "RISK_POLICY_UNSUPPORTED"} and facts[
        "support_status"
    ] not in {"CATALOG_INCREMENT_UNSUPPORTED", "UNSUPPORTED"}:
        raise ValueError("Preflight definition support evidence is invalid.")
    if code == "RISK_POLICY_MISSING" and facts["registry_status"] != "MISSING":
        raise ValueError("Preflight risk-policy evidence is internally inconsistent.")

    expected_status = {
        "CATALOG_INTEGRITY_FAILED": ("integrity_status", "FAILED"),
        "CATALOG_NOT_PUBLISHED": ("publication_status", "NOT_PUBLISHED"),
        "CATALOG_PUBLISHED": ("publication_status", "PUBLISHED"),
        "CATALOG_UNKNOWN": ("lookup_status", "NOT_FOUND"),
        "RUN_ROOT_INVALID": ("directory_status", "UNAVAILABLE"),
        "RUN_ROOT_VALID": ("directory_status", "AVAILABLE_DIRECTORY"),
    }.get(code)
    if expected_status is not None and facts[expected_status[0]] != expected_status[1]:
        raise ValueError("Preflight status evidence is internally inconsistent.")
    if code == "CATALOG_UNREADABLE" and facts["read_status"] not in {
        "INVALID_RESPONSE",
        "UNREADABLE",
    }:
        raise ValueError("Preflight catalog-read evidence is internally inconsistent.")

    missing_section = {
        "COST_FEE_MISSING": "fee",
        "COST_SPREAD_MISSING": "spread",
        "COST_SLIPPAGE_MISSING": "slippage",
        "COST_LATENCY_MISSING": "latency",
        "FILL_LIQUIDITY_MISSING": "liquidity",
        "FILL_CANCEL_MISSING": "cancel",
    }.get(code)
    if missing_section is not None and (
        facts["required_section"] != missing_section or facts["section_status"] != "MISSING"
    ):
        raise ValueError("Preflight missing-section evidence is internally inconsistent.")
    if code == "UNSUPPORTED_COST_FILL_MODEL" and (facts["native_mapping_status"] != "UNSUPPORTED"):
        raise ValueError("Preflight cost-model evidence is internally inconsistent.")

    fixed_account_status = {
        "BALANCE_MODEL_MISSING": ("account_model_status", "MISSING"),
        "BALANCE_INVALID": ("starting_balance_status", "NON_POSITIVE"),
        "BALANCE_VALID": ("native_profile_status", "SUPPORTED"),
        "VENUE_ACCOUNT_UNSUPPORTED": ("native_profile_status", "UNSUPPORTED"),
    }.get(code)
    if fixed_account_status is not None and (
        facts[fixed_account_status[0]] != fixed_account_status[1]
    ):
        raise ValueError("Preflight account evidence is internally inconsistent.")
    if code in {"CURRENCY_MATCH", "CURRENCY_MISMATCH"}:
        matches = facts["venue_match"] == facts["currency_match"] == "TRUE"
        if matches != (code == "CURRENCY_MATCH"):
            raise ValueError("Preflight currency evidence is internally inconsistent.")
    if code in {"RUN_ROOT_VALID", "RUN_ROOT_INVALID"} and (
        facts["authority"] != "SERVER_CONFIGURED_RUN_ROOT"
    ):
        raise ValueError("Preflight run-root evidence is internally inconsistent.")

    if code in {"INFORMATION_SET_MATCH", "INFORMATION_SET_MISMATCH"}:
        same = facts["requested_policy_sha256"] == facts["catalog_policy_sha256"]
        if same != (code == "INFORMATION_SET_MATCH"):
            raise ValueError("Preflight information-set evidence is internally inconsistent.")
    if code in {"EVALUATION_PROTOCOL_MATCH", "EVALUATION_PROTOCOL_MISMATCH"}:
        same = facts["requested_protocol_sha256"] == facts["catalog_protocol_sha256"]
        if same != (code == "EVALUATION_PROTOCOL_MATCH"):
            raise ValueError("Preflight evaluation-protocol evidence is internally inconsistent.")
    if code in {"WINDOW_VALID", "WINDOW_OUT_OF_RANGE"}:
        contained = not _numeric_string_less(
            facts["requested_start_ns"], facts["catalog_start_ns"]
        ) and not _numeric_string_less(facts["catalog_end_ns"], facts["requested_end_ns"])
        if contained != (code == "WINDOW_VALID") or facts["range_status"] != (
            "CONTAINED" if contained else "OUT_OF_RANGE"
        ):
            raise ValueError("Preflight window evidence is internally inconsistent.")
    if code in {"PRECISION_VALID", "PRECISION_MISMATCH"}:
        precision_relationship_is_valid = (
            int(facts["price_precision"]) <= int(facts["fixed_precision_limit"])
            and int(facts["size_precision"]) <= int(facts["fixed_precision_limit"])
            and facts["catalog_engine_version"] == facts["evaluated_engine_version"]
            and facts["catalog_python_version"] == facts["evaluated_python_version"]
        )
        if precision_relationship_is_valid != (code == "PRECISION_VALID") or facts[
            "validation_status"
        ] != ("VALID" if precision_relationship_is_valid else "MISMATCH"):
            raise ValueError("Preflight precision evidence is internally inconsistent.")


def _numeric_string_less(left: str, right: str) -> bool:
    return (len(left), left) < (len(right), right)
