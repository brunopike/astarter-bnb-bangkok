from __future__ import annotations

from copy import deepcopy

import pytest
from pydantic import ValidationError

from stark_trading_os.domain.historical_input import (
    HistoricalExecutionV2,
    HistoricalRuntimeV2,
    SmaConfigurationInputV2,
    SmaCrossParametersV1,
)
from tests.unit.runner.test_historical_cost import _supported_cost


def config_payload() -> dict:
    return {
        "name": "SMA engineering baseline",
        "strategy_ref": "sma-cross-long-flat@v1",
        "purpose": "ENGINEERING_BASELINE",
        "catalog_revision": "a" * 64,
        "parameters": {"fast_period": 5, "slow_period": 20, "order_quantity": "1"},
        "risk": {
            "schema": "SmaLocalRisk.v1",
            "max_order_notional": "1000",
            "max_position_quantity": "2",
        },
        "execution_cost": _supported_cost(),
    }


def runtime_payload() -> dict:
    return {
        "engine_package_version": "2.0.0rc3",
        "engine_tag_commit": "648970ce64a304d93da0a29320cb6e19b905fa39",
        "python_version": "3.12.4",
        "precision_mode": "FIXED_PRECISION_16",
        "platform_system": "Darwin",
        "platform_machine": "arm64",
        "native_extension_sha256": "b" * 64,
    }


def execution_payload() -> dict:
    return {
        "venue": "SIM",
        "oms_type": "NETTING",
        "account_type": "CASH",
        "book_type": "L1_MBP",
        "initial_state": "ZERO_BASE_QUOTE_CASH_NO_POSITION",
        "bar_execution": True,
        "bar_adaptive_high_low_ordering": False,
        "trade_execution": False,
        "liquidity_consumption": True,
        "routing": False,
        "use_random_ids": False,
        "use_position_ids": True,
        "use_reduce_only": False,
        "use_market_order_acks": False,
        "allow_cash_borrowing": False,
    }


def test_sma_config_is_strict_nested_frozen_and_preserves_explicit_values() -> None:
    payload = config_payload()
    config = SmaConfigurationInputV2.model_validate(payload)
    assert config.model_dump(mode="json", by_alias=True) == payload
    with pytest.raises(ValidationError):
        config.parameters.fast_period = 10
    with pytest.raises(ValidationError):
        config.execution_cost.taker_fee = "0.2"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("fast_period", True),
        ("fast_period", 1),
        ("fast_period", 20),
        ("fast_period", 5.0),
        ("slow_period", 501),
        ("slow_period", "20"),
        ("order_quantity", "0"),
        ("order_quantity", "-1"),
        ("order_quantity", "1.0"),
        ("order_quantity", "1e-3"),
        ("order_quantity", ".1"),
        ("order_quantity", "01"),
        ("order_quantity", "NaN"),
        ("order_quantity", "9" * 65),
        ("order_quantity", 1),
        ("python_path", "private-marker"),
    ],
)
def test_parameters_reject_ambiguous_or_unsupported_inputs(field: str, value: object) -> None:
    payload = config_payload()["parameters"]
    payload[field] = value
    with pytest.raises(ValidationError):
        SmaCrossParametersV1.model_validate(payload)


@pytest.mark.parametrize("periods", [(2, 3), (5, 20), (10, 30), (499, 500)])
def test_sma_period_boundaries_are_supported(periods: tuple[int, int]) -> None:
    result = SmaCrossParametersV1.model_validate(
        {"fast_period": periods[0], "slow_period": periods[1], "order_quantity": "0.001"}
    )
    assert (result.fast_period, result.slow_period) == periods


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("name",), "   "),
        (("name",), "x" * 121),
        (("strategy_ref",), "arbitrary@v1"),
        (("purpose",), "LIVE"),
        (("catalog_revision",), "A" * 64),
        (("execution_cost",), None),
        (("risk", "max_order_notional"), "0"),
        (("risk", "max_position_quantity"), "0.5"),
        (("execution_cost", "random_seed"), 123),
        (("execution_cost", "execution_timing"), "NEXT_OPEN"),
    ],
)
def test_configuration_rejects_unsupported_or_inconsistent_settings(
    path: tuple[str, ...], value: object
) -> None:
    payload = config_payload()
    target = payload
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    with pytest.raises(ValidationError):
        SmaConfigurationInputV2.model_validate(payload)


@pytest.mark.parametrize("field", [k for k, v in execution_payload().items() if type(v) is bool])
@pytest.mark.parametrize("wrong_kind", ["opposite", "integer", "text"])
def test_execution_flags_cannot_be_disabled_or_coerced(field: str, wrong_kind: str) -> None:
    payload = execution_payload()
    original = payload[field]
    payload[field] = {"opposite": not original, "integer": int(original), "text": str(original)}[
        wrong_kind
    ]
    with pytest.raises(ValidationError):
        HistoricalExecutionV2.model_validate(payload)


def test_runtime_is_a_closed_pinned_identity() -> None:
    payload = runtime_payload()
    assert HistoricalRuntimeV2.model_validate(payload).python_version == "3.12.4"
    for field, value in (
        ("engine_package_version", "latest"),
        ("python_version", "3.13.1"),
        ("platform_system", "Linux"),
        ("platform_machine", "x86_64"),
        ("native_extension_sha256", "not-a-digest"),
        ("writer_class", "untrusted"),
    ):
        invalid = deepcopy(payload)
        invalid[field] = value
        with pytest.raises(ValidationError):
            HistoricalRuntimeV2.model_validate(invalid)
