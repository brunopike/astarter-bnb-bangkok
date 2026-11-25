"""Backtest-only preflight and one-time READY-token consumption."""

from __future__ import annotations

import importlib.metadata
import sys
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from hashlib import sha256
from pathlib import Path
from typing import Literal, Protocol, cast

from nautilus_trader.model import FIXED_PRECISION, HIGH_PRECISION
from pydantic import BaseModel, ValidationError

from stark_trading_os.audit.canonical_json import (
    CanonicalJSONError,
    canonical_json_bytes,
    parse_json_object,
)
from stark_trading_os.control.preflight_contract import (
    PREFLIGHT_CHECK_EXPLANATIONS,
    sanitize_preflight_evidence_value,
    sanitize_preflight_registry_reference_value,
    validate_preflight_evidence,
    validate_unix_epoch_ns,
)
from stark_trading_os.control.registry import (
    CatalogConflict,
    CatalogIntegrityFailed,
    CatalogPublication,
    CatalogRecoveryBlocked,
    CatalogStorageFailed,
    ControlStore,
    ControlStoreError,
    ControlTransaction,
    EventCandidate,
    EventRejected,
    IdempotencyCommand,
    IdempotentResponse,
    PreflightReadyEvidence,
)
from stark_trading_os.control.strategy_configurations import (
    RegisteredDefinition,
    StrategyConfigurationBinding,
)
from stark_trading_os.control.transactions import (
    PINNED_ENGINE_PACKAGE_VERSION,
    PINNED_ENGINE_PRECISION_MODE,
    PINNED_ENGINE_PYTHON_VERSION,
    PINNED_ENGINE_TAG_COMMIT,
    _validated_create_response_object,
    _validated_preflight_result_object,
)
from stark_trading_os.domain.cost_fill import (
    UnsupportedCostFillModel,
    build_native_cost_fill_profile,
)
from stark_trading_os.domain.models import (
    BacktestDraftRequest,
    CatalogManifestV1,
    CostFillModelV1,
    DeterminismProbeConfigV1,
    DraftVenueAccountModelV1,
    InputManifestV1,
    ProbeRiskPolicyV1,
    RunState,
)


class CatalogRevalidator(Protocol):
    def revalidate(self, catalog_revision: str) -> CatalogPublication: ...


@dataclass(frozen=True)
class EngineIdentity:
    package_version: str
    tag_commit: str
    python_version: str
    precision_mode: str


@dataclass(frozen=True)
class PreflightEvidenceFact:
    name: str
    value: str


@dataclass(frozen=True)
class PreflightCheck:
    code: str
    passed: bool
    checked_at_ns: int
    explanation: str
    evidence: tuple[PreflightEvidenceFact, ...]


@dataclass(frozen=True)
class _PreflightCheckOutcome:
    code: str
    passed: bool
    evidence: tuple[PreflightEvidenceFact, ...]


def _outcome(
    code: str,
    passed: bool,
    *evidence: tuple[str, str],
) -> _PreflightCheckOutcome:
    validated = validate_preflight_evidence(code, evidence)
    return _PreflightCheckOutcome(
        code=code,
        passed=passed,
        evidence=tuple(PreflightEvidenceFact(name=name, value=value) for name, value in validated),
    )


@dataclass(frozen=True)
class PreflightResponse:
    preflight_id: str
    run_id: str
    state: RunState
    state_version: int
    canonical_request_hash: str
    input_manifest_hash: str | None
    catalog_revision: str | None
    expires_at_ns: int
    checks: tuple[PreflightCheck, ...]


@dataclass(frozen=True)
class RunReservation:
    run_id: str
    state: RunState
    state_version: int
    last_visible_seq: int
    input_manifest_bytes: bytes
    input_manifest_hash: str


class PreflightStale(RuntimeError):
    def __init__(self) -> None:
        super().__init__("PREFLIGHT_STALE")


class PreflightService:
    def __init__(
        self,
        *,
        control: ControlStore,
        catalog: CatalogRevalidator,
        engine: EngineIdentity,
        strategy_resolver: Callable[[str], RegisteredDefinition | None],
        risk_resolver: Callable[[str], RegisteredDefinition | None],
        clock: Callable[[], int],
        run_id_factory: Callable[[], str],
        preflight_id_factory: Callable[[], str],
        token_ttl_ns: int,
        run_root: Path,
    ) -> None:
        if type(token_ttl_ns) is not int or token_ttl_ns <= 0:
            raise ValueError("Preflight token TTL must be a positive integer.")
        self._control = control
        self._catalog = catalog
        self._engine = engine
        self._strategy_resolver = strategy_resolver
        self._risk_resolver = risk_resolver
        self._clock = clock
        self._run_id_factory = run_id_factory
        self._preflight_id_factory = preflight_id_factory
        self._token_ttl_ns = token_ttl_ns
        self._run_root = run_root.absolute()

    def run(
        self,
        draft: BacktestDraftRequest,
        idempotency_key: str,
        *,
        configuration_binding: StrategyConfigurationBinding | None = None,
    ) -> PreflightResponse:
        if type(draft) is not BacktestDraftRequest:
            raise TypeError("Preflight requires an exact BacktestDraftRequest.")
        request_bytes = canonical_json_bytes(draft.model_dump(mode="json", by_alias=True))
        command = IdempotencyCommand.preflight(
            key=idempotency_key,
            canonical_request_bytes=request_bytes,
            configuration_id=(
                configuration_binding.configuration_id
                if configuration_binding is not None
                else None
            ),
            configuration_content_sha256=(
                configuration_binding.content_sha256
                if configuration_binding is not None
                else None
            ),
        )
        canonical_request_hash = sha256(request_bytes).hexdigest()
        replay = self._control.idempotent_response(command)
        if replay is not None:
            return _decode_preflight_response(replay)

        checked_at_ns = _preflight_clock_ns(self._clock)
        expires_at_ns = validate_unix_epoch_ns(
            checked_at_ns + self._token_ttl_ns,
            label="Preflight expiry",
        )
        publication, catalog_check = self._revalidate_for_preflight(draft.catalog_revision)
        strategy_result = self._resolve_definition(
            draft.strategy_ref,
            resolver=self._strategy_resolver,
            unknown_code="STRATEGY_UNKNOWN",
            hash_code="STRATEGY_HASH_MISMATCH",
            unsupported_code="STRATEGY_UNSUPPORTED",
            expected_identifier="determinism-probe",
            expected_version="v1",
            definition_model=DeterminismProbeConfigV1,
        )
        risk_result = self._resolve_optional_risk(draft.risk_policy_ref)
        outcomes = self._checks(
            draft=draft,
            publication=publication,
            catalog_check=catalog_check,
            strategy=strategy_result,
            risk=risk_result,
        )
        strategy = strategy_result[0]
        risk = risk_result[0]
        ready = all(check.passed for check in outcomes)
        manifest_bytes: bytes | None = None
        manifest_hash: str | None = None
        catalog_revision: str | None = None
        inventory_hash: str | None = None
        ready_evidence: PreflightReadyEvidence | None = None
        if ready:
            assert publication is not None
            assert strategy is not None
            assert risk is not None
            manifest_bytes = self._manifest_bytes(
                draft=draft,
                publication=publication,
                strategy=strategy,
                risk=risk,
            )
            manifest_hash = sha256(manifest_bytes).hexdigest()
            catalog_revision = publication.catalog_revision
            inventory_hash = publication.inventory_hash
            ready_evidence = PreflightReadyEvidence(
                catalog_publication_bytes=publication.publication_bytes,
                strategy_id=strategy.identifier,
                strategy_version=strategy.version,
                strategy_bytes=strategy.canonical_bytes,
                strategy_hash=strategy.sha256,
                risk_policy_id=risk.identifier,
                risk_policy_version=risk.version,
                risk_policy_bytes=risk.canonical_bytes,
                risk_policy_hash=risk.sha256,
                engine_python_version=self._engine.python_version,
                engine_precision_mode=self._engine.precision_mode,
            )

        def persist(transaction: ControlTransaction) -> IdempotentResponse:
            checks = tuple(
                PreflightCheck(
                    code=outcome.code,
                    passed=outcome.passed,
                    checked_at_ns=checked_at_ns,
                    explanation=PREFLIGHT_CHECK_EXPLANATIONS[outcome.code],
                    evidence=outcome.evidence,
                )
                for outcome in outcomes
            )
            run_id = _new_id(self._run_id_factory, label="run_id")
            preflight_id = _new_id(
                self._preflight_id_factory,
                label="preflight_id",
            )
            status: Literal["PREFLIGHT_BLOCKED", "PREFLIGHT_READY"] = (
                "PREFLIGHT_READY" if ready else "PREFLIGHT_BLOCKED"
            )
            state = RunState(status)
            response_value = PreflightResponse(
                preflight_id=preflight_id,
                run_id=run_id,
                state=state,
                state_version=1,
                canonical_request_hash=canonical_request_hash,
                input_manifest_hash=manifest_hash,
                catalog_revision=catalog_revision,
                expires_at_ns=expires_at_ns,
                checks=checks,
            )
            response_bytes = _preflight_response_bytes(response_value)
            transaction.reserve_run(
                run_id=run_id,
                input_manifest_bytes=manifest_bytes,
                input_manifest_hash=manifest_hash,
                catalog_revision=catalog_revision,
                catalog_inventory_hash=inventory_hash,
            )
            transaction.persist_preflight(
                preflight_id=preflight_id,
                run_id=run_id,
                status=status,
                request_bytes=request_bytes,
                request_hash=canonical_request_hash,
                result_bytes=response_bytes,
                input_manifest_bytes=manifest_bytes,
                input_manifest_hash=manifest_hash,
                catalog_revision=catalog_revision,
                catalog_inventory_hash=inventory_hash,
                engine_package_version=(self._engine.package_version if ready else None),
                engine_tag_commit=self._engine.tag_commit if ready else None,
                risk_policy_hash=risk.sha256 if ready and risk is not None else None,
                expires_at_ns=expires_at_ns,
                ready_evidence=ready_evidence,
                configuration_id=(
                    configuration_binding.configuration_id
                    if configuration_binding is not None
                    else None
                ),
                configuration_content_sha256=(
                    configuration_binding.content_sha256
                    if configuration_binding is not None
                    else None
                ),
            )
            transaction.commit_transition(
                run_id=run_id,
                expected_version=0,
                target=state,
                candidate=EventCandidate.control(
                    type=("preflight.passed" if ready else "preflight.blocked"),
                    ts_event_ns=str(checked_at_ns),
                    payload={
                        "canonical_request_hash": canonical_request_hash,
                        "preflight_id": preflight_id,
                    },
                ),
            )
            return IdempotentResponse(
                status_code=200,
                body=response_bytes,
                run_id=run_id,
            )

        stored = self._control.execute_idempotent(command=command, handler=persist)
        return _decode_preflight_response(stored)

    def consume_ready(
        self,
        preflight_id: str,
        canonical_request_hash: str,
        idempotency_key: str,
    ) -> RunReservation:
        _require_digest(canonical_request_hash)
        request_bytes = canonical_json_bytes(
            {
                "canonical_request_hash": canonical_request_hash,
                "preflight_id": preflight_id,
            }
        )
        command = IdempotencyCommand.create(
            key=idempotency_key,
            canonical_request_bytes=request_bytes,
        )
        replay = self._control.idempotent_response(command)
        if replay is not None:
            return self._decode_reservation(replay, preflight_id=preflight_id)
        try:
            stored = self._control.preflight(preflight_id)
        except ControlStoreError as error:
            raise PreflightStale from error
        if (
            stored is None
            or stored.status != "PREFLIGHT_READY"
            or stored.request_hash != canonical_request_hash
            or stored.input_manifest_bytes is None
            or stored.input_manifest_hash is None
            or stored.catalog_revision is None
            or stored.catalog_inventory_hash is None
            or stored.engine_package_version is None
            or stored.engine_tag_commit is None
            or stored.risk_policy_hash is None
        ):
            raise PreflightStale
        try:
            manifest = _exact_model(InputManifestV1, stored.input_manifest_bytes)
            publication = self._catalog.revalidate(stored.catalog_revision)
        except Exception as error:
            raise PreflightStale from error
        strategy = self._strategy_resolver(f"{manifest.strategy_id}@{manifest.strategy_version}")
        risk = self._risk_resolver(f"{manifest.risk_policy_id}@{manifest.risk_policy_version}")
        if (
            not _engine_identity_is_current(self._engine)
            or not _definition_is_supported(
                strategy,
                expected_identifier="determinism-probe",
                expected_version="v1",
                definition_model=DeterminismProbeConfigV1,
            )
            or strategy is None
            or strategy.sha256 != manifest.config_hash
            or not _definition_is_valid(risk)
            or not _definition_is_supported(
                risk,
                expected_identifier="probe-risk",
                expected_version="v1",
                definition_model=ProbeRiskPolicyV1,
            )
            or risk is None
            or risk.sha256 != stored.risk_policy_hash
            or publication.catalog_revision != stored.catalog_revision
            or publication.inventory_hash != stored.catalog_inventory_hash
            or publication.status != "PUBLISHED"
        ):
            raise PreflightStale
        manifest_bytes = stored.input_manifest_bytes
        manifest_hash = stored.input_manifest_hash
        catalog_revision = stored.catalog_revision
        catalog_inventory_hash = stored.catalog_inventory_hash
        assert manifest_bytes is not None
        assert manifest_hash is not None
        assert catalog_revision is not None
        assert catalog_inventory_hash is not None

        def consume(transaction: ControlTransaction) -> IdempotentResponse:
            consumed_at_ns = _clock_ns(self._clock)
            transaction.consume_preflight(
                preflight_id=preflight_id,
                expected_request_hash=canonical_request_hash,
                expected_manifest_bytes=manifest_bytes,
                expected_manifest_hash=manifest_hash,
                expected_catalog_revision=catalog_revision,
                expected_catalog_inventory_hash=catalog_inventory_hash,
                expected_catalog_publication_bytes=publication.publication_bytes,
                expected_engine_package_version=self._engine.package_version,
                expected_engine_tag_commit=self._engine.tag_commit,
                expected_python_version=self._engine.python_version,
                expected_precision_mode=self._engine.precision_mode,
                expected_risk_policy_hash=risk.sha256,
                consumed_at_ns=consumed_at_ns,
            )
            transaction.commit_transition(
                run_id=stored.run_id,
                expected_version=1,
                target=RunState.QUEUED,
                candidate=EventCandidate.control(
                    type="run.queued",
                    ts_event_ns=str(consumed_at_ns),
                    payload={"preflight_id": preflight_id},
                ),
            )
            response_body = _schema_less_canonical_object_bytes(
                {
                    "input_manifest_hash": stored.input_manifest_hash,
                    "last_visible_seq": 2,
                    "run_id": stored.run_id,
                    "state": RunState.QUEUED.value,
                    "state_version": 2,
                }
            )
            return IdempotentResponse(
                status_code=202,
                body=response_body,
                run_id=stored.run_id,
            )

        try:
            response = self._control.execute_idempotent(
                command=command,
                handler=consume,
            )
        except EventRejected as error:
            if "PREFLIGHT_STALE" in str(error):
                raise PreflightStale from error
            raise
        return self._decode_reservation(response, preflight_id=preflight_id)

    def _decode_reservation(
        self,
        response: IdempotentResponse,
        *,
        preflight_id: str,
    ) -> RunReservation:
        value = _exact_response_object(response)
        response_run_id, response_manifest_hash = _validated_create_response_object(value)
        snapshot = self._control.preflight(preflight_id)
        if (
            response.status_code != 202
            or snapshot is None
            or snapshot.input_manifest_bytes is None
            or snapshot.input_manifest_hash is None
            or response_run_id != snapshot.run_id
            or response_manifest_hash != snapshot.input_manifest_hash
        ):
            raise ValueError("Stored create response is invalid.")
        return RunReservation(
            run_id=snapshot.run_id,
            state=RunState.QUEUED,
            state_version=2,
            last_visible_seq=2,
            input_manifest_bytes=snapshot.input_manifest_bytes,
            input_manifest_hash=snapshot.input_manifest_hash,
        )

    def _revalidate_for_preflight(
        self,
        catalog_revision: str,
    ) -> tuple[CatalogPublication | None, _PreflightCheckOutcome]:
        try:
            publication = self._catalog.revalidate(catalog_revision)
        except CatalogConflict:
            return None, _outcome(
                "CATALOG_UNKNOWN",
                False,
                ("catalog_revision", catalog_revision),
                ("lookup_status", "NOT_FOUND"),
            )
        except CatalogRecoveryBlocked:
            return None, _outcome(
                "CATALOG_NOT_PUBLISHED",
                False,
                ("requested_revision", catalog_revision),
                ("observed_revision", "NONE"),
                ("observed_status", "UNAVAILABLE"),
                ("publication_status", "NOT_PUBLISHED"),
            )
        except CatalogIntegrityFailed:
            return None, _catalog_integrity_outcome(catalog_revision, None, None)
        except (CatalogStorageFailed, OSError):
            return None, _outcome(
                "CATALOG_UNREADABLE",
                False,
                ("catalog_revision", catalog_revision),
                ("read_status", "UNREADABLE"),
            )
        except Exception:
            return None, _outcome(
                "CATALOG_UNREADABLE",
                False,
                ("catalog_revision", catalog_revision),
                ("read_status", "UNREADABLE"),
            )
        if type(publication) is not CatalogPublication:
            return None, _outcome(
                "CATALOG_UNREADABLE",
                False,
                ("catalog_revision", catalog_revision),
                ("read_status", "INVALID_RESPONSE"),
            )
        if type(publication.status) is not str or publication.status not in (
            "PREPARED",
            "PUBLISHED",
            "INTEGRITY_FAILED",
        ):
            return None, _catalog_integrity_outcome(catalog_revision, publication, None)
        if publication.catalog_revision != catalog_revision:
            return None, _catalog_integrity_outcome(catalog_revision, publication, None)
        if publication.status == "PREPARED":
            return None, _catalog_not_published_outcome(catalog_revision, publication)
        if publication.status == "INTEGRITY_FAILED":
            return None, _catalog_integrity_outcome(catalog_revision, publication, None)
        try:
            catalog = _exact_model(CatalogManifestV1, publication.publication_bytes)
        except (CanonicalJSONError, ValidationError, ValueError):
            return None, _catalog_integrity_outcome(catalog_revision, publication, None)
        if (
            sha256(publication.publication_bytes).hexdigest() != publication.catalog_revision
            or catalog.inventory_hash != publication.inventory_hash
        ):
            return None, _catalog_integrity_outcome(catalog_revision, publication, catalog)
        return publication, _outcome(
            "CATALOG_PUBLISHED",
            True,
            ("catalog_revision", catalog_revision),
            ("inventory_hash", publication.inventory_hash),
            ("publication_status", "PUBLISHED"),
        )

    def _resolve_definition(
        self,
        reference: str,
        *,
        resolver: Callable[[str], RegisteredDefinition | None],
        unknown_code: str,
        hash_code: str,
        unsupported_code: str,
        expected_identifier: str,
        expected_version: str,
        definition_model: type[BaseModel],
    ) -> tuple[RegisteredDefinition | None, _PreflightCheckOutcome]:
        definition = resolver(reference)
        if definition is None:
            reference_name = (
                "strategy_ref" if unknown_code.startswith("STRATEGY_") else "risk_policy_ref"
            )
            return None, _outcome(
                unknown_code,
                False,
                (reference_name, reference),
                ("resolved_ref", "NONE"),
                ("lookup_status", "NOT_FOUND"),
            )
        computed_sha256 = _definition_computed_sha256(
            definition,
            definition_model=definition_model,
        )
        if (
            type(definition) is RegisteredDefinition
            and type(definition.sha256) is str
            and type(definition.canonical_bytes) is bytes
            and computed_sha256 != "UNAVAILABLE"
            and definition.sha256 != computed_sha256
        ):
            reference_name = (
                "strategy_ref" if hash_code.startswith("STRATEGY_") else "risk_policy_ref"
            )
            return None, _outcome(
                hash_code,
                False,
                (reference_name, reference),
                ("declared_digest", _definition_declared_digest(definition)),
                ("computed_sha256", computed_sha256),
                ("hash_status", "MISMATCH"),
            )
        if type(definition) is RegisteredDefinition and reference != (
            f"{definition.identifier}@{definition.version}"
        ):
            reference_name = (
                "strategy_ref" if unknown_code.startswith("STRATEGY_") else "risk_policy_ref"
            )
            return None, _outcome(
                unknown_code,
                False,
                (reference_name, reference),
                (
                    "resolved_ref",
                    sanitize_preflight_registry_reference_value(
                        f"{definition.identifier}@{definition.version}"
                    ),
                ),
                ("lookup_status", "REFERENCE_MISMATCH"),
            )
        if not _definition_is_supported(
            definition,
            expected_identifier=expected_identifier,
            expected_version=expected_version,
            definition_model=definition_model,
        ):
            reference_name = (
                "strategy_ref" if unsupported_code.startswith("STRATEGY_") else "risk_policy_ref"
            )
            return None, _outcome(
                unsupported_code,
                False,
                (reference_name, reference),
                ("definition_sha256", computed_sha256),
                ("support_status", "UNSUPPORTED"),
            )
        assert type(definition) is RegisteredDefinition
        assert computed_sha256 != "UNAVAILABLE"
        valid_code = f"{unknown_code.removesuffix('_UNKNOWN')}_VALID"
        reference_name = "strategy_ref" if valid_code.startswith("STRATEGY_") else "risk_policy_ref"
        return definition, _outcome(
            valid_code,
            True,
            (reference_name, reference),
            ("definition_sha256", computed_sha256),
            ("support_status", "SUPPORTED"),
        )

    def _resolve_optional_risk(
        self,
        reference: str | None,
    ) -> tuple[RegisteredDefinition | None, _PreflightCheckOutcome]:
        if reference is None:
            return None, _outcome(
                "RISK_POLICY_MISSING",
                False,
                ("risk_policy_ref", "NONE"),
                ("registry_status", "MISSING"),
            )
        return self._resolve_definition(
            reference,
            resolver=self._risk_resolver,
            unknown_code="RISK_POLICY_UNKNOWN",
            hash_code="RISK_POLICY_HASH_MISMATCH",
            unsupported_code="RISK_POLICY_UNSUPPORTED",
            expected_identifier="probe-risk",
            expected_version="v1",
            definition_model=ProbeRiskPolicyV1,
        )

    def _checks(
        self,
        *,
        draft: BacktestDraftRequest,
        publication: CatalogPublication | None,
        catalog_check: _PreflightCheckOutcome,
        strategy: tuple[RegisteredDefinition | None, _PreflightCheckOutcome],
        risk: tuple[RegisteredDefinition | None, _PreflightCheckOutcome],
    ) -> tuple[_PreflightCheckOutcome, ...]:
        strategy_definition, strategy_check = strategy
        risk_definition, risk_check = risk
        del risk_definition
        catalog = (
            None
            if publication is None
            else _exact_model(CatalogManifestV1, publication.publication_bytes)
        )
        if (
            strategy_check.passed
            and strategy_definition is not None
            and catalog is not None
            and not _strategy_values_align_to_catalog(strategy_definition, catalog)
        ):
            strategy_check = _outcome(
                "STRATEGY_UNSUPPORTED",
                False,
                ("strategy_ref", draft.strategy_ref),
                (
                    "definition_sha256",
                    sha256(strategy_definition.canonical_bytes).hexdigest(),
                ),
                ("support_status", "CATALOG_INCREMENT_UNSUPPORTED"),
            )
        checks: list[_PreflightCheckOutcome] = []
        checks.extend(_engine_checks(self._engine))
        checks.append(strategy_check)
        checks.append(catalog_check)
        checks.extend(_cost_fill_checks(draft))
        checks.append(risk_check)
        if draft.venue_account_model is None:
            checks.append(
                _outcome(
                    "BALANCE_MODEL_MISSING",
                    False,
                    ("account_model_status", "MISSING"),
                )
            )
        elif Decimal(draft.venue_account_model.starting_balance) <= 0:
            checks.append(
                _outcome(
                    "BALANCE_INVALID",
                    False,
                    (
                        "account_model_sha256",
                        _canonical_model_sha256(draft.venue_account_model),
                    ),
                    ("starting_balance", draft.venue_account_model.starting_balance),
                    ("starting_balance_status", "NON_POSITIVE"),
                )
            )
        elif not _venue_account_semantics_are_supported(draft.venue_account_model):
            checks.append(
                _outcome(
                    "VENUE_ACCOUNT_UNSUPPORTED",
                    False,
                    (
                        "account_model_sha256",
                        _canonical_model_sha256(draft.venue_account_model),
                    ),
                    ("native_profile_status", "UNSUPPORTED"),
                )
            )
        else:
            checks.append(
                _outcome(
                    "BALANCE_VALID",
                    True,
                    (
                        "account_model_sha256",
                        _canonical_model_sha256(draft.venue_account_model),
                    ),
                    ("starting_balance", draft.venue_account_model.starting_balance),
                    ("native_profile_status", "SUPPORTED"),
                )
            )
        account = draft.venue_account_model
        if catalog is None:
            currency_valid = account is not None and (
                account.venue_id == "SIM" and account.currency == "USDT"
            )
        else:
            currency_valid = account is not None and (
                account.venue_id == catalog.inventory.instrument.venue
                and account.currency == catalog.inventory.instrument.quote_currency
            )
        currency_authority = {
            "currency": "USDT" if catalog is None else catalog.inventory.instrument.quote_currency,
            "venue": "SIM" if catalog is None else catalog.inventory.instrument.venue,
        }
        expected_venue = currency_authority["venue"]
        expected_currency = currency_authority["currency"]
        checks.append(
            _outcome(
                "CURRENCY_MATCH" if currency_valid else "CURRENCY_MISMATCH",
                currency_valid,
                (
                    "account_model_sha256",
                    "NONE" if account is None else _canonical_model_sha256(account),
                ),
                (
                    "currency_authority_sha256",
                    sha256(canonical_json_bytes(currency_authority)).hexdigest(),
                ),
                (
                    "venue_match",
                    "TRUE"
                    if account is not None and account.venue_id == expected_venue
                    else "FALSE",
                ),
                (
                    "currency_match",
                    "TRUE"
                    if account is not None and account.currency == expected_currency
                    else "FALSE",
                ),
            )
        )
        if not self._run_root.is_dir():
            checks.append(
                _outcome(
                    "RUN_ROOT_INVALID",
                    False,
                    ("authority", "SERVER_CONFIGURED_RUN_ROOT"),
                    ("directory_status", "UNAVAILABLE"),
                )
            )
        else:
            checks.append(
                _outcome(
                    "RUN_ROOT_VALID",
                    True,
                    ("authority", "SERVER_CONFIGURED_RUN_ROOT"),
                    ("directory_status", "AVAILABLE_DIRECTORY"),
                )
            )
        if catalog is None:
            return tuple(checks)
        inventory = catalog.inventory
        checks.append(
            _outcome(
                "INFORMATION_SET_MATCH"
                if draft.information_set_policy == inventory.information_set_policy
                else "INFORMATION_SET_MISMATCH",
                draft.information_set_policy == inventory.information_set_policy,
                (
                    "requested_policy_sha256",
                    _canonical_model_sha256(draft.information_set_policy),
                ),
                (
                    "catalog_policy_sha256",
                    _canonical_model_sha256(inventory.information_set_policy),
                ),
            )
        )
        checks.append(
            _outcome(
                "EVALUATION_PROTOCOL_MATCH"
                if draft.evaluation_protocol == inventory.evaluation_protocol
                else "EVALUATION_PROTOCOL_MISMATCH",
                draft.evaluation_protocol == inventory.evaluation_protocol,
                (
                    "requested_protocol_sha256",
                    _canonical_model_sha256(draft.evaluation_protocol),
                ),
                (
                    "catalog_protocol_sha256",
                    _canonical_model_sha256(inventory.evaluation_protocol),
                ),
            )
        )
        window_valid = not _numeric_less(
            draft.window.start_ns,
            inventory.readback.first_ts_init,
        ) and not _numeric_less(
            _increment(inventory.readback.last_ts_init),
            draft.window.end_ns,
        )
        checks.append(
            _outcome(
                "WINDOW_VALID" if window_valid else "WINDOW_OUT_OF_RANGE",
                window_valid,
                ("requested_start_ns", draft.window.start_ns),
                ("requested_end_ns", draft.window.end_ns),
                ("catalog_start_ns", inventory.readback.first_ts_init),
                ("catalog_end_ns", _increment(inventory.readback.last_ts_init)),
                ("range_status", "CONTAINED" if window_valid else "OUT_OF_RANGE"),
            )
        )
        precision_valid = (
            inventory.instrument.price_precision <= FIXED_PRECISION
            and inventory.instrument.size_precision <= FIXED_PRECISION
            and inventory.native_fingerprint.installed_nautilus_version
            == self._engine.package_version
            and inventory.native_fingerprint.python_version == self._engine.python_version
        )
        checks.append(
            _outcome(
                "PRECISION_VALID" if precision_valid else "PRECISION_MISMATCH",
                precision_valid,
                ("price_precision", str(inventory.instrument.price_precision)),
                ("size_precision", str(inventory.instrument.size_precision)),
                ("fixed_precision_limit", str(FIXED_PRECISION)),
                (
                    "catalog_engine_version",
                    sanitize_preflight_evidence_value(
                        inventory.native_fingerprint.installed_nautilus_version
                    ),
                ),
                (
                    "catalog_python_version",
                    sanitize_preflight_evidence_value(inventory.native_fingerprint.python_version),
                ),
                (
                    "evaluated_engine_version",
                    sanitize_preflight_evidence_value(self._engine.package_version),
                ),
                (
                    "evaluated_python_version",
                    sanitize_preflight_evidence_value(self._engine.python_version),
                ),
                ("validation_status", "VALID" if precision_valid else "MISMATCH"),
            )
        )
        return tuple(checks)

    def _manifest_bytes(
        self,
        *,
        draft: BacktestDraftRequest,
        publication: CatalogPublication,
        strategy: RegisteredDefinition,
        risk: RegisteredDefinition,
    ) -> bytes:
        catalog = _exact_model(CatalogManifestV1, publication.publication_bytes)
        complete_cost_fill = CostFillModelV1.model_validate(
            draft.cost_fill_model.model_dump(mode="json", by_alias=True)
        )
        strategy_object = parse_json_object(strategy.canonical_bytes)
        risk_object = parse_json_object(risk.canonical_bytes)
        instrument = catalog.inventory.instrument
        assert draft.venue_account_model is not None
        manifest = InputManifestV1.model_validate(
            {
                "schema": "InputManifest.v1",
                "environment": draft.environment,
                "strategy_id": strategy.identifier,
                "strategy_version": strategy.version,
                "canonical_config": strategy_object,
                "config_hash": strategy.sha256,
                "engine_package_version": self._engine.package_version,
                "engine_tag_commit": self._engine.tag_commit,
                "python_version": self._engine.python_version,
                "precision_mode": self._engine.precision_mode,
                "fixture_id": catalog.fixture_id,
                "catalog_revision": publication.catalog_revision,
                "source_checksum": catalog.source_checksum,
                "catalog_checksum": catalog.catalog_checksum,
                "instruments": [
                    {
                        "instrument_id": instrument.instrument_id,
                        "price_increment": instrument.price_increment,
                        "quantity_increment": instrument.size_increment,
                    }
                ],
                "data_types": catalog.inventory.readback.data_types,
                "window": draft.window,
                "timezone": catalog.inventory.timezone,
                "gaps": catalog.inventory.gaps,
                "duplicates": catalog.inventory.duplicates,
                "ordering_result": catalog.inventory.ordering_result,
                "information_set_policy": draft.information_set_policy,
                "evaluation_protocol": draft.evaluation_protocol,
                "venue_account_model": draft.venue_account_model.model_dump(
                    mode="json", by_alias=True
                ),
                "cost_fill_model": complete_cost_fill,
                "risk_policy_id": risk.identifier,
                "risk_policy_version": risk.version,
                "canonical_risk_policy": risk_object,
                "risk_policy_hash": risk.sha256,
                "replay_seed": draft.replay_seed,
            }
        )
        return canonical_json_bytes(manifest.model_dump(mode="json", by_alias=True))


def _catalog_not_published_outcome(
    requested_revision: str,
    publication: CatalogPublication,
) -> _PreflightCheckOutcome:
    return _outcome(
        "CATALOG_NOT_PUBLISHED",
        False,
        ("requested_revision", requested_revision),
        ("observed_revision", _safe_catalog_observation(publication.catalog_revision)),
        ("observed_status", _safe_catalog_observation(publication.status)),
        ("publication_status", "NOT_PUBLISHED"),
    )


def _catalog_integrity_outcome(
    requested_revision: str,
    publication: object,
    catalog: CatalogManifestV1 | None,
) -> _PreflightCheckOutcome:
    if type(publication) is CatalogPublication:
        observed_revision = _safe_catalog_observation(publication.catalog_revision)
        observed_status = _safe_catalog_observation(publication.status)
        validated_catalog = catalog
        if validated_catalog is None and type(publication.publication_bytes) is bytes:
            try:
                validated_catalog = _exact_model(
                    CatalogManifestV1,
                    publication.publication_bytes,
                )
            except (CanonicalJSONError, ValidationError, ValueError):
                validated_catalog = None
        publication_digest = "UNAVAILABLE"
        if validated_catalog is not None and type(publication.publication_bytes) is bytes:
            publication_digest = sha256(publication.publication_bytes).hexdigest()
        declared_inventory_digest = _safe_catalog_observation(publication.inventory_hash)
        catalog = validated_catalog
    elif publication is None:
        observed_revision = "NONE"
        observed_status = "UNAVAILABLE"
        publication_digest = "UNAVAILABLE"
        declared_inventory_digest = "UNAVAILABLE"
    else:
        observed_revision = "INVALID_RESPONSE"
        observed_status = "INVALID_RESPONSE"
        publication_digest = "UNAVAILABLE"
        declared_inventory_digest = "UNAVAILABLE"
    observed_inventory_digest = "UNAVAILABLE"
    if catalog is not None:
        observed_inventory_digest = _safe_catalog_observation(catalog.inventory_hash)
    return _outcome(
        "CATALOG_INTEGRITY_FAILED",
        False,
        ("requested_revision", requested_revision),
        ("observed_revision", observed_revision),
        ("observed_status", observed_status),
        ("publication_bytes_sha256", publication_digest),
        ("declared_inventory_digest", declared_inventory_digest),
        ("observed_inventory_digest", observed_inventory_digest),
        ("integrity_status", "FAILED"),
    )


def _safe_catalog_observation(value: object) -> str:
    if type(value) is not str:
        return "INVALID_RESPONSE"
    return sanitize_preflight_evidence_value(value)


def _venue_account_semantics_are_supported(account: DraftVenueAccountModelV1) -> bool:
    return (
        account.oms_type == "HEDGING"
        and account.account_type == "MARGIN"
        and account.book_type == "L1_MBP"
        and account.routing is False
        and account.use_random_ids is False
        and account.use_position_ids is True
        and account.allow_cash_borrowing is False
        and account.starting_balance == "1000000"
    )


def _strategy_values_align_to_catalog(
    definition: RegisteredDefinition,
    catalog: CatalogManifestV1,
) -> bool:
    try:
        config = DeterminismProbeConfigV1.model_validate(
            parse_json_object(definition.canonical_bytes)
        )
    except (CanonicalJSONError, ValidationError, ValueError):
        return False
    price_increment = Decimal(catalog.inventory.instrument.price_increment)
    size_increment = Decimal(catalog.inventory.instrument.size_increment)
    return Decimal(config.entry_limit_price) % price_increment == 0 and all(
        Decimal(quantity) % size_increment == 0
        for quantity in (
            config.entry_quantity,
            config.metric_round_trip_quantity,
            config.risk_probe_quantity,
            config.venue_rejection_quantity,
        )
    )


def _cost_fill_checks(draft: BacktestDraftRequest) -> tuple[_PreflightCheckOutcome, ...]:
    costs = draft.cost_fill_model
    cost_fill_sha256 = _canonical_model_sha256(costs)
    missing_codes = (
        ("fee", "COST_FEE_MISSING"),
        ("spread", "COST_SPREAD_MISSING"),
        ("slippage", "COST_SLIPPAGE_MISSING"),
        ("latency", "COST_LATENCY_MISSING"),
        ("liquidity", "FILL_LIQUIDITY_MISSING"),
        ("cancel", "FILL_CANCEL_MISSING"),
    )
    missing = tuple(
        _outcome(
            code,
            False,
            ("cost_fill_sha256", cost_fill_sha256),
            ("required_section", field),
            ("section_status", "MISSING"),
        )
        for field, code in missing_codes
        if getattr(costs, field) is None
    )
    if missing:
        return missing
    try:
        complete = CostFillModelV1.model_validate(costs.model_dump(mode="json", by_alias=True))
        build_native_cost_fill_profile(complete, replay_seed=draft.replay_seed)
    except (ValidationError, UnsupportedCostFillModel, ValueError):
        return (
            _outcome(
                "UNSUPPORTED_COST_FILL_MODEL",
                False,
                ("cost_fill_sha256", cost_fill_sha256),
                ("native_mapping_status", "UNSUPPORTED"),
                ("replay_seed", str(draft.replay_seed)),
            ),
        )
    return (
        _outcome(
            "COST_FILL_SUPPORTED",
            True,
            ("cost_fill_sha256", cost_fill_sha256),
            ("fee_model", complete.fee.model),
            ("slippage_model", complete.slippage.model),
            ("latency_model", complete.latency.model),
            ("liquidity_source", complete.liquidity.available_size_source),
            ("cancel_rule", complete.cancel.acknowledgment_rule),
            ("replay_seed", str(draft.replay_seed)),
        ),
    )


def _engine_checks(engine: EngineIdentity) -> tuple[_PreflightCheckOutcome, ...]:
    runtime_version = importlib.metadata.version("nautilus_trader")
    runtime_python = ".".join(str(part) for part in sys.version_info[:3])
    runtime_precision = f"FIXED_PRECISION_{FIXED_PRECISION}"
    version_valid = engine.package_version == PINNED_ENGINE_PACKAGE_VERSION == runtime_version
    tag_valid = engine.tag_commit == PINNED_ENGINE_TAG_COMMIT
    python_valid = engine.python_version == PINNED_ENGINE_PYTHON_VERSION == runtime_python
    precision_valid = (
        engine.precision_mode == PINNED_ENGINE_PRECISION_MODE == runtime_precision
        and HIGH_PRECISION == 1
    )
    return (
        _outcome(
            "ENGINE_VERSION_VALID" if version_valid else "ENGINE_VERSION_MISMATCH",
            version_valid,
            ("expected_version", PINNED_ENGINE_PACKAGE_VERSION),
            *(
                (("observed_version", runtime_version),)
                if version_valid
                else (
                    (
                        "configured_version",
                        sanitize_preflight_evidence_value(engine.package_version),
                    ),
                    ("runtime_version", sanitize_preflight_evidence_value(runtime_version)),
                )
            ),
        ),
        _outcome(
            "ENGINE_TAG_VALID" if tag_valid else "ENGINE_TAG_MISMATCH",
            tag_valid,
            ("expected_commit", PINNED_ENGINE_TAG_COMMIT),
            ("observed_commit", sanitize_preflight_evidence_value(engine.tag_commit)),
        ),
        _outcome(
            "PYTHON_VERSION_VALID" if python_valid else "PYTHON_VERSION_MISMATCH",
            python_valid,
            ("expected_version", PINNED_ENGINE_PYTHON_VERSION),
            *(
                (("observed_version", runtime_python),)
                if python_valid
                else (
                    (
                        "configured_version",
                        sanitize_preflight_evidence_value(engine.python_version),
                    ),
                    ("runtime_version", sanitize_preflight_evidence_value(runtime_python)),
                )
            ),
        ),
        _outcome(
            "PRECISION_MODE_VALID" if precision_valid else "PRECISION_MODE_MISMATCH",
            precision_valid,
            ("expected_mode", PINNED_ENGINE_PRECISION_MODE),
            *(
                (
                    ("observed_mode", runtime_precision),
                    ("high_precision", "ENABLED"),
                )
                if precision_valid
                else (
                    (
                        "configured_mode",
                        sanitize_preflight_evidence_value(engine.precision_mode),
                    ),
                    ("runtime_mode", sanitize_preflight_evidence_value(runtime_precision)),
                    ("high_precision", "ENABLED" if HIGH_PRECISION == 1 else "DISABLED"),
                )
            ),
        ),
    )


def _engine_identity_is_current(engine: EngineIdentity) -> bool:
    return all(check.passed for check in _engine_checks(engine))


def _definition_is_valid(value: RegisteredDefinition | None) -> bool:
    if type(value) is not RegisteredDefinition:
        return False
    if (
        type(value.identifier) is not str
        or not value.identifier
        or type(value.version) is not str
        or not value.version
        or type(value.canonical_bytes) is not bytes
        or type(value.sha256) is not str
    ):
        return False
    try:
        parsed = parse_json_object(value.canonical_bytes)
    except CanonicalJSONError:
        return False
    return canonical_json_bytes(parsed) == value.canonical_bytes


def _definition_declared_digest(value: object) -> str:
    if type(value) is RegisteredDefinition and type(value.sha256) is str:
        return sanitize_preflight_evidence_value(value.sha256)
    return "UNAVAILABLE"


def _definition_computed_sha256(
    value: object,
    *,
    definition_model: type[BaseModel],
) -> str:
    if type(value) is not RegisteredDefinition or type(value.canonical_bytes) is not bytes:
        return "UNAVAILABLE"
    try:
        _exact_model(definition_model, value.canonical_bytes)
    except (CanonicalJSONError, ValidationError, ValueError):
        return "UNAVAILABLE"
    return sha256(value.canonical_bytes).hexdigest()


def _canonical_model_sha256(value: BaseModel) -> str:
    return sha256(
        _schema_less_canonical_object_bytes(value.model_dump(mode="json", by_alias=True))
    ).hexdigest()


def _definition_is_supported(
    value: RegisteredDefinition | None,
    *,
    expected_identifier: str,
    expected_version: str,
    definition_model: type[BaseModel],
) -> bool:
    if (
        not _definition_is_valid(value)
        or value is None
        or value.identifier != expected_identifier
        or value.version != expected_version
    ):
        return False
    try:
        definition_model.model_validate(parse_json_object(value.canonical_bytes))
    except (CanonicalJSONError, ValidationError):
        return False
    return sha256(value.canonical_bytes).hexdigest() == value.sha256


def _exact_model[ModelT: BaseModel](model: type[ModelT], raw: bytes) -> ModelT:
    parsed = parse_json_object(raw)
    if canonical_json_bytes(parsed) != raw:
        raise ValueError("Persisted evidence is not exact canonical bytes.")
    return model.model_validate(parsed)


def _preflight_response_bytes(response: PreflightResponse) -> bytes:
    return _schema_less_canonical_object_bytes(
        {
            "canonical_request_hash": response.canonical_request_hash,
            "catalog_revision": response.catalog_revision,
            "checks": [
                {
                    "checked_at_ns": check.checked_at_ns,
                    "code": check.code,
                    "evidence": [
                        {"name": fact.name, "value": fact.value} for fact in check.evidence
                    ],
                    "explanation": check.explanation,
                    "passed": check.passed,
                }
                for check in response.checks
            ],
            "expires_at_ns": response.expires_at_ns,
            "input_manifest_hash": response.input_manifest_hash,
            "preflight_id": response.preflight_id,
            "run_id": response.run_id,
            "state": response.state.value,
            "state_version": response.state_version,
        }
    )


def _decode_preflight_response(response: IdempotentResponse) -> PreflightResponse:
    value = _exact_response_object(response)
    validated = _validated_preflight_result_object(value)
    checks = [
        PreflightCheck(
            code=check.code,
            passed=check.passed,
            checked_at_ns=check.checked_at_ns,
            explanation=check.explanation,
            evidence=tuple(
                PreflightEvidenceFact(name=name, value=fact_value)
                for name, fact_value in check.evidence
            ),
        )
        for check in validated.checks
    ]
    return PreflightResponse(
        preflight_id=validated.preflight_id,
        run_id=validated.run_id,
        state=RunState(validated.state),
        state_version=1,
        canonical_request_hash=validated.canonical_request_hash,
        input_manifest_hash=validated.input_manifest_hash,
        catalog_revision=validated.catalog_revision,
        expires_at_ns=validated.expires_at_ns,
        checks=tuple(checks),
    )


def _exact_response_object(response: IdempotentResponse) -> dict[str, object]:
    return _parse_schema_less_exact(response.body)


def _schema_less_canonical_object_bytes(value: dict[str, object]) -> bytes:
    wrapped = canonical_json_bytes({"value": value})
    prefix = b'{"value":'
    if not wrapped.startswith(prefix) or not wrapped.endswith(b"}"):
        raise ValueError("Canonical response wrapper is invalid.")
    return wrapped[len(prefix) : -1]


def _parse_schema_less_exact(value: bytes) -> dict[str, object]:
    wrapped = b'{"value":' + value + b"}"
    parsed_wrapper = parse_json_object(wrapped)
    parsed = parsed_wrapper.get("value")
    if type(parsed) is not dict or canonical_json_bytes(parsed_wrapper) != wrapped:
        raise ValueError("Stored response is not exact canonical object bytes.")
    return cast(dict[str, object], parsed)


def _clock_ns(clock: Callable[[], int]) -> int:
    value = clock()
    if type(value) is not int or value < 0:
        raise ValueError("Injected clock must return non-negative integer nanoseconds.")
    return value


def _preflight_clock_ns(clock: Callable[[], int]) -> int:
    return validate_unix_epoch_ns(
        clock(),
        label="Injected preflight clock",
    )


def _new_id(factory: Callable[[], str], *, label: str) -> str:
    value = factory()
    if type(value) is not str or not value:
        raise ValueError(f"Injected {label} factory returned an invalid identifier.")
    return value


def _require_digest(value: str) -> None:
    if (
        type(value) is not str
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError("canonical_request_hash must be a lowercase SHA-256 digest.")


def _numeric_less(left: str, right: str) -> bool:
    return (len(left), left) < (len(right), right)


def _increment(value: str) -> str:
    digits = list(value)
    carry = 1
    for index in range(len(digits) - 1, -1, -1):
        digit = ord(digits[index]) - ord("0") + carry
        digits[index] = chr(ord("0") + digit % 10)
        carry = digit // 10
        if not carry:
            break
    if carry:
        digits.insert(0, "1")
    return "".join(digits)
