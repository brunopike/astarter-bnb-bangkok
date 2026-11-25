"""A stale core controller keeps durable failure evidence without native dispatch."""

import json
from dataclasses import asdict, fields, replace
from decimal import Decimal

import pytest

from stark_trading_os.control.astarter.service import AstarterControl
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.s03_bridge import S03BridgeControl
from stark_trading_os.domain.astarter_simulation import AstarterIntegrityError, NativeSnapshot
from stark_trading_os.runner import s03_simulation as sim
from stark_trading_os.runner.astarter_facts import NativeFactsSource


@pytest.mark.parametrize("phase", ["submit", "cancel"])
def test_core_fence_after_claim_preserves_failure_evidence(tmp_path, monkeypatch, phase):
    path = tmp_path / "owned.sqlite"
    seen = {"cut": False, "sends_after": 0, "cancels_after": 0}
    entry = S03BridgeControl.claim_entry
    cancel = AstarterControl.claim_cancel
    native_submit, native_cancel = (
        sim.S03NativeStrategy.submit_order,
        sim.S03NativeStrategy.cancel_order,
    )
    native_close = NativeFactsSource.close

    def cut(control, owner, source):
        with_context = ControlStore.open(path)
        try:
            replacement = sim.S03ControllerBackend(control.controller_identity).control(
                with_context
            )
            before = replacement.controller_identity.fence
            after = replacement.begin_recovery(source.account_id, owner=owner)
            assert after.fence == before + 1
            seen["core_fence"] = after.fence
            seen["s03_fence"] = owner.fence
            seen["audit_at_cut"] = with_context._connection.execute(
                "SELECT COUNT(*) FROM astarter_audit"
            ).fetchone()[0]
            seen["cut"] = True
        finally:
            with_context.close()

    def claim_entry(bridge, owner, source, order_id):
        result = entry(bridge, owner, source, order_id)
        if phase == "submit" and result is not None and not seen["cut"]:
            cut(bridge._astarter, owner, source)
        return result

    def claim_cancel(control, order_id, **kwargs):
        result = cancel(control, order_id, **kwargs)
        if phase == "cancel" and result and not seen["cut"]:
            cut(control, kwargs["owner"], kwargs["source"])
        return result

    def submit(strategy, order):
        seen["sends_after"] += int(seen["cut"])
        return native_submit(strategy, order)

    def native_cancellation(strategy, order):
        seen["cancels_after"] += int(seen["cut"])
        return native_cancel(strategy, order)

    def close(source):
        if not source._closed:
            seen["final_native"] = asdict(source.capture())
        native_close(source)
        seen["source_closed"] = source._closed

    monkeypatch.setattr(S03BridgeControl, "claim_entry", claim_entry)
    monkeypatch.setattr(AstarterControl, "claim_cancel", claim_cancel)
    monkeypatch.setattr(sim.S03NativeStrategy, "submit_order", submit)
    monkeypatch.setattr(sim.S03NativeStrategy, "cancel_order", native_cancellation)
    monkeypatch.setattr(NativeFactsSource, "close", close)
    result = None
    try:
        result = sim.run_s03_simulation(
            database_path=path, scenario="open_position" if phase == "submit" else "cancel_race"
        )
    except Exception as error:
        seen["raised"] = {"type": type(error).__name__, "message": str(error)}
    if result is not None:
        seen["evidence"] = json.loads(result.evidence_bytes)
    (tmp_path / ("core-fence-" + phase + ".json")).write_text(
        json.dumps(seen, ensure_ascii=False, indent=2)
    )
    assert seen["cut"]
    assert seen["sends_after"] == 0 and seen["cancels_after"] == 0
    assert seen["source_closed"]
    assert result is not None, seen.get("raised")
    report = json.loads(result.evidence_bytes)
    assert report["status"] == "FAILED"
    assert report["settlement"] is None and report["duplicate_settlement"] is None
    assert report["reconciliation_rejection"] == "ASTARTER_CONTROLLER_FENCED"
    assert report["cleanup"] == dict(source_closed=True, store_closed=True, engine_disposed=True)
    assert (
        Decimal(report["account"]["cash_hold"]) > 0
        or Decimal(report["account"]["inventory_risk"]) > 0
    )
    assert len(report["audit"]) == seen["audit_at_cut"]


def test_added_native_source_fields_are_authenticated_and_old_seal_position_stays():
    from tests.unit.control.astarter_native_setup import native_source

    names = [f.name for f in fields(NativeSnapshot)]
    assert names[15] == "seal"
    with native_source() as source:
        snapshot = source.capture()
        source.verify(snapshot)
        for key, value in (
            ("source_event_time_ns", snapshot.source_event_time_ns + 1),
            ("bid_size", "0.00001"),
            ("ask_size", "0.00002"),
        ):
            with pytest.raises(AstarterIntegrityError, match="ATTESTATION_INVALID"):
                source.verify(replace(snapshot, **{key: value}))
