'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { History } from 'lucide-react';
import { INVENTORY_STOCK_MOVEMENT_TYPE, type InventoryStockMovementResponse, type InventoryStockMovementType } from '@potato-corner/shared';
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
import { MOVEMENT_TYPE_LABELS } from '@/lib/inventory-movement-labels';

interface InventoryMovementsViewProps {
  /** Overrides useBranchStore's activeBranchId — used by the Admin cross-branch screen, which has no single "active branch" of its own. Omitted (the default) everywhere else, preserving the existing branch-store-driven behavior exactly. */
  branchId?: string | null;
}

/**
 * Shared body behind `/supervisor/inventory/movements` and the Admin
 * Inventory Movements screen — the full, unfiltered movement ledger across
 * every movement type. No internal navigation, so no basePath is needed.
 *
 * POS-PERF-P27 — `/branch/inventory/movements` no longer renders this: that
 * route now renders OrderDeductionsView, a SALE/SALE_REVERSAL-only view
 * (see order-deductions-view.tsx). This component is unchanged otherwise,
 * so Supervisor/Admin retain full audit visibility exactly as before.
 */
export function InventoryMovementsView({ branchId }: InventoryMovementsViewProps = {}) {
  const storeActiveBranchId = useBranchStore((s) => s.activeBranchId);
  const activeBranchId = branchId !== undefined ? branchId : storeActiveBranchId;
  const { data: stock } = useBranchInventoryStock(activeBranchId);
  const [inventoryItemId, setInventoryItemId] = useState('all');
  const [movementType, setMovementType] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  // POS-PERF-P25 — "View Photo" opens the same payment-proof dialog the
  // sale's own detail view uses (view-payment-proof-dialog.tsx), fetched
  // fresh by transactionId. A SALE movement's reference_id IS the
  // originating transaction's id, so no new backend field is needed — and
  // no per-ingredient copy of the image is ever made (see createStockMovements:
  // proofKey/proofType are deliberately never set on a SALE movement).
  const [viewingProofForTransactionId, setViewingProofForTransactionId] = useState<string | null>(null);

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
      // A SALE movement's reference_id is the originating transaction's id
      // — shown as its actual receipt number (with a link to the same
      // public receipt view the printed receipt's QR code opens) rather
      // than a bare, meaningless UUID prefix. Every other movement type
      // (TRANSFER_IN/TRANSFER_OUT legs sharing one reference_id, etc.) keeps
      // the existing truncated-id display.
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
        if (movement.reference_id) {
          return (
            <span className="text-xs text-muted-foreground">
              {movement.reference_type ?? 'ref'}: {movement.reference_id.slice(0, 8)}
            </span>
          );
        }
        return '—';
      },
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
    {
      id: 'payment_proof',
      // POS-PERF-P25 — payment-proof evidence for the sale that caused this
      // movement. Distinct from the "Receipt" column above (that one is a
      // purchase/receiving receipt photo — RECEIVING/WASTE only). Only
      // meaningful for a SALE movement; every other movement type shows
      // "—" since it was never a sale.
      header: 'Proof of Payment',
      cell: ({ row }) => {
        const movement = row.original;
        if (movement.movement_type !== 'SALE' || movement.reference_type !== 'transaction' || !movement.reference_id) return '—';
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

      <ViewPaymentProofDialog
        transactionId={viewingProofForTransactionId}
        onOpenChange={(open) => !open && setViewingProofForTransactionId(null)}
      />
    </div>
  );
}
