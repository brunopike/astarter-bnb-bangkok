BEGIN IMMEDIATE;

-- Account risk state only: native cache/reports remain the cash and fill authority.
CREATE TABLE astarter_accounts (
 account_id TEXT PRIMARY KEY CHECK(length(account_id) BETWEEN 1 AND 64),
 venue_session TEXT NOT NULL UNIQUE CHECK(length(venue_session)=36),
 baseline_quote TEXT NOT NULL CHECK(length(baseline_quote) BETWEEN 1 AND 256),
 risk_period TEXT NOT NULL CHECK(length(risk_period) BETWEEN 1 AND 64),
 lock_fraction TEXT NOT NULL CHECK(length(lock_fraction) BETWEEN 1 AND 256),
 risk_epoch INTEGER NOT NULL DEFAULT 0 CHECK(risk_epoch>=0),
 controller_fence INTEGER NOT NULL DEFAULT 1 CHECK(controller_fence>0),
 profit_hwm TEXT NOT NULL DEFAULT '0',
 locked_reserve TEXT NOT NULL DEFAULT '0',
 hard_locks BLOB NOT NULL DEFAULT X'5b5d' CHECK(typeof(hard_locks)='blob'),
 last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
 last_snapshot BLOB,
 last_snapshot_sha256 TEXT CHECK(last_snapshot_sha256 IS NULL OR length(last_snapshot_sha256)=64)
) STRICT;
CREATE TABLE astarter_bindings (
 binding_id TEXT PRIMARY KEY CHECK(length(binding_id)=36),
 account_id TEXT NOT NULL REFERENCES astarter_accounts(account_id),
 component_id TEXT NOT NULL CHECK(length(component_id)=64),
 policy_bytes BLOB NOT NULL CHECK(typeof(policy_bytes)='blob'),
 policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256)=64),
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED')),
 UNIQUE(binding_id,account_id), UNIQUE(account_id,component_id,policy_sha256)
) STRICT;
CREATE TABLE astarter_limits (
 account_id TEXT NOT NULL REFERENCES astarter_accounts(account_id),
 scope TEXT NOT NULL CHECK(scope IN ('PRIVATE','CYCLE','DAY','PORTFOLIO','ASSET','CORRELATED','EVENT')),
 cap TEXT NOT NULL, booked_debit TEXT NOT NULL DEFAULT '0',
 PRIMARY KEY(account_id,scope)
) STRICT;
CREATE TABLE astarter_intents (
 intent_id TEXT PRIMARY KEY CHECK(length(intent_id)=36),
 account_id TEXT NOT NULL REFERENCES astarter_accounts(account_id),
 binding_id TEXT NOT NULL,
 opportunity_key TEXT NOT NULL CHECK(length(opportunity_key) BETWEEN 1 AND 128),
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
 receipt_bytes BLOB NOT NULL CHECK(typeof(receipt_bytes)='blob'),
 entry_order_id TEXT NOT NULL UNIQUE CHECK(length(entry_order_id) BETWEEN 1 AND 36),
 state TEXT NOT NULL CHECK(state IN ('RESERVED','DISPATCHING','ACTIVE','CLOSING','CLOSED','NO_FILL','RECONCILING')),
 pending_risk TEXT NOT NULL, inventory_risk TEXT NOT NULL DEFAULT '0', cash_hold TEXT NOT NULL,
 last_exit_attempt_ns INTEGER NOT NULL DEFAULT 0 CHECK(last_exit_attempt_ns>=0),
 UNIQUE(intent_id,account_id), UNIQUE(account_id,opportunity_key),
 FOREIGN KEY(binding_id,account_id) REFERENCES astarter_bindings(binding_id,account_id)
) STRICT;
CREATE TABLE astarter_orders (
 order_id TEXT PRIMARY KEY CHECK(length(order_id) BETWEEN 1 AND 36),
 account_id TEXT NOT NULL REFERENCES astarter_accounts(account_id),
 intent_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('ENTRY','STOP','EXIT')),
 quantity TEXT NOT NULL,
 trigger_price TEXT,
 native_state TEXT NOT NULL DEFAULT 'UNKNOWN',
 dispatch_state TEXT NOT NULL DEFAULT 'PENDING' CHECK(dispatch_state IN ('PENDING','DISPATCHING','OBSERVED','CANCELED_LOCAL')),
 cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
 accepted_at_ns INTEGER CHECK(accepted_at_ns IS NULL OR accepted_at_ns>=0),
 deadline_ns INTEGER CHECK(deadline_ns IS NULL OR deadline_ns>=0),
 last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
 UNIQUE(order_id,account_id),
 FOREIGN KEY(intent_id,account_id) REFERENCES astarter_intents(intent_id,account_id)
) STRICT;
CREATE TABLE astarter_fills (
 account_id TEXT NOT NULL,
 order_id TEXT NOT NULL,
 trade_id TEXT NOT NULL CHECK(length(trade_id) BETWEEN 1 AND 128),
 fact_bytes BLOB NOT NULL CHECK(typeof(fact_bytes)='blob'),
 fact_sha256 TEXT NOT NULL CHECK(length(fact_sha256)=64),
 PRIMARY KEY(account_id,order_id,trade_id),
 FOREIGN KEY(order_id,account_id) REFERENCES astarter_orders(order_id,account_id)
) STRICT;
CREATE TABLE astarter_settlements (
 account_id TEXT NOT NULL REFERENCES astarter_accounts(account_id),
 economic_id TEXT NOT NULL CHECK(length(economic_id)=64),
 fact_sha256 TEXT NOT NULL CHECK(length(fact_sha256)=64),
 profit_increment TEXT NOT NULL, new_lock TEXT NOT NULL,
 evidence_bytes BLOB NOT NULL CHECK(typeof(evidence_bytes)='blob'),
 PRIMARY KEY(account_id,economic_id)
) STRICT;
CREATE TABLE astarter_audit (
 account_id TEXT NOT NULL REFERENCES astarter_accounts(account_id),
 seq INTEGER NOT NULL CHECK(seq>0), kind TEXT NOT NULL,
 fact_bytes BLOB NOT NULL CHECK(typeof(fact_bytes)='blob'),
 fact_sha256 TEXT NOT NULL CHECK(length(fact_sha256)=64),
 PRIMARY KEY(account_id,seq)
) STRICT;
CREATE INDEX idx_astarter_intents_account ON astarter_intents(account_id,state);
CREATE INDEX idx_astarter_orders_intent ON astarter_orders(intent_id,role);
CREATE TRIGGER trg_astarter_accounts_identity BEFORE UPDATE OF account_id,venue_session,baseline_quote,risk_period,lock_fraction ON astarter_accounts
WHEN NEW.account_id IS NOT OLD.account_id OR NEW.venue_session IS NOT OLD.venue_session OR NEW.baseline_quote IS NOT OLD.baseline_quote OR NEW.risk_period IS NOT OLD.risk_period OR NEW.lock_fraction IS NOT OLD.lock_fraction
BEGIN SELECT RAISE(ABORT,'Astarter account identity/baseline/period is immutable'); END;
CREATE TRIGGER trg_astarter_accounts_no_delete BEFORE DELETE ON astarter_accounts
BEGIN SELECT RAISE(ABORT,'Astarter accounts cannot be deleted'); END;
CREATE TRIGGER trg_astarter_bindings_identity BEFORE UPDATE OF binding_id,account_id,component_id,policy_bytes,policy_sha256 ON astarter_bindings
BEGIN SELECT RAISE(ABORT,'Astarter binding provenance is immutable'); END;
CREATE TRIGGER trg_astarter_intents_identity BEFORE UPDATE OF intent_id,account_id,binding_id,opportunity_key,request_sha256,receipt_bytes,entry_order_id ON astarter_intents
BEGIN SELECT RAISE(ABORT,'Astarter receipt is immutable'); END;
CREATE TRIGGER trg_astarter_orders_identity BEFORE UPDATE OF order_id,account_id,intent_id,role,quantity,trigger_price,deadline_ns ON astarter_orders
BEGIN SELECT RAISE(ABORT,'Astarter order intent is immutable'); END;

-- Replace every old writer guard atomically; already-open schema5 code is fenced.
DROP TRIGGER trg_audit_intents_schema5_delete;
DROP TRIGGER trg_audit_intents_schema5_insert;
DROP TRIGGER trg_audit_intents_schema5_update;
DROP TRIGGER trg_catalog_audit_intents_schema5_delete;
DROP TRIGGER trg_catalog_audit_intents_schema5_insert;
DROP TRIGGER trg_catalog_audit_intents_schema5_update;
DROP TRIGGER trg_catalog_publications_schema5_delete;
DROP TRIGGER trg_catalog_publications_schema5_insert;
DROP TRIGGER trg_catalog_publications_schema5_update;
DROP TRIGGER trg_events_schema5_delete;
DROP TRIGGER trg_events_schema5_insert;
DROP TRIGGER trg_events_schema5_update;
DROP TRIGGER trg_finalization_faults_schema5_delete;
DROP TRIGGER trg_finalization_faults_schema5_insert;
DROP TRIGGER trg_finalization_faults_schema5_update;
DROP TRIGGER trg_historical_preflights_schema5_delete;
DROP TRIGGER trg_historical_preflights_schema5_insert;
DROP TRIGGER trg_historical_preflights_schema5_update;
DROP TRIGGER trg_historical_terminal_anchors_schema5_delete;
DROP TRIGGER trg_historical_terminal_anchors_schema5_insert;
DROP TRIGGER trg_historical_terminal_anchors_schema5_update;
DROP TRIGGER trg_idempotency_records_schema5_delete;
DROP TRIGGER trg_idempotency_records_schema5_insert;
DROP TRIGGER trg_idempotency_records_schema5_update;
DROP TRIGGER trg_outbox_schema5_delete;
DROP TRIGGER trg_outbox_schema5_insert;
DROP TRIGGER trg_outbox_schema5_update;
DROP TRIGGER trg_preflight_configuration_bindings_schema5_delete;
DROP TRIGGER trg_preflight_configuration_bindings_schema5_insert;
DROP TRIGGER trg_preflight_configuration_bindings_schema5_update;
DROP TRIGGER trg_preflights_schema5_delete;
DROP TRIGGER trg_preflights_schema5_insert;
DROP TRIGGER trg_preflights_schema5_update;
DROP TRIGGER trg_runner_outcomes_schema5_delete;
DROP TRIGGER trg_runner_outcomes_schema5_insert;
DROP TRIGGER trg_runner_outcomes_schema5_update;
DROP TRIGGER trg_runner_processes_schema5_delete;
DROP TRIGGER trg_runner_processes_schema5_insert;
DROP TRIGGER trg_runner_processes_schema5_update;
DROP TRIGGER trg_runs_schema5_delete;
DROP TRIGGER trg_runs_schema5_insert;
DROP TRIGGER trg_runs_schema5_update;
DROP TRIGGER trg_seals_schema5_delete;
DROP TRIGGER trg_seals_schema5_insert;
DROP TRIGGER trg_seals_schema5_update;
DROP TRIGGER trg_strategy_configuration_audit_entries_schema5_delete;
DROP TRIGGER trg_strategy_configuration_audit_entries_schema5_insert;
DROP TRIGGER trg_strategy_configuration_audit_entries_schema5_update;
DROP TRIGGER trg_strategy_configuration_versions_schema5_delete;
DROP TRIGGER trg_strategy_configuration_versions_schema5_insert;
DROP TRIGGER trg_strategy_configuration_versions_schema5_update;
DROP TRIGGER trg_strategy_drafts_schema5_delete;
DROP TRIGGER trg_strategy_drafts_schema5_insert;
DROP TRIGGER trg_strategy_drafts_schema5_update;
DROP TRIGGER trg_terminal_preparations_schema5_delete;
DROP TRIGGER trg_terminal_preparations_schema5_insert;
DROP TRIGGER trg_terminal_preparations_schema5_update;
CREATE TRIGGER trg_audit_intents_schema6_insert BEFORE INSERT ON audit_intents
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_audit_intents_schema6_update BEFORE UPDATE ON audit_intents
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_audit_intents_schema6_delete BEFORE DELETE ON audit_intents
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_catalog_audit_intents_schema6_insert BEFORE INSERT ON catalog_audit_intents
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_catalog_audit_intents_schema6_update BEFORE UPDATE ON catalog_audit_intents
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_catalog_audit_intents_schema6_delete BEFORE DELETE ON catalog_audit_intents
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_catalog_publications_schema6_insert BEFORE INSERT ON catalog_publications
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_catalog_publications_schema6_update BEFORE UPDATE ON catalog_publications
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_catalog_publications_schema6_delete BEFORE DELETE ON catalog_publications
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_events_schema6_insert BEFORE INSERT ON events
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_events_schema6_update BEFORE UPDATE ON events
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_events_schema6_delete BEFORE DELETE ON events
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_finalization_faults_schema6_insert BEFORE INSERT ON finalization_faults
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_finalization_faults_schema6_update BEFORE UPDATE ON finalization_faults
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_finalization_faults_schema6_delete BEFORE DELETE ON finalization_faults
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_historical_preflights_schema6_insert BEFORE INSERT ON historical_preflights
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_historical_preflights_schema6_update BEFORE UPDATE ON historical_preflights
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_historical_preflights_schema6_delete BEFORE DELETE ON historical_preflights
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_historical_terminal_anchors_schema6_insert BEFORE INSERT ON historical_terminal_anchors
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_historical_terminal_anchors_schema6_update BEFORE UPDATE ON historical_terminal_anchors
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_historical_terminal_anchors_schema6_delete BEFORE DELETE ON historical_terminal_anchors
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_idempotency_records_schema6_insert BEFORE INSERT ON idempotency_records
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_idempotency_records_schema6_update BEFORE UPDATE ON idempotency_records
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_idempotency_records_schema6_delete BEFORE DELETE ON idempotency_records
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_outbox_schema6_insert BEFORE INSERT ON outbox
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_outbox_schema6_update BEFORE UPDATE ON outbox
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_outbox_schema6_delete BEFORE DELETE ON outbox
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_preflight_configuration_bindings_schema6_insert BEFORE INSERT ON preflight_configuration_bindings
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_preflight_configuration_bindings_schema6_update BEFORE UPDATE ON preflight_configuration_bindings
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_preflight_configuration_bindings_schema6_delete BEFORE DELETE ON preflight_configuration_bindings
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_preflights_schema6_insert BEFORE INSERT ON preflights
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_preflights_schema6_update BEFORE UPDATE ON preflights
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_preflights_schema6_delete BEFORE DELETE ON preflights
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_runner_outcomes_schema6_insert BEFORE INSERT ON runner_outcomes
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_runner_outcomes_schema6_update BEFORE UPDATE ON runner_outcomes
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_runner_outcomes_schema6_delete BEFORE DELETE ON runner_outcomes
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_runner_processes_schema6_insert BEFORE INSERT ON runner_processes
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_runner_processes_schema6_update BEFORE UPDATE ON runner_processes
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_runner_processes_schema6_delete BEFORE DELETE ON runner_processes
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_runs_schema6_insert BEFORE INSERT ON runs
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_runs_schema6_update BEFORE UPDATE ON runs
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_runs_schema6_delete BEFORE DELETE ON runs
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_seals_schema6_insert BEFORE INSERT ON seals
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_seals_schema6_update BEFORE UPDATE ON seals
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_seals_schema6_delete BEFORE DELETE ON seals
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_strategy_configuration_audit_entries_schema6_insert BEFORE INSERT ON strategy_configuration_audit_entries
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_strategy_configuration_audit_entries_schema6_update BEFORE UPDATE ON strategy_configuration_audit_entries
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_strategy_configuration_audit_entries_schema6_delete BEFORE DELETE ON strategy_configuration_audit_entries
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_strategy_configuration_versions_schema6_insert BEFORE INSERT ON strategy_configuration_versions
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_strategy_configuration_versions_schema6_update BEFORE UPDATE ON strategy_configuration_versions
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_strategy_configuration_versions_schema6_delete BEFORE DELETE ON strategy_configuration_versions
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_strategy_drafts_schema6_insert BEFORE INSERT ON strategy_drafts
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_strategy_drafts_schema6_update BEFORE UPDATE ON strategy_drafts
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_strategy_drafts_schema6_delete BEFORE DELETE ON strategy_drafts
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_terminal_preparations_schema6_insert BEFORE INSERT ON terminal_preparations
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_terminal_preparations_schema6_update BEFORE UPDATE ON terminal_preparations
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_terminal_preparations_schema6_delete BEFORE DELETE ON terminal_preparations
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_accounts_schema6_insert BEFORE INSERT ON astarter_accounts
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_accounts_schema6_update BEFORE UPDATE ON astarter_accounts
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_accounts_schema6_delete BEFORE DELETE ON astarter_accounts
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_bindings_schema6_insert BEFORE INSERT ON astarter_bindings
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_bindings_schema6_update BEFORE UPDATE ON astarter_bindings
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_bindings_schema6_delete BEFORE DELETE ON astarter_bindings
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_limits_schema6_insert BEFORE INSERT ON astarter_limits
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_limits_schema6_update BEFORE UPDATE ON astarter_limits
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_limits_schema6_delete BEFORE DELETE ON astarter_limits
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_intents_schema6_insert BEFORE INSERT ON astarter_intents
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_intents_schema6_update BEFORE UPDATE ON astarter_intents
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_intents_schema6_delete BEFORE DELETE ON astarter_intents
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_orders_schema6_insert BEFORE INSERT ON astarter_orders
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_orders_schema6_update BEFORE UPDATE ON astarter_orders
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_orders_schema6_delete BEFORE DELETE ON astarter_orders
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_fills_schema6_insert BEFORE INSERT ON astarter_fills
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_fills_schema6_update BEFORE UPDATE ON astarter_fills
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_fills_schema6_delete BEFORE DELETE ON astarter_fills
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_settlements_schema6_insert BEFORE INSERT ON astarter_settlements
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_settlements_schema6_update BEFORE UPDATE ON astarter_settlements
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_settlements_schema6_delete BEFORE DELETE ON astarter_settlements
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_audit_schema6_insert BEFORE INSERT ON astarter_audit
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_audit_schema6_update BEFORE UPDATE ON astarter_audit
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_audit_schema6_delete BEFORE DELETE ON astarter_audit
WHEN stark_control_writer_schema_version() <> 6
BEGIN SELECT RAISE(ABORT,'control writer schema version mismatch'); END;
CREATE TRIGGER trg_astarter_fills_immutable_update BEFORE UPDATE ON astarter_fills
BEGIN SELECT RAISE(ABORT,'Astarter economic facts are append-only'); END;
CREATE TRIGGER trg_astarter_fills_immutable_delete BEFORE DELETE ON astarter_fills
BEGIN SELECT RAISE(ABORT,'Astarter economic facts are append-only'); END;
CREATE TRIGGER trg_astarter_settlements_immutable_update BEFORE UPDATE ON astarter_settlements
BEGIN SELECT RAISE(ABORT,'Astarter economic facts are append-only'); END;
CREATE TRIGGER trg_astarter_settlements_immutable_delete BEFORE DELETE ON astarter_settlements
BEGIN SELECT RAISE(ABORT,'Astarter economic facts are append-only'); END;
CREATE TRIGGER trg_astarter_audit_immutable_update BEFORE UPDATE ON astarter_audit
BEGIN SELECT RAISE(ABORT,'Astarter economic facts are append-only'); END;
CREATE TRIGGER trg_astarter_audit_immutable_delete BEFORE DELETE ON astarter_audit
BEGIN SELECT RAISE(ABORT,'Astarter economic facts are append-only'); END;

PRAGMA user_version = 6;
COMMIT;
