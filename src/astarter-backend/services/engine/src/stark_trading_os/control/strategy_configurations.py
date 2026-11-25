"""Closed strategy catalog and transactional configuration persistence."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from hashlib import sha256
from typing import Protocol

from pydantic import ValidationError

from stark_trading_os.audit.canonical_json import (
    CanonicalJSONError,
    canonical_json_bytes,
    parse_json_object,
)
from stark_trading_os.control.database import _immediate_transaction, _verify_write_connection
from stark_trading_os.control.strategy_models import (
    ConfigurationInput,
    StrategyConfigurationVersion,
    StrategyDataRequirements,
    StrategyDefinition,
    StrategyDraft,
)
from stark_trading_os.domain.models import (
    BacktestDraftRequest,
    DeterminismProbeConfigV1,
    FrozenJsonObject,
    InputManifestV1,
)

PROBE_STRATEGY_REF = "determinism-probe@v1"
PROBE_DEFAULT_REPLAY_SEED = 7
PROBE_PARAMETERS = DeterminismProbeConfigV1(
    entry_limit_price="100",
    entry_quantity="15",
    metric_round_trip_quantity="1",
    metric_round_trips=5,
    risk_probe_quantity="20",
    venue_rejection_quantity="1",
)


class StrategyConfigurationError(RuntimeError):
    """Base class for safe strategy configuration failures."""


class StrategyUnknown(StrategyConfigurationError):
    """Raised when a configuration references no executable catalog entry."""


class StrategyDraftUnknown(StrategyConfigurationError):
    """Raised when a draft identity is absent."""


class StrategyConfigurationUnknown(StrategyConfigurationError):
    """Raised when an immutable configuration identity is absent."""


class StrategyRevisionConflict(StrategyConfigurationError):
    """Raised when a draft compare-and-swap revision is stale."""


class StrategyConfigurationIntegrityError(StrategyConfigurationError):
    """Raised when persisted canonical configuration identity fails verification."""


class StrategyConfigurationStorageError(StrategyConfigurationError):
    """Raised when SQLite cannot complete a configuration operation."""


class StrategyPreflightConflict(StrategyConfigurationError):
    """Raised when a preflight request contradicts its selected version."""


@dataclass(frozen=True)
class RegisteredDefinition:
    identifier: str
    version: str
    canonical_bytes: bytes
    sha256: str


@dataclass(frozen=True)
class StrategyConfigurationBinding:
    configuration_id: str
    content_sha256: str


class StrategyConfigurationStore(Protocol):
    def create_strategy_draft(
        self, *, draft_id: str, configuration: ConfigurationInput
    ) -> StrategyDraft: ...

    def strategy_drafts(self) -> tuple[StrategyDraft, ...]: ...

    def strategy_draft(self, draft_id: str) -> StrategyDraft | None: ...

    def update_strategy_draft(
        self,
        *,
        draft_id: str,
        expected_revision: int,
        configuration: ConfigurationInput,
    ) -> StrategyDraft: ...

    def publish_strategy_draft(
        self,
        *,
        draft_id: str,
        expected_revision: int,
        configuration_id: str,
    ) -> StrategyConfigurationVersion: ...

    def strategy_configuration(
        self, configuration_id: str
    ) -> StrategyConfigurationVersion | None: ...

    def strategy_configuration_versions(
        self, draft_id: str
    ) -> tuple[StrategyConfigurationVersion, ...]: ...

    def run_strategy_configuration(
        self, run_id: str
    ) -> StrategyConfigurationVersion | None: ...


class StrategyCatalog:
    """The single catalog authority for both HTTP discovery and preflight resolution."""

    def __init__(self) -> None:
        canonical_parameters = canonical_json_bytes(
            PROBE_PARAMETERS.model_dump(mode="json", by_alias=True)
        )
        self._registered = RegisteredDefinition(
            identifier="determinism-probe",
            version="v1",
            canonical_bytes=canonical_parameters,
            sha256=sha256(canonical_parameters).hexdigest(),
        )
        self._definition = StrategyDefinition(
            strategy_ref=PROBE_STRATEGY_REF,
            name="Determinism QA Probe",
            purpose="QA_PROBE",
            description=(
                "Fixed native-engine determinism, fill, rejection, risk, and replay QA probe."
            ),
            parameters_schema=FrozenJsonObject(
                DeterminismProbeConfigV1.model_json_schema(mode="validation")
            ),
            default_parameters=PROBE_PARAMETERS,
            default_replay_seed=PROBE_DEFAULT_REPLAY_SEED,
            execution_modes=("BACKTEST",),
            data_requirements=StrategyDataRequirements(
                catalog_purpose="LOCAL_QA_ONLY",
                fixture_label="LOCAL QA FIXTURE",
                data_types=("instruments", "quotes"),
                timezone="UTC",
            ),
        )

    def definitions(self) -> tuple[StrategyDefinition, ...]:
        return (self._definition,)

    def resolve(self, strategy_ref: str) -> RegisteredDefinition | None:
        return self._registered if strategy_ref == PROBE_STRATEGY_REF else None

    def validate(self, configuration: ConfigurationInput) -> None:
        if configuration.strategy_ref != PROBE_STRATEGY_REF:
            raise StrategyUnknown(configuration.strategy_ref)
        if configuration.parameters != PROBE_PARAMETERS:
            raise StrategyUnknown(configuration.strategy_ref)


class StrategyConfigurationService:
    def __init__(
        self,
        *,
        store: StrategyConfigurationStore,
        catalog: StrategyCatalog,
        draft_id_factory: Callable[[], str],
        configuration_id_factory: Callable[[], str],
    ) -> None:
        self._store = store
        self._catalog = catalog
        self._draft_id_factory = draft_id_factory
        self._configuration_id_factory = configuration_id_factory

    def definitions(self) -> tuple[StrategyDefinition, ...]:
        return self._catalog.definitions()

    def create_draft(self, configuration: ConfigurationInput) -> StrategyDraft:
        self._catalog.validate(configuration)
        return self._store.create_strategy_draft(
            draft_id=self._draft_id_factory(),
            configuration=configuration,
        )

    def drafts(self) -> tuple[StrategyDraft, ...]:
        return self._store.strategy_drafts()

    def draft(self, draft_id: str) -> StrategyDraft:
        draft = self._store.strategy_draft(draft_id)
        if draft is None:
            raise StrategyDraftUnknown(draft_id)
        self._catalog.validate(_draft_input(draft))
        return draft

    def update_draft(
        self,
        *,
        draft_id: str,
        expected_revision: int,
        configuration: ConfigurationInput,
    ) -> StrategyDraft:
        self._catalog.validate(configuration)
        return self._store.update_strategy_draft(
            draft_id=draft_id,
            expected_revision=expected_revision,
            configuration=configuration,
        )

    def publish_draft(
        self,
        *,
        draft_id: str,
        expected_revision: int,
    ) -> StrategyConfigurationVersion:
        version = self._store.publish_strategy_draft(
            draft_id=draft_id,
            expected_revision=expected_revision,
            configuration_id=self._configuration_id_factory(),
        )
        self._catalog.validate(_version_input(version))
        return version

    def configuration(self, configuration_id: str) -> StrategyConfigurationVersion:
        version = self._store.strategy_configuration(configuration_id)
        if version is None:
            raise StrategyConfigurationUnknown(configuration_id)
        self._catalog.validate(_version_input(version))
        return version

    def versions(self, draft_id: str) -> tuple[StrategyConfigurationVersion, ...]:
        if self._store.strategy_draft(draft_id) is None:
            raise StrategyDraftUnknown(draft_id)
        versions = self._store.strategy_configuration_versions(draft_id)
        for version in versions:
            self._catalog.validate(_version_input(version))
        return versions

    def resolve_preflight(
        self,
        *,
        configuration_id: str,
        request: BacktestDraftRequest,
    ) -> tuple[BacktestDraftRequest, StrategyConfigurationBinding]:
        version = self.configuration(configuration_id)
        if (
            request.strategy_ref != version.strategy_ref
            or request.replay_seed != version.replay_seed
        ):
            raise StrategyPreflightConflict(configuration_id)
        return request, StrategyConfigurationBinding(
            configuration_id=version.configuration_id,
            content_sha256=version.content_sha256,
        )

    def configuration_for_run(self, run_id: str) -> StrategyConfigurationVersion | None:
        version = self._store.run_strategy_configuration(run_id)
        if version is not None:
            self._catalog.validate(_version_input(version))
        return version


def create_strategy_draft(
    connection: sqlite3.Connection,
    *,
    clock: Callable[[], int],
    draft_id: str,
    configuration: ConfigurationInput,
) -> StrategyDraft:
    content_bytes = _configuration_bytes(configuration)
    content_sha256 = sha256(content_bytes).hexdigest()
    try:
        with _immediate_transaction(connection):
            created_at_ns = _clock_ns(clock)
            connection.execute(
                """
                INSERT INTO strategy_drafts (
                    draft_id, content_bytes, content_sha256, revision,
                    created_at_ns, updated_at_ns
                ) VALUES (?, ?, ?, 1, ?, ?)
                """,
                (draft_id, content_bytes, content_sha256, created_at_ns, created_at_ns),
            )
            _append_audit(
                connection,
                action="strategy_draft.created",
                draft_id=draft_id,
                configuration_id=None,
                revision=1,
                content_sha256=content_sha256,
                created_at_ns=created_at_ns,
            )
            draft = _read_draft(connection, draft_id)
            assert draft is not None
            return draft
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error


def read_strategy_draft(
    connection: sqlite3.Connection, draft_id: str
) -> StrategyDraft | None:
    try:
        _verify_write_connection(connection)
        return _read_draft(connection, draft_id)
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error


def read_strategy_drafts(connection: sqlite3.Connection) -> tuple[StrategyDraft, ...]:
    try:
        _verify_write_connection(connection)
        rows = connection.execute(
            """
            SELECT draft_id, content_bytes, content_sha256, revision,
                   created_at_ns, updated_at_ns
            FROM strategy_drafts
            WHERE content_schema = 'StrategyConfigurationInput.v1'
            ORDER BY updated_at_ns DESC, draft_id ASC
            """
        ).fetchall()
        return tuple(_draft_from_row(row) for row in rows)
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error


def update_strategy_draft(
    connection: sqlite3.Connection,
    *,
    clock: Callable[[], int],
    draft_id: str,
    expected_revision: int,
    configuration: ConfigurationInput,
) -> StrategyDraft:
    content_bytes = _configuration_bytes(configuration)
    content_sha256 = sha256(content_bytes).hexdigest()
    try:
        with _immediate_transaction(connection):
            current = _read_draft(connection, draft_id)
            if current is None:
                raise StrategyDraftUnknown(draft_id)
            if current.revision != expected_revision:
                raise StrategyRevisionConflict(draft_id)
            revision = expected_revision + 1
            updated_at_ns = _clock_ns(clock)
            updated = connection.execute(
                """
                UPDATE strategy_drafts
                SET content_bytes = ?, content_sha256 = ?, revision = ?, updated_at_ns = ?
                WHERE content_schema = 'StrategyConfigurationInput.v1' AND draft_id = ?
                  AND revision = ?
                """,
                (
                    content_bytes,
                    content_sha256,
                    revision,
                    updated_at_ns,
                    draft_id,
                    expected_revision,
                ),
            )
            if updated.rowcount != 1:
                raise StrategyRevisionConflict(draft_id)
            _append_audit(
                connection,
                action="strategy_draft.updated",
                draft_id=draft_id,
                configuration_id=None,
                revision=revision,
                content_sha256=content_sha256,
                created_at_ns=updated_at_ns,
            )
            result = _read_draft(connection, draft_id)
            assert result is not None
            return result
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error


def publish_strategy_draft(
    connection: sqlite3.Connection,
    *,
    clock: Callable[[], int],
    draft_id: str,
    expected_revision: int,
    configuration_id: str,
) -> StrategyConfigurationVersion:
    try:
        with _immediate_transaction(connection):
            existing = _read_version_for_revision(connection, draft_id, expected_revision)
            if existing is not None:
                return existing
            draft = _read_draft(connection, draft_id)
            if draft is None:
                raise StrategyDraftUnknown(draft_id)
            if draft.revision != expected_revision:
                raise StrategyRevisionConflict(draft_id)
            row = connection.execute(
                """
                SELECT COALESCE(MAX(version), 0) + 1
                FROM strategy_configuration_versions
                WHERE content_schema = 'StrategyConfigurationInput.v1' AND draft_id = ?
                """,
                (draft_id,),
            ).fetchone()
            if row is None or type(row[0]) is not int:
                raise StrategyConfigurationIntegrityError(
                    "Configuration version sequence is invalid."
                )
            version_number = int(row[0])
            created_at_ns = _clock_ns(clock)
            content = _draft_input(draft)
            content_bytes = _configuration_bytes(content)
            content_sha256 = sha256(content_bytes).hexdigest()
            connection.execute(
                """
                INSERT INTO strategy_configuration_versions (
                    configuration_id, draft_id, version, source_revision,
                    content_bytes, content_sha256, created_at_ns
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    configuration_id,
                    draft_id,
                    version_number,
                    expected_revision,
                    content_bytes,
                    content_sha256,
                    created_at_ns,
                ),
            )
            _append_audit(
                connection,
                action="strategy_configuration.published",
                draft_id=draft_id,
                configuration_id=configuration_id,
                revision=expected_revision,
                content_sha256=content_sha256,
                created_at_ns=created_at_ns,
            )
            result = _read_configuration(connection, configuration_id)
            assert result is not None
            return result
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error


def read_strategy_configuration(
    connection: sqlite3.Connection, configuration_id: str
) -> StrategyConfigurationVersion | None:
    try:
        _verify_write_connection(connection)
        return _read_configuration(connection, configuration_id)
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error


def read_strategy_configuration_versions(
    connection: sqlite3.Connection, draft_id: str
) -> tuple[StrategyConfigurationVersion, ...]:
    try:
        _verify_write_connection(connection)
        rows = connection.execute(
            """
            SELECT configuration_id, draft_id, version, source_revision,
                   content_bytes, content_sha256, created_at_ns
            FROM strategy_configuration_versions
            WHERE content_schema = 'StrategyConfigurationInput.v1' AND draft_id = ?
            ORDER BY version DESC
            """,
            (draft_id,),
        ).fetchall()
        return tuple(_version_from_row(row) for row in rows)
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error


def read_run_strategy_configuration(
    connection: sqlite3.Connection, run_id: str
) -> StrategyConfigurationVersion | None:
    try:
        _verify_write_connection(connection)
        row = connection.execute(
            """
            SELECT binding.preflight_id, preflight.request_bytes,
                   preflight.input_manifest_bytes
            FROM preflight_configuration_bindings AS binding
            LEFT JOIN preflights AS preflight
              ON preflight.preflight_id = binding.preflight_id
            WHERE binding.run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if row is None:
            return None
        request_bytes = _row_bytes(row, "request_bytes")
        manifest_value = row["input_manifest_bytes"]
        if manifest_value is not None and type(manifest_value) is not bytes:
            raise StrategyConfigurationIntegrityError("Persisted input manifest must be bytes.")
        binding = validate_preflight_configuration_binding(
            connection,
            preflight_id=_row_str(row, "preflight_id"),
            run_id=run_id,
            request_bytes=request_bytes,
            input_manifest_bytes=manifest_value,
        )
        if binding is None:
            raise StrategyConfigurationIntegrityError("Run configuration binding is missing.")
        version = _read_configuration(connection, binding.configuration_id)
        if version is None:
            raise StrategyConfigurationIntegrityError("Run configuration version is missing.")
        return version
    except sqlite3.Error as error:
        raise StrategyConfigurationStorageError from error


def persist_preflight_configuration_binding(
    connection: sqlite3.Connection,
    *,
    preflight_id: str,
    run_id: str,
    binding: StrategyConfigurationBinding,
    request_bytes: bytes,
    input_manifest_bytes: bytes | None,
    created_at_ns: int,
) -> None:
    if type(binding) is not StrategyConfigurationBinding:
        raise StrategyConfigurationIntegrityError("Configuration binding authority is invalid.")
    _validate_configuration_for_preflight(
        connection,
        binding=binding,
        request_bytes=request_bytes,
        input_manifest_bytes=input_manifest_bytes,
    )
    connection.execute(
        """
        INSERT INTO preflight_configuration_bindings (
            preflight_id, run_id, configuration_id,
            configuration_content_sha256, created_at_ns
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (
            preflight_id,
            run_id,
            binding.configuration_id,
            binding.content_sha256,
            created_at_ns,
        ),
    )


def validate_preflight_configuration_binding(
    connection: sqlite3.Connection,
    *,
    preflight_id: str,
    run_id: str,
    request_bytes: bytes,
    input_manifest_bytes: bytes | None,
    expected: StrategyConfigurationBinding | None = None,
) -> StrategyConfigurationBinding | None:
    row = connection.execute(
        """
        SELECT binding.preflight_id AS binding_preflight_id,
               binding.run_id AS binding_run_id,
               binding.configuration_id AS binding_configuration_id,
               binding.configuration_content_sha256 AS binding_content_sha256,
               binding.created_at_ns AS binding_created_at_ns
        FROM preflight_configuration_bindings AS binding
        WHERE binding.preflight_id = ?
        """,
        (preflight_id,),
    ).fetchone()
    if row is None:
        if expected is not None:
            raise StrategyConfigurationIntegrityError("Configuration binding is missing.")
        return None
    binding = StrategyConfigurationBinding(
        configuration_id=_row_str(row, "binding_configuration_id"),
        content_sha256=_row_str(row, "binding_content_sha256"),
    )
    if (
        _row_str(row, "binding_preflight_id") != preflight_id
        or _row_str(row, "binding_run_id") != run_id
        or _row_int(row, "binding_created_at_ns") < 1_000_000_000_000_000_000
        or (expected is not None and binding != expected)
    ):
        raise StrategyConfigurationIntegrityError("Configuration binding identity is invalid.")
    _validate_configuration_for_preflight(
        connection,
        binding=binding,
        request_bytes=request_bytes,
        input_manifest_bytes=input_manifest_bytes,
    )
    return binding


def _validate_configuration_for_preflight(
    connection: sqlite3.Connection,
    *,
    binding: StrategyConfigurationBinding,
    request_bytes: bytes,
    input_manifest_bytes: bytes | None,
) -> None:
    row = connection.execute(
        """
        SELECT content_bytes, content_sha256
        FROM strategy_configuration_versions
        WHERE content_schema = 'StrategyConfigurationInput.v1' AND configuration_id = ?
        """,
        (binding.configuration_id,),
    ).fetchone()
    if row is None or _row_str(row, "content_sha256") != binding.content_sha256:
        raise StrategyConfigurationIntegrityError("Bound configuration identity is invalid.")
    configuration = _configuration_from_bytes(
        _row_bytes(row, "content_bytes"), expected_sha256=binding.content_sha256
    )
    try:
        request_value = parse_json_object(request_bytes)
        if canonical_json_bytes(request_value) != request_bytes:
            raise ValueError("Preflight request bytes are not canonical.")
        draft = BacktestDraftRequest.model_validate(request_value)
        if (
            draft.strategy_ref != configuration.strategy_ref
            or draft.replay_seed != configuration.replay_seed
        ):
            raise ValueError("Preflight request differs from its configuration.")
        if input_manifest_bytes is not None:
            manifest_value = parse_json_object(input_manifest_bytes)
            if canonical_json_bytes(manifest_value) != input_manifest_bytes:
                raise ValueError("Input manifest bytes are not canonical.")
            manifest = InputManifestV1.model_validate(manifest_value)
            if (
                f"{manifest.strategy_id}@{manifest.strategy_version}"
                != configuration.strategy_ref
                or manifest.replay_seed != configuration.replay_seed
                or manifest_value["canonical_config"]
                != configuration.parameters.model_dump(mode="json", by_alias=True)
            ):
                raise ValueError("Input manifest differs from its bound configuration.")
    except (CanonicalJSONError, KeyError, ValidationError, ValueError) as error:
        raise StrategyConfigurationIntegrityError(
            "Configuration preflight lineage is invalid."
        ) from error


def _read_draft(connection: sqlite3.Connection, draft_id: str) -> StrategyDraft | None:
    row = connection.execute(
        """
        SELECT draft_id, content_bytes, content_sha256, revision,
               created_at_ns, updated_at_ns
        FROM strategy_drafts
        WHERE content_schema = 'StrategyConfigurationInput.v1' AND draft_id = ?
        """,
        (draft_id,),
    ).fetchone()
    return None if row is None else _draft_from_row(row)


def _read_configuration(
    connection: sqlite3.Connection, configuration_id: str
) -> StrategyConfigurationVersion | None:
    row = connection.execute(
        """
        SELECT configuration_id, draft_id, version, source_revision,
               content_bytes, content_sha256, created_at_ns
        FROM strategy_configuration_versions
        WHERE content_schema = 'StrategyConfigurationInput.v1' AND configuration_id = ?
        """,
        (configuration_id,),
    ).fetchone()
    return None if row is None else _version_from_row(row)


def _read_version_for_revision(
    connection: sqlite3.Connection, draft_id: str, source_revision: int
) -> StrategyConfigurationVersion | None:
    row = connection.execute(
        """
        SELECT configuration_id, draft_id, version, source_revision,
               content_bytes, content_sha256, created_at_ns
        FROM strategy_configuration_versions
        WHERE content_schema = 'StrategyConfigurationInput.v1' AND draft_id = ?
          AND source_revision = ?
        """,
        (draft_id, source_revision),
    ).fetchone()
    return None if row is None else _version_from_row(row)


def _draft_from_row(row: sqlite3.Row) -> StrategyDraft:
    configuration = _configuration_from_bytes(
        _row_bytes(row, "content_bytes"),
        expected_sha256=_row_str(row, "content_sha256"),
    )
    try:
        return StrategyDraft(
            **configuration.model_dump(mode="python"),
            draft_id=_row_str(row, "draft_id"),
            revision=_row_int(row, "revision"),
            created_at_ns=str(_row_int(row, "created_at_ns")),
            updated_at_ns=str(_row_int(row, "updated_at_ns")),
        )
    except ValidationError as error:
        raise StrategyConfigurationIntegrityError("Persisted strategy draft is invalid.") from error


def _version_from_row(row: sqlite3.Row) -> StrategyConfigurationVersion:
    content_sha256 = _row_str(row, "content_sha256")
    configuration = _configuration_from_bytes(
        _row_bytes(row, "content_bytes"), expected_sha256=content_sha256
    )
    try:
        return StrategyConfigurationVersion(
            **configuration.model_dump(mode="python"),
            configuration_id=_row_str(row, "configuration_id"),
            draft_id=_row_str(row, "draft_id"),
            version=_row_int(row, "version"),
            source_revision=_row_int(row, "source_revision"),
            content_sha256=content_sha256,
            created_at_ns=str(_row_int(row, "created_at_ns")),
        )
    except ValidationError as error:
        raise StrategyConfigurationIntegrityError(
            "Persisted strategy configuration is invalid."
        ) from error


def _configuration_bytes(configuration: ConfigurationInput) -> bytes:
    if type(configuration) is not ConfigurationInput:
        configuration = ConfigurationInput.model_validate(
            configuration.model_dump(mode="python")
        )
    return canonical_json_bytes(
        {
            "kind": "StrategyConfigurationInput.v1",
            "configuration": configuration.model_dump(mode="json", by_alias=True),
        }
    )


def _configuration_from_bytes(
    content_bytes: bytes, *, expected_sha256: str
) -> ConfigurationInput:
    if sha256(content_bytes).hexdigest() != expected_sha256:
        raise StrategyConfigurationIntegrityError("Configuration content hash mismatch.")
    try:
        envelope = parse_json_object(content_bytes)
        if set(envelope) != {"kind", "configuration"}:
            raise ValueError("Configuration envelope fields are invalid.")
        if envelope["kind"] != "StrategyConfigurationInput.v1":
            raise ValueError("Configuration envelope schema is invalid.")
        configuration = ConfigurationInput.model_validate(envelope["configuration"])
    except (CanonicalJSONError, ValidationError, ValueError) as error:
        raise StrategyConfigurationIntegrityError("Configuration content is invalid.") from error
    if _configuration_bytes(configuration) != content_bytes:
        raise StrategyConfigurationIntegrityError("Configuration bytes are not canonical.")
    return configuration


def _append_audit(
    connection: sqlite3.Connection,
    *,
    action: str,
    draft_id: str,
    configuration_id: str | None,
    revision: int,
    content_sha256: str,
    created_at_ns: int,
) -> None:
    entry_bytes = canonical_json_bytes(
        {
            "action": action,
            "configuration_id": configuration_id,
            "content_sha256": content_sha256,
            "draft_id": draft_id,
            "revision": revision,
        }
    )
    connection.execute(
        """
        INSERT INTO strategy_configuration_audit_entries (
            action, draft_id, configuration_id, revision, content_sha256,
            entry_bytes, entry_sha256, created_at_ns
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            action,
            draft_id,
            configuration_id,
            revision,
            content_sha256,
            entry_bytes,
            sha256(entry_bytes).hexdigest(),
            created_at_ns,
        ),
    )


def _draft_input(draft: StrategyDraft) -> ConfigurationInput:
    return ConfigurationInput.model_validate(
        {
            "name": draft.name,
            "strategy_ref": draft.strategy_ref,
            "parameters": draft.parameters.model_dump(mode="json"),
            "replay_seed": draft.replay_seed,
        }
    )


def _version_input(version: StrategyConfigurationVersion) -> ConfigurationInput:
    return ConfigurationInput.model_validate(
        {
            "name": version.name,
            "strategy_ref": version.strategy_ref,
            "parameters": version.parameters.model_dump(mode="json"),
            "replay_seed": version.replay_seed,
        }
    )


def _row_str(row: sqlite3.Row, key: str) -> str:
    value = row[key]
    if type(value) is not str:
        raise StrategyConfigurationIntegrityError(f"Persisted {key} must be text.")
    return value


def _row_bytes(row: sqlite3.Row, key: str) -> bytes:
    value = row[key]
    if type(value) is not bytes:
        raise StrategyConfigurationIntegrityError(f"Persisted {key} must be bytes.")
    return value


def _row_int(row: sqlite3.Row, key: str) -> int:
    value = row[key]
    if type(value) is not int:
        raise StrategyConfigurationIntegrityError(f"Persisted {key} must be an integer.")
    return value


def _clock_ns(clock: Callable[[], int]) -> int:
    value = clock()
    if type(value) is not int or value < 1_000_000_000_000_000_000:
        raise ValueError("Strategy configuration clock must return Unix epoch nanoseconds.")
    return value
