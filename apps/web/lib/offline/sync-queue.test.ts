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
const { manilaDateString, syncOfflineTransactions } = await import('./sync-queue');

/** Fakes Dexie's `.orderBy('createdAt').filter(fn).toArray()` chain used by syncOfflineTransactions. */
function mockPendingRows(rows: { id: string; payload: Record<string, unknown>; createdAt: number; syncedAt: number | null }[]) {
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
    ...overrides,
  };
}

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

    await syncOfflineTransactions();

    expect(apiClient).not.toHaveBeenCalled();
  });

  it('sends every pending row as one batch to POST /api/transactions/sync-offline', async () => {
    mockPendingRows([offlineRow()]);
    vi.mocked(apiClient).mockResolvedValue({ data: { results: [], synced_count: 0 }, error: null, meta: null });

    await syncOfflineTransactions();

    expect(apiClient).toHaveBeenCalledWith('/api/transactions/sync-offline', {
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
    });
  });

  it('marks a synced row with the official receipt number and leaves a failed row untouched in the queue', async () => {
    mockPendingRows([offlineRow({ id: 'PC-MAIN01-20260719-OFFLINE-0001' }), offlineRow({ id: 'PC-MAIN01-20260719-OFFLINE-0002' })]);
    vi.mocked(apiClient).mockResolvedValue({
      data: {
        results: [
          { offline_provisional_number: 'PC-MAIN01-20260719-OFFLINE-0001', status: 'synced', transaction: { receipt_number: 'MAIN01-20260719-000001' } },
          { offline_provisional_number: 'PC-MAIN01-20260719-OFFLINE-0002', status: 'failed', error: { code: 'PRODUCT_UNAVAILABLE' } },
        ],
        synced_count: 1,
      },
      error: null,
      meta: null,
    });

    await syncOfflineTransactions();

    expect(db.offlineTransactions.update).toHaveBeenCalledTimes(1);
    expect(db.offlineTransactions.update).toHaveBeenCalledWith('PC-MAIN01-20260719-OFFLINE-0001', {
      syncedAt: expect.any(Number),
      officialTransactionNumber: 'MAIN01-20260719-000001',
    });
  });

  it('logs but does not throw when the batch request itself fails', async () => {
    mockPendingRows([offlineRow()]);
    vi.mocked(apiClient).mockRejectedValue(new Error('network down'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(syncOfflineTransactions()).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(db.offlineTransactions.update).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
