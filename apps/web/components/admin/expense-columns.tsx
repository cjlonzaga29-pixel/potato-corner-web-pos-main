'use client';

import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { ExpenseRow } from '@/hooks/queries/use-expenses';

const CATEGORY_LABELS: Record<string, string> = {
  utilities: 'Utilities',
  supplies: 'Supplies',
  staff_meals: 'Staff Meals',
  miscellaneous: 'Miscellaneous',
};

const CATEGORY_BADGE_VARIANTS: Record<string, BadgeProps['variant']> = {
  utilities: 'pending',
  supplies: 'active',
  staff_meals: 'warning',
  miscellaneous: 'inactive',
};

export const expenseColumns: ColumnDef<ExpenseRow>[] = [
  {
    id: 'incurredAt',
    header: 'Date',
    cell: ({ row }) => formatDate(row.original.incurred_at),
  },
  {
    id: 'branch',
    header: 'Branch',
    cell: ({ row }) => row.original.branch_name,
  },
  {
    id: 'category',
    header: 'Category',
    cell: ({ row }) => (
      <Badge variant={CATEGORY_BADGE_VARIANTS[row.original.category] ?? 'secondary'}>
        {CATEGORY_LABELS[row.original.category] ?? row.original.category}
      </Badge>
    ),
  },
  {
    id: 'vendorName',
    header: 'Vendor',
    cell: ({ row }) => row.original.vendor_name ?? '—',
  },
  {
    id: 'amount',
    header: () => <div className="text-right">Amount</div>,
    cell: ({ row }) => <div className="text-right">{formatCurrency(row.original.amount)}</div>,
  },
  {
    id: 'createdByName',
    header: 'Recorded By',
    cell: ({ row }) => row.original.created_by_name,
  },
  {
    id: 'actions',
    header: '',
    cell: ({ row }) => (
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/admin/expenses/${row.original.id}`}>View</Link>
      </Button>
    ),
  },
];
