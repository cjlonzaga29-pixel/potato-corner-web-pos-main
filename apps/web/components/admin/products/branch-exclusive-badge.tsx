import { Badge } from '@/components/ui/badge';

interface BranchExclusiveBadgeProps {
  branchExclusive: boolean;
  exclusiveBranchName: string | null;
}

export function BranchExclusiveBadge({ branchExclusive, exclusiveBranchName }: BranchExclusiveBadgeProps) {
  if (!branchExclusive) return <Badge variant="secondary">All Branches</Badge>;
  return <Badge variant="warning">Exclusive: {exclusiveBranchName ?? 'Unknown branch'}</Badge>;
}
