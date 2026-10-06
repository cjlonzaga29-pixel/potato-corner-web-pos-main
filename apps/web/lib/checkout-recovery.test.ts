import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockApiClient } = vi.hoisted(() => ({ mockApiClient: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiClient: mockApiClient }));

import {
  resolveCheckoutAttempt,
  abandonCheckoutAttempt,
  resolveAndFenceCheckoutAttempt,
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

    const result = await resolveCheckoutAttempt('key-1', 'branch-1');

    expect(result).toEqual({ status: 'found', transaction: { id: 'txn-1' } });
    expect(mockApiClient).toHaveBeenCalledTimes(1);
    expect(mockApiClient).toHaveBeenCalledWith('/api/transactions/by-idempotency-key/key-1?branch_id=branch-1');
  });

  it('returns "unknown" on an inconclusive response (network error) — a single check, no polling', async () => {
    mockApiClient.mockResolvedValueOnce({ data: null, error: { code: 'NETWORK_ERROR' }, meta: null });

    const result = await resolveCheckoutAttempt('key-1', 'branch-1');

    expect(result).toEqual({ status: 'unknown' });
    expect(mockApiClient).toHaveBeenCalledTimes(1);
  });

  // POS-PERF-P15R5 — this GET is now purely read-only: a 404 here is no
  // longer reported as "not-found" (which this module's other callers treat
  // as license to remint) because the server no longer fences the key as a
  // side effect of this check. It is 'ambiguous' instead — the caller MUST
  // call abandonCheckoutAttempt and act on ITS result before reminting.
  it('returns "ambiguous" (NOT "not-found") when no CheckoutAttempt row exists yet (404) — no fencing happened on this GET', async () => {
    mockApiClient.mockResolvedValueOnce({ data: null, error: { code: 'IDEMPOTENCY_KEY_NOT_FOUND' }, meta: null });

    const result = await resolveCheckoutAttempt('key-1', 'branch-1');

    expect(result).toEqual({ status: 'ambiguous' });
    expect(mockApiClient).toHaveBeenCalledTimes(1);
  });

  it('returns "not-found" when the server reports the attempt definitively failed pre-commit — safe to remint immediately, no abandon call needed', async () => {
    mockApiClient.mockResolvedValueOnce({ data: { status: 'failed' }, error: null, meta: null });

    const result = await resolveCheckoutAttempt('key-1', 'branch-1');

    expect(result).toEqual({ status: 'not-found' });
  });

  it('returns "not-found" when the server reports the key was already durably abandoned by a prior call', async () => {
    mockApiClient.mockResolvedValueOnce({ data: { status: 'abandoned' }, error: null, meta: null });

    const result = await resolveCheckoutAttempt('key-1', 'branch-1');

    expect(result).toEqual({ status: 'not-found' });
  });

  it('returns "in-progress" when the server reports the attempt is still live — never treated as safe to remint', async () => {
    mockApiClient.mockResolvedValueOnce({ data: { status: 'in_progress' }, error: null, meta: null });

    const result = await resolveCheckoutAttempt('key-1', 'branch-1');

    expect(result).toEqual({ status: 'in-progress' });
    expect(mockApiClient).toHaveBeenCalledTimes(1);
  });
});

describe('abandonCheckoutAttempt', () => {
  it('POSTs to the abandon endpoint with the branch id in the body, not the query string', async () => {
    mockApiClient.mockResolvedValueOnce({ data: { status: 'abandoned' }, error: null, meta: null });

    const result = await abandonCheckoutAttempt('key-1', 'branch-1');

    expect(result).toEqual({ status: 'abandoned' });
    expect(mockApiClient).toHaveBeenCalledWith('/api/transactions/by-idempotency-key/key-1/abandon', {
      method: 'POST',
      body: JSON.stringify({ branch_id: 'branch-1' }),
    });
  });

  it('returns "found" when the server reports a sale already committed under this key instead of abandoning it', async () => {
    mockApiClient.mockResolvedValueOnce({ data: { status: 'committed', transaction: { id: 'txn-1' } }, error: null, meta: null });

    const result = await abandonCheckoutAttempt('key-1', 'branch-1');

    expect(result).toEqual({ status: 'found', transaction: { id: 'txn-1' } });
  });

  it('returns "in-progress" (NOT "abandoned") when a genuinely live attempt wins the race for this key', async () => {
    mockApiClient.mockResolvedValueOnce({ data: { status: 'in_progress' }, error: null, meta: null });

    const result = await abandonCheckoutAttempt('key-1', 'branch-1');

    expect(result).toEqual({ status: 'in-progress' });
  });

  it('returns "unknown" on a network error — never conflated with "abandoned"', async () => {
    mockApiClient.mockResolvedValueOnce({ data: null, error: { code: 'NETWORK_ERROR' }, meta: null });

    const result = await abandonCheckoutAttempt('key-1', 'branch-1');

    expect(result).toEqual({ status: 'unknown' });
  });
});

describe('resolveAndFenceCheckoutAttempt', () => {
  it('passes through a non-ambiguous resolveCheckoutAttempt outcome without ever calling the abandon endpoint', async () => {
    mockApiClient.mockResolvedValueOnce({ data: { status: 'failed' }, error: null, meta: null });

    const result = await resolveAndFenceCheckoutAttempt('key-1', 'branch-1');

    expect(result).toEqual({ status: 'not-found' });
    expect(mockApiClient).toHaveBeenCalledTimes(1);
  });

  it('on "ambiguous", calls the abandon endpoint and reports "not-found" only once that call confirms "abandoned"', async () => {
    mockApiClient
      .mockResolvedValueOnce({ data: null, error: { code: 'IDEMPOTENCY_KEY_NOT_FOUND' }, meta: null })
      .mockResolvedValueOnce({ data: { status: 'abandoned' }, error: null, meta: null });

    const result = await resolveAndFenceCheckoutAttempt('key-1', 'branch-1');

    expect(result).toEqual({ status: 'not-found' });
    expect(mockApiClient).toHaveBeenCalledTimes(2);
    expect(mockApiClient).toHaveBeenNthCalledWith(2, '/api/transactions/by-idempotency-key/key-1/abandon', {
      method: 'POST',
      body: JSON.stringify({ branch_id: 'branch-1' }),
    });
  });

  it('on "ambiguous", reports "in-progress" (never "not-found") when the abandon call finds a genuinely live attempt instead', async () => {
    mockApiClient
      .mockResolvedValueOnce({ data: null, error: { code: 'IDEMPOTENCY_KEY_NOT_FOUND' }, meta: null })
      .mockResolvedValueOnce({ data: { status: 'in_progress' }, error: null, meta: null });

    const result = await resolveAndFenceCheckoutAttempt('key-1', 'branch-1');

    expect(result).toEqual({ status: 'in-progress' });
  });

  it('on "ambiguous", reports "found" when the abandon call discovers a sale already committed under this key', async () => {
    mockApiClient
      .mockResolvedValueOnce({ data: null, error: { code: 'IDEMPOTENCY_KEY_NOT_FOUND' }, meta: null })
      .mockResolvedValueOnce({ data: { status: 'committed', transaction: { id: 'txn-1' } }, error: null, meta: null });

    const result = await resolveAndFenceCheckoutAttempt('key-1', 'branch-1');

    expect(result).toEqual({ status: 'found', transaction: { id: 'txn-1' } });
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
