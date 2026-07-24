'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import type { CashReconciliationReportRow } from '@potato-corner/shared';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/shared/status-badge';
import { ReportLastUpdated } from '@/components/reports/report-last-updated';
import { formatCurrency } from '@/lib/utils';
import { useBranchStore } from '@/stores/branch.store';
import { useCashReconciliationReport } from '@/hooks/queries/use-reports';

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoDateString(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const DEFAULT_RANGE_DAYS = 30;

const columns: ColumnDef<CashReconciliationReportRow>[] = [
  { accessorKey: 'cashier_name', header: 'Cashier' },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.original.status} type="shift" />,
  },
  { accessorKey: 'opening_counted_total', header: 'Opening', cell: ({ row }) => formatCurrency(row.original.opening_counted_total) },
  {
    accessorKey: 'closing_counted_total',
    header: 'Closing',
    cell: ({ row }) => (row.original.closing_counted_total !== null ? formatCurrency(row.original.closing_counted_total) : '—'),
  },
  {
    accessorKey: 'cash_variance',
    header: 'Variance',
    cell: ({ row }) => (row.original.cash_variance !== null ? formatCurrency(row.original.cash_variance) : '—'),
  },
  {
    accessorKey: 'variance_approved',
    header: 'Approved',
    cell: ({ row }) => (row.original.variance_approved === null ? '—' : row.original.variance_approved ? 'Yes' : 'No'),
  },
];

/**
 * Branch-scoped view of GET /api/reports/cash-reconciliation — every closed
 * or flagged shift in range, with its opening/closing counts and any
 * unresolved cash variance. Row click drills into the same shift detail
 * (ShiftDetailView) `/cash` already links to.
 */
export function CashReconciliationView({ basePath }: { basePath: string }) {
  const router = useRouter();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const [dateFrom, setDateFrom] = useState(() => daysAgoDateString(DEFAULT_RANGE_DAYS));
  const [dateTo, setDateTo] = useState(() => todayDateString());

  const { data, isLoading, isError, refetch } = useCashReconciliationReport(
    { branch_id: activeBranchId ?? undefined, date_from: dateFrom, date_to: dateTo, page: 1, limit: 100 },
    Boolean(activeBranchId),
  );

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch to view its cash reconciliation.</p>;
  }

  const rows = data?.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Cash Reconciliation</h1>
        <p className="text-sm text-muted-foreground">Closed and flagged shifts for this branch, with opening/closing counts and variance.</p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor="cash-reconciliation-from">From</Label>
          <Input id="cash-reconciliation-from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="cash-reconciliation-to">To</Label>
          <Input id="cash-reconciliation-to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
      </div>

      {isError ? (
        <ErrorState retry={() => void refetch()} />
      ) : (
        <>
          <ReportLastUpdated timestamp={data?.generated_at} isLoading={isLoading} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <KpiCard title="Closed/Flagged Shifts" value={rows.length} isLoading={isLoading} />
            <KpiCard title="Flagged" value={rows.filter((r) => r.status === 'flagged').length} isLoading={isLoading} tone="danger" />
            <KpiCard
              title="Unapproved Variance"
              value={rows.filter((r) => r.cash_variance !== null && r.cash_variance !== 0 && !r.variance_approved).length}
              isLoading={isLoading}
              tone="warning"
            />
          </div>
          <DataTable
            columns={columns}
            data={rows}
            isLoading={isLoading}
            onRowClick={(row) => router.push(`${basePath}/cash/${row.shift_id}`)}
            emptyState={<EmptyState title="No closed or flagged shifts in this range" />}
          />
        </>
      )}
    </div>
  );
}
