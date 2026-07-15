import { Badge } from '@/components/ui/badge';

/**
 * Local status->color map, not the shared STATUS_MAPS.shift entry in
 * status-badge.tsx (which uses green/gray/red for active/closed/flagged) —
 * this phase's brief explicitly specifies OPEN=blue, CLOSED=green,
 * PENDING_REVIEW=amber for the shift review UI specifically, so it's defined
 * locally here rather than changing the shared map's colors for every other
 * consumer (same pattern as the price-overrides approval page's own local
 * STATUS_BADGE_VARIANT).
 */
const VARIANT: Record<string, 'pending' | 'active' | 'warning'> = {
  active: 'pending', // blue
  closed: 'active', // green
  flagged: 'warning', // amber
};

const LABEL: Record<string, string> = {
  active: 'Open',
  closed: 'Closed',
  flagged: 'Pending Review',
};

export function ShiftStatusBadge({ status }: { status: string }) {
  return <Badge variant={VARIANT[status] ?? 'default'}>{LABEL[status] ?? status}</Badge>;
}
