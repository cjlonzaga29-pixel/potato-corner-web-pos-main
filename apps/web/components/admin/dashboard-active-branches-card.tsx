import { Building2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';

interface DashboardActiveBranchesCardProps {
  activeCount: number | undefined;
  inactiveCount: number | undefined;
  isLoading: boolean;
}

/**
 * Super admin dashboard — operational status treatment for org-wide branch
 * status: status dots (not color alone) beside each figure so Active vs.
 * Inactive reads as network health, not a plain two-number tally.
 */
export function DashboardActiveBranchesCard({ activeCount, inactiveCount, isLoading }: DashboardActiveBranchesCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Building2 className="h-4 w-4" />
        </div>
        <CardTitle className="text-sm font-medium">Active Branches</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-full" />
        ) : (
          <div className="flex items-center">
            <div className="flex-1">
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
                <span className="text-2xl font-bold tabular-nums text-success">{activeCount ?? 0}</span>
              </div>
              <p className="text-xs text-muted-foreground">Active</p>
            </div>
            <Separator orientation="vertical" className="mx-4 h-9 bg-border/60" />
            <div className="flex-1">
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden="true" />
                <span className="text-2xl font-bold tabular-nums text-muted-foreground">{inactiveCount ?? 0}</span>
              </div>
              <p className="text-xs text-muted-foreground">Inactive</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
