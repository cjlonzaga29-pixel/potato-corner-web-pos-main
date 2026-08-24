'use client';

import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { MAX_LIST_LIMIT, type BranchComparisonReportRow, type BranchResponse } from '@potato-corner/shared';
import { BarChart3 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/shared/data-table/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { cn, formatCurrency } from '@/lib/utils';

import { useBranchComparisonReport } from '@/hooks/queries/use-reports';
import { useBranches } from '@/hooks/queries/use-branches';

interface BranchPerformanceRow extends BranchComparisonReportRow {
  status: BranchResponse['status'] | null;
}

/** Right-aligned header + cell pair for numeric columns — money and counts read left-to-right down the column instead of ragging against variable-width branch names. */
function numericHeader(label: string) {
  return <div className="text-right">{label}</div>;
}

const columns: ColumnDef<BranchPerformanceRow>[] = [
  {
    accessorKey: 'branch_name',
    header: 'Branch',
    cell: ({ row }) => <span className="font-medium">{row.original.branch_name}</span>,
  },
  {
    accessorKey: 'gross_sales',
    header: () => numericHeader('Gross Sales'),
    cell: ({ row }) => <div className="text-right tabular-nums">{formatCurrency(row.original.gross_sales)}</div>,
  },
  {
    accessorKey: 'transaction_count',
    header: () => numericHeader('Transactions'),
    cell: ({ row }) => <div className="text-right tabular-nums">{row.original.transaction_count}</div>,
  },
  {
    accessorKey: 'active_shift_count',
    header: () => numericHeader('Active Shifts'),
    cell: ({ row }) => <div className="text-right tabular-nums">{row.original.active_shift_count}</div>,
  },
  {
    accessorKey: 'low_stock_ingredient_count',
    header: () => numericHeader('Low Stock'),
    cell: ({ row }) => (
      <div className={cn('text-right tabular-nums', row.original.low_stock_ingredient_count > 0 && 'text-warning font-medium')}>
        {row.original.low_stock_ingredient_count > 0 ? row.original.low_stock_ingredient_count : '—'}
      </div>
    ),
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
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <BarChart3 className="h-4 w-4" />
        </div>
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
