-- ============================================================
-- Migration 0002: leads table
-- ============================================================
-- Represents a single human contact regardless of channel.
-- A lead is uniquely identified by (phone_e164, channel).
-- If the same person reaches out via WhatsApp AND Instagram
-- they will have two lead rows linked by external_id or
-- manually merged by an agent.
-- ============================================================

CREATE TABLE leads (
    -- Identity
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Contact info
    -- phone_e164: E.164 format e.g. +14155552671 (enforced in app layer)
    phone_e164          TEXT,
    email               TEXT,
    name                TEXT,
    first_name          TEXT            GENERATED ALWAYS AS (
                            CASE
                                WHEN name IS NOT NULL
                                THEN split_part(trim(name), ' ', 1)
                                ELSE NULL
                            END
                        ) STORED,

    -- Channel that originated this lead
    channel             channel_type    NOT NULL DEFAULT 'whatsapp',

    -- External identifiers
    -- whatsapp_id: WhatsApp phone number ID from the Cloud API
    whatsapp_id         TEXT,
    -- meta_lead_id: Facebook Lead Ads lead ID for dedup
    meta_lead_id        TEXT,
    -- external_id: generic field for future channel IDs (Instagram PSID, etc.)
    external_id         TEXT,

    -- Lead source / campaign tracking
    ad_id               TEXT,
    ad_name             TEXT,
    form_id             TEXT,
    campaign_id         TEXT,
    campaign_name       TEXT,

    -- CRM assignment
    assigned_agent_id   UUID            REFERENCES auth.users(id) ON DELETE SET NULL,
    team_id             UUID,           -- For multi-tenant; FK added when teams table exists

    -- Lifecycle
    status              lead_status     NOT NULL DEFAULT 'new',
    qualified_at        TIMESTAMPTZ,
    converted_at        TIMESTAMPTZ,
    last_contacted_at   TIMESTAMPTZ,
    last_reply_at       TIMESTAMPTZ,    -- Last time the lead themselves replied

    -- Arbitrary key-value from lead ad form fields or enrichment
    -- Example: {"job_title": "CEO", "company": "Acme", "utm_source": "google"}
    metadata            JSONB           NOT NULL DEFAULT '{}',

    -- Soft delete
    deleted_at          TIMESTAMPTZ,

    -- Audit timestamps
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),

    -- --------------------------------------------------------
    -- Constraints
    -- --------------------------------------------------------

    -- A lead is uniquely identified by phone + channel.
    -- NULL phone is allowed only for non-phone channels (email).
    CONSTRAINT uq_lead_phone_channel
        UNIQUE NULLS NOT DISTINCT (phone_e164, channel),

    -- Meta Lead Ads IDs must be globally unique
    CONSTRAINT uq_meta_lead_id
        UNIQUE (meta_lead_id),

    -- Basic format guards (app layer enforces E.164 more strictly)
    CONSTRAINT chk_phone_format
        CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9]\d{6,14}$'),

    CONSTRAINT chk_email_format
        CHECK (email IS NULL OR email ~ '^[^@]+@[^@]+\.[^@]+$'),

    -- At least one contact method must exist
    CONSTRAINT chk_contact_method
        CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL)
);

-- --------------------------------------------------------
-- updated_at auto-maintenance trigger
-- --------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_leads_updated_at
    BEFORE UPDATE ON leads
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------
-- Comments
-- --------------------------------------------------------
COMMENT ON TABLE  leads                     IS 'One row per unique contact per channel';
COMMENT ON COLUMN leads.phone_e164          IS 'E.164 format: +14155552671';
COMMENT ON COLUMN leads.whatsapp_id         IS 'WhatsApp Cloud API sender phone number ID';
COMMENT ON COLUMN leads.meta_lead_id        IS 'Facebook Lead Ads lead ID — used for idempotent upsert';
COMMENT ON COLUMN leads.external_id         IS 'Generic external identifier for future channels';
COMMENT ON COLUMN leads.metadata            IS 'Arbitrary JSONB from ad form fields, enrichment APIs, etc.';
COMMENT ON COLUMN leads.team_id             IS 'Multi-tenant team identifier; FK added when teams table is created';
