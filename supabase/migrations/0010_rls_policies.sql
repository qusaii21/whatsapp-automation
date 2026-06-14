-- ============================================================
-- Migration 0010: Row-Level Security (RLS) Policies
-- ============================================================
-- Principles:
--   1. Default-deny: RLS enabled on every table, no policy = no access
--   2. Service role bypasses RLS (used only in server-side API routes)
--   3. Agents see only leads/conversations assigned to them or their team
--   4. Sensitive tables (webhook_events, ai_classifications raw fields)
--      are inaccessible to client-side queries
-- ============================================================

-- ============================================================
-- Enable RLS on all tables
-- ============================================================
ALTER TABLE leads               ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages            ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_notes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE followups           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_classifications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events      ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Helper: extract team_id from JWT claims
-- Requires custom claim set during sign-in via Supabase Auth hook
-- ============================================================
CREATE OR REPLACE FUNCTION auth_team_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
    SELECT NULLIF(
        (auth.jwt() -> 'app_metadata' ->> 'team_id'),
        ''
    )::UUID;
$$;

CREATE OR REPLACE FUNCTION auth_is_service_role()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
    SELECT (auth.jwt() ->> 'role') = 'service_role';
$$;

-- ============================================================
-- leads policies
-- ============================================================

-- Agents can read leads assigned to them or their team
CREATE POLICY leads_select ON leads
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL AND (
            assigned_agent_id = auth.uid() OR
            team_id = auth_team_id() OR
            auth_is_service_role()
        )
    );

-- Agents can insert new leads (service role for webhooks)
CREATE POLICY leads_insert ON leads
    FOR INSERT TO authenticated
    WITH CHECK (
        auth_is_service_role() OR
        team_id = auth_team_id()
    );

-- Agents can update leads they own or in their team
CREATE POLICY leads_update ON leads
    FOR UPDATE TO authenticated
    USING (
        deleted_at IS NULL AND (
            assigned_agent_id = auth.uid() OR
            team_id = auth_team_id() OR
            auth_is_service_role()
        )
    )
    WITH CHECK (
        team_id = auth_team_id() OR
        auth_is_service_role()
    );

-- Only service role can hard-delete (soft-delete via UPDATE deleted_at)
CREATE POLICY leads_delete ON leads
    FOR DELETE TO authenticated
    USING (auth_is_service_role());

-- ============================================================
-- conversations policies
-- ============================================================

CREATE POLICY conversations_select ON conversations
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM leads l
            WHERE l.id = conversations.lead_id
              AND l.deleted_at IS NULL
              AND (
                  l.assigned_agent_id = auth.uid() OR
                  l.team_id = auth_team_id() OR
                  auth_is_service_role()
              )
        )
    );

CREATE POLICY conversations_insert ON conversations
    FOR INSERT TO authenticated
    WITH CHECK (
        auth_is_service_role() OR
        team_id = auth_team_id()
    );

CREATE POLICY conversations_update ON conversations
    FOR UPDATE TO authenticated
    USING (
        assigned_agent_id = auth.uid() OR
        team_id = auth_team_id() OR
        auth_is_service_role()
    );

-- ============================================================
-- messages policies
-- ============================================================

CREATE POLICY messages_select ON messages
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM conversations c
            JOIN leads l ON l.id = c.lead_id
            WHERE c.id = messages.conversation_id
              AND l.deleted_at IS NULL
              AND (
                  l.assigned_agent_id = auth.uid() OR
                  l.team_id = auth_team_id() OR
                  auth_is_service_role()
              )
        )
    );

-- Agents and AI bot (service role) can insert messages
CREATE POLICY messages_insert ON messages
    FOR INSERT TO authenticated
    WITH CHECK (
        auth_is_service_role() OR
        sender_agent_id = auth.uid()
    );

-- Only service role can update delivery status (from WhatsApp callbacks)
CREATE POLICY messages_update ON messages
    FOR UPDATE TO authenticated
    USING (auth_is_service_role());

-- ============================================================
-- lead_notes policies
-- ============================================================

CREATE POLICY lead_notes_select ON lead_notes
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL AND
        EXISTS (
            SELECT 1 FROM leads l
            WHERE l.id = lead_notes.lead_id
              AND l.deleted_at IS NULL
              AND (
                  l.assigned_agent_id = auth.uid() OR
                  l.team_id = auth_team_id() OR
                  auth_is_service_role()
              )
        )
    );

CREATE POLICY lead_notes_insert ON lead_notes
    FOR INSERT TO authenticated
    WITH CHECK (agent_id = auth.uid() OR auth_is_service_role());

-- Agents can only edit their own notes
CREATE POLICY lead_notes_update ON lead_notes
    FOR UPDATE TO authenticated
    USING (agent_id = auth.uid() OR auth_is_service_role());

-- Agents can soft-delete their own notes (set deleted_at)
CREATE POLICY lead_notes_delete ON lead_notes
    FOR DELETE TO authenticated
    USING (agent_id = auth.uid() OR auth_is_service_role());

-- ============================================================
-- followups policies
-- ============================================================

CREATE POLICY followups_select ON followups
    FOR SELECT TO authenticated
    USING (
        assigned_agent_id = auth.uid() OR
        auth_is_service_role()
    );

CREATE POLICY followups_insert ON followups
    FOR INSERT TO authenticated
    WITH CHECK (
        auth_is_service_role()
    );

CREATE POLICY followups_update ON followups
    FOR UPDATE TO authenticated
    USING (
        assigned_agent_id = auth.uid() OR
        auth_is_service_role()
    );

-- ============================================================
-- ai_classifications policies
-- ============================================================
-- Dashboard agents can read classification summaries.
-- Raw prompt/completion fields are redacted via view (see functions).

CREATE POLICY ai_classifications_select ON ai_classifications
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM leads l
            WHERE l.id = ai_classifications.lead_id
              AND (
                  l.assigned_agent_id = auth.uid() OR
                  l.team_id = auth_team_id() OR
                  auth_is_service_role()
              )
        )
    );

-- Only service role writes AI results
CREATE POLICY ai_classifications_insert ON ai_classifications
    FOR INSERT TO authenticated
    WITH CHECK (auth_is_service_role());

CREATE POLICY ai_classifications_update ON ai_classifications
    FOR UPDATE TO authenticated
    USING (auth_is_service_role());

-- ============================================================
-- webhook_events policies
-- ============================================================
-- No direct client access. Service role only.

CREATE POLICY webhook_events_service_role_only ON webhook_events
    FOR ALL TO authenticated
    USING (auth_is_service_role())
    WITH CHECK (auth_is_service_role());

-- ============================================================
-- Redacted view for ai_classifications
-- Exposes summary fields to agents, hides raw_prompt/raw_completion
-- ============================================================
CREATE OR REPLACE VIEW ai_classifications_summary
    WITH (security_invoker = true)
AS
SELECT
    id,
    lead_id,
    message_id,
    conversation_id,
    intent,
    confidence,
    sentiment,
    sentiment_score,
    qualification_score,
    summary,
    suggested_action,
    action_taken,
    action_taken_at,
    model_provider,
    model_name,
    -- raw_prompt and raw_completion intentionally excluded
    created_at
FROM ai_classifications;

COMMENT ON VIEW ai_classifications_summary IS 'Redacted view — raw_prompt and raw_completion are excluded for agents';
