from decimal import Decimal

from rc3_bar_fixture import run_bar_case

FIRST_CLOSE_NS = 1_700_000_060_000_000_000
SECOND_CLOSE_NS = 1_700_000_120_000_000_000


def _decimal(value: object) -> Decimal:
    return Decimal(str(value).split()[0])


def _final_account_row(result: dict[str, object], currency: str) -> dict[str, object]:
    rows = [row for row in result["account"] if row["currency"] == currency]
    assert rows, f"native account report has no {currency} row"
    return rows[-1]


def test_closed_bar_signal_uses_native_close_not_next_open() -> None:
    result = run_bar_case()

    first = result["fills"][0]
    assert _decimal(first["last_px"]) == Decimal("105")
    assert _decimal(first["last_qty"]) == Decimal("1")
    assert _decimal(first["commission"]) == Decimal("0.105")
    assert first["currency"] == "USDT"
    assert str(first["commission"]).endswith(" USDT")

    callbacks = [
        observation
        for observation in result["observations"]
        if observation["event"] == "bar_callback"
    ]
    assert [callback["clock_ns"] for callback in callbacks] == [
        FIRST_CLOSE_NS,
        SECOND_CLOSE_NS,
    ]
    assert [callback["bar_ts_event"] for callback in callbacks] == [
        FIRST_CLOSE_NS,
        SECOND_CLOSE_NS,
    ]
    assert [callback["bar_ts_init"] for callback in callbacks] == [
        FIRST_CLOSE_NS,
        SECOND_CLOSE_NS,
    ]

    trace = [observation["event"] for observation in result["observations"]]
    first_callback = trace.index("bar_callback")
    submit = trace.index("order_submit")
    fill = trace.index("order_filled")
    second_callback = trace.index("bar_callback", first_callback + 1)
    assert first_callback < submit < fill < second_callback
    fill_observation = result["observations"][fill]
    assert fill_observation["clock_ns"] == FIRST_CLOSE_NS
    assert fill_observation["event_ts"] == FIRST_CLOSE_NS


def test_last_bar_does_not_manufacture_position_exit() -> None:
    result = run_bar_case()

    assert len(result["fills"]) == 1
    assert len(result["positions"]) == 1
    assert _decimal(result["positions"][0]["quantity"]) == Decimal("1")
    assert result["positions"][0]["side"] == "LONG"
    assert result["orders"][0]["status"] == "FILLED"


def test_cash_account_rejects_an_order_it_cannot_fund() -> None:
    result = run_bar_case(cash="10")

    assert result["fills"] == []
    assert result["positions"] == []
    assert len(result["orders"]) == 1
    assert result["orders"][0]["status"] == "DENIED"
    assert _decimal(result["orders"][0]["filled_qty"]) == Decimal("0")
    denial = next(
        observation
        for observation in result["observations"]
        if observation["event"] == "order_denied"
    )
    assert denial["reason"] == (
        "NOTIONAL_EXCEEDS_FREE_BALANCE: "
        "free=10.00000000 USDT, notional=105.00000000 USDT"
    )
    assert all(
        _decimal(row[field]) >= Decimal("0")
        for row in result["account"]
        for field in ("total", "locked", "free")
    )
    assert _decimal(_final_account_row(result, "USDT")["total"]) == Decimal("10")
    assert _decimal(_final_account_row(result, "ETH")["total"]) == Decimal("0")


def test_round_trip_charges_two_native_fees_and_reconciles_cash() -> None:
    result = run_bar_case(sell_on_second=True)

    assert len(result["fills"]) == 2
    assert [fill["order_side"] for fill in result["fills"]] == ["BUY", "SELL"]
    assert [_decimal(fill["last_px"]) for fill in result["fills"]] == [
        Decimal("105"),
        Decimal("210"),
    ]
    assert [_decimal(fill["commission"]) for fill in result["fills"]] == [
        Decimal("0.105"),
        Decimal("0.210"),
    ]
    assert [fill["currency"] for fill in result["fills"]] == ["USDT", "USDT"]
    assert all(str(fill["commission"]).endswith(" USDT") for fill in result["fills"])
    fill_observations = [
        observation
        for observation in result["observations"]
        if observation["event"] == "order_filled"
    ]
    assert [observation["clock_ns"] for observation in fill_observations] == [
        FIRST_CLOSE_NS,
        SECOND_CLOSE_NS,
    ]
    assert [observation["event_ts"] for observation in fill_observations] == [
        FIRST_CLOSE_NS,
        SECOND_CLOSE_NS,
    ]
    assert _decimal(_final_account_row(result, "USDT")["total"]) == Decimal("1104.685")
    assert _decimal(_final_account_row(result, "ETH")["total"]) == Decimal("0")
    assert len(result["positions"]) == 1
    assert _decimal(result["positions"][0]["quantity"]) == Decimal("0")
    assert result["positions"][0]["side"] == "FLAT"


def test_oversized_bar_order_locks_native_fill_split_and_end_state() -> None:
    result = run_bar_case(quantity="250.000", cash="100000")

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
    assert len(result["orders"]) == 1
    assert result["orders"][0]["status"] == "FILLED"
    assert _decimal(result["orders"][0]["filled_qty"]) == Decimal("250")
    assert _decimal(result["orders"][0]["quantity"]) == Decimal("250")
    assert _decimal(result["positions"][0]["quantity"]) == Decimal("250")

    fill_clocks = [
        observation["clock_ns"]
        for observation in result["observations"]
        if observation["event"] == "order_filled"
    ]
    assert fill_clocks == [FIRST_CLOSE_NS, FIRST_CLOSE_NS]
