"""STA-25 finalization orchestration over persisted terminal authority."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from decimal import (
    ROUND_HALF_EVEN,
    Context,
    Decimal,
    DivisionByZero,
    InvalidOperation,
    Overflow,
    localcontext,
)
from pathlib import Path
from typing import Literal, cast

from pydantic import ValidationError

from stark_trading_os.audit.canonical_json import (
    CanonicalJSONError,
    canonical_json_bytes,
    parse_json_object,
)
from stark_trading_os.audit.materializer import (
    CanonicalMaterializer,
    FinalizationAlreadyResolved,
    MaterializationError,
)
from stark_trading_os.audit.replay import ReplaySchemaError, replay_digest_v1
from stark_trading_os.control.registry import (
    ControlStore,
    FinalizationFailure,
    TerminalFinalization,
    TerminalPreparation,
    UnverifiedTerminalPublication,
)
from stark_trading_os.control.run_contract import require_probe_contract
from stark_trading_os.domain.models import CatalogManifestV1, InputManifestV1
from stark_trading_os.runner.report_export import (
    REPORT_SCHEMAS,
    ReportSchemaError,
    export_metrics,
    normalize_report_row,
)

type FinalizationStage = Literal[
    "STAGING",
    "REPORTS",
    "RECONCILIATION",
    "MATERIALIZATION",
    "FSYNC",
    "RENAME",
    "SEAL",
    "PUBLICATION",
]

_REPORT_NAMES = ("orders", "fills", "positions", "account", "metrics")
_DIGEST = re.compile(r"^[0-9a-f]{64}$")


def _reconciliation_decimal_context() -> Context:
    return Context(
        prec=28,
        rounding=ROUND_HALF_EVEN,
        Emin=-999999,
        Emax=999999,
        capitals=1,
        clamp=0,
        flags=[],
        traps=[InvalidOperation, DivisionByZero, Overflow],
    )


class FinalizationRetryPending(RuntimeError):
    """One durable operational finalization attempt remains retryable."""

    def __init__(self, *, attempt: int, stage: FinalizationStage) -> None:
        if attempt not in {1, 2}:
            raise ValueError("retry attempt must be one or two")
        self.attempt = attempt
        self.stage = stage
        super().__init__("Finalization retry is pending.")


class _EvidenceFailure(ValueError):
    """A closed, safe-to-persist failure classification."""

    def __init__(self, *, stage: FinalizationStage) -> None:
        super().__init__(stage)
        self.stage = stage


class _FinalizationAuthority:
    """Committed input/catalog authority needed for the full semantic gate."""

    def __init__(self, *, manifest: InputManifestV1, catalog: CatalogManifestV1) -> None:
        self.manifest = manifest
        self.catalog = catalog


class Finalizer:
    """Derive exactly one terminal result from the control store."""

    def __init__(self, *, store: ControlStore, runtime_root: Path) -> None:
        if type(store) is not ControlStore:
            raise TypeError("Finalizer requires an exact ControlStore.")
        self._store = store
        self._runtime_root = Path(runtime_root)

    def finalize(self, run_id: str) -> TerminalFinalization:
        if type(run_id) is not str or not run_id:
            raise ValueError("run_id must be a non-empty string.")
        require_probe_contract(self._store.run(run_id).contract_kind)
        existing = self._store.terminal_finalization(run_id=run_id)
        if existing is not None:
            return existing
        authority = self._load_authority(run_id)
        preparation = self._store.prepare_terminal(run_id=run_id)
        existing = self._store.terminal_finalization(run_id=run_id)
        if existing is not None:
            return existing
        materializer = CanonicalMaterializer(store=self._store, runtime_root=self._runtime_root)
        try:
            reports = self._validate_reports(
                preparation=preparation,
                snapshot=materializer.read_staging_reports(preparation=preparation),
            )
            if len(reports) == len(_REPORT_NAMES):
                self._reconcile(
                    preparation=preparation,
                    reports=reports,
                    authority=authority,
                )
            return materializer.materialize_and_publish(preparation=preparation)
        except FinalizationAlreadyResolved as resolved:
            return resolved.result
        except _EvidenceFailure as error:
            return self._record_failure(
                run_id=run_id,
                deterministic=True,
                stage=error.stage,
            )
        except MaterializationError as error:
            return self._record_failure(
                run_id=run_id,
                deterministic=error.deterministic,
                stage=error.stage,
            )

    def validate_recovery_reports(
        self,
        preparation: TerminalPreparation,
        snapshot: tuple[tuple[str, bytes], ...],
    ) -> None:
        """Apply the ordinary report, economic, and replay gates to final-root bytes."""

        authority = self._load_authority(preparation.run_id)
        try:
            reports = self._validate_reports(
                preparation=preparation,
                snapshot=snapshot,
            )
            if len(reports) == len(_REPORT_NAMES):
                self._reconcile(
                    preparation=preparation,
                    reports=reports,
                    authority=authority,
                )
        except _EvidenceFailure as error:
            raise MaterializationError(
                "renamed-root reports failed finalization validation",
                deterministic=True,
                stage=error.stage,
            ) from error

    def _record_failure(
        self,
        *,
        run_id: str,
        deterministic: bool,
        stage: FinalizationStage,
    ) -> TerminalFinalization:
        result = self._store.record_finalization_failure(
            run_id=run_id,
            failure=FinalizationFailure(deterministic=deterministic, stage=stage),
        )
        if type(result) is UnverifiedTerminalPublication:
            return result
        if type(result) is not TerminalPreparation:
            raise RuntimeError("finalization failure storage returned an invalid result")
        raise FinalizationRetryPending(
            attempt=result.failure_attempt_count,
            stage=stage,
        )

    def _load_authority(self, run_id: str) -> _FinalizationAuthority:
        run = self._store.run(run_id)
        require_probe_contract(run.contract_kind)
        if run.input_manifest_bytes is None or run.input_manifest_hash is None:
            raise ValueError("run input manifest authority is missing")
        if _sha256(run.input_manifest_bytes) != run.input_manifest_hash:
            raise ValueError("run input manifest hash is invalid")
        try:
            manifest_value = parse_json_object(run.input_manifest_bytes)
            manifest = InputManifestV1.model_validate(manifest_value)
        except (CanonicalJSONError, ValidationError) as error:
            raise ValueError("run input manifest authority is invalid") from error
        if canonical_json_bytes(manifest_value) != run.input_manifest_bytes:
            raise ValueError("run input manifest authority is noncanonical")
        if (
            run.catalog_revision is None
            or run.catalog_inventory_hash is None
            or manifest.catalog_revision != run.catalog_revision
        ):
            raise ValueError("run catalog authority is incomplete")
        publication = self._store.catalog_publication(run.catalog_revision)
        if publication is None or publication.status != "PUBLISHED":
            raise ValueError("run catalog publication is unavailable")
        if publication.inventory_hash != run.catalog_inventory_hash:
            raise ValueError("run catalog inventory authority differs")
        try:
            catalog_value = parse_json_object(publication.publication_bytes)
            catalog = CatalogManifestV1.model_validate(catalog_value)
        except (CanonicalJSONError, ValidationError) as error:
            raise ValueError("catalog publication authority is invalid") from error
        if (
            canonical_json_bytes(catalog_value) != publication.publication_bytes
            or _sha256(publication.publication_bytes) != publication.catalog_revision
            or catalog.inventory_hash != publication.inventory_hash
            or catalog.fixture_id != manifest.fixture_id
            or catalog.inventory.instrument.instrument_id != manifest.instruments[0].instrument_id
        ):
            raise ValueError("catalog publication authority does not bind the run")
        return _FinalizationAuthority(manifest=manifest, catalog=catalog)

    def _validate_reports(
        self,
        *,
        preparation: TerminalPreparation,
        snapshot: tuple[tuple[str, bytes], ...],
    ) -> dict[str, object]:
        outcome = preparation.outcome.outcome
        classification = outcome.classification
        child = outcome.child_outcome
        declared = () if child is None else child.report_candidates
        expected_names = _REPORT_NAMES[: len(declared)]
        if tuple(name for name, _raw in snapshot) != expected_names:
            raise _EvidenceFailure(stage="REPORTS")
        if classification == "NATURAL_SUCCESS" and len(snapshot) != len(_REPORT_NAMES):
            raise _EvidenceFailure(stage="REPORTS")
        if classification == "NO_SPAWN_CANCELLED" and snapshot:
            raise _EvidenceFailure(stage="REPORTS")
        if classification not in {
            "NATURAL_SUCCESS",
            "NATURAL_FAILURE",
            "NO_SPAWN_CANCELLED",
            "SUPERVISOR_FAILURE",
        }:
            raise _EvidenceFailure(stage="REPORTS")
        reports: dict[str, object] = {}
        for name, raw in snapshot:
            value = _parse_canonical_report(raw)
            if name == "metrics":
                if not isinstance(value, Mapping):
                    raise _EvidenceFailure(stage="REPORTS")
                if "performance_series" not in value:
                    raise _EvidenceFailure(stage="REPORTS")
                try:
                    normalized_metrics = export_metrics(value)
                except ReportSchemaError as error:
                    raise _EvidenceFailure(stage="REPORTS") from error
                if normalized_metrics != value:
                    raise _EvidenceFailure(stage="REPORTS")
            else:
                if type(value) is not list:
                    raise _EvidenceFailure(stage="REPORTS")
                self._validate_rows(name=name, rows=value)
            reports[name] = value
        return reports

    @staticmethod
    def _validate_rows(*, name: str, rows: list[object]) -> None:
        schema = REPORT_SCHEMAS[name]
        primary_fields = {
            "orders": ("client_order_id",),
            "fills": ("ts_event", "client_order_id", "trade_id"),
            "positions": ("position_id",),
            "account": ("ts_event_ns", "account_id", "currency"),
        }[name]
        seen: set[tuple[object, ...]] = set()
        normalized_rows: list[dict[str, object]] = []
        for row in rows:
            if not isinstance(row, Mapping):
                raise _EvidenceFailure(stage="REPORTS")
            try:
                normalized = normalize_report_row(name, row)
            except ReportSchemaError as error:
                raise _EvidenceFailure(stage="REPORTS") from error
            if normalized != row:
                raise _EvidenceFailure(stage="REPORTS")
            key = tuple(normalized[field] for field in primary_fields) + (
                (canonical_json_bytes(normalized).hex(),) if name == "account" else ()
            )
            if key in seen:
                raise _EvidenceFailure(stage="REPORTS")
            seen.add(key)
            normalized_rows.append(normalized)
        try:
            ordered = sorted(
                normalized_rows,
                key=lambda row: (
                    tuple(_report_sort_value(row[key]) for key in schema.sort_keys)
                    + ((canonical_json_bytes(row).hex(),) if name == "account" else ())
                ),
            )
        except KeyError as error:
            raise _EvidenceFailure(stage="REPORTS") from error
        if rows != ordered:
            raise _EvidenceFailure(stage="REPORTS")

    def _reconcile(
        self,
        *,
        preparation: TerminalPreparation,
        reports: Mapping[str, object],
        authority: _FinalizationAuthority,
    ) -> None:
        with localcontext(_reconciliation_decimal_context()):
            self._reconcile_with_context(
                preparation=preparation,
                reports=reports,
                authority=authority,
            )

    def _reconcile_with_context(
        self,
        *,
        preparation: TerminalPreparation,
        reports: Mapping[str, object],
        authority: _FinalizationAuthority,
    ) -> None:
        try:
            orders = _rows(reports, "orders")
            fills = _rows(reports, "fills")
            positions = _rows(reports, "positions")
            accounts = _rows(reports, "account")
            metrics = reports["metrics"]
            if not isinstance(metrics, Mapping) or not accounts:
                raise _EvidenceFailure(stage="RECONCILIATION")
            manifest = authority.manifest
            catalog_instrument = authority.catalog.inventory.instrument
            if len(manifest.instruments) != 1:
                raise _EvidenceFailure(stage="RECONCILIATION")
            instrument_id = manifest.instruments[0].instrument_id
            quote = manifest.venue_account_model.currency
            if (
                catalog_instrument.instrument_id != instrument_id
                or catalog_instrument.quote_currency != quote
            ):
                raise _EvidenceFailure(stage="RECONCILIATION")
            order_by_id = _index_rows(orders, "client_order_id")
            position_by_id = _index_rows(positions, "position_id")
            final_account = accounts[-1]
            account_id = _string_value(final_account, "account_id")
            venue_id = manifest.venue_account_model.venue_id
            account_type = manifest.venue_account_model.account_type
            performance_series = metrics.get("performance_series")
            if not isinstance(performance_series, Mapping) or (
                performance_series.get("account_id") != account_id
                or performance_series.get("currency") != quote
            ):
                raise _EvidenceFailure(stage="RECONCILIATION")
            for account in accounts:
                if (
                    account.get("account_id") != account_id
                    or account.get("account_type") != account_type
                    or account.get("currency") != quote
                    or account.get("base_currency") != "None"
                ):
                    raise _EvidenceFailure(stage="RECONCILIATION")
                total = _decimal_value(account, "total")
                locked = _decimal_value(account, "locked")
                free = _decimal_value(account, "free")
                if free != total - locked:
                    raise _EvidenceFailure(stage="RECONCILIATION")
                margins = account.get("margins")
                if margins in (None, []):
                    if locked != 0:
                        raise _EvidenceFailure(stage="RECONCILIATION")
                else:
                    _validate_margin_identity(margins, instrument_id, quote)
                    margin = cast(list[Mapping[str, object]], margins)[0]
                    if locked != _decimal_value(margin, "initial") + _decimal_value(
                        margin, "maintenance"
                    ):
                        raise _EvidenceFailure(stage="RECONCILIATION")
            fill_qty: dict[str, Decimal] = {key: Decimal("0") for key in order_by_id}
            fill_commissions: dict[str, Decimal] = {key: Decimal("0") for key in order_by_id}
            position_commissions: dict[str, Decimal] = {key: Decimal("0") for key in position_by_id}
            for row in orders:
                if row["instrument_id"] != instrument_id:
                    raise _EvidenceFailure(stage="RECONCILIATION")
                if row["account_id"] is not None and row["account_id"] != account_id:
                    raise _EvidenceFailure(stage="RECONCILIATION")
                if row["position_id"] is not None and row["position_id"] not in position_by_id:
                    raise _EvidenceFailure(stage="RECONCILIATION")
                if row["commissions"] is None:
                    if (
                        row["status"] not in {"REJECTED", "DENIED"}
                        or _decimal_value(row, "filled_qty") != 0
                    ):
                        raise _EvidenceFailure(stage="RECONCILIATION")
                else:
                    _require_money_currency(row["commissions"], quote)
            fill_by_trade: dict[tuple[str, str], Mapping[str, object]] = {}
            for row in fills:
                fill_key = (_string_value(row, "client_order_id"), _string_value(row, "trade_id"))
                if fill_key in fill_by_trade:
                    raise _EvidenceFailure(stage="RECONCILIATION")
                fill_by_trade[fill_key] = row
            for row in positions:
                if row["instrument_id"] != instrument_id or row["account_id"] != account_id:
                    raise _EvidenceFailure(stage="RECONCILIATION")
                _require_money_currency(row["commissions"], quote)
                _require_money_currency((row["realized_pnl"],), quote)
                events = row["events"]
                if type(events) is not list:
                    raise _EvidenceFailure(stage="RECONCILIATION")
                position_id = _string_value(row, "position_id")
                expected_fills = sorted(
                    (fill for fill in fill_by_trade.values() if fill["position_id"] == position_id),
                    key=lambda fill: (
                        _report_sort_value(fill["ts_event"]),
                        _report_sort_value(fill["client_order_id"]),
                        _report_sort_value(fill["trade_id"]),
                    ),
                )
                expected_fill_keys = [
                    (_string_value(fill, "client_order_id"), _string_value(fill, "trade_id"))
                    for fill in expected_fills
                ]
                observed_fill_keys: list[tuple[str, str]] = []
                for event in events:
                    if not isinstance(event, Mapping):
                        raise _EvidenceFailure(stage="RECONCILIATION")
                    for field, expected_value in (
                        ("instrument_id", instrument_id),
                        ("currency", quote),
                        ("account_id", account_id),
                    ):
                        if event.get(field) != expected_value:
                            raise _EvidenceFailure(stage="RECONCILIATION")
                    fill_key = (
                        _string_value(event, "client_order_id"),
                        _string_value(event, "trade_id"),
                    )
                    fill = fill_by_trade.get(fill_key)
                    if fill is None or event.get("position_id") != position_id:
                        raise _EvidenceFailure(stage="RECONCILIATION")
                    if any(event.get(field) != value for field, value in fill.items()):
                        raise _EvidenceFailure(stage="RECONCILIATION")
                    observed_fill_keys.append(fill_key)
                if (
                    len(events) != len(expected_fill_keys)
                    or len(observed_fill_keys) != len(set(observed_fill_keys))
                    or observed_fill_keys != expected_fill_keys
                ):
                    raise _EvidenceFailure(stage="RECONCILIATION")
                # Exported native ID arrays have stable JSON order but no
                # persisted ordering authority outside that report; bind their
                # exact unique membership without inventing one from fills.
                expected_trade_ids = {trade_id for _order_id, trade_id in expected_fill_keys}
                trade_ids = row["trade_ids"]
                if (
                    not isinstance(trade_ids, list)
                    or len(trade_ids) != len(expected_trade_ids)
                    or len(trade_ids) != len(set(trade_ids))
                    or set(trade_ids) != expected_trade_ids
                ):
                    raise _EvidenceFailure(stage="RECONCILIATION")
                expected_venue_order_ids = {
                    cast(str, fill["venue_order_id"]) for fill in expected_fills
                }
                venue_order_ids = row["venue_order_ids"]
                if (
                    not isinstance(venue_order_ids, list)
                    or len(venue_order_ids) != len(expected_venue_order_ids)
                    or len(venue_order_ids) != len(set(venue_order_ids))
                    or set(venue_order_ids) != expected_venue_order_ids
                ):
                    raise _EvidenceFailure(stage="RECONCILIATION")
                if (
                    not expected_fills
                    or row["opening_order_id"] != expected_fills[0]["client_order_id"]
                ):
                    raise _EvidenceFailure(stage="RECONCILIATION")
                if row["ts_closed"] is None:
                    if row["closing_order_id"] is not None:
                        raise _EvidenceFailure(stage="RECONCILIATION")
                elif row["closing_order_id"] != expected_fills[-1]["client_order_id"]:
                    raise _EvidenceFailure(stage="RECONCILIATION")
            quantizer = Decimal(1).scaleb(-manifest.cost_fill_model.fee.decimal_precision)
            fills_by_order: dict[str, list[dict[str, object]]] = {
                order_id: [] for order_id in order_by_id
            }
            for row in fills:
                order_id = _string_value(row, "client_order_id")
                position_id = _string_value(row, "position_id")
                if (
                    row["instrument_id"] != instrument_id
                    or row["currency"] != quote
                    or row["account_id"] != account_id
                    or order_id not in order_by_id
                    or position_id not in position_by_id
                    or (
                        order_by_id[order_id]["position_id"] is not None
                        and order_by_id[order_id]["position_id"] != position_id
                    )
                ):
                    raise _EvidenceFailure(stage="RECONCILIATION")
                order = order_by_id[order_id]
                if (
                    order["account_id"] != account_id
                    or order["position_id"] != position_id
                    or order["side"] != row["order_side"]
                    or order["type"] != row["order_type"]
                    or order["venue_order_id"] != row["venue_order_id"]
                ):
                    raise _EvidenceFailure(stage="RECONCILIATION")
                quantity = _decimal_value(row, "last_qty")
                price = _decimal_value(row, "last_px")
                liquidity = _string_value(row, "liquidity_side")
                rate = (
                    Decimal(catalog_instrument.maker_fee)
                    if liquidity == "MAKER"
                    else Decimal(catalog_instrument.taker_fee)
                    if liquidity == "TAKER"
                    else None
                )
                if rate is None:
                    raise _EvidenceFailure(stage="RECONCILIATION")
                commission = _money_amount(row["commission"], quote)
                if commission != (quantity * price * rate).quantize(
                    quantizer,
                    rounding=ROUND_HALF_EVEN,
                ):
                    raise _EvidenceFailure(stage="RECONCILIATION")
                fill_qty[order_id] += quantity
                fill_commissions[order_id] += commission
                position_commissions[position_id] += commission
                fills_by_order[order_id].append(row)
            for order_id, order_row in order_by_id.items():
                quantity = _decimal_value(order_row, "quantity")
                filled = _decimal_value(order_row, "filled_qty")
                if filled != fill_qty[order_id] or filled > quantity:
                    raise _EvidenceFailure(stage="RECONCILIATION")
                if order_row["status"] in {"REJECTED", "DENIED"} and fill_qty[order_id] != 0:
                    raise _EvidenceFailure(stage="RECONCILIATION")
                if _money_sum(order_row["commissions"], quote) != fill_commissions[order_id]:
                    raise _EvidenceFailure(stage="RECONCILIATION")
                order_fills = fills_by_order[order_id]
                if not order_fills:
                    if order_row["last_trade_id"] is not None:
                        raise _EvidenceFailure(stage="RECONCILIATION")
                else:
                    terminal_fill = max(
                        order_fills,
                        key=lambda fill: (
                            _report_sort_value(fill["ts_event"]),
                            _report_sort_value(fill["trade_id"]),
                        ),
                    )
                    if order_row["last_trade_id"] != terminal_fill["trade_id"]:
                        raise _EvidenceFailure(stage="RECONCILIATION")
            for position_id, position_row in position_by_id.items():
                if (
                    _money_sum(position_row["commissions"], quote)
                    != position_commissions[position_id]
                ):
                    raise _EvidenceFailure(stage="RECONCILIATION")
            if final_account["currency"] != quote:
                raise _EvidenceFailure(stage="RECONCILIATION")
            total = _decimal_value(final_account, "total")
            locked = _decimal_value(final_account, "locked")
            free = _decimal_value(final_account, "free")
            realized = sum(
                (_money_amount(row["realized_pnl"], quote) for row in positions),
                Decimal("0"),
            )
            if (
                total != Decimal(manifest.venue_account_model.starting_balance) + realized
                or free != total - locked
            ):
                raise _EvidenceFailure(stage="RECONCILIATION")
            _validate_margins(
                final_account["margins"],
                instrument_id,
                quote,
                locked,
                expected_initial=_expected_initial_margin(
                    orders=orders,
                    margin_init=Decimal(catalog_instrument.margin_init),
                ),
                expected_maintenance=_expected_maintenance_margin(
                    positions=positions,
                    margin_maint=Decimal(catalog_instrument.margin_maint),
                ),
            )
            self._validate_metrics(
                metrics=metrics,
                orders=orders,
                fills=fills,
                positions=positions,
                accounts=accounts,
                venue_id=venue_id,
                account_id=account_id,
            )
            events = [
                cast(object, parse_json_object(event.envelope_bytes))
                for event in (*self._store.events(preparation.run_id), preparation.event)
            ]
            digest = replay_digest_v1(
                {
                    "input_manifest_hash": _sha256(
                        canonical_json_bytes(
                            authority.manifest.model_dump(mode="json", by_alias=True)
                        )
                    ),
                    "events": events,
                    "reports": reports,
                }
            )
            if _DIGEST.fullmatch(digest) is None:
                raise _EvidenceFailure(stage="RECONCILIATION")
        except (CanonicalJSONError, InvalidOperation, KeyError, ReplaySchemaError) as error:
            raise _EvidenceFailure(stage="RECONCILIATION") from error

    @staticmethod
    def _validate_metrics(
        *,
        metrics: Mapping[str, object],
        orders: list[dict[str, object]],
        fills: list[dict[str, object]],
        positions: list[dict[str, object]],
        accounts: list[dict[str, object]],
        venue_id: str,
        account_id: str,
    ) -> None:
        summary = metrics.get("summary")
        if not isinstance(summary, Mapping):
            raise _EvidenceFailure(stage="RECONCILIATION")
        expected = {
            "orders.total": len(orders),
            "orders.closed": sum(
                row["status"] in {"FILLED", "CANCELED", "REJECTED", "DENIED", "EXPIRED", "VOIDED"}
                for row in orders
            ),
            "orders.open": sum(
                row["status"] in {"ACCEPTED", "PARTIALLY_FILLED", "PENDING_CANCEL"}
                for row in orders
            ),
            "orders.inflight": sum(
                row["status"] in {"SUBMITTED", "PENDING_UPDATE", "PENDING_CANCEL"} for row in orders
            ),
            "orders.emulated": sum(row["status"] == "EMULATED" for row in orders),
            "positions.total": len({row["position_id"] for row in positions}),
            "positions.total_with_snapshots": len(positions),
            "positions.open": sum(row["ts_closed"] is None for row in positions),
            "positions.closed": sum(row["ts_closed"] is not None for row in positions),
            "positions.snapshots": sum(row["is_snapshot"] is True for row in positions),
        }
        for key, value in expected.items():
            if summary.get(key) != str(value):
                raise _EvidenceFailure(stage="RECONCILIATION")
        account = accounts[-1]
        currency = account.get("currency")
        if type(currency) is not str:
            raise _EvidenceFailure(stage="RECONCILIATION")
        account_total = f"account.{venue_id}.balance.{currency}.total"
        account_locked = f"account.{venue_id}.balance.{currency}.locked"
        account_free = f"account.{venue_id}.balance.{currency}.free"
        if (
            _money_amount(summary.get(account_total), currency) != _decimal_value(account, "total")
            or _money_amount(summary.get(account_locked), currency)
            != _decimal_value(account, "locked")
            or _money_amount(summary.get(account_free), currency) != _decimal_value(account, "free")
        ):
            raise _EvidenceFailure(stage="RECONCILIATION")
        event_count = len(accounts)
        expected_summary = {
            f"account.{venue_id}.id": account_id,
            f"account.{venue_id}.type": account["account_type"],
            f"account.{venue_id}.base_currency": str(account["base_currency"]),
            f"account.{venue_id}.event_count": str(event_count),
            # The real Task 7 exporter evidence pins total_events to the
            # account-state rows plus committed order rows; iterations remains
            # closed-schema-only because no report relation derives it.
            "total_events": str(event_count + len(orders)),
            "venues.total": "1",
        }
        account_summary_keys = {key for key in summary if key.startswith("account.")}
        expected_account_summary_keys = set(expected_summary).difference(
            {"total_events", "venues.total"}
        ) | {account_total, account_locked, account_free}
        if account_summary_keys != expected_account_summary_keys or any(
            summary.get(key) != value for key, value in expected_summary.items()
        ):
            raise _EvidenceFailure(stage="RECONCILIATION")


def _parse_canonical_report(raw: bytes) -> object:
    wrapped = b'{"value":' + raw + b"}"
    try:
        parsed = parse_json_object(wrapped)
    except CanonicalJSONError as error:
        raise _EvidenceFailure(stage="REPORTS") from error
    if canonical_json_bytes(parsed) != wrapped:
        raise _EvidenceFailure(stage="REPORTS")
    return parsed["value"]


def _rows(reports: Mapping[str, object], name: str) -> list[dict[str, object]]:
    value = reports[name]
    if type(value) is not list:
        raise _EvidenceFailure(stage="RECONCILIATION")
    rows: list[dict[str, object]] = []
    for item in value:
        if not isinstance(item, Mapping):
            raise _EvidenceFailure(stage="RECONCILIATION")
        rows.append(dict(item))
    return rows


def _index_rows(
    rows: Sequence[Mapping[str, object]], field: str
) -> dict[str, Mapping[str, object]]:
    indexed: dict[str, Mapping[str, object]] = {}
    for row in rows:
        value = _string_value(row, field)
        if value in indexed:
            raise _EvidenceFailure(stage="RECONCILIATION")
        indexed[value] = row
    return indexed


def _string_value(row: Mapping[str, object], field: str) -> str:
    value = row[field]
    if type(value) is not str:
        raise _EvidenceFailure(stage="RECONCILIATION")
    return value


def _decimal_value(row: Mapping[str, object], field: str) -> Decimal:
    value = _string_value(row, field)
    try:
        return Decimal(value)
    except InvalidOperation as error:
        raise _EvidenceFailure(stage="RECONCILIATION") from error


def _money_amount(value: object, currency: str) -> Decimal:
    if type(value) is not str:
        raise _EvidenceFailure(stage="RECONCILIATION")
    amount, separator, observed_currency = value.partition(" ")
    if not separator or observed_currency != currency:
        raise _EvidenceFailure(stage="RECONCILIATION")
    try:
        return Decimal(amount)
    except InvalidOperation as error:
        raise _EvidenceFailure(stage="RECONCILIATION") from error


def _require_money_currency(values: object, currency: str) -> None:
    if type(values) is not list and type(values) is not tuple:
        raise _EvidenceFailure(stage="RECONCILIATION")
    for value in values:
        _money_amount(value, currency)


def _money_sum(values: object, currency: str) -> Decimal:
    if values is None:
        return Decimal("0")
    _require_money_currency(values, currency)
    return sum(
        (_money_amount(value, currency) for value in cast(Sequence[object], values)),
        Decimal("0"),
    )


def _validate_margins(
    value: object,
    instrument_id: str,
    currency: str,
    locked: Decimal,
    *,
    expected_initial: Decimal,
    expected_maintenance: Decimal,
) -> None:
    _validate_margin_identity(value, instrument_id, currency)
    margin = cast(list[Mapping[str, object]], value)[0]
    if (
        _decimal_value(margin, "initial") != expected_initial
        or _decimal_value(margin, "maintenance") != expected_maintenance
        or locked != expected_initial + expected_maintenance
    ):
        raise _EvidenceFailure(stage="RECONCILIATION")


def _validate_margin_identity(value: object, instrument_id: str, currency: str) -> None:
    if type(value) is not list or len(value) != 1 or not isinstance(value[0], Mapping):
        raise _EvidenceFailure(stage="RECONCILIATION")
    margin = value[0]
    if (
        margin.get("instrument_id") != instrument_id
        or margin.get("currency") != currency
        or margin.get("type") != "MarginBalance"
    ):
        raise _EvidenceFailure(stage="RECONCILIATION")


def _expected_initial_margin(
    *, orders: Sequence[Mapping[str, object]], margin_init: Decimal
) -> Decimal:
    active_statuses = {
        "SUBMITTED",
        "ACCEPTED",
        "PARTIALLY_FILLED",
        "PENDING_UPDATE",
        "PENDING_CANCEL",
    }
    margin = Decimal("0")
    for order in orders:
        if order["status"] not in active_statuses:
            continue
        remaining = _decimal_value(order, "quantity") - _decimal_value(order, "filled_qty")
        if remaining < 0:
            raise _EvidenceFailure(stage="RECONCILIATION")
        margin += remaining * _decimal_value(order, "price") * margin_init
    return margin


def _expected_maintenance_margin(
    *, positions: Sequence[Mapping[str, object]], margin_maint: Decimal
) -> Decimal:
    margin = Decimal("0")
    for position in positions:
        if position["ts_closed"] is None:
            margin += (
                _decimal_value(position, "quantity")
                * _decimal_value(position, "avg_px_open")
                * _decimal_value(position, "multiplier")
                * margin_maint
            )
    return margin


def _sha256(value: bytes) -> str:
    from hashlib import sha256

    return sha256(value).hexdigest()


def _report_sort_value(value: object) -> tuple[int, object]:
    if type(value) is str and value.isdecimal():
        return (0, int(value))
    if type(value) is int:
        return (0, value)
    if value is None:
        return (1, "")
    return (2, str(value))
