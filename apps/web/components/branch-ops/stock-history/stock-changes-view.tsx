'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { Loader2, PackageSearch } from 'lucide-react';
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
import { useBranchInventoryStock, useInventoryStockMovements, type InventoryStockMovementCategory } from '@/hooks/queries/use-universal-inventory';

type ChangesFilter = 'all' | InventoryStockMovementCategory;

const FILTER_LABELS: Record<ChangesFilter, string> = {
  all: 'All',
  stock_in: 'Stock In',
  adjustments: 'Adjustments',
  waste: 'Waste',
  transfers: 'Transfers',
  order_deductions: 'Orders',
};

const MOVEMENT_TYPE_LABELS: Record<InventoryStockMovementResponse['movement_type'], string> = {
  RECEIVING: 'Stock In',
  ADJUSTMENT_IN: 'Adjustment (In)',
  ADJUSTMENT_OUT: 'Adjustment (Out)',
  WASTE: 'Waste',
  TRANSFER_IN: 'Transfer (In)',
  TRANSFER_OUT: 'Transfer (Out)',
  PHYSICAL_COUNT: 'Physical Count',
  SALE: 'Sale',
  SALE_REVERSAL: 'Reversal',
};

/**
 * POS-PERF-P31 — "Stock Changes" tab of the Stock History page: every
 * actually-applied InventoryStockMovement, reusing the exact same ledger
 * endpoint/response the Order Deductions and Stock Adjustments history
 * views already use (useInventoryStockMovements) — no new accounting data,
 * just a broader filter over it. Order Deductions itself (order-deductions-view.tsx)
 * is left untouched and reachable from its own nav entry, per the brief.
 */
export function StockChangesView() {
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: stock } = useBranchInventoryStock(activeBranchId);
  const [inventoryItemId, setInventoryItemId] = useState('all');
  const [filter, setFilter] = useState<ChangesFilter>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [viewingProofForTransactionId, setViewingProofForTransactionId] = useState<string | null>(null);

  const { data, isLoading, isFetching, isError, refetch } = useInventoryStockMovements(activeBranchId, {
    inventory_item_id: inventoryItemId === 'all' ? undefined : inventoryItemId,
    category: filter === 'all' ? undefined : filter,
    from_date: fromDate || undefined,
    to_date: toDate || undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  function resetToFirstPage() {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  }

  const columns: ColumnDef<InventoryStockMovementResponse>[] = [
    { id: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
    { id: 'item', header: 'Item', cell: ({ row }) => row.original.inventory_item_name },
    {
      id: 'movement_type',
      header: 'Action',
      cell: ({ row }) => (
        <Badge variant={row.original.quantity_change < 0 ? 'outline' : 'secondary'}>{MOVEMENT_TYPE_LABELS[row.original.movement_type]}</Badge>
      ),
    },
    {
      id: 'quantity_change',
      header: 'Quantity',
      cell: ({ row }) => (
        <span className={`tabular-nums ${row.original.quantity_change < 0 ? 'text-destructive' : 'text-success'}`}>
          {row.original.quantity_change > 0 ? '+' : ''}
          {row.original.quantity_change}
          {row.original.unit_code ? ` ${row.original.unit_code}` : ''}
        </span>
      ),
    },
    {
      id: 'balance',
      header: 'Before / After',
      cell: ({ row }) => (
        <span className="tabular-nums text-sm text-muted-foreground">
          {row.original.quantity_before} → {row.original.quantity_after}
          {row.original.unit_code ? ` ${row.original.unit_code}` : ''}
        </span>
      ),
    },
    { id: 'performed_by', header: 'Recorded By', cell: ({ row }) => row.original.performed_by_name ?? '—' },
    {
      id: 'reviewed_by',
      header: 'Reviewed By',
      cell: ({ row }) => row.original.reviewed_by_name ?? (row.original.recorded_as_supervisor_direct ? 'Direct record — no review required' : '—'),
    },
    {
      id: 'reference',
      header: 'Reference',
      cell: ({ row }) => {
        const movement = row.original;
        if (movement.reference_type === 'transaction' && movement.receipt_number) {
          return (
            <a href={`/r/${movement.receipt_number}`} target="_blank" rel="noreferrer" className="text-primary underline">
              {movement.receipt_number}
            </a>
          );
        }
        if (movement.linked_request_id) return <span className="text-xs text-muted-foreground">Request #{movement.linked_request_id.slice(0, 8)}</span>;
        return '—';
      },
    },
    {
      id: 'proof',
      header: 'Proof',
      cell: ({ row }) => {
        const movement = row.original;
        if (movement.proof_url) {
          return (
            <a href={movement.proof_url} target="_blank" rel="noreferrer" className="text-sm text-primary underline">
              View Photo
            </a>
          );
        }
        if (movement.reference_type === 'transaction' && movement.reference_id) {
          return (
            <Button type="button" variant="ghost" size="sm" className="h-auto p-0 text-xs underline" onClick={() => setViewingProofForTransactionId(movement.reference_id)}>
              View Photo
            </Button>
          );
        }
        return '—';
      },
    },
    { id: 'notes', header: 'Notes', cell: ({ row }) => row.original.notes ?? '—' },
  ];

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch to view its stock history.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={inventoryItemId}
          onValueChange={(value) => {
            setInventoryItemId(value);
            resetToFirstPage();
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
          value={filter}
          onValueChange={(value) => {
            setFilter(value as ChangesFilter);
            resetToFirstPage();
          }}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(FILTER_LABELS) as ChangesFilter[]).map((key) => (
              <SelectItem key={key} value={key}>
                {FILTER_LABELS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type="date"
          value={fromDate}
          onChange={(event) => {
            setFromDate(event.target.value);
            resetToFirstPage();
          }}
          className="w-[160px]"
        />
        <Input
          type="date"
          value={toDate}
          onChange={(event) => {
            setToDate(event.target.value);
            resetToFirstPage();
          }}
          className="w-[160px]"
        />

        {isFetching && !isLoading && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Updating…
          </span>
        )}
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
        emptyState={<EmptyState icon={PackageSearch} title="No stock changes yet" description="Stock in, adjustments, waste, transfers, and sale deductions will appear here as they're recorded." />}
      />

      <ViewPaymentProofDialog transactionId={viewingProofForTransactionId} onOpenChange={(open) => !open && setViewingProofForTransactionId(null)} />
    </div>
  );
}
