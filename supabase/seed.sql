-- ============================================================
-- Seed: Development / Demo Data
-- ============================================================
-- Run ONLY in local dev and staging environments.
-- Never run against production.
-- ============================================================

-- Seed a demo lead
INSERT INTO leads (
    phone_e164, name, email, channel, status,
    ad_id, campaign_name, metadata
) VALUES (
    '+14155552671', 'Jane Demo', 'jane@example.com', 'whatsapp', 'new',
    'ad_demo_001', 'Q1 WhatsApp Campaign',
    '{"utm_source": "facebook", "utm_medium": "cpc", "interest": "Plan A"}'::jsonb
) ON CONFLICT (phone_e164, channel) DO NOTHING;

-- Seed an open conversation for the demo lead
WITH demo_lead AS (
    SELECT id FROM leads WHERE phone_e164 = '+14155552671' AND channel = 'whatsapp'
)
INSERT INTO conversations (lead_id, channel, status)
SELECT id, 'whatsapp', 'open'
FROM demo_lead
ON CONFLICT DO NOTHING;

-- Seed demo messages
WITH demo_conv AS (
    SELECT c.id AS conv_id, l.id AS lead_id
    FROM conversations c
    JOIN leads l ON l.id = c.lead_id
    WHERE l.phone_e164 = '+14155552671'
    LIMIT 1
)
INSERT INTO messages (
    conversation_id, lead_id, direction, sender_type,
    whatsapp_message_id, message_type, content, raw_payload,
    delivery_status, sent_at
)
SELECT
    conv_id, lead_id, 'inbound', 'lead',
    'wamid.seed_msg_001', 'text', 'Hi, I saw your ad. Tell me more about Plan A.',
    '{"type": "text", "text": {"body": "Hi, I saw your ad. Tell me more about Plan A."}}'::jsonb,
    'delivered', now() - INTERVAL '2 hours'
FROM demo_conv
UNION ALL
SELECT
    conv_id, lead_id, 'outbound', 'ai_bot',
    'wamid.seed_msg_002', 'text',
    'Hi Jane! Thanks for reaching out. Plan A includes unlimited messaging and AI automation. Shall I send you the full brochure?',
    '{"type": "text"}'::jsonb,
    'read', now() - INTERVAL '1 hour 55 minutes'
FROM demo_conv
ON CONFLICT (whatsapp_message_id) DO NOTHING;
