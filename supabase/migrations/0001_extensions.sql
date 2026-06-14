-- ============================================================
-- Migration 0001: Enable required PostgreSQL extensions
-- ============================================================

-- UUID generation (pgcrypto provides gen_random_uuid())
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- UUID alternative (uuid-ossp for compatibility)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Full-text search via tsvector helpers
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Async HTTP calls from DB (used by pg_net for edge function triggers)
CREATE EXTENSION IF NOT EXISTS "pg_net";

-- Scheduled jobs (event purge, follow-up reminders)
CREATE EXTENSION IF NOT EXISTS "pg_cron";

-- ============================================================
-- Shared ENUM types used across multiple tables
-- ============================================================

-- Communication channels — add new channels here only, never remove
CREATE TYPE channel_type AS ENUM (
    'whatsapp',
    'instagram',
    'email',
    'sms'
);

-- Lead lifecycle stages
CREATE TYPE lead_status AS ENUM (
    'new',          -- Just ingested, not yet contacted
    'contacted',    -- First message sent
    'qualified',    -- AI or agent marked as qualified
    'unqualified',  -- Not a fit
    'negotiating',  -- In active discussion
    'converted',    -- Deal closed / goal achieved
    'lost',         -- Dropped off
    'archived'      -- Soft-deleted
);

-- Direction of a message
CREATE TYPE message_direction AS ENUM (
    'inbound',   -- From lead to agent/AI
    'outbound'   -- From agent/AI to lead
);

-- Who or what sent/generated a message
CREATE TYPE message_sender_type AS ENUM (
    'lead',
    'agent',
    'ai_bot',
    'system'
);

-- Conversation lifecycle
CREATE TYPE conversation_status AS ENUM (
    'open',
    'pending_reply',  -- Waiting on lead response
    'resolved',
    'archived'
);

-- Follow-up status
CREATE TYPE followup_status AS ENUM (
    'pending',
    'completed',
    'cancelled',
    'overdue'
);

-- AI classification intent categories
CREATE TYPE ai_intent AS ENUM (
    'purchase_intent',
    'inquiry',
    'support',
    'complaint',
    'spam',
    'unsubscribe',
    'greeting',
    'other'
);

-- Webhook processing status
CREATE TYPE webhook_status AS ENUM (
    'received',
    'processing',
    'processed',
    'failed',
    'duplicate'
);
