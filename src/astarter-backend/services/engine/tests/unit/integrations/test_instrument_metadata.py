from importlib import import_module, util

import pytest

T0 = 1_700_000_000_000_000_000
TTL = 300_000_000_000


def api():
    name = "stark_trading_os.integrations.instrument_metadata"
    assert util.find_spec(name), "T2 versioned metadata boundary is missing"
    return import_module(name)


def query(**changes):
    return api().InstrumentQuery(
        **(
            dict(
                venue="BINANCE",
                market="SPOT",
                symbol="BTCUSDT",
                expected_base="BTC",
                expected_quote="USDT",
            )
            | changes
        )
    )


def receipt(**changes):
    return api().MetadataReceiptV1(
        **(
            dict(
                receipt_id="receipt-1",
                raw_sha256="a" * 64,
                facts_revision="b" * 64,
                source_policy_id="offline-test",
                source_policy_revision="v1",
                received_at_ns=T0,
                available_at_ns=T0 + 1,
                expires_at_ns=T0 + TTL,
            )
            | changes
        )
    )


def test_receipt_delayed_processing_retains_real_times_without_renewal():
    r = receipt(available_at_ns=T0 + TTL + 1)
    assert r.available_at_ns == T0 + TTL + 1
    assert r.expires_at_ns == T0 + TTL
    assert not r.usable_at(T0 + TTL + 1)


def test_receipt_consumption_is_half_open_and_has_no_future_access():
    r = receipt()
    assert not r.usable_at(T0)
    assert r.usable_at(T0 + 1)
    assert not r.usable_at(T0 + TTL)


@pytest.mark.parametrize(
    "changes",
    [
        {"received_at_ns": True},
        {"available_at_ns": True},
        {"expires_at_ns": True},
        {"available_at_ns": T0 - 1},
        {"expires_at_ns": T0 + TTL + 1},
        {"received_at_ns": 2**64 - 1},
        {"available_at_ns": 2**64},
    ],
)
def test_receipt_rejects_invalid_or_extended_times(changes):
    with pytest.raises(ValueError):
        receipt(**changes)


@pytest.mark.parametrize("now", [True, -1, 2**64, 1.0])
def test_consumer_time_never_coerces(now):
    with pytest.raises(ValueError):
        receipt().usable_at(now)


def test_failed_result_may_not_carry_observation():
    m = api()
    with pytest.raises(ValueError):
        m.MetadataResult(query=query(), status="INVALID_RESPONSE", receipt=receipt())


def test_object_construct_bypass_is_revalidated():
    m = api()
    bad = query().model_copy(update={"expected_base": "BTCU", "expected_quote": "BTCU"})
    with pytest.raises(ValueError):
        m.checked(m.InstrumentQuery, bad)
