"""Hash-chain primitives for canonical audit entries."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from hashlib import sha256

from stark_trading_os.audit.canonical_json import CanonicalJSONError, canonical_json_bytes

_GENESIS_HASH = "0" * 64
_OWNED_ARTIFACT_NAMES = frozenset(
    {
        "input-manifest.json",
        "reports/orders.json",
        "reports/fills.json",
        "reports/positions.json",
        "reports/account.json",
        "reports/metrics.json",
    }
)


class HashChainVerificationError(ValueError):
    """Raised with the first corrupt audit sequence."""

    def __init__(self, sequence: object, reason: str) -> None:
        self.sequence = sequence
        super().__init__(f"Hash chain corrupt at seq {sequence}: {reason}")


def canonical_sha256(value: object) -> str:
    """Return SHA-256 of one CanonicalJSON.v1 value."""

    try:
        return sha256(canonical_json_bytes(value)).hexdigest()
    except CanonicalJSONError as error:
        raise ValueError(f"Cannot hash non-canonical value: {error}") from error


def append_hash_chain(entries: Sequence[Mapping[str, object]]) -> list[dict[str, object]]:
    """Build audit entries with a deterministic previous-hash link."""

    previous_hash = _GENESIS_HASH
    chained: list[dict[str, object]] = []
    for expected_seq, entry in enumerate(entries, start=1):
        _require_sequence(entry, expected_seq)
        if "prev_hash" in entry or "entry_hash" in entry:
            raise ValueError("Unhashed audit entries cannot include prev_hash or entry_hash.")
        entry_without_hash = {**entry, "prev_hash": previous_hash}
        entry_hash = canonical_sha256(entry_without_hash)
        chained.append({**entry_without_hash, "entry_hash": entry_hash})
        previous_hash = entry_hash
    return chained


def verify_hash_chain(entries: Sequence[Mapping[str, object]]) -> None:
    """Verify every chain link and identify the first corrupt sequence."""

    previous_hash = _GENESIS_HASH
    for expected_seq, entry in enumerate(entries, start=1):
        try:
            sequence = _require_sequence(entry, expected_seq)
        except ValueError as error:
            raise HashChainVerificationError(entry.get("seq", "missing"), str(error)) from error
        if entry.get("prev_hash") != previous_hash:
            raise HashChainVerificationError(sequence, "prev_hash does not match")
        if "entry_hash" not in entry:
            raise HashChainVerificationError(sequence, "entry_hash is missing")
        entry_without_hash = {key: value for key, value in entry.items() if key != "entry_hash"}
        try:
            expected_hash = canonical_sha256(entry_without_hash)
        except ValueError as error:
            raise HashChainVerificationError(sequence, str(error)) from error
        if entry["entry_hash"] != expected_hash:
            raise HashChainVerificationError(sequence, "entry_hash does not match")
        previous_hash = expected_hash


def build_named_digests(files: Mapping[str, object]) -> dict[str, str]:
    """Build canonical digests for a fixed artifact-name mapping."""

    _require_owned_inventory(files)
    return {name: canonical_sha256(value) for name, value in sorted(files.items())}


def verify_named_digests(files: Mapping[str, object], digests: Mapping[str, str]) -> None:
    """Verify artifact digests and name the first missing, changed, or unexpected file."""

    names = sorted(set(files) | set(digests) | _OWNED_ARTIFACT_NAMES)
    for name in names:
        if name not in files:
            raise HashChainVerificationError(name, "file is missing")
        if name not in digests:
            raise HashChainVerificationError(name, "file is not listed")
        if name not in _OWNED_ARTIFACT_NAMES:
            raise HashChainVerificationError(name, "file is outside Task 3 inventory")
        if canonical_sha256(files[name]) != digests[name]:
            raise HashChainVerificationError(name, "file digest does not match")


def _require_sequence(entry: Mapping[str, object], expected: int) -> int:
    sequence = entry.get("seq")
    if type(sequence) is not int or sequence != expected:
        raise ValueError(f"seq must be exact contiguous integer {expected}")
    return sequence


def _require_owned_inventory(files: Mapping[str, object]) -> None:
    if set(files) != _OWNED_ARTIFACT_NAMES:
        raise ValueError("artifact inventory must contain only Task 3 owned names")
