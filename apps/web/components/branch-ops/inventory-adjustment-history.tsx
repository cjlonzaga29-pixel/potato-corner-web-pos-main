'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { History } from 'lucide-react';
import type { InventoryStockMovementResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatDateTime } from '@/lib/utils';
import { useBranchStore } from '@/stores/branch.store';
import { useBranchInventoryStock, useInventoryStockMovements } from '@/hooks/queries/use-universal-inventory';

/**
 * POS-PERF-P27 — manual adjustment history, shown below the Stock
 * Adjustments form. Scoped server-side to ADJUSTMENT_IN/ADJUSTMENT_OUT only
 * (see STOCK_MOVEMENT_CATEGORY_TYPES.adjustments) — receiving, waste, and
 * transfers keep their own existing workflows/pages and never appear here.
 *
 * Shares the same INVENTORY_MOVEMENT_RECORDED realtime invalidation as the
 * branch stock query (adjustStock already emits it synchronously on record,
 * unlike the async sale-deduction worker), so no extra polling is needed.
 */
export function InventoryAdjustmentHistory() {
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: stock } = useBranchInventoryStock(activeBranchId);
  const [inventoryItemId, setInventoryItemId] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });

  const { data, isLoading, isError, refetch } = useInventoryStockMovements(activeBranchId, {
    inventory_item_id: inventoryItemId === 'all' ? undefined : inventoryItemId,
    category: 'adjustments',
    from_date: fromDate || undefined,
    to_date: toDate || undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<InventoryStockMovementResponse>[] = [
    { id: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
    { id: 'item', header: 'Item', cell: ({ row }) => row.original.inventory_item_name },
    {
      id: 'direction',
      header: 'Adjustment',
      cell: ({ row }) => (
        <Badge variant={row.original.movement_type === 'ADJUSTMENT_IN' ? 'secondary' : 'outline'}>
          {row.original.movement_type === 'ADJUSTMENT_IN' ? 'In' : 'Out'}
        </Badge>
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
    // notes already carries "Reason: <code> — <notes>" verbatim (see
    // adjustStock) — never relabeled or split, so nothing is invented here.
    { id: 'notes', header: 'Reason / Notes', cell: ({ row }) => row.original.notes ?? '—' },
    {
      id: 'attachment',
      // Deliberately "View Attachment", never "Proof of Payment" — this is
      // the adjustment's own optional proof photo, not evidence a customer
      // paid for anything.
      header: 'Attachment',
      cell: ({ row }) =>
        row.original.proof_url ? (
          <a href={row.original.proof_url} target="_blank" rel="noreferrer" className="text-primary underline">
            View Attachment
          </a>
        ) : (
          '—'
        ),
    },
  ];

  if (!activeBranchId) return null;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Adjustment History</h2>
        <p className="text-sm text-muted-foreground">Manual stock adjustments recorded for this branch.</p>
      </div>

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
        emptyState={<EmptyState icon={History} title="No adjustments yet" description="Manual stock adjustments will appear here as they're recorded." />}
      />
    </div>
  );
}
