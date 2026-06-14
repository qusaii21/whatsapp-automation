import 'server-only';
import type { SupabaseClient, PostgrestError } from '@supabase/supabase-js';
import type { MetaIntegration } from '@/types/database.types';
import type { Logger } from '@/lib/logger';
import { decryptToken, encryptToken } from '@/lib/utils/token-encryption';

type SBSingle<T> = { data: T | null; error: PostgrestError | null };
type SBList<T>   = { data: T[] | null; error: PostgrestError | null };

// ============================================================
// MetaIntegrationRepository
// ============================================================
// Data access for the meta_integrations table.
// All methods use the admin (service-role) client because:
//   1. Webhook processing runs outside user sessions.
//   2. access_token_encrypted must only be read server-side.
// ============================================================

export interface CreateMetaIntegrationInput {
  organizationId: string;
  pageId: string;
  pageName?: string;
  appId: string;
  /** Plaintext access token — encrypted before storage */
  accessToken: string;
  allowedFormIds?: string[];
}

export interface MetaIntegrationWithToken extends Omit<MetaIntegration, 'access_token_encrypted'> {
  /** Decrypted plaintext access token — NEVER log or expose */
  accessToken: string;
}

export class MetaIntegrationRepository {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: SupabaseClient<any>,
    private readonly logger: Logger,
  ) {}

  /**
   * Finds an active integration by page_id and returns it with the
   * decrypted access token.
   *
   * This is the hot-path lookup called on every leadgen webhook event.
   * Uses the partial index: idx_meta_integrations_page_id WHERE is_active = TRUE.
   */
  async findActiveByPageId(
    pageId: string,
  ): Promise<MetaIntegrationWithToken | null> {
    const { data, error } = await (
      this.db
        .from('meta_integrations')
        .select('*')
        .eq('page_id', pageId)
        .eq('is_active', true)
        .maybeSingle() as unknown as Promise<SBSingle<MetaIntegration>>
    );

    if (error) {
      this.logger.error('Failed to find meta integration by page_id', error, { pageId });
      throw error;
    }

    if (!data) return null;

    const accessToken = decryptToken(data.access_token_encrypted);

    // Return without the ciphertext
    const { access_token_encrypted: _removed, ...safe } = data;
    return { ...safe, accessToken };
  }

  /**
   * Stamps the last_webhook_received_at timestamp.
   * Best-effort — failure does not abort lead processing.
   */
  async touchLastWebhook(integrationId: string): Promise<void> {
    const { error } = await (
      this.db
        .from('meta_integrations')
        .update({ last_webhook_received_at: new Date().toISOString() })
        .eq('id', integrationId) as unknown as Promise<SBList<MetaIntegration>>
    );

    if (error) {
      this.logger.warn('Failed to update last_webhook_received_at', { integrationId });
    }
  }

  /** Creates a new integration. Access token is encrypted before storage. */
  async create(input: CreateMetaIntegrationInput): Promise<MetaIntegration> {
    const encryptedToken = encryptToken(input.accessToken);

    const { data, error } = await (
      this.db
        .from('meta_integrations')
        .insert({
          organization_id: input.organizationId,
          page_id: input.pageId,
          page_name: input.pageName ?? null,
          app_id: input.appId,
          access_token_encrypted: encryptedToken,
          allowed_form_ids: input.allowedFormIds ?? null,
          is_active: true,
        })
        .select()
        .single() as unknown as Promise<SBSingle<MetaIntegration>>
    );

    if (error) {
      this.logger.error('Failed to create meta integration', error, {
        organizationId: input.organizationId,
        pageId: input.pageId,
      });
      throw error;
    }

    return data!;
  }
}
