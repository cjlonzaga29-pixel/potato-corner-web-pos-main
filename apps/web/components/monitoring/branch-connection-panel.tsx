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
 * (transactions, alerts, shift lifecycle) — rather than a dedicated
 * "branch:<id>" event, which nothing in the backend currently emits.
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
  for (const entry of entries) {
    const branchId = entry.payload.branchId ?? entry.payload.branch_id;
    if (!branchId) continue;
    const existing = lastSeenByBranch.get(branchId);
    if (!existing || entry.receivedAt > existing) lastSeenByBranch.set(branchId, entry.receivedAt);
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
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {branches.map((branch) => {
                const lastSeen = lastSeenByBranch.get(branch.id);
                const status = !lastSeen ? 'Never seen' : now - lastSeen < ACTIVE_WINDOW_MS ? 'Active' : 'Idle';
                const dot = status === 'Active' ? '🟢' : status === 'Idle' ? '⚪' : '🔴';
                return (
                  <div key={branch.id} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
                    <span className="truncate">{branch.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {dot} {status}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">🟢 Active (event &lt;60s ago) · ⚪ Idle · 🔴 Never seen</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
