#!/usr/bin/env node
// ============================================================
// test-meta-webhook.mjs
// ============================================================
// Simulates a Meta Lead Ads webhook POST to your local server.
// Run: node scripts/test-meta-webhook.mjs
//
// Prerequisites:
//   - npm run dev is running (localhost:3000)
//   - .env.local has META_APP_SECRET set
// ============================================================

import crypto from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Load .env.local ──────────────────────────────────────────
const envPath = resolve(process.cwd(), '.env.local');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => [l.split('=')[0].trim(), l.slice(l.indexOf('=') + 1).trim()])
);

const APP_SECRET = env.META_APP_SECRET;
const BASE_URL   = process.env.TEST_URL || 'http://localhost:3000';

if (!APP_SECRET || APP_SECRET.includes('REPLACE')) {
  console.error('❌ META_APP_SECRET not set in .env.local');
  process.exit(1);
}

// ── Test payload (simulates a real Meta leadgen event) ────────
// Replace these IDs with real ones from your Meta page if you
// want to also test the Graph API fetch (LEADGEN_ID must exist).
const PAGE_ID   = env.META_TEST_PAGE_ID   || '123456789012345';
const FORM_ID   = env.META_TEST_FORM_ID   || '987654321098765';
const LEADGEN_ID = env.META_TEST_LEADGEN_ID || '111222333444555';

const payload = {
  object: 'page',
  entry: [{
    id: PAGE_ID,
    time: Math.floor(Date.now() / 1000),
    changes: [{
      field: 'leadgen',
      value: {
        leadgen_id: LEADGEN_ID,
        page_id: PAGE_ID,
        form_id: FORM_ID,
        adgroup_id: '11223344556677',
        ad_id: '99887766554433',
        created_time: Math.floor(Date.now() / 1000),
      },
    }],
  }],
};

const body = JSON.stringify(payload);

// ── Sign the payload ──────────────────────────────────────────
const signature = 'sha256=' + crypto
  .createHmac('sha256', APP_SECRET)
  .update(body)
  .digest('hex');

// ── Send ──────────────────────────────────────────────────────
const url = `${BASE_URL}/api/webhooks/meta-leads`;
console.log(`\nPOST ${url}`);
console.log('Payload:', JSON.stringify(payload, null, 2));
console.log('Signature:', signature.slice(0, 30) + '...');

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Hub-Signature-256': signature,
  },
  body,
});

const responseText = await res.text();
console.log('\n── Response ──');
console.log('Status:', res.status);
console.log('Body:  ', responseText);

if (res.status === 200) {
  console.log('\n✅ Webhook accepted (200)');
  console.log('Check your Supabase webhook_events table for the new row.');
} else if (res.status === 401) {
  console.log('\n❌ Signature verification failed — check META_APP_SECRET');
} else if (res.status === 503) {
  console.log('\n⚠️  Graph API fetch failed (leadgen_id not real) — expected if using fake IDs');
  console.log('Set META_TEST_PAGE_ID, META_TEST_FORM_ID, META_TEST_LEADGEN_ID in .env.local for real test');
} else {
  console.log('\n❌ Unexpected response');
}

// ── Also test GET verification ────────────────────────────────
console.log('\n── Testing GET (webhook verification) ──');
const verifyToken = env.META_WEBHOOK_VERIFY_TOKEN;
if (!verifyToken || verifyToken.includes('REPLACE')) {
  console.log('⚠️  META_WEBHOOK_VERIFY_TOKEN not set — skipping verification test');
} else {
  const challenge = 'test_challenge_' + Date.now();
  const verifyUrl = `${BASE_URL}/api/webhooks/meta-leads?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=${challenge}`;
  const vRes = await fetch(verifyUrl);
  const vBody = await vRes.text();
  if (vRes.status === 200 && vBody === challenge) {
    console.log('✅ Verification passed — challenge echoed correctly');
  } else {
    console.log('❌ Verification failed', vRes.status, vBody);
  }
}
