BEGIN IMMEDIATE;

CREATE UNIQUE INDEX uq_runs_prepared_terminal_identity
ON runs (
    run_id,
    prepared_terminal_state,
    prepared_terminal_state_version,
    prepared_terminal_event_seq
);

CREATE UNIQUE INDEX uq_runner_outcomes_run_hash
ON runner_outcomes (run_id, outcome_hash);

CREATE UNIQUE INDEX uq_finalization_faults_run_hash
ON finalization_faults (run_id, fault_hash);

CREATE TABLE terminal_preparations (
    run_id TEXT PRIMARY KEY
        CHECK (typeof(run_id) = 'text' AND length(run_id) > 0),
    runner_outcome_hash TEXT NOT NULL
        CHECK (
            length(runner_outcome_hash) = 64
            AND runner_outcome_hash NOT GLOB '*[^0-9a-f]*'
        ),
    terminal_state TEXT NOT NULL
        CHECK (terminal_state IN ('COMPLETED', 'FAILED', 'CANCELLED')),
    terminal_state_version INTEGER NOT NULL
        CHECK (typeof(terminal_state_version) = 'integer' AND terminal_state_version >= 1),
    event_id TEXT NOT NULL UNIQUE
        CHECK (typeof(event_id) = 'text' AND length(event_id) > 0),
    event_seq INTEGER NOT NULL
        CHECK (typeof(event_seq) = 'integer' AND event_seq >= 1),
    event_source_seq INTEGER NOT NULL
        CHECK (typeof(event_source_seq) = 'integer' AND event_source_seq >= 1),
    event_source TEXT NOT NULL
        CHECK (event_source = 'control-api'),
    event_type TEXT NOT NULL
        CHECK (event_type IN ('run.completed', 'run.failed', 'run.cancelled')),
    event_writer TEXT NOT NULL
        CHECK (event_writer = 'control-api'),
    event_schema_version INTEGER NOT NULL
        CHECK (typeof(event_schema_version) = 'integer' AND event_schema_version = 1),
    event_ts_event_ns TEXT NOT NULL
        CHECK (
            length(event_ts_event_ns) > 0
            AND event_ts_event_ns NOT GLOB '*[^0-9]*'
            AND (event_ts_event_ns = '0' OR substr(event_ts_event_ns, 1, 1) <> '0')
        ),
    event_ts_ingest_ns TEXT NOT NULL
        CHECK (
            length(event_ts_ingest_ns) > 0
            AND event_ts_ingest_ns NOT GLOB '*[^0-9]*'
            AND (event_ts_ingest_ns = '0' OR substr(event_ts_ingest_ns, 1, 1) <> '0')
        ),
    event_visible INTEGER NOT NULL
        CHECK (typeof(event_visible) = 'integer' AND event_visible = 0),
    event_envelope_bytes BLOB NOT NULL
        CHECK (typeof(event_envelope_bytes) = 'blob'),
    event_digest TEXT NOT NULL
        CHECK (length(event_digest) = 64 AND event_digest NOT GLOB '*[^0-9a-f]*'),
    initial_event_digest TEXT NOT NULL
        CHECK (
            length(initial_event_digest) = 64
            AND initial_event_digest NOT GLOB '*[^0-9a-f]*'
        ),
    audit_seq INTEGER NOT NULL
        CHECK (typeof(audit_seq) = 'integer' AND audit_seq >= 1),
    audit_event_digest TEXT NOT NULL
        CHECK (
            length(audit_event_digest) = 64
            AND audit_event_digest NOT GLOB '*[^0-9a-f]*'
        ),
    audit_intent_bytes BLOB NOT NULL
        CHECK (typeof(audit_intent_bytes) = 'blob'),
    audit_intent_digest TEXT NOT NULL
        CHECK (
            length(audit_intent_digest) = 64
            AND audit_intent_digest NOT GLOB '*[^0-9a-f]*'
        ),
    audit_created_at_ns INTEGER NOT NULL
        CHECK (typeof(audit_created_at_ns) = 'integer' AND audit_created_at_ns >= 0),
    prepared_at_ns INTEGER NOT NULL
        CHECK (typeof(prepared_at_ns) = 'integer' AND prepared_at_ns >= 0),
    disposition TEXT NOT NULL
        CHECK (disposition IN ('NORMAL', 'FAULT_CONVERTED')),
    failure_attempt_count INTEGER NOT NULL
        CHECK (typeof(failure_attempt_count) = 'integer' AND failure_attempt_count BETWEEN 0 AND 3),
    last_failure_at_ns INTEGER
        CHECK (
            last_failure_at_ns IS NULL
            OR (typeof(last_failure_at_ns) = 'integer' AND last_failure_at_ns >= 0)
        ),
    last_failure_stage TEXT
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
    conversion_fault_hash TEXT
        CHECK (
            conversion_fault_hash IS NULL
            OR (
                length(conversion_fault_hash) = 64
                AND conversion_fault_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    converted_at_ns INTEGER
        CHECK (
            converted_at_ns IS NULL
            OR (typeof(converted_at_ns) = 'integer' AND converted_at_ns >= 0)
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
    ),
    FOREIGN KEY (run_id, runner_outcome_hash)
        REFERENCES runner_outcomes(run_id, outcome_hash)
        ON UPDATE NO ACTION ON DELETE NO ACTION
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (
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
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (run_id, conversion_fault_hash)
        REFERENCES finalization_faults(run_id, fault_hash)
        ON UPDATE NO ACTION ON DELETE NO ACTION
        DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TRIGGER trg_terminal_preparations_validate_insert
BEFORE INSERT ON terminal_preparations
WHEN NEW.disposition <> 'NORMAL'
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
 )
BEGIN
    SELECT RAISE(ABORT, 'invalid initial terminal preparation');
END;

CREATE TRIGGER trg_terminal_preparations_reject_delete
BEFORE DELETE ON terminal_preparations
BEGIN
    SELECT RAISE(ABORT, 'terminal preparation records are immutable');
END;

CREATE TRIGGER trg_terminal_preparations_validate_update
BEFORE UPDATE ON terminal_preparations
WHEN EXISTS (
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
        AND NEW.run_id IS OLD.run_id
        AND NEW.runner_outcome_hash IS OLD.runner_outcome_hash
        AND NEW.terminal_state IS OLD.terminal_state
        AND NEW.terminal_state_version IS OLD.terminal_state_version
        AND NEW.event_id IS OLD.event_id
        AND NEW.event_seq IS OLD.event_seq
        AND NEW.event_source_seq IS OLD.event_source_seq
        AND NEW.event_source IS OLD.event_source
        AND NEW.event_type IS OLD.event_type
        AND NEW.event_writer IS OLD.event_writer
        AND NEW.event_schema_version IS OLD.event_schema_version
        AND NEW.event_ts_event_ns IS OLD.event_ts_event_ns
        AND NEW.event_ts_ingest_ns IS OLD.event_ts_ingest_ns
        AND NEW.event_visible IS OLD.event_visible
        AND NEW.event_envelope_bytes IS OLD.event_envelope_bytes
        AND NEW.event_digest IS OLD.event_digest
        AND NEW.initial_event_digest IS OLD.initial_event_digest
        AND NEW.audit_seq IS OLD.audit_seq
        AND NEW.audit_event_digest IS OLD.audit_event_digest
        AND NEW.audit_intent_bytes IS OLD.audit_intent_bytes
        AND NEW.audit_intent_digest IS OLD.audit_intent_digest
        AND NEW.audit_created_at_ns IS OLD.audit_created_at_ns
        AND NEW.prepared_at_ns IS OLD.prepared_at_ns
        AND NEW.conversion_fault_hash IS OLD.conversion_fault_hash
        AND NEW.converted_at_ns IS OLD.converted_at_ns
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
        AND NEW.run_id IS OLD.run_id
        AND NEW.runner_outcome_hash IS OLD.runner_outcome_hash
        AND NEW.terminal_state_version IS OLD.terminal_state_version
        AND NEW.event_id IS OLD.event_id
        AND NEW.event_seq IS OLD.event_seq
        AND NEW.event_source_seq IS OLD.event_source_seq
        AND NEW.event_source IS OLD.event_source
        AND NEW.event_writer IS OLD.event_writer
        AND NEW.event_schema_version IS OLD.event_schema_version
        AND NEW.event_ts_event_ns IS OLD.event_ts_event_ns
        AND NEW.event_ts_ingest_ns IS OLD.event_ts_ingest_ns
        AND NEW.event_visible IS OLD.event_visible
        AND NEW.initial_event_digest IS OLD.initial_event_digest
        AND NEW.audit_seq IS OLD.audit_seq
        AND NEW.audit_created_at_ns IS OLD.audit_created_at_ns
        AND NEW.prepared_at_ns IS OLD.prepared_at_ns
    )
 )
BEGIN
    SELECT RAISE(ABORT, 'invalid terminal preparation update');
END;

CREATE TRIGGER trg_runs_reject_prepared_insert
BEFORE INSERT ON runs
WHEN NEW.prepared_terminal_state IS NOT NULL
 OR NEW.prepared_terminal_state_version IS NOT NULL
 OR NEW.prepared_terminal_event_seq IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'run prepared identity requires a terminal preparation');
END;

CREATE TRIGGER trg_runs_validate_prepared_update
BEFORE UPDATE OF prepared_terminal_state, prepared_terminal_state_version,
                 prepared_terminal_event_seq ON runs
WHEN NOT (
    NEW.prepared_terminal_state IS OLD.prepared_terminal_state
    AND NEW.prepared_terminal_state_version IS OLD.prepared_terminal_state_version
    AND NEW.prepared_terminal_event_seq IS OLD.prepared_terminal_event_seq
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
              AND NEW.prepared_terminal_state_version IS OLD.prepared_terminal_state_version
              AND NEW.prepared_terminal_event_seq IS OLD.prepared_terminal_event_seq
              AND preparation.disposition = 'FAULT_CONVERTED'
          )
      )
 )
BEGIN
    SELECT RAISE(ABORT, 'run prepared identity does not match terminal preparation');
END;

CREATE TRIGGER trg_events_terminal_copy_preparation
BEFORE INSERT ON events
WHEN NEW.type IN ('run.completed', 'run.failed', 'run.cancelled')
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
      AND preparation.event_envelope_bytes IS NEW.envelope_bytes
 )
BEGIN
    SELECT RAISE(ABORT, 'terminal event is not an exact preparation copy');
END;

CREATE TRIGGER trg_audit_terminal_copy_preparation
BEFORE INSERT ON audit_intents
WHEN EXISTS (
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
      AND preparation.audit_intent_bytes IS NEW.intent_bytes
      AND preparation.audit_created_at_ns = NEW.created_at_ns
 )
BEGIN
    SELECT RAISE(ABORT, 'terminal audit is not an exact preparation copy');
END;

CREATE TRIGGER trg_outbox_terminal_copy_preparation
BEFORE INSERT ON outbox
WHEN EXISTS (
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
 )
BEGIN
    SELECT RAISE(ABORT, 'terminal outbox does not match preparation');
END;

CREATE TRIGGER trg_finalization_faults_bind_converted_preparation
BEFORE INSERT ON finalization_faults
WHEN NOT EXISTS (
    SELECT 1
    FROM terminal_preparations AS preparation
    WHERE preparation.run_id = NEW.run_id
      AND preparation.disposition = 'FAULT_CONVERTED'
      AND preparation.conversion_fault_hash = NEW.fault_hash
 )
BEGIN
    SELECT RAISE(ABORT, 'fault does not bind a converted terminal preparation');
END;

CREATE TRIGGER trg_seals_bind_normal_preparation
BEFORE INSERT ON seals
WHEN NOT EXISTS (
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
 )
BEGIN
    SELECT RAISE(ABORT, 'seal does not bind a normal terminal preparation');
END;

CREATE TRIGGER trg_events_terminal_visibility_requires_publication
BEFORE UPDATE OF visible ON events
WHEN OLD.visible = 0
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
 )
BEGIN
    SELECT RAISE(ABORT, 'terminal visibility requires complete publication');
END;

CREATE TRIGGER trg_runs_validate_terminal_transition
BEFORE UPDATE OF state ON runs
WHEN NEW.state IN ('COMPLETED', 'FAILED', 'CANCELLED')
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
 )
BEGIN
    SELECT RAISE(ABORT, 'terminal run transition is incomplete');
END;

PRAGMA user_version = 2;

COMMIT;
