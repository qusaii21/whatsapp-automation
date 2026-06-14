# Meta Lead Ads — Testing & Deployment Guide

## Example Webhook Payloads

### GET — Verification Challenge (sent once when you subscribe)
```
GET /api/webhooks/meta-leads
  ?hub.mode=subscribe
  &hub.verify_token=YOUR_VERIFY_TOKEN
  &hub.challenge=1234567890
```
Expected response: `1234567890` (plain text, status 200)

---

### POST — Lead Ad Submission (sent on every form submission)
```json
{
  "object": "page",
  "entry": [
    {
      "id": "111222333444555",
      "time": 1717200000,
      "changes": [
        {
          "field": "leadgen",
          "value": {
            "leadgen_id": "987654321098765",
            "page_id": "111222333444555",
            "form_id": "555666777888999",
            "adgroup_id": "123456789012345",
            "ad_id": "234567890123456",
            "created_time": 1717200000
          }
        }
      ]
    }
  ]
}
```

### Meta Graph API response (fetched after webhook)
```json
{
  "id": "987654321098765",
  "created_time": "2024-06-01T10:00:00+0000",
  "ad_id": "234567890123456",
  "ad_name": "Q2 WhatsApp Campaign - India",
  "form_id": "555666777888999",
  "field_data": [
    { "name": "full_name", "values": ["Jane Doe"] },
    { "name": "phone_number", "values": ["+14155552671"] },
    { "name": "email", "values": ["jane@example.com"] },
    { "name": "what_are_you_interested_in", "values": ["Plan A - Monthly"] }
  ],
  "is_organic": false
}
```

### POST — Batch payload (multiple leads in one webhook call)
```json
{
  "object": "page",
  "entry": [
    {
      "id": "111222333444555",
      "time": 1717200000,
      "changes": [
        {
          "field": "leadgen",
          "value": {
            "leadgen_id": "987654321098765",
            "page_id": "111222333444555",
            "form_id": "555666777888999",
            "created_time": 1717200000
          }
        },
        {
          "field": "leadgen",
          "value": {
            "leadgen_id": "876543210987654",
            "page_id": "111222333444555",
            "form_id": "555666777888999",
            "created_time": 1717200001
          }
        }
      ]
    }
  ]
}
```

### POST — Non-leadgen change (should return 200, no processing)
```json
{
  "object": "page",
  "entry": [
    {
      "id": "111222333444555",
      "time": 1717200000,
      "changes": [
        {
          "field": "feed",
          "value": { "item": "post", "verb": "add" }
        }
      ]
    }
  ]
}
```

---

## End-to-End Request Flow

```
1. Meta Lead Ad submitted by user on Facebook/Instagram
   └─ Meta sends POST /api/webhooks/meta-leads

2. route.ts (GET /api/webhooks/meta-leads)
   ├─ Read raw body (request.text())
   ├─ Verify X-Hub-Signature-256 header (HMAC-SHA256)
   ├─ Zod validate payload
   └─ Delegate to MetaLeadService.processWebhookPayload()

3. MetaLeadService.processLeadgenEvent()
   ├─ Build idempotency key: SHA-256("meta-leads:leadgen_id")
   ├─ WebhookEventRepository.createIfNotExists()
   │   └─ If duplicate → return early (already processed)
   ├─ MetaIntegrationRepository.findActiveByPageId()
   │   └─ If not found → mark failed, outcome = unknown_page
   ├─ Check form_id against allowed_form_ids whitelist
   ├─ MetaGraphApiClient.fetchLeadDetails(leadgen_id)
   │   └─ GET https://graph.facebook.com/v21.0/{leadgen_id}
   ├─ extractLeadFields() → normalize phone to E.164
   └─ LeadRepository.upsertFromMetaAd()
       └─ Calls PostgreSQL function upsert_lead_from_meta_ad()
           ├─ Dedup by meta_lead_id (global)
           └─ Dedup by (organization_id, phone_e164, channel)

4. WebhookEventRepository.markProcessed()
   └─ Links lead_id + organization_id to webhook_event row

5. Returns 200 { ok: true, requestId }
```

---

## Local Testing

### Prerequisites
```bash
npm install
cp .env.example .env.local
# Fill in values in .env.local
npx supabase start       # Start local Supabase
npx supabase db push     # Apply all migrations
```

### Install ngrok for local webhook testing
```bash
brew install ngrok
ngrok http 3000
# Note the HTTPS URL: https://abc123.ngrok-free.app
```

### Start the dev server
```bash
npm run dev
```

### Test the verification endpoint
```bash
curl -X GET \
  "http://localhost:3000/api/webhooks/meta-leads?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=TEST_CHALLENGE_123" \
  -v
# Expected: 200 with body "TEST_CHALLENGE_123"
```

### Generate a valid HMAC signature for manual POST testing
```bash
node -e "
const crypto = require('crypto');
const body = JSON.stringify({
  object: 'page',
  entry: [{
    id: '111222333444555',
    time: Math.floor(Date.now()/1000),
    changes: [{
      field: 'leadgen',
      value: {
        leadgen_id: 'TEST_LEADGEN_' + Date.now(),
        page_id: '111222333444555',
        form_id: '555666777888999',
        created_time: Math.floor(Date.now()/1000)
      }
    }]
  }]
});
const sig = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
console.log('Body:', body);
console.log('Signature:', sig);
"
```

### Send a test webhook
```bash
# Replace SIGNATURE with output from the script above
curl -X POST http://localhost:3000/api/webhooks/meta-leads \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: SIGNATURE" \
  -d 'BODY_FROM_SCRIPT'
```

### Use Meta's Webhook Testing Tool
1. Go to developers.facebook.com → Your App → Webhooks
2. Subscribe to the `page` object, `leadgen` field
3. Use the **Send** button to fire a test event
4. Check your server logs and Supabase dashboard

### Test idempotency (send same event twice)
```bash
# Run the POST test above twice with the same leadgen_id
# Second call should return 200 with outcome: duplicate
# Check webhook_events table: status = 'duplicate'
```

---

## Database Setup for First Organization

After running migrations, register a test organization and Meta integration:

```sql
-- 1. Create organization
INSERT INTO organizations (name, slug, plan)
VALUES ('Test Business', 'test-business', 'starter')
RETURNING id;

-- 2. Register Meta integration (use actual page_id and access token)
-- Replace values with your actual Meta credentials
SELECT * FROM meta_integrations; -- verify empty

-- Use the API endpoint (POST /api/integrations/meta) in production
-- For local dev, insert directly using the service-role client:
INSERT INTO meta_integrations (
  organization_id,
  page_id,
  page_name,
  app_id,
  access_token_encrypted,  -- encrypt via encryptToken() in your app
  is_active
) VALUES (
  'YOUR_ORG_UUID',
  '111222333444555',
  'My Test Page',
  'YOUR_META_APP_ID',
  'ENCRYPTED_TOKEN',        -- use src/lib/utils/token-encryption.ts
  TRUE
);
```

---

## Production Deployment Considerations

### 1. Vercel Deployment
```bash
# Set all environment variables in Vercel dashboard
# Never commit .env.local

vercel env add META_APP_SECRET production
vercel env add META_WEBHOOK_VERIFY_TOKEN production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add META_TOKEN_ENCRYPT_KEY production
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
```

Vercel Edge Network handles HTTPS termination — the webhook URL will be:
`https://your-domain.com/api/webhooks/meta-leads`

### 2. Meta App Configuration
1. Create a Meta App at developers.facebook.com
2. Add **Webhooks** product
3. Subscribe to object: **Page**, field: **leadgen**
4. Set Callback URL to `https://your-domain.com/api/webhooks/meta-leads`
5. Set Verify Token to the value of `META_WEBHOOK_VERIFY_TOKEN`
6. For each Facebook Page, subscribe to the webhook:
   ```
   POST https://graph.facebook.com/v21.0/{page_id}/subscribed_apps
     ?subscribed_fields=leadgen
     &access_token={PAGE_ACCESS_TOKEN}
   ```

### 3. Meta App Secret Rotation
If you rotate `META_APP_SECRET`:
1. Update the env var in all environments
2. Update the App Secret in Meta App Settings
3. Meta will start signing webhooks with the new secret immediately
4. No DB changes required (the secret is not stored in DB)

### 4. Access Token Rotation
If `META_TOKEN_ENCRYPT_KEY` is rotated:
1. Decrypt all tokens using the old key
2. Re-encrypt with the new key
3. Update meta_integrations rows
4. Then rotate the env var

### 5. Monitoring
Key metrics to watch:
- `webhook_events` WHERE `status = 'failed'` — processing failures
- `webhook_events` WHERE `status = 'received' AND retry_after < now()` — stalled events
- Graph API error rates (check server logs for MetaGraphApiError)
- Lead creation rate vs expected ad spend

### 6. Scaling
- The webhook endpoint is stateless — Vercel auto-scales horizontally
- Supabase PgBouncer handles connection pooling
- For > 100 req/sec webhook volume: consider Supabase Edge Functions as the
  ingestion layer (writes webhook_event + enqueues) and a worker for Graph API calls
- The idempotency table (webhook_events) prevents double-processing under any scaling scenario

### 7. Meta Retry Behavior
- Meta retries on HTTP 5xx responses, up to 10 times with exponential backoff
- Meta stops retrying on HTTP 2xx (including for failed business logic)
- Our design: return 5xx only for transient errors (DB down, Graph API timeout)
           return 2xx for permanent failures (unknown page_id, form not allowed)
- The webhook_events table captures ALL outcomes for manual replay

### 8. Required Environment Variables
| Variable | Purpose | Example |
|---|---|---|
| `META_APP_SECRET` | HMAC signature verification | `abc123...` (32+ chars) |
| `META_WEBHOOK_VERIFY_TOKEN` | GET challenge verification | `my-random-token-here` |
| `META_TOKEN_ENCRYPT_KEY` | AES-256-GCM key for access tokens | `32-char-random-string` |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | `https://xyz.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key | `eyJ...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server-only) | `eyJ...` |

### 9. Security Checklist
- [ ] `SUPABASE_SERVICE_ROLE_KEY` never bundled in client code (`'server-only'` imports)
- [ ] `META_APP_SECRET` never logged (check logger redaction list)
- [ ] `access_token_encrypted` never returned in client-facing API responses
- [ ] Webhook endpoint returns 403 on signature mismatch
- [ ] All DB writes via service-role client only in webhook pipeline
- [ ] `invitation_token` column never returned in API responses
- [ ] RLS enabled on all tables (verified in migration 0010 + 0014)
