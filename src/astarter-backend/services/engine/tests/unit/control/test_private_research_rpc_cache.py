"""R2 "never cache private data publicly": every PRIVATE RPC answer is no-store and nosniff.

Synthetic values and in-memory stub backends only; no database, network or provider. Each case
reaches one answer of private_research_rpc.py, including the two the framework raises (an
unknown path and a wrong method), and every answer must carry the two headers set in
_response(). A private record must never be stored by a shared cache or sniffed as markup. The
one answer not reached here, the 503 at full capacity, is pinned in
test_private_research_rpc_capacity.py.
"""

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response

from stark_trading_os.control.postgres.pool import CommitUnknown
from stark_trading_os.control.private_research_rpc import (
    PrivateRPCError,
    create_private_research_app,
)

RUNTIME = "r" * 48
ISSUER = "i" * 48
DIGEST = "a" * 64
BASE = "/internal/private/v1"
CONTRACT = "ASTARTER_PRIVATE_RESEARCH_V1"
OWNER = {"Authorization": "Bearer " + RUNTIME, "X-Astarter-Private-Session-Digest": DIGEST}
JSON = {"Content-Type": "application/json"}
TOO_LARGE = '{"x":"' + "x" * 70_000 + '"}'
RECORD = {
    "requestId": "request1",
    "state": "complete",
    "subjectId": "wallet:56:alice",
    "result": {"headline": "Synthetic private research", "executionAuthority": "NONE"},
}


class Backend:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.result: Any = RECORD
        self.error: Exception | None = None

    def invoke(self, operation: str, payload: dict[str, Any], session_digest: str | None) -> Any:
        self.calls.append(operation)
        if self.error is not None:
            raise self.error
        return self.result


def configured() -> tuple[TestClient, Backend]:
    runtime, issuer = Backend(), Backend()
    app = create_private_research_app(
        runtime=runtime, issuer=issuer, runtime_secret=RUNTIME, issuer_secret=ISSUER
    )
    return TestClient(app), runtime


def read(client: TestClient) -> Response:
    return client.post(BASE + "/research/get", json={"requestId": "request1"}, headers=OWNER)


def failing(error: Exception) -> Callable[[TestClient, Backend], Response]:
    def call(client: TestClient, runtime: Backend) -> Response:
        runtime.error = error
        return read(client)

    return call


def returning(result: Any) -> Callable[[TestClient, Backend], Response]:
    def call(client: TestClient, runtime: Backend) -> Response:
        runtime.result = result
        return read(client)

    return call


CASES = [
    pytest.param(lambda c, _: read(c), 200, None, id="200-private-record"),
    pytest.param(
        lambda c, _: c.post(
            BASE + "/research/get?subjectId=other", json={"requestId": "request1"}, headers=OWNER
        ),
        400,
        "PRIVATE_REQUEST_INVALID",
        id="400-query-string",
    ),
    pytest.param(
        lambda c, _: c.post(BASE + "/lease", content='{"x":1,"x":2}', headers=OWNER | JSON),
        400,
        "PRIVATE_REQUEST_INVALID",
        id="400-duplicate-json-field",
    ),
    pytest.param(
        lambda c, _: c.post(
            BASE + "/lease", content="{}", headers=OWNER | JSON | {"Content-Length": "two"}
        ),
        400,
        "PRIVATE_REQUEST_INVALID",
        id="400-malformed-content-length",
    ),
    pytest.param(
        failing(ValueError("synthetic")), 400, "PRIVATE_REQUEST_INVALID", id="400-backend-refusal"
    ),
    pytest.param(
        lambda c, _: c.post(
            BASE + "/research/get",
            json={"requestId": "request1"},
            headers={"X-Astarter-Private-Session-Digest": DIGEST},
        ),
        401,
        "PRIVATE_AUTH_REQUIRED",
        id="401-no-bearer",
    ),
    pytest.param(
        lambda c, _: c.post(
            BASE + "/research/get",
            json={"requestId": "request1"},
            headers={"Authorization": "Bearer " + RUNTIME},
        ),
        401,
        "PRIVATE_AUTH_REQUIRED",
        id="401-no-session-digest",
    ),
    pytest.param(
        lambda c, _: c.post(
            BASE + "/session/resolve", json={"tokenDigest": "c" * 64}, headers=OWNER
        ),
        401,
        "PRIVATE_AUTH_REQUIRED",
        id="401-session-digest-mismatch",
    ),
    pytest.param(
        failing(PermissionError("synthetic")), 403, "PRIVATE_FORBIDDEN", id="403-forbidden"
    ),
    pytest.param(
        failing(PrivateRPCError("PRIVATE_TARGET_MISMATCH")),
        403,
        "PRIVATE_TARGET_MISMATCH",
        id="403-target-mismatch",
    ),
    pytest.param(
        lambda c, _: c.post(BASE + "/owner/sql", json={}, headers=OWNER),
        404,
        "PRIVATE_REQUEST_INVALID",
        id="404-unknown-method",
    ),
    pytest.param(
        lambda c, _: c.post("/internal/private/v2/lease", json={}, headers=OWNER),
        404,
        "PRIVATE_REQUEST_INVALID",
        id="404-outside-the-rpc-path",
    ),
    pytest.param(
        lambda c, _: c.get(BASE + "/research/get", headers=OWNER),
        405,
        "PRIVATE_REQUEST_INVALID",
        id="405-wrong-method",
    ),
    pytest.param(
        failing(PrivateRPCError("PRIVATE_CONFLICT")), 409, "PRIVATE_CONFLICT", id="409-conflict"
    ),
    pytest.param(
        failing(CommitUnknown("synthetic")), 409, "PRIVATE_COMMIT_UNKNOWN", id="409-commit-unknown"
    ),
    pytest.param(
        lambda c, _: c.post(BASE + "/lease", content=TOO_LARGE, headers=OWNER | JSON),
        413,
        "PRIVATE_BODY_TOO_LARGE",
        id="413-body-too-large",
    ),
    pytest.param(
        # A generator body is sent without Content-Length, so only the read loop can refuse it.
        lambda c, _: c.post(
            BASE + "/lease", content=(part for part in [TOO_LARGE.encode()]), headers=OWNER | JSON
        ),
        413,
        "PRIVATE_BODY_TOO_LARGE",
        id="413-streamed-body-too-large",
    ),
    pytest.param(
        lambda c, _: c.post(
            BASE + "/lease", content="{}", headers=OWNER | {"Content-Type": "text/plain"}
        ),
        415,
        "PRIVATE_REQUEST_INVALID",
        id="415-not-json",
    ),
    pytest.param(
        returning({"value": float("nan")}), 500, "PRIVATE_RESULT_INVALID", id="500-result-not-json"
    ),
    pytest.param(
        failing(RuntimeError("synthetic")), 503, "PRIVATE_UNAVAILABLE", id="503-backend-unavailable"
    ),
]


def assert_private_headers(result: Response) -> None:
    assert result.headers["cache-control"] == "no-store"
    assert result.headers["x-content-type-options"] == "nosniff"
    assert result.headers["content-type"].split(";")[0] == "application/json"


@pytest.mark.parametrize("request_case,status,code", CASES)
def test_every_private_rpc_answer_is_no_store_and_nosniff(
    request_case: Callable[[TestClient, Backend], Response], status: int, code: str | None
) -> None:
    client, runtime = configured()
    result = request_case(client, runtime)
    assert result.status_code == status
    body: dict[str, Any] = {"result": RECORD} if code is None else {"code": code}
    assert result.json() == {"contract": CONTRACT} | body
    assert_private_headers(result)


def test_unconfigured_service_answer_is_no_store_and_nosniff() -> None:
    result = TestClient(create_private_research_app()).post(
        BASE + "/research/get", json={"requestId": "request1"}, headers=OWNER
    )
    assert result.status_code == 503
    assert result.json() == {"contract": CONTRACT, "code": "PRIVATE_UNCONFIGURED"}
    assert_private_headers(result)
