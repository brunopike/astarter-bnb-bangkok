from pathlib import Path

from stark_trading_os.runner.compat_probe import run_compat_probe


def test_native_matching_produces_partial_then_terminal_fill(tmp_path: Path) -> None:
    first = run_compat_probe(tmp_path / "first")
    second = run_compat_probe(tmp_path / "second")

    assert first.order_status_path == second.order_status_path
    assert first.order_status_path[0] == "PARTIALLY_FILLED"
    assert first.order_status_path[-1] == "FILLED"
    assert first.order_status_path.count("PARTIALLY_FILLED") >= 1
