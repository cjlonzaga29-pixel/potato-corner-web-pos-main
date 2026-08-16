'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { FileClock } from 'lucide-react';
import type { CostCorrectionReason, InventoryCostCorrectionResponse } from '@potato-corner/shared';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatDateTime } from '@/lib/utils';
import { useBranchStore } from '@/stores/branch.store';
import { useInventoryCostCorrections } from '@/hooks/queries/use-universal-inventory';

const REASON_LABELS: Record<CostCorrectionReason, string> = {
  incorrect_receiving_cost: 'Incorrect receiving cost',
  supplier_invoice_correction: 'Supplier invoice correction',
  data_entry_mistake: 'Data-entry mistake',
  opening_balance_correction: 'Opening balance correction',
  other: 'Other',
};

/** Supervisor/Super Admin only — no equivalent route exists under (branch), enforcing the RBAC at the routing level in addition to the server-side adminOrSupervisor guard. */
export function InventoryCostCorrectionsView() {
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });

  const { data, isLoading, isError, refetch } = useInventoryCostCorrections(activeBranchId, {
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<InventoryCostCorrectionResponse>[] = [
    { id: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
    { id: 'item', header: 'Item', cell: ({ row }) => row.original.inventory_item_name },
    {
      id: 'old_unit_cost',
      header: 'Old Cost',
      cell: ({ row }) => (
        <span className="tabular-nums text-muted-foreground">
          {row.original.old_unit_cost === null ? 'Cost not initialized' : `₱${row.original.old_unit_cost.toFixed(4)}`}
        </span>
      ),
    },
    {
      id: 'new_unit_cost',
      header: 'New Cost',
      cell: ({ row }) => <span className="tabular-nums font-medium">₱{row.original.new_unit_cost.toFixed(4)}</span>,
    },
    {
      id: 'quantity_on_hand',
      header: 'Stock at Correction',
      cell: ({ row }) => <span className="tabular-nums">{row.original.quantity_on_hand}</span>,
    },
    {
      id: 'valuation_difference',
      header: 'Valuation Difference',
      cell: ({ row }) => (
        <span className={`tabular-nums font-medium ${row.original.valuation_difference < 0 ? 'text-destructive' : 'text-success'}`}>
          {row.original.valuation_difference >= 0 ? '+' : ''}₱{row.original.valuation_difference.toFixed(2)}
        </span>
      ),
    },
    { id: 'reason', header: 'Reason', cell: ({ row }) => REASON_LABELS[row.original.reason_code as CostCorrectionReason] },
    { id: 'corrected_by', header: 'Corrected By', cell: ({ row }) => row.original.corrected_by_name },
    {
      id: 'proof',
      header: 'Proof',
      cell: ({ row }) =>
        row.original.proof_url ? (
          <a href={row.original.proof_url} target="_blank" rel="noreferrer" className="text-primary underline">
            View Proof
          </a>
        ) : (
          '—'
        ),
    },
    { id: 'notes', header: 'Notes', cell: ({ row }) => row.original.notes ?? '—' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Cost Correction History</h1>
        <p className="text-sm text-muted-foreground">
          Every valuation correction, auditable — corrections change current/future carrying cost only, never past sales, COGS, or waste.
        </p>
      </div>

      {!activeBranchId ? (
        <p className="text-sm text-destructive">Select an active branch to view its cost correction history.</p>
      ) : (
        <DataTable
          columns={columns}
          data={data?.corrections ?? []}
          isLoading={isLoading}
          isError={isError}
          onRetry={() => void refetch()}
          pagination={pagination}
          onPaginationChange={setPagination}
          rowCount={data?.total ?? 0}
          emptyState={
            <EmptyState icon={FileClock} title="No cost corrections yet" description="Valuation corrections will appear here once recorded." />
          }
        />
      )}
    </div>
  );
}
