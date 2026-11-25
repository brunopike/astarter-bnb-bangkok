"""Exact native cash arithmetic shared by live callbacks and saved-fact checks."""

from collections.abc import Mapping, Sequence
from fractions import Fraction
from typing import cast


def initial_native_cash(currencies: tuple[str, str], starting_cash: str) -> dict[str, Fraction]:
    return {currencies[0]: Fraction(0), currencies[1]: Fraction(starting_cash)}


def apply_native_fill_cash(
    totals: dict[str, Fraction],
    cash_delta: Mapping[str, str],
    commission: Mapping[str, str],
) -> None:
    """Use the native cash delta, including native rounding, then charge its fee once."""
    for currency, value in cash_delta.items():
        totals[currency] += Fraction(value)
    for currency, value in commission.items():
        totals[currency] -= Fraction(value)


def native_position_matches_cash(
    positions: Sequence[Mapping[str, object]], base_total: Fraction | None
) -> bool:
    return (
        len(positions) <= 1
        and all(row["side"] == "LONG" for row in positions)
        and base_total
        == sum((Fraction(cast(str, row["quantity"])) for row in positions), Fraction(0))
    )
