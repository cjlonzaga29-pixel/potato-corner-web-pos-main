'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ColumnDef } from '@tanstack/react-table';
import { ClipboardList, Loader2 } from 'lucide-react';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import type { InventoryRequestResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatDateTime } from '@/lib/utils';
import { apiClient } from '@/lib/api-client';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';

const PENDING_KEY = ['inventory-requests', 'pending'];
const TYPE_LABEL: Record<string, string> = { stock_in: 'Stock In', stock_out: 'Stock Out' };

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

function usePendingInventoryRequests() {
  return useQuery({
    queryKey: PENDING_KEY,
    queryFn: async () => {
      const response = await apiClient<{ requests: InventoryRequestResponse[] }>('/api/inventory-requests/pending');
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load inventory requests'));
      return response.data;
    },
    staleTime: 30 * 1000,
  });
}

function useApproveInventoryRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await apiClient<InventoryRequestResponse>(`/api/inventory-requests/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ requestId: id }),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to approve request'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PENDING_KEY });
      toast.success('Inventory request approved');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

function useRejectInventoryRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, rejectionReason }: { id: string; rejectionReason: string }) => {
      const response = await apiClient<InventoryRequestResponse>(`/api/inventory-requests/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ requestId: id, rejectionReason }),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to reject request'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PENDING_KEY });
      toast.success('Inventory request rejected');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

function RejectDialog({ request, onOpenChange }: { request: InventoryRequestResponse; onOpenChange: (open: boolean) => void }) {
  const reject = useRejectInventoryRequest();
  const [reason, setReason] = useState('');
  const tooShort = reason.trim().length < 3;

  async function handleReject() {
    if (tooShort) return;
    await reject.mutateAsync({ id: request.id, rejectionReason: reason.trim() });
    onOpenChange(false);
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reject Inventory Request</DialogTitle>
          <DialogDescription>
            {request.branchName} — {request.ingredientName}
          </DialogDescription>
        </DialogHeader>

        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Reason for rejection" />
        {reason.length > 0 && tooShort && <p className="text-xs text-destructive">Reason must be at least 3 characters.</p>}

        <DialogFooter>
          <Button type="button" variant="destructive" disabled={reject.isPending || tooShort} onClick={() => void handleReject()}>
            {reject.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SupervisorInventoryRequestsPage() {
  const { data, isLoading, isError, refetch } = usePendingInventoryRequests();
  const approve = useApproveInventoryRequest();
  const [rejecting, setRejecting] = useState<InventoryRequestResponse | null>(null);

  useRealtimeInvalidate(
    [SOCKET_EVENTS.INVENTORY_REQUEST_SUBMITTED, SOCKET_EVENTS.INVENTORY_REQUEST_APPROVED, SOCKET_EVENTS.INVENTORY_REQUEST_REJECTED],
    [PENDING_KEY],
  );

  const requests = data?.requests ?? [];

  const columns: ColumnDef<InventoryRequestResponse>[] = [
    { id: 'branchName', header: 'Branch', cell: ({ row }) => row.original.branchName },
    { id: 'ingredientName', header: 'Ingredient', cell: ({ row }) => row.original.ingredientName },
    {
      id: 'type',
      header: 'Type',
      cell: ({ row }) => (
        <Badge variant={row.original.type === 'stock_in' ? 'active' : 'warning'}>
          {TYPE_LABEL[row.original.type] ?? row.original.type}
        </Badge>
      ),
    },
    { id: 'quantity', header: 'Quantity', cell: ({ row }) => row.original.quantity },
    {
      id: 'reason',
      header: 'Reason',
      cell: ({ row }) => <span className="line-clamp-1 max-w-xs text-muted-foreground">{row.original.reason}</span>,
    },
    { id: 'requestedByName', header: 'Requested By', cell: ({ row }) => row.original.requestedByName },
    { id: 'createdAt', header: 'Date', cell: ({ row }) => formatDateTime(row.original.createdAt) },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <div className="flex gap-2">
          <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate(row.original.id)}>
            Approve
          </Button>
          <Button size="sm" variant="destructive" onClick={() => setRejecting(row.original)}>
            Reject
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Inventory Requests</h1>
        <p className="text-sm text-muted-foreground">Pending stock in/out requests awaiting your approval.</p>
      </div>

      <DataTable
        columns={columns}
        data={requests}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        emptyState={
          <EmptyState
            icon={ClipboardList}
            title="No pending requests"
            description="There are no inventory requests awaiting approval."
          />
        }
      />

      {rejecting && <RejectDialog request={rejecting} onOpenChange={(open) => !open && setRejecting(null)} />}
    </div>
  );
}
