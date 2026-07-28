'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { Boxes, ClipboardList, Plus } from 'lucide-react';
import type { InventoryItemResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useInventoryItems } from '@/hooks/queries/use-universal-inventory';
import { CreateInventoryItemDialog } from '@/components/admin/inventory/create-inventory-item-dialog';

export default function UniversalInventoryPage() {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data, isLoading, isError, refetch } = useInventoryItems();

  const columns: ColumnDef<InventoryItemResponse>[] = [
    { accessorKey: 'name', header: 'Item' },
    { accessorKey: 'sku', header: 'SKU', cell: ({ row }) => row.original.sku ?? '—' },
    { accessorKey: 'category_name', header: 'Category', cell: ({ row }) => row.original.category_name ?? '—' },
    { accessorKey: 'base_unit_code', header: 'Base Unit' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Universal Inventory</h1>
          <p className="text-sm text-muted-foreground">
            The single, company-wide inventory identity. Branches reference these items — they never create their own.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => router.push('/admin/inventory/migration-report')}>
            <ClipboardList className="mr-2 h-4 w-4" />
            Migration Report
          </Button>
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Create Item
          </Button>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={data ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        onRowClick={(item) => router.push(`/admin/inventory/${item.id}`)}
        emptyState={
          <EmptyState icon={Boxes} title="No inventory items yet" description="Create the first Universal Inventory item to start assigning it to branches." />
        }
      />

      <CreateInventoryItemDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
