'use client';

import { Suspense } from 'react';
import { useSocketStore } from '@/stores/socket.store';
import { useAuthStore } from '@/stores/auth.store';
import { LiveTransactionFeed } from '@/components/monitoring/live-transaction-feed';
import { ActiveCashiersPanel } from '@/components/monitoring/active-cashiers-panel';
import { LiveAlertsStream } from '@/components/monitoring/live-alerts-stream';
import { BranchConnectionPanel } from '@/components/monitoring/branch-connection-panel';
import { Skeleton } from '@/components/ui/skeleton';

function MonitoringPageContent() {
  const isConnected = useSocketStore((s) => s.isConnected);
  const isReconnecting = useSocketStore((s) => s.isReconnecting);
  const isLoadingAuth = useAuthStore((s) => s.isLoading);

  const connectionLabel = isReconnecting ? 'Reconnecting' : isConnected ? 'Connected' : 'Disconnected';
  const connectionColor = isReconnecting ? 'bg-yellow-500' : isConnected ? 'bg-green-500' : 'bg-red-500';

  if (isLoadingAuth) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton className="h-80 w-full" />
          <Skeleton className="h-80 w-full" />
          <Skeleton className="h-80 w-full" />
          <Skeleton className="h-80 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Real-Time Monitoring</h1>
          <p className="text-sm text-muted-foreground">Live activity across all branches</p>
        </div>
        <div className="flex items-center gap-2">
          <span
            title={connectionLabel}
            aria-label={connectionLabel}
            className={`h-2.5 w-2.5 rounded-full ${connectionColor}`}
          />
          <span className="text-sm text-muted-foreground">{connectionLabel}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <LiveTransactionFeed />
        <ActiveCashiersPanel />
        <LiveAlertsStream />
        <BranchConnectionPanel />
      </div>
    </div>
  );
}

export default function MonitoringPage() {
  return (
    <Suspense fallback={<div>Loading monitoring dashboard...</div>}>
      <MonitoringPageContent />
    </Suspense>
  );
}
