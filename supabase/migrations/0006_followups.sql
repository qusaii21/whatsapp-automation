-- ============================================================
-- Migration 0006: followups table
-- ============================================================
-- Scheduled follow-up tasks for agents or the AI bot.
-- A follow-up may be linked to a conversation or stand alone
-- on a lead (e.g. a reminder to call after 3 days).
-- ============================================================

CREATE TABLE followups (
    -- Identity
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relationships
    lead_id             UUID            NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    conversation_id     UUID            REFERENCES conversations(id) ON DELETE SET NULL,
    -- Who is responsible for this follow-up (NULL = unassigned)
    assigned_agent_id   UUID            REFERENCES auth.users(id) ON DELETE SET NULL,
    -- Who created it (agent or system/AI)
    created_by_agent_id UUID            REFERENCES auth.users(id) ON DELETE SET NULL,

    -- Content
    title               TEXT            NOT NULL,
    description         TEXT,
    -- Type of follow-up action expected
    -- e.g. 'whatsapp_message', 'call', 'email', 'review', 'ai_auto'
    followup_type       TEXT            NOT NULL DEFAULT 'whatsapp_message',

    -- Scheduling
    scheduled_at        TIMESTAMPTZ     NOT NULL,
    -- How many times this follow-up has been snoozed
    snooze_count        INTEGER         NOT NULL DEFAULT 0,
    snoozed_until       TIMESTAMPTZ,

    -- Lifecycle
    status              followup_status NOT NULL DEFAULT 'pending',
    completed_at        TIMESTAMPTZ,
    cancelled_at        TIMESTAMPTZ,
    cancellation_reason TEXT,

    -- If completed, which message was sent
    completed_message_id UUID           REFERENCES messages(id) ON DELETE SET NULL,

    -- Priority (1=highest, 5=lowest)
    priority            SMALLINT        NOT NULL DEFAULT 3
                            CHECK (priority BETWEEN 1 AND 5),

    -- Audit timestamps
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),

    -- --------------------------------------------------------
    -- Constraints
    -- --------------------------------------------------------
    CONSTRAINT chk_followup_title_not_empty
        CHECK (char_length(trim(title)) > 0),

    CONSTRAINT chk_completed_at_set
        CHECK (status != 'completed' OR completed_at IS NOT NULL),

    CONSTRAINT chk_cancelled_at_set
        CHECK (status != 'cancelled' OR cancelled_at IS NOT NULL)
);

CREATE TRIGGER trg_followups_updated_at
    BEFORE UPDATE ON followups
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  followups                 IS 'Scheduled follow-up tasks for agents or AI bot';
COMMENT ON COLUMN followups.followup_type   IS 'Action type: whatsapp_message, call, email, review, ai_auto';
COMMENT ON COLUMN followups.snooze_count    IS 'Incremented each time the follow-up is snoozed';
COMMENT ON COLUMN followups.priority        IS '1=highest urgency, 5=lowest urgency';
