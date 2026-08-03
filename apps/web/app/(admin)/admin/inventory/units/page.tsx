'use client';

import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Pencil, Plus, Ruler } from 'lucide-react';
import type { UnitOfMeasureResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useUnitsOfMeasure } from '@/hooks/queries/use-universal-inventory';
import { CreateUnitDialog } from '@/components/admin/inventory/create-unit-dialog';
import { EditUnitDialog } from '@/components/admin/inventory/edit-unit-dialog';

export default function UnitsOfMeasurePage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingUnit, setEditingUnit] = useState<UnitOfMeasureResponse | null>(null);
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
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => (
        <Button
          variant="outline"
          size="sm"
          aria-label={`Edit ${row.original.name}`}
          onClick={(event) => {
            event.stopPropagation();
            setEditingUnit(row.original);
          }}
        >
          <Pencil className="mr-1 h-4 w-4" />
          Edit
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Units</h1>
          <p className="text-sm text-muted-foreground">Measurement units for Universal Inventory items and their conversions.</p>
        </div>
        <Button onClick={() => setDialogOpen(true)} className="w-full sm:w-auto">
          <Plus className="mr-2 h-4 w-4" />
          Create Unit
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={data ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        emptyState={<EmptyState icon={Ruler} title="No units yet" description="Create a unit before assigning it as an item's base unit." />}
      />

      <CreateUnitDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <EditUnitDialog unit={editingUnit} onOpenChange={(open) => !open && setEditingUnit(null)} />
    </div>
  );
}
