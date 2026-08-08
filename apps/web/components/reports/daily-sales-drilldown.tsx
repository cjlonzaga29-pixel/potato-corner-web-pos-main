'use client';

import { useMemo, useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { TransactionResponse, TransactionStatus, PaymentMethod } from '@potato-corner/shared';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { ReceiptModal } from '@/components/pos/receipt-modal';
import { ViewPaymentProofDialog } from '@/components/shared/transactions/view-payment-proof-dialog';
import { formatCurrency } from '@/lib/utils';
import { useTransaction, useTransactions } from '@/hooks/queries/use-transactions';

const ALL = 'all';

function humanizeSnake(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatTimeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
}

interface DailySalesDrilldownProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branchId: string | null;
  branchName: string;
  reportDate: string;
}

/**
 * Every transaction behind a single Daily Sales row (one branch, one business
 * date). Bounded to a single day/branch — fetched once at a generous page
 * size and filtered/paginated client-side, rather than adding new
 * receipt-number-search/cashier-filter query params to the backend contract.
 */
export function DailySalesDrilldown({ open, onOpenChange, branchId, branchName, reportDate }: DailySalesDrilldownProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>(ALL);
  const [paymentFilter, setPaymentFilter] = useState<string>(ALL);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
  const [receiptTransactionId, setReceiptTransactionId] = useState<string | null>(null);
  const [proofTransactionId, setProofTransactionId] = useState<string | null>(null);

  const { data: receiptTransaction } = useTransaction(receiptTransactionId);

  const { data, isLoading, isError, refetch } = useTransactions({
    branch_id: branchId ?? undefined,
    date_from: reportDate,
    date_to: reportDate,
    status: statusFilter === ALL ? undefined : (statusFilter as TransactionStatus),
    payment_method: paymentFilter === ALL ? undefined : (paymentFilter as PaymentMethod),
    page: 1,
    limit: 100,
  });

  const filtered = useMemo(() => {
    const allTransactions = data?.transactions ?? [];
    const term = search.trim().toLowerCase();
    if (!term) return allTransactions;
    return allTransactions.filter((t) => t.receipt_number.toLowerCase().includes(term));
  }, [data, search]);

  const columns: ColumnDef<TransactionResponse>[] = [
    { id: 'time', header: 'Time', cell: ({ row }) => formatTimeOnly(row.original.created_at) },
    { id: 'receipt_number', header: 'Receipt Number', accessorKey: 'receipt_number' },
    {
      id: 'payment_method',
      header: 'Payment Method',
      cell: ({ row }) => <Badge variant="outline">{humanizeSnake(row.original.payment_method)}</Badge>,
    },
    { id: 'subtotal', header: 'Subtotal', cell: ({ row }) => formatCurrency(row.original.subtotal) },
    { id: 'vat_amount', header: 'VAT', cell: ({ row }) => formatCurrency(row.original.vat_amount) },
    {
      id: 'discount_amount',
      header: 'Discount',
      cell: ({ row }) => (row.original.discount_amount > 0 ? formatCurrency(row.original.discount_amount) : '—'),
    },
    { id: 'total_amount', header: 'Total', cell: ({ row }) => formatCurrency(row.original.total_amount) },
    { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} type="transaction" /> },
    {
      id: 'payment_proof',
      header: 'Payment Proof',
      cell: ({ row }) => {
        const txn = row.original;
        if (txn.payment_method === 'cash') return <span className="text-muted-foreground text-xs">—</span>;
        if (!txn.has_payment_proof) return <span className="text-muted-foreground text-xs">No payment proof uploaded</span>;
        return (
          <Button type="button" variant="ghost" size="sm" onClick={() => setProofTransactionId(txn.id)}>
            View Proof
          </Button>
        );
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => (
        <Button type="button" variant="outline" size="sm" onClick={() => setReceiptTransactionId(row.original.id)}>
          View Receipt
        </Button>
      ),
    },
  ];

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle>
              Transactions — {branchName} — {reportDate}
            </SheetTitle>
          </SheetHeader>

          <div className="mt-4 flex flex-wrap items-end gap-4">
            <div>
              <label htmlFor="drilldown-search" className="text-sm font-medium">
                Receipt Number
              </label>
              <Input
                id="drilldown-search"
                placeholder="Search receipt #"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPagination((prev) => ({ ...prev, pageIndex: 0 }));
                }}
                className="w-[180px]"
              />
            </div>
            <div>
              <label htmlFor="drilldown-status" className="text-sm font-medium">
                Status
              </label>
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v);
                  setPagination((prev) => ({ ...prev, pageIndex: 0 }));
                }}
              >
                <SelectTrigger id="drilldown-status" className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All statuses</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="voided">Voided</SelectItem>
                  <SelectItem value="refunded">Refunded</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label htmlFor="drilldown-payment" className="text-sm font-medium">
                Payment
              </label>
              <Select
                value={paymentFilter}
                onValueChange={(v) => {
                  setPaymentFilter(v);
                  setPagination((prev) => ({ ...prev, pageIndex: 0 }));
                }}
              >
                <SelectTrigger id="drilldown-payment" className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All methods</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="gcash">GCash</SelectItem>
                  <SelectItem value="maya">Maya</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="mt-4">
            <DataTable
              stickyHeader
              columns={columns}
              data={filtered}
              isLoading={isLoading}
              isError={isError}
              onRetry={() => void refetch()}
              pagination={pagination}
              onPaginationChange={setPagination}
              emptyState={<EmptyState title="No transactions" description="No transactions match this filter for this date." />}
            />
          </div>
        </SheetContent>
      </Sheet>

      <ReceiptModal transaction={receiptTransaction ?? null} onClose={() => setReceiptTransactionId(null)} />
      <ViewPaymentProofDialog transactionId={proofTransactionId} onOpenChange={(o) => !o && setProofTransactionId(null)} />
    </>
  );
}
