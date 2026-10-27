'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { FileDown, Loader2 } from 'lucide-react';
import type { TransactionResponse, TransactionStatus, PaymentMethod } from '@potato-corner/shared';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { ReceiptModal } from '@/components/pos/receipt-modal';
import { ViewPaymentProofDialog } from '@/components/shared/transactions/view-payment-proof-dialog';
import { ViewDiscountProofDialog } from '@/components/shared/transactions/view-discount-proof-dialog';
import { formatCurrency } from '@/lib/utils';
import { downloadTransactionsPdf } from '@/lib/transaction-export-client';
import { useDiscountAuditTrail, useTransaction, useTransactions } from '@/hooks/queries/use-transactions';

const ALL = 'all';
const SEARCH_DEBOUNCE_MS = 300;

function humanizeSnake(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatTimeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
}

function money(value: number) {
  return <div className="whitespace-nowrap text-right tabular-nums">{formatCurrency(value)}</div>;
}

function moneyHeader(label: string) {
  return <div className="text-right">{label}</div>;
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
 * date). POS-PERF-P40 — paginated and searched on the server (the panel used
 * to load at most 100 rows and could not page past them), widened on
 * desktop, and able to download a PDF of either every matching transaction
 * or a single one.
 */
export function DailySalesDrilldown({ open, onOpenChange, branchId, branchName, reportDate }: DailySalesDrilldownProps) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>(ALL);
  const [paymentFilter, setPaymentFilter] = useState<string>(ALL);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [receiptTransactionId, setReceiptTransactionId] = useState<string | null>(null);
  const [proofTransactionId, setProofTransactionId] = useState<string | null>(null);
  const [discountProofTransactionId, setDiscountProofTransactionId] = useState<string | null>(null);
  const [pdfState, setPdfState] = useState<{ status: 'idle' | 'working' | 'error' | 'done'; target?: string; message?: string }>({ status: 'idle' });

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search]);

  const { data: receiptTransaction } = useTransaction(receiptTransactionId);

  const filters = {
    branch_id: branchId ?? undefined,
    date_from: reportDate,
    date_to: reportDate,
    status: statusFilter === ALL ? undefined : (statusFilter as TransactionStatus),
    payment_method: paymentFilter === ALL ? undefined : (paymentFilter as PaymentMethod),
    receipt_search: debouncedSearch || undefined,
  };
  const { data, isLoading, isError, refetch } = useTransactions({ ...filters, page: pagination.pageIndex + 1, limit: pagination.pageSize });
  const total = data?.total ?? 0;

  // Customer ID / Reference for PWD/Senior rows — same authorized
  // discount-audit trail endpoint the Discount Compliance drilldown already
  // calls (server-enforced to super_admin/supervisor, null for every other
  // role), scoped to this sheet's single branch+day rather than a new query.
  const discountAuditQuery = useDiscountAuditTrail({ branchId: branchId ?? undefined, dateFrom: reportDate, dateTo: reportDate, page: 1, limit: 100 }, open);
  const discountCustomerIdByTransaction = useMemo(
    () => new Map((discountAuditQuery.data?.data ?? []).map((row) => [row.id, row.discountCustomerId])),
    [discountAuditQuery.data],
  );

  async function handlePdf(target: 'all' | string) {
    setPdfState({ status: 'working', target });
    try {
      const filename = await downloadTransactionsPdf(target === 'all' ? filters : { transaction_id: target });
      setPdfState({ status: 'done', target, message: `Downloaded ${filename}` });
    } catch (error) {
      setPdfState({ status: 'error', target, message: error instanceof Error ? error.message : 'The PDF could not be generated.' });
    }
  }

  const columns: ColumnDef<TransactionResponse>[] = [
    { id: 'time', header: 'Time', cell: ({ row }) => <span className="whitespace-nowrap">{formatTimeOnly(row.original.created_at)}</span> },
    {
      id: 'receipt_number',
      header: 'Receipt Number',
      cell: ({ row }) => <span className="whitespace-nowrap font-mono text-xs">{row.original.receipt_number}</span>,
    },
    {
      id: 'cashier',
      header: 'Cashier',
      cell: ({ row }) => <span className="whitespace-nowrap">{row.original.cashier_name ?? row.original.cashier_id}</span>,
    },
    {
      id: 'payment_method',
      header: 'Payment Method',
      cell: ({ row }) => <Badge variant="outline">{humanizeSnake(row.original.payment_method)}</Badge>,
    },
    { id: 'subtotal', header: () => moneyHeader('Subtotal'), cell: ({ row }) => money(row.original.subtotal) },
    { id: 'vat_amount', header: () => moneyHeader('VAT'), cell: ({ row }) => money(row.original.vat_amount) },
    {
      id: 'discount_amount',
      header: () => moneyHeader('Discount'),
      cell: ({ row }) => (row.original.discount_amount > 0 ? money(row.original.discount_amount) : <div className="text-right">—</div>),
    },
    {
      id: 'discount_type',
      header: 'Discount Type',
      cell: ({ row }) => <span className="whitespace-nowrap">{row.original.discount_type ? humanizeSnake(row.original.discount_type) : '—'}</span>,
    },
    {
      id: 'customer_id',
      header: 'Customer ID / Reference',
      cell: ({ row }) => discountCustomerIdByTransaction.get(row.original.id) ?? '—',
    },
    { id: 'total_amount', header: () => moneyHeader('Total'), cell: ({ row }) => <div className="font-medium">{money(row.original.total_amount)}</div> },
    { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} type="transaction" /> },
    {
      id: 'payment_proof',
      header: 'Payment Proof',
      cell: ({ row }) => {
        const txn = row.original;
        if (txn.payment_method === 'cash') return <span className="text-muted-foreground text-xs">—</span>;
        if (!txn.has_payment_proof) return <span className="whitespace-nowrap text-muted-foreground text-xs">Not uploaded</span>;
        return (
          <Button type="button" variant="ghost" size="sm" onClick={() => setProofTransactionId(txn.id)}>
            View Proof
          </Button>
        );
      },
    },
    {
      id: 'discount_proof',
      header: 'Discount Proof',
      cell: ({ row }) => {
        const txn = row.original;
        if (!txn.has_discount_proof) return <span className="text-muted-foreground text-xs">—</span>;
        return (
          <Button type="button" variant="ghost" size="sm" onClick={() => setDiscountProofTransactionId(txn.id)}>
            View Proof
          </Button>
        );
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => {
        const isWorking = pdfState.status === 'working' && pdfState.target === row.original.id;
        return (
          <div className="flex items-center gap-1">
            <Button type="button" variant="outline" size="sm" onClick={() => setReceiptTransactionId(row.original.id)}>
              View Receipt
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Download PDF of ${row.original.receipt_number}`}
              disabled={pdfState.status === 'working'}
              onClick={() => void handlePdf(row.original.id)}
            >
              {isWorking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FileDown className="h-4 w-4" aria-hidden="true" />}
            </Button>
          </div>
        );
      },
    },
  ];

  function resetPage() {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-[min(96vw,92rem)]">
          <SheetHeader>
            <SheetTitle>
              Transactions — {branchName} — {reportDate}
            </SheetTitle>
            <SheetDescription>
              {isLoading ? 'Loading…' : `${total} transaction${total === 1 ? '' : 's'} match the filters below.`}
            </SheetDescription>
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
                  resetPage();
                }}
                className="w-[200px]"
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
                  resetPage();
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
                  resetPage();
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
            <div className="ml-auto flex flex-col items-end gap-1">
              <Button type="button" variant="outline" disabled={pdfState.status === 'working' || total === 0} onClick={() => void handlePdf('all')}>
                {pdfState.status === 'working' && pdfState.target === 'all' ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <FileDown className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                Download PDF ({total} matching)
              </Button>
              <span className="text-xs text-muted-foreground">All pages for these filters, not just this page.</span>
            </div>
          </div>

          <p className="mt-2 min-h-[1rem] text-xs" role="status" aria-live="polite">
            {pdfState.status === 'error' ? <span className="text-destructive">{pdfState.message}</span> : pdfState.status === 'done' ? pdfState.message : ''}
          </p>

          <div className="mt-2">
            <DataTable
              stickyHeader
              columns={columns}
              data={data?.transactions ?? []}
              isLoading={isLoading}
              isError={isError}
              onRetry={() => void refetch()}
              pagination={pagination}
              onPaginationChange={setPagination}
              rowCount={total}
              emptyState={<EmptyState title="No transactions" description="No transactions match this filter for this date." />}
            />
          </div>
        </SheetContent>
      </Sheet>

      <ReceiptModal transaction={receiptTransaction ?? null} onClose={() => setReceiptTransactionId(null)} />
      <ViewPaymentProofDialog transactionId={proofTransactionId} onOpenChange={(o) => !o && setProofTransactionId(null)} />
      <ViewDiscountProofDialog transactionId={discountProofTransactionId} onOpenChange={(o) => !o && setDiscountProofTransactionId(null)} />
    </>
  );
}
