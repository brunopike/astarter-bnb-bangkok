"""Closed Task 9 run-seal inventory primitives."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from hashlib import sha256

from stark_trading_os.audit.canonical_json import CanonicalJSONError, canonical_json_bytes
from stark_trading_os.domain.models import RunState

_BASE_PATHS = frozenset(
    {
        "request.json",
        "preflight.json",
        "input-manifest.json",
        "run-record.json",
        "events.ndjson",
        "audit.ndjson",
        "runner-exit.json",
        "stderr.txt",
    }
)
_REPORT_PATHS = tuple(
    f"reports/{name}.json" for name in ("orders", "fills", "positions", "account", "metrics")
)


class SealVerificationError(ValueError):
    """Raised when the first run-root or seal invariant fails."""


@dataclass(frozen=True)
class BuiltSeal:
    seal_bytes: bytes
    seal_digest: str


def build_run_seal(
    *,
    run_id: str,
    terminal_state: RunState,
    terminal_event_seq: int,
    last_audit_seq: int,
    audit_head_hash: str,
    files: Mapping[str, bytes],
) -> BuiltSeal:
    """Build the self-excluding canonical seal for one closed byte inventory."""

    if type(terminal_state) is not RunState:
        raise SealVerificationError("terminal_state must be an exact RunState")
    if not _inventory_is_closed(frozenset(files), terminal_state=terminal_state):
        raise SealVerificationError("run seal file inventory is not a legal closed prefix")
    entries: list[dict[str, object]] = []
    for relative_path, content in files.items():
        if type(content) is not bytes:
            raise SealVerificationError(f"{relative_path}: content must be exact bytes")
        entries.append(
            {
                "relative_path": relative_path,
                "sha256": sha256(content).hexdigest(),
                "size_bytes": len(content),
            }
        )
    try:
        seal_bytes = canonical_json_bytes(
            {
                "schema": "RunSeal.v1",
                "run_id": run_id,
                "terminal_state": terminal_state.value,
                "terminal_event_seq": terminal_event_seq,
                "last_audit_seq": last_audit_seq,
                "audit_head_hash": audit_head_hash,
                "files": entries,
            }
        )
    except CanonicalJSONError as error:
        raise SealVerificationError(str(error)) from error
    return BuiltSeal(
        seal_bytes=seal_bytes,
        seal_digest=sha256(seal_bytes).hexdigest(),
    )


def _inventory_is_closed(paths: frozenset[str], *, terminal_state: RunState) -> bool:
    if not _BASE_PATHS.issubset(paths):
        return False
    reports = tuple(path for path in _REPORT_PATHS if path in paths)
    expected_reports = _REPORT_PATHS[: len(reports)]
    if reports != expected_reports or paths != _BASE_PATHS | frozenset(reports):
        return False
    if terminal_state is RunState.CANCELLED:
        return not reports
    return terminal_state is not RunState.COMPLETED or reports == _REPORT_PATHS
