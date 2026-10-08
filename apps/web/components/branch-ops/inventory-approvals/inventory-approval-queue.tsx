'use client';

import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { ClipboardCheck } from 'lucide-react';
import type { InventoryApprovalRequestResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatDateTime } from '@/lib/utils';
import { useBranchStore } from '@/stores/branch.store';
import { useInventoryApprovalRealtimeSync, useInventoryApprovals, type InventoryApprovalStatusFilter } from '@/hooks/queries/use-inventory-approvals';
import { InventoryApprovalDetailDialog } from './inventory-approval-detail-dialog';

const OPERATION_LABELS: Record<string, string> = {
  RECEIVING: 'Stock In',
  ADJUSTMENT: 'Stock Adjustment',
  PHYSICAL_COUNT: 'Physical Count',
};

/**
 * Shared body behind `/branch/inventory/approvals` and
 * `/supervisor/inventory/approvals` — three separate status views (Pending
 * Review / Approved / Returned for Correction) per the approval brief. A
 * branch account sees only its own branch's requests (server-enforced,
 * see inventory-approval.service.ts#listRequests); supervisor/admin see
 * the full review queue for branches they have access to.
 */
export function InventoryApprovalQueue({ basePath: _basePath }: { basePath: string }) {
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const [status, setStatus] = useState<InventoryApprovalStatusFilter>('PENDING');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useInventoryApprovalRealtimeSync(activeBranchId);
  const { data, isLoading, isError, refetch } = useInventoryApprovals(activeBranchId, status);

  const columns: ColumnDef<InventoryApprovalRequestResponse>[] = [
    { id: 'submitted_at', header: 'Submitted At', cell: ({ row }) => formatDateTime(row.original.submitted_at) },
    { id: 'item', header: 'Item', cell: ({ row }) => row.original.item_name ?? '—' },
    { id: 'operation', header: 'Operation', cell: ({ row }) => <Badge variant="secondary">{OPERATION_LABELS[row.original.operation] ?? row.original.operation}</Badge> },
    {
      id: 'quantity',
      header: 'Quantity',
      cell: ({ row }) => {
        const r = row.original;
        const value = r.operation === 'RECEIVING' ? r.entered_quantity : r.operation === 'ADJUSTMENT' ? r.quantity_delta : r.counted_quantity;
        return <span className="tabular-nums">{value ?? '—'}</span>;
      },
    },
    { id: 'submitted_by', header: 'Recorded By', cell: ({ row }) => row.original.submitted_by_name ?? '—' },
    ...(status === 'APPROVED'
      ? [
          { id: 'reviewed_by', header: 'Approved By', cell: ({ row }: { row: { original: InventoryApprovalRequestResponse } }) => row.original.reviewed_by_name ?? '—' },
          { id: 'reviewed_at', header: 'Approved At', cell: ({ row }: { row: { original: InventoryApprovalRequestResponse } }) => (row.original.reviewed_at ? formatDateTime(row.original.reviewed_at) : '—') },
        ]
      : []),
    ...(status === 'RETURNED'
      ? [{ id: 'return_reason', header: 'Return Reason', cell: ({ row }: { row: { original: InventoryApprovalRequestResponse } }) => row.original.return_reason ?? '—' }]
      : []),
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <Button variant="ghost" size="sm" onClick={() => setSelectedId(row.original.id)}>
          View
        </Button>
      ),
    },
  ];

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch to view its inventory approvals.</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Inventory Approvals</h1>
        <p className="text-sm text-muted-foreground">Manual Stock In, Adjustments, and Physical Counts require supervisor review before they change stock.</p>
      </div>

      <Tabs value={status} onValueChange={(v) => setStatus(v as InventoryApprovalStatusFilter)}>
        <TabsList>
          <TabsTrigger value="PENDING">Pending Review</TabsTrigger>
          <TabsTrigger value="APPROVED">Approved</TabsTrigger>
          <TabsTrigger value="RETURNED">Returned for Correction</TabsTrigger>
        </TabsList>
      </Tabs>

      <DataTable
        columns={columns}
        data={data?.requests ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        emptyState={<EmptyState icon={ClipboardCheck} title="Nothing here" description="Requests in this status will appear here." />}
      />

      <InventoryApprovalDetailDialog id={selectedId} onOpenChange={(open) => !open && setSelectedId(null)} branchId={activeBranchId} />
    </div>
  );
}
