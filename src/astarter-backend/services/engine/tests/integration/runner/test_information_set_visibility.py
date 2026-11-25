from __future__ import annotations

from pathlib import Path

from stark_trading_os.catalog.fixture_registry import FixtureRegistry

_FIXTURE_ROOT = Path(__file__).resolve().parents[5] / "data" / "fixtures"
_BASE_NS = 1_700_000_000_000_000_000
_DAY_NS = 86_400_000_000_000


def test_probe_fixture_has_cross_day_metrics_tie_adversary_and_end_sentinel() -> None:
    source = FixtureRegistry(_FIXTURE_ROOT).load("determinism-probe-v1")

    assert [record.source_seq for record in source.records] == list(range(1, 14))
    assert [int(record.ts_available_ns) for record in source.records] == [
        _BASE_NS,
        _BASE_NS + _DAY_NS,
        _BASE_NS + 2 * _DAY_NS,
        _BASE_NS + 3 * _DAY_NS,
        _BASE_NS + 4 * _DAY_NS,
        _BASE_NS + 5 * _DAY_NS,
        _BASE_NS + 5 * _DAY_NS,
        _BASE_NS + 6 * _DAY_NS,
        _BASE_NS + 7 * _DAY_NS,
        _BASE_NS + 8 * _DAY_NS,
        _BASE_NS + 9 * _DAY_NS,
        _BASE_NS + 10 * _DAY_NS,
        _BASE_NS + 11 * _DAY_NS,
    ]
    assert int(source.records[6].ts_event_ns) < int(source.records[5].ts_event_ns)
    assert source.records[6].ts_available_ns == source.records[5].ts_available_ns
