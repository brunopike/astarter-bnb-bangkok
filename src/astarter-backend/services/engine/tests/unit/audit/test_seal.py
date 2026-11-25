from __future__ import annotations

from hashlib import sha256

import pytest

from stark_trading_os.audit.seal import SealVerificationError, build_run_seal
from stark_trading_os.domain.models import RunState

_BASE_FILES = {
    "request.json": b"{}",
    "preflight.json": b"{}",
    "input-manifest.json": b"{}",
    "run-record.json": b"{}",
    "events.ndjson": b"events\n",
    "audit.ndjson": b"audit\n",
    "runner-exit.json": b"{}",
    "stderr.txt": b"",
}


def test_build_run_seal_emits_exact_self_excluding_canonical_bytes() -> None:
    expected = (
        b'{"audit_head_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
        b'"files":[{"relative_path":"audit.ndjson",'
        b'"sha256":"8818d016bf6ad2955510ea05054b6287e0b6732ac22a6c323fcda06476d04a72",'
        b'"size_bytes":6},{"relative_path":"events.ndjson",'
        b'"sha256":"34dd567bde26307e87e1996f33d72215e0d5673222738bfc26baa066fdfeadfd",'
        b'"size_bytes":7},{"relative_path":"input-manifest.json",'
        b'"sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",'
        b'"size_bytes":2},{"relative_path":"preflight.json",'
        b'"sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",'
        b'"size_bytes":2},{"relative_path":"request.json",'
        b'"sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",'
        b'"size_bytes":2},{"relative_path":"run-record.json",'
        b'"sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",'
        b'"size_bytes":2},{"relative_path":"runner-exit.json",'
        b'"sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",'
        b'"size_bytes":2},{"relative_path":"stderr.txt",'
        b'"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",'
        b'"size_bytes":0}],"last_audit_seq":5,"run_id":"run-1",'
        b'"schema":"RunSeal.v1","terminal_event_seq":5,"terminal_state":"CANCELLED"}'
    )

    built = build_run_seal(
        run_id="run-1",
        terminal_state=RunState.CANCELLED,
        terminal_event_seq=5,
        last_audit_seq=5,
        audit_head_hash="a" * 64,
        files=_BASE_FILES,
    )

    actual = None if built is None else built.seal_bytes
    digest = None if built is None else built.seal_digest
    assert actual == expected
    assert digest == sha256(expected).hexdigest()
    assert b"seal.json" not in expected


def test_cancelled_seal_rejects_every_report_prefix() -> None:
    files = {**_BASE_FILES, "reports/orders.json": b"{}"}

    with pytest.raises(SealVerificationError, match="inventory"):
        build_run_seal(
            run_id="run-cancelled-with-report",
            terminal_state=RunState.CANCELLED,
            terminal_event_seq=5,
            last_audit_seq=5,
            audit_head_hash="a" * 64,
            files=files,
        )


def test_run_seal_rejects_unequal_event_and_audit_boundaries() -> None:
    with pytest.raises(SealVerificationError, match="boundaries"):
        build_run_seal(
            run_id="run-boundary-mismatch",
            terminal_state=RunState.FAILED,
            terminal_event_seq=9,
            last_audit_seq=8,
            audit_head_hash="a" * 64,
            files=_BASE_FILES,
        )


def test_completed_seal_requires_all_five_reports() -> None:
    four_reports = {
        **_BASE_FILES,
        **{f"reports/{name}.json": b"{}" for name in ("orders", "fills", "positions", "account")},
    }
    with pytest.raises(SealVerificationError, match="inventory"):
        build_run_seal(
            run_id="run-incomplete-completion",
            terminal_state=RunState.COMPLETED,
            terminal_event_seq=8,
            last_audit_seq=8,
            audit_head_hash="a" * 64,
            files=four_reports,
        )


@pytest.mark.parametrize("prefix_length", range(6))
def test_failed_seal_accepts_each_legal_report_prefix(prefix_length: int) -> None:
    reports = {
        f"reports/{name}.json": b"{}"
        for name in ("orders", "fills", "positions", "account", "metrics")[:prefix_length]
    }
    built = build_run_seal(
        run_id=f"run-failed-{prefix_length}",
        terminal_state=RunState.FAILED,
        terminal_event_seq=8,
        last_audit_seq=8,
        audit_head_hash="a" * 64,
        files={**_BASE_FILES, **reports},
    )
    assert sha256(built.seal_bytes).hexdigest() == built.seal_digest


def test_run_seal_rejects_self_inclusion() -> None:
    with pytest.raises(SealVerificationError, match="inventory"):
        build_run_seal(
            run_id="run-self-seal",
            terminal_state=RunState.FAILED,
            terminal_event_seq=8,
            last_audit_seq=8,
            audit_head_hash="a" * 64,
            files={**_BASE_FILES, "seal.json": b"{}"},
        )
