"""Issuer wire is structural validation, never proof of a signature or DB identity."""

import pytest
from pydantic import ValidationError

from stark_trading_os.control.postgres.private_research_inputs import issuer_input

HASH = "a" * 64
ADDRESS = "0x" + "1" * 40
ORIGIN = "https://astarter.imstark.site"
AT = 1_794_810_000_000


def challenge() -> dict[str, object]:
    return {
        "challengeHash": HASH,
        "nonce": "b" * 64,
        "origin": ORIGIN,
        "issuedAt": AT,
        "expires": AT + 300000,
        "address": None,
        "chain": None,
        "message": None,
    }


def session() -> dict[str, object]:
    return {
        "tokenHash": HASH,
        "previousTokenHash": None,
        "challengeHash": "b" * 64,
        "claimToken": "c" * 43,
        "address": ADDRESS,
        "chain": 56,
        "origin": ORIGIN,
        "issuedAt": AT,
        "expires": AT + 604800000,
        "permissions": ["research:analyze"],
    }


def test_exact_parent_challenge_and_session_contract() -> None:
    c = issuer_input("auth/challenge/issue", challenge())
    assert c.model_dump(by_alias=True) == challenge()
    assert (
        issuer_input("auth/session/issue", session()).model_dump(mode="json", by_alias=True)
        == session()
    )
    for operation, key in (
        ("challenge/get", "challengeHash"),
        ("challenge/revoke", "challengeHash"),
        ("session/resolve", "tokenHash"),
        ("session/revoke", "tokenHash"),
    ):
        issuer_input("auth/" + operation, {key: HASH, "now": AT})


@pytest.mark.parametrize(
    "field,value",
    [
        ("expires", AT + 300001),
        ("issuedAt", True),
        ("origin", "https://evil.invalid"),
        ("address", ADDRESS),
        ("chain", 56),
        ("nonce", "x" * 64),
        ("challengeHash", "A" * 64),
        ("tenantId", "forged"),
    ],
)
def test_challenge_rejects_mutable_or_forged_shape(field: str, value: object) -> None:
    data = challenge() | {field: value}
    with pytest.raises(ValidationError):
        issuer_input("auth/challenge/issue", data)


@pytest.mark.parametrize(
    "field,value",
    [
        ("expires", AT + 604800001),
        ("chain", True),
        ("permissions", ["admin"]),
        ("permissions", ["research:analyze", "research:analyze"]),
        ("previousTokenHash", HASH),
        ("subjectId", "forged"),
        ("claimToken", "short"),
    ],
)
def test_session_cannot_supply_authority_or_reuse_previous_token(field: str, value: object) -> None:
    with pytest.raises(ValidationError):
        issuer_input("auth/session/issue", session() | {field: value})


def test_prepare_and_consume_have_the_same_fixed_binding() -> None:
    data = {
        "challengeHash": HASH,
        "nonce": "b" * 64,
        "address": ADDRESS,
        "chain": 56,
        "message": "bounded server SIWE message",
        "now": AT,
    }
    for operation in ("prepare", "consume"):
        assert issuer_input("auth/challenge/" + operation, data).model_dump(by_alias=True) == data
        for patch in (
            {"chain": 1},
            {"chain": 56.0},
            {"message": "x" * 4097},
            {"message": "汉" * 1366},
            {"nonce": None},
        ):
            with pytest.raises(ValidationError):
                issuer_input("auth/challenge/" + operation, data | patch)


def test_unknown_issuer_operation_cannot_dispatch_arbitrary_method() -> None:
    with pytest.raises(ValueError, match="PRIVATE_REQUEST_INVALID"):
        issuer_input("auth/owner/sql", {})
