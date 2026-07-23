'use client';

import type { ColumnDef } from '@tanstack/react-table';
import type { FraudAlertResponse, FraudAlertSeverity } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/shared/status-badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDateTime, formatTimeAgo } from '@/lib/utils';

/**
 * StatusBadge already has a `fraud` status map (open/investigating/dismissed/
 * escalated, see apps/web/components/shared/status-badge.tsx) but no
 * severity map — severity is rendered with an explicit Badge + color class
 * instead, per the task's fallback instruction.
 */
const SEVERITY_CLASSES: Record<FraudAlertSeverity, string> = {
  critical: 'border-transparent bg-destructive/15 text-destructive',
  high: 'border-transparent bg-warning/15 text-warning',
  medium: 'border-transparent bg-accent/15 text-accent',
  low: 'border-transparent bg-info/15 text-info',
};

function humanize(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export interface FraudAlertActionHandlers {
  onInvestigate: (alert: FraudAlertResponse) => void;
  onDismiss: (alert: FraudAlertResponse) => void;
  onEscalate: (alert: FraudAlertResponse) => void;
  /** Mutation-in-flight state, keyed by alert id, so only the row whose action is pending shows disabled/loading buttons. */
  pendingAlertId: string | null;
}

export function createFraudAlertColumns({
  onInvestigate,
  onDismiss,
  onEscalate,
  pendingAlertId,
}: FraudAlertActionHandlers): ColumnDef<FraudAlertResponse>[] {
  return [
    {
      id: 'alert_type',
      header: 'Alert Type',
      cell: ({ row }) => humanize(row.original.alert_type),
    },
    {
      id: 'severity',
      header: 'Severity',
      cell: ({ row }) => (
        <Badge className={SEVERITY_CLASSES[row.original.severity]}>{humanize(row.original.severity)}</Badge>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => <StatusBadge status={row.original.status} type="fraud" />,
    },
    {
      id: 'branch_name',
      header: 'Branch',
      cell: ({ row }) => row.original.branch_name ?? '—',
    },
    {
      id: 'employee_name',
      header: 'Employee',
      cell: ({ row }) => row.original.employee_name ?? '—',
    },
    {
      id: 'created_at',
      header: 'Detected At',
      cell: ({ row }) => (
        // Scoped provider, not a root-level one: this app has no app-wide
        // TooltipProvider (apps/web/app/layout.tsx doesn't render one, and
        // attendance-columns.tsx's Tooltip usage happens to never hit this
        // in practice) — Radix's Tooltip.Root throws without an ancestor
        // Provider, so each cell brings its own.
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-default">{formatDateTime(row.original.created_at)}</span>
            </TooltipTrigger>
            <TooltipContent>{formatTimeAgo(row.original.created_at)}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      enableSorting: false,
      enableHiding: false,
      cell: ({ row }) => {
        const alert = row.original;
        const isPending = pendingAlertId === alert.id;
        return (
          <div className="flex items-center gap-2">
            {alert.status === 'open' && (
              <Button variant="outline" size="sm" disabled={isPending} onClick={() => onInvestigate(alert)}>
                Investigate
              </Button>
            )}
            {alert.status !== 'dismissed' && (
              <Button variant="outline" size="sm" disabled={isPending} onClick={() => onDismiss(alert)}>
                Dismiss
              </Button>
            )}
            {alert.status !== 'dismissed' && alert.status !== 'escalated' && (
              <Button variant="danger" size="sm" disabled={isPending} onClick={() => onEscalate(alert)}>
                Escalate
              </Button>
            )}
          </div>
        );
      },
    },
  ];
}
