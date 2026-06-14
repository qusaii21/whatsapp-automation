import { NextRequest, NextResponse } from 'next/server';
import { logger as rootLogger } from '@/lib/logger';
import { generateRequestId } from '@/lib/utils/idempotency';
import { SendMessageRequestSchema } from '@/schemas/whatsapp-webhook.schema';
import { createWhatsAppService, WhatsAppApiError } from '@/services/whatsapp.service';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const logger = rootLogger.child({ route: 'POST /api/whatsapp/send' });

// ─── POST — send a WhatsApp message ──────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  const reqLogger = logger.child({ requestId });

  // 1. Auth — require an authenticated Supabase session
  const supabase = await createServerSupabaseClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Parse body
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // 3. Validate the send request
  const parsedMsg = SendMessageRequestSchema.safeParse(rawBody);
  if (!parsedMsg.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsedMsg.error.flatten() },
      { status: 422 },
    );
  }

  // Extract context fields from the body
  const ctx = rawBody as Record<string, unknown>;
  const organizationId = ctx.organizationId as string | undefined;
  const leadId = ctx.leadId as string | undefined;
  const conversationId = ctx.conversationId as string | undefined;
  const agentId = user.id;

  if (!organizationId || !leadId || !conversationId) {
    return NextResponse.json(
      { error: 'organizationId, leadId, and conversationId are required' },
      { status: 422 },
    );
  }

  // 4. Send
  try {
    const service = createWhatsAppService();
    const result = await service.sendMessage(parsedMsg.data, {
      organizationId,
      leadId,
      conversationId,
      agentId,
    });

    reqLogger.info('Outbound message queued', {
      waMessageId: result.waMessageId,
      messageId: result.messageId,
      organizationId,
      leadId,
      type: parsedMsg.data.type,
    });

    return NextResponse.json({
      waMessageId: result.waMessageId,
      messageId: result.messageId,
    });
  } catch (err) {
    if (err instanceof WhatsAppApiError) {
      reqLogger.warn('WhatsApp API error', {
        code: err.code,
        isRetryable: err.isRetryable,
        message: err.message,
      });

      if (err.isRetryable) {
        return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 });
      }
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }

    reqLogger.error('Unhandled error sending WhatsApp message', err instanceof Error ? err : new Error(String(err)));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
