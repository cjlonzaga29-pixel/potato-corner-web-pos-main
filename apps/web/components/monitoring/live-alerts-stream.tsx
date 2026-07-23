'use client';

import { AlertTriangle, ShieldAlert, PackageX, Banknote, Ban, SearchX } from 'lucide-react';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import { useRealtimeFeed } from '@/hooks/use-realtime-feed';
import { useBranches } from '@/hooks/queries/use-branches';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { cn, formatTimeAgo } from '@/lib/utils';

interface AlertPayload {
  branchId?: string;
  alertId?: string;
  severity?: string;
  currentStock?: number;
  shiftId?: string;
  variance?: number;
  transactionId?: string;
  reason?: string | null;
}

const ALERT_EVENTS = [
  SOCKET_EVENTS.FRAUD_ALERT_CREATED,
  SOCKET_EVENTS.INVENTORY_LOW_STOCK,
  SOCKET_EVENTS.INVENTORY_OUT_OF_STOCK,
  SOCKET_EVENTS.CASH_VARIANCE_FLAGGED,
  SOCKET_EVENTS.VOID_REQUESTED,
  SOCKET_EVENTS.FRAUD_SCAN_FAILED,
];

const FEED_MAX_SIZE = 20;

const ALERT_META: Record<string, { label: string; icon: typeof ShieldAlert; severity: 'red' | 'orange' | 'yellow' }> = {
  [SOCKET_EVENTS.FRAUD_ALERT_CREATED]: { label: 'Fraud alert', icon: ShieldAlert, severity: 'red' },
  [SOCKET_EVENTS.INVENTORY_OUT_OF_STOCK]: { label: 'Out of stock', icon: PackageX, severity: 'red' },
  [SOCKET_EVENTS.INVENTORY_LOW_STOCK]: { label: 'Low stock', icon: PackageX, severity: 'orange' },
  [SOCKET_EVENTS.CASH_VARIANCE_FLAGGED]: { label: 'Cash variance', icon: Banknote, severity: 'orange' },
  [SOCKET_EVENTS.VOID_REQUESTED]: { label: 'Void request', icon: Ban, severity: 'yellow' },
  [SOCKET_EVENTS.FRAUD_SCAN_FAILED]: { label: 'Fraud scan failed', icon: SearchX, severity: 'red' },
};

const SEVERITY_CLASSES: Record<'red' | 'orange' | 'yellow', string> = {
  red: 'text-destructive',
  orange: 'text-warning',
  yellow: 'text-accent',
};

export function LiveAlertsStream() {
  const entries = useRealtimeFeed<AlertPayload>(ALERT_EVENTS, FEED_MAX_SIZE);
  const { data: branchesData } = useBranches({ limit: 100 });
  const branchNameById = new Map((branchesData?.branches ?? []).map((b) => [b.id, b.name]));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4" />
          Live Alerts Stream
        </CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <EmptyState icon={AlertTriangle} title="Waiting for activity..." />
        ) : (
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {entries.map((entry) => {
              const meta = ALERT_META[entry.event] ?? { label: entry.event, icon: AlertTriangle, severity: 'yellow' as const };
              const Icon = meta.icon;
              const branchId = entry.payload.branchId;
              return (
                <div key={entry.id} className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm">
                  <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', SEVERITY_CLASSES[meta.severity])} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{meta.label}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {(branchId && branchNameById.get(branchId)) ?? 'Unknown branch'}
                    </p>
                  </div>
                  <p className="shrink-0 text-xs text-muted-foreground">{formatTimeAgo(new Date(entry.receivedAt))}</p>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
