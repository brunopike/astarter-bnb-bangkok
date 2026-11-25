BEGIN IMMEDIATE;

CREATE TABLE strategy_drafts (
    draft_id TEXT PRIMARY KEY
        CHECK (
            typeof(draft_id) = 'text'
            AND length(draft_id) = 35
            AND substr(draft_id, 1, 3) = 'sd_'
            AND substr(draft_id, 4) NOT GLOB '*[^0-9a-f]*'
        ),
    content_bytes BLOB NOT NULL
        CHECK (typeof(content_bytes) = 'blob'),
    content_sha256 TEXT NOT NULL
        CHECK (
            length(content_sha256) = 64
            AND content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    revision INTEGER NOT NULL
        CHECK (typeof(revision) = 'integer' AND revision >= 1),
    created_at_ns INTEGER NOT NULL
        CHECK (
            typeof(created_at_ns) = 'integer'
            AND created_at_ns >= 1000000000000000000
        ),
    updated_at_ns INTEGER NOT NULL
        CHECK (
            typeof(updated_at_ns) = 'integer'
            AND updated_at_ns >= created_at_ns
        )
) STRICT;

CREATE TABLE strategy_configuration_versions (
    configuration_id TEXT PRIMARY KEY
        CHECK (
            typeof(configuration_id) = 'text'
            AND length(configuration_id) = 36
            AND substr(configuration_id, 1, 4) = 'cfg_'
            AND substr(configuration_id, 5) NOT GLOB '*[^0-9a-f]*'
        ),
    draft_id TEXT NOT NULL
        REFERENCES strategy_drafts(draft_id) ON DELETE RESTRICT,
    version INTEGER NOT NULL
        CHECK (typeof(version) = 'integer' AND version >= 1),
    source_revision INTEGER NOT NULL
        CHECK (typeof(source_revision) = 'integer' AND source_revision >= 1),
    content_bytes BLOB NOT NULL
        CHECK (typeof(content_bytes) = 'blob'),
    content_sha256 TEXT NOT NULL
        CHECK (
            length(content_sha256) = 64
            AND content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    created_at_ns INTEGER NOT NULL
        CHECK (
            typeof(created_at_ns) = 'integer'
            AND created_at_ns >= 1000000000000000000
        ),
    UNIQUE (draft_id, version),
    UNIQUE (draft_id, source_revision)
) STRICT;

CREATE TABLE strategy_configuration_audit_entries (
    audit_seq INTEGER PRIMARY KEY
        CHECK (typeof(audit_seq) = 'integer' AND audit_seq >= 1),
    action TEXT NOT NULL
        CHECK (action IN (
            'strategy_draft.created',
            'strategy_draft.updated',
            'strategy_configuration.published'
        )),
    draft_id TEXT NOT NULL
        REFERENCES strategy_drafts(draft_id) ON DELETE RESTRICT,
    configuration_id TEXT
        REFERENCES strategy_configuration_versions(configuration_id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL
        CHECK (typeof(revision) = 'integer' AND revision >= 1),
    content_sha256 TEXT NOT NULL
        CHECK (
            length(content_sha256) = 64
            AND content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    entry_bytes BLOB NOT NULL
        CHECK (typeof(entry_bytes) = 'blob'),
    entry_sha256 TEXT NOT NULL
        CHECK (
            length(entry_sha256) = 64
            AND entry_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    created_at_ns INTEGER NOT NULL
        CHECK (
            typeof(created_at_ns) = 'integer'
            AND created_at_ns >= 1000000000000000000
        ),
    CHECK (
        (action IN ('strategy_draft.created', 'strategy_draft.updated')
         AND configuration_id IS NULL)
        OR
        (action = 'strategy_configuration.published'
         AND configuration_id IS NOT NULL)
    )
) STRICT;

CREATE TRIGGER trg_strategy_configuration_audit_entries_reject_update
BEFORE UPDATE ON strategy_configuration_audit_entries
BEGIN
    SELECT RAISE(ABORT, 'strategy configuration audit entries are append-only');
END;

CREATE TRIGGER trg_strategy_configuration_audit_entries_reject_delete
BEFORE DELETE ON strategy_configuration_audit_entries
BEGIN
    SELECT RAISE(ABORT, 'strategy configuration audit entries are append-only');
END;

CREATE TABLE preflight_configuration_bindings (
    preflight_id TEXT PRIMARY KEY
        REFERENCES preflights(preflight_id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL UNIQUE
        REFERENCES runs(run_id) ON DELETE RESTRICT,
    configuration_id TEXT NOT NULL
        REFERENCES strategy_configuration_versions(configuration_id) ON DELETE RESTRICT,
    configuration_content_sha256 TEXT NOT NULL
        CHECK (
            length(configuration_content_sha256) = 64
            AND configuration_content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    created_at_ns INTEGER NOT NULL
        CHECK (
            typeof(created_at_ns) = 'integer'
            AND created_at_ns >= 1000000000000000000
        )
) STRICT;

CREATE TRIGGER trg_preflight_configuration_bindings_reject_update
BEFORE UPDATE ON preflight_configuration_bindings
BEGIN
    SELECT RAISE(ABORT, 'preflight configuration bindings are immutable');
END;

CREATE TRIGGER trg_preflight_configuration_bindings_reject_delete
BEFORE DELETE ON preflight_configuration_bindings
BEGIN
    SELECT RAISE(ABORT, 'preflight configuration bindings are immutable');
END;

PRAGMA user_version = 3;

COMMIT;
