import 'server-only';
import type { SupabaseClient, PostgrestError } from '@supabase/supabase-js';
import type { Lead } from '@/types/database.types';
import type { Json } from '@/types/database.types';
import type { Logger } from '@/lib/logger';

type SBSingle<T> = { data: T | null; error: PostgrestError | null };
type SBList<T>   = { data: T[] | null; error: PostgrestError | null };

// ============================================================
// LeadRepository
// ============================================================
// All lead persistence operations.
// upsertFromMetaAd delegates to the PostgreSQL function
// upsert_lead_from_meta_ad() which owns the deduplication logic.
// ============================================================

export interface UpsertLeadFromMetaAdInput {
  organizationId: string;
  metaLeadId: string;
  phoneE164: string | null;
  name: string | null;
  email: string | null;
  adId: string | null;
  adName: string | null;
  adSetId: string | null;
  adSetName: string | null;
  formId: string | null;
  campaignId: string | null;
  campaignName: string | null;
  sourceUrl?: string | null;
  metadata?: Record<string, unknown>;
}

export interface UpsertLeadResult {
  lead: Lead;
  /** True if the lead already existed (dedup hit) */
  isExisting: boolean;
}

export class LeadRepository {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: SupabaseClient<any>,
    private readonly logger: Logger,
  ) {}

  /**
   * Atomically inserts or updates a lead from a Meta Lead Ad submission.
   * Delegates deduplication entirely to the database function
   * upsert_lead_from_meta_ad() which enforces:
   *   1. Global dedup by meta_lead_id
   *   2. Per-org dedup by (organization_id, phone_e164, channel)
   *
   * Returns the lead row and whether it was a new creation or an update.
   */
  async upsertFromMetaAd(input: UpsertLeadFromMetaAdInput): Promise<UpsertLeadResult> {
    this.logger.debug('Upserting lead from Meta Ad', {
      organizationId: input.organizationId,
      leadgenId: input.metaLeadId,
    });

    const { data, error } = await (
      this.db.rpc('upsert_lead_from_meta_ad', {
        p_organization_id: input.organizationId,
        p_meta_lead_id: input.metaLeadId,
        p_phone_e164: input.phoneE164,
        p_name: input.name,
        p_email: input.email,
        p_ad_id: input.adId,
        p_ad_name: input.adName,
        p_ad_set_id: input.adSetId,
        p_ad_set_name: input.adSetName,
        p_form_id: input.formId,
        p_campaign_id: input.campaignId,
        p_campaign_name: input.campaignName,
        p_source_url: input.sourceUrl ?? null,
        p_metadata: (input.metadata ?? {}) as Json,
      }) as unknown as Promise<SBSingle<Lead>>
    );

    if (error) {
      this.logger.error('upsert_lead_from_meta_ad RPC failed', error, {
        organizationId: input.organizationId,
        leadgenId: input.metaLeadId,
      });
      throw error;
    }

    if (!data) {
      throw new Error('upsert_lead_from_meta_ad returned no data');
    }

    // Detect if this was a pre-existing lead:
    // If created_at !== updated_at, it was updated (not freshly inserted).
    const isExisting = data.created_at !== data.updated_at;

    this.logger.info('Lead upserted', {
      organizationId: input.organizationId,
      leadId: data.id,
      leadgenId: input.metaLeadId,
      isExisting: String(isExisting),
    });

    return { lead: data, isExisting };
  }

  /** Finds a lead by ID within an organization (RLS-safe lookup) */
  async findById(id: string, organizationId: string): Promise<Lead | null> {
    const { data, error } = await (
      this.db
        .from('leads')
        .select()
        .eq('id', id)
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .maybeSingle() as unknown as Promise<SBSingle<Lead>>
    );

    if (error) {
      this.logger.error('Failed to find lead by id', error, { leadId: id, organizationId });
      throw error;
    }

    return data ?? null;
  }

  /** Finds a lead by meta_lead_id (global uniqueness — no org filter needed) */
  async findByMetaLeadId(metaLeadId: string): Promise<Lead | null> {
    const { data, error } = await (
      this.db
        .from('leads')
        .select()
        .eq('meta_lead_id', metaLeadId)
        .maybeSingle() as unknown as Promise<SBSingle<Lead>>
    );

    if (error) {
      this.logger.error('Failed to find lead by meta_lead_id', error, { metaLeadId });
      throw error;
    }

    return data ?? null;
  }

  /**
   * Finds an active lead by phone number within an organization.
   * Used to match inbound WhatsApp messages to existing leads.
   */
  async findByPhone(phoneE164: string, organizationId: string): Promise<Lead | null> {
    const { data, error } = await (
      this.db
        .from('leads')
        .select()
        .eq('organization_id', organizationId)
        .eq('phone_e164', phoneE164)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle() as unknown as Promise<SBSingle<Lead>>
    );

    if (error) {
      this.logger.error('Failed to find lead by phone', error, { phoneE164, organizationId });
      throw error;
    }

    return data ?? null;
  }

  /** Updates lead name — best-effort, used when inbound WhatsApp provides a display name. */
  async updateName(id: string, name: string): Promise<void> {
    const { error } = await (
      this.db
        .from('leads')
        .update({ name })
        .eq('id', id) as unknown as Promise<SBList<Lead>>
    );

    if (error) {
      this.logger.warn('Failed to update lead name', { leadId: id });
    }
  }
}
