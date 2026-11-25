from pathlib import Path

from stark_trading_os.runner.compat_probe import run_compat_probe_in_child


def test_backtest_node_is_constructed_only_in_child_process(tmp_path: Path) -> None:
    result = run_compat_probe_in_child(tmp_path)

    assert result["parent_backtest_node_instances"] == 0
    assert result["child_process_id"] != __import__("os").getpid()
    assert result["child_backtest_node_instances"] == 1
    assert result["child_backtest_node_observations"] == (
        ("before_construction", 0, False),
        ("during_execution", 1, True),
        ("after_disposal", 1, False),
    )
    assert result["child_lifecycle_trace"] == ["node_constructed", "node_disposed"]


def test_cancel_probe_restricts_v0_1_to_signal_failure(tmp_path: Path) -> None:
    result = run_compat_probe_in_child(tmp_path, request_cancel=True)

    assert result["stdin_cancel_attempted"] is True
    assert result["strategy_callback_observed"] is True
    assert result["node_completed_after_strategy_stop"] is False
    assert result["failure_category"] == "strategy_stop_faulted_before_clean_outcome"
    assert result["failure_type"] is not None
    assert result["cooperative_cancel_proven"] is False
    assert result["cancel_mode"] == "SIGTERM/SIGKILL -> FAILED"
