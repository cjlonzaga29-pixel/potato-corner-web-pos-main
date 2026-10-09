import { createHash, createHmac, randomBytes } from 'node:crypto';

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

/**
 * Keyed HMAC-SHA256 hex digest — POS-PERF-P29's staff-PIN lookup digest.
 * Unlike sha256Hex above, a PIN is low-entropy (4-6 digits), so an unkeyed
 * hash would be brute-forceable offline from a leaked digest; keying it by
 * a server-only secret (STAFF_PIN_HMAC_SECRET) makes that infeasible
 * without the secret. This digest is only ever used to find a *candidate*
 * row by (branchId, digest) — the authoritative check is always the
 * following bcrypt.compare against that row's pinHash, never this digest
 * alone.
 */
export function hmacSha256Hex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}
