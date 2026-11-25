-- Q08 research stub v1; invoker-only, reference-only, no financial execution.
CREATE SCHEMA q08_research;
REVOKE ALL ON SCHEMA q08_research FROM PUBLIC;
CREATE DOMAIN q08_research.identifier AS TEXT COLLATE "C"
 CHECK (VALUE ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$');
CREATE DOMAIN q08_research.digest AS TEXT COLLATE "C" CHECK (VALUE ~ '^[0-9a-f]{64}$');
CREATE DOMAIN q08_research.atoms AS NUMERIC
 CHECK (VALUE >= 0 AND VALUE < 170141183460469231731687303715884105728 AND VALUE=trunc(VALUE));
CREATE DOMAIN q08_research.milliseconds AS BIGINT
 CHECK (VALUE BETWEEN 0 AND 253402300799999);

CREATE TABLE q08_research.research_metadata (
 singleton BOOLEAN PRIMARY KEY CHECK(singleton),
 contract TEXT NOT NULL CHECK(contract='Q08_RESEARCH_STUB_V1'),
 schema_version INTEGER NOT NULL CHECK(schema_version=1),
 writer_version INTEGER NOT NULL CHECK(writer_version=1),
 base_catalog_sha256 q08_research.digest NOT NULL,
 base_manifest_sha256 q08_research.digest NOT NULL,
 resource_sha256 q08_research.digest NOT NULL
);

CREATE TABLE q08_research.research_jobs (
 scope_key q08_research.digest NOT NULL,
 job_id q08_research.identifier NOT NULL,
 visibility TEXT NOT NULL CHECK(visibility IN ('PUBLIC','PRIVATE')),
 tenant_id q08_research.identifier NOT NULL,
 principal_id q08_research.identifier NOT NULL,
 account_id q08_research.identifier NOT NULL,
 source_scope_id q08_research.digest,
 plan_id q08_research.identifier,
 plan_revision q08_research.identifier,
 plan_sha256 q08_research.digest,
 subject_sha256 q08_research.digest NOT NULL,
 logical_request_id q08_research.identifier NOT NULL,
 event_id q08_research.identifier NOT NULL,
 research_kind TEXT NOT NULL CHECK(research_kind IN
 ('FACTS','PROPOSAL','REVISION','CONTRADICTION','ANOMALY','POSTMORTEM','FAST_EVENT')),
 mode TEXT NOT NULL CHECK(mode IN ('FAST','BALANCED','ADAPTIVE')),
 role_schema_revision TEXT NOT NULL DEFAULT 'Q08_RESEARCH_18_REF_V1'
 CHECK(role_schema_revision='Q08_RESEARCH_18_REF_V1'),
 policy_revision q08_research.identifier NOT NULL,
 manifest_sha256 q08_research.digest NOT NULL,
 manifest_bytes BYTEA NOT NULL CHECK(octet_length(manifest_bytes) BETWEEN 1 AND 2097152),
 content_sha256 q08_research.digest NOT NULL,
 state TEXT NOT NULL DEFAULT 'QUEUED' CHECK(state IN
 ('QUEUED','RUNNABLE','RUNNING','WAIT_DATA','WAIT_BUDGET','WAIT_REVIEW','UNKNOWN',
  'COMPLETED_REFERENCE','CANCELLED','FAILED_REFERENCE')),
 version BIGINT NOT NULL DEFAULT 0 CHECK(version>=0),
 created_at_ms q08_research.milliseconds NOT NULL,
 updated_at_ms q08_research.milliseconds NOT NULL,
 deadline_ms q08_research.milliseconds NOT NULL,
 resume_kind TEXT CHECK(resume_kind IN ('DATA','BUDGET','REVIEW')),
 resume_event_id q08_research.identifier,
 not_before_ms q08_research.milliseconds,
 PRIMARY KEY(scope_key,job_id),
 UNIQUE(scope_key,principal_id,logical_request_id),
 UNIQUE(scope_key,job_id,visibility),
 UNIQUE(scope_key,job_id,principal_id),
 UNIQUE(scope_key,job_id,manifest_sha256),
 FOREIGN KEY(source_scope_id,account_id)
 REFERENCES pg1_control.astarter_strategy_scopes(scope_id,account_id),
 FOREIGN KEY(source_scope_id,plan_id,plan_revision,plan_sha256)
 REFERENCES pg1_control.astarter_plan_versions(scope_id,plan_id,revision,plan_sha256),
 CHECK(created_at_ms<deadline_ms AND updated_at_ms>=created_at_ms),
 CHECK(content_sha256=encode(sha256(manifest_bytes),'hex')),
 -- Identifiers are ASCII without quotes/backslashes; match the existing canonical scope encoding.
 CHECK(scope_key=encode(sha256(convert_to(CASE WHEN visibility='PUBLIC'
 THEN '{"visibility":"PUBLIC"}' ELSE
 '{"account_scope_id":"'||account_id||'","principal_scope_id":"'||principal_id||
 '","tenant_id":"'||tenant_id||'","visibility":"PRIVATE"}' END,'UTF8')),'hex')),
 CHECK((visibility='PUBLIC' AND source_scope_id IS NULL AND plan_id IS NULL
        AND plan_revision IS NULL AND plan_sha256 IS NULL AND tenant_id='platform'
        AND account_id='public-research' AND principal_id='platform-public-research'
        AND research_kind='FACTS') OR
       (visibility='PRIVATE' AND source_scope_id IS NOT NULL AND plan_id IS NOT NULL
        AND plan_revision IS NOT NULL AND plan_sha256 IS NOT NULL
        AND plan_sha256=subject_sha256)),
 CHECK(((convert_from(manifest_bytes,'UTF8')::jsonb->>'manifest_sha256')=manifest_sha256
 AND (convert_from(manifest_bytes,'UTF8')::jsonb->>'subject_sha256')=subject_sha256
 AND (convert_from(manifest_bytes,'UTF8')::jsonb->>'principal_id')=principal_id
 AND (convert_from(manifest_bytes,'UTF8')::jsonb#>>'{trigger,job_id}')=job_id
 AND (convert_from(manifest_bytes,'UTF8')::jsonb#>>'{trigger,logical_request_id}')=logical_request_id
 AND (convert_from(manifest_bytes,'UTF8')::jsonb#>>'{trigger,event_id}')=event_id
 AND (convert_from(manifest_bytes,'UTF8')::jsonb#>>'{trigger,kind}')=research_kind
 AND (convert_from(manifest_bytes,'UTF8')::jsonb#>>'{trigger,mode}')=mode
 AND (convert_from(manifest_bytes,'UTF8')::jsonb#>>'{policy,revision}')=policy_revision
 AND (convert_from(manifest_bytes,'UTF8')::jsonb#>>'{visibility,visibility}')=visibility
 AND (convert_from(manifest_bytes,'UTF8')::jsonb#>>'{policy,deadline_ms}')::BIGINT=deadline_ms
 AND (visibility='PUBLIC' OR
 ((convert_from(manifest_bytes,'UTF8')::jsonb#>>'{visibility,tenant_id}')=tenant_id
 AND (convert_from(manifest_bytes,'UTF8')::jsonb#>>'{visibility,principal_scope_id}')=principal_id
 AND (convert_from(manifest_bytes,'UTF8')::jsonb#>>'{visibility,account_scope_id}')=account_id
 AND (convert_from(manifest_bytes,'UTF8')::jsonb#>>'{trigger,plan,plan_id}')=plan_id
 AND (convert_from(manifest_bytes,'UTF8')::jsonb#>>'{trigger,plan,revision}')=plan_revision
 AND (convert_from(manifest_bytes,'UTF8')::jsonb#>>'{trigger,plan,binding,tenant_id}')=tenant_id
 AND (convert_from(manifest_bytes,'UTF8')::jsonb#>>'{trigger,plan,binding,account_id}')=account_id
 AND (convert_from(manifest_bytes,'UTF8')::jsonb#>>'{trigger,plan,binding,environment}')='OFFLINE'))
 AND (convert_from(manifest_bytes,'UTF8')::jsonb->>'role_semantics_revision')=role_schema_revision
 AND (convert_from(manifest_bytes,'UTF8')::jsonb->>'purpose')='OFFLINE_FIXTURE'
 AND (convert_from(manifest_bytes,'UTF8')::jsonb->'execution_authorized')='false'::jsonb) IS TRUE)
);
CREATE INDEX research_jobs_due ON q08_research.research_jobs(state,not_before_ms,deadline_ms);

CREATE TABLE q08_research.research_role_attempts (
 scope_key q08_research.digest NOT NULL,
 job_id q08_research.identifier NOT NULL,
 visibility TEXT NOT NULL,
 role_id TEXT COLLATE "C" NOT NULL CHECK(role_id ~ '^A(0[1-9]|1[0-8])$'),
 attempt_id q08_research.identifier NOT NULL,
 attempt_no SMALLINT NOT NULL DEFAULT 1 CHECK(attempt_no=1),
 manifest_sha256 q08_research.digest NOT NULL,
 request_sha256 q08_research.digest NOT NULL,
 payload_sha256 q08_research.digest NOT NULL,
 request_bytes BYTEA NOT NULL CHECK(octet_length(request_bytes) BETWEEN 1 AND 1048576),
 content_sha256 q08_research.digest NOT NULL,
 model_id q08_research.identifier NOT NULL,
 profile_revision q08_research.identifier NOT NULL,
 policy_revision q08_research.identifier NOT NULL,
 effort TEXT NOT NULL CHECK(effort IN ('LOW','MEDIUM','HIGH')),
 key_owner_id q08_research.identifier NOT NULL,
 credential_revision q08_research.identifier NOT NULL,
 funding TEXT NOT NULL CHECK(funding IN ('PLATFORM','BYOK')),
 state TEXT NOT NULL DEFAULT 'PLANNED' CHECK(state IN
 ('PLANNED','CLAIMED','RESERVED','DISPATCH_STARTED','UNKNOWN_PENDING_RECONCILE',
  'SETTLED','FAILED','RELEASED_UNSENT')),
 worker_id q08_research.identifier,
 claim_id q08_research.identifier,
 owner_epoch BIGINT NOT NULL DEFAULT 0 CHECK(owner_epoch>=0),
 lease_until_ms q08_research.milliseconds,
 permit_id q08_research.identifier,
 response_id q08_research.identifier,
 response_sha256 q08_research.digest,
 version BIGINT NOT NULL DEFAULT 0 CHECK(version>=0),
 created_at_ms q08_research.milliseconds NOT NULL,
 updated_at_ms q08_research.milliseconds NOT NULL CHECK(updated_at_ms>=created_at_ms),
 PRIMARY KEY(scope_key,job_id,attempt_id),
 UNIQUE(scope_key,job_id,role_id),
 UNIQUE(scope_key,job_id,attempt_id,role_id),
 UNIQUE(scope_key,job_id,attempt_id,request_sha256),
 UNIQUE(scope_key,job_id,attempt_id,role_id,visibility,funding,key_owner_id,credential_revision),
 UNIQUE(scope_key,job_id,permit_id),
 FOREIGN KEY(scope_key,job_id,visibility)
 REFERENCES q08_research.research_jobs(scope_key,job_id,visibility),
 FOREIGN KEY(scope_key,job_id,manifest_sha256)
 REFERENCES q08_research.research_jobs(scope_key,job_id,manifest_sha256),
 CHECK(visibility<>'PUBLIC' OR (role_id IN ('A01','A02') AND funding='PLATFORM')),
 CHECK((worker_id IS NULL AND claim_id IS NULL AND lease_until_ms IS NULL AND owner_epoch=0)
 OR (worker_id IS NOT NULL AND claim_id IS NOT NULL AND lease_until_ms IS NOT NULL AND owner_epoch>0)),
 CHECK(state NOT IN ('CLAIMED','RESERVED','DISPATCH_STARTED','UNKNOWN_PENDING_RECONCILE','SETTLED')
 OR worker_id IS NOT NULL),
 CHECK(state NOT IN ('DISPATCH_STARTED','UNKNOWN_PENDING_RECONCILE','SETTLED') OR permit_id IS NOT NULL),
 CHECK(content_sha256=encode(sha256(request_bytes),'hex'))
);
CREATE INDEX research_attempts_lease ON q08_research.research_role_attempts(state,lease_until_ms);

CREATE TABLE q08_research.research_artifacts (
 scope_key q08_research.digest NOT NULL,
 job_id q08_research.identifier NOT NULL,
 artifact_id q08_research.identifier NOT NULL,
 principal_id q08_research.identifier NOT NULL,
 attempt_id q08_research.identifier NOT NULL,
 role_id TEXT COLLATE "C" NOT NULL,
 visibility TEXT NOT NULL,
 funding TEXT NOT NULL CHECK(funding IN ('PLATFORM','BYOK')),
 key_owner_id q08_research.identifier NOT NULL,
 credential_revision q08_research.identifier NOT NULL,
 reuse_key q08_research.digest NOT NULL,
 role_schema_revision TEXT NOT NULL DEFAULT 'Q08_RESEARCH_18_REF_V1'
 CHECK(role_schema_revision='Q08_RESEARCH_18_REF_V1'),
 content_bytes BYTEA NOT NULL CHECK(octet_length(content_bytes) BETWEEN 1 AND 2097152),
 content_sha256 q08_research.digest NOT NULL,
 output_sha256 q08_research.digest NOT NULL,
 created_at_ms q08_research.milliseconds NOT NULL,
 use_until_ms q08_research.milliseconds NOT NULL CHECK(use_until_ms>created_at_ms),
 PRIMARY KEY(scope_key,job_id,artifact_id),
 UNIQUE(scope_key,job_id,role_id),
 UNIQUE(scope_key,job_id,artifact_id,visibility,principal_id,key_owner_id,credential_revision),
 FOREIGN KEY(scope_key,job_id,principal_id)
 REFERENCES q08_research.research_jobs(scope_key,job_id,principal_id),
 FOREIGN KEY(scope_key,job_id,visibility)
 REFERENCES q08_research.research_jobs(scope_key,job_id,visibility),
 FOREIGN KEY(scope_key,job_id,attempt_id,role_id)
 REFERENCES q08_research.research_role_attempts(scope_key,job_id,attempt_id,role_id),
 FOREIGN KEY(scope_key,job_id,attempt_id,role_id,visibility,funding,key_owner_id,credential_revision)
 REFERENCES q08_research.research_role_attempts
 (scope_key,job_id,attempt_id,role_id,visibility,funding,key_owner_id,credential_revision),
 CHECK(visibility<>'PUBLIC' OR (funding='PLATFORM' AND role_id IN ('A01','A02'))),
 CHECK(content_sha256=encode(sha256(content_bytes),'hex'))
);
CREATE INDEX research_artifacts_reuse ON q08_research.research_artifacts(reuse_key,use_until_ms);

CREATE TABLE q08_research.research_consumers (
 scope_key q08_research.digest NOT NULL,
 job_id q08_research.identifier NOT NULL,
 consumer_id q08_research.identifier NOT NULL,
 principal_id q08_research.identifier NOT NULL,
 key_owner_id q08_research.identifier NOT NULL,
 credential_revision q08_research.identifier NOT NULL,
 producer_scope_key q08_research.digest NOT NULL,
 producer_job_id q08_research.identifier NOT NULL,
 artifact_id q08_research.identifier NOT NULL,
 producer_visibility TEXT NOT NULL CHECK(producer_visibility IN ('PUBLIC','PRIVATE')),
 producer_principal_id q08_research.identifier NOT NULL,
 producer_key_owner_id q08_research.identifier NOT NULL,
 producer_credential_revision q08_research.identifier NOT NULL,
 created_at_ms q08_research.milliseconds NOT NULL,
 use_until_ms q08_research.milliseconds NOT NULL CHECK(use_until_ms>created_at_ms),
 PRIMARY KEY(scope_key,job_id,consumer_id),
 UNIQUE(scope_key,job_id,producer_scope_key,producer_job_id,artifact_id),
 FOREIGN KEY(scope_key,job_id,principal_id)
 REFERENCES q08_research.research_jobs(scope_key,job_id,principal_id),
 FOREIGN KEY(producer_scope_key,producer_job_id,artifact_id,producer_visibility,
             producer_principal_id,producer_key_owner_id,producer_credential_revision)
 REFERENCES q08_research.research_artifacts(scope_key,job_id,artifact_id,visibility,
             principal_id,key_owner_id,credential_revision),
 CHECK(producer_visibility='PUBLIC' OR
 (scope_key=producer_scope_key AND principal_id=producer_principal_id
 AND key_owner_id=producer_key_owner_id AND credential_revision=producer_credential_revision))
);

CREATE TABLE q08_research.research_budget_scopes (
 budget_scope_id q08_research.digest PRIMARY KEY,
 scope_kind TEXT NOT NULL CHECK(scope_kind IN ('OWNER','ROOT','TASK','DAY','PLATFORM')),
 scope_owner q08_research.identifier NOT NULL,
 period_id q08_research.identifier NOT NULL,
 policy_revision q08_research.identifier NOT NULL,
 unit_id TEXT NOT NULL CHECK(unit_id='SIM_MODEL_CREDIT_V1'),
 scale SMALLINT NOT NULL CHECK(scale=6),
 cap_atoms q08_research.atoms NOT NULL,
 reserved_atoms q08_research.atoms NOT NULL DEFAULT 0,
 spent_atoms q08_research.atoms NOT NULL DEFAULT 0,
 unknown_atoms q08_research.atoms NOT NULL DEFAULT 0,
 version BIGINT NOT NULL DEFAULT 0 CHECK(version>=0),
 created_at_ms q08_research.milliseconds NOT NULL,
 updated_at_ms q08_research.milliseconds NOT NULL CHECK(updated_at_ms>=created_at_ms),
 UNIQUE(scope_kind,scope_owner,period_id,policy_revision,unit_id),
 CHECK(reserved_atoms+spent_atoms+unknown_atoms<=cap_atoms)
);

CREATE TABLE q08_research.research_reservations (
 reservation_id q08_research.identifier NOT NULL,
 budget_scope_id q08_research.digest NOT NULL REFERENCES q08_research.research_budget_scopes,
 scope_key q08_research.digest NOT NULL,
 job_id q08_research.identifier NOT NULL,
 attempt_id q08_research.identifier NOT NULL,
 request_sha256 q08_research.digest NOT NULL,
 quote_sha256 q08_research.digest NOT NULL,
 atoms q08_research.atoms NOT NULL,
 state TEXT NOT NULL DEFAULT 'RESERVED' CHECK(state IN
 ('RESERVED','DISPATCH_STARTED','UNKNOWN_PENDING_RECONCILE','SETTLED','RELEASED_UNSENT')),
 version BIGINT NOT NULL DEFAULT 0 CHECK(version>=0),
 created_at_ms q08_research.milliseconds NOT NULL,
 updated_at_ms q08_research.milliseconds NOT NULL CHECK(updated_at_ms>=created_at_ms),
 PRIMARY KEY(reservation_id,budget_scope_id),
 FOREIGN KEY(scope_key,job_id,attempt_id,request_sha256)
 REFERENCES q08_research.research_role_attempts(scope_key,job_id,attempt_id,request_sha256)
);

CREATE TABLE q08_research.research_events_outbox (
 scope_key q08_research.digest NOT NULL,
 job_id q08_research.identifier NOT NULL,
 seq BIGINT NOT NULL CHECK(seq>0),
 event_id q08_research.identifier NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('TRIGGER','QUESTION','ANSWER','ROLE_READY','ROLE_RESULT',
 'WAIT','CANCEL','DEADLINE','ARTIFACT_PUBLISHED','NOTICE','RECONCILIATION')),
 cause_event_id q08_research.identifier,
 fact_bytes BYTEA NOT NULL CHECK(octet_length(fact_bytes) BETWEEN 1 AND 2097152),
 fact_sha256 q08_research.digest NOT NULL,
 created_at_ms q08_research.milliseconds NOT NULL,
 not_before_ms q08_research.milliseconds NOT NULL,
 delivery_state TEXT NOT NULL DEFAULT 'PENDING'
 CHECK(delivery_state IN ('PENDING','CLAIMED','SENT','ACKED','UNKNOWN')),
 delivery_owner q08_research.identifier,
 delivery_epoch BIGINT NOT NULL DEFAULT 0 CHECK(delivery_epoch>=0),
 delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(delivery_attempts>=0),
 delivery_lease_until_ms q08_research.milliseconds,
 delivery_ack_sha256 q08_research.digest,
 updated_at_ms q08_research.milliseconds NOT NULL CHECK(updated_at_ms>=created_at_ms),
 version BIGINT NOT NULL DEFAULT 0 CHECK(version>=0),
 PRIMARY KEY(scope_key,job_id,seq),
 UNIQUE(scope_key,job_id,event_id),
 FOREIGN KEY(scope_key,job_id) REFERENCES q08_research.research_jobs,
 CHECK(fact_sha256=encode(sha256(fact_bytes),'hex')),
 CHECK((delivery_owner IS NULL AND delivery_epoch=0 AND delivery_lease_until_ms IS NULL)
 OR (delivery_owner IS NOT NULL AND delivery_epoch>0 AND delivery_lease_until_ms IS NOT NULL))
);
CREATE INDEX research_outbox_due ON q08_research.research_events_outbox
 (delivery_state,not_before_ms,delivery_lease_until_ms);

CREATE FUNCTION q08_research.require_writer() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $q08$
BEGIN
 PERFORM 1 FROM q08_research.research_metadata WHERE singleton AND schema_version=1
 AND writer_version=1 AND contract='Q08_RESEARCH_STUB_V1' FOR SHARE;
 IF NOT FOUND OR current_setting('q08.writer_version',true) IS DISTINCT FROM '1' THEN
  RAISE EXCEPTION USING MESSAGE='Q08_WRITER_VERSION',ERRCODE='P0001';
 END IF;
 IF TG_OP='TRUNCATE' THEN
  RAISE EXCEPTION USING MESSAGE='Q08_RETAINED',ERRCODE='P0001';
 END IF;
 RETURN NULL;
END $q08$;

CREATE FUNCTION q08_research.guard_row() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $q08$
DECLARE mutable TEXT[];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING MESSAGE='Q08_RETAINED',ERRCODE='P0001'; END IF;
 IF TG_TABLE_NAME='research_jobs' THEN
 IF NEW.visibility='PRIVATE' THEN
  PERFORM 1 FROM pg1_control.astarter_strategy_scopes WHERE scope_id=NEW.source_scope_id
  AND tenant_id=NEW.tenant_id AND account_id=NEW.account_id AND environment='OFFLINE';
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='Q08_SCOPE_MISMATCH',ERRCODE='P0001'; END IF;
 END IF;
 END IF;
 IF TG_TABLE_NAME='research_reservations' THEN
  PERFORM pg_advisory_xact_lock(170508,hashtext(NEW.reservation_id));
 END IF;
 IF TG_TABLE_NAME='research_consumers' THEN
  PERFORM 1 FROM q08_research.research_artifacts a WHERE a.scope_key=NEW.producer_scope_key
  AND a.job_id=NEW.producer_job_id AND a.artifact_id=NEW.artifact_id
  AND a.created_at_ms<=NEW.created_at_ms AND NEW.use_until_ms<=a.use_until_ms;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='Q08_SOURCE_TTL',ERRCODE='P0001'; END IF;
 END IF;
 IF TG_OP='INSERT' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='research_jobs' THEN
  mutable=ARRAY['state','version','updated_at_ms','resume_kind','resume_event_id','not_before_ms'];
 ELSIF TG_TABLE_NAME='research_role_attempts' THEN
  mutable=ARRAY['state','worker_id','claim_id','owner_epoch','lease_until_ms','permit_id',
  'response_id','response_sha256','version','updated_at_ms'];
 ELSIF TG_TABLE_NAME='research_budget_scopes' THEN
  mutable=ARRAY['reserved_atoms','spent_atoms','unknown_atoms','version','updated_at_ms'];
 ELSIF TG_TABLE_NAME='research_reservations' THEN
  mutable=ARRAY['state','version','updated_at_ms'];
 ELSIF TG_TABLE_NAME='research_events_outbox' THEN
  mutable=ARRAY['delivery_state','delivery_owner','delivery_epoch','delivery_attempts',
  'delivery_lease_until_ms','delivery_ack_sha256','version','updated_at_ms'];
 ELSE RAISE EXCEPTION USING MESSAGE='Q08_IMMUTABLE',ERRCODE='P0001'; END IF;
 IF (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable)
 OR NEW.version<>OLD.version+1 OR NEW.updated_at_ms<OLD.updated_at_ms THEN
  RAISE EXCEPTION USING MESSAGE='Q08_IMMUTABLE_OR_VERSION',ERRCODE='P0001';
 END IF;
 IF TG_TABLE_NAME='research_role_attempts' THEN
  IF NEW.owner_epoch<OLD.owner_epoch THEN
   RAISE EXCEPTION USING MESSAGE='Q08_OWNER_EPOCH',ERRCODE='P0001';
  END IF;
 END IF;
 IF TG_TABLE_NAME='research_events_outbox' THEN
  IF NEW.delivery_epoch<OLD.delivery_epoch OR NEW.delivery_attempts<OLD.delivery_attempts THEN
   RAISE EXCEPTION USING MESSAGE='Q08_DELIVERY_EPOCH',ERRCODE='P0001';
  END IF;
 END IF;
 RETURN NEW;
END $q08$;

CREATE FUNCTION q08_research.metadata_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $q08$
BEGIN
 IF TG_OP<>'UPDATE' OR NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION USING MESSAGE='Q08_METADATA_IMMUTABLE',ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $q08$;
CREATE TRIGGER q08_metadata_immutable BEFORE UPDATE OR DELETE ON q08_research.research_metadata
 FOR EACH ROW EXECUTE FUNCTION q08_research.metadata_immutable();

CREATE FUNCTION q08_research.reservation_group() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $q08$
BEGIN
 IF (SELECT count(DISTINCT ROW(scope_key,job_id,attempt_id,request_sha256,quote_sha256,atoms,state))
 FROM q08_research.research_reservations WHERE reservation_id=NEW.reservation_id)>1 THEN
  RAISE EXCEPTION USING MESSAGE='Q08_RESERVATION_GROUP',ERRCODE='23514';
 END IF;
 RETURN NULL;
END $q08$;
CREATE CONSTRAINT TRIGGER q08_reservation_group AFTER INSERT OR UPDATE
 ON q08_research.research_reservations DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION q08_research.reservation_group();

DO $q08$
DECLARE t TEXT;
BEGIN
 FOREACH t IN ARRAY ARRAY['research_jobs','research_role_attempts','research_artifacts',
 'research_consumers','research_budget_scopes','research_reservations','research_events_outbox'] LOOP
  EXECUTE format('CREATE TRIGGER q08_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON q08_research.%I FOR EACH STATEMENT EXECUTE FUNCTION q08_research.require_writer()',t);
  EXECUTE format('CREATE TRIGGER q08_row BEFORE INSERT OR UPDATE OR DELETE ON q08_research.%I FOR EACH ROW EXECUTE FUNCTION q08_research.guard_row()',t);
 END LOOP;
END $q08$;
REVOKE ALL ON ALL TABLES IN SCHEMA q08_research FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA q08_research FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA q08_research FROM PUBLIC;
