-- PRIVATE UI forward extension. The installer owns the transaction, exact v1
-- catalog precondition, and the final bound metadata/resource update.
ALTER TABLE astarter_private.metadata DROP CONSTRAINT metadata_schema_version_check;
ALTER TABLE astarter_private.metadata ADD CONSTRAINT metadata_schema_version_check
    CHECK (schema_version IN (1, 2));

ALTER TABLE astarter_private.challenges
    ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN permission_profile TEXT NOT NULL DEFAULT 'research-v1',
    ADD CONSTRAINT challenges_auth_profile_check CHECK (
        (auth_version = 1 AND permission_profile = 'research-v1') OR
        (auth_version = 2 AND permission_profile = 'private-ui-v2')
    );
ALTER TABLE astarter_private.sessions
    ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN permission_profile TEXT NOT NULL DEFAULT 'research-v1';
ALTER TABLE astarter_private.sessions DROP CONSTRAINT sessions_permissions_check;
ALTER TABLE astarter_private.sessions ADD CONSTRAINT sessions_permissions_check CHECK (
    (auth_version = 1 AND permission_profile = 'research-v1' AND
        permissions = ARRAY['research:analyze']::TEXT[]) OR
    (auth_version = 2 AND permission_profile = 'private-ui-v2' AND
        permissions = ARRAY['research:analyze', 'notifications:read',
            'notifications:write', 'workspace:read', 'workspace:write']::TEXT[])
);

CREATE FUNCTION astarter_private.ui_profile_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
    challenge_version INTEGER;
    challenge_profile TEXT;
BEGIN
    IF TG_OP = 'UPDATE' AND
        (NEW.auth_version IS DISTINCT FROM OLD.auth_version OR
         NEW.permission_profile IS DISTINCT FROM OLD.permission_profile) THEN
        RAISE EXCEPTION 'PRIVATE_UI_PROFILE_IMMUTABLE';
    END IF;
    IF TG_TABLE_NAME = 'sessions' AND TG_OP = 'INSERT' THEN
        SELECT c.auth_version, c.permission_profile
        INTO STRICT challenge_version, challenge_profile
        FROM astarter_private.challenges AS c
        WHERE c.challenge_hash = NEW.challenge_hash FOR UPDATE;
        IF NEW.auth_version IS DISTINCT FROM challenge_version OR
            NEW.permission_profile IS DISTINCT FROM challenge_profile THEN
            RAISE EXCEPTION 'PRIVATE_UI_PROFILE_MISMATCH';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION astarter_private.ui_profile_guard() FROM PUBLIC;
CREATE TRIGGER challenges_ui_profile BEFORE INSERT OR UPDATE ON astarter_private.challenges
    FOR EACH ROW EXECUTE FUNCTION astarter_private.ui_profile_guard();
CREATE TRIGGER sessions_ui_profile BEFORE INSERT OR UPDATE ON astarter_private.sessions
    FOR EACH ROW EXECUTE FUNCTION astarter_private.ui_profile_guard();

CREATE OR REPLACE FUNCTION astarter_private.resolve_session(p_digest TEXT, p_audience TEXT)
RETURNS TABLE(subject_id TEXT, tenant_id TEXT, scope_id TEXT, audience TEXT,
    not_before_ms NUMERIC, expires_at_ms NUMERIC, revoked_at_ms NUMERIC, permissions TEXT[])
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT s.subject_id::TEXT, s.tenant_id::TEXT, s.tenant_id::TEXT, s.audience,
        s.not_before_ms::NUMERIC, s.expires_at_ms::NUMERIC,
        s.revoked_at_ms::NUMERIC, s.permissions
    FROM astarter_private.sessions AS s
    WHERE s.token_digest = p_digest AND s.audience = p_audience
        AND p_audience = 'astarter-research' AND s.revoked_at_ms IS NULL
        AND s.not_before_ms <= extract(epoch FROM statement_timestamp()) * 1000
        AND s.expires_at_ms > extract(epoch FROM statement_timestamp()) * 1000
        AND (
            (s.auth_version = 1 AND s.permission_profile = 'research-v1' AND
                s.permissions = ARRAY['research:analyze']::TEXT[]) OR
            (s.auth_version = 2 AND s.permission_profile = 'private-ui-v2' AND
                s.permissions = ARRAY['research:analyze', 'notifications:read',
                    'notifications:write', 'workspace:read', 'workspace:write']::TEXT[])
        );
$$;

CREATE FUNCTION astarter_private.ui_authorized(p_tenant TEXT, p_subject TEXT, p_permission TEXT)
RETURNS BOOLEAN LANGUAGE SQL STABLE SET search_path = pg_catalog AS $$
    SELECT EXISTS (
        SELECT 1 FROM astarter_private.resolve_session(
            current_setting('astarter_private.session_digest', TRUE), 'astarter-research') AS s
        WHERE s.tenant_id = p_tenant AND s.subject_id = p_subject
            AND p_permission = ANY(s.permissions)
    );
$$;
REVOKE ALL ON FUNCTION astarter_private.ui_authorized(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION astarter_private.ui_authorized(TEXT, TEXT, TEXT)
    TO astarter_private_runtime;

CREATE FUNCTION astarter_private.ui_workspace_valid(
    p_preferences JSONB, p_drafts JSONB, p_selected TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
    item JSONB;
    watch_key TEXT;
    parts TEXT[];
    seen_watch TEXT[] := ARRAY[]::TEXT[];
    seen_drafts TEXT[] := ARRAY[]::TEXT[];
    draft_name TEXT;
    metadata_text TEXT;
    secret_pattern CONSTANT TEXT := '\mBearer\s+[A-Za-z0-9._-]{16,}|\msk-(or-v1-|proj-)?[A-Za-z0-9_-]{16,}|(https?|postgres(ql)?)://[^\s/@:]+:[^\s/@]+@|\m0x[0-9a-fA-F]{64}\M';
BEGIN
    IF jsonb_typeof(p_preferences) IS DISTINCT FROM 'object' OR
        jsonb_typeof(p_drafts) IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
    IF NOT (p_preferences ?& ARRAY['workbenchFilter', 'workbenchFocusAsset', 'watchedAssets']) OR
        p_preferences - ARRAY['workbenchFilter', 'workbenchFocusAsset', 'watchedAssets'] <> '{}'::JSONB OR
        jsonb_typeof(p_preferences->'workbenchFilter') IS DISTINCT FROM 'string' OR
        p_preferences->>'workbenchFilter' NOT IN ('all', 'scan', 'tracked') OR
        jsonb_typeof(p_preferences->'watchedAssets') IS DISTINCT FROM 'array' THEN
        RETURN FALSE;
    END IF;
    IF p_preferences->'workbenchFocusAsset' <> 'null'::JSONB AND
        (jsonb_typeof(p_preferences->'workbenchFocusAsset') IS DISTINCT FROM 'string' OR
         (p_preferences->>'workbenchFocusAsset') !~ '^[A-Z0-9][A-Z0-9._-]{0,31}$') THEN
        RETURN FALSE;
    END IF;
    IF jsonb_array_length(p_preferences->'watchedAssets') > 200 OR
        jsonb_array_length(p_drafts) > 50 OR
        octet_length(jsonb_build_object('preferences', p_preferences, 'drafts', p_drafts,
            'selectedDraftId', p_selected)::TEXT) > 131072 THEN RETURN FALSE; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(p_preferences->'watchedAssets') LOOP
        IF jsonb_typeof(item) IS DISTINCT FROM 'string' THEN RETURN FALSE; END IF;
        watch_key := item #>> '{}';
        IF length(watch_key) > 256 OR watch_key = ANY(seen_watch) THEN RETURN FALSE; END IF;
        parts := string_to_array(watch_key, ':');
        IF watch_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$' THEN
            NULL;
        ELSIF cardinality(parts) = 2 AND parts[1] = 'coin' AND
            parts[2] ~ '^[a-z0-9][a-z0-9._-]{0,149}$' THEN
            NULL;
        ELSIF cardinality(parts) = 3 AND parts[1] = 'ca' AND
            parts[2] ~ '^[a-z0-9][a-z0-9._-]{0,149}$' AND
            (parts[3] ~* '^0x([0-9a-f]{40}|[0-9a-f]{64})$' OR
             parts[3] ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') THEN
            NULL;
        ELSE RETURN FALSE;
        END IF;
        -- A typed CA may legitimately contain a 32-byte chain address. Only
        -- its chain name is metadata; legacy/coin keys have no such exemption.
        metadata_text := CASE WHEN cardinality(parts) = 3 AND parts[1] = 'ca'
            THEN parts[2] ELSE watch_key END;
        IF metadata_text ~ '[[:cntrl:]]' OR metadata_text ~ secret_pattern THEN RETURN FALSE; END IF;
        seen_watch := array_append(seen_watch, watch_key);
    END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements(p_drafts) LOOP
        IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR
            NOT (item ?& ARRAY['id', 'strategyId', 'name']) OR
            item - ARRAY['id', 'strategyId', 'name'] <> '{}'::JSONB OR
            jsonb_typeof(item->'id') IS DISTINCT FROM 'string' OR
            jsonb_typeof(item->'strategyId') IS DISTINCT FROM 'string' OR
            jsonb_typeof(item->'name') IS DISTINCT FROM 'string' THEN RETURN FALSE; END IF;
        IF (item->>'id') !~ '^[A-Za-z0-9:_-]{1,96}$' OR
            item->>'id' = ANY(seen_drafts) OR
            item->>'strategyId' NOT IN ('S00','S01','S02','S03','S04','S05','S06','S07','S08',
                'S09-A','S09-L','RX01','RX02-P','RX02-A','RX03-S','RX03-B','RX04','RX05')
            THEN RETURN FALSE; END IF;
        draft_name := item->>'name';
        IF length(draft_name) NOT BETWEEN 1 AND 120 OR draft_name ~ '[[:cntrl:]]' OR
            draft_name ~ secret_pattern OR (item->>'id') ~ secret_pattern THEN RETURN FALSE; END IF;
        seen_drafts := array_append(seen_drafts, item->>'id');
    END LOOP;
    IF p_selected IS NOT NULL AND
        (p_selected ~ '[[:cntrl:]]' OR p_selected ~ secret_pattern) THEN RETURN FALSE; END IF;
    RETURN p_selected IS NULL OR p_selected = ANY(seen_drafts);
END;
$$;
REVOKE ALL ON FUNCTION astarter_private.ui_workspace_valid(JSONB, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION astarter_private.ui_workspace_valid(JSONB, JSONB, TEXT)
    TO astarter_private_runtime;

CREATE TABLE astarter_private.notification_preferences (
    tenant_id astarter_private.identifier NOT NULL,
    subject_id astarter_private.identifier NOT NULL,
    revision astarter_private.integer_amount NOT NULL DEFAULT 0,
    updated_at_ms astarter_private.milliseconds NOT NULL DEFAULT 0,
    inapp BOOLEAN NOT NULL DEFAULT TRUE,
    events TEXT[] NOT NULL DEFAULT ARRAY['orders', 'risk', 'research']::TEXT[],
    telegram_enabled BOOLEAN NOT NULL DEFAULT FALSE CHECK (NOT telegram_enabled),
    email_enabled BOOLEAN NOT NULL DEFAULT FALSE CHECK (NOT email_enabled),
    PRIMARY KEY (tenant_id, subject_id),
    CHECK (events IN (ARRAY[]::TEXT[], ARRAY['orders'], ARRAY['risk'], ARRAY['research'],
        ARRAY['orders','risk'], ARRAY['orders','research'], ARRAY['risk','research'],
        ARRAY['orders','risk','research']))
);

CREATE TABLE astarter_private.notification_inbox (
    tenant_id astarter_private.identifier NOT NULL,
    subject_id astarter_private.identifier NOT NULL,
    event_id TEXT COLLATE "C" NOT NULL CHECK (event_id ~ '^[A-Za-z0-9:._-]{1,128}$')
        CHECK (event_id !~ '\msk-(or-v1-|proj-)?[A-Za-z0-9_-]{16,}|\m0x[0-9a-fA-F]{64}\M'),
    request_id TEXT COLLATE "C" NOT NULL CHECK (request_id ~ '^[A-Za-z0-9:_-]{8,96}$'),
    terminal_state TEXT NOT NULL CHECK (terminal_state IN ('complete', 'failed')),
    type TEXT NOT NULL CHECK (type IN ('research', 'risk')),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1200),
    created_at_ms astarter_private.milliseconds NOT NULL,
    read_at_ms astarter_private.milliseconds CHECK (read_at_ms >= created_at_ms),
    PRIMARY KEY (tenant_id, subject_id, event_id),
    UNIQUE (tenant_id, subject_id, request_id, terminal_state),
    FOREIGN KEY (tenant_id, subject_id, request_id)
        REFERENCES astarter_private.requests(tenant_id, subject_id, request_id)
);

CREATE TABLE astarter_private.workspace_preferences (
    tenant_id astarter_private.identifier NOT NULL,
    subject_id astarter_private.identifier NOT NULL,
    revision astarter_private.integer_amount NOT NULL DEFAULT 0,
    updated_at_ms astarter_private.milliseconds NOT NULL DEFAULT 0,
    preferences JSONB NOT NULL DEFAULT
        '{"workbenchFilter":"all","workbenchFocusAsset":null,"watchedAssets":[]}'::JSONB,
    drafts JSONB NOT NULL DEFAULT '[]'::JSONB,
    selected_draft_id TEXT,
    PRIMARY KEY (tenant_id, subject_id),
    CHECK (astarter_private.ui_workspace_valid(preferences, drafts, selected_draft_id))
);

CREATE TABLE astarter_private.ui_commands (
    tenant_id astarter_private.identifier NOT NULL,
    subject_id astarter_private.identifier NOT NULL,
    domain TEXT NOT NULL CHECK (domain IN ('notifications', 'workspace')),
    request_id TEXT COLLATE "C" NOT NULL CHECK (request_id ~ '^[A-Za-z0-9:_-]{8,96}$')
        CHECK (request_id !~ '\msk-(or-v1-|proj-)?[A-Za-z0-9_-]{16,}|\m0x[0-9a-fA-F]{64}\M'),
    fingerprint astarter_private.digest NOT NULL,
    base_revision astarter_private.integer_amount NOT NULL,
    revision astarter_private.integer_amount NOT NULL CHECK (revision >= base_revision),
    applied_at_ms astarter_private.milliseconds NOT NULL,
    original_result JSONB NOT NULL CHECK (
        jsonb_typeof(original_result) = 'object' AND
        original_result ?& ARRAY['request', 'state'] AND
        original_result - ARRAY['request', 'state'] = '{}'::JSONB AND
        jsonb_typeof(original_result->'request') = 'object' AND
        jsonb_typeof(original_result->'state') = 'object' AND
        octet_length(original_result::TEXT) <= 524288
    ),
    PRIMARY KEY (tenant_id, subject_id, domain, request_id),
    CHECK (original_result->'request' = jsonb_build_object(
        'schema', 'private-ui-command-v1', 'domain', domain, 'requestId', request_id,
        'status', 'applied', 'baseRevision', base_revision, 'revision', revision,
        'appliedAt', applied_at_ms)),
    CHECK (original_result->'state' @> jsonb_build_object(
        'schema', CASE domain WHEN 'workspace' THEN 'private-workspace-v1'
            ELSE 'private-notifications-v1' END,
        'scope', tenant_id, 'revision', revision)),
    CHECK (CASE domain WHEN 'workspace' THEN
        original_result->'state' ?& ARRAY['schema','scope','revision','updatedAt',
            'preferences','drafts','selectedDraftId','executionAuthority'] AND
        (original_result->'state') - ARRAY['schema','scope','revision','updatedAt',
            'preferences','drafts','selectedDraftId','executionAuthority'] = '{}'::JSONB AND
        original_result->'state'->>'executionAuthority' = 'NONE' AND
        jsonb_typeof(original_result->'state'->'selectedDraftId') IN ('null','string') AND
        astarter_private.ui_workspace_valid(original_result->'state'->'preferences',
            original_result->'state'->'drafts', original_result->'state'->>'selectedDraftId')
    ELSE
        original_result->'state' ?& ARRAY['schema','scope','revision','updatedAt','inapp','events',
            'services','channels','deliveries','inbox','unreadCount','nextCursor','mode'] AND
        (original_result->'state') - ARRAY['schema','scope','revision','updatedAt','inapp','events',
            'services','channels','deliveries','inbox','unreadCount','nextCursor','mode'] = '{}'::JSONB AND
        original_result->'state'->>'mode' = 'server-research-only' AND
        original_result->'state'->'deliveries' = '[]'::JSONB AND
        original_result->'state'->'services' = '{"telegram":{"available":false,"error":"CHANNEL_DISABLED"},"email":{"available":false,"error":"CHANNEL_DISABLED"}}'::JSONB AND
        original_result->'state'->'channels' = '{"telegram":{"channel":"telegram","label":"","enabled":0,"verified":0},"email":{"channel":"email","label":"","enabled":0,"verified":0}}'::JSONB
    END)
);
CREATE TRIGGER ui_commands_append_only BEFORE UPDATE OR DELETE ON astarter_private.ui_commands
    FOR EACH ROW EXECUTE FUNCTION astarter_private.audit_guard();

ALTER TABLE astarter_private.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE astarter_private.notification_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE astarter_private.workspace_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE astarter_private.ui_commands ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_preferences_read ON astarter_private.notification_preferences
    FOR SELECT TO astarter_private_runtime USING (
        astarter_private.ui_authorized(tenant_id::TEXT, subject_id::TEXT, 'notifications:read'));
CREATE POLICY notification_preferences_insert ON astarter_private.notification_preferences
    FOR INSERT TO astarter_private_runtime WITH CHECK (
        astarter_private.ui_authorized(tenant_id::TEXT, subject_id::TEXT, 'notifications:write'));
CREATE POLICY notification_preferences_update ON astarter_private.notification_preferences
    FOR UPDATE TO astarter_private_runtime USING (
        astarter_private.ui_authorized(tenant_id::TEXT, subject_id::TEXT, 'notifications:write'))
    WITH CHECK (astarter_private.ui_authorized(tenant_id::TEXT, subject_id::TEXT, 'notifications:write'));
CREATE POLICY notification_inbox_read ON astarter_private.notification_inbox
    FOR SELECT TO astarter_private_runtime USING (
        astarter_private.ui_authorized(tenant_id::TEXT, subject_id::TEXT, 'notifications:read'));
CREATE POLICY notification_inbox_update ON astarter_private.notification_inbox
    FOR UPDATE TO astarter_private_runtime USING (
        astarter_private.ui_authorized(tenant_id::TEXT, subject_id::TEXT, 'notifications:write'))
    WITH CHECK (astarter_private.ui_authorized(tenant_id::TEXT, subject_id::TEXT, 'notifications:write'));
CREATE POLICY workspace_preferences_read ON astarter_private.workspace_preferences
    FOR SELECT TO astarter_private_runtime USING (
        astarter_private.ui_authorized(tenant_id::TEXT, subject_id::TEXT, 'workspace:read'));
CREATE POLICY workspace_preferences_insert ON astarter_private.workspace_preferences
    FOR INSERT TO astarter_private_runtime WITH CHECK (
        astarter_private.ui_authorized(tenant_id::TEXT, subject_id::TEXT, 'workspace:write'));
CREATE POLICY workspace_preferences_update ON astarter_private.workspace_preferences
    FOR UPDATE TO astarter_private_runtime USING (
        astarter_private.ui_authorized(tenant_id::TEXT, subject_id::TEXT, 'workspace:write'))
    WITH CHECK (astarter_private.ui_authorized(tenant_id::TEXT, subject_id::TEXT, 'workspace:write'));
CREATE POLICY ui_commands_read ON astarter_private.ui_commands
    FOR SELECT TO astarter_private_runtime USING (
        astarter_private.ui_authorized(tenant_id::TEXT, subject_id::TEXT, domain || ':read'));
CREATE POLICY ui_commands_insert ON astarter_private.ui_commands
    FOR INSERT TO astarter_private_runtime WITH CHECK (
        astarter_private.ui_authorized(tenant_id::TEXT, subject_id::TEXT, domain || ':write'));

GRANT SELECT ON astarter_private.notification_preferences, astarter_private.notification_inbox,
    astarter_private.workspace_preferences, astarter_private.ui_commands TO astarter_private_runtime;
GRANT INSERT ON astarter_private.notification_preferences, astarter_private.workspace_preferences,
    astarter_private.ui_commands TO astarter_private_runtime;
GRANT UPDATE (revision, updated_at_ms, inapp, events, telegram_enabled, email_enabled)
    ON astarter_private.notification_preferences TO astarter_private_runtime;
GRANT UPDATE (revision, updated_at_ms, preferences, drafts, selected_draft_id)
    ON astarter_private.workspace_preferences TO astarter_private_runtime;
GRANT UPDATE (read_at_ms) ON astarter_private.notification_inbox TO astarter_private_runtime;

CREATE FUNCTION astarter_private.ui_research_terminal() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    owner_lock BIGINT;
    event_key TEXT;
    happened_at NUMERIC;
BEGIN
    IF OLD.state <> 'pending' OR NEW.state NOT IN ('complete', 'failed') THEN RETURN NEW; END IF;
    owner_lock := ('x' || substr(encode(sha256(convert_to(
        'private-ui:' || NEW.tenant_id || '|' || NEW.subject_id || '|notifications',
        'UTF8')), 'hex'), 1, 16))::BIT(64)::BIGINT;
    PERFORM pg_advisory_xact_lock(owner_lock);
    happened_at := floor(extract(epoch FROM clock_timestamp()) * 1000);
    event_key := 'research:' || encode(sha256(convert_to(jsonb_build_array(
        NEW.tenant_id, NEW.subject_id, NEW.request_id, NEW.state)::TEXT, 'UTF8')), 'hex');
    INSERT INTO astarter_private.notification_inbox
        (tenant_id, subject_id, event_id, request_id, terminal_state, type,
            title, body, created_at_ms, read_at_ms)
    VALUES (NEW.tenant_id, NEW.subject_id, event_key, NEW.request_id, NEW.state,
        CASE NEW.state WHEN 'complete' THEN 'research' ELSE 'risk' END,
        CASE NEW.state WHEN 'complete' THEN 'Research completed' ELSE 'Research failed' END,
        CASE NEW.state WHEN 'complete' THEN 'Your research request completed.'
            ELSE 'Your research request failed.' END, happened_at, NULL)
    ON CONFLICT (tenant_id, subject_id, request_id, terminal_state) DO NOTHING;
    IF FOUND THEN
        INSERT INTO astarter_private.notification_preferences
            (tenant_id, subject_id, revision, updated_at_ms)
        VALUES (NEW.tenant_id, NEW.subject_id, 1, happened_at)
        ON CONFLICT (tenant_id, subject_id) DO UPDATE SET
            revision = astarter_private.notification_preferences.revision + 1,
            updated_at_ms = happened_at;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION astarter_private.ui_research_terminal() FROM PUBLIC;
CREATE TRIGGER requests_ui_terminal AFTER UPDATE OF state ON astarter_private.requests
    FOR EACH ROW WHEN (OLD.state = 'pending' AND NEW.state IN ('complete', 'failed'))
    EXECUTE FUNCTION astarter_private.ui_research_terminal();
