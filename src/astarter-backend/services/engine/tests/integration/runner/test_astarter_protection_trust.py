"""Known source failures must not remove native protection before a blocked exit."""

import json
import sqlite3

import pytest

from stark_trading_os.runner.astarter_simulation import AstarterNativeStrategy, run_btc_simulation


def stops(snapshot):
    return [o for o in snapshot["orders"] if o["order_type"] == "STOP_MARKET"]


def test_native_integrity_lock_retains_accepted_stop_without_cancel_or_exit(tmp_path, monkeypatch):
    original = AstarterNativeStrategy.on_quote
    before = []

    def halt_before_close(self, quote):
        if self.source is not None and self.sequence == 1:
            before.extend(
                o.state for o in self.source.capture().orders if o.order_type == "STOP_MARKET"
            )
            self.control.halt(self.source.account_id, "NATIVE_INTEGRITY")
        return original(self, quote)

    monkeypatch.setattr(AstarterNativeStrategy, "on_quote", halt_before_close)
    r = json.loads(run_btc_simulation(database_path=tmp_path / "control.sqlite").evidence_bytes)
    assert before == ["ACCEPTED"]
    assert [o["state"] for o in stops(r["native_snapshot"])] == ["ACCEPTED"]
    assert not any(e["event"] == "OrderCanceled" for e in r["trace"])
    assert r["native_snapshot"]["position_quantity"] == "0.00368" and r["live_orders"] == 1
    assert "NATIVE_INTEGRITY" in r["account"]["locks"]
    assert r["status"] == "RECONCILIATION_REQUIRED" and r["settlement"] is None
    assert not r["errors"]


def test_reconcile_lock_retains_stop_then_trusted_observe_allows_same_exit_target(
    tmp_path, monkeypatch
):
    original = AstarterNativeStrategy._drive
    observed = []

    def interrupt_drive(self):
        if self.sequence == 2 and not observed:
            observed.append({})  # prevents nested native callbacks repeating this injection
            self.control.begin_recovery(self.source.account_id)
            original(self)
            snapshot = self.source.capture()
            observed[0] = {
                "stops": [o.state for o in snapshot.orders if o.order_type == "STOP_MARKET"],
                "canceled": any(e["event"] == "OrderCanceled" for e in self.trace),
                "locks": self.control.account(self.source.account_id).locks,
            }
            self.control.observe(self.source)
        return original(self)

    monkeypatch.setattr(AstarterNativeStrategy, "_drive", interrupt_drive)
    r = json.loads(run_btc_simulation(database_path=tmp_path / "control.sqlite").evidence_bytes)
    assert observed[0]["stops"] == ["ACCEPTED"] and observed[0]["canceled"] is False
    assert "RECONCILE_REQUIRED" in observed[0]["locks"]
    assert r["status"] == "COMPLETE" and not r["errors"]
    assert r["native_snapshot"]["position_quantity"] == "0"
    assert len([f for f in r["native_snapshot"]["fills"] if f["side"] == "SELL"]) == 1


def test_integrity_failure_in_native_cancel_callback_does_not_prepare_an_exit(
    tmp_path, monkeypatch
):
    original = AstarterNativeStrategy.on_order_canceled

    def integrity_after_cancel(self, event):
        if "-P" in str(event.client_order_id):
            self.control.halt(self.source.account_id, "NATIVE_INTEGRITY")
        return original(self, event)

    monkeypatch.setattr(AstarterNativeStrategy, "on_order_canceled", integrity_after_cancel)
    r = json.loads(run_btc_simulation(database_path=tmp_path / "control.sqlite").evidence_bytes)
    assert "NATIVE_INTEGRITY" in r["account"]["locks"]
    assert r["native_snapshot"]["position_quantity"] == "0.00368"
    assert r["status"] == "RECONCILIATION_REQUIRED" and not r["errors"]
    with sqlite3.connect(tmp_path / "control.sqlite") as c:
        assert (
            c.execute("SELECT COUNT(*) FROM astarter_orders WHERE role='EXIT'").fetchone()[0] == 0
        )


@pytest.mark.parametrize(
    "scenario", ["integrity_hold", "reconcile_pause", "integrity_after_cancel", "short_ttl"]
)
def test_production_fault_and_short_ttl_scenarios_keep_honest_native_outcomes(tmp_path, scenario):
    r = json.loads(
        run_btc_simulation(
            database_path=tmp_path / "control.sqlite", scenario=scenario
        ).evidence_bytes
    )
    assert not r["errors"]
    if scenario in {"reconcile_pause", "short_ttl"}:
        assert r["status"] == "COMPLETE"
        assert r["settlement"]["net_profit"] == "3.23472"
        assert r["settlement"]["new_lock"] == "0.646944"
    else:
        assert r["status"] == "RECONCILIATION_REQUIRED" and r["settlement"] is None
        assert r["native_snapshot"]["position_quantity"] == "0.00368"
    if scenario == "integrity_hold":
        assert [o["state"] for o in stops(r["native_snapshot"])] == ["ACCEPTED"]
        assert r["live_orders"] == 1
        assert not any(v["event"] == "OrderCanceled" for v in r["trace"])
    if scenario == "reconcile_pause":
        assert any(
            v["event"] == "SourceTrustDeferred" and "RECONCILE_REQUIRED" in v["reason"]
            for v in r["trace"]
        )
        canceled = [v for v in r["trace"] if v["event"] == "OrderCanceled"]
        assert canceled and canceled[0]["time_ns"] >= 1_700_000_002_000_000_000
    if scenario == "integrity_after_cancel":
        with sqlite3.connect(tmp_path / "control.sqlite") as c:
            assert (
                c.execute("SELECT COUNT(*) FROM astarter_orders WHERE role='EXIT'").fetchone()[0]
                == 0
            )
    if scenario == "short_ttl":
        with sqlite3.connect(tmp_path / "control.sqlite") as c:
            raw = c.execute("SELECT policy_bytes FROM astarter_bindings LIMIT 1").fetchone()[0]
        assert json.loads(raw)["snapshot_ttl_ns"] == 1_000_000_000


@pytest.mark.parametrize("reason", ["NATIVE_INTEGRITY", "RECONCILE_REQUIRED"])
def test_cancel_transaction_itself_rejects_untrusted_source_without_consuming_cancel(
    tmp_path, monkeypatch, reason
):
    original = AstarterNativeStrategy._drive
    seen = []

    def drive(self):
        if self.sequence == 2 and not seen:
            self.control.request_exit(self.receipt.intent_id)
            if reason == "NATIVE_INTEGRITY":
                self.control.halt(self.source.account_id, reason)
            else:
                self.control.begin_recovery(self.source.account_id)
            snapshot = self.source.capture()
            stop = next(o for o in snapshot.orders if o.order_type == "STOP_MARKET")
            before = self.control.account(self.source.account_id)
            allowed = self.control.claim_cancel(stop.order_id, fence=before.fence)
            pending = next(
                o
                for o in self.control.orders(self.receipt.intent_id)
                if o.order_id == stop.order_id
            )
            seen.append(
                (
                    allowed,
                    pending.cancel_requested,
                    self.control.account(self.source.account_id) == before,
                    stop.state,
                )
            )
        return original(self)

    monkeypatch.setattr(AstarterNativeStrategy, "_drive", drive)
    r = json.loads(run_btc_simulation(database_path=tmp_path / "control.sqlite").evidence_bytes)
    assert seen == [(False, False, True, "ACCEPTED")]
    assert not r["errors"]
    if reason == "NATIVE_INTEGRITY":
        assert [o["state"] for o in stops(r["native_snapshot"])] == ["ACCEPTED"]
    else:
        assert r["status"] == "COMPLETE"
