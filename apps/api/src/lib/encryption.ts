import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { config } from '../config/index.js';

/**
 * Application-layer AES-256-GCM encryption for government ID fields
 * (SSS, PhilHealth, TIN, Pag-IBIG numbers). These fields must never be
 * stored in plaintext and must never appear in standard API responses —
 * decrypt only on explicit, authorized Super Admin requests.
 *
 * ENCRYPTION_KEY must be a 32-byte key, base64-encoded, in env.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey(): Buffer {
  return Buffer.from(config.encryptionKey, 'base64');
}

function getHashKey(): Buffer {
  return Buffer.from(config.hashKey, 'base64');
}

/**
 * Deterministic HMAC-SHA256 of a plaintext ID, hex-encoded. Used only for
 * equality-matching (Phase 17's discount-ID-reuse rule) — never for
 * confidentiality, and never decrypted or reversed. Kept as a separate key
 * (HASH_KEY, not ENCRYPTION_KEY) so rotating one does not invalidate the
 * other.
 */
export function hashField(plaintext: string): string {
  return createHmac('sha256', getHashKey()).update(plaintext, 'utf8').digest('hex');
}

/** Returns base64(iv + authTag + ciphertext), safe to store as a single column value. */
export function encryptField(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptField(encoded: string): string {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = raw.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
