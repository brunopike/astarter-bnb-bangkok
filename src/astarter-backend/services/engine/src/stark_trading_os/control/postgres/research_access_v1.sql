-- New capabilities only. Old pg2 roles and access_v1.sql remain unchanged.
-- Only the new Q08 target loses inherited temporary DDL; no existing target is modified.
DO $q08_access$ BEGIN
 EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',current_database());
END $q08_access$;
GRANT USAGE ON SCHEMA pg1_control,q08_research TO q08_research_read,q08_research_write;
REVOKE ALL ON DOMAIN q08_research.identifier,q08_research.digest,q08_research.atoms,
 q08_research.milliseconds FROM PUBLIC;
GRANT USAGE ON DOMAIN q08_research.identifier,q08_research.digest,q08_research.atoms,
 q08_research.milliseconds TO q08_research_read,q08_research_write;
GRANT SELECT ON pg1_control.pg1_metadata,pg1_control.astarter_strategy_scopes,
 pg1_control.astarter_strategy_versions,pg1_control.astarter_plan_versions,
 pg1_control.astarter_approval_references,pg1_control.astarter_episode_references,
 pg1_control.astarter_layer_references,pg1_control.astarter_recovery_checkpoints
 TO q08_research_read,q08_research_write;
GRANT SELECT(account_id,venue_session) ON pg1_control.astarter_accounts
 TO q08_research_read,q08_research_write;
GRANT INSERT ON pg1_control.astarter_strategy_versions,pg1_control.astarter_plan_versions,
 pg1_control.astarter_approval_references,pg1_control.astarter_episode_references,
 pg1_control.astarter_layer_references,pg1_control.astarter_recovery_checkpoints
 TO q08_research_write;
GRANT UPDATE(singleton) ON pg1_control.pg1_metadata TO q08_research_write;
GRANT SELECT ON ALL TABLES IN SCHEMA q08_research TO q08_research_read,q08_research_write;
GRANT INSERT ON q08_research.research_jobs,q08_research.research_role_attempts,
 q08_research.research_artifacts,q08_research.research_consumers,
 q08_research.research_budget_scopes,q08_research.research_reservations,
 q08_research.research_events_outbox TO q08_research_write;
GRANT UPDATE(singleton) ON q08_research.research_metadata TO q08_research_write;
GRANT UPDATE(state,version,updated_at_ms,resume_kind,resume_event_id,not_before_ms)
 ON q08_research.research_jobs TO q08_research_write;
GRANT UPDATE(state,worker_id,claim_id,owner_epoch,lease_until_ms,permit_id,response_id,
 response_sha256,version,updated_at_ms) ON q08_research.research_role_attempts TO q08_research_write;
GRANT UPDATE(reserved_atoms,spent_atoms,unknown_atoms,version,updated_at_ms)
 ON q08_research.research_budget_scopes TO q08_research_write;
GRANT UPDATE(state,version,updated_at_ms)
 ON q08_research.research_reservations TO q08_research_write;
GRANT UPDATE(delivery_state,delivery_owner,delivery_epoch,delivery_attempts,delivery_lease_until_ms,
 delivery_ack_sha256,version,updated_at_ms) ON q08_research.research_events_outbox TO q08_research_write;
