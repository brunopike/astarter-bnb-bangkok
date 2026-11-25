BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY
        CHECK (typeof(run_id) = 'text' AND length(run_id) > 0),
    state TEXT NOT NULL DEFAULT 'DRAFT'
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
    state_version INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(state_version) = 'integer' AND state_version >= 0),
    last_event_seq INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(last_event_seq) = 'integer' AND last_event_seq >= 0),
    last_audit_seq INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(last_audit_seq) = 'integer' AND last_audit_seq >= 0),
    control_source_seq INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(control_source_seq) = 'integer' AND control_source_seq >= 0),
    runner_source_seq INTEGER
        CHECK (
            runner_source_seq IS NULL
            OR (typeof(runner_source_seq) = 'integer' AND runner_source_seq >= 0)
        ),
    input_manifest_bytes BLOB
        CHECK (input_manifest_bytes IS NULL OR typeof(input_manifest_bytes) = 'blob'),
    input_manifest_hash TEXT
        CHECK (
            input_manifest_hash IS NULL
            OR (
                length(input_manifest_hash) = 64
                AND input_manifest_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    catalog_revision TEXT,
    catalog_inventory_hash TEXT
        CHECK (
            catalog_inventory_hash IS NULL
            OR (
                length(catalog_inventory_hash) = 64
                AND catalog_inventory_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    created_at_ns INTEGER NOT NULL
        CHECK (typeof(created_at_ns) = 'integer' AND created_at_ns >= 0),
    started_at_ns INTEGER
        CHECK (started_at_ns IS NULL OR (typeof(started_at_ns) = 'integer' AND started_at_ns >= 0)),
    completed_at_ns INTEGER
        CHECK (
            completed_at_ns IS NULL
            OR (typeof(completed_at_ns) = 'integer' AND completed_at_ns >= 0)
        ),
    duration_ns INTEGER
        CHECK (duration_ns IS NULL OR (typeof(duration_ns) = 'integer' AND duration_ns >= 0)),
    prepared_terminal_state TEXT
        CHECK (prepared_terminal_state IS NULL OR prepared_terminal_state IN ('COMPLETED', 'FAILED', 'CANCELLED')),
    prepared_terminal_state_version INTEGER
        CHECK (
            prepared_terminal_state_version IS NULL
            OR (
                typeof(prepared_terminal_state_version) = 'integer'
                AND prepared_terminal_state_version >= 0
            )
        ),
    prepared_terminal_event_seq INTEGER
        CHECK (
            prepared_terminal_event_seq IS NULL
            OR (typeof(prepared_terminal_event_seq) = 'integer' AND prepared_terminal_event_seq >= 1)
        ),
    materialized_event_seq INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(materialized_event_seq) = 'integer' AND materialized_event_seq >= 0),
    materialized_audit_seq INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(materialized_audit_seq) = 'integer' AND materialized_audit_seq >= 0),
    evidence_status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (evidence_status IN ('PENDING', 'STAGING', 'PARTIAL', 'VERIFIED', 'UNVERIFIED')),
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
    CHECK (materialized_audit_seq <= last_audit_seq),
    FOREIGN KEY (catalog_revision, catalog_inventory_hash)
        REFERENCES catalog_publications(catalog_revision, inventory_hash) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS catalog_publications (
    catalog_revision TEXT PRIMARY KEY
        CHECK (typeof(catalog_revision) = 'text' AND length(catalog_revision) > 0),
    fixture_id TEXT NOT NULL
        CHECK (typeof(fixture_id) = 'text' AND length(fixture_id) > 0),
    status TEXT NOT NULL
        CHECK (status IN ('PREPARED', 'PUBLISHED', 'INTEGRITY_FAILED')),
    inventory_hash TEXT NOT NULL
        CHECK (
            length(inventory_hash) = 64
            AND inventory_hash NOT GLOB '*[^0-9a-f]*'
        ),
    publication_bytes BLOB NOT NULL
        CHECK (typeof(publication_bytes) = 'blob'),
    staging_identity TEXT NOT NULL UNIQUE
        CHECK (typeof(staging_identity) = 'text' AND length(staging_identity) > 0),
    prepared_at_ns INTEGER NOT NULL
        CHECK (typeof(prepared_at_ns) = 'integer' AND prepared_at_ns >= 0),
    published_at_ns INTEGER
        CHECK (
            published_at_ns IS NULL
            OR (typeof(published_at_ns) = 'integer' AND published_at_ns >= 0)
        ),
    UNIQUE (catalog_revision, inventory_hash),
    CHECK (
        (status = 'PREPARED' AND published_at_ns IS NULL)
        OR (status IN ('PUBLISHED', 'INTEGRITY_FAILED') AND published_at_ns IS NOT NULL)
    )
) STRICT;

CREATE TABLE IF NOT EXISTS catalog_audit_intents (
    catalog_revision TEXT PRIMARY KEY
        REFERENCES catalog_publications(catalog_revision) ON DELETE RESTRICT,
    intent_bytes BLOB NOT NULL
        CHECK (typeof(intent_bytes) = 'blob'),
    created_at_ns INTEGER NOT NULL
        CHECK (typeof(created_at_ns) = 'integer' AND created_at_ns >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS preflights (
    preflight_id TEXT PRIMARY KEY
        CHECK (typeof(preflight_id) = 'text' AND length(preflight_id) > 0),
    run_id TEXT NOT NULL UNIQUE
        REFERENCES runs(run_id) ON DELETE RESTRICT,
    status TEXT NOT NULL
        CHECK (status IN ('PREFLIGHT_BLOCKED', 'PREFLIGHT_READY')),
    request_bytes BLOB NOT NULL
        CHECK (typeof(request_bytes) = 'blob'),
    request_hash TEXT NOT NULL
        CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    result_bytes BLOB NOT NULL
        CHECK (typeof(result_bytes) = 'blob'),
    input_manifest_bytes BLOB
        CHECK (input_manifest_bytes IS NULL OR typeof(input_manifest_bytes) = 'blob'),
    input_manifest_hash TEXT
        CHECK (
            input_manifest_hash IS NULL
            OR (length(input_manifest_hash) = 64 AND input_manifest_hash NOT GLOB '*[^0-9a-f]*')
        ),
    catalog_revision TEXT,
    catalog_inventory_hash TEXT
        CHECK (
            catalog_inventory_hash IS NULL
            OR (
                length(catalog_inventory_hash) = 64
                AND catalog_inventory_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    engine_package_version TEXT,
    engine_tag_commit TEXT,
    risk_policy_hash TEXT
        CHECK (
            risk_policy_hash IS NULL
            OR (length(risk_policy_hash) = 64 AND risk_policy_hash NOT GLOB '*[^0-9a-f]*')
        ),
    expires_at_ns INTEGER NOT NULL
        CHECK (typeof(expires_at_ns) = 'integer' AND expires_at_ns >= 0),
    consumed_at_ns INTEGER
        CHECK (
            consumed_at_ns IS NULL
            OR (typeof(consumed_at_ns) = 'integer' AND consumed_at_ns >= 0)
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
    ),
    FOREIGN KEY (catalog_revision, catalog_inventory_hash)
        REFERENCES catalog_publications(catalog_revision, inventory_hash) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS idempotency_records (
    idempotency_scope TEXT NOT NULL
        CHECK (
            idempotency_scope IN ('backtest.preflight', 'backtest.create')
            OR (
                substr(idempotency_scope, 1, 16) = 'backtest.cancel/'
                AND length(idempotency_scope) > 16
            )
        ),
    idempotency_key TEXT NOT NULL
        CHECK (typeof(idempotency_key) = 'text' AND length(idempotency_key) > 0),
    request_hash TEXT NOT NULL
        CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    request_body BLOB NOT NULL
        CHECK (typeof(request_body) = 'blob'),
    response_status INTEGER NOT NULL
        CHECK (
            typeof(response_status) = 'integer'
            AND response_status BETWEEN 100 AND 599
        ),
    response_body BLOB NOT NULL
        CHECK (typeof(response_body) = 'blob'),
    target_run_id TEXT
        CHECK (
            target_run_id IS NULL
            OR (typeof(target_run_id) = 'text' AND length(target_run_id) > 0)
        ),
    run_id TEXT REFERENCES runs(run_id) ON DELETE RESTRICT,
    created_at_ns INTEGER NOT NULL
        CHECK (typeof(created_at_ns) = 'integer' AND created_at_ns >= 0),
    PRIMARY KEY (idempotency_scope, idempotency_key),
    CHECK (
        (
            idempotency_scope IN ('backtest.preflight', 'backtest.create')
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
) STRICT;

CREATE TABLE IF NOT EXISTS events (
    event_id TEXT NOT NULL UNIQUE
        CHECK (typeof(event_id) = 'text' AND length(event_id) > 0),
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
    seq INTEGER NOT NULL
        CHECK (typeof(seq) = 'integer' AND seq >= 1),
    source_seq INTEGER NOT NULL
        CHECK (typeof(source_seq) = 'integer' AND source_seq >= 0),
    source TEXT NOT NULL
        CHECK (source IN ('control-api', 'runner')),
    type TEXT NOT NULL
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
    writer TEXT NOT NULL
        CHECK (writer = 'control-api'),
    schema_version INTEGER NOT NULL
        CHECK (typeof(schema_version) = 'integer' AND schema_version = 1),
    ts_event_ns TEXT NOT NULL
        CHECK (
            length(ts_event_ns) > 0
            AND ts_event_ns NOT GLOB '*[^0-9]*'
            AND (ts_event_ns = '0' OR substr(ts_event_ns, 1, 1) <> '0')
        ),
    ts_ingest_ns TEXT NOT NULL
        CHECK (
            length(ts_ingest_ns) > 0
            AND ts_ingest_ns NOT GLOB '*[^0-9]*'
            AND (ts_ingest_ns = '0' OR substr(ts_ingest_ns, 1, 1) <> '0')
        ),
    visible INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(visible) = 'integer' AND visible IN (0, 1)),
    envelope_bytes BLOB NOT NULL
        CHECK (typeof(envelope_bytes) = 'blob'),
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
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_events_one_terminal_per_run
ON events(run_id)
WHERE type IN ('run.completed', 'run.failed', 'run.cancelled');

CREATE TRIGGER IF NOT EXISTS trg_events_no_insert_after_terminal
BEFORE INSERT ON events
WHEN EXISTS (
    SELECT 1
    FROM events
    WHERE run_id = NEW.run_id
      AND type IN ('run.completed', 'run.failed', 'run.cancelled')
)
BEGIN
    SELECT RAISE(ABORT, 'terminal event freezes the run event stream');
END;

CREATE TRIGGER IF NOT EXISTS trg_events_prepared_boundary
BEFORE INSERT ON events
WHEN NEW.type NOT IN ('run.completed', 'run.failed', 'run.cancelled')
 AND EXISTS (
    SELECT 1
    FROM runs
    WHERE run_id = NEW.run_id
      AND (
          prepared_terminal_state IS NOT NULL
          OR prepared_terminal_state_version IS NOT NULL
          OR prepared_terminal_event_seq IS NOT NULL
      )
 )
BEGIN
    SELECT RAISE(ABORT, 'prepared terminal boundary freezes generic events');
END;

CREATE TRIGGER IF NOT EXISTS trg_events_terminal_matches_preparation
BEFORE INSERT ON events
WHEN NEW.type IN ('run.completed', 'run.failed', 'run.cancelled')
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
 )
BEGIN
    SELECT RAISE(ABORT, 'terminal event does not match prepared terminal boundary');
END;

CREATE TABLE IF NOT EXISTS audit_intents (
    run_id TEXT NOT NULL,
    audit_seq INTEGER NOT NULL
        CHECK (typeof(audit_seq) = 'integer' AND audit_seq >= 1),
    event_seq INTEGER NOT NULL
        CHECK (typeof(event_seq) = 'integer' AND event_seq >= 1),
    event_digest TEXT NOT NULL
        CHECK (length(event_digest) = 64 AND event_digest NOT GLOB '*[^0-9a-f]*'),
    intent_bytes BLOB NOT NULL
        CHECK (typeof(intent_bytes) = 'blob'),
    created_at_ns INTEGER NOT NULL
        CHECK (typeof(created_at_ns) = 'integer' AND created_at_ns >= 0),
    PRIMARY KEY (run_id, audit_seq),
    UNIQUE (run_id, event_seq),
    UNIQUE (run_id, audit_seq, event_seq),
    FOREIGN KEY (run_id, event_seq)
        REFERENCES events(run_id, seq) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS outbox (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL
        CHECK (typeof(seq) = 'integer' AND seq >= 1),
    audit_seq INTEGER NOT NULL
        CHECK (typeof(audit_seq) = 'integer' AND audit_seq >= 1),
    materialized INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(materialized) = 'integer' AND materialized IN (0, 1)),
    materialized_at_ns INTEGER
        CHECK (
            materialized_at_ns IS NULL
            OR (typeof(materialized_at_ns) = 'integer' AND materialized_at_ns >= 0)
        ),
    PRIMARY KEY (run_id, seq),
    UNIQUE (run_id, audit_seq),
    FOREIGN KEY (run_id, seq)
        REFERENCES events(run_id, seq) ON DELETE RESTRICT,
    FOREIGN KEY (run_id, audit_seq, seq)
        REFERENCES audit_intents(run_id, audit_seq, event_seq) ON DELETE RESTRICT,
    CHECK (
        (materialized = 0 AND materialized_at_ns IS NULL)
        OR (materialized = 1 AND materialized_at_ns IS NOT NULL)
    )
) STRICT;

CREATE TABLE IF NOT EXISTS runner_processes (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE RESTRICT,
    spawn_nonce TEXT NOT NULL UNIQUE
        CHECK (typeof(spawn_nonce) = 'text' AND length(spawn_nonce) > 0),
    pid INTEGER
        CHECK (pid IS NULL OR (typeof(pid) = 'integer' AND pid > 0)),
    process_identity_bytes BLOB
        CHECK (process_identity_bytes IS NULL OR typeof(process_identity_bytes) = 'blob'),
    launched_at_ns INTEGER
        CHECK (
            launched_at_ns IS NULL
            OR (typeof(launched_at_ns) = 'integer' AND launched_at_ns >= 0)
        ),
    cancel_phase TEXT NOT NULL DEFAULT 'NONE'
        CHECK (cancel_phase IN ('NONE', 'REQUESTED', 'ACKNOWLEDGED', 'TERM_SENT', 'KILL_SENT')),
    CHECK (
        (pid IS NULL AND process_identity_bytes IS NULL AND launched_at_ns IS NULL)
        OR (pid IS NOT NULL AND process_identity_bytes IS NOT NULL AND launched_at_ns IS NOT NULL)
    )
) STRICT;

CREATE TABLE IF NOT EXISTS runner_outcomes (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE RESTRICT,
    outcome_bytes BLOB NOT NULL
        CHECK (typeof(outcome_bytes) = 'blob'),
    outcome_hash TEXT NOT NULL
        CHECK (length(outcome_hash) = 64 AND outcome_hash NOT GLOB '*[^0-9a-f]*'),
    recorded_at_ns INTEGER NOT NULL
        CHECK (typeof(recorded_at_ns) = 'integer' AND recorded_at_ns >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS finalization_faults (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE RESTRICT,
    fault_bytes BLOB NOT NULL
        CHECK (typeof(fault_bytes) = 'blob'),
    fault_hash TEXT NOT NULL
        CHECK (length(fault_hash) = 64 AND fault_hash NOT GLOB '*[^0-9a-f]*'),
    recorded_at_ns INTEGER NOT NULL
        CHECK (typeof(recorded_at_ns) = 'integer' AND recorded_at_ns >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS seals (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE RESTRICT,
    seal_digest TEXT NOT NULL
        CHECK (length(seal_digest) = 64 AND seal_digest NOT GLOB '*[^0-9a-f]*'),
    terminal_event_seq INTEGER NOT NULL
        CHECK (typeof(terminal_event_seq) = 'integer' AND terminal_event_seq >= 1),
    last_audit_seq INTEGER NOT NULL
        CHECK (typeof(last_audit_seq) = 'integer' AND last_audit_seq >= 1),
    published_at_ns INTEGER NOT NULL
        CHECK (typeof(published_at_ns) = 'integer' AND published_at_ns >= 0),
    FOREIGN KEY (run_id, terminal_event_seq)
        REFERENCES events(run_id, seq) ON DELETE RESTRICT,
    FOREIGN KEY (run_id, last_audit_seq, terminal_event_seq)
        REFERENCES audit_intents(run_id, audit_seq, event_seq) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER IF NOT EXISTS trg_seals_reject_duplicate_insert
BEFORE INSERT ON seals
WHEN EXISTS (
    SELECT 1
    FROM seals
    WHERE run_id = NEW.run_id
)
BEGIN
    SELECT RAISE(ABORT, 'seal already exists');
END;

CREATE TRIGGER IF NOT EXISTS trg_seals_validate_terminal_boundary
BEFORE INSERT ON seals
WHEN NOT EXISTS (
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
)
BEGIN
    SELECT RAISE(ABORT, 'invalid seal terminal boundary');
END;

CREATE TRIGGER IF NOT EXISTS trg_events_immutable_update
BEFORE UPDATE ON events
WHEN NOT (
    OLD.visible = 0
    AND NEW.visible = 1
    AND OLD.type IN ('run.completed', 'run.failed', 'run.cancelled')
    AND NEW.event_id IS OLD.event_id
    AND NEW.run_id IS OLD.run_id
    AND NEW.seq IS OLD.seq
    AND NEW.source_seq IS OLD.source_seq
    AND NEW.source IS OLD.source
    AND NEW.type IS OLD.type
    AND NEW.writer IS OLD.writer
    AND NEW.schema_version IS OLD.schema_version
    AND NEW.ts_event_ns IS OLD.ts_event_ns
    AND NEW.ts_ingest_ns IS OLD.ts_ingest_ns
    AND NEW.envelope_bytes IS OLD.envelope_bytes
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
)
BEGIN
    SELECT RAISE(ABORT, 'event records are immutable outside terminal publication');
END;

CREATE TRIGGER IF NOT EXISTS trg_events_immutable_delete
BEFORE DELETE ON events
BEGIN
    SELECT RAISE(ABORT, 'event records are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_seals_immutable_update
BEFORE UPDATE ON seals
BEGIN
    SELECT RAISE(ABORT, 'seal records are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_seals_immutable_delete
BEFORE DELETE ON seals
BEGIN
    SELECT RAISE(ABORT, 'seal records are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_finalization_faults_require_finalizing_unverified
BEFORE INSERT ON finalization_faults
WHEN NOT EXISTS (
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
)
BEGIN
    SELECT RAISE(
        ABORT,
        'finalization fault requires FINALIZING state and UNVERIFIED evidence'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_finalization_faults_reject_duplicate_insert
BEFORE INSERT ON finalization_faults
WHEN EXISTS (
    SELECT 1
    FROM finalization_faults
    WHERE run_id = NEW.run_id
)
BEGIN
    SELECT RAISE(ABORT, 'finalization fault already exists');
END;

CREATE TRIGGER IF NOT EXISTS trg_finalization_faults_reject_sealed_insert
BEFORE INSERT ON finalization_faults
WHEN EXISTS (
    SELECT 1
    FROM seals
    WHERE run_id = NEW.run_id
)
BEGIN
    SELECT RAISE(ABORT, 'sealed run cannot record an unverified finalization fault');
END;

CREATE TRIGGER IF NOT EXISTS trg_finalization_faults_immutable_update
BEFORE UPDATE ON finalization_faults
BEGIN
    SELECT RAISE(ABORT, 'finalization fault records are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_finalization_faults_immutable_delete
BEFORE DELETE ON finalization_faults
BEGIN
    SELECT RAISE(ABORT, 'finalization fault records are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_runs_reject_unverified_seal
BEFORE UPDATE OF evidence_status ON runs
WHEN NEW.evidence_status = 'UNVERIFIED'
 AND EXISTS (
     SELECT 1
     FROM seals
     WHERE run_id = NEW.run_id
 )
BEGIN
    SELECT RAISE(ABORT, 'sealed run cannot become UNVERIFIED');
END;

CREATE TRIGGER IF NOT EXISTS trg_runs_preserve_unverified_fault_status
BEFORE UPDATE OF evidence_status ON runs
WHEN NEW.evidence_status <> 'UNVERIFIED'
 AND EXISTS (
     SELECT 1
     FROM finalization_faults
     WHERE run_id = NEW.run_id
 )
BEGIN
    SELECT RAISE(ABORT, 'run with a finalization fault must remain UNVERIFIED');
END;

PRAGMA user_version = 1;

COMMIT;
