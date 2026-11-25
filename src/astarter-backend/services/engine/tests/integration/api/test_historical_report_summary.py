"""A display summary is a projection of fresh verified native evidence."""

import asyncio
from hashlib import sha256

import pytest

from tests.integration.api.test_historical import (
    PREFIX,
    HistoricalHttpHarness,
    command,
    configure,
    drain,
    ready,
)
from tests.integration.runner.sma_component_fixture import prepare_sma_case


@pytest.fixture(name="historical_http")
def historical_http_fixture(tmp_path):
    *_, config = prepare_sma_case(tmp_path, [100, 100, 100, 110, 100, 90])
    return HistoricalHttpHarness(tmp_path, config)


async def completed(client, dependencies, config):
    _, version = await configure(client, config)
    receipt = (await ready(client, version)).json()
    queued = await client.post(
        PREFIX + "/runs", json=command(receipt), headers={"Idempotency-Key": "start"}
    )
    assert queued.status_code == 202, queued.text
    await drain(dependencies)
    return receipt


def summary_path(run_id):
    return PREFIX + f"/runs/{run_id}/report-summary"


def test_native_summary_uses_final_checkpoint_exact_values_and_original_bytes(historical_http):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            receipt = await completed(client, dependencies, historical_http.config)
            run_id = receipt["run_id"]
            before = tuple(dependencies.store._connection.iterdump())
            raw = await client.get(PREFIX + f"/runs/{run_id}/artifacts/historical_report")
            report = raw.json()
            response = await client.get(summary_path(run_id))
            assert response.status_code == 200, response.text
            value = response.json()
            assert value["run_id"] == run_id
            assert value["contract_kind"] == "HISTORICAL_SMA_V2"
            assert value["report_status"] == "INTERNAL_REPORT_CHECK_PASSED"
            assert value["report_validation"] == "COMPLETE_PASSED"
            assert value["verification"] == "FRESH_FULL_ROOT_AND_CONTROL_ANCHORS"
            assert value["input_manifest_sha256"] == receipt["input_manifest_sha256"]
            for field in (
                "configuration_content_sha256",
                "catalog_revision",
                "cost_sha256",
                "account_id",
            ):
                assert value[field] == report["identity"][field]
            assert value["report_sha256"] == sha256(raw.content).hexdigest()
            assert value["component_snapshot_sha256"] == report["component_snapshot_sha256"]
            assert value["table_counts"]["orders"] == 2
            assert value["table_counts"]["fills"] == 2
            assert value["consistency_failures"] == []
            final = value["final_cash"]
            assert final["phase"] == "FINAL_POST_RUN" and final["sequence"] == 6
            assert final["clock_ns"] == final["bar_ts_event"] == "1700000360000000000"
            assert final["balances"]["USDT"] == dict(total="979.8", free="979.8", locked="0")
            assert final["total_equity"]["USDT"] == "979.8"
            assert final["base_currency_equity"] is None
            assert final["position_count"] == final["pending_order_count"] == 0
            assert final["is_stale"] is False
            for field in (
                "realized_pnls",
                "unrealized_pnls",
                "total_pnls",
                "mark_values",
                "total_equity",
                "stale_instruments",
                "stale_currencies",
                "unpriced_instruments",
            ):
                assert final[field] == report["cash_series"]["points"][-1][field]
            index = (await client.get(PREFIX + f"/runs/{run_id}/artifacts")).json()
            assert value["evidence_anchor_sha256"] == index["evidence_anchor_sha256"]
            assert value["seal_sha256"] == index["seal_sha256"]
            assert tuple(dependencies.store._connection.iterdump()) == before
            assert (
                raw.content
                == (
                    historical_http.root / f"runtime/runs/{run_id}/reports/historical-report.json"
                ).read_bytes()
            )

    asyncio.run(exercise())


@pytest.mark.parametrize("state", ["pending", "legacy", "unknown", "disabled"])
def test_summary_has_no_fabricated_result_without_historical_publication(historical_http, state):
    async def exercise():
        async with historical_http.open(enabled=state != "disabled") as (client, dependencies):
            run_id = "bt_" + "a" * 32
            expected = (404, "RUN_UNKNOWN")
            if state == "pending":
                _, version = await configure(client, historical_http.config)
                run_id = (await ready(client, version)).json()["run_id"]
                expected = (409, "ARTIFACT_UNVERIFIED")
            elif state == "legacy":
                dependencies.store.reserve_run(run_id=run_id)
                expected = (409, "RUN_CONTRACT_UNSUPPORTED")
            elif state == "disabled":
                expected = (503, "CAPABILITY_DISABLED")
            before = tuple(dependencies.store._connection.iterdump())
            response = await client.get(summary_path(run_id))
            assert response.status_code == expected[0], response.text
            assert response.json().get("code") == expected[1]
            assert "final_cash" not in response.json()
            assert tuple(dependencies.store._connection.iterdump()) == before

    asyncio.run(exercise())


@pytest.mark.parametrize("damage", ["report", "unrelated_file", "anchor"])
def test_summary_rechecks_entire_root_and_independent_anchor(historical_http, damage):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            receipt = await completed(client, dependencies, historical_http.config)
            run_id = receipt["run_id"]
            if damage == "anchor":
                dependencies.store._connection.execute("DROP TRIGGER trg_seals_immutable_update")
                dependencies.store._connection.execute(
                    "UPDATE seals SET seal_digest=?", ("0" * 64,)
                )
            else:
                name = "reports/historical-report.json" if damage == "report" else "stderr.txt"
                path = historical_http.root / "runtime/runs" / run_id / name
                path.chmod(0o600)
                path.write_bytes(b"{}" if damage == "report" else b"unexpected")
                path.chmod(0o400)
            before = tuple(dependencies.store._connection.iterdump())
            response = await client.get(summary_path(run_id))
            assert response.status_code == 409, response.text
            assert response.json()["code"] == "ARTIFACT_INTEGRITY_FAILED"
            assert "final_cash" not in response.json()
            assert tuple(dependencies.store._connection.iterdump()) == before

    asyncio.run(exercise())


def test_no_report_is_404_only_after_validating_clean_cancel_root(historical_http):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            _, version = await configure(client, historical_http.config)
            receipt = (await ready(client, version)).json()
            control = dependencies.historical
            control.reserve(**command(receipt), idempotency_key="reserved-only")
            control.finalize_clean_cancel(
                dependencies.cancellation.request(
                    run_id=receipt["run_id"], idempotency_key="cancel", reason="operator"
                )
            )
            control._finalizer.finalize(receipt["run_id"])
            before = tuple(dependencies.store._connection.iterdump())
            response = await client.get(summary_path(receipt["run_id"]))
            assert response.status_code == 404, response.text
            assert response.json().get("code") == "REPORT_NOT_PRESENT"
            assert tuple(dependencies.store._connection.iterdump()) == before
            path = historical_http.root / "runtime/runs" / receipt["run_id"] / "stderr.txt"
            path.chmod(0o600)
            path.write_bytes(b"broken")
            path.chmod(0o400)
            damaged = await client.get(summary_path(receipt["run_id"]))
            assert damaged.status_code == 409
            assert damaged.json()["code"] == "ARTIFACT_INTEGRITY_FAILED"

    asyncio.run(exercise())


@pytest.mark.parametrize("mode", ["diagnostic", "failed", "stale"])
def test_real_diagnostic_and_failed_native_reports_remain_distinct(tmp_path, monkeypatch, mode):
    *_, config = prepare_sma_case(tmp_path, [100, 100, 100, 110], cash="110")
    harness = HistoricalHttpHarness(tmp_path, config)
    original = asyncio.create_subprocess_exec
    if mode == "diagnostic":
        script = (
            "import sys\nimport stark_trading_os.runner.historical_main as child\n"
            "from stark_trading_os.runner.historical_report_files import "
            "HistoricalReportPersistenceError\n"
            "persist=child.persist_historical_report_files\n"
            "def fail(**kwargs):\n"
            "    bundle=persist(**kwargs)\n"
            "    raise HistoricalReportPersistenceError(bundle.artifacts[:1])\n"
            "child.persist_historical_report_files=fail\nsys.exit(child.main())\n"
        )
    elif mode == "failed":
        script = (
            "import sys\nimport stark_trading_os.runner.historical_sma as sma\n"
            "from stark_trading_os.runner.historical_sma_policy import SmaGuardDecision\n"
            "from stark_trading_os.runner.historical_main import main\n"
            "sma.check_sma_intent=lambda **kwargs:SmaGuardDecision('ALLOW')\nsys.exit(main())\n"
        )
    else:
        # Native child, with a test-only stale final snapshot fault. The normal
        # report builder and independent parent verifier must still accept it as FAILED.
        script = (
            "import sys\nfrom stark_trading_os.runner.historical_sma import "
            "HistoricalSmaStrategy as S\n"
            "from stark_trading_os.runner.historical_main import main\n"
            "original=S._checkpoint\n"
            "def stale(self,phase):\n"
            "    row,state,pending=original(self,phase)\n"
            "    if phase=='FINAL_POST_RUN':\n"
            "        row['is_stale']=True\n"
            "        row['stale_currencies']=['USDT']\n"
            "        self._fail('NATIVE_SNAPSHOT_UNSUPPORTED')\n"
            "    return row,state,pending\n"
            "S._checkpoint=stale\nsys.exit(main())\n"
        )

    async def launch(*args, **kwargs):
        return await original(*args[:5], "-c", script, *args[7:], **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)

    async def exercise():
        async with harness.open() as (client, dependencies):
            receipt = await completed(client, dependencies, config)
            before = tuple(dependencies.store._connection.iterdump())
            response = await client.get(summary_path(receipt["run_id"]))
            if mode == "diagnostic":
                assert response.status_code == 404, response.text
                assert response.json().get("code") == "REPORT_NOT_PRESENT"
            else:
                assert response.status_code == 200, response.text
                value = response.json()
                assert value["report_validation"] == "COMPLETE_FAILED"
                assert value["report_status"] == "INTERNAL_REPORT_CHECK_FAILED"
                assert value["consistency_failures"]
                if mode == "stale":
                    assert value["final_cash"]["is_stale"] is True
                    assert value["final_cash"]["stale_currencies"] == ["USDT"]
                raw = await client.get(
                    PREFIX + f"/runs/{receipt['run_id']}/artifacts/historical_report"
                )
                assert (
                    value["final_cash"]["balances"]
                    == raw.json()["cash_series"]["points"][-1]["balances"]
                )
            assert tuple(dependencies.store._connection.iterdump()) == before

    asyncio.run(exercise())
