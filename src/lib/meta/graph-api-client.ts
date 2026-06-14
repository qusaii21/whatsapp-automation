import type { MetaLeadDetails, MetaGraphApiErrorBody } from '@/types/meta.types';
import { MetaLeadDetailsSchema } from '@/schemas/meta-webhook.schema';
import type { Logger } from '@/lib/logger';

// ============================================================
// Meta Graph API Client
// ============================================================
// Wraps the Meta Graph API for fetching full lead details after
// receiving a leadgen webhook notification.
//
// Rate limits (as of Meta API v21.0):
//   - 200 API calls / hour / page access token (default)
//   - 4,800 calls / 24 hours
//   Use long-lived page access tokens (they don't expire).
//
// Docs:
//   https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving
// ============================================================

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE_URL = 'https://graph.facebook.com';
const LEAD_FIELDS = 'id,created_time,ad_id,ad_name,form_id,field_data,is_organic';

// Timeout for Graph API calls — Meta recommends < 10s round-trip
const REQUEST_TIMEOUT_MS = 10_000;

export class MetaGraphApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly metaError?: MetaGraphApiErrorBody['error'],
  ) {
    super(message);
    this.name = 'MetaGraphApiError';
  }

  get isRetryable(): boolean {
    // Meta error codes that are transient (rate limit, server error, etc.)
    const retryableCodes = new Set([1, 2, 4, 17, 341]);
    return this.statusCode >= 500 || retryableCodes.has(this.metaError?.code ?? 0);
  }
}

export class MetaGraphApiClient {
  constructor(
    private readonly accessToken: string,
    private readonly logger?: Logger,
  ) {}

  /**
   * Fetches full lead details from the Meta Graph API.
   *
   * @param leadgenId - The leadgen_id from the webhook payload
   * @returns Parsed and validated MetaLeadDetails
   * @throws MetaGraphApiError on API failure
   */
  async fetchLeadDetails(leadgenId: string): Promise<MetaLeadDetails> {
    const url = new URL(`${GRAPH_BASE_URL}/${GRAPH_VERSION}/${leadgenId}`);
    url.searchParams.set('fields', LEAD_FIELDS);
    // Access token appended to URL (required by Meta Graph API)
    // Never logged — URL is only stored in webhook_events.raw_body which is service-role-only
    url.searchParams.set('access_token', this.accessToken);

    this.logger?.debug('Fetching lead details from Graph API', { leadgenId });

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      const message =
        cause instanceof Error && cause.name === 'TimeoutError'
          ? `Graph API timed out after ${REQUEST_TIMEOUT_MS}ms`
          : `Graph API network error: ${String(cause)}`;
      throw new MetaGraphApiError(message, 0);
    }

    const body = await response.text();

    if (!response.ok) {
      let errorBody: MetaGraphApiErrorBody = {};
      try {
        errorBody = JSON.parse(body) as MetaGraphApiErrorBody;
      } catch {
        // non-JSON error body
      }
      this.logger?.warn('Graph API returned error', {
        leadgenId,
        statusCode: String(response.status),
        metaErrorCode: String(errorBody.error?.code ?? ''),
      });
      throw new MetaGraphApiError(
        `Graph API error ${response.status}: ${errorBody.error?.message ?? body}`,
        response.status,
        errorBody.error,
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new MetaGraphApiError('Graph API returned non-JSON response', response.status);
    }

    const parsed = MetaLeadDetailsSchema.safeParse(json);
    if (!parsed.success) {
      throw new MetaGraphApiError(
        `Graph API response failed schema validation: ${parsed.error.message}`,
        response.status,
      );
    }

    this.logger?.debug('Lead details fetched successfully', { leadgenId });
    return parsed.data;
  }
}

/**
 * Factory function to create a MetaGraphApiClient instance.
 * Used by services to avoid direct constructor calls in tests.
 */
export function createMetaGraphApiClient(
  accessToken: string,
  logger?: Logger,
): MetaGraphApiClient {
  return new MetaGraphApiClient(accessToken, logger);
}
