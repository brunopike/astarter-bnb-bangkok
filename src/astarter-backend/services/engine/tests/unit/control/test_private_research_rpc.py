"""The internal PRIVATE transport must reject before borrowing an identity or DB."""

from typing import Any

import pytest
from fastapi.testclient import TestClient

from stark_trading_os.control.postgres.pool import CommitUnknown
from stark_trading_os.control.private_research_rpc import create_private_research_app

RUNTIME = "r" * 48
ISSUER = "i" * 48
DIGEST = "a" * 64
BASE = "/internal/private/v1"


class Backend:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any], str | None]] = []
        self.result: Any = {"owned": True}
        self.error: Exception | None = None

    def invoke(self, operation: str, payload: dict[str, Any], session_digest: str | None) -> Any:
        self.calls.append((operation, payload, session_digest))
        if self.error:
            raise self.error
        return self.result


@pytest.fixture
def configured() -> tuple[TestClient, Backend, Backend]:
    runtime, issuer = Backend(), Backend()
    app = create_private_research_app(
        runtime=runtime, issuer=issuer, runtime_secret=RUNTIME, issuer_secret=ISSUER
    )
    return TestClient(app), runtime, issuer


def test_disabled_factory_has_no_io() -> None:
    client = TestClient(create_private_research_app())
    result = client.post(BASE + "/research/claim", json={})
    assert result.status_code == 503
    assert result.json()["code"] == "PRIVATE_UNCONFIGURED"


@pytest.mark.parametrize("path,key", [("/lease", ISSUER), ("/auth/challenge/issue", RUNTIME)])
def test_capabilities_cannot_cross(
    configured: tuple[TestClient, Backend, Backend], path: str, key: str
) -> None:
    client, runtime, issuer = configured
    result = client.post(BASE + path, json={}, headers={"Authorization": "Bearer " + key})
    assert result.status_code == 401
    assert not runtime.calls and not issuer.calls


def test_each_request_carries_its_own_digest(
    configured: tuple[TestClient, Backend, Backend],
) -> None:
    client, runtime, issuer = configured
    for digest in (DIGEST, "b" * 64):
        result = client.post(
            BASE + "/research/get",
            json={"requestId": "request1"},
            headers={
                "Authorization": "Bearer " + RUNTIME,
                "X-Astarter-Private-Session-Digest": digest,
            },
        )
        assert result.json() == {
            "contract": "ASTARTER_PRIVATE_RESEARCH_V1",
            "result": {"owned": True},
        }
    assert [call[2] for call in runtime.calls] == [DIGEST, "b" * 64]
    assert not issuer.calls


@pytest.mark.parametrize("digest", [None, "a" * 63, "A" * 64, "x\nsubject=other"])
def test_owner_methods_require_cookie_digest(
    configured: tuple[TestClient, Backend, Backend], digest: str | None
) -> None:
    client, runtime, _ = configured
    headers = {"Authorization": "Bearer " + RUNTIME}
    if digest is not None:
        headers["X-Astarter-Private-Session-Digest"] = digest
    result = client.post(BASE + "/research/claim", json={}, headers=headers)
    assert result.status_code == 401
    assert not runtime.calls


def test_duplicate_headers_and_json_rejected(
    configured: tuple[TestClient, Backend, Backend],
) -> None:
    client, runtime, issuer = configured
    good = "Bearer " + RUNTIME
    result = client.post(
        BASE + "/lease", json={}, headers=[("Authorization", good), ("Authorization", good)]
    )
    assert result.status_code == 401
    for body in (
        '{"subjectId":"alice","subjectId":"bob"}',
        '{"nested":{"x":1,"x":2}}',
        '{"x":NaN}', '{"x":1e999}',
        "[]",
        "null",
    ):
        result = client.post(
            BASE + "/lease",
            content=body,
            headers={
                "Authorization": good,
                "Content-Type": "application/json",
                "X-Astarter-Private-Session-Digest": DIGEST,
            },
        )
        assert result.status_code == 400
    assert not runtime.calls and not issuer.calls


def test_issuer_has_all_nonce_and_session_operations(
    configured: tuple[TestClient, Backend, Backend],
) -> None:
    client, runtime, issuer = configured
    paths = ["challenge/" + op for op in ("issue", "get", "prepare", "consume", "revoke")]
    paths += ["session/" + op for op in ("issue", "resolve", "revoke")]
    for path in paths:
        result = client.post(
            BASE + "/auth/" + path, json={}, headers={"Authorization": "Bearer " + ISSUER}
        )
        assert result.status_code == 200
    assert len(issuer.calls) == 8 and not runtime.calls


def test_body_and_result_caps(configured: tuple[TestClient, Backend, Backend]) -> None:
    client, runtime, _ = configured
    headers = {
        "Authorization": "Bearer " + RUNTIME,
        "Content-Type": "application/json",
        "X-Astarter-Private-Session-Digest": DIGEST,
    }
    result = client.post(BASE + "/lease", content='{"x":"' + "x" * 131072 + '"}', headers=headers)
    assert result.status_code == 413 and not runtime.calls
    runtime.result = {"x": "x" * 131072}
    result = client.post(BASE + "/lease", json={}, headers=headers)
    assert result.status_code == 500
    assert result.json()["code"] == "PRIVATE_RESULT_INVALID"


@pytest.mark.parametrize(
    "error,status,code",
    [
        (CommitUnknown("sensitive SQL token"), 409, "PRIVATE_COMMIT_UNKNOWN"),
        (ValueError("sensitive body token"), 400, "PRIVATE_REQUEST_INVALID"),
        (RuntimeError("sensitive DSN password"), 503, "PRIVATE_UNAVAILABLE"),
    ],
)
def test_errors_are_fixed_not_exception_text(
    configured: tuple[TestClient, Backend, Backend], error: Exception, status: int, code: str
) -> None:
    client, runtime, _ = configured
    runtime.error = error
    result = client.post(
        BASE + "/lease",
        json={},
        headers={"Authorization": "Bearer " + RUNTIME, "X-Astarter-Private-Session-Digest": DIGEST},
    )
    assert result.status_code == status
    assert result.json() == {"contract": "ASTARTER_PRIVATE_RESEARCH_V1", "code": code}
    assert "sensitive" not in result.text


def test_unknown_operations_never_reach_db(configured: tuple[TestClient, Backend, Backend]) -> None:
    client, runtime, issuer = configured
    for path in ("/owner/sql", "/auth/session/delete", "/research/get?subjectId=other"):
        result = client.post(
            BASE + path,
            json={},
            headers={
                "Authorization": "Bearer " + RUNTIME,
                "X-Astarter-Private-Session-Digest": DIGEST,
            },
        )
        assert result.status_code in (400, 404)
    assert not runtime.calls and not issuer.calls


def test_same_secret_or_backend_cannot_collapse_roles() -> None:
    runtime, issuer = Backend(), Backend()
    with pytest.raises(ValueError, match="PRIVATE_CONFIGURATION"):
        create_private_research_app(
            runtime=runtime, issuer=issuer, runtime_secret=RUNTIME, issuer_secret=RUNTIME
        )
    with pytest.raises(ValueError, match="PRIVATE_CONFIGURATION"):
        create_private_research_app(
            runtime=runtime, issuer=runtime, runtime_secret=RUNTIME, issuer_secret=ISSUER
        )
