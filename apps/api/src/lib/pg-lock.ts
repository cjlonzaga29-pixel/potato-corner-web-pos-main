import { sha256Hex } from './hash.js';

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

/**
 * Canonical advisory-lock key for a branch-scoped InventoryStock row.
 * Every path that reads-then-writes InventoryStock.quantityOnHand (sale
 * deduction, sale reversal, receive/adjust/waste/transfer/physical-count)
 * must derive its lock ID through this one helper — InventoryStock rows are
 * keyed by (branchId, inventoryItemId), so the lock must be too, or two
 * operations against the same branch+item can take different advisory locks
 * and race each other instead of serializing.
 */
export function inventoryStockLockId(branchId: string, inventoryItemId: string): bigint {
  return hashToLockId(sha256Hex(`${branchId}:${inventoryItemId}`));
}
