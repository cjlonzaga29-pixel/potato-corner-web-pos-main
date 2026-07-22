'use client';

import { useEffect, useState } from 'react';
import { useSocket } from '@/hooks/use-socket';
import { useAuthStore } from '@/stores/auth.store';

export interface RealtimeFeedEntry<T> {
  id: string;
  event: string;
  receivedAt: number;
  payload: T;
}

/**
 * Bounded, append-only view over a set of Socket.io events — the live-feed
 * counterpart to use-realtime-invalidate.ts's cache-sync pattern. Each
 * matching event is wrapped with its name and arrival time (payload shapes
 * differ per event, see packages/shared/src/constants/events.ts) and pushed
 * onto the end of the array, oldest dropped once maxSize is exceeded.
 */
export function useRealtimeFeed<T = unknown>(events: string[], maxSize = 20): Array<RealtimeFeedEntry<T>> {
  const { on, off } = useSocket();
  const accessToken = useAuthStore((state) => state.accessToken);
  const [entries, setEntries] = useState<Array<RealtimeFeedEntry<T>>>([]);
  const eventsSignature = events.join(',');

  useEffect(() => {
    if (!accessToken) return;

    function makeHandler(event: string) {
      return (payload: unknown) => {
        setEntries((prev) => {
          const next = [...prev, { id: crypto.randomUUID(), event, receivedAt: Date.now(), payload: payload as T }];
          return next.length > maxSize ? next.slice(next.length - maxSize) : next;
        });
      };
    }

    const eventList = eventsSignature ? eventsSignature.split(',') : [];
    const handlerByEvent = new Map(eventList.map((event) => [event, makeHandler(event)]));
    for (const [event, handler] of handlerByEvent) on(event, handler);

    return () => {
      for (const [event, handler] of handlerByEvent) off(event, handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, eventsSignature, maxSize]);

  return entries;
}
