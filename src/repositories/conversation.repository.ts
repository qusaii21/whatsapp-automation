import 'server-only';
import type { SupabaseClient, PostgrestError } from '@supabase/supabase-js';
import type { Conversation } from '@/types/database.types';
import type { Logger } from '@/lib/logger';

type SBSingle<T> = { data: T | null; error: PostgrestError | null };

// ─── Input types ──────────────────────────────────────────────────────────────

export interface GetOrCreateConversationInput {
  organizationId: string;
  leadId: string;
  channel: 'whatsapp';
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class ConversationRepository {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: SupabaseClient<any>,
    private readonly logger: Logger,
  ) {}

  /**
   * Delegates to the database function get_or_create_open_conversation()
   * which uses an advisory lock to prevent concurrent duplicate open conversations.
   */
  async getOrCreateOpen(
    input: GetOrCreateConversationInput,
  ): Promise<{ conversation: Conversation; isNew: boolean }> {
    const { data, error } = await (
      this.db.rpc('get_or_create_open_conversation', {
        p_organization_id: input.organizationId,
        p_lead_id: input.leadId,
        p_channel: input.channel,
      }) as unknown as Promise<SBSingle<Conversation>>
    );

    if (error) {
      this.logger.error('get_or_create_open_conversation RPC failed', error, {
        organizationId: input.organizationId,
        leadId: input.leadId,
        channel: input.channel,
      });
      throw error;
    }

    if (!data) {
      throw new Error('get_or_create_open_conversation returned no data');
    }

    // Heuristic: if created_at ≈ now (within 5s), it was just created
    const createdMs = new Date(data.created_at).getTime();
    const isNew = Date.now() - createdMs < 5_000;

    return { conversation: data, isNew };
  }

  /** Finds a conversation by ID within an organization. */
  async findById(id: string, organizationId: string): Promise<Conversation | null> {
    const { data, error } = await (
      this.db
        .from('conversations')
        .select()
        .eq('id', id)
        .eq('organization_id', organizationId)
        .maybeSingle() as unknown as Promise<SBSingle<Conversation>>
    );

    if (error) {
      this.logger.error('Failed to find conversation', error, {
        conversationId: id,
        organizationId,
      });
      throw error;
    }

    return data ?? null;
  }
}
