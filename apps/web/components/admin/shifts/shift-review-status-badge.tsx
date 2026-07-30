import { Badge } from '@/components/ui/badge';

const VARIANT: Record<string, 'pending' | 'active' | 'critical'> = {
  pending: 'pending',
  approved: 'active',
  rejected: 'critical',
};

const LABEL: Record<string, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

export function ShiftReviewStatusBadge({ status }: { status: string }) {
  return <Badge variant={VARIANT[status] ?? 'default'}>{LABEL[status] ?? status}</Badge>;
}
