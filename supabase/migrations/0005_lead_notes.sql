-- ============================================================
-- Migration 0005: lead_notes table
-- ============================================================
-- Free-form agent notes attached to a lead.
-- Notes are immutable after creation (updated_at = created_at).
-- Agents may soft-delete their own notes.
-- ============================================================

CREATE TABLE lead_notes (
    -- Identity
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relationships
    lead_id         UUID        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    -- The agent who wrote the note
    agent_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,

    -- Content
    content         TEXT        NOT NULL,
    -- Optional tag for categorisation: 'call', 'email', 'meeting', 'system', etc.
    note_type       TEXT        NOT NULL DEFAULT 'general',

    -- Pinned notes surface at top of lead timeline
    is_pinned       BOOLEAN     NOT NULL DEFAULT FALSE,

    -- Soft delete (agents can remove their own notes)
    deleted_at      TIMESTAMPTZ,

    -- Audit timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- --------------------------------------------------------
    -- Constraints
    -- --------------------------------------------------------
    CONSTRAINT chk_note_content_not_empty
        CHECK (char_length(trim(content)) > 0),

    CONSTRAINT chk_note_content_length
        CHECK (char_length(content) <= 10000)
);

CREATE TRIGGER trg_lead_notes_updated_at
    BEFORE UPDATE ON lead_notes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  lead_notes            IS 'Free-form agent notes attached to a lead';
COMMENT ON COLUMN lead_notes.note_type  IS 'Category tag: general, call, email, meeting, system';
COMMENT ON COLUMN lead_notes.is_pinned  IS 'Pinned notes surface at the top of the lead activity timeline';
COMMENT ON COLUMN lead_notes.deleted_at IS 'Soft-delete; agent can remove their own notes';
