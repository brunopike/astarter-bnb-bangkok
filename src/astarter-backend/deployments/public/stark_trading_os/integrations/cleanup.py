"""One owned cleanup action, one bounded attempt, and a retained safe outcome."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True, slots=True)
class CloseResult:
    state: Literal["CLOSED", "FAILED", "TIMED_OUT"]

    @property
    def release_confirmed(self) -> bool:
        return self.state == "CLOSED"


async def join_owned[T](task: asyncio.Task[T]) -> T:
    """Defer waiter cancellation until the owned action has a terminal result.

    Repeated cancellation never cancels or detaches the owned task. The waiter
    still observes cancellation after joining. This cannot preempt Python code
    which blocks the loop or deliberately suppresses cancellation indefinitely.
    """
    cancellation: asyncio.CancelledError | None = None
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError as exc:
            if cancellation is None:
                cancellation = exc
    result = task.result()
    if cancellation is not None:
        raise cancellation
    return result


class OwnedClose:
    def __init__(
        self,
        operation: Callable[[], Awaitable[None]],
        deadline: Callable[[], float],
        completed: Callable[[OwnedClose, CloseResult], None],
    ) -> None:
        self._operation = operation
        self._deadline = deadline
        self._completed = completed
        self._task: asyncio.Task[CloseResult] | None = None

    async def wait(self) -> CloseResult:
        if self._task is None:
            # No await between testing/assigning: concurrent callers share one task.
            deadline = self._deadline()
            self._task = asyncio.create_task(self._run(deadline))
        return await join_owned(self._task)

    async def _run(self, deadline: float) -> CloseResult:
        loop = asyncio.get_running_loop()
        result = CloseResult("TIMED_OUT")
        try:
            if loop.time() < deadline:
                async with asyncio.timeout_at(deadline):
                    await self._operation()
                result = CloseResult("CLOSED" if loop.time() < deadline else "TIMED_OUT")
        except TimeoutError:
            result = CloseResult("TIMED_OUT")
        except (Exception, asyncio.CancelledError):
            result = CloseResult("FAILED")
        # Never retain an upstream exception/message/cause in the result or task.
        self._completed(self, result)
        return result
