from __future__ import annotations

import pytest

from stark_trading_os.catalog.information_set import (
    InformationSetViolation,
    is_bar_visible,
    validate_evaluation_protocol,
    validate_information_set,
    validate_source_order,
)
from stark_trading_os.domain.models import CatalogSourceRecordV1, EvaluationProtocolV1


def quote(
    *,
    ts_event_ns: str = "100",
    ts_available_ns: str = "200",
    source_seq: int = 1,
    source_revision: str = "local-qa-v1",
    record_hash: str = "a" * 64,
) -> CatalogSourceRecordV1:
    return CatalogSourceRecordV1(
        instrument_id="ETH/USDT.SIM", bid_price="99.00", ask_price="100.00",
        bid_size="10.000", ask_size="10.000", ts_event_ns=ts_event_ns,
        ts_available_ns=ts_available_ns, source_seq=source_seq,
        source_revision=source_revision, record_hash=record_hash,
    )


def protocol(**overrides: object) -> EvaluationProtocolV1:
    value: dict[str, object] = {
        "schema": "EvaluationProtocol.v1", "mode": "explicit",
        "train": {"start_ns": "0", "end_ns": "20"},
        "tune": {"start_ns": "25", "end_ns": "40"},
        "out_of_sample": {"start_ns": "45", "end_ns": "60"},
        "purge_ns": "5", "embargo_ns": "5",
    }
    value.update(overrides)
    return EvaluationProtocolV1.model_validate(value)


def test_future_record_is_rejected_and_equal_cutoff_is_visible() -> None:
    with pytest.raises(InformationSetViolation, match="INFORMATION_SET_FUTURE"):
        validate_information_set([quote(ts_available_ns="201")], decision_ts_ns="200",
                                 source_revision="local-qa-v1")

    assert validate_information_set([quote()], decision_ts_ns="200",
                                    source_revision="local-qa-v1") == (quote(),)


def test_later_revision_and_bad_source_order_are_rejected_without_sorting() -> None:
    with pytest.raises(InformationSetViolation, match="SOURCE_REVISION_MISMATCH"):
        validate_information_set([quote(source_revision="later")], decision_ts_ns="200",
                                 source_revision="local-qa-v1")
    with pytest.raises(InformationSetViolation, match="SOURCE_ORDER_INVALID"):
        validate_source_order(
            [quote(source_seq=2, record_hash="b" * 64), quote(source_seq=1)],
            source_revision="local-qa-v1",
        )


def test_source_sequence_jumps_do_not_infer_gaps() -> None:
    records = [
        quote(ts_available_ns="200", source_seq=1),
        quote(ts_event_ns="500", ts_available_ns="900", source_seq=7, record_hash="b" * 64),
    ]
    assert validate_source_order(records, source_revision="local-qa-v1") == tuple(records)


@pytest.mark.parametrize(
    ("close_ns", "available_ns", "decision_ns", "visible"),
    [("100", "200", "200", True), ("201", "200", "200", False), ("100", "201", "200", False)],
)
def test_bar_requires_close_and_availability(
    close_ns: str, available_ns: str, decision_ns: str, visible: bool
) -> None:
    assert is_bar_visible(close_ns=close_ns, available_ns=available_ns,
                          decision_ts_ns=decision_ns) is visible


def test_explicit_windows_obey_catalog_purge_and_embargo() -> None:
    validate_evaluation_protocol(protocol(), catalog_start_ns="0", catalog_end_ns="60")
    with pytest.raises(InformationSetViolation, match="EVALUATION_WINDOW_RANGE"):
        validate_evaluation_protocol(protocol(), catalog_start_ns="1", catalog_end_ns="60")
    with pytest.raises(InformationSetViolation, match="EVALUATION_PURGE"):
        validate_evaluation_protocol(
            protocol(tune={"start_ns": "24", "end_ns": "40"}),
            catalog_start_ns="0", catalog_end_ns="60",
        )
    with pytest.raises(InformationSetViolation, match="EVALUATION_EMBARGO"):
        validate_evaluation_protocol(
            protocol(out_of_sample={"start_ns": "44", "end_ns": "60"}),
            catalog_start_ns="0", catalog_end_ns="60",
        )
    with pytest.raises(InformationSetViolation, match="EVALUATION_WINDOW_EMPTY"):
        validate_evaluation_protocol(
            protocol(train={"start_ns": "0", "end_ns": "0"}),
            catalog_start_ns="0", catalog_end_ns="60",
        )
    with pytest.raises(InformationSetViolation, match="EVALUATION_WINDOW_ORDER"):
        validate_evaluation_protocol(
            protocol(
                train={"start_ns": "40", "end_ns": "50"},
                tune={"start_ns": "10", "end_ns": "20"},
                out_of_sample={"start_ns": "50", "end_ns": "60"},
                purge_ns="0",
                embargo_ns="0",
            ),
            catalog_start_ns="0",
            catalog_end_ns="60",
        )


def test_fixture_only_shape_is_already_closed_by_domain_and_is_valid() -> None:
    fixture_only = EvaluationProtocolV1.model_validate(
        {"schema": "EvaluationProtocol.v1", "mode": "fixture_only", "train": None,
         "tune": None, "out_of_sample": None, "purge_ns": "0", "embargo_ns": "0"}
    )
    validate_evaluation_protocol(fixture_only, catalog_start_ns="0", catalog_end_ns="1")


def test_arbitrary_size_nanoseconds_preserve_information_set_order() -> None:
    lower = "1" + ("0" * 4_999)
    cutoff = "2" + ("0" * 4_999)
    future = "3" + ("0" * 4_999)
    visible = quote(ts_event_ns=lower, ts_available_ns=cutoff)

    assert validate_information_set(
        [visible], decision_ts_ns=cutoff, source_revision="local-qa-v1"
    ) == (visible,)
    assert is_bar_visible(
        close_ns=lower, available_ns=cutoff, decision_ts_ns=cutoff
    )
    assert not is_bar_visible(
        close_ns=lower, available_ns=future, decision_ts_ns=cutoff
    )
    with pytest.raises(InformationSetViolation, match="INFORMATION_SET_FUTURE"):
        validate_information_set(
            [quote(ts_event_ns=lower, ts_available_ns=future)],
            decision_ts_ns=cutoff,
            source_revision="local-qa-v1",
        )


def test_arbitrary_size_evaluation_purge_and_embargo_are_exact() -> None:
    one = "1" + ("0" * 4_999)
    two = "2" + ("0" * 4_999)
    four = "4" + ("0" * 4_999)
    five = "5" + ("0" * 4_999)
    seven = "7" + ("0" * 4_999)
    eight = "8" + ("0" * 4_999)
    catalog_end = "9" * 5_000
    exact = protocol(
        train={"start_ns": one, "end_ns": two},
        tune={"start_ns": four, "end_ns": five},
        out_of_sample={"start_ns": seven, "end_ns": eight},
        purge_ns=two,
        embargo_ns=two,
    )

    validate_evaluation_protocol(exact, catalog_start_ns=one, catalog_end_ns=catalog_end)

    with pytest.raises(InformationSetViolation, match="EVALUATION_PURGE"):
        validate_evaluation_protocol(
            exact.model_copy(update={"purge_ns": "3" + ("0" * 4_999)}),
            catalog_start_ns=one,
            catalog_end_ns=catalog_end,
        )
    with pytest.raises(InformationSetViolation, match="EVALUATION_EMBARGO"):
        validate_evaluation_protocol(
            exact.model_copy(update={"embargo_ns": "3" + ("0" * 4_999)}),
            catalog_start_ns=one,
            catalog_end_ns=catalog_end,
        )
