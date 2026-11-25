from __future__ import annotations

import socket

import httpx
import pytest

from stark_trading_os.agent.openai_review import (
    SensitiveQuestionRejected,
    validate_untrusted_question,
)

_BIDI_CONTROLS = (
    "\u061c",
    "\u200e",
    "\u200f",
    "\u202a",
    "\u202b",
    "\u202c",
    "\u202d",
    "\u202e",
    "\u2066",
    "\u2067",
    "\u2068",
    "\u2069",
)


@pytest.fixture(autouse=True)
def _forbid_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def blocked(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("question validation must not use the network")

    async def blocked_http(*_args: object, **_kwargs: object) -> None:
        blocked()

    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(httpx.AsyncClient, "send", blocked_http)


def _credential_examples() -> tuple[str, ...]:
    openai_style = "".join(("sk", "-", "a" * 16))
    project_style = "".join(("sk", "-", "proj", "-", "b" * 16))
    service_style = "".join(("sk", "-", "svcacct", "-", "c" * 16))
    authorization = "".join(("Author", "ization", ": Bear", "er ", "d" * 8))
    basic = "".join(("author", "ization", " = Basic ", "e" * 8))
    jwt = ".".join(("a" * 8, "b" * 8, "c" * 8))
    pem = "".join(("-----BEGIN ", "OPENSSH ", "PRIVATE KEY-----"))
    assignments = tuple(
        "".join((label, " = ", "z" * 8))
        for label in (
            "api key",
            "secret",
            "password",
            "passwd",
            "private key",
            "access token",
            "client secret",
        )
    )
    return (
        openai_style,
        project_style,
        service_style,
        authorization,
        basic,
        jwt,
        pem,
        *assignments,
    )


@pytest.mark.parametrize(
    "question",
    (
        "contains\x00nul",
        "contains\x1fcontrol",
        "contains\ud800surrogate",
        *(f"left{character}right" for character in _BIDI_CONTROLS),
    ),
)
def test_question_gate_rejects_controls_surrogates_and_bidi_without_echo(question: str) -> None:
    with pytest.raises(SensitiveQuestionRejected) as captured:
        validate_untrusted_question(question)

    error = captured.value
    assert type(error) is SensitiveQuestionRejected
    assert error.field == "question"
    assert error.reason == "SENSITIVE_INPUT_NOT_ACCEPTED"
    assert question not in str(error)
    assert question not in repr(error)
    assert set(vars(error)) <= {"field", "reason"}


def test_question_gate_rejects_only_closed_credential_forms_after_normalization() -> None:
    for question in _credential_examples():
        with pytest.raises(SensitiveQuestionRejected):
            validate_untrusted_question(question)

    fullwidth = "".join(("ｓｋ", "－", "ａ" * 16))
    with pytest.raises(SensitiveQuestionRejected):
        validate_untrusted_question(fullwidth)


def test_openai_style_prefixes_apply_the_exact_sixteen_character_threshold() -> None:
    for prefix in (("sk", "-"), ("sk", "-", "proj", "-"), ("sk", "-", "svcacct", "-")):
        accepted = "".join((*prefix, "a" * 15))
        rejected = "".join((*prefix, "a" * 16))
        assert validate_untrusted_question(accepted) == accepted
        with pytest.raises(SensitiveQuestionRejected):
            validate_untrusted_question(rejected)


def test_authorization_schemes_apply_the_exact_seven_to_eight_boundary() -> None:
    for scheme in ("Basic", "Bearer"):
        accepted = "".join(("Author", "ization: ", scheme, " ", "a" * 7))
        rejected = "".join(("Author", "ization: ", scheme, " ", "a" * 8))
        assert validate_untrusted_question(accepted) == accepted
        with pytest.raises(SensitiveQuestionRejected):
            validate_untrusted_question(rejected)


def test_jwt_like_values_require_eight_characters_in_every_segment() -> None:
    rejected = ".".join(("a" * 8, "b" * 8, "c" * 8))
    with pytest.raises(SensitiveQuestionRejected):
        validate_untrusted_question(rejected)

    for short_index in range(3):
        segments = [character * 8 for character in ("a", "b", "c")]
        segments[short_index] = segments[short_index][:-1]
        accepted = ".".join(segments)
        assert validate_untrusted_question(accepted) == accepted


def test_sensitive_assignments_apply_the_exact_seven_to_eight_boundary() -> None:
    labels = (
        "api key",
        "secret",
        "password",
        "passwd",
        "private key",
        "access token",
        "client secret",
    )
    for label in labels:
        accepted = "".join((label, "=", "z" * 7))
        rejected = "".join((label, "=", "z" * 8))
        assert validate_untrusted_question(accepted) == accepted
        with pytest.raises(SensitiveQuestionRejected):
            validate_untrusted_question(rejected)


def test_all_closed_private_key_pem_headers_are_rejected() -> None:
    for algorithm in ("", "RSA ", "EC ", "OPENSSH "):
        pem_header = "".join(("-----BEGIN ", algorithm, "PRIVATE KEY-----"))
        with pytest.raises(SensitiveQuestionRejected):
            validate_untrusted_question(pem_header)


def test_label_must_be_a_real_assignment_not_a_substring() -> None:
    benign = "".join(("notasecret", "=", "a" * 12))
    assert validate_untrusted_question(benign) == benign


@pytest.mark.parametrize(
    "question",
    (
        "Explain this token and its tokenomics.",
        "Compare access token economics without including a credential.",
        "0x" + "a" * 64,
        "Review the sealed run \U0001f469\u200d\U0001f4bb",
        "The API key field is intentionally blank.",
        "Bearer is an authentication scheme.",
        "abc.def.ghi",
    ),
)
def test_question_gate_preserves_benign_web3_hash_and_zwj_text(question: str) -> None:
    assert validate_untrusted_question(question) == question


def test_question_gate_defers_non_string_values_to_ordinary_schema_validation() -> None:
    marker = object()
    assert validate_untrusted_question(marker) is marker
