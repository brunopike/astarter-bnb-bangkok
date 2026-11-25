BEGIN IMMEDIATE;

-- S03 bridge state. Economic facts stay in the existing Astarter tables.
CREATE TABLE s03_runs (
 run_id TEXT PRIMARY KEY CHECK(length(run_id)=64),
 account_id TEXT NOT NULL UNIQUE REFERENCES astarter_accounts(account_id),
 venue_session TEXT NOT NULL CHECK(length(venue_session)=36),
 group_id TEXT NOT NULL CHECK(length(group_id) BETWEEN 1 AND 64),
 plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64),
 manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64),
 owner_id TEXT NOT NULL CHECK(length(owner_id)=64),
 owner_epoch INTEGER NOT NULL CHECK(owner_epoch>0),
 fence INTEGER NOT NULL CHECK(fence>0),
 credential_sha256 TEXT NOT NULL CHECK(length(credential_sha256)=64),
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','CLOSED')),
 starts_at_ns INTEGER NOT NULL CHECK(starts_at_ns>=0),
 expires_at_ns INTEGER NOT NULL CHECK(expires_at_ns>starts_at_ns),
 quote_watermark INTEGER CHECK(quote_watermark IS NULL OR quote_watermark>=0),
 quote_event_ns INTEGER CHECK(quote_event_ns IS NULL OR quote_event_ns>=0),
 reasons BLOB NOT NULL CHECK(typeof(reasons)='blob'),
 recovery_reactivation INTEGER NOT NULL DEFAULT 0 CHECK(recovery_reactivation IN (0,1))
) STRICT;
CREATE TABLE s03_events (
 run_id TEXT NOT NULL REFERENCES s03_runs(run_id),
 event_key TEXT NOT NULL CHECK(length(event_key)=64),
 kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 32),
 content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
 source_event_time_ns INTEGER NOT NULL CHECK(source_event_time_ns>=0),
 received_time_ns INTEGER NOT NULL CHECK(received_time_ns>=0),
 PRIMARY KEY(run_id, event_key)
) STRICT;
CREATE TABLE s03_signals (
 run_id TEXT NOT NULL REFERENCES s03_runs(run_id),
 signal_id TEXT NOT NULL CHECK(length(signal_id)=64),
 content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
 intent_id TEXT,
 PRIMARY KEY(run_id, signal_id)
) STRICT;
CREATE TABLE s03_lifecycle (
 run_id TEXT PRIMARY KEY REFERENCES s03_runs(run_id),
 first_fill_ns INTEGER CHECK(first_fill_ns IS NULL OR first_fill_ns>=0),
 rsi_fail_streak INTEGER NOT NULL DEFAULT 0 CHECK(rsi_fail_streak>=0),
 hold_seen INTEGER NOT NULL DEFAULT 0 CHECK(hold_seen>=0),
 cooldown_bars INTEGER NOT NULL DEFAULT 0 CHECK(cooldown_bars>=0),
 flat_ns INTEGER CHECK(flat_ns IS NULL OR flat_ns>=0),
 exit_claims INTEGER NOT NULL DEFAULT 0 CHECK(exit_claims>=0),
 last_exit_ns INTEGER CHECK(last_exit_ns IS NULL OR last_exit_ns>=0),
 exit_deadline_ns INTEGER CHECK(exit_deadline_ns IS NULL OR exit_deadline_ns>=0),
 protection_deadline_ns INTEGER CHECK(protection_deadline_ns IS NULL OR protection_deadline_ns>=0),
 residual_used INTEGER NOT NULL DEFAULT 0 CHECK(residual_used IN (0,1)),
 day_baseline TEXT,
 day_key TEXT,
 exit_target TEXT,
 blocked_signal_id TEXT,
 reasons BLOB NOT NULL CHECK(typeof(reasons)='blob')
) STRICT;
CREATE TABLE s03_plan_manifest (
 run_id TEXT PRIMARY KEY REFERENCES s03_runs(run_id),
 plan_json TEXT NOT NULL CHECK(length(plan_json)>2),
 manifest_json TEXT NOT NULL CHECK(length(manifest_json)>2)
) STRICT;
CREATE TABLE s03_audit (
 run_id TEXT NOT NULL REFERENCES s03_runs(run_id),
 seq INTEGER NOT NULL CHECK(seq>0),
 kind TEXT NOT NULL,
 fact_bytes BLOB NOT NULL CHECK(typeof(fact_bytes)='blob'),
 fact_sha256 TEXT NOT NULL CHECK(length(fact_sha256)=64),
 PRIMARY KEY(run_id, seq)
) STRICT;
-- New capability fences old writers at statement prepare, including zero-row/cached SQL.
CREATE TRIGGER s03_astarter_accounts_i BEFORE INSERT ON astarter_accounts
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_accounts_u BEFORE UPDATE ON astarter_accounts
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_accounts_d BEFORE DELETE ON astarter_accounts
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_admission_heads_i BEFORE INSERT ON astarter_admission_heads
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_admission_heads_u BEFORE UPDATE ON astarter_admission_heads
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_admission_heads_d BEFORE DELETE ON astarter_admission_heads
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_admissions_i BEFORE INSERT ON astarter_admissions
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_admissions_u BEFORE UPDATE ON astarter_admissions
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_admissions_d BEFORE DELETE ON astarter_admissions
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_approval_references_i BEFORE INSERT ON astarter_approval_references
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_approval_references_u BEFORE UPDATE ON astarter_approval_references
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_approval_references_d BEFORE DELETE ON astarter_approval_references
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_audit_i BEFORE INSERT ON astarter_audit
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_audit_u BEFORE UPDATE ON astarter_audit
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_audit_d BEFORE DELETE ON astarter_audit
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_bindings_i BEFORE INSERT ON astarter_bindings
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_bindings_u BEFORE UPDATE ON astarter_bindings
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_bindings_d BEFORE DELETE ON astarter_bindings
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_episode_references_i BEFORE INSERT ON astarter_episode_references
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_episode_references_u BEFORE UPDATE ON astarter_episode_references
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_episode_references_d BEFORE DELETE ON astarter_episode_references
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_fills_i BEFORE INSERT ON astarter_fills
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_fills_u BEFORE UPDATE ON astarter_fills
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_fills_d BEFORE DELETE ON astarter_fills
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_intent_admissions_i BEFORE INSERT ON astarter_intent_admissions
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_intent_admissions_u BEFORE UPDATE ON astarter_intent_admissions
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_intent_admissions_d BEFORE DELETE ON astarter_intent_admissions
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_intents_i BEFORE INSERT ON astarter_intents
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_intents_u BEFORE UPDATE ON astarter_intents
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_intents_d BEFORE DELETE ON astarter_intents
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_layer_references_i BEFORE INSERT ON astarter_layer_references
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_layer_references_u BEFORE UPDATE ON astarter_layer_references
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_layer_references_d BEFORE DELETE ON astarter_layer_references
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_limits_i BEFORE INSERT ON astarter_limits
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_limits_u BEFORE UPDATE ON astarter_limits
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_limits_d BEFORE DELETE ON astarter_limits
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_orders_i BEFORE INSERT ON astarter_orders
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_orders_u BEFORE UPDATE ON astarter_orders
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_orders_d BEFORE DELETE ON astarter_orders
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_plan_versions_i BEFORE INSERT ON astarter_plan_versions
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_plan_versions_u BEFORE UPDATE ON astarter_plan_versions
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_plan_versions_d BEFORE DELETE ON astarter_plan_versions
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_recovery_checkpoints_i BEFORE INSERT ON astarter_recovery_checkpoints
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_recovery_checkpoints_u BEFORE UPDATE ON astarter_recovery_checkpoints
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_recovery_checkpoints_d BEFORE DELETE ON astarter_recovery_checkpoints
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_settlements_i BEFORE INSERT ON astarter_settlements
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_settlements_u BEFORE UPDATE ON astarter_settlements
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_settlements_d BEFORE DELETE ON astarter_settlements
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_strategy_scopes_i BEFORE INSERT ON astarter_strategy_scopes
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_strategy_scopes_u BEFORE UPDATE ON astarter_strategy_scopes
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_strategy_scopes_d BEFORE DELETE ON astarter_strategy_scopes
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_strategy_versions_i BEFORE INSERT ON astarter_strategy_versions
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_strategy_versions_u BEFORE UPDATE ON astarter_strategy_versions
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_astarter_strategy_versions_d BEFORE DELETE ON astarter_strategy_versions
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_audit_intents_i BEFORE INSERT ON audit_intents
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_audit_intents_u BEFORE UPDATE ON audit_intents
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_audit_intents_d BEFORE DELETE ON audit_intents
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_catalog_audit_intents_i BEFORE INSERT ON catalog_audit_intents
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_catalog_audit_intents_u BEFORE UPDATE ON catalog_audit_intents
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_catalog_audit_intents_d BEFORE DELETE ON catalog_audit_intents
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_catalog_publications_i BEFORE INSERT ON catalog_publications
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_catalog_publications_u BEFORE UPDATE ON catalog_publications
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_catalog_publications_d BEFORE DELETE ON catalog_publications
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_events_i BEFORE INSERT ON events
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_events_u BEFORE UPDATE ON events
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_events_d BEFORE DELETE ON events
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_finalization_faults_i BEFORE INSERT ON finalization_faults
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_finalization_faults_u BEFORE UPDATE ON finalization_faults
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_finalization_faults_d BEFORE DELETE ON finalization_faults
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_historical_preflights_i BEFORE INSERT ON historical_preflights
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_historical_preflights_u BEFORE UPDATE ON historical_preflights
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_historical_preflights_d BEFORE DELETE ON historical_preflights
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_historical_terminal_anchors_i BEFORE INSERT ON historical_terminal_anchors
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_historical_terminal_anchors_u BEFORE UPDATE ON historical_terminal_anchors
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_historical_terminal_anchors_d BEFORE DELETE ON historical_terminal_anchors
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_idempotency_records_i BEFORE INSERT ON idempotency_records
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_idempotency_records_u BEFORE UPDATE ON idempotency_records
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_idempotency_records_d BEFORE DELETE ON idempotency_records
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_outbox_i BEFORE INSERT ON outbox
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_outbox_u BEFORE UPDATE ON outbox
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_outbox_d BEFORE DELETE ON outbox
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_preflight_configuration_bindings_i BEFORE INSERT ON preflight_configuration_bindings
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_preflight_configuration_bindings_u BEFORE UPDATE ON preflight_configuration_bindings
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_preflight_configuration_bindings_d BEFORE DELETE ON preflight_configuration_bindings
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_preflights_i BEFORE INSERT ON preflights
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_preflights_u BEFORE UPDATE ON preflights
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_preflights_d BEFORE DELETE ON preflights
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_runner_outcomes_i BEFORE INSERT ON runner_outcomes
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_runner_outcomes_u BEFORE UPDATE ON runner_outcomes
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_runner_outcomes_d BEFORE DELETE ON runner_outcomes
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_runner_processes_i BEFORE INSERT ON runner_processes
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_runner_processes_u BEFORE UPDATE ON runner_processes
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_runner_processes_d BEFORE DELETE ON runner_processes
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_runs_i BEFORE INSERT ON runs
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_runs_u BEFORE UPDATE ON runs
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_runs_d BEFORE DELETE ON runs
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_audit_i BEFORE INSERT ON s03_audit
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_audit_u BEFORE UPDATE ON s03_audit
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_audit_d BEFORE DELETE ON s03_audit
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_events_i BEFORE INSERT ON s03_events
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_events_u BEFORE UPDATE ON s03_events
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_events_d BEFORE DELETE ON s03_events
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_lifecycle_i BEFORE INSERT ON s03_lifecycle
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_lifecycle_u BEFORE UPDATE ON s03_lifecycle
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_lifecycle_d BEFORE DELETE ON s03_lifecycle
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_plan_manifest_i BEFORE INSERT ON s03_plan_manifest
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_plan_manifest_u BEFORE UPDATE ON s03_plan_manifest
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_plan_manifest_d BEFORE DELETE ON s03_plan_manifest
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_runs_i BEFORE INSERT ON s03_runs
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_runs_u BEFORE UPDATE ON s03_runs
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_runs_d BEFORE DELETE ON s03_runs
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_signals_i BEFORE INSERT ON s03_signals
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_signals_u BEFORE UPDATE ON s03_signals
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_s03_signals_d BEFORE DELETE ON s03_signals
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_seals_i BEFORE INSERT ON seals
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_seals_u BEFORE UPDATE ON seals
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_seals_d BEFORE DELETE ON seals
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_strategy_configuration_audit_entries_i BEFORE INSERT ON strategy_configuration_audit_entries
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_strategy_configuration_audit_entries_u BEFORE UPDATE ON strategy_configuration_audit_entries
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_strategy_configuration_audit_entries_d BEFORE DELETE ON strategy_configuration_audit_entries
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_strategy_configuration_versions_i BEFORE INSERT ON strategy_configuration_versions
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_strategy_configuration_versions_u BEFORE UPDATE ON strategy_configuration_versions
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_strategy_configuration_versions_d BEFORE DELETE ON strategy_configuration_versions
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_strategy_drafts_i BEFORE INSERT ON strategy_drafts
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_strategy_drafts_u BEFORE UPDATE ON strategy_drafts
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_strategy_drafts_d BEFORE DELETE ON strategy_drafts
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_terminal_preparations_i BEFORE INSERT ON terminal_preparations
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_terminal_preparations_u BEFORE UPDATE ON terminal_preparations
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER s03_terminal_preparations_d BEFORE DELETE ON terminal_preparations
WHEN stark_control_writer_schema9() IS NOT 9 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;

PRAGMA user_version = 9;
COMMIT;
