-- Dedicated PRIVATE v1; no PUBLIC/Q08 objects or live credentials are reused.
CREATE SCHEMA astarter_private;
REVOKE ALL ON SCHEMA astarter_private FROM PUBLIC;
CREATE DOMAIN astarter_private.identifier AS TEXT COLLATE "C"
 CHECK(VALUE ~ '^[A-Za-z0-9:_-]{1,128}$');
CREATE DOMAIN astarter_private.digest AS TEXT COLLATE "C" CHECK(VALUE ~ '^[0-9a-f]{64}$');
CREATE DOMAIN astarter_private.integer_amount AS NUMERIC
 CHECK(VALUE>=0 AND VALUE<=9007199254740991 AND VALUE=trunc(VALUE));
CREATE DOMAIN astarter_private.milliseconds AS NUMERIC
 CHECK(VALUE>=0 AND VALUE<=253402300799999 AND VALUE=trunc(VALUE));

CREATE TABLE astarter_private.metadata (
 singleton BOOLEAN PRIMARY KEY CHECK(singleton),
 contract TEXT NOT NULL CHECK(contract='ASTARTER_PRIVATE_RESEARCH_V1'),
 schema_version INTEGER NOT NULL CHECK(schema_version=1),
 resource_sha256 astarter_private.digest NOT NULL,
 profile TEXT NOT NULL CHECK(profile IN ('LOCAL_PG17','NEON_PG17_V1')),
 target_id astarter_private.identifier NOT NULL,
 database_name TEXT NOT NULL CHECK(database_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
 owner_role TEXT NOT NULL CHECK(owner_role ~ '^[a-z_][a-z0-9_]{0,62}$'),
 runtime_role TEXT NOT NULL CHECK(runtime_role ~ '^[a-z_][a-z0-9_]{0,62}$'),
 issuer_role TEXT NOT NULL CHECK(issuer_role ~ '^[a-z_][a-z0-9_]{0,62}$'),
 cost_role TEXT NOT NULL CHECK(cost_role ~ '^[a-z_][a-z0-9_]{0,62}$'),
 UNIQUE(target_id,database_name,runtime_role,profile),
 CHECK(owner_role<>runtime_role AND owner_role<>issuer_role AND owner_role<>cost_role
 AND runtime_role<>issuer_role AND runtime_role<>cost_role AND issuer_role<>cost_role)
);
CREATE TABLE astarter_private.leases (
 lease_id astarter_private.identifier PRIMARY KEY,
 target_id astarter_private.identifier NOT NULL,
 database_name TEXT NOT NULL,
 runtime_role TEXT NOT NULL,
 profile TEXT NOT NULL,
 audience TEXT NOT NULL CHECK(audience='astarter-research'),
 model TEXT NOT NULL CHECK(model='openai/gpt-4.1-mini'),
 budget_id astarter_private.identifier NOT NULL,
 created_at_ms astarter_private.milliseconds NOT NULL,
 expires_at_ms astarter_private.milliseconds NOT NULL CHECK(expires_at_ms>created_at_ms),
 UNIQUE(lease_id,budget_id),
 FOREIGN KEY(target_id,database_name,runtime_role,profile)
 REFERENCES astarter_private.metadata(target_id,database_name,runtime_role,profile)
);
CREATE TABLE astarter_private.challenges (
 challenge_hash astarter_private.digest PRIMARY KEY,
 nonce astarter_private.digest NOT NULL UNIQUE,
 origin TEXT NOT NULL CHECK(origin='https://astarter.imstark.site'),
 issued_at_ms astarter_private.milliseconds NOT NULL,
 expires_at_ms astarter_private.milliseconds NOT NULL CHECK(expires_at_ms=issued_at_ms+300000),
 address TEXT COLLATE "C" CHECK(address ~ '^0x[0-9A-Fa-f]{40}$'),
 chain_id astarter_private.integer_amount CHECK(chain_id=56),
 message TEXT CHECK(octet_length(message) BETWEEN 1 AND 4096),
 prepared_at_ms astarter_private.milliseconds,
 claim_digest astarter_private.digest UNIQUE,
 consumed_at_ms astarter_private.milliseconds,
 revoked_at_ms astarter_private.milliseconds CHECK(revoked_at_ms>=issued_at_ms),
 CHECK((address IS NULL AND chain_id IS NULL AND message IS NULL AND prepared_at_ms IS NULL)
 OR (address IS NOT NULL AND chain_id IS NOT NULL AND message IS NOT NULL
 AND prepared_at_ms IS NOT NULL AND prepared_at_ms>=issued_at_ms AND prepared_at_ms<expires_at_ms)),
 CHECK((claim_digest IS NULL AND consumed_at_ms IS NULL)
 OR (claim_digest IS NOT NULL AND consumed_at_ms IS NOT NULL AND prepared_at_ms IS NOT NULL
 AND consumed_at_ms>=prepared_at_ms AND consumed_at_ms<expires_at_ms)),
 UNIQUE(challenge_hash,claim_digest,address,chain_id)
);
CREATE TABLE astarter_private.sessions (
 token_digest astarter_private.digest PRIMARY KEY,
 challenge_hash astarter_private.digest NOT NULL UNIQUE,
 claim_digest astarter_private.digest NOT NULL UNIQUE,
 verified_address TEXT COLLATE "C" NOT NULL,
 chain_id astarter_private.integer_amount NOT NULL CHECK(chain_id=56),
 origin TEXT NOT NULL CHECK(origin='https://astarter.imstark.site'),
 subject_id astarter_private.identifier NOT NULL CHECK(subject_id='wallet:56:'||lower(verified_address)),
 tenant_id astarter_private.identifier NOT NULL CHECK(tenant_id=subject_id),
 audience TEXT NOT NULL CHECK(audience='astarter-research'),
 permissions TEXT[] NOT NULL CHECK(permissions=ARRAY['research:analyze']::TEXT[]),
 not_before_ms astarter_private.milliseconds NOT NULL,
 expires_at_ms astarter_private.milliseconds NOT NULL CHECK(expires_at_ms=not_before_ms+604800000),
 revoked_at_ms astarter_private.milliseconds CHECK(revoked_at_ms>=not_before_ms),
 FOREIGN KEY(challenge_hash,claim_digest,verified_address,chain_id)
 REFERENCES astarter_private.challenges(challenge_hash,claim_digest,address,chain_id),
 UNIQUE(token_digest,tenant_id,subject_id)
);
CREATE TABLE astarter_private.global_budget (
 month_start_ms astarter_private.milliseconds PRIMARY KEY,
 month_end_ms astarter_private.milliseconds NOT NULL,
 limit_microusd astarter_private.integer_amount NOT NULL CHECK(limit_microusd BETWEEN 1 AND 50000000),
 fixed_service_microusd astarter_private.integer_amount,
 held_microusd astarter_private.integer_amount NOT NULL DEFAULT 0,
 spent_microusd astarter_private.integer_amount NOT NULL DEFAULT 0,
 blocked BOOLEAN NOT NULL DEFAULT TRUE,
 CHECK(month_start_ms=extract(epoch FROM
 (date_trunc('month',to_timestamp(month_start_ms/1000) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))*1000),
 CHECK(month_end_ms=extract(epoch FROM
 ((date_trunc('month',to_timestamp(month_start_ms/1000) AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC'))*1000),
 CHECK(blocked OR (fixed_service_microusd IS NOT NULL
 AND fixed_service_microusd+held_microusd+spent_microusd<=limit_microusd))
);
CREATE TABLE astarter_private.policies (
 month_start_ms astarter_private.milliseconds NOT NULL REFERENCES astarter_private.global_budget,
 tenant_id astarter_private.identifier NOT NULL,
 policy_id astarter_private.identifier NOT NULL,
 model TEXT NOT NULL CHECK(model='openai/gpt-4.1-mini'),
 token_limit astarter_private.integer_amount NOT NULL CHECK(token_limit>=13056),
 request_limit astarter_private.integer_amount NOT NULL CHECK(request_limit>0),
 limit_microusd astarter_private.integer_amount NOT NULL CHECK(limit_microusd BETWEEN 1 AND 50000000),
 held_tokens astarter_private.integer_amount NOT NULL DEFAULT 0,
 spent_tokens astarter_private.integer_amount NOT NULL DEFAULT 0,
 request_count astarter_private.integer_amount NOT NULL DEFAULT 0,
 held_microusd astarter_private.integer_amount NOT NULL DEFAULT 0,
 spent_microusd astarter_private.integer_amount NOT NULL DEFAULT 0,
 blocked BOOLEAN NOT NULL DEFAULT TRUE,
 PRIMARY KEY(month_start_ms,tenant_id,policy_id),
 CHECK(blocked OR (held_tokens+spent_tokens<=token_limit AND request_count<=request_limit
 AND held_microusd+spent_microusd<=limit_microusd))
);
CREATE TABLE astarter_private.requests (
 tenant_id astarter_private.identifier NOT NULL,
 subject_id astarter_private.identifier NOT NULL,
 request_id TEXT COLLATE "C" NOT NULL CHECK(request_id ~ '^[A-Za-z0-9:_-]{8,96}$'),
 session_digest astarter_private.digest NOT NULL,
 lease_id astarter_private.identifier NOT NULL,
 month_start_ms astarter_private.milliseconds NOT NULL,
 policy_id astarter_private.identifier NOT NULL,
 fingerprint astarter_private.digest NOT NULL,
 claim_digest astarter_private.digest NOT NULL UNIQUE,
 reserved_tokens astarter_private.integer_amount NOT NULL CHECK(reserved_tokens=13056),
 reserved_microusd astarter_private.integer_amount NOT NULL CHECK(reserved_microusd=20890),
 settled_tokens astarter_private.integer_amount,
 settled_microusd astarter_private.integer_amount,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete','failed','unknown')),
 result JSONB CHECK(result IS NULL OR (jsonb_typeof(result)='object'
 AND result->>'model'='openai/gpt-4.1-mini' AND result->>'executionAuthority'='NONE') IS TRUE),
 error_code astarter_private.identifier,
 created_at_ms astarter_private.milliseconds NOT NULL,
 expires_at_ms astarter_private.milliseconds NOT NULL CHECK(expires_at_ms>created_at_ms),
 finished_at_ms astarter_private.milliseconds CHECK(finished_at_ms>=created_at_ms),
 PRIMARY KEY(tenant_id,subject_id,request_id),
 FOREIGN KEY(session_digest,tenant_id,subject_id)
 REFERENCES astarter_private.sessions(token_digest,tenant_id,subject_id),
 FOREIGN KEY(month_start_ms,tenant_id,policy_id)
 REFERENCES astarter_private.policies(month_start_ms,tenant_id,policy_id),
 FOREIGN KEY(lease_id,policy_id) REFERENCES astarter_private.leases(lease_id,budget_id),
 CHECK((state='pending' AND result IS NULL AND finished_at_ms IS NULL AND settled_tokens IS NULL)
 OR (state='complete' AND result IS NOT NULL AND finished_at_ms IS NOT NULL AND settled_tokens IS NOT NULL)
 OR (state IN ('failed','unknown') AND result IS NULL AND finished_at_ms IS NOT NULL))
);
CREATE TABLE astarter_private.cost_events (
 provider_receipt TEXT COLLATE "C" PRIMARY KEY CHECK(length(provider_receipt) BETWEEN 1 AND 256 AND provider_receipt ~ '^[A-Za-z0-9:._/-]+$'),
 tenant_id astarter_private.identifier NOT NULL,
 subject_id astarter_private.identifier NOT NULL,
 request_id TEXT COLLATE "C" NOT NULL,
 model TEXT NOT NULL CHECK(model='openai/gpt-4.1-mini'),
 amount_microusd astarter_private.integer_amount NOT NULL,
 actual_tokens astarter_private.integer_amount NOT NULL,
 recorded_at_ms astarter_private.milliseconds NOT NULL,
 UNIQUE(tenant_id,subject_id,request_id),
 FOREIGN KEY(tenant_id,subject_id,request_id)
 REFERENCES astarter_private.requests(tenant_id,subject_id,request_id)
);

-- Consumption happens before signature verification; only the trusted issuer may issue sessions.
CREATE FUNCTION astarter_private.identity_guard() RETURNS TRIGGER
 LANGUAGE plpgsql SET search_path=pg_catalog AS $guard$
DECLARE challenge astarter_private.challenges;
BEGIN
 IF TG_TABLE_NAME='challenges' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.address IS NOT NULL OR NEW.claim_digest IS NOT NULL OR NEW.revoked_at_ms IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE='PRIVATE_CHALLENGE_STATE'; END IF;
  ELSE
   IF (NEW.challenge_hash,NEW.nonce,NEW.origin,NEW.issued_at_ms,NEW.expires_at_ms)
      IS DISTINCT FROM (OLD.challenge_hash,OLD.nonce,OLD.origin,OLD.issued_at_ms,OLD.expires_at_ms)
   OR (OLD.address IS NOT NULL AND (NEW.address,NEW.chain_id,NEW.message,NEW.prepared_at_ms)
      IS DISTINCT FROM (OLD.address,OLD.chain_id,OLD.message,OLD.prepared_at_ms))
   OR (OLD.claim_digest IS NOT NULL AND (NEW.claim_digest,NEW.consumed_at_ms)
      IS DISTINCT FROM (OLD.claim_digest,OLD.consumed_at_ms))
   OR (OLD.revoked_at_ms IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION USING MESSAGE='PRIVATE_CHALLENGE_IMMUTABLE'; END IF;
  END IF;
 ELSE
  IF TG_OP='INSERT' THEN
   -- Serializes issue versus revoke; a consumed claim is not evidence of a valid signature.
   SELECT * INTO STRICT challenge FROM astarter_private.challenges
    WHERE challenge_hash=NEW.challenge_hash FOR UPDATE;
   IF challenge.consumed_at_ms IS NULL OR challenge.revoked_at_ms IS NOT NULL
   OR NEW.not_before_ms<challenge.consumed_at_ms OR NEW.not_before_ms>=challenge.expires_at_ms
   OR NEW.revoked_at_ms IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE='PRIVATE_SESSION_STATE'; END IF;
  ELSIF (OLD.revoked_at_ms IS NOT NULL AND NEW.revoked_at_ms IS DISTINCT FROM OLD.revoked_at_ms)
   OR NEW.revoked_at_ms IS NULL OR
   (to_jsonb(NEW)-'revoked_at_ms') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at_ms') THEN
   RAISE EXCEPTION USING MESSAGE='PRIVATE_SESSION_IMMUTABLE';
  END IF;
 END IF;
 RETURN NEW;
END $guard$;
CREATE TRIGGER challenge_identity BEFORE INSERT OR UPDATE ON astarter_private.challenges
 FOR EACH ROW EXECUTE FUNCTION astarter_private.identity_guard();
CREATE TRIGGER session_identity BEFORE INSERT OR UPDATE ON astarter_private.sessions
 FOR EACH ROW EXECUTE FUNCTION astarter_private.identity_guard();
CREATE FUNCTION astarter_private.revoke_challenge_sessions() RETURNS TRIGGER
 LANGUAGE plpgsql SET search_path=pg_catalog AS $revoke$
BEGIN
 IF NEW.revoked_at_ms IS NOT NULL AND OLD.revoked_at_ms IS NULL THEN
  UPDATE astarter_private.sessions SET revoked_at_ms=greatest(NEW.revoked_at_ms,not_before_ms)
   WHERE challenge_hash=NEW.challenge_hash AND revoked_at_ms IS NULL;
 END IF;
 RETURN NEW;
END $revoke$;
CREATE TRIGGER challenge_revoke AFTER UPDATE ON astarter_private.challenges
 FOR EACH ROW EXECUTE FUNCTION astarter_private.revoke_challenge_sessions();

CREATE FUNCTION astarter_private.policy_guard() RETURNS TRIGGER
 LANGUAGE plpgsql SET search_path=pg_catalog AS $policy$
BEGIN
 IF NEW.limit_microusd>(SELECT limit_microusd FROM astarter_private.global_budget
 WHERE month_start_ms=NEW.month_start_ms) THEN
 RAISE EXCEPTION USING MESSAGE='PRIVATE_POLICY_PARENT_LIMIT'; END IF;
 RETURN NEW;
END $policy$;
CREATE TRIGGER policy_parent BEFORE INSERT OR UPDATE ON astarter_private.policies
 FOR EACH ROW EXECUTE FUNCTION astarter_private.policy_guard();
CREATE FUNCTION astarter_private.request_guard() RETURNS TRIGGER
 LANGUAGE plpgsql SET search_path=pg_catalog AS $request$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'pending' OR NEW.settled_microusd IS NOT NULL THEN
   RAISE EXCEPTION USING MESSAGE='PRIVATE_INITIAL_REQUEST'; END IF;
 ELSE
  IF (to_jsonb(NEW)-'state'-'result'-'error_code'-'finished_at_ms'-'settled_tokens'-'settled_microusd')
   IS DISTINCT FROM (to_jsonb(OLD)-'state'-'result'-'error_code'-'finished_at_ms'-'settled_tokens'-'settled_microusd')
   OR (OLD.state<>'pending' AND (to_jsonb(NEW)-'settled_microusd') IS DISTINCT FROM
       (to_jsonb(OLD)-'settled_microusd'))
   OR (OLD.settled_microusd IS NOT NULL AND NEW.settled_microusd IS DISTINCT FROM OLD.settled_microusd) THEN
   RAISE EXCEPTION USING MESSAGE='PRIVATE_REQUEST_IMMUTABLE'; END IF;
 END IF;
 RETURN NEW;
END $request$;
CREATE TRIGGER request_identity BEFORE INSERT OR UPDATE ON astarter_private.requests
 FOR EACH ROW EXECUTE FUNCTION astarter_private.request_guard();
CREATE FUNCTION astarter_private.audit_guard() RETURNS TRIGGER
 LANGUAGE plpgsql SET search_path=pg_catalog AS $audit$
BEGIN RAISE EXCEPTION USING MESSAGE='PRIVATE_AUDIT_APPEND_ONLY'; END $audit$;
CREATE TRIGGER cost_append_only BEFORE UPDATE OR DELETE ON astarter_private.cost_events
 FOR EACH ROW EXECUTE FUNCTION astarter_private.audit_guard();

CREATE FUNCTION astarter_private.resolve_session(p_digest TEXT,p_audience TEXT)
 RETURNS TABLE(subject_id TEXT,tenant_id TEXT,scope_id TEXT,audience TEXT,
 not_before_ms NUMERIC,expires_at_ms NUMERIC,revoked_at_ms NUMERIC,permissions TEXT[])
 LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog AS $resolve$
 SELECT s.subject_id::TEXT,s.tenant_id::TEXT,s.tenant_id::TEXT,s.audience,
 s.not_before_ms::NUMERIC,s.expires_at_ms::NUMERIC,s.revoked_at_ms::NUMERIC,s.permissions
 FROM astarter_private.sessions s WHERE s.token_digest=p_digest AND s.audience=p_audience
 AND p_audience='astarter-research' AND s.revoked_at_ms IS NULL
 AND s.not_before_ms<=extract(epoch FROM statement_timestamp())*1000
 AND s.expires_at_ms>extract(epoch FROM statement_timestamp())*1000;
$resolve$;
ALTER TABLE astarter_private.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE astarter_private.policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY request_owner ON astarter_private.requests FOR SELECT TO astarter_private_runtime
 USING(EXISTS(SELECT 1 FROM astarter_private.resolve_session(
 current_setting('astarter_private.session_digest',TRUE),'astarter-research') s
 WHERE s.tenant_id=requests.tenant_id AND s.subject_id=requests.subject_id));
CREATE POLICY policy_tenant ON astarter_private.policies FOR SELECT TO astarter_private_runtime
 USING(EXISTS(SELECT 1 FROM astarter_private.resolve_session(
 current_setting('astarter_private.session_digest',TRUE),'astarter-research') s
 WHERE s.tenant_id=policies.tenant_id));

-- No claim function or runtime writes yet: the next DAL must admit under the parent lock.
CREATE FUNCTION astarter_private.settle_cost(p_receipt TEXT,p_tenant TEXT,p_subject TEXT,
 p_request TEXT,p_amount NUMERIC,p_tokens NUMERIC) RETURNS BOOLEAN
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $settle$
DECLARE r astarter_private.requests; g astarter_private.global_budget;
 p astarter_private.policies; event astarter_private.cost_events;
BEGIN
 IF p_amount IS NULL OR p_tokens IS NULL THEN RAISE EXCEPTION USING MESSAGE='PRIVATE_COST_INPUT'; END IF;
 PERFORM p_amount::astarter_private.integer_amount,p_tokens::astarter_private.integer_amount;
 SELECT * INTO STRICT r FROM astarter_private.requests
 WHERE tenant_id=p_tenant AND subject_id=p_subject AND request_id=p_request;
 -- Immutable request identity supplies the lock keys; all accounting locks follow the same order.
 SELECT * INTO STRICT g FROM astarter_private.global_budget WHERE month_start_ms=r.month_start_ms FOR UPDATE;
 SELECT * INTO STRICT p FROM astarter_private.policies WHERE month_start_ms=r.month_start_ms
 AND tenant_id=r.tenant_id AND policy_id=r.policy_id FOR UPDATE;
 SELECT * INTO STRICT r FROM astarter_private.requests
 WHERE tenant_id=p_tenant AND subject_id=p_subject AND request_id=p_request FOR UPDATE;
 SELECT * INTO event FROM astarter_private.cost_events WHERE provider_receipt=p_receipt;
 IF FOUND THEN
  IF (event.tenant_id,event.subject_id,event.request_id,event.amount_microusd,event.actual_tokens)
   IS DISTINCT FROM (p_tenant,p_subject,p_request,p_amount,p_tokens) THEN
   RAISE EXCEPTION USING MESSAGE='PRIVATE_RECEIPT_CONFLICT'; END IF;
  RETURN FALSE;
 END IF;
 IF r.settled_microusd IS NOT NULL OR g.held_microusd<r.reserved_microusd
 OR p.held_microusd<r.reserved_microusd OR p.held_tokens<r.reserved_tokens THEN
  RAISE EXCEPTION USING MESSAGE='PRIVATE_COST_STATE'; END IF;
 INSERT INTO astarter_private.cost_events VALUES(p_receipt,p_tenant,p_subject,p_request,
 'openai/gpt-4.1-mini',p_amount,p_tokens,floor(extract(epoch FROM clock_timestamp())*1000));
 UPDATE astarter_private.global_budget SET held_microusd=held_microusd-r.reserved_microusd,
 spent_microusd=spent_microusd+p_amount,blocked=blocked OR p_amount>r.reserved_microusd
 OR fixed_service_microusd IS NULL
 OR fixed_service_microusd+held_microusd-r.reserved_microusd+spent_microusd+p_amount>limit_microusd
 WHERE month_start_ms=r.month_start_ms;
 UPDATE astarter_private.policies SET held_microusd=held_microusd-r.reserved_microusd,
 spent_microusd=spent_microusd+p_amount,held_tokens=held_tokens-r.reserved_tokens,
 spent_tokens=spent_tokens+p_tokens,blocked=blocked OR p_amount>r.reserved_microusd
 OR held_microusd-r.reserved_microusd+spent_microusd+p_amount>limit_microusd
 OR held_tokens-r.reserved_tokens+spent_tokens+p_tokens>token_limit
 WHERE month_start_ms=r.month_start_ms AND tenant_id=r.tenant_id AND policy_id=r.policy_id;
 UPDATE astarter_private.requests SET settled_microusd=p_amount
 WHERE tenant_id=p_tenant AND subject_id=p_subject AND request_id=p_request;
 RETURN TRUE;
END $settle$;
