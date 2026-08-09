import { describe, it, expect } from 'vitest';
import { hashToLockId, inventoryStockLockId } from './pg-lock.js';
import { sha256Hex } from './hash.js';

// Task 209.30 — the audit found the POS sale-deduction path taking its
// InventoryStock advisory lock on hash(inventoryItemId) while the manual
// inventory path (receive/adjust/waste/transfer/physical-count) took it on
// hash(branchId:inventoryItemId) — two different Postgres advisory locks for
// the same (branch, item) row, so the two paths never actually contended and
// could silently race each other's writes. inventoryStockLockId is now the
// one place both call sites derive their lock ID from.
describe('inventoryStockLockId', () => {
  it('derives the same lock ID for the same (branchId, inventoryItemId) pair every time', () => {
    const first = inventoryStockLockId('branch-1', 'item-flour');
    const second = inventoryStockLockId('branch-1', 'item-flour');
    expect(first).toBe(second);
  });

  it('matches hashToLockId(sha256Hex(`${branchId}:${inventoryItemId}`)) — the manual-inventory-path convention', () => {
    const expected = hashToLockId(sha256Hex('branch-1:item-flour'));
    expect(inventoryStockLockId('branch-1', 'item-flour')).toBe(expected);
  });

  it('derives a different lock ID for a different branch, same inventory item', () => {
    const branchA = inventoryStockLockId('branch-a', 'item-flour');
    const branchB = inventoryStockLockId('branch-b', 'item-flour');
    expect(branchA).not.toBe(branchB);
  });

  it('derives a different lock ID for a different inventory item, same branch', () => {
    const itemA = inventoryStockLockId('branch-1', 'item-flour');
    const itemB = inventoryStockLockId('branch-1', 'item-sugar');
    expect(itemA).not.toBe(itemB);
  });

  it('does NOT collide with the bare item-only key the sale path used to take (the bug the audit found)', () => {
    const canonical = inventoryStockLockId('branch-1', 'item-flour');
    const legacyItemOnlyKey = hashToLockId(sha256Hex('item-flour'));
    expect(canonical).not.toBe(legacyItemOnlyKey);
  });
});
