'use client';

import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Pencil, Plus, Tags } from 'lucide-react';
import type { InventoryCategoryResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useInventoryCategories } from '@/hooks/queries/use-universal-inventory';
import { CreateCategoryDialog } from '@/components/admin/inventory/create-category-dialog';
import { EditCategoryDialog } from '@/components/admin/inventory/edit-category-dialog';

export default function InventoryCategoriesPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<InventoryCategoryResponse | null>(null);
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
            setEditing(row.original);
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
          <h1 className="text-2xl font-bold">Inventory Categories</h1>
          <p className="text-sm text-muted-foreground">Groupings for Universal Inventory items — admin-managed, shared company-wide.</p>
        </div>
        <Button onClick={() => setDialogOpen(true)} className="w-full sm:w-auto">
          <Plus className="mr-2 h-4 w-4" />
          Create Category
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={data ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        emptyState={<EmptyState icon={Tags} title="No categories yet" description="Create a category to start organizing Universal Inventory items." />}
      />

      <CreateCategoryDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <EditCategoryDialog category={editing} onOpenChange={(open) => !open && setEditing(null)} />
    </div>
  );
}
