from __future__ import annotations

from stark_trading_os.domain.models import RunState


class StateConflict(Exception):
    """Raised when a requested run-state change is not declared by the lifecycle."""

    def __init__(self, *, current: RunState, requested: RunState) -> None:
        self.current = current
        self.requested = requested
        super().__init__(f"State transition is not allowed: {current} -> {requested}")
