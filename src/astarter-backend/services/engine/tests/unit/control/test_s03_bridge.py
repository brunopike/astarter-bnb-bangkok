"""S03 lease, owner fence, and atomic ingest on a new test database."""

from dataclasses import replace

import pytest
from nautilus_trader.model import Price, Quantity, QuoteTick

from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.astarter_simulation import (
    AstarterBlocked,
    SimulationPolicy,
    policy_bytes,
)
from stark_trading_os.domain.s03_bridge import S03BridgeRejected
from stark_trading_os.runner.s03_bridge_source import S03InputEvent, s03_event_key
from tests.unit.control.astarter_native_setup import native_source
from tests.unit.control.s03_native_setup import s03_bridge
from tests.unit.control.test_s03_lifecycle import _consume_news
from tests.unit.domain.test_s03_bridge import _stream_case, make_plan
from tests.unit.runner.test_s03_bridge_source import _session


def test_owner_fence_survives_a_read_and_blocks_the_old_controller(tmp_path) -> None:
    path = tmp_path / "control.sqlite"
    plan, manifest, _case = make_plan()
    with native_source() as source:
        first = s03_bridge(ControlStore.open(path), source)
        owner = first.activate(source, plan, manifest)
        view = first.state(owner.run_id)
        assert view.fence == 1
        assert not hasattr(view, "credential")
        assert owner.credential not in repr(view)
        second = s03_bridge(ControlStore.open(path), source)
        taken = second.takeover(source, owner.run_id)
        assert taken.fence == 2
        assert taken.credential != owner.credential
        copied = replace(owner, fence=taken.fence)
        with pytest.raises(S03BridgeRejected, match="S03_OWNER_STALE"):
            first.note_recovery(copied)
        recovered = second.note_recovery(taken)
        assert "RECOVERY_REACTIVATION_REQUIRED" in recovered.input_reasons
        second._astarter.observe(source, owner=taken)
        assert "RECOVERY_REACTIVATION_REQUIRED" in second.state(owner.run_id).input_reasons
        account = second._astarter.account("SIM-001")
        with pytest.raises(AstarterBlocked, match="S03_LEASE"):
            second._astarter.reserve(
                second._c.execute(
                    "SELECT binding_id FROM astarter_bindings WHERE account_id='SIM-001'"
                ).fetchone()[0],
                __import__(
                    "stark_trading_os.domain.astarter_simulation", fromlist=["Opportunity"]
                ).Opportunity("other-opportunity", account.epoch, account.epoch + 1, "5"),
                expected_epoch=account.epoch,
                expected_sequence=account.latest_sequence,
                fence=account.fence,
            )


def test_ingest_quote_watermark_rolls_back_with_the_native_observation(tmp_path) -> None:
    path = tmp_path / "control.sqlite"
    plan, manifest, _case = make_plan()
    with native_source() as source:
        control = s03_bridge(ControlStore.open(path), source)
        owner = control.activate(source, plan, manifest)
        before = control._c.execute(
            "SELECT last_sequence FROM astarter_accounts WHERE account_id='SIM-001'"
        ).fetchone()[0]
        event = S03InputEvent(
            kind="QUOTE",
            event_key="0" * 64,
            source_event_time_ns=1_700_000_000_000_000_000,
            received_time_ns=1_700_000_000_000_000_000,
            available_at_ns=1_700_000_000_000_000_000,
            quote={
                "source_sequence": 100,
                "bid": "59999",
                "ask": "60000",
                "bid_size": "10",
                "ask_size": "10",
                "instrument_id": "BTCUSDT.SIM",
            },
        )
        event = event.model_copy(update={"event_key": s03_event_key(event)})

        def fail(run_id: str) -> None:
            raise RuntimeError("injected")

        control._after_ingest = fail  # type: ignore[method-assign]
        with pytest.raises(RuntimeError, match="injected"):
            control.ingest(owner, source, event)
        assert (
            control._c.execute(
                "SELECT last_sequence FROM astarter_accounts WHERE account_id='SIM-001'"
            ).fetchone()[0]
            == before
        )
        assert (
            control._c.execute(
                "SELECT COUNT(*) FROM s03_events WHERE run_id=?",
                (owner.run_id,),
            ).fetchone()[0]
            == 0
        )
        assert control.state(owner.run_id).quote_source_watermark is None


def test_same_signal_replays_and_a_different_signal_conflicts(tmp_path) -> None:
    path = tmp_path / "control.sqlite"
    plan, manifest, case, signal, observation = _stream_case()
    when = signal.bar_close_ns + 1_000_000_000
    with _session(when, when) as (_engine, _strategy, source):
        control = s03_bridge(ControlStore.open(path), source)
        owner = control.activate(source, plan, manifest)
        _consume_news(control, owner, source, manifest)
        _engine.add_data(
            [
                QuoteTick(
                    _strategy.item.id,
                    Price.from_str("1253.00"),
                    Price.from_str("1254.00"),
                    Quantity.from_str("10.00000"),
                    Quantity.from_str("10.00000"),
                    when + 500_000,
                    when + 500_000,
                )
            ]
        )
        _engine.run()
        account = control._astarter.account("SIM-001")
        first = control.reserve_signal(
            owner,
            source,
            signal,
            observation,
            expected_epoch=account.epoch,
            expected_sequence=account.latest_sequence,
        )
        again = control.reserve_signal(
            owner,
            source,
            signal,
            observation,
            expected_epoch=account.epoch,
            expected_sequence=account.latest_sequence,
        )
        assert again.intent_id == first.intent_id
        changed = replace(signal, close="1")
        with pytest.raises(S03BridgeRejected, match="S03_SIGNAL_UNTRUSTED"):
            control.reserve_signal(
                owner,
                source,
                changed,
                replace(observation, close="1", signal=changed),
                expected_epoch=account.epoch,
                expected_sequence=account.latest_sequence,
            )
        control._c.execute(
            "UPDATE s03_signals SET content_sha256=? WHERE run_id=? AND signal_id=?",
            ("ab" * 32, owner.run_id, signal.signal_id),
        )
        with pytest.raises(S03BridgeRejected, match="S03_SIGNAL_CONFLICT"):
            control.reserve_signal(
                owner,
                source,
                signal,
                observation,
                expected_epoch=account.epoch,
                expected_sequence=account.latest_sequence,
            )
        assert case.issued(plan)
        assert policy_bytes(SimulationPolicy())
