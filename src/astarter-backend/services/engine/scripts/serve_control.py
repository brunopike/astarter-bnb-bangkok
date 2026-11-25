"""Acceptance-only Control factory with an explicit synthetic SSE retention floor."""

from __future__ import annotations

import json
import os
from dataclasses import replace
from pathlib import Path

from fastapi import FastAPI

from stark_trading_os.control.app import create_app
from stark_trading_os.control.dependencies import ControlDependencies, build_default_dependencies
from stark_trading_os.control.preflight import RunReservation


class _FixedRetentionFloor:
    def __init__(self, minimum_seq: int) -> None:
        self._minimum_seq = minimum_seq

    def minimum_available_seq(self, _run_id: str) -> int:
        return self._minimum_seq


def _acceptance_dependencies(
    repository_root: Path,
    minimum_seq: int,
    held_replay_seed: int | None,
) -> ControlDependencies:
    dependencies = build_default_dependencies(repository_root)
    configured = replace(
        dependencies,
        event_retention_floor=_FixedRetentionFloor(minimum_seq),
    )
    if held_replay_seed is not None:
        original_schedule = configured.scheduler.schedule_run

        def schedule_unless_held(reservation: RunReservation) -> None:
            manifest = json.loads(reservation.input_manifest_bytes)
            if type(manifest) is dict and manifest.get("replay_seed") == held_replay_seed:
                return
            original_schedule(reservation)

        setattr(configured.scheduler, "schedule_run", schedule_unless_held)
    return configured


def _optional_nonnegative_integer(name: str) -> int | None:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return None
    if not raw_value.isascii() or not raw_value.isdecimal():
        raise RuntimeError(f"{name} must be a nonnegative decimal integer")
    return int(raw_value)


def create_acceptance_app() -> FastAPI:
    raw_floor = os.environ.get("STARK_ACCEPTANCE_SSE_FLOOR")
    if raw_floor is None or not raw_floor.isascii() or not raw_floor.isdecimal():
        raise RuntimeError("acceptance SSE floor is required")
    minimum_seq = int(raw_floor)
    if minimum_seq < 1:
        raise RuntimeError("acceptance SSE floor must be positive")
    repository_root = Path(__file__).resolve().parents[3]
    held_replay_seed = _optional_nonnegative_integer("STARK_ACCEPTANCE_HOLD_REPLAY_SEED")
    return create_app(
        dependency_factory=lambda: _acceptance_dependencies(
            repository_root,
            minimum_seq,
            held_replay_seed,
        )
    )
