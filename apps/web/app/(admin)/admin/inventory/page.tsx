'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef, PaginationState, SortingState } from '@tanstack/react-table';
import { Boxes, ClipboardList, Pencil, Plus } from 'lucide-react';
import type { InventoryItemResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/shared/data-table';
import { DataTableColumnHeader } from '@/components/shared/data-table/data-table-column-header';
import { SearchInput } from '@/components/shared/forms/search-input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { cn } from '@/lib/utils';
import { useInventoryItems } from '@/hooks/queries/use-universal-inventory';
import { CreateInventoryItemDialog } from '@/components/admin/inventory/create-inventory-item-dialog';
import { InventoryCategoryBadge } from '@/components/admin/inventory/inventory-category-badge';

const ALL_CATEGORIES = 'all';

/** Below `md`, only Item/Category/Unit/Actions stay visible per the inventory UX spec. */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    const query = window.matchMedia('(min-width: 768px)');
    setIsDesktop(query.matches);
    const listener = (event: MediaQueryListEvent) => setIsDesktop(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

  return isDesktop;
}

function compareNullableStrings(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

export default function UniversalInventoryPage() {
  const router = useRouter();
  const isDesktop = useIsDesktop();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const { data, isLoading, isError, refetch } = useInventoryItems();

  const categories = useMemo(() => {
    const names = new Set<string>();
    for (const item of data ?? []) {
      if (item.category_name) names.add(item.category_name);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const filteredSorted = useMemo(() => {
    const query = search.trim().toLowerCase();
    let items = data ?? [];

    if (category !== ALL_CATEGORIES) {
      items = items.filter((item) => item.category_name === category);
    }

    if (query) {
      items = items.filter(
        (item) =>
          item.name.toLowerCase().includes(query) ||
          (item.sku?.toLowerCase().includes(query) ?? false) ||
          (item.category_name?.toLowerCase().includes(query) ?? false),
      );
    }

    const sorted = [...items];
    const sort = sorting[0];
    if (sort) {
      sorted.sort((a, b) => {
        const direction = sort.desc ? -1 : 1;
        switch (sort.id) {
          case 'name':
            return direction * a.name.localeCompare(b.name);
          case 'sku':
            return direction * compareNullableStrings(a.sku, b.sku);
          case 'category_name':
            return direction * compareNullableStrings(a.category_name, b.category_name);
          case 'base_unit_code':
            return direction * compareNullableStrings(a.base_unit_code, b.base_unit_code);
          default:
            return 0;
        }
      });
    } else {
      // Default grouping: category, then SKU, then name.
      sorted.sort(
        (a, b) =>
          compareNullableStrings(a.category_name, b.category_name) ||
          compareNullableStrings(a.sku, b.sku) ||
          a.name.localeCompare(b.name),
      );
    }

    return sorted;
  }, [data, category, search, sorting]);

  const pageStart = pagination.pageIndex * pagination.pageSize;
  const pageRows = filteredSorted.slice(pageStart, pageStart + pagination.pageSize);

  const columns: ColumnDef<InventoryItemResponse>[] = [
    {
      accessorKey: 'name',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Item" />,
    },
    ...(isDesktop
      ? [
          {
            accessorKey: 'sku',
            header: ({ column }) => <DataTableColumnHeader column={column} title="SKU" />,
            cell: ({ row }) => row.original.sku ?? '—',
          } satisfies ColumnDef<InventoryItemResponse>,
        ]
      : []),
    {
      accessorKey: 'category_name',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Category" />,
      cell: ({ row }) => <InventoryCategoryBadge category={row.original.category_name} />,
    },
    {
      accessorKey: 'base_unit_code',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Base Unit" />,
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
            router.push(`/admin/inventory/${row.original.id}`);
          }}
        >
          <Pencil className="mr-1 h-4 w-4" />
          Edit
        </Button>
      ),
    },
  ];

  const hasAnyItems = (data?.length ?? 0) > 0;
  const hasFilters = search.trim().length > 0 || category !== ALL_CATEGORIES;

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

      <div className="space-y-3">
        <SearchInput
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
          placeholder="Search by item name, SKU, or category..."
          className="max-w-sm"
        />
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
            <Button
              type="button"
              variant={category === ALL_CATEGORIES ? 'default' : 'outline'}
              size="sm"
              className="h-8 rounded-full"
              aria-pressed={category === ALL_CATEGORIES}
              onClick={() => {
                setCategory(ALL_CATEGORIES);
                setPagination((prev) => ({ ...prev, pageIndex: 0 }));
              }}
            >
              All
            </Button>
            {categories.map((name) => (
              <Button
                key={name}
                type="button"
                variant={category === name ? 'default' : 'outline'}
                size="sm"
                className={cn('h-8 rounded-full')}
                aria-pressed={category === name}
                onClick={() => {
                  setCategory(name);
                  setPagination((prev) => ({ ...prev, pageIndex: 0 }));
                }}
              >
                {name}
              </Button>
            ))}
          </div>
        )}
      </div>

      <DataTable
        columns={columns}
        data={pageRows}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        onRowClick={(item) => router.push(`/admin/inventory/${item.id}`)}
        sorting={sorting}
        onSortingChange={(next) => {
          setSorting(next);
          setPagination((prev) => ({ ...prev, pageIndex: 0 }));
        }}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={filteredSorted.length}
        emptyState={
          hasAnyItems && hasFilters ? (
            <EmptyState icon={Boxes} title="No matching items" description="Try a different search term or clear the category filter." />
          ) : (
            <EmptyState
              icon={Boxes}
              title="No inventory items yet"
              description="Create your first inventory item to start building recipes."
              action={
                <Button size="sm" onClick={() => setDialogOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Item
                </Button>
              }
            />
          )
        }
      />

      <CreateInventoryItemDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
