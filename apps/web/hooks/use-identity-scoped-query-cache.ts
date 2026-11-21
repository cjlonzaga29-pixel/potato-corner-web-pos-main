'use client';

import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth.store';
import { purgeApiResponseCache } from '@/lib/offline/purge-api-response-cache';

/**
 * POS-PERF-P62 — nothing the previous identity loaded may stay on screen or in
 * the cache for the next one. When auth.store's identityEpoch changes (a
 * sign-out, or another account signing in) every query is cancelled and the
 * cache emptied, and stored API responses are purged from the service
 * worker's caches. api-client.ts separately drops any response that started
 * under the earlier identity, so a fetch that answers late can't put it back.
 *
 * Offline sales, drafts and unresolved operations live in IndexedDB and are
 * deliberately left alone, so an uncertain sale stays recoverable.
 *
 * Upgrade: on the first load after an upgrade the previous build's service
 * worker still controls the page while the new one installs, and it keeps
 * caching API responses after the start-up purge (seen in the P62 browser run:
 * four new entries). So the purge also runs when a new worker takes control,
 * and once more shortly after, for a request the old worker was finishing.
 *
 * Returns the unsubscribe function.
 */
export const CONTROLLER_CHANGE_REPURGE_MS = 5000;

export function bindIdentityScopedQueryCache(queryClient: QueryClient): () => void {
  void purgeApiResponseCache();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  const onControllerChange = () => {
    void purgeApiResponseCache();
    timers.push(setTimeout(() => void purgeApiResponseCache(), CONTROLLER_CHANGE_REPURGE_MS));
  };
  sw?.addEventListener('controllerchange', onControllerChange);
  const unsubscribe = useAuthStore.subscribe((state, previous) => {
    if (state.identityEpoch === previous.identityEpoch) return;
    void queryClient.cancelQueries();
    queryClient.clear();
    void purgeApiResponseCache();
  });
  return () => {
    unsubscribe();
    sw?.removeEventListener('controllerchange', onControllerChange);
    for (const timer of timers) clearTimeout(timer);
  };
}

export function useIdentityScopedQueryCache(queryClient: QueryClient): void {
  useEffect(() => bindIdentityScopedQueryCache(queryClient), [queryClient]);
}
