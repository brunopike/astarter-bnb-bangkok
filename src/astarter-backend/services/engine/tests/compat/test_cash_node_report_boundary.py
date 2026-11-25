from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest
from nautilus_trader.backtest import BacktestVenueConfig
from nautilus_trader.execution import FillModel
from nautilus_trader.model import AccountType, BookType, OmsType, Venue
from nautilus_trader.persistence import ParquetDataCatalog

from stark_trading_os.runner.report_export import (
    ReportSchemaError,
    export_backtest_reports,
    export_dataframe_report,
    export_portfolio_equity_series,
)
from tests.compat.rc3_cash_node_fixture import cash_node_case, catalog_file_hashes


def test_node_cannot_accept_the_existing_historical_base_fill_profile() -> None:
    with pytest.raises(TypeError, match="Cannot convert FillModel to FillModel"):
        BacktestVenueConfig(
            name="SIM",
            oms_type=OmsType.NETTING,
            account_type=AccountType.CASH,
            book_type=BookType.L1_MBP,
            starting_balances=["0 ETH", "1000 USDT"],
            fill_model=FillModel(),
        )


@pytest.mark.parametrize(
    ("rate", "fees", "final_cash"),
    [
        ("0.001", ["0.10500000 USDT", "0.21000000 USDT"], "1104.68500000"),
        ("0.002", ["0.21000000 USDT", "0.42000000 USDT"], "1104.37000000"),
    ],
)
def test_node_consumes_run_local_fees_without_rewriting_source(
    tmp_path: Path, rate: str, fees: list[str], final_cash: str
) -> None:
    with cash_node_case(tmp_path, taker_fee=rate, sell_on_second=True) as case:
        fills = case.node.generate_fills_report(case.run_config_id).reset_index()
        assert fills["commission"].tolist() == fees
        assert fills["order_side"].tolist() == ["BUY", "SELL"]
        assert fills["last_px"].tolist() == ["105.00", "210.00"]
        account = export_dataframe_report(
            "account", case.node.generate_account_report(case.run_config_id, venue=Venue("SIM"))
        )
        balances = {row["currency"]: Decimal(str(row["total"])) for row in account}
        assert balances == {"ETH": Decimal("0"), "USDT": Decimal(final_cash)}
        assert catalog_file_hashes(case.source_root) == case.source_hashes
        source_instrument = ParquetDataCatalog(str(case.source_root)).instruments()[0]
        assert source_instrument.maker_fee == source_instrument.taker_fee == Decimal("0")


def test_cash_vector_cannot_be_misrepresented_as_v1_single_currency_equity(
    tmp_path: Path,
) -> None:
    with cash_node_case(tmp_path) as case:
        portfolio = case.node.get_engine_portfolio(case.run_config_id)
        account = portfolio.account(Venue("SIM"))
        assert account is not None
        snapshot = portfolio.snapshots(account.id)[-1]
        assert {str(value.currency): value.as_decimal() for value in snapshot.total_equity} == {
            "ETH": Decimal("1"), "USDT": Decimal("894.895")
        }
        assert snapshot.base_currency_equity is None
        unrealized = portfolio.unrealized_pnls(venue=Venue("SIM"))
        assert {str(k): str(v) for k, v in unrealized.items()} == {"USDT": "105.00000000 USDT"}
        positions = case.node.generate_positions_report(case.run_config_id).reset_index()
        assert positions["side"].tolist() == ["LONG"]
        assert positions["quantity"].tolist() == ["1.000"]
        with pytest.raises(ReportSchemaError, match="must have sole total equity"):
            export_portfolio_equity_series(case.node, case.run_config_id, Venue("SIM"))


def test_market_only_native_report_is_rejected_by_unchanged_v1_exporter(
    tmp_path: Path,
) -> None:
    with cash_node_case(tmp_path) as case:
        orders = case.node.generate_orders_report(case.run_config_id)
        assert orders["type"].tolist() == ["MARKET"]
        assert orders["status"].tolist() == ["FILLED"]
        # The old mixed-order contract must not silently invent absent fields.
        with pytest.raises(ReportSchemaError, match="orders report missing fields"):
            export_dataframe_report("orders", orders)
        with pytest.raises(ReportSchemaError, match="orders report missing fields"):
            export_backtest_reports(case.node, case.run_config_id, Venue("SIM"), case.result)
