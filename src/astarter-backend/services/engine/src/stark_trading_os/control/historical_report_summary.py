"""Display only freshly verified facts; never calculate another accounting view."""

from stark_trading_os.audit.canonical_json import parse_json_object
from stark_trading_os.catalog.historical_catalog import canonical_historical_bytes
from stark_trading_os.control.historical_api_adapters import (
    _error,
    _published_context,
    _verified_bytes,
)
from stark_trading_os.control.historical_api_models import HistoricalReportSummary
from stark_trading_os.control.historical_control import HistoricalControl
from stark_trading_os.control.historical_preflight import _now

_REPORT = "reports/historical-report.json"
_COMPONENT = "reports/component-snapshot.json"
_IDENTITY_FIELDS = (
    "input_manifest_sha256",
    "configuration_content_sha256",
    "catalog_revision",
    "cost_sha256",
    "account_id",
)


def historical_report_summary(control: HistoricalControl, run_id: str) -> HistoricalReportSummary:
    preparation, expected, publication = _published_context(control, run_id)
    validation = preparation.anchor.validation
    if validation not in {"COMPLETE_PASSED", "COMPLETE_FAILED"} or _REPORT not in expected:
        # Even an absent or diagnostic report is meaningful only under a verified root.
        _verified_bytes(control, run_id, "seal.json", expected)
        raise _error(run_id, "REPORT_NOT_PRESENT", status=404)
    raw = _verified_bytes(control, run_id, _REPORT, expected)
    try:
        report = parse_json_object(raw)
        identity, tables, cash_series = report["identity"], report["tables"], report["cash_series"]
        if type(identity) is not dict or type(tables) is not dict or type(cash_series) is not dict:
            raise ValueError("Report projection records are invalid.")
        if (
            report["schema_version"] != 2
            or report["scope"] != "IN_MEMORY_HISTORICAL_REPORT_COMPONENT"
            or identity["run_id"] != run_id
            or identity["input_manifest_sha256"] != preparation.anchor.input_manifest_sha256
            or report["component_snapshot_sha256"] != expected[_COMPONENT][1]
            or set(tables) != {"orders", "fills", "positions", "account"}
        ):
            raise ValueError("Report projection identity is invalid.")
        counts = {}
        for name, rows in tables.items():
            if type(rows) is not list:
                raise ValueError("Report table is invalid.")
            counts[name] = len(rows)
        points = cash_series["points"]
        if type(points) is not list or not points or type(points[-1]) is not dict:
            raise ValueError("Final native checkpoint is missing.")
        # Equal-time account table rows do not establish causal ordering.
        final = dict(points[-1])
        for original, count in (
            ("positions", "position_count"),
            ("pending_orders", "pending_order_count"),
        ):
            rows = final.pop(original)
            if type(rows) is not list:
                raise ValueError("Native checkpoint collection is invalid.")
            final[count] = len(rows)
        return HistoricalReportSummary.model_validate_json(
            canonical_historical_bytes(
                dict(
                    run_id=run_id,
                    report_status=report["status"],
                    report_validation=validation,
                    report_sha256=expected[_REPORT][1],
                    component_snapshot_sha256=report["component_snapshot_sha256"],
                    evidence_anchor_sha256=preparation.anchor_sha256,
                    seal_sha256=publication.seal_digest,
                    observed_at_ns=str(_now(control._store._clock)),
                    consistency_failures=report["consistency_failures"],
                    table_counts=counts,
                    final_cash=final,
                    **{name: identity[name] for name in _IDENTITY_FIELDS},
                )
            )
        )
    except (ValueError, TypeError, KeyError, IndexError):
        raise _error(run_id, "ARTIFACT_INTEGRITY_FAILED") from None
