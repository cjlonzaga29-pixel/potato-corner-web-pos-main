'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { Receipt } from 'lucide-react';
import type { InventoryStockMovementResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ViewPaymentProofDialog } from '@/components/shared/transactions/view-payment-proof-dialog';
import { formatDateTime } from '@/lib/utils';
import { useBranchStore } from '@/stores/branch.store';
import { useBranchInventoryStock, useInventoryStockMovements } from '@/hooks/queries/use-universal-inventory';

/** The only two movement types this view ever shows — see STOCK_MOVEMENT_CATEGORY_TYPES.order_deductions on the API side. */
type OrderDeductionMovementType = 'SALE' | 'SALE_REVERSAL';

const ORDER_DEDUCTION_TYPE_LABELS: Record<OrderDeductionMovementType, string> = {
  SALE: 'Sale',
  SALE_REVERSAL: 'Stock Returned',
};

/**
 * POS-PERF-P27 — "Order Deductions": the branch-facing view of only the
 * automatic, sale-linked inventory changes (SALE / SALE_REVERSAL). Manual
 * adjustments, receiving, waste, and transfers live in their own existing
 * workflows/pages and never appear here. Replaces the old branch "Stock
 * Movement" page, which showed the full, unfiltered ledger.
 *
 * Polls on a bounded interval (see useInventoryStockMovements) because
 * neither the async sale-deduction worker nor the void/refund reversal path
 * emits a socket event this view could otherwise react to — see that hook's
 * doc comment for why.
 */
export function OrderDeductionsView() {
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: stock } = useBranchInventoryStock(activeBranchId);
  const [inventoryItemId, setInventoryItemId] = useState('all');
  const [movementType, setMovementType] = useState<'all' | OrderDeductionMovementType>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [viewingProofForTransactionId, setViewingProofForTransactionId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useInventoryStockMovements(
    activeBranchId,
    {
      inventory_item_id: inventoryItemId === 'all' ? undefined : inventoryItemId,
      category: 'order_deductions',
      movement_type: movementType === 'all' ? undefined : movementType,
      from_date: fromDate || undefined,
      to_date: toDate || undefined,
      page: pagination.pageIndex + 1,
      limit: pagination.pageSize,
    },
    // Bounded, non-overlapping fallback poll — see useInventoryStockMovements's doc comment.
    { refetchInterval: 20 * 1000 },
  );

  const columns: ColumnDef<InventoryStockMovementResponse>[] = [
    { id: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
    { id: 'item', header: 'Item', cell: ({ row }) => row.original.inventory_item_name },
    {
      id: 'movement_type',
      header: 'Type',
      cell: ({ row }) => (
        <Badge variant={row.original.movement_type === 'SALE_REVERSAL' ? 'outline' : 'secondary'}>
          {ORDER_DEDUCTION_TYPE_LABELS[row.original.movement_type as OrderDeductionMovementType] ?? row.original.movement_type}
        </Badge>
      ),
    },
    {
      id: 'quantity_change',
      header: 'Deducted / Returned',
      cell: ({ row }) => (
        <span className={`tabular-nums ${row.original.quantity_change < 0 ? 'text-destructive' : 'text-success'}`}>
          {row.original.quantity_change > 0 ? '+' : ''}
          {row.original.quantity_change}
          {row.original.unit_code ? ` ${row.original.unit_code}` : ''}
        </span>
      ),
    },
    {
      id: 'quantity_after',
      header: 'Balance After',
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.quantity_after}
          {row.original.unit_code ? ` ${row.original.unit_code}` : ''}
        </span>
      ),
    },
    { id: 'performed_by', header: 'Recorded By', cell: ({ row }) => row.original.performed_by_name ?? '—' },
    { id: 'responsible', header: 'Responsible Staff', cell: ({ row }) => row.original.responsible_user_name ?? '—' },
    {
      id: 'order_reference',
      // One clear order reference per row: the sale's own receipt/
      // transaction number (never a bare, meaningless UUID — a SALE/
      // SALE_REVERSAL movement's reference_id is always the originating
      // Transaction's id, resolved server-side to receipt_number).
      header: 'Order Reference',
      cell: ({ row }) => row.original.receipt_number ?? '—',
    },
    {
      id: 'receipt',
      header: 'Receipt',
      cell: ({ row }) => {
        const movement = row.original;
        if (movement.reference_type !== 'transaction' || !movement.receipt_number) return '—';
        return (
          <a href={`/r/${movement.receipt_number}`} target="_blank" rel="noreferrer" className="text-primary underline">
            View Receipt
          </a>
        );
      },
    },
    {
      id: 'payment_proof',
      header: 'Proof of Payment',
      cell: ({ row }) => {
        const movement = row.original;
        if (movement.reference_type !== 'transaction' || !movement.reference_id) return '—';
        return (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto p-0 text-xs underline"
            onClick={() => setViewingProofForTransactionId(movement.reference_id)}
          >
            View Photo
          </Button>
        );
      },
    },
    { id: 'notes', header: 'Notes', cell: ({ row }) => row.original.notes ?? '—' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Order Deductions</h1>
        <p className="text-sm text-muted-foreground">
          Automatic inventory changes tied to completed sales — deductions and the stock returned by refunds/voids. Manual adjustments,
          receiving, waste, and transfers are tracked separately.
        </p>
      </div>

      {!activeBranchId ? (
        <p className="text-sm text-destructive">Select an active branch to view its order deductions.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={inventoryItemId}
              onValueChange={(value) => {
                setInventoryItemId(value);
                setPagination((prev) => ({ ...prev, pageIndex: 0 }));
              }}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="All items" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All items</SelectItem>
                {stock?.items.map((i) => (
                  <SelectItem key={i.inventory_item_id} value={i.inventory_item_id}>
                    {i.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={movementType}
              onValueChange={(value) => {
                setMovementType(value as 'all' | OrderDeductionMovementType);
                setPagination((prev) => ({ ...prev, pageIndex: 0 }));
              }}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="SALE">Sale</SelectItem>
                <SelectItem value="SALE_REVERSAL">Stock Returned</SelectItem>
              </SelectContent>
            </Select>

            <Input
              type="date"
              value={fromDate}
              onChange={(event) => {
                setFromDate(event.target.value);
                setPagination((prev) => ({ ...prev, pageIndex: 0 }));
              }}
              className="w-[160px]"
            />
            <Input
              type="date"
              value={toDate}
              onChange={(event) => {
                setToDate(event.target.value);
                setPagination((prev) => ({ ...prev, pageIndex: 0 }));
              }}
              className="w-[160px]"
            />
          </div>

          <DataTable
            columns={columns}
            data={data?.movements ?? []}
            isLoading={isLoading}
            isError={isError}
            onRetry={() => void refetch()}
            pagination={pagination}
            onPaginationChange={setPagination}
            rowCount={data?.total ?? 0}
            emptyState={
              <EmptyState icon={Receipt} title="No order deductions yet" description="Sale deductions and returns will appear here as they're recorded." />
            }
          />
        </>
      )}

      <ViewPaymentProofDialog
        transactionId={viewingProofForTransactionId}
        onOpenChange={(open) => !open && setViewingProofForTransactionId(null)}
      />
    </div>
  );
}
