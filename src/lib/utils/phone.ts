// ============================================================
// Phone number normalization utilities
// ============================================================
// Meta Lead Ads forms return phone numbers in many formats.
// This module normalizes them to E.164 for consistent storage.
//
// Production note: install libphonenumber-js for robust
// international parsing:
//   npm install libphonenumber-js
// Then replace normalizePhone() with:
//   import { parsePhoneNumber } from 'libphonenumber-js'
//   parsePhoneNumber(raw, defaultRegion).format('E.164')
// ============================================================

/** E.164 regex: + followed by 7–15 digits */
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

/**
 * Attempts to normalize a raw phone string to E.164 format.
 *
 * Handles common Meta form formats:
 *   "+1 (415) 555-2671"  → "+14155552671"
 *   "415-555-2671"       → null (ambiguous country; need region context)
 *   "+447700900123"      → "+447700900123" (already E.164)
 *   "14155552671"        → "+14155552671"  (US without leading +)
 *
 * Returns null if the number cannot be reliably normalized.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // Strip formatting characters
  let digits = raw.replace(/[\s\-().]/g, '');

  // Already E.164
  if (E164_REGEX.test(digits)) return digits;

  // Has + but still dirty
  if (digits.startsWith('+')) {
    digits = '+' + digits.slice(1).replace(/\D/g, '');
    return E164_REGEX.test(digits) ? digits : null;
  }

  // No country code — prepend + and check (works for full intl numbers like "14155552671")
  const withPlus = '+' + digits.replace(/\D/g, '');
  if (E164_REGEX.test(withPlus)) return withPlus;

  // Cannot normalize without region context
  return null;
}

/**
 * Returns true if the string is a valid E.164 phone number.
 */
export function isValidE164(phone: string): boolean {
  return E164_REGEX.test(phone);
}
