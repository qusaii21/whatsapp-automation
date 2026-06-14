import 'server-only';
import type { MetaWebhookPayload, ProcessWebhookResult, LeadgenEventResult, WebhookProcessingOutcome } from '@/types/meta.types';
import type { WebhookEventRepository } from '@/repositories/webhook-event.repository';
import type { LeadRepository } from '@/repositories/lead.repository';
import type { MetaIntegrationRepository } from '@/repositories/meta-integration.repository';
import type { MetaGraphApiClient } from '@/lib/meta/graph-api-client';
import { MetaGraphApiError } from '@/lib/meta/graph-api-client';
import {
  extractLeadgenChanges,
  extractLeadFields,
  buildLeadMetadata,
} from '@/lib/meta/parser';
import { normalizePhone } from '@/lib/utils/phone';
import { buildIdempotencyKey } from '@/lib/utils/idempotency';
import type { Json } from '@/types/database.types';
import type { Logger } from '@/lib/logger';
import type { MetaLeadgenChangeValue, MetaLeadDetails } from '@/types/meta.types';

// ============================================================
// MetaLeadService
// ============================================================
// Orchestrates the full Meta Lead Ads ingestion pipeline:
//
//   Webhook payload
//     → Extract leadgen changes (one payload may contain many)
//     → For each leadgen event:
//         1. Build idempotency key from leadgen_id
//         2. Create webhook_event record (idempotency checkpoint)
//         3. Lookup organization via page_id → meta_integrations
//         4. Validate form_id against allowed whitelist
//         5. Fetch full lead details from Meta Graph API
//         6. Normalize phone to E.164
//         7. Upsert lead via upsert_lead_from_meta_ad() DB function
//         8. Mark webhook_event as processed with linked lead_id
//
// Each leadgen event is processed independently — one failure
// does not abort the batch.
// ============================================================

const WEBHOOK_SOURCE = 'meta_leads';

export class MetaLeadService {
  constructor(
    private readonly webhookEventRepo: WebhookEventRepository,
    private readonly leadRepo: LeadRepository,
    private readonly metaIntegrationRepo: MetaIntegrationRepository,
    private readonly graphApiClientFactory: (accessToken: string) => MetaGraphApiClient,
    private readonly logger: Logger,
  ) {}

  /**
   * Processes a validated Meta webhook payload.
   * Called from the route handler after signature verification.
   *
   * @param rawBody     - Original raw request body (stored verbatim for replay)
   * @param payload     - Zod-validated webhook payload
   * @param requestId   - Correlation ID for this HTTP request
   */
  async processWebhookPayload(
    rawBody: string,
    payload: MetaWebhookPayload,
    requestId: string,
  ): Promise<ProcessWebhookResult> {
    const log = this.logger.child({ requestId });
    const leadgenChanges = extractLeadgenChanges(payload);

    log.info('Processing Meta webhook payload', {
      totalEntries: String(payload.entry.length),
      totalLeadgenEvents: String(leadgenChanges.length),
    });

    const results: LeadgenEventResult[] = [];

    for (const change of leadgenChanges) {
      const result = await this.processLeadgenEvent(
        change,
        rawBody,
        requestId,
        log,
      );
      results.push(result);
    }

    const skipped = leadgenChanges.length === 0
      ? [{ leadgenId: 'n/a', pageId: 'n/a', outcome: 'skipped' as WebhookProcessingOutcome }]
      : [];

    return {
      requestId,
      totalEvents: leadgenChanges.length,
      results: [...results, ...skipped],
    };
  }

  // ---- Private: single leadgen event processing ----

  private async processLeadgenEvent(
    change: MetaLeadgenChangeValue,
    rawBody: string,
    requestId: string,
    log: Logger,
  ): Promise<LeadgenEventResult> {
    const eventLog = log.child({
      leadgenId: change.leadgen_id,
      pageId: change.page_id,
    });

    // ---- Step 1: Idempotency checkpoint ----
    const idempotencyKey = await buildIdempotencyKey(
      WEBHOOK_SOURCE,
      change.leadgen_id,
    );

    const { event: webhookEvent, isDuplicate } =
      await this.webhookEventRepo.createIfNotExists({
        source: WEBHOOK_SOURCE,
        idempotencyKey,
        externalEventId: change.leadgen_id,
        rawBody,
        // Cast through unknown: MetaLeadgenChangeValue is a flat object of
        // primitives and is therefore valid Json. The Json union type requires
        // this cast because Record<string, unknown> is not directly assignable.
        parsedPayload: change as unknown as Json,
      });

    if (isDuplicate) {
      eventLog.info('Leadgen event already processed — skipping', {
        webhookEventId: webhookEvent.id,
      });
      return {
        leadgenId: change.leadgen_id,
        pageId: change.page_id,
        outcome: 'duplicate',
        leadId: webhookEvent.lead_id ?? undefined,
      };
    }

    await this.webhookEventRepo.markProcessing(webhookEvent.id);

    // ---- Step 2: Resolve organization via page_id ----
    let integration: Awaited<ReturnType<MetaIntegrationRepository['findActiveByPageId']>>;
    try {
      integration = await this.metaIntegrationRepo.findActiveByPageId(change.page_id);
    } catch (err) {
      eventLog.error('Failed to lookup meta integration', err);
      await this.webhookEventRepo.markFailed(
        webhookEvent.id,
        `Integration lookup failed: ${String(err)}`,
        { retryable: true, attemptCount: webhookEvent.attempt_count },
      );
      return { leadgenId: change.leadgen_id, pageId: change.page_id, outcome: 'graph_api_error' };
    }

    if (!integration) {
      eventLog.warn('No active meta integration found for page_id', { pageId: change.page_id });
      await this.webhookEventRepo.markFailed(
        webhookEvent.id,
        `No active integration for page_id: ${change.page_id}`,
        { retryable: false },
      );
      return { leadgenId: change.leadgen_id, pageId: change.page_id, outcome: 'unknown_page' };
    }

    const { organization_id: organizationId, id: integrationId } = integration;
    const orgLog = eventLog.child({ organizationId, integrationId });

    // ---- Step 3: Validate form_id whitelist ----
    if (
      integration.allowed_form_ids !== null &&
      integration.allowed_form_ids.length > 0 &&
      !integration.allowed_form_ids.includes(change.form_id)
    ) {
      orgLog.info('Form ID not in whitelist — skipping', {
        formId: change.form_id,
      });
      await this.webhookEventRepo.markFailed(
        webhookEvent.id,
        `Form ID ${change.form_id} not in allowed_form_ids`,
        { retryable: false },
      );
      return {
        leadgenId: change.leadgen_id,
        pageId: change.page_id,
        outcome: 'form_not_allowed',
      };
    }

    // Best-effort: stamp last_webhook_received_at (non-blocking)
    void this.metaIntegrationRepo.touchLastWebhook(integrationId);

    // ---- Step 4: Fetch full lead details from Meta Graph API ----
    let leadDetails: MetaLeadDetails;
    try {
      const graphClient = this.graphApiClientFactory(integration.accessToken);
      leadDetails = await graphClient.fetchLeadDetails(change.leadgen_id);
    } catch (err) {
      const isRetryable = err instanceof MetaGraphApiError ? err.isRetryable : true;
      orgLog.error('Failed to fetch lead details from Graph API', err);
      await this.webhookEventRepo.markFailed(
        webhookEvent.id,
        `Graph API error: ${String(err)}`,
        { retryable: isRetryable, attemptCount: webhookEvent.attempt_count },
      );
      return { leadgenId: change.leadgen_id, pageId: change.page_id, outcome: 'graph_api_error' };
    }

    // ---- Step 5: Normalize and extract fields ----
    const extracted = extractLeadFields(leadDetails.field_data);
    const phoneE164 = normalizePhone(extracted.phone);
    const metadata = buildLeadMetadata(change, leadDetails, extracted);

    orgLog.debug('Lead fields extracted', {
      hasPhone: String(!!phoneE164),
      hasEmail: String(!!extracted.email),
      hasName: String(!!extracted.name),
    });

    // ---- Step 6: Upsert lead ----
    let leadResult: Awaited<ReturnType<LeadRepository['upsertFromMetaAd']>>;
    try {
      leadResult = await this.leadRepo.upsertFromMetaAd({
        organizationId,
        metaLeadId: change.leadgen_id,
        phoneE164,
        name: extracted.name,
        email: extracted.email,
        adId: change.ad_id ?? leadDetails.ad_id ?? null,
        adName: leadDetails.ad_name ?? null,
        adSetId: change.adgroup_id ?? null,
        adSetName: null,
        formId: change.form_id,
        campaignId: null,       // Not in leadgen payload; enrich from Ads Insights API if needed
        campaignName: null,
        metadata,
      });
    } catch (err) {
      orgLog.error('Failed to upsert lead', err);
      await this.webhookEventRepo.markFailed(
        webhookEvent.id,
        `Lead upsert failed: ${String(err)}`,
        { retryable: true, attemptCount: webhookEvent.attempt_count },
      );
      return { leadgenId: change.leadgen_id, pageId: change.page_id, outcome: 'graph_api_error' };
    }

    // ---- Step 7: Mark webhook event as processed ----
    await this.webhookEventRepo.markProcessed(webhookEvent.id, {
      organizationId,
      leadId: leadResult.lead.id,
    });

    orgLog.info('Leadgen event processed successfully', {
      leadId: leadResult.lead.id,
      isExisting: String(leadResult.isExisting),
    });

    return {
      leadgenId: change.leadgen_id,
      pageId: change.page_id,
      outcome: 'processed',
      leadId: leadResult.lead.id,
    };
  }
}
