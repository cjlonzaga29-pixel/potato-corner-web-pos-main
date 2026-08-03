import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

type ConnectionState = 'connected' | 'reconnecting' | 'disconnected';

const CONNECTION_VARIANT: Record<ConnectionState, 'active' | 'warning' | 'critical'> = {
  connected: 'active',
  reconnecting: 'warning',
  disconnected: 'critical',
};

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
};

const CONNECTION_DOT: Record<ConnectionState, string> = {
  connected: 'bg-success',
  reconnecting: 'bg-warning',
  disconnected: 'bg-destructive',
};

/** Realtime socket status as a labeled badge — a colored dot alone fails the "not color-only" accessibility rule, so the state name is always rendered as text too. */
export function DashboardConnectionBadge({ isConnected, isReconnecting }: { isConnected: boolean; isReconnecting: boolean }) {
  const state: ConnectionState = isReconnecting ? 'reconnecting' : isConnected ? 'connected' : 'disconnected';
  return (
    <Badge variant={CONNECTION_VARIANT[state]} className="gap-1.5 font-medium">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${CONNECTION_DOT[state]}`} aria-hidden="true" />
      {CONNECTION_LABEL[state]}
    </Badge>
  );
}

interface DashboardPageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /** Branch selector, connection badge, or other existing header actions — never invent new controls here. */
  actions?: ReactNode;
}

/** Compact page header shared by the Admin, Supervisor, and Branch dashboards so all three open with identical structure and spacing. */
export function DashboardPageHeader({ title, subtitle, actions }: DashboardPageHeaderProps) {
  return (
    <div className="space-y-3 pb-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
          {subtitle && <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {actions && <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2.5">{actions}</div>}
      </div>
      <Separator className="bg-border/60" />
    </div>
  );
}
