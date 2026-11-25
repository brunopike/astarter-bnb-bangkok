from __future__ import annotations

from decimal import Decimal
from hashlib import sha256
from pathlib import Path

from nautilus_trader.model import CurrencyPair
from nautilus_trader.persistence import ParquetDataCatalog

from stark_trading_os.runner.historical_cost import (
    HistoricalExecutionCostV1,
    NativeHistoricalExecutionProfile,
    build_historical_execution_profile,
)
from tests.compat.rc3_bar_fixture import run_bar_case
from tests.integration.catalog.test_historical_publication import _publisher, _source


def _cost(*, starting_cash: str, taker_fee: str) -> HistoricalExecutionCostV1:
    return HistoricalExecutionCostV1.model_validate(
        {
            "schema": "HistoricalExecutionCost.v1",
            "profile": "HISTORICAL_BAR_CLOSE_CASH_V1",
            "starting_cash": starting_cash,
            "maker_fee": "0.0002",
            "taker_fee": taker_fee,
            "fee_source": "synthetic explicit assumption",
            "fill_model": "NATIVE_BASE_FILL",
            "latency": "ZERO",
            "execution_timing": "CLOSED_BAR_NATIVE",
            "random_seed_support": "UNSUPPORTED",
        }
    )


def _decimal(value: object) -> Decimal:
    return Decimal(str(value).split()[0])


def _final_account_row(result: dict[str, object], currency: str) -> dict[str, object]:
    account = result["account"]
    assert isinstance(account, list)
    rows = [row for row in account if row["currency"] == currency]
    assert rows, f"native account report has no {currency} row"
    return rows[-1]


def _catalog_snapshot(root: Path) -> dict[str, tuple[bytes, str]]:
    return {
        path.relative_to(root).as_posix(): (
            path.read_bytes(),
            sha256(path.read_bytes()).hexdigest(),
        )
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _run_profile(
    profile: NativeHistoricalExecutionProfile,
    bars: list[object],
    *,
    quantity: str = "1.000",
    sell_on_second: bool = False,
) -> dict[str, object]:
    return run_bar_case(
        quantity=quantity,
        sell_on_second=sell_on_second,
        instrument=profile.instrument,
        bars=bars,
        starting_quote_balance=profile.starting_quote_balance,
        fee_model=profile.fee_model,
        fill_model=profile.fill_model,
        latency_model=profile.latency_model,
        book_type=profile.book_type,
        oms_type=profile.oms_type,
        account_type=profile.account_type,
        routing=profile.routing,
        use_position_ids=profile.use_position_ids,
        use_random_ids=profile.use_random_ids,
        use_reduce_only=profile.use_reduce_only,
        use_market_order_acks=profile.use_market_order_acks,
        bar_execution=profile.bar_execution,
        bar_adaptive_high_low_ordering=profile.bar_adaptive_high_low_ordering,
        trade_execution=profile.trade_execution,
        liquidity_consumption=profile.liquidity_consumption,
        allow_cash_borrowing=profile.allow_cash_borrowing,
    )


def test_two_cost_profiles_drive_real_native_fees_and_preserve_published_catalog(
    tmp_path: Path,
) -> None:
    source = _source()
    service, store = _publisher(tmp_path)
    try:
        publication = service.publish_historical(source)
        assert service.revalidate(publication.catalog_revision) == publication
        target = tmp_path / "runtime" / "catalogs" / publication.catalog_revision
        before_files = _catalog_snapshot(target)
        catalog = ParquetDataCatalog(str(target.resolve()))
        source_instrument = catalog.instruments()[0]
        assert isinstance(source_instrument, CurrencyPair)
        source_instrument_before = source_instrument.to_dict()
        bars = catalog.query_bars()

        first_profile = build_historical_execution_profile(
            source_instrument,
            _cost(starting_cash="1000", taker_fee="0.001"),
        )
        second_profile = build_historical_execution_profile(
            source_instrument,
            _cost(starting_cash="1000", taker_fee="0.002"),
        )
        first = _run_profile(first_profile, bars, sell_on_second=True)
        second = _run_profile(second_profile, bars, sell_on_second=True)

        assert first_profile.cost_sha256 != second_profile.cost_sha256
        assert [fill["order_side"] for fill in first["fills"]] == ["BUY", "SELL"]
        assert [fill["order_side"] for fill in second["fills"]] == ["BUY", "SELL"]
        assert [_decimal(fill["commission"]) for fill in first["fills"]] == [
            Decimal("0.105"),
            Decimal("0.210"),
        ]
        assert [_decimal(fill["commission"]) for fill in second["fills"]] == [
            Decimal("0.210"),
            Decimal("0.420"),
        ]
        assert [fill["currency"] for fill in first["fills"]] == ["USDT", "USDT"]
        assert [fill["currency"] for fill in second["fills"]] == ["USDT", "USDT"]
        assert [order["status"] for order in first["orders"]] == ["FILLED", "FILLED"]
        assert [order["status"] for order in second["orders"]] == ["FILLED", "FILLED"]
        assert _decimal(_final_account_row(first, "USDT")["total"]) == Decimal("1104.685")
        assert _decimal(_final_account_row(second, "USDT")["total"]) == Decimal("1104.37")
        assert _decimal(_final_account_row(first, "ETH")["total"]) == Decimal("0")
        assert _decimal(_final_account_row(second, "ETH")["total"]) == Decimal("0")
        assert first["positions"][0]["side"] == "FLAT"
        assert second["positions"][0]["side"] == "FLAT"

        expected_clocks = [
            1_700_000_060_000_000_000,
            1_700_000_120_000_000_000,
        ]
        for result in (first, second):
            callbacks = [item for item in result["observations"] if item["event"] == "bar_callback"]
            fills = [item for item in result["observations"] if item["event"] == "order_filled"]
            assert [item["clock_ns"] for item in callbacks] == expected_clocks
            assert [item["bar_ts_event"] for item in callbacks] == expected_clocks
            assert [item["clock_ns"] for item in fills] == expected_clocks
            assert [item["event_ts"] for item in fills] == expected_clocks

        assert source_instrument.to_dict() == source_instrument_before
        assert source_instrument.maker_fee == Decimal("0")
        assert source_instrument.taker_fee == Decimal("0")
        assert _catalog_snapshot(target) == before_files
        assert service.revalidate(publication.catalog_revision) == publication
        assert _catalog_snapshot(target) == before_files
    finally:
        store.close()


def test_native_cash_boundaries_expose_fee_inclusive_account_gap_not_a_safeguard(
    tmp_path: Path,
) -> None:
    service, store = _publisher(tmp_path)
    try:
        publication = service.publish_historical(_source())
        target = tmp_path / "runtime" / "catalogs" / publication.catalog_revision
        catalog = ParquetDataCatalog(str(target.resolve()))
        source_instrument = catalog.instruments()[0]
        assert isinstance(source_instrument, CurrencyPair)
        bars = catalog.query_bars()

        denied = _run_profile(
            build_historical_execution_profile(
                source_instrument,
                _cost(starting_cash="10", taker_fee="0.001"),
            ),
            bars,
        )
        notional_only = _run_profile(
            build_historical_execution_profile(
                source_instrument,
                _cost(starting_cash="105", taker_fee="0.001"),
            ),
            bars,
        )

        assert denied["fills"] == []
        assert denied["positions"] == []
        assert [order["status"] for order in denied["orders"]] == ["DENIED"]
        assert _decimal(_final_account_row(denied, "USDT")["total"]) == Decimal("10")
        assert _decimal(_final_account_row(denied, "ETH")["total"]) == Decimal("0")

        assert [order["status"] for order in notional_only["orders"]] == ["FILLED"]
        assert [_decimal(fill["commission"]) for fill in notional_only["fills"]] == [
            Decimal("0.105")
        ]
        assert _decimal(_final_account_row(notional_only, "USDT")["total"]) == Decimal("105")
        assert _decimal(_final_account_row(notional_only, "ETH")["total"]) == Decimal("0")
        assert len(notional_only["positions"]) == 1
        assert notional_only["positions"][0]["side"] == "LONG"
        assert _decimal(notional_only["positions"][0]["quantity"]) == Decimal("1")
    finally:
        store.close()


def test_default_profile_charges_each_real_native_oversized_split(tmp_path: Path) -> None:
    service, store = _publisher(tmp_path)
    try:
        publication = service.publish_historical(_source())
        target = tmp_path / "runtime" / "catalogs" / publication.catalog_revision
        catalog = ParquetDataCatalog(str(target.resolve()))
        source_instrument = catalog.instruments()[0]
        assert isinstance(source_instrument, CurrencyPair)
        profile = build_historical_execution_profile(
            source_instrument,
            _cost(starting_cash="100000", taker_fee="0.001"),
        )

        result = _run_profile(profile, catalog.query_bars(), quantity="250.000")

        assert [_decimal(fill["last_qty"]) for fill in result["fills"]] == [
            Decimal("25"),
            Decimal("225"),
        ]
        assert [_decimal(fill["last_px"]) for fill in result["fills"]] == [
            Decimal("105"),
            Decimal("105.01"),
        ]
        assert [_decimal(fill["commission"]) for fill in result["fills"]] == [
            Decimal("2.625"),
            Decimal("23.62725"),
        ]
        assert [fill["currency"] for fill in result["fills"]] == ["USDT", "USDT"]
        assert [order["status"] for order in result["orders"]] == ["FILLED"]
        assert _decimal(result["orders"][0]["filled_qty"]) == Decimal("250")
    finally:
        store.close()
