import { Badge, type badgeVariants } from '@/components/ui/badge';
import type { VariantProps } from 'class-variance-authority';

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;
type StatusType = 'product' | 'employee' | 'shift' | 'inventory' | 'fraud' | 'attendance' | 'gps' | 'branch' | 'transaction' | 'general';

const STATUS_MAPS: Record<StatusType, Record<string, BadgeVariant>> = {
  product: {
    draft: 'inactive',
    active: 'active',
    temporarily_unavailable: 'warning',
    discontinued: 'critical',
    archived: 'inactive',
  },
  employee: {
    active: 'active',
    inactive: 'inactive',
    suspended: 'warning',
    resigned: 'inactive',
    terminated: 'critical',
  },
  shift: {
    active: 'active',
    closed: 'inactive',
    flagged: 'critical',
  },
  inventory: {
    ok: 'active',
    low: 'warning',
    critical: 'critical',
    out_of_stock: 'critical',
  },
  fraud: {
    open: 'critical',
    investigating: 'warning',
    dismissed: 'inactive',
    escalated: 'critical',
  },
  attendance: {
    present: 'active',
    corrected: 'warning',
  },
  gps: {
    within_radius: 'active',
    outside_radius: 'critical',
    no_gps_data: 'inactive',
  },
  branch: {
    active: 'active',
    inactive: 'inactive',
    closed: 'critical',
  },
  transaction: {
    completed: 'active',
    voided: 'critical',
    refunded: 'pending',
  },
  general: {
    active: 'active',
    enabled: 'active',
    online: 'active',
    inactive: 'inactive',
    disabled: 'inactive',
    offline: 'offline',
    pending: 'pending',
    warning: 'warning',
    critical: 'critical',
    error: 'critical',
  },
};

function humanize(status: string): string {
  return status
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

interface StatusBadgeProps {
  status: string;
  type?: StatusType;
}

/** Maps a status string to the correct Badge variant based on domain (product, employee, shift, inventory, fraud). */
export function StatusBadge({ status, type = 'general' }: StatusBadgeProps) {
  const variant = STATUS_MAPS[type][status.toLowerCase()] ?? 'default';
  return <Badge variant={variant}>{humanize(status)}</Badge>;
}
