from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType

from stark_trading_os.domain.errors import StateConflict
from stark_trading_os.domain.models import RunState

ALLOWED_TRANSITIONS: Mapping[RunState, frozenset[RunState]] = MappingProxyType(
    {
        RunState.DRAFT: frozenset({RunState.PREFLIGHT_BLOCKED, RunState.PREFLIGHT_READY}),
        RunState.PREFLIGHT_BLOCKED: frozenset({RunState.PREFLIGHT_READY}),
        RunState.PREFLIGHT_READY: frozenset({RunState.QUEUED}),
        RunState.QUEUED: frozenset(
            {RunState.RUNNING, RunState.CANCEL_REQUESTED, RunState.FINALIZING}
        ),
        RunState.RUNNING: frozenset({RunState.CANCEL_REQUESTED, RunState.FINALIZING}),
        RunState.CANCEL_REQUESTED: frozenset({RunState.CANCEL_PENDING, RunState.FINALIZING}),
        RunState.CANCEL_PENDING: frozenset({RunState.FINALIZING}),
        RunState.FINALIZING: frozenset(
            {RunState.COMPLETED, RunState.FAILED, RunState.CANCELLED}
        ),
        RunState.COMPLETED: frozenset(),
        RunState.FAILED: frozenset(),
        RunState.CANCELLED: frozenset(),
    }
)


def transition(current: RunState, target: RunState) -> RunState:
    if target not in ALLOWED_TRANSITIONS[current]:
        raise StateConflict(current=current, requested=target)
    return target
