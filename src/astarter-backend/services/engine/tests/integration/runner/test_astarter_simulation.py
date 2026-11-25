"""One production finite simulation path; expected money is independently literal."""

import json
import sqlite3

import pytest

from stark_trading_os.runner.astarter_simulation import run_btc_simulation


def run(tmp_path, scenario="round_trip"):
    result = run_btc_simulation(database_path=tmp_path / "control.sqlite", scenario=scenario)
    assert result.engine_disposed
    return json.loads(result.evidence_bytes)


def test_btc_reservation_native_fills_protection_close_and_deduplicated_lock(tmp_path):
    r = run(tmp_path)
    assert r["scope"] == "FINITE_NATIVE_SIMULATION"
    assert r["status"] == "COMPLETE"
    assert r["reservation"]["quantity"] == "0.00368"
    assert r["reservation"]["cash_hold"] == "221.46284528"
    assert [
        (f["side"], f["quantity"], f["price"], f["fee"]) for f in r["native_snapshot"]["fills"]
    ] == [("BUY", "0.00368", "60000", "0.2208"), ("SELL", "0.00368", "61000", "0.22448")]
    assert r["native_snapshot"]["quote_total"] == "10003.23472"
    assert r["native_snapshot"]["base_total"] == r["native_snapshot"]["position_quantity"] == "0"
    assert r["settlement"]["new_lock"] == "0.646944"
    assert r["settlement"]["tradable_equity"] == "10002.587776"
    assert r["duplicate_settlement"]["new_lock"] == "0"
    assert r["alias_settlement"]["new_lock"] == "0"
    assert r["account"]["reserve"] == "0.646944"
    assert r["settlement_rows"] == 1
    assert r["protected_acceptances"] == 1
    assert not r["errors"] and r["live_orders"] == r["open_positions"] == 0


@pytest.mark.parametrize(
    "scenario,quantity,final_quote",
    [("partial_stop", "0.001", "9998.7811"), ("stop", "0.00368", "9995.514448")],
)
def test_partial_and_full_native_stop_exit_and_loss_do_not_create_profit_lock(
    tmp_path, scenario, quantity, final_quote
):
    r = run(tmp_path, scenario)
    assert r["status"] == "COMPLETE"
    first, last = r["native_snapshot"]["fills"]
    assert first["quantity"] == last["quantity"] == quantity
    assert last["time_ns"] > first["time_ns"]
    assert r["native_snapshot"]["quote_total"] == final_quote
    assert r["settlement"]["new_lock"] == "0"
    assert r["account"]["reserve"] == "0"
    assert r["protected_acceptances"] == 1
    assert r["pending_stop_without_acceptance_at_final_snapshot"] is False


def test_native_zero_fill_consumes_opportunity_and_releases_only_proven_terminal_remaining(
    tmp_path,
):
    r = run(tmp_path, "zero")
    assert r["status"] == "NO_FILL"
    assert not r["native_snapshot"]["fills"] and r["protected_acceptances"] == 0
    assert r["native_snapshot"]["quote_total"] == "10000"
    assert r["entry_submissions"] == 1
    assert r["account"]["pending_risk"] == r["account"]["cash_hold"] == "0"


def test_reopened_controller_reconciles_existing_native_stop_without_resubmitting(tmp_path):
    r = run(tmp_path, "recover")
    assert r["status"] == "COMPLETE"
    assert r["controller_reopened"] is True
    assert r["account"]["fence"] == 2
    assert r["protected_acceptances"] == r["entry_submissions"] == 1
    assert r["account"]["reserve"] == "0.646944"


def test_new_risk_halt_does_not_block_preapproved_protective_reduction(tmp_path):
    r = run(tmp_path, "halt_exit")
    assert r["status"] == "COMPLETE"
    assert "DAY_LOSS" in r["account"]["locks"]
    assert r["native_snapshot"]["position_quantity"] == "0"
    assert len(r["native_snapshot"]["fills"]) == 2


@pytest.mark.parametrize("scenario", ["stop_rejected", "stop_late"])
def test_missing_or_late_native_protection_halts_new_risk_and_records_real_outcome(
    tmp_path, scenario
):
    r = run(tmp_path, scenario)
    assert "PROTECTION_FAILED" in r["account"]["locks"]
    assert r["entry_submissions"] == 1
    assert r["protection_failure_observed"] is True
    assert all(v["side"] in ("BUY", "SELL") for v in r["native_snapshot"]["fills"])
    assert r["status"] in ("HALTED_FLAT", "RECONCILIATION_REQUIRED")


def test_native_stop_fill_before_cancel_ack_never_creates_a_second_sale(tmp_path):
    r = run(tmp_path, "cancel_race")
    sells = [v for v in r["native_snapshot"]["fills"] if v["side"] == "SELL"]
    assert len(sells) == 1 and sells[0]["quantity"] == "0.00368"
    assert r["native_snapshot"]["base_total"] == r["native_snapshot"]["position_quantity"] == "0"
    assert r["entry_submissions"] == 1


def test_expired_unsent_opportunity_does_not_dispatch_after_recovery(tmp_path):
    r = run(tmp_path, "expired_dispatch")
    assert r["entry_submissions"] == 0
    assert not r["native_snapshot"]["fills"]
    assert r["status"] == "EXPIRED_UNSENT"


def test_native_acceptance_exactly_at_deadline_is_not_a_pre_settle_timeout(tmp_path):
    r = run(tmp_path, "accepted_at_deadline")
    assert r["status"] == "COMPLETE"
    assert "PROTECTION_FAILED" not in r["account"]["locks"]
    assert r["protected_acceptances"] == 1


def test_committed_lock_survives_real_recovery_process_and_economic_replay(tmp_path):
    r = run(tmp_path, "recover_after_settlement")
    assert r["controller_reopened"]
    assert r["recovery_process"]["account"]["reserve"] == "0.646944"
    assert r["recovery_process"]["account"]["profit_hwm"] == "3.23472"
    assert r["account"]["reserve"] == "0.646944"
    assert r["duplicate_settlement"]["new_lock"] == r["alias_settlement"]["new_lock"] == "0"
    assert r["settlement_rows"] == 1


def test_recovery_cannot_restart_the_deadline_of_an_unprotected_old_fill(tmp_path):
    r = run(tmp_path, "recover_before_protection")
    assert r["controller_reopened"]
    assert r["protection_failure_observed"]
    assert r["protected_acceptances"] == 0
    assert r["status"] == "HALTED_FLAT"


def test_approved_reduction_above_new_entry_notional_cap_remains_possible(tmp_path):
    r = run(tmp_path, "exit_above_cap")
    assert r["status"] == "COMPLETE"
    buy, sell = r["native_snapshot"]["fills"]
    assert buy["quantity"] == sell["quantity"] == "0.00368"
    assert sell["price"] == "400000"
    assert r["native_snapshot"]["quote_total"] == "11249.5072"


def test_revoking_new_entry_permission_keeps_frozen_protection_exit_and_settlement(tmp_path):
    r = run(tmp_path, "revoke_holding")
    assert r["status"] == "COMPLETE"
    assert r["native_snapshot"]["position_quantity"] == "0"
    assert r["protected_acceptances"] == 1
    assert r["settlement"]["new_lock"] == "0.646944"


def test_native_fill_blocks_new_risk_until_stop_acceptance_is_confirmed(tmp_path):
    r = run(tmp_path)
    changes = [v["fact"]["locks"] for v in r["audit"] if v["kind"] == "RISK_LOCKS_CHANGED"]
    assert any("PROTECTION_PENDING" in value for value in changes)
    assert any("EXIT_PENDING" in value for value in changes)
    assert r["account"]["locks"] == []


def test_profitable_close_does_not_count_its_paid_fees_twice_as_realized_loss(tmp_path):
    r = run(tmp_path)
    with sqlite3.connect(tmp_path / "control.sqlite") as connection:
        debit = connection.execute(
            "SELECT booked_debit FROM astarter_limits WHERE scope='CYCLE'"
        ).fetchone()[0]
    assert r["settlement"]["net_profit"] == "3.23472"
    assert debit == "0"


def test_losing_close_books_exact_native_net_loss_once(tmp_path):
    r = run(tmp_path, "partial_stop")
    with sqlite3.connect(tmp_path / "control.sqlite") as connection:
        debit = connection.execute(
            "SELECT booked_debit FROM astarter_limits WHERE scope='CYCLE'"
        ).fetchone()[0]
    assert r["settlement"]["net_profit"] == "-1.2189"
    assert debit == "1.2189"


def test_open_adverse_move_and_paid_costs_remain_in_budget_before_settlement(tmp_path):
    r = run(tmp_path, "open_dip")
    assert r["native_snapshot"]["position_quantity"] == "0.00368"
    assert r["open_cost_debit"] == "2.0608"
    assert r["account"]["inventory_risk"] == "2.49092944"
    assert r["settlement"] is None


def test_partial_native_exit_is_reconciled_before_a_new_reduction_child(tmp_path):
    r = run(tmp_path, "partial_exit")
    assert r["status"] == "COMPLETE"
    sales = [v for v in r["native_snapshot"]["fills"] if v["side"] == "SELL"]
    assert [v["quantity"] for v in sales] == ["0.001", "0.00268"]
    assert sales[0]["order_id"] != sales[1]["order_id"]
    with sqlite3.connect(tmp_path / "control.sqlite") as connection:
        assert (
            connection.execute("SELECT COUNT(*) FROM astarter_orders WHERE role='EXIT'").fetchone()[
                0
            ]
            == 2
        )
    assert r["native_snapshot"]["base_total"] == "0"


def test_recovery_dispatches_only_the_proven_unclaimed_exit_intent(tmp_path):
    r = run(tmp_path, "recover_before_exit")
    assert r["status"] == "COMPLETE" and r["controller_reopened"]
    assert len([v for v in r["native_snapshot"]["fills"] if v["side"] == "SELL"]) == 1
    assert r["entry_submissions"] == 1
