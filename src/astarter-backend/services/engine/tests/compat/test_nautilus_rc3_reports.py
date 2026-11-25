import math
from pathlib import Path

import pandas as pd

from stark_trading_os.runner.compat_probe import _native_float_fields, run_compat_probe


def test_real_rc3_run_generates_all_reports_before_dispose(tmp_path: Path) -> None:
    result = run_compat_probe(tmp_path)

    assert result.orders is not None
    assert result.fills is not None
    assert result.positions is not None
    assert result.account is not None
    assert result.fills.empty is False
    assert result.metrics_source == {
        "summary",
        "stats_general",
        "stats_pnls",
        "stats_returns",
    }


def test_native_float_fields_are_characterized_for_task_three(tmp_path: Path) -> None:
    result = run_compat_probe(tmp_path)

    assert math.isfinite(result.native_float_fields["stats_general.Long Ratio"])
    assert math.isnan(result.native_float_fields["stats_pnls.USDT.Avg Winner"])
    assert all(isinstance(value, float) for value in result.native_float_fields.values())


def test_dataframe_float_characterization_retains_named_nan_values() -> None:
    fields = _native_float_fields(
        {"stats_general": {"Long Ratio": 1.0}},
        pd.DataFrame({"native_price": [float("nan"), 100.0]}),
    )

    assert math.isfinite(fields["stats_general.Long Ratio"])
    assert math.isnan(fields["report_0.native_price[0]"])
    assert math.isfinite(fields["report_0.native_price[1]"])
