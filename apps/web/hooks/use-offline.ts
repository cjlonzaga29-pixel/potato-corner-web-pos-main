'use client';

import { useCallback, useEffect, useState } from 'react';
import { db } from '@/lib/offline/db';
import { syncOfflineTransactions } from '@/lib/offline/sync-queue';

/**
 * Tracks browser connectivity and the local offline-transaction queue
 * depth, triggering a sync attempt on reconnect. Starts `isOnline: true`
 * unconditionally (matching what the server would render) and only reads
 * the real `navigator.onLine` value after mount — reading it during the
 * initial render would disagree with SSR output and cause a hydration
 * mismatch, the same class of bug fixed in the login form (see
 * apps/web/app/(auth)/login/_components/login-form.tsx).
 */
export function useOffline() {
  const [isOnline, setIsOnline] = useState(true);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);

  const refreshPendingCount = useCallback(async () => {
    // See sync-queue.ts — syncedAt is stored as null, not 0, so an indexed
    // .equals(0) query would silently never match.
    const count = await db.offlineTransactions.filter((t) => t.syncedAt === null).count();
    setPendingSyncCount(count);
  }, []);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    void refreshPendingCount();

    function handleOnline() {
      setIsOnline(true);
      void syncOfflineTransactions().finally(() => void refreshPendingCount());
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
  }, [refreshPendingCount]);

  return { isOnline, isOffline: !isOnline, pendingSyncCount };
}
