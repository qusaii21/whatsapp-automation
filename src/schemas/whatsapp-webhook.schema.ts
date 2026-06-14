import { z } from 'zod';

// ─── Shared ──────────────────────────────────────────────────────────────────

const WaMetadataSchema = z.object({
  display_phone_number: z.string(),
  phone_number_id: z.string(),
});

// ─── Inbound message types ────────────────────────────────────────────────────

const WaTextSchema = z.object({ body: z.string() });

const WaMediaSchema = z.object({
  id: z.string(),
  mime_type: z.string().optional(),
  sha256: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
});

const WaLocationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  name: z.string().optional(),
  address: z.string().optional(),
});

const WaErrorItemSchema = z.object({
  code: z.number(),
  title: z.string(),
  details: z.string().optional(),
});

// Inbound message (user → business)
export const WaInboundMessageSchema = z.object({
  id: z.string(),
  from: z.string(),           // sender phone in E.164 without '+'
  timestamp: z.string(),      // unix epoch string
  type: z.enum([
    'text', 'image', 'document', 'audio', 'video', 'sticker',
    'location', 'contacts', 'interactive', 'reaction', 'unsupported',
  ]),
  text: WaTextSchema.optional(),
  image: WaMediaSchema.optional(),
  document: WaMediaSchema.optional(),
  audio: WaMediaSchema.optional(),
  video: WaMediaSchema.optional(),
  sticker: WaMediaSchema.optional(),
  location: WaLocationSchema.optional(),
  context: z.object({
    from: z.string().optional(),
    id: z.string(),           // quoted message wamid
  }).optional(),
  errors: z.array(WaErrorItemSchema).optional(),
});

export type WaInboundMessage = z.infer<typeof WaInboundMessageSchema>;

// ─── Delivery status (business → user) ───────────────────────────────────────

const WaConversationSchema = z.object({
  id: z.string(),
  origin: z.object({ type: z.string() }).optional(),
  expiration_timestamp: z.string().optional(),
});

const WaPricingSchema = z.object({
  billable: z.boolean().optional(),
  pricing_model: z.string().optional(),
  category: z.string().optional(),
});

export const WaStatusSchema = z.object({
  id: z.string(),             // wamid
  status: z.enum(['sent', 'delivered', 'read', 'failed', 'deleted']),
  timestamp: z.string(),
  recipient_id: z.string(),
  conversation: WaConversationSchema.optional(),
  pricing: WaPricingSchema.optional(),
  errors: z.array(WaErrorItemSchema).optional(),
});

export type WaStatus = z.infer<typeof WaStatusSchema>;

// ─── Contact info accompanying inbound messages ───────────────────────────────

const WaContactSchema = z.object({
  profile: z.object({ name: z.string() }).optional(),
  wa_id: z.string(),
});

// ─── Change value ─────────────────────────────────────────────────────────────

export const WaChangeValueSchema = z.object({
  messaging_product: z.literal('whatsapp'),
  metadata: WaMetadataSchema,
  contacts: z.array(WaContactSchema).optional(),
  messages: z.array(WaInboundMessageSchema).optional(),
  statuses: z.array(WaStatusSchema).optional(),
  errors: z.array(WaErrorItemSchema).optional(),
});

export type WaChangeValue = z.infer<typeof WaChangeValueSchema>;

// ─── Full webhook payload ─────────────────────────────────────────────────────

export const WaWebhookPayloadSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),         // WABA id
      changes: z.array(
        z.object({
          value: WaChangeValueSchema,
          field: z.string(),  // typically "messages"
        }),
      ),
    }),
  ),
});

export type WaWebhookPayload = z.infer<typeof WaWebhookPayloadSchema>;

// ─── Webhook verification query ───────────────────────────────────────────────

export const WaVerificationQuerySchema = z.object({
  'hub.mode': z.literal('subscribe'),
  'hub.verify_token': z.string(),
  'hub.challenge': z.string(),
});

// ─── Send message request (API → WhatsApp) ────────────────────────────────────

const WaTemplateComponentSchema: z.ZodType<WaTemplateComponent> = z.lazy(() =>
  z.object({
    type: z.enum(['header', 'body', 'footer', 'button']),
    sub_type: z.string().optional(),
    index: z.number().optional(),
    parameters: z.array(
      z.object({
        type: z.enum(['text', 'currency', 'date_time', 'image', 'document', 'video']),
        text: z.string().optional(),
        image: z.object({ link: z.string().optional(), id: z.string().optional() }).optional(),
        document: z.object({ link: z.string().optional(), id: z.string().optional() }).optional(),
        video: z.object({ link: z.string().optional(), id: z.string().optional() }).optional(),
      }),
    ).optional(),
  })
);

// TypeScript type needed for the lazy reference
interface WaTemplateComponent {
  type: 'header' | 'body' | 'footer' | 'button';
  sub_type?: string;
  index?: number;
  parameters?: Array<{
    type: 'text' | 'currency' | 'date_time' | 'image' | 'document' | 'video';
    text?: string;
    image?: { link?: string; id?: string };
    document?: { link?: string; id?: string };
    video?: { link?: string; id?: string };
  }>;
}

export const SendTextMessageSchema = z.object({
  type: z.literal('text'),
  to: z.string().regex(/^\d{7,15}$/),
  text: z.object({ body: z.string().min(1).max(4096), preview_url: z.boolean().optional() }),
});

export const SendTemplateMessageSchema = z.object({
  type: z.literal('template'),
  to: z.string().regex(/^\d{7,15}$/),
  template: z.object({
    name: z.string(),
    language: z.object({ code: z.string() }),
    components: z.array(WaTemplateComponentSchema).optional(),
  }),
});

export const SendMessageRequestSchema = z.discriminatedUnion('type', [
  SendTextMessageSchema,
  SendTemplateMessageSchema,
]);

export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

// ─── WhatsApp env schema ──────────────────────────────────────────────────────

export const WhatsAppEnvSchema = z.object({
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().min(1),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
});
