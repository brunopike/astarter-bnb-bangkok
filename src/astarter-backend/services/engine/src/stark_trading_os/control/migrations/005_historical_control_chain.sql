BEGIN IMMEDIATE;

ALTER TABLE runs ADD COLUMN contract_kind TEXT NOT NULL DEFAULT 'PROBE_V1'
    CHECK (contract_kind IN ('PROBE_V1', 'HISTORICAL_SMA_V2'));

CREATE TRIGGER trg_runs_immutable_contract_kind
BEFORE UPDATE OF contract_kind ON runs
WHEN NEW.contract_kind IS NOT OLD.contract_kind
BEGIN
    SELECT RAISE(ABORT, 'run contract kind is immutable');
END;

CREATE INDEX idx_runs_active_admission ON runs(state, contract_kind, run_id);

-- Replace all old per-connection guards atomically with the schema upgrade.
DROP TRIGGER trg_runs_schema4_insert;
DROP TRIGGER trg_runs_schema4_update;
DROP TRIGGER trg_runs_schema4_delete;
DROP TRIGGER trg_catalog_publications_schema4_insert;
DROP TRIGGER trg_catalog_publications_schema4_update;
DROP TRIGGER trg_catalog_publications_schema4_delete;
DROP TRIGGER trg_catalog_audit_intents_schema4_insert;
DROP TRIGGER trg_catalog_audit_intents_schema4_update;
DROP TRIGGER trg_catalog_audit_intents_schema4_delete;
DROP TRIGGER trg_preflights_schema4_insert;
DROP TRIGGER trg_preflights_schema4_update;
DROP TRIGGER trg_preflights_schema4_delete;
DROP TRIGGER trg_idempotency_records_schema4_insert;
DROP TRIGGER trg_idempotency_records_schema4_update;
DROP TRIGGER trg_idempotency_records_schema4_delete;
DROP TRIGGER trg_events_schema4_insert;
DROP TRIGGER trg_events_schema4_update;
DROP TRIGGER trg_events_schema4_delete;
DROP TRIGGER trg_audit_intents_schema4_insert;
DROP TRIGGER trg_audit_intents_schema4_update;
DROP TRIGGER trg_audit_intents_schema4_delete;
DROP TRIGGER trg_outbox_schema4_insert;
DROP TRIGGER trg_outbox_schema4_update;
DROP TRIGGER trg_outbox_schema4_delete;
DROP TRIGGER trg_runner_processes_schema4_insert;
DROP TRIGGER trg_runner_processes_schema4_update;
DROP TRIGGER trg_runner_processes_schema4_delete;
DROP TRIGGER trg_runner_outcomes_schema4_insert;
DROP TRIGGER trg_runner_outcomes_schema4_update;
DROP TRIGGER trg_runner_outcomes_schema4_delete;
DROP TRIGGER trg_finalization_faults_schema4_insert;
DROP TRIGGER trg_finalization_faults_schema4_update;
DROP TRIGGER trg_finalization_faults_schema4_delete;
DROP TRIGGER trg_seals_schema4_insert;
DROP TRIGGER trg_seals_schema4_update;
DROP TRIGGER trg_seals_schema4_delete;
DROP TRIGGER trg_terminal_preparations_schema4_insert;
DROP TRIGGER trg_terminal_preparations_schema4_update;
DROP TRIGGER trg_terminal_preparations_schema4_delete;
DROP TRIGGER trg_strategy_drafts_schema4_insert;
DROP TRIGGER trg_strategy_drafts_schema4_update;
DROP TRIGGER trg_strategy_drafts_schema4_delete;
DROP TRIGGER trg_strategy_configuration_versions_schema4_insert;
DROP TRIGGER trg_strategy_configuration_versions_schema4_update;
DROP TRIGGER trg_strategy_configuration_versions_schema4_delete;
DROP TRIGGER trg_strategy_configuration_audit_entries_schema4_insert;
DROP TRIGGER trg_strategy_configuration_audit_entries_schema4_update;
DROP TRIGGER trg_strategy_configuration_audit_entries_schema4_delete;
DROP TRIGGER trg_preflight_configuration_bindings_schema4_insert;
DROP TRIGGER trg_preflight_configuration_bindings_schema4_update;
DROP TRIGGER trg_preflight_configuration_bindings_schema4_delete;

CREATE TABLE idempotency_records_v5 (
    idempotency_scope TEXT NOT NULL
        CHECK (
            idempotency_scope IN ('backtest.preflight', 'backtest.create', 'historical.preflight', 'historical.create')
            OR (
                substr(idempotency_scope, 1, 16) = 'backtest.cancel/'
                AND length(idempotency_scope) > 16
            )
        ),
    idempotency_key TEXT NOT NULL
        CHECK (typeof(idempotency_key) = 'text' AND length(idempotency_key) > 0),
    request_hash TEXT NOT NULL
        CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    request_body BLOB NOT NULL
        CHECK (typeof(request_body) = 'blob'),
    response_status INTEGER NOT NULL
        CHECK (
            typeof(response_status) = 'integer'
            AND response_status BETWEEN 100 AND 599
        ),
    response_body BLOB NOT NULL
        CHECK (typeof(response_body) = 'blob'),
    target_run_id TEXT
        CHECK (
            target_run_id IS NULL
            OR (typeof(target_run_id) = 'text' AND length(target_run_id) > 0)
        ),
    run_id TEXT REFERENCES runs(run_id) ON DELETE RESTRICT,
    created_at_ns INTEGER NOT NULL
        CHECK (typeof(created_at_ns) = 'integer' AND created_at_ns >= 0),
    PRIMARY KEY (idempotency_scope, idempotency_key),
    CHECK (
        (
            idempotency_scope IN ('backtest.preflight', 'backtest.create', 'historical.preflight', 'historical.create')
            AND target_run_id IS NULL
        )
        OR (
            target_run_id IS NOT NULL
            AND idempotency_scope = 'backtest.cancel/' || target_run_id
        )
    ),
    CHECK (target_run_id IS NULL OR run_id IS NULL OR run_id = target_run_id),
    CHECK (
        target_run_id IS NULL
        OR response_status NOT BETWEEN 200 AND 299
        OR (run_id IS NOT NULL AND run_id = target_run_id)
    )
) STRICT;
INSERT INTO idempotency_records_v5 SELECT * FROM idempotency_records;
DROP TABLE idempotency_records;
ALTER TABLE idempotency_records_v5 RENAME TO idempotency_records;

CREATE TABLE historical_preflights (
    preflight_id TEXT PRIMARY KEY CHECK (length(preflight_id) = 36),
    run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE RESTRICT,
    configuration_id TEXT NOT NULL REFERENCES strategy_configuration_versions(configuration_id),
    request_bytes BLOB NOT NULL,
    request_hash TEXT NOT NULL CHECK (length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    result_bytes BLOB NOT NULL,
    catalog_publication_bytes BLOB NOT NULL,
    risk_sha256 TEXT NOT NULL CHECK (length(risk_sha256)=64 AND risk_sha256 NOT GLOB '*[^0-9a-f]*'),
    runtime_sha256 TEXT NOT NULL CHECK (length(runtime_sha256)=64 AND runtime_sha256 NOT GLOB '*[^0-9a-f]*'),
    account_id TEXT NOT NULL CHECK (account_id='SIM-001'),
    checked_at_ns INTEGER NOT NULL CHECK (checked_at_ns > 0),
    expires_at_ns INTEGER NOT NULL CHECK (expires_at_ns > checked_at_ns),
    consumed_at_ns INTEGER CHECK (
        consumed_at_ns IS NULL OR
        (consumed_at_ns >= checked_at_ns AND consumed_at_ns < expires_at_ns)
    )
) STRICT;

CREATE TRIGGER trg_historical_preflights_parent_kind
BEFORE INSERT ON historical_preflights
WHEN NOT EXISTS (
    SELECT 1 FROM runs WHERE run_id=NEW.run_id AND contract_kind='HISTORICAL_SMA_V2'
) OR NOT EXISTS (
    SELECT 1 FROM strategy_configuration_versions WHERE configuration_id=NEW.configuration_id
    AND content_schema='StrategyConfigurationInput.v2'
)
BEGIN
    SELECT RAISE(ABORT, 'historical preflight parent kind mismatch');
END;

CREATE TRIGGER trg_historical_preflights_immutable
BEFORE UPDATE ON historical_preflights
WHEN OLD.consumed_at_ns IS NOT NULL OR NEW.consumed_at_ns IS NULL
    OR NEW.preflight_id IS NOT OLD.preflight_id
    OR NEW.run_id IS NOT OLD.run_id
    OR NEW.configuration_id IS NOT OLD.configuration_id
    OR NEW.request_bytes IS NOT OLD.request_bytes
    OR NEW.request_hash IS NOT OLD.request_hash
    OR NEW.result_bytes IS NOT OLD.result_bytes
    OR NEW.catalog_publication_bytes IS NOT OLD.catalog_publication_bytes
    OR NEW.risk_sha256 IS NOT OLD.risk_sha256
    OR NEW.runtime_sha256 IS NOT OLD.runtime_sha256
    OR NEW.account_id IS NOT OLD.account_id
    OR NEW.checked_at_ns IS NOT OLD.checked_at_ns
    OR NEW.expires_at_ns IS NOT OLD.expires_at_ns
BEGIN
    SELECT RAISE(ABORT, 'historical preflight identity is immutable');
END;

CREATE TRIGGER trg_historical_preflights_reject_delete
BEFORE DELETE ON historical_preflights
BEGIN
    SELECT RAISE(ABORT, 'historical preflights are retained');
END;

CREATE TRIGGER trg_historical_idempotency_parent_kind
BEFORE INSERT ON idempotency_records
WHEN NEW.idempotency_scope IN ('historical.preflight', 'historical.create') AND (
    NOT EXISTS (SELECT 1 FROM runs WHERE run_id=NEW.run_id AND contract_kind='HISTORICAL_SMA_V2')
    OR NEW.response_status != CASE NEW.idempotency_scope WHEN 'historical.preflight' THEN 200 ELSE 202 END
)
BEGIN
    SELECT RAISE(ABORT, 'historical idempotency parent kind mismatch');
END;

CREATE TRIGGER trg_historical_idempotency_reject_update
BEFORE UPDATE ON idempotency_records
WHEN OLD.idempotency_scope IN ('historical.preflight', 'historical.create')
    OR NEW.idempotency_scope IN ('historical.preflight', 'historical.create')
BEGIN
    SELECT RAISE(ABORT, 'historical idempotency receipts are immutable');
END;

CREATE TRIGGER trg_historical_idempotency_reject_delete
BEFORE DELETE ON idempotency_records
WHEN OLD.idempotency_scope IN ('historical.preflight', 'historical.create')
BEGIN
    SELECT RAISE(ABORT, 'historical idempotency receipts are retained');
END;

CREATE TRIGGER trg_historical_preflights_schema5_insert
BEFORE INSERT ON historical_preflights
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_historical_preflights_schema5_update
BEFORE UPDATE ON historical_preflights
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_historical_preflights_schema5_delete
BEFORE DELETE ON historical_preflights
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runs_schema5_insert
BEFORE INSERT ON runs
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runs_schema5_update
BEFORE UPDATE ON runs
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runs_schema5_delete
BEFORE DELETE ON runs
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_catalog_publications_schema5_insert
BEFORE INSERT ON catalog_publications
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_catalog_publications_schema5_update
BEFORE UPDATE ON catalog_publications
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_catalog_publications_schema5_delete
BEFORE DELETE ON catalog_publications
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_catalog_audit_intents_schema5_insert
BEFORE INSERT ON catalog_audit_intents
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_catalog_audit_intents_schema5_update
BEFORE UPDATE ON catalog_audit_intents
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_catalog_audit_intents_schema5_delete
BEFORE DELETE ON catalog_audit_intents
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_preflights_schema5_insert
BEFORE INSERT ON preflights
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_preflights_schema5_update
BEFORE UPDATE ON preflights
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_preflights_schema5_delete
BEFORE DELETE ON preflights
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_idempotency_records_schema5_insert
BEFORE INSERT ON idempotency_records
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_idempotency_records_schema5_update
BEFORE UPDATE ON idempotency_records
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_idempotency_records_schema5_delete
BEFORE DELETE ON idempotency_records
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_events_schema5_insert
BEFORE INSERT ON events
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_events_schema5_update
BEFORE UPDATE ON events
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_events_schema5_delete
BEFORE DELETE ON events
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_audit_intents_schema5_insert
BEFORE INSERT ON audit_intents
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_audit_intents_schema5_update
BEFORE UPDATE ON audit_intents
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_audit_intents_schema5_delete
BEFORE DELETE ON audit_intents
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_outbox_schema5_insert
BEFORE INSERT ON outbox
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_outbox_schema5_update
BEFORE UPDATE ON outbox
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_outbox_schema5_delete
BEFORE DELETE ON outbox
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runner_processes_schema5_insert
BEFORE INSERT ON runner_processes
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runner_processes_schema5_update
BEFORE UPDATE ON runner_processes
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runner_processes_schema5_delete
BEFORE DELETE ON runner_processes
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runner_outcomes_schema5_insert
BEFORE INSERT ON runner_outcomes
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runner_outcomes_schema5_update
BEFORE UPDATE ON runner_outcomes
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runner_outcomes_schema5_delete
BEFORE DELETE ON runner_outcomes
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_finalization_faults_schema5_insert
BEFORE INSERT ON finalization_faults
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_finalization_faults_schema5_update
BEFORE UPDATE ON finalization_faults
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_finalization_faults_schema5_delete
BEFORE DELETE ON finalization_faults
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_seals_schema5_insert
BEFORE INSERT ON seals
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_seals_schema5_update
BEFORE UPDATE ON seals
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_seals_schema5_delete
BEFORE DELETE ON seals
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_terminal_preparations_schema5_insert
BEFORE INSERT ON terminal_preparations
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_terminal_preparations_schema5_update
BEFORE UPDATE ON terminal_preparations
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_terminal_preparations_schema5_delete
BEFORE DELETE ON terminal_preparations
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_drafts_schema5_insert
BEFORE INSERT ON strategy_drafts
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_drafts_schema5_update
BEFORE UPDATE ON strategy_drafts
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_drafts_schema5_delete
BEFORE DELETE ON strategy_drafts
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_configuration_versions_schema5_insert
BEFORE INSERT ON strategy_configuration_versions
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_configuration_versions_schema5_update
BEFORE UPDATE ON strategy_configuration_versions
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_configuration_versions_schema5_delete
BEFORE DELETE ON strategy_configuration_versions
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_configuration_audit_entries_schema5_insert
BEFORE INSERT ON strategy_configuration_audit_entries
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_configuration_audit_entries_schema5_update
BEFORE UPDATE ON strategy_configuration_audit_entries
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_configuration_audit_entries_schema5_delete
BEFORE DELETE ON strategy_configuration_audit_entries
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_preflight_configuration_bindings_schema5_insert
BEFORE INSERT ON preflight_configuration_bindings
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_preflight_configuration_bindings_schema5_update
BEFORE UPDATE ON preflight_configuration_bindings
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_preflight_configuration_bindings_schema5_delete
BEFORE DELETE ON preflight_configuration_bindings
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TABLE historical_terminal_anchors (
    run_id TEXT PRIMARY KEY REFERENCES terminal_preparations(run_id),
    anchor_bytes BLOB NOT NULL,
    anchor_hash TEXT NOT NULL CHECK (length(anchor_hash)=64 AND anchor_hash NOT GLOB '*[^0-9a-f]*'),
    event_digest TEXT NOT NULL CHECK (length(event_digest)=64 AND event_digest NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE TRIGGER trg_historical_terminal_anchors_parent
BEFORE INSERT ON historical_terminal_anchors
WHEN NOT EXISTS (
    SELECT 1 FROM runs JOIN terminal_preparations USING (run_id)
    WHERE run_id=NEW.run_id AND contract_kind='HISTORICAL_SMA_V2'
    AND terminal_preparations.event_digest=NEW.event_digest
    AND runs.state='FINALIZING'
)
BEGIN SELECT RAISE(ABORT, 'historical terminal anchor parent mismatch'); END;

CREATE TRIGGER trg_historical_terminal_anchors_immutable_update
BEFORE UPDATE ON historical_terminal_anchors
BEGIN SELECT RAISE(ABORT, 'historical terminal anchors are immutable'); END;

CREATE TRIGGER trg_historical_terminal_anchors_immutable_delete
BEFORE DELETE ON historical_terminal_anchors
BEGIN SELECT RAISE(ABORT, 'historical terminal anchors are retained'); END;

CREATE TRIGGER trg_historical_terminal_anchors_schema5_insert
BEFORE INSERT ON historical_terminal_anchors
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN SELECT RAISE(ABORT, 'control writer schema version mismatch'); END;

CREATE TRIGGER trg_historical_terminal_anchors_schema5_update
BEFORE UPDATE ON historical_terminal_anchors
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN SELECT RAISE(ABORT, 'control writer schema version mismatch'); END;

CREATE TRIGGER trg_historical_terminal_anchors_schema5_delete
BEFORE DELETE ON historical_terminal_anchors
WHEN stark_control_writer_schema_version() IS NOT 5
BEGIN SELECT RAISE(ABORT, 'control writer schema version mismatch'); END;

PRAGMA user_version = 5;
COMMIT;
