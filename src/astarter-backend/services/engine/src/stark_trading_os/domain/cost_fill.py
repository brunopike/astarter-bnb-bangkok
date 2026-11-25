"""Closed Task 6 adapter from CostFillModel.v1 to pinned rc3 native models."""

from __future__ import annotations

from dataclasses import dataclass

from nautilus_trader.execution import (
    DefaultFillModel,
    MakerTakerFeeModel,
    StaticLatencyModel,
)
from nautilus_trader.model import BookType
from pydantic import ValidationError

from stark_trading_os.domain.models import CostFillModelV1


class UnsupportedCostFillModel(ValueError):
    def __init__(self) -> None:
        super().__init__("UNSUPPORTED_COST_FILL_MODEL")


@dataclass(frozen=True)
class NativeCostFillProfile:
    fee_model: MakerTakerFeeModel
    fill_model: DefaultFillModel
    latency_model: StaticLatencyModel
    book_type: BookType
    liquidity_consumption: bool


def build_native_cost_fill_profile(
    model: CostFillModelV1, *, replay_seed: int
) -> NativeCostFillProfile:
    if type(model) is not CostFillModelV1:
        raise UnsupportedCostFillModel
    if type(replay_seed) is not int or not 0 <= replay_seed <= (2**64) - 1:
        raise ValueError("replay_seed must be an unsigned 64-bit integer.")
    try:
        CostFillModelV1.model_validate(model.model_dump(mode="json", by_alias=True))
    except ValidationError as error:
        raise UnsupportedCostFillModel from error
    return NativeCostFillProfile(
        fee_model=MakerTakerFeeModel(),
        fill_model=DefaultFillModel(
            prob_fill_on_limit=1.0,
            prob_slippage=0.0,
            random_seed=replay_seed,
        ),
        latency_model=StaticLatencyModel(
            base_latency_nanos=0,
            insert_latency_nanos=0,
            update_latency_nanos=0,
            cancel_latency_nanos=0,
        ),
        book_type=BookType.L1_MBP,
        liquidity_consumption=True,
    )
