'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { TransactionResponse, TransactionStatus } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { StatusBadge } from '@/components/shared/status-badge';
import { ReceiptModal } from '@/components/pos/receipt-modal';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useTransaction, useTransactions, useTransactionsRealtimeSync } from '@/hooks/queries/use-transactions';

const ALL_STATUSES = 'all';

function humanizeSnake(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** The branch role's own sales ledger — every transaction recorded at its branch, across all shifts and cashiers. */
export default function BranchSalesPage() {
  useTransactionsRealtimeSync();
  const { user } = useAuth();
  const branchId = user?.branchIds[0];
  const [status, setStatus] = useState<string>(ALL_STATUSES);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: selectedTransaction } = useTransaction(selectedId);

  const { data, isLoading, isError, refetch } = useTransactions({
    branch_id: branchId,
    status: status === ALL_STATUSES ? undefined : (status as TransactionStatus),
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const transactions = data?.transactions ?? [];
  const grossSales = transactions.reduce((sum, t) => sum + t.total_amount, 0);
  const completedCount = transactions.filter((t) => t.status === 'completed').length;

  const columns: ColumnDef<TransactionResponse>[] = [
    { id: 'receipt_number', header: 'Receipt #', accessorKey: 'receipt_number' },
    {
      id: 'payment_method',
      header: 'Payment',
      cell: ({ row }) => <Badge variant="outline">{humanizeSnake(row.original.payment_method)}</Badge>,
    },
    { id: 'total_amount', header: 'Total', cell: ({ row }) => formatCurrency(row.original.total_amount) },
    {
      id: 'discount_type',
      header: 'Discount',
      cell: ({ row }) => (row.original.discount_type ? humanizeSnake(row.original.discount_type) : '—'),
    },
    { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} type="transaction" /> },
    { id: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
  ];

  if (!branchId) {
    return <EmptyState title="No branch assigned" description="Contact your supervisor to get staffed to a branch." />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Sales</h1>
        <p className="text-sm text-muted-foreground">Every transaction recorded at your branch.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard title="Transactions (this page)" value={transactions.length} isLoading={isLoading} />
        <KpiCard title="Completed (this page)" value={completedCount} isLoading={isLoading} />
        <KpiCard title="Gross (this page)" value={grossSales} prefix="₱" isLoading={isLoading} />
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor="sales-status-filter">Status</Label>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value);
              setPagination((prev) => ({ ...prev, pageIndex: 0 }));
            }}
          >
            <SelectTrigger id="sales-status-filter" className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUSES}>All statuses</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="voided">Voided</SelectItem>
              <SelectItem value="refunded">Refunded</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="sales-from">From</Label>
          <Input
            id="sales-from"
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPagination((prev) => ({ ...prev, pageIndex: 0 }));
            }}
          />
        </div>
        <div>
          <Label htmlFor="sales-to">To</Label>
          <Input
            id="sales-to"
            type="date"
            value={dateTo}
            onChange={(e) => {
              setDateTo(e.target.value);
              setPagination((prev) => ({ ...prev, pageIndex: 0 }));
            }}
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        data={transactions}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        onRowClick={(row) => setSelectedId(row.id)}
        emptyState={<EmptyState title="No sales" description="No transactions match this filter." />}
      />

      <ReceiptModal transaction={selectedTransaction ?? null} onClose={() => setSelectedId(null)} />
    </div>
  );
}
