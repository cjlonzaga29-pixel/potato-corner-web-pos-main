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
 * Returns the unsubscribe function.
 */
export function bindIdentityScopedQueryCache(queryClient: QueryClient): () => void {
  void purgeApiResponseCache();
  return useAuthStore.subscribe((state, previous) => {
    if (state.identityEpoch === previous.identityEpoch) return;
    void queryClient.cancelQueries();
    queryClient.clear();
    void purgeApiResponseCache();
  });
}

export function useIdentityScopedQueryCache(queryClient: QueryClient): void {
  useEffect(() => bindIdentityScopedQueryCache(queryClient), [queryClient]);
}
