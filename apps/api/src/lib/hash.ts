import { createHash, randomBytes } from 'node:crypto';

/**
 * Deterministic SHA-256 hex digest — for indexing/looking up high-entropy
 * secrets (refresh tokens, access-token blacklist keys) where the secret's
 * own randomness already provides security and a fast, deterministic hash
 * is needed for O(1) lookup. NOT for low-entropy secrets like passwords or
 * PINs — those use bcrypt (see auth.service.ts), which is deliberately
 * slow and salted to resist brute force.
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Cryptographically random opaque token (refresh tokens, password reset tokens). */
export function randomOpaqueToken(): string {
  return randomBytes(32).toString('hex');
}
