'use client';

import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { MAX_LIST_LIMIT, type BranchComparisonReportRow, type BranchResponse } from '@potato-corner/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/shared/data-table/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { formatCurrency } from '@/lib/utils';
import { useBranchComparisonReport } from '@/hooks/queries/use-reports';
import { useBranches } from '@/hooks/queries/use-branches';

interface BranchPerformanceRow extends BranchComparisonReportRow {
  status: BranchResponse['status'] | null;
}

const columns: ColumnDef<BranchPerformanceRow>[] = [
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'gross_sales', header: 'Gross Sales', cell: ({ row }) => formatCurrency(row.original.gross_sales) },
  { accessorKey: 'transaction_count', header: 'Transactions' },
  { accessorKey: 'active_shift_count', header: 'Active Shifts' },
  {
    accessorKey: 'low_stock_ingredient_count',
    header: 'Low Stock',
    cell: ({ row }) => (row.original.low_stock_ingredient_count > 0 ? row.original.low_stock_ingredient_count : '—'),
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => (row.original.status ? <StatusBadge status={row.original.status} type="branch" /> : '—'),
  },
];

interface DashboardBranchPerformanceTableProps {
  /** The dashboard's branch selector value — undefined ("All Branches") shows every branch; a specific id narrows the same underlying report to just that branch, keeping this table consistent with every other card on the page (spec: branch selector must affect branch performance too). */
  branchId?: string;
}

/**
 * Admin-dashboard-only — reuses BRANCH_COMPARISON (the same precomputed
 * snapshot Reports would show for a branch-comparison export) joined against
 * the branch list purely for the active/inactive badge, which the report row
 * itself doesn't carry. Always fetched org-wide (BRANCH_COMPARISON has no
 * per-branch variant) and filtered client-side to `branchId` when narrowed.
 */
export function DashboardBranchPerformanceTable({ branchId }: DashboardBranchPerformanceTableProps) {
  const branchComparison = useBranchComparisonReport(undefined);
  const branchList = useBranches({ limit: MAX_LIST_LIMIT });

  const rows = useMemo(() => {
    const statusByBranchId = new Map(branchList.data?.branches.map((b) => [b.id, b.status]));
    return [...(branchComparison.data?.data ?? [])]
      .filter((row) => !branchId || row.branch_id === branchId)
      .sort((a, b) => b.gross_sales - a.gross_sales)
      .map((row) => ({ ...row, status: statusByBranchId.get(row.branch_id) ?? null }));
  }, [branchComparison.data, branchList.data, branchId]);

  const isLoading = branchComparison.isLoading || branchList.isLoading;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Branch Performance</CardTitle>
      </CardHeader>
      <CardContent>
        {branchComparison.isError ? (
          <ErrorState retry={() => void branchComparison.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            data={rows}
            isLoading={isLoading}
            emptyState={<EmptyState title="No branch activity yet" description="Branch performance will appear once sales come in." />}
          />
        )}
      </CardContent>
    </Card>
  );
}
