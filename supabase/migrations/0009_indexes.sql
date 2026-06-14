-- ============================================================
-- Migration 0009: Indexes
-- ============================================================
-- All non-unique indexes and partial indexes.
-- Unique constraints are declared inline on tables.
-- Strategy:
--   - B-tree for equality, range, sort
--   - GIN for JSONB and full-text search
--   - Partial indexes to keep index size minimal
-- ============================================================

-- ============================================================
-- leads
-- ============================================================

-- Primary lookup: find lead by external WhatsApp sender ID
CREATE INDEX idx_leads_whatsapp_id
    ON leads (whatsapp_id)
    WHERE whatsapp_id IS NOT NULL AND deleted_at IS NULL;

-- Dashboard: leads by status for kanban/list views
CREATE INDEX idx_leads_status_created
    ON leads (status, created_at DESC)
    WHERE deleted_at IS NULL;

-- Assignment: all leads for an agent
CREATE INDEX idx_leads_assigned_agent
    ON leads (assigned_agent_id, created_at DESC)
    WHERE assigned_agent_id IS NOT NULL AND deleted_at IS NULL;

-- Multi-tenant: all leads for a team
CREATE INDEX idx_leads_team_id
    ON leads (team_id, created_at DESC)
    WHERE team_id IS NOT NULL AND deleted_at IS NULL;

-- Follow-up list: leads that haven't been contacted recently
CREATE INDEX idx_leads_last_contacted
    ON leads (last_contacted_at ASC NULLS FIRST)
    WHERE deleted_at IS NULL AND status NOT IN ('converted', 'lost', 'archived');

-- JSONB metadata search (e.g. filter by utm_source, campaign, custom fields)
CREATE INDEX idx_leads_metadata_gin
    ON leads USING GIN (metadata);

-- ============================================================
-- conversations
-- ============================================================

-- All conversations for a lead (most recent first)
CREATE INDEX idx_conversations_lead_id
    ON conversations (lead_id, created_at DESC);

-- Critical: enforce only ONE open conversation per (lead, channel)
-- This is a partial unique index — business rule at DB level
CREATE UNIQUE INDEX uq_conversations_one_open_per_lead_channel
    ON conversations (lead_id, channel)
    WHERE status = 'open';

-- Agent inbox: all open conversations assigned to an agent
CREATE INDEX idx_conversations_agent_open
    ON conversations (assigned_agent_id, last_message_at DESC)
    WHERE status = 'open' AND assigned_agent_id IS NOT NULL;

-- Conversations with unread messages (for notification badges)
CREATE INDEX idx_conversations_unread
    ON conversations (last_message_at DESC)
    WHERE unread_count > 0 AND status = 'open';

-- WhatsApp 24-hour window expiry checks
CREATE INDEX idx_conversations_wa_window
    ON conversations (whatsapp_window_expires_at ASC)
    WHERE channel = 'whatsapp'
      AND status = 'open'
      AND whatsapp_window_expires_at IS NOT NULL;

-- ============================================================
-- messages
-- ============================================================

-- All messages in a conversation (paginated, newest first)
CREATE INDEX idx_messages_conversation_created
    ON messages (conversation_id, created_at DESC);

-- Unread inbound messages for a lead (notification count)
CREATE INDEX idx_messages_unread_inbound
    ON messages (conversation_id, created_at DESC)
    WHERE direction = 'inbound' AND agent_read_at IS NULL;

-- Outbound messages pending delivery confirmation
CREATE INDEX idx_messages_pending_delivery
    ON messages (created_at ASC)
    WHERE direction = 'outbound'
      AND delivery_status IN ('pending', 'sent')
      AND failed_at IS NULL;

-- Full-text search across message content
-- tsvector is computed from the content column
CREATE INDEX idx_messages_content_fts
    ON messages USING GIN (to_tsvector('english', coalesce(content, '')));

-- Media messages (for media gallery view)
CREATE INDEX idx_messages_media
    ON messages (conversation_id, created_at DESC)
    WHERE media_url IS NOT NULL;

-- ============================================================
-- lead_notes
-- ============================================================

-- All notes for a lead (most recent first, excluding deleted)
CREATE INDEX idx_lead_notes_lead_id
    ON lead_notes (lead_id, created_at DESC)
    WHERE deleted_at IS NULL;

-- Pinned notes surface first
CREATE INDEX idx_lead_notes_pinned
    ON lead_notes (lead_id, is_pinned DESC, created_at DESC)
    WHERE deleted_at IS NULL;

-- ============================================================
-- followups
-- ============================================================

-- Due follow-ups queue (the most critical query for agents)
CREATE INDEX idx_followups_scheduled
    ON followups (scheduled_at ASC, priority ASC)
    WHERE status = 'pending';

-- All pending follow-ups for a specific agent
CREATE INDEX idx_followups_agent_pending
    ON followups (assigned_agent_id, scheduled_at ASC)
    WHERE status = 'pending' AND assigned_agent_id IS NOT NULL;

-- All follow-ups for a lead
CREATE INDEX idx_followups_lead_id
    ON followups (lead_id, created_at DESC);

-- ============================================================
-- ai_classifications
-- ============================================================

-- Most recent classification for a lead
CREATE INDEX idx_ai_classifications_lead_created
    ON ai_classifications (lead_id, created_at DESC);

-- One classification per message (prevents double-classifying)
-- Partial unique index so conversation-level runs don't conflict
CREATE UNIQUE INDEX uq_ai_classification_per_message
    ON ai_classifications (message_id)
    WHERE message_id IS NOT NULL;

-- Classifications pending action (automation queue)
CREATE INDEX idx_ai_classifications_action_pending
    ON ai_classifications (created_at ASC)
    WHERE action_taken = FALSE
      AND confidence >= 0.75;  -- Only act on high-confidence results

-- ============================================================
-- webhook_events
-- ============================================================

-- Unprocessed events queue (worker polling).
-- Note: retry_after <= now() cannot be in the predicate (now() is not IMMUTABLE).
-- Workers filter retry_after in the query WHERE clause instead.
CREATE INDEX idx_webhook_events_unprocessed
    ON webhook_events (received_at ASC)
    WHERE processed_at IS NULL
      AND status NOT IN ('duplicate', 'failed');

-- Events by source (for monitoring dashboards)
CREATE INDEX idx_webhook_events_source_received
    ON webhook_events (source, received_at DESC);

-- Link to lead for event history
CREATE INDEX idx_webhook_events_lead_id
    ON webhook_events (lead_id, received_at DESC)
    WHERE lead_id IS NOT NULL;

-- Failed events (alert queue)
CREATE INDEX idx_webhook_events_failed
    ON webhook_events (received_at DESC)
    WHERE status = 'failed';
