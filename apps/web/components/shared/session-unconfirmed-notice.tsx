'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { retryUnconfirmedSession } from '@/hooks/use-auth';

function readOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

/**
 * POS-PERF-P69R — shown instead of a page when this tab's sign-in could not be
 * checked (session `unconfirmed`: offline, timeout or server error on reload).
 * It never claims "No branch assigned": the account and its branch are simply
 * unknown until the server answers. Nothing on the device is cleared, and no
 * branch is assumed from cached data.
 *
 * Tries again by itself when the browser comes back online or the tab becomes
 * visible, and on "Try again". A definitive refusal goes to sign-in.
 */
export function SessionUnconfirmedNotice() {
  const router = useRouter();
  const [isOnline, setIsOnline] = useState(readOnline);
  const [isChecking, setIsChecking] = useState(false);
  const checkingRef = useRef(false);

  const retry = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setIsChecking(true);
    try {
      const result = await retryUnconfirmedSession();
      if (result === 'ended') router.replace('/login');
    } finally {
      checkingRef.current = false;
      setIsChecking(false);
    }
  }, [router]);

  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
      void retry();
    }
    function handleOffline() {
      setIsOnline(false);
    }
    function handleVisible() {
      if (document.visibilityState === 'visible' && readOnline()) void retry();
    }
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisible);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, [retry]);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <section aria-labelledby="session-unconfirmed-title" className="max-w-md space-y-3 rounded-lg border bg-card p-6 text-center shadow-sm">
        <WifiOff className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
        <h1 id="session-unconfirmed-title" className="text-lg font-semibold">
          {isOnline ? "Can't reach the server to confirm your sign-in" : "Can't confirm your sign-in while offline"}
        </h1>
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {isChecking
            ? 'Checking your sign-in…'
            : isOnline
              ? 'Your account and branch could not be checked yet. Try again in a moment.'
              : 'Your account and branch can be checked once this device is back online. This page continues on its own when the connection returns.'}
        </p>
        <p className="text-sm text-muted-foreground">Sales, drafts and queued sales saved on this device are kept.</p>
        <Button type="button" onClick={() => void retry()} disabled={isChecking} className="touch-target gap-1.5">
          {isChecking && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          Try again
        </Button>
      </section>
    </div>
  );
}
