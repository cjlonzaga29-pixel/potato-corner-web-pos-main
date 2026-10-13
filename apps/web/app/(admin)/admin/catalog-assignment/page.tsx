'use client';

import { useState } from 'react';
import type { CatalogResourceType } from '@potato-corner/shared';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useUnmanagedCatalogResources } from '@/hooks/queries/use-catalog-assignment';
import { AssignManagementDialog } from '@/components/admin/catalog-assignment/assign-management-dialog';

const RESOURCE_TYPE_OPTIONS: { value: CatalogResourceType; label: string }[] = [
  { value: 'PRODUCT', label: 'Products' },
  { value: 'PRODUCT_CATEGORY', label: 'Product Categories' },
  { value: 'PRODUCT_OPTION_GROUP', label: 'Product Option Groups' },
  { value: 'PRODUCT_OPTION', label: 'Product Options' },
  { value: 'INVENTORY_CATEGORY', label: 'Inventory Categories' },
  { value: 'UNIT_OF_MEASURE', label: 'Units of Measure' },
  { value: 'UNIT_CONVERSION', label: 'Unit Conversions' },
  { value: 'INVENTORY_ITEM', label: 'Inventory Items' },
];

/**
 * POS-PERF-P35R — lists catalog/inventory-definition records that
 * currently have no explicit manager (managedBy IS NULL — includes both
 * NULL-createdBy shared master data and records created by an Admin
 * account, which P35 made otherwise unmanageable). Super Admin assigns
 * management explicitly here; nothing here auto-assigns or backfills.
 */
export default function CatalogAssignmentPage() {
  const [resourceType, setResourceType] = useState<CatalogResourceType>('INVENTORY_CATEGORY');
  const [page, setPage] = useState(1);
  const [assigning, setAssigning] = useState<{ id: string; label: string } | null>(null);

  const { data, isLoading, isError, refetch } = useUnmanagedCatalogResources(resourceType, page, 25);

  function handleResourceTypeChange(value: string) {
    setResourceType(value as CatalogResourceType);
    setPage(1);
  }

  return (
    <div className="app-section app-section-gap">
      <div className="min-w-0">
        <h1 className="app-title font-bold">Catalog Assignment</h1>
        <p className="text-sm text-muted-foreground">
          Explicitly assign management of a shared, orphaned, or Admin-created catalog/inventory record to a Supervisor. This is an administrative
          transition action — it does not restore catalog CRUD to Admin.
        </p>
      </div>

      <Select value={resourceType} onValueChange={handleResourceTypeChange}>
        <SelectTrigger className="w-[260px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RESOURCE_TYPE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : isError ? (
        <EmptyState title="Failed to load" description="Could not load unmanaged records." action={<Button onClick={() => void refetch()}>Retry</Button>} />
      ) : !data?.resources.length ? (
        <EmptyState title="Nothing unmanaged" description="Every record of this type already has an explicit manager." />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Original Creator</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.resources.map((resource) => (
                <TableRow key={resource.id}>
                  <TableCell>{resource.label}</TableCell>
                  <TableCell className="text-muted-foreground">{resource.created_by ?? 'None (pre-existing shared data)'}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" onClick={() => setAssigning({ id: resource.id, label: resource.label })}>
                      Assign
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Page {data.page} — {data.total} unmanaged record{data.total === 1 ? '' : 's'}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={data.page * data.limit >= data.total} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {assigning && (
        <AssignManagementDialog
          open={Boolean(assigning)}
          onOpenChange={(open) => !open && setAssigning(null)}
          resourceType={resourceType}
          resourceId={assigning.id}
          resourceLabel={assigning.label}
        />
      )}
    </div>
  );
}
