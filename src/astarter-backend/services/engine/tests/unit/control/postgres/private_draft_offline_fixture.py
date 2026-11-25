"""Offline stand-ins for PRIVATE draft repository tests: no PostgreSQL, socket or provider.

The pool is the real PgRepositoryPool for the PRIVATE contract, built cold with its native
ConnectionPool replaced by a mock (the pattern of test_private_research_pool.py), and the target
is that file's target() with schema_version=3 (as test_private_draft_native.py does). While a
fixture is open, opening the native pool, psycopg.connect, socket.getaddrinfo and
socket.socket.connect fail the test. pool.transaction yields a recording connection that accepts
statements and refuses every row read, so each row the repository needs comes from a stub.

fields() and report_row() are copies of the builders in test_private_draft_contracts.py at
23405d6 (L100-L114, L154-L204), copied rather than imported so these tests stay independent of
that test module. Synthetic values only.
"""

import json
import re
import socket
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from hashlib import sha256
from typing import Any
from unittest.mock import MagicMock, patch

import psycopg
from psycopg.conninfo import make_conninfo

from stark_trading_os.control.postgres.access import RepositoryAccessContract
from stark_trading_os.control.postgres.pool import PgRepositoryPool, PoolSettings
from stark_trading_os.control.postgres.private_draft_contracts import (
    CATALOG_VERSION,
    DraftContent,
    DraftFields,
    missing_fields,
    report_source,
)
from stark_trading_os.control.postgres.private_draft_repository import PrivateDraftRepository
from stark_trading_os.control.postgres.private_research_contracts import PrivateLease
from stark_trading_os.control.postgres.private_research_migration import PrivateTarget
from stark_trading_os.control.postgres.synthetic_migration import TargetProfile

DAY = 1_794_787_200
NOW = (DAY + 3600) * 1000
OWNER = ("wallet:56:alice", "wallet:56:alice")
LEASE_ID = "lease"
TARGET_ID = "private-local"
DIGEST = "c" * 64
REQUEST_ID = "draft-save-01"
DRAFT_ID = "draft-01"
SOURCE_ID = "research-01"
PROPOSAL_REVISION = "b" * 64
WRITE_STATEMENT = re.compile(r"^\s*(INSERT|UPDATE|DELETE)\b", re.IGNORECASE)


def target() -> PrivateTarget:
    return PrivateTarget(
        TargetProfile.LOCAL_PG17,
        "/owned_synthetic",
        55439,
        "private_fixture",
        "private_owner",
        "private_runtime",
        "private_issuer",
        "private_cost",
        TARGET_ID,
        schema_version=3,
    )


def lease(selected: PrivateTarget) -> PrivateLease:
    return PrivateLease(
        leaseId=LEASE_ID,
        targetId=selected.target_id,
        database=selected.database,
        schema="astarter_private",
        runtimeRole=selected.runtime,
        audience="astarter-research",
        budgetId="policy",
        model="openai/gpt-4.1-mini",
        expiresAt=253402300799998,
    )


def fields(strategy: str = "S01") -> dict[str, Any]:
    return {
        "name": "BTC research draft",
        "strategy": strategy,
        "planVariant": strategy + "-SIM",
        "market": "BTC/USDT",
        "environment": "DEMO",
        "mode": "auto",
        "amount": None,
        "cap": None,
        "researchBudget": None,
        "botParameters": None,
        "protection": None,
        "executionRoute": None,
    }


def report_row(
    now: int = NOW, *, owner: tuple[str, str] = OWNER, request: str = SOURCE_ID
) -> dict[str, Any]:
    closed = now // 86400000 * 86400
    source: dict[str, Any] = {
        "symbol": "BTC",
        "source": "Binance Spot",
        "timezone": "UTC",
        "unit": "USDT",
        "period": "1D",
        "methodVersion": "ema20-atr14-rsi14-v1",
        "sampleAt": closed - 86400,
        "closedAt": closed,
        "validUntil": closed + 86400,
        "metrics": {"close": 65000, "changePercent": 1, "ema20DeviationAtr14": 0.5, "rsi14": 55},
        "bars": 250,
    }
    source["id"] = (
        "market-" + sha256(json.dumps(source, separators=(",", ":")).encode()).hexdigest()[:32]
    )
    result = {
        "method": "ai",
        "model": "openai/gpt-4.1-mini",
        "responseId": "synthetic-response",
        "usage": {"inputTokens": 100, "outputTokens": 50, "totalTokens": 150},
        "billing": None,
        "output": {
            "outcome": "watch",
            "headline": "Synthetic closed-bar evidence",
            "summary": "Synthetic research; no executable strategy.",
            "claims": [{"text": "A test claim", "evidenceIds": [source["id"]]}],
        },
        "sources": [source],
        "missingDimensions": ["depth", "macro", "social", "chain", "risk"],
        "createdAt": now - 1000,
        "validUntil": (closed + 86400) * 1000,
        "executionAuthority": "NONE",
        "methodVersion": "closed-market-research-v1",
    }
    return {
        "tenant_id": owner[0],
        "subject_id": owner[1],
        "request_id": request,
        "fingerprint": "a" * 64,
        "lease_id": "lease",
        "state": "complete",
        "result": result,
        "created_at_ms": now - 2000,
        "expires_at_ms": now - 500,
        "finished_at_ms": now - 900,
        "error_code": None,
        "settled_microusd": None,
    }


def proposal_content() -> dict[str, Any]:
    """The draft content a preview of report_row() with fields() proposes at NOW."""
    selected = DraftFields.model_validate(fields())
    source = report_source(
        report_row(), owner=OWNER, lease_id=LEASE_ID, market="BTC/USDT", now=NOW
    )
    return DraftContent.model_validate(
        {
            "catalogVersion": CATALOG_VERSION,
            "templateVersion": selected.plan_variant + "@paper-v1",
            "parameterOrigin": "user-confirmed",
            "source": source.model_dump(by_alias=True),
            "fields": selected.model_dump(by_alias=True),
            "missingFields": missing_fields(selected),
            "executionAuthority": "NONE",
        }
    ).model_dump(by_alias=True)


def adopt_payload(changes: dict[str, Any] | None = None) -> dict[str, Any]:
    value = {
        "leaseId": LEASE_ID,
        "targetId": TARGET_ID,
        "audience": "astarter-research",
        "draftId": DRAFT_ID,
        "sourceRequestId": SOURCE_ID,
        "fields": fields(),
        "requestId": REQUEST_ID,
        "expectedRevision": 0,
        "workspaceRevision": 0,
        "proposalRevision": PROPOSAL_REVISION,
    }
    return value | (changes or {})


def receipt_row(fingerprint: str) -> dict[str, Any]:
    """A stored draft_commands row joined with its draft_versions row, as _command returns it."""
    return {
        "tenant_id": OWNER[0],
        "subject_id": OWNER[1],
        "request_id": REQUEST_ID,
        "fingerprint": fingerprint,
        "draft_id": DRAFT_ID,
        "expected_revision": 0,
        "revision": 1,
        "workspace_base_revision": 0,
        "workspace_revision": 1,
        "applied_at_ms": NOW,
        "source_request_id": SOURCE_ID,
        "saved_at_ms": NOW,
        "content": proposal_content(),
    }


def expected_receipt() -> dict[str, Any]:
    return {
        "requestId": REQUEST_ID,
        "draftId": DRAFT_ID,
        "status": "applied",
        "expectedRevision": 0,
        "revision": 1,
        "workspaceBaseRevision": 0,
        "workspaceRevision": 1,
        "appliedAt": NOW,
    }


class RecordingConnection:
    """Accepts and records statements; every row read must come from a stub instead."""

    def __init__(self, events: list[tuple[Any, ...]]) -> None:
        self.events = events

    def execute(self, query: str, params: Any = None) -> "RecordingConnection":
        self.events.append(("sql", query, params))
        return self

    def fetchone(self) -> Any:
        raise AssertionError("UNEXPECTED_ROW_READ")

    def fetchall(self) -> Any:
        raise AssertionError("UNEXPECTED_ROW_READ")


@dataclass
class OfflineDrafts:
    repo: PrivateDraftRepository
    identity: MagicMock
    events: list[tuple[Any, ...]]
    transactions: list[dict[str, Any]]


def writes(events: list[tuple[Any, ...]]) -> list[str]:
    return [e[1] for e in events if e[0] == "sql" and WRITE_STATEMENT.match(e[1])]


def _refuse_io(*args: Any, **kwargs: Any) -> Any:
    raise AssertionError("UNEXPECTED_IO")


@contextmanager
def offline_drafts() -> Iterator[OfflineDrafts]:
    events: list[tuple[Any, ...]] = []
    transactions: list[dict[str, Any]] = []
    connection = RecordingConnection(events)

    @contextmanager
    def transaction(*, write: bool = False, scope_id: str = "") -> Iterator[RecordingConnection]:
        record: dict[str, Any] = {"write": write, "scope_id": scope_id, "error": None}
        transactions.append(record)
        try:
            yield connection
        except BaseException as error:
            # The real pool rolls back here; the stub only records that it would have.
            record["error"] = error
            raise

    with ExitStack() as stack:
        stack.enter_context(patch.object(socket.socket, "connect", _refuse_io))
        stack.enter_context(patch.object(socket, "getaddrinfo", _refuse_io))
        stack.enter_context(patch.object(psycopg, "connect", _refuse_io))
        selected = target()
        with patch("stark_trading_os.control.postgres.pool.ConnectionPool") as native:
            pool = PgRepositoryPool(
                make_conninfo(
                    host=selected.host,
                    port=selected.port,
                    dbname=selected.database,
                    user=selected.runtime,
                    passfile="/dev/null",
                    sslmode="disable",
                ),
                settings=PoolSettings(max_size=2),
                access_contract=RepositoryAccessContract.PRIVATE_RESEARCH_V1,
                private_target=selected,
                private_role="runtime",
            )
        stack.callback(pool.close)
        stack.callback(native.return_value.open.assert_not_called)
        repo = PrivateDraftRepository(pool, lease=lease(selected))
        stack.enter_context(patch.object(pool, "transaction", transaction))
        identity = stack.enter_context(
            patch.object(repo._ui, "_identity", return_value=(OWNER, NOW))
        )
        yield OfflineDrafts(repo, identity, events, transactions)
