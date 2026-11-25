from __future__ import annotations

import sqlite3
from copy import deepcopy
from typing import cast

import pytest
from conftest import ORIGIN, ApiHarness, _dependencies, publish
from fastapi.testclient import TestClient

from stark_trading_os.control.app import create_app
from stark_trading_os.control.strategy_configurations import StrategyConfigurationIntegrityError
from stark_trading_os.control.strategy_models import ConfigurationInput
from stark_trading_os.domain.models import BacktestDraftRequest
from tests.sqlite_corruption import open_corruption_connection

VALID_CONFIGURATION_INPUT: dict[str, object] = {
    "name": "  QA run  ",
    "strategy_ref": "determinism-probe@v1",
    "parameters": {
        "entry_limit_price": "100",
        "entry_quantity": "15",
        "metric_round_trip_quantity": "1",
        "metric_round_trips": 5,
        "risk_probe_quantity": "20",
        "venue_rejection_quantity": "1",
    },
    "replay_seed": 7,
}


def _publish_configuration(
    client: TestClient,
    *,
    name: str = "QA run",
    replay_seed: int = 7,
) -> dict[str, object]:
    draft = client.post(
        "/v1/strategy-drafts",
        json={**VALID_CONFIGURATION_INPUT, "name": name, "replay_seed": replay_seed},
    ).json()
    response = client.post(
        f"/v1/strategy-drafts/{draft['draft_id']}/publish",
        json={"expected_revision": draft["revision"]},
    )
    assert response.status_code == 201
    return response.json()


def test_create_and_get_persistent_strategy_draft(client: TestClient) -> None:
    created = client.post("/v1/strategy-drafts", json=VALID_CONFIGURATION_INPUT)

    assert created.status_code == 201
    draft = created.json()
    assert draft == {
        **VALID_CONFIGURATION_INPUT,
        "name": "QA run",
        "draft_id": draft["draft_id"],
        "revision": 1,
        "created_at_ns": draft["created_at_ns"],
        "updated_at_ns": draft["updated_at_ns"],
    }
    assert isinstance(draft["created_at_ns"], str)
    assert draft["updated_at_ns"] == draft["created_at_ns"]

    fetched = client.get(f"/v1/strategy-drafts/{draft['draft_id']}")

    assert fetched.status_code == 200
    assert fetched.json() == draft


def test_strategy_catalog_exposes_the_same_fixed_probe_contract(client: TestClient) -> None:
    response = client.get("/v1/strategies")

    assert response.status_code == 200
    assert response.json() == {
        "items": [
            {
                "strategy_ref": "determinism-probe@v1",
                "name": "Determinism QA Probe",
                "purpose": "QA_PROBE",
                "description": (
                    "Fixed native-engine determinism, fill, rejection, risk, and replay QA probe."
                ),
                "parameters_schema": response.json()["items"][0]["parameters_schema"],
                "default_parameters": VALID_CONFIGURATION_INPUT["parameters"],
                "default_replay_seed": 7,
                "execution_modes": ["BACKTEST"],
                "data_requirements": {
                    "catalog_purpose": "LOCAL_QA_ONLY",
                    "fixture_label": "LOCAL QA FIXTURE",
                    "data_types": ["instruments", "quotes"],
                    "timezone": "UTC",
                },
            }
        ]
    }
    schema = cast(dict[str, object], response.json()["items"][0]["parameters_schema"])
    assert schema["additionalProperties"] is False
    required = cast(list[str], schema["required"])
    parameters = cast(dict[str, object], VALID_CONFIGURATION_INPUT["parameters"])
    properties = cast(dict[str, dict[str, object]], schema["properties"])
    assert set(required) == set(parameters)
    assert properties["metric_round_trips"]["const"] == 5
    assert properties["entry_limit_price"]["const"] == "100"


def test_list_strategy_drafts_returns_persisted_items(client: TestClient) -> None:
    assert client.get("/v1/strategy-drafts").json() == {"items": []}
    created = client.post("/v1/strategy-drafts", json=VALID_CONFIGURATION_INPUT).json()

    response = client.get("/v1/strategy-drafts")

    assert response.status_code == 200
    assert response.json() == {"items": [created]}


@pytest.mark.parametrize(
    ("mutation", "code"),
    [
        (("parameters", "entry_quantity", "16"), "CONFIGURATION_PARAMETERS_INVALID"),
        (("replay_seed", None, -1), "CONFIGURATION_INPUT_INVALID"),
        (("replay_seed", None, 2**31), "CONFIGURATION_INPUT_INVALID"),
        (("replay_seed", None, True), "CONFIGURATION_INPUT_INVALID"),
        (("name", None, "   "), "CONFIGURATION_INPUT_INVALID"),
        (("name", None, "x" * 121), "CONFIGURATION_INPUT_INVALID"),
    ],
)
def test_strategy_draft_rejects_invalid_fixed_parameters_and_saved_inputs(
    client: TestClient,
    mutation: tuple[str, str | None, object],
    code: str,
) -> None:
    payload = deepcopy(VALID_CONFIGURATION_INPUT)
    field, nested, value = mutation
    if nested is None:
        payload[field] = value
    else:
        parameters = payload[field]
        assert isinstance(parameters, dict)
        parameters[nested] = value

    response = client.post("/v1/strategy-drafts", json=payload)

    assert response.status_code == 422
    assert response.json()["code"] == code


def test_strategy_draft_rejects_an_unregistered_closed_reference(client: TestClient) -> None:
    payload = {**VALID_CONFIGURATION_INPUT, "strategy_ref": "other-probe@v1"}

    response = client.post("/v1/strategy-drafts", json=payload)

    assert response.status_code == 422
    assert response.json()["code"] == "STRATEGY_UNKNOWN"


def test_strategy_draft_update_uses_revision_compare_and_swap(client: TestClient) -> None:
    created = client.post("/v1/strategy-drafts", json=VALID_CONFIGURATION_INPUT).json()
    update = {
        **VALID_CONFIGURATION_INPUT,
        "name": "Winner",
        "replay_seed": 8,
        "expected_revision": 1,
    }

    winner = client.put(f"/v1/strategy-drafts/{created['draft_id']}", json=update)
    stale = client.put(
        f"/v1/strategy-drafts/{created['draft_id']}",
        json={**update, "name": "Stale writer"},
    )

    assert winner.status_code == 200
    assert winner.json()["revision"] == 2
    assert winner.json()["name"] == "Winner"
    assert winner.json()["replay_seed"] == 8
    assert stale.status_code == 409
    assert stale.json()["code"] == "CONFIGURATION_REVISION_CONFLICT"
    assert client.get(f"/v1/strategy-drafts/{created['draft_id']}").json() == winner.json()


@pytest.mark.parametrize("oversized_revision", [2**53, 2**63])
def test_expected_revision_above_supported_range_is_rejected_at_http_boundary(
    api_harness: ApiHarness,
    oversized_revision: int,
) -> None:
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(
        app,
        headers={"Origin": ORIGIN},
        raise_server_exceptions=False,
    ) as client:
        draft = client.post("/v1/strategy-drafts", json=VALID_CONFIGURATION_INPUT).json()
        responses = (
            client.put(
                f"/v1/strategy-drafts/{draft['draft_id']}",
                json={**VALID_CONFIGURATION_INPUT, "expected_revision": oversized_revision},
            ),
            client.post(
                f"/v1/strategy-drafts/{draft['draft_id']}/publish",
                json={"expected_revision": oversized_revision},
            ),
        )

    assert [response.status_code for response in responses] == [422, 422]
    assert [response.json()["code"] for response in responses] == [
        "CONFIGURATION_INPUT_INVALID",
        "CONFIGURATION_INPUT_INVALID",
    ]


def test_maximum_supported_revision_reaches_revision_conflict(
    client: TestClient,
) -> None:
    draft = client.post("/v1/strategy-drafts", json=VALID_CONFIGURATION_INPUT).json()
    maximum_revision = (2**53) - 1
    responses = (
        client.put(
            f"/v1/strategy-drafts/{draft['draft_id']}",
            json={**VALID_CONFIGURATION_INPUT, "expected_revision": maximum_revision},
        ),
        client.post(
            f"/v1/strategy-drafts/{draft['draft_id']}/publish",
            json={"expected_revision": maximum_revision},
        ),
    )

    assert [(response.status_code, response.json()["code"]) for response in responses] == [
        (409, "CONFIGURATION_REVISION_CONFLICT"),
        (409, "CONFIGURATION_REVISION_CONFLICT"),
    ]


def test_publish_is_immutable_and_idempotent_for_each_source_revision(
    client: TestClient,
) -> None:
    draft = client.post("/v1/strategy-drafts", json=VALID_CONFIGURATION_INPUT).json()
    draft_id = draft["draft_id"]

    first = client.post(
        f"/v1/strategy-drafts/{draft_id}/publish",
        json={"expected_revision": 1},
    )
    updated = client.put(
        f"/v1/strategy-drafts/{draft_id}",
        json={
            **VALID_CONFIGURATION_INPUT,
            "name": "Second version",
            "replay_seed": 9,
            "expected_revision": 1,
        },
    ).json()
    retry = client.post(
        f"/v1/strategy-drafts/{draft_id}/publish",
        json={"expected_revision": 1},
    )
    second = client.post(
        f"/v1/strategy-drafts/{draft_id}/publish",
        json={"expected_revision": 2},
    )

    assert first.status_code == retry.status_code == second.status_code == 201
    first_version = first.json()
    assert retry.json() == first_version
    assert first_version["version"] == first_version["source_revision"] == 1
    assert first_version["name"] == "QA run"
    assert first_version["replay_seed"] == 7
    assert len(first_version["content_sha256"]) == 64
    second_version = second.json()
    assert second_version["configuration_id"] != first_version["configuration_id"]
    assert second_version["version"] == second_version["source_revision"] == 2
    assert second_version["name"] == updated["name"]
    assert second_version["replay_seed"] == 9

    fetched_first = client.get(
        f"/v1/strategy-configurations/{first_version['configuration_id']}"
    )
    versions = client.get(f"/v1/strategy-drafts/{draft_id}/versions")

    assert fetched_first.status_code == 200
    assert fetched_first.json() == first_version
    assert versions.status_code == 200
    assert versions.json() == {"items": [second_version, first_version]}


def test_selected_version_preflight_is_atomically_bound_and_survives_create(
    client: TestClient,
    api_harness: ApiHarness,
    draft: dict[str, object],
) -> None:
    version = _publish_configuration(client, name="Bound configuration", replay_seed=11)
    publication = publish(client)
    request = {**draft, "catalog_revision": publication["catalog_revision"], "replay_seed": 11}

    response = client.post(
        f"/v1/strategy-configurations/{version['configuration_id']}/preflight",
        headers={"Idempotency-Key": "configured-ready"},
        json=request,
    )

    assert response.status_code == 200
    preflight = response.json()
    assert preflight["state"] == "PREFLIGHT_READY"
    with sqlite3.connect(api_harness.database) as connection:
        binding = connection.execute(
            """
            SELECT preflight_id, run_id, configuration_id, configuration_content_sha256
            FROM preflight_configuration_bindings
            """
        ).fetchone()
    assert binding == (
        preflight["preflight_id"],
        preflight["run_id"],
        version["configuration_id"],
        version["content_sha256"],
    )

    queued = client.post(
        "/v1/backtests",
        headers={"Idempotency-Key": "create-configured-ready"},
        json={
            "preflight_id": preflight["preflight_id"],
            "canonical_request_hash": preflight["canonical_request_hash"],
        },
    )
    lineage = client.get(f"/v1/backtests/{preflight['run_id']}/configuration")

    assert queued.status_code == 202
    assert lineage.status_code == 200
    assert lineage.json() == version


@pytest.mark.parametrize(
    "override",
    [
        {"replay_seed": 8},
        {"strategy_ref": "other-probe@v1"},
    ],
)
def test_selected_version_preflight_rejects_request_identity_mismatch(
    client: TestClient,
    draft: dict[str, object],
    override: dict[str, object],
) -> None:
    version = _publish_configuration(client)
    publication = publish(client)
    request = {**draft, "catalog_revision": publication["catalog_revision"], **override}

    response = client.post(
        f"/v1/strategy-configurations/{version['configuration_id']}/preflight",
        headers={"Idempotency-Key": "configured-mismatch"},
        json=request,
    )

    assert response.status_code == 409
    assert response.json()["code"] == "CONFIGURATION_PREFLIGHT_MISMATCH"


def test_selected_version_preflight_rejects_forged_parameters(
    client: TestClient,
    draft: dict[str, object],
) -> None:
    version = _publish_configuration(client)
    publication = publish(client)
    parameters = cast(dict[str, object], VALID_CONFIGURATION_INPUT["parameters"])
    request = {
        **draft,
        "catalog_revision": publication["catalog_revision"],
        "parameters": {**parameters, "entry_quantity": "16"},
    }

    response = client.post(
        f"/v1/strategy-configurations/{version['configuration_id']}/preflight",
        headers={"Idempotency-Key": "configured-forged-parameters"},
        json=request,
    )

    assert response.status_code == 422
    assert response.json()["code"] == "CONFIGURATION_PARAMETERS_INVALID"


def test_preflight_idempotency_identity_includes_exact_configuration_version(
    client: TestClient,
    draft: dict[str, object],
) -> None:
    first = _publish_configuration(client, name="First")
    source = client.get(f"/v1/strategy-drafts/{first['draft_id']}").json()
    updated = client.put(
        f"/v1/strategy-drafts/{first['draft_id']}",
        json={
            **VALID_CONFIGURATION_INPUT,
            "name": "Second",
            "expected_revision": source["revision"],
        },
    ).json()
    second = client.post(
        f"/v1/strategy-drafts/{first['draft_id']}/publish",
        json={"expected_revision": updated["revision"]},
    ).json()
    publication = publish(client)
    request = {**draft, "catalog_revision": publication["catalog_revision"]}

    initial = client.post(
        f"/v1/strategy-configurations/{first['configuration_id']}/preflight",
        headers={"Idempotency-Key": "configuration-sensitive-key"},
        json=request,
    )
    retry = client.post(
        f"/v1/strategy-configurations/{first['configuration_id']}/preflight",
        headers={"Idempotency-Key": "configuration-sensitive-key"},
        json=request,
    )
    other_version = client.post(
        f"/v1/strategy-configurations/{second['configuration_id']}/preflight",
        headers={"Idempotency-Key": "configuration-sensitive-key"},
        json=request,
    )
    direct = client.post(
        "/v1/backtests/preflight",
        headers={"Idempotency-Key": "configuration-sensitive-key"},
        json=request,
    )

    assert initial.status_code == retry.status_code == 200
    assert retry.content == initial.content
    assert other_version.status_code == 409
    assert other_version.json()["code"] == "IDEMPOTENCY_CONFLICT"
    assert direct.status_code == 409
    assert direct.json()["code"] == "IDEMPOTENCY_CONFLICT"


def test_configuration_hash_tampering_blocks_consumption_and_lineage_reads(
    client: TestClient,
    api_harness: ApiHarness,
    draft: dict[str, object],
) -> None:
    version = _publish_configuration(client)
    publication = publish(client)
    request = {**draft, "catalog_revision": publication["catalog_revision"]}
    preflight = client.post(
        f"/v1/strategy-configurations/{version['configuration_id']}/preflight",
        headers={"Idempotency-Key": "tamper-configured-preflight"},
        json=request,
    ).json()
    with open_corruption_connection(api_harness.database) as connection:
        connection.execute(
            """
            UPDATE strategy_configuration_versions
            SET content_sha256 = ?
            WHERE configuration_id = ?
            """,
            ("b" * 64, version["configuration_id"]),
        )

    create = client.post(
        "/v1/backtests",
        headers={"Idempotency-Key": "consume-tampered-configuration"},
        json={
            "preflight_id": preflight["preflight_id"],
            "canonical_request_hash": preflight["canonical_request_hash"],
        },
    )
    lineage = client.get(f"/v1/backtests/{preflight['run_id']}/configuration")

    assert create.status_code == 409
    assert create.json()["code"] == "PREFLIGHT_STALE"
    assert lineage.status_code == 409
    assert lineage.json()["code"] == "CONFIGURATION_INTEGRITY_FAILED"


def test_failed_configuration_binding_rolls_back_the_whole_preflight_transaction(
    api_harness: ApiHarness,
    draft: dict[str, object],
) -> None:
    dependencies = _dependencies(api_harness)
    try:
        configuration = ConfigurationInput.model_validate(VALID_CONFIGURATION_INPUT)
        created = dependencies.strategy_configurations.create_draft(configuration)
        version = dependencies.strategy_configurations.publish_draft(
            draft_id=created.draft_id,
            expected_revision=created.revision,
        )
        publication = dependencies.fixture_publisher.publish("local-qa-v1")
        request = BacktestDraftRequest.model_validate(
            {**draft, "catalog_revision": publication.catalog_revision}
        )
        resolved, binding = dependencies.strategy_configurations.resolve_preflight(
            configuration_id=version.configuration_id,
            request=request,
        )
        with open_corruption_connection(api_harness.database) as connection:
            connection.execute(
                """
                UPDATE strategy_configuration_versions
                SET content_sha256 = ?
                WHERE configuration_id = ?
                """,
                ("b" * 64, version.configuration_id),
            )

        with pytest.raises(StrategyConfigurationIntegrityError):
            dependencies.preflight.run(
                resolved,
                "atomic-binding-failure",
                configuration_binding=binding,
            )

        counts = dependencies.store._connection.execute(
            """
            SELECT (SELECT COUNT(*) FROM runs),
                   (SELECT COUNT(*) FROM preflights),
                   (SELECT COUNT(*) FROM preflight_configuration_bindings),
                   (SELECT COUNT(*) FROM idempotency_records)
            """
        ).fetchone()
        assert tuple(counts) == (0, 0, 0, 0)
    finally:
        dependencies.store.close()


def test_direct_preflight_remains_unbound_and_returns_null_configuration(
    client: TestClient,
    draft: dict[str, object],
) -> None:
    publication = publish(client)
    request = {**draft, "catalog_revision": publication["catalog_revision"]}
    preflight = client.post(
        "/v1/backtests/preflight",
        headers={"Idempotency-Key": "legacy-direct-preflight"},
        json=request,
    ).json()

    response = client.get(f"/v1/backtests/{preflight['run_id']}/configuration")

    assert response.status_code == 200
    assert response.json() is None


def test_drafts_and_versions_survive_control_service_restart(api_harness: ApiHarness) -> None:
    first_app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(first_app, headers={"Origin": ORIGIN}) as first_client:
        draft = first_client.post(
            "/v1/strategy-drafts", json=VALID_CONFIGURATION_INPUT
        ).json()
        version = first_client.post(
            f"/v1/strategy-drafts/{draft['draft_id']}/publish",
            json={"expected_revision": 1},
        ).json()

    second_app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(second_app, headers={"Origin": ORIGIN}) as second_client:
        recovered_draft = second_client.get(f"/v1/strategy-drafts/{draft['draft_id']}")
        recovered_version = second_client.get(
            f"/v1/strategy-configurations/{version['configuration_id']}"
        )

    assert recovered_draft.status_code == 200
    assert recovered_draft.json() == draft
    assert recovered_version.status_code == 200
    assert recovered_version.json() == version
