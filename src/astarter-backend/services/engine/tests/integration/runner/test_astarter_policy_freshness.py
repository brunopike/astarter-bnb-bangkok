"""Frozen policy freshness at every native execution and settlement boundary."""

import json
from dataclasses import replace

import pytest

from stark_trading_os.control.astarter.service import AstarterControl
from stark_trading_os.domain.astarter_simulation import AstarterBlocked, SimulationPolicy
from stark_trading_os.runner.astarter_simulation import AstarterNativeStrategy, run_btc_simulation
from tests.unit.control.test_astarter_control import reserve, setup


@pytest.mark.parametrize("ttl", [250_000_000, 1_000_000_000])
@pytest.mark.parametrize("alias", [False, True])
@pytest.mark.parametrize("age", ["before", "deadline", "late"])
def test_frozen_entry_ttl_is_not_relaxed_by_default_or_another_binding(tmp_path, ttl, alias, age):
    policy = replace(SimulationPolicy(), snapshot_ttl_ns=ttl)
    with setup(tmp_path / "control.sqlite", policy=policy) as (control, binding, source, store):
        receipt = reserve(control, binding)
        if alias:
            control.activate(source, SimulationPolicy(), component_id="b" * 64)
        raw = store._connection.execute(
            "SELECT last_snapshot FROM astarter_accounts WHERE account_id='SIM-001'"
        ).fetchone()[0]
        observed = json.loads(raw)["observed_wall_ns"]
        elapsed = ttl - 1 if age == "before" else ttl if age == "deadline" else 2_000_000_000
        store._clock = lambda: observed + elapsed
        before = control.account("SIM-001")
        if age == "before":
            command = control.claim_order(receipt.entry_order_id, fence=before.fence)
            assert command is not None and command.role == "ENTRY"
            return
        with pytest.raises(AstarterBlocked, match="ASTARTER_NATIVE_SNAPSHOT_STALE"):
            control.claim_order(receipt.entry_order_id, fence=before.fence)
        assert control.account("SIM-001") == before
        assert control.orders(receipt.intent_id)[0].dispatch_state == "PENDING"


def use_short_policy(monkeypatch):
    original = AstarterNativeStrategy.__init__

    def initialize(self, **kwargs):
        original(self, **kwargs)
        self.policy = replace(self.policy, snapshot_ttl_ns=1_000_000_000)

    monkeypatch.setattr(AstarterNativeStrategy, "__init__", initialize)


def stale_clock(control):
    raw = control._c.execute("SELECT last_snapshot FROM astarter_accounts").fetchone()[0]
    observed = json.loads(raw)["observed_wall_ns"]
    control._store._clock = lambda: observed + 2_000_000_000


@pytest.mark.parametrize("operation", ["STOP_CLAIM", "EXIT_CLAIM", "PREPARE_EXIT"])
def test_short_ttl_applies_at_reduction_prepare_and_claim(tmp_path, monkeypatch, operation):
    use_short_policy(monkeypatch)
    original_send = AstarterNativeStrategy._send
    seen = []
    pending_proofs = []

    def send(self, key):
        matches = "-P" in key if operation == "STOP_CLAIM" else key.endswith("-X")
        if matches and not seen:
            clock = self.store._clock
            before = self.control.account(self.source.account_id)
            stale_clock(self.control)
            try:
                if operation == "PREPARE_EXIT":
                    self.control.prepare_exit(self.receipt.intent_id)
                else:
                    self.control.claim_order(key, fence=before.fence)
            except AstarterBlocked as error:
                seen.append(str(error))
                row = self.control._c.execute(
                    "SELECT dispatch_state FROM astarter_orders WHERE order_id=?", (key,)
                ).fetchone()
                pending_proofs.append(
                    (row[0], self.control.account(self.source.account_id) == before)
                )
            else:
                seen.append("UNSAFE_STALE_PERMISSION")
            finally:
                self.store._clock = clock
        return original_send(self, key)

    monkeypatch.setattr(AstarterNativeStrategy, "_send", send)
    r = json.loads(run_btc_simulation(database_path=tmp_path / "control.sqlite").evidence_bytes)
    assert seen == ["ASTARTER_NATIVE_SNAPSHOT_STALE"]
    assert pending_proofs == [("PENDING", True)]
    assert r["status"] == "COMPLETE" and not r["errors"]


def test_short_ttl_cancel_cannot_remove_protection_from_a_stale_snapshot(tmp_path, monkeypatch):
    use_short_policy(monkeypatch)
    original = AstarterControl.claim_cancel
    seen = []
    pending_proofs = []

    def cancel(self, key, *, fence):
        order = self._c.execute("SELECT * FROM astarter_orders WHERE order_id=?", (key,)).fetchone()
        eligible = (
            self._intent(order["intent_id"])["state"] == "CLOSING"
            and order["native_state"] == "ACCEPTED"
            and not order["cancel_requested"]
        )
        if "-P" in key and eligible and not seen:
            clock = self._store._clock
            before = self.account("SIM-001")
            stale_clock(self)
            try:
                original(self, key, fence=fence)
            except AstarterBlocked as error:
                seen.append(str(error))
                requested = self._c.execute(
                    "SELECT cancel_requested FROM astarter_orders WHERE order_id=?", (key,)
                ).fetchone()[0]
                pending_proofs.append((requested, self.account("SIM-001") == before))
            else:
                seen.append("UNSAFE_STALE_CANCEL")
            finally:
                self._store._clock = clock
        return original(self, key, fence=fence)

    monkeypatch.setattr(AstarterControl, "claim_cancel", cancel)
    r = json.loads(run_btc_simulation(database_path=tmp_path / "control.sqlite").evidence_bytes)
    assert seen == ["ASTARTER_NATIVE_SNAPSHOT_STALE"]
    assert pending_proofs == [(0, True)]
    assert r["status"] == "COMPLETE" and not r["errors"]


@pytest.mark.parametrize("alias", [False, True])
def test_short_ttl_settlement_requires_fresh_economic_snapshot(tmp_path, monkeypatch, alias):
    use_short_policy(monkeypatch)
    original = AstarterControl.settle
    seen = []
    original_quote = AstarterNativeStrategy.on_quote

    def add_looser_zero_fill(self, quote):
        original_quote(self, quote)
        if alias and self.sequence == 3:
            binding = self.control.activate(self.source, SimulationPolicy(), component_id="b" * 64)
            reserve_receipt = reserve(self.control, binding, key="looser-zero")
            self._send(reserve_receipt.entry_order_id)

    def settle(self, account_id, **kwargs):
        if not seen:
            clock = self._store._clock
            stale_clock(self)
            try:
                original(self, account_id, **kwargs)
            except AstarterBlocked as error:
                seen.append(str(error))
            else:
                seen.append("UNSAFE_STALE_SETTLEMENT")
            finally:
                self._store._clock = clock
        return original(self, account_id, **kwargs)

    monkeypatch.setattr(AstarterControl, "settle", settle)
    monkeypatch.setattr(AstarterNativeStrategy, "on_quote", add_looser_zero_fill)
    r = json.loads(run_btc_simulation(database_path=tmp_path / "control.sqlite").evidence_bytes)
    assert seen == ["ASTARTER_NATIVE_SNAPSHOT_STALE"]
    assert r["status"] == "COMPLETE" and r["settlement"]["new_lock"] == "0.646944"


@pytest.mark.parametrize("revoked", [False, True])
def test_open_cost_aggregate_keeps_strict_active_intent_ttl_despite_wider_alias(tmp_path, revoked):
    policy = replace(SimulationPolicy(), snapshot_ttl_ns=1_000_000_000)
    with setup(tmp_path / "control.sqlite", policy=policy) as (control, binding, source, store):
        reserve(control, binding)
        control.activate(source, SimulationPolicy(), component_id="b" * 64)
        if revoked:
            control.revoke(binding)
        stale_clock(control)
        with pytest.raises(AstarterBlocked, match="ASTARTER_NATIVE_SNAPSHOT_STALE"):
            control._open_cost_debit("SIM-001")
