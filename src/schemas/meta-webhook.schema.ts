import { z } from 'zod';

// ============================================================
// Zod Schemas — Meta Lead Ads
// ============================================================
// All inbound data (webhook payloads, Graph API responses) must
// pass these schemas before touching any business logic.
// ============================================================

// ---- Webhook payload schemas --------------------------------

export const MetaLeadgenChangeValueSchema = z.object({
  leadgen_id: z.string().min(1),
  page_id: z.string().min(1),
  form_id: z.string().min(1),
  adgroup_id: z.string().optional(),
  ad_id: z.string().optional(),
  created_time: z.number().int().positive(),
});

export const MetaWebhookChangeSchema = z.object({
  field: z.string(),
  // value is unknown until we check field === 'leadgen'
  value: z.unknown(),
});

export const MetaWebhookEntrySchema = z.object({
  id: z.string().min(1),
  time: z.number().int(),
  changes: z.array(MetaWebhookChangeSchema).min(1),
});

export const MetaWebhookPayloadSchema = z
  .object({
    object: z.string(),
    entry: z.array(MetaWebhookEntrySchema).min(1),
  })
  .refine(
    (data) => data.object === 'page',
    { message: 'Webhook object must be "page"' },
  );

// ---- Graph API response schemas ----------------------------

export const MetaFieldDataSchema = z.object({
  name: z.string().min(1),
  values: z.array(z.string()).min(1),
});

export const MetaLeadDetailsSchema = z.object({
  id: z.string().min(1),
  created_time: z.string(),
  ad_id: z.string().optional(),
  ad_name: z.string().optional(),
  form_id: z.string().optional(),
  field_data: z.array(MetaFieldDataSchema).default([]),
  is_organic: z.boolean().optional(),
});

// ---- Webhook verification query string ----------------------

export const MetaVerificationQuerySchema = z.object({
  'hub.mode': z.literal('subscribe'),
  'hub.challenge': z.string().min(1),
  'hub.verify_token': z.string().min(1),
});

// ---- Environment variable validation -----------------------
// Called once at startup to fail fast on missing config.

export const MetaEnvSchema = z.object({
  META_APP_SECRET: z
    .string()
    .min(16, 'META_APP_SECRET must be at least 16 characters'),
  META_WEBHOOK_VERIFY_TOKEN: z
    .string()
    .min(8, 'META_WEBHOOK_VERIFY_TOKEN must be at least 8 characters'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  META_TOKEN_ENCRYPT_KEY: z
    .string()
    .min(32, 'META_TOKEN_ENCRYPT_KEY must be at least 32 characters for AES-256'),
});

export type MetaWebhookPayloadInput = z.infer<typeof MetaWebhookPayloadSchema>;
export type MetaLeadDetailsInput = z.infer<typeof MetaLeadDetailsSchema>;
export type MetaLeadgenChangeValueInput = z.infer<typeof MetaLeadgenChangeValueSchema>;
