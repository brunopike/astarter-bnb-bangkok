from __future__ import annotations

from conftest import ORIGIN, ApiHarness, _dependencies, queued_run, seed_verified_cancelled_run
from fastapi.testclient import TestClient

from stark_trading_os.control.app import create_app
from tests.sqlite_corruption import open_corruption_connection


def test_unsealed_artifacts_are_read_only_metadata_and_never_downloadable(
    client: TestClient,
    draft: dict[str, object],
) -> None:
    run = queued_run(client, draft)
    index = client.get(f"/v1/backtests/{run['run_id']}/artifacts")
    assert index.status_code == 200
    assert index.json()["evidence_status"] == "PENDING"
    assert index.json()["publication_status"] is None
    assert index.json()["items"]
    assert all("status" not in item for item in index.json()["items"])
    assert all(item["downloadable"] is False for item in index.json()["items"])

    denied = client.get(f"/v1/backtests/{run['run_id']}/artifacts/run_record")
    assert denied.status_code == 409
    assert denied.json()["code"] == "ARTIFACT_UNVERIFIED"


def test_artifact_download_accepts_only_closed_public_names(
    client: TestClient,
    draft: dict[str, object],
) -> None:
    run = queued_run(client, draft)
    for name in ("../control.sqlite", "unknown", "reports%2Forders.json"):
        response = client.get(f"/v1/backtests/{run['run_id']}/artifacts/{name}")
        assert response.status_code in {404, 422}
        if response.status_code == 422:
            assert response.json()["code"] == "REQUEST_INVALID"

    unknown = client.get("/v1/backtests/missing/artifacts")
    assert unknown.status_code == 404
    assert unknown.json()["code"] == "RUN_UNKNOWN"


def test_persisted_staging_and_partial_states_never_enable_download(
    client: TestClient,
    api_harness: ApiHarness,
    draft: dict[str, object],
) -> None:
    run = queued_run(client, draft)
    for state in ("STAGING", "PARTIAL"):
        connection = open_corruption_connection(api_harness.database)
        try:
            connection.execute(
                "UPDATE runs SET evidence_status = ? WHERE run_id = ?",
                (state, run["run_id"]),
            )
            connection.commit()
        finally:
            connection.close()
        index = client.get(f"/v1/backtests/{run['run_id']}/artifacts")
        assert index.json()["evidence_status"] == state
        assert index.json()["publication_status"] == state
        assert not any(item["downloadable"] for item in index.json()["items"])

    connection = open_corruption_connection(api_harness.database)
    try:
        connection.execute(
            "UPDATE runs SET evidence_status = 'UNVERIFIED' WHERE run_id = ?",
            (run["run_id"],),
        )
        connection.commit()
    finally:
        connection.close()
    unverified = client.get(f"/v1/backtests/{run['run_id']}/artifacts")
    assert unverified.json()["evidence_status"] == "UNVERIFIED"
    assert unverified.json()["publication_status"] == "PARTIAL"
    assert not any(item["downloadable"] for item in unverified.json()["items"])


def test_verified_download_uses_recovery_and_rejects_later_tampering(
    api_harness: ApiHarness,
) -> None:
    expected = seed_verified_cancelled_run(api_harness, run_id="verified")
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as verified_client:
        runs_root = api_harness.runtime_root / "runs"
        run_id = next(path.name for path in runs_root.iterdir() if path.is_dir())
        index = verified_client.get(f"/v1/backtests/{run_id}/artifacts")
        assert index.status_code == 200
        assert index.json()["evidence_status"] == "VERIFIED"
        assert index.json()["publication_status"] == "VERIFIED"
        assert any(
            item["name"] == "run_record" and item["downloadable"] for item in index.json()["items"]
        )
        downloaded = verified_client.get(f"/v1/backtests/{run_id}/artifacts/run_record")
        assert downloaded.status_code == 200
        assert downloaded.content == expected

        root = runs_root / run_id
        record = root / "run-record.json"
        root.chmod(0o700)
        record.chmod(0o600)
        original = record.read_bytes()
        record.write_bytes(b"X" + original[1:])
        record.chmod(0o400)
        root.chmod(0o500)
        tampered = verified_client.get(f"/v1/backtests/{run_id}/artifacts/run_record")
        assert tampered.status_code == 409
        assert tampered.json()["code"] == "ARTIFACT_INTEGRITY_FAILED"
