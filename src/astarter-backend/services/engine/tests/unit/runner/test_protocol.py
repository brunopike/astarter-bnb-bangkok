from __future__ import annotations

from copy import deepcopy

import pytest

from stark_trading_os.runner.protocol import (
    MAX_CONTROL_LINE_BYTES,
    MAX_PROTOCOL_LINE_BYTES,
    ProtocolError,
    RunnerCandidateV1,
    RunnerControlV1,
    RunnerFailureV1,
    RunnerOutcomeV1,
    RunnerReportCandidateV1,
    RunnerSequenceValidator,
    encode_protocol_line,
    parse_control_line,
    parse_protocol_line,
)


def _progress_candidate(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schema": "RunnerCandidate.v1",
        "run_id": "bt_001",
        "input_manifest_hash": "a" * 64,
        "catalog_revision": "b" * 64,
        "source_seq": 1,
        "ts_event_ns": "1700000000000000000",
        "type": "run.progress",
        "payload": {
            "progress": "decision",
            "decision_ts_ns": "1700000000000000000",
            "quote_identity": {
                "instrument_id": "ETH/USDT.SIM",
                "ts_event_ns": "1699999999999999999",
                "ts_available_ns": "1700000000000000000",
                "source_seq": 1,
                "source_revision": "determinism-probe-v1",
                "record_hash": "c" * 64,
            },
        },
    }
    value.update(overrides)
    return value


def _success_outcome() -> dict[str, object]:
    reports = [
        {
            "name": name,
            "relative_path": f"reports/{name}.json",
            "sha256": (str(index) * 64),
            "size_bytes": index,
        }
        for index, name in enumerate(
            ("orders", "fills", "positions", "account", "metrics"),
            start=1,
        )
    ]
    return {
        "schema": "RunnerOutcome.v1",
        "run_id": "bt_001",
        "input_manifest_hash": "a" * 64,
        "catalog_revision": "b" * 64,
        "engine_package_version": "2.0.0rc3",
        "result": "SUCCEEDED",
        "last_source_seq": 9,
        "report_candidates": reports,
        "failure": None,
    }


def test_candidate_and_outcome_use_only_the_frozen_wire_fields() -> None:
    candidate = RunnerCandidateV1.model_validate(_progress_candidate())
    outcome = RunnerOutcomeV1.model_validate(_success_outcome())

    assert set(candidate.model_dump(by_alias=True)) == {
        "schema",
        "run_id",
        "input_manifest_hash",
        "catalog_revision",
        "source_seq",
        "ts_event_ns",
        "type",
        "payload",
    }
    assert set(outcome.model_dump(by_alias=True)) == {
        "schema",
        "run_id",
        "input_manifest_hash",
        "catalog_revision",
        "engine_package_version",
        "result",
        "last_source_seq",
        "report_candidates",
        "failure",
    }
    assert all(type(item) is RunnerReportCandidateV1 for item in outcome.report_candidates)


def test_canonical_line_is_one_utf8_object_one_lf_and_at_most_64_kib() -> None:
    candidate = RunnerCandidateV1.model_validate(_progress_candidate())

    encoded = encode_protocol_line(candidate)

    assert encoded.endswith(b"\n")
    assert b"\r" not in encoded
    assert len(encoded) <= MAX_PROTOCOL_LINE_BYTES
    assert parse_protocol_line(encoded) == candidate


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"\n",
        b"\xef\xbb\xbf{}\n",
        b"{}\r\n",
        b'{"schema":"RunnerCandidate.v1","schema":"RunnerOutcome.v1"}\n',
        b'{"schema":"Unknown.v1"}\n',
        b'{"schema":"RunnerCandidate.v1","value":0.1}\n',
    ],
)
def test_parser_rejects_empty_bom_cr_duplicate_unknown_and_float_lines(raw: bytes) -> None:
    with pytest.raises(ProtocolError):
        parse_protocol_line(raw)


def test_parser_rejects_unknown_candidate_field_and_closed_payload_drift() -> None:
    unknown = _progress_candidate(unexpected=True)
    payload_drift = _progress_candidate()
    payload = deepcopy(payload_drift["payload"])
    assert isinstance(payload, dict)
    payload["future"] = "not-authorized"
    payload_drift["payload"] = payload

    for value in (unknown, payload_drift):
        with pytest.raises(ProtocolError):
            parse_protocol_line(_raw_line(value))


def test_progress_rejects_future_visibility_and_ambiguous_quote_identity() -> None:
    future = _progress_candidate()
    payload = deepcopy(future["payload"])
    assert isinstance(payload, dict)
    identity = payload["quote_identity"]
    assert isinstance(identity, dict)
    identity["ts_available_ns"] = "1700000000000000001"
    future["payload"] = payload

    ambiguous = _progress_candidate()
    ambiguous_payload = deepcopy(ambiguous["payload"])
    assert isinstance(ambiguous_payload, dict)
    ambiguous_identity = ambiguous_payload["quote_identity"]
    assert isinstance(ambiguous_identity, dict)
    ambiguous_identity["source_seq"] = True
    ambiguous["payload"] = ambiguous_payload

    for value in (future, ambiguous):
        with pytest.raises(ProtocolError):
            parse_protocol_line(_raw_line(value))


def test_sequence_starts_at_one_and_is_contiguous_without_duplicate_or_regression() -> None:
    validator = RunnerSequenceValidator(
        run_id="bt_001",
        input_manifest_hash="a" * 64,
        catalog_revision="b" * 64,
        instrument_id="ETH/USDT.SIM",
        quote_currency="USDT",
    )
    validator.accept(RunnerCandidateV1.model_validate(_progress_candidate(source_seq=1)))
    validator.accept(RunnerCandidateV1.model_validate(_progress_candidate(source_seq=2)))

    assert validator.last_source_seq == 2
    for bad in (2, 1, 4):
        with pytest.raises(ProtocolError):
            validator.accept(
                RunnerCandidateV1.model_validate(_progress_candidate(source_seq=bad))
            )


def test_sequence_rejects_cross_run_manifest_and_catalog_identity() -> None:
    validator = RunnerSequenceValidator(
        run_id="bt_001",
        input_manifest_hash="a" * 64,
        catalog_revision="b" * 64,
        instrument_id="ETH/USDT.SIM",
        quote_currency="USDT",
    )
    for field, value in (
        ("run_id", "bt_002"),
        ("input_manifest_hash", "c" * 64),
        ("catalog_revision", "d" * 64),
    ):
        with pytest.raises(ProtocolError):
            validator.accept(
                RunnerCandidateV1.model_validate(_progress_candidate(**{field: value}))
            )


def test_success_outcome_requires_exact_five_fixed_report_candidates() -> None:
    valid = RunnerOutcomeV1.model_validate(_success_outcome())
    assert tuple(item.name for item in valid.report_candidates) == (
        "orders",
        "fills",
        "positions",
        "account",
        "metrics",
    )

    missing = _success_outcome()
    reports = missing["report_candidates"]
    assert isinstance(reports, list)
    reports.pop()
    duplicate = _success_outcome()
    duplicate_reports = duplicate["report_candidates"]
    assert isinstance(duplicate_reports, list)
    duplicate_reports[-1] = duplicate_reports[0]
    extra = _success_outcome()
    extra["terminal_state"] = "COMPLETED"

    for value in (missing, duplicate, extra):
        with pytest.raises(ProtocolError):
            parse_protocol_line(_raw_line(value))


@pytest.mark.parametrize("completed_count", range(6))
def test_failed_outcome_allows_only_the_atomically_completed_report_prefix(
    completed_count: int,
) -> None:
    value = _success_outcome()
    reports = value["report_candidates"]
    assert isinstance(reports, list)
    value["result"] = "FAILED"
    value["report_candidates"] = reports[:completed_count]
    value["failure"] = {
        "code": "REPORT_EXPORT_FAILED",
        "message": "native report export failed",
    }

    outcome = parse_protocol_line(_raw_line(value))
    assert isinstance(outcome, RunnerOutcomeV1)
    assert len(outcome.report_candidates) == completed_count


def test_failed_outcome_rejects_report_gap_duplicate_reorder_and_bad_path() -> None:
    base = _success_outcome()
    reports = base["report_candidates"]
    assert isinstance(reports, list)
    attacks = [
        [reports[0], reports[2]],
        [reports[0], reports[0]],
        [reports[1], reports[0]],
        [{**reports[0], "relative_path": "reports/elsewhere.json"}],
    ]
    for attack in attacks:
        value = {
            **base,
            "result": "FAILED",
            "report_candidates": attack,
            "failure": {
                "code": "REPORT_EXPORT_FAILED",
                "message": "native report export failed",
            },
        }
        with pytest.raises(ProtocolError):
            parse_protocol_line(_raw_line(value))


def test_encoder_rejects_a_line_larger_than_64_kib() -> None:
    candidate = RunnerCandidateV1.model_validate(_progress_candidate()).model_copy(
        update={
            "payload": {
                "progress": "decision",
                "decision_ts_ns": "1700000000000000000",
                "quote_identity": {
                    "instrument_id": "X" * MAX_PROTOCOL_LINE_BYTES,
                    "ts_event_ns": "1699999999999999999",
                    "ts_available_ns": "1700000000000000000",
                    "source_seq": 1,
                    "source_revision": "determinism-probe-v1",
                    "record_hash": "c" * 64,
                },
            }
        },
    )

    with pytest.raises(ProtocolError, match="64 KiB"):
        encode_protocol_line(candidate)


def test_protocol_encoder_accepts_exactly_64_kib_and_rejects_one_byte_more() -> None:
    value = _progress_candidate()
    payload = value["payload"]
    assert isinstance(payload, dict)
    identity = payload["quote_identity"]
    assert isinstance(identity, dict)
    identity["instrument_id"] = ""
    baseline = RunnerCandidateV1.model_validate(value)
    padding = MAX_PROTOCOL_LINE_BYTES - len(encode_protocol_line(baseline))

    identity["instrument_id"] = "X" * padding
    exact = RunnerCandidateV1.model_validate(value)
    assert len(encode_protocol_line(exact)) == 64 * 1024 == MAX_PROTOCOL_LINE_BYTES

    identity["instrument_id"] += "X"
    oversized = RunnerCandidateV1.model_validate(value)
    with pytest.raises(ProtocolError, match="64 KiB"):
        encode_protocol_line(oversized)


def test_failed_outcome_has_one_closed_failure_and_never_claims_terminal_state() -> None:
    value = _success_outcome()
    value["result"] = "FAILED"
    value["report_candidates"] = []
    value["failure"] = {
        "code": "RUNNER_EXECUTION_FAILED",
        "message": "native node failed before report export",
    }

    outcome = RunnerOutcomeV1.model_validate(value)

    assert type(outcome.failure) is RunnerFailureV1
    assert outcome.failure.code == "RUNNER_EXECUTION_FAILED"
    assert outcome.last_source_seq == 9
    assert outcome.run_id == "bt_001"
    assert outcome.input_manifest_hash == "a" * 64
    assert outcome.catalog_revision == "b" * 64
    assert "terminal_state" not in outcome.model_dump(by_alias=True)

    for bad in (
        {**value, "failure": None},
        {**_success_outcome(), "failure": value["failure"]},
        {
            **value,
            "failure": {
                "code": "UNKNOWN_FAILURE",
                "message": "not registered",
            },
        },
    ):
        with pytest.raises(ProtocolError):
            parse_protocol_line(_raw_line(bad))


@pytest.mark.parametrize(
    "message",
    [
        "X" * 257,
        "failure\nwith control",
        "/Users/operator/private/input-manifest.json",
        "token=super-secret-value",
    ],
)
def test_failure_message_is_bounded_and_sanitized_before_stdout(message: str) -> None:
    value = _success_outcome()
    value["result"] = "FAILED"
    value["report_candidates"] = []
    value["failure"] = {
        "code": "RUNNER_EXECUTION_FAILED",
        "message": message,
    }

    with pytest.raises(ProtocolError):
        parse_protocol_line(_raw_line(value))


def test_control_parser_accepts_exactly_one_bounded_cancel_request_shape() -> None:
    parsed = parse_control_line(
        b'{"action":"cancel.request","schema":"RunnerControl.v1"}\n'
    )
    assert type(parsed) is RunnerControlV1
    assert parsed.action == "cancel.request"

    for raw in (
        b'{"action":"cancel.request","schema":"RunnerControl.v1","again":true}\n',
        b'{"action":"stop","schema":"RunnerControl.v1"}\n',
        b'{"action":"cancel.request","schema":"RunnerControl.v1"}\r\n',
    ):
        with pytest.raises(ProtocolError):
            parse_control_line(raw)

    with pytest.raises(ProtocolError):
        encode_protocol_line(parsed)


def test_control_line_uses_the_independent_exact_four_kib_boundary() -> None:
    value = {
        "schema": "RunnerControl.v1",
        "action": "cancel.request",
        "padding": "",
    }
    empty_padding = _raw_line(value)
    value["padding"] = "x" * (MAX_CONTROL_LINE_BYTES - len(empty_padding))
    exact = _raw_line(value)
    assert len(exact) == 4096 == MAX_CONTROL_LINE_BYTES
    with pytest.raises(ProtocolError, match="control object is invalid"):
        parse_control_line(exact)

    value["padding"] += "x"
    oversized = _raw_line(value)
    assert len(oversized) == 4097
    with pytest.raises(ProtocolError, match="exceeds its byte bound"):
        parse_control_line(oversized)


_ECONOMIC_PAYLOADS: dict[str, dict[str, object]] = {
    "order.submitted": {
        "client_order_id": "O-1",
        "instrument_id": "ETH/USDT.SIM",
        "side": "BUY",
        "type": "LIMIT",
        "quantity": "15",
        "price": "100",
        "status": "SUBMITTED",
    },
    "order.accepted": {
        "client_order_id": "O-1",
        "instrument_id": "ETH/USDT.SIM",
        "venue_order_id": "V-1",
        "status": "ACCEPTED",
    },
    "order.rejected": {
        "client_order_id": "O-1",
        "instrument_id": "ETH/USDT.SIM",
        "reason": "POST_ONLY_WOULD_TAKE",
        "status": "REJECTED",
    },
    "order.partially_filled": {
        "client_order_id": "O-1",
        "instrument_id": "ETH/USDT.SIM",
        "last_qty": "10",
        "last_px": "100",
        "filled_qty": "10",
        "trade_id": "T-1",
        "commission": "1 USDT",
        "currency": "USDT",
        "liquidity_side": "TAKER",
    },
    "order.filled": {
        "client_order_id": "O-2",
        "instrument_id": "ETH/USDT.SIM",
        "last_qty": "1",
        "last_px": "100",
        "filled_qty": "1",
        "trade_id": "T-2",
        "commission": "0.1 USDT",
        "currency": "USDT",
        "liquidity_side": "TAKER",
    },
    "order.cancel_pending": {
        "client_order_id": "O-1",
        "instrument_id": "ETH/USDT.SIM",
        "status": "PENDING_CANCEL",
    },
    "order.cancelled": {
        "client_order_id": "O-1",
        "instrument_id": "ETH/USDT.SIM",
        "status": "CANCELED",
    },
    "position.opened": {
        "position_id": "P-1",
        "instrument_id": "ETH/USDT.SIM",
        "side": "LONG",
        "quantity": "10",
        "price": "100",
        "client_order_id": "O-1",
    },
    "position.changed": {
        "position_id": "P-1",
        "instrument_id": "ETH/USDT.SIM",
        "side": "LONG",
        "quantity": "9",
        "price": "100",
        "client_order_id": "O-2",
    },
    "position.closed": {
        "position_id": "P-1",
        "instrument_id": "ETH/USDT.SIM",
        "side": "FLAT",
        "quantity": "0",
        "price": "100",
        "client_order_id": "O-3",
        "realized_pnl": "5 USDT",
    },
    "risk.rejected": {
        "rule_id": "NAUTILUS_MAX_NOTIONAL_PER_ORDER",
        "reason": "NOTIONAL_EXCEEDED",
        "client_order_id": "O-RISK",
        "instrument_id": "ETH/USDT.SIM",
    },
}


@pytest.mark.parametrize(
    ("event_type", "field", "value"),
    [
        ("order.submitted", "side", "HOLD"),
        ("order.submitted", "type", "STOP_LIMIT"),
        ("order.submitted", "status", "PENDING"),
        ("order.accepted", "status", "FILLED"),
        ("order.rejected", "status", "DENIED"),
        ("order.partially_filled", "liquidity_side", "UNKNOWN"),
        ("order.filled", "currency", "usd"),
        ("order.cancel_pending", "status", "CANCELED"),
        ("order.cancelled", "status", "PENDING_CANCEL"),
        ("position.opened", "side", "FLAT"),
        ("position.changed", "side", "FLAT"),
        ("position.closed", "side", "LONG"),
    ],
)
def test_economic_payload_value_domains_are_closed_per_event(
    event_type: str,
    field: str,
    value: str,
) -> None:
    payload = {**_ECONOMIC_PAYLOADS[event_type], field: value}

    with pytest.raises(ProtocolError):
        parse_protocol_line(
            _raw_line(_progress_candidate(type=event_type, payload=payload))
        )


@pytest.mark.parametrize(
    ("commission", "currency"),
    [
        ("1.00000000 USDT", "USDT"),
        ("1 USD", "USDT"),
        ("1USDT", "USDT"),
        ("1 USDT", "USD"),
    ],
)
def test_fill_commission_is_canonical_money_matching_currency(
    commission: str,
    currency: str,
) -> None:
    payload = {
        **_ECONOMIC_PAYLOADS["order.filled"],
        "commission": commission,
        "currency": currency,
    }

    with pytest.raises(ProtocolError):
        parse_protocol_line(
            _raw_line(_progress_candidate(type="order.filled", payload=payload))
        )


def test_submitted_price_is_type_aware_and_never_fabricated() -> None:
    limit_without_price = deepcopy(_ECONOMIC_PAYLOADS["order.submitted"])
    limit_without_price.pop("price")
    market = {
        **_ECONOMIC_PAYLOADS["order.submitted"],
        "type": "MARKET",
    }
    market.pop("price")
    market_with_price = {**market, "price": "0"}

    parsed = parse_protocol_line(
        _raw_line(_progress_candidate(type="order.submitted", payload=market))
    )
    assert isinstance(parsed, RunnerCandidateV1)
    for payload in (limit_without_price, market_with_price):
        with pytest.raises(ProtocolError):
            parse_protocol_line(
                _raw_line(_progress_candidate(type="order.submitted", payload=payload))
            )


def test_sequence_binds_every_candidate_to_manifest_instrument_and_currency() -> None:
    validator = RunnerSequenceValidator(
        run_id="bt_001",
        input_manifest_hash="a" * 64,
        catalog_revision="b" * 64,
        instrument_id="ETH/USDT.SIM",
        quote_currency="USDT",
    )
    wrong_progress = _progress_candidate(source_seq=1)
    progress_payload = wrong_progress["payload"]
    assert isinstance(progress_payload, dict)
    quote_identity = progress_payload["quote_identity"]
    assert isinstance(quote_identity, dict)
    quote_identity["instrument_id"] = "BTC/USDT.SIM"
    wrong_economic = _progress_candidate(
        source_seq=1,
        type="order.filled",
        payload={
            **_ECONOMIC_PAYLOADS["order.filled"],
            "instrument_id": "BTC/USDT.SIM",
        },
    )
    wrong_currency = _progress_candidate(
        source_seq=1,
        type="order.filled",
        payload={
            **_ECONOMIC_PAYLOADS["order.filled"],
            "commission": "0.1 USD",
            "currency": "USD",
        },
    )

    for value in (wrong_progress, wrong_economic, wrong_currency):
        with pytest.raises(ProtocolError):
            validator.accept(RunnerCandidateV1.model_validate(value))


@pytest.mark.parametrize(("event_type", "payload"), _ECONOMIC_PAYLOADS.items())
def test_each_economic_candidate_payload_is_closed_and_strictly_typed(
    event_type: str, payload: dict[str, object]
) -> None:
    valid = _progress_candidate(type=event_type, payload=payload)
    parsed = parse_protocol_line(_raw_line(valid))
    assert isinstance(parsed, RunnerCandidateV1)
    assert parsed.type == event_type

    unknown = deepcopy(valid)
    unknown_payload = unknown["payload"]
    assert isinstance(unknown_payload, dict)
    unknown_payload["future"] = "not-authorized"
    missing = deepcopy(valid)
    missing_payload = missing["payload"]
    assert isinstance(missing_payload, dict)
    missing_payload.pop(next(iter(payload)))

    for drift in (unknown, missing):
        with pytest.raises(ProtocolError):
            parse_protocol_line(_raw_line(drift))


def test_candidate_rejects_unknown_event_type_and_binary_float_economic_value() -> None:
    unknown = _progress_candidate(type="order.future", payload={})
    float_value = _progress_candidate(
        type="order.submitted",
        payload={**_ECONOMIC_PAYLOADS["order.submitted"], "quantity": 1.0},
    )

    for value in (unknown, float_value):
        with pytest.raises(ProtocolError):
            parse_protocol_line(_raw_line(value))


def test_quote_identity_sequence_starts_at_one_and_payload_null_is_never_wire_data() -> None:
    bad_quote = _progress_candidate()
    progress = bad_quote["payload"]
    assert isinstance(progress, dict)
    identity = progress["quote_identity"]
    assert isinstance(identity, dict)
    identity["source_seq"] = 0
    explicit_null = _progress_candidate(
        type="order.accepted",
        payload={**_ECONOMIC_PAYLOADS["order.accepted"], "status": None},
    )

    for value in (bad_quote, explicit_null):
        with pytest.raises(ProtocolError):
            parse_protocol_line(_raw_line(value))


@pytest.mark.parametrize(
    "reason",
    [
        "X" * 257,
        "native\ncontrol",
        "/Users/operator/private/config.json",
        "api_key=super-secret-value",
    ],
)
def test_native_rejection_reasons_are_bounded_and_already_sanitized(reason: str) -> None:
    risk = deepcopy(_ECONOMIC_PAYLOADS["risk.rejected"])
    risk["reason"] = reason
    with pytest.raises(ProtocolError):
        parse_protocol_line(_raw_line(_progress_candidate(type="risk.rejected", payload=risk)))


def test_risk_rejection_rule_is_the_single_native_max_notional_rule() -> None:
    risk = deepcopy(_ECONOMIC_PAYLOADS["risk.rejected"])
    risk["rule_id"] = "CLIENT_INVENTED_RULE"
    with pytest.raises(ProtocolError):
        parse_protocol_line(_raw_line(_progress_candidate(type="risk.rejected", payload=risk)))


def test_sequence_finish_binds_outcome_cursor_identity_and_is_exactly_once() -> None:
    validator = RunnerSequenceValidator(
        run_id="bt_001",
        input_manifest_hash="a" * 64,
        catalog_revision="b" * 64,
        instrument_id="ETH/USDT.SIM",
        quote_currency="USDT",
    )
    validator.accept(RunnerCandidateV1.model_validate(_progress_candidate(source_seq=1)))
    valid = _success_outcome()
    valid["last_source_seq"] = 1
    outcome = RunnerOutcomeV1.model_validate(valid)
    validator.finish(outcome)

    with pytest.raises(ProtocolError):
        validator.finish(outcome)
    with pytest.raises(ProtocolError):
        validator.accept(RunnerCandidateV1.model_validate(_progress_candidate(source_seq=2)))


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("run_id", "bt_OTHER"),
        ("input_manifest_hash", "c" * 64),
        ("catalog_revision", "d" * 64),
        ("last_source_seq", 2),
    ],
)
def test_sequence_finish_rejects_cross_identity_and_off_by_one_cursor(
    field: str, value: object
) -> None:
    validator = RunnerSequenceValidator(
        run_id="bt_001",
        input_manifest_hash="a" * 64,
        catalog_revision="b" * 64,
        instrument_id="ETH/USDT.SIM",
        quote_currency="USDT",
    )
    validator.accept(RunnerCandidateV1.model_validate(_progress_candidate(source_seq=1)))
    outcome_value = _success_outcome()
    outcome_value["last_source_seq"] = 1
    outcome_value[field] = value

    with pytest.raises(ProtocolError):
        validator.finish(RunnerOutcomeV1.model_validate(outcome_value))


def _raw_line(value: dict[str, object]) -> bytes:
    import json

    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8") + b"\n"
