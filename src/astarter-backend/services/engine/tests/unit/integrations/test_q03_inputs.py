from dataclasses import replace
from decimal import localcontext
from importlib import import_module, util
from pathlib import Path

import pytest

from stark_trading_os.domain.astarter_risk import size_spot, spot_costs

FIXTURES = Path(__file__).parents[2] / "fixtures" / "data-model-ports-t2"
T0 = 1_700_000_000_000_000_000


def api():
    name = "stark_trading_os.integrations.q03_inputs"
    assert util.find_spec(name), "T2 Q03 consumer boundary is missing"
    return import_module(name)


def inputs(data=None):
    m = api()
    from stark_trading_os.integrations.binance_metadata import parse_metadata
    from stark_trading_os.integrations.instrument_metadata import InstrumentQuery

    query = InstrumentQuery(
        venue="BINANCE", market="SPOT", symbol="BTCUSDT", expected_base="BTC", expected_quote="USDT"
    )
    metadata = parse_metadata(
        data or (FIXTURES / "btcusdt-exchange-info.v1.json").read_bytes(),
        query=query,
        received_at_ns=T0,
        available_at_ns=T0 + 1,
        receipt_id="receipt-1",
        source_policy_id="offline-test",
        source_policy_revision="v1",
    )
    plan = m.SimulationPlan(
        plan_id="plan-1",
        revision="v1",
        instrument=query,
        cap="65000",
        stress_exit="63000",
        valid_from_ns=T0,
        valid_until_ns=T0 + 10_000_000_000,
        signal_id="signal-1",
        parameters_sha256="c" * 64,
        bar_source_revision="bars-v1",
        signal_expires_at_ns=T0 + 5_000_000_000,
    )
    fees = m.SimulationAssumptionsV1.model_validate_json(
        (FIXTURES / "simulation-assumptions.v1.json").read_bytes()
    )
    account = m.AccountView(
        account_id="account-1",
        snapshot_id="snapshot-1",
        risk_epoch=1,
        base="BTC",
        quote="USDT",
        risk_budget="20",
        notional_cap="1000",
        available_quote="2000",
        available_at_ns=T0,
        valid_until_ns=T0 + 10_000_000_000,
    )
    context = m.SimulationContext(
        decision_time_ns=T0 + 2_000_000_000,
        expected_binding=m.bind_inputs(metadata, plan, fees, account),
        source_policy=m.SourcePolicyRef(policy_id="offline-test", revision="v1"),
    )
    return m, metadata, plan, fees, account, context


def prepare(values):
    m, metadata, plan, fees, account, context = values
    return m.prepare_q03_inputs(metadata, plan, fees, account, context)


def rebind(values):
    m, metadata, plan, fees, account, context = values
    return (
        *values[:-1],
        context.model_copy(
            update={"expected_binding": m.bind_inputs(metadata, plan, fees, account)}
        ),
    )


def test_real_q03_path_keeps_units_scope_and_absolute_signal_expiry():
    values = inputs()
    m, _, _, _, _, context = values
    result = prepare(values)
    assert result.status == "PREPARED"
    p = result.prepared
    assert p.profile.quantity_step == "0.00001"
    assert p.profile.quote_unit == "0.000001"
    assert p.valid_until_ns == T0 + 5_000_000_000
    costs = spot_costs(p.profile, "0.001")
    assert (
        costs.fill_bound,
        costs.buy_fee_max,
        costs.sell_fee_max,
        costs.reserve,
        costs.stress_loss,
    ) == (100, "0.0651", "0.0631", "65.0651", "2.1282")
    candidate = size_spot(p.profile, p.limits)
    checked = m.check_q03_candidate(p, candidate, context)
    assert checked.status == "CANDIDATE"
    assert checked.execution_authorized is False
    assert checked.venue_admissibility == "UNVERIFIED"
    assert "NATIVE_EXECUTION" in checked.unchecked_constraints


@pytest.mark.parametrize("change", ["account", "epoch", "plan", "fees", "receipt", "policy"])
def test_bound_versions_cannot_be_replaced_without_current_context(change):
    m, metadata, plan, fees, account, context = inputs()
    if change == "account":
        account = account.model_copy(update={"account_id": "account-2"})
    if change == "epoch":
        account = account.model_copy(update={"risk_epoch": 2})
    if change == "plan":
        plan = plan.model_copy(update={"cap": "65001"})
    if change == "fees":
        fees = fees.model_copy(update={"buy_fee": "0"})
    if change == "receipt":
        metadata = metadata.model_copy(
            update={"receipt": metadata.receipt.model_copy(update={"receipt_id": "receipt-2"})}
        )
    if change == "policy":
        context = context.model_copy(update={"source_policy": None})
    result = m.prepare_q03_inputs(metadata, plan, fees, account, context)
    assert result.status == "REJECTED" and result.prepared is None


@pytest.mark.parametrize("now", [T0 - 1, T0 + 5_000_000_000, T0 + 300_000_000_000, True, 2**64])
def test_expired_future_or_invalid_time_never_prepares(now):
    values = inputs()
    result = prepare((*values[:-1], values[-1].model_copy(update={"decision_time_ns": now})))
    assert result.status == "REJECTED"


def test_new_receipt_cannot_renew_old_signal():
    m, metadata, plan, fees, account, context = inputs()
    r = metadata.receipt.model_copy(
        update={
            "receipt_id": "receipt-2",
            "received_at_ns": T0 + 4_000_000_000,
            "available_at_ns": T0 + 4_000_000_001,
            "expires_at_ns": T0 + 304_000_000_000,
        }
    )
    metadata = metadata.model_copy(update={"receipt": r, "evaluated_at_ns": r.available_at_ns})
    context = context.model_copy(update={"decision_time_ns": T0 + 5_000_000_000})
    result = prepare(rebind((m, metadata, plan, fees, account, context)))
    assert result.status == "REJECTED" and result.reason == "INPUT_EXPIRED"


@pytest.mark.parametrize(
    "updates",
    [
        {"buy_fee": "1.01"},
        {"quote_unit": "0"},
        {"fee_currency": "BNB"},
        {"fill_bound_policy": "ORDER_STEP_IMPLIES_FILL_STEP"},
        {"buy_fee": 0.001},
    ],
)
def test_invalid_fee_model_is_not_accepted_even_through_construct_bypass(updates):
    m, metadata, plan, fees, account, context = inputs()
    fees = fees.model_copy(update=updates)
    assert m.prepare_q03_inputs(metadata, plan, fees, account, context).status == "REJECTED"


def test_explicit_zero_fee_keeps_q03_rounding_buffer():
    m, metadata, plan, fees, account, context = inputs()
    fees = fees.model_copy(update={"buy_fee": "0", "sell_fee": "0"})
    p = prepare(rebind((m, metadata, plan, fees, account, context))).prepared
    assert spot_costs(p.profile, "0.001").buy_fee_max == "0.0001"


def test_check_rejects_modified_candidate_and_modified_prepared_profile():
    m, *_ = values = inputs()
    p = prepare(values).prepared
    candidate = size_spot(p.profile, p.limits)
    changed = replace(candidate, costs=replace(candidate.costs, quantity="1"))
    assert m.check_q03_candidate(p, changed, values[-1]).status == "REJECTED"
    changed_p = replace(p, profile=replace(p.profile, buy_fee="0"))
    assert m.check_q03_candidate(changed_p, candidate, values[-1]).status == "REJECTED"
    assert (
        m.check_q03_candidate(
            p, candidate, values[-1].model_copy(update={"decision_time_ns": T0 + 5_000_000_000})
        ).status
        == "REJECTED"
    )


@pytest.mark.parametrize("rule", ["maxQty", "maxNotional"])
def test_q03_candidate_is_checked_against_limits_q03_does_not_model(rule):
    import json

    data = json.loads((FIXTURES / "btcusdt-exchange-info.v1.json").read_text())
    target = 1 if rule == "maxQty" else 2
    data["symbols"][0]["filters"][target][rule] = "0.001" if rule == "maxQty" else "6"
    values = inputs(json.dumps(data).encode())
    m = values[0]
    p = prepare(values).prepared
    assert p is not None
    result = m.check_q03_candidate(p, size_spot(p.profile, p.limits), values[-1])
    assert result.status == "REJECTED" and result.reason == "STATIC_LIMIT_FAILED"


@pytest.mark.parametrize("kind", ["FUTURE_RULE", "PERCENT_PRICE", "MISSING", "HALT", "NO_SPOT"])
def test_unsupported_or_unmodeled_rules_do_not_silently_pass(kind):
    import json

    data = json.loads((FIXTURES / "btcusdt-exchange-info.v1.json").read_text())
    symbol = data["symbols"][0]
    if kind == "FUTURE_RULE":
        symbol["filters"].append({"filterType": kind, "value": "1"})
    if kind == "PERCENT_PRICE":
        symbol["filters"].append(
            {"filterType": kind, "multiplierUp": "1.2", "multiplierDown": "0.8", "avgPriceMins": 5}
        )
    if kind == "MISSING":
        symbol["filters"].pop(0)
    if kind == "HALT":
        symbol["status"] = "HALT"
    if kind == "NO_SPOT":
        symbol["isSpotTradingAllowed"] = False
    assert prepare(inputs(json.dumps(data).encode())).status == "REJECTED"


def test_explicit_known_dynamic_exclusion_is_reported_not_passed():
    import json

    data = json.loads((FIXTURES / "btcusdt-exchange-info.v1.json").read_text())
    data["symbols"][0]["filters"].append(
        {
            "filterType": "PERCENT_PRICE",
            "multiplierUp": "1.2",
            "multiplierDown": "0.8",
            "avgPriceMins": 5,
        }
    )
    m, metadata, plan, fees, account, context = inputs(json.dumps(data).encode())
    fees = fees.model_copy(update={"unmodeled_constraints": ("PERCENT_PRICE",)})
    values = rebind((m, metadata, plan, fees, account, context))
    p = prepare(values).prepared
    result = m.check_q03_candidate(p, size_spot(p.profile, p.limits), values[-1])
    assert result.status == "CANDIDATE" and "PERCENT_PRICE" in result.unchecked_constraints
    assert result.venue_admissibility == "UNVERIFIED"


def test_price_grid_is_not_inferred_from_decimal_places():
    import json

    data = json.loads((FIXTURES / "btcusdt-exchange-info.v1.json").read_text())
    data["symbols"][0]["filters"][0]["tickSize"] = "0.05"
    m, metadata, plan, fees, account, context = inputs(json.dumps(data).encode())
    plan = plan.model_copy(update={"cap": "65000.01"})
    assert (
        prepare(rebind((m, metadata, plan, fees, account, context))).reason == "PRICE_GRID_INVALID"
    )


def test_ambient_decimal_context_does_not_change_candidate():
    values = inputs()
    with localcontext() as ctx:
        ctx.prec = 2
        p = prepare(values).prepared
        c = size_spot(p.profile, p.limits)
        result = values[0].check_q03_candidate(p, c, values[-1])
    assert result.status == "CANDIDATE"


def test_no_risk_budget_is_no_candidate_not_invalid_input():
    m, metadata, plan, fees, account, context = inputs()
    account = account.model_copy(update={"risk_budget": "0"})
    values = rebind((m, metadata, plan, fees, account, context))
    p = prepare(values).prepared
    result = m.check_q03_candidate(p, size_spot(p.profile, p.limits), values[-1])
    assert result.status == "NO_CANDIDATE" and result.candidate is None


def test_failure_result_cannot_carry_prepared_payload():
    values = inputs()
    with pytest.raises(ValueError):
        values[0].PrepareResult(
            status="REJECTED", reason="INVALID_INPUT", prepared=prepare(values).prepared
        )


def test_success_result_cannot_claim_a_candidate_without_costs():
    from stark_trading_os.domain.astarter_risk import SizeCandidate

    m = api()
    with pytest.raises(ValueError):
        m.CandidateCheck(
            status="CANDIDATE", candidate=SizeCandidate("NO_RISK_BUDGET", None, "0", 0, 0)
        )


@pytest.mark.parametrize(
    "tick,min_price,max_price,cap,want",
    [
        ("0.05", "0", "0", "65000.05", "PREPARED"),
        ("0.05", "0", "65000.05", "65000.1", "REJECTED"),
        ("0", "0", "0", "65000", "REJECTED"),
    ],
)
def test_disabled_price_bounds_and_non_decimal_power_grid(tick, min_price, max_price, cap, want):
    import json

    data = json.loads((FIXTURES / "btcusdt-exchange-info.v1.json").read_text())
    data["symbols"][0]["filters"][0].update(tickSize=tick, minPrice=min_price, maxPrice=max_price)
    m, metadata, plan, fees, account, context = inputs(json.dumps(data).encode())
    plan = plan.model_copy(update={"cap": cap})
    assert prepare(rebind((m, metadata, plan, fees, account, context))).status == want


def test_notional_lower_bound_uses_both_rules():
    import json

    data = json.loads((FIXTURES / "btcusdt-exchange-info.v1.json").read_text())
    data["symbols"][0]["filters"].append(
        {
            "filterType": "MIN_NOTIONAL",
            "minNotional": "10",
            "applyToMarket": False,
            "avgPriceMins": 5,
        }
    )
    p = prepare(inputs(json.dumps(data).encode())).prepared
    assert p.limits.min_notional == "10"


def test_equal_tick_and_quote_unit_are_not_rejected_based_on_numeric_equality():
    m, metadata, plan, fees, account, context = inputs()
    fees = fees.model_copy(update={"quote_unit": "0.1"})
    assert prepare(rebind((m, metadata, plan, fees, account, context))).status == "PREPARED"


def test_unknown_rule_cannot_be_excluded_as_known_dynamic():
    m, metadata, plan, fees, account, context = inputs()
    fees = fees.model_copy(update={"unmodeled_constraints": ("FUTURE_RULE",)})
    assert m.prepare_q03_inputs(metadata, plan, fees, account, context).status == "REJECTED"


def test_tampered_nested_numeric_lineage_fails_safe():
    m, metadata, plan, fees, account, context = inputs()
    metadata.facts.price.tick.__dict__["canonical"] = "1"
    assert m.prepare_q03_inputs(metadata, plan, fees, account, context).status == "REJECTED"


def test_review_max_quantity_wrapper_cannot_replace_the_verified_limit():
    import json
    from fractions import Fraction

    from stark_trading_os.integrations.decimal_normalization import DecimalValue

    data = json.loads((FIXTURES / "btcusdt-exchange-info.v1.json").read_text())
    data["symbols"][0]["filters"][1]["maxQty"] = "0.001"
    values = inputs(json.dumps(data).encode())
    m = values[0]
    p = prepare(values).prepared
    candidate = size_spot(p.profile, p.limits)
    assert candidate.costs.quantity == "0.00939"
    assert m.check_q03_candidate(p, candidate, values[-1]).reason == "STATIC_LIMIT_FAILED"
    calls = []

    class QuantityWrapper(DecimalValue):
        def exact(self):
            calls.append("exact")
            return Fraction(10)

        def __eq__(self, other):
            calls.append("eq")
            return True

    object.__setattr__(
        p.metadata.facts.lot, "maximum", QuantityWrapper(raw="0.001", canonical="0.001")
    )
    result = m.check_q03_candidate(p, candidate, values[-1])
    assert result.status == "REJECTED" and result.candidate is None
    assert calls == []


@pytest.mark.parametrize("target", ["price", "quantity", "expiry", "unchecked", "cap"])
def test_prepared_wrappers_are_rejected_without_comparison_or_numeric_dispatch(target):
    from fractions import Fraction

    from stark_trading_os.integrations.decimal_normalization import DecimalValue

    values = inputs()
    m = values[0]
    p = prepare(values).prepared
    candidate = size_spot(p.profile, p.limits)
    calls = []

    class DecimalWrapper(DecimalValue):
        def exact(self):
            calls.append("exact")
            return Fraction(10)

        def __eq__(self, other):
            calls.append("eq")
            return True

    class IntWrapper(int):
        def __eq__(self, other):
            calls.append("eq")
            return True

    class TupleWrapper(tuple):
        def __eq__(self, other):
            calls.append("eq")
            return True

    class StringWrapper(str):
        def __eq__(self, other):
            calls.append("eq")
            return True

    if target == "price":
        object.__setattr__(
            p.metadata.facts.price, "tick", DecimalWrapper(raw="0.10000000", canonical="0.1")
        )
    if target == "quantity":
        object.__setattr__(
            p.metadata.facts.lot, "step", DecimalWrapper(raw="0.00001000", canonical="0.00001")
        )
    if target == "expiry":
        object.__setattr__(p, "valid_until_ns", IntWrapper(p.valid_until_ns + 1))
    if target == "unchecked":
        object.__setattr__(p, "unchecked_constraints", TupleWrapper(()))
    if target == "cap":
        object.__setattr__(p.profile, "cap", StringWrapper("65001"))
    result = m.check_q03_candidate(p, candidate, values[-1])
    assert result.status == "REJECTED" and result.candidate is None
    assert calls == []


def test_candidate_nested_pair_cannot_run_custom_comparison():
    from stark_trading_os.domain.astarter_risk import Pair

    values = inputs()
    m = values[0]
    p = prepare(values).prepared
    candidate = size_spot(p.profile, p.limits)
    calls = []

    class PairWrapper(Pair):
        def __eq__(self, other):
            calls.append("eq")
            return True

    changed = replace(candidate, costs=replace(candidate.costs, pair=PairWrapper("BTC", "USDT")))
    result = m.check_q03_candidate(p, changed, values[-1])
    assert result.status == "REJECTED" and result.candidate is None
    assert calls == []


@pytest.mark.parametrize("target", ["account", "plan", "fees", "metadata"])
def test_bind_inputs_has_fixed_error_without_private_input_or_exception_chain(target):
    import traceback

    from stark_trading_os.integrations.instrument_metadata import MetadataInvalid

    m, metadata, plan, fees, account, _ = inputs()
    sentinel = "synthetic-private-amount-sentinel"
    if target == "account":
        account = account.model_copy(update={"risk_budget": sentinel})
    if target == "plan":
        plan = plan.model_copy(update={"cap": sentinel})
    if target == "fees":
        fees = fees.model_copy(update={"buy_fee": sentinel})
    if target == "metadata":
        metadata = metadata.model_copy(update={"status": sentinel})
    with pytest.raises(MetadataInvalid) as caught:
        m.bind_inputs(metadata, plan, fees, account)
    error = caught.value
    assert str(error) == "METADATA_INPUT_INVALID"
    assert sentinel not in str(error)
    assert sentinel not in repr(error)
    assert sentinel not in "".join(traceback.format_exception(error))
    assert error.__cause__ is None and error.__context__ is None


@pytest.mark.parametrize("kind", ["cancel", "interrupt", "exit"])
def test_binding_preserves_control_flow_exceptions(monkeypatch, kind):
    import asyncio

    m, metadata, plan, fees, account, _ = inputs()
    error = {"cancel": asyncio.CancelledError, "interrupt": KeyboardInterrupt, "exit": SystemExit}[
        kind
    ]()

    def stop(*args):
        raise error

    monkeypatch.setattr(m, "checked", stop)
    with pytest.raises(type(error)) as caught:
        m.bind_inputs(metadata, plan, fees, account)
    assert caught.value is error
