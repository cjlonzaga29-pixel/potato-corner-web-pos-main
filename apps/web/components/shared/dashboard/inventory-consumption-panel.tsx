'use client';

import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import type { InventoryConsumptionSummaryReportRow } from '@potato-corner/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/shared/data-table/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { manilaToday } from '@/lib/manila-date';
import { useInventoryConsumptionSummaryReport } from '@/hooks/queries/use-reports';

const TOP_CONSUMED_COUNT = 5;

const columns: ColumnDef<InventoryConsumptionSummaryReportRow>[] = [
  { accessorKey: 'ingredient_name', header: 'Ingredient' },
  { id: 'quantity_consumed', header: 'Consumed Today', cell: ({ row }) => `${row.original.quantity_consumed} ${row.original.unit}` },
];

interface InventoryConsumptionPanelProps {
  branchId: string | undefined;
}

/** Today's top sale-driven ingredient consumption for this branch — reuses the same INVENTORY_CONSUMPTION_SUMMARY report as the Reports > Inventory tab, scoped to today (see useInventoryAnalyticsRealtimeSync for the realtime invalidation that keeps this in sync with stock movements). */
export function InventoryConsumptionPanel({ branchId }: InventoryConsumptionPanelProps) {
  const today = manilaToday();
  const consumption = useInventoryConsumptionSummaryReport({ branch_id: branchId, date_from: today, date_to: today, page: 1, limit: 100 });

  const topConsumed = useMemo(
    () => [...(consumption.data?.data ?? [])].sort((a, b) => b.quantity_consumed - a.quantity_consumed).slice(0, TOP_CONSUMED_COUNT),
    [consumption.data],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Inventory Consumption</CardTitle>
      </CardHeader>
      <CardContent>
        {consumption.isError ? (
          <ErrorState retry={() => void consumption.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            data={topConsumed}
            isLoading={consumption.isLoading}
            emptyState={<EmptyState title="No consumption yet" description="Ingredient consumption will appear once sales come in today." />}
          />
        )}
      </CardContent>
    </Card>
  );
}
