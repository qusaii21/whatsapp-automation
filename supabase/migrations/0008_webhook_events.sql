-- ============================================================
-- Migration 0008: webhook_events table
-- ============================================================
-- Append-only log of every inbound webhook payload.
-- Primary purpose: idempotency + audit + replay.
-- NEVER update or delete rows — only set processed_at.
-- ============================================================

CREATE TABLE webhook_events (
    -- Identity
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Source of the webhook
    -- 'meta_leads' | 'whatsapp_inbound' | 'whatsapp_status'
    source              TEXT        NOT NULL,

    -- Idempotency key derived in application layer:
    -- SHA-256( source || ':' || external_event_id || ':' || payload_hash )
    -- This ensures exact duplicate payloads are rejected at DB level.
    idempotency_key     TEXT        NOT NULL UNIQUE,

    -- External event ID from the provider (e.g. WhatsApp message ID)
    external_event_id   TEXT,

    -- HTTP metadata
    http_method         TEXT        NOT NULL DEFAULT 'POST',
    -- Request headers (sanitized — Authorization headers must be stripped before insert)
    request_headers     JSONB       NOT NULL DEFAULT '{}',
    -- Raw body as text (preserved for HMAC re-verification and replay)
    raw_body            TEXT        NOT NULL,
    -- Parsed JSON payload (NULL if body is not valid JSON)
    parsed_payload      JSONB,

    -- Processing lifecycle
    status              webhook_status NOT NULL DEFAULT 'received',
    -- Set when a worker begins processing
    processing_started_at TIMESTAMPTZ,
    -- Set when processing completes successfully
    processed_at        TIMESTAMPTZ,
    -- Number of processing attempts
    attempt_count       SMALLINT    NOT NULL DEFAULT 0,
    -- Error message from last failed attempt
    last_error          TEXT,
    -- Next retry time (NULL when not retrying)
    retry_after         TIMESTAMPTZ,

    -- Linked entities created from this event (populated after processing)
    lead_id             UUID        REFERENCES leads(id) ON DELETE SET NULL,
    conversation_id     UUID        REFERENCES conversations(id) ON DELETE SET NULL,
    message_id          UUID        REFERENCES messages(id) ON DELETE SET NULL,

    -- Audit timestamps
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- --------------------------------------------------------
    -- Constraints
    -- --------------------------------------------------------
    CONSTRAINT chk_source_not_empty
        CHECK (char_length(trim(source)) > 0),

    CONSTRAINT chk_idempotency_key_format
        CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),

    CONSTRAINT chk_attempt_count
        CHECK (attempt_count >= 0 AND attempt_count <= 10),

    CONSTRAINT chk_request_headers_sanitized
        CHECK (
            NOT (request_headers ? 'authorization') AND
            NOT (request_headers ? 'Authorization') AND
            NOT (request_headers ? 'x-hub-signature') AND
            NOT (request_headers ? 'x-hub-signature-256')
        )
);

-- --------------------------------------------------------
-- Scheduled purge: delete processed events older than 90 days
-- Runs daily at 02:00 UTC. Adjust retention as needed.
-- --------------------------------------------------------
SELECT cron.schedule(
    'purge-old-webhook-events',
    '0 2 * * *',
    $$
        DELETE FROM webhook_events
        WHERE processed_at IS NOT NULL
          AND received_at < now() - INTERVAL '90 days';
    $$
);

COMMENT ON TABLE  webhook_events                    IS 'Append-only log of inbound webhook payloads — never delete rows manually';
COMMENT ON COLUMN webhook_events.idempotency_key    IS 'SHA-256 of (source:external_event_id:payload_hash) — enforces exactly-once processing';
COMMENT ON COLUMN webhook_events.raw_body           IS 'Preserved verbatim for HMAC re-verification and event replay';
COMMENT ON COLUMN webhook_events.request_headers    IS 'Sanitized request headers — signature headers MUST be stripped before insert';
COMMENT ON COLUMN webhook_events.attempt_count      IS 'Number of processing attempts; max 10 before manual review';
COMMENT ON COLUMN webhook_events.retry_after        IS 'Earliest time a worker should retry; NULL when not retrying';
