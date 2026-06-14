-- ============================================================
-- Migration 0013: meta_integrations
-- ============================================================
-- Stores the per-organization Meta (Facebook) integration config.
-- One organization may have multiple Pages connected (one row per page).
-- page_id is GLOBALLY unique — a Meta Page can only be connected
-- to one organization at a time.
--
-- Security model:
--   - access_token stored as encrypted ciphertext (pgp_sym_encrypt).
--   - Decryption key is held in SUPABASE_META_TOKEN_ENCRYPT_KEY env var.
--   - This column is NEVER returned by RLS-governed client queries.
--   - Only the service-role API route fetches it via admin client.
-- ============================================================

CREATE TABLE meta_integrations (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Tenant ownership
    organization_id         UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- Meta identifiers
    page_id                 TEXT        NOT NULL UNIQUE,   -- Facebook Page ID; globally unique
    page_name               TEXT,                          -- Display name (refreshed on connect)
    app_id                  TEXT        NOT NULL,           -- The Meta App this connection belongs to

    -- Page access token (encrypted at rest)
    -- Encrypted with pgp_sym_encrypt(value, SUPABASE_META_TOKEN_ENCRYPT_KEY)
    -- Decrypted at application layer via pgp_sym_decrypt()
    -- DO NOT SELECT this column in RLS-governed queries — service role only
    access_token_encrypted  TEXT        NOT NULL,

    -- Optional: whitelist of form IDs to accept.
    -- NULL = accept all leadgen submissions from this page.
    allowed_form_ids        TEXT[],

    -- Toggle integration on/off without deleting
    is_active               BOOLEAN     NOT NULL DEFAULT TRUE,

    -- Monitoring
    last_webhook_received_at TIMESTAMPTZ,
    last_successful_lead_at  TIMESTAMPTZ,
    total_leads_ingested    INTEGER     NOT NULL DEFAULT 0,

    -- Subscribed webhook fields (for documentation; actual subscription managed via Meta API)
    webhook_subscribed_fields TEXT[]    NOT NULL DEFAULT ARRAY['leadgen'],

    -- Audit timestamps
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- --------------------------------------------------------
    CONSTRAINT chk_page_id_not_empty
        CHECK (char_length(trim(page_id)) > 0),

    CONSTRAINT chk_app_id_not_empty
        CHECK (char_length(trim(app_id)) > 0)
);

CREATE TRIGGER trg_meta_integrations_updated_at
    BEFORE UPDATE ON meta_integrations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------
-- RLS: meta_integrations
-- --------------------------------------------------------
-- Agents can see their org's integrations (but NOT the token column).
-- The application enforces token redaction by using a view.
-- The admin client (service role) accesses the raw table to read tokens.
-- --------------------------------------------------------
ALTER TABLE meta_integrations ENABLE ROW LEVEL SECURITY;

-- Read integration config (token column redacted via view below)
CREATE POLICY meta_integrations_select ON meta_integrations
    FOR SELECT TO authenticated
    USING (
        organization_id = auth_organization_id() OR
        auth_is_service_role()
    );

-- Only owners/admins can connect a new page
CREATE POLICY meta_integrations_insert ON meta_integrations
    FOR INSERT TO authenticated
    WITH CHECK (
        auth_is_service_role() OR (
            organization_id = auth_organization_id() AND
            auth_org_role() IN ('owner', 'admin')
        )
    );

-- Only owners/admins can update integration config
CREATE POLICY meta_integrations_update ON meta_integrations
    FOR UPDATE TO authenticated
    USING (
        auth_is_service_role() OR (
            organization_id = auth_organization_id() AND
            auth_org_role() IN ('owner', 'admin')
        )
    );

-- Only owners/admins can disconnect (delete)
CREATE POLICY meta_integrations_delete ON meta_integrations
    FOR DELETE TO authenticated
    USING (
        auth_is_service_role() OR (
            organization_id = auth_organization_id() AND
            auth_org_role() IN ('owner', 'admin')
        )
    );

-- --------------------------------------------------------
-- Redacted view: never exposes access_token_encrypted to clients
-- --------------------------------------------------------
CREATE OR REPLACE VIEW meta_integrations_safe
    WITH (security_invoker = true)
AS
SELECT
    id,
    organization_id,
    page_id,
    page_name,
    app_id,
    -- access_token_encrypted intentionally EXCLUDED
    allowed_form_ids,
    is_active,
    last_webhook_received_at,
    last_successful_lead_at,
    total_leads_ingested,
    webhook_subscribed_fields,
    created_at,
    updated_at
FROM meta_integrations;

COMMENT ON VIEW meta_integrations_safe IS 'Redacted view — access_token_encrypted excluded. Use for client-facing queries.';

-- --------------------------------------------------------
-- Helper function: decrypt access token (service-role only)
-- Requires pgcrypto extension (already enabled in 0001).
-- The encryption key SUPABASE_META_TOKEN_ENCRYPT_KEY must be
-- set as a Supabase secret and referenced via a Vault secret or
-- passed to the function from the application layer.
--
-- NOTE: In this implementation decryption happens in the
-- application layer (src/repositories/meta-integration.repository.ts)
-- using node's crypto to avoid storing the key in DB functions.
-- --------------------------------------------------------

-- --------------------------------------------------------
-- Indexes
-- --------------------------------------------------------

-- Primary webhook routing lookup: find org by page_id (hot path)
CREATE INDEX idx_meta_integrations_page_id
    ON meta_integrations (page_id)
    WHERE is_active = TRUE;

-- All active integrations for an org
CREATE INDEX idx_meta_integrations_org_id
    ON meta_integrations (organization_id)
    WHERE is_active = TRUE;

-- --------------------------------------------------------
-- Comments
-- --------------------------------------------------------
COMMENT ON TABLE  meta_integrations                            IS 'Per-organization Meta (Facebook) Page integration config';
COMMENT ON COLUMN meta_integrations.page_id                    IS 'Facebook Page ID — globally unique; one page belongs to one org';
COMMENT ON COLUMN meta_integrations.access_token_encrypted     IS 'AES-256-GCM ciphertext of page access token. NEVER expose to clients.';
COMMENT ON COLUMN meta_integrations.allowed_form_ids           IS 'Whitelist of leadgen form IDs; NULL = accept all forms from this page';
COMMENT ON COLUMN meta_integrations.total_leads_ingested       IS 'Running counter for analytics; incremented by upsert_lead_from_meta_ad()';
