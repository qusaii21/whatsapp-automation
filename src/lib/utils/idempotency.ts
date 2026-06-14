// ============================================================
// Idempotency key utilities
// ============================================================
// Produces deterministic, collision-resistant keys for webhook
// deduplication. Keys are stored in webhook_events.idempotency_key.
// ============================================================

/**
 * Creates a SHA-256 idempotency key from source + external event ID.
 * The result is a 64-character lowercase hex string.
 *
 * @example
 * await buildIdempotencyKey('meta-leads', 'leadgen_123456789')
 * // → "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
 */
export async function buildIdempotencyKey(
  source: string,
  externalEventId: string,
): Promise<string> {
  const input = `${source}:${externalEventId}`;
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generates a cryptographically random request correlation ID.
 * Used to trace a single HTTP request across all log lines.
 *
 * @example
 * generateRequestId() // → "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}
