/**
 * Phase 21: pg_advisory_xact_lock takes a bigint (signed 64-bit) key.
 * Deterministically derives one from an arbitrary string (e.g. a token
 * hash) by taking the first 16 hex chars (64 bits) of a hex digest and
 * reinterpreting them as signed. A 1-in-2^64 collision between two unrelated
 * hashes just serializes two operations that didn't need to wait on each
 * other — harmless, since the lock only rules out a concurrent-write race
 * (see auth.service.ts's refreshToken); it is never the source of truth for
 * whether an operation is allowed to proceed.
 */
export function hashToLockId(hexDigest: string): bigint {
  return BigInt.asIntN(64, BigInt(`0x${hexDigest.slice(0, 16)}`));
}
