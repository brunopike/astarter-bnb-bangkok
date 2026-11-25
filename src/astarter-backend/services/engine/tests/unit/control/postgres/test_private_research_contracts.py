"""Wire aliases, identity separation and exact budget units for the PRIVATE adapter."""

import pytest
from pydantic import ValidationError

from stark_trading_os.control.postgres.private_research_contracts import (
    PrivateLease,
    PrivatePrincipal,
    RequestIdentity,
    reserve_microusd,
    utc_month_bounds,
)


def test_lease_matches_frozen_frontend_wire_and_rejects_public_schema():
    value = {
        "leaseId": "private-lease-1",
        "targetId": "private-sg-1",
        "database": "astarter_private",
        "schema": "astarter_private",
        "runtimeRole": "astarter_private_runtime_v1",
        "audience": "astarter-research",
        "budgetId": "research-202611",
        "model": "openai/gpt-4.1-mini",
        "expiresAt": 1_800_000_000_000,
    }
    assert PrivateLease.model_validate(value).model_dump(by_alias=True) == value
    for field, wrong in [
        ("schema", "public"),
        ("schema", "q08_research"),
        ("audience", "preview"),
        ("expiresAt", True),
    ]:
        with pytest.raises(ValidationError):
            PrivateLease.model_validate(value | {field: wrong})


def test_private_scope_is_the_authenticated_tenant_and_never_silently_replaced():
    value = {
        "subjectId": "wallet:1:abc",
        "tenantId": "tenant:a",
        "scopeId": "tenant:a",
        "audience": "astarter-research",
        "expiresAt": 1000,
        "permissions": ("research:analyze",),
    }
    assert PrivatePrincipal.model_validate(value).tenant_id == "tenant:a"
    assert PrivatePrincipal.model_validate(
        value | {"permissions": ["research:analyze"]}
    ).permissions == ("research:analyze",)
    with pytest.raises(ValidationError):
        PrivatePrincipal.model_validate(value | {"scopeId": "tenant:b"})
    with pytest.raises(ValidationError):
        PrivatePrincipal.model_validate(value | {"permissions": ("admin",)})
    with pytest.raises(ValidationError):
        RequestIdentity(subjectId="u", tenantId="a", scopeId="b", requestId="request-123")


def test_approved_token_bound_and_microusd_round_up_match_node():
    assert reserve_microusd() == 20_890
    assert reserve_microusd(1) == 2
    for invalid in [0, -1, 13057, True, 13056.0]:
        with pytest.raises(ValueError):
            reserve_microusd(invalid)


def test_month_is_utc_and_handles_year_boundary():
    assert utc_month_bounds(1794810000000) == (1793491200000, 1796083200000)
    assert utc_month_bounds(1798761599999) == (1796083200000, 1798761600000)
    assert utc_month_bounds(1798761600000) == (1798761600000, 1801440000000)
    with pytest.raises(ValueError):
        utc_month_bounds(True)
