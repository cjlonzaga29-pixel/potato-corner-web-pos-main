import Dexie, { type EntityTable } from 'dexie';
import type { CreateTransactionInput } from '@potato-corner/shared';

/** P46R3 — a server answer for one queued sale, kept so the cashier can see it (was console-only). */
export interface OfflineSyncError {
  code: string;
  message: string | null;
  at: number;
}

export interface OfflineTransaction {
  id: string; // provisional local id, e.g. PC-[BRANCH]-[DATE]-OFFLINE-[LOCAL_SEQ]
  payload: CreateTransactionInput;
  createdAt: number;
  syncedAt: number | null;
  officialTransactionNumber: string | null;
  // P46R3 — the fields below are not indexed, so no schema version bump; rows
  // queued before P46R3 simply lack them.
  /** Who rang the sale. Sync only ever sends it under this user's own token, so the server's cashier_id stays theirs. */
  cashierUserId?: string;
  cashierName?: string;
  /** Display only — the server recomputes every amount. */
  summary?: { itemCount: number; totalAmount: number };
  /** A definitive server refusal (see isDefinitiveQueueRejection). Never resent automatically; only an explicit Retry clears it. */
  rejection?: OfflineSyncError | null;
  /** The latest failed attempt that proves nothing permanent (connection, server error, unknown code). Retried on the next sync. */
  lastError?: OfflineSyncError | null;
}

interface CachedProduct {
  /** POS-PERF-P39 — `<branchId>:<productId>`; rows cached before P39 used the bare product id and carry no branchId. */
  id: string;
  /** POS-PERF-P39 — the branch whose catalog this row came from (prices and availability are per branch). Not indexed, so no schema version bump. */
  branchId?: string;
  data: unknown;
  cachedAt: number;
}

interface OfflineSequenceCounter {
  /** Key format: "<branchCode>:<YYYY-MM-DD>" — resets to 1 at midnight per day. */
  key: string;
  value: number;
}

/**
 * IndexedDB schema for offline POS operation. See Architecture doc §10 for
 * the full offline strategy — this is the local queue that
 * lib/offline/sync-queue.ts drains once connectivity returns.
 */
export const db = new Dexie('potato-corner-pos') as Dexie & {
  offlineTransactions: EntityTable<OfflineTransaction, 'id'>;
  cachedProducts: EntityTable<CachedProduct, 'id'>;
  offlineSequenceCounters: EntityTable<OfflineSequenceCounter, 'key'>;
};

db.version(1).stores({
  offlineTransactions: 'id, createdAt, syncedAt',
  cachedProducts: 'id, cachedAt',
  offlineSequenceCounters: 'key',
});

db.version(2).stores({
  cachedPriceOverrides: null,
});
