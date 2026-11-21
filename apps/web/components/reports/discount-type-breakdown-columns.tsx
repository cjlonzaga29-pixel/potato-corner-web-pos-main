'use client';

import type { ColumnDef } from '@tanstack/react-table';
import type { DiscountComplianceReportRow } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';
import { discountRowName } from '@/lib/discount-report';

interface DiscountBreakdownColumnOptions {
  showBranch: boolean;
  /** Proof counts follow the report's existing permission model: Supervisor and Super Admin only. */
  showProof: boolean;
  onViewTransactions?: (row: DiscountComplianceReportRow) => void;
}

/** POS-PERF-P59 — one row per discount type actually sold, from the saved sales. */
export function getDiscountBreakdownColumns({ showBranch, showProof, onViewTransactions }: DiscountBreakdownColumnOptions): ColumnDef<DiscountComplianceReportRow>[] {
  const columns: ColumnDef<DiscountComplianceReportRow>[] = [
    ...(showBranch ? [{ accessorKey: 'branch_name', header: 'Branch' } satisfies ColumnDef<DiscountComplianceReportRow>] : []),
    {
      id: 'discount_type',
      header: 'Discount Type',
      cell: ({ row }) => {
        const otherNames = row.original.discount_other_names ?? [];
        return (
          <div>
            <span className="font-medium">{discountRowName(row.original)}</span>
            {otherNames.length > 0 && <span className="block text-xs text-muted-foreground">Also saved as: {otherNames.join(', ')}</span>}
          </div>
        );
      },
    },
    { accessorKey: 'transaction_count', header: 'Transactions' },
    { accessorKey: 'total_discount_amount', header: 'Discount Amount', cell: ({ row }) => formatCurrency(row.original.total_discount_amount) },
  ];
  if (showProof) {
    columns.push(
      { id: 'proof_required', header: 'Proof Required', cell: ({ row }) => row.original.proof_required_count ?? 0 },
      { id: 'proof_available', header: 'Proof Available', cell: ({ row }) => row.original.proof_available_count ?? 0 },
      { id: 'proof_missing', header: 'Proof Missing', cell: ({ row }) => row.original.proof_missing_count ?? 0 },
      {
        id: 'proof_completion',
        header: 'Proof Completion',
        cell: ({ row }) => (row.original.proof_completion_percent == null ? 'N/A' : `${row.original.proof_completion_percent}%`),
      },
    );
  }
  if (onViewTransactions) {
    columns.push({
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => (
        <Button type="button" variant="outline" size="sm" onClick={() => onViewTransactions(row.original)}>
          View Transactions
        </Button>
      ),
    });
  }
  return columns;
}
