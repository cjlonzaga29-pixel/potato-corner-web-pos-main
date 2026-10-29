import { db, type OfflineSyncError, type OfflineTransaction } from './db';
import { apiClient } from '../api-client';
import { manilaDateString } from '../manila-date';
import type { CreateTransactionInput } from '@potato-corner/shared';

export { manilaDateString };
export type { OfflineTransaction };

async function nextOfflineSequence(branchCode: string): Promise<number> {
  const key = `${branchCode}:${manilaDateString(new Date())}`;
  const existing = await db.offlineSequenceCounters.get(key);
  const next = (existing?.value ?? 0) + 1;
  await db.offlineSequenceCounters.put({ key, value: next });
  return next;
}

/** P46R3 — who rang the queued sale, plus a display-only summary for the Pending tab. */
export interface OfflineSaleContext {
  cashierUserId: string;
  cashierName: string;
  itemCount: number;
  totalAmount: number;
}

/**
 * Queues a transaction locally while offline instead of POSTing it live.
 * Returns the provisional local id (format: PC-[BRANCH]-[DATE]-OFFLINE-[SEQ])
 * shown to the cashier until the real sync assigns a BIR receipt number.
 */
export async function enqueueOfflineTransaction(branchCode: string, payload: CreateTransactionInput, context?: OfflineSaleContext): Promise<string> {
  if (typeof window === 'undefined') throw new Error('Offline queueing is only available in the browser');

  const now = Date.now();
  const sequence = await nextOfflineSequence(branchCode);
  const dateStr = manilaDateString(new Date(now)).replace(/-/g, '');
  const id = `PC-${branchCode}-${dateStr}-OFFLINE-${String(sequence).padStart(4, '0')}`;

  await db.offlineTransactions.add({
    id,
    payload,
    createdAt: now,
    syncedAt: null,
    officialTransactionNumber: null,
    ...(context
      ? {
          cashierUserId: context.cashierUserId,
          cashierName: context.cashierName,
          summary: { itemCount: context.itemCount, totalAmount: context.totalAmount },
        }
      : {}),
  });
  return id;
}

/**
 * P46R3 — per-item codes that settle a queued sale as refused: the server
 * found no committed sale for this offline identity (its replay lookup runs
 * first) and the cart failed option validation before the sale transaction.
 * Resending the same payload gets the same answer until the catalog itself
 * changes, so these wait for an explicit Retry instead of going out on every
 * reconnect. Every other failure (no response, server error, stock, shift,
 * unknown code) stays retryable.
 */
const DEFINITIVE_QUEUE_REJECTION_CODES = new Set(['PRODUCT_OPTION_REQUIRED', 'PRODUCT_OPTION_LIMIT_EXCEEDED', 'PRODUCT_OPTION_NOT_AVAILABLE']);

export function isDefinitiveQueueRejection(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && DEFINITIVE_QUEUE_REJECTION_CODES.has(code);
}

export interface SyncOfflineOptions {
  /** Only rows queued at this branch go in the batch (branchGuard checks the whole batch against one branch_id). */
  branchId: string;
  /** The cashier now at the terminal. Only rows they rang are sent, under their own token. */
  cashierUserId: string;
  /** The cashier's employee token on a Branch Account (and its refresh), as live checkout uses. Omitted: the session token. */
  accessToken?: string;
  refreshAccessToken?: () => Promise<string | null>;
  /** Explicit Retry: exactly these rows, including refused ones. Omitted: every eligible row not refused. */
  onlyIds?: readonly string[];
}

export interface SyncOfflineOutcome {
  attempted: number;
  synced: string[];
  /** Newly refused (definitive) in this run. */
  rejected: string[];
  /** Still waiting after a retryable failure. */
  failed: string[];
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
 * A row goes out only under the token of the cashier who rang it. Rows
 * queued before P46R3 never recorded one, so they are never sent
 * automatically: whoever is signed in now (Branch Account employee or a
 * direct login) may not be the person who sold it, and the server records
 * the sender as cashier_id.
 */
export function isOfflineSaleEligible(row: OfflineTransaction, options: Pick<SyncOfflineOptions, 'branchId' | 'cashierUserId'>): boolean {
  if (row.syncedAt !== null || row.payload.branch_id !== options.branchId) return false;
  return Boolean(row.cashierUserId) && row.cashierUserId === options.cashierUserId;
}

// One sync at a time: a reconnect, a cashier change and a Retry tap can all
// fire together, and sending one row in two overlapping batches only leans
// on the server's replay guard for no reason.
let syncChain: Promise<unknown> = Promise.resolve();

/**
 * Drains offline transactions in one reconnect-sync batch call once
 * connectivity returns, per Architecture doc §10.3 — the server processes
 * the batch in chronological order (client_created_at) and assigns each an
 * official receipt number; this just relays that queue's payload shape and
 * writes the results back. A failed item is left in the local queue rather
 * than blocking the rest of the batch from syncing.
 *
 * P46R3 — the server's (branch, X-Device-ID, provisional number) replay guard
 * is what makes resending safe: an attempt that committed but lost its
 * response comes back 'synced' with the original sale. So the identity (row
 * id, createdAt, device) and the payload are never changed here, and a row is
 * only ever marked synced on a 'synced' result. The outcome of every attempt
 * is stored on the row for the Pending tab instead of console-only.
 */
export function syncOfflineTransactions(options: SyncOfflineOptions): Promise<SyncOfflineOutcome> {
  const run = syncChain.then(() => runSync(options));
  syncChain = run.catch(() => undefined);
  return run;
}

async function runSync(options: SyncOfflineOptions): Promise<SyncOfflineOutcome> {
  const outcome: SyncOfflineOutcome = { attempted: 0, synced: [], rejected: [], failed: [] };
  if (typeof window === 'undefined') return outcome;

  // `.where('syncedAt').equals(0)` never matches — rows are created with
  // syncedAt: null, and IndexedDB key comparisons don't coerce null to 0.
  // Filtering after an indexed orderBy keeps the chronological order without
  // that mismatch.
  const pending = await db.offlineTransactions
    .orderBy('createdAt')
    .filter((t) => isOfflineSaleEligible(t, options) && (options.onlyIds ? options.onlyIds.includes(t.id) : !t.rejection))
    .toArray();
  if (pending.length === 0) return outcome;
  outcome.attempted = pending.length;

  const markAllFailed = async (code: string, message: string | null) => {
    const error: OfflineSyncError = { code, message, at: Date.now() };
    for (const row of pending) await db.offlineTransactions.update(row.id, { lastError: error });
    outcome.failed = pending.map((row) => row.id);
  };

  try {
    const response = await apiClient<SyncOfflineTransactionsResponse>(
      '/api/transactions/sync-offline',
      {
        method: 'POST',
        body: JSON.stringify({
          branch_id: options.branchId,
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
      },
      options.accessToken,
      options.refreshAccessToken,
    );

    if (!response.data) {
      // The whole batch was refused or never answered: nothing per-row is
      // proven, so every row stays retryable (a row already refused keeps
      // that refusal — only a per-row answer changes it).
      const error = response.error;
      if (typeof error === 'string') await markAllFailed('SYNC_FAILED', error);
      else await markAllFailed(error?.code ?? 'SYNC_FAILED', error?.message ?? null);
      return outcome;
    }

    const answered = new Set<string>();
    for (const result of response.data.results) {
      const id = result.offline_provisional_number;
      answered.add(id);
      if (result.status === 'synced' && result.transaction) {
        await db.offlineTransactions.update(id, {
          syncedAt: Date.now(),
          officialTransactionNumber: result.transaction.receipt_number,
          rejection: null,
          lastError: null,
        });
        outcome.synced.push(id);
        continue;
      }
      const error: OfflineSyncError = { code: result.error?.code ?? 'SYNC_FAILED', message: result.error?.message ?? null, at: Date.now() };
      if (isDefinitiveQueueRejection(error.code)) {
        await db.offlineTransactions.update(id, { rejection: error, lastError: null });
        outcome.rejected.push(id);
      } else {
        await db.offlineTransactions.update(id, { lastError: error });
        outcome.failed.push(id);
      }
    }
    // A row the response never mentioned proves nothing either way.
    for (const row of pending.filter((candidate) => !answered.has(candidate.id))) {
      await db.offlineTransactions.update(row.id, { lastError: { code: 'SYNC_FAILED', message: null, at: Date.now() } });
      outcome.failed.push(row.id);
    }
  } catch (error) {
    await markAllFailed('SYNC_FAILED', error instanceof Error ? error.message : null);
  }
  return outcome;
}

/** P46R3 — the Pending/Done tabs' view of this branch's queue: every unsynced row, plus rows synced in the last 12 hours, newest first. */
export async function listOfflineSales(branchId: string): Promise<OfflineTransaction[]> {
  if (typeof window === 'undefined') return [];
  const since = Date.now() - 12 * 60 * 60 * 1000;
  const rows = await db.offlineTransactions
    .orderBy('createdAt')
    .filter((t) => t.payload.branch_id === branchId && (t.syncedAt === null || t.syncedAt >= since))
    .toArray();
  return rows.reverse();
}
