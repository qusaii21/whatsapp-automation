#!/usr/bin/env node
// ============================================================
// test-whatsapp-webhook.mjs
// ============================================================
// Simulates:
//   1. WhatsApp webhook GET verification
//   2. Inbound text message from a WhatsApp user
//   3. Delivery status update (delivered)
//
// Run: node scripts/test-whatsapp-webhook.mjs
// ============================================================

import crypto from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const envPath = resolve(process.cwd(), '.env.local');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => [l.split('=')[0].trim(), l.slice(l.indexOf('=') + 1).trim()])
);

const APP_SECRET   = env.WHATSAPP_APP_SECRET;
const VERIFY_TOKEN = env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
const PHONE_NUM_ID = env.WHATSAPP_PHONE_NUMBER_ID || '123456789';
const BASE_URL     = process.env.TEST_URL || 'http://localhost:3000';
const URL          = `${BASE_URL}/api/webhooks/whatsapp`;

// ── 1. GET verification ───────────────────────────────────────
console.log('\n── 1. Testing GET (webhook verification) ──');
if (!VERIFY_TOKEN || VERIFY_TOKEN.includes('REPLACE') || !VERIFY_TOKEN) {
  console.log('⚠️  WHATSAPP_WEBHOOK_VERIFY_TOKEN not set — skipping');
} else {
  const challenge = 'wa_challenge_' + Date.now();
  const verifyUrl = `${URL}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=${challenge}`;
  const res = await fetch(verifyUrl);
  const body = await res.text();
  if (res.status === 200 && body === challenge) {
    console.log('✅ Verification passed');
  } else {
    console.log('❌ Failed', res.status, body);
  }
}

if (!APP_SECRET || APP_SECRET.includes('REPLACE')) {
  console.log('\n⚠️  WHATSAPP_APP_SECRET not set — skipping POST tests');
  process.exit(0);
}

async function post(payload, label) {
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
  console.log(`\n── ${label} ──`);
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
    body,
  });
  const text = await res.text();
  console.log('Status:', res.status, '| Body:', text);
  return res.status;
}

// ── 2. Inbound text message ───────────────────────────────────
const inboundMsg = {
  object: 'whatsapp_business_account',
  entry: [{
    id: '102290129340398',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15550783881', phone_number_id: PHONE_NUM_ID },
        contacts: [{ profile: { name: 'Test Lead' }, wa_id: '16505551234' }],
        messages: [{
          id: 'wamid.test_inbound_' + Date.now(),
          from: '16505551234',
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text',
          text: { body: 'Hello, I am interested!' },
        }],
      },
    }],
  }],
};

const status1 = await post(inboundMsg, '2. Inbound text message');
if (status1 === 200) {
  console.log('✅ Accepted — check messages table in Supabase');
  console.log('   (will log "unknown lead" warning if lead with that phone doesn\'t exist yet)');
}

// ── 3. Delivery status webhook ────────────────────────────────
const deliveryStatus = {
  object: 'whatsapp_business_account',
  entry: [{
    id: '102290129340398',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15550783881', phone_number_id: PHONE_NUM_ID },
        statuses: [{
          id: 'wamid.fake_outbound_message_id',
          status: 'delivered',
          timestamp: String(Math.floor(Date.now() / 1000)),
          recipient_id: '16505551234',
        }],
      },
    }],
  }],
};

const status2 = await post(deliveryStatus, '3. Delivery status (delivered)');
if (status2 === 200) {
  console.log('✅ Accepted — delivery status processed (no-op if wamid doesn\'t exist in DB)');
}
