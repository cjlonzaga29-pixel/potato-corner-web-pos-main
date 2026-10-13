'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { Tags } from 'lucide-react';
import type { InventoryCategoryResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ManagedElsewhereBanner } from '@/components/shared/managed-elsewhere-banner';
import { useInventoryCategories } from '@/hooks/queries/use-universal-inventory';

export default function InventoryCategoriesPage() {
  const { data, isLoading, isError, refetch } = useInventoryCategories(true);

  const columns: ColumnDef<InventoryCategoryResponse>[] = [
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'code', header: 'Code', cell: ({ row }) => row.original.code ?? '—' },
    { accessorKey: 'description', header: 'Description', cell: ({ row }) => row.original.description ?? '—' },
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
          <h1 className="app-title font-bold">Inventory Categories</h1>
          <p className="text-sm text-muted-foreground">Groupings for Universal Inventory items, shared company-wide.</p>
        </div>
      </div>

      <ManagedElsewhereBanner module="Inventory Categories" managedBy="Supervisor" />

      <DataTable
        columns={columns}
        data={data ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        emptyState={<EmptyState icon={Tags} title="No categories yet" description="Inventory categories are created by Supervisors." />}
      />
    </div>
  );
}
