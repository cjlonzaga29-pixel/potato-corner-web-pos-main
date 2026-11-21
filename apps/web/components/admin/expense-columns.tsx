'use client';

import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { expenseDisplayName } from '@potato-corner/shared';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { ExpenseRow } from '@/hooks/queries/use-expenses';

const CATEGORY_BADGE_VARIANTS: Record<string, BadgeProps['variant']> = {
  utilities: 'pending',
  supplies: 'active',
  staff_meals: 'warning',
  miscellaneous: 'inactive',
};

export function createExpenseColumns(onViewReceipt: (expense: ExpenseRow) => void): ColumnDef<ExpenseRow>[] {
  return [
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
    id: 'expense_type',
    header: 'Type',
    cell: ({ row }) => {
      const { expense_type_id: typeId, expense_type_name: recorded, expense_type_current_name: current, category } = row.original;
      return (
        <span className="inline-flex flex-col items-start gap-0.5">
          {/* A typed expense's category is only a placeholder, so it never picks the color. */}
          <Badge variant={typeId ? 'secondary' : (CATEGORY_BADGE_VARIANTS[category] ?? 'secondary')}>{expenseDisplayName(row.original)}</Badge>
          {typeId && current && current !== recorded && <span className="text-xs text-muted-foreground">now called {current}</span>}
        </span>
      );
    },
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
    id: 'proof',
    header: 'Proof',
    cell: ({ row }) =>
      row.original.receipt_url ? (
        <button
          type="button"
          onClick={() => onViewReceipt(row.original)}
          className="text-primary underline underline-offset-2 hover:no-underline"
        >
          Yes · View Receipt
        </button>
      ) : (
        <span className="text-xs text-muted-foreground">No Proof</span>
      ),
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
}
