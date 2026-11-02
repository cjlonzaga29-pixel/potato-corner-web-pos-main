'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRightLeft, ClipboardCheck, ClipboardList, History, MinusCircle, PlusCircle, TriangleAlert } from 'lucide-react';
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
import {
  STOCK_STATUS_FILTERS,
  affectedLabel,
  matchesStockStatusFilter,
  otherChoicesStillSell,
  parseStockStatusFilter,
  recipeShortageLine,
  stockAlertCounts,
  stockAlertRows,
  stockBadgeStatus,
  stockStateOf,
} from '@/lib/inventory-stock-status';
import { transferPrepareHref } from '@/lib/transfer-links';

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
  const searchParams = useSearchParams();
  const statusFilter = parseStockStatusFilter(searchParams.get('status'));
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  useInventoryStockRealtimeSync(activeBranchId);
  const { data, isLoading, isError, refetch } = useBranchInventoryStock(activeBranchId);
  const { data: alertsData } = useBranchInventoryStockAlerts(activeBranchId);

  // Same stale-branch guard as the dashboard: rows/alerts answered for a
  // previously selected branch are never shown under the current one.
  const items = data?.branch_id === activeBranchId ? data.items : undefined;
  const filteredItems = (items ?? []).filter((row) => matchesStockStatusFilter(row, statusFilter));
  const isItemsLoading = isLoading || (data !== undefined && items === undefined);
  const alertsForBranch = alertsData?.branch_id === activeBranchId ? alertsData : undefined;
  const alerts = stockAlertRows(alertsForBranch);
  const alertCount = alerts.length;
  const { out: outCount, insufficient: insufficientCount, critical: criticalCount } = stockAlertCounts(alerts);
  const setupIssues = alertsForBranch?.setup_issues ?? [];

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
      id: 'quantity_reserved',
      header: 'Reserved',
      cell: ({ row }) => (
        <span className="tabular-nums text-muted-foreground">
          {row.original.quantity_reserved > 0 ? `${row.original.quantity_reserved} ${row.original.base_unit_code}` : '—'}
        </span>
      ),
    },
    {
      id: 'quantity_available',
      header: 'Available',
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.quantity_available} {row.original.base_unit_code}
        </span>
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
      cell: ({ row }) => {
        const shortage = row.original.recipe_shortage;
        return (
          <div className="min-w-[10rem] space-y-1">
            <StatusBadge status={stockBadgeStatus(stockStateOf(row.original))} type="inventory" />
            {shortage && (
              <details className="text-xs text-muted-foreground" data-testid="inventory-shortage-detail">
                <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {shortage.deficit} {shortage.unit_code} short
                </summary>
                <p className="mt-1">{recipeShortageLine(row.original.quantity_available, shortage)}.</p>
                <p className="mt-1">Affects {affectedLabel(shortage)}.</p>
                {otherChoicesStillSell(shortage) && <p className="mt-1">Other choices still sell.</p>}
              </details>
            )}
          </div>
        );
      },
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          {/* POS-PERF-P48 — this branch as the destination; the transfer page re-checks access and the server re-authorizes. */}
          {stockStateOf(row.original) !== 'healthy' && activeBranchId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push(transferPrepareHref(basePath, { toBranchId: activeBranchId, inventoryItemId: row.original.inventory_item_id }))}
            >
              <ArrowRightLeft className="mr-1 h-4 w-4" />
              Prepare transfer
            </Button>
          )}
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Inventory</h1>
          <p className="text-sm text-muted-foreground">Current stock levels, derived from every recorded movement.</p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:flex sm:shrink-0">
          <Button variant="outline" onClick={() => router.push(transferPrepareHref(basePath, { fromBranchId: activeBranchId }))} className="w-full sm:w-auto">
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
          <Button variant="outline" onClick={() => router.push(`${basePath}/inventory/stock-history`)} className="w-full sm:w-auto">
            <ClipboardCheck className="mr-2 h-4 w-4" />
            Stock History
          </Button>
        </div>
      </div>

      {alertCount > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <TriangleAlert className="h-4 w-4 shrink-0 text-destructive" />
          <span>
            {alertCount} item{alertCount === 1 ? '' : 's'} need{alertCount === 1 ? 's' : ''} attention
            {outCount > 0 && (
              <>
                {' '}
                — <Badge variant="critical">{outCount} out of stock</Badge>
              </>
            )}
            {insufficientCount > 0 && (
              <>
                {' '}
                — <Badge variant="critical">{insufficientCount} insufficient for a serving</Badge>
              </>
            )}
            {criticalCount > 0 && (
              <>
                {' '}
                — <Badge variant="critical">{criticalCount} critical</Badge>
              </>
            )}
          </span>
        </div>
      )}

      {/* POS-PERF-P57 — blocked at the POS, but not a stock shortage: receiving more of a tracked item would not explain these. */}
      {setupIssues.length > 0 && (
        <details className="rounded-md border px-4 py-3 text-sm" data-testid="inventory-setup-issues">
          <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {setupIssues.length} size{setupIssues.length === 1 ? ' is' : 's are'} blocked by setup, not stock
          </summary>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            {setupIssues.map((issue) => (
              <li key={`${issue.inventory_item_id ?? issue.name}:${issue.product_name}:${issue.variant_name}`}>
                {issue.product_name} {issue.variant_name}: {issue.name}{' '}
                {issue.reason === 'not_assigned' ? 'is not assigned to this branch' : issue.reason === 'untracked' ? 'is not tracked, but its recipe still needs stock here' : issue.reason === 'no_slot_choice' ? 'has no snack and flavor to choose at this branch' : 'uses a unit with no conversion to the stock unit'}.
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by stock status">
        {STOCK_STATUS_FILTERS.map((filter) => (
          <Button
            key={filter.value}
            type="button"
            size="sm"
            variant={statusFilter === filter.value ? 'default' : 'outline'}
            aria-pressed={statusFilter === filter.value}
            onClick={() =>
              router.replace(filter.value === 'all' ? `${basePath}/inventory` : `${basePath}/inventory?status=${filter.value}`, {
                scroll: false,
              })
            }
          >
            {filter.label}
          </Button>
        ))}
        {statusFilter !== 'all' && items && (
          <span className="text-sm text-muted-foreground" aria-live="polite">
            {filteredItems.length} of {items.length} items
          </span>
        )}
      </div>

      <DataTable
        columns={columns}
        data={filteredItems}
        isLoading={isItemsLoading}
        isError={isError}
        onRetry={() => void refetch()}
        emptyState={
          statusFilter === 'all' ? (
            <EmptyState
              icon={ArrowRightLeft}
              title="No inventory items yet"
              description="Inventory items are created by an admin and assigned to branches — once assigned, they appear here."
            />
          ) : (
            <EmptyState
              compact
              title="No items match this filter"
              description="No tracked item at this branch is in this stock state."
              action={
                <Button type="button" variant="outline" size="sm" onClick={() => router.replace(`${basePath}/inventory`)}>
                  Show all items
                </Button>
              }
            />
          )
        }
      />
    </div>
  );
}
