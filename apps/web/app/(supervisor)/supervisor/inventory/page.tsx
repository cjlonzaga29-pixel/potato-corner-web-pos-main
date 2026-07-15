'use client';

import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRightLeft, ClipboardList, History, MinusCircle, PlusCircle, TriangleAlert } from 'lucide-react';
import type { BranchInventoryRow } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/shared/data-table';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useBranchStore } from '@/stores/branch.store';
import { useBranchInventory, useBranchInventoryAlerts, useInventoryRealtimeSync } from '@/hooks/queries/use-inventory';

export default function SupervisorInventoryPage() {
  const router = useRouter();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  useInventoryRealtimeSync(activeBranchId);
  const { data, isLoading, isError, refetch } = useBranchInventory(activeBranchId);
  const { data: alertsData } = useBranchInventoryAlerts(activeBranchId);

  const alertCount = alertsData?.alerts.length ?? 0;
  const criticalCount = alertsData?.alerts.filter((a) => a.severity === 'critical').length ?? 0;

  const columns: ColumnDef<BranchInventoryRow>[] = [
    { accessorKey: 'name', header: 'Ingredient' },
    { accessorKey: 'unit', header: 'Unit' },
    {
      id: 'current_stock',
      header: 'Current Stock',
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.current_stock} {row.original.unit}
        </span>
      ),
    },
    {
      id: 'low_stock_threshold',
      header: 'Low / Critical',
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground tabular-nums">
          {row.original.low_stock_threshold} / {row.original.critical_threshold}
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
            onClick={() => router.push(`/supervisor/inventory/stock-in?ingredient_id=${row.original.ingredient_id}`)}
          >
            <PlusCircle className="mr-1 h-4 w-4" />
            Stock In
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`/supervisor/inventory/adjust?ingredient_id=${row.original.ingredient_id}`)}
          >
            Adjust
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`/supervisor/inventory/waste?ingredient_id=${row.original.ingredient_id}`)}
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
          <Button variant="outline" onClick={() => router.push('/supervisor/inventory/movements')}>
            <History className="mr-2 h-4 w-4" />
            Movements
          </Button>
          <Button variant="outline" onClick={() => router.push('/supervisor/inventory/count')}>
            <ClipboardList className="mr-2 h-4 w-4" />
            Physical Count
          </Button>
        </div>
      </div>

      {alertCount > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <TriangleAlert className="h-4 w-4 shrink-0 text-destructive" />
          <span>
            {alertCount} ingredient{alertCount === 1 ? '' : 's'} at or below the low-stock threshold
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
        data={data?.ingredients ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        emptyState={
          <EmptyState
            icon={ArrowRightLeft}
            title="No ingredients yet"
            description="Ingredients are created by an admin — once added, their stock movements appear here."
          />
        }
      />
    </div>
  );
}
