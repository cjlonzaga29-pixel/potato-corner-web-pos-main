import type { ColumnDef } from '@tanstack/react-table';
import { Eye, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatCurrency } from '@/lib/utils';
import { StatusBadge } from '../status-badge';
import { DataTableColumnHeader } from './data-table-column-header';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** DD MMM YYYY — a distinct display order from lib/utils.ts formatDate ("Jan 15, 2025"), used specifically for table cells. */
function formatDDMMMYYYY(date: Date): string {
  return `${String(date.getDate()).padStart(2, '0')} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function formatDDMMMYYYYHHmm(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${formatDDMMMYYYY(date)} ${hh}:${mm}`;
}

export function createSelectColumn<TData>(): ColumnDef<TData> {
  return {
    id: 'select',
    header: ({ table }) => (
      <Checkbox
        checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() ? 'indeterminate' : false)}
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label="Select row"
      />
    ),
    enableSorting: false,
    enableHiding: false,
  };
}

interface RowActions<TData> {
  onView?: (row: TData) => void;
  onEdit?: (row: TData) => void;
  onDelete?: (row: TData) => void;
}

export function createActionsColumn<TData>(actions: RowActions<TData>): ColumnDef<TData> {
  return {
    id: 'actions',
    enableSorting: false,
    enableHiding: false,
    cell: ({ row }) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Row actions">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {actions.onView && (
            <DropdownMenuItem onClick={() => actions.onView?.(row.original)}>
              <Eye className="mr-2 h-4 w-4" />
              View
            </DropdownMenuItem>
          )}
          {actions.onEdit && (
            <DropdownMenuItem onClick={() => actions.onEdit?.(row.original)}>
              <Pencil className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
          )}
          {actions.onDelete && (
            <DropdownMenuItem
              onClick={() => actions.onDelete?.(row.original)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  };
}

export function createDateColumn<TData>(accessorKey: keyof TData & string, header: string): ColumnDef<TData> {
  return {
    accessorKey,
    header: ({ column }) => <DataTableColumnHeader column={column} title={header} />,
    cell: ({ getValue }) => {
      const value = getValue() as string | Date | null | undefined;
      return value ? formatDDMMMYYYY(new Date(value)) : '—';
    },
  };
}

export function createDateTimeColumn<TData>(accessorKey: keyof TData & string, header: string): ColumnDef<TData> {
  return {
    accessorKey,
    header: ({ column }) => <DataTableColumnHeader column={column} title={header} />,
    cell: ({ getValue }) => {
      const value = getValue() as string | Date | null | undefined;
      return value ? formatDDMMMYYYYHHmm(new Date(value)) : '—';
    },
  };
}

export function createCurrencyColumn<TData>(accessorKey: keyof TData & string, header: string): ColumnDef<TData> {
  return {
    accessorKey,
    header: ({ column }) => <DataTableColumnHeader column={column} title={header} />,
    cell: ({ getValue }) => {
      const value = getValue() as number | null | undefined;
      return <span className="tabular-nums">{formatCurrency(value ?? 0)}</span>;
    },
  };
}

export function createStatusColumn<TData>(
  accessorKey: keyof TData & string,
  header: string,
  type?: Parameters<typeof StatusBadge>[0]['type'],
): ColumnDef<TData> {
  return {
    accessorKey,
    header: ({ column }) => <DataTableColumnHeader column={column} title={header} />,
    cell: ({ getValue }) => {
      const value = getValue() as string;
      return <StatusBadge status={value} type={type} />;
    },
  };
}

export function createBadgeColumn<TData>(accessorKey: keyof TData & string, header: string): ColumnDef<TData> {
  return {
    accessorKey,
    header: ({ column }) => <DataTableColumnHeader column={column} title={header} />,
    cell: ({ getValue }) => <Badge variant="secondary">{String(getValue() ?? '')}</Badge>,
  };
}
