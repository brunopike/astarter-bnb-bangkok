"""Server-owned historical configuration workflow; candidates do not authorize runs."""

from collections.abc import Callable
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

from stark_trading_os.audit.historical_input import (
    configuration_bytes,
    input_manifest_bytes,
    parse_input_manifest_bytes,
    validate_configuration_catalog_binding,
    validate_input_bindings,
)
from stark_trading_os.catalog.fixture_publisher import FixturePublisher
from stark_trading_os.catalog.historical_catalog import parse_historical_manifest_bytes
from stark_trading_os.control.historical_configuration_models import (
    HistoricalStrategyConfigurationVersionV2,
    HistoricalStrategyDraftV2,
)
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.strategy_configurations import (
    StrategyConfigurationUnknown,
    StrategyDraftUnknown,
)
from stark_trading_os.domain.historical_input import (
    HistoricalExecutionV2,
    InputManifestV2,
    SmaConfigurationEnvelopeV2,
    SmaConfigurationInputV2,
)
from stark_trading_os.runner.historical_cost import historical_cost_bytes
from stark_trading_os.runner.historical_input_adapter import (
    _check_catalog_runtime,
    observe_historical_runtime,
)


@dataclass(frozen=True, slots=True)
class HistoricalInputCandidateV2:
    configuration_id: str
    configuration_version: int
    configuration_content_sha256: str
    catalog_revision: str
    input_manifest_bytes: bytes
    input_manifest_sha256: str


class HistoricalInputCandidateError(RuntimeError):
    """Content-free failure; no partial candidate or authorization is returned."""

    def __init__(self) -> None:
        super().__init__("HISTORICAL_INPUT_CANDIDATE_INVALID")


def _execution() -> HistoricalExecutionV2:
    return HistoricalExecutionV2(
        venue="SIM",
        oms_type="NETTING",
        account_type="CASH",
        book_type="L1_MBP",
        initial_state="ZERO_BASE_QUOTE_CASH_NO_POSITION",
        bar_execution=True,
        bar_adaptive_high_low_ordering=False,
        trade_execution=False,
        liquidity_consumption=True,
        routing=False,
        use_random_ids=False,
        use_position_ids=True,
        use_reduce_only=False,
        use_market_order_acks=False,
        allow_cash_borrowing=False,
    )


class HistoricalConfigurationService:
    def __init__(
        self,
        *,
        store: ControlStore,
        runtime_root: Path,
        draft_id_factory: Callable[[], str],
        configuration_id_factory: Callable[[], str],
    ) -> None:
        if not runtime_root.is_absolute() or ".." in runtime_root.parts:
            raise ValueError("Historical runtime root must be absolute server configuration.")
        self._store = store
        self._runtime_root = runtime_root
        self._publisher = FixturePublisher(registry=None, control=store, runtime_root=runtime_root)
        self._draft_id_factory = draft_id_factory
        self._configuration_id_factory = configuration_id_factory

    def create_draft(self, configuration: SmaConfigurationInputV2) -> HistoricalStrategyDraftV2:
        return self._store.create_historical_strategy_draft(
            draft_id=self._draft_id_factory(), configuration=configuration
        )

    def draft(self, draft_id: str) -> HistoricalStrategyDraftV2:
        value = self._store.historical_strategy_draft(draft_id)
        if value is None:
            raise StrategyDraftUnknown(draft_id)
        return value

    def drafts(self) -> tuple[HistoricalStrategyDraftV2, ...]:
        return self._store.historical_strategy_drafts()

    def draft_page(
        self,
        *,
        after_id: str | None = None,
        limit: int = 50,
    ) -> tuple[tuple[HistoricalStrategyDraftV2, ...], str | None]:
        return self._store.historical_strategy_draft_page(after_id=after_id, limit=limit)

    def configuration_page(
        self,
        *,
        after_id: str | None = None,
        limit: int = 50,
    ) -> tuple[tuple[HistoricalStrategyConfigurationVersionV2, ...], str | None]:
        return self._store.historical_strategy_configuration_page(after_id=after_id, limit=limit)

    def update_draft(
        self,
        *,
        draft_id: str,
        expected_revision: int,
        configuration: SmaConfigurationInputV2,
    ) -> HistoricalStrategyDraftV2:
        return self._store.update_historical_strategy_draft(
            draft_id=draft_id, expected_revision=expected_revision, configuration=configuration
        )

    def publish_draft(
        self,
        *,
        draft_id: str,
        expected_revision: int,
    ) -> HistoricalStrategyConfigurationVersionV2:
        return self._store.publish_historical_strategy_draft(
            draft_id=draft_id,
            expected_revision=expected_revision,
            configuration_id=self._configuration_id_factory(),
        )

    def configuration(self, configuration_id: str) -> HistoricalStrategyConfigurationVersionV2:
        value = self._store.historical_strategy_configuration(configuration_id)
        if value is None:
            raise StrategyConfigurationUnknown(configuration_id)
        return value

    def versions(self, draft_id: str) -> tuple[HistoricalStrategyConfigurationVersionV2, ...]:
        self.draft(draft_id)
        return self._store.historical_strategy_configuration_versions(draft_id)

    def build_input_candidate(self, configuration_id: str) -> HistoricalInputCandidateV2:
        """Bind saved intent to two verified catalog observations and current runtime.

        This does not create/consume a preflight, reserve a run or start an engine.
        Future Control authorization and the runner must revalidate mutable state.
        """
        try:
            if not self._runtime_root.is_dir():
                raise HistoricalInputCandidateError()
            version = self.configuration(configuration_id)
            if version.configuration_id != configuration_id:
                raise HistoricalInputCandidateError()
            configuration = version.configuration
            revision = configuration.catalog_revision
            publication = self._publisher.revalidate(revision)
            runtime = observe_historical_runtime()
            catalog = parse_historical_manifest_bytes(publication.publication_bytes)
            _check_catalog_runtime(catalog, runtime)
            dataset = validate_configuration_catalog_binding(
                configuration, catalog_manifest_bytes=publication.publication_bytes
            )
            if sha256(configuration_bytes(configuration)).hexdigest() != version.content_sha256:
                raise HistoricalInputCandidateError()
            manifest = InputManifestV2(
                schema="InputManifest.v2",
                environment="BACKTEST",
                configuration_id=version.configuration_id,
                configuration_version=version.version,
                configuration=SmaConfigurationEnvelopeV2(
                    kind="StrategyConfigurationInput.v2", configuration=configuration
                ),
                configuration_content_sha256=version.content_sha256,
                dataset=dataset,
                cost_sha256=sha256(historical_cost_bytes(configuration.execution_cost)).hexdigest(),
                runtime=runtime,
                execution=_execution(),
            )
            validate_input_bindings(
                manifest,
                catalog_manifest_bytes=publication.publication_bytes,
                expected_runtime=runtime,
            )
            raw = input_manifest_bytes(manifest)
            digest = sha256(raw).hexdigest()
            parse_input_manifest_bytes(raw, expected_sha256=digest)
            if (
                self._publisher.revalidate(revision) != publication
                or self.configuration(configuration_id) != version
                or self._store.catalog_publication(revision) != publication
            ):
                raise HistoricalInputCandidateError()
            return HistoricalInputCandidateV2(
                configuration_id=version.configuration_id,
                configuration_version=version.version,
                configuration_content_sha256=version.content_sha256,
                catalog_revision=revision,
                input_manifest_bytes=raw,
                input_manifest_sha256=digest,
            )
        except Exception:
            # Raw paths, input fields and native exceptions are never exposed by this boundary.
            raise HistoricalInputCandidateError() from None
