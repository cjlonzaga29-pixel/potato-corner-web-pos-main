import { Building2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

interface DashboardActiveBranchesCardProps {
  activeCount: number | undefined;
  inactiveCount: number | undefined;
  /** POS-PERF-P40 — closed branches were previously counted as "Inactive". */
  closedCount?: number | undefined;
  isLoading: boolean;
}

function Figure({ value, label, dotClassName, valueClassName }: { value: number; label: string; dotClassName: string; valueClassName: string }) {
  return (
    <div className="flex-1">
      <div className="flex items-center gap-1.5">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClassName)} aria-hidden="true" />
        <span className={cn('text-2xl font-bold tabular-nums', valueClassName)}>{value}</span>
      </div>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

/**
 * Super admin dashboard — administrative branch status (set by Admin), not
 * connectivity: whether a branch is online is shown separately in Branch
 * Performance. Status dots (not color alone) sit beside each labeled figure.
 */
export function DashboardActiveBranchesCard({ activeCount, inactiveCount, closedCount, isLoading }: DashboardActiveBranchesCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Building2 className="h-4 w-4" />
        </div>
        <CardTitle className="text-sm font-medium">Branch Status</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-full" />
        ) : (
          <div className="flex items-center">
            <Figure value={activeCount ?? 0} label="Active" dotClassName="bg-success" valueClassName="text-success" />
            <Separator orientation="vertical" className="mx-4 h-9 bg-border/60" />
            <Figure value={inactiveCount ?? 0} label="Inactive" dotClassName="bg-muted-foreground/50" valueClassName="text-muted-foreground" />
            {closedCount !== undefined && (
              <>
                <Separator orientation="vertical" className="mx-4 h-9 bg-border/60" />
                <Figure value={closedCount} label="Closed" dotClassName="bg-destructive/60" valueClassName="text-muted-foreground" />
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
