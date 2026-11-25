"""Pure information-set checks for immutable catalog evidence."""

from __future__ import annotations

from collections.abc import Sequence

from stark_trading_os.domain.models import CatalogSourceRecordV1, EvaluationProtocolV1


class InformationSetViolation(ValueError):
    """A stable fail-closed information-set violation."""


def validate_source_order(
    records: Sequence[CatalogSourceRecordV1], *, source_revision: str
) -> tuple[CatalogSourceRecordV1, ...]:
    """Validate source identity and declared order without repairing it."""

    accepted = tuple(records)
    seen_hashes: set[str] = set()
    seen_identities: set[tuple[str, int]] = set()
    prior_key: tuple[tuple[int, str], int, str] | None = None
    prior_source_seq: int | None = None
    for record in accepted:
        if record.source_revision != source_revision:
            raise InformationSetViolation("SOURCE_REVISION_MISMATCH")
        if _nanosecond_key(record.ts_event_ns) > _nanosecond_key(
            record.ts_available_ns
        ):
            raise InformationSetViolation("EVENT_AFTER_AVAILABILITY")
        if record.record_hash in seen_hashes:
            raise InformationSetViolation("SOURCE_DUPLICATE_RECORD")
        identity = (record.source_revision, record.source_seq)
        if identity in seen_identities:
            raise InformationSetViolation("SOURCE_IDENTITY_CONFLICT")
        key = (
            _nanosecond_key(record.ts_available_ns),
            record.source_seq,
            record.record_hash,
        )
        if prior_key is not None and key < prior_key:
            raise InformationSetViolation("SOURCE_ORDER_INVALID")
        if prior_source_seq is not None and record.source_seq <= prior_source_seq:
            raise InformationSetViolation("SOURCE_SEQUENCE_INVALID")
        seen_hashes.add(record.record_hash)
        seen_identities.add(identity)
        prior_key = key
        prior_source_seq = record.source_seq
    return accepted


def validate_information_set(
    records: Sequence[CatalogSourceRecordV1],
    *,
    decision_ts_ns: str,
    source_revision: str,
) -> tuple[CatalogSourceRecordV1, ...]:
    """Return only when every supplied record is visible at the decision timestamp."""

    decision = _nanoseconds(decision_ts_ns, label="decision_ts_ns")
    accepted = validate_source_order(records, source_revision=source_revision)
    if any(
        _nanosecond_key(record.ts_available_ns) > _nanosecond_key(decision)
        for record in accepted
    ):
        raise InformationSetViolation("INFORMATION_SET_FUTURE")
    return accepted


def is_bar_visible(*, close_ns: str, available_ns: str, decision_ts_ns: str) -> bool:
    """A bar is visible only after both its close and availability timestamps."""

    close = _nanoseconds(close_ns, label="close_ns")
    available = _nanoseconds(available_ns, label="available_ns")
    decision = _nanoseconds(decision_ts_ns, label="decision_ts_ns")
    decision_key = _nanosecond_key(decision)
    return (
        _nanosecond_key(close) <= decision_key
        and _nanosecond_key(available) <= decision_key
    )


def validate_evaluation_protocol(
    protocol: EvaluationProtocolV1,
    *,
    catalog_start_ns: str,
    catalog_end_ns: str,
) -> None:
    """Validate explicit half-open evaluation windows against one catalog range."""

    catalog_start = _nanoseconds(catalog_start_ns, label="catalog_start_ns")
    catalog_end = _nanoseconds(catalog_end_ns, label="catalog_end_ns")
    catalog_start_key = _nanosecond_key(catalog_start)
    catalog_end_key = _nanosecond_key(catalog_end)
    if catalog_start_key >= catalog_end_key:
        raise InformationSetViolation("CATALOG_RANGE_EMPTY")
    if protocol.mode == "fixture_only":
        return

    assert protocol.train is not None
    assert protocol.tune is not None
    assert protocol.out_of_sample is not None
    windows = tuple(
        (
            _nanoseconds(window.start_ns, label="evaluation_start_ns"),
            _nanoseconds(window.end_ns, label="evaluation_end_ns"),
        )
        for window in (protocol.train, protocol.tune, protocol.out_of_sample)
    )
    window_keys = tuple(
        (_nanosecond_key(start), _nanosecond_key(end)) for start, end in windows
    )
    if any(start >= end for start, end in window_keys):
        raise InformationSetViolation("EVALUATION_WINDOW_EMPTY")
    if any(
        start < catalog_start_key or end > catalog_end_key
        for start, end in window_keys
    ):
        raise InformationSetViolation("EVALUATION_WINDOW_RANGE")
    train, tune, out_of_sample = window_keys
    if not (train[0] <= tune[0] <= out_of_sample[0]):
        raise InformationSetViolation("EVALUATION_WINDOW_ORDER")
    if train[1] > tune[0] or tune[1] > out_of_sample[0]:
        raise InformationSetViolation("EVALUATION_WINDOW_OVERLAP")
    purge = _nanoseconds(protocol.purge_ns, label="purge_ns")
    embargo = _nanoseconds(protocol.embargo_ns, label="embargo_ns")
    if _nanosecond_key(_add_nanoseconds(windows[0][1], purge)) > tune[0]:
        raise InformationSetViolation("EVALUATION_PURGE")
    if _nanosecond_key(_add_nanoseconds(windows[1][1], embargo)) > out_of_sample[0]:
        raise InformationSetViolation("EVALUATION_EMBARGO")


def _nanoseconds(value: str, *, label: str) -> str:
    if type(value) is not str or not value.isascii() or not value.isdigit():
        raise InformationSetViolation(f"{label.upper()}_INVALID")
    if len(value) > 1 and value.startswith("0"):
        raise InformationSetViolation(f"{label.upper()}_INVALID")
    return value


def _nanosecond_key(value: str) -> tuple[int, str]:
    return len(value), value


def _add_nanoseconds(left: str, right: str) -> str:
    left_index = len(left) - 1
    right_index = len(right) - 1
    carry = 0
    reversed_digits: list[str] = []
    while left_index >= 0 or right_index >= 0 or carry:
        left_digit = ord(left[left_index]) - ord("0") if left_index >= 0 else 0
        right_digit = ord(right[right_index]) - ord("0") if right_index >= 0 else 0
        total = left_digit + right_digit + carry
        reversed_digits.append(chr(ord("0") + (total % 10)))
        carry = total // 10
        left_index -= 1
        right_index -= 1
    return "".join(reversed(reversed_digits))
