'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { useAdminInventoryRollup, useAdminInventoryRollupRealtimeSync } from '@/hooks/queries/use-admin-inventory-rollup';

const TOP_BRANCH_COUNT = 5;

interface DashboardLowStockSummaryProps {
  /** The dashboard's branch selector value — undefined ("All Branches") ranks every branch; a specific id narrows to just that branch, keeping this panel consistent with the selector everywhere else on the page. */
  branchId?: string;
}

/**
 * Admin-dashboard-only preview — reuses the same ADMIN_INVENTORY_VALUATION_ROLLUP
 * rollup that /admin/inventory's valuation view reads, filtered to the branches
 * with the most low/critical/out-of-stock items. Full detail lives at
 * /admin/inventory (the "View Inventory" link below), not duplicated here.
 */
export function DashboardLowStockSummary({ branchId }: DashboardLowStockSummaryProps) {
  useAdminInventoryRollupRealtimeSync();
  const rollup = useAdminInventoryRollup();

  const affectedBranches = useMemo(
    () =>
      [...(rollup.data?.branches ?? [])]
        .filter((b) => !branchId || b.branch_id === branchId)
        .filter((b) => b.low_stock_count > 0 || b.critical_stock_count > 0 || b.out_of_stock_count > 0)
        .sort((a, b) => b.low_stock_count + b.critical_stock_count - (a.low_stock_count + a.critical_stock_count))
        .slice(0, TOP_BRANCH_COUNT),
    [rollup.data, branchId],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium">Low Stock Summary</CardTitle>
        <Button variant="link" size="sm" className="h-auto p-0" asChild>
          <Link href="/admin/inventory">View Inventory</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {rollup.isError ? (
          <ErrorState retry={() => void rollup.refetch()} />
        ) : rollup.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : affectedBranches.length === 0 ? (
          <EmptyState title="No low stock items" description="Every branch is within its stock thresholds." />
        ) : (
          <ul className="divide-y">
            {affectedBranches.map((branch) => (
              <li key={branch.branch_id} className="flex items-center justify-between py-2 text-sm">
                <span className="font-medium">{branch.branch_name}</span>
                <span className="text-muted-foreground">
                  {branch.low_stock_count} low
                  {branch.critical_stock_count > 0 && `, ${branch.critical_stock_count} critical`}
                  {branch.out_of_stock_count > 0 && `, ${branch.out_of_stock_count} out of stock`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
