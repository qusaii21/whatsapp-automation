import 'server-only';
import type { SupabaseClient, PostgrestError } from '@supabase/supabase-js';
import type { WebhookEvent } from '@/types/database.types';
import type { Json } from '@/types/database.types';
import type { Logger } from '@/lib/logger';

// NOTE ON TYPES: db is typed SupabaseClient<any> — Supabase's internal
// GenericSchema conditional resolves to `never` for hand-crafted Database
// types. We assert return types explicitly at each call site instead.

// Typed Supabase response helpers
type SBSingle<T> = { data: T | null; error: PostgrestError | null };
type SBList<T>   = { data: T[] | null; error: PostgrestError | null };

export interface CreateWebhookEventInput {
  source: string;
  idempotencyKey: string;
  externalEventId?: string;
  rawBody: string;
  parsedPayload?: Json;
  /** Sanitized headers — must NOT include signature or auth headers */
  requestHeaders?: Record<string, string>;
  organizationId?: string;
}

export interface CreateWebhookEventResult {
  event: WebhookEvent;
  isDuplicate: boolean;
}

export class WebhookEventRepository {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: SupabaseClient<any>,
    private readonly logger: Logger,
  ) {}

  /**
   * Inserts a new webhook event only if the idempotency_key is unseen.
   * Returns the existing event and isDuplicate=true if already recorded.
   *
   * This is the idempotency checkpoint — called BEFORE any lead processing.
   */
  async createIfNotExists(
    input: CreateWebhookEventInput,
  ): Promise<CreateWebhookEventResult> {
    // First try: INSERT and return
    const { data: inserted, error: insertError } = await (
      this.db
        .from('webhook_events')
        .insert({
          source: input.source,
          idempotency_key: input.idempotencyKey,
          external_event_id: input.externalEventId ?? null,
          raw_body: input.rawBody,
          parsed_payload: input.parsedPayload ?? null,
          request_headers: (input.requestHeaders ?? {}) as Json,
          organization_id: input.organizationId ?? null,
          status: 'received',
          attempt_count: 1,
        })
        .select()
        .single() as unknown as Promise<SBSingle<WebhookEvent>>
    );

    if (!insertError) {
      return { event: inserted!, isDuplicate: false };
    }

    // Unique violation on idempotency_key → duplicate event
    if (insertError.code === '23505') {
      const { data: existing, error: fetchError } = await (
        this.db
          .from('webhook_events')
          .select()
          .eq('idempotency_key', input.idempotencyKey)
          .single() as unknown as Promise<SBSingle<WebhookEvent>>
      );

      if (fetchError || !existing) {
        throw new Error(
          `Idempotency conflict but could not fetch existing event: ${fetchError?.message}`,
        );
      }

      this.logger.info('Duplicate webhook event detected', {
        idempotencyKey: input.idempotencyKey,
        source: input.source,
        webhookEventId: existing.id,
      });

      return { event: existing, isDuplicate: true };
    }

    this.logger.error('Failed to create webhook event', insertError, {
      source: input.source,
      idempotencyKey: input.idempotencyKey,
    });
    throw insertError;
  }

  /** Marks the event as currently being processed (updates status + timestamps) */
  async markProcessing(id: string): Promise<void> {
    const { error } = await (
      this.db
        .from('webhook_events')
        .update({
          status: 'processing',
          processing_started_at: new Date().toISOString(),
        })
        .eq('id', id) as unknown as Promise<SBList<WebhookEvent>>
    );

    if (error) {
      this.logger.warn('Failed to mark webhook event as processing', { webhookEventId: id });
      // Non-fatal — processing continues
    }
  }

  /** Marks the event as successfully processed and links created entities */
  async markProcessed(
    id: string,
    links: {
      organizationId?: string;
      leadId?: string;
      conversationId?: string;
      messageId?: string;
    },
  ): Promise<void> {
    const { error } = await (
      this.db
        .from('webhook_events')
        .update({
          status: 'processed',
          processed_at: new Date().toISOString(),
          organization_id: links.organizationId ?? null,
          lead_id: links.leadId ?? null,
          conversation_id: links.conversationId ?? null,
          message_id: links.messageId ?? null,
        })
        .eq('id', id) as unknown as Promise<SBList<WebhookEvent>>
    );

    if (error) {
      this.logger.warn('Failed to mark webhook event as processed', {
        webhookEventId: id,
      });
    }
  }

  /**
   * Marks the event as failed and increments attempt count.
   * Sets retry_after for exponential backoff (if retryable).
   */
  async markFailed(
    id: string,
    errorMessage: string,
    options: { retryable?: boolean; attemptCount?: number } = {},
  ): Promise<void> {
    const { retryable = false, attemptCount = 1 } = options;

    let retryAfter: string | null = null;
    if (retryable && attemptCount < 10) {
      // Exponential backoff: 30s * 2^attempt, capped at 30 minutes
      const delaySeconds = Math.min(30 * Math.pow(2, attemptCount), 1800);
      retryAfter = new Date(Date.now() + delaySeconds * 1000).toISOString();
    }

    const { error } = await (
      this.db
        .from('webhook_events')
        .update({
          status: retryable ? 'received' : 'failed',
          last_error: errorMessage.slice(0, 1000),
          retry_after: retryAfter,
          attempt_count: attemptCount,
        })
        .eq('id', id) as unknown as Promise<SBList<WebhookEvent>>
    );

    if (error) {
      this.logger.warn('Failed to mark webhook event as failed', { webhookEventId: id });
    }
  }

  /** Marks the event as a duplicate (no processing needed) */
  async markDuplicate(id: string): Promise<void> {
    const { error } = await (
      this.db
        .from('webhook_events')
        .update({ status: 'duplicate', processed_at: new Date().toISOString() })
        .eq('id', id) as unknown as Promise<SBList<WebhookEvent>>
    );

    if (error) {
      this.logger.warn('Failed to mark webhook event as duplicate', { webhookEventId: id });
    }
  }
}
