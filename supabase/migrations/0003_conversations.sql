-- ============================================================
-- Migration 0003: conversations table
-- ============================================================
-- A conversation is a bounded thread of messages between
-- the system and a lead on a specific channel.
-- One lead may have multiple conversations over time, but
-- only ONE open conversation per (lead_id, channel) at a time
-- (enforced by partial unique index in 0009_indexes.sql).
-- ============================================================

CREATE TABLE conversations (
    -- Identity
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relationships
    lead_id                 UUID            NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    assigned_agent_id       UUID            REFERENCES auth.users(id) ON DELETE SET NULL,
    team_id                 UUID,

    -- Channel this conversation is on
    channel                 channel_type    NOT NULL DEFAULT 'whatsapp',

    -- Lifecycle
    status                  conversation_status NOT NULL DEFAULT 'open',
    resolved_at             TIMESTAMPTZ,
    archived_at             TIMESTAMPTZ,

    -- Messaging stats (denormalized for dashboard performance)
    message_count           INTEGER         NOT NULL DEFAULT 0,
    unread_count            INTEGER         NOT NULL DEFAULT 0,
    last_message_at         TIMESTAMPTZ,
    last_message_preview    TEXT,           -- Truncated to 280 chars in app layer

    -- WhatsApp-specific session window
    -- Meta's 24-hour customer service window expires at this time
    whatsapp_window_expires_at TIMESTAMPTZ,

    -- Context passed to AI on every turn
    -- Example: {"product_interest": "Plan A", "objections": ["price"]}
    ai_context              JSONB           NOT NULL DEFAULT '{}',

    -- Arbitrary metadata
    metadata                JSONB           NOT NULL DEFAULT '{}',

    -- Audit timestamps
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_conversations_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------
-- Denormalized counter maintenance
-- Kept in sync by message insert trigger in 0004_messages.sql
-- --------------------------------------------------------

COMMENT ON TABLE  conversations                         IS 'Bounded message thread between system and a lead';
COMMENT ON COLUMN conversations.message_count           IS 'Denormalized count — maintained by trigger on messages';
COMMENT ON COLUMN conversations.unread_count            IS 'Inbound messages not yet read by an agent';
COMMENT ON COLUMN conversations.last_message_preview    IS 'Truncated to 280 chars; updated by trigger on messages';
COMMENT ON COLUMN conversations.whatsapp_window_expires_at IS '24-hour service window; NULL after first inbound resets it';
COMMENT ON COLUMN conversations.ai_context              IS 'Running context blob passed to LLM on each turn';
