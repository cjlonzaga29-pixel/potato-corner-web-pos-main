'use client';

import { useEffect } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { SocketEvent } from '@potato-corner/shared';
import { useSocket } from '@/hooks/use-socket';

/**
 * Subscribes to one or more Socket.io events and invalidates the given
 * TanStack Query key prefixes whenever any of them fire — the shared
 * plumbing behind every domain's real-time cache sync (attendance,
 * inventory, transactions, shifts). Each key is a prefix, matching
 * TanStack Query's default partial-key invalidation (e.g. ['shifts']
 * invalidates every ['shifts', filters] variant).
 */
export function useRealtimeInvalidate(events: SocketEvent[], queryKeyPrefixes: QueryKey[]): void {
  const { on, off } = useSocket();
  const queryClient = useQueryClient();
  const eventsSignature = events.join(',');
  const keysSignature = JSON.stringify(queryKeyPrefixes);

  useEffect(() => {
    function handleEvent() {
      for (const key of queryKeyPrefixes) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    }

    for (const event of events) on(event, handleEvent);
    return () => {
      for (const event of events) off(event, handleEvent);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsSignature, keysSignature, queryClient]);
}
