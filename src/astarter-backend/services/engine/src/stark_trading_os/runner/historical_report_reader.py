"""Revalidate original historical report bytes without constructing an engine.

Expectations and reverify digests must come from the caller's committed receipt.
These values establish consistency, not a permission to run or seal artifacts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from hashlib import sha256
from typing import Literal

from stark_trading_os.audit.canonical_json import parse_json_object
from stark_trading_os.audit.historical_input import (
    _CATALOG_BYTE_LIMIT,
    _CONTRACT_BYTE_LIMIT,
    parse_input_manifest_bytes,
    validate_input_bindings,
)
from stark_trading_os.catalog.historical_catalog import (
    canonical_historical_bytes,
    parse_historical_manifest_bytes,
)
from stark_trading_os.domain.historical_input import InputManifestV2
from stark_trading_os.runner.historical_input_adapter import _check_catalog_runtime
from stark_trading_os.runner.historical_report_semantics import (
    _strict_values,
    normalize_historical_report_tables_v2,
    validate_historical_report_facts_v2,
)
from stark_trading_os.runner.report_export import ReportSchemaError

MAX_REPORT_BYTES = 128 * 1024 * 1024
MAX_JSON_DEPTH = 64
_INVALID = "historical report evidence is invalid"
_TABLES = ("orders", "fills", "positions", "account")
type ReportStatusV2 = Literal["INTERNAL_REPORT_CHECK_PASSED", "INTERNAL_REPORT_CHECK_FAILED"]


@dataclass(frozen=True, slots=True)
class HistoricalReportExpectationV2:
    """Caller-owned immutable values; every public entry validates them afresh."""

    run_id: str
    input_manifest_bytes: bytes
    input_manifest_sha256: str
    catalog_manifest_bytes: bytes
    account_id: str


@dataclass(frozen=True, slots=True)
class ValidatedHistoricalReportV2:
    run_id: str
    input_manifest_sha256: str
    report_sha256: str
    component_snapshot_sha256: str
    status: ReportStatusV2
    consistency_failures: tuple[str, ...]
    table_counts: tuple[tuple[str, int], ...]


def _check_bytes(raw: bytes, *, limit: int) -> None:
    """Check size and container depth before any recursive decoder/normalizer."""
    if type(raw) is not bytes or not raw or len(raw) > limit:
        raise ReportSchemaError(_INVALID)
    depth = 0
    quoted = escaped = False
    for byte in raw:
        if quoted:
            if escaped:
                escaped = False
            elif byte == 92:
                escaped = True
            elif byte == 34:
                quoted = False
        elif byte == 34:
            quoted = True
        elif byte in (91, 123):
            depth += 1
            if depth > MAX_JSON_DEPTH:
                raise ReportSchemaError(_INVALID)
        elif byte in (93, 125):
            depth -= 1
            if depth < 0:
                raise ReportSchemaError(_INVALID)
    if quoted or depth:
        raise ReportSchemaError(_INVALID)


def _trusted_input(expected: HistoricalReportExpectationV2) -> InputManifestV2:
    if (
        type(expected) is not HistoricalReportExpectationV2
        or type(expected.run_id) is not str
        or re.fullmatch(r"bt_[0-9a-f]{32}", expected.run_id) is None
        or type(expected.account_id) is not str
        or not expected.account_id.strip()
    ):
        raise ReportSchemaError(_INVALID)
    _check_bytes(expected.input_manifest_bytes, limit=_CONTRACT_BYTE_LIMIT)
    _check_bytes(expected.catalog_manifest_bytes, limit=_CATALOG_BYTE_LIMIT)
    manifest = parse_input_manifest_bytes(
        expected.input_manifest_bytes, expected_sha256=expected.input_manifest_sha256
    )
    validate_input_bindings(
        manifest,
        catalog_manifest_bytes=expected.catalog_manifest_bytes,
        expected_runtime=manifest.runtime,
    )
    # This checks the saved fingerprint only. It never observes the current host.
    _check_catalog_runtime(
        parse_historical_manifest_bytes(expected.catalog_manifest_bytes), manifest.runtime
    )
    return manifest


def validate_historical_report_candidate_v2(
    *,
    report_bytes: bytes,
    component_snapshot_bytes: bytes,
    expected: HistoricalReportExpectationV2,
) -> ValidatedHistoricalReportV2:
    """Validate candidate evidence; no DB, sealing, filesystem or run authority."""
    try:
        _check_bytes(report_bytes, limit=MAX_REPORT_BYTES)
        _check_bytes(component_snapshot_bytes, limit=MAX_REPORT_BYTES)
        manifest = _trusted_input(expected)
        report = parse_json_object(report_bytes)
        snapshot = parse_json_object(component_snapshot_bytes)
        if (
            canonical_historical_bytes(report) != report_bytes
            or canonical_historical_bytes(snapshot) != component_snapshot_bytes
        ):
            raise ReportSchemaError(_INVALID)
        _strict_values(report)
        tables = normalize_historical_report_tables_v2(report["tables"])
        dataset = manifest.dataset
        start, step = int(dataset.window.first_close_ns), int(dataset.timeframe_ns)
        cash, failures = validate_historical_report_facts_v2(
            snapshot=snapshot,
            tables=tables,
            expected_input_sha256=expected.input_manifest_sha256,
            expected_bar_times=tuple(
                (start + i * step, start + i * step) for i in range(dataset.record_count)
            ),
            currencies=(dataset.base_currency, dataset.quote_currency),
            instrument_id=dataset.instrument_id,
            account_id=expected.account_id,
            starting_cash=manifest.configuration.configuration.execution_cost.starting_cash,
        )
        snapshot_digest = sha256(component_snapshot_bytes).hexdigest()
        status: ReportStatusV2 = (
            "INTERNAL_REPORT_CHECK_FAILED" if failures else "INTERNAL_REPORT_CHECK_PASSED"
        )
        # Rebuild every consumed field. Canonical byte equality rejects unknown
        # fields, lost facts, coercions, reordered rows and forged diagnostics.
        rebuilt: dict[str, object] = dict(
            schema_version=2,
            scope="IN_MEMORY_HISTORICAL_REPORT_COMPONENT",
            status=status,
            identity=dict(
                run_id=expected.run_id,
                input_manifest_sha256=expected.input_manifest_sha256,
                configuration_content_sha256=manifest.configuration_content_sha256,
                catalog_revision=dataset.catalog_revision,
                cost_sha256=manifest.cost_sha256,
                runtime=manifest.runtime.model_dump(mode="json"),
                account_id=expected.account_id,
            ),
            tables=tables,
            cash_series=cash,
            component_snapshot_sha256=snapshot_digest,
            consistency_failures=list(failures),
        )
        if canonical_historical_bytes(rebuilt) != report_bytes:
            raise ReportSchemaError(_INVALID)
        return ValidatedHistoricalReportV2(
            run_id=expected.run_id,
            input_manifest_sha256=expected.input_manifest_sha256,
            report_sha256=sha256(report_bytes).hexdigest(),
            component_snapshot_sha256=snapshot_digest,
            status=status,
            consistency_failures=failures,
            table_counts=tuple((k, len(tables[k])) for k in _TABLES),
        )
    except (ValueError, TypeError, KeyError, AttributeError, ArithmeticError, RecursionError):
        # Parser and reused row codecs may include input in their diagnostics.
        raise ReportSchemaError(_INVALID) from None


def reverify_historical_report_v2(
    *,
    report_bytes: bytes,
    component_snapshot_bytes: bytes,
    expected: HistoricalReportExpectationV2,
    expected_report_sha256: str,
    expected_component_snapshot_sha256: str,
) -> ValidatedHistoricalReportV2:
    """Require both previously committed artifact digests, then recheck semantics."""
    for raw, digest in (
        (report_bytes, expected_report_sha256),
        (component_snapshot_bytes, expected_component_snapshot_sha256),
    ):
        _check_bytes(raw, limit=MAX_REPORT_BYTES)
        if (
            type(digest) is not str
            or re.fullmatch(r"[0-9a-f]{64}", digest) is None
            or sha256(raw).hexdigest() != digest
        ):
            raise ReportSchemaError(_INVALID)
    return validate_historical_report_candidate_v2(
        report_bytes=report_bytes,
        component_snapshot_bytes=component_snapshot_bytes,
        expected=expected,
    )
