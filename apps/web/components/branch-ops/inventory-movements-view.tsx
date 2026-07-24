'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { History } from 'lucide-react';
import { MOVEMENT_TYPE, type MovementResponse, type MovementType } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatDateTime } from '@/lib/utils';
import { useBranchStore } from '@/stores/branch.store';
import { useIngredients, useInventoryMovements } from '@/hooks/queries/use-inventory';

const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  stock_in: 'Stock In',
  sale_deduction: 'Sale Deduction',
  manual_adjustment: 'Manual Adjustment',
  waste: 'Waste',
  physical_count: 'Physical Count',
  transfer_in: 'Transfer In',
  transfer_out: 'Transfer Out',
};

/** Shared body behind both `/supervisor/inventory/movements` and `/branch/inventory/movements` — no internal navigation, so no basePath is needed. */
export function InventoryMovementsView() {
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: ingredients } = useIngredients(activeBranchId);
  const [ingredientId, setIngredientId] = useState('all');
  const [movementType, setMovementType] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });

  const { data, isLoading, isError, refetch } = useInventoryMovements(activeBranchId, {
    ingredient_id: ingredientId === 'all' ? undefined : ingredientId,
    movement_type: movementType === 'all' ? undefined : (movementType as MovementType),
    from_date: fromDate ? new Date(fromDate).toISOString() : undefined,
    to_date: toDate ? new Date(`${toDate}T23:59:59.999`).toISOString() : undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<MovementResponse>[] = [
    { id: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
    { id: 'ingredient', header: 'Ingredient', cell: ({ row }) => row.original.ingredient_name },
    {
      id: 'movement_type',
      header: 'Type',
      cell: ({ row }) => <Badge variant="secondary">{MOVEMENT_TYPE_LABELS[row.original.movement_type as MovementType]}</Badge>,
    },
    {
      id: 'quantity_change',
      header: 'Change',
      cell: ({ row }) => (
        <span className={`tabular-nums ${row.original.quantity_change < 0 ? 'text-destructive' : 'text-success'}`}>
          {row.original.quantity_change > 0 ? '+' : ''}
          {row.original.quantity_change}
        </span>
      ),
    },
    {
      id: 'quantity_after',
      header: 'Balance After',
      cell: ({ row }) => <span className="tabular-nums">{row.original.quantity_after}</span>,
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
              value={ingredientId}
              onValueChange={(value) => {
                setIngredientId(value);
                setPagination((prev) => ({ ...prev, pageIndex: 0 }));
              }}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="All ingredients" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All ingredients</SelectItem>
                {ingredients?.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
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
                {(Object.values(MOVEMENT_TYPE) as MovementType[]).map((type) => (
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
