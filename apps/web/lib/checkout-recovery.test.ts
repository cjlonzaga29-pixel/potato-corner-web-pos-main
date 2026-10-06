import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockApiClient } = vi.hoisted(() => ({ mockApiClient: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiClient: mockApiClient }));

import {
  resolveCheckoutAttempt,
  savePendingCheckoutAttempt,
  readPendingCheckoutAttempt,
  clearPendingCheckoutAttempt,
  transactionToSaleSnapshot,
} from './checkout-recovery';

beforeEach(() => {
  mockApiClient.mockReset();
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveCheckoutAttempt', () => {
  it('returns "found" on a single lookup when the server reports the attempt committed', async () => {
    mockApiClient.mockResolvedValueOnce({ data: { status: 'committed', transaction: { id: 'txn-1' } }, error: null, meta: null });

    const result = await resolveCheckoutAttempt('key-1');

    expect(result).toEqual({ status: 'found', transaction: { id: 'txn-1' } });
    expect(mockApiClient).toHaveBeenCalledTimes(1);
    expect(mockApiClient).toHaveBeenCalledWith('/api/transactions/by-idempotency-key/key-1');
  });

  it('returns "unknown" on an inconclusive response (network error) — a single check, no polling', async () => {
    mockApiClient.mockResolvedValueOnce({ data: null, error: { code: 'NETWORK_ERROR' }, meta: null });

    const result = await resolveCheckoutAttempt('key-1');

    expect(result).toEqual({ status: 'unknown' });
    expect(mockApiClient).toHaveBeenCalledTimes(1);
  });

  it('returns "not-found" when the server confirms the key was never claimed (404)', async () => {
    mockApiClient.mockResolvedValueOnce({ data: null, error: { code: 'IDEMPOTENCY_KEY_NOT_FOUND' }, meta: null });

    const result = await resolveCheckoutAttempt('key-1');

    expect(result).toEqual({ status: 'not-found' });
    expect(mockApiClient).toHaveBeenCalledTimes(1);
  });

  it('returns "not-found" when the server reports the attempt definitively failed pre-commit', async () => {
    mockApiClient.mockResolvedValueOnce({ data: { status: 'failed' }, error: null, meta: null });

    const result = await resolveCheckoutAttempt('key-1');

    expect(result).toEqual({ status: 'not-found' });
  });

  it('returns "in-progress" when the server reports the attempt is still live — never treated as safe to remint', async () => {
    mockApiClient.mockResolvedValueOnce({ data: { status: 'in_progress' }, error: null, meta: null });

    const result = await resolveCheckoutAttempt('key-1');

    expect(result).toEqual({ status: 'in-progress' });
    expect(mockApiClient).toHaveBeenCalledTimes(1);
  });
});

describe('pending checkout attempt persistence', () => {
  it('round-trips a saved attempt through read, scoped per branch', () => {
    savePendingCheckoutAttempt('branch-a', 'key-a');
    savePendingCheckoutAttempt('branch-b', 'key-b');

    expect(readPendingCheckoutAttempt('branch-a')?.idempotencyKey).toBe('key-a');
    expect(readPendingCheckoutAttempt('branch-b')?.idempotencyKey).toBe('key-b');
  });

  it('returns null when nothing is pending for that branch', () => {
    expect(readPendingCheckoutAttempt('branch-nothing-pending')).toBeNull();
  });

  it('clears only the named branch\'s record', () => {
    savePendingCheckoutAttempt('branch-a', 'key-a');
    savePendingCheckoutAttempt('branch-b', 'key-b');

    clearPendingCheckoutAttempt('branch-a');

    expect(readPendingCheckoutAttempt('branch-a')).toBeNull();
    expect(readPendingCheckoutAttempt('branch-b')?.idempotencyKey).toBe('key-b');
  });

  it('returns null (never throws) on corrupted storage content', () => {
    localStorage.setItem('pos:pending-checkout:branch-a', 'not json');
    expect(readPendingCheckoutAttempt('branch-a')).toBeNull();
  });
});

describe('transactionToSaleSnapshot', () => {
  it('maps a TransactionResponse onto the SaleSnapshot shape the confirmation popup renders', () => {
    const snapshot = transactionToSaleSnapshot({
      subtotal: 100,
      discount_amount: 10,
      discount_type: 'pwd',
      vat_amount: 9.64,
      total_amount: 90,
      payment_method: 'cash',
      cash_tendered: 100,
      change_given: 10,
      items: [
        {
          id: 'item-1',
          product_name: 'Classic',
          variant_name: 'Regular',
          flavor_name: 'BBQ',
          quantity: 2,
          line_total: 80,
          selected_options: [{ option_id: 'opt-1', option_name: 'Extra Cheese', price_adjustment: 10 }],
        },
      ],
      // Fields irrelevant to the snapshot mapping, present only to satisfy the type.
    } as never);

    expect(snapshot).toEqual({
      items: [
        {
          id: 'item-1',
          productName: 'Classic',
          variantName: 'Regular',
          flavorName: 'BBQ',
          quantity: 2,
          lineTotal: 80,
          optionSelections: [{ option_id: 'opt-1', option_name: 'Extra Cheese', price_adjustment: 10 }],
        },
      ],
      subtotal: 100,
      discountAmount: 10,
      discountType: 'pwd',
      vatAmount: 9.64,
      totalAmount: 90,
      paymentMethod: 'cash',
      cashTendered: 100,
      changeGiven: 10,
    });
  });
});
