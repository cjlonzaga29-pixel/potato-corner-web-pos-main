'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { Receipt as ReceiptIcon } from 'lucide-react';
import type { TransactionResponse } from '@potato-corner/shared';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { ReceiptModal } from '@/components/pos/receipt-modal';
import { useAuth } from '@/hooks/use-auth';
import { useTransaction, useTransactions, useTransactionsRealtimeSync } from '@/hooks/queries/use-transactions';
import { formatDateTime } from '@/lib/utils';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

/** Branch/staff-facing receipt lookup/reprint — the (branch) nav's "Receipts" item. Scoped to the cashier's own branch, most recent first. */
export default function ReceiptsPage() {
  const { user } = useAuth();
  const branchId = user?.branchIds[0];
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useTransactionsRealtimeSync();
  const { data, isLoading, isError, refetch } = useTransactions({
    branch_id: branchId,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });
  const { data: selectedTransaction } = useTransaction(selectedId);

  const columns: ColumnDef<TransactionResponse>[] = [
    { id: 'receipt_number', header: 'Receipt No.', cell: ({ row }) => row.original.receipt_number },
    { id: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
    { id: 'payment_method', header: 'Payment', cell: ({ row }) => (row.original.payment_method === 'cash' ? 'Cash' : 'GCash') },
    { id: 'total_amount', header: 'Total', cell: ({ row }) => formatPeso(row.original.total_amount) },
    { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} type="transaction" /> },
  ];

  if (!branchId) {
    return <p className="p-6 text-sm text-destructive">No branch assigned.</p>;
  }

  return (
    <div className="space-y-6 overflow-y-auto p-6">
      <div>
        <h1 className="text-2xl font-bold">Receipts</h1>
        <p className="text-sm text-muted-foreground">Look up a past sale from this branch and reprint its receipt.</p>
      </div>

      <DataTable
        columns={columns}
        data={data?.transactions ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        onRowClick={(row) => setSelectedId(row.id)}
        emptyState={<EmptyState icon={ReceiptIcon} title="No receipts yet" description="Completed sales at this branch will appear here." />}
      />

      <ReceiptModal transaction={selectedTransaction ?? null} onClose={() => setSelectedId(null)} />
    </div>
  );
}
