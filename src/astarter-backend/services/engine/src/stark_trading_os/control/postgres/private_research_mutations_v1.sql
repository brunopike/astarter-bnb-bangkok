-- P2 component. Integrator must seal this together with P1 and capture a new catalog pin.
-- No price/cap/tenant/subject input; no connections, role creation or direct runtime writes.
CREATE FUNCTION astarter_private.claim_research(
 p_session TEXT,p_lease TEXT,p_target TEXT,p_request TEXT,p_fingerprint TEXT,p_claim TEXT,
 p_created NUMERIC,p_expires NUMERIC) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $claim$
DECLARE s astarter_private.sessions; l astarter_private.leases;
 g astarter_private.global_budget; p astarter_private.policies; r astarter_private.requests;
 t NUMERIC; month_start NUMERIC; existing BOOLEAN;
BEGIN
 IF p_session IS NULL OR p_lease IS NULL OR p_target IS NULL OR p_request IS NULL
 OR p_fingerprint IS NULL OR p_claim IS NULL OR p_created IS NULL OR p_expires IS NULL
 OR p_request !~ '^[A-Za-z0-9:_-]{8,96}$' THEN
  RAISE EXCEPTION USING MESSAGE='REQUEST_INVALID'; END IF;
 PERFORM p_session::astarter_private.digest,p_fingerprint::astarter_private.digest,
 p_claim::astarter_private.digest,p_lease::astarter_private.identifier,
 p_target::astarter_private.identifier,p_created::astarter_private.milliseconds,
 p_expires::astarter_private.milliseconds;
 -- Lock the authoritative identity first. Revoke takes this same row lock.
 SELECT * INTO s FROM astarter_private.sessions WHERE token_digest=p_session FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='AUTH_REQUIRED'; END IF;
 PERFORM 1 FROM astarter_private.resolve_session(p_session,'astarter-research');
 IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='AUTH_REQUIRED'; END IF;
 SELECT * INTO l FROM astarter_private.leases WHERE lease_id=p_lease FOR SHARE;
 IF NOT FOUND OR l.target_id<>p_target OR l.database_name<>current_database()
 OR l.runtime_role<>session_user OR l.audience<>'astarter-research'
 OR l.model<>'openai/gpt-4.1-mini' THEN
  RAISE EXCEPTION USING MESSAGE='PRIVATE_TARGET_MISMATCH'; END IF;
 t=floor(extract(epoch FROM clock_timestamp())*1000);
 IF s.revoked_at_ms IS NOT NULL OR s.not_before_ms>t OR s.expires_at_ms<=t THEN
  RAISE EXCEPTION USING MESSAGE='AUTH_REQUIRED'; END IF;
 IF l.created_at_ms>t OR l.expires_at_ms<=t THEN
  RAISE EXCEPTION USING MESSAGE='SCOPE_EXPIRED'; END IF;
 -- Immutable identity supplies an existing request's accounting month; no row lock out of order.
 SELECT * INTO r FROM astarter_private.requests
 WHERE tenant_id=s.tenant_id AND subject_id=s.subject_id AND request_id=p_request;
 existing=FOUND;
 month_start=CASE WHEN existing THEN r.month_start_ms ELSE
 extract(epoch FROM (date_trunc('month',to_timestamp(t/1000) AT TIME ZONE 'UTC')
 AT TIME ZONE 'UTC'))*1000 END;
 SELECT * INTO g FROM astarter_private.global_budget WHERE month_start_ms=month_start FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='BUDGET_UNAVAILABLE'; END IF;
 SELECT * INTO p FROM astarter_private.policies WHERE month_start_ms=month_start
 AND tenant_id=s.tenant_id AND policy_id=l.budget_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='BUDGET_UNAVAILABLE'; END IF;
 SELECT * INTO r FROM astarter_private.requests
 WHERE tenant_id=s.tenant_id AND subject_id=s.subject_id AND request_id=p_request FOR UPDATE;
 t=floor(extract(epoch FROM clock_timestamp())*1000);
 IF s.expires_at_ms<=t THEN RAISE EXCEPTION USING MESSAGE='AUTH_REQUIRED'; END IF;
 IF l.expires_at_ms<=t THEN RAISE EXCEPTION USING MESSAGE='SCOPE_EXPIRED'; END IF;
 IF FOUND THEN
  IF r.fingerprint<>p_fingerprint OR r.lease_id<>p_lease OR r.policy_id<>l.budget_id THEN
   RAISE EXCEPTION USING MESSAGE='PRIVATE_CONFLICT'; END IF;
  RETURN jsonb_build_object('acquired',FALSE,'record',jsonb_build_object(
   'tenantId',r.tenant_id,'subjectId',r.subject_id,'scopeId',r.tenant_id,
   'requestId',r.request_id,'fingerprint',r.fingerprint,'state',r.state,
   'createdAt',r.created_at_ms,'expiresAt',r.expires_at_ms,'result',r.result,
   'error',r.error_code,'settledTokens',r.settled_tokens,
   'queryOriginalRequest',r.state='unknown' OR (r.state='pending' AND r.expires_at_ms<=t)));
 END IF;
 IF abs(p_created-t)>5000 OR p_expires<=t OR p_expires<=p_created
 OR p_expires>least(l.expires_at_ms,s.expires_at_ms,g.month_end_ms)
 OR t<g.month_start_ms OR t>=g.month_end_ms THEN
  RAISE EXCEPTION USING MESSAGE='SCOPE_EXPIRED'; END IF;
 IF p.model<>l.model OR p.limit_microusd>g.limit_microusd THEN
  RAISE EXCEPTION USING MESSAGE='BUDGET_UNAVAILABLE'; END IF;
 IF g.blocked OR p.blocked OR g.fixed_service_microusd IS NULL
 OR g.fixed_service_microusd+g.held_microusd+g.spent_microusd+20890>g.limit_microusd
 OR p.held_microusd+p.spent_microusd+20890>p.limit_microusd
 OR p.held_tokens+p.spent_tokens+13056>p.token_limit OR p.request_count+1>p.request_limit THEN
  RETURN jsonb_build_object('acquired',FALSE,'code','BUDGET_EXCEEDED'); END IF;
 INSERT INTO astarter_private.requests(tenant_id,subject_id,request_id,session_digest,
 lease_id,month_start_ms,policy_id,fingerprint,claim_digest,reserved_tokens,reserved_microusd,
 created_at_ms,expires_at_ms) VALUES(s.tenant_id,s.subject_id,p_request,p_session,
 p_lease,month_start,l.budget_id,p_fingerprint,p_claim,13056,20890,t,p_expires);
 UPDATE astarter_private.global_budget SET held_microusd=held_microusd+20890
 WHERE month_start_ms=month_start;
 UPDATE astarter_private.policies SET held_microusd=held_microusd+20890,
 held_tokens=held_tokens+13056,request_count=request_count+1
 WHERE month_start_ms=month_start AND tenant_id=s.tenant_id AND policy_id=l.budget_id;
 RETURN jsonb_build_object('acquired',TRUE);
END $claim$;
REVOKE ALL ON FUNCTION astarter_private.claim_research(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,NUMERIC)
 FROM PUBLIC;
GRANT EXECUTE ON FUNCTION astarter_private.claim_research(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,NUMERIC)
 TO astarter_private_runtime;

CREATE FUNCTION astarter_private.finish_research(
 p_session TEXT,p_lease TEXT,p_target TEXT,p_request TEXT,p_claim TEXT,p_state TEXT,
 p_tokens NUMERIC,p_result JSONB,p_error TEXT) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $finish$
DECLARE s astarter_private.sessions; l astarter_private.leases; r astarter_private.requests;
 t NUMERIC; input_tokens NUMERIC; output_tokens NUMERIC; total_tokens NUMERIC;
BEGIN
 IF p_session IS NULL OR p_lease IS NULL OR p_target IS NULL OR p_request IS NULL
 OR p_claim IS NULL OR p_state IS NULL OR p_state NOT IN ('complete','failed','unknown')
 OR p_request !~ '^[A-Za-z0-9:_-]{8,96}$' THEN
  RAISE EXCEPTION USING MESSAGE='REQUEST_INVALID'; END IF;
 PERFORM p_session::astarter_private.digest,p_claim::astarter_private.digest,
 p_lease::astarter_private.identifier,p_target::astarter_private.identifier;
 IF p_error IS NOT NULL AND p_error NOT IN ('UNCONFIGURED','AUTH_REQUIRED','SCOPE_EXPIRED',
 'REQUEST_INVALID','REQUEST_CONFLICT','REQUEST_NOT_FOUND','BUDGET_EXCEEDED','BUDGET_UNAVAILABLE',
 'EVIDENCE_UNAVAILABLE','EVIDENCE_INVALID','EVIDENCE_EXPIRED','MODEL_UNAVAILABLE',
 'MODEL_INVALID_RESPONSE','MODEL_TIMEOUT','REQUEST_PENDING','OUTCOME_UNKNOWN','BODY_TOO_LARGE',
 'JSON_REQUIRED','ORIGIN_DENIED','METHOD_NOT_ALLOWED','SERVICE_UNAVAILABLE') THEN
  RAISE EXCEPTION USING MESSAGE='REQUEST_INVALID'; END IF;
 IF p_state='complete' THEN
  IF p_tokens IS NULL OR p_error IS NOT NULL OR p_result IS NULL
  OR jsonb_typeof(p_result)<>'object' OR octet_length(p_result::TEXT)>65536 THEN
   RAISE EXCEPTION USING MESSAGE='REQUEST_INVALID'; END IF;
  IF NOT (p_result ?& ARRAY['method','model','responseId','usage','billing','output','sources',
    'missingDimensions','createdAt','validUntil','executionAuthority','methodVersion'])
  OR (p_result-ARRAY['method','model','responseId','usage','billing','output','sources',
    'missingDimensions','createdAt','validUntil','executionAuthority','methodVersion'])<>'{}'::JSONB
  OR p_result->>'model' IS DISTINCT FROM 'openai/gpt-4.1-mini' OR p_result->>'executionAuthority' IS DISTINCT FROM 'NONE'
  OR p_result->>'method' IS DISTINCT FROM 'ai' OR p_result->>'methodVersion' IS DISTINCT FROM 'closed-market-research-v1'
  OR jsonb_typeof(p_result->'responseId')<>'string'
  OR length(p_result->>'responseId') NOT BETWEEN 1 AND 160
  OR jsonb_typeof(p_result->'output')<>'object'
  OR jsonb_typeof(p_result->'sources')<>'array'
  OR p_result->'missingDimensions'<>'["depth","macro","social","chain","risk"]'::JSONB
  OR jsonb_typeof(p_result->'usage')<>'object'
  OR jsonb_typeof(p_result->'usage'->'inputTokens') IS DISTINCT FROM 'number'
  OR jsonb_typeof(p_result->'usage'->'outputTokens') IS DISTINCT FROM 'number'
  OR jsonb_typeof(p_result->'usage'->'totalTokens') IS DISTINCT FROM 'number'
  OR ((p_result->'usage')-ARRAY['inputTokens','outputTokens','totalTokens'])<>'{}'::JSONB
  OR jsonb_typeof(p_result->'createdAt') IS DISTINCT FROM 'number'
  OR jsonb_typeof(p_result->'validUntil') IS DISTINCT FROM 'number' THEN
   RAISE EXCEPTION USING MESSAGE='REQUEST_INVALID'; END IF;
  IF NOT (p_result->'output' ?& ARRAY['outcome','headline','summary','claims'])
  OR ((p_result->'output')-ARRAY['outcome','headline','summary','claims'])<>'{}'::JSONB
  OR (p_result->'output'->>'outcome') IS NULL
  OR p_result->'output'->>'outcome' NOT IN ('watch','conflict','insufficient')
  OR jsonb_typeof(p_result->'output'->'headline') IS DISTINCT FROM 'string'
  OR length(btrim(p_result->'output'->>'headline')) NOT BETWEEN 1 AND 120
  OR jsonb_typeof(p_result->'output'->'summary') IS DISTINCT FROM 'string'
  OR length(btrim(p_result->'output'->>'summary')) NOT BETWEEN 1 AND 1200
  OR jsonb_typeof(p_result->'output'->'claims') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION USING MESSAGE='REQUEST_INVALID'; END IF;
  IF jsonb_array_length(p_result->'output'->'claims') NOT BETWEEN 1 AND 6
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_result->'output'->'claims') c
    WHERE jsonb_typeof(c) IS DISTINCT FROM 'object'
    OR NOT (c ?& ARRAY['text','evidenceIds']) OR (c-ARRAY['text','evidenceIds'])<>'{}'::JSONB
    OR jsonb_typeof(c->'text') IS DISTINCT FROM 'string'
    OR length(btrim(c->>'text')) NOT BETWEEN 1 AND 500
    OR jsonb_typeof(c->'evidenceIds') IS DISTINCT FROM 'array') THEN
   RAISE EXCEPTION USING MESSAGE='REQUEST_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_result->'output'->'claims') c
    WHERE jsonb_array_length(c->'evidenceIds') NOT BETWEEN 1 AND 8
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(c->'evidenceIds') e
      WHERE jsonb_typeof(e) IS DISTINCT FROM 'string' OR NOT EXISTS(
       SELECT 1 FROM jsonb_array_elements(p_result->'sources') source WHERE source->'id'=e))) THEN
   RAISE EXCEPTION USING MESSAGE='REQUEST_INVALID'; END IF;
  PERFORM (p_result->>'createdAt')::astarter_private.milliseconds,
   (p_result->>'validUntil')::astarter_private.milliseconds;
  input_tokens=(p_result->'usage'->>'inputTokens')::astarter_private.integer_amount;
  output_tokens=(p_result->'usage'->>'outputTokens')::astarter_private.integer_amount;
  total_tokens=(p_result->'usage'->>'totalTokens')::astarter_private.integer_amount;
  PERFORM p_tokens::astarter_private.integer_amount;
  IF total_tokens<>p_tokens OR total_tokens<>input_tokens+output_tokens
  OR p_tokens>13056 OR output_tokens>800 OR jsonb_array_length(p_result->'sources') NOT BETWEEN 1 AND 8
  THEN RAISE EXCEPTION USING MESSAGE='REQUEST_INVALID'; END IF;
  -- Billing is advisory only: even a complete result cannot settle or release this reservation.
  IF p_result->'billing'<>'null'::JSONB THEN
   IF jsonb_typeof(p_result->'billing')<>'object'
   OR NOT (p_result->'billing' ?& ARRAY['provider','responseId','model','costMicrousd','isByok'])
   OR ((p_result->'billing')-ARRAY['provider','responseId','model','costMicrousd','isByok'])<>'{}'::JSONB
   OR p_result->'billing'->>'provider' IS DISTINCT FROM 'openrouter'
   OR p_result->'billing'->'responseId'<>p_result->'responseId'
   OR p_result->'billing'->'model'<>p_result->'model'
   OR p_result->'billing'->'isByok'<>'false'::JSONB
   OR jsonb_typeof(p_result->'billing'->'costMicrousd') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION USING MESSAGE='REQUEST_INVALID'; END IF;
   PERFORM (p_result->'billing'->>'costMicrousd')::astarter_private.integer_amount;
  END IF;
 ELSIF p_state='failed' THEN
  IF p_tokens IS DISTINCT FROM 0 OR p_result IS NOT NULL THEN
   RAISE EXCEPTION USING MESSAGE='REQUEST_INVALID'; END IF;
 ELSE
  IF p_tokens IS NOT NULL OR p_result IS NOT NULL THEN
   RAISE EXCEPTION USING MESSAGE='REQUEST_INVALID'; END IF;
 END IF;
 SELECT * INTO s FROM astarter_private.sessions WHERE token_digest=p_session FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='AUTH_REQUIRED'; END IF;
 PERFORM 1 FROM astarter_private.resolve_session(p_session,'astarter-research');
 IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='AUTH_REQUIRED'; END IF;
 SELECT * INTO l FROM astarter_private.leases WHERE lease_id=p_lease FOR SHARE;
 IF NOT FOUND OR l.target_id<>p_target OR l.database_name<>current_database()
 OR l.runtime_role<>session_user OR l.audience<>'astarter-research'
 OR l.model<>'openai/gpt-4.1-mini' THEN
  RAISE EXCEPTION USING MESSAGE='PRIVATE_TARGET_MISMATCH'; END IF;
 SELECT * INTO r FROM astarter_private.requests
 WHERE tenant_id=s.tenant_id AND subject_id=s.subject_id AND request_id=p_request;
 IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='REQUEST_NOT_FOUND'; END IF;
 PERFORM 1 FROM astarter_private.global_budget WHERE month_start_ms=r.month_start_ms FOR UPDATE;
 PERFORM 1 FROM astarter_private.policies WHERE month_start_ms=r.month_start_ms
 AND tenant_id=s.tenant_id AND policy_id=r.policy_id FOR UPDATE;
 SELECT * INTO r FROM astarter_private.requests
 WHERE tenant_id=s.tenant_id AND subject_id=s.subject_id AND request_id=p_request FOR UPDATE;
 t=floor(extract(epoch FROM clock_timestamp())*1000);
 IF s.revoked_at_ms IS NOT NULL OR s.not_before_ms>t OR s.expires_at_ms<=t THEN
  RAISE EXCEPTION USING MESSAGE='AUTH_REQUIRED'; END IF;
 IF l.created_at_ms>t OR l.expires_at_ms<=t THEN
  RAISE EXCEPTION USING MESSAGE='SCOPE_EXPIRED'; END IF;
 IF r.session_digest<>p_session OR r.claim_digest<>p_claim
 OR r.lease_id<>p_lease OR r.policy_id<>l.budget_id THEN
  RAISE EXCEPTION USING MESSAGE='PRIVATE_CONFLICT'; END IF;
 IF r.state<>'pending' THEN
  IF (r.state,r.settled_tokens,r.result,r.error_code) IS DISTINCT FROM
     (p_state,p_tokens,p_result,p_error) THEN
   RAISE EXCEPTION USING MESSAGE='PRIVATE_CONFLICT'; END IF;
 ELSE
  IF r.expires_at_ms<=t THEN RAISE EXCEPTION USING MESSAGE='SCOPE_EXPIRED'; END IF;
  UPDATE astarter_private.requests SET state=p_state,settled_tokens=p_tokens,result=p_result,
  error_code=p_error,finished_at_ms=t WHERE tenant_id=s.tenant_id AND subject_id=s.subject_id
  AND request_id=p_request RETURNING * INTO r;
 END IF;
 RETURN jsonb_build_object('tenantId',r.tenant_id,'subjectId',r.subject_id,'scopeId',r.tenant_id,
  'requestId',r.request_id,'fingerprint',r.fingerprint,'state',r.state,
  'createdAt',r.created_at_ms,'expiresAt',r.expires_at_ms,'result',r.result,'error',r.error_code,
  'settledTokens',r.settled_tokens,'queryOriginalRequest',r.state='unknown');
END $finish$;
REVOKE ALL ON FUNCTION astarter_private.finish_research(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,JSONB,TEXT)
 FROM PUBLIC;
GRANT EXECUTE ON FUNCTION astarter_private.finish_research(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,JSONB,TEXT)
 TO astarter_private_runtime;
