// ============================================================
// Meta Lead Ads — TypeScript types
// Based on Meta Marketing API v21.0
// Docs: https://developers.facebook.com/docs/marketing-api/guides/lead-ads/
// ============================================================

// ---- Inbound webhook payload --------------------------------

/** Raw value inside a leadgen change event */
export interface MetaLeadgenChangeValue {
  /** The Lead ID (leadgen_id) — use to fetch full data from Graph API */
  leadgen_id: string;
  /** Facebook Page ID where the ad ran */
  page_id: string;
  /** Lead Ad Form ID */
  form_id: string;
  /** Ad Group (Ad Set) ID */
  adgroup_id?: string;
  /** Ad ID */
  ad_id?: string;
  /** Unix timestamp of submission */
  created_time: number;
}

export interface MetaWebhookChange {
  /** Field name — we only process 'leadgen' */
  field: string;
  /**
   * Parsed value (type varies by field).
   * Optional because Zod's z.unknown() produces an optional property in the
   * inferred type — the value is always present on real Meta payloads but
   * the type must match the Zod schema output to avoid assignment errors.
   */
  value?: unknown;
}

export interface MetaWebhookEntry {
  /** Facebook Page ID */
  id: string;
  /** Unix timestamp of the batch */
  time: number;
  changes: MetaWebhookChange[];
}

/** Top-level webhook payload sent by Meta to our endpoint */
export interface MetaWebhookPayload {
  /** Always "page" for Lead Ads webhooks */
  object: string;
  entry: MetaWebhookEntry[];
}

// ---- Graph API response: lead details ----------------------

export interface MetaFieldData {
  /** Form field name e.g. "full_name", "phone_number", "email" */
  name: string;
  /** Array of submitted values (usually one element) */
  values: string[];
}

/** Response from GET /{leadgen_id}?fields=id,created_time,... */
export interface MetaLeadDetails {
  id: string;
  created_time: string; // ISO 8601
  ad_id?: string;
  ad_name?: string;
  form_id?: string;
  /** Field values submitted by the lead */
  field_data: MetaFieldData[];
  /** True if submitted via organic post (not an ad) */
  is_organic?: boolean;
}

// ---- Processed / normalized form ---------------------------

/** Parsed and normalized lead data extracted from MetaLeadDetails */
export interface ExtractedLeadFields {
  phone: string | null;
  email: string | null;
  name: string | null;
  /** All raw form fields as a flat key→value map */
  rawFields: Record<string, string>;
}

// ---- Processing result types --------------------------------

export type WebhookProcessingOutcome =
  | 'processed'        // Lead created or updated successfully
  | 'duplicate'        // Already processed (idempotency hit)
  | 'unknown_page'     // page_id not found in meta_integrations
  | 'form_not_allowed' // Form ID not in allowed_form_ids whitelist
  | 'graph_api_error'  // Could not fetch lead details from Meta
  | 'validation_error' // Payload failed Zod schema
  | 'skipped';         // Non-leadgen field change; safely ignored

export interface LeadgenEventResult {
  leadgenId: string;
  pageId: string;
  outcome: WebhookProcessingOutcome;
  leadId?: string;
  error?: string;
}

export interface ProcessWebhookResult {
  requestId: string;
  totalEvents: number;
  results: LeadgenEventResult[];
}

// ---- Meta Graph API error shape ----------------------------

export interface MetaGraphApiErrorBody {
  error?: {
    message: string;
    type: string;
    code: number;
    fbtrace_id?: string;
  };
}
