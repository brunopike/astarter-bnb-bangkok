"""R3 "Retries do not duplicate drafts or overwrite user edits.": the adopt replay branch.

Runs PrivateDraftRepository.invoke("drafts/adopt") on the offline fixture: real input parsing,
lease check, owner lock, fingerprint and replay decision (private_draft_repository.py L43-L83 at
23405d6), with only the database reads stubbed. The first attempt's fingerprint is taken from
what invoke hands to _adopt, which stores it with the receipt. This pins the Python branch only;
the same-id race, the primary key and the commit stay with the native PostgreSQL tests.
No PostgreSQL, socket or provider is used.
"""

import re
from typing import Any
from unittest.mock import patch

import pytest

from stark_trading_os.control.postgres.private_draft_repository import PrivateDraftRepository
from stark_trading_os.control.postgres.private_ui_repository import ui_lock_key
from stark_trading_os.control.private_research_rpc import PrivateRPCError
from tests.unit.control.postgres.private_draft_offline_fixture import (
    DIGEST,
    DRAFT_ID,
    NOW,
    OWNER,
    REQUEST_ID,
    OfflineDrafts,
    adopt_payload,
    expected_receipt,
    fields,
    offline_drafts,
    receipt_row,
    writes,
)


def first_attempt_fingerprint(drafts: OfflineDrafts, payload: dict[str, Any]) -> str:
    """The fingerprint a first attempt hands to _adopt, which stores it with its receipt."""
    with (
        patch.object(PrivateDraftRepository, "_command", return_value=None),
        patch.object(PrivateDraftRepository, "_adopt", return_value={"first": True}) as adopt,
    ):
        drafts.repo.invoke("drafts/adopt", payload, DIGEST)
    fingerprint = adopt.call_args.args[4]
    assert re.fullmatch(r"[a-f0-9]{64}", fingerprint)
    drafts.events.clear()
    drafts.transactions.clear()
    return fingerprint


def test_retry_with_the_same_request_returns_the_stored_receipt_and_writes_nothing() -> None:
    with offline_drafts() as drafts:
        payload = adopt_payload()
        stored = receipt_row(first_attempt_fingerprint(drafts, payload))

        def lookup(connection: Any, owner: tuple[str, str], request_id: str) -> dict[str, Any]:
            drafts.events.append(("lookup", owner, request_id))
            return stored

        with (
            patch.object(PrivateDraftRepository, "_command", side_effect=lookup),
            patch.object(PrivateDraftRepository, "_adopt") as adopt,
        ):
            result = drafts.repo.invoke("drafts/adopt", payload, DIGEST)

    adopt.assert_not_called()
    assert result["schema"] == "private-draft-command-v1"
    assert result["scope"] == OWNER[0]
    assert result["request"] == expected_receipt()
    assert result["draft"]["draftId"] == DRAFT_ID
    assert result["draft"]["revision"] == 1
    assert result["draft"]["savedAt"] == NOW
    assert result["draft"]["content"] == stored["content"]
    assert writes(drafts.events) == []
    assert [t["write"] for t in drafts.transactions] == [True]
    # The stored receipt is looked up under the owner's workspace lock, by the session owner.
    lock = next(
        i
        for i, event in enumerate(drafts.events)
        if event[0] == "sql" and "pg_advisory_xact_lock" in event[1]
    )
    lookup_at = next(i for i, event in enumerate(drafts.events) if event[0] == "lookup")
    assert lock < lookup_at
    assert drafts.events[lock][2] == (ui_lock_key(*OWNER, "workspace"),)
    assert drafts.events[lookup_at][1:] == (OWNER, REQUEST_ID)


@pytest.mark.parametrize(
    "change",
    [
        pytest.param({"fields": fields() | {"name": "BTC research draft edited"}}, id="field"),
        pytest.param({"expectedRevision": 1}, id="expected-revision"),
        pytest.param({"proposalRevision": "e" * 64}, id="proposal-revision"),
        pytest.param({"sourceRequestId": "research-02"}, id="source-report"),
    ],
)
def test_same_request_id_with_a_changed_body_is_a_conflict_and_adopts_nothing(
    change: dict[str, Any],
) -> None:
    with offline_drafts() as drafts:
        stored = receipt_row(first_attempt_fingerprint(drafts, adopt_payload()))
        with (
            patch.object(PrivateDraftRepository, "_command", return_value=stored) as command,
            patch.object(PrivateDraftRepository, "_adopt") as adopt,
            pytest.raises(PrivateRPCError) as refused,
        ):
            drafts.repo.invoke("drafts/adopt", adopt_payload(change), DIGEST)

    assert refused.value.code == "PRIVATE_CONFLICT"
    adopt.assert_not_called()
    command.assert_called_once()
    assert command.call_args.args[1:] == (OWNER, REQUEST_ID)
    assert writes(drafts.events) == []


def test_first_attempt_without_a_stored_receipt_adopts_once_for_the_session_owner() -> None:
    with offline_drafts() as drafts:
        with (
            patch.object(PrivateDraftRepository, "_command", return_value=None) as command,
            patch.object(
                PrivateDraftRepository, "_adopt", return_value={"adopted": True}
            ) as adopt,
        ):
            result = drafts.repo.invoke("drafts/adopt", adopt_payload(), DIGEST)

    assert result == {"adopted": True}
    adopt.assert_called_once()
    connection, data, owner, now, fingerprint, session_digest = adopt.call_args.args
    assert (owner, now, session_digest) == (OWNER, NOW, DIGEST)
    assert (data.request_id, data.draft_id) == (REQUEST_ID, DRAFT_ID)
    assert re.fullmatch(r"[a-f0-9]{64}", fingerprint)
    command.assert_called_once_with(connection, OWNER, REQUEST_ID)
    assert [t["write"] for t in drafts.transactions] == [True]
