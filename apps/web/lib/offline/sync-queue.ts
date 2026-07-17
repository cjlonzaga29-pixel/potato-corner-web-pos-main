import { db } from './db';
import { apiClient } from '../api-client';
import type { CreateTransactionInput } from '@potato-corner/shared';

/**
 * YYYY-MM-DD in Asia/Manila local time, not UTC. Date.prototype.toISOString()
 * is always UTC and rolls the date over at 8am Manila time — using it here
 * would break the "resets to 1 at midnight" locked rule (CLAUDE.md's Offline
 * Receipt Numbers) for any transaction between local midnight and 8am, and
 * would disagree with this codebase's other explicit Asia/Manila business-day
 * conventions (apps/api/src/queues/eod.queue.ts, fraud.queue.ts).
 */
export function manilaDateString(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(date);
}

async function nextOfflineSequence(branchCode: string): Promise<number> {
  const key = `${branchCode}:${manilaDateString(new Date())}`;
  const existing = await db.offlineSequenceCounters.get(key);
  const next = (existing?.value ?? 0) + 1;
  await db.offlineSequenceCounters.put({ key, value: next });
  return next;
}

/**
 * Queues a transaction locally while offline instead of POSTing it live.
 * Returns the provisional local id (format: PC-[BRANCH]-[DATE]-OFFLINE-[SEQ])
 * shown to the cashier until the real sync assigns a BIR receipt number.
 */
export async function enqueueOfflineTransaction(branchCode: string, payload: CreateTransactionInput): Promise<string> {
  if (typeof window === 'undefined') throw new Error('Offline queueing is only available in the browser');

  const now = Date.now();
  const sequence = await nextOfflineSequence(branchCode);
  const dateStr = manilaDateString(new Date(now)).replace(/-/g, '');
  const id = `PC-${branchCode}-${dateStr}-OFFLINE-${String(sequence).padStart(4, '0')}`;

  await db.offlineTransactions.add({ id, payload, createdAt: now, syncedAt: null, officialTransactionNumber: null });
  return id;
}

interface SyncOfflineTransactionsResult {
  offline_provisional_number: string;
  status: 'synced' | 'failed';
  transaction?: { receipt_number: string };
  error?: { code: string; message?: string };
}

interface SyncOfflineTransactionsResponse {
  results: SyncOfflineTransactionsResult[];
  synced_count: number;
}

/**
 * Drains offline transactions in one reconnect-sync batch call once
 * connectivity returns, per Architecture doc §10.3 — the server processes
 * the batch in chronological order (client_created_at) and assigns each an
 * official receipt number; this just relays that queue's payload shape and
 * writes the results back. A failed item is logged and left in the local
 * queue (retried on the next reconnect) rather than blocking the rest of
 * the batch from syncing.
 */
export async function syncOfflineTransactions(): Promise<void> {
  if (typeof window === 'undefined') return;

  // `.where('syncedAt').equals(0)` never matches — rows are created with
  // syncedAt: null, and IndexedDB key comparisons don't coerce null to 0.
  // Filtering after an indexed orderBy keeps the chronological order without
  // that mismatch.
  const pending = await db.offlineTransactions.orderBy('createdAt').filter((t) => t.syncedAt === null).toArray();
  const [firstPending] = pending;
  if (!firstPending) return;

  // Every queued transaction on this device was rung up at the same branch
  // — a device's terminal session never spans branches.
  const branchId = firstPending.payload.branch_id;

  try {
    const response = await apiClient<SyncOfflineTransactionsResponse>('/api/transactions/sync-offline', {
      method: 'POST',
      body: JSON.stringify({
        branch_id: branchId,
        transactions: pending.map((t) => ({
          offline_provisional_number: t.id,
          shift_id: t.payload.shift_id,
          items: t.payload.items,
          payment_method: t.payload.payment_method,
          discount_type: t.payload.discount_type,
          discount_id_reference: t.payload.discount_id_reference,
          discount_amount: t.payload.discount_amount,
          cash_tendered: t.payload.cash_tendered,
          gcash_reference_number: t.payload.gcash_reference_number,
          gcash_manually_verified: t.payload.gcash_manually_verified,
          client_created_at: t.createdAt,
        })),
      }),
    });

    if (!response.data) {
      console.error('Failed to sync offline transaction batch:', response.error);
      return;
    }

    for (const result of response.data.results) {
      if (result.status === 'synced' && result.transaction) {
        await db.offlineTransactions.update(result.offline_provisional_number, {
          syncedAt: Date.now(),
          officialTransactionNumber: result.transaction.receipt_number,
        });
      } else {
        console.error(`Failed to sync offline transaction ${result.offline_provisional_number}:`, result.error);
      }
    }
  } catch (error) {
    console.error('Failed to sync offline transaction batch:', error);
  }
}
