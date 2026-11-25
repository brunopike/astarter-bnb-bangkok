from __future__ import annotations

from collections.abc import MutableMapping
from typing import cast

import pytest

from stark_trading_os.domain.errors import StateConflict
from stark_trading_os.domain.models import TERMINAL_STATES, RunState
from stark_trading_os.domain.state_machine import ALLOWED_TRANSITIONS, transition

EXPECTED_ALLOWED_TRANSITIONS = {
    RunState.DRAFT: {RunState.PREFLIGHT_BLOCKED, RunState.PREFLIGHT_READY},
    RunState.PREFLIGHT_BLOCKED: {RunState.PREFLIGHT_READY},
    RunState.PREFLIGHT_READY: {RunState.QUEUED},
    RunState.QUEUED: {RunState.RUNNING, RunState.CANCEL_REQUESTED, RunState.FINALIZING},
    RunState.RUNNING: {RunState.CANCEL_REQUESTED, RunState.FINALIZING},
    RunState.CANCEL_REQUESTED: {RunState.CANCEL_PENDING, RunState.FINALIZING},
    RunState.CANCEL_PENDING: {RunState.FINALIZING},
    RunState.FINALIZING: {RunState.COMPLETED, RunState.FAILED, RunState.CANCELLED},
    RunState.COMPLETED: set(),
    RunState.FAILED: set(),
    RunState.CANCELLED: set(),
}


def test_allowed_transitions_match_the_backtest_lifecycle() -> None:
    assert ALLOWED_TRANSITIONS == EXPECTED_ALLOWED_TRANSITIONS
    assert sum(len(targets) for targets in ALLOWED_TRANSITIONS.values()) == 15
    assert sum(
        target not in targets
        for current, targets in ALLOWED_TRANSITIONS.items()
        for target in RunState
    ) == 106


def test_transition_table_is_runtime_immutable() -> None:
    table = cast(MutableMapping[RunState, frozenset[RunState]], ALLOWED_TRANSITIONS)

    with pytest.raises(TypeError):
        table[RunState.DRAFT] = frozenset({RunState.COMPLETED})
    with pytest.raises(AttributeError):
        ALLOWED_TRANSITIONS[RunState.DRAFT].add(RunState.COMPLETED)
    with pytest.raises(AttributeError):
        ALLOWED_TRANSITIONS[RunState.DRAFT].remove(RunState.PREFLIGHT_READY)

    assert transition(RunState.DRAFT, RunState.PREFLIGHT_READY) is RunState.PREFLIGHT_READY
    with pytest.raises(StateConflict):
        transition(RunState.DRAFT, RunState.COMPLETED)


@pytest.mark.parametrize(
    ("current", "target"),
    [
        (current, target)
        for current, targets in EXPECTED_ALLOWED_TRANSITIONS.items()
        for target in targets
    ],
)
def test_transition_accepts_each_specified_lifecycle_edge(
    current: RunState, target: RunState
) -> None:
    assert transition(current, target) is target


@pytest.mark.parametrize(
    ("current", "target"),
    [
        (current, target)
        for current in RunState
        for target in RunState
        if target not in EXPECTED_ALLOWED_TRANSITIONS[current]
    ],
)
def test_transition_rejects_every_undeclared_lifecycle_edge(
    current: RunState, target: RunState
) -> None:
    with pytest.raises(StateConflict) as exc_info:
        transition(current, target)

    assert exc_info.value.current is current
    assert exc_info.value.requested is target


@pytest.mark.parametrize("state", sorted(TERMINAL_STATES, key=str))
def test_terminal_states_are_immutable(state: RunState) -> None:
    for target in RunState:
        with pytest.raises(StateConflict):
            transition(state, target)
