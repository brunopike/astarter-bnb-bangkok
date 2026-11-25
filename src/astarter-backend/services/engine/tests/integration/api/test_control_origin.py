from __future__ import annotations

import pytest
from conftest import ORIGIN
from fastapi.testclient import TestClient

from stark_trading_os.control.app import create_app
from stark_trading_os.control.security import InvalidLocalOrigin


@pytest.mark.parametrize(
    "origin",
    [
        "https://127.0.0.1:3000",
        "http://192.168.1.20:3000",
        "http://user@127.0.0.1:3000",
        "http://127.0.0.1:3000/path",
        "http://127.0.0.1:3000?query=1",
        "http://127.0.0.1:3000#fragment",
    ],
)
def test_configured_origin_must_be_an_exact_http_loopback_origin(origin: str) -> None:
    with pytest.raises(InvalidLocalOrigin):
        create_app(testing=True, web_local_origin=origin)


def test_production_app_requires_an_explicit_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("WEB_LOCAL_ORIGIN", raising=False)
    with pytest.raises(InvalidLocalOrigin):
        create_app()


def test_exact_origin_is_required_and_forwarded_authority_is_rejected(
    client: TestClient,
) -> None:
    missing = client.get("/v1/system/capabilities", headers={"Origin": ""})
    assert missing.status_code == 403
    assert missing.json()["code"] == "ORIGIN_FORBIDDEN"

    wrong = client.get(
        "/v1/system/capabilities",
        headers={"Origin": "http://localhost:3000"},
    )
    assert wrong.status_code == 403
    assert wrong.json()["code"] == "ORIGIN_FORBIDDEN"

    for name in ("Forwarded", "X-Forwarded-Host", "X-Forwarded-Proto"):
        rejected = client.get(
            "/v1/system/capabilities",
            headers={"Origin": ORIGIN, name: "for=127.0.0.1"},
        )
        assert rejected.status_code == 400
        assert rejected.json()["code"] == "FORWARDED_HEADER_FORBIDDEN"

    accepted = client.get(
        "/v1/system/capabilities",
        headers={"Origin": ORIGIN},
    )
    assert accepted.status_code == 200
    assert "access-control-allow-origin" not in accepted.headers


def test_duplicate_idempotency_headers_are_rejected_in_both_orders(
    client: TestClient,
    draft: dict[str, object],
) -> None:
    for first, second in (("alpha", "beta"), ("beta", "alpha")):
        response = client.post(
            "/v1/backtests/preflight",
            headers=[
                ("Origin", ORIGIN),
                ("Idempotency-Key", first),
                ("Idempotency-Key", second),
            ],
            json=draft,
        )
        assert response.status_code == 422
        assert response.json()["code"] == "REQUEST_INVALID"
