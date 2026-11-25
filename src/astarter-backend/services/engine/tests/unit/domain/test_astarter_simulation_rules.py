from dataclasses import replace

import pytest

from stark_trading_os.domain.astarter_simulation import (
    AstarterBlocked,
    Opportunity,
    SimulationPolicy,
    policy_bytes,
    validate_opportunity,
)


def test_fixed_policy_has_separate_identity_and_canonical_bytes():
    p = SimulationPolicy()
    assert p.identity == "ASTARTER_BTC_NATIVE_SIM_V1"
    assert policy_bytes(p) == policy_bytes(replace(p))
    assert b'"59000"' in policy_bytes(p)


@pytest.mark.parametrize(
    "changes",
    [
        dict(requested_risk=5.0),
        dict(created_at_ns=True),
        dict(expires_at_ns=11_000_000_001),
        dict(created_at_ns=7_000_000_000),
    ],
)
def test_bad_or_future_opportunity_never_becomes_fresh(changes):
    o = Opportunity("btc-synthetic-1", 1_000_000_000, 6_000_000_000, "5")
    with pytest.raises((ValueError, AstarterBlocked)):
        validate_opportunity(replace(o, **changes), now_ns=2_000_000_000, policy=SimulationPolicy())


def test_expiry_is_absolute_and_cannot_be_extended_by_repeated_requests():
    o = Opportunity("btc-synthetic-1", 1_000_000_000, 6_000_000_000, "5")
    validate_opportunity(o, now_ns=5_999_999_999, policy=SimulationPolicy())
    with pytest.raises(AstarterBlocked, match="EXPIRED"):
        validate_opportunity(o, now_ns=6_000_000_000, policy=SimulationPolicy())
