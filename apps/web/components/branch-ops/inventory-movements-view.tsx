'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { History } from 'lucide-react';
import { INVENTORY_STOCK_MOVEMENT_TYPE, type InventoryStockMovementResponse, type InventoryStockMovementType } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatDateTime } from '@/lib/utils';
import { useBranchStore } from '@/stores/branch.store';
import { useBranchInventoryStock, useInventoryStockMovements } from '@/hooks/queries/use-universal-inventory';

const MOVEMENT_TYPE_LABELS: Record<InventoryStockMovementType, string> = {
  RECEIVING: 'Receiving',
  ADJUSTMENT_IN: 'Adjustment (In)',
  ADJUSTMENT_OUT: 'Adjustment (Out)',
  WASTE: 'Waste',
  TRANSFER_IN: 'Transfer In',
  TRANSFER_OUT: 'Transfer Out',
  PHYSICAL_COUNT: 'Physical Count',
  SALE: 'Sale',
  SALE_REVERSAL: 'Sale Reversal',
};

interface InventoryMovementsViewProps {
  /** Overrides useBranchStore's activeBranchId — used by the Admin cross-branch screen, which has no single "active branch" of its own. Omitted (the default) everywhere else, preserving the existing branch-store-driven behavior exactly. */
  branchId?: string | null;
}

/** Shared body behind `/supervisor/inventory/movements`, `/branch/inventory/movements`, and the Admin Inventory Movements screen — no internal navigation, so no basePath is needed. */
export function InventoryMovementsView({ branchId }: InventoryMovementsViewProps = {}) {
  const storeActiveBranchId = useBranchStore((s) => s.activeBranchId);
  const activeBranchId = branchId !== undefined ? branchId : storeActiveBranchId;
  const { data: stock } = useBranchInventoryStock(activeBranchId);
  const [inventoryItemId, setInventoryItemId] = useState('all');
  const [movementType, setMovementType] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });

  const { data, isLoading, isError, refetch } = useInventoryStockMovements(activeBranchId, {
    inventory_item_id: inventoryItemId === 'all' ? undefined : inventoryItemId,
    movement_type: movementType === 'all' ? undefined : (movementType as InventoryStockMovementType),
    // Send the bare Manila business date as-is — the API resolves it to that
    // day's Manila start/end. `new Date(fromDate).toISOString()` would parse
    // it as UTC midnight (Manila 8:00 AM), dropping early-morning movements;
    // the previous to_date also relied on the browser's local timezone.
    from_date: fromDate || undefined,
    to_date: toDate || undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<InventoryStockMovementResponse>[] = [
    { id: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
    { id: 'item', header: 'Item', cell: ({ row }) => row.original.inventory_item_name },
    {
      id: 'movement_type',
      header: 'Type',
      cell: ({ row }) => <Badge variant="secondary">{MOVEMENT_TYPE_LABELS[row.original.movement_type]}</Badge>,
    },
    {
      id: 'quantity_change',
      header: 'Change',
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
    {
      id: 'unit_cost',
      header: 'Unit Cost',
      cell: ({ row }) => (
        <span className="tabular-nums text-muted-foreground">
          {row.original.unit_cost === null ? '—' : `₱${row.original.unit_cost.toFixed(4)}`}
        </span>
      ),
    },
    {
      id: 'total_cost',
      header: 'Cost',
      cell: ({ row }) => (
        <span className="tabular-nums text-muted-foreground">
          {row.original.total_cost === null ? '—' : `₱${Math.abs(row.original.total_cost).toFixed(2)}`}
        </span>
      ),
    },
    {
      id: 'purchase_quantity',
      header: 'Purchase Qty/Unit',
      cell: ({ row }) =>
        row.original.entered_quantity === null ? (
          '—'
        ) : (
          <span className="tabular-nums">
            {row.original.entered_quantity} {row.original.entered_unit_code}
          </span>
        ),
    },
    {
      id: 'performed_by',
      header: 'Recorded By',
      cell: ({ row }) => row.original.performed_by_name ?? '—',
    },
    {
      id: 'responsible',
      header: 'Responsible Staff',
      cell: ({ row }) => row.original.responsible_user_name ?? '—',
    },
    {
      id: 'reference',
      // TRANSFER_IN/TRANSFER_OUT legs share one reference_id (see
      // transferStock) — shown so the two branch-side rows of the same
      // transfer can be visually matched instead of looking unrelated.
      header: 'Reference',
      cell: ({ row }) =>
        row.original.reference_id ? (
          <span className="text-xs text-muted-foreground">
            {row.original.reference_type ?? 'ref'}: {row.original.reference_id.slice(0, 8)}
          </span>
        ) : (
          '—'
        ),
    },
    {
      id: 'proof',
      header: 'Receipt',
      cell: ({ row }) =>
        row.original.proof_url ? (
          <a href={row.original.proof_url} target="_blank" rel="noreferrer" className="text-primary underline">
            View Receipt
          </a>
        ) : (
          '—'
        ),
    },
    { id: 'notes', header: 'Notes', cell: ({ row }) => row.original.notes ?? '—' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Inventory Movements</h1>
        <p className="text-sm text-muted-foreground">Full, append-only history of every stock change at this branch.</p>
      </div>

      {!activeBranchId ? (
        <p className="text-sm text-destructive">Select an active branch to view its inventory movements.</p>
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
                setMovementType(value);
                setPagination((prev) => ({ ...prev, pageIndex: 0 }));
              }}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {(Object.values(INVENTORY_STOCK_MOVEMENT_TYPE) as InventoryStockMovementType[]).map((type) => (
                  <SelectItem key={type} value={type}>
                    {MOVEMENT_TYPE_LABELS[type]}
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
            emptyState={
              <EmptyState icon={History} title="No movements yet" description="Stock movements will appear here as they're recorded." />
            }
          />
        </>
      )}
    </div>
  );
}
