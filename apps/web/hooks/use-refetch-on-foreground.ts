'use client';

import { useEffect } from 'react';

/**
 * Re-runs `refetch` when the tab/app regains the foreground (app switch,
 * screen unlock, browser tab refocus). Attendance state is
 * server-authoritative and TanStack Query's own refetchOnWindowFocus is
 * disabled app-wide (components/shared/providers.tsx, to keep the POS stable
 * mid-transaction) — without this, a clock-out made from another device
 * never clears a mobile session's stale "clocked in" read until its next
 * unrelated refetch.
 */
export function useRefetchOnForeground(refetch: () => void): void {
  useEffect(() => {
    function handleForeground() {
      if (document.visibilityState === 'visible') refetch?.();
    }
    document.addEventListener('visibilitychange', handleForeground);
    window.addEventListener('focus', handleForeground);
    return () => {
      document.removeEventListener('visibilitychange', handleForeground);
      window.removeEventListener('focus', handleForeground);
    };
  }, [refetch]);
}
