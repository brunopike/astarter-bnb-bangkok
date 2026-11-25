from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path

import pytest
from pydantic import ValidationError

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.catalog.fixture_publisher import FixturePublisher
from stark_trading_os.catalog.fixture_registry import FixtureRegistry
from stark_trading_os.catalog.historical_source import validate_historical_source
from stark_trading_os.control.preflight import (
    EngineIdentity,
    PreflightService,
    RegisteredDefinition,
)
from stark_trading_os.control.preflight_contract import UNIX_EPOCH_NS_MAX
from stark_trading_os.control.registry import (
    CatalogConflict,
    CatalogIntegrityFailed,
    CatalogPublication,
    CatalogRecoveryBlocked,
    CatalogStorageFailed,
    ControlStore,
)
from stark_trading_os.domain.models import BacktestDraftRequest, RunState

REPOSITORY_ROOT = Path(__file__).parents[5]


class StepClock:
    def __init__(self, start: int = 1_800_000_000_000_000_000) -> None:
        self.next_value = start
        self.calls = 0

    def __call__(self) -> int:
        value = self.next_value
        self.next_value += 1
        self.calls += 1
        return value


class SequentialIds:
    def __init__(self, prefix: str) -> None:
        self.prefix = prefix
        self.calls = 0

    def __call__(self) -> str:
        self.calls += 1
        return f"{self.prefix}_{self.calls:03d}"


class MissingCatalog:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def revalidate(self, catalog_revision: str) -> object:
        self.calls.append(catalog_revision)
        raise CatalogConflict


class FailingCatalog:
    def __init__(self, error: BaseException) -> None:
        self.error = error

    def revalidate(self, catalog_revision: str) -> object:
        del catalog_revision
        raise self.error


class ReturningCatalog:
    def __init__(self, publication: CatalogPublication) -> None:
        self.publication = publication
        self.calls: list[str] = []

    def revalidate(self, catalog_revision: str) -> CatalogPublication:
        self.calls.append(catalog_revision)
        return self.publication


def supported_cost_fill() -> dict[str, object]:
    return {
        "schema": "CostFillModel.v1",
        "fee": {
            "model": "MakerTakerFeeModel",
            "rate_source": "INSTRUMENT_MAKER_TAKER",
            "rate_unit": "NOTIONAL_DECIMAL_FRACTION",
            "charge_currency": "INSTRUMENT_QUOTE_CURRENCY",
            "minimum_fee": "0",
            "application": "PER_FILL",
            "decimal_precision": 8,
            "rounding_mode": "MIDPOINT_NEAREST_EVEN",
        },
        "spread": {"authority": "FIXTURE_BID_ASK"},
        "slippage": {
            "model": "DefaultFillModel",
            "prob_fill_on_limit": "1",
            "prob_slippage": "0",
            "random_seed_source": "INPUT_MANIFEST_REPLAY_SEED",
            "probabilistic_slippage": "DISABLED",
            "depth_price_impact": "DISABLED",
            "maximum_book_walk_ticks": "0",
        },
        "latency": {
            "model": "StaticLatencyModel",
            "decision_to_submit_ns": "0",
            "submit_to_venue_ns": "0",
            "base_latency_ns": "0",
            "insert_latency_ns": "0",
            "update_latency_ns": "0",
            "cancel_latency_ns": "0",
        },
        "liquidity": {
            "available_size_source": "RECORDED_QUOTE_TICK_BID_ASK_SIZE",
            "queue_assumption": "NOT_MODELED_AT_L1",
            "allocation_order": "SINGLE_ORDER_NO_ALLOCATION_COMPETITION",
            "partial_fill_schedule": "ON_RECORDED_QUOTE",
            "price_selection": "NATIVE_L1_BID_ASK_CROSS",
            "allow_partial_fills": True,
            "liquidity_consumption": True,
        },
        "cancel": {
            "acknowledgment_rule": "NATIVE",
            "remaining_quantity_disposition": "CANCEL_OPEN_REMAINDER",
            "time_in_force": "GTC",
        },
    }


def valid_draft(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "environment": "BACKTEST",
        "strategy_ref": "determinism-probe@v1",
        "catalog_revision": "a" * 64,
        "window": {"start_ns": "1700000000000000000", "end_ns": "1700000000000000002"},
        "information_set_policy": {
            "schema": "InformationSetPolicy.v1",
            "availability_field": "ts_available_ns",
            "nautilus_timestamp_field": "ts_init",
            "visibility_rule": "AVAILABLE_AT_OR_BEFORE_DECISION",
            "tie_breakers": ["ts_available_ns", "source_seq", "record_hash"],
            "bar_rule": "CLOSED_AND_AVAILABLE",
            "source_revision_rule": "SINGLE_IMMUTABLE_REVISION",
        },
        "evaluation_protocol": {
            "schema": "EvaluationProtocol.v1",
            "mode": "fixture_only",
            "train": None,
            "tune": None,
            "out_of_sample": None,
            "purge_ns": "0",
            "embargo_ns": "0",
        },
        "venue_account_model": {
            "venue_id": "SIM",
            "oms_type": "HEDGING",
            "account_type": "MARGIN",
            "book_type": "L1_MBP",
            "routing": False,
            "use_random_ids": False,
            "use_position_ids": True,
            "allow_cash_borrowing": False,
            "starting_balance": "1000000",
            "currency": "USDT",
        },
        "cost_fill_model": supported_cost_fill(),
        "risk_policy_ref": "probe-risk@v1",
        "replay_seed": 7,
    }
    value.update(overrides)
    return value


def _definition(identifier: str, version: str, value: dict[str, object]) -> RegisteredDefinition:
    raw = canonical_json_bytes(value)
    return RegisteredDefinition(
        identifier=identifier,
        version=version,
        canonical_bytes=raw,
        sha256=sha256(raw).hexdigest(),
    )


def _historical_source():
    csv_bytes = (
        b"open_time_ns,close_time_ns,available_time_ns,open,high,low,close,volume\n"
        b"1700000000000000000,1700000060000000000,1700000060000000000,"
        b"100.00,110.00,90.00,105.00,100.000\n"
    )
    metadata = {
        "schema": "HistoricalBarSource.v1",
        "source": {
            "name": "Synthetic preflight boundary bars",
            "origin": "generated test input; not market data",
            "retrieved_at_ns": "1700000300000000000",
            "raw_sha256": sha256(csv_bytes).hexdigest(),
        },
        "instrument": {
            "market": "SYNTHETIC",
            "raw_symbol": "ETHUSDT",
            "base_currency": "ETH",
            "quote_currency": "USDT",
            "price_precision": 2,
            "size_precision": 3,
            "price_increment": "0.01",
            "size_increment": "0.001",
            "minimum_quantity": "0.001",
            "specification_source": "test assumptions",
            "specification_status": "EXPLICIT_ASSUMPTION",
        },
        "timeframe_ns": "60000000000",
        "timestamp_mapping": "UTC nanoseconds, half-open, available at close",
        "availability_source": "ASSUMED_AT_CLOSE",
        "purpose": "SYNTHETIC_QA",
    }
    return validate_historical_source(
        csv_bytes,
        json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode(),
        now_ns=1_700_000_400_000_000_000,
    )


def _service(
    tmp_path: Path,
    *,
    engine: EngineIdentity | None = None,
    strategy: RegisteredDefinition | None = None,
    risk: RegisteredDefinition | None = None,
) -> tuple[PreflightService, ControlStore, MissingCatalog, StepClock, SequentialIds, SequentialIds]:
    control = ControlStore.open(tmp_path / "control.sqlite", clock=StepClock(10_000))
    catalog = MissingCatalog()
    clock = StepClock()
    run_ids = SequentialIds("bt")
    preflight_ids = SequentialIds("pf")
    strategy_definition = strategy or _definition(
        "determinism-probe",
        "v1",
        {
            "entry_limit_price": "100",
            "entry_quantity": "15",
            "metric_round_trip_quantity": "1",
            "metric_round_trips": 5,
            "risk_probe_quantity": "20",
            "venue_rejection_quantity": "1",
        },
    )
    risk_definition = risk or _definition("probe-risk", "v1", {"max_notional": "1600"})
    service = PreflightService(
        control=control,
        catalog=catalog,
        engine=engine
        or EngineIdentity(
            package_version="2.0.0rc3",
            tag_commit="648970ce64a304d93da0a29320cb6e19b905fa39",
            python_version="3.12.4",
            precision_mode="FIXED_PRECISION_16",
        ),
        strategy_resolver=lambda ref: (
            strategy_definition if ref == "determinism-probe@v1" else None
        ),
        risk_resolver=lambda ref: risk_definition if ref == "probe-risk@v1" else None,
        clock=clock,
        run_id_factory=run_ids,
        preflight_id_factory=preflight_ids,
        token_ttl_ns=100,
        run_root=tmp_path,
    )
    return service, control, catalog, clock, run_ids, preflight_ids


@pytest.mark.parametrize(
    ("missing", "code"),
    [
        ("fee", "COST_FEE_MISSING"),
        ("spread", "COST_SPREAD_MISSING"),
        ("slippage", "COST_SLIPPAGE_MISSING"),
        ("latency", "COST_LATENCY_MISSING"),
        ("liquidity", "FILL_LIQUIDITY_MISSING"),
        ("cancel", "FILL_CANCEL_MISSING"),
        ("venue_account_model", "BALANCE_MODEL_MISSING"),
        ("risk_policy_ref", "RISK_POLICY_MISSING"),
    ],
)
def test_preflight_persists_blocked_for_each_missing_semantic_section(
    tmp_path: Path, missing: str, code: str
) -> None:
    raw = valid_draft()
    if missing in {"venue_account_model", "risk_policy_ref"}:
        raw[missing] = None
    else:
        costs = raw["cost_fill_model"]
        assert isinstance(costs, dict)
        costs[missing] = None
    draft = BacktestDraftRequest.model_validate(raw)
    service, control, _catalog, _clock, _run_ids, _preflight_ids = _service(tmp_path)

    try:
        result = service.run(draft, idempotency_key=f"missing-{missing}")

        assert result.state is RunState.PREFLIGHT_BLOCKED
        assert code in {check.code for check in result.checks if not check.passed}
        assert result.input_manifest_hash is None
        assert result.catalog_revision is None
        snapshot = control.run(result.run_id)
        assert snapshot.state is RunState.PREFLIGHT_BLOCKED
        assert snapshot.input_manifest_bytes is None
        stored = control.preflight(result.preflight_id)
        assert stored is not None
        assert stored.input_manifest_bytes is None
        assert stored.engine_package_version is None
        assert stored.risk_policy_hash is None
    finally:
        control.close()


def test_preflight_checks_share_one_authoritative_timestamp_and_closed_evidence(
    tmp_path: Path,
) -> None:
    service, control, _catalog, clock, _run_ids, _preflight_ids = _service(tmp_path)
    checked_at_ns = 1_800_000_000_000_000_000
    clock.next_value = checked_at_ns

    try:
        result = service.run(
            BacktestDraftRequest.model_validate(valid_draft()),
            idempotency_key="authoritative-check-evidence",
        )

        assert clock.calls == 1
        assert {getattr(check, "checked_at_ns", None) for check in result.checks} == {checked_at_ns}
        assert all(
            isinstance(getattr(check, "explanation", None), str)
            and bool(getattr(check, "explanation", "").strip())
            for check in result.checks
        )
        assert all(
            isinstance(getattr(check, "evidence", None), tuple)
            and bool(getattr(check, "evidence", ()))
            and all(
                isinstance(getattr(fact, "name", None), str)
                and bool(getattr(fact, "name", "").strip())
                and isinstance(getattr(fact, "value", None), str)
                and bool(getattr(fact, "value", "").strip())
                for fact in getattr(check, "evidence", ())
            )
            for check in result.checks
        )

        engine = next(check for check in result.checks if check.code == "ENGINE_VERSION_VALID")
        assert getattr(engine, "explanation", None) == (
            "The installed Nautilus package version matches the locked engine pin."
        )
        assert [
            (getattr(fact, "name", None), getattr(fact, "value", None))
            for fact in getattr(engine, "evidence", ())
        ] == [
            ("expected_version", "2.0.0rc3"),
            ("observed_version", "2.0.0rc3"),
        ]

        catalog = next(check for check in result.checks if check.code == "CATALOG_UNKNOWN")
        assert getattr(catalog, "explanation", None) == (
            "The requested catalog revision is not registered."
        )
        assert [
            (getattr(fact, "name", None), getattr(fact, "value", None))
            for fact in getattr(catalog, "evidence", ())
        ] == [
            ("catalog_revision", "a" * 64),
            ("lookup_status", "NOT_FOUND"),
        ]
    finally:
        control.close()


@pytest.mark.parametrize(
    "invalid_clock_value",
    [
        1_800_000_000,
        1_800_000_000_000,
        1_800_000_000_000_000,
        True,
        -1,
        9_223_372_036_854_775_808,
    ],
    ids=["seconds", "milliseconds", "microseconds", "bool", "negative", "int64-overflow"],
)
def test_preflight_rejects_non_epoch_nanosecond_clock_values(
    tmp_path: Path,
    invalid_clock_value: object,
) -> None:
    service, control, _catalog, clock, _run_ids, _preflight_ids = _service(tmp_path)
    clock.next_value = invalid_clock_value  # type: ignore[assignment]

    try:
        with pytest.raises(ValueError, match="Unix epoch nanoseconds"):
            service.run(
                BacktestDraftRequest.model_validate(valid_draft()),
                idempotency_key=f"invalid-clock-{type(invalid_clock_value).__name__}",
            )
    finally:
        control.close()


@pytest.mark.parametrize(
    "checked_at_ns",
    [UNIX_EPOCH_NS_MAX - 99, UNIX_EPOCH_NS_MAX],
    ids=["first-overflow", "maximum"],
)
def test_preflight_rejects_expiry_overflow_before_mutable_authority_reads(
    tmp_path: Path,
    checked_at_ns: int,
) -> None:
    service, control, catalog, clock, run_ids, preflight_ids = _service(tmp_path)
    strategy_calls: list[str] = []
    risk_calls: list[str] = []

    def strategy_resolver(reference: str) -> RegisteredDefinition | None:
        strategy_calls.append(reference)
        return None

    def risk_resolver(reference: str) -> RegisteredDefinition | None:
        risk_calls.append(reference)
        return None

    service._strategy_resolver = strategy_resolver
    service._risk_resolver = risk_resolver
    clock.next_value = checked_at_ns

    try:
        with pytest.raises((ValueError, OverflowError)) as captured:
            service.run(
                BacktestDraftRequest.model_validate(valid_draft()),
                idempotency_key="expiry-overflow",
            )

        assert catalog.calls == []
        assert strategy_calls == []
        assert risk_calls == []
        assert run_ids.calls == 0
        assert preflight_ids.calls == 0
        for table in ("runs", "preflights", "events", "idempotency_records"):
            assert control._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
        assert type(captured.value) is ValueError
        assert str(captured.value).startswith("Preflight expiry must be Unix epoch nanoseconds")
    finally:
        control.close()


def test_preflight_accepts_last_expiry_that_fits_signed_int64(tmp_path: Path) -> None:
    service, control, _catalog, clock, _run_ids, _preflight_ids = _service(tmp_path)
    checked_at_ns = UNIX_EPOCH_NS_MAX - 100
    clock.next_value = checked_at_ns

    try:
        result = service.run(
            BacktestDraftRequest.model_validate(valid_draft()),
            idempotency_key="last-safe-expiry",
        )

        assert result.expires_at_ns == UNIX_EPOCH_NS_MAX
        assert {check.checked_at_ns for check in result.checks} == {checked_at_ns}
        stored = control.preflight(result.preflight_id)
        assert stored is not None and stored.expires_at_ns == UNIX_EPOCH_NS_MAX
    finally:
        control.close()


def test_catalog_failure_evidence_is_bound_and_sanitized(tmp_path: Path) -> None:
    service, control, _catalog, clock, _run_ids, _preflight_ids = _service(tmp_path)
    clock.next_value = 1_800_000_000_000_000_000
    authority_revision = "c" * 64
    leaked_context = "raw catalog exception /private/tmp/catalog OPENAI_API_KEY=sk-live-secret"
    service._catalog = FailingCatalog(OSError(leaked_context))

    try:
        result = service.run(
            BacktestDraftRequest.model_validate(valid_draft(catalog_revision=authority_revision)),
            idempotency_key="sanitized-catalog-failure",
        )
        check = next(item for item in result.checks if item.code == "CATALOG_UNREADABLE")
        facts = [
            (getattr(fact, "name", None), getattr(fact, "value", None))
            for fact in getattr(check, "evidence", ())
        ]

        assert facts == [
            ("catalog_revision", authority_revision),
            ("read_status", "UNREADABLE"),
        ]
        rendered = repr(
            (
                getattr(check, "explanation", None),
                facts,
            )
        )
        for forbidden in (
            leaked_context,
            sha256(leaked_context.encode("utf-8")).hexdigest(),
            "/private/tmp/catalog",
            "OPENAI_API_KEY",
            "sk-live-secret",
        ):
            assert forbidden not in rendered
    finally:
        control.close()


def test_schema_invalid_catalog_bytes_never_expose_an_unsafe_digest(
    tmp_path: Path,
) -> None:
    requested_revision = "a" * 64
    unsafe_marker = b"OPENAI_" + b"API_KEY"
    unsafe_bytes = b'{"schema":"CatalogManifest.v1","unexpected":"' + unsafe_marker + b'"}'
    unsafe_digest = sha256(unsafe_bytes).hexdigest()
    service, control, _catalog, clock, _run_ids, _preflight_ids = _service(tmp_path)
    catalog = ReturningCatalog(
        CatalogPublication(
            catalog_revision=requested_revision,
            fixture_id="local-qa-v1",
            status="PUBLISHED",
            inventory_hash="c" * 64,
            publication_bytes=unsafe_bytes,
            staging_identity=f"prepared-{requested_revision}",
            prepared_at_ns=1,
            published_at_ns=2,
            audit_intent_bytes=b"{}",
        )
    )
    service._catalog = catalog
    draft = BacktestDraftRequest.model_validate(valid_draft())

    try:
        first = service.run(draft, idempotency_key="unsafe-catalog-bytes")
        check = next(item for item in first.checks if item.code == "CATALOG_INTEGRITY_FAILED")
        assert first.state is RunState.PREFLIGHT_BLOCKED
        assert [(fact.name, fact.value) for fact in check.evidence] == [
            ("requested_revision", requested_revision),
            ("observed_revision", requested_revision),
            ("observed_status", "PUBLISHED"),
            ("publication_bytes_sha256", "UNAVAILABLE"),
            ("declared_inventory_digest", "c" * 64),
            ("observed_inventory_digest", "UNAVAILABLE"),
            ("integrity_status", "FAILED"),
        ]
        stored = control.preflight(first.preflight_id)
        assert stored is not None
        exact_bytes = stored.result_bytes
        assert unsafe_marker not in exact_bytes
        assert unsafe_digest.encode("ascii") not in exact_bytes
        calls = list(catalog.calls)
        clock_calls = clock.calls

        assert service.run(draft, idempotency_key="unsafe-catalog-bytes") == first
        replayed = control.preflight(first.preflight_id)
        assert replayed is not None and replayed.result_bytes == exact_bytes
        assert catalog.calls == calls
        assert clock.calls == clock_calls
    finally:
        control.close()


def test_schema_valid_catalog_bytes_retain_their_actual_digest(tmp_path: Path) -> None:
    service, control, _catalog, clock, _run_ids, _preflight_ids = _service(tmp_path)
    publisher = FixturePublisher(
        registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
        control=control,
        runtime_root=tmp_path / "runtime",
    )
    publication = publisher.publish("local-qa-v1")
    catalog = ReturningCatalog(publication)
    service._catalog = catalog
    draft = BacktestDraftRequest.model_validate(valid_draft())

    try:
        first = service.run(draft, idempotency_key="valid-catalog-digest")
        check = next(item for item in first.checks if item.code == "CATALOG_INTEGRITY_FAILED")
        assert first.state is RunState.PREFLIGHT_BLOCKED
        assert ("publication_bytes_sha256", sha256(publication.publication_bytes).hexdigest()) in [
            (fact.name, fact.value) for fact in check.evidence
        ]
        stored = control.preflight(first.preflight_id)
        assert stored is not None
        exact_bytes = stored.result_bytes
        calls = list(catalog.calls)
        clock_calls = clock.calls

        assert service.run(draft, idempotency_key="valid-catalog-digest") == first
        replayed = control.preflight(first.preflight_id)
        assert replayed is not None and replayed.result_bytes == exact_bytes
        assert catalog.calls == calls
        assert clock.calls == clock_calls
    finally:
        control.close()


def test_valid_v2_catalog_is_cleanly_blocked_without_mutating_publication(
    tmp_path: Path,
) -> None:
    service, control, _catalog, _clock, _run_ids, _preflight_ids = _service(tmp_path)
    publisher = FixturePublisher(
        registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
        control=control,
        runtime_root=tmp_path / "runtime",
    )
    source = _historical_source()
    publication = publisher.publish_historical(source)
    service._catalog = ReturningCatalog(publication)
    draft = BacktestDraftRequest.model_validate(
        valid_draft(catalog_revision=publication.catalog_revision)
    )

    try:
        result = service.run(draft, idempotency_key="v2-catalog-not-runnable")

        assert result.state is RunState.PREFLIGHT_BLOCKED
        assert any(check.code == "CATALOG_INTEGRITY_FAILED" for check in result.checks)
        retained = control.catalog_publication(publication.catalog_revision)
        assert retained is not None and retained.status == "PUBLISHED"
        assert publisher.revalidate(publication.catalog_revision) == publication
    finally:
        control.close()


@pytest.mark.parametrize(
    (
        "observed_revision",
        "observed_status",
        "expected_observed_status",
        "code",
        "status_fact",
    ),
    [
        (
            "b" * 64,
            "PUBLISHED",
            "PUBLISHED",
            "CATALOG_INTEGRITY_FAILED",
            ("integrity_status", "FAILED"),
        ),
        (
            "a" * 64,
            "PREPARED",
            "PREPARED",
            "CATALOG_NOT_PUBLISHED",
            ("publication_status", "NOT_PUBLISHED"),
        ),
        (
            "a" * 64,
            "INTEGRITY_FAILED",
            "INTEGRITY_FAILED",
            "CATALOG_INTEGRITY_FAILED",
            ("integrity_status", "FAILED"),
        ),
        (
            "a" * 64,
            "INVALID_STATUS",
            "INVALID_STATUS",
            "CATALOG_INTEGRITY_FAILED",
            ("integrity_status", "FAILED"),
        ),
        (
            "a" * 64,
            ["INVALID_STATUS"],
            "INVALID_RESPONSE",
            "CATALOG_INTEGRITY_FAILED",
            ("integrity_status", "FAILED"),
        ),
    ],
)
def test_returned_catalog_mismatch_preserves_safe_actual_facts_and_replays(
    tmp_path: Path,
    observed_revision: str,
    observed_status: object,
    expected_observed_status: str,
    code: str,
    status_fact: tuple[str, str],
) -> None:
    requested_revision = "a" * 64
    service, control, _catalog, clock, _run_ids, _preflight_ids = _service(tmp_path)
    publication = CatalogPublication(
        catalog_revision=observed_revision,
        fixture_id="local-qa-v1",
        status=observed_status,  # type: ignore[arg-type]
        inventory_hash="c" * 64,
        publication_bytes=b"{}",
        staging_identity=f"prepared-{observed_revision}",
        prepared_at_ns=1,
        published_at_ns=2 if observed_status == "PUBLISHED" else None,
        audit_intent_bytes=b"{}" if observed_status == "PUBLISHED" else None,
    )
    catalog = ReturningCatalog(publication)
    service._catalog = catalog
    draft = BacktestDraftRequest.model_validate(valid_draft())
    key = f"returned-catalog-{expected_observed_status.lower()}-{observed_revision[:1]}"

    try:
        first = service.run(draft, idempotency_key=key)
        check = next(item for item in first.checks if item.code == code)
        assert first.state is RunState.PREFLIGHT_BLOCKED
        expected_facts = [
            ("requested_revision", requested_revision),
            ("observed_revision", observed_revision),
            ("observed_status", expected_observed_status),
        ]
        if code == "CATALOG_INTEGRITY_FAILED":
            expected_facts.extend(
                [
                    ("publication_bytes_sha256", "UNAVAILABLE"),
                    ("declared_inventory_digest", "c" * 64),
                    ("observed_inventory_digest", "UNAVAILABLE"),
                ]
            )
        expected_facts.append(status_fact)
        assert [(fact.name, fact.value) for fact in check.evidence] == expected_facts
        stored = control.preflight(first.preflight_id)
        assert stored is not None
        exact_bytes = stored.result_bytes
        calls = list(catalog.calls)
        clock_calls = clock.calls

        assert service.run(draft, idempotency_key=key) == first
        replayed = control.preflight(first.preflight_id)
        assert replayed is not None and replayed.result_bytes == exact_bytes
        assert catalog.calls == calls
        assert clock.calls == clock_calls
    finally:
        control.close()


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value.update({"surprise": True}),
        lambda value: value.update({"replay_seed": 7.0}),
        lambda value: value["cost_fill_model"].update({"schema": "Wrong.v1"}),
        lambda value: value["cost_fill_model"]["fee"].update({"minimum_fee": 0.0}),
    ],
)
def test_malformed_float_and_unknown_inputs_remain_request_invalid(
    mutation: object,
) -> None:
    raw = valid_draft()
    assert callable(mutation)
    mutation(raw)

    with pytest.raises(ValidationError):
        BacktestDraftRequest.model_validate(raw)


@pytest.mark.parametrize("seed", [True, -1, 2**64])
def test_replay_seed_rejects_bool_negative_and_u64_overflow_before_native_mapping(
    seed: object,
) -> None:
    with pytest.raises(ValidationError):
        BacktestDraftRequest.model_validate(valid_draft(replay_seed=seed))


@pytest.mark.parametrize(
    ("section", "field", "value"),
    [
        ("fee", "model", "FixedFeeModel"),
        ("fee", "decimal_precision", 6),
        ("spread", "authority", "SYNTHETIC"),
        ("slippage", "probabilistic_slippage", "ENABLED"),
        ("slippage", "prob_slippage", "0.1"),
        ("latency", "insert_latency_ns", "1"),
        ("liquidity", "available_size_source", "NATIVE_SYNTHETIC_BOOK"),
        ("liquidity", "liquidity_consumption", False),
        ("cancel", "time_in_force", "IOC"),
    ],
)
def test_structurally_valid_but_unsupported_native_combinations_are_blocked(
    tmp_path: Path, section: str, field: str, value: object
) -> None:
    raw = valid_draft()
    costs = raw["cost_fill_model"]
    assert isinstance(costs, dict)
    policy = costs[section]
    assert isinstance(policy, dict)
    policy[field] = value
    draft = BacktestDraftRequest.model_validate(raw)
    service, control, _catalog, _clock, _run_ids, _preflight_ids = _service(tmp_path)

    try:
        result = service.run(draft, idempotency_key=f"unsupported-{section}-{field}")
        assert result.state is RunState.PREFLIGHT_BLOCKED
        assert "UNSUPPORTED_COST_FILL_MODEL" in {
            check.code for check in result.checks if not check.passed
        }
    finally:
        control.close()


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"strategy_ref": "unknown@v1"}, "STRATEGY_UNKNOWN"),
        ({"risk_policy_ref": "unknown@v1"}, "RISK_POLICY_UNKNOWN"),
        (
            {
                "venue_account_model": {
                    "venue_id": "SIM",
                    "oms_type": "HEDGING",
                    "account_type": "MARGIN",
                    "book_type": "L1_MBP",
                    "routing": False,
                    "use_random_ids": False,
                    "use_position_ids": True,
                    "allow_cash_borrowing": False,
                    "starting_balance": "0",
                    "currency": "USDT",
                }
            },
            "BALANCE_INVALID",
        ),
        (
            {
                "venue_account_model": {
                    "venue_id": "SIM",
                    "oms_type": "HEDGING",
                    "account_type": "MARGIN",
                    "book_type": "L1_MBP",
                    "routing": False,
                    "use_random_ids": False,
                    "use_position_ids": True,
                    "allow_cash_borrowing": False,
                    "starting_balance": "1000000",
                    "currency": "USD",
                }
            },
            "CURRENCY_MISMATCH",
        ),
    ],
)
def test_strategy_risk_balance_and_currency_fail_with_stable_checks(
    tmp_path: Path, overrides: dict[str, object], code: str
) -> None:
    service, control, _catalog, _clock, _run_ids, _preflight_ids = _service(tmp_path)
    try:
        result = service.run(
            BacktestDraftRequest.model_validate(valid_draft(**overrides)),
            idempotency_key=f"failure-{code}",
        )
        assert result.state is RunState.PREFLIGHT_BLOCKED
        assert code in {check.code for check in result.checks if not check.passed}
    finally:
        control.close()


@pytest.mark.parametrize(
    ("field", "reference", "code"),
    [
        ("strategy_ref", "token@v1", "STRATEGY_UNKNOWN"),
        ("risk_policy_ref", "secret@v1", "RISK_POLICY_UNKNOWN"),
    ],
)
def test_keyword_named_registry_reference_stays_valid_blocked_evidence(
    tmp_path: Path,
    field: str,
    reference: str,
    code: str,
) -> None:
    service, control, _catalog, clock, _run_ids, _preflight_ids = _service(tmp_path)
    draft = BacktestDraftRequest.model_validate(valid_draft(**{field: reference}))
    key = f"keyword-reference-{field}"

    try:
        first = service.run(draft, idempotency_key=key)
        check = next(item for item in first.checks if item.code == code)
        assert first.state is RunState.PREFLIGHT_BLOCKED
        assert check.evidence[0].value == reference
        stored = control.preflight(first.preflight_id)
        assert stored is not None
        exact_bytes = stored.result_bytes
        clock_calls = clock.calls

        assert service.run(draft, idempotency_key=key) == first
        replayed = control.preflight(first.preflight_id)
        assert replayed is not None and replayed.result_bytes == exact_bytes
        assert clock.calls == clock_calls
    finally:
        control.close()


@pytest.mark.parametrize(
    ("kind", "field", "code", "resolved_identifier", "expected_resolved"),
    [
        (
            "strategy",
            "strategy_ref",
            "STRATEGY_UNKNOWN",
            "determinism-probe",
            "determinism-probe@v1",
        ),
        (
            "risk",
            "risk_policy_ref",
            "RISK_POLICY_UNKNOWN",
            "raw/private/OPENAI_API_KEY=sk-live-secret",
            "REDACTED",
        ),
    ],
)
def test_resolver_reference_mismatch_records_only_safe_actual_reference(
    tmp_path: Path,
    kind: str,
    field: str,
    code: str,
    resolved_identifier: str,
    expected_resolved: str,
) -> None:
    definition = (
        _definition(
            resolved_identifier,
            "v1",
            {
                "entry_limit_price": "100",
                "entry_quantity": "15",
                "metric_round_trip_quantity": "1",
                "metric_round_trips": 5,
                "risk_probe_quantity": "20",
                "venue_rejection_quantity": "1",
            },
        )
        if kind == "strategy"
        else _definition(resolved_identifier, "v1", {"max_notional": "1600"})
    )
    service, control, _catalog, clock, _run_ids, _preflight_ids = _service(tmp_path)
    if kind == "strategy":
        service._strategy_resolver = lambda _ref: definition
    else:
        service._risk_resolver = lambda _ref: definition
    requested_ref = "alias@v1"
    draft = BacktestDraftRequest.model_validate(valid_draft(**{field: requested_ref}))
    key = f"resolver-mismatch-{kind}"

    try:
        first = service.run(draft, idempotency_key=key)
        check = next(item for item in first.checks if item.code == code)
        assert first.state is RunState.PREFLIGHT_BLOCKED
        assert [(fact.name, fact.value) for fact in check.evidence] == [
            (field, requested_ref),
            ("resolved_ref", expected_resolved),
            ("lookup_status", "REFERENCE_MISMATCH"),
        ]
        stored = control.preflight(first.preflight_id)
        assert stored is not None
        exact_bytes = stored.result_bytes
        clock_calls = clock.calls

        assert service.run(draft, idempotency_key=key) == first
        replayed = control.preflight(first.preflight_id)
        assert replayed is not None and replayed.result_bytes == exact_bytes
        assert clock.calls == clock_calls
        if expected_resolved == "REDACTED":
            assert resolved_identifier.encode() not in exact_bytes
            assert sha256(resolved_identifier.encode()).hexdigest().encode() not in exact_bytes
    finally:
        control.close()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("oms_type", "NETTING"),
        ("book_type", "L2_MBP"),
        ("use_position_ids", False),
    ],
)
def test_valid_but_unsupported_venue_semantics_are_blocked_before_ready(
    tmp_path: Path, field: str, value: object
) -> None:
    service, control, _catalog, _clock, _run_ids, _preflight_ids = _service(tmp_path)
    draft = valid_draft()
    account = draft["venue_account_model"]
    assert isinstance(account, dict)
    account[field] = value

    try:
        result = service.run(
            BacktestDraftRequest.model_validate(draft),
            idempotency_key=f"unsupported-venue-{field}",
        )
        failed = {check.code for check in result.checks if not check.passed}

        assert result.state is RunState.PREFLIGHT_BLOCKED
        assert "VENUE_ACCOUNT_UNSUPPORTED" in failed
        assert "BALANCE_VALID" not in {check.code for check in result.checks}
    finally:
        control.close()


def test_engine_and_registry_hash_drift_block_without_a_manifest(tmp_path: Path) -> None:
    bad_strategy = _definition(
        "determinism-probe",
        "v1",
        {
            "entry_limit_price": "100",
            "entry_quantity": "15",
            "metric_round_trip_quantity": "1",
            "metric_round_trips": 5,
            "risk_probe_quantity": "20",
            "venue_rejection_quantity": "1",
        },
    )
    object.__setattr__(bad_strategy, "sha256", "f" * 64)
    service, control, _catalog, _clock, _run_ids, _preflight_ids = _service(
        tmp_path,
        engine=EngineIdentity(
            package_version="2.0.0rc2",
            tag_commit="648970ce64a304d93da0a29320cb6e19b905fa39",
            python_version="3.12.4",
            precision_mode="FIXED_PRECISION_16",
        ),
        strategy=bad_strategy,
    )
    try:
        result = service.run(
            BacktestDraftRequest.model_validate(valid_draft()),
            idempotency_key="engine-hash-drift",
        )
        failed = {check.code for check in result.checks if not check.passed}
        assert {"ENGINE_VERSION_MISMATCH", "STRATEGY_HASH_MISMATCH"} <= failed
        assert result.input_manifest_hash is None
        engine_check = next(
            check for check in result.checks if check.code == "ENGINE_VERSION_MISMATCH"
        )
        assert [(fact.name, fact.value) for fact in engine_check.evidence] == [
            ("expected_version", "2.0.0rc3"),
            ("configured_version", "2.0.0rc2"),
            ("runtime_version", "2.0.0rc3"),
        ]
        strategy_check = next(
            check for check in result.checks if check.code == "STRATEGY_HASH_MISMATCH"
        )
        assert [(fact.name, fact.value) for fact in strategy_check.evidence] == [
            ("strategy_ref", "determinism-probe@v1"),
            ("declared_digest", "f" * 64),
            ("computed_sha256", sha256(bad_strategy.canonical_bytes).hexdigest()),
            ("hash_status", "MISMATCH"),
        ]
    finally:
        control.close()


def test_safe_malformed_engine_identity_persists_blocked_actual_evidence(
    tmp_path: Path,
) -> None:
    service, control, _catalog, clock, _run_ids, _preflight_ids = _service(
        tmp_path,
        engine=EngineIdentity(
            package_version="rc-bad",
            tag_commit="deadbeef",
            python_version="py-bad",
            precision_mode="FLOATING_BAD",
        ),
    )
    draft = BacktestDraftRequest.model_validate(valid_draft())

    try:
        first = service.run(draft, idempotency_key="malformed-safe-engine")
        assert first.state is RunState.PREFLIGHT_BLOCKED
        checks = {check.code: check for check in first.checks}
        assert [(fact.name, fact.value) for fact in checks["ENGINE_VERSION_MISMATCH"].evidence] == [
            ("expected_version", "2.0.0rc3"),
            ("configured_version", "rc-bad"),
            ("runtime_version", "2.0.0rc3"),
        ]
        assert [(fact.name, fact.value) for fact in checks["ENGINE_TAG_MISMATCH"].evidence] == [
            ("expected_commit", "648970ce64a304d93da0a29320cb6e19b905fa39"),
            ("observed_commit", "deadbeef"),
        ]
        stored = control.preflight(first.preflight_id)
        assert stored is not None
        exact_bytes = stored.result_bytes
        clock_calls = clock.calls

        replay = service.run(draft, idempotency_key="malformed-safe-engine")

        assert replay == first
        replayed = control.preflight(first.preflight_id)
        assert replayed is not None
        assert replayed.result_bytes == exact_bytes
        assert clock.calls == clock_calls
    finally:
        control.close()


@pytest.mark.parametrize(
    ("kind", "code"),
    [
        ("strategy", "STRATEGY_HASH_MISMATCH"),
        ("risk", "RISK_POLICY_HASH_MISMATCH"),
    ],
)
def test_safe_malformed_declared_definition_digest_is_preserved_and_replayed(
    tmp_path: Path,
    kind: str,
    code: str,
) -> None:
    definition = (
        _definition(
            "determinism-probe",
            "v1",
            {
                "entry_limit_price": "100",
                "entry_quantity": "15",
                "metric_round_trip_quantity": "1",
                "metric_round_trips": 5,
                "risk_probe_quantity": "20",
                "venue_rejection_quantity": "1",
            },
        )
        if kind == "strategy"
        else _definition("probe-risk", "v1", {"max_notional": "1600"})
    )
    object.__setattr__(definition, "sha256", "deadbeef")
    service, control, _catalog, clock, _run_ids, _preflight_ids = _service(
        tmp_path,
        **{kind: definition},
    )
    draft = BacktestDraftRequest.model_validate(valid_draft())
    key = f"malformed-declared-{kind}"

    try:
        first = service.run(draft, idempotency_key=key)
        check = next(item for item in first.checks if item.code == code)
        assert first.state is RunState.PREFLIGHT_BLOCKED
        assert ("declared_digest", "deadbeef") in [
            (fact.name, fact.value) for fact in check.evidence
        ]
        assert (
            "computed_sha256",
            sha256(definition.canonical_bytes).hexdigest(),
        ) in [(fact.name, fact.value) for fact in check.evidence]
        stored = control.preflight(first.preflight_id)
        assert stored is not None
        exact_bytes = stored.result_bytes
        clock_calls = clock.calls

        assert service.run(draft, idempotency_key=key) == first
        replayed = control.preflight(first.preflight_id)
        assert replayed is not None and replayed.result_bytes == exact_bytes
        assert clock.calls == clock_calls
    finally:
        control.close()


@pytest.mark.parametrize(
    ("kind", "identifier", "code"),
    [
        ("strategy", "determinism-probe", "STRATEGY_UNSUPPORTED"),
        ("risk", "probe-risk", "RISK_POLICY_UNSUPPORTED"),
    ],
)
def test_hash_matching_non_json_definition_is_unsupported_and_replayed(
    tmp_path: Path,
    kind: str,
    identifier: str,
    code: str,
) -> None:
    raw = b"not-json"
    definition = RegisteredDefinition(
        identifier=identifier,
        version="v1",
        canonical_bytes=raw,
        sha256=sha256(raw).hexdigest(),
    )
    service, control, _catalog, clock, _run_ids, _preflight_ids = _service(
        tmp_path,
        **{kind: definition},
    )
    draft = BacktestDraftRequest.model_validate(valid_draft())
    key = f"non-json-{kind}"

    try:
        first = service.run(draft, idempotency_key=key)
        assert first.state is RunState.PREFLIGHT_BLOCKED
        check = next(item for item in first.checks if item.code == code)
        assert ("definition_sha256", "UNAVAILABLE") in [
            (fact.name, fact.value) for fact in check.evidence
        ]
        assert not any(check.code.endswith("HASH_MISMATCH") for check in first.checks)
        stored = control.preflight(first.preflight_id)
        assert stored is not None
        exact_bytes = stored.result_bytes
        assert sha256(raw).hexdigest().encode("ascii") not in exact_bytes
        clock_calls = clock.calls

        assert service.run(draft, idempotency_key=key) == first
        replayed = control.preflight(first.preflight_id)
        assert replayed is not None and replayed.result_bytes == exact_bytes
        assert clock.calls == clock_calls
    finally:
        control.close()


@pytest.mark.parametrize(
    ("kind", "identifier", "code"),
    [
        ("strategy", "determinism-probe", "STRATEGY_UNSUPPORTED"),
        ("risk", "probe-risk", "RISK_POLICY_UNSUPPORTED"),
    ],
)
def test_schema_invalid_definition_bytes_never_expose_an_unsafe_digest(
    tmp_path: Path,
    kind: str,
    identifier: str,
    code: str,
) -> None:
    unsafe_marker = b"OPENAI_" + b"API_KEY"
    unsafe_bytes = canonical_json_bytes({"unexpected": unsafe_marker.decode("ascii")})
    unsafe_digest = sha256(unsafe_bytes).hexdigest()
    definition = RegisteredDefinition(
        identifier=identifier,
        version="v1",
        canonical_bytes=unsafe_bytes,
        sha256=unsafe_digest,
    )
    service, control, _catalog, clock, _run_ids, _preflight_ids = _service(
        tmp_path,
        **{kind: definition},
    )
    draft = BacktestDraftRequest.model_validate(valid_draft())
    key = f"unsafe-definition-{kind}"

    try:
        first = service.run(draft, idempotency_key=key)
        check = next(item for item in first.checks if item.code == code)
        assert first.state is RunState.PREFLIGHT_BLOCKED
        assert ("definition_sha256", "UNAVAILABLE") in [
            (fact.name, fact.value) for fact in check.evidence
        ]
        stored = control.preflight(first.preflight_id)
        assert stored is not None
        exact_bytes = stored.result_bytes
        assert unsafe_marker not in exact_bytes
        assert unsafe_digest.encode("ascii") not in exact_bytes
        clock_calls = clock.calls

        assert service.run(draft, idempotency_key=key) == first
        replayed = control.preflight(first.preflight_id)
        assert replayed is not None and replayed.result_bytes == exact_bytes
        assert clock.calls == clock_calls
    finally:
        control.close()


@pytest.mark.parametrize(
    ("field", "value", "code"),
    [
        ("strategy_ref", f"{'token' * 60}@v1", "STRATEGY_UNKNOWN"),
        ("risk_policy_ref", f"{'secret' * 60}@v1", "RISK_POLICY_UNKNOWN"),
    ],
)
def test_long_valid_registry_reference_remains_a_blocked_evidence_fact(
    tmp_path: Path,
    field: str,
    value: str,
    code: str,
) -> None:
    service, control, _catalog, clock, _run_ids, _preflight_ids = _service(tmp_path)
    draft = BacktestDraftRequest.model_validate(valid_draft(**{field: value}))
    key = f"long-reference-{field}"

    try:
        first = service.run(draft, idempotency_key=key)
        check = next(item for item in first.checks if item.code == code)
        assert first.state is RunState.PREFLIGHT_BLOCKED
        assert check.evidence[0].value == value
        stored = control.preflight(first.preflight_id)
        assert stored is not None
        exact_bytes = stored.result_bytes
        clock_calls = clock.calls

        assert service.run(draft, idempotency_key=key) == first
        replayed = control.preflight(first.preflight_id)
        assert replayed is not None and replayed.result_bytes == exact_bytes
        assert clock.calls == clock_calls
    finally:
        control.close()


def test_long_canonical_balance_remains_a_blocked_evidence_fact(tmp_path: Path) -> None:
    service, control, _catalog, clock, _run_ids, _preflight_ids = _service(tmp_path)
    raw = valid_draft()
    account = raw["venue_account_model"]
    assert isinstance(account, dict)
    account["starting_balance"] = "-" + ("1" * 129)
    draft = BacktestDraftRequest.model_validate(raw)
    key = "long-canonical-balance"

    try:
        first = service.run(draft, idempotency_key=key)
        check = next(item for item in first.checks if item.code == "BALANCE_INVALID")
        assert first.state is RunState.PREFLIGHT_BLOCKED
        assert check.evidence[1].value == account["starting_balance"]
        stored = control.preflight(first.preflight_id)
        assert stored is not None
        exact_bytes = stored.result_bytes
        clock_calls = clock.calls

        assert service.run(draft, idempotency_key=key) == first
        replayed = control.preflight(first.preflight_id)
        assert replayed is not None and replayed.result_bytes == exact_bytes
        assert clock.calls == clock_calls
    finally:
        control.close()


@pytest.mark.parametrize(
    ("kind", "definition", "code"),
    [
        (
            "strategy",
            _definition(
                "determinism-probe",
                "v1",
                {
                    "entry_limit_price": "100",
                    "entry_quantity": "15",
                    "metric_round_trip_quantity": "1",
                    "metric_round_trips": 5,
                    "risk_probe_quantity": "20",
                },
            ),
            "STRATEGY_UNSUPPORTED",
        ),
        (
            "strategy",
            _definition(
                "determinism-probe",
                "v1",
                {
                    "entry_limit_price": "100",
                    "entry_quantity": "15",
                    "metric_round_trip_quantity": "1",
                    "metric_round_trips": True,
                    "risk_probe_quantity": "20",
                    "venue_rejection_quantity": "1",
                },
            ),
            "STRATEGY_UNSUPPORTED",
        ),
        (
            "risk",
            _definition(
                "probe-risk",
                "v1",
                {"max_notional": "1600", "max_position": "10"},
            ),
            "RISK_POLICY_UNSUPPORTED",
        ),
        (
            "risk",
            _definition("probe-risk", "v1", {"max_notional": "0"}),
            "RISK_POLICY_UNSUPPORTED",
        ),
    ],
)
def test_registered_strategy_and_risk_definitions_fail_closed_before_queue(
    tmp_path: Path,
    kind: str,
    definition: RegisteredDefinition,
    code: str,
) -> None:
    kwargs = {kind: definition}
    service, control, _catalog, _clock, _run_ids, _preflight_ids = _service(
        tmp_path,
        **kwargs,
    )
    try:
        result = service.run(
            BacktestDraftRequest.model_validate(valid_draft()),
            idempotency_key=f"unsupported-{kind}",
        )
        assert result.state is RunState.PREFLIGHT_BLOCKED
        assert code in {check.code for check in result.checks if not check.passed}
    finally:
        control.close()


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (CatalogConflict(), "CATALOG_UNKNOWN"),
        (CatalogRecoveryBlocked(), "CATALOG_NOT_PUBLISHED"),
        (CatalogIntegrityFailed(), "CATALOG_INTEGRITY_FAILED"),
        (CatalogStorageFailed(), "CATALOG_UNREADABLE"),
        (OSError("unreadable"), "CATALOG_UNREADABLE"),
    ],
)
def test_catalog_missing_prepared_failed_and_unreadable_have_stable_blocked_codes(
    tmp_path: Path,
    error: BaseException,
    code: str,
) -> None:
    service, control, _catalog, _clock, _run_ids, _preflight_ids = _service(tmp_path)
    service._catalog = FailingCatalog(error)
    try:
        result = service.run(
            BacktestDraftRequest.model_validate(valid_draft()),
            idempotency_key=f"catalog-{code}",
        )
        assert result.state is RunState.PREFLIGHT_BLOCKED
        assert code in {check.code for check in result.checks if not check.passed}
        assert result.input_manifest_hash is None
    finally:
        control.close()


@pytest.mark.parametrize(
    ("override", "code"),
    [
        ({"tag_commit": "f" * 40}, "ENGINE_TAG_MISMATCH"),
        ({"python_version": "3.12.5"}, "PYTHON_VERSION_MISMATCH"),
        ({"precision_mode": "FIXED_PRECISION_8"}, "PRECISION_MODE_MISMATCH"),
    ],
)
def test_server_owned_engine_tag_python_and_precision_drift_block(
    tmp_path: Path,
    override: dict[str, str],
    code: str,
) -> None:
    identity = {
        "package_version": "2.0.0rc3",
        "tag_commit": "648970ce64a304d93da0a29320cb6e19b905fa39",
        "python_version": "3.12.4",
        "precision_mode": "FIXED_PRECISION_16",
    }
    identity.update(override)
    service, control, _catalog, _clock, _run_ids, _preflight_ids = _service(
        tmp_path,
        engine=EngineIdentity(**identity),
    )
    try:
        result = service.run(
            BacktestDraftRequest.model_validate(valid_draft()),
            idempotency_key=f"engine-{code}",
        )
        assert result.state is RunState.PREFLIGHT_BLOCKED
        assert code in {check.code for check in result.checks if not check.passed}
    finally:
        control.close()


def test_same_preflight_command_replays_exact_response_without_ids_clock_or_filesystem(
    tmp_path: Path,
) -> None:
    service, control, catalog, clock, run_ids, preflight_ids = _service(tmp_path)
    draft = BacktestDraftRequest.model_validate(valid_draft())
    try:
        first = service.run(draft, idempotency_key="exact-replay")
        observed = (list(catalog.calls), clock.calls, run_ids.calls, preflight_ids.calls)

        second = service.run(draft, idempotency_key="exact-replay")

        assert second == first
        assert (catalog.calls, clock.calls, run_ids.calls, preflight_ids.calls) == observed
        assert len(control.events(first.run_id)) == 1
        assert len(control.audit_intents(first.run_id)) == 1
        assert len(control.pending_outbox(first.run_id)) == 1
    finally:
        control.close()


def test_same_key_with_changed_draft_conflicts_before_catalog_revalidation(
    tmp_path: Path,
) -> None:
    service, control, catalog, _clock, _run_ids, _preflight_ids = _service(tmp_path)
    try:
        service.run(
            BacktestDraftRequest.model_validate(valid_draft()),
            idempotency_key="conflict",
        )
        calls = list(catalog.calls)
        changed = valid_draft(replay_seed=8)

        with pytest.raises(Exception, match="IDEMPOTENCY_CONFLICT"):
            service.run(
                BacktestDraftRequest.model_validate(changed),
                idempotency_key="conflict",
            )
        assert catalog.calls == calls
    finally:
        control.close()
