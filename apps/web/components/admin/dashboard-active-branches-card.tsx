import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface DashboardActiveBranchesCardProps {
  activeCount: number | undefined;
  inactiveCount: number | undefined;
  isLoading: boolean;
}

/** Super admin dashboard — count of active vs. inactive branches org-wide. */
export function DashboardActiveBranchesCard({ activeCount, inactiveCount, isLoading }: DashboardActiveBranchesCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Active Branches</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-full" />
        ) : (
          <div className="flex items-center gap-6">
            <div>
              <div className="text-2xl font-bold text-success">{activeCount ?? 0}</div>
              <p className="text-xs text-muted-foreground">Active</p>
            </div>
            <div>
              <div className="text-2xl font-bold text-muted-foreground">{inactiveCount ?? 0}</div>
              <p className="text-xs text-muted-foreground">Inactive</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
