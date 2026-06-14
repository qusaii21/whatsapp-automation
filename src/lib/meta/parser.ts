import type {
  MetaLeadDetails,
  MetaLeadgenChangeValue,
  MetaWebhookEntry,
  MetaWebhookPayload,
  ExtractedLeadFields,
} from '@/types/meta.types';

// ============================================================
// Meta Webhook Payload Parser
// ============================================================
// Extracts leadgen change events from raw Meta webhook payloads
// and normalizes lead field data for storage.
// ============================================================

/**
 * Known Meta Lead Form field name mappings.
 * Meta uses these as canonical field names in field_data.
 * Custom questions use arbitrary strings.
 */
const PHONE_FIELD_NAMES = new Set([
  'phone_number',
  'phone',
  'mobile_phone',
  'work_phone',
]);

const EMAIL_FIELD_NAMES = new Set(['email', 'work_email', 'email_address']);

const NAME_FIELD_NAMES = new Set(['full_name', 'name']);
const FIRST_NAME_FIELDS = new Set(['first_name', 'fname']);
const LAST_NAME_FIELDS = new Set(['last_name', 'lname', 'surname']);

/**
 * Extracts all leadgen change values from a Meta webhook payload.
 * One payload can contain multiple entries and multiple changes —
 * each representing a separate lead submission.
 */
export function extractLeadgenChanges(
  payload: MetaWebhookPayload,
): MetaLeadgenChangeValue[] {
  const results: MetaLeadgenChangeValue[] = [];

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'leadgen') continue;

      const value = change.value as MetaLeadgenChangeValue;
      if (value?.leadgen_id && value?.page_id) {
        results.push(value);
      }
    }
  }

  return results;
}

/**
 * Extracts the set of unique page IDs present in a webhook payload.
 * Used to resolve organizations before processing.
 */
export function extractPageIds(payload: MetaWebhookPayload): Set<string> {
  const pageIds = new Set<string>();
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'leadgen') continue;
      const value = change.value as MetaLeadgenChangeValue;
      if (value?.page_id) pageIds.add(value.page_id);
    }
  }
  return pageIds;
}

/**
 * Normalizes Meta field_data array into structured lead fields.
 *
 * @param fieldData - Array of { name, values } from Graph API response
 * @returns Normalized lead fields with rawFields for JSONB metadata
 *
 * @example
 * extractLeadFields([
 *   { name: 'full_name', values: ['Jane Doe'] },
 *   { name: 'phone_number', values: ['+14155552671'] },
 *   { name: 'email', values: ['jane@example.com'] },
 * ])
 * // → { name: 'Jane Doe', phone: '+14155552671', email: 'jane@example.com', rawFields: {...} }
 */
export function extractLeadFields(
  fieldData: MetaLeadDetails['field_data'],
): ExtractedLeadFields {
  const rawFields: Record<string, string> = {};

  for (const field of fieldData) {
    const firstValue = field.values[0];
    if (firstValue !== undefined && firstValue !== '') {
      rawFields[field.name] = firstValue;
    }
  }

  // Resolve phone
  let phone: string | null = null;
  for (const key of PHONE_FIELD_NAMES) {
    if (rawFields[key]) {
      phone = rawFields[key];
      break;
    }
  }

  // Resolve email
  let email: string | null = null;
  for (const key of EMAIL_FIELD_NAMES) {
    if (rawFields[key]) {
      email = rawFields[key];
      break;
    }
  }

  // Resolve full name
  let name: string | null = null;
  for (const key of NAME_FIELD_NAMES) {
    if (rawFields[key]) {
      name = rawFields[key];
      break;
    }
  }
  if (!name) {
    const parts = [
      Object.entries(rawFields).find(([k]) => FIRST_NAME_FIELDS.has(k))?.[1],
      Object.entries(rawFields).find(([k]) => LAST_NAME_FIELDS.has(k))?.[1],
    ].filter(Boolean);
    if (parts.length > 0) name = parts.join(' ');
  }

  return { phone, email, name, rawFields };
}

/**
 * Builds a JSONB-safe metadata object from the webhook change value,
 * Graph API lead details, and extracted fields.
 * This is stored in leads.metadata for dashboard display and filtering.
 */
export function buildLeadMetadata(
  changeValue: MetaLeadgenChangeValue,
  leadDetails: MetaLeadDetails,
  extractedFields: ExtractedLeadFields,
): Record<string, unknown> {
  return {
    // Attribution
    ad_id: changeValue.ad_id ?? leadDetails.ad_id ?? null,
    ad_name: leadDetails.ad_name ?? null,
    adgroup_id: changeValue.adgroup_id ?? null,
    form_id: leadDetails.form_id ?? changeValue.form_id,
    is_organic: leadDetails.is_organic ?? false,
    // All raw form fields for future reference
    form_fields: extractedFields.rawFields,
    // Source
    source: 'meta_lead_ads',
    meta_lead_id: leadDetails.id,
  };
}
