-- ============================================================
-- Migration 0011: Utility Functions & Stored Procedures
-- ============================================================
-- All functions use SECURITY DEFINER with explicit search_path
-- to prevent search_path injection attacks.
-- ============================================================

-- ============================================================
-- upsert_lead_from_meta_ad
-- ============================================================
-- Called by the webhook handler to idempotently create or
-- return an existing lead from a Meta Lead Ad event.
-- Uses meta_lead_id as the idempotency key.
-- Returns the lead row (new or existing).
-- ============================================================
CREATE OR REPLACE FUNCTION upsert_lead_from_meta_ad(
    p_meta_lead_id  TEXT,
    p_phone_e164    TEXT,
    p_name          TEXT,
    p_email         TEXT,
    p_ad_id         TEXT,
    p_ad_name       TEXT,
    p_form_id       TEXT,
    p_campaign_id   TEXT,
    p_campaign_name TEXT,
    p_metadata      JSONB DEFAULT '{}'
)
RETURNS leads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_lead leads;
BEGIN
    -- Attempt to find by meta_lead_id first (cheapest dedup check)
    SELECT * INTO v_lead FROM leads WHERE meta_lead_id = p_meta_lead_id;

    IF FOUND THEN
        RETURN v_lead;
    END IF;

    -- Insert new lead; if a duplicate phone+channel exists, return that row
    INSERT INTO leads (
        phone_e164, email, name, channel,
        meta_lead_id, ad_id, ad_name, form_id,
        campaign_id, campaign_name, metadata
    )
    VALUES (
        p_phone_e164, p_email, p_name, 'whatsapp',
        p_meta_lead_id, p_ad_id, p_ad_name, p_form_id,
        p_campaign_id, p_campaign_name, p_metadata
    )
    ON CONFLICT (phone_e164, channel) DO UPDATE
        SET
            -- Update enrichment fields if the lead was created by phone first
            meta_lead_id    = EXCLUDED.meta_lead_id,
            email           = COALESCE(leads.email, EXCLUDED.email),
            name            = COALESCE(leads.name, EXCLUDED.name),
            ad_id           = COALESCE(leads.ad_id, EXCLUDED.ad_id),
            campaign_id     = COALESCE(leads.campaign_id, EXCLUDED.campaign_id),
            metadata        = leads.metadata || EXCLUDED.metadata,
            updated_at      = now()
    RETURNING * INTO v_lead;

    RETURN v_lead;
END;
$$;

-- ============================================================
-- get_or_create_open_conversation
-- ============================================================
-- Returns the open conversation for a lead+channel, or creates one.
-- Guaranteed atomic — no race condition via advisory lock on lead_id.
-- ============================================================
CREATE OR REPLACE FUNCTION get_or_create_open_conversation(
    p_lead_id   UUID,
    p_channel   channel_type DEFAULT 'whatsapp'
)
RETURNS conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_conversation conversations;
BEGIN
    -- Advisory lock scoped to this lead to prevent concurrent inserts
    PERFORM pg_advisory_xact_lock(hashtext(p_lead_id::TEXT));

    SELECT * INTO v_conversation
    FROM conversations
    WHERE lead_id = p_lead_id
      AND channel = p_channel
      AND status = 'open';

    IF NOT FOUND THEN
        INSERT INTO conversations (lead_id, channel, status)
        VALUES (p_lead_id, p_channel, 'open')
        RETURNING * INTO v_conversation;
    END IF;

    RETURN v_conversation;
END;
$$;

-- ============================================================
-- insert_message_idempotent
-- ============================================================
-- Inserts a message only if whatsapp_message_id has not been seen.
-- Returns the existing row on duplicate (safe replay).
-- ============================================================
CREATE OR REPLACE FUNCTION insert_message_idempotent(
    p_conversation_id       UUID,
    p_lead_id               UUID,
    p_direction             message_direction,
    p_sender_type           message_sender_type,
    p_whatsapp_message_id   TEXT,
    p_message_type          TEXT,
    p_content               TEXT,
    p_raw_payload           JSONB DEFAULT '{}',
    p_sender_agent_id       UUID DEFAULT NULL
)
RETURNS messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_message messages;
BEGIN
    -- Check for duplicate first (avoids write lock on hot path)
    SELECT * INTO v_message
    FROM messages
    WHERE whatsapp_message_id = p_whatsapp_message_id;

    IF FOUND THEN
        RETURN v_message;
    END IF;

    INSERT INTO messages (
        conversation_id, lead_id, direction, sender_type,
        whatsapp_message_id, message_type, content,
        raw_payload, sender_agent_id
    )
    VALUES (
        p_conversation_id, p_lead_id, p_direction, p_sender_type,
        p_whatsapp_message_id, p_message_type, p_content,
        p_raw_payload, p_sender_agent_id
    )
    ON CONFLICT (whatsapp_message_id) DO NOTHING
    RETURNING * INTO v_message;

    -- If DO NOTHING fired, fetch the existing row
    IF v_message IS NULL THEN
        SELECT * INTO v_message FROM messages
        WHERE whatsapp_message_id = p_whatsapp_message_id;
    END IF;

    RETURN v_message;
END;
$$;

-- ============================================================
-- mark_followups_overdue
-- ============================================================
-- Called by pg_cron every 15 minutes to transition stale pending
-- follow-ups to 'overdue'.
-- ============================================================
CREATE OR REPLACE FUNCTION mark_followups_overdue()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE followups
    SET status = 'overdue', updated_at = now()
    WHERE status = 'pending'
      AND scheduled_at < now() - INTERVAL '1 hour';

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

SELECT cron.schedule(
    'mark-followups-overdue',
    '*/15 * * * *',
    'SELECT mark_followups_overdue()'
);

-- ============================================================
-- update_whatsapp_delivery_status
-- ============================================================
-- Called from the /api/webhooks/whatsapp route when a
-- status update payload arrives (sent/delivered/read/failed).
-- ============================================================
CREATE OR REPLACE FUNCTION update_whatsapp_delivery_status(
    p_whatsapp_message_id   TEXT,
    p_status                TEXT,
    p_timestamp             TIMESTAMPTZ DEFAULT now(),
    p_failure_reason        TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE messages
    SET
        delivery_status = p_status,
        sent_at         = CASE WHEN p_status = 'sent'      THEN p_timestamp ELSE sent_at      END,
        delivered_at    = CASE WHEN p_status = 'delivered' THEN p_timestamp ELSE delivered_at END,
        read_at         = CASE WHEN p_status = 'read'      THEN p_timestamp ELSE read_at      END,
        failed_at       = CASE WHEN p_status = 'failed'    THEN p_timestamp ELSE failed_at    END,
        failure_reason  = COALESCE(p_failure_reason, failure_reason),
        updated_at      = now()
    WHERE whatsapp_message_id = p_whatsapp_message_id;
END;
$$;

-- ============================================================
-- get_lead_conversation_summary
-- ============================================================
-- Returns a denormalized summary for the lead detail view
-- to avoid N+1 queries from the dashboard.
-- ============================================================
CREATE OR REPLACE FUNCTION get_lead_conversation_summary(p_lead_id UUID)
RETURNS TABLE (
    lead_id             UUID,
    open_conversation_id UUID,
    total_messages      BIGINT,
    unread_count        INTEGER,
    last_message_at     TIMESTAMPTZ,
    last_message_preview TEXT,
    pending_followups   BIGINT,
    latest_intent       ai_intent,
    qualification_score SMALLINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        p_lead_id AS lead_id,
        (SELECT id FROM conversations
         WHERE lead_id = p_lead_id AND status = 'open'
         LIMIT 1)                                    AS open_conversation_id,
        (SELECT COUNT(*) FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.lead_id = p_lead_id)                AS total_messages,
        COALESCE((SELECT SUM(unread_count)::INTEGER
         FROM conversations
         WHERE lead_id = p_lead_id AND status = 'open'), 0) AS unread_count,
        (SELECT last_message_at FROM conversations
         WHERE lead_id = p_lead_id
         ORDER BY last_message_at DESC NULLS LAST
         LIMIT 1)                                    AS last_message_at,
        (SELECT last_message_preview FROM conversations
         WHERE lead_id = p_lead_id
         ORDER BY last_message_at DESC NULLS LAST
         LIMIT 1)                                    AS last_message_preview,
        (SELECT COUNT(*) FROM followups
         WHERE lead_id = p_lead_id AND status = 'pending') AS pending_followups,
        (SELECT intent FROM ai_classifications
         WHERE lead_id = p_lead_id
         ORDER BY created_at DESC
         LIMIT 1)                                    AS latest_intent,
        (SELECT qualification_score FROM ai_classifications
         WHERE lead_id = p_lead_id AND qualification_score IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1)                                    AS qualification_score;
$$;
