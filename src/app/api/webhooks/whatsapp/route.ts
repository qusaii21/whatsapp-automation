import { NextRequest, NextResponse } from 'next/server';
import { logger as rootLogger } from '@/lib/logger';
import { verifyMetaWebhookSignature } from '@/lib/meta/validator';
import { generateRequestId } from '@/lib/utils/idempotency';
import {
  WaWebhookPayloadSchema,
  WaVerificationQuerySchema,
} from '@/schemas/whatsapp-webhook.schema';
import { createWhatsAppService, WhatsAppApiError } from '@/services/whatsapp.service';

export const runtime = 'nodejs';

const logger = rootLogger.child({ route: 'POST /api/webhooks/whatsapp' });

// ─── GET — webhook verification ───────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!verifyToken) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);
  const parsed = WaVerificationQuerySchema.safeParse({
    'hub.mode': searchParams.get('hub.mode'),
    'hub.verify_token': searchParams.get('hub.verify_token'),
    'hub.challenge': searchParams.get('hub.challenge'),
  });

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid verification request' }, { status: 400 });
  }

  // Use timingSafeEqual via the existing utility
  const { verifyWebhookToken } = await import('@/lib/meta/validator');
  const tokenValid = verifyWebhookToken(parsed.data['hub.verify_token'], verifyToken);
  if (!tokenValid) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Meta expects a plain text response with just the challenge value
  return new NextResponse(parsed.data['hub.challenge'], {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}

// ─── POST — inbound messages + delivery status webhooks ───────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  const reqLogger = logger.child({ requestId });

  // 1. Read raw body BEFORE parsing (needed for HMAC verification)
  const rawBody = await request.text();

  // 2. Verify HMAC-SHA256 signature
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    reqLogger.error('WHATSAPP_APP_SECRET not configured', new Error('missing env var'));
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const signatureHeader = request.headers.get('x-hub-signature-256') ?? '';
  const signatureValid = await verifyMetaWebhookSignature(rawBody, signatureHeader, appSecret);
  if (!signatureValid) {
    reqLogger.warn('Invalid webhook signature', { signatureHeader: signatureHeader.slice(0, 20) });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 3. Parse JSON
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // 4. Validate payload shape
  const parsed = WaWebhookPayloadSchema.safeParse(body);
  if (!parsed.success) {
    reqLogger.warn('Invalid WhatsApp webhook payload', { errorCount: parsed.error.errors.length });
    // Return 200 to prevent Meta from retrying malformed payloads we can't process
    return NextResponse.json({ received: true });
  }

  // 5. Resolve organization from phone_number_id
  // The phone_number_id in the metadata tells us which WABA/org this belongs to.
  // For now we use the env var WHATSAPP_PHONE_NUMBER_ID to match, and resolve
  // the organization at runtime.  In a fully multi-tenant setup, store a
  // phone_number_id → organization_id mapping in the DB.
  const organizationId = await resolveOrganizationId(parsed.data);
  if (!organizationId) {
    reqLogger.warn('Could not resolve organization for webhook', {
      entryCount: parsed.data.entry.length,
    });
    return NextResponse.json({ received: true });
  }

  // 6. Process — respond 200 immediately; errors are logged but don't cause retries
  try {
    const service = createWhatsAppService();
    const result = await service.processWebhookPayload(parsed.data, organizationId);

    if (result.errors.length > 0) {
      reqLogger.warn('Some webhook events failed processing', { errorCount: result.errors.length });
    }

    reqLogger.info('Webhook processed', {
      messagesProcessed: result.messagesProcessed,
      statusesProcessed: result.statusesProcessed,
      errorCount: result.errors.length,
    });
  } catch (err) {
    if (err instanceof WhatsAppApiError && err.isRetryable) {
      reqLogger.error('Retryable error processing WhatsApp webhook', err);
      return NextResponse.json({ error: 'Temporary error' }, { status: 503 });
    }
    reqLogger.error('Unhandled error processing WhatsApp webhook', err instanceof Error ? err : new Error(String(err)));
    // Return 200 to avoid retry storms for non-retryable errors
  }

  return NextResponse.json({ received: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolves the organization ID from the webhook payload.
 * In a single-tenant deployment the env var WHATSAPP_PHONE_NUMBER_ID is enough.
 * Multi-tenant: query a whatsapp_integrations table keyed by phone_number_id.
 */
async function resolveOrganizationId(payload: {
  entry: Array<{ changes: Array<{ value: { metadata: { phone_number_id: string } } }> }>;
}): Promise<string | null> {
  const envPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const envOrgId = process.env.WHATSAPP_ORGANIZATION_ID; // optional single-tenant shortcut

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const phoneNumberId = change.value.metadata.phone_number_id;
      if (envPhoneNumberId && phoneNumberId === envPhoneNumberId && envOrgId) {
        return envOrgId;
      }
    }
  }

  return null;
}
