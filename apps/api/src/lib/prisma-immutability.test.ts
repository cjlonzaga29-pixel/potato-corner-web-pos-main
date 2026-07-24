import { describe, it, expect } from 'vitest';
import { assertMutableWrite, ImmutabilityViolationError } from './prisma-immutability.js';

describe('assertMutableWrite — CR-004', () => {
  describe('InventoryMovement (append-only ledger)', () => {
    it('allows create', () => {
      expect(() => assertMutableWrite('InventoryMovement', 'create', { data: { quantityChange: 5 } })).not.toThrow();
    });

    it.each(['update', 'updateMany', 'delete', 'deleteMany', 'upsert'])('blocks %s', (operation) => {
      expect(() => assertMutableWrite('InventoryMovement', operation, {})).toThrow(ImmutabilityViolationError);
    });
  });

  describe('TransactionItem (sale-time snapshot)', () => {
    it('allows create and createMany', () => {
      expect(() => assertMutableWrite('TransactionItem', 'create', { data: {} })).not.toThrow();
      expect(() => assertMutableWrite('TransactionItem', 'createMany', { data: [] })).not.toThrow();
    });

    it.each(['update', 'updateMany', 'delete', 'deleteMany', 'upsert'])('blocks %s', (operation) => {
      expect(() => assertMutableWrite('TransactionItem', operation, {})).toThrow(ImmutabilityViolationError);
    });
  });

  describe('Transaction (status transitions only)', () => {
    it('allows update with only status-transition fields — the exact shapes voidTransaction/refundTransaction/markReceiptPrinted send', () => {
      expect(() =>
        assertMutableWrite('Transaction', 'update', {
          data: { status: 'voided', voidedAt: new Date(), voidedById: 'user-1', voidReason: 'customer request' },
        }),
      ).not.toThrow();
      expect(() =>
        assertMutableWrite('Transaction', 'update', {
          data: { status: 'refunded', refundedAt: new Date(), refundedById: 'user-1', refundReason: 'defective item' },
        }),
      ).not.toThrow();
      expect(() => assertMutableWrite('Transaction', 'update', { data: { receiptPrinted: true } })).not.toThrow();
      expect(() => assertMutableWrite('Transaction', 'update', { data: { inventoryDeductionStatus: 'completed' } })).not.toThrow();
    });

    it('blocks update touching a money/catalog-snapshot field — subtotal must never be rewritten after creation', () => {
      expect(() => assertMutableWrite('Transaction', 'update', { data: { subtotal: 999 } })).toThrow(ImmutabilityViolationError);
      expect(() => assertMutableWrite('Transaction', 'update', { data: { totalAmount: 1 } })).toThrow(ImmutabilityViolationError);
    });

    it('blocks an update that mixes one allowed field with one disallowed field', () => {
      expect(() => assertMutableWrite('Transaction', 'update', { data: { status: 'voided', totalAmount: 0 } })).toThrow(
        ImmutabilityViolationError,
      );
    });

    it('blocks delete and deleteMany outright — a Transaction is never removed', () => {
      expect(() => assertMutableWrite('Transaction', 'delete', {})).toThrow(ImmutabilityViolationError);
      expect(() => assertMutableWrite('Transaction', 'deleteMany', {})).toThrow(ImmutabilityViolationError);
    });

    it('allows create', () => {
      expect(() => assertMutableWrite('Transaction', 'create', { data: { subtotal: 100, totalAmount: 100 } })).not.toThrow();
    });

    it('allows a read (findMany) with no data payload to pass through untouched', () => {
      expect(() => assertMutableWrite('Transaction', 'findMany', {})).not.toThrow();
    });
  });
});
