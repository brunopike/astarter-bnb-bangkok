BEGIN IMMEDIATE;

-- Q01 offline references only. No existing economic row is inserted or updated.
-- An explicit trusted backend assignment is required; migration claims no account.
-- WITHOUT ROWID closes the hidden REPLACE conflict path outside declared keys.
CREATE TABLE astarter_strategy_scopes (
 scope_id TEXT PRIMARY KEY CHECK(length(scope_id)=64),
 tenant_id TEXT NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 128),
 account_id TEXT NOT NULL UNIQUE REFERENCES astarter_accounts(account_id),
 environment TEXT NOT NULL CHECK(environment IN ('OFFLINE','PAPER','LIVE')),
 venue_session TEXT NOT NULL CHECK(length(venue_session)=36),
 authority_ref TEXT NOT NULL CHECK(length(authority_ref) BETWEEN 1 AND 128),
 content_bytes BLOB NOT NULL,
 content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
 UNIQUE(tenant_id,account_id,environment), UNIQUE(scope_id,account_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER trg_strategy_scope_account BEFORE INSERT ON astarter_strategy_scopes
WHEN NOT EXISTS(SELECT 1 FROM astarter_accounts WHERE account_id=NEW.account_id AND venue_session=NEW.venue_session)
BEGIN SELECT RAISE(ABORT,'scope account provenance mismatch'); END;

CREATE TABLE astarter_strategy_versions (
 scope_id TEXT NOT NULL REFERENCES astarter_strategy_scopes(scope_id),
 strategy_id TEXT NOT NULL CHECK(length(strategy_id) BETWEEN 1 AND 128),
 kind TEXT NOT NULL CHECK(kind IN ('S03_ORIGINAL','ASTARTER_COMPOSITION','RESEARCH','VP')),
 version TEXT NOT NULL CHECK(length(version) BETWEEN 1 AND 128),
 profile_revision TEXT NOT NULL CHECK(length(profile_revision) BETWEEN 1 AND 128),
 parameter_revision TEXT NOT NULL CHECK(length(parameter_revision) BETWEEN 1 AND 128),
 content_bytes BLOB NOT NULL,
 content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
 PRIMARY KEY(scope_id,strategy_id,kind,version,profile_revision,parameter_revision),
 UNIQUE(scope_id,content_sha256)
) STRICT, WITHOUT ROWID;
CREATE TABLE astarter_plan_versions (
 scope_id TEXT NOT NULL REFERENCES astarter_strategy_scopes(scope_id),
 plan_id TEXT NOT NULL CHECK(length(plan_id) BETWEEN 1 AND 128),
 revision TEXT NOT NULL CHECK(length(revision) BETWEEN 1 AND 128),
 ordinal INTEGER NOT NULL CHECK(ordinal>0),
 previous_revision TEXT,
 request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64),
 spec_sha256 TEXT NOT NULL,
 risk_policy_revision TEXT NOT NULL,
 role_schema_revision TEXT NOT NULL CHECK(role_schema_revision='Q01_S03_NINE_DUTIES_REF_V1'),
 starts_at_ms INTEGER NOT NULL CHECK(starts_at_ms>=0),
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>starts_at_ms),
 content_bytes BLOB NOT NULL,
 content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
 PRIMARY KEY(scope_id,plan_id,revision),
 UNIQUE(scope_id,plan_id,ordinal), UNIQUE(scope_id,request_key),
 UNIQUE(scope_id,plan_id,revision,plan_sha256),
 FOREIGN KEY(scope_id,spec_sha256) REFERENCES astarter_strategy_versions(scope_id,content_sha256),
 FOREIGN KEY(scope_id,plan_id,previous_revision) REFERENCES astarter_plan_versions(scope_id,plan_id,revision),
 CHECK((ordinal=1 AND previous_revision IS NULL) OR (ordinal>1 AND previous_revision IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE TABLE astarter_approval_references (
 scope_id TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 revision TEXT NOT NULL,
 plan_sha256 TEXT NOT NULL,
 reference_id TEXT NOT NULL CHECK(length(reference_id) BETWEEN 1 AND 128),
 request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 authority TEXT NOT NULL CHECK(authority='OFFLINE_REFERENCE'),
 risk_policy_revision TEXT NOT NULL,
 role_schema_revision TEXT NOT NULL CHECK(role_schema_revision='Q01_S03_NINE_DUTIES_REF_V1'),
 starts_at_ms INTEGER NOT NULL CHECK(starts_at_ms>=0),
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>starts_at_ms),
 content_bytes BLOB NOT NULL,
 content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
 PRIMARY KEY(scope_id,reference_id), UNIQUE(scope_id,request_key),
 FOREIGN KEY(scope_id,plan_id,revision,plan_sha256) REFERENCES astarter_plan_versions(scope_id,plan_id,revision,plan_sha256)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_approval_plan ON astarter_approval_references(scope_id,plan_id,revision,reference_id);
CREATE TABLE astarter_episode_references (
 scope_id TEXT NOT NULL,
 account_id TEXT NOT NULL,
 episode_id TEXT NOT NULL CHECK(length(episode_id) BETWEEN 1 AND 128),
 plan_id TEXT NOT NULL,
 revision TEXT NOT NULL,
 plan_sha256 TEXT NOT NULL,
 binding_id TEXT,
 content_bytes BLOB NOT NULL,
 content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
 PRIMARY KEY(scope_id,episode_id), UNIQUE(scope_id,episode_id,plan_id,revision),
 FOREIGN KEY(scope_id,account_id) REFERENCES astarter_strategy_scopes(scope_id,account_id),
 FOREIGN KEY(scope_id,plan_id,revision,plan_sha256) REFERENCES astarter_plan_versions(scope_id,plan_id,revision,plan_sha256),
 FOREIGN KEY(binding_id,account_id) REFERENCES astarter_bindings(binding_id,account_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE astarter_layer_references (
 scope_id TEXT NOT NULL,
 episode_id TEXT NOT NULL,
 layer_index INTEGER NOT NULL CHECK(layer_index BETWEEN 0 AND 127),
 mode TEXT NOT NULL CHECK(mode IN ('VIRTUAL','ACTUAL_REFERENCE')),
 action_id TEXT NOT NULL CHECK(length(action_id) BETWEEN 1 AND 128),
 trigger_id TEXT NOT NULL,
 content_bytes BLOB NOT NULL,
 content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
 PRIMARY KEY(scope_id,episode_id,layer_index), UNIQUE(scope_id,episode_id,action_id),
 FOREIGN KEY(scope_id,episode_id) REFERENCES astarter_episode_references(scope_id,episode_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE astarter_recovery_checkpoints (
 scope_id TEXT NOT NULL,
 account_id TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 revision TEXT NOT NULL,
 plan_sha256 TEXT NOT NULL,
 seq INTEGER NOT NULL CHECK(seq>0),
 previous_sha256 TEXT,
 request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 state_sha256 TEXT NOT NULL CHECK(length(state_sha256)=64),
 lifecycle TEXT NOT NULL CHECK(lifecycle IN ('DRAFT','PREFLIGHT','REVIEWED_REFERENCE','ACTIVE_REFERENCE','PAUSED','EXPIRED')),
 order_state TEXT NOT NULL CHECK(order_state IN ('NONE','PENDING','ACK','PARTIAL','FILLED','CANCELLED','UNKNOWN')),
 protection TEXT NOT NULL CHECK(protection IN ('NOT_REQUIRED','PENDING','SUFFICIENT_REFERENCE','INSUFFICIENT','UNKNOWN')),
 reconciliation TEXT NOT NULL CHECK(reconciliation IN ('NOT_STARTED','PENDING','MATCHED_REFERENCE','MISMATCH','UNKNOWN')),
 causal_id TEXT NOT NULL,
 observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms>=0),
 episode_id TEXT,
 layer_index INTEGER,
 audit_seq INTEGER,
 content_bytes BLOB NOT NULL,
 content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
 PRIMARY KEY(scope_id,plan_id,revision,seq), UNIQUE(scope_id,request_key),
 UNIQUE(scope_id,plan_id,revision,content_sha256),
 FOREIGN KEY(scope_id,account_id) REFERENCES astarter_strategy_scopes(scope_id,account_id),
 FOREIGN KEY(scope_id,plan_id,revision,plan_sha256) REFERENCES astarter_plan_versions(scope_id,plan_id,revision,plan_sha256),
 FOREIGN KEY(scope_id,plan_id,revision,previous_sha256) REFERENCES astarter_recovery_checkpoints(scope_id,plan_id,revision,content_sha256),
 FOREIGN KEY(scope_id,episode_id,plan_id,revision) REFERENCES astarter_episode_references(scope_id,episode_id,plan_id,revision),
 FOREIGN KEY(scope_id,episode_id,layer_index) REFERENCES astarter_layer_references(scope_id,episode_id,layer_index),
 FOREIGN KEY(account_id,audit_seq) REFERENCES astarter_audit(account_id,seq),
 CHECK((seq=1 AND previous_sha256 IS NULL) OR (seq>1 AND length(previous_sha256)=64)),
 CHECK(layer_index IS NULL OR episode_id IS NOT NULL)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_recovery_episode ON astarter_recovery_checkpoints(scope_id,episode_id,layer_index,seq);

-- Append-only version/reference rows. INSERT OR REPLACE cannot erase history.
CREATE TRIGGER trg_strategy_scopes_replace BEFORE INSERT ON astarter_strategy_scopes
WHEN EXISTS(SELECT 1 FROM astarter_strategy_scopes WHERE scope_id=NEW.scope_id OR account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_strategy_versions_replace BEFORE INSERT ON astarter_strategy_versions
WHEN EXISTS(SELECT 1 FROM astarter_strategy_versions WHERE scope_id=NEW.scope_id AND
 (content_sha256=NEW.content_sha256 OR (strategy_id=NEW.strategy_id AND kind=NEW.kind AND version=NEW.version AND profile_revision=NEW.profile_revision AND parameter_revision=NEW.parameter_revision)))
BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_plan_versions_replace BEFORE INSERT ON astarter_plan_versions
WHEN EXISTS(SELECT 1 FROM astarter_plan_versions WHERE scope_id=NEW.scope_id AND
 (request_key=NEW.request_key OR (plan_id=NEW.plan_id AND (revision=NEW.revision OR ordinal=NEW.ordinal))))
BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_approval_references_replace BEFORE INSERT ON astarter_approval_references
WHEN EXISTS(SELECT 1 FROM astarter_approval_references WHERE scope_id=NEW.scope_id AND (reference_id=NEW.reference_id OR request_key=NEW.request_key))
BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_episode_references_replace BEFORE INSERT ON astarter_episode_references
WHEN EXISTS(SELECT 1 FROM astarter_episode_references WHERE scope_id=NEW.scope_id AND episode_id=NEW.episode_id)
BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_layer_references_replace BEFORE INSERT ON astarter_layer_references
WHEN EXISTS(SELECT 1 FROM astarter_layer_references WHERE scope_id=NEW.scope_id AND episode_id=NEW.episode_id AND (layer_index=NEW.layer_index OR action_id=NEW.action_id))
BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_recovery_checkpoints_replace BEFORE INSERT ON astarter_recovery_checkpoints
WHEN EXISTS(SELECT 1 FROM astarter_recovery_checkpoints WHERE scope_id=NEW.scope_id AND
 (request_key=NEW.request_key OR (plan_id=NEW.plan_id AND revision=NEW.revision AND (seq=NEW.seq OR content_sha256=NEW.content_sha256))))
BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_strategy_scopes_update BEFORE UPDATE ON astarter_strategy_scopes BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_strategy_scopes_delete BEFORE DELETE ON astarter_strategy_scopes BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_strategy_versions_update BEFORE UPDATE ON astarter_strategy_versions BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_strategy_versions_delete BEFORE DELETE ON astarter_strategy_versions BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_plan_versions_update BEFORE UPDATE ON astarter_plan_versions BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_plan_versions_delete BEFORE DELETE ON astarter_plan_versions BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_approval_references_update BEFORE UPDATE ON astarter_approval_references BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_approval_references_delete BEFORE DELETE ON astarter_approval_references BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_episode_references_update BEFORE UPDATE ON astarter_episode_references BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_episode_references_delete BEFORE DELETE ON astarter_episode_references BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_layer_references_update BEFORE UPDATE ON astarter_layer_references BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_layer_references_delete BEFORE DELETE ON astarter_layer_references BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_recovery_checkpoints_update BEFORE UPDATE ON astarter_recovery_checkpoints BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;
CREATE TRIGGER trg_recovery_checkpoints_delete BEFORE DELETE ON astarter_recovery_checkpoints BEGIN SELECT RAISE(ABORT,'D1 reference immutable'); END;

-- New capability is resolved at prepare time, including UPDATE/DELETE/INSERT WHERE 0.
-- Existing v6 guards are replaced below, leaving all other immutable triggers intact.
DROP TRIGGER trg_audit_intents_schema6_insert;
DROP TRIGGER trg_audit_intents_schema6_update;
DROP TRIGGER trg_audit_intents_schema6_delete;
DROP TRIGGER trg_catalog_audit_intents_schema6_insert;
DROP TRIGGER trg_catalog_audit_intents_schema6_update;
DROP TRIGGER trg_catalog_audit_intents_schema6_delete;
DROP TRIGGER trg_catalog_publications_schema6_insert;
DROP TRIGGER trg_catalog_publications_schema6_update;
DROP TRIGGER trg_catalog_publications_schema6_delete;
DROP TRIGGER trg_events_schema6_insert;
DROP TRIGGER trg_events_schema6_update;
DROP TRIGGER trg_events_schema6_delete;
DROP TRIGGER trg_finalization_faults_schema6_insert;
DROP TRIGGER trg_finalization_faults_schema6_update;
DROP TRIGGER trg_finalization_faults_schema6_delete;
DROP TRIGGER trg_historical_preflights_schema6_insert;
DROP TRIGGER trg_historical_preflights_schema6_update;
DROP TRIGGER trg_historical_preflights_schema6_delete;
DROP TRIGGER trg_historical_terminal_anchors_schema6_insert;
DROP TRIGGER trg_historical_terminal_anchors_schema6_update;
DROP TRIGGER trg_historical_terminal_anchors_schema6_delete;
DROP TRIGGER trg_idempotency_records_schema6_insert;
DROP TRIGGER trg_idempotency_records_schema6_update;
DROP TRIGGER trg_idempotency_records_schema6_delete;
DROP TRIGGER trg_outbox_schema6_insert;
DROP TRIGGER trg_outbox_schema6_update;
DROP TRIGGER trg_outbox_schema6_delete;
DROP TRIGGER trg_preflight_configuration_bindings_schema6_insert;
DROP TRIGGER trg_preflight_configuration_bindings_schema6_update;
DROP TRIGGER trg_preflight_configuration_bindings_schema6_delete;
DROP TRIGGER trg_preflights_schema6_insert;
DROP TRIGGER trg_preflights_schema6_update;
DROP TRIGGER trg_preflights_schema6_delete;
DROP TRIGGER trg_runner_outcomes_schema6_insert;
DROP TRIGGER trg_runner_outcomes_schema6_update;
DROP TRIGGER trg_runner_outcomes_schema6_delete;
DROP TRIGGER trg_runner_processes_schema6_insert;
DROP TRIGGER trg_runner_processes_schema6_update;
DROP TRIGGER trg_runner_processes_schema6_delete;
DROP TRIGGER trg_runs_schema6_insert;
DROP TRIGGER trg_runs_schema6_update;
DROP TRIGGER trg_runs_schema6_delete;
DROP TRIGGER trg_seals_schema6_insert;
DROP TRIGGER trg_seals_schema6_update;
DROP TRIGGER trg_seals_schema6_delete;
DROP TRIGGER trg_strategy_configuration_audit_entries_schema6_insert;
DROP TRIGGER trg_strategy_configuration_audit_entries_schema6_update;
DROP TRIGGER trg_strategy_configuration_audit_entries_schema6_delete;
DROP TRIGGER trg_strategy_configuration_versions_schema6_insert;
DROP TRIGGER trg_strategy_configuration_versions_schema6_update;
DROP TRIGGER trg_strategy_configuration_versions_schema6_delete;
DROP TRIGGER trg_strategy_drafts_schema6_insert;
DROP TRIGGER trg_strategy_drafts_schema6_update;
DROP TRIGGER trg_strategy_drafts_schema6_delete;
DROP TRIGGER trg_terminal_preparations_schema6_insert;
DROP TRIGGER trg_terminal_preparations_schema6_update;
DROP TRIGGER trg_terminal_preparations_schema6_delete;
DROP TRIGGER trg_astarter_accounts_schema6_insert;
DROP TRIGGER trg_astarter_accounts_schema6_update;
DROP TRIGGER trg_astarter_accounts_schema6_delete;
DROP TRIGGER trg_astarter_bindings_schema6_insert;
DROP TRIGGER trg_astarter_bindings_schema6_update;
DROP TRIGGER trg_astarter_bindings_schema6_delete;
DROP TRIGGER trg_astarter_limits_schema6_insert;
DROP TRIGGER trg_astarter_limits_schema6_update;
DROP TRIGGER trg_astarter_limits_schema6_delete;
DROP TRIGGER trg_astarter_intents_schema6_insert;
DROP TRIGGER trg_astarter_intents_schema6_update;
DROP TRIGGER trg_astarter_intents_schema6_delete;
DROP TRIGGER trg_astarter_orders_schema6_insert;
DROP TRIGGER trg_astarter_orders_schema6_update;
DROP TRIGGER trg_astarter_orders_schema6_delete;
DROP TRIGGER trg_astarter_fills_schema6_insert;
DROP TRIGGER trg_astarter_fills_schema6_update;
DROP TRIGGER trg_astarter_fills_schema6_delete;
DROP TRIGGER trg_astarter_settlements_schema6_insert;
DROP TRIGGER trg_astarter_settlements_schema6_update;
DROP TRIGGER trg_astarter_settlements_schema6_delete;
DROP TRIGGER trg_astarter_audit_schema6_insert;
DROP TRIGGER trg_astarter_audit_schema6_update;
DROP TRIGGER trg_astarter_audit_schema6_delete;

CREATE TRIGGER trg_audit_intents_schema7_insert BEFORE INSERT ON audit_intents WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_audit_intents_schema7_update BEFORE UPDATE ON audit_intents WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_audit_intents_schema7_delete BEFORE DELETE ON audit_intents WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_catalog_audit_intents_schema7_insert BEFORE INSERT ON catalog_audit_intents WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_catalog_audit_intents_schema7_update BEFORE UPDATE ON catalog_audit_intents WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_catalog_audit_intents_schema7_delete BEFORE DELETE ON catalog_audit_intents WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_catalog_publications_schema7_insert BEFORE INSERT ON catalog_publications WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_catalog_publications_schema7_update BEFORE UPDATE ON catalog_publications WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_catalog_publications_schema7_delete BEFORE DELETE ON catalog_publications WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_events_schema7_insert BEFORE INSERT ON events WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_events_schema7_update BEFORE UPDATE ON events WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_events_schema7_delete BEFORE DELETE ON events WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_finalization_faults_schema7_insert BEFORE INSERT ON finalization_faults WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_finalization_faults_schema7_update BEFORE UPDATE ON finalization_faults WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_finalization_faults_schema7_delete BEFORE DELETE ON finalization_faults WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_historical_preflights_schema7_insert BEFORE INSERT ON historical_preflights WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_historical_preflights_schema7_update BEFORE UPDATE ON historical_preflights WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_historical_preflights_schema7_delete BEFORE DELETE ON historical_preflights WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_historical_terminal_anchors_schema7_insert BEFORE INSERT ON historical_terminal_anchors WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_historical_terminal_anchors_schema7_update BEFORE UPDATE ON historical_terminal_anchors WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_historical_terminal_anchors_schema7_delete BEFORE DELETE ON historical_terminal_anchors WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_idempotency_records_schema7_insert BEFORE INSERT ON idempotency_records WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_idempotency_records_schema7_update BEFORE UPDATE ON idempotency_records WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_idempotency_records_schema7_delete BEFORE DELETE ON idempotency_records WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_outbox_schema7_insert BEFORE INSERT ON outbox WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_outbox_schema7_update BEFORE UPDATE ON outbox WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_outbox_schema7_delete BEFORE DELETE ON outbox WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_preflight_configuration_bindings_schema7_insert BEFORE INSERT ON preflight_configuration_bindings WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_preflight_configuration_bindings_schema7_update BEFORE UPDATE ON preflight_configuration_bindings WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_preflight_configuration_bindings_schema7_delete BEFORE DELETE ON preflight_configuration_bindings WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_preflights_schema7_insert BEFORE INSERT ON preflights WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_preflights_schema7_update BEFORE UPDATE ON preflights WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_preflights_schema7_delete BEFORE DELETE ON preflights WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_runner_outcomes_schema7_insert BEFORE INSERT ON runner_outcomes WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_runner_outcomes_schema7_update BEFORE UPDATE ON runner_outcomes WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_runner_outcomes_schema7_delete BEFORE DELETE ON runner_outcomes WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_runner_processes_schema7_insert BEFORE INSERT ON runner_processes WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_runner_processes_schema7_update BEFORE UPDATE ON runner_processes WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_runner_processes_schema7_delete BEFORE DELETE ON runner_processes WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_runs_schema7_insert BEFORE INSERT ON runs WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_runs_schema7_update BEFORE UPDATE ON runs WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_runs_schema7_delete BEFORE DELETE ON runs WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_seals_schema7_insert BEFORE INSERT ON seals WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_seals_schema7_update BEFORE UPDATE ON seals WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_seals_schema7_delete BEFORE DELETE ON seals WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_strategy_configuration_audit_entries_schema7_insert BEFORE INSERT ON strategy_configuration_audit_entries WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_strategy_configuration_audit_entries_schema7_update BEFORE UPDATE ON strategy_configuration_audit_entries WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_strategy_configuration_audit_entries_schema7_delete BEFORE DELETE ON strategy_configuration_audit_entries WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_strategy_configuration_versions_schema7_insert BEFORE INSERT ON strategy_configuration_versions WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_strategy_configuration_versions_schema7_update BEFORE UPDATE ON strategy_configuration_versions WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_strategy_configuration_versions_schema7_delete BEFORE DELETE ON strategy_configuration_versions WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_strategy_drafts_schema7_insert BEFORE INSERT ON strategy_drafts WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_strategy_drafts_schema7_update BEFORE UPDATE ON strategy_drafts WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_strategy_drafts_schema7_delete BEFORE DELETE ON strategy_drafts WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_terminal_preparations_schema7_insert BEFORE INSERT ON terminal_preparations WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_terminal_preparations_schema7_update BEFORE UPDATE ON terminal_preparations WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_terminal_preparations_schema7_delete BEFORE DELETE ON terminal_preparations WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_accounts_schema7_insert BEFORE INSERT ON astarter_accounts WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_accounts_schema7_update BEFORE UPDATE ON astarter_accounts WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_accounts_schema7_delete BEFORE DELETE ON astarter_accounts WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_bindings_schema7_insert BEFORE INSERT ON astarter_bindings WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_bindings_schema7_update BEFORE UPDATE ON astarter_bindings WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_bindings_schema7_delete BEFORE DELETE ON astarter_bindings WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_limits_schema7_insert BEFORE INSERT ON astarter_limits WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_limits_schema7_update BEFORE UPDATE ON astarter_limits WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_limits_schema7_delete BEFORE DELETE ON astarter_limits WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_intents_schema7_insert BEFORE INSERT ON astarter_intents WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_intents_schema7_update BEFORE UPDATE ON astarter_intents WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_intents_schema7_delete BEFORE DELETE ON astarter_intents WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_orders_schema7_insert BEFORE INSERT ON astarter_orders WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_orders_schema7_update BEFORE UPDATE ON astarter_orders WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_orders_schema7_delete BEFORE DELETE ON astarter_orders WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_fills_schema7_insert BEFORE INSERT ON astarter_fills WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_fills_schema7_update BEFORE UPDATE ON astarter_fills WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_fills_schema7_delete BEFORE DELETE ON astarter_fills WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_settlements_schema7_insert BEFORE INSERT ON astarter_settlements WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_settlements_schema7_update BEFORE UPDATE ON astarter_settlements WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_settlements_schema7_delete BEFORE DELETE ON astarter_settlements WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_audit_schema7_insert BEFORE INSERT ON astarter_audit WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_audit_schema7_update BEFORE UPDATE ON astarter_audit WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_astarter_audit_schema7_delete BEFORE DELETE ON astarter_audit WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_strategy_scopes_schema7_insert BEFORE INSERT ON astarter_strategy_scopes WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_strategy_scopes_schema7_update BEFORE UPDATE ON astarter_strategy_scopes WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_strategy_scopes_schema7_delete BEFORE DELETE ON astarter_strategy_scopes WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_strategy_versions_schema7_insert BEFORE INSERT ON astarter_strategy_versions WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_strategy_versions_schema7_update BEFORE UPDATE ON astarter_strategy_versions WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_strategy_versions_schema7_delete BEFORE DELETE ON astarter_strategy_versions WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_plan_versions_schema7_insert BEFORE INSERT ON astarter_plan_versions WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_plan_versions_schema7_update BEFORE UPDATE ON astarter_plan_versions WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_plan_versions_schema7_delete BEFORE DELETE ON astarter_plan_versions WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_approval_references_schema7_insert BEFORE INSERT ON astarter_approval_references WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_approval_references_schema7_update BEFORE UPDATE ON astarter_approval_references WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_approval_references_schema7_delete BEFORE DELETE ON astarter_approval_references WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_episode_references_schema7_insert BEFORE INSERT ON astarter_episode_references WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_episode_references_schema7_update BEFORE UPDATE ON astarter_episode_references WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_episode_references_schema7_delete BEFORE DELETE ON astarter_episode_references WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_layer_references_schema7_insert BEFORE INSERT ON astarter_layer_references WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_layer_references_schema7_update BEFORE UPDATE ON astarter_layer_references WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_layer_references_schema7_delete BEFORE DELETE ON astarter_layer_references WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_recovery_checkpoints_schema7_insert BEFORE INSERT ON astarter_recovery_checkpoints WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_recovery_checkpoints_schema7_update BEFORE UPDATE ON astarter_recovery_checkpoints WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
CREATE TRIGGER trg_recovery_checkpoints_schema7_delete BEFORE DELETE ON astarter_recovery_checkpoints WHEN stark_control_writer_schema7() IS NOT 7 BEGIN SELECT RAISE(ABORT,'control writer schema mismatch'); END;
PRAGMA user_version = 7;
COMMIT;
