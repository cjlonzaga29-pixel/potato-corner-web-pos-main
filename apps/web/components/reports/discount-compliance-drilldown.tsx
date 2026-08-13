'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { DiscountAuditTransactionRow } from '@potato-corner/shared';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/shared/data-table/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ViewDiscountProofDialog } from '@/components/shared/transactions/view-discount-proof-dialog';
import { formatCurrency } from '@/lib/utils';
import { useDiscountAuditTrail } from '@/hooks/queries/use-transactions';
import { useEmployees } from '@/hooks/queries/use-employees';

function humanizeSnake(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' });
}

interface DiscountComplianceDrilldownProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branchId: string | null;
  branchName: string;
  discountType: string | null;
  dateFrom: string;
  dateTo: string;
}

/**
 * Task 209.16 — every PWD/Senior Citizen (or other discount-type) transaction
 * behind one Discount Compliance summary row, reusing the existing
 * GET /api/transactions/discount-audit endpoint (transactionsService.
 * getDiscountAuditTrail) that already exists and is already role-gated to
 * super_admin/supervisor — this just wires it into the Admin Reports UI,
 * which previously had no per-transaction view of discount transactions at
 * all (only the branch/discount_type aggregate table). Same Sheet
 * drill-down pattern as DailySalesDrilldown.
 */
export function DiscountComplianceDrilldown({
  open,
  onOpenChange,
  branchId,
  branchName,
  discountType,
  dateFrom,
  dateTo,
}: DiscountComplianceDrilldownProps) {
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
  const [proofTransactionId, setProofTransactionId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useDiscountAuditTrail(
    { branchId: branchId ?? undefined, discountType: discountType ?? undefined, dateFrom, dateTo, page: 1, limit: 100 },
    open,
  );

  const employeesQuery = useEmployees({ branchId: branchId ?? undefined, limit: 100 }, { enabled: open && Boolean(branchId) });
  const employeeNames = new Map((employeesQuery.data?.employees ?? []).map((e) => [e.id, `${e.first_name} ${e.last_name}`]));

  const columns: ColumnDef<DiscountAuditTransactionRow>[] = [
    { id: 'receipt_number', header: 'Receipt #', cell: ({ row }) => row.original.transactionNumber },
    { id: 'created_at', header: 'Date/Time', cell: ({ row }) => formatDateTime(row.original.createdAt) },
    {
      id: 'cashier',
      header: 'Cashier',
      cell: ({ row }) => employeeNames.get(row.original.cashierId) ?? row.original.cashierId,
    },
    {
      id: 'discount_type',
      header: 'Discount Type',
      cell: ({ row }) => (row.original.discountType ? <Badge variant="secondary">{humanizeSnake(row.original.discountType)}</Badge> : '—'),
    },
    {
      id: 'discount_rate_used',
      header: 'Discount Rate Used',
      // Task 209.xx — the percentage actually applied to THIS transaction
      // (frozen at sale time), never today's Discount Settings value.
      cell: ({ row }) => (row.original.discountRateUsed != null ? `${row.original.discountRateUsed}%` : '—'),
    },
    {
      id: 'customer_id',
      header: 'Customer ID / Reference',
      cell: ({ row }) => row.original.discountCustomerId ?? '—',
    },
    { id: 'discount_amount', header: 'Discount Amount', cell: ({ row }) => formatCurrency(row.original.discountAmount) },
    {
      id: 'proof',
      header: 'Proof Available',
      cell: ({ row }) => {
        const txn = row.original;
        if (!txn.hasDiscountProof) return <span className="text-xs text-muted-foreground">No</span>;
        return (
          <Button type="button" variant="ghost" size="sm" onClick={() => setProofTransactionId(txn.id)}>
            Yes · View Proof
          </Button>
        );
      },
    },
  ];

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-4xl">
          <SheetHeader>
            <SheetTitle>
              Discount Transactions — {branchName} — {discountType ? humanizeSnake(discountType) : 'All types'}
            </SheetTitle>
          </SheetHeader>

          <div className="mt-4">
            <DataTable
              stickyHeader
              columns={columns}
              data={data?.data ?? []}
              isLoading={isLoading}
              isError={isError}
              onRetry={() => void refetch()}
              pagination={pagination}
              onPaginationChange={setPagination}
              emptyState={<EmptyState title="No discount transactions" description="No discount transactions match this filter." />}
            />
          </div>
        </SheetContent>
      </Sheet>

      <ViewDiscountProofDialog transactionId={proofTransactionId} onOpenChange={(o) => !o && setProofTransactionId(null)} />
    </>
  );
}
