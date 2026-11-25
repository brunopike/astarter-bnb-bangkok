"""Runner cancellation coordination without cooperative acknowledgments."""

from __future__ import annotations

import asyncio
import os
import signal
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from math import isfinite

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.control.process_identity import (
    ProcessIdentityV1,
    ProcessObserver,
    RunnerProcessRecord,
    SignalDelivery,
    persisted_process_group_is_live,
    verified_signal_process_group,
    verify_process_identity,
)
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.transactions import (
    IdempotencyCommand,
    PersistedCancelRequest,
)


@dataclass(frozen=True)
class TerminationObservation:
    identity_verified: bool
    term_delivery: SignalDelivery | None
    kill_delivery: SignalDelivery | None
    group_dead: bool

    @property
    def delivered(self) -> bool:
        return "DELIVERED" in {self.term_delivery, self.kill_delivery}


class CancellationCoordinator:
    """Persist cancel truth before sending bounded, identity-checked signals."""

    def __init__(
        self,
        *,
        control: ControlStore,
        identity_observer: ProcessObserver | None = None,
        signal_sender: Callable[[int, int], None] = os.killpg,
        group_is_live: Callable[[ProcessIdentityV1], bool] | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        term_grace_seconds: float = 2.0,
    ) -> None:
        if isinstance(term_grace_seconds, bool) or not isinstance(term_grace_seconds, (int, float)):
            raise ValueError("TERM grace must be a positive finite duration.")
        grace = float(term_grace_seconds)
        if grace <= 0 or not isfinite(grace):
            raise ValueError("TERM grace must be a positive finite duration.")
        self._control = control
        self._identity_observer = identity_observer
        self._signal_sender = signal_sender
        self._group_is_live = group_is_live
        self._sleep = sleep
        self._term_grace_seconds = grace

    def request(
        self,
        *,
        run_id: str,
        idempotency_key: str,
        reason: str,
    ) -> PersistedCancelRequest:
        request_bytes = canonical_json_bytes({"reason": reason})
        command = IdempotencyCommand.cancel(
            run_id=run_id,
            key=idempotency_key,
            canonical_request_bytes=request_bytes,
        )
        return self._control.request_runner_cancel(command=command, reason=reason)

    async def terminate(self, decision: PersistedCancelRequest) -> TerminationObservation:
        if type(decision) is not PersistedCancelRequest:
            raise TypeError("Cancellation termination requires an exact persisted decision.")
        if not decision.created_by_caller or not decision.signal_required:
            return TerminationObservation(False, None, None, False)
        process = self._control.runner_process(decision.response.run_id or "")
        if process is None or process.identity is None:
            return TerminationObservation(False, None, None, False)
        if not self._control.mark_runner_term_sent(
            run_id=process.run_id,
            spawn_nonce=process.spawn_nonce,
        ):
            return TerminationObservation(False, None, None, False)
        term_delivery = verified_signal_process_group(
            process.identity,
            signal.SIGTERM,
            observer=self._identity_observer,
            sender=self._signal_sender,
        )
        if term_delivery == "IDENTITY_MISMATCH":
            return TerminationObservation(False, term_delivery, None, False)
        await self._sleep(self._term_grace_seconds)
        if not self._live(process):
            return TerminationObservation(True, term_delivery, None, True)
        if not self._control.mark_runner_kill_sent(
            run_id=process.run_id,
            spawn_nonce=process.spawn_nonce,
        ):
            return TerminationObservation(True, term_delivery, None, False)
        kill_delivery = verified_signal_process_group(
            process.identity,
            signal.SIGKILL,
            observer=self._identity_observer,
            sender=self._signal_sender,
        )
        await self._sleep(self._term_grace_seconds)
        return TerminationObservation(
            kill_delivery != "IDENTITY_MISMATCH",
            term_delivery,
            kill_delivery,
            not self._live(process),
        )

    async def recover(self, process: RunnerProcessRecord) -> TerminationObservation:
        """Bound a lost-pipe child without replaying an already persisted TERM."""
        if type(process) is not RunnerProcessRecord or process.identity is None:
            return TerminationObservation(False, None, None, False)
        identity = process.identity
        if not verify_process_identity(identity, observer=self._identity_observer):
            return TerminationObservation(False, None, None, False)
        term_delivery: SignalDelivery | None = None
        kill_delivery: SignalDelivery | None = None
        if process.cancel_phase in {"NONE", "REQUESTED"}:
            if not self._control.mark_recovery_term_sent(
                run_id=process.run_id,
                spawn_nonce=process.spawn_nonce,
            ):
                return TerminationObservation(True, None, None, not self._live(process))
            term_delivery = verified_signal_process_group(
                identity,
                signal.SIGTERM,
                observer=self._identity_observer,
                sender=self._signal_sender,
            )
            if term_delivery == "IDENTITY_MISMATCH":
                return TerminationObservation(False, term_delivery, None, False)
            await self._sleep(self._term_grace_seconds)
        elif process.cancel_phase == "TERM_SENT":
            await self._sleep(self._term_grace_seconds)
        elif process.cancel_phase == "KILL_SENT":
            if not self._live(process):
                return TerminationObservation(True, None, None, True)
            kill_delivery = verified_signal_process_group(
                identity,
                signal.SIGKILL,
                observer=self._identity_observer,
                sender=self._signal_sender,
            )
            if kill_delivery == "IDENTITY_MISMATCH":
                return TerminationObservation(False, None, kill_delivery, False)
            await self._sleep(self._term_grace_seconds)
            return TerminationObservation(
                True,
                None,
                kill_delivery,
                not self._live(process),
            )
        if not self._live(process):
            return TerminationObservation(True, term_delivery, None, True)
        if not self._control.mark_recovery_kill_sent(
            run_id=process.run_id,
            spawn_nonce=process.spawn_nonce,
        ):
            return TerminationObservation(True, term_delivery, None, False)
        kill_delivery = verified_signal_process_group(
            identity,
            signal.SIGKILL,
            observer=self._identity_observer,
            sender=self._signal_sender,
        )
        if kill_delivery == "IDENTITY_MISMATCH":
            return TerminationObservation(False, term_delivery, kill_delivery, False)
        await self._sleep(self._term_grace_seconds)
        return TerminationObservation(
            True,
            term_delivery,
            kill_delivery,
            not self._live(process),
        )

    async def recover_owned_group_after_leader_exit(
        self,
        process: RunnerProcessRecord,
    ) -> TerminationObservation:
        """Report group liveness without treating an exited leader as signal authority."""
        if type(process) is not RunnerProcessRecord or process.identity is None:
            return TerminationObservation(False, None, None, False)
        if not self._live(process):
            return TerminationObservation(False, None, None, True)
        return TerminationObservation(False, None, None, False)

    def _live(self, process: RunnerProcessRecord) -> bool:
        assert process.identity is not None
        if self._group_is_live is not None:
            return self._group_is_live(process.identity)
        return persisted_process_group_is_live(process.identity)
