-- R3 PRIVATE draft contents. Existing UI DTOs/receipts and financial tables are unchanged.
ALTER TABLE astarter_private.metadata DROP CONSTRAINT metadata_schema_version_check;
ALTER TABLE astarter_private.metadata ADD CONSTRAINT metadata_schema_version_check
    CHECK (schema_version IN (1, 2, 3));

CREATE TABLE astarter_private.draft_versions (
    tenant_id astarter_private.identifier NOT NULL,
    subject_id astarter_private.identifier NOT NULL,
    draft_id TEXT COLLATE "C" NOT NULL CHECK (draft_id ~ '^[A-Za-z0-9:_-]{1,96}$'),
    revision astarter_private.integer_amount NOT NULL CHECK (revision >= 1),
    source_request_id TEXT COLLATE "C" NOT NULL,
    saved_at_ms astarter_private.milliseconds NOT NULL,
    content JSONB NOT NULL CHECK ((
        jsonb_typeof(content) = 'object' AND octet_length(content::TEXT) <= 32768 AND
        content ?& ARRAY['catalogVersion','templateVersion','parameterOrigin','source','fields',
            'missingFields','executionAuthority'] AND
        content - ARRAY['catalogVersion','templateVersion','parameterOrigin','source','fields',
            'missingFields','executionAuthority'] = '{}'::JSONB AND
        content->>'catalogVersion' = 'private-paper-draft-v1' AND
        content->>'templateVersion' IN ('S01-SIM@paper-v1','S02-SIM@paper-v1') AND
        content->>'parameterOrigin' = 'user-confirmed' AND content->>'executionAuthority' = 'NONE' AND
        jsonb_typeof(content->'fields') = 'object' AND
        (content->'fields') ?& ARRAY['name','strategy','planVariant','market','environment','mode',
            'amount','cap','researchBudget','botParameters','protection','executionRoute'] AND
        (content->'fields') - ARRAY['name','strategy','planVariant','market','environment','mode',
            'amount','cap','researchBudget','botParameters','protection','executionRoute'] = '{}'::JSONB AND
        content->'fields'->>'strategy' IN ('S01','S02') AND
        content->'fields'->>'planVariant' = (content->'fields'->>'strategy') || '-SIM' AND
        content->>'templateVersion' = (content->'fields'->>'planVariant') || '@paper-v1' AND
        content->'fields'->>'environment' = 'DEMO' AND content->'fields'->>'mode' = 'auto' AND
        content->'fields'->>'market' IN ('BTC/USDT','ETH/USDT','SOL/USDT') AND
        jsonb_typeof(content->'missingFields') = 'array' AND
        jsonb_array_length(content->'missingFields') <= 24 AND
        jsonb_typeof(content->'source') = 'object' AND
        (content->'source') ?& ARRAY['kind','sourceRequestId','requestFingerprint','reportRevision',
            'evidenceRevision','symbol','evidenceId','methodVersion','createdAt','validUntil',
            'sourceClock'] AND
        (content->'source') - ARRAY['kind','sourceRequestId','requestFingerprint','reportRevision',
            'evidenceRevision','symbol','evidenceId','methodVersion','createdAt','validUntil',
            'sourceClock'] = '{}'::JSONB AND
        content->'source'->>'kind' = 'private-research-request' AND
        content->'source'->>'sourceRequestId' = source_request_id AND
        content->'source'->>'methodVersion' = 'closed-market-research-v1' AND
        (content->'source'->>'symbol') || '/USDT' = content->'fields'->>'market' AND
        content->'source'->>'requestFingerprint' ~ '^[a-f0-9]{64}$' AND
        content->'source'->>'reportRevision' ~ '^[a-f0-9]{64}$' AND
        content->'source'->>'evidenceRevision' ~ '^[a-f0-9]{64}$' AND
        content->'source'->>'evidenceId' ~ '^market-[a-f0-9]{32}$' AND
        astarter_private.ui_workspace_valid(
            '{"workbenchFilter":"all","workbenchFocusAsset":null,"watchedAssets":[]}'::JSONB,
            jsonb_build_array(jsonb_build_object('id',draft_id,
                'strategyId',content->'fields'->>'strategy','name',content->'fields'->>'name')),draft_id)
    ) IS TRUE),
    PRIMARY KEY (tenant_id,subject_id,draft_id,revision),
    FOREIGN KEY (tenant_id,subject_id,source_request_id)
        REFERENCES astarter_private.requests(tenant_id,subject_id,request_id)
);
CREATE TABLE astarter_private.draft_heads (
    tenant_id astarter_private.identifier NOT NULL,
    subject_id astarter_private.identifier NOT NULL,
    draft_id TEXT COLLATE "C" NOT NULL,
    revision astarter_private.integer_amount NOT NULL CHECK (revision >= 1),
    PRIMARY KEY (tenant_id,subject_id,draft_id),
    FOREIGN KEY (tenant_id,subject_id,draft_id,revision)
        REFERENCES astarter_private.draft_versions(tenant_id,subject_id,draft_id,revision)
);
CREATE TABLE astarter_private.draft_commands (
    tenant_id astarter_private.identifier NOT NULL,
    subject_id astarter_private.identifier NOT NULL,
    request_id TEXT COLLATE "C" NOT NULL CHECK (request_id ~ '^[A-Za-z0-9:_-]{8,96}$'),
    fingerprint astarter_private.digest NOT NULL,
    draft_id TEXT COLLATE "C" NOT NULL,
    expected_revision astarter_private.integer_amount NOT NULL,
    revision astarter_private.integer_amount NOT NULL CHECK (revision=expected_revision+1),
    workspace_base_revision astarter_private.integer_amount NOT NULL,
    workspace_revision astarter_private.integer_amount NOT NULL
        CHECK (workspace_revision BETWEEN workspace_base_revision AND workspace_base_revision+1),
    applied_at_ms astarter_private.milliseconds NOT NULL,
    PRIMARY KEY (tenant_id,subject_id,request_id),
    FOREIGN KEY (tenant_id,subject_id,draft_id,revision)
        REFERENCES astarter_private.draft_versions(tenant_id,subject_id,draft_id,revision)
);

CREATE TRIGGER draft_versions_append_only BEFORE UPDATE OR DELETE ON astarter_private.draft_versions
    FOR EACH ROW EXECUTE FUNCTION astarter_private.audit_guard();
CREATE TRIGGER draft_commands_append_only BEFORE UPDATE OR DELETE ON astarter_private.draft_commands
    FOR EACH ROW EXECUTE FUNCTION astarter_private.audit_guard();

CREATE FUNCTION astarter_private.draft_head_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF (TG_OP='INSERT' AND NEW.revision<>1) OR (TG_OP='UPDATE' AND
        ((NEW.tenant_id,NEW.subject_id,NEW.draft_id) IS DISTINCT FROM
         (OLD.tenant_id,OLD.subject_id,OLD.draft_id) OR NEW.revision<>OLD.revision+1)) THEN
        RAISE EXCEPTION USING MESSAGE='PRIVATE_DRAFT_HEAD_CONFLICT';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION astarter_private.draft_head_guard() FROM PUBLIC;
CREATE TRIGGER draft_head_revision BEFORE INSERT OR UPDATE ON astarter_private.draft_heads
    FOR EACH ROW EXECUTE FUNCTION astarter_private.draft_head_guard();

CREATE FUNCTION astarter_private.draft_workspace_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    -- Legacy summary removal hides the entry; it never rewrites or deletes version content.
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.drafts) item
        JOIN astarter_private.draft_heads h ON h.tenant_id=NEW.tenant_id
            AND h.subject_id=NEW.subject_id AND h.draft_id=item->>'id'
        JOIN astarter_private.draft_versions v USING(tenant_id,subject_id,draft_id,revision)
        WHERE (item->>'strategyId',item->>'name') IS DISTINCT FROM
            (v.content->'fields'->>'strategy',v.content->'fields'->>'name')
    ) THEN RAISE EXCEPTION USING MESSAGE='PRIVATE_DRAFT_METADATA_CONFLICT'; END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION astarter_private.draft_workspace_guard() FROM PUBLIC;
CREATE TRIGGER workspace_draft_consistency BEFORE INSERT OR UPDATE ON astarter_private.workspace_preferences
    FOR EACH ROW EXECUTE FUNCTION astarter_private.draft_workspace_guard();

ALTER TABLE astarter_private.draft_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE astarter_private.draft_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE astarter_private.draft_commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY draft_versions_read ON astarter_private.draft_versions
    FOR SELECT TO astarter_private_runtime
    USING(astarter_private.ui_authorized(tenant_id,subject_id,'workspace:read'));
CREATE POLICY draft_versions_insert ON astarter_private.draft_versions
    FOR INSERT TO astarter_private_runtime
    WITH CHECK(astarter_private.ui_authorized(tenant_id,subject_id,'workspace:write'));
CREATE POLICY draft_heads_read ON astarter_private.draft_heads
    FOR SELECT TO astarter_private_runtime
    USING(astarter_private.ui_authorized(tenant_id,subject_id,'workspace:read'));
CREATE POLICY draft_heads_insert ON astarter_private.draft_heads
    FOR INSERT TO astarter_private_runtime
    WITH CHECK(astarter_private.ui_authorized(tenant_id,subject_id,'workspace:write'));
CREATE POLICY draft_heads_update ON astarter_private.draft_heads
    FOR UPDATE TO astarter_private_runtime
    USING(astarter_private.ui_authorized(tenant_id,subject_id,'workspace:write'))
    WITH CHECK(astarter_private.ui_authorized(tenant_id,subject_id,'workspace:write'));
CREATE POLICY draft_commands_read ON astarter_private.draft_commands
    FOR SELECT TO astarter_private_runtime
    USING(astarter_private.ui_authorized(tenant_id,subject_id,'workspace:read'));
CREATE POLICY draft_commands_insert ON astarter_private.draft_commands
    FOR INSERT TO astarter_private_runtime
    WITH CHECK(astarter_private.ui_authorized(tenant_id,subject_id,'workspace:write'));
GRANT SELECT,INSERT ON astarter_private.draft_versions,astarter_private.draft_heads,
    astarter_private.draft_commands TO astarter_private_runtime;
GRANT UPDATE(revision) ON astarter_private.draft_heads TO astarter_private_runtime;
