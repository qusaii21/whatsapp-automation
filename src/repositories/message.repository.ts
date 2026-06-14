import 'server-only';
import type { SupabaseClient, PostgrestError } from '@supabase/supabase-js';
import type { Message } from '@/types/database.types';
import type { Logger } from '@/lib/logger';

type SBSingle<T> = { data: T | null; error: PostgrestError | null };
type SBList<T>   = { data: T[] | null; error: PostgrestError | null };

// ─── Input/Output types ───────────────────────────────────────────────────────

export interface InsertMessageInput {
  organizationId: string;
  conversationId: string;
  leadId: string;
  /** Inbound: sender's wamid. Outbound: the wamid returned by the send API. */
  whatsappMessageId: string;
  direction: 'inbound' | 'outbound';
  senderType: 'lead' | 'agent' | 'ai_bot' | 'system';
  /** Null for non-text messages */
  content: string | null;
  messageType: string;
  /** Raw JSON payload stored for audit */
  rawPayload?: Record<string, unknown>;
  // Timestamps (all optional — defaults handled by DB)
  sentAt?: Date;
}

export interface UpdateDeliveryStatusInput {
  whatsappMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'deleted';
  failureReason?: string;
  sentAt?: Date;
  deliveredAt?: Date;
  readAt?: Date;
  failedAt?: Date;
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class MessageRepository {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: SupabaseClient<any>,
    private readonly logger: Logger,
  ) {}

  /**
   * Idempotently inserts a message by whatsapp_message_id.
   * Returns the existing row (with isDuplicate=true) if already present.
   */
  async insertIdempotent(
    input: InsertMessageInput,
  ): Promise<{ message: Message; isDuplicate: boolean }> {
    // Check for existing message first
    const { data: existing } = await (
      this.db
        .from('messages')
        .select()
        .eq('whatsapp_message_id', input.whatsappMessageId)
        .maybeSingle() as unknown as Promise<SBSingle<Message>>
    );

    if (existing) {
      return { message: existing, isDuplicate: true };
    }

    const { data, error } = await (
      this.db
        .from('messages')
        .insert({
          organization_id: input.organizationId,
          conversation_id: input.conversationId,
          lead_id: input.leadId,
          whatsapp_message_id: input.whatsappMessageId,
          direction: input.direction,
          sender_type: input.senderType,
          content: input.content,
          message_type: input.messageType,
          raw_payload: input.rawPayload ?? null,
          sent_at: input.sentAt?.toISOString() ?? new Date().toISOString(),
          delivery_status: input.direction === 'outbound' ? 'sent' : null,
        })
        .select()
        .single() as unknown as Promise<SBSingle<Message>>
    );

    if (error) {
      // Handle unique constraint race (concurrent duplicate insert)
      if ((error.code === '23505') || error.message.includes('duplicate')) {
        const { data: raceRow } = await (
          this.db
            .from('messages')
            .select()
            .eq('whatsapp_message_id', input.whatsappMessageId)
            .maybeSingle() as unknown as Promise<SBSingle<Message>>
        );
        if (raceRow) return { message: raceRow, isDuplicate: true };
      }

      this.logger.error('Failed to insert message', error, {
        whatsappMessageId: input.whatsappMessageId,
        conversationId: input.conversationId,
      });
      throw error;
    }

    return { message: data!, isDuplicate: false };
  }

  /**
   * Updates delivery status columns for an outbound message identified by wamid.
   * Timestamps are only set forward (sent < delivered < read).
   */
  async updateDeliveryStatus(input: UpdateDeliveryStatusInput): Promise<void> {
    const updates: Record<string, unknown> = {
      delivery_status: input.status,
    };

    if (input.sentAt)     updates.sent_at      = input.sentAt.toISOString();
    if (input.deliveredAt) updates.delivered_at = input.deliveredAt.toISOString();
    if (input.readAt)      updates.read_at      = input.readAt.toISOString();
    if (input.failedAt)    updates.failed_at    = input.failedAt.toISOString();
    if (input.failureReason) updates.failure_reason = input.failureReason.slice(0, 500);

    const { error } = await (
      this.db
        .from('messages')
        .update(updates)
        .eq('whatsapp_message_id', input.whatsappMessageId) as unknown as Promise<SBList<Message>>
    );

    if (error) {
      this.logger.warn('Failed to update message delivery status', {
        whatsappMessageId: input.whatsappMessageId,
        status: input.status,
        error: error.message,
      });
      // Non-fatal — best effort delivery tracking
    }
  }

  /** Finds a message by its WhatsApp message ID. */
  async findByWaMessageId(whatsappMessageId: string): Promise<Message | null> {
    const { data, error } = await (
      this.db
        .from('messages')
        .select()
        .eq('whatsapp_message_id', whatsappMessageId)
        .maybeSingle() as unknown as Promise<SBSingle<Message>>
    );

    if (error) {
      this.logger.error('Failed to find message by wamid', error, { whatsappMessageId });
      throw error;
    }

    return data ?? null;
  }
}
