'use client';

import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRightLeft, ClipboardList, History, MinusCircle, PlusCircle, TriangleAlert } from 'lucide-react';
import type { BranchInventoryStockRow } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/shared/data-table';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useBranchStore } from '@/stores/branch.store';
import {
  useBranchInventoryStock,
  useBranchInventoryStockAlerts,
  useInventoryStockRealtimeSync,
} from '@/hooks/queries/use-universal-inventory';

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
        </div>
      ),
    },
  ];

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch to view its inventory.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Inventory</h1>
          <p className="text-sm text-muted-foreground">Current stock levels, derived from every recorded movement.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => router.push(`${basePath}/inventory/transfer`)}>
            <ArrowRightLeft className="mr-2 h-4 w-4" />
            Transfer
          </Button>
          <Button variant="outline" onClick={() => router.push(`${basePath}/inventory/movements`)}>
            <History className="mr-2 h-4 w-4" />
            Movements
          </Button>
          <Button variant="outline" onClick={() => router.push(`${basePath}/inventory/count`)}>
            <ClipboardList className="mr-2 h-4 w-4" />
            Physical Count
          </Button>
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
    </div>
  );
}
