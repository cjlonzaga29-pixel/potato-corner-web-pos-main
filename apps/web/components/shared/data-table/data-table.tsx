'use client';

import type { ReactNode } from 'react';
import {
  type ColumnDef,
  type ColumnFiltersState,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  type Updater,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LoadingSpinner } from '../feedback/loading-spinner';
import { ErrorState } from '../feedback/error-state';
import { EmptyState } from '../feedback/empty-state';
import { DataTablePagination } from './data-table-pagination';

function resolveUpdater<T>(updater: Updater<T>, current: T): T {
  return typeof updater === 'function' ? (updater as (old: T) => T)(current) : updater;
}

export interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  pagination?: PaginationState;
  onPaginationChange?: (pagination: PaginationState) => void;
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  filtering?: ColumnFiltersState;
  onFilteringChange?: (filtering: ColumnFiltersState) => void;
  rowCount?: number;
  emptyState?: ReactNode;
  toolbar?: ReactNode;
  enableRowSelection?: boolean;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (selection: RowSelectionState) => void;
  columnVisibility?: VisibilityState;
  onColumnVisibilityChange?: (visibility: VisibilityState) => void;
  onRowClick?: (row: TData) => void;
}

/**
 * Generic server-side DataTable: this component never fetches or filters
 * data itself (manualPagination/Sorting/Filtering are always on) — the
 * caller owns state and passes it back down, matching how every list
 * screen in this app talks to TanStack Query.
 */
export function DataTable<TData, TValue>({
  columns,
  data,
  isLoading,
  isError,
  onRetry,
  pagination,
  onPaginationChange,
  sorting,
  onSortingChange,
  filtering,
  onFilteringChange,
  rowCount,
  emptyState,
  toolbar,
  enableRowSelection = false,
  rowSelection,
  onRowSelectionChange,
  columnVisibility,
  onColumnVisibilityChange,
  onRowClick,
}: DataTableProps<TData, TValue>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    enableRowSelection,
    rowCount,
    state: {
      pagination,
      sorting,
      columnFilters: filtering,
      // TanStack Table only applies its own default state for a key when
      // that key is entirely absent from `state` — explicitly listing it
      // as `undefined` (the caller-omitted case for every list page that
      // doesn't use row selection) instead overrides the default and
      // leaves internals like row.getIsSelected() reading a property off
      // undefined. Default here so the "row selection not used" case is
      // still a real, if empty, object.
      rowSelection: rowSelection ?? {},
      columnVisibility: columnVisibility ?? {},
    },
    onPaginationChange: onPaginationChange
      ? (updater) => onPaginationChange(resolveUpdater(updater, pagination ?? { pageIndex: 0, pageSize: 10 }))
      : undefined,
    onSortingChange: onSortingChange ? (updater) => onSortingChange(resolveUpdater(updater, sorting ?? [])) : undefined,
    onColumnFiltersChange: onFilteringChange
      ? (updater) => onFilteringChange(resolveUpdater(updater, filtering ?? []))
      : undefined,
    onRowSelectionChange: onRowSelectionChange
      ? (updater) => onRowSelectionChange(resolveUpdater(updater, rowSelection ?? {}))
      : undefined,
    onColumnVisibilityChange: onColumnVisibilityChange
      ? (updater) => onColumnVisibilityChange(resolveUpdater(updater, columnVisibility ?? {}))
      : undefined,
  });

  const rows = table.getRowModel().rows;

  return (
    <div className="space-y-4">
      {toolbar}
      <div className="relative rounded-md border">
        {isLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60">
            <LoadingSpinner size="lg" />
          </div>
        )}
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isError ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-40 p-0">
                  <ErrorState retry={onRetry} />
                </TableCell>
              </TableRow>
            ) : !isLoading && rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-40 p-0">
                  {emptyState ?? <EmptyState title="No results" description="There's nothing to show here yet." />}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? 'selected' : undefined}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  className={onRowClick ? 'cursor-pointer' : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {pagination && onPaginationChange && (
        <DataTablePagination table={table} rowCount={rowCount ?? data.length} isLoading={isLoading} />
      )}
    </div>
  );
}
