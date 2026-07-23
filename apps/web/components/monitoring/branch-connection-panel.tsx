'use client';

import { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import { useRealtimeFeed } from '@/hooks/use-realtime-feed';
import { useBranches } from '@/hooks/queries/use-branches';
import { useAuthStore } from '@/stores/auth.store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface BranchScopedPayload {
  branchId?: string;
  branch_id?: string;
}

/**
 * Branch activity is inferred from any event carrying that branch's id —
 * the same broad vocabulary the other panels already subscribe to
 * (transactions, alerts, shift lifecycle). BRANCH_OFFLINE/BRANCH_ONLINE
 * (socket/presence.ts — no staff socket connected to the branch's room for
 * 30s) are the authoritative signal when present and override the inferred
 * "Idle" state below.
 */
const ACTIVITY_EVENTS = [
  SOCKET_EVENTS.TRANSACTION_COMPLETED,
  SOCKET_EVENTS.TRANSACTION_REFUNDED,
  SOCKET_EVENTS.SHIFT_OPENED,
  SOCKET_EVENTS.SHIFT_CLOSED,
  SOCKET_EVENTS.FRAUD_ALERT_CREATED,
  SOCKET_EVENTS.INVENTORY_LOW_STOCK,
  SOCKET_EVENTS.INVENTORY_OUT_OF_STOCK,
  SOCKET_EVENTS.CASH_VARIANCE_FLAGGED,
  SOCKET_EVENTS.VOID_REQUESTED,
  SOCKET_EVENTS.BRANCH_OFFLINE,
  SOCKET_EVENTS.BRANCH_ONLINE,
];

const FEED_MAX_SIZE = 100;
const ACTIVE_WINDOW_MS = 60_000;

export function BranchConnectionPanel() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const isLoadingAuth = useAuthStore((state) => state.isLoading);
  const { data: branchesData, isLoading: isLoadingBranches } = useBranches({ limit: 100 });
  const entries = useRealtimeFeed<BranchScopedPayload>(ACTIVITY_EVENTS, FEED_MAX_SIZE);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(interval);
  }, []);

  const lastSeenByBranch = new Map<string, number>();
  const latestEventByBranch = new Map<string, string>();
  for (const entry of entries) {
    const branchId = entry.payload.branchId ?? entry.payload.branch_id;
    if (!branchId) continue;
    const existing = lastSeenByBranch.get(branchId);
    if (!existing || entry.receivedAt > existing) {
      lastSeenByBranch.set(branchId, entry.receivedAt);
      latestEventByBranch.set(branchId, entry.event);
    }
  }

  const isLoading = !accessToken || isLoadingAuth || isLoadingBranches;
  const branches = branchesData?.branches ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="h-4 w-4" />
          Branch Connection Status
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <>
            <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
              {branches.map((branch) => {
                const lastSeen = lastSeenByBranch.get(branch.id);
                const latestEvent = latestEventByBranch.get(branch.id);
                const status = !lastSeen
                  ? 'Never seen'
                  : latestEvent === SOCKET_EVENTS.BRANCH_OFFLINE
                    ? 'Offline'
                    : now - lastSeen < ACTIVE_WINDOW_MS
                      ? 'Active'
                      : 'Idle';
                const dot = status === 'Active' ? '🟢' : status === 'Idle' ? '⚪' : '🔴';
                return (
                  <div key={branch.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {dot} {status}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">🟢 Active (event &lt;60s ago) · ⚪ Idle · 🔴 Offline / never seen</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
