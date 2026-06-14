-- ============================================================
-- Migration 0004: messages table
-- ============================================================
-- Individual messages within a conversation.
-- Supports text, media, templates, and interactive messages.
-- Idempotency: whatsapp_message_id is UNIQUE — duplicate
-- webhook deliveries are safely ignored via ON CONFLICT DO NOTHING.
-- ============================================================

CREATE TABLE messages (
    -- Identity
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relationships
    conversation_id         UUID            NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    lead_id                 UUID            NOT NULL REFERENCES leads(id) ON DELETE CASCADE,

    -- Direction & sender
    direction               message_direction       NOT NULL,
    sender_type             message_sender_type     NOT NULL,
    -- NULL for leads; set to auth.users.id for agents; 'ai_bot' uses sender_type only
    sender_agent_id         UUID            REFERENCES auth.users(id) ON DELETE SET NULL,

    -- External message identifiers
    -- WhatsApp message ID from Cloud API — e.g. "wamid.HBgLMTY..."
    whatsapp_message_id     TEXT            UNIQUE,
    -- For future channels
    external_message_id     TEXT,

    -- Message type (text, image, audio, video, document, template, interactive, etc.)
    message_type            TEXT            NOT NULL DEFAULT 'text',

    -- Primary text content (NULL for pure media messages)
    content                 TEXT,

    -- Full raw payload from WhatsApp (for media, interactive buttons, etc.)
    -- Preserves the original structure for future replay / rendering
    raw_payload             JSONB           NOT NULL DEFAULT '{}',

    -- Media attachments
    media_url               TEXT,           -- Supabase Storage URL after download
    media_mime_type         TEXT,
    media_sha256            TEXT,           -- Integrity check on download

    -- WhatsApp template details
    template_name           TEXT,
    template_language       TEXT,

    -- Delivery tracking
    -- WhatsApp status progression: sent → delivered → read
    delivery_status         TEXT            NOT NULL DEFAULT 'pending',
    -- Timestamps from WhatsApp status callbacks
    sent_at                 TIMESTAMPTZ,
    delivered_at            TIMESTAMPTZ,
    read_at                 TIMESTAMPTZ,    -- Set when lead opens the message
    failed_at               TIMESTAMPTZ,
    failure_reason          TEXT,

    -- Agent read tracking (separate from WhatsApp read receipt)
    agent_read_at           TIMESTAMPTZ,

    -- Audit timestamps
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ     NOT NULL DEFAULT now(),

    -- --------------------------------------------------------
    -- Constraints
    -- --------------------------------------------------------
    CONSTRAINT chk_content_length
        CHECK (content IS NULL OR char_length(content) <= 4096),

    CONSTRAINT chk_sender_agent_set
        CHECK (sender_type != 'agent' OR sender_agent_id IS NOT NULL)
);

CREATE TRIGGER trg_messages_updated_at
    BEFORE UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------
-- Trigger: maintain conversation denormalized counters
-- --------------------------------------------------------
CREATE OR REPLACE FUNCTION update_conversation_on_message()
RETURNS TRIGGER LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE conversations
    SET
        message_count       = message_count + 1,
        unread_count        = unread_count + CASE
                                WHEN NEW.direction = 'inbound' AND NEW.agent_read_at IS NULL
                                THEN 1 ELSE 0
                              END,
        last_message_at     = NEW.created_at,
        last_message_preview = left(coalesce(NEW.content, '[media]'), 280),
        -- Reset 24-hour window on every inbound message
        whatsapp_window_expires_at = CASE
            WHEN NEW.direction = 'inbound' AND NEW.conversation_id IN (
                SELECT id FROM conversations WHERE channel = 'whatsapp'
            )
            THEN NEW.created_at + INTERVAL '24 hours'
            ELSE (SELECT whatsapp_window_expires_at FROM conversations WHERE id = NEW.conversation_id)
        END,
        updated_at          = now()
    WHERE id = NEW.conversation_id;

    -- Also update lead's last_reply_at for inbound messages
    IF NEW.direction = 'inbound' THEN
        UPDATE leads
        SET
            last_reply_at     = NEW.created_at,
            last_contacted_at = NEW.created_at,
            updated_at        = now()
        WHERE id = NEW.lead_id;
    ELSE
        UPDATE leads
        SET
            last_contacted_at = NEW.created_at,
            updated_at        = now()
        WHERE id = NEW.lead_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_message_update_conversation
    AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION update_conversation_on_message();

-- --------------------------------------------------------
-- Comments
-- --------------------------------------------------------
COMMENT ON TABLE  messages                      IS 'Individual messages within a conversation';
COMMENT ON COLUMN messages.whatsapp_message_id  IS 'WhatsApp Cloud API message ID; UNIQUE for idempotency';
COMMENT ON COLUMN messages.raw_payload          IS 'Full original webhook payload for replay and rich rendering';
COMMENT ON COLUMN messages.media_url            IS 'Supabase Storage URL after media is downloaded from WhatsApp';
COMMENT ON COLUMN messages.read_at              IS 'Set from WhatsApp read receipt — lead opened the message';
COMMENT ON COLUMN messages.agent_read_at        IS 'Set when a CRM agent marks the message as read';
