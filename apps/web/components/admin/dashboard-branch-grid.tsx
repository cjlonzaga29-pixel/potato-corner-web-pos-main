import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import type { BranchResponse } from '@potato-corner/shared';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/feedback/empty-state';

const SKELETON_COUNT = 6;

interface DashboardBranchGridProps {
  branches: BranchResponse[] | undefined;
  flaggedBranchIds: Set<string>;
  isLoading: boolean;
}

/** Row 2 of the super admin dashboard — every branch's health at a glance. Pure display, no data fetching. */
export function DashboardBranchGrid({ branches, flaggedBranchIds, isLoading }: DashboardBranchGridProps) {
  const router = useRouter();

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: SKELETON_COUNT }).map((_, index) => (
          <Card key={index}>
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-20" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!branches || branches.length === 0) {
    return <EmptyState title="No branches configured" />;
  }

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
      {branches.map((branch) => {
        const isFlagged = flaggedBranchIds.has(branch.id);
        return (
          <Card
            key={branch.id}
            onClick={() => router.push('/admin/branches')}
            className="cursor-pointer transition-colors hover:bg-accent/50"
          >
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <span className="truncate text-sm font-medium">{branch.name}</span>
              <StatusBadge status={branch.status} type="branch" />
            </CardHeader>
            <CardContent className="space-y-1">
              <p className="text-xs text-muted-foreground">{branch.code}</p>
              {isFlagged && (
                <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
                  <AlertTriangle className="h-3 w-3" />
                  Shift flagged
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
