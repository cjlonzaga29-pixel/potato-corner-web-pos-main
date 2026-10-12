'use client';

import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { ClipboardCheck, Loader2 } from 'lucide-react';
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
  WASTE: 'Waste',
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
  const { data, isLoading, isFetching, isError, refetch } = useInventoryApprovals(activeBranchId, status);

  const columns: ColumnDef<InventoryApprovalRequestResponse>[] = [
    { id: 'submitted_at', header: 'Submitted At', cell: ({ row }) => formatDateTime(row.original.submitted_at) },
    { id: 'item', header: 'Item', cell: ({ row }) => row.original.item_name ?? '—' },
    { id: 'operation', header: 'Operation', cell: ({ row }) => <Badge variant="secondary">{OPERATION_LABELS[row.original.operation] ?? row.original.operation}</Badge> },
    {
      // POS-PERF-P31 — a request's own status never implies a stock delta by
      // itself: Pending/Returned/Cancelled never apply one, and even an
      // Approved zero-variance physical count applies none (see
      // applyApprovedRequest's placeholder movementId in
      // inventory-approval.service.ts). Read from the server-computed
      // stock_changed flag, never re-derived from applied_movement_id's
      // truthiness/equality on the client.
      id: 'stock_change',
      header: 'Stock Change',
      cell: ({ row }) => {
        const r = row.original;
        if (r.stock_changed) return <Badge variant="active">Applied</Badge>;
        if (r.status === 'APPROVED') return <span className="text-xs text-muted-foreground">No quantity change</span>;
        return <span className="text-xs text-muted-foreground">No stock change</span>;
      },
    },
    {
      id: 'quantity',
      header: 'Quantity',
      cell: ({ row }) => {
        const r = row.original;
        const value =
          r.operation === 'RECEIVING' || r.operation === 'WASTE' ? r.entered_quantity : r.operation === 'ADJUSTMENT' ? r.quantity_delta : r.counted_quantity;
        return <span className="tabular-nums">{value ?? '—'}</span>;
      },
    },
    { id: 'recorded_by', header: 'Recorded By', cell: ({ row }) => row.original.submitted_by_name ?? 'Not recorded' },
    // POS-PERF-P33R — responsible_staff_name/pin_verified_at (Identity
    // Status column below) are a verified identity, resolved from a PIN
    // token; staff_involved_name is separate, free-text, and never implies
    // verification — these must never be shown as the same column.
    { id: 'staff_involved', header: 'Staff Involved (reported)', cell: ({ row }) => row.original.staff_involved_name ?? '—' },
    {
      id: 'pin_verified',
      header: 'Identity Status',
      cell: ({ row }) =>
        row.original.pin_verified_at ? (
          <Badge variant="active">PIN Verified</Badge>
        ) : row.original.responsible_staff_name ? (
          <Badge variant="secondary">Not PIN verified</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    ...(status === 'APPROVED'
      ? [
          { id: 'reviewed_by', header: 'Reviewed By', cell: ({ row }: { row: { original: InventoryApprovalRequestResponse } }) => row.original.reviewed_by_name ?? '—' },
          { id: 'reviewed_at', header: 'Approved At', cell: ({ row }: { row: { original: InventoryApprovalRequestResponse } }) => (row.original.reviewed_at ? formatDateTime(row.original.reviewed_at) : '—') },
        ]
      : []),
    ...(status === 'RETURNED'
      ? [{ id: 'return_reason', header: 'Return Reason', cell: ({ row }: { row: { original: InventoryApprovalRequestResponse } }) => row.original.return_reason ?? '—' }]
      : []),
    ...(status === 'CANCELLED'
      ? [
          { id: 'cancel_reason', header: 'Cancel Reason', cell: ({ row }: { row: { original: InventoryApprovalRequestResponse } }) => row.original.cancel_reason ?? '—' },
          { id: 'cancelled_by', header: 'Cancelled By', cell: ({ row }: { row: { original: InventoryApprovalRequestResponse } }) => row.original.cancelled_by_name ?? '—' },
        ]
      : []),
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <Button variant="ghost" size="sm" onClick={() => setSelectedId(row.original.id)}>
          Review
        </Button>
      ),
    },
  ];

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch to view its inventory approvals.</p>;
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">Manual Stock In, Adjustments, and Physical Counts require supervisor review before they change stock.</p>

      <Tabs value={status} onValueChange={(v) => setStatus(v as InventoryApprovalStatusFilter)}>
        <TabsList>
          <TabsTrigger value="PENDING">Pending Review</TabsTrigger>
          <TabsTrigger value="APPROVED">Approved</TabsTrigger>
          <TabsTrigger value="RETURNED">Returned for Correction</TabsTrigger>
          <TabsTrigger value="CANCELLED">Cancelled</TabsTrigger>
        </TabsList>
      </Tabs>

      {isFetching && !isLoading && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Updating…
        </span>
      )}

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
