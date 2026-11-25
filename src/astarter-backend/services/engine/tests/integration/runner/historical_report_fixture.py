"""Synthetic actual-loader inputs and same-engine report capture, without persistence."""

from hashlib import sha256

from stark_trading_os.catalog.historical_catalog import canonical_historical_bytes
from stark_trading_os.runner.historical_input_adapter import load_historical_runner_input
from tests.integration.runner.sma_component_fixture import execute_sma_case, prepare_sma_case

CASES = {
    "warmup": ([100, 100, 110], {}, {}, (0, 0, 0, 2)),
    "entry": ([100, 100, 100, 110], {}, {}, (1, 1, 1, 4)),
    "round_trip": ([100, 100, 100, 110, 100, 90], {}, {}, (2, 2, 1, 6)),
    "denied": ([100, 100, 100, 110], {}, {"native_order_cap": "100"}, (1, 0, 0, 2)),
    "zero_volume": ([100, 100, 100, 110], {"volume": "0.000"}, {}, (1, 0, 0, 2)),
    "large_entry": (
        [100, 100, 100, 110],
        dict(quantity="1000", max_position="2000", cash="1000000", max_notional="1000000"),
        {},
        (1, 2, 1, 6),
    ),
    "zero_volume_reverse": (
        [100, 100, 100, 110, 100, 90],
        {"volume": "0.000"},
        {},
        (1, 0, 0, 2),
    ),
    "large_entry_reverse": (
        [100, 100, 100, 110, 100, 90],
        dict(quantity="1000", max_position="2000", cash="1000000", max_notional="1000000"),
        {},
        (2, 4, 1, 10),
    ),
}


def stage_prepared(tmp_path, prepared):
    run_id = "bt_" + "b" * 32
    stage = tmp_path / "runtime/staging" / run_id
    stage.mkdir(parents=True, mode=0o700)
    stage.parent.chmod(0o700)
    path = stage / "input-manifest.json"
    path.write_bytes(prepared[3])
    path.chmod(0o600)
    return dict(
        run_id=run_id,
        staging_dir=stage,
        input_manifest=path,
        expected_input_sha256=sha256(prepared[3]).hexdigest(),
    )


def capture_case(tmp_path, name):
    closes, params, execution, _ = CASES[name]
    prepared = prepare_sma_case(tmp_path, closes, **params)
    args = stage_prepared(tmp_path, prepared)
    captured = {"loaded": load_historical_runner_input(**args)}

    def capture(strategy, engine):
        venue = prepared[0].id.venue
        captured.update(
            component_snapshot_bytes=canonical_historical_bytes(strategy.finalize_component()),
            account_id=str(engine.cache.account_for_venue(venue).id),
            orders=engine.generate_orders_report(),
            fills=engine.generate_fills_report(),
            positions=engine.generate_positions_report(),
            account=engine.generate_account_report(venue),
        )

    execute_sma_case(prepared, after_run=capture, **execution)
    return captured
