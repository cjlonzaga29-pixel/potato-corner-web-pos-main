'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { listOfflineSales, syncOfflineTransactions, type OfflineTransaction, type SyncOfflineOutcome } from '@/lib/offline/sync-queue';

/**
 * P46R3 — who is at the terminal, so queued sales sync under the cashier who
 * rang them. `cashierUserId` is null while nobody is (a locked Branch
 * Account), and nothing syncs then. `accessToken` is the Branch Account's
 * employee token; it is required there, since the Branch Account's own
 * session is never clocked in and the server would refuse the batch.
 */
export interface OfflineSyncOperator {
  branchId: string | null;
  cashierUserId: string | null;
  isBranchAccount: boolean;
  accessToken?: string;
  refreshAccessToken?: () => Promise<string | null>;
  /** A sync answered one or more queued sales with a definitive refusal. */
  onRejected?: (ids: string[]) => void;
}

/**
 * Tracks browser connectivity and the local offline-transaction queue
 * depth, triggering a sync attempt on reconnect. Starts `isOnline: true`
 * unconditionally (matching what the server would render) and only reads
 * the real `navigator.onLine` value after mount — reading it during the
 * initial render would disagree with SSR output and cause a hydration
 * mismatch, the same class of bug fixed in the login form (see
 * apps/web/app/(auth)/login/_components/login-form.tsx).
 *
 * P46R3 — also syncs when the cashier at the terminal changes (their own
 * queued sales can only go out under their token) and exposes the queue rows
 * for the Pending/Done tabs. A refused row is never resent automatically;
 * `retryOfflineSale` is the explicit path.
 */
export function useOffline(operator?: OfflineSyncOperator) {
  const [isOnline, setIsOnline] = useState(true);
  const [offlineSales, setOfflineSales] = useState<OfflineTransaction[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);

  // Tokens rotate every few minutes; reading them through a ref keeps a token
  // refresh from counting as "the cashier changed" and re-firing a sync.
  const operatorRef = useRef(operator);
  operatorRef.current = operator;
  const branchId = operator?.branchId ?? null;
  const cashierUserId = operator?.cashierUserId ?? null;

  const refreshOfflineSales = useCallback(async () => {
    if (!branchId) {
      setOfflineSales([]);
      return;
    }
    setOfflineSales(await listOfflineSales(branchId));
  }, [branchId]);

  const runSync = useCallback(
    async (onlyIds?: readonly string[]): Promise<SyncOfflineOutcome | null> => {
      const current = operatorRef.current;
      if (!current?.branchId || !current.cashierUserId) return null;
      if (current.isBranchAccount && !current.accessToken) return null;
      setIsSyncing(true);
      try {
        const outcome = await syncOfflineTransactions({
          branchId: current.branchId,
          cashierUserId: current.cashierUserId,
          ...(current.isBranchAccount ? { accessToken: current.accessToken, refreshAccessToken: current.refreshAccessToken } : {}),
          ...(onlyIds ? { onlyIds } : {}),
        });
        if (outcome.rejected.length > 0) current.onRejected?.(outcome.rejected);
        return outcome;
      } finally {
        setIsSyncing(false);
        await refreshOfflineSales();
      }
    },
    [refreshOfflineSales],
  );

  useEffect(() => {
    setIsOnline(navigator.onLine);

    function handleOnline() {
      setIsOnline(true);
      void runSync();
    }
    function handleOffline() {
      setIsOnline(false);
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [runSync]);

  // On mount and whenever the cashier or branch changes: list the queue, and
  // send this cashier's waiting rows if the device is online.
  useEffect(() => {
    void refreshOfflineSales();
    if (cashierUserId && navigator.onLine) void runSync();
  }, [branchId, cashierUserId, refreshOfflineSales, runSync]);

  const syncNow = useCallback(() => runSync(), [runSync]);
  const retryOfflineSale = useCallback((id: string) => runSync([id]), [runSync]);

  const pendingSyncCount = offlineSales.filter((sale) => sale.syncedAt === null).length;

  return { isOnline, isOffline: !isOnline, pendingSyncCount, offlineSales, isSyncing, syncNow, retryOfflineSale, refreshOfflineSales };
}
