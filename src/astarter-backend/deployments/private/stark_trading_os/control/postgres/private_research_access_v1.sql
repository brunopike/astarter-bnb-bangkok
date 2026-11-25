DO $database_acl$ BEGIN
 EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC',current_database());
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO astarter_private_runtime,astarter_private_issuer,astarter_private_cost',current_database());
END $database_acl$;
GRANT USAGE ON SCHEMA astarter_private TO astarter_private_runtime,astarter_private_issuer,astarter_private_cost;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA astarter_private FROM PUBLIC;
REVOKE ALL ON DOMAIN astarter_private.identifier,astarter_private.digest,
 astarter_private.integer_amount,astarter_private.milliseconds FROM PUBLIC;
GRANT USAGE ON DOMAIN astarter_private.identifier,astarter_private.digest,
 astarter_private.integer_amount,astarter_private.milliseconds
 TO astarter_private_runtime,astarter_private_issuer,astarter_private_cost;
GRANT SELECT ON astarter_private.metadata TO astarter_private_runtime,astarter_private_issuer,astarter_private_cost;
GRANT SELECT ON astarter_private.leases,astarter_private.global_budget,
 astarter_private.policies,astarter_private.requests TO astarter_private_runtime;
GRANT EXECUTE ON FUNCTION astarter_private.resolve_session(TEXT,TEXT) TO astarter_private_runtime;
GRANT SELECT,INSERT ON astarter_private.challenges,astarter_private.sessions TO astarter_private_issuer;
GRANT UPDATE(address,chain_id,message,prepared_at_ms,claim_digest,consumed_at_ms,revoked_at_ms) ON astarter_private.challenges TO astarter_private_issuer;
GRANT UPDATE(revoked_at_ms) ON astarter_private.sessions TO astarter_private_issuer;
GRANT SELECT ON astarter_private.cost_events TO astarter_private_cost;
GRANT EXECUTE ON FUNCTION astarter_private.settle_cost(TEXT,TEXT,TEXT,TEXT,NUMERIC,NUMERIC) TO astarter_private_cost;
