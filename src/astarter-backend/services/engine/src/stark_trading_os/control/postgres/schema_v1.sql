-- PG1 static schema resource. Source: frozen SQLite schema8, NOT runtime DAL.
-- Apply only in a transaction to an empty isolated database; use generated bundle.sql.
CREATE SCHEMA pg1_control;
REVOKE ALL ON SCHEMA pg1_control FROM PUBLIC;
SET LOCAL search_path = pg1_control, pg_catalog;
CREATE TABLE pg1_metadata (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
 schema_version BIGINT NOT NULL CHECK(schema_version=1),
 source_version BIGINT NOT NULL CHECK(source_version=8),
 writer_version BIGINT NOT NULL CHECK(writer_version=1),
 resource_sha256 TEXT NOT NULL,
 manifest_sha256 TEXT NOT NULL,
 manifest_bytes BYTEA NOT NULL
);
CREATE TABLE astarter_accounts (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 account_id TEXT COLLATE "C" PRIMARY KEY CHECK(length(account_id) BETWEEN 1 AND 64),
 venue_session TEXT COLLATE "C" NOT NULL UNIQUE CHECK(length(venue_session)=36),
 baseline_quote TEXT COLLATE "C" NOT NULL CHECK(length(baseline_quote) BETWEEN 1 AND 256),
 risk_period TEXT COLLATE "C" NOT NULL CHECK(length(risk_period) BETWEEN 1 AND 64),
 lock_fraction TEXT COLLATE "C" NOT NULL CHECK(length(lock_fraction) BETWEEN 1 AND 256),
 risk_epoch BIGINT NOT NULL DEFAULT 0 CHECK(risk_epoch>=0),
 controller_fence BIGINT NOT NULL DEFAULT 1 CHECK(controller_fence>0),
 profit_hwm TEXT COLLATE "C" NOT NULL DEFAULT '0',
 locked_reserve TEXT COLLATE "C" NOT NULL DEFAULT '0',
 hard_locks BYTEA NOT NULL DEFAULT decode('5b5d','hex') CHECK(TRUE),
 last_sequence BIGINT NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
 last_snapshot BYTEA,
 last_snapshot_sha256 TEXT COLLATE "C" CHECK(last_snapshot_sha256 IS NULL OR length(last_snapshot_sha256)=64)
);
CREATE TABLE astarter_admission_heads (
 account_id TEXT COLLATE "C" PRIMARY KEY,
 scope_id TEXT COLLATE "C" NOT NULL,
 purpose TEXT COLLATE "C" NOT NULL CHECK(purpose IN ('LEGACY_FINITE','PLAN_FINITE_ATOMICITY')),
 authority_id TEXT COLLATE "C" NOT NULL CHECK(length(authority_id) BETWEEN 1 AND 128),
 generation BIGINT NOT NULL DEFAULT 0 CHECK(generation>=0),
 admission_id TEXT COLLATE "C",
 CHECK((generation=0 AND admission_id IS NULL) OR (generation>0 AND admission_id IS NOT NULL)),
 CHECK(purpose!='LEGACY_FINITE' OR generation=0)
);
CREATE TABLE astarter_admissions (
 admission_id TEXT COLLATE "C" PRIMARY KEY CHECK(length(admission_id) BETWEEN 1 AND 128),
 account_id TEXT COLLATE "C" NOT NULL ,
 scope_id TEXT COLLATE "C" NOT NULL,
 binding_id TEXT COLLATE "C" NOT NULL,
 episode_id TEXT COLLATE "C" NOT NULL,
 plan_id TEXT COLLATE "C" NOT NULL,
 revision TEXT COLLATE "C" NOT NULL,
 approval_id TEXT COLLATE "C" NOT NULL,
 generation BIGINT NOT NULL CHECK(generation>0),
 dependency_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(dependency_sha256)=64),
 policy_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(policy_sha256)=64),
 starts_at_ms BIGINT NOT NULL CHECK(starts_at_ms>=0),
 expires_at_ms BIGINT NOT NULL CHECK(expires_at_ms>starts_at_ms),
 state TEXT COLLATE "C" NOT NULL CHECK(state IN ('READY','REVOKED','DEPENDENCY_CHANGED')),
 update_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(update_sha256)=64),
 UNIQUE(account_id,generation),
 UNIQUE(admission_id,account_id,generation),
 UNIQUE(admission_id,account_id,binding_id)
);
CREATE TABLE astarter_approval_references (
 scope_id TEXT COLLATE "C" NOT NULL,
 plan_id TEXT COLLATE "C" NOT NULL,
 revision TEXT COLLATE "C" NOT NULL,
 plan_sha256 TEXT COLLATE "C" NOT NULL,
 reference_id TEXT COLLATE "C" NOT NULL CHECK(length(reference_id) BETWEEN 1 AND 128),
 request_key TEXT COLLATE "C" NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 authority TEXT COLLATE "C" NOT NULL CHECK(authority='OFFLINE_REFERENCE'),
 risk_policy_revision TEXT COLLATE "C" NOT NULL,
 role_schema_revision TEXT COLLATE "C" NOT NULL CHECK(role_schema_revision='Q01_S03_NINE_DUTIES_REF_V1'),
 starts_at_ms BIGINT NOT NULL CHECK(starts_at_ms>=0),
 expires_at_ms BIGINT NOT NULL CHECK(expires_at_ms>starts_at_ms),
 content_bytes BYTEA NOT NULL,
 content_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(content_sha256)=64),
 PRIMARY KEY(scope_id,reference_id),
 UNIQUE(scope_id,request_key)
);
CREATE TABLE astarter_audit (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 account_id TEXT COLLATE "C" NOT NULL ,
 seq BIGINT NOT NULL CHECK(seq>0),
 kind TEXT COLLATE "C" NOT NULL,
 fact_bytes BYTEA NOT NULL CHECK(TRUE),
 fact_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(fact_sha256)=64),
 PRIMARY KEY(account_id,seq)
);
CREATE TABLE astarter_bindings (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 binding_id TEXT COLLATE "C" PRIMARY KEY CHECK(length(binding_id)=36),
 account_id TEXT COLLATE "C" NOT NULL ,
 component_id TEXT COLLATE "C" NOT NULL CHECK(length(component_id)=64),
 policy_bytes BYTEA NOT NULL CHECK(TRUE),
 policy_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(policy_sha256)=64),
 status TEXT COLLATE "C" NOT NULL CHECK(status IN ('ACTIVE','REVOKED')),
 UNIQUE(binding_id,account_id),
 UNIQUE(account_id,component_id,policy_sha256)
);
CREATE TABLE astarter_episode_references (
 scope_id TEXT COLLATE "C" NOT NULL,
 account_id TEXT COLLATE "C" NOT NULL,
 episode_id TEXT COLLATE "C" NOT NULL CHECK(length(episode_id) BETWEEN 1 AND 128),
 plan_id TEXT COLLATE "C" NOT NULL,
 revision TEXT COLLATE "C" NOT NULL,
 plan_sha256 TEXT COLLATE "C" NOT NULL,
 binding_id TEXT COLLATE "C",
 content_bytes BYTEA NOT NULL,
 content_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(content_sha256)=64),
 PRIMARY KEY(scope_id,episode_id),
 UNIQUE(scope_id,episode_id,plan_id,revision)
);
CREATE TABLE astarter_fills (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 account_id TEXT COLLATE "C" NOT NULL,
 order_id TEXT COLLATE "C" NOT NULL,
 trade_id TEXT COLLATE "C" NOT NULL CHECK(length(trade_id) BETWEEN 1 AND 128),
 fact_bytes BYTEA NOT NULL CHECK(TRUE),
 fact_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(fact_sha256)=64),
 PRIMARY KEY(account_id,order_id,trade_id)
);
CREATE TABLE astarter_intent_admissions (
 intent_id TEXT COLLATE "C" PRIMARY KEY,
 account_id TEXT COLLATE "C" NOT NULL,
 binding_id TEXT COLLATE "C" NOT NULL,
 admission_id TEXT COLLATE "C" NOT NULL
);
CREATE TABLE astarter_intents (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 intent_id TEXT COLLATE "C" PRIMARY KEY CHECK(length(intent_id)=36),
 account_id TEXT COLLATE "C" NOT NULL ,
 binding_id TEXT COLLATE "C" NOT NULL,
 opportunity_key TEXT COLLATE "C" NOT NULL CHECK(length(opportunity_key) BETWEEN 1 AND 128),
 request_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(request_sha256)=64),
 receipt_bytes BYTEA NOT NULL CHECK(TRUE),
 entry_order_id TEXT COLLATE "C" NOT NULL UNIQUE CHECK(length(entry_order_id) BETWEEN 1 AND 36),
 state TEXT COLLATE "C" NOT NULL CHECK(state IN ('RESERVED','DISPATCHING','ACTIVE','CLOSING','CLOSED','NO_FILL','RECONCILING')),
 pending_risk TEXT COLLATE "C" NOT NULL,
 inventory_risk TEXT COLLATE "C" NOT NULL DEFAULT '0',
 cash_hold TEXT COLLATE "C" NOT NULL,
 last_exit_attempt_ns BIGINT NOT NULL DEFAULT 0 CHECK(last_exit_attempt_ns>=0),
 UNIQUE(intent_id,account_id),
 UNIQUE(account_id,opportunity_key)
);
CREATE TABLE astarter_layer_references (
 scope_id TEXT COLLATE "C" NOT NULL,
 episode_id TEXT COLLATE "C" NOT NULL,
 layer_index BIGINT NOT NULL CHECK(layer_index BETWEEN 0 AND 127),
 mode TEXT COLLATE "C" NOT NULL CHECK(mode IN ('VIRTUAL','ACTUAL_REFERENCE')),
 action_id TEXT COLLATE "C" NOT NULL CHECK(length(action_id) BETWEEN 1 AND 128),
 trigger_id TEXT COLLATE "C" NOT NULL,
 content_bytes BYTEA NOT NULL,
 content_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(content_sha256)=64),
 PRIMARY KEY(scope_id,episode_id,layer_index),
 UNIQUE(scope_id,episode_id,action_id)
);
CREATE TABLE astarter_limits (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 account_id TEXT COLLATE "C" NOT NULL ,
 scope TEXT COLLATE "C" NOT NULL CHECK(scope IN ('PRIVATE','CYCLE','DAY','PORTFOLIO','ASSET','CORRELATED','EVENT')),
 cap TEXT COLLATE "C" NOT NULL,
 booked_debit TEXT COLLATE "C" NOT NULL DEFAULT '0',
 PRIMARY KEY(account_id,scope)
);
CREATE TABLE astarter_orders (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 order_id TEXT COLLATE "C" PRIMARY KEY CHECK(length(order_id) BETWEEN 1 AND 36),
 account_id TEXT COLLATE "C" NOT NULL ,
 intent_id TEXT COLLATE "C" NOT NULL,
 role TEXT COLLATE "C" NOT NULL CHECK(role IN ('ENTRY','STOP','EXIT')),
 quantity TEXT COLLATE "C" NOT NULL,
 trigger_price TEXT COLLATE "C",
 native_state TEXT COLLATE "C" NOT NULL DEFAULT 'UNKNOWN',
 dispatch_state TEXT COLLATE "C" NOT NULL DEFAULT 'PENDING' CHECK(dispatch_state IN ('PENDING','DISPATCHING','OBSERVED','CANCELED_LOCAL')),
 cancel_requested BIGINT NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
 accepted_at_ns BIGINT CHECK(accepted_at_ns IS NULL OR accepted_at_ns>=0),
 deadline_ns BIGINT CHECK(deadline_ns IS NULL OR deadline_ns>=0),
 last_sequence BIGINT NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
 UNIQUE(order_id,account_id)
);
CREATE TABLE astarter_plan_versions (
 scope_id TEXT COLLATE "C" NOT NULL ,
 plan_id TEXT COLLATE "C" NOT NULL CHECK(length(plan_id) BETWEEN 1 AND 128),
 revision TEXT COLLATE "C" NOT NULL CHECK(length(revision) BETWEEN 1 AND 128),
 ordinal BIGINT NOT NULL CHECK(ordinal>0),
 previous_revision TEXT COLLATE "C",
 request_key TEXT COLLATE "C" NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 plan_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(plan_sha256)=64),
 spec_sha256 TEXT COLLATE "C" NOT NULL,
 risk_policy_revision TEXT COLLATE "C" NOT NULL,
 role_schema_revision TEXT COLLATE "C" NOT NULL CHECK(role_schema_revision='Q01_S03_NINE_DUTIES_REF_V1'),
 starts_at_ms BIGINT NOT NULL CHECK(starts_at_ms>=0),
 expires_at_ms BIGINT NOT NULL CHECK(expires_at_ms>starts_at_ms),
 content_bytes BYTEA NOT NULL,
 content_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(content_sha256)=64),
 PRIMARY KEY(scope_id,plan_id,revision),
 UNIQUE(scope_id,plan_id,ordinal),
 UNIQUE(scope_id,request_key),
 UNIQUE(scope_id,plan_id,revision,plan_sha256),
 CHECK((ordinal=1 AND previous_revision IS NULL) OR (ordinal>1 AND previous_revision IS NOT NULL))
);
CREATE TABLE astarter_recovery_checkpoints (
 scope_id TEXT COLLATE "C" NOT NULL,
 account_id TEXT COLLATE "C" NOT NULL,
 plan_id TEXT COLLATE "C" NOT NULL,
 revision TEXT COLLATE "C" NOT NULL,
 plan_sha256 TEXT COLLATE "C" NOT NULL,
 seq BIGINT NOT NULL CHECK(seq>0),
 previous_sha256 TEXT COLLATE "C",
 request_key TEXT COLLATE "C" NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 state_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(state_sha256)=64),
 lifecycle TEXT COLLATE "C" NOT NULL CHECK(lifecycle IN ('DRAFT','PREFLIGHT','REVIEWED_REFERENCE','ACTIVE_REFERENCE','PAUSED','EXPIRED')),
 order_state TEXT COLLATE "C" NOT NULL CHECK(order_state IN ('NONE','PENDING','ACK','PARTIAL','FILLED','CANCELLED','UNKNOWN')),
 protection TEXT COLLATE "C" NOT NULL CHECK(protection IN ('NOT_REQUIRED','PENDING','SUFFICIENT_REFERENCE','INSUFFICIENT','UNKNOWN')),
 reconciliation TEXT COLLATE "C" NOT NULL CHECK(reconciliation IN ('NOT_STARTED','PENDING','MATCHED_REFERENCE','MISMATCH','UNKNOWN')),
 causal_id TEXT COLLATE "C" NOT NULL,
 observed_at_ms BIGINT NOT NULL CHECK(observed_at_ms>=0),
 episode_id TEXT COLLATE "C",
 layer_index BIGINT,
 audit_seq BIGINT,
 content_bytes BYTEA NOT NULL,
 content_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(content_sha256)=64),
 PRIMARY KEY(scope_id,plan_id,revision,seq),
 UNIQUE(scope_id,request_key),
 UNIQUE(scope_id,plan_id,revision,content_sha256),
 CHECK((seq=1 AND previous_sha256 IS NULL) OR (seq>1 AND length(previous_sha256)=64)),
 CHECK(layer_index IS NULL OR episode_id IS NOT NULL)
);
CREATE TABLE astarter_settlements (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 account_id TEXT COLLATE "C" NOT NULL ,
 economic_id TEXT COLLATE "C" NOT NULL CHECK(length(economic_id)=64),
 fact_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(fact_sha256)=64),
 profit_increment TEXT COLLATE "C" NOT NULL,
 new_lock TEXT COLLATE "C" NOT NULL,
 evidence_bytes BYTEA NOT NULL CHECK(TRUE),
 PRIMARY KEY(account_id,economic_id)
);
CREATE TABLE astarter_strategy_scopes (
 scope_id TEXT COLLATE "C" PRIMARY KEY CHECK(length(scope_id)=64),
 tenant_id TEXT COLLATE "C" NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 128),
 account_id TEXT COLLATE "C" NOT NULL UNIQUE ,
 environment TEXT COLLATE "C" NOT NULL CHECK(environment IN ('OFFLINE','PAPER','LIVE')),
 venue_session TEXT COLLATE "C" NOT NULL CHECK(length(venue_session)=36),
 authority_ref TEXT COLLATE "C" NOT NULL CHECK(length(authority_ref) BETWEEN 1 AND 128),
 content_bytes BYTEA NOT NULL,
 content_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(content_sha256)=64),
 UNIQUE(tenant_id,account_id,environment),
 UNIQUE(scope_id,account_id)
);
CREATE TABLE astarter_strategy_versions (
 scope_id TEXT COLLATE "C" NOT NULL ,
 strategy_id TEXT COLLATE "C" NOT NULL CHECK(length(strategy_id) BETWEEN 1 AND 128),
 kind TEXT COLLATE "C" NOT NULL CHECK(kind IN ('S03_ORIGINAL','ASTARTER_COMPOSITION','RESEARCH','VP')),
 version TEXT COLLATE "C" NOT NULL CHECK(length(version) BETWEEN 1 AND 128),
 profile_revision TEXT COLLATE "C" NOT NULL CHECK(length(profile_revision) BETWEEN 1 AND 128),
 parameter_revision TEXT COLLATE "C" NOT NULL CHECK(length(parameter_revision) BETWEEN 1 AND 128),
 content_bytes BYTEA NOT NULL,
 content_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(content_sha256)=64),
 PRIMARY KEY(scope_id,strategy_id,kind,version,profile_revision,parameter_revision),
 UNIQUE(scope_id,content_sha256)
);
CREATE TABLE audit_intents (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 run_id TEXT COLLATE "C" NOT NULL,
 audit_seq BIGINT NOT NULL
        CHECK (TRUE AND audit_seq >= 1),
 event_seq BIGINT NOT NULL
        CHECK (TRUE AND event_seq >= 1),
 event_digest TEXT COLLATE "C" NOT NULL
        CHECK (length(event_digest) = 64 AND event_digest !~ '[^0-9a-f]'),
 intent_bytes BYTEA NOT NULL
        CHECK (TRUE),
 created_at_ns BIGINT NOT NULL
        CHECK (TRUE AND created_at_ns >= 0),
 PRIMARY KEY (run_id, audit_seq),
 UNIQUE (run_id, event_seq),
 UNIQUE (run_id, audit_seq, event_seq)
);
CREATE TABLE catalog_audit_intents (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 catalog_revision TEXT COLLATE "C" PRIMARY KEY
        ,
 intent_bytes BYTEA NOT NULL
        CHECK (TRUE),
 created_at_ns BIGINT NOT NULL
        CHECK (TRUE AND created_at_ns >= 0)
);
CREATE TABLE catalog_publications (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 catalog_revision TEXT COLLATE "C" PRIMARY KEY
        CHECK (TRUE AND length(catalog_revision) > 0),
 fixture_id TEXT COLLATE "C" NOT NULL
        CHECK (TRUE AND length(fixture_id) > 0),
 status TEXT COLLATE "C" NOT NULL
        CHECK (status IN ('PREPARED', 'PUBLISHED', 'INTEGRITY_FAILED')),
 inventory_hash TEXT COLLATE "C" NOT NULL
        CHECK (
            length(inventory_hash) = 64
            AND inventory_hash !~ '[^0-9a-f]'
        ),
 publication_bytes BYTEA NOT NULL
        CHECK (TRUE),
 staging_identity TEXT COLLATE "C" NOT NULL UNIQUE
        CHECK (TRUE AND length(staging_identity) > 0),
 prepared_at_ns BIGINT NOT NULL
        CHECK (TRUE AND prepared_at_ns >= 0),
 published_at_ns BIGINT
        CHECK (
            published_at_ns IS NULL
            OR (TRUE AND published_at_ns >= 0)
        ),
 UNIQUE (catalog_revision, inventory_hash),
 CHECK (
        (status = 'PREPARED' AND published_at_ns IS NULL)
        OR (status IN ('PUBLISHED', 'INTEGRITY_FAILED') AND published_at_ns IS NOT NULL)
    )
);
CREATE TABLE events (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 event_id TEXT COLLATE "C" NOT NULL UNIQUE
        CHECK (TRUE AND length(event_id) > 0),
 run_id TEXT COLLATE "C" NOT NULL ,
 seq BIGINT NOT NULL
        CHECK (TRUE AND seq >= 1),
 source_seq BIGINT NOT NULL
        CHECK (TRUE AND source_seq >= 0),
 source TEXT COLLATE "C" NOT NULL
        CHECK (source IN ('control-api', 'runner')),
 type TEXT COLLATE "C" NOT NULL
        CHECK (type IN (
            'preflight.passed',
            'preflight.blocked',
            'run.queued',
            'run.started',
            'run.cancel_requested',
            'run.cancel_pending',
            'run.finalizing',
            'report.generated',
            'run.completed',
            'run.failed',
            'run.cancelled',
            'run.progress',
            'order.submitted',
            'order.accepted',
            'order.rejected',
            'order.partially_filled',
            'order.filled',
            'order.cancel_pending',
            'order.cancelled',
            'position.opened',
            'position.changed',
            'position.closed',
            'risk.rejected'
        )),
 writer TEXT COLLATE "C" NOT NULL
        CHECK (writer = 'control-api'),
 schema_version BIGINT NOT NULL
        CHECK (TRUE AND schema_version = 1),
 ts_event_ns TEXT COLLATE "C" NOT NULL
        CHECK (
            length(ts_event_ns) > 0
            AND ts_event_ns !~ '[^0-9]'
            AND (ts_event_ns = '0' OR substr(ts_event_ns, 1, 1) <> '0')
        ),
 ts_ingest_ns TEXT COLLATE "C" NOT NULL
        CHECK (
            length(ts_ingest_ns) > 0
            AND ts_ingest_ns !~ '[^0-9]'
            AND (ts_ingest_ns = '0' OR substr(ts_ingest_ns, 1, 1) <> '0')
        ),
 visible BIGINT NOT NULL DEFAULT 1
        CHECK (TRUE AND visible IN (0, 1)),
 envelope_bytes BYTEA NOT NULL
        CHECK (TRUE),
 PRIMARY KEY (run_id, seq),
 UNIQUE (run_id, source, source_seq),
 CHECK (
        (
            source = 'control-api'
            AND type IN (
                'preflight.passed',
                'preflight.blocked',
                'run.queued',
                'run.started',
                'run.cancel_requested',
                'run.cancel_pending',
                'run.finalizing',
                'report.generated',
                'run.completed',
                'run.failed',
                'run.cancelled'
            )
        )
        OR (
            source = 'runner'
            AND type IN (
                'run.progress',
                'order.submitted',
                'order.accepted',
                'order.rejected',
                'order.partially_filled',
                'order.filled',
                'order.cancel_pending',
                'order.cancelled',
                'position.opened',
                'position.changed',
                'position.closed',
                'risk.rejected'
            )
        )
    ),
 CHECK (visible = 1 OR type IN ('run.completed', 'run.failed', 'run.cancelled'))
);
CREATE TABLE finalization_faults (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 run_id TEXT COLLATE "C" PRIMARY KEY ,
 fault_bytes BYTEA NOT NULL
        CHECK (TRUE),
 fault_hash TEXT COLLATE "C" NOT NULL
        CHECK (length(fault_hash) = 64 AND fault_hash !~ '[^0-9a-f]'),
 recorded_at_ns BIGINT NOT NULL
        CHECK (TRUE AND recorded_at_ns >= 0)
);
CREATE TABLE historical_preflights (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 preflight_id TEXT COLLATE "C" PRIMARY KEY CHECK (length(preflight_id) = 36),
 run_id TEXT COLLATE "C" NOT NULL UNIQUE ,
 configuration_id TEXT COLLATE "C" NOT NULL ,
 request_bytes BYTEA NOT NULL,
 request_hash TEXT COLLATE "C" NOT NULL CHECK (length(request_hash)=64 AND request_hash !~ '[^0-9a-f]'),
 result_bytes BYTEA NOT NULL,
 catalog_publication_bytes BYTEA NOT NULL,
 risk_sha256 TEXT COLLATE "C" NOT NULL CHECK (length(risk_sha256)=64 AND risk_sha256 !~ '[^0-9a-f]'),
 runtime_sha256 TEXT COLLATE "C" NOT NULL CHECK (length(runtime_sha256)=64 AND runtime_sha256 !~ '[^0-9a-f]'),
 account_id TEXT COLLATE "C" NOT NULL CHECK (account_id='SIM-001'),
 checked_at_ns BIGINT NOT NULL CHECK (checked_at_ns > 0),
 expires_at_ns BIGINT NOT NULL CHECK (expires_at_ns > checked_at_ns),
 consumed_at_ns BIGINT CHECK (
        consumed_at_ns IS NULL OR
        (consumed_at_ns >= checked_at_ns AND consumed_at_ns < expires_at_ns)
    )
);
CREATE TABLE historical_terminal_anchors (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 run_id TEXT COLLATE "C" PRIMARY KEY ,
 anchor_bytes BYTEA NOT NULL,
 anchor_hash TEXT COLLATE "C" NOT NULL CHECK (length(anchor_hash)=64 AND anchor_hash !~ '[^0-9a-f]'),
 event_digest TEXT COLLATE "C" NOT NULL CHECK (length(event_digest)=64 AND event_digest !~ '[^0-9a-f]')
);
CREATE TABLE idempotency_records (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 idempotency_scope TEXT COLLATE "C" NOT NULL
        CHECK (
            idempotency_scope IN ('backtest.preflight', 'backtest.create', 'historical.preflight', 'historical.create')
            OR (
                substr(idempotency_scope, 1, 16) = 'backtest.cancel/'
                AND length(idempotency_scope) > 16
            )
        ),
 idempotency_key TEXT COLLATE "C" NOT NULL
        CHECK (TRUE AND length(idempotency_key) > 0),
 request_hash TEXT COLLATE "C" NOT NULL
        CHECK (length(request_hash) = 64 AND request_hash !~ '[^0-9a-f]'),
 request_body BYTEA NOT NULL
        CHECK (TRUE),
 response_status BIGINT NOT NULL
        CHECK (
            TRUE
            AND response_status BETWEEN 100 AND 599
        ),
 response_body BYTEA NOT NULL
        CHECK (TRUE),
 target_run_id TEXT COLLATE "C"
        CHECK (
            target_run_id IS NULL
            OR (TRUE AND length(target_run_id) > 0)
        ),
 run_id TEXT COLLATE "C" ,
 created_at_ns BIGINT NOT NULL
        CHECK (TRUE AND created_at_ns >= 0),
 PRIMARY KEY (idempotency_scope, idempotency_key),
 CHECK (
        (
            idempotency_scope IN ('backtest.preflight', 'backtest.create', 'historical.preflight', 'historical.create')
            AND target_run_id IS NULL
        )
        OR (
            target_run_id IS NOT NULL
            AND idempotency_scope = 'backtest.cancel/' || target_run_id
        )
    ),
 CHECK (target_run_id IS NULL OR run_id IS NULL OR run_id = target_run_id),
 CHECK (
        target_run_id IS NULL
        OR response_status NOT BETWEEN 200 AND 299
        OR (run_id IS NOT NULL AND run_id = target_run_id)
    )
);
CREATE TABLE outbox (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 run_id TEXT COLLATE "C" NOT NULL,
 seq BIGINT NOT NULL
        CHECK (TRUE AND seq >= 1),
 audit_seq BIGINT NOT NULL
        CHECK (TRUE AND audit_seq >= 1),
 materialized BIGINT NOT NULL DEFAULT 0
        CHECK (TRUE AND materialized IN (0, 1)),
 materialized_at_ns BIGINT
        CHECK (
            materialized_at_ns IS NULL
            OR (TRUE AND materialized_at_ns >= 0)
        ),
 PRIMARY KEY (run_id, seq),
 UNIQUE (run_id, audit_seq),
 CHECK (
        (materialized = 0 AND materialized_at_ns IS NULL)
        OR (materialized = 1 AND materialized_at_ns IS NOT NULL)
    )
);
CREATE TABLE preflight_configuration_bindings (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 preflight_id TEXT COLLATE "C" PRIMARY KEY
        ,
 run_id TEXT COLLATE "C" NOT NULL UNIQUE
        ,
 configuration_id TEXT COLLATE "C" NOT NULL
        ,
 configuration_content_sha256 TEXT COLLATE "C" NOT NULL
        CHECK (
            length(configuration_content_sha256) = 64
            AND configuration_content_sha256 !~ '[^0-9a-f]'
        ),
 created_at_ns BIGINT NOT NULL
        CHECK (
            TRUE
            AND created_at_ns >= 1000000000000000000
        )
);
CREATE TABLE preflights (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 preflight_id TEXT COLLATE "C" PRIMARY KEY
        CHECK (TRUE AND length(preflight_id) > 0),
 run_id TEXT COLLATE "C" NOT NULL UNIQUE
        ,
 status TEXT COLLATE "C" NOT NULL
        CHECK (status IN ('PREFLIGHT_BLOCKED', 'PREFLIGHT_READY')),
 request_bytes BYTEA NOT NULL
        CHECK (TRUE),
 request_hash TEXT COLLATE "C" NOT NULL
        CHECK (length(request_hash) = 64 AND request_hash !~ '[^0-9a-f]'),
 result_bytes BYTEA NOT NULL
        CHECK (TRUE),
 input_manifest_bytes BYTEA
        CHECK (input_manifest_bytes IS NULL OR TRUE),
 input_manifest_hash TEXT COLLATE "C"
        CHECK (
            input_manifest_hash IS NULL
            OR (length(input_manifest_hash) = 64 AND input_manifest_hash !~ '[^0-9a-f]')
        ),
 catalog_revision TEXT COLLATE "C",
 catalog_inventory_hash TEXT COLLATE "C"
        CHECK (
            catalog_inventory_hash IS NULL
            OR (
                length(catalog_inventory_hash) = 64
                AND catalog_inventory_hash !~ '[^0-9a-f]'
            )
        ),
 engine_package_version TEXT COLLATE "C",
 engine_tag_commit TEXT COLLATE "C",
 risk_policy_hash TEXT COLLATE "C"
        CHECK (
            risk_policy_hash IS NULL
            OR (length(risk_policy_hash) = 64 AND risk_policy_hash !~ '[^0-9a-f]')
        ),
 expires_at_ns BIGINT NOT NULL
        CHECK (TRUE AND expires_at_ns >= 0),
 consumed_at_ns BIGINT
        CHECK (
            consumed_at_ns IS NULL
            OR (TRUE AND consumed_at_ns >= 0)
        ),
 CHECK (
        (
            input_manifest_bytes IS NULL
            AND input_manifest_hash IS NULL
            AND catalog_revision IS NULL
            AND catalog_inventory_hash IS NULL
            AND engine_package_version IS NULL
            AND engine_tag_commit IS NULL
            AND risk_policy_hash IS NULL
        )
        OR (
            input_manifest_bytes IS NOT NULL
            AND input_manifest_hash IS NOT NULL
            AND catalog_revision IS NOT NULL
            AND catalog_inventory_hash IS NOT NULL
            AND engine_package_version IS NOT NULL
            AND engine_tag_commit IS NOT NULL
            AND risk_policy_hash IS NOT NULL
        )
    ),
 CHECK (
        status = 'PREFLIGHT_BLOCKED'
        OR (
            input_manifest_bytes IS NOT NULL
            AND input_manifest_hash IS NOT NULL
            AND catalog_revision IS NOT NULL
            AND catalog_inventory_hash IS NOT NULL
            AND engine_package_version IS NOT NULL
            AND engine_tag_commit IS NOT NULL
            AND risk_policy_hash IS NOT NULL
        )
    )
);
CREATE TABLE runner_outcomes (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 run_id TEXT COLLATE "C" PRIMARY KEY ,
 outcome_bytes BYTEA NOT NULL
        CHECK (TRUE),
 outcome_hash TEXT COLLATE "C" NOT NULL
        CHECK (length(outcome_hash) = 64 AND outcome_hash !~ '[^0-9a-f]'),
 recorded_at_ns BIGINT NOT NULL
        CHECK (TRUE AND recorded_at_ns >= 0)
);
CREATE TABLE runner_processes (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 run_id TEXT COLLATE "C" PRIMARY KEY ,
 spawn_nonce TEXT COLLATE "C" NOT NULL UNIQUE
        CHECK (TRUE AND length(spawn_nonce) > 0),
 pid BIGINT
        CHECK (pid IS NULL OR (TRUE AND pid > 0)),
 process_identity_bytes BYTEA
        CHECK (process_identity_bytes IS NULL OR TRUE),
 launched_at_ns BIGINT
        CHECK (
            launched_at_ns IS NULL
            OR (TRUE AND launched_at_ns >= 0)
        ),
 cancel_phase TEXT COLLATE "C" NOT NULL DEFAULT 'NONE'
        CHECK (cancel_phase IN ('NONE', 'REQUESTED', 'ACKNOWLEDGED', 'TERM_SENT', 'KILL_SENT')),
 CHECK (
        (pid IS NULL AND process_identity_bytes IS NULL AND launched_at_ns IS NULL)
        OR (pid IS NOT NULL AND process_identity_bytes IS NOT NULL AND launched_at_ns IS NOT NULL)
    )
);
CREATE TABLE runs (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 run_id TEXT COLLATE "C" PRIMARY KEY
        CHECK (TRUE AND length(run_id) > 0),
 state TEXT COLLATE "C" NOT NULL DEFAULT 'DRAFT'
        CHECK (state IN (
            'DRAFT',
            'PREFLIGHT_BLOCKED',
            'PREFLIGHT_READY',
            'QUEUED',
            'RUNNING',
            'CANCEL_REQUESTED',
            'CANCEL_PENDING',
            'FINALIZING',
            'COMPLETED',
            'FAILED',
            'CANCELLED'
        )),
 state_version BIGINT NOT NULL DEFAULT 0
        CHECK (TRUE AND state_version >= 0),
 last_event_seq BIGINT NOT NULL DEFAULT 0
        CHECK (TRUE AND last_event_seq >= 0),
 last_audit_seq BIGINT NOT NULL DEFAULT 0
        CHECK (TRUE AND last_audit_seq >= 0),
 control_source_seq BIGINT NOT NULL DEFAULT 0
        CHECK (TRUE AND control_source_seq >= 0),
 runner_source_seq BIGINT
        CHECK (
            runner_source_seq IS NULL
            OR (TRUE AND runner_source_seq >= 0)
        ),
 input_manifest_bytes BYTEA
        CHECK (input_manifest_bytes IS NULL OR TRUE),
 input_manifest_hash TEXT COLLATE "C"
        CHECK (
            input_manifest_hash IS NULL
            OR (
                length(input_manifest_hash) = 64
                AND input_manifest_hash !~ '[^0-9a-f]'
            )
        ),
 catalog_revision TEXT COLLATE "C",
 catalog_inventory_hash TEXT COLLATE "C"
        CHECK (
            catalog_inventory_hash IS NULL
            OR (
                length(catalog_inventory_hash) = 64
                AND catalog_inventory_hash !~ '[^0-9a-f]'
            )
        ),
 created_at_ns BIGINT NOT NULL
        CHECK (TRUE AND created_at_ns >= 0),
 started_at_ns BIGINT
        CHECK (started_at_ns IS NULL OR (TRUE AND started_at_ns >= 0)),
 completed_at_ns BIGINT
        CHECK (
            completed_at_ns IS NULL
            OR (TRUE AND completed_at_ns >= 0)
        ),
 duration_ns BIGINT
        CHECK (duration_ns IS NULL OR (TRUE AND duration_ns >= 0)),
 prepared_terminal_state TEXT COLLATE "C"
        CHECK (prepared_terminal_state IS NULL OR prepared_terminal_state IN ('COMPLETED', 'FAILED', 'CANCELLED')),
 prepared_terminal_state_version BIGINT
        CHECK (
            prepared_terminal_state_version IS NULL
            OR (
                TRUE
                AND prepared_terminal_state_version >= 0
            )
        ),
 prepared_terminal_event_seq BIGINT
        CHECK (
            prepared_terminal_event_seq IS NULL
            OR (TRUE AND prepared_terminal_event_seq >= 1)
        ),
 materialized_event_seq BIGINT NOT NULL DEFAULT 0
        CHECK (TRUE AND materialized_event_seq >= 0),
 materialized_audit_seq BIGINT NOT NULL DEFAULT 0
        CHECK (TRUE AND materialized_audit_seq >= 0),
 evidence_status TEXT COLLATE "C" NOT NULL DEFAULT 'PENDING'
        CHECK (evidence_status IN ('PENDING', 'STAGING', 'PARTIAL', 'VERIFIED', 'UNVERIFIED')),
 contract_kind TEXT COLLATE "C" NOT NULL DEFAULT 'PROBE_V1'
    CHECK (contract_kind IN ('PROBE_V1', 'HISTORICAL_SMA_V2')),
 CHECK (
        (
            input_manifest_bytes IS NULL
            AND input_manifest_hash IS NULL
            AND catalog_revision IS NULL
            AND catalog_inventory_hash IS NULL
        )
        OR (
            input_manifest_bytes IS NOT NULL
            AND input_manifest_hash IS NOT NULL
            AND catalog_revision IS NOT NULL
            AND length(catalog_revision) > 0
            AND catalog_inventory_hash IS NOT NULL
        )
    ),
 CHECK (
        (
            prepared_terminal_state IS NULL
            AND prepared_terminal_state_version IS NULL
            AND prepared_terminal_event_seq IS NULL
        )
        OR (
            prepared_terminal_state IS NOT NULL
            AND prepared_terminal_state_version IS NOT NULL
            AND prepared_terminal_event_seq IS NOT NULL
        )
    ),
 CHECK (materialized_event_seq <= last_event_seq),
 CHECK (materialized_audit_seq <= last_audit_seq)
);
CREATE TABLE seals (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 run_id TEXT COLLATE "C" PRIMARY KEY ,
 seal_digest TEXT COLLATE "C" NOT NULL
        CHECK (length(seal_digest) = 64 AND seal_digest !~ '[^0-9a-f]'),
 terminal_event_seq BIGINT NOT NULL
        CHECK (TRUE AND terminal_event_seq >= 1),
 last_audit_seq BIGINT NOT NULL
        CHECK (TRUE AND last_audit_seq >= 1),
 published_at_ns BIGINT NOT NULL
        CHECK (TRUE AND published_at_ns >= 0)
);
CREATE TABLE strategy_configuration_audit_entries (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 audit_seq BIGINT PRIMARY KEY
        CHECK (TRUE AND audit_seq >= 1),
 action TEXT COLLATE "C" NOT NULL
        CHECK (action IN (
            'strategy_draft.created',
            'strategy_draft.updated',
            'strategy_configuration.published'
        )),
 draft_id TEXT COLLATE "C" NOT NULL
        ,
 configuration_id TEXT COLLATE "C"
        ,
 revision BIGINT NOT NULL
        CHECK (TRUE AND revision >= 1),
 content_sha256 TEXT COLLATE "C" NOT NULL
        CHECK (
            length(content_sha256) = 64
            AND content_sha256 !~ '[^0-9a-f]'
        ),
 entry_bytes BYTEA NOT NULL
        CHECK (TRUE),
 entry_sha256 TEXT COLLATE "C" NOT NULL
        CHECK (
            length(entry_sha256) = 64
            AND entry_sha256 !~ '[^0-9a-f]'
        ),
 created_at_ns BIGINT NOT NULL
        CHECK (
            TRUE
            AND created_at_ns >= 1000000000000000000
        ),
 CHECK (
        (action IN ('strategy_draft.created', 'strategy_draft.updated')
         AND configuration_id IS NULL)
        OR
        (action = 'strategy_configuration.published'
         AND configuration_id IS NOT NULL)
    )
);
CREATE TABLE strategy_configuration_versions (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 configuration_id TEXT COLLATE "C" PRIMARY KEY
        CHECK (
            TRUE
            AND length(configuration_id) = 36
            AND substr(configuration_id, 1, 4) = 'cfg_'
            AND substr(configuration_id, 5) !~ '[^0-9a-f]'
        ),
 draft_id TEXT COLLATE "C" NOT NULL
        ,
 version BIGINT NOT NULL
        CHECK (TRUE AND version >= 1),
 source_revision BIGINT NOT NULL
        CHECK (TRUE AND source_revision >= 1),
 content_bytes BYTEA NOT NULL
        CHECK (TRUE),
 content_sha256 TEXT COLLATE "C" NOT NULL
        CHECK (
            length(content_sha256) = 64
            AND content_sha256 !~ '[^0-9a-f]'
        ),
 created_at_ns BIGINT NOT NULL
        CHECK (
            TRUE
            AND created_at_ns >= 1000000000000000000
        ),
 content_schema TEXT COLLATE "C" NOT NULL
    DEFAULT 'StrategyConfigurationInput.v1'
    CHECK (content_schema IN ('StrategyConfigurationInput.v1', 'StrategyConfigurationInput.v2')),
 UNIQUE (draft_id, version),
 UNIQUE (draft_id, source_revision)
);
CREATE TABLE strategy_drafts (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 draft_id TEXT COLLATE "C" PRIMARY KEY
        CHECK (
            TRUE
            AND length(draft_id) = 35
            AND substr(draft_id, 1, 3) = 'sd_'
            AND substr(draft_id, 4) !~ '[^0-9a-f]'
        ),
 content_bytes BYTEA NOT NULL
        CHECK (TRUE),
 content_sha256 TEXT COLLATE "C" NOT NULL
        CHECK (
            length(content_sha256) = 64
            AND content_sha256 !~ '[^0-9a-f]'
        ),
 revision BIGINT NOT NULL
        CHECK (TRUE AND revision >= 1),
 created_at_ns BIGINT NOT NULL
        CHECK (
            TRUE
            AND created_at_ns >= 1000000000000000000
        ),
 updated_at_ns BIGINT NOT NULL
        CHECK (
            TRUE
            AND updated_at_ns >= created_at_ns
        ),
 content_schema TEXT COLLATE "C" NOT NULL
    DEFAULT 'StrategyConfigurationInput.v1'
    CHECK (content_schema IN ('StrategyConfigurationInput.v1', 'StrategyConfigurationInput.v2'))
);
CREATE TABLE terminal_preparations (
 legacy_rowid BIGINT NOT NULL UNIQUE,
 run_id TEXT COLLATE "C" PRIMARY KEY
        CHECK (TRUE AND length(run_id) > 0),
 runner_outcome_hash TEXT COLLATE "C" NOT NULL
        CHECK (
            length(runner_outcome_hash) = 64
            AND runner_outcome_hash !~ '[^0-9a-f]'
        ),
 terminal_state TEXT COLLATE "C" NOT NULL
        CHECK (terminal_state IN ('COMPLETED', 'FAILED', 'CANCELLED')),
 terminal_state_version BIGINT NOT NULL
        CHECK (TRUE AND terminal_state_version >= 1),
 event_id TEXT COLLATE "C" NOT NULL UNIQUE
        CHECK (TRUE AND length(event_id) > 0),
 event_seq BIGINT NOT NULL
        CHECK (TRUE AND event_seq >= 1),
 event_source_seq BIGINT NOT NULL
        CHECK (TRUE AND event_source_seq >= 1),
 event_source TEXT COLLATE "C" NOT NULL
        CHECK (event_source = 'control-api'),
 event_type TEXT COLLATE "C" NOT NULL
        CHECK (event_type IN ('run.completed', 'run.failed', 'run.cancelled')),
 event_writer TEXT COLLATE "C" NOT NULL
        CHECK (event_writer = 'control-api'),
 event_schema_version BIGINT NOT NULL
        CHECK (TRUE AND event_schema_version = 1),
 event_ts_event_ns TEXT COLLATE "C" NOT NULL
        CHECK (
            length(event_ts_event_ns) > 0
            AND event_ts_event_ns !~ '[^0-9]'
            AND (event_ts_event_ns = '0' OR substr(event_ts_event_ns, 1, 1) <> '0')
        ),
 event_ts_ingest_ns TEXT COLLATE "C" NOT NULL
        CHECK (
            length(event_ts_ingest_ns) > 0
            AND event_ts_ingest_ns !~ '[^0-9]'
            AND (event_ts_ingest_ns = '0' OR substr(event_ts_ingest_ns, 1, 1) <> '0')
        ),
 event_visible BIGINT NOT NULL
        CHECK (TRUE AND event_visible = 0),
 event_envelope_bytes BYTEA NOT NULL
        CHECK (TRUE),
 event_digest TEXT COLLATE "C" NOT NULL
        CHECK (length(event_digest) = 64 AND event_digest !~ '[^0-9a-f]'),
 initial_event_digest TEXT COLLATE "C" NOT NULL
        CHECK (
            length(initial_event_digest) = 64
            AND initial_event_digest !~ '[^0-9a-f]'
        ),
 audit_seq BIGINT NOT NULL
        CHECK (TRUE AND audit_seq >= 1),
 audit_event_digest TEXT COLLATE "C" NOT NULL
        CHECK (
            length(audit_event_digest) = 64
            AND audit_event_digest !~ '[^0-9a-f]'
        ),
 audit_intent_bytes BYTEA NOT NULL
        CHECK (TRUE),
 audit_intent_digest TEXT COLLATE "C" NOT NULL
        CHECK (
            length(audit_intent_digest) = 64
            AND audit_intent_digest !~ '[^0-9a-f]'
        ),
 audit_created_at_ns BIGINT NOT NULL
        CHECK (TRUE AND audit_created_at_ns >= 0),
 prepared_at_ns BIGINT NOT NULL
        CHECK (TRUE AND prepared_at_ns >= 0),
 disposition TEXT COLLATE "C" NOT NULL
        CHECK (disposition IN ('NORMAL', 'FAULT_CONVERTED')),
 failure_attempt_count BIGINT NOT NULL
        CHECK (TRUE AND failure_attempt_count BETWEEN 0 AND 3),
 last_failure_at_ns BIGINT
        CHECK (
            last_failure_at_ns IS NULL
            OR (TRUE AND last_failure_at_ns >= 0)
        ),
 last_failure_stage TEXT COLLATE "C"
        CHECK (
            last_failure_stage IS NULL
            OR last_failure_stage IN (
                'STAGING',
                'REPORTS',
                'RECONCILIATION',
                'MATERIALIZATION',
                'FSYNC',
                'RENAME',
                'SEAL',
                'PUBLICATION'
            )
        ),
 conversion_fault_hash TEXT COLLATE "C"
        CHECK (
            conversion_fault_hash IS NULL
            OR (
                length(conversion_fault_hash) = 64
                AND conversion_fault_hash !~ '[^0-9a-f]'
            )
        ),
 converted_at_ns BIGINT
        CHECK (
            converted_at_ns IS NULL
            OR (TRUE AND converted_at_ns >= 0)
        ),
 CHECK (
        (terminal_state = 'COMPLETED' AND event_type = 'run.completed')
        OR (terminal_state = 'FAILED' AND event_type = 'run.failed')
        OR (terminal_state = 'CANCELLED' AND event_type = 'run.cancelled')
    ),
 CHECK (event_ts_event_ns = event_ts_ingest_ns),
 CHECK (event_ts_ingest_ns = CAST(audit_created_at_ns AS TEXT)),
 CHECK (prepared_at_ns = audit_created_at_ns),
 CHECK (audit_event_digest = event_digest),
 CHECK (
        (
            disposition = 'NORMAL'
            AND failure_attempt_count BETWEEN 0 AND 2
            AND conversion_fault_hash IS NULL
            AND converted_at_ns IS NULL
            AND initial_event_digest = event_digest
            AND (
                (
                    failure_attempt_count = 0
                    AND last_failure_at_ns IS NULL
                    AND last_failure_stage IS NULL
                )
                OR (
                    failure_attempt_count IN (1, 2)
                    AND last_failure_at_ns IS NOT NULL
                    AND last_failure_stage IS NOT NULL
                )
            )
        )
        OR (
            disposition = 'FAULT_CONVERTED'
            AND failure_attempt_count = 3
            AND terminal_state = 'FAILED'
            AND event_type = 'run.failed'
            AND last_failure_at_ns IS NOT NULL
            AND last_failure_stage IS NOT NULL
            AND conversion_fault_hash IS NOT NULL
            AND converted_at_ns IS NOT NULL
        )
    )
);
CREATE INDEX idx_approval_plan ON astarter_approval_references(scope_id,plan_id,revision,reference_id);
CREATE INDEX idx_astarter_intents_account ON astarter_intents(account_id,state);
CREATE INDEX idx_astarter_orders_intent ON astarter_orders(intent_id,role);
CREATE UNIQUE INDEX idx_d2_approval_identity ON astarter_approval_references(scope_id,reference_id,plan_id,revision);
CREATE UNIQUE INDEX idx_d2_episode_identity ON astarter_episode_references(scope_id,episode_id,account_id,binding_id,plan_id,revision);
CREATE UNIQUE INDEX idx_d2_intent_identity ON astarter_intents(intent_id,account_id,binding_id);
CREATE INDEX idx_recovery_episode ON astarter_recovery_checkpoints(scope_id,episode_id,layer_index,seq);
CREATE INDEX idx_runs_active_admission ON runs(state, contract_kind, run_id);
CREATE UNIQUE INDEX uq_events_one_terminal_per_run
ON events(run_id)
WHERE type IN ('run.completed', 'run.failed', 'run.cancelled');
CREATE UNIQUE INDEX uq_finalization_faults_run_hash
ON finalization_faults (run_id, fault_hash);
CREATE UNIQUE INDEX uq_runner_outcomes_run_hash
ON runner_outcomes (run_id, outcome_hash);
CREATE UNIQUE INDEX uq_runs_prepared_terminal_identity
ON runs (
    run_id,
    prepared_terminal_state,
    prepared_terminal_state_version,
    prepared_terminal_event_seq
);

-- PG1 POST-LOAD CONSTRAINTS AND GUARDS
ALTER TABLE astarter_admission_heads ADD FOREIGN KEY(scope_id,account_id) REFERENCES astarter_strategy_scopes(scope_id,account_id);ALTER TABLE astarter_admission_heads ADD FOREIGN KEY(admission_id,account_id,generation) REFERENCES astarter_admissions(admission_id,account_id,generation);ALTER TABLE astarter_admissions ADD FOREIGN KEY (account_id) REFERENCES astarter_admission_heads(account_id);ALTER TABLE astarter_admissions ADD FOREIGN KEY(scope_id,account_id) REFERENCES astarter_strategy_scopes(scope_id,account_id);ALTER TABLE astarter_admissions ADD FOREIGN KEY(binding_id,account_id) REFERENCES astarter_bindings(binding_id,account_id);ALTER TABLE astarter_admissions ADD FOREIGN KEY(scope_id,episode_id,account_id,binding_id,plan_id,revision) REFERENCES astarter_episode_references(scope_id,episode_id,account_id,binding_id,plan_id,revision);ALTER TABLE astarter_admissions ADD FOREIGN KEY(scope_id,approval_id,plan_id,revision) REFERENCES astarter_approval_references(scope_id,reference_id,plan_id,revision);ALTER TABLE astarter_approval_references ADD FOREIGN KEY(scope_id,plan_id,revision,plan_sha256) REFERENCES astarter_plan_versions(scope_id,plan_id,revision,plan_sha256);ALTER TABLE astarter_audit ADD FOREIGN KEY (account_id) REFERENCES astarter_accounts(account_id);ALTER TABLE astarter_bindings ADD FOREIGN KEY (account_id) REFERENCES astarter_accounts(account_id);ALTER TABLE astarter_episode_references ADD FOREIGN KEY(scope_id,account_id) REFERENCES astarter_strategy_scopes(scope_id,account_id);ALTER TABLE astarter_episode_references ADD FOREIGN KEY(scope_id,plan_id,revision,plan_sha256) REFERENCES astarter_plan_versions(scope_id,plan_id,revision,plan_sha256);ALTER TABLE astarter_episode_references ADD FOREIGN KEY(binding_id,account_id) REFERENCES astarter_bindings(binding_id,account_id);ALTER TABLE astarter_fills ADD FOREIGN KEY(order_id,account_id) REFERENCES astarter_orders(order_id,account_id);ALTER TABLE astarter_intent_admissions ADD FOREIGN KEY(intent_id,account_id,binding_id) REFERENCES astarter_intents(intent_id,account_id,binding_id);ALTER TABLE astarter_intent_admissions ADD FOREIGN KEY(admission_id,account_id,binding_id) REFERENCES astarter_admissions(admission_id,account_id,binding_id);ALTER TABLE astarter_intents ADD FOREIGN KEY (account_id) REFERENCES astarter_accounts(account_id);ALTER TABLE astarter_intents ADD FOREIGN KEY(binding_id,account_id) REFERENCES astarter_bindings(binding_id,account_id);ALTER TABLE astarter_layer_references ADD FOREIGN KEY(scope_id,episode_id) REFERENCES astarter_episode_references(scope_id,episode_id);ALTER TABLE astarter_limits ADD FOREIGN KEY (account_id) REFERENCES astarter_accounts(account_id);ALTER TABLE astarter_orders ADD FOREIGN KEY (account_id) REFERENCES astarter_accounts(account_id);ALTER TABLE astarter_orders ADD FOREIGN KEY(intent_id,account_id) REFERENCES astarter_intents(intent_id,account_id);ALTER TABLE astarter_plan_versions ADD FOREIGN KEY (scope_id) REFERENCES astarter_strategy_scopes(scope_id);ALTER TABLE astarter_plan_versions ADD FOREIGN KEY(scope_id,spec_sha256) REFERENCES astarter_strategy_versions(scope_id,content_sha256);ALTER TABLE astarter_plan_versions ADD FOREIGN KEY(scope_id,plan_id,previous_revision) REFERENCES astarter_plan_versions(scope_id,plan_id,revision);ALTER TABLE astarter_recovery_checkpoints ADD FOREIGN KEY(scope_id,account_id) REFERENCES astarter_strategy_scopes(scope_id,account_id);ALTER TABLE astarter_recovery_checkpoints ADD FOREIGN KEY(scope_id,plan_id,revision,plan_sha256) REFERENCES astarter_plan_versions(scope_id,plan_id,revision,plan_sha256);ALTER TABLE astarter_recovery_checkpoints ADD FOREIGN KEY(scope_id,plan_id,revision,previous_sha256) REFERENCES astarter_recovery_checkpoints(scope_id,plan_id,revision,content_sha256);ALTER TABLE astarter_recovery_checkpoints ADD FOREIGN KEY(scope_id,episode_id,plan_id,revision) REFERENCES astarter_episode_references(scope_id,episode_id,plan_id,revision);ALTER TABLE astarter_recovery_checkpoints ADD FOREIGN KEY(scope_id,episode_id,layer_index) REFERENCES astarter_layer_references(scope_id,episode_id,layer_index);ALTER TABLE astarter_recovery_checkpoints ADD FOREIGN KEY(account_id,audit_seq) REFERENCES astarter_audit(account_id,seq);ALTER TABLE astarter_settlements ADD FOREIGN KEY (account_id) REFERENCES astarter_accounts(account_id);ALTER TABLE astarter_strategy_scopes ADD FOREIGN KEY (account_id) REFERENCES astarter_accounts(account_id);ALTER TABLE astarter_strategy_versions ADD FOREIGN KEY (scope_id) REFERENCES astarter_strategy_scopes(scope_id);ALTER TABLE audit_intents ADD FOREIGN KEY (run_id, event_seq)
        REFERENCES events(run_id, seq) ON DELETE RESTRICT;ALTER TABLE catalog_audit_intents ADD FOREIGN KEY (catalog_revision) REFERENCES catalog_publications(catalog_revision) ON DELETE RESTRICT;ALTER TABLE events ADD FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT;ALTER TABLE finalization_faults ADD FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT;ALTER TABLE historical_preflights ADD FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT;ALTER TABLE historical_preflights ADD FOREIGN KEY (configuration_id) REFERENCES strategy_configuration_versions(configuration_id);ALTER TABLE historical_terminal_anchors ADD FOREIGN KEY (run_id) REFERENCES terminal_preparations(run_id);ALTER TABLE idempotency_records ADD FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT;ALTER TABLE outbox ADD FOREIGN KEY (run_id, seq)
        REFERENCES events(run_id, seq) ON DELETE RESTRICT;ALTER TABLE outbox ADD FOREIGN KEY (run_id, audit_seq, seq)
        REFERENCES audit_intents(run_id, audit_seq, event_seq) ON DELETE RESTRICT;ALTER TABLE preflight_configuration_bindings ADD FOREIGN KEY (preflight_id) REFERENCES preflights(preflight_id) ON DELETE RESTRICT;ALTER TABLE preflight_configuration_bindings ADD FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT;ALTER TABLE preflight_configuration_bindings ADD FOREIGN KEY (configuration_id) REFERENCES strategy_configuration_versions(configuration_id) ON DELETE RESTRICT;ALTER TABLE preflights ADD FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT;ALTER TABLE preflights ADD FOREIGN KEY (catalog_revision, catalog_inventory_hash)
        REFERENCES catalog_publications(catalog_revision, inventory_hash) ON DELETE RESTRICT;ALTER TABLE runner_outcomes ADD FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT;ALTER TABLE runner_processes ADD FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT;ALTER TABLE runs ADD FOREIGN KEY (catalog_revision, catalog_inventory_hash)
        REFERENCES catalog_publications(catalog_revision, inventory_hash) ON DELETE RESTRICT;ALTER TABLE seals ADD FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT;ALTER TABLE seals ADD FOREIGN KEY (run_id, terminal_event_seq)
        REFERENCES events(run_id, seq) ON DELETE RESTRICT;ALTER TABLE seals ADD FOREIGN KEY (run_id, last_audit_seq, terminal_event_seq)
        REFERENCES audit_intents(run_id, audit_seq, event_seq) ON DELETE RESTRICT;ALTER TABLE strategy_configuration_audit_entries ADD FOREIGN KEY (draft_id) REFERENCES strategy_drafts(draft_id) ON DELETE RESTRICT;ALTER TABLE strategy_configuration_audit_entries ADD FOREIGN KEY (configuration_id) REFERENCES strategy_configuration_versions(configuration_id) ON DELETE RESTRICT;ALTER TABLE strategy_configuration_versions ADD FOREIGN KEY (draft_id) REFERENCES strategy_drafts(draft_id) ON DELETE RESTRICT;ALTER TABLE terminal_preparations ADD FOREIGN KEY (run_id, runner_outcome_hash)
        REFERENCES runner_outcomes(run_id, outcome_hash)
        ON UPDATE NO ACTION ON DELETE NO ACTION
        DEFERRABLE INITIALLY DEFERRED;ALTER TABLE terminal_preparations ADD FOREIGN KEY (
        run_id,
        terminal_state,
        terminal_state_version,
        event_seq
    ) REFERENCES runs (
        run_id,
        prepared_terminal_state,
        prepared_terminal_state_version,
        prepared_terminal_event_seq
    ) ON UPDATE NO ACTION ON DELETE NO ACTION
      DEFERRABLE INITIALLY DEFERRED;ALTER TABLE terminal_preparations ADD FOREIGN KEY (run_id, conversion_fault_hash)
        REFERENCES finalization_faults(run_id, fault_hash)
        ON UPDATE NO ACTION ON DELETE NO ACTION
        DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION pg1_require_writer() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 PERFORM 1 FROM pg1_control.pg1_metadata WHERE singleton AND schema_version=1
 AND source_version=8 AND writer_version=1 FOR SHARE;
 IF NOT FOUND OR current_setting('pg1.writer_version', true) IS DISTINCT FROM '1' THEN
  RAISE EXCEPTION USING MESSAGE='PG1_VERSION_MISMATCH', ERRCODE='P0001';
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION pg1_no_truncate() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN RAISE EXCEPTION USING MESSAGE='PG1_RETAINED', ERRCODE='P0001'; END $$;
CREATE FUNCTION pg1_rowid_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NEW.legacy_rowid IS DISTINCT FROM OLD.legacy_rowid THEN
  RAISE EXCEPTION USING MESSAGE='PG1_ROWID_IMMUTABLE', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
-- trg_approval_references_delete
CREATE FUNCTION pg1_guard_000() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_000', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_000 BEFORE DELETE ON astarter_approval_references
FOR EACH ROW EXECUTE FUNCTION pg1_guard_000();
-- trg_approval_references_replace
CREATE FUNCTION pg1_guard_001() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM astarter_approval_references WHERE scope_id=NEW.scope_id AND (reference_id=NEW.reference_id OR request_key=NEW.request_key)) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_001', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_001 BEFORE INSERT ON astarter_approval_references
FOR EACH ROW EXECUTE FUNCTION pg1_guard_001();
-- trg_approval_references_update
CREATE FUNCTION pg1_guard_002() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_002', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_002 BEFORE UPDATE ON astarter_approval_references
FOR EACH ROW EXECUTE FUNCTION pg1_guard_002();
-- trg_astarter_accounts_identity
CREATE FUNCTION pg1_guard_003() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.venue_session IS DISTINCT FROM OLD.venue_session OR NEW.baseline_quote IS DISTINCT FROM OLD.baseline_quote OR NEW.risk_period IS DISTINCT FROM OLD.risk_period OR NEW.lock_fraction IS DISTINCT FROM OLD.lock_fraction THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_003', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_003 BEFORE UPDATE OF account_id,venue_session,baseline_quote,risk_period,lock_fraction ON astarter_accounts
FOR EACH ROW EXECUTE FUNCTION pg1_guard_003();
-- trg_astarter_accounts_no_delete
CREATE FUNCTION pg1_guard_004() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_004', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_004 BEFORE DELETE ON astarter_accounts
FOR EACH ROW EXECUTE FUNCTION pg1_guard_004();
-- trg_astarter_audit_immutable_delete
CREATE FUNCTION pg1_guard_005() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_005', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_005 BEFORE DELETE ON astarter_audit
FOR EACH ROW EXECUTE FUNCTION pg1_guard_005();
-- trg_astarter_audit_immutable_update
CREATE FUNCTION pg1_guard_006() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_006', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_006 BEFORE UPDATE ON astarter_audit
FOR EACH ROW EXECUTE FUNCTION pg1_guard_006();
-- trg_astarter_bindings_identity
CREATE FUNCTION pg1_guard_007() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_007', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_007 BEFORE UPDATE OF binding_id,account_id,component_id,policy_bytes,policy_sha256 ON astarter_bindings
FOR EACH ROW EXECUTE FUNCTION pg1_guard_007();
-- trg_astarter_fills_immutable_delete
CREATE FUNCTION pg1_guard_008() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_008', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_008 BEFORE DELETE ON astarter_fills
FOR EACH ROW EXECUTE FUNCTION pg1_guard_008();
-- trg_astarter_fills_immutable_update
CREATE FUNCTION pg1_guard_009() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_009', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_009 BEFORE UPDATE ON astarter_fills
FOR EACH ROW EXECUTE FUNCTION pg1_guard_009();
-- trg_astarter_intents_identity
CREATE FUNCTION pg1_guard_010() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_010', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_010 BEFORE UPDATE OF intent_id,account_id,binding_id,opportunity_key,request_sha256,receipt_bytes,entry_order_id ON astarter_intents
FOR EACH ROW EXECUTE FUNCTION pg1_guard_010();
-- trg_astarter_orders_identity
CREATE FUNCTION pg1_guard_011() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_011', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_011 BEFORE UPDATE OF order_id,account_id,intent_id,role,quantity,trigger_price,deadline_ns ON astarter_orders
FOR EACH ROW EXECUTE FUNCTION pg1_guard_011();
-- trg_astarter_settlements_immutable_delete
CREATE FUNCTION pg1_guard_012() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_012', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_012 BEFORE DELETE ON astarter_settlements
FOR EACH ROW EXECUTE FUNCTION pg1_guard_012();
-- trg_astarter_settlements_immutable_update
CREATE FUNCTION pg1_guard_013() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_013', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_013 BEFORE UPDATE ON astarter_settlements
FOR EACH ROW EXECUTE FUNCTION pg1_guard_013();
-- trg_audit_terminal_copy_preparation
CREATE FUNCTION pg1_guard_014() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS (
    SELECT 1 FROM terminal_preparations
    WHERE run_id = NEW.run_id AND event_seq = NEW.event_seq
 )
 AND NOT EXISTS (
    SELECT 1
    FROM terminal_preparations AS preparation
    WHERE preparation.run_id = NEW.run_id
      AND preparation.event_seq = NEW.event_seq
      AND preparation.audit_seq = NEW.audit_seq
      AND preparation.audit_event_digest = NEW.event_digest
      AND preparation.audit_intent_bytes IS NOT DISTINCT FROM NEW.intent_bytes
      AND preparation.audit_created_at_ns = NEW.created_at_ns
 ) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_014', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_014 BEFORE INSERT ON audit_intents
FOR EACH ROW EXECUTE FUNCTION pg1_guard_014();
-- trg_d2_admissions_delete
CREATE FUNCTION pg1_guard_015() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_015', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_015 BEFORE DELETE ON astarter_admissions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_015();
-- trg_d2_admissions_replace
CREATE FUNCTION pg1_guard_016() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM astarter_admissions WHERE admission_id=NEW.admission_id OR (account_id=NEW.account_id AND generation=NEW.generation)) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_016', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_016 BEFORE INSERT ON astarter_admissions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_016();
-- trg_d2_admissions_update
CREATE FUNCTION pg1_guard_017() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_017', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_017 BEFORE UPDATE ON astarter_admissions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_017();
-- trg_d2_heads_delete
CREATE FUNCTION pg1_guard_018() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_018', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_018 BEFORE DELETE ON astarter_admission_heads
FOR EACH ROW EXECUTE FUNCTION pg1_guard_018();
-- trg_d2_heads_replace
CREATE FUNCTION pg1_guard_019() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM astarter_admission_heads WHERE account_id=NEW.account_id) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_019', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_019 BEFORE INSERT ON astarter_admission_heads
FOR EACH ROW EXECUTE FUNCTION pg1_guard_019();
-- trg_d2_heads_update
CREATE FUNCTION pg1_guard_020() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NEW.account_id!=OLD.account_id OR NEW.scope_id!=OLD.scope_id OR NEW.purpose!=OLD.purpose OR NEW.authority_id!=OLD.authority_id OR NEW.generation!=OLD.generation+1 THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_020', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_020 BEFORE UPDATE ON astarter_admission_heads
FOR EACH ROW EXECUTE FUNCTION pg1_guard_020();
-- trg_d2_links_delete
CREATE FUNCTION pg1_guard_021() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_021', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_021 BEFORE DELETE ON astarter_intent_admissions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_021();
-- trg_d2_links_replace
CREATE FUNCTION pg1_guard_022() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM astarter_intent_admissions WHERE intent_id=NEW.intent_id) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_022', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_022 BEFORE INSERT ON astarter_intent_admissions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_022();
-- trg_d2_links_update
CREATE FUNCTION pg1_guard_023() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_023', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_023 BEFORE UPDATE ON astarter_intent_admissions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_023();
-- trg_episode_references_delete
CREATE FUNCTION pg1_guard_024() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_024', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_024 BEFORE DELETE ON astarter_episode_references
FOR EACH ROW EXECUTE FUNCTION pg1_guard_024();
-- trg_episode_references_replace
CREATE FUNCTION pg1_guard_025() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM astarter_episode_references WHERE scope_id=NEW.scope_id AND episode_id=NEW.episode_id) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_025', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_025 BEFORE INSERT ON astarter_episode_references
FOR EACH ROW EXECUTE FUNCTION pg1_guard_025();
-- trg_episode_references_update
CREATE FUNCTION pg1_guard_026() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_026', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_026 BEFORE UPDATE ON astarter_episode_references
FOR EACH ROW EXECUTE FUNCTION pg1_guard_026();
-- trg_events_immutable_delete
CREATE FUNCTION pg1_guard_027() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_027', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_027 BEFORE DELETE ON events
FOR EACH ROW EXECUTE FUNCTION pg1_guard_027();
-- trg_events_immutable_update
CREATE FUNCTION pg1_guard_028() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NOT (
    OLD.visible = 0
    AND NEW.visible = 1
    AND OLD.type IN ('run.completed', 'run.failed', 'run.cancelled')
    AND NEW.event_id IS NOT DISTINCT FROM OLD.event_id
    AND NEW.run_id IS NOT DISTINCT FROM OLD.run_id
    AND NEW.seq IS NOT DISTINCT FROM OLD.seq
    AND NEW.source_seq IS NOT DISTINCT FROM OLD.source_seq
    AND NEW.source IS NOT DISTINCT FROM OLD.source
    AND NEW.type IS NOT DISTINCT FROM OLD.type
    AND NEW.writer IS NOT DISTINCT FROM OLD.writer
    AND NEW.schema_version IS NOT DISTINCT FROM OLD.schema_version
    AND NEW.ts_event_ns IS NOT DISTINCT FROM OLD.ts_event_ns
    AND NEW.ts_ingest_ns IS NOT DISTINCT FROM OLD.ts_ingest_ns
    AND NEW.envelope_bytes IS NOT DISTINCT FROM OLD.envelope_bytes
    AND (
        EXISTS (
            SELECT 1
            FROM seals AS seal
            WHERE seal.run_id = OLD.run_id
              AND seal.terminal_event_seq = OLD.seq
        )
        OR (
            OLD.type = 'run.failed'
            AND NOT EXISTS (
                SELECT 1
                FROM seals AS seal
                WHERE seal.run_id = OLD.run_id
            )
            AND EXISTS (
                SELECT 1
                FROM runs AS run
                JOIN finalization_faults AS fault
                  ON fault.run_id = run.run_id
                JOIN audit_intents AS audit
                  ON audit.run_id = run.run_id
                 AND audit.audit_seq = run.last_audit_seq
                 AND audit.event_seq = OLD.seq
                WHERE run.run_id = OLD.run_id
                  AND run.state = 'FINALIZING'
                  AND run.evidence_status = 'UNVERIFIED'
                  AND run.prepared_terminal_state = 'FAILED'
                  AND run.prepared_terminal_state_version = run.state_version + 1
                  AND run.prepared_terminal_event_seq = OLD.seq
                  AND run.last_event_seq = OLD.seq
            )
        )
    )
) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_028', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_028 BEFORE UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION pg1_guard_028();
-- trg_events_no_insert_after_terminal
CREATE FUNCTION pg1_guard_029() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS (
    SELECT 1
    FROM events
    WHERE run_id = NEW.run_id
      AND type IN ('run.completed', 'run.failed', 'run.cancelled')
) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_029', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_029 BEFORE INSERT ON events
FOR EACH ROW EXECUTE FUNCTION pg1_guard_029();
-- trg_events_prepared_boundary
CREATE FUNCTION pg1_guard_030() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NEW.type NOT IN ('run.completed', 'run.failed', 'run.cancelled')
 AND EXISTS (
    SELECT 1
    FROM runs
    WHERE run_id = NEW.run_id
      AND (
          prepared_terminal_state IS NOT NULL
          OR prepared_terminal_state_version IS NOT NULL
          OR prepared_terminal_event_seq IS NOT NULL
      )
 ) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_030', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_030 BEFORE INSERT ON events
FOR EACH ROW EXECUTE FUNCTION pg1_guard_030();
-- trg_events_terminal_copy_preparation
CREATE FUNCTION pg1_guard_031() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NEW.type IN ('run.completed', 'run.failed', 'run.cancelled')
 AND NOT EXISTS (
    SELECT 1
    FROM terminal_preparations AS preparation
    WHERE preparation.run_id = NEW.run_id
      AND preparation.event_id = NEW.event_id
      AND preparation.event_seq = NEW.seq
      AND preparation.event_source_seq = NEW.source_seq
      AND preparation.event_source = NEW.source
      AND preparation.event_type = NEW.type
      AND preparation.event_writer = NEW.writer
      AND preparation.event_schema_version = NEW.schema_version
      AND preparation.event_ts_event_ns = NEW.ts_event_ns
      AND preparation.event_ts_ingest_ns = NEW.ts_ingest_ns
      AND preparation.event_visible = NEW.visible
      AND preparation.event_envelope_bytes IS NOT DISTINCT FROM NEW.envelope_bytes
 ) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_031', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_031 BEFORE INSERT ON events
FOR EACH ROW EXECUTE FUNCTION pg1_guard_031();
-- trg_events_terminal_matches_preparation
CREATE FUNCTION pg1_guard_032() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NEW.type IN ('run.completed', 'run.failed', 'run.cancelled')
 AND NOT EXISTS (
    SELECT 1
    FROM runs
    WHERE run_id = NEW.run_id
      AND state = 'FINALIZING'
      AND prepared_terminal_event_seq = NEW.seq
      AND prepared_terminal_state_version = state_version + 1
      AND last_event_seq = NEW.seq
      AND NEW.visible = 0
      AND (
          (prepared_terminal_state = 'COMPLETED' AND NEW.type = 'run.completed')
          OR (prepared_terminal_state = 'FAILED' AND NEW.type = 'run.failed')
          OR (prepared_terminal_state = 'CANCELLED' AND NEW.type = 'run.cancelled')
      )
 ) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_032', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_032 BEFORE INSERT ON events
FOR EACH ROW EXECUTE FUNCTION pg1_guard_032();
-- trg_events_terminal_visibility_requires_publication
CREATE FUNCTION pg1_guard_033() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF OLD.visible = 0
 AND NEW.visible = 1
 AND OLD.type IN ('run.completed', 'run.failed', 'run.cancelled')
 AND NOT EXISTS (
    SELECT 1
    FROM terminal_preparations AS preparation
    WHERE preparation.run_id = OLD.run_id
      AND preparation.event_seq = OLD.seq
      AND (
          (
              preparation.disposition = 'NORMAL'
              AND EXISTS (
                  SELECT 1 FROM seals AS seal
                  WHERE seal.run_id = preparation.run_id
                    AND seal.terminal_event_seq = preparation.event_seq
                    AND seal.last_audit_seq = preparation.audit_seq
              )
              AND EXISTS (
                  SELECT 1 FROM outbox AS box
                  WHERE box.run_id = preparation.run_id
                    AND box.seq = preparation.event_seq
                    AND box.audit_seq = preparation.audit_seq
                    AND box.materialized = 1
              )
              AND NOT EXISTS (
                  SELECT 1 FROM outbox AS pending
                  WHERE pending.run_id = preparation.run_id
                    AND pending.seq <= preparation.event_seq
                    AND pending.materialized = 0
              )
              AND NOT EXISTS (
                  SELECT 1 FROM finalization_faults AS fault
                  WHERE fault.run_id = preparation.run_id
              )
          )
          OR (
              preparation.disposition = 'FAULT_CONVERTED'
              AND EXISTS (
                  SELECT 1 FROM finalization_faults AS fault
                  WHERE fault.run_id = preparation.run_id
                    AND fault.fault_hash = preparation.conversion_fault_hash
              )
              AND NOT EXISTS (
                  SELECT 1 FROM seals AS seal WHERE seal.run_id = preparation.run_id
              )
              AND EXISTS (
                  SELECT 1 FROM outbox AS box
                  WHERE box.run_id = preparation.run_id
                    AND box.seq = preparation.event_seq
                    AND box.audit_seq = preparation.audit_seq
                    AND box.materialized = 0
              )
          )
      )
 ) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_033', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_033 BEFORE UPDATE OF visible ON events
FOR EACH ROW EXECUTE FUNCTION pg1_guard_033();
-- trg_finalization_faults_bind_converted_preparation
CREATE FUNCTION pg1_guard_034() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NOT EXISTS (
    SELECT 1
    FROM terminal_preparations AS preparation
    WHERE preparation.run_id = NEW.run_id
      AND preparation.disposition = 'FAULT_CONVERTED'
      AND preparation.conversion_fault_hash = NEW.fault_hash
 ) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_034', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_034 BEFORE INSERT ON finalization_faults
FOR EACH ROW EXECUTE FUNCTION pg1_guard_034();
-- trg_finalization_faults_immutable_delete
CREATE FUNCTION pg1_guard_035() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_035', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_035 BEFORE DELETE ON finalization_faults
FOR EACH ROW EXECUTE FUNCTION pg1_guard_035();
-- trg_finalization_faults_immutable_update
CREATE FUNCTION pg1_guard_036() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_036', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_036 BEFORE UPDATE ON finalization_faults
FOR EACH ROW EXECUTE FUNCTION pg1_guard_036();
-- trg_finalization_faults_reject_duplicate_insert
CREATE FUNCTION pg1_guard_037() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS (
    SELECT 1
    FROM finalization_faults
    WHERE run_id = NEW.run_id
) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_037', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_037 BEFORE INSERT ON finalization_faults
FOR EACH ROW EXECUTE FUNCTION pg1_guard_037();
-- trg_finalization_faults_reject_sealed_insert
CREATE FUNCTION pg1_guard_038() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS (
    SELECT 1
    FROM seals
    WHERE run_id = NEW.run_id
) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_038', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_038 BEFORE INSERT ON finalization_faults
FOR EACH ROW EXECUTE FUNCTION pg1_guard_038();
-- trg_finalization_faults_require_finalizing_unverified
CREATE FUNCTION pg1_guard_039() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NOT EXISTS (
    SELECT 1
    FROM seals
    WHERE run_id = NEW.run_id
)
 AND NOT EXISTS (
    SELECT 1
    FROM runs
    WHERE run_id = NEW.run_id
      AND state = 'FINALIZING'
      AND evidence_status = 'UNVERIFIED'
) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_039', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_039 BEFORE INSERT ON finalization_faults
FOR EACH ROW EXECUTE FUNCTION pg1_guard_039();
-- trg_historical_idempotency_parent_kind
CREATE FUNCTION pg1_guard_040() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NEW.idempotency_scope IN ('historical.preflight', 'historical.create') AND (
    NOT EXISTS (SELECT 1 FROM runs WHERE run_id=NEW.run_id AND contract_kind='HISTORICAL_SMA_V2')
    OR NEW.response_status != CASE NEW.idempotency_scope WHEN 'historical.preflight' THEN 200 ELSE 202 END
) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_040', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_040 BEFORE INSERT ON idempotency_records
FOR EACH ROW EXECUTE FUNCTION pg1_guard_040();
-- trg_historical_idempotency_reject_delete
CREATE FUNCTION pg1_guard_041() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF OLD.idempotency_scope IN ('historical.preflight', 'historical.create') THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_041', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_041 BEFORE DELETE ON idempotency_records
FOR EACH ROW EXECUTE FUNCTION pg1_guard_041();
-- trg_historical_idempotency_reject_update
CREATE FUNCTION pg1_guard_042() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF OLD.idempotency_scope IN ('historical.preflight', 'historical.create')
    OR NEW.idempotency_scope IN ('historical.preflight', 'historical.create') THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_042', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_042 BEFORE UPDATE ON idempotency_records
FOR EACH ROW EXECUTE FUNCTION pg1_guard_042();
-- trg_historical_preflights_immutable
CREATE FUNCTION pg1_guard_043() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF OLD.consumed_at_ns IS NOT NULL OR NEW.consumed_at_ns IS NULL
    OR NEW.preflight_id IS DISTINCT FROM OLD.preflight_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.configuration_id IS DISTINCT FROM OLD.configuration_id
    OR NEW.request_bytes IS DISTINCT FROM OLD.request_bytes
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.result_bytes IS DISTINCT FROM OLD.result_bytes
    OR NEW.catalog_publication_bytes IS DISTINCT FROM OLD.catalog_publication_bytes
    OR NEW.risk_sha256 IS DISTINCT FROM OLD.risk_sha256
    OR NEW.runtime_sha256 IS DISTINCT FROM OLD.runtime_sha256
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.checked_at_ns IS DISTINCT FROM OLD.checked_at_ns
    OR NEW.expires_at_ns IS DISTINCT FROM OLD.expires_at_ns THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_043', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_043 BEFORE UPDATE ON historical_preflights
FOR EACH ROW EXECUTE FUNCTION pg1_guard_043();
-- trg_historical_preflights_parent_kind
CREATE FUNCTION pg1_guard_044() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NOT EXISTS (
    SELECT 1 FROM runs WHERE run_id=NEW.run_id AND contract_kind='HISTORICAL_SMA_V2'
) OR NOT EXISTS (
    SELECT 1 FROM strategy_configuration_versions WHERE configuration_id=NEW.configuration_id
    AND content_schema='StrategyConfigurationInput.v2'
) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_044', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_044 BEFORE INSERT ON historical_preflights
FOR EACH ROW EXECUTE FUNCTION pg1_guard_044();
-- trg_historical_preflights_reject_delete
CREATE FUNCTION pg1_guard_045() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_045', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_045 BEFORE DELETE ON historical_preflights
FOR EACH ROW EXECUTE FUNCTION pg1_guard_045();
-- trg_historical_strategy_versions_reject_delete
CREATE FUNCTION pg1_guard_046() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF OLD.content_schema = 'StrategyConfigurationInput.v2' THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_046', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_046 BEFORE DELETE ON strategy_configuration_versions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_046();
-- trg_historical_strategy_versions_reject_update
CREATE FUNCTION pg1_guard_047() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF OLD.content_schema = 'StrategyConfigurationInput.v2' THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_047', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_047 BEFORE UPDATE ON strategy_configuration_versions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_047();
-- trg_historical_terminal_anchors_immutable_delete
CREATE FUNCTION pg1_guard_048() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_048', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_048 BEFORE DELETE ON historical_terminal_anchors
FOR EACH ROW EXECUTE FUNCTION pg1_guard_048();
-- trg_historical_terminal_anchors_immutable_update
CREATE FUNCTION pg1_guard_049() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_049', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_049 BEFORE UPDATE ON historical_terminal_anchors
FOR EACH ROW EXECUTE FUNCTION pg1_guard_049();
-- trg_historical_terminal_anchors_parent
CREATE FUNCTION pg1_guard_050() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NOT EXISTS (
    SELECT 1 FROM runs JOIN terminal_preparations USING (run_id)
    WHERE run_id=NEW.run_id AND contract_kind='HISTORICAL_SMA_V2'
    AND terminal_preparations.event_digest=NEW.event_digest
    AND runs.state='FINALIZING'
) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_050', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_050 BEFORE INSERT ON historical_terminal_anchors
FOR EACH ROW EXECUTE FUNCTION pg1_guard_050();
-- trg_layer_references_delete
CREATE FUNCTION pg1_guard_051() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_051', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_051 BEFORE DELETE ON astarter_layer_references
FOR EACH ROW EXECUTE FUNCTION pg1_guard_051();
-- trg_layer_references_replace
CREATE FUNCTION pg1_guard_052() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM astarter_layer_references WHERE scope_id=NEW.scope_id AND episode_id=NEW.episode_id AND (layer_index=NEW.layer_index OR action_id=NEW.action_id)) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_052', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_052 BEFORE INSERT ON astarter_layer_references
FOR EACH ROW EXECUTE FUNCTION pg1_guard_052();
-- trg_layer_references_update
CREATE FUNCTION pg1_guard_053() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_053', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_053 BEFORE UPDATE ON astarter_layer_references
FOR EACH ROW EXECUTE FUNCTION pg1_guard_053();
-- trg_outbox_terminal_copy_preparation
CREATE FUNCTION pg1_guard_054() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS (
    SELECT 1 FROM terminal_preparations
    WHERE run_id = NEW.run_id AND event_seq = NEW.seq
 )
 AND NOT EXISTS (
    SELECT 1
    FROM terminal_preparations AS preparation
    WHERE preparation.run_id = NEW.run_id
      AND preparation.event_seq = NEW.seq
      AND preparation.audit_seq = NEW.audit_seq
      AND (
          (
              preparation.disposition = 'NORMAL'
              AND NEW.materialized = 1
              AND NEW.materialized_at_ns IS NOT NULL
          )
          OR (
              preparation.disposition = 'FAULT_CONVERTED'
              AND NEW.materialized = 0
              AND NEW.materialized_at_ns IS NULL
          )
      )
 ) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_054', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_054 BEFORE INSERT ON outbox
FOR EACH ROW EXECUTE FUNCTION pg1_guard_054();
-- trg_plan_versions_delete
CREATE FUNCTION pg1_guard_055() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_055', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_055 BEFORE DELETE ON astarter_plan_versions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_055();
-- trg_plan_versions_replace
CREATE FUNCTION pg1_guard_056() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM astarter_plan_versions WHERE scope_id=NEW.scope_id AND
 (request_key=NEW.request_key OR (plan_id=NEW.plan_id AND (revision=NEW.revision OR ordinal=NEW.ordinal)))) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_056', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_056 BEFORE INSERT ON astarter_plan_versions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_056();
-- trg_plan_versions_update
CREATE FUNCTION pg1_guard_057() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_057', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_057 BEFORE UPDATE ON astarter_plan_versions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_057();
-- trg_preflight_configuration_bindings_reject_delete
CREATE FUNCTION pg1_guard_058() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_058', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_058 BEFORE DELETE ON preflight_configuration_bindings
FOR EACH ROW EXECUTE FUNCTION pg1_guard_058();
-- trg_preflight_configuration_bindings_reject_update
CREATE FUNCTION pg1_guard_059() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_059', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_059 BEFORE UPDATE ON preflight_configuration_bindings
FOR EACH ROW EXECUTE FUNCTION pg1_guard_059();
-- trg_recovery_checkpoints_delete
CREATE FUNCTION pg1_guard_060() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_060', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_060 BEFORE DELETE ON astarter_recovery_checkpoints
FOR EACH ROW EXECUTE FUNCTION pg1_guard_060();
-- trg_recovery_checkpoints_replace
CREATE FUNCTION pg1_guard_061() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM astarter_recovery_checkpoints WHERE scope_id=NEW.scope_id AND
 (request_key=NEW.request_key OR (plan_id=NEW.plan_id AND revision=NEW.revision AND (seq=NEW.seq OR content_sha256=NEW.content_sha256)))) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_061', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_061 BEFORE INSERT ON astarter_recovery_checkpoints
FOR EACH ROW EXECUTE FUNCTION pg1_guard_061();
-- trg_recovery_checkpoints_update
CREATE FUNCTION pg1_guard_062() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_062', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_062 BEFORE UPDATE ON astarter_recovery_checkpoints
FOR EACH ROW EXECUTE FUNCTION pg1_guard_062();
-- trg_runs_immutable_contract_kind
CREATE FUNCTION pg1_guard_063() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NEW.contract_kind IS DISTINCT FROM OLD.contract_kind THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_063', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_063 BEFORE UPDATE OF contract_kind ON runs
FOR EACH ROW EXECUTE FUNCTION pg1_guard_063();
-- trg_runs_preserve_unverified_fault_status
CREATE FUNCTION pg1_guard_064() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NEW.evidence_status <> 'UNVERIFIED'
 AND EXISTS (
     SELECT 1
     FROM finalization_faults
     WHERE run_id = NEW.run_id
 ) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_064', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_064 BEFORE UPDATE OF evidence_status ON runs
FOR EACH ROW EXECUTE FUNCTION pg1_guard_064();
-- trg_runs_reject_prepared_insert
CREATE FUNCTION pg1_guard_065() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NEW.prepared_terminal_state IS NOT NULL
 OR NEW.prepared_terminal_state_version IS NOT NULL
 OR NEW.prepared_terminal_event_seq IS NOT NULL THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_065', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_065 BEFORE INSERT ON runs
FOR EACH ROW EXECUTE FUNCTION pg1_guard_065();
-- trg_runs_reject_unverified_seal
CREATE FUNCTION pg1_guard_066() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NEW.evidence_status = 'UNVERIFIED'
 AND EXISTS (
     SELECT 1
     FROM seals
     WHERE run_id = NEW.run_id
 ) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_066', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_066 BEFORE UPDATE OF evidence_status ON runs
FOR EACH ROW EXECUTE FUNCTION pg1_guard_066();
-- trg_runs_validate_prepared_update
CREATE FUNCTION pg1_guard_067() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NOT (
    NEW.prepared_terminal_state IS NOT DISTINCT FROM OLD.prepared_terminal_state
    AND NEW.prepared_terminal_state_version IS NOT DISTINCT FROM OLD.prepared_terminal_state_version
    AND NEW.prepared_terminal_event_seq IS NOT DISTINCT FROM OLD.prepared_terminal_event_seq
 )
 AND NOT EXISTS (
    SELECT 1
    FROM terminal_preparations AS preparation
    WHERE preparation.run_id = NEW.run_id
      AND preparation.terminal_state = NEW.prepared_terminal_state
      AND preparation.terminal_state_version = NEW.prepared_terminal_state_version
      AND preparation.event_seq = NEW.prepared_terminal_event_seq
      AND NEW.state = 'FINALIZING'
      AND (
          (
              OLD.prepared_terminal_state IS NULL
              AND OLD.prepared_terminal_state_version IS NULL
              AND OLD.prepared_terminal_event_seq IS NULL
              AND preparation.disposition = 'NORMAL'
          )
          OR (
              OLD.prepared_terminal_state IS NOT NULL
              AND NEW.prepared_terminal_state = 'FAILED'
              AND NEW.prepared_terminal_state_version IS NOT DISTINCT FROM OLD.prepared_terminal_state_version
              AND NEW.prepared_terminal_event_seq IS NOT DISTINCT FROM OLD.prepared_terminal_event_seq
              AND preparation.disposition = 'FAULT_CONVERTED'
          )
      )
 ) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_067', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_067 BEFORE UPDATE OF prepared_terminal_state, prepared_terminal_state_version,
                 prepared_terminal_event_seq ON runs
FOR EACH ROW EXECUTE FUNCTION pg1_guard_067();
-- trg_runs_validate_terminal_transition
CREATE FUNCTION pg1_guard_068() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NEW.state IN ('COMPLETED', 'FAILED', 'CANCELLED')
 AND OLD.state = 'FINALIZING'
 AND NOT EXISTS (
    SELECT 1
    FROM terminal_preparations AS preparation
    JOIN events AS event
      ON event.run_id = preparation.run_id
     AND event.seq = preparation.event_seq
    JOIN audit_intents AS audit
      ON audit.run_id = preparation.run_id
     AND audit.audit_seq = preparation.audit_seq
     AND audit.event_seq = preparation.event_seq
    JOIN outbox AS box
      ON box.run_id = preparation.run_id
     AND box.seq = preparation.event_seq
     AND box.audit_seq = preparation.audit_seq
    WHERE preparation.run_id = NEW.run_id
      AND NEW.state = preparation.terminal_state
      AND NEW.state_version = preparation.terminal_state_version
      AND NEW.prepared_terminal_state = preparation.terminal_state
      AND NEW.prepared_terminal_state_version = preparation.terminal_state_version
      AND NEW.prepared_terminal_event_seq = preparation.event_seq
      AND NEW.last_event_seq = preparation.event_seq
      AND NEW.last_audit_seq = preparation.audit_seq
      AND NEW.control_source_seq = preparation.event_source_seq
      AND event.visible = 1
      AND audit.event_digest = preparation.audit_event_digest
      AND (
          (
              preparation.disposition = 'NORMAL'
              AND NEW.evidence_status = 'VERIFIED'
              AND NEW.completed_at_ns IS NOT NULL
              AND NEW.duration_ns IS NOT NULL
              AND NEW.materialized_event_seq = preparation.event_seq
              AND NEW.materialized_audit_seq = preparation.audit_seq
              AND box.materialized = 1
              AND EXISTS (
                  SELECT 1 FROM seals AS seal
                  WHERE seal.run_id = preparation.run_id
                    AND seal.terminal_event_seq = preparation.event_seq
                    AND seal.last_audit_seq = preparation.audit_seq
              )
              AND NOT EXISTS (
                  SELECT 1 FROM finalization_faults AS fault
                  WHERE fault.run_id = preparation.run_id
              )
          )
          OR (
              preparation.disposition = 'FAULT_CONVERTED'
              AND NEW.state = 'FAILED'
              AND NEW.evidence_status = 'UNVERIFIED'
              AND NEW.materialized_event_seq < preparation.event_seq
              AND NEW.materialized_audit_seq < preparation.audit_seq
              AND box.materialized = 0
              AND EXISTS (
                  SELECT 1 FROM finalization_faults AS fault
                  WHERE fault.run_id = preparation.run_id
                    AND fault.fault_hash = preparation.conversion_fault_hash
              )
              AND NOT EXISTS (
                  SELECT 1 FROM seals AS seal WHERE seal.run_id = preparation.run_id
              )
          )
      )
 ) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_068', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_068 BEFORE UPDATE OF state ON runs
FOR EACH ROW EXECUTE FUNCTION pg1_guard_068();
-- trg_seals_bind_normal_preparation
CREATE FUNCTION pg1_guard_069() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NOT EXISTS (
    SELECT 1
    FROM terminal_preparations AS preparation
    JOIN events AS event
      ON event.run_id = preparation.run_id
     AND event.seq = preparation.event_seq
    JOIN audit_intents AS audit
      ON audit.run_id = preparation.run_id
     AND audit.audit_seq = preparation.audit_seq
     AND audit.event_seq = preparation.event_seq
    JOIN outbox AS box
      ON box.run_id = preparation.run_id
     AND box.seq = preparation.event_seq
     AND box.audit_seq = preparation.audit_seq
    WHERE preparation.run_id = NEW.run_id
      AND preparation.disposition = 'NORMAL'
      AND preparation.event_seq = NEW.terminal_event_seq
      AND preparation.audit_seq = NEW.last_audit_seq
      AND event.visible = 0
      AND box.materialized = 1
      AND box.materialized_at_ns IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM finalization_faults AS fault
          WHERE fault.run_id = preparation.run_id
      )
 ) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_069', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_069 BEFORE INSERT ON seals
FOR EACH ROW EXECUTE FUNCTION pg1_guard_069();
-- trg_seals_immutable_delete
CREATE FUNCTION pg1_guard_070() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_070', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_070 BEFORE DELETE ON seals
FOR EACH ROW EXECUTE FUNCTION pg1_guard_070();
-- trg_seals_immutable_update
CREATE FUNCTION pg1_guard_071() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_071', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_071 BEFORE UPDATE ON seals
FOR EACH ROW EXECUTE FUNCTION pg1_guard_071();
-- trg_seals_reject_duplicate_insert
CREATE FUNCTION pg1_guard_072() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS (
    SELECT 1
    FROM seals
    WHERE run_id = NEW.run_id
) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_072', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_072 BEFORE INSERT ON seals
FOR EACH ROW EXECUTE FUNCTION pg1_guard_072();
-- trg_seals_validate_terminal_boundary
CREATE FUNCTION pg1_guard_073() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NOT EXISTS (
    SELECT 1
    FROM runs AS run
    JOIN events AS event
      ON event.run_id = run.run_id
     AND event.seq = NEW.terminal_event_seq
    JOIN audit_intents AS audit
      ON audit.run_id = run.run_id
     AND audit.audit_seq = NEW.last_audit_seq
     AND audit.event_seq = NEW.terminal_event_seq
    WHERE run.run_id = NEW.run_id
      AND run.state = 'FINALIZING'
      AND run.evidence_status <> 'UNVERIFIED'
      AND run.prepared_terminal_event_seq = NEW.terminal_event_seq
      AND run.prepared_terminal_state_version = run.state_version + 1
      AND run.last_event_seq = NEW.terminal_event_seq
      AND run.last_audit_seq = NEW.last_audit_seq
      AND event.visible = 0
      AND NOT EXISTS (
          SELECT 1
          FROM finalization_faults AS fault
          WHERE fault.run_id = run.run_id
      )
      AND (
          (run.prepared_terminal_state = 'COMPLETED' AND event.type = 'run.completed')
          OR (run.prepared_terminal_state = 'FAILED' AND event.type = 'run.failed')
          OR (run.prepared_terminal_state = 'CANCELLED' AND event.type = 'run.cancelled')
      )
) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_073', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_073 BEFORE INSERT ON seals
FOR EACH ROW EXECUTE FUNCTION pg1_guard_073();
-- trg_strategy_configuration_audit_entries_reject_delete
CREATE FUNCTION pg1_guard_074() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_074', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_074 BEFORE DELETE ON strategy_configuration_audit_entries
FOR EACH ROW EXECUTE FUNCTION pg1_guard_074();
-- trg_strategy_configuration_audit_entries_reject_update
CREATE FUNCTION pg1_guard_075() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_075', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_075 BEFORE UPDATE ON strategy_configuration_audit_entries
FOR EACH ROW EXECUTE FUNCTION pg1_guard_075();
-- trg_strategy_drafts_immutable_kind
CREATE FUNCTION pg1_guard_076() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NEW.content_schema != OLD.content_schema THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_076', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_076 BEFORE UPDATE OF content_schema ON strategy_drafts
FOR EACH ROW EXECUTE FUNCTION pg1_guard_076();
-- trg_strategy_scope_account
CREATE FUNCTION pg1_guard_077() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM astarter_accounts WHERE account_id=NEW.account_id AND venue_session=NEW.venue_session) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_077', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_077 BEFORE INSERT ON astarter_strategy_scopes
FOR EACH ROW EXECUTE FUNCTION pg1_guard_077();
-- trg_strategy_scopes_delete
CREATE FUNCTION pg1_guard_078() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_078', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_078 BEFORE DELETE ON astarter_strategy_scopes
FOR EACH ROW EXECUTE FUNCTION pg1_guard_078();
-- trg_strategy_scopes_replace
CREATE FUNCTION pg1_guard_079() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM astarter_strategy_scopes WHERE scope_id=NEW.scope_id OR account_id=NEW.account_id) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_079', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_079 BEFORE INSERT ON astarter_strategy_scopes
FOR EACH ROW EXECUTE FUNCTION pg1_guard_079();
-- trg_strategy_scopes_update
CREATE FUNCTION pg1_guard_080() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_080', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_080 BEFORE UPDATE ON astarter_strategy_scopes
FOR EACH ROW EXECUTE FUNCTION pg1_guard_080();
-- trg_strategy_versions_delete
CREATE FUNCTION pg1_guard_081() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_081', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_081 BEFORE DELETE ON astarter_strategy_versions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_081();
-- trg_strategy_versions_immutable_kind
CREATE FUNCTION pg1_guard_082() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NEW.content_schema != OLD.content_schema THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_082', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_082 BEFORE UPDATE OF content_schema ON strategy_configuration_versions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_082();
-- trg_strategy_versions_parent_kind_insert
CREATE FUNCTION pg1_guard_083() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NOT EXISTS (
    SELECT 1 FROM strategy_drafts
    WHERE draft_id = NEW.draft_id AND content_schema = NEW.content_schema
) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_083', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_083 BEFORE INSERT ON strategy_configuration_versions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_083();
-- trg_strategy_versions_parent_kind_update
CREATE FUNCTION pg1_guard_084() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NOT EXISTS (
    SELECT 1 FROM strategy_drafts
    WHERE draft_id = NEW.draft_id AND content_schema = NEW.content_schema
) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_084', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_084 BEFORE UPDATE ON strategy_configuration_versions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_084();
-- trg_strategy_versions_replace
CREATE FUNCTION pg1_guard_085() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM astarter_strategy_versions WHERE scope_id=NEW.scope_id AND
 (content_sha256=NEW.content_sha256 OR (strategy_id=NEW.strategy_id AND kind=NEW.kind AND version=NEW.version AND profile_revision=NEW.profile_revision AND parameter_revision=NEW.parameter_revision))) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_085', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_085 BEFORE INSERT ON astarter_strategy_versions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_085();
-- trg_strategy_versions_update
CREATE FUNCTION pg1_guard_086() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_086', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_086 BEFORE UPDATE ON astarter_strategy_versions
FOR EACH ROW EXECUTE FUNCTION pg1_guard_086();
-- trg_terminal_preparations_reject_delete
CREATE FUNCTION pg1_guard_087() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF TRUE THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_087', ERRCODE='P0001';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER pg1_guard_087 BEFORE DELETE ON terminal_preparations
FOR EACH ROW EXECUTE FUNCTION pg1_guard_087();
-- trg_terminal_preparations_validate_insert
CREATE FUNCTION pg1_guard_088() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF NEW.disposition <> 'NORMAL'
 OR NEW.failure_attempt_count <> 0
 OR NOT EXISTS (
    SELECT 1
    FROM runs AS run
    JOIN runner_outcomes AS outcome
      ON outcome.run_id = run.run_id
     AND outcome.outcome_hash = NEW.runner_outcome_hash
    WHERE run.run_id = NEW.run_id
      AND run.state = 'FINALIZING'
      AND run.prepared_terminal_state IS NULL
      AND run.prepared_terminal_state_version IS NULL
      AND run.prepared_terminal_event_seq IS NULL
      AND NEW.terminal_state_version = run.state_version + 1
      AND NEW.event_seq = run.last_event_seq + 1
      AND NEW.event_source_seq = run.control_source_seq + 1
      AND NEW.audit_seq = run.last_audit_seq + 1
      AND NOT EXISTS (
          SELECT 1 FROM events AS event
          WHERE event.run_id = run.run_id
            AND event.type IN ('run.completed', 'run.failed', 'run.cancelled')
      )
      AND NOT EXISTS (SELECT 1 FROM seals AS seal WHERE seal.run_id = run.run_id)
      AND NOT EXISTS (
          SELECT 1 FROM finalization_faults AS fault WHERE fault.run_id = run.run_id
      )
 ) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_088', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_088 BEFORE INSERT ON terminal_preparations
FOR EACH ROW EXECUTE FUNCTION pg1_guard_088();
-- trg_terminal_preparations_validate_update
CREATE FUNCTION pg1_guard_089() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg1_control, pg_temp AS $$
BEGIN
 IF EXISTS (
    SELECT 1 FROM events
    WHERE run_id = OLD.run_id
      AND type IN ('run.completed', 'run.failed', 'run.cancelled')
 )
 OR EXISTS (SELECT 1 FROM seals WHERE run_id = OLD.run_id)
 OR EXISTS (SELECT 1 FROM finalization_faults WHERE run_id = OLD.run_id)
 OR NOT (
    (
        OLD.disposition = 'NORMAL'
        AND NEW.disposition = 'NORMAL'
        AND OLD.failure_attempt_count IN (0, 1)
        AND NEW.failure_attempt_count = OLD.failure_attempt_count + 1
        AND NEW.last_failure_at_ns > COALESCE(OLD.last_failure_at_ns, OLD.prepared_at_ns)
        AND NEW.last_failure_stage IS NOT NULL
        AND NEW.run_id IS NOT DISTINCT FROM OLD.run_id
        AND NEW.runner_outcome_hash IS NOT DISTINCT FROM OLD.runner_outcome_hash
        AND NEW.terminal_state IS NOT DISTINCT FROM OLD.terminal_state
        AND NEW.terminal_state_version IS NOT DISTINCT FROM OLD.terminal_state_version
        AND NEW.event_id IS NOT DISTINCT FROM OLD.event_id
        AND NEW.event_seq IS NOT DISTINCT FROM OLD.event_seq
        AND NEW.event_source_seq IS NOT DISTINCT FROM OLD.event_source_seq
        AND NEW.event_source IS NOT DISTINCT FROM OLD.event_source
        AND NEW.event_type IS NOT DISTINCT FROM OLD.event_type
        AND NEW.event_writer IS NOT DISTINCT FROM OLD.event_writer
        AND NEW.event_schema_version IS NOT DISTINCT FROM OLD.event_schema_version
        AND NEW.event_ts_event_ns IS NOT DISTINCT FROM OLD.event_ts_event_ns
        AND NEW.event_ts_ingest_ns IS NOT DISTINCT FROM OLD.event_ts_ingest_ns
        AND NEW.event_visible IS NOT DISTINCT FROM OLD.event_visible
        AND NEW.event_envelope_bytes IS NOT DISTINCT FROM OLD.event_envelope_bytes
        AND NEW.event_digest IS NOT DISTINCT FROM OLD.event_digest
        AND NEW.initial_event_digest IS NOT DISTINCT FROM OLD.initial_event_digest
        AND NEW.audit_seq IS NOT DISTINCT FROM OLD.audit_seq
        AND NEW.audit_event_digest IS NOT DISTINCT FROM OLD.audit_event_digest
        AND NEW.audit_intent_bytes IS NOT DISTINCT FROM OLD.audit_intent_bytes
        AND NEW.audit_intent_digest IS NOT DISTINCT FROM OLD.audit_intent_digest
        AND NEW.audit_created_at_ns IS NOT DISTINCT FROM OLD.audit_created_at_ns
        AND NEW.prepared_at_ns IS NOT DISTINCT FROM OLD.prepared_at_ns
        AND NEW.conversion_fault_hash IS NOT DISTINCT FROM OLD.conversion_fault_hash
        AND NEW.converted_at_ns IS NOT DISTINCT FROM OLD.converted_at_ns
    )
    OR (
        OLD.disposition = 'NORMAL'
        AND NEW.disposition = 'FAULT_CONVERTED'
        AND NEW.failure_attempt_count = 3
        AND NEW.last_failure_at_ns > COALESCE(OLD.last_failure_at_ns, OLD.prepared_at_ns)
        AND NEW.last_failure_stage IS NOT NULL
        AND NEW.conversion_fault_hash IS NOT NULL
        AND NEW.converted_at_ns IS NOT NULL
        AND NEW.converted_at_ns >= NEW.last_failure_at_ns
        AND NEW.terminal_state = 'FAILED'
        AND NEW.event_type = 'run.failed'
        AND NEW.run_id IS NOT DISTINCT FROM OLD.run_id
        AND NEW.runner_outcome_hash IS NOT DISTINCT FROM OLD.runner_outcome_hash
        AND NEW.terminal_state_version IS NOT DISTINCT FROM OLD.terminal_state_version
        AND NEW.event_id IS NOT DISTINCT FROM OLD.event_id
        AND NEW.event_seq IS NOT DISTINCT FROM OLD.event_seq
        AND NEW.event_source_seq IS NOT DISTINCT FROM OLD.event_source_seq
        AND NEW.event_source IS NOT DISTINCT FROM OLD.event_source
        AND NEW.event_writer IS NOT DISTINCT FROM OLD.event_writer
        AND NEW.event_schema_version IS NOT DISTINCT FROM OLD.event_schema_version
        AND NEW.event_ts_event_ns IS NOT DISTINCT FROM OLD.event_ts_event_ns
        AND NEW.event_ts_ingest_ns IS NOT DISTINCT FROM OLD.event_ts_ingest_ns
        AND NEW.event_visible IS NOT DISTINCT FROM OLD.event_visible
        AND NEW.initial_event_digest IS NOT DISTINCT FROM OLD.initial_event_digest
        AND NEW.audit_seq IS NOT DISTINCT FROM OLD.audit_seq
        AND NEW.audit_created_at_ns IS NOT DISTINCT FROM OLD.audit_created_at_ns
        AND NEW.prepared_at_ns IS NOT DISTINCT FROM OLD.prepared_at_ns
    )
 ) THEN
  RAISE EXCEPTION USING MESSAGE='PG1_INVARIANT_089', ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pg1_guard_089 BEFORE UPDATE ON terminal_preparations
FOR EACH ROW EXECUTE FUNCTION pg1_guard_089();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_accounts
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_accounts
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON astarter_accounts FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_admission_heads
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_admission_heads
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_admissions
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_admissions
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_approval_references
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_approval_references
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_audit
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_audit
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON astarter_audit FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_bindings
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_bindings
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON astarter_bindings FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_episode_references
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_episode_references
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_fills
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_fills
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON astarter_fills FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_intent_admissions
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_intent_admissions
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_intents
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_intents
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON astarter_intents FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_layer_references
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_layer_references
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_limits
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_limits
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON astarter_limits FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_orders
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_orders
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON astarter_orders FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_plan_versions
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_plan_versions
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_recovery_checkpoints
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_recovery_checkpoints
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_settlements
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_settlements
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON astarter_settlements FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_strategy_scopes
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_strategy_scopes
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON astarter_strategy_versions
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON astarter_strategy_versions
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON audit_intents
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON audit_intents
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON audit_intents FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON catalog_audit_intents
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON catalog_audit_intents
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON catalog_audit_intents FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON catalog_publications
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON catalog_publications
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON catalog_publications FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON events
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON events
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON finalization_faults
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON finalization_faults
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON finalization_faults FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON historical_preflights
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON historical_preflights
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON historical_preflights FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON historical_terminal_anchors
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON historical_terminal_anchors
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON historical_terminal_anchors FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON idempotency_records
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON idempotency_records
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON idempotency_records FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON outbox
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON outbox
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON preflight_configuration_bindings
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON preflight_configuration_bindings
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON preflight_configuration_bindings FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON preflights
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON preflights
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON preflights FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON runner_outcomes
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON runner_outcomes
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON runner_outcomes FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON runner_processes
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON runner_processes
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON runner_processes FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON runs
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON runs
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON seals
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON seals
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON seals FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON strategy_configuration_audit_entries
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON strategy_configuration_audit_entries
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON strategy_configuration_audit_entries FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON strategy_configuration_versions
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON strategy_configuration_versions
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON strategy_configuration_versions FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON strategy_drafts
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON strategy_drafts
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON strategy_drafts FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
CREATE TRIGGER pg1_writer BEFORE INSERT OR UPDATE OR DELETE ON terminal_preparations
FOR EACH STATEMENT EXECUTE FUNCTION pg1_require_writer();
CREATE TRIGGER pg1_retain BEFORE TRUNCATE ON terminal_preparations
FOR EACH STATEMENT EXECUTE FUNCTION pg1_no_truncate();
CREATE TRIGGER pg1_rowid BEFORE UPDATE ON terminal_preparations FOR EACH ROW EXECUTE FUNCTION pg1_rowid_immutable();
REVOKE ALL ON ALL TABLES IN SCHEMA pg1_control FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pg1_control FROM PUBLIC;
