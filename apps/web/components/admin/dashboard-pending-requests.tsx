import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import type { ProductRequestResponse } from '@potato-corner/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatTimeAgo } from '@/lib/utils';

const SKELETON_ROWS = 3;

interface DashboardPendingRequestsProps {
  requests: ProductRequestResponse[] | undefined;
  isLoading: boolean;
}

/** Row 3 (left) of the super admin dashboard — up to 5 pending product requests. Pure display, no data fetching. */
export function DashboardPendingRequests({ requests, isLoading }: DashboardPendingRequestsProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">Pending Product Requests</CardTitle>
        <Link href="/admin/approvals/product-requests" className="text-xs text-primary hover:underline">
          View all
        </Link>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: SKELETON_ROWS }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : !requests || requests.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="No pending product requests" />
        ) : (
          <div className="space-y-2">
            {requests.map((request) => (
              <div key={request.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{request.proposed_name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {request.branch_name} — {request.requested_by_name}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{formatTimeAgo(request.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
