"""Historical observer codecs reject invented clean cancellation and wire coercion."""

import warnings
from hashlib import sha256

import pytest

from stark_trading_os.catalog.historical_catalog import canonical_historical_bytes
from stark_trading_os.control.historical_process import (
    SupervisorExitV2,
    historical_exit_bytes,
    historical_exit_from_bytes,
)
from stark_trading_os.control.process_identity import supervisor_exit_from_bytes
from stark_trading_os.runner.historical_protocol import HistoricalRunnerIdentityV2


def clean():
    return SupervisorExitV2(
        identity=HistoricalRunnerIdentityV2(
            run_id="bt_" + "1" * 32,
            input_manifest_sha256="2" * 64,
            catalog_revision="3" * 64,
            cost_sha256="4" * 64,
            engine_package_version="2.0.0rc3",
            account_id="SIM-001",
        ),
        run_id="bt_" + "1" * 32,
        spawn_nonce=None,
        process_identity_sha256=None,
        launched_at_ns=None,
        ended_at_ns=1700000500000000000,
        duration_ns=0,
        exit_code=None,
        signal=None,
        final_cancel_phase="NONE",
        stdout_size_bytes=0,
        stderr_size_bytes=0,
        stderr_sha256=sha256(b"").hexdigest(),
        stderr_truncated=False,
        child_outcome=None,
        classification="NO_SPAWN_CANCELLED",
        failure_code=None,
        proposed_terminal_state="CANCELLED",
    )


def test_explicit_observer_codec_round_trip_cannot_enter_v1():
    outcome = clean()
    raw = historical_exit_bytes(outcome)
    assert historical_exit_from_bytes(raw) == outcome
    with pytest.raises(ValueError):
        supervisor_exit_from_bytes(raw)
    with pytest.raises(ValueError):
        historical_exit_from_bytes(raw.replace(b'"schema":', b'"schema_":'))
    with pytest.raises(ValueError):
        historical_exit_from_bytes(raw + b"\n")


@pytest.mark.parametrize(
    "change",
    [
        {"final_cancel_phase": "TERM_SENT"},
        {"stdout_size_bytes": 1},
        {"stderr_size_bytes": 1},
        {"stderr_sha256": "f" * 64},
        {"stderr_truncated": True},
        {"run_id": "bt_" + "9" * 32},
        {"exit_code": 0},
        {"classification": "NATURAL_SUCCESS", "proposed_terminal_state": "COMPLETED"},
    ],
)
def test_no_spawn_observer_cannot_claim_execution_or_foreign_evidence(change):
    forged = clean().model_copy(update=change)
    with pytest.raises(ValueError, match="HISTORICAL_OBSERVER_INVALID"):
        historical_exit_bytes(forged)
    with pytest.raises(ValueError, match="HISTORICAL_OBSERVER_INVALID"):
        historical_exit_from_bytes(canonical_historical_bytes(forged))


def test_invalid_observer_projection_does_not_warn_with_untrusted_values():
    forged = clean().model_copy(update={"duration_ns": "private-test-marker"})
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        with pytest.raises(ValueError, match="^HISTORICAL_OBSERVER_INVALID$"):
            historical_exit_bytes(forged)
    assert caught == []
