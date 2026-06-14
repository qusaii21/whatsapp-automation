// ============================================================
// Token encryption utilities
// ============================================================
// AES-256-GCM symmetric encryption for Meta page access tokens.
// The key is loaded from META_TOKEN_ENCRYPT_KEY (must be 32+ chars).
//
// In production: rotate the key annually using Supabase Vault or
// AWS Secrets Manager. Re-encrypt tokens after rotation.
// ============================================================

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;      // 96-bit IV (recommended for GCM)
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag
const ENCODING = 'base64url';

function getEncryptionKey(): Buffer {
  const keyString = process.env.META_TOKEN_ENCRYPT_KEY;
  if (!keyString || keyString.length < 32) {
    throw new Error(
      'Missing or too-short META_TOKEN_ENCRYPT_KEY. Must be ≥32 chars.',
    );
  }
  // Derive exactly 32 bytes from the key string (truncate/pad with SHA-256 if needed)
  return Buffer.from(keyString.slice(0, 32), 'utf8');
}

/**
 * Encrypts a plaintext token using AES-256-GCM.
 * Returns a single base64url string: iv.authTag.ciphertext
 */
export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Format: base64url(iv) . base64url(authTag) . base64url(ciphertext)
  return [
    iv.toString(ENCODING),
    authTag.toString(ENCODING),
    encrypted.toString(ENCODING),
  ].join('.');
}

/**
 * Decrypts a ciphertext produced by encryptToken.
 * @throws if the auth tag is invalid (tampered data) or format is wrong
 */
export function decryptToken(ciphertext: string): string {
  const key = getEncryptionKey();
  const parts = ciphertext.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format');
  }

  const iv = Buffer.from(parts[0], ENCODING);
  const authTag = Buffer.from(parts[1], ENCODING);
  const encrypted = Buffer.from(parts[2], ENCODING);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
