from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

from nautilus_trader.model import (
    Currency,
    CurrencyPair,
    InstrumentId,
    Price,
    Quantity,
    QuoteTick,
    Symbol,
    Venue,
)
from nautilus_trader.persistence import ParquetDataCatalog

VENUE = Venue("SIM")
BASE_NS = 1_700_000_000_000_000_000


@dataclass(frozen=True)
class FixtureCatalog:
    catalog_path: Path
    instrument: CurrencyPair
    quotes: tuple[QuoteTick, ...]


def create_fixture_catalog(tmp_path: Path) -> FixtureCatalog:
    instrument = CurrencyPair(
        instrument_id=InstrumentId(Symbol("ETH/USDT"), VENUE),
        raw_symbol=Symbol("ETH/USDT"),
        base_currency=Currency.from_str("ETH"),
        quote_currency=Currency.from_str("USDT"),
        price_precision=2,
        size_precision=3,
        price_increment=Price.from_str("0.01"),
        size_increment=Quantity.from_str("0.001"),
        ts_event=BASE_NS,
        ts_init=BASE_NS,
        min_quantity=Quantity.from_str("0.001"),
        min_notional=None,
        margin_init=Decimal("0.10"),
        margin_maint=Decimal("0.05"),
        maker_fee=Decimal("0"),
        taker_fee=Decimal("0"),
    )
    quotes = (
        QuoteTick(
            instrument.id,
            Price.from_str("99.00"),
            Price.from_str("100.00"),
            Quantity.from_str("10.000"),
            Quantity.from_str("10.000"),
            BASE_NS,
            BASE_NS,
        ),
        QuoteTick(
            instrument.id,
            Price.from_str("99.00"),
            Price.from_str("100.00"),
            Quantity.from_str("10.000"),
            Quantity.from_str("10.000"),
            BASE_NS + 1,
            BASE_NS + 1,
        ),
    )
    catalog_path = tmp_path / "catalog"
    catalog_path.mkdir()
    catalog = ParquetDataCatalog(str(catalog_path))
    catalog.write_instruments([instrument])
    catalog.write_quote_ticks(quotes)
    return FixtureCatalog(catalog_path, instrument, quotes)
