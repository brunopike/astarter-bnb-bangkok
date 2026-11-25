"""R2 native: one request's reservation, actual charge and release, as separate numbers."""

from tests.unit.control.postgres import test_private_research_mutations as mutations
from tests.unit.control.postgres.test_private_research_migration import native
from tests.unit.control.postgres.test_private_research_mutations import db as db
from tests.unit.control.postgres.test_private_research_mutations import pg as pg

SETTLE = "SELECT astarter_private.settle_cost(%s,%s,%s,%s,%s,%s) AS settled"
REQUEST = "request-001"
HELD_ONLY = {
    "budget_microusd": {"held": 20890, "spent": 0, "released": 0},
    "policy_microusd": {"held": 20890, "spent": 0, "released": 0},
    "policy_tokens": {"held": 13056, "spent": 0, "released": 0},
}


def books(db):
    """The owner's read of the global budget, the first wallet's policy and its request."""
    owner, who = db[1], db[3][0]["subject"]
    return dict(
        budget=owner.execute(
            "SELECT held_microusd,spent_microusd,blocked FROM astarter_private.global_budget"
        ).fetchone(),
        policy=owner.execute(
            "SELECT held_microusd,spent_microusd,held_tokens,spent_tokens,request_count,"
            "blocked FROM astarter_private.policies WHERE tenant_id=%s",
            (who,),
        ).fetchone(),
        request=owner.execute(
            "SELECT state,reserved_microusd,reserved_tokens,settled_microusd,settled_tokens "
            "FROM astarter_private.requests WHERE tenant_id=%s AND request_id=%s",
            (who, REQUEST),
        ).fetchone(),
        costs=owner.execute(
            "SELECT request_id,amount_microusd,actual_tokens FROM astarter_private.cost_events"
        ).fetchall(),
    )


def split(snapshot):
    """Held, spent and released of the request's reservation, per ledger, as three numbers.

    The schema keeps no released column. With this one request in a new database, the part
    of its reservation that is neither held nor charged has gone back to the budget.
    """
    request, budget, policy = snapshot["request"], snapshot["budget"], snapshot["policy"]

    def three(reserved, held, spent):
        return {"held": held, "spent": spent, "released": reserved - held - spent}

    return {
        "budget_microusd": three(
            request["reserved_microusd"], budget["held_microusd"], budget["spent_microusd"]
        ),
        "policy_microusd": three(
            request["reserved_microusd"], policy["held_microusd"], policy["spent_microusd"]
        ),
        "policy_tokens": three(
            request["reserved_tokens"], policy["held_tokens"], policy["spent_tokens"]
        ),
    }


@native
def test_reservation_actual_charge_and_release_are_separate_numbers(db):
    who = db[3][0]["subject"]
    start = books(db)
    assert start["budget"] == dict(held_microusd=0, spent_microusd=0, blocked=False)
    assert start["policy"] == dict(
        held_microusd=0,
        spent_microusd=0,
        held_tokens=0,
        spent_tokens=0,
        request_count=0,
        blocked=False,
    )
    assert start["request"] is None and start["costs"] == []

    # 1. Reservation: the claim holds the fixed reserve and charges nothing.
    assert mutations.claim(db) == {"acquired": True}
    held = books(db)
    assert held["request"] == dict(
        state="pending",
        reserved_microusd=20890,
        reserved_tokens=13056,
        settled_microusd=None,
        settled_tokens=None,
    )
    assert split(held) == HELD_ONLY
    assert held["policy"]["request_count"] == 1 and held["costs"] == []

    # 2. Finish with the provider's receipt (cost 18000): stored with the result, not charged.
    result = mutations.model_result()
    result["billing"] = {
        "provider": "openrouter",
        "responseId": result["responseId"],
        "model": result["model"],
        "costMicrousd": 18000,
        "isByok": False,
    }
    record = mutations.finish(db, mutations.finish_args(db, result=result))
    assert record["state"] == "complete" and record["settledTokens"] == 150
    assert record["result"]["billing"]["costMicrousd"] == 18000
    finished = books(db)
    assert finished["request"] == dict(
        state="complete",
        reserved_microusd=20890,
        reserved_tokens=13056,
        settled_microusd=None,
        settled_tokens=150,
    )
    assert split(finished) == HELD_ONLY
    assert finished["policy"]["request_count"] == 1 and finished["costs"] == []

    # 3. Actual charge: the cost role settles 18000 for 150 tokens, below the hold.
    with mutations.app(db, "cost") as cost:
        assert cost.execute(
            SETTLE, ("synthetic-receipt-r2-split", who, who, REQUEST, 18000, 150)
        ).fetchone() == {"settled": True}
    settled = books(db)
    assert settled["request"] == dict(
        state="complete",
        reserved_microusd=20890,
        reserved_tokens=13056,
        settled_microusd=18000,
        settled_tokens=150,
    )
    assert split(settled) == {
        "budget_microusd": {"held": 0, "spent": 18000, "released": 2890},
        "policy_microusd": {"held": 0, "spent": 18000, "released": 2890},
        "policy_tokens": {"held": 0, "spent": 150, "released": 12906},
    }
    assert settled["costs"] == [
        dict(request_id=REQUEST, amount_microusd=18000, actual_tokens=150)
    ]
    # The charge and the release add up to the hold: the request row against each ledger.
    request = settled["request"]
    for ledger in ("budget_microusd", "policy_microusd"):
        released = split(settled)[ledger]["released"]
        assert request["settled_microusd"] + released == request["reserved_microusd"]
    released_tokens = split(settled)["policy_tokens"]["released"]
    assert settled["costs"][0]["actual_tokens"] + released_tokens == request["reserved_tokens"]
    # A charge below the hold blocks nothing; the month's request count stays used.
    assert settled["budget"]["blocked"] is False and settled["policy"]["blocked"] is False
    assert settled["policy"]["request_count"] == 1


@native
def test_failure_before_the_model_call_keeps_its_hold_today(db):
    # Today's behaviour, pinned on purpose; it is not a chosen rule. Which release rule is
    # meant for a request that fails before the model call is an open question. Today a
    # failed finish neither charges nor releases: the hold stays held (in this SQL only
    # settle_cost takes a hold off), and the month's request count is not given back. If
    # another rule is chosen, this test is expected to change with it.
    assert mutations.claim(db) == {"acquired": True}
    # Before the model call there are no tokens and no result: a failed finish, tokens 0.
    record = mutations.finish(
        db, mutations.finish_args(db, state="failed", tokens=0, error="EVIDENCE_UNAVAILABLE")
    )
    assert record["state"] == "failed" and record["error"] == "EVIDENCE_UNAVAILABLE"
    assert record["settledTokens"] == 0 and record["result"] is None
    failed = books(db)
    assert failed["request"] == dict(
        state="failed",
        reserved_microusd=20890,
        reserved_tokens=13056,
        settled_microusd=None,
        settled_tokens=0,
    )
    assert split(failed) == HELD_ONLY
    assert failed["policy"]["request_count"] == 1 and failed["costs"] == []
    assert failed["budget"]["blocked"] is False and failed["policy"]["blocked"] is False
    # A retry with a new claim token answers the original failed record and holds nothing new.
    assert mutations.claim(db, mutations.args(db, claim="d" * 64)) == {
        "acquired": False,
        "record": record,
    }
    assert books(db) == failed
