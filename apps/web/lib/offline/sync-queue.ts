import { db } from './db';
import { apiClient } from '../api-client';
import type { CreateTransactionInput } from '@potato-corner/shared';

async function nextOfflineSequence(branchCode: string): Promise<number> {
  const key = `${branchCode}:${new Date().toISOString().slice(0, 10)}`;
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
  const dateStr = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  const id = `PC-${branchCode}-${dateStr}-OFFLINE-${String(sequence).padStart(4, '0')}`;

  await db.offlineTransactions.add({ id, payload, createdAt: now, syncedAt: null, officialTransactionNumber: null });
  return id;
}

/**
 * Drains offline transactions in chronological order once connectivity
 * returns, per Architecture doc §10.3. The server assigns the official
 * receipt number; the local record is updated to reference it. A failed
 * sync is logged and left in the queue — the loop moves on to the next
 * transaction rather than blocking the whole drain on one bad payload.
 */
export async function syncOfflineTransactions(): Promise<void> {
  if (typeof window === 'undefined') return;

  // `.where('syncedAt').equals(0)` never matches — rows are created with
  // syncedAt: null, and IndexedDB key comparisons don't coerce null to 0.
  // Filtering after an indexed orderBy keeps the chronological order without
  // that mismatch.
  const pending = await db.offlineTransactions.orderBy('createdAt').filter((t) => t.syncedAt === null).toArray();

  for (const transaction of pending) {
    try {
      const response = await apiClient<{ receipt_number: string }>('/api/transactions', {
        method: 'POST',
        body: JSON.stringify(transaction.payload),
      });

      if (response.data) {
        await db.offlineTransactions.update(transaction.id, {
          syncedAt: Date.now(),
          officialTransactionNumber: response.data.receipt_number,
        });
      } else {
        console.error(`Failed to sync offline transaction ${transaction.id}:`, response.error);
      }
    } catch (error) {
      console.error(`Failed to sync offline transaction ${transaction.id}:`, error);
    }
  }
}
