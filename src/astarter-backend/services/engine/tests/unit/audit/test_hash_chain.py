from __future__ import annotations

import pytest

from stark_trading_os.audit.hash_chain import (
    HashChainVerificationError,
    append_hash_chain,
    build_named_digests,
    verify_hash_chain,
    verify_named_digests,
)


def test_hash_chain_detects_the_first_tampered_audit_sequence() -> None:
    chain = append_hash_chain(
        [
            {"seq": 1, "action": "preflight.passed"},
            {"seq": 2, "action": "run.queued"},
        ]
    )
    chain[1]["action"] = "run.completed"

    with pytest.raises(HashChainVerificationError, match="seq 2"):
        verify_hash_chain(chain)


def test_hash_chain_links_each_entry_to_the_previous_digest() -> None:
    chain = append_hash_chain([{"seq": 1, "action": "preflight.passed"}])

    assert chain[0]["prev_hash"] == "0" * 64
    assert isinstance(chain[0]["entry_hash"], str)
    verify_hash_chain(chain)


def test_named_digest_verification_identifies_the_first_tampered_report_file() -> None:
    files = _owned_artifacts()
    digests = build_named_digests(files)
    files["reports/metrics.json"] = {"summary": {"Total Orders": "2"}}

    with pytest.raises(HashChainVerificationError, match="reports/metrics.json"):
        verify_named_digests(files, digests)


@pytest.mark.parametrize(
    "entries",
    [
        [{"seq": 0, "action": "preflight.passed"}],
        [{"seq": 1, "action": "preflight.passed"}, {"seq": 3, "action": "run.queued"}],
    ],
)
def test_hash_chain_requires_one_based_contiguous_integer_sequences(
    entries: list[dict[str, object]],
) -> None:
    with pytest.raises(ValueError, match="seq"):
        append_hash_chain(entries)


def test_hash_chain_rejects_a_missing_sequence_during_verification() -> None:
    chain = append_hash_chain([{"seq": 1, "action": "preflight.passed"}])
    chain[0].pop("seq")

    with pytest.raises(HashChainVerificationError, match="seq"):
        verify_hash_chain(chain)


def test_named_digest_inventory_is_closed_to_task_three_artifacts() -> None:
    with pytest.raises(ValueError, match="inventory"):
        build_named_digests({"orders.json": []})


@pytest.mark.parametrize(
    "mutation",
    [
        lambda files: files.pop("reports/fills.json"),
        lambda files: files.__setitem__("reports/surprise.json", []),
    ],
)
def test_named_digest_verification_identifies_missing_or_extra_file(
    mutation: object,
) -> None:
    files = _owned_artifacts()
    digests = build_named_digests(files)
    assert callable(mutation)
    mutation(files)

    with pytest.raises(HashChainVerificationError, match="reports/"):
        verify_named_digests(files, digests)


def _owned_artifacts() -> dict[str, object]:
    return {
        "input-manifest.json": {},
        "reports/orders.json": [],
        "reports/fills.json": [],
        "reports/positions.json": [],
        "reports/account.json": [],
        "reports/metrics.json": {"summary": {}},
    }
