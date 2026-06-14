import 'server-only';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from '@/lib/logger';
import { logger as rootLogger } from '@/lib/logger';
import { getAdminClient } from '@/lib/supabase/admin';
import {
  WhatsAppCloudApiClient,
  WhatsAppApiError,
  createWhatsAppApiClient,
} from '@/lib/whatsapp/cloud-api-client';
import { MessageRepository } from '@/repositories/message.repository';
import { ConversationRepository } from '@/repositories/conversation.repository';
import { LeadRepository } from '@/repositories/lead.repository';
import type {
  WaWebhookPayload,
  WaInboundMessage,
  WaStatus,
  WaChangeValue,
} from '@/schemas/whatsapp-webhook.schema';
import type { SendMessageRequest } from '@/schemas/whatsapp-webhook.schema';

// ─── Result types ─────────────────────────────────────────────────────────────

export interface ProcessWebhookResult {
  messagesProcessed: number;
  statusesProcessed: number;
  errors: Array<{ waMessageId: string; error: string }>;
}

export interface SendMessageResult {
  waMessageId: string;
  messageId: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class WhatsAppService {
  private readonly messageRepo: MessageRepository;
  private readonly conversationRepo: ConversationRepository;
  private readonly leadRepo: LeadRepository;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: SupabaseClient<any>,
    private readonly apiClient: WhatsAppCloudApiClient,
    private readonly logger: Logger,
  ) {
    this.messageRepo = new MessageRepository(db, logger);
    this.conversationRepo = new ConversationRepository(db, logger);
    this.leadRepo = new LeadRepository(db, logger);
  }

  // ── Inbound webhook ────────────────────────────────────────────────────────

  async processWebhookPayload(
    payload: WaWebhookPayload,
    organizationId: string,
  ): Promise<ProcessWebhookResult> {
    const result: ProcessWebhookResult = {
      messagesProcessed: 0,
      statusesProcessed: 0,
      errors: [],
    };

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;
        await this.processChangeValue(change.value, organizationId, result);
      }
    }

    return result;
  }

  // ── Outbound send ──────────────────────────────────────────────────────────

  /**
   * Sends a WhatsApp message and persists it to the messages table.
   * Caller must have already resolved organizationId, leadId, conversationId.
   */
  async sendMessage(
    request: SendMessageRequest,
    context: {
      organizationId: string;
      leadId: string;
      conversationId: string;
      agentId?: string;
    },
  ): Promise<SendMessageResult> {
    let waResponse: { waMessageId: string; recipientWaId: string };

    try {
      if (request.type === 'text') {
        waResponse = await this.apiClient.sendText(
          request.to,
          request.text.body,
          request.text.preview_url,
        );
      } else {
        waResponse = await this.apiClient.sendTemplate(
          request.to,
          request.template.name,
          request.template.language.code,
          request.template.components as unknown[],
        );
      }
    } catch (err) {
      if (err instanceof WhatsAppApiError) {
        this.logger.error('WhatsApp send failed', err, {
          to: request.to,
          type: request.type,
          organizationId: context.organizationId,
          isRetryable: err.isRetryable,
        });
      }
      throw err;
    }

    const { message } = await this.messageRepo.insertIdempotent({
      organizationId: context.organizationId,
      conversationId: context.conversationId,
      leadId: context.leadId,
      whatsappMessageId: waResponse.waMessageId,
      direction: 'outbound',
      senderType: context.agentId ? 'agent' : 'system',
      content: request.type === 'text' ? request.text.body : null,
      messageType: request.type === 'template' ? `template:${request.template.name}` : 'text',
      sentAt: new Date(),
    });

    this.logger.info('Message sent', {
      organizationId: context.organizationId,
      waMessageId: waResponse.waMessageId,
      messageId: message.id,
      type: request.type,
    });

    return { waMessageId: waResponse.waMessageId, messageId: message.id };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async processChangeValue(
    value: WaChangeValue,
    organizationId: string,
    result: ProcessWebhookResult,
  ): Promise<void> {
    // Process inbound messages
    if (value.messages?.length) {
      const contactMap = new Map(
        (value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]),
      );

      for (const msg of value.messages) {
        try {
          await this.processInboundMessage(msg, organizationId, contactMap);
          result.messagesProcessed++;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          result.errors.push({ waMessageId: msg.id, error });
          this.logger.error('Failed to process inbound message', err instanceof Error ? err : new Error(error), {
            waMessageId: msg.id,
            organizationId,
          });
        }
      }
    }

    // Process delivery status updates
    if (value.statuses?.length) {
      for (const status of value.statuses) {
        try {
          await this.processDeliveryStatus(status);
          result.statusesProcessed++;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          result.errors.push({ waMessageId: status.id, error });
          this.logger.error('Failed to process delivery status', err instanceof Error ? err : new Error(error), {
            waMessageId: status.id,
            status: status.status,
          });
        }
      }
    }
  }

  private async processInboundMessage(
    msg: WaInboundMessage,
    organizationId: string,
    contactMap: Map<string, string | null>,
  ): Promise<void> {
    // Normalise the sender phone: WhatsApp sends without '+', add it
    const phoneE164 = `+${msg.from}`;
    const contactName = contactMap.get(msg.from) ?? null;

    // Find the lead by phone — must already exist (created via Meta Lead Ads)
    const lead = await this.leadRepo.findByPhone(phoneE164, organizationId);
    if (!lead) {
      this.logger.warn('Received WhatsApp message from unknown lead', {
        from: msg.from,
        waMessageId: msg.id,
        organizationId,
      });
      // Store as-is without a lead link — create anonymous lead optionally in future
      return;
    }

    // Get or create the open conversation for this lead
    const { conversation } = await this.conversationRepo.getOrCreateOpen({
      organizationId,
      leadId: lead.id,
      channel: 'whatsapp',
    });

    const content = extractMessageContent(msg);

    const { isDuplicate } = await this.messageRepo.insertIdempotent({
      organizationId,
      conversationId: conversation.id,
      leadId: lead.id,
      whatsappMessageId: msg.id,
      direction: 'inbound',
      senderType: 'lead',
      content,
      messageType: msg.type,
      rawPayload: msg as unknown as Record<string, unknown>,
      sentAt: new Date(parseInt(msg.timestamp, 10) * 1000),
    });

    if (isDuplicate) {
      this.logger.debug('Duplicate inbound message — skipped', { waMessageId: msg.id });
      return;
    }

    // Update contact name if we received one and lead doesn't have a name yet
    if (contactName && !lead.name) {
      // Best-effort name update — non-fatal
      try {
        await this.leadRepo.updateName(lead.id, contactName);
      } catch { /* ignore */ }
    }

    this.logger.info('Inbound message processed', {
      organizationId,
      leadId: lead.id,
      conversationId: conversation.id,
      waMessageId: msg.id,
      type: msg.type,
    });
  }

  private async processDeliveryStatus(status: WaStatus): Promise<void> {
    const ts = new Date(parseInt(status.timestamp, 10) * 1000);

    const failureReason = status.errors?.[0]
      ? `[${status.errors[0].code}] ${status.errors[0].title}`
      : undefined;

    await this.messageRepo.updateDeliveryStatus({
      whatsappMessageId: status.id,
      status: status.status === 'deleted' ? 'failed' : status.status,
      failureReason,
      sentAt:      status.status === 'sent'      ? ts : undefined,
      deliveredAt: status.status === 'delivered' ? ts : undefined,
      readAt:      status.status === 'read'      ? ts : undefined,
      failedAt:    (status.status === 'failed' || status.status === 'deleted') ? ts : undefined,
    });
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function extractMessageContent(msg: WaInboundMessage): string | null {
  switch (msg.type) {
    case 'text':     return msg.text?.body ?? null;
    case 'image':    return msg.image?.caption ?? null;
    case 'video':    return msg.video?.caption ?? null;
    case 'document': return msg.document?.caption ?? msg.document?.filename ?? null;
    case 'location':
      if (msg.location) {
        const { latitude, longitude, name } = msg.location;
        return name ?? `${latitude},${longitude}`;
      }
      return null;
    default:         return null;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createWhatsAppService(): WhatsAppService {
  const db = getAdminClient();
  const apiClient = createWhatsAppApiClient();
  const svcLogger = rootLogger.child({ service: 'WhatsAppService' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new WhatsAppService(db as unknown as SupabaseClient<any>, apiClient, svcLogger);
}

// re-export error type so route handlers don't need to import from the client
export { WhatsAppApiError };
