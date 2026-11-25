BEGIN IMMEDIATE;

-- D2 reuses D1 identities; no account is adopted, no economic row is rewritten.
CREATE UNIQUE INDEX idx_d2_episode_identity ON astarter_episode_references(scope_id,episode_id,account_id,binding_id,plan_id,revision);
CREATE UNIQUE INDEX idx_d2_approval_identity ON astarter_approval_references(scope_id,reference_id,plan_id,revision);
CREATE UNIQUE INDEX idx_d2_intent_identity ON astarter_intents(intent_id,account_id,binding_id);

CREATE TABLE astarter_admission_heads (
 account_id TEXT PRIMARY KEY,
 scope_id TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('LEGACY_FINITE','PLAN_FINITE_ATOMICITY')),
 authority_id TEXT NOT NULL CHECK(length(authority_id) BETWEEN 1 AND 128),
 generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
 admission_id TEXT,
 FOREIGN KEY(scope_id,account_id) REFERENCES astarter_strategy_scopes(scope_id,account_id),
 FOREIGN KEY(admission_id,account_id,generation) REFERENCES astarter_admissions(admission_id,account_id,generation),
 CHECK((generation=0 AND admission_id IS NULL) OR (generation>0 AND admission_id IS NOT NULL)),
 CHECK(purpose!='LEGACY_FINITE' OR generation=0)
) STRICT, WITHOUT ROWID;

CREATE TABLE astarter_admissions (
 admission_id TEXT PRIMARY KEY CHECK(length(admission_id) BETWEEN 1 AND 128),
 account_id TEXT NOT NULL REFERENCES astarter_admission_heads(account_id),
 scope_id TEXT NOT NULL,
 binding_id TEXT NOT NULL,
 episode_id TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 revision TEXT NOT NULL,
 approval_id TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0),
 dependency_sha256 TEXT NOT NULL CHECK(length(dependency_sha256)=64),
 policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256)=64),
 starts_at_ms INTEGER NOT NULL CHECK(starts_at_ms>=0),
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>starts_at_ms),
 state TEXT NOT NULL CHECK(state IN ('READY','REVOKED','DEPENDENCY_CHANGED')),
 update_sha256 TEXT NOT NULL CHECK(length(update_sha256)=64),
 UNIQUE(account_id,generation),
 UNIQUE(admission_id,account_id,generation),
 UNIQUE(admission_id,account_id,binding_id),
 FOREIGN KEY(scope_id,account_id) REFERENCES astarter_strategy_scopes(scope_id,account_id),
 FOREIGN KEY(binding_id,account_id) REFERENCES astarter_bindings(binding_id,account_id),
 FOREIGN KEY(scope_id,episode_id,account_id,binding_id,plan_id,revision) REFERENCES astarter_episode_references(scope_id,episode_id,account_id,binding_id,plan_id,revision),
 FOREIGN KEY(scope_id,approval_id,plan_id,revision) REFERENCES astarter_approval_references(scope_id,reference_id,plan_id,revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE astarter_intent_admissions (
 intent_id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL,
 binding_id TEXT NOT NULL,
 admission_id TEXT NOT NULL,
 FOREIGN KEY(intent_id,account_id,binding_id) REFERENCES astarter_intents(intent_id,account_id,binding_id),
 FOREIGN KEY(admission_id,account_id,binding_id) REFERENCES astarter_admissions(admission_id,account_id,binding_id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER trg_d2_heads_replace BEFORE INSERT ON astarter_admission_heads
WHEN EXISTS(SELECT 1 FROM astarter_admission_heads WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'D2 purpose immutable'); END;
CREATE TRIGGER trg_d2_heads_update BEFORE UPDATE ON astarter_admission_heads
WHEN NEW.account_id!=OLD.account_id OR NEW.scope_id!=OLD.scope_id OR NEW.purpose!=OLD.purpose OR NEW.authority_id!=OLD.authority_id OR NEW.generation!=OLD.generation+1
BEGIN SELECT RAISE(ABORT,'D2 purpose or generation immutable'); END;
CREATE TRIGGER trg_d2_heads_delete BEFORE DELETE ON astarter_admission_heads BEGIN SELECT RAISE(ABORT,'D2 purpose immutable'); END;
CREATE TRIGGER trg_d2_admissions_replace BEFORE INSERT ON astarter_admissions
WHEN EXISTS(SELECT 1 FROM astarter_admissions WHERE admission_id=NEW.admission_id OR (account_id=NEW.account_id AND generation=NEW.generation))
BEGIN SELECT RAISE(ABORT,'D2 admission immutable'); END;
CREATE TRIGGER trg_d2_admissions_update BEFORE UPDATE ON astarter_admissions BEGIN SELECT RAISE(ABORT,'D2 admission immutable'); END;
CREATE TRIGGER trg_d2_admissions_delete BEFORE DELETE ON astarter_admissions BEGIN SELECT RAISE(ABORT,'D2 admission immutable'); END;
CREATE TRIGGER trg_d2_links_replace BEFORE INSERT ON astarter_intent_admissions
WHEN EXISTS(SELECT 1 FROM astarter_intent_admissions WHERE intent_id=NEW.intent_id)
BEGIN SELECT RAISE(ABORT,'D2 intent admission immutable'); END;
CREATE TRIGGER trg_d2_links_update BEFORE UPDATE ON astarter_intent_admissions BEGIN SELECT RAISE(ABORT,'D2 intent admission immutable'); END;
CREATE TRIGGER trg_d2_links_delete BEFORE DELETE ON astarter_intent_admissions BEGIN SELECT RAISE(ABORT,'D2 intent admission immutable'); END;

-- Separate capability name rejects already-open v7 writers at statement prepare,
-- including zero-row/cached statements. Existing schema7 guards remain intact.
CREATE TRIGGER d2_audit_intents_i BEFORE INSERT ON audit_intents BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_audit_intents_u BEFORE UPDATE ON audit_intents BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_audit_intents_d BEFORE DELETE ON audit_intents BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_catalog_audit_intents_i BEFORE INSERT ON catalog_audit_intents BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_catalog_audit_intents_u BEFORE UPDATE ON catalog_audit_intents BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_catalog_audit_intents_d BEFORE DELETE ON catalog_audit_intents BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_catalog_publications_i BEFORE INSERT ON catalog_publications BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_catalog_publications_u BEFORE UPDATE ON catalog_publications BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_catalog_publications_d BEFORE DELETE ON catalog_publications BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_events_i BEFORE INSERT ON events BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_events_u BEFORE UPDATE ON events BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_events_d BEFORE DELETE ON events BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_finalization_faults_i BEFORE INSERT ON finalization_faults BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_finalization_faults_u BEFORE UPDATE ON finalization_faults BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_finalization_faults_d BEFORE DELETE ON finalization_faults BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_historical_preflights_i BEFORE INSERT ON historical_preflights BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_historical_preflights_u BEFORE UPDATE ON historical_preflights BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_historical_preflights_d BEFORE DELETE ON historical_preflights BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_historical_terminal_anchors_i BEFORE INSERT ON historical_terminal_anchors BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_historical_terminal_anchors_u BEFORE UPDATE ON historical_terminal_anchors BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_historical_terminal_anchors_d BEFORE DELETE ON historical_terminal_anchors BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_idempotency_records_i BEFORE INSERT ON idempotency_records BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_idempotency_records_u BEFORE UPDATE ON idempotency_records BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_idempotency_records_d BEFORE DELETE ON idempotency_records BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_outbox_i BEFORE INSERT ON outbox BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_outbox_u BEFORE UPDATE ON outbox BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_outbox_d BEFORE DELETE ON outbox BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_preflight_configuration_bindings_i BEFORE INSERT ON preflight_configuration_bindings BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_preflight_configuration_bindings_u BEFORE UPDATE ON preflight_configuration_bindings BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_preflight_configuration_bindings_d BEFORE DELETE ON preflight_configuration_bindings BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_preflights_i BEFORE INSERT ON preflights BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_preflights_u BEFORE UPDATE ON preflights BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_preflights_d BEFORE DELETE ON preflights BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_runner_outcomes_i BEFORE INSERT ON runner_outcomes BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_runner_outcomes_u BEFORE UPDATE ON runner_outcomes BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_runner_outcomes_d BEFORE DELETE ON runner_outcomes BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_runner_processes_i BEFORE INSERT ON runner_processes BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_runner_processes_u BEFORE UPDATE ON runner_processes BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_runner_processes_d BEFORE DELETE ON runner_processes BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_runs_i BEFORE INSERT ON runs BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_runs_u BEFORE UPDATE ON runs BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_runs_d BEFORE DELETE ON runs BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_seals_i BEFORE INSERT ON seals BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_seals_u BEFORE UPDATE ON seals BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_seals_d BEFORE DELETE ON seals BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_strategy_configuration_audit_entries_i BEFORE INSERT ON strategy_configuration_audit_entries BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_strategy_configuration_audit_entries_u BEFORE UPDATE ON strategy_configuration_audit_entries BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_strategy_configuration_audit_entries_d BEFORE DELETE ON strategy_configuration_audit_entries BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_strategy_configuration_versions_i BEFORE INSERT ON strategy_configuration_versions BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_strategy_configuration_versions_u BEFORE UPDATE ON strategy_configuration_versions BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_strategy_configuration_versions_d BEFORE DELETE ON strategy_configuration_versions BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_strategy_drafts_i BEFORE INSERT ON strategy_drafts BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_strategy_drafts_u BEFORE UPDATE ON strategy_drafts BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_strategy_drafts_d BEFORE DELETE ON strategy_drafts BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_terminal_preparations_i BEFORE INSERT ON terminal_preparations BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_terminal_preparations_u BEFORE UPDATE ON terminal_preparations BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_terminal_preparations_d BEFORE DELETE ON terminal_preparations BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_accounts_i BEFORE INSERT ON astarter_accounts BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_accounts_u BEFORE UPDATE ON astarter_accounts BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_accounts_d BEFORE DELETE ON astarter_accounts BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_bindings_i BEFORE INSERT ON astarter_bindings BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_bindings_u BEFORE UPDATE ON astarter_bindings BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_bindings_d BEFORE DELETE ON astarter_bindings BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_limits_i BEFORE INSERT ON astarter_limits BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_limits_u BEFORE UPDATE ON astarter_limits BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_limits_d BEFORE DELETE ON astarter_limits BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_intents_i BEFORE INSERT ON astarter_intents BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_intents_u BEFORE UPDATE ON astarter_intents BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_intents_d BEFORE DELETE ON astarter_intents BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_orders_i BEFORE INSERT ON astarter_orders BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_orders_u BEFORE UPDATE ON astarter_orders BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_orders_d BEFORE DELETE ON astarter_orders BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_fills_i BEFORE INSERT ON astarter_fills BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_fills_u BEFORE UPDATE ON astarter_fills BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_fills_d BEFORE DELETE ON astarter_fills BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_settlements_i BEFORE INSERT ON astarter_settlements BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_settlements_u BEFORE UPDATE ON astarter_settlements BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_settlements_d BEFORE DELETE ON astarter_settlements BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_audit_i BEFORE INSERT ON astarter_audit BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_audit_u BEFORE UPDATE ON astarter_audit BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_audit_d BEFORE DELETE ON astarter_audit BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_strategy_scopes_i BEFORE INSERT ON astarter_strategy_scopes BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_strategy_scopes_u BEFORE UPDATE ON astarter_strategy_scopes BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_strategy_scopes_d BEFORE DELETE ON astarter_strategy_scopes BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_strategy_versions_i BEFORE INSERT ON astarter_strategy_versions BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_strategy_versions_u BEFORE UPDATE ON astarter_strategy_versions BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_strategy_versions_d BEFORE DELETE ON astarter_strategy_versions BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_plan_versions_i BEFORE INSERT ON astarter_plan_versions BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_plan_versions_u BEFORE UPDATE ON astarter_plan_versions BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_plan_versions_d BEFORE DELETE ON astarter_plan_versions BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_approval_references_i BEFORE INSERT ON astarter_approval_references BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_approval_references_u BEFORE UPDATE ON astarter_approval_references BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_approval_references_d BEFORE DELETE ON astarter_approval_references BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_episode_references_i BEFORE INSERT ON astarter_episode_references BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_episode_references_u BEFORE UPDATE ON astarter_episode_references BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_episode_references_d BEFORE DELETE ON astarter_episode_references BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_layer_references_i BEFORE INSERT ON astarter_layer_references BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_layer_references_u BEFORE UPDATE ON astarter_layer_references BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_layer_references_d BEFORE DELETE ON astarter_layer_references BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_recovery_checkpoints_i BEFORE INSERT ON astarter_recovery_checkpoints BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_recovery_checkpoints_u BEFORE UPDATE ON astarter_recovery_checkpoints BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_recovery_checkpoints_d BEFORE DELETE ON astarter_recovery_checkpoints BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_admission_heads_i BEFORE INSERT ON astarter_admission_heads BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_admission_heads_u BEFORE UPDATE ON astarter_admission_heads BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_admission_heads_d BEFORE DELETE ON astarter_admission_heads BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_admissions_i BEFORE INSERT ON astarter_admissions BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_admissions_u BEFORE UPDATE ON astarter_admissions BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_admissions_d BEFORE DELETE ON astarter_admissions BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_intent_admissions_i BEFORE INSERT ON astarter_intent_admissions BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_intent_admissions_u BEFORE UPDATE ON astarter_intent_admissions BEGIN SELECT stark_control_writer_schema8(); END;
CREATE TRIGGER d2_astarter_intent_admissions_d BEFORE DELETE ON astarter_intent_admissions BEGIN SELECT stark_control_writer_schema8(); END;
PRAGMA user_version = 8;
COMMIT;
