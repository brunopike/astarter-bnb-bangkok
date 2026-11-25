"""Independent external expectations and counterexamples for pure risk mathematics."""

import json
from dataclasses import FrozenInstanceError, asdict, replace
from decimal import Context, Decimal, Inexact, getcontext, localcontext
from fractions import Fraction as F
from pathlib import Path

import pytest

from stark_trading_os.domain import astarter_risk as ar

PACKET = json.loads(
    (Path(__file__).parents[2] / "fixtures/astarter_risk_vectors.v1.json").read_text()
)
GOLDENS = [c for c in PACKET["cases"] if c["verification_mode"] == "ARITHMETIC_ORACLE"]
PAIR = ar.Pair("BTC", "USDT")


def profile(**changes):
    return replace(
        ar.CostProfile(PAIR, "60120", "58882", "0.001", "0.001", "0.00001", "0.00000001"), **changes
    )


def limits(**changes):
    return replace(ar.SizingLimits(PAIR, "5", "1000", "1000", "0.00001", "5"), **changes)


def decimal_text(value):
    """Test-side exact finite rendering, independent of production helpers."""
    with localcontext(Context(prec=512)) as ctx:
        ctx.traps[Inexact] = True
        result = format(Decimal(value.numerator) / Decimal(value.denominator), "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def run_golden(c):
    x = c["inputs"]
    kind = c["kind"]
    if kind in ("directional_sizing", "directional_candidate_check"):
        p = ar.CostProfile(
            PAIR,
            *(
                x[k]
                for k in (
                    "cap",
                    "stress_exit",
                    "buy_fee",
                    "sell_fee",
                    "quantity_step",
                    "quote_unit",
                )
            ),
        )
        lim = ar.SizingLimits(
            PAIR,
            *(
                x[k]
                for k in (
                    "risk_budget",
                    "notional_cap",
                    "available_quote",
                    "min_quantity",
                    "min_notional",
                )
            ),
        )
        if kind == "directional_candidate_check":
            out = ar.spot_costs(p, x["quantity"])
            return {
                "reserve": out.reserve,
                "stress_loss": out.stress_loss,
                "risk_budget_exceeded": F(out.stress_loss) > F(x["risk_budget"]),
            }
        out = ar.size_spot(p, lim)
        if out.costs is None:
            return {
                "quantity": "0",
                "decision": "REJECT_MIN_ORDER",
                "round_up_forbidden": out.reason == "BELOW_MIN_ORDER",
            }
        more = ar.spot_costs(p, decimal_text(F(out.costs.quantity) + F(p.quantity_step)))
        return {
            "quantity": out.costs.quantity,
            "reserve": out.costs.reserve,
            "stress_loss": out.costs.stress_loss,
            "max_fill_count_per_leg": out.costs.fill_bound,
            "initial_floor_quantity": out.initial_quantity,
            "fee_upper_bound_adjustment_steps": out.reduced_steps,
            "quantity_plus_step_exceeds_risk": F(more.stress_loss) > F(x["risk_budget"]),
        }
    if kind == "staged_budget":
        out = ar.staged_risk(
            "USDT",
            *(
                x[k]
                for k in (
                    "equity",
                    "base_risk_fraction",
                    "card_cap_fraction",
                    "policy_cap_fraction",
                    "account_multiplier",
                    "stage_multiplier",
                )
            ),
        )
        return {"risk_fraction": out.risk_fraction, "requested_risk": out.risk_quote}
    if kind == "minimum_remaining":
        rows = (
            ar.BudgetLimit("PRIVATE", "25", "0", "0", "0"),
            ar.BudgetLimit("CYCLE", "500", "0", "55", "0"),
            ar.BudgetLimit("DAY", "200", "0", "55", "0"),
            ar.BudgetLimit("PORTFOLIO", "100", "0", "55", "0"),
            ar.BudgetLimit("ASSET", "50", "0", "45", "0"),
            ar.BudgetLimit("CORRELATED", "60", "0", "55", "0"),
            ar.BudgetLimit("EVENT", "50", "0", "0", "0"),
        )
        out = ar.remaining_budget("USDT", x["requested_risk"], rows)
        by = {v.scope: v for v in out.lines}
        return {
            "portfolio_remaining": by["PORTFOLIO"].remaining,
            "asset_remaining": by["ASSET"].remaining,
            "correlated_remaining": by["CORRELATED"].remaining,
            "allowed_risk": out.candidate_risk,
        }
    if kind == "future_occupancy":
        rows = tuple(
            ar.BudgetLimit(
                k,
                *(
                    x[n]
                    for n in (
                        "cycle_limit",
                        "booked_loss_debit",
                        "inventory_future_loss",
                        "pending_or_unknown_future_loss",
                    )
                ),
            )
            for k in ar.BUDGET_SCOPES
        )
        out = ar.remaining_budget("USDT", "10", rows)
        return {
            "total_occupied_including_booked": out.lines[0].occupied,
            "new_remaining": out.lines[0].remaining,
            "already_booked_loss_not_charged_twice": F(out.lines[0].occupied)
            == sum(
                (
                    F(x[k])
                    for k in (
                        "booked_loss_debit",
                        "inventory_future_loss",
                        "pending_or_unknown_future_loss",
                    )
                ),
                F(0),
            ),
        }
    if kind == "profit_reserve":
        out = ar.profit_lock(
            ar.ProfitInput(
                "USDT",
                *(
                    x[k]
                    for k in (
                        "gross_native_equity",
                        "settled_net_profit",
                        "realized_profit_HWM",
                        "locked_reserve_before",
                        "lock_fraction",
                        "flat",
                        "orders_terminal",
                        "reconciled",
                    )
                ),
            )
        )
        return {
            "new_profit_increment": out.increment,
            "new_locked_reserve": out.new_reserve,
            "locked_reserve_after": out.reserve_after,
            "tradable_equity": out.tradable_equity,
            "wealth": out.wealth,
        }
    if kind == "kelly_advisory":
        out = ar.kelly_advice(x["probability"], x["net_payoff_ratio"], x["fraction"])
        return {
            "full_kelly": out.full_fraction,
            "fractional_kelly": out.fractional_fraction,
            "positive_kelly_candidate": out.positive,
            "execution_authorized": out.execution_authorized,
        }
    if kind == "basket_check":
        p = profile(stress_exit=x["stress_exit"], quantity_step=x["quantity_step"])
        rows = tuple(ar.BasketOrder(v["cap"], v["quantity"]) for v in x["layers"])
        out = ar.basket_costs(p, rows)
        more = ar.basket_costs(
            p,
            tuple(
                replace(v, quantity=decimal_text(F(v.quantity) + F(p.quantity_step))) for v in rows
            ),
        )
        return {
            "total_quantity": out.quantity,
            "reserve": out.reserve,
            "stress_loss": out.stress_loss,
            "risk_budget_exceeded": F(out.stress_loss) > F(x["risk_budget"]),
            "one_more_quantity_step_each_layer_exceeds_risk": F(more.stress_loss)
            > F(x["risk_budget"]),
        }
    if kind == "LP_full_principal_budget":
        out = ar.lp_budget(
            "USDT",
            *(
                x[k]
                for k in (
                    "equity",
                    "portfolio_risk_fraction",
                    "other_future_occupancy",
                    "nominal_cap_fraction",
                    "requested_principal",
                    "gas_reserve_quote",
                )
            ),
            "0.00000001",
        )
        return {
            "portfolio_remaining": out.remaining,
            "requested_pressure": out.requested_pressure,
            "maximum_principal_by_risk": out.maximum_principal,
            "risk_budget_exceeded": out.exceeds_budget,
            "execution_authorized": out.execution_authorized,
        }
    if kind == "atomic_net_cost_floor":
        out = ar.atomic_cost_floor(
            "USDC",
            *(
                x[k]
                for k in (
                    "input_quote",
                    "amount_out_net",
                    "gas_quote",
                    "external_fee_quote",
                    "failure_MEV_buffer_quote",
                    "minimum_absolute_net",
                    "minimum_net_fraction",
                    "quote_unit",
                )
            ),
            fees_in_output=x["pool_fees_already_in_net"],
        )
        return {
            "net_profit_after_all_costs": out.net_profit,
            "required_minimum_net": out.minimum_net,
            "amount_out_min": out.minimum_output,
            "cost_floor_met": out.cost_floor_met,
            "execution_authorized": out.execution_authorized,
        }
    raise AssertionError(kind)


@pytest.mark.parametrize("case", GOLDENS, ids=lambda c: c["id"])
def test_external_golden_arithmetic(case):
    # These literals were prepared before production code; no expected value uses ar helpers.
    observed = run_golden(case)
    for key, value in case["expected"].items():
        if key == "extra_layers_forbidden":
            # Strategy-specific runtime layer ceilings belong to Q04, not Q03 arithmetic.
            continue
        assert observed[key] == value


@pytest.mark.parametrize(
    "bad", [1.0, True, None, "NaN", "Infinity", "1e3", " 1", "01", "1.0", "-0", "9" * 65]
)
def test_rejects_noncanonical_or_nonexact_money_without_echoing_it(bad):
    with pytest.raises(ar.InvalidRiskInput) as exc:
        ar.size_spot(profile(cap=bad), limits())
    assert str(exc.value) == "ASTARTER_RISK_INPUT_INVALID"


@pytest.mark.parametrize(
    "field,value",
    [
        ("cap", "0"),
        ("stress_exit", "60120"),
        ("buy_fee", "-0.1"),
        ("sell_fee", "1.01"),
        ("quantity_step", "0"),
        ("quote_unit", "0"),
    ],
)
def test_invalid_cost_profile_fails_closed(field, value):
    with pytest.raises(ar.InvalidRiskInput):
        ar.size_spot(profile(**{field: value}), limits())


def test_cash_split_rounding_boundary_and_more_cash_never_reduces_quantity():
    low = ar.size_spot(profile(), limits(available_quote="221.462843"))
    exact = ar.size_spot(profile(), limits(available_quote="221.46284528"))
    assert low.costs.quantity == "0.00367"
    assert exact.costs.quantity == "0.00368"
    assert low.reduced_steps == 1


def test_zero_stage_and_zero_budget_produce_no_positive_candidate():
    assert ar.staged_risk("USDT", "10000", "0.0025", "0.0025", "0.0025", "1", "0").risk_quote == "0"
    out = ar.size_spot(profile(), limits(risk_budget="0"))
    assert out.costs is None and out.reason == "NO_RISK_BUDGET"


def test_aggressive_multiplier_does_not_exceed_card_or_policy_cap():
    out = ar.staged_risk("USDT", "10000", "0.0025", "0.0025", "0.0025", "1.25", "1")
    assert out.risk_quote == "25"
    assert (
        ar.staged_risk("USDT", "10000", "0.0025", "0.0025", "0.0025", "1", "1", "0").risk_quote
        == "0"
    )


def test_cross_currency_and_missing_step_or_scope_are_not_guessed():
    with pytest.raises(ar.InvalidRiskInput):
        ar.size_spot(profile(), limits(pair=ar.Pair("ETH", "USDT")))
    with pytest.raises(ar.InvalidRiskInput):
        ar.remaining_budget("USDT", "5", ())
    with pytest.raises(ar.InvalidRiskInput):
        ar.spot_costs(profile(), "0.000011")


def test_all_limits_apply_and_over_limit_is_visible():
    rows = tuple(ar.BudgetLimit(k, "100", "0", "0", "0") for k in ar.BUDGET_SCOPES)
    rows = tuple(replace(v, inventory_future="101") if v.scope == "EVENT" else v for v in rows)
    out = ar.remaining_budget("USDT", "25", rows)
    event = next(v for v in out.lines if v.scope == "EVENT")
    assert out.candidate_risk == "0" and event.headroom == "-1" and event.over_limit
    with pytest.raises(ar.InvalidRiskInput):
        ar.remaining_budget("USDT", "25", rows[:-1] + (rows[0],))
    with pytest.raises(ar.InvalidRiskInput):
        ar.remaining_budget("USDT", "25", list(rows))


def test_minimum_order_cannot_force_more_risk_or_cash():
    out = ar.size_spot(profile(), limits(min_notional="500"))
    assert out.costs is None and out.reason == "BELOW_MIN_ORDER"


def test_tiny_steps_have_bounded_search_and_maximal_valid_quantity():
    step = "0.000000000000000000000000000001"
    p = profile(quantity_step=step)
    rejected = ar.size_spot(p, limits())
    assert rejected.costs is None and rejected.reason == "BELOW_MIN_ORDER"
    out = ar.size_spot(p, limits(min_quantity=step, min_notional="0"))
    assert out.search_iterations <= 220
    assert out.costs is not None
    assert F(out.costs.stress_loss) <= 5
    more = ar.spot_costs(p, decimal_text(F(out.costs.quantity) + F(step)))
    assert F(out.costs.reserve) <= 1000
    assert F(more.stress_loss) > 5 or F(more.reserve) > 1000


def test_basket_sizing_preserves_martingale_ratios_and_aggregate_budget():
    layers = (
        ar.WeightedLayer("60000", "1"),
        ar.WeightedLayer("59000", "1.5"),
        ar.WeightedLayer("58000", "2.25"),
    )
    out = ar.size_basket(profile(stress_exit="57000"), layers, limits())
    assert out.first_layer_quantity == "0.00056"
    assert tuple(v.quantity for v in out.orders) == ("0.00056", "0.00084", "0.00126")
    assert F(out.costs.stress_loss) <= 5
    assert out.execution_authorized is False


def test_basket_minima_and_mutable_layers_rejected_without_upsize():
    layers = (ar.WeightedLayer("60000", "1"), ar.WeightedLayer("59400", "1"))
    assert (
        ar.size_basket(profile(stress_exit="57000"), layers, limits(min_notional="1000")).costs
        is None
    )
    with pytest.raises(ar.InvalidRiskInput):
        ar.size_basket(profile(), list(layers), limits())


@pytest.mark.parametrize("count", [0, 17])
def test_basket_layer_count_is_bounded(count):
    with pytest.raises(ar.InvalidRiskInput):
        ar.size_basket(profile(), (ar.WeightedLayer("60000", "1"),) * count, limits())
    with pytest.raises(ar.InvalidRiskInput):
        ar.basket_costs(profile(), (ar.BasketOrder("60000", "0.001"),) * count)


@pytest.mark.parametrize(
    "bad_pair", [ar.Pair("BTC", "BTC"), ar.Pair("btc", "USDT"), ar.Pair("BTC", "USDT/USDC"), None]
)
def test_currency_units_are_validated_even_on_typed_dataclasses(bad_pair):
    with pytest.raises(ar.InvalidRiskInput):
        ar.size_spot(profile(pair=bad_pair), limits())


@pytest.mark.parametrize(
    "field", ["risk_budget", "notional_cap", "available_quote", "min_notional"]
)
def test_negative_limits_are_rejected(field):
    with pytest.raises(ar.InvalidRiskInput):
        ar.size_spot(profile(), limits(**{field: "-1"}))


@pytest.mark.parametrize("account,stage", [("2", "1"), ("1", "0.1"), ("1", "1.25")])
def test_only_declared_account_modes_and_stage_multipliers_apply(account, stage):
    with pytest.raises(ar.InvalidRiskInput):
        ar.staged_risk("USDT", "10000", "0.0025", "0.0025", "0.0025", account, stage)


def test_budget_headroom_cannot_grow_when_occupancy_increases():
    original = tuple(ar.BudgetLimit(k, "50", "1", "2", "3") for k in ar.BUDGET_SCOPES)
    occupied = tuple(replace(v, pending_future="49") if v.scope == "ASSET" else v for v in original)
    before = ar.remaining_budget("USDT", "25", original)
    after = ar.remaining_budget("USDT", "25", occupied)
    assert before.candidate_risk == "25" and after.candidate_risk == "0"
    assert before.lines[0].occupied == "6"
    assert next(v for v in after.lines if v.scope == "ASSET").headroom == "-2"


def test_spot_risk_monotonicity_and_maximal_step_under_each_budget():
    previous = F(0)
    for risk in ("1", "2", "5", "10"):
        out = ar.size_spot(profile(), limits(risk_budget=risk))
        assert out.costs is not None
        current = F(out.costs.quantity)
        assert current >= previous
        assert F(out.costs.stress_loss) <= F(risk)
        more = ar.spot_costs(profile(), decimal_text(current + F("0.00001")))
        assert F(more.stress_loss) > F(risk)
        previous = current


def test_zero_commission_still_retains_declared_split_rounding_buffer():
    out = ar.spot_costs(profile(buy_fee="0", sell_fee="0"), "0.00001")
    assert out.buy_fee_max == "0.00000001" and out.sell_fee_max == "0.00000001"
    assert out.stress_loss == "0.01238002"


@pytest.mark.parametrize("field", ["flat", "orders_terminal", "reconciled"])
def test_unsettled_profit_never_generates_a_lock_candidate(field):
    p = ar.ProfitInput("USDT", "12000", "2000", "0", "0", "0.2", True, True, True)
    with pytest.raises(ar.InvalidRiskInput):
        ar.profit_lock(replace(p, **{field: False}))


def test_profit_hwm_and_negative_tradable_equity_are_not_reset():
    out = ar.profit_lock(
        ar.ProfitInput("USDT", "100", "-9900", "2000", "400", "0.2", True, True, True)
    )
    assert (out.profit_hwm_after, out.reserve_after, out.tradable_equity) == ("2000", "400", "-300")


def test_profit_lock_requires_real_booleans_and_does_not_mutate_snapshot():
    inputs = ar.ProfitInput("USDT", "12000", "2000", "0", "0", "0.2", True, True, True)
    before = asdict(inputs)
    with pytest.raises(ar.InvalidRiskInput):
        ar.profit_lock(replace(inputs, flat=1))
    out = ar.profit_lock(inputs)
    assert asdict(inputs) == before
    assert out.reserve_after == "400" and out.wealth == inputs.gross_equity
    assert ar.profit_lock(inputs) == out  # repeat math is not a persisted second booking


def test_kelly_recurring_ratio_is_conservatively_quantized_and_never_permission():
    out = ar.kelly_advice("0.33", "3", "0.25")
    assert out.full_fraction == "0.106666666666666666"
    assert out.fractional_fraction == "0.026666666666666666"
    assert out.execution_authorized is False
    with pytest.raises(ar.InvalidRiskInput):
        ar.kelly_advice("0.34", "0", "0.25")


def test_atomic_cost_pass_is_not_a_capability_or_execution_permission():
    out = ar.atomic_cost_floor(
        "USDC", "1000", "1006", "3", "1", "1", "1", "0.0005", "0.000001", fees_in_output=True
    )
    assert out.cost_floor_met and not out.execution_authorized
    with pytest.raises(ar.InvalidRiskInput):
        ar.atomic_cost_floor(
            "USDC", "1000", "1006", "3", "1", "1", "1", "0.0005", "0.000001", fees_in_output=False
        )


def test_common_basket_increment_sizes_integer_weights_without_missing_valid_lots():
    p = profile(
        cap="100", stress_exit="80", buy_fee="0", sell_fee="0", quantity_step="1", quote_unit="0.01"
    )
    rows = (ar.WeightedLayer("100", "2"), ar.WeightedLayer("90", "2"))
    out = ar.size_basket(p, rows, limits(risk_budget="31", min_quantity="1", min_notional="0"))
    assert out.first_layer_quantity == "1"
    assert tuple(v.quantity for v in out.orders) == ("1", "1")
    assert out.costs.stress_loss == "30.04"


def test_basket_weight_scale_cannot_create_nonfinite_quantity_text():
    p = profile(
        cap="100", stress_exit="80", buy_fee="0", sell_fee="0", quantity_step="1", quote_unit="0.01"
    )
    lim = limits(risk_budget="31", min_quantity="1", min_notional="0")
    a = ar.size_basket(p, (ar.WeightedLayer("100", "1"), ar.WeightedLayer("90", "1")), lim)
    b = ar.size_basket(p, (ar.WeightedLayer("100", "3"), ar.WeightedLayer("90", "3")), lim)
    assert a.orders == b.orders
    assert a.costs == b.costs


def test_large_bounded_inputs_do_not_reject_internal_quantity_over_64_characters():
    p = profile(
        cap="0.000000000000000000000000000002",
        stress_exit="0.000000000000000000000000000001",
        buy_fee="0",
        sell_fee="0",
        quantity_step="1",
        quote_unit="0." + "0" * 49 + "1",
    )
    lim = limits(
        risk_budget="9" * 64,
        notional_cap="9" * 64,
        available_quote="9" * 64,
        min_quantity="1",
        min_notional="0",
    )
    spot = ar.size_spot(p, lim)
    basket = ar.size_basket(p, (ar.WeightedLayer(p.cap, "1"),), lim)
    assert spot.costs is not None and basket.costs is not None
    assert len(spot.costs.quantity) > 64
    assert spot.costs == basket.costs
    assert F(spot.costs.stress_loss) <= F(lim.risk_budget)
    assert F(spot.costs.reserve) <= F(lim.available_quote)


def test_lp_quote_rounding_also_respects_nominal_cap():
    out = ar.lp_budget("USDT", "1", "1", "0", "0.333", "0.333", "0", "0.01")
    assert out.maximum_principal == "0.33"
    assert out.requested_pressure == "0.34"
    assert out.exceeds_budget


def test_lp_exhausted_portfolio_keeps_negative_headroom_visible():
    out = ar.lp_budget("USDT", "10000", "0.01", "101", "0.05", "0", "2", "0.01")
    assert out.remaining == "-1" and out.maximum_principal == "0" and out.exceeds_budget


def test_atomic_floor_requires_meeting_the_rounded_minimum_output():
    out = ar.atomic_cost_floor(
        "USDC",
        "1000",
        "1006.0000001",
        "3",
        "1",
        "1",
        "1.00000005",
        "0.0005",
        "0.000001",
        fees_in_output=True,
    )
    assert out.minimum_output == "1006.000001"
    assert not out.cost_floor_met


def test_serialized_candidates_keep_simulation_scope_and_no_execution_permission():
    result = asdict(ar.size_spot(profile(), limits()))
    assert result["scope"] == "SIMULATION_MATH_ONLY"
    assert result["execution_authorized"] is False
    assert result["costs"]["execution_authorized"] is False


def test_decimal_context_input_and_result_immutability_and_no_runtime_io(monkeypatch):
    import socket

    def forbidden(*args, **kwargs):
        raise AssertionError("Pure calculator attempted external I/O")

    monkeypatch.setattr(socket, "socket", forbidden)
    monkeypatch.setattr(Path, "write_text", forbidden)
    old = getcontext().copy()
    with localcontext() as ctx:
        ctx.prec = 3
        ctx.traps[Inexact] = True
        before = ctx.copy()
        p, lim = profile(), limits()
        out = ar.size_spot(p, lim)
        assert out.costs.stress_loss == "4.99377472"
        assert ctx.prec == before.prec and ctx.flags == before.flags
        with pytest.raises((FrozenInstanceError, AttributeError, TypeError)):
            out.reason = "ALLOW"
        with pytest.raises((FrozenInstanceError, AttributeError, TypeError)):
            p.cap = "1"
    assert getcontext().prec == old.prec
