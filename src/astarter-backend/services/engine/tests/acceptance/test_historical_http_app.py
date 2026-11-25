"""The isolated acceptance factory must use its configured browser origin."""

from fastapi.testclient import TestClient

from tests.acceptance import historical_http_app


def test_factory_honors_explicit_origin_without_enabling_external_review(tmp_path, monkeypatch):
    project = tmp_path / "var/acceptance/origin-case/project"
    project.parent.mkdir(parents=True)
    monkeypatch.setattr(
        historical_http_app,
        "__file__",
        str(tmp_path / "services/engine/tests/acceptance/historical_http_app.py"),
    )
    monkeypatch.setenv("STARK_HISTORICAL_SMOKE_ROOT", str(project))
    monkeypatch.setenv("WEB_LOCAL_ORIGIN", "http://127.0.0.1:49541")
    monkeypatch.setenv("HISTORICAL_API_ENABLED", "0")
    app = historical_http_app.create_historical_acceptance_app()
    with TestClient(app) as client:
        response = client.get(
            "/v2/historical/capabilities", headers={"Origin": "http://127.0.0.1:49541"}
        )
        assert response.status_code == 200
        assert response.json()["enabled"] is False
        assert app.state.allow_external_agent_review is False
        assert (
            client.get(
                "/v2/historical/capabilities", headers={"Origin": "http://127.0.0.1:3000"}
            ).status_code
            == 403
        )
