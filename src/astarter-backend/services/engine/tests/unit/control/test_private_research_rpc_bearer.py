"""PRIVATE RPC refuses plain bad bearer values before any backend call.

test_private_research_rpc.py already covers the other role's token and a duplicated header.
These cases add the plain ones, and the right token in another letter case, on one runtime
method (sent with a valid session digest, so the refusal can only come from the bearer) and one
issuer method. Each must answer 401 PRIVATE_AUTH_REQUIRED and leave both stub backends
untouched. Synthetic values only.
"""

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from stark_trading_os.control.private_research_rpc import create_private_research_app

RUNTIME = "r" * 48
ISSUER = "i" * 48
UNKNOWN = "u" * 48
DIGEST = "a" * 64
BASE = "/internal/private/v1"
CONTRACT = "ASTARTER_PRIVATE_RESEARCH_V1"
Call = tuple[str, dict[str, Any], str, str | None]
RUNTIME_CALL: Call = ("/research/get", {"requestId": "request1"}, RUNTIME, DIGEST)
ISSUER_CALL: Call = ("/auth/session/issue", {}, ISSUER, None)


class Backend:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def invoke(self, operation: str, payload: dict[str, Any], session_digest: str | None) -> Any:
        self.calls.append(operation)
        return {"owned": True}


def configured() -> tuple[TestClient, Backend, Backend]:
    runtime, issuer = Backend(), Backend()
    app = create_private_research_app(
        runtime=runtime, issuer=issuer, runtime_secret=RUNTIME, issuer_secret=ISSUER
    )
    return TestClient(app), runtime, issuer


def headers(authorization: str | None, digest: str | None) -> dict[str, str]:
    result = {}
    if authorization is not None:
        result["Authorization"] = authorization
    if digest is not None:
        result["X-Astarter-Private-Session-Digest"] = digest
    return result


BAD_BEARERS = [
    pytest.param(lambda token: None, id="no-header"),
    pytest.param(lambda token: "", id="empty-value"),
    pytest.param(lambda token: "Bearer ", id="bearer-with-nothing-after-it"),
    pytest.param(lambda token: "Bearer " + UNKNOWN, id="unknown-token"),
    pytest.param(lambda token: token, id="token-without-bearer-prefix"),
    pytest.param(lambda token: "Bearer " + token.upper(), id="token-in-other-letter-case"),
]


@pytest.mark.parametrize("call", [RUNTIME_CALL, ISSUER_CALL], ids=["runtime", "issuer"])
@pytest.mark.parametrize("bad", BAD_BEARERS)
def test_plain_bad_bearer_is_refused_before_any_backend_call(
    call: Call, bad: Callable[[str], str | None]
) -> None:
    path, body, token, digest = call
    client, runtime, issuer = configured()
    result = client.post(BASE + path, json=body, headers=headers(bad(token), digest))
    assert result.status_code == 401
    assert result.json() == {"contract": CONTRACT, "code": "PRIVATE_AUTH_REQUIRED"}
    assert result.headers["cache-control"] == "no-store"
    assert not runtime.calls and not issuer.calls


@pytest.mark.parametrize("call", [RUNTIME_CALL, ISSUER_CALL], ids=["runtime", "issuer"])
def test_same_request_with_the_right_bearer_reaches_only_its_backend(call: Call) -> None:
    path, body, token, digest = call
    client, runtime, issuer = configured()
    result = client.post(BASE + path, json=body, headers=headers("Bearer " + token, digest))
    assert result.status_code == 200
    assert result.json() == {"contract": CONTRACT, "result": {"owned": True}}
    reached, other = (runtime, issuer) if token == RUNTIME else (issuer, runtime)
    assert reached.calls == [path.lstrip("/")] and not other.calls
