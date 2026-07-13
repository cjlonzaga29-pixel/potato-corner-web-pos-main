import Dexie, { type EntityTable } from 'dexie';
import type { CreateTransactionInput } from '@potato-corner/shared';

interface OfflineTransaction {
  id: string; // provisional local id, e.g. PC-[BRANCH]-[DATE]-OFFLINE-[LOCAL_SEQ]
  payload: CreateTransactionInput;
  createdAt: number;
  syncedAt: number | null;
  officialTransactionNumber: string | null;
}

interface CachedProduct {
  id: string;
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
