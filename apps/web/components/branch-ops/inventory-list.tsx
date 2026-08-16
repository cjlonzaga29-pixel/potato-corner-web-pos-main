'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRightLeft, ClipboardList, FileClock, History, MinusCircle, PenLine, PlusCircle, TriangleAlert } from 'lucide-react';
import { ROLES, type BranchInventoryStockRow } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/shared/data-table';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useAuthStore } from '@/stores/auth.store';
import { useBranchStore } from '@/stores/branch.store';
import {
  useBranchInventoryStock,
  useBranchInventoryStockAlerts,
  useInventoryStockRealtimeSync,
} from '@/hooks/queries/use-universal-inventory';
import { CostCorrectionDialog } from './cost-correction-dialog';

/**
 * Shared body behind both `/supervisor/inventory` and `/branch/inventory` —
 * `basePath` is the only thing that differs between the two routes (their
 * page.tsx wrappers pass "/supervisor" or "/branch"), everything else
 * (data, mutations) is the single copy of the real logic.
 *
 * Reads/writes InventoryStock directly (branch inventory cutover) — items
 * themselves are Admin-owned (see /admin/inventory) and simply appear here
 * once assigned to this branch, at zero quantity until received.
 */
export function InventoryList({ basePath }: { basePath: string }) {
  const router = useRouter();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  useInventoryStockRealtimeSync(activeBranchId);
  const { data, isLoading, isError, refetch } = useBranchInventoryStock(activeBranchId);
  const { data: alertsData } = useBranchInventoryStockAlerts(activeBranchId);
  // Cost correction is Supervisor/Super Admin only (Receiving Simplification
  // V2 §12) — this component is shared with /branch/inventory, so the
  // action/nav must be hidden for the branch role even though the server
  // independently enforces the same rule (adminOrSupervisor).
  const role = useAuthStore((s) => s.user?.role);
  const canCorrectCost = role === ROLES.SUPERVISOR || role === ROLES.SUPER_ADMIN;
  const [correctingItem, setCorrectingItem] = useState<BranchInventoryStockRow | null>(null);

  const alertCount = alertsData?.alerts.length ?? 0;
  const criticalCount = alertsData?.alerts.filter((a) => a.severity === 'critical').length ?? 0;

  const columns: ColumnDef<BranchInventoryStockRow>[] = [
    { accessorKey: 'name', header: 'Item' },
    { accessorKey: 'base_unit_code', header: 'Unit' },
    {
      id: 'quantity_on_hand',
      header: 'Current Stock',
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.quantity_on_hand} {row.original.base_unit_code}
        </span>
      ),
    },
    {
      id: 'avg_unit_cost',
      header: 'Avg Unit Cost',
      cell: ({ row }) => (
        <span className="tabular-nums text-muted-foreground">
          {row.original.avg_unit_cost === null ? 'Cost not initialized' : `₱${row.original.avg_unit_cost.toFixed(4)}`}
        </span>
      ),
    },
    {
      id: 'inventory_value',
      header: 'Inventory Value',
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.inventory_value === null ? '—' : `₱${row.original.inventory_value.toFixed(2)}`}</span>
      ),
    },
    {
      id: 'consumed_today',
      header: 'Consumed Today',
      cell: ({ row }) => (
        <span className="tabular-nums text-muted-foreground">
          {row.original.consumed_today} {row.original.base_unit_code}
        </span>
      ),
    },
    {
      id: 'low_stock_threshold',
      header: 'Low / Critical',
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground tabular-nums">
          {row.original.low_stock_threshold ?? '—'} / {row.original.critical_threshold ?? '—'}
        </span>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => <StatusBadge status={row.original.status} type="inventory" />,
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`${basePath}/inventory/stock-in?inventory_item_id=${row.original.inventory_item_id}`)}
          >
            <PlusCircle className="mr-1 h-4 w-4" />
            Stock In
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`${basePath}/inventory/adjust?inventory_item_id=${row.original.inventory_item_id}`)}
          >
            Adjust
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`${basePath}/inventory/waste?inventory_item_id=${row.original.inventory_item_id}`)}
          >
            <MinusCircle className="mr-1 h-4 w-4" />
            Waste
          </Button>
          {canCorrectCost && (
            <Button variant="ghost" size="sm" onClick={() => setCorrectingItem(row.original)}>
              <PenLine className="mr-1 h-4 w-4" />
              Correct Cost
            </Button>
          )}
        </div>
      ),
    },
  ];

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch to view its inventory.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Inventory</h1>
          <p className="text-sm text-muted-foreground">Current stock levels, derived from every recorded movement.</p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:flex sm:shrink-0">
          <Button variant="outline" onClick={() => router.push(`${basePath}/inventory/transfer`)} className="w-full sm:w-auto">
            <ArrowRightLeft className="mr-2 h-4 w-4" />
            Transfer
          </Button>
          <Button variant="outline" onClick={() => router.push(`${basePath}/inventory/movements`)} className="w-full sm:w-auto">
            <History className="mr-2 h-4 w-4" />
            Movements
          </Button>
          <Button variant="outline" onClick={() => router.push(`${basePath}/inventory/count`)} className="w-full sm:w-auto">
            <ClipboardList className="mr-2 h-4 w-4" />
            Physical Count
          </Button>
          {canCorrectCost && (
            <Button variant="outline" onClick={() => router.push('/supervisor/inventory/cost-corrections')} className="w-full sm:w-auto">
              <FileClock className="mr-2 h-4 w-4" />
              Cost Corrections
            </Button>
          )}
        </div>
      </div>

      {alertCount > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <TriangleAlert className="h-4 w-4 shrink-0 text-destructive" />
          <span>
            {alertCount} item{alertCount === 1 ? '' : 's'} at or below the low-stock threshold
            {criticalCount > 0 && (
              <>
                {' '}
                — <Badge variant="critical">{criticalCount} critical</Badge>
              </>
            )}
          </span>
        </div>
      )}

      <DataTable
        columns={columns}
        data={data?.items ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        emptyState={
          <EmptyState
            icon={ArrowRightLeft}
            title="No inventory items yet"
            description="Inventory items are created by an admin and assigned to branches — once assigned, they appear here."
          />
        }
      />

      {canCorrectCost && correctingItem && activeBranchId && (
        <CostCorrectionDialog
          branchId={activeBranchId}
          inventoryItemId={correctingItem.inventory_item_id}
          itemName={correctingItem.name}
          baseUnitCode={correctingItem.base_unit_code}
          quantityOnHand={correctingItem.quantity_on_hand}
          currentUnitCost={correctingItem.avg_unit_cost}
          open={Boolean(correctingItem)}
          onOpenChange={(nextOpen) => !nextOpen && setCorrectingItem(null)}
        />
      )}
    </div>
  );
}
