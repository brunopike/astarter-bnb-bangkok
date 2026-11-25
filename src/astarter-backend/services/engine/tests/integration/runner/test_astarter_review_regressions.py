"""Native reproductions of final-review crash windows, not synthetic balance mocks."""

import json
from dataclasses import replace

import pytest

from stark_trading_os.domain.astarter_simulation import (
    AstarterBlocked,
    AstarterConflict,
    Opportunity,
)
from stark_trading_os.runner.astarter_simulation import (
    AstarterNativeStrategy,
    run_btc_simulation,
)


def run(tmp_path, scenario):
    result = run_btc_simulation(database_path=tmp_path / "control.sqlite", scenario=scenario)
    assert result.engine_disposed
    return json.loads(result.evidence_bytes)


@pytest.mark.parametrize("closing", [False, True])
def test_prepared_unclaimed_stop_recovers_or_locally_cancels_for_approved_exit(
    tmp_path, monkeypatch, closing
):
    original_send = AstarterNativeStrategy._send
    original_quote = AstarterNativeStrategy.on_quote
    skipped = []

    def skip_first_stop(self, key):
        if "-P" in key and not skipped:
            skipped.append(key)
            return
        return original_send(self, key)

    def recover_while_still_holding(self, quote):
        original_quote(self, quote)
        if self.sequence == 2:
            self._recover_controller()
            self._drive()

    monkeypatch.setattr(AstarterNativeStrategy, "_send", skip_first_stop)
    if not closing:
        monkeypatch.setattr(AstarterNativeStrategy, "on_quote", recover_while_still_holding)
    r = run(tmp_path, "recover" if closing else "open_dip")
    assert skipped and r["controller_reopened"] and not r["errors"]
    assert r["entry_submissions"] == 1
    assert "PROTECTION_FAILED" not in r["account"]["locks"]
    if closing:
        assert r["status"] == "COMPLETE"
        assert r["native_snapshot"]["base_total"] == "0"
        assert len([f for f in r["native_snapshot"]["fills"] if f["side"] == "SELL"]) == 1
    else:
        assert r["protected_acceptances"] == 1
        stops = [o for o in r["native_snapshot"]["orders"] if o["order_type"] == "STOP_MARKET"]
        assert len(stops) == 1 and stops[0]["order_id"] == skipped[0]
        assert r["native_snapshot"]["position_quantity"] == "0.00368"


def test_unclaimed_stop_past_original_deadline_recovers_to_halted_flat(tmp_path, monkeypatch):
    original_send = AstarterNativeStrategy._send
    original_quote = AstarterNativeStrategy.on_quote

    def skip_stop(self, key):
        if "-P" in key:
            return
        return original_send(self, key)

    def recover_late(self, quote):
        original_quote(self, quote)
        if self.sequence == 3:
            self._recover_controller()
            self._drive()

    monkeypatch.setattr(AstarterNativeStrategy, "_send", skip_stop)
    monkeypatch.setattr(AstarterNativeStrategy, "on_quote", recover_late)
    r = run(tmp_path, "open_dip")
    assert r["status"] == "HALTED_FLAT" and r["controller_reopened"]
    assert "PROTECTION_FAILED" in r["account"]["locks"]
    assert r["protected_acceptances"] == 0 and not r["errors"]
    assert r["native_snapshot"]["position_quantity"] == "0"


def test_zero_fill_policy_alias_cannot_change_account_profit_lock_rate(tmp_path, monkeypatch):
    original_quote = AstarterNativeStrategy.on_quote
    conflicts = []

    def add_alias(self, quote):
        original_quote(self, quote)
        if self.sequence != 3:
            return
        try:
            binding = self.control.activate(
                self.source, replace(self.policy, lock_fraction="0"), component_id="c" * 64
            )
        except AstarterConflict as error:
            conflicts.append(str(error))
            return
        # On the old bug this is an actual native zero-fill IOC at ask61001>cap60120.
        account = self.control.account(self.source.account_id)
        receipt = self.control.reserve(
            binding,
            Opportunity("alias-zero", quote.ts_init, quote.ts_init + 1_000_000_000, "5"),
            expected_epoch=account.epoch,
            expected_sequence=account.latest_sequence,
            fence=account.fence,
        )
        self._send(receipt.entry_order_id)

    monkeypatch.setattr(AstarterNativeStrategy, "on_quote", add_alias)
    r = run(tmp_path, "round_trip")
    assert conflicts == ["ASTARTER_ACCOUNT_LOCK_FRACTION_CANNOT_RESET"]
    assert r["settlement"]["net_profit"] == "3.23472"
    assert r["settlement"]["new_lock"] == "0.646944"
    assert r["alias_settlement"]["new_lock"] == "0"
    assert r["account"]["profit_hwm"] == "3.23472"


@pytest.mark.parametrize("role", ["STOP", "EXIT"])
def test_reduction_claim_rechecks_staleness_then_recovery_before_native_send(
    tmp_path, monkeypatch, role
):
    original_send = AstarterNativeStrategy._send
    seen = []

    def interrupted_send(self, key):
        matches = "-P" in key if role == "STOP" else key.endswith("-X")
        if matches and not seen:
            clock = self.store._clock
            self.store._clock = lambda: clock() + 6_000_000_000
            recovery = self.control.begin_recovery(self.source.account_id)
            try:
                self.control.claim_order(key, fence=recovery.fence)
            except AstarterBlocked as error:
                seen.append(str(error))
            else:
                seen.append("UNSAFE_STALE_CLAIM")
            finally:
                self.store._clock = clock
            try:
                self.control.claim_order(key, fence=recovery.fence)
            except AstarterBlocked as error:
                seen.append(str(error))
            else:
                seen.append("UNSAFE_UNRECONCILED_CLAIM")
            self.control.observe(self.source)
        return original_send(self, key)

    monkeypatch.setattr(AstarterNativeStrategy, "_send", interrupted_send)
    r = run(tmp_path, "round_trip")
    assert seen == [
        "ASTARTER_NATIVE_SNAPSHOT_STALE",
        "ASTARTER_NATIVE_RECONCILIATION_REQUIRED",
    ]
    assert r["status"] == "COMPLETE" and not r["errors"]
    assert r["entry_submissions"] == 1 and r["native_snapshot"]["position_quantity"] == "0"
