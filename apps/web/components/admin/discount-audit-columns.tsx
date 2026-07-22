'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import type { DiscountAuditRow } from '@/hooks/queries/use-discount-audit';

const DISCOUNT_TYPE_LABELS: Record<string, string> = {
  pwd: 'PWD',
  senior_citizen: 'Senior Citizen',
  employee: 'Employee',
  manager_override: 'Manager Override',
  promotional: 'Promotional',
};

export function createDiscountAuditColumns(branchNameById: Map<string, string>): ColumnDef<DiscountAuditRow>[] {
  return [
    { accessorKey: 'transactionNumber', header: 'Receipt #' },
    {
      id: 'branch',
      header: 'Branch',
      cell: ({ row }) => branchNameById.get(row.original.branchId) ?? row.original.branchId,
    },
    {
      id: 'discountType',
      header: 'Discount Type',
      cell: ({ row }) => <Badge variant="secondary">{DISCOUNT_TYPE_LABELS[row.original.discountType] ?? row.original.discountType}</Badge>,
    },
    {
      id: 'discountAmount',
      header: 'Discount Amount',
      cell: ({ row }) => formatCurrency(Number(row.original.discountAmount)),
    },
    {
      id: 'discountCustomerId',
      header: 'Customer ID',
      cell: ({ row }) => {
        const r = row.original;
        if (r.discountCustomerId) return r.discountCustomerId;
        if (r.discountCustomerIdEncrypted) return '****';
        return '—';
      },
    },
    {
      id: 'fraudFlagged',
      header: 'Fraud',
      cell: ({ row }) => (row.original.fraudFlagged ? <Badge variant="critical">Flagged</Badge> : '—'),
    },
    {
      id: 'createdAt',
      header: 'Date',
      cell: ({ row }) => formatDateTime(row.original.createdAt),
    },
  ];
}
