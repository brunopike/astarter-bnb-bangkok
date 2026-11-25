BEGIN IMMEDIATE;

ALTER TABLE strategy_drafts ADD COLUMN content_schema TEXT NOT NULL
    DEFAULT 'StrategyConfigurationInput.v1'
    CHECK (content_schema IN ('StrategyConfigurationInput.v1', 'StrategyConfigurationInput.v2'));

ALTER TABLE strategy_configuration_versions ADD COLUMN content_schema TEXT NOT NULL
    DEFAULT 'StrategyConfigurationInput.v1'
    CHECK (content_schema IN ('StrategyConfigurationInput.v1', 'StrategyConfigurationInput.v2'));

CREATE TRIGGER trg_strategy_drafts_immutable_kind
BEFORE UPDATE OF content_schema ON strategy_drafts
WHEN NEW.content_schema != OLD.content_schema
BEGIN
    SELECT RAISE(ABORT, 'strategy draft content kind is immutable');
END;

CREATE TRIGGER trg_strategy_versions_immutable_kind
BEFORE UPDATE OF content_schema ON strategy_configuration_versions
WHEN NEW.content_schema != OLD.content_schema
BEGIN
    SELECT RAISE(ABORT, 'strategy version content kind is immutable');
END;

CREATE TRIGGER trg_strategy_versions_parent_kind_insert
BEFORE INSERT ON strategy_configuration_versions
WHEN NOT EXISTS (
    SELECT 1 FROM strategy_drafts
    WHERE draft_id = NEW.draft_id AND content_schema = NEW.content_schema
)
BEGIN
    SELECT RAISE(ABORT, 'strategy version must match parent kind');
END;

CREATE TRIGGER trg_strategy_versions_parent_kind_update
BEFORE UPDATE ON strategy_configuration_versions
WHEN NOT EXISTS (
    SELECT 1 FROM strategy_drafts
    WHERE draft_id = NEW.draft_id AND content_schema = NEW.content_schema
)
BEGIN
    SELECT RAISE(ABORT, 'strategy version must match parent kind');
END;

CREATE TRIGGER trg_historical_strategy_versions_reject_update
BEFORE UPDATE ON strategy_configuration_versions
WHEN OLD.content_schema = 'StrategyConfigurationInput.v2'
BEGIN
    SELECT RAISE(ABORT, 'historical strategy versions are immutable');
END;

CREATE TRIGGER trg_historical_strategy_versions_reject_delete
BEFORE DELETE ON strategy_configuration_versions
WHEN OLD.content_schema = 'StrategyConfigurationInput.v2'
BEGIN
    SELECT RAISE(ABORT, 'historical strategy versions are immutable');
END;

-- Per-connection binary capability: already-open schema3 writers lack this
-- function and fail before writing. A future migration must replace these
-- exact-version guards before its newer binary performs any data writes.
CREATE TRIGGER trg_runs_schema4_insert
BEFORE INSERT ON runs
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runs_schema4_update
BEFORE UPDATE ON runs
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runs_schema4_delete
BEFORE DELETE ON runs
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_catalog_publications_schema4_insert
BEFORE INSERT ON catalog_publications
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_catalog_publications_schema4_update
BEFORE UPDATE ON catalog_publications
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_catalog_publications_schema4_delete
BEFORE DELETE ON catalog_publications
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_catalog_audit_intents_schema4_insert
BEFORE INSERT ON catalog_audit_intents
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_catalog_audit_intents_schema4_update
BEFORE UPDATE ON catalog_audit_intents
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_catalog_audit_intents_schema4_delete
BEFORE DELETE ON catalog_audit_intents
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_preflights_schema4_insert
BEFORE INSERT ON preflights
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_preflights_schema4_update
BEFORE UPDATE ON preflights
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_preflights_schema4_delete
BEFORE DELETE ON preflights
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_idempotency_records_schema4_insert
BEFORE INSERT ON idempotency_records
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_idempotency_records_schema4_update
BEFORE UPDATE ON idempotency_records
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_idempotency_records_schema4_delete
BEFORE DELETE ON idempotency_records
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_events_schema4_insert
BEFORE INSERT ON events
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_events_schema4_update
BEFORE UPDATE ON events
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_events_schema4_delete
BEFORE DELETE ON events
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_audit_intents_schema4_insert
BEFORE INSERT ON audit_intents
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_audit_intents_schema4_update
BEFORE UPDATE ON audit_intents
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_audit_intents_schema4_delete
BEFORE DELETE ON audit_intents
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_outbox_schema4_insert
BEFORE INSERT ON outbox
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_outbox_schema4_update
BEFORE UPDATE ON outbox
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_outbox_schema4_delete
BEFORE DELETE ON outbox
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runner_processes_schema4_insert
BEFORE INSERT ON runner_processes
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runner_processes_schema4_update
BEFORE UPDATE ON runner_processes
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runner_processes_schema4_delete
BEFORE DELETE ON runner_processes
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runner_outcomes_schema4_insert
BEFORE INSERT ON runner_outcomes
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runner_outcomes_schema4_update
BEFORE UPDATE ON runner_outcomes
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_runner_outcomes_schema4_delete
BEFORE DELETE ON runner_outcomes
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_finalization_faults_schema4_insert
BEFORE INSERT ON finalization_faults
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_finalization_faults_schema4_update
BEFORE UPDATE ON finalization_faults
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_finalization_faults_schema4_delete
BEFORE DELETE ON finalization_faults
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_seals_schema4_insert
BEFORE INSERT ON seals
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_seals_schema4_update
BEFORE UPDATE ON seals
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_seals_schema4_delete
BEFORE DELETE ON seals
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_terminal_preparations_schema4_insert
BEFORE INSERT ON terminal_preparations
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_terminal_preparations_schema4_update
BEFORE UPDATE ON terminal_preparations
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_terminal_preparations_schema4_delete
BEFORE DELETE ON terminal_preparations
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_drafts_schema4_insert
BEFORE INSERT ON strategy_drafts
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_drafts_schema4_update
BEFORE UPDATE ON strategy_drafts
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_drafts_schema4_delete
BEFORE DELETE ON strategy_drafts
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_configuration_versions_schema4_insert
BEFORE INSERT ON strategy_configuration_versions
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_configuration_versions_schema4_update
BEFORE UPDATE ON strategy_configuration_versions
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_configuration_versions_schema4_delete
BEFORE DELETE ON strategy_configuration_versions
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_configuration_audit_entries_schema4_insert
BEFORE INSERT ON strategy_configuration_audit_entries
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_configuration_audit_entries_schema4_update
BEFORE UPDATE ON strategy_configuration_audit_entries
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_strategy_configuration_audit_entries_schema4_delete
BEFORE DELETE ON strategy_configuration_audit_entries
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_preflight_configuration_bindings_schema4_insert
BEFORE INSERT ON preflight_configuration_bindings
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_preflight_configuration_bindings_schema4_update
BEFORE UPDATE ON preflight_configuration_bindings
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

CREATE TRIGGER trg_preflight_configuration_bindings_schema4_delete
BEFORE DELETE ON preflight_configuration_bindings
WHEN stark_control_writer_schema_version() IS NOT 4
BEGIN
    SELECT RAISE(ABORT, 'control writer schema version mismatch');
END;

PRAGMA user_version = 4;

COMMIT;
