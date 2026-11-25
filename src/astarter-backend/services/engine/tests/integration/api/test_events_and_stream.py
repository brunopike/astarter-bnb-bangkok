from __future__ import annotations

from dataclasses import replace

from conftest import ORIGIN, ApiHarness, _dependencies, queued_run, seed_hidden_cancelled_run
from fastapi.testclient import TestClient

from stark_trading_os.control.app import create_app
from stark_trading_os.control.dependencies import ControlDependencies


def test_event_pages_are_visible_persisted_rows_with_strict_cursors(
    client: TestClient,
    draft: dict[str, object],
) -> None:
    run = queued_run(client, draft)
    endpoint = f"/v1/backtests/{run['run_id']}/events"

    first = client.get(endpoint, params={"after_seq": "0", "limit": 1})
    assert first.status_code == 200
    assert [item["seq"] for item in first.json()["items"]] == [1]
    assert first.json()["next_after_seq"] == 1

    second = client.get(endpoint, params={"after_seq": "1", "limit": 500})
    assert second.status_code == 200
    assert [item["seq"] for item in second.json()["items"]] == [2]
    assert second.json()["next_after_seq"] == 2

    for cursor in ("-1", "bogus", "3"):
        invalid = client.get(endpoint, params={"after_seq": cursor})
        assert invalid.status_code == 422
        assert invalid.json()["code"] == "CURSOR_INVALID"

    for limit in (0, 501):
        invalid = client.get(endpoint, params={"limit": limit})
        assert invalid.status_code == 422
        assert invalid.json()["code"] == "CURSOR_INVALID"

    unknown = client.get("/v1/backtests/missing/events")
    assert unknown.status_code == 404
    assert unknown.json()["code"] == "RUN_UNKNOWN"


def test_sse_replays_after_last_event_id_then_heartbeats_without_new_state(
    client: TestClient,
    draft: dict[str, object],
) -> None:
    run = queued_run(client, draft)
    before = client.get(f"/v1/backtests/{run['run_id']}").json()

    stream = client.get(
        "/v1/stream",
        params={"run_id": str(run["run_id"])},
        headers={"Last-Event-ID": "1"},
    )
    assert stream.status_code == 200
    assert stream.headers["content-type"].startswith("text/event-stream")
    assert "id: 2\n" in stream.text
    assert "event: run.queued\n" in stream.text
    assert ": heartbeat\n\n" in stream.text

    after = client.get(f"/v1/backtests/{run['run_id']}").json()
    assert (after["state_version"], after["last_visible_seq"]) == (
        before["state_version"],
        before["last_visible_seq"],
    )


def test_sse_rejects_invalid_unknown_and_unbacked_expired_cursors(
    client: TestClient,
    draft: dict[str, object],
) -> None:
    run = queued_run(client, draft)
    for cursor in ("-1", "bogus", "3"):
        response = client.get(
            "/v1/stream",
            params={"run_id": str(run["run_id"])},
            headers={"Last-Event-ID": cursor},
        )
        assert response.status_code == 422
        assert response.json()["code"] == "CURSOR_INVALID"
        assert response.json()["code"] != "CURSOR_EXPIRED"

    unknown = client.get("/v1/stream", params={"run_id": "missing"})
    assert unknown.status_code == 404
    assert unknown.json()["code"] == "RUN_UNKNOWN"


def test_sse_rejects_duplicate_and_empty_last_event_id(
    client: TestClient,
    draft: dict[str, object],
) -> None:
    run = queued_run(client, draft)
    for values in (("0", "1"), ("1", "0")):
        response = client.get(
            "/v1/stream",
            params={"run_id": str(run["run_id"])},
            headers=[
                ("Origin", ORIGIN),
                ("Last-Event-ID", values[0]),
                ("Last-Event-ID", values[1]),
            ],
        )
        assert response.status_code == 422
        assert response.json()["code"] == "CURSOR_INVALID"
    empty = client.get(
        "/v1/stream",
        params={"run_id": str(run["run_id"])},
        headers={"Last-Event-ID": ""},
    )
    assert empty.status_code == 422
    assert empty.json()["code"] == "CURSOR_INVALID"


def test_sse_returns_expired_only_from_injected_retention_authority(
    api_harness: ApiHarness,
    draft: dict[str, object],
) -> None:
    class RetentionFloor:
        def minimum_available_seq(self, run_id: str) -> int:
            assert run_id.startswith("bt_")
            return 2

    def dependencies_with_floor() -> ControlDependencies:
        return replace(
            _dependencies(api_harness),
            event_retention_floor=RetentionFloor(),
        )

    app = create_app(
        dependency_factory=dependencies_with_floor,
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as floor_client:
        run = queued_run(floor_client, draft)
        response = floor_client.get(
            "/v1/stream",
            params={"run_id": str(run["run_id"])},
            headers={"Last-Event-ID": "0"},
        )
        assert response.status_code == 410
        assert response.json()["code"] == "CURSOR_EXPIRED"


def test_hidden_persisted_event_is_absent_from_event_page_and_sse(
    api_harness: ApiHarness,
) -> None:
    run_id = seed_hidden_cancelled_run(api_harness, run_id="hidden")
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as hidden_client:
        page = hidden_client.get(f"/v1/backtests/{run_id}/events")
        visible = [item["seq"] for item in page.json()["items"]]
        assert visible
        assert max(visible) < 5
        stream = hidden_client.get("/v1/stream", params={"run_id": run_id})
        assert "id: 5\n" not in stream.text
        assert "event: run.cancelled\n" not in stream.text
