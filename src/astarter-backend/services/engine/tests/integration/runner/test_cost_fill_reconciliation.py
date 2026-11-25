from __future__ import annotations

import json
from decimal import ROUND_HALF_EVEN, Decimal
from pathlib import Path

from test_backtest_process import prepare_real_runner_input
from test_report_lifecycle import run_runner_process

from stark_trading_os.audit.canonical_json import canonical_decimal_string


def test_real_recorded_l1_fill_fee_margin_and_account_reconcile(tmp_path: Path) -> None:
    loaded = prepare_real_runner_input(tmp_path, run_id="bt_reconcile")
    process = run_runner_process(loaded)
    reports = {
        report.name: json.loads((loaded.staging_dir / report.relative_path).read_bytes())
        for report in process.outcome.report_candidates
    }
    orders = {row["client_order_id"]: row for row in reports["orders"]}
    entry = orders["ENTRY-PARTIAL"]

    assert entry["quantity"] == "15"
    assert entry["filled_qty"] == "10"
    assert Decimal(entry["quantity"]) - Decimal(entry["filled_qty"]) == Decimal("5")
    assert entry["status"] == "CANCELED"
    assert orders["RISK-PROBE"]["status"] == "DENIED"
    assert orders["VENUE-REJECTION"]["status"] == "REJECTED"

    types = [candidate.type for candidate in process.candidates]
    assert "order.partially_filled" in types
    assert "order.cancel_pending" in types
    assert "order.cancelled" in types
    assert "risk.rejected" in types
    assert "order.rejected" in types

    instrument = loaded.catalog_manifest.inventory.instrument
    rates = {
        "MAKER": Decimal(instrument.maker_fee),
        "TAKER": Decimal(instrument.taker_fee),
    }
    assert rates == {"MAKER": Decimal("0.0002"), "TAKER": Decimal("0.001")}
    commissions_by_order: dict[str, Decimal] = {}
    commissions_by_position: dict[str, Decimal] = {}
    for fill in reports["fills"]:
        amount, currency = fill["commission"].split(" ")
        expected = (
            Decimal(fill["last_qty"]) * Decimal(fill["last_px"]) * rates[fill["liquidity_side"]]
        ).quantize(Decimal("0.00000001"), rounding=ROUND_HALF_EVEN)
        assert currency == instrument.quote_currency
        assert Decimal(amount) == expected
        commissions_by_order[fill["client_order_id"]] = (
            commissions_by_order.get(fill["client_order_id"], Decimal("0")) + expected
        )
        commissions_by_position[fill["position_id"]] = (
            commissions_by_position.get(fill["position_id"], Decimal("0")) + expected
        )
    assert {fill["liquidity_side"] for fill in reports["fills"]} == {"TAKER"}
    assert commissions_by_order["ENTRY-PARTIAL"] == Decimal("1")
    assert not any(
        fill["client_order_id"] in {"RISK-PROBE", "VENUE-REJECTION"} for fill in reports["fills"]
    )

    for order_id, commission in commissions_by_order.items():
        assert orders[order_id]["commissions"] == [f"{canonical_decimal_string(commission)} USDT"]
    for position in reports["positions"]:
        position_commission = commissions_by_position[position["position_id"]]
        assert position["commissions"] == [f"{canonical_decimal_string(position_commission)} USDT"]

    final_account = reports["account"][-1]
    realized_net = sum(
        (Decimal(position["realized_pnl"].split(" ")[0]) for position in reports["positions"]),
        Decimal("0"),
    )
    assert Decimal(final_account["total"]) == Decimal("1000000") + realized_net
    assert Decimal(final_account["locked"]) == Decimal("50")
    assert Decimal(final_account["free"]) == (
        Decimal(final_account["total"]) - Decimal(final_account["locked"])
    )
    assert final_account["margins"] == [
        {
            "currency": "USDT",
            "initial": "0",
            "instrument_id": instrument.instrument_id,
            "maintenance": "50",
            "type": "MarginBalance",
        }
    ]
