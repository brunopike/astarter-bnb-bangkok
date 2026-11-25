from decimal import localcontext
from importlib import import_module, util

import pytest


def api():
    name = "stark_trading_os.integrations.decimal_normalization"
    assert util.find_spec(name), "T2 lossless decimal boundary is missing"
    return import_module(name)


@pytest.mark.parametrize(
    "raw,want",
    [
        ("65000.12000000", "65000.12"),
        ("0.00000000", "0"),
        ("1000", "1000"),
        ("0.01000000", "0.01"),
        ("1." + "0" * 126, "1"),
        ("9" * 64, "9" * 64),
    ],
)
def test_lossless_canonicalization_preserves_integer_zeros(raw, want):
    assert api().normalize_decimal_text(raw) == want


@pytest.mark.parametrize(
    "raw",
    [
        "",
        " 1",
        "1 ",
        "1e-8",
        "+1",
        "-0",
        "-1",
        "01",
        "1.",
        "１",
        "NaN",
        "Infinity",
        1,
        1.0,
        True,
        None,
        "1." + "0" * 127,
        "9" * 65,
    ],
)
def test_no_coercion_rounding_truncation_or_oversized_source(raw):
    m = api()
    with pytest.raises(m.DecimalRejected):
        m.normalize_decimal_text(raw)


@pytest.mark.parametrize("raw,domain", [("0", "positive"), ("1.0001", "rate"), ("0", "step")])
def test_field_domains_are_checked_after_normalization(raw, domain):
    m = api()
    with pytest.raises(m.DecimalRejected):
        m.normalize_decimal_text(raw, domain=domain)


def test_ambient_decimal_precision_cannot_change_money():
    with localcontext() as ctx:
        ctx.prec = 2
        assert api().normalize_decimal_text("123456789.123450000") == "123456789.12345"


def test_raw_canonical_lineage_cannot_be_forged():
    m = api()
    value = m.DecimalValue(raw="0.1000", canonical="0.1")
    assert value.raw == "0.1000"
    with pytest.raises(ValueError):
        m.DecimalValue(raw="0.1000", canonical="0.2")
