-- ============================================================
-- SCHEMA VERIFICATION REPORT
-- ============================================================
-- Findings against required multi-tenant structure:
--
-- ❌ organizations table            — MISSING
-- ❌ organization_members table     — MISSING
-- ❌ organization_id on leads       — MISSING (team_id stub; no FK, no backing table)
-- ❌ organization_id on conversations— MISSING (same team_id stub)
-- ❌ organization_id on messages    — MISSING (no tenant column at all)
-- ❌ organization_id on lead_notes  — MISSING
-- ❌ organization_id on followups   — MISSING (team_id stub)
-- ❌ organization_id on ai_classifications — MISSING
-- ❌ organization_id on webhook_events    — MISSING
-- ❌ upsert_lead_from_meta_ad()     — no organization_id parameter
-- ❌ leads UNIQUE constraint        — globally scoped (phone_e164, channel)
--                                    must be per-org: (organization_id, phone_e164, channel)
-- ❌ RLS policies                   — use team_id with no FK enforcement
--
-- This migration introduces the organizations table, the
-- organization_members table, and their supporting infrastructure.
-- ============================================================

-- ============================================================
-- Migration 0012: organizations + organization_members
-- ============================================================

-- --------------------------------------------------------
-- organizations
-- --------------------------------------------------------
-- Root tenant entity. Every business using the platform
-- maps to exactly one organization.
-- --------------------------------------------------------

CREATE TABLE organizations (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Display info
    name            TEXT        NOT NULL,
    -- URL-safe slug for routing. UNIQUE globally.
    slug            TEXT        NOT NULL UNIQUE,

    -- Billing / feature gating
    plan            TEXT        NOT NULL DEFAULT 'free'
                        CHECK (plan IN ('free', 'starter', 'pro', 'enterprise')),
    -- Seats included in plan (NULL = unlimited)
    seat_limit      SMALLINT,
    -- Lead volume limit per month (NULL = unlimited)
    monthly_lead_limit INTEGER,

    -- Contact info for the business
    contact_email   TEXT,
    contact_phone   TEXT,
    website_url     TEXT,

    -- Org-level settings / feature flags stored as JSONB
    -- Example: {"ai_auto_reply": true, "timezone": "America/New_York"}
    settings        JSONB       NOT NULL DEFAULT '{}',

    -- Soft delete
    deleted_at      TIMESTAMPTZ,

    -- Audit timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- --------------------------------------------------------
    CONSTRAINT chk_org_name_not_empty
        CHECK (char_length(trim(name)) >= 1),

    CONSTRAINT chk_org_slug_format
        CHECK (slug ~ '^[a-z0-9][a-z0-9\-]{0,61}[a-z0-9]$')
);

CREATE TRIGGER trg_organizations_updated_at
    BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------
-- organization_members
-- --------------------------------------------------------
-- Junction table: maps auth.users to organizations with a role.
-- A user may belong to multiple organizations (e.g. a consultant).
-- Their JWT will carry the organization_id they are currently
-- acting on (set via the auth hook on session selection).
-- --------------------------------------------------------

CREATE TYPE org_member_role AS ENUM ('owner', 'admin', 'agent');

CREATE TABLE organization_members (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID            NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id             UUID            NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role                org_member_role NOT NULL DEFAULT 'agent',

    -- Invitation tracking
    invited_by          UUID            REFERENCES auth.users(id) ON DELETE SET NULL,
    invited_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    joined_at           TIMESTAMPTZ,    -- NULL = pending acceptance
    invitation_token    TEXT            UNIQUE, -- SHORT-LIVED; cleared after join

    -- Soft remove (keeps audit trail)
    removed_at          TIMESTAMPTZ,
    removed_by          UUID            REFERENCES auth.users(id) ON DELETE SET NULL,

    -- Audit timestamps
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),

    -- A user can only have one active role per org
    CONSTRAINT uq_org_member UNIQUE (organization_id, user_id)
);

CREATE TRIGGER trg_organization_members_updated_at
    BEFORE UPDATE ON organization_members
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------
-- Enable RLS
-- --------------------------------------------------------
ALTER TABLE organizations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;

-- --------------------------------------------------------
-- Helper functions for JWT-based org scoping
-- Replaces the old auth_team_id() approach.
-- --------------------------------------------------------

-- Returns the organization_id embedded in the user's JWT app_metadata.
-- Set by a Supabase Auth hook (see 0011_functions.sql note).
CREATE OR REPLACE FUNCTION auth_organization_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
    SELECT NULLIF(
        (auth.jwt() -> 'app_metadata' ->> 'organization_id'),
        ''
    )::UUID;
$$;

-- Returns the user's role within their current org context.
CREATE OR REPLACE FUNCTION auth_org_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
    SELECT (auth.jwt() -> 'app_metadata' ->> 'org_role');
$$;

-- True if the calling JWT belongs to the service_role key.
-- Renamed from auth_is_service_role for clarity (old one kept
-- for backward compat; both implementations identical).
CREATE OR REPLACE FUNCTION auth_is_service_role()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
    SELECT (auth.jwt() ->> 'role') = 'service_role';
$$;

-- --------------------------------------------------------
-- RLS policies: organizations
-- --------------------------------------------------------

-- Users can read organizations they are members of
CREATE POLICY orgs_select ON organizations
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL AND (
            id = auth_organization_id() OR
            auth_is_service_role()
        )
    );

-- Only service role inserts organizations (via onboarding API)
CREATE POLICY orgs_insert ON organizations
    FOR INSERT TO authenticated
    WITH CHECK (auth_is_service_role());

-- Owners and admins can update their org settings
CREATE POLICY orgs_update ON organizations
    FOR UPDATE TO authenticated
    USING (
        id = auth_organization_id() AND
        auth_org_role() IN ('owner', 'admin')
    )
    WITH CHECK (
        id = auth_organization_id() AND
        auth_org_role() IN ('owner', 'admin')
    );

-- Only service role can soft-delete
CREATE POLICY orgs_delete ON organizations
    FOR DELETE TO authenticated
    USING (auth_is_service_role());

-- --------------------------------------------------------
-- RLS policies: organization_members
-- --------------------------------------------------------

-- Members can see other members in their org
CREATE POLICY org_members_select ON organization_members
    FOR SELECT TO authenticated
    USING (
        removed_at IS NULL AND (
            organization_id = auth_organization_id() OR
            auth_is_service_role()
        )
    );

-- Owners and admins can invite members (INSERT)
CREATE POLICY org_members_insert ON organization_members
    FOR INSERT TO authenticated
    WITH CHECK (
        auth_is_service_role() OR (
            organization_id = auth_organization_id() AND
            auth_org_role() IN ('owner', 'admin')
        )
    );

-- Owners and admins can update roles; users can update their own join status
CREATE POLICY org_members_update ON organization_members
    FOR UPDATE TO authenticated
    USING (
        organization_id = auth_organization_id() AND (
            auth_org_role() IN ('owner', 'admin') OR
            user_id = auth.uid()
        ) OR auth_is_service_role()
    );

-- --------------------------------------------------------
-- Indexes
-- --------------------------------------------------------

-- All members of an org
CREATE INDEX idx_org_members_org_id
    ON organization_members (organization_id)
    WHERE removed_at IS NULL;

-- All orgs a user belongs to (for multi-org switcher)
CREATE INDEX idx_org_members_user_id
    ON organization_members (user_id)
    WHERE removed_at IS NULL;

-- Pending invitations
CREATE INDEX idx_org_members_invitation_token
    ON organization_members (invitation_token)
    WHERE invitation_token IS NOT NULL AND joined_at IS NULL;

-- Org slug lookup (already UNIQUE btree; explicit for query clarity)
CREATE INDEX idx_organizations_slug
    ON organizations (slug)
    WHERE deleted_at IS NULL;

-- --------------------------------------------------------
-- Comments
-- --------------------------------------------------------
COMMENT ON TABLE  organizations                         IS 'Root tenant entity — one row per business';
COMMENT ON COLUMN organizations.slug                    IS 'URL-safe identifier e.g. "acme-corp". Must match ^[a-z0-9][a-z0-9\-]{0,61}[a-z0-9]$';
COMMENT ON COLUMN organizations.settings               IS 'Feature flags and org-level config as JSONB';
COMMENT ON TABLE  organization_members                  IS 'Maps auth.users to organizations with a role';
COMMENT ON COLUMN organization_members.invitation_token IS 'Short-lived token sent via email; cleared after join. NEVER return to clients.';
COMMENT ON COLUMN organization_members.joined_at        IS 'NULL = invitation pending; set when user accepts';
