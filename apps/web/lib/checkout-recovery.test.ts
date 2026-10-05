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
  it('returns "found" immediately on the first successful lookup', async () => {
    mockApiClient.mockResolvedValueOnce({ data: { id: 'txn-1' }, error: null, meta: null });

    const result = await resolveCheckoutAttempt('key-1');

    expect(result).toEqual({ status: 'found', transaction: { id: 'txn-1' } });
    expect(mockApiClient).toHaveBeenCalledTimes(1);
    expect(mockApiClient).toHaveBeenCalledWith('/api/transactions/by-idempotency-key/key-1');
  });

  it('returns "unknown" on the first inconclusive response (network error) without polling further', async () => {
    mockApiClient.mockResolvedValueOnce({ data: null, error: { code: 'NETWORK_ERROR' }, meta: null });

    const result = await resolveCheckoutAttempt('key-1');

    expect(result).toEqual({ status: 'unknown' });
    expect(mockApiClient).toHaveBeenCalledTimes(1);
  });

  it('polls on a clean "not found" and returns "not-found" only after exhausting the bounded window', async () => {
    mockApiClient.mockResolvedValue({ data: null, error: { code: 'IDEMPOTENCY_KEY_NOT_FOUND' }, meta: null });

    const resultPromise = resolveCheckoutAttempt('key-1');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({ status: 'not-found' });
    // Initial check + one retry per POLL_DELAYS_MS entry.
    expect(mockApiClient.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops polling and returns "found" as soon as a later attempt succeeds', async () => {
    mockApiClient
      .mockResolvedValueOnce({ data: null, error: { code: 'IDEMPOTENCY_KEY_NOT_FOUND' }, meta: null })
      .mockResolvedValueOnce({ data: { id: 'txn-2' }, error: null, meta: null });

    const resultPromise = resolveCheckoutAttempt('key-1');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({ status: 'found', transaction: { id: 'txn-2' } });
    expect(mockApiClient).toHaveBeenCalledTimes(2);
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
