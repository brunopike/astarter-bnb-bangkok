"""PRIVATE UI wire validation is inert and does not grant authority."""

import importlib
import importlib.util

import pytest
from pydantic import ValidationError

MODULE = "stark_trading_os.control.postgres.private_ui_contracts"
BINDING = {"leaseId": "lease", "targetId": "private-local", "audience": "astarter-research"}


def test_private_ui_contracts_exist():
    assert importlib.util.find_spec(MODULE) is not None, "PRIVATE UI contracts missing"


@pytest.fixture
def contract():
    assert importlib.util.find_spec(MODULE) is not None, "PRIVATE UI contracts missing"
    return importlib.import_module(MODULE)


def workspace(**changes):
    return {
        **BINDING,
        "requestId": "workspace-1",
        "baseRevision": 0,
        "preferences": {
            "workbenchFilter": "all", "workbenchFocusAsset": None,
            "watchedAssets": ["BTC", "coin:bitcoin", "ca:bsc:0x" + "a" * 40],
        },
        "drafts": [{"id": "D-S03", "strategyId": "S03", "name": "BTC study"}],
        "selectedDraftId": "D-S03",
        **changes,
    }


def test_catalog_and_closed_keys(contract):
    data = contract.ui_input("workspace/save", workspace())
    assert data.model_dump(by_alias=True)["drafts"][0]["strategyId"] == "S03"
    assert set(contract.UI_METHODS) == {
        "notifications/state", "notifications/command", "notifications/request",
        "workspace/state", "workspace/save", "workspace/request",
    }
    with pytest.raises(ValueError):
        contract.ui_input("research/claim", BINDING)


@pytest.mark.parametrize("change", [
    {"subjectId": "other"}, {"tenantId": "other"}, {"authVersion": 2},
    {"baseRevision": True}, {"baseRevision": 0.0}, {"baseRevision": -1},
    {"requestId": "short"}, {"selectedDraftId": "absent"},
    {"drafts": [{"id": "D-S03", "strategyId": "S99", "name": "x"}]},
    {"drafts": [{"id": "D-S03", "strategyId": "S03", "name": "x", "status": "passed"}]},
    {"preferences": {"workbenchFilter": "all", "workbenchFocusAsset": None,
                     "watchedAssets": ["ca:bsc:bad"]}},
    {"preferences": {"workbenchFilter": "all", "workbenchFocusAsset": None,
                     "watchedAssets": [], "budget": 10}},
])
def test_invalid_workspace_is_rejected(contract, change):
    with pytest.raises(ValidationError):
        contract.ui_input("workspace/save", workspace(**change))


@pytest.mark.parametrize("payload", [
    {"ids": []}, {"ids": ["one", "one"]}, {"ids": ["x"] * 51},
    {"ids": [1]}, {"ids": ["x"], "subjectId": "other"},
])
def test_read_command_is_closed_and_bounded(contract, payload):
    with pytest.raises(ValidationError):
        contract.ui_input("notifications/command", {
            **BINDING, "requestId": "notice-01", "baseRevision": 0,
            "action": "mark-read", "payload": payload,
        })


def test_notification_preferences_have_canonical_order(contract):
    data = contract.ui_input("notifications/command", {
        **BINDING, "requestId": "notice-01", "baseRevision": 0,
        "action": "save", "payload": {
            "events": ["research", "orders"], "inapp": False,
            "enabled": {"telegram": False, "email": False},
        },
    })
    assert data.model_dump(by_alias=True)["payload"]["events"] == ["orders", "research"]


@pytest.mark.parametrize("events", [["risk", "risk"], ["arbitrary"], [True]])
def test_invalid_events(contract, events):
    with pytest.raises(ValidationError):
        contract.ui_input("notifications/command", {
            **BINDING, "requestId": "notice-01", "baseRevision": 0,
            "action": "save", "payload": {
                "events": events, "inapp": True,
                "enabled": {"telegram": False, "email": False},
            },
        })


def test_cursor_and_model_fields_do_not_expand_input(contract):
    with pytest.raises(ValidationError):
        contract.ui_input("notifications/state", {**BINDING, "cursor": None, "limit": True})
    with pytest.raises(ValidationError):
        contract.ui_input("notifications/command", {
            **BINDING, "requestId": "notice-01", "baseRevision": 0,
            "action": "event", "payload": {"type": "orders"},
        })


def test_secret_and_unbounded_content_are_rejected(contract):
    for name in ("Bearer " + "a" * 40, "sk-or-v1-" + "a" * 40, "x\nlabel", "x" * 121):
        with pytest.raises(ValidationError):
            contract.ui_input("workspace/save", workspace(drafts=[{
                "id": "D-S03", "strategyId": "S03", "name": name,
            }]))


def test_snake_case_fields_do_not_expand_wire_contract(contract):
    wrong = {**BINDING}
    wrong["lease_id"] = wrong.pop("leaseId")
    with pytest.raises(ValidationError):
        contract.ui_input("workspace/state", wrong)
    data = workspace()
    data["preferences"]["workbench_filter"] = data["preferences"].pop("workbenchFilter")
    with pytest.raises(ValidationError):
        contract.ui_input("workspace/save", data)


@pytest.mark.parametrize("strategy", [
    "RX01", "RX02-P", "RX02-A", "RX03-S", "RX03-B", "RX04", "RX05",
])
def test_existing_research_catalog_metadata_remains_saveable(contract, strategy):
    data = workspace(drafts=[{"id": "D-S03", "strategyId": strategy, "name": "Research"}])
    saved = contract.ui_input("workspace/save", data)
    assert saved.model_dump(by_alias=True)["drafts"][0]["strategyId"] == strategy
    data["drafts"][0]["status"] = "passed"
    with pytest.raises(ValidationError):
        contract.ui_input("workspace/save", data)


@pytest.mark.parametrize("field", ["draft-id", "selected-id", "legacy-watch", "coin-watch",
                                   "ca-chain", "request-id"])
def test_known_credential_shapes_are_rejected_at_metadata_boundaries(contract, field):
    synthetic = "sk-or-v1-" + "synthetic_only_" * 3
    data = workspace()
    if field == "draft-id":
        data["drafts"][0]["id"] = synthetic
        data["selectedDraftId"] = synthetic
    elif field == "selected-id":
        data["selectedDraftId"] = synthetic
    elif field in {"legacy-watch", "coin-watch", "ca-chain"}:
        key = synthetic if field == "legacy-watch" else (
            "coin:" + synthetic if field == "coin-watch" else "ca:" + synthetic + ":0x" + "a" * 40
        )
        data["preferences"]["watchedAssets"] = [key]
    else:
        data["requestId"] = synthetic
    with pytest.raises(ValidationError):
        contract.ui_input("workspace/save", data)


def test_explicit_ca_namespace_keeps_legitimate_32_byte_addresses(contract):
    keys = ["ca:sui:0x" + "a" * 64, "ca:bsc:0x" + "b" * 40,
            "ca:solana:" + "A" * 32]
    data = workspace()
    data["preferences"]["watchedAssets"] = keys
    assert contract.ui_input("workspace/save", data).model_dump(by_alias=True)[
        "preferences"]["watchedAssets"] == keys


def test_reminder_projection_is_explicit_and_does_not_expand_mutation_receipts(contract):
    read = {**BINDING, "cursor": None, "limit": 20}
    assert contract.ui_input("notifications/state", read) is not None
    selected = contract.ui_input("notifications/state", {**read, "responseVersion": 2})
    assert selected.response_version == 2
    for operation, payload in (
        ("workspace/state", BINDING),
        ("notifications/request", {**BINDING, "requestId": "notice-01"}),
        ("notifications/command", {
            **BINDING, "requestId": "notice-01", "baseRevision": 0,
            "action": "mark-read", "payload": {"ids": ["event-1"]},
        }),
    ):
        with pytest.raises(ValidationError):
            contract.ui_input(operation, {**payload, "responseVersion": 2})


@pytest.mark.parametrize("version", [None, True, False, 2.0, "2", 0, 1, 3])
def test_reminder_projection_refuses_ambiguous_or_unsupported_versions(contract, version):
    with pytest.raises(ValidationError):
        contract.ui_input("notifications/state", {
            **BINDING, "cursor": None, "limit": 20, "responseVersion": version,
        })
