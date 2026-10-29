import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db', () => ({
  db: {
    offlineTransactions: {
      orderBy: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../api-client', () => ({
  apiClient: vi.fn(),
}));

const { db } = await import('./db');
const { apiClient } = await import('../api-client');
const { isDefinitiveQueueRejection, manilaDateString, syncOfflineTransactions } = await import('./sync-queue');

/** Fakes Dexie's `.orderBy('createdAt').filter(fn).toArray()` chain used by syncOfflineTransactions. */
function mockPendingRows(rows: Array<Record<string, unknown>>) {
  vi.mocked(db.offlineTransactions.orderBy).mockReturnValue({
    filter: (predicate: (row: (typeof rows)[number]) => boolean) => ({
      toArray: async () => rows.filter(predicate),
    }),
  } as never);
}

function offlineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'PC-MAIN01-20260719-OFFLINE-0001',
    payload: {
      branch_id: 'branch-1',
      shift_id: 'shift-1',
      items: [{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 }],
      payment_method: 'cash',
      cash_tendered: 40,
      is_offline_transaction: true,
      offline_provisional_number: 'PC-MAIN01-20260719-OFFLINE-0001',
    },
    createdAt: 1_000,
    syncedAt: null,
    cashierUserId: 'cashier-a',
    ...overrides,
  };
}

function sentIds(callIndex: number): string[] {
  const init = vi.mocked(apiClient).mock.calls[callIndex]?.[1];
  const body = JSON.parse(String(init?.body)) as { transactions: { offline_provisional_number: string }[] };
  return body.transactions.map((t) => t.offline_provisional_number);
}

const OPTIONS = { branchId: 'branch-1', cashierUserId: 'cashier-a' } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('manilaDateString', () => {
  it('uses Asia/Manila local date, not UTC — the bug this locks in a regression test for', () => {
    // 2026-01-15T23:30:00Z is 2026-01-16T07:30:00+08:00 in Manila —
    // already the next day locally, even though the UTC date is still the
    // 15th. The old Date.prototype.toISOString().slice(0, 10) approach
    // would have returned "2026-01-15" here, violating CLAUDE.md's Offline
    // Receipt Numbers rule ("resets to 1 at midnight") by rolling the date
    // over 8 hours late relative to actual Manila midnight.
    const utcLateNight = new Date('2026-01-15T23:30:00Z');
    expect(manilaDateString(utcLateNight)).toBe('2026-01-16');
  });

  it('matches the UTC date for times well inside the Manila business day', () => {
    // 2026-01-15T04:00:00Z is 2026-01-15T12:00:00+08:00 — same calendar
    // date in both zones, so this should NOT falsely appear broken either
    // way (guards against a fix that's UTC-blind in the other direction).
    const midday = new Date('2026-01-15T04:00:00Z');
    expect(manilaDateString(midday)).toBe('2026-01-15');
  });

  it('rolls over exactly at Manila local midnight (UTC 16:00 the previous day)', () => {
    const oneMinuteBeforeManilaMidnight = new Date('2026-01-15T15:59:00Z'); // 2026-01-15 23:59 +08:00
    const exactlyManilaMidnight = new Date('2026-01-15T16:00:00Z'); // 2026-01-16 00:00 +08:00

    expect(manilaDateString(oneMinuteBeforeManilaMidnight)).toBe('2026-01-15');
    expect(manilaDateString(exactlyManilaMidnight)).toBe('2026-01-16');
  });
});

describe('syncOfflineTransactions', () => {
  it('does nothing and never calls the API when the queue is empty', async () => {
    mockPendingRows([]);

    await syncOfflineTransactions(OPTIONS);

    expect(apiClient).not.toHaveBeenCalled();
  });

  it('sends every pending row as one batch to POST /api/transactions/sync-offline', async () => {
    mockPendingRows([offlineRow()]);
    vi.mocked(apiClient).mockResolvedValue({ data: { results: [], synced_count: 0 }, error: null, meta: null });

    await syncOfflineTransactions(OPTIONS);

    expect(apiClient).toHaveBeenCalledWith(
      '/api/transactions/sync-offline',
      {
        method: 'POST',
        body: JSON.stringify({
          branch_id: 'branch-1',
          transactions: [
            {
              offline_provisional_number: 'PC-MAIN01-20260719-OFFLINE-0001',
              shift_id: 'shift-1',
              items: [{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 }],
              payment_method: 'cash',
              discount_type: undefined,
              discount_id_reference: undefined,
              discount_amount: undefined,
              cash_tendered: 40,
              gcash_reference_number: undefined,
              gcash_manually_verified: undefined,
              client_created_at: 1_000,
            },
          ],
        }),
      },
      undefined,
      undefined,
    );
  });

  it('marks a synced row with the official receipt number and keeps a retryable failure queued with its reason', async () => {
    mockPendingRows([offlineRow({ id: 'PC-MAIN01-20260719-OFFLINE-0001' }), offlineRow({ id: 'PC-MAIN01-20260719-OFFLINE-0002' })]);
    vi.mocked(apiClient).mockResolvedValue({
      data: {
        results: [
          { offline_provisional_number: 'PC-MAIN01-20260719-OFFLINE-0001', status: 'synced', transaction: { receipt_number: 'MAIN01-20260719-000001' } },
          { offline_provisional_number: 'PC-MAIN01-20260719-OFFLINE-0002', status: 'failed', error: { code: 'INSUFFICIENT_STOCK', message: 'Not enough Potato' } },
        ],
        synced_count: 1,
      },
      error: null,
      meta: null,
    });

    const outcome = await syncOfflineTransactions(OPTIONS);

    expect(db.offlineTransactions.update).toHaveBeenCalledWith('PC-MAIN01-20260719-OFFLINE-0001', {
      syncedAt: expect.any(Number),
      officialTransactionNumber: 'MAIN01-20260719-000001',
      rejection: null,
      lastError: null,
    });
    expect(db.offlineTransactions.update).toHaveBeenCalledWith('PC-MAIN01-20260719-OFFLINE-0002', {
      lastError: { code: 'INSUFFICIENT_STOCK', message: 'Not enough Potato', at: expect.any(Number) },
    });
    expect(outcome).toEqual({ attempted: 2, synced: ['PC-MAIN01-20260719-OFFLINE-0001'], rejected: [], failed: ['PC-MAIN01-20260719-OFFLINE-0002'] });
  });

  // P46R3 — an option-validation refusal is settled: stored as a rejection,
  // never marked synced, and the payload/identity are untouched.
  it.each(['PRODUCT_OPTION_REQUIRED', 'PRODUCT_OPTION_LIMIT_EXCEEDED', 'PRODUCT_OPTION_NOT_AVAILABLE'])('stores %s as a definitive rejection', async (code) => {
    mockPendingRows([offlineRow()]);
    vi.mocked(apiClient).mockResolvedValue({
      data: {
        results: [{ offline_provisional_number: 'PC-MAIN01-20260719-OFFLINE-0001', status: 'failed', error: { code, message: 'Regular needs 1 Seasoning selection' } }],
        synced_count: 0,
      },
      error: null,
      meta: null,
    });

    const outcome = await syncOfflineTransactions(OPTIONS);

    expect(db.offlineTransactions.update).toHaveBeenCalledTimes(1);
    expect(db.offlineTransactions.update).toHaveBeenCalledWith('PC-MAIN01-20260719-OFFLINE-0001', {
      rejection: { code, message: 'Regular needs 1 Seasoning selection', at: expect.any(Number) },
      lastError: null,
    });
    expect(outcome.rejected).toEqual(['PC-MAIN01-20260719-OFFLINE-0001']);
  });

  it('never resends a rejected row automatically, but an explicit Retry sends exactly that row with its original identity', async () => {
    const rejected = offlineRow({ id: 'PC-MAIN01-20260719-OFFLINE-0001', rejection: { code: 'PRODUCT_OPTION_REQUIRED', message: null, at: 1 } });
    const waiting = offlineRow({ id: 'PC-MAIN01-20260719-OFFLINE-0002' });
    mockPendingRows([rejected, waiting]);
    vi.mocked(apiClient).mockResolvedValue({ data: { results: [], synced_count: 0 }, error: null, meta: null });

    await syncOfflineTransactions(OPTIONS);
    expect(sentIds(0)).toEqual(['PC-MAIN01-20260719-OFFLINE-0002']);

    await syncOfflineTransactions({ ...OPTIONS, onlyIds: ['PC-MAIN01-20260719-OFFLINE-0001'] });
    expect(sentIds(1)).toEqual(['PC-MAIN01-20260719-OFFLINE-0001']);
    const retried = JSON.parse(String(vi.mocked(apiClient).mock.calls[1]?.[1]?.body)) as { transactions: Record<string, unknown>[] };
    expect(retried.transactions[0]).toMatchObject({ client_created_at: 1_000, shift_id: 'shift-1', cash_tendered: 40 });
  });

  it('keeps every row retryable when the batch itself is refused', async () => {
    mockPendingRows([offlineRow()]);
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: { code: 'NOT_CLOCKED_IN', message: 'Clock in first' }, meta: null });

    const outcome = await syncOfflineTransactions(OPTIONS);

    expect(db.offlineTransactions.update).toHaveBeenCalledTimes(1);
    expect(db.offlineTransactions.update).toHaveBeenCalledWith('PC-MAIN01-20260719-OFFLINE-0001', {
      lastError: { code: 'NOT_CLOCKED_IN', message: 'Clock in first', at: expect.any(Number) },
    });
    expect(outcome.failed).toEqual(['PC-MAIN01-20260719-OFFLINE-0001']);
  });

  it('does not throw when the batch request itself fails, and records the failure as retryable', async () => {
    mockPendingRows([offlineRow()]);
    vi.mocked(apiClient).mockRejectedValue(new Error('network down'));

    const outcome = await syncOfflineTransactions(OPTIONS);

    expect(db.offlineTransactions.update).toHaveBeenCalledWith('PC-MAIN01-20260719-OFFLINE-0001', {
      lastError: { code: 'SYNC_FAILED', message: 'network down', at: expect.any(Number) },
    });
    expect(outcome.synced).toEqual([]);
    expect(outcome.failed).toEqual(['PC-MAIN01-20260719-OFFLINE-0001']);
  });

  it('treats a row the response leaves out as unanswered, never as synced', async () => {
    mockPendingRows([offlineRow()]);
    vi.mocked(apiClient).mockResolvedValue({ data: { results: [], synced_count: 0 }, error: null, meta: null });

    const outcome = await syncOfflineTransactions(OPTIONS);

    expect(db.offlineTransactions.update).toHaveBeenCalledWith('PC-MAIN01-20260719-OFFLINE-0001', {
      lastError: { code: 'SYNC_FAILED', message: null, at: expect.any(Number) },
    });
    expect(outcome.failed).toEqual(['PC-MAIN01-20260719-OFFLINE-0001']);
  });

  // P46R3 — attribution: a row only goes out under the token of the cashier who rang it.
  it("sends only the current cashier's rows, under the token passed in", async () => {
    mockPendingRows([
      offlineRow({ id: 'PC-MAIN01-20260719-OFFLINE-0001', cashierUserId: 'cashier-a' }),
      offlineRow({ id: 'PC-MAIN01-20260719-OFFLINE-0002', cashierUserId: 'cashier-b' }),
      offlineRow({ id: 'PC-MAIN01-20260719-OFFLINE-0003', cashierUserId: undefined }),
    ]);
    vi.mocked(apiClient).mockResolvedValue({ data: { results: [], synced_count: 0 }, error: null, meta: null });
    const refresh = vi.fn();

    await syncOfflineTransactions({ ...OPTIONS, accessToken: 'employee-a-token', refreshAccessToken: refresh });

    expect(sentIds(0)).toEqual(['PC-MAIN01-20260719-OFFLINE-0001']);
    const [, , token, refreshArg] = vi.mocked(apiClient).mock.calls[0] ?? [];
    expect(token).toBe('employee-a-token');
    expect(refreshArg).toBe(refresh);
  });

  // P46R3 — a row without a recorded cashier is never sent under anyone's token.
  it('never sends a row queued before P46R3 (no cashier recorded)', async () => {
    mockPendingRows([offlineRow({ cashierUserId: undefined })]);

    await syncOfflineTransactions(OPTIONS);
    await syncOfflineTransactions({ ...OPTIONS, onlyIds: ['PC-MAIN01-20260719-OFFLINE-0001'] });

    expect(apiClient).not.toHaveBeenCalled();
  });

  it('skips rows queued at another branch', async () => {
    mockPendingRows([offlineRow({ payload: { ...offlineRow().payload, branch_id: 'branch-2' } })]);

    await syncOfflineTransactions(OPTIONS);

    expect(apiClient).not.toHaveBeenCalled();
  });

  it('runs one sync at a time', async () => {
    mockPendingRows([offlineRow()]);
    let release: () => void = () => undefined;
    vi.mocked(apiClient).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: { results: [], synced_count: 0 }, error: null, meta: null });
        }),
    );
    vi.mocked(apiClient).mockResolvedValue({ data: { results: [], synced_count: 0 }, error: null, meta: null });

    const first = syncOfflineTransactions(OPTIONS);
    const second = syncOfflineTransactions(OPTIONS);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiClient).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(apiClient).toHaveBeenCalledTimes(2);
  });
});

describe('isDefinitiveQueueRejection', () => {
  it('is true only for option-validation refusals', () => {
    expect(isDefinitiveQueueRejection('PRODUCT_OPTION_REQUIRED')).toBe(true);
    for (const code of ['INSUFFICIENT_STOCK', 'SHIFT_CLOSED', 'NETWORK_ERROR', 'SYNC_FAILED', 'PRODUCT_UNAVAILABLE', undefined, null]) {
      expect(isDefinitiveQueueRejection(code)).toBe(false);
    }
  });
});
