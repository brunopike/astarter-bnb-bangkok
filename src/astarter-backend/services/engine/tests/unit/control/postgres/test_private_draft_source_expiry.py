"""R3 "Expired/wrong-owner/invalid-citation reports cannot be adopted.": the expiry edge.

report_source refuses a report at and after its validUntil (private_draft_contracts.py L318 at
23405d6). With the copied fixture row unchanged no other check reads the clock that way, so the
refusal cases fail if that line goes; the existing "expired" case changes validUntil and so also
trips the source-time check (L339), which is why it does not notice today.

The adopt end recheck (private_draft_repository.py L309-L310) refuses a report that expired
while the adopt was writing, inside the same transaction, so nothing commits. No test reached its
refusal before; here invoke runs on the offline fixture with the preview, workspace and command
reads stubbed and the third identity check (L306) returning the later clock. No PostgreSQL is used.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from stark_trading_os.control.postgres.private_draft_contracts import (
    DraftContent,
    DraftPreviewResult,
    changed_groups,
    report_source,
)
from stark_trading_os.control.postgres.private_draft_repository import PrivateDraftRepository
from stark_trading_os.control.private_research_rpc import PrivateRPCError
from tests.unit.control.postgres.private_draft_offline_fixture import (
    DIGEST,
    DRAFT_ID,
    LEASE_ID,
    NOW,
    OWNER,
    PROPOSAL_REVISION,
    SOURCE_ID,
    OfflineDrafts,
    adopt_payload,
    expected_receipt,
    offline_drafts,
    proposal_content,
    receipt_row,
    report_row,
)

VALID_UNTIL = report_row()["result"]["validUntil"]
EMPTY_WORKSPACE = {
    "schema": "private-workspace-v1",
    "scope": OWNER[0],
    "revision": 0,
    "updatedAt": 0,
    "preferences": {"workbenchFilter": "all", "workbenchFocusAsset": None, "watchedAssets": []},
    "drafts": [],
    "selectedDraftId": None,
    "executionAuthority": "NONE",
}


def source_at(now: int) -> Any:
    return report_source(report_row(), owner=OWNER, lease_id=LEASE_ID, market="BTC/USDT", now=now)


def test_report_is_a_usable_source_until_one_millisecond_before_valid_until() -> None:
    source = source_at(VALID_UNTIL - 1)
    assert source.valid_until == VALID_UNTIL
    assert source.source_request_id == SOURCE_ID


@pytest.mark.parametrize("offset", [0, 1], ids=["at-valid-until", "after-valid-until"])
def test_report_at_or_after_valid_until_is_not_a_source(offset: int) -> None:
    with pytest.raises(ValueError, match="^PRIVATE_DRAFT_SOURCE_INVALID$"):
        source_at(VALID_UNTIL + offset)


def preview() -> DraftPreviewResult:
    proposal = proposal_content()
    return DraftPreviewResult.model_validate(
        {
            "schema": "private-draft-preview-v1",
            "scope": OWNER[0],
            "draftId": DRAFT_ID,
            "expectedRevision": 0,
            "workspaceRevision": 0,
            "proposalRevision": PROPOSAL_REVISION,
            "listed": False,
            "current": None,
            "proposal": proposal,
            "changedFields": changed_groups(None, DraftContent.model_validate(proposal)),
        }
    )


@contextmanager
def adopt_reads(drafts: OfflineDrafts, final_now: int) -> Iterator[MagicMock]:
    """Stub every read of one first adopt; the third identity check returns final_now."""
    drafts.identity.side_effect = [(OWNER, NOW), (OWNER, NOW), (OWNER, final_now)]
    with (
        patch.object(PrivateDraftRepository, "_preview", return_value=preview()),
        patch.object(drafts.repo._ui, "_workspace", return_value=EMPTY_WORKSPACE),
        patch.object(drafts.repo._ui, "_save_workspace", return_value={"revision": 1}),
        patch.object(
            PrivateDraftRepository, "_command", side_effect=[None, receipt_row("d" * 64)]
        ) as command,
    ):
        yield command


@pytest.mark.parametrize("offset", [0, 1], ids=["at-valid-until", "after-valid-until"])
def test_adopt_end_recheck_refuses_a_report_that_expired_during_the_write(offset: int) -> None:
    assert preview().proposal.source.valid_until == VALID_UNTIL
    with offline_drafts() as drafts, adopt_reads(drafts, VALID_UNTIL + offset) as command:
        with pytest.raises(PrivateRPCError) as refused:
            drafts.repo.invoke("drafts/adopt", adopt_payload(), DIGEST)

    assert refused.value.code == "PRIVATE_REQUEST_INVALID"
    assert drafts.identity.call_count == 3
    # Refused before the stored receipt is read back, inside the one write transaction.
    assert command.call_count == 1
    assert [t["write"] for t in drafts.transactions] == [True]
    assert drafts.transactions[0]["error"] is refused.value


def test_adopt_end_recheck_lets_a_report_that_is_still_valid_through() -> None:
    with offline_drafts() as drafts, adopt_reads(drafts, VALID_UNTIL - 1) as command:
        result = drafts.repo.invoke("drafts/adopt", adopt_payload(), DIGEST)

    assert result["request"] == expected_receipt()
    assert drafts.identity.call_count == 3
    assert command.call_count == 2
    assert drafts.transactions[0]["error"] is None
