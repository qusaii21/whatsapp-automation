import { createHmac, timingSafeEqual } from 'crypto';

// ============================================================
// Meta Webhook Signature Verifier
// ============================================================
// Meta signs every POST webhook payload with HMAC-SHA256 using
// the Meta App Secret. The signature is sent in the header:
//   X-Hub-Signature-256: sha256=<hex>
//
// Security requirements:
//   1. Read the raw request body BEFORE any JSON parsing.
//   2. Compare signatures with timingSafeEqual to prevent
//      timing-oracle attacks.
//   3. NEVER log the app secret or the full signature header.
//
// Docs:
//   https://developers.facebook.com/docs/messenger-platform/webhooks#validate-payloads
// ============================================================

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Verifies the X-Hub-Signature-256 header against the raw request body.
 *
 * @param rawBody - The raw UTF-8 request body string (before JSON.parse)
 * @param signatureHeader - The full value of X-Hub-Signature-256 header
 * @param appSecret - The Meta App Secret (from META_APP_SECRET env var)
 * @returns true if the signature is valid
 *
 * @throws never — returns false on any format error
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  appSecret: string,
): boolean {
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;

  const receivedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);

  // Guard against malformed hex values
  if (!/^[0-9a-f]{64}$/i.test(receivedHex)) return false;

  const expectedHex = createHmac('sha256', appSecret)
    .update(rawBody, 'utf8')
    .digest('hex');

  const receivedBuf = Buffer.from(receivedHex, 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');

  // Both buffers must be the same length before timingSafeEqual
  if (receivedBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(receivedBuf, expectedBuf);
}

/**
 * Verifies the hub.verify_token for the GET challenge-response handshake.
 *
 * @param receivedToken - hub.verify_token query parameter from Meta
 * @param expectedToken - META_WEBHOOK_VERIFY_TOKEN env var
 * @returns true if tokens match (constant-time comparison)
 */
export function verifyWebhookToken(
  receivedToken: string,
  expectedToken: string,
): boolean {
  if (receivedToken.length !== expectedToken.length) return false;
  return timingSafeEqual(
    Buffer.from(receivedToken, 'utf8'),
    Buffer.from(expectedToken, 'utf8'),
  );
}
