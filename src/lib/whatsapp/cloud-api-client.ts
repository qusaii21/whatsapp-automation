import 'server-only';
import { logger as rootLogger } from '@/lib/logger';

const WA_API_VERSION = 'v21.0';
const WA_API_BASE = 'https://graph.facebook.com';
const DEFAULT_TIMEOUT_MS = 10_000;

// ─── Response types ───────────────────────────────────────────────────────────

export interface WaSendResponse {
  /** WhatsApp message ID (wamid.*) */
  waMessageId: string;
  /** Normalised recipient phone (may differ from input) */
  recipientWaId: string;
}

// ─── Error ────────────────────────────────────────────────────────────────────

interface WaApiErrorBody {
  error: {
    message: string;
    type: string;
    code: number;
    fbtrace_id?: string;
    error_subcode?: number;
    error_data?: { messaging_product: string; details: string };
  };
}

// Transient / rate-limit error codes per Meta docs
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 130429, 131048, 131056]);

export class WhatsAppApiError extends Error {
  readonly code: number;
  readonly fbTraceId: string | undefined;
  readonly isRetryable: boolean;
  readonly httpStatus: number;

  constructor(message: string, code: number, httpStatus: number, fbTraceId?: string) {
    super(message);
    this.name = 'WhatsAppApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.fbTraceId = fbTraceId;
    this.isRetryable = RETRYABLE_CODES.has(code) || httpStatus >= 500;
  }
}

// ─── Outbound message body types ─────────────────────────────────────────────

type WaTextBody = {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: 'text';
  text: { body: string; preview_url?: boolean };
};

type WaTemplateBody = {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: 'template';
  template: {
    name: string;
    language: { code: string };
    components?: unknown[];
  };
};

type WaMessageBody = WaTextBody | WaTemplateBody;

// ─── Client ───────────────────────────────────────────────────────────────────

export class WhatsAppCloudApiClient {
  private readonly logger = rootLogger.child({ component: 'WhatsAppCloudApiClient' });
  private readonly baseUrl: string;

  constructor(
    private readonly phoneNumberId: string,
    private readonly accessToken: string,
  ) {
    this.baseUrl = `${WA_API_BASE}/${WA_API_VERSION}/${phoneNumberId}`;
  }

  /** Sends a text message. Returns the wamid and recipient wa_id. */
  async sendText(to: string, body: string, previewUrl = false): Promise<WaSendResponse> {
    const payload: WaTextBody = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body, preview_url: previewUrl },
    };
    return this.post(payload);
  }

  /** Sends a template message. Returns the wamid and recipient wa_id. */
  async sendTemplate(
    to: string,
    templateName: string,
    languageCode: string,
    components?: unknown[],
  ): Promise<WaSendResponse> {
    const payload: WaTemplateBody = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components ? { components } : {}),
      },
    };
    return this.post(payload);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async post(body: WaMessageBody): Promise<WaSendResponse> {
    const url = `${this.baseUrl}/messages`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      this.logger.error('WhatsApp API network error', err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const json = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      const errBody = json as unknown as WaApiErrorBody;
      const msg = errBody?.error?.message ?? `HTTP ${response.status}`;
      const code = errBody?.error?.code ?? response.status;
      const fbTraceId = errBody?.error?.fbtrace_id;
      this.logger.error('WhatsApp API error', new Error(msg), {
        code,
        httpStatus: response.status,
        fbTraceId,
        to: body.to,
      });
      throw new WhatsAppApiError(msg, code, response.status, fbTraceId);
    }

    // Expected: { messaging_product, contacts: [{input, wa_id}], messages: [{id}] }
    const messages = (json.messages as Array<{ id: string }> | undefined) ?? [];
    const contacts = (json.contacts as Array<{ input: string; wa_id: string }> | undefined) ?? [];

    const waMessageId = messages[0]?.id;
    const recipientWaId = contacts[0]?.wa_id ?? body.to;

    if (!waMessageId) {
      throw new Error('WhatsApp API returned no message id');
    }

    this.logger.debug('Message sent', { waMessageId, recipientWaId, type: body.type });
    return { waMessageId, recipientWaId };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createWhatsAppApiClient(): WhatsAppCloudApiClient {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    throw new Error(
      'Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN environment variables',
    );
  }

  return new WhatsAppCloudApiClient(phoneNumberId, accessToken);
}
