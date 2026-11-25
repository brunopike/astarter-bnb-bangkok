from dataclasses import replace

import pytest
from nautilus_trader.model import CurrencyPair

from stark_trading_os.domain.astarter_simulation import AstarterIntegrityError
from tests.unit.control.astarter_native_setup import native_source


def test_cash_and_position_are_read_from_actual_native_account_not_input_scalars():
    with native_source() as source:
        snap = source.capture()
        source.verify(snap)
        assert snap.quote_total == "10000" and snap.base_total == "0"
        assert snap.position_quantity == "0" and snap.cash_reconciled
        assert snap.now_ns == snap.quote_time_ns == 1_700_000_000_000_000_000
        assert not snap.orders and not snap.fills


def test_scalar_replacement_or_different_venue_source_cannot_forge_authority():
    with native_source() as first, native_source() as second:
        original = first.capture()
        with pytest.raises(AstarterIntegrityError):
            first.verify(replace(original, quote_total="12000"))
        with pytest.raises(AstarterIntegrityError):
            second.verify(original)


def test_closed_native_source_cannot_refresh_stale_snapshots():
    with native_source() as source:
        source.close()
        with pytest.raises(AstarterIntegrityError):
            source.capture()


def test_close_releases_native_handles_before_later_api_threads_can_collect_cycles():
    with native_source() as source:
        snapshot = source.capture()
        source.close()
        assert not hasattr(source, "_strategy") and not hasattr(source, "_cache")
        with pytest.raises(AstarterIntegrityError, match="CLOSED"):
            source.verify(snapshot)


def test_changed_native_fee_or_instrument_does_not_keep_old_authority():
    with native_source() as source:
        fields = source._cache.instrument(source._instrument.id).to_dict()
        fields["taker_fee"] = "0.002"
        source._strategy.engine.add_instrument(CurrencyPair.from_dict(fields))
        with pytest.raises(AstarterIntegrityError, match="INSTRUMENT"):
            source.capture()
