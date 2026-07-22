'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/utils';
import type { AuditLogReportRow } from '@/hooks/queries/use-audit-log-report';

const ACTION_BADGE_VARIANT: Record<string, 'active' | 'critical' | 'inactive' | 'secondary'> = {
  LOGIN_SUCCESS: 'active',
  LOGIN_FAILURE: 'critical',
  LOGOUT: 'inactive',
  LOGOUT_ALL_DEVICES: 'inactive',
  PIN_LOGIN_SUCCESS: 'active',
  ACCOUNT_UNLOCKED: 'secondary',
};

export function createLoginAuditColumns(): ColumnDef<AuditLogReportRow>[] {
  return [
    {
      id: 'created_at',
      header: 'Timestamp',
      cell: ({ row }) => formatDateTime(row.original.created_at),
    },
    {
      id: 'actor_id',
      header: 'Actor',
      cell: ({ row }) => row.original.actor_id ?? 'System',
    },
    {
      id: 'actor_role',
      header: 'Role',
      cell: ({ row }) => row.original.actor_role ?? '—',
    },
    {
      id: 'action',
      header: 'Action',
      cell: ({ row }) => <Badge variant={ACTION_BADGE_VARIANT[row.original.action] ?? 'default'}>{row.original.action}</Badge>,
    },
    {
      id: 'ip_address',
      header: 'IP Address',
      cell: ({ row }) => row.original.ip_address ?? '—',
    },
  ];
}
