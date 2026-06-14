import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import {
  MetaWebhookPayloadSchema,
  MetaVerificationQuerySchema,
} from '@/schemas/meta-webhook.schema';
import {
  verifyMetaWebhookSignature,
  verifyWebhookToken,
} from '@/lib/meta/validator';
import { getAdminClient } from '@/lib/supabase/admin';
import { createLogger } from '@/lib/logger';
import { generateRequestId } from '@/lib/utils/idempotency';
import { MetaLeadService } from '@/services/meta-lead.service';
import { WebhookEventRepository } from '@/repositories/webhook-event.repository';
import { LeadRepository } from '@/repositories/lead.repository';
import { MetaIntegrationRepository } from '@/repositories/meta-integration.repository';
import { createMetaGraphApiClient } from '@/lib/meta/graph-api-client';

// ============================================================
// Route: /api/webhooks/meta-leads
// ============================================================
// GET  — Meta webhook verification (challenge-response)
// POST — Meta Lead Ads event ingestion
//
// Design constraints:
//   - No business logic in this file — all delegated to service
//   - Raw body MUST be read before JSON parsing (HMAC requirement)
//   - Return 200 quickly; Meta requires response within 20s
//   - Return 5xx only for retryable errors (triggers Meta retry)
//   - Return 2xx for non-retryable failures (unknown org, bad form)
// ============================================================

export const runtime = 'nodejs'; // Required: uses Node.js crypto for HMAC

// ---- GET: Webhook verification handshake -------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  const log = createLogger({ source: 'meta-webhook-verify' });

  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const parsed = MetaVerificationQuerySchema.safeParse(params);

  if (!parsed.success) {
    log.warn('Webhook verification: invalid query parameters');
    return NextResponse.json({ error: 'Bad Request' }, { status: 400 });
  }

  const { 'hub.verify_token': receivedToken, 'hub.challenge': challenge } = parsed.data;
  const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN ?? '';

  if (!expectedToken) {
    log.error('META_WEBHOOK_VERIFY_TOKEN is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  if (!verifyWebhookToken(receivedToken, expectedToken)) {
    log.warn('Webhook verification: token mismatch');
    return new NextResponse('Forbidden', { status: 403 });
  }

  log.info('Webhook verification successful');
  // Meta expects the challenge as plain text with status 200
  return new NextResponse(challenge, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}

// ---- POST: Lead event ingestion ----------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, source: 'meta-webhook-ingest' });

  // ---- 1. Validate required env vars are present ----------
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    log.error('META_APP_SECRET is not configured');
    // 500 → Meta will retry; this is a configuration error that should be fixed
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  // ---- 2. Read raw body BEFORE any JSON parsing -----------
  // CRITICAL: request.text() must be called before request.json()
  // The raw bytes are required for HMAC-SHA256 verification.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (err) {
    log.error('Failed to read request body', err);
    return NextResponse.json({ error: 'Bad Request' }, { status: 400 });
  }

  if (!rawBody || rawBody.length === 0) {
    log.warn('Empty request body received');
    return NextResponse.json({ error: 'Empty body' }, { status: 400 });
  }

  // ---- 3. Verify HMAC-SHA256 signature --------------------
  const signatureHeader = request.headers.get('x-hub-signature-256') ?? '';

  if (!signatureHeader) {
    log.warn('Missing X-Hub-Signature-256 header');
    return new NextResponse('Forbidden', { status: 403 });
  }

  const isValidSignature = verifyMetaWebhookSignature(rawBody, signatureHeader, appSecret);
  if (!isValidSignature) {
    log.warn('Invalid webhook signature — possible spoofed request');
    return new NextResponse('Forbidden', { status: 403 });
  }

  // ---- 4. Parse and validate payload with Zod -------------
  let payload: ReturnType<typeof MetaWebhookPayloadSchema.parse>;
  try {
    const raw = JSON.parse(rawBody) as unknown;
    payload = MetaWebhookPayloadSchema.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      log.warn('Webhook body is not valid JSON');
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (err instanceof ZodError) {
      log.warn('Webhook payload failed schema validation', {
        issues: String(err.issues.length),
      });
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }
    throw err; // Re-throw unexpected errors
  }

  // ---- 5. Build sanitized headers (strip all signature/auth headers) ----
  const safeHeaders: Record<string, string> = {};
  const BLOCKED_HEADERS = new Set([
    'x-hub-signature',
    'x-hub-signature-256',
    'authorization',
    'cookie',
  ]);
  request.headers.forEach((value, key) => {
    if (!BLOCKED_HEADERS.has(key.toLowerCase())) {
      safeHeaders[key] = value;
    }
  });

  // ---- 6. Delegate to service layer -----------------------
  try {
    const db = getAdminClient();
    const webhookEventRepo = new WebhookEventRepository(db, log);
    const leadRepo = new LeadRepository(db, log);
    const metaIntegrationRepo = new MetaIntegrationRepository(db, log);

    const service = new MetaLeadService(
      webhookEventRepo,
      leadRepo,
      metaIntegrationRepo,
      (accessToken) => createMetaGraphApiClient(accessToken, log),
      log,
    );

    const result = await service.processWebhookPayload(rawBody, payload, requestId);

    log.info('Webhook processing complete', {
      totalEvents: String(result.totalEvents),
      processed: String(result.results.filter((r) => r.outcome === 'processed').length),
      duplicates: String(result.results.filter((r) => r.outcome === 'duplicate').length),
    });

    return NextResponse.json({ ok: true, requestId }, { status: 200 });
  } catch (err) {
    log.error('Unhandled error during webhook processing', err);
    // Return 500 to trigger Meta retry for truly unexpected errors
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
