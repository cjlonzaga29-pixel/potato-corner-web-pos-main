'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import { useDashboardRecentTransactions } from '@/hooks/queries/use-transactions';
import { useBranches } from '@/hooks/queries/use-branches';
import { MAX_LIST_LIMIT } from '@potato-corner/shared';

const RECENT_ACTIVITY_LIMIT = 5;

/**
 * Admin-dashboard-only — capped preview of the most recent transactions
 * across every branch. Reuses GET /api/transactions (same endpoint the
 * branch/supervisor dashboards' DashboardTransactionsFeed reads) rather than
 * a new "activity feed" endpoint; "View All" hands off to Reports, the
 * single place full transaction/report detail lives per this sprint.
 */
export function DashboardRecentActivity({ branchId }: { branchId: string | undefined }) {
  const transactions = useDashboardRecentTransactions({ branch_id: branchId, limit: RECENT_ACTIVITY_LIMIT });
  // Same query key as the branch selector / branch-performance table elsewhere on this
  // dashboard — React Query dedupes, so this never issues a second network request.
  const branchList = useBranches({ limit: MAX_LIST_LIMIT });

  const branchNameById = useMemo(
    () => new Map(branchList.data?.branches.map((b) => [b.id, b.name])),
    [branchList.data],
  );

  const rows = transactions.data?.transactions.slice(0, RECENT_ACTIVITY_LIMIT) ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium">Recent Activity</CardTitle>
        <Button variant="link" size="sm" className="h-auto p-0" asChild>
          <Link href="/admin/reports">View All</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {transactions.isError ? (
          <ErrorState retry={() => void transactions.refetch()} />
        ) : transactions.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : rows.length === 0 ? (
          <EmptyState title="No recent activity" description="New sales will show up here as they happen." />
        ) : (
          <ul className="divide-y">
            {rows.map((txn) => (
              <li key={txn.id} className="flex items-center justify-between py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{txn.receipt_number}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {branchNameById.get(txn.branch_id) ?? 'Unknown branch'} · {formatDateTime(txn.created_at)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-medium">{formatCurrency(txn.total_amount)}</span>
                  <StatusBadge status={txn.status} type="transaction" />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
