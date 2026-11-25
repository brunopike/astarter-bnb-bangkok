"""The v2 wire boundary keeps precise scalars and rejects extra authority."""

import json

import pytest
from pydantic import ValidationError

from stark_trading_os.control.historical_preflight import HistoricalPreflightReceiptV2
from tests.unit.domain.test_historical_input import config_payload


def models():
    from stark_trading_os.control import historical_api_models

    return historical_api_models


def test_start_response_matches_persisted_queue_and_rejects_float_revision():
    model = models().HistoricalStartResponse
    payload = dict(
        run_id="bt_" + "1" * 32,
        state="QUEUED",
        state_version=2,
        last_visible_seq=2,
        input_manifest_hash="a" * 64,
    )
    assert json.loads(model.model_validate(payload).model_dump_json()) == payload
    for changes in (
        {"state_version": 2.0},
        {"last_visible_seq": True},
        {"input_manifest_hash": "bad"},
        {"state": "COMPLETED"},
        {"runtime_root": "/tmp/forbidden"},
    ):
        with pytest.raises(ValidationError):
            model.model_validate(payload | changes)


def test_configuration_page_nested_money_and_timestamps_keep_strict_strings():
    model = models().HistoricalDraftPage
    draft = dict(
        configuration=config_payload(),
        draft_id="sd_" + "1" * 32,
        revision=1,
        created_at_ns="1700000500000000000",
        updated_at_ns="1700000500000000000",
    )
    wire = {"items": [draft], "next_cursor": None}
    parsed = model.model_validate_json(json.dumps(wire))
    assert json.loads(parsed.model_dump_json()) == wire
    with pytest.raises(ValidationError):
        model.model_validate_json(
            json.dumps({"items": [draft | {"created_at_ns": 1700000500.0}], "next_cursor": None})
        )
    bad = json.loads(json.dumps(wire))
    bad["items"][0]["configuration"]["risk"]["max_order_notional"] = 1000.0
    with pytest.raises(ValidationError):
        model.model_validate_json(json.dumps(bad))


def test_capabilities_and_preflight_observation_are_closed_and_truthful():
    api = models()
    capabilities = api.HistoricalCapabilitiesResponse(enabled=False)
    assert capabilities.environment == "BACKTEST"
    assert capabilities.contract_kind == "HISTORICAL_SMA_V2" and not capabilities.live_available
    with pytest.raises(ValidationError):
        api.HistoricalCapabilitiesResponse(enabled="false")
    ready = HistoricalPreflightReceiptV2.model_validate(
        {
            "schema": "HistoricalPreflightReceipt.v2",
            "preflight_id": "pfh_" + "1" * 32,
            "run_id": "bt_" + "1" * 32,
            "state": "PREFLIGHT_READY",
            "state_version": 1,
            "configuration_id": "cfg_" + "1" * 32,
            "configuration_version": 1,
            "configuration_content_sha256": "a" * 64,
            "request_sha256": "b" * 64,
            "input_manifest_sha256": "c" * 64,
            "checked_at_ns": "1700000500000000000",
            "expires_at_ns": "1700000560000000000",
        }
    )
    payload = dict(
        receipt=ready,
        consumed_at_ns=None,
        observed_at_ns=ready.expires_at_ns,
        time_status="EXPIRED",
    )
    assert api.HistoricalPreflightStatus(**payload).current_eligibility == "NOT_RECHECKED"
    with pytest.raises(ValidationError):
        api.HistoricalPreflightStatus(**(payload | {"time_status": "IN_WINDOW"}))
    with pytest.raises(ValidationError):
        api.HistoricalPreflightStatus(**(payload | {"consumed_at_ns": ready.expires_at_ns}))
