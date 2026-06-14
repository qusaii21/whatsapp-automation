-- ============================================================
-- Migration 0014: Add organization_id to all tenant tables
-- ============================================================
-- This migration retrofits every table created in 0002–0008 with
-- a proper organization_id FK to organizations.id.
--
-- Changes per table:
--   leads             — add org FK; replace global UNIQUE(phone,channel)
--                       with per-org UNIQUE(org,phone,channel);
--                       drop team_id column; update all existing indexes
--   conversations     — add org FK; drop team_id stub
--   messages          — add org FK (denormalized for query performance
--                       and partition-readiness — avoids JOIN to
--                       conversations on every message query)
--   lead_notes        — add org FK
--   followups         — add org FK; drop team_id stub
--   ai_classifications— add org FK
--   webhook_events    — add org FK (nullable; set after page→org routing)
--
-- RLS policies:
--   All old team_id-based policies are dropped and replaced with
--   organization_id-based policies.
--
-- Functions:
--   upsert_lead_from_meta_ad()      — receives p_organization_id
--   get_or_create_open_conversation()— receives p_organization_id
--   get_lead_conversation_summary() — unchanged (uses lead_id)
-- ============================================================

-- ============================================================
-- STEP 1: Add organization_id columns (nullable first for backfill)
-- ============================================================

ALTER TABLE leads               ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE conversations       ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE messages            ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE lead_notes          ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE followups           ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ai_classifications  ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE webhook_events      ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

-- ============================================================
-- STEP 2: Backfill — create a default "Migrated" organization
-- for any existing rows (dev/staging only; prod should have 0 rows)
-- ============================================================
DO $$
DECLARE
    v_org_id UUID;
BEGIN
    -- Only backfill if there are existing rows without org
    IF EXISTS (SELECT 1 FROM leads WHERE organization_id IS NULL LIMIT 1) THEN
        INSERT INTO organizations (name, slug, plan)
        VALUES ('Migrated Organization', 'migrated-org-' || gen_random_uuid()::TEXT, 'free')
        RETURNING id INTO v_org_id;

        UPDATE leads              SET organization_id = v_org_id WHERE organization_id IS NULL;
        UPDATE conversations      SET organization_id = v_org_id WHERE organization_id IS NULL;
        UPDATE messages           SET organization_id = v_org_id WHERE organization_id IS NULL;
        UPDATE lead_notes         SET organization_id = v_org_id WHERE organization_id IS NULL;
        UPDATE followups          SET organization_id = v_org_id WHERE organization_id IS NULL;
        UPDATE ai_classifications SET organization_id = v_org_id WHERE organization_id IS NULL;
        -- webhook_events intentionally left nullable (org resolved during processing)
    END IF;
END;
$$;

-- ============================================================
-- STEP 3: Enforce NOT NULL now that backfill is done
-- (webhook_events.organization_id stays nullable — org resolved async)
-- ============================================================
ALTER TABLE leads               ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE conversations       ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE messages            ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE lead_notes          ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE followups           ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE ai_classifications  ALTER COLUMN organization_id SET NOT NULL;

-- ============================================================
-- STEP 4: Drop all old RLS policies (team_id-based) BEFORE dropping columns
-- ============================================================
DROP POLICY IF EXISTS leads_select       ON leads;
DROP POLICY IF EXISTS leads_insert       ON leads;
DROP POLICY IF EXISTS leads_update       ON leads;
DROP POLICY IF EXISTS leads_delete       ON leads;

DROP POLICY IF EXISTS conversations_select ON conversations;
DROP POLICY IF EXISTS conversations_insert ON conversations;
DROP POLICY IF EXISTS conversations_update ON conversations;

DROP POLICY IF EXISTS messages_select   ON messages;
DROP POLICY IF EXISTS messages_insert   ON messages;
DROP POLICY IF EXISTS messages_update   ON messages;

DROP POLICY IF EXISTS lead_notes_select  ON lead_notes;
DROP POLICY IF EXISTS lead_notes_insert  ON lead_notes;
DROP POLICY IF EXISTS lead_notes_update  ON lead_notes;
DROP POLICY IF EXISTS lead_notes_delete  ON lead_notes;

DROP POLICY IF EXISTS followups_select   ON followups;
DROP POLICY IF EXISTS followups_insert   ON followups;
DROP POLICY IF EXISTS followups_update   ON followups;

DROP POLICY IF EXISTS ai_classifications_select ON ai_classifications;
DROP POLICY IF EXISTS ai_classifications_insert ON ai_classifications;
DROP POLICY IF EXISTS ai_classifications_update ON ai_classifications;

DROP POLICY IF EXISTS webhook_events_service_role_only ON webhook_events;

-- ============================================================
-- STEP 5: Drop team_id stubs (no FK, no backing table — was placeholder)
-- ============================================================
ALTER TABLE leads          DROP COLUMN IF EXISTS team_id;
ALTER TABLE conversations  DROP COLUMN IF EXISTS team_id;
ALTER TABLE followups      DROP COLUMN IF EXISTS team_id;

-- ============================================================
-- STEP 6: Update unique constraints on leads
-- ============================================================

-- Drop global constraint: (phone_e164, channel)
-- A lead is now unique per organization, not globally
ALTER TABLE leads DROP CONSTRAINT uq_lead_phone_channel;

-- Add per-org unique constraint
ALTER TABLE leads ADD CONSTRAINT uq_lead_org_phone_channel
    UNIQUE NULLS NOT DISTINCT (organization_id, phone_e164, channel);

-- meta_lead_id stays globally unique — Meta IDs are globally unique
-- (no change needed for uq_meta_lead_id)

-- ============================================================
-- STEP 6: Drop stale team_id-based indexes and replace
-- ============================================================

-- leads: was (team_id, created_at)
DROP INDEX IF EXISTS idx_leads_team_id;

CREATE INDEX idx_leads_org_id
    ON leads (organization_id, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_leads_org_status
    ON leads (organization_id, status, created_at DESC)
    WHERE deleted_at IS NULL;

-- conversations
CREATE INDEX idx_conversations_org_id
    ON conversations (organization_id, created_at DESC);

-- messages
CREATE INDEX idx_messages_org_id
    ON messages (organization_id, created_at DESC);

-- lead_notes
CREATE INDEX idx_lead_notes_org_id
    ON lead_notes (organization_id, created_at DESC)
    WHERE deleted_at IS NULL;

-- followups
CREATE INDEX idx_followups_org_id
    ON followups (organization_id, scheduled_at ASC)
    WHERE status = 'pending';

-- ai_classifications
CREATE INDEX idx_ai_classifications_org_id
    ON ai_classifications (organization_id, created_at DESC);

-- webhook_events
CREATE INDEX idx_webhook_events_org_id
    ON webhook_events (organization_id, received_at DESC)
    WHERE organization_id IS NOT NULL;

-- ============================================================
-- STEP 7: New organization_id-based RLS policies
-- ============================================================

-- ---- leads ----
CREATE POLICY leads_select ON leads
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL AND (
            organization_id = auth_organization_id() OR
            auth_is_service_role()
        )
    );

CREATE POLICY leads_insert ON leads
    FOR INSERT TO authenticated
    WITH CHECK (
        auth_is_service_role() OR
        organization_id = auth_organization_id()
    );

CREATE POLICY leads_update ON leads
    FOR UPDATE TO authenticated
    USING (
        deleted_at IS NULL AND (
            organization_id = auth_organization_id() OR
            auth_is_service_role()
        )
    )
    WITH CHECK (
        organization_id = auth_organization_id() OR
        auth_is_service_role()
    );

CREATE POLICY leads_delete ON leads
    FOR DELETE TO authenticated
    USING (auth_is_service_role());

-- ---- conversations ----
CREATE POLICY conversations_select ON conversations
    FOR SELECT TO authenticated
    USING (
        organization_id = auth_organization_id() OR
        auth_is_service_role()
    );

CREATE POLICY conversations_insert ON conversations
    FOR INSERT TO authenticated
    WITH CHECK (
        auth_is_service_role() OR
        organization_id = auth_organization_id()
    );

CREATE POLICY conversations_update ON conversations
    FOR UPDATE TO authenticated
    USING (
        organization_id = auth_organization_id() OR
        auth_is_service_role()
    );

-- ---- messages ----
CREATE POLICY messages_select ON messages
    FOR SELECT TO authenticated
    USING (
        organization_id = auth_organization_id() OR
        auth_is_service_role()
    );

CREATE POLICY messages_insert ON messages
    FOR INSERT TO authenticated
    WITH CHECK (
        auth_is_service_role() OR
        (organization_id = auth_organization_id() AND sender_agent_id = auth.uid())
    );

CREATE POLICY messages_update ON messages
    FOR UPDATE TO authenticated
    USING (auth_is_service_role());

-- ---- lead_notes ----
CREATE POLICY lead_notes_select ON lead_notes
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL AND (
            organization_id = auth_organization_id() OR
            auth_is_service_role()
        )
    );

CREATE POLICY lead_notes_insert ON lead_notes
    FOR INSERT TO authenticated
    WITH CHECK (
        (organization_id = auth_organization_id() AND agent_id = auth.uid()) OR
        auth_is_service_role()
    );

CREATE POLICY lead_notes_update ON lead_notes
    FOR UPDATE TO authenticated
    USING (
        (organization_id = auth_organization_id() AND agent_id = auth.uid()) OR
        auth_is_service_role()
    );

CREATE POLICY lead_notes_delete ON lead_notes
    FOR DELETE TO authenticated
    USING (
        (organization_id = auth_organization_id() AND agent_id = auth.uid()) OR
        auth_is_service_role()
    );

-- ---- followups ----
CREATE POLICY followups_select ON followups
    FOR SELECT TO authenticated
    USING (
        organization_id = auth_organization_id() OR
        auth_is_service_role()
    );

CREATE POLICY followups_insert ON followups
    FOR INSERT TO authenticated
    WITH CHECK (
        auth_is_service_role() OR
        organization_id = auth_organization_id()
    );

CREATE POLICY followups_update ON followups
    FOR UPDATE TO authenticated
    USING (
        organization_id = auth_organization_id() OR
        auth_is_service_role()
    );

-- ---- ai_classifications ----
CREATE POLICY ai_classifications_select ON ai_classifications
    FOR SELECT TO authenticated
    USING (
        organization_id = auth_organization_id() OR
        auth_is_service_role()
    );

CREATE POLICY ai_classifications_insert ON ai_classifications
    FOR INSERT TO authenticated
    WITH CHECK (auth_is_service_role());

CREATE POLICY ai_classifications_update ON ai_classifications
    FOR UPDATE TO authenticated
    USING (auth_is_service_role());

-- ---- webhook_events ----
CREATE POLICY webhook_events_service_role_only ON webhook_events
    FOR ALL TO authenticated
    USING (auth_is_service_role())
    WITH CHECK (auth_is_service_role());

-- ============================================================
-- STEP 9: Replace upsert_lead_from_meta_ad with org-aware version
-- ============================================================
-- Drop the old signature (PostgreSQL requires DROP for parameter changes)
DROP FUNCTION IF EXISTS upsert_lead_from_meta_ad(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB);

CREATE OR REPLACE FUNCTION upsert_lead_from_meta_ad(
    p_organization_id   UUID,
    p_meta_lead_id      TEXT,
    p_phone_e164        TEXT,
    p_name              TEXT,
    p_email             TEXT,
    p_ad_id             TEXT,
    p_ad_name           TEXT,
    p_ad_set_id         TEXT,
    p_ad_set_name       TEXT,
    p_form_id           TEXT,
    p_campaign_id       TEXT,
    p_campaign_name     TEXT,
    p_source_url        TEXT DEFAULT NULL,
    p_metadata          JSONB DEFAULT '{}'
)
RETURNS leads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_lead leads;
BEGIN
    -- Fast dedup: meta_lead_id is globally unique
    SELECT * INTO v_lead FROM leads WHERE meta_lead_id = p_meta_lead_id;
    IF FOUND THEN
        RETURN v_lead;
    END IF;

    INSERT INTO leads (
        organization_id,
        phone_e164, email, name,
        channel,
        meta_lead_id,
        ad_id, ad_name, form_id,
        campaign_id, campaign_name,
        metadata
    )
    VALUES (
        p_organization_id,
        p_phone_e164, p_email, p_name,
        'whatsapp',
        p_meta_lead_id,
        p_ad_id, p_ad_name, p_form_id,
        p_campaign_id, p_campaign_name,
        -- Merge ad set, source, and custom fields into metadata
        jsonb_build_object(
            'ad_set_id',    p_ad_set_id,
            'ad_set_name',  p_ad_set_name,
            'source_url',   p_source_url
        ) || p_metadata
    )
    -- Per-org dedup: same phone + channel in same org
    ON CONFLICT (organization_id, phone_e164, channel) DO UPDATE
        SET
            meta_lead_id    = COALESCE(leads.meta_lead_id, EXCLUDED.meta_lead_id),
            email           = COALESCE(leads.email, EXCLUDED.email),
            name            = COALESCE(leads.name, EXCLUDED.name),
            ad_id           = COALESCE(leads.ad_id, EXCLUDED.ad_id),
            campaign_id     = COALESCE(leads.campaign_id, EXCLUDED.campaign_id),
            metadata        = leads.metadata || EXCLUDED.metadata,
            updated_at      = now()
    RETURNING * INTO v_lead;

    -- Increment integration counter (best-effort; ignore failure)
    UPDATE meta_integrations
    SET
        total_leads_ingested    = total_leads_ingested + 1,
        last_successful_lead_at = now()
    WHERE organization_id = p_organization_id
      AND p_form_id = ANY(COALESCE(allowed_form_ids, ARRAY[p_form_id]));

    RETURN v_lead;
END;
$$;

-- ============================================================
-- STEP 10: Update get_or_create_open_conversation with org_id
-- ============================================================
DROP FUNCTION IF EXISTS get_or_create_open_conversation(UUID, channel_type);

CREATE OR REPLACE FUNCTION get_or_create_open_conversation(
    p_organization_id   UUID,
    p_lead_id           UUID,
    p_channel           channel_type DEFAULT 'whatsapp'
)
RETURNS conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_conversation conversations;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext(p_lead_id::TEXT));

    SELECT * INTO v_conversation
    FROM conversations
    WHERE organization_id = p_organization_id
      AND lead_id = p_lead_id
      AND channel = p_channel
      AND status = 'open';

    IF NOT FOUND THEN
        INSERT INTO conversations (organization_id, lead_id, channel, status)
        VALUES (p_organization_id, p_lead_id, p_channel, 'open')
        RETURNING * INTO v_conversation;
    END IF;

    RETURN v_conversation;
END;
$$;

-- ============================================================
-- STEP 11: Comments on new columns
-- ============================================================
COMMENT ON COLUMN leads.organization_id             IS 'Tenant owner — hard FK enforces complete isolation';
COMMENT ON COLUMN conversations.organization_id     IS 'Denormalized from leads for direct tenant-filtered queries';
COMMENT ON COLUMN messages.organization_id          IS 'Denormalized for partition-readiness and index efficiency';
COMMENT ON COLUMN lead_notes.organization_id        IS 'Tenant scope';
COMMENT ON COLUMN followups.organization_id         IS 'Tenant scope';
COMMENT ON COLUMN ai_classifications.organization_id IS 'Tenant scope';
COMMENT ON COLUMN webhook_events.organization_id    IS 'Resolved from page_id after event is received; NULL until routing completes';
