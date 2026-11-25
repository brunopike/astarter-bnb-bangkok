-- PG2 access protocol v1. Owner-only, atomic; no business predicate changes.
-- Capability roles must be provisioned as plain NOLOGIN by trusted bootstrap.
GRANT USAGE ON SCHEMA pg1_control TO pg2_reference_read, pg2_reference_write;
GRANT SELECT ON pg1_control.pg1_metadata,
 pg1_control.astarter_strategy_scopes,
 pg1_control.astarter_strategy_versions,
 pg1_control.astarter_plan_versions,
 pg1_control.astarter_approval_references,
 pg1_control.astarter_episode_references,
 pg1_control.astarter_layer_references,
 pg1_control.astarter_recovery_checkpoints
 TO pg2_reference_read, pg2_reference_write;
GRANT SELECT(account_id,venue_session) ON pg1_control.astarter_accounts
 TO pg2_reference_read, pg2_reference_write;
-- Invoker pg1_require_writer locks the immutable singleton FOR SHARE.
GRANT UPDATE(singleton) ON pg1_control.pg1_metadata TO pg2_reference_write;
GRANT INSERT ON pg1_control.astarter_strategy_versions,
 pg1_control.astarter_plan_versions,
 pg1_control.astarter_approval_references,
 pg1_control.astarter_episode_references,
 pg1_control.astarter_layer_references,
 pg1_control.astarter_recovery_checkpoints TO pg2_reference_write;
