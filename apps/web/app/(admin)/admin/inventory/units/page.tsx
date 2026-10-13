'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { Ruler } from 'lucide-react';
import type { UnitOfMeasureResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ManagedElsewhereBanner } from '@/components/shared/managed-elsewhere-banner';
import { useUnitsOfMeasure } from '@/hooks/queries/use-universal-inventory';

export default function UnitsOfMeasurePage() {
  const { data, isLoading, isError, refetch } = useUnitsOfMeasure(true);

  const columns: ColumnDef<UnitOfMeasureResponse>[] = [
    { accessorKey: 'code', header: 'Code' },
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'dimension', header: 'Dimension' },
    {
      accessorKey: 'is_base_unit',
      header: 'Base Unit',
      cell: ({ row }) => (row.original.is_base_unit ? <Badge variant="active">Base</Badge> : '—'),
    },
    {
      accessorKey: 'is_active',
      header: 'Status',
      cell: ({ row }) => <Badge variant={row.original.is_active ? 'active' : 'inactive'}>{row.original.is_active ? 'Active' : 'Inactive'}</Badge>,
    },
  ];

  return (
    <div className="app-section app-section-gap">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="app-title font-bold">Units</h1>
          <p className="text-sm text-muted-foreground">Measurement units for Universal Inventory items and their conversions.</p>
        </div>
      </div>

      <ManagedElsewhereBanner module="Units" managedBy="Supervisor" />

      <DataTable
        columns={columns}
        data={data ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        emptyState={<EmptyState icon={Ruler} title="No units yet" description="Units are created by Supervisors." />}
      />
    </div>
  );
}
