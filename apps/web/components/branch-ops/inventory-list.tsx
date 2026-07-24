'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRightLeft, ClipboardList, History, Loader2, MinusCircle, Pencil, Plus, PlusCircle, TriangleAlert } from 'lucide-react';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import type { BranchInventoryRow, IngredientResponse, InventoryRequestResponse, SubmitInventoryRequestInput } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DataTable } from '@/components/shared/data-table';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useBranchStore } from '@/stores/branch.store';
import { useBranchInventory, useBranchInventoryAlerts, useIngredients, useInventoryRealtimeSync } from '@/hooks/queries/use-inventory';
import { IngredientDialog } from '@/components/supervisor/inventory/ingredient-dialog';
import { apiClient } from '@/lib/api-client';
import { useSocket } from '@/hooks/use-socket';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

function useCreateInventoryRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitInventoryRequestInput) => {
      const response = await apiClient<InventoryRequestResponse>('/api/inventory-requests', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to submit inventory request'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory-requests', 'pending'] });
      toast.success('Inventory request submitted');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

function InventoryRequestDialog({
  branchId,
  ingredient,
  type,
  onOpenChange,
}: {
  branchId: string;
  ingredient: BranchInventoryRow;
  type: 'stock_in' | 'stock_out';
  onOpenChange: (open: boolean) => void;
}) {
  const createRequest = useCreateInventoryRequest();
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const quantityValue = Number(quantity);
  const invalid = !quantity || !(quantityValue > 0) || reason.trim().length < 3;

  async function handleSubmit() {
    if (invalid) return;
    await createRequest.mutateAsync({
      branchId,
      ingredientId: ingredient.ingredient_id,
      type,
      quantity: quantityValue,
      reason: reason.trim(),
    });
    onOpenChange(false);
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{type === 'stock_in' ? 'Request Stock In' : 'Request Stock Out'}</DialogTitle>
          <DialogDescription>{ingredient.name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="inventory-request-quantity">
              Quantity<span className="ml-0.5 text-destructive">*</span>
            </Label>
            <Input
              id="inventory-request-quantity"
              type="number"
              step="any"
              min="0"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="inventory-request-reason">
              Reason<span className="ml-0.5 text-destructive">*</span>
            </Label>
            <Textarea
              id="inventory-request-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Reason for this request"
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" disabled={createRequest.isPending || invalid} onClick={() => void handleSubmit()}>
            {createRequest.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit Request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shared body behind both `/supervisor/inventory` and `/branch/inventory` —
 * `basePath` is the only thing that differs between the two routes (their
 * page.tsx wrappers pass "/supervisor" or "/branch"), everything else
 * (data, mutations, dialogs) is the single copy of the real logic.
 */
export function InventoryList({ basePath }: { basePath: string }) {
  const router = useRouter();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  useInventoryRealtimeSync(activeBranchId);
  const { data, isLoading, isError, refetch } = useBranchInventory(activeBranchId);
  const { data: alertsData } = useBranchInventoryAlerts(activeBranchId);
  const { data: ingredients } = useIngredients(activeBranchId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingIngredient, setEditingIngredient] = useState<IngredientResponse | null>(null);
  const [requestDialog, setRequestDialog] = useState<{ ingredient: BranchInventoryRow; type: 'stock_in' | 'stock_out' } | null>(null);

  const { on, off } = useSocket();
  useEffect(() => {
    function handleApproved(payload: unknown) {
      const req = payload as InventoryRequestResponse;
      toast.success(`Inventory request approved: ${req.ingredientName}`);
    }
    function handleRejected(payload: unknown) {
      const req = payload as InventoryRequestResponse;
      toast.error(`Inventory request rejected: ${req.ingredientName}`);
    }
    on(SOCKET_EVENTS.INVENTORY_REQUEST_APPROVED, handleApproved);
    on(SOCKET_EVENTS.INVENTORY_REQUEST_REJECTED, handleRejected);
    return () => {
      off(SOCKET_EVENTS.INVENTORY_REQUEST_APPROVED, handleApproved);
      off(SOCKET_EVENTS.INVENTORY_REQUEST_REJECTED, handleRejected);
    };
  }, [on, off]);

  function openCreateDialog() {
    setEditingIngredient(null);
    setDialogOpen(true);
  }

  function openEditDialog(ingredientId: string) {
    setEditingIngredient(ingredients?.find((i) => i.id === ingredientId) ?? null);
    setDialogOpen(true);
  }

  const alertCount = alertsData?.alerts.length ?? 0;
  const criticalCount = alertsData?.alerts.filter((a) => a.severity === 'critical').length ?? 0;

  const columns: ColumnDef<BranchInventoryRow>[] = [
    { accessorKey: 'name', header: 'Ingredient' },
    { accessorKey: 'unit', header: 'Unit' },
    {
      id: 'current_stock',
      header: 'Current Stock',
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.current_stock} {row.original.unit}
        </span>
      ),
    },
    {
      id: 'low_stock_threshold',
      header: 'Low / Critical',
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground tabular-nums">
          {row.original.low_stock_threshold} / {row.original.critical_threshold}
        </span>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => <StatusBadge status={row.original.status} type="inventory" />,
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`${basePath}/inventory/stock-in?ingredient_id=${row.original.ingredient_id}`)}
          >
            <PlusCircle className="mr-1 h-4 w-4" />
            Stock In
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`${basePath}/inventory/adjust?ingredient_id=${row.original.ingredient_id}`)}
          >
            Adjust
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`${basePath}/inventory/waste?ingredient_id=${row.original.ingredient_id}`)}
          >
            <MinusCircle className="mr-1 h-4 w-4" />
            Waste
          </Button>
          <Button variant="ghost" size="sm" onClick={() => openEditDialog(row.original.ingredient_id)}>
            <Pencil className="mr-1 h-4 w-4" />
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRequestDialog({ ingredient: row.original, type: 'stock_in' })}>
            Request Stock In
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRequestDialog({ ingredient: row.original, type: 'stock_out' })}>
            Request Stock Out
          </Button>
        </div>
      ),
    },
  ];

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch to view its inventory.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Inventory</h1>
          <p className="text-sm text-muted-foreground">Current stock levels, derived from every recorded movement.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => router.push(`${basePath}/inventory/transfer`)}>
            <ArrowRightLeft className="mr-2 h-4 w-4" />
            Transfer
          </Button>
          <Button variant="outline" onClick={() => router.push(`${basePath}/inventory/movements`)}>
            <History className="mr-2 h-4 w-4" />
            Movements
          </Button>
          <Button variant="outline" onClick={() => router.push(`${basePath}/inventory/count`)}>
            <ClipboardList className="mr-2 h-4 w-4" />
            Physical Count
          </Button>
          <Button onClick={openCreateDialog} disabled={!activeBranchId}>
            <Plus className="mr-2 h-4 w-4" />
            Create Ingredient
          </Button>
        </div>
      </div>

      {alertCount > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <TriangleAlert className="h-4 w-4 shrink-0 text-destructive" />
          <span>
            {alertCount} ingredient{alertCount === 1 ? '' : 's'} at or below the low-stock threshold
            {criticalCount > 0 && (
              <>
                {' '}
                — <Badge variant="critical">{criticalCount} critical</Badge>
              </>
            )}
          </span>
        </div>
      )}

      <DataTable
        columns={columns}
        data={data?.ingredients ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        emptyState={
          <EmptyState
            icon={ArrowRightLeft}
            title="No ingredients yet"
            description="Ingredients are created by an admin — once added, their stock movements appear here."
          />
        }
      />

      <IngredientDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        branchId={activeBranchId}
        ingredient={editingIngredient}
      />

      {requestDialog && (
        <InventoryRequestDialog
          branchId={activeBranchId}
          ingredient={requestDialog.ingredient}
          type={requestDialog.type}
          onOpenChange={(open) => !open && setRequestDialog(null)}
        />
      )}
    </div>
  );
}
