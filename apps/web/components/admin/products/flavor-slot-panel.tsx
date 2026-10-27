'use client';

import { useState } from 'react';
import { Plus, Pencil, Trash2, X, Loader2 } from 'lucide-react';
import type { FlavorSlotResponse } from '@potato-corner/shared';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useFlavorSlots, useRemoveFlavorSlot, useRemoveSnackOption } from '@/hooks/queries/use-flavor-slots';
import { FlavorSlotFormDialog } from './flavor-slot-form-dialog';
import { SnackOptionFormDialog } from './snack-option-form-dialog';

interface FlavorSlotPanelProps {
  productId: string;
  variantId: string;
  variantLabel: string;
  /** products.service.ts's performSlotEditWithActiveGovernance requires a reason on an ACTIVE variant. */
  lifecycleStatus: string | null;
}

/**
 * POS-PERF-P36R — Mix & Max slot editor, reached from the builder's Choices
 * step. Was previously unreachable from any UI at all: the backing
 * ProductFlavorSlot/ProductFlavorSlotSnackOption CRUD existed in
 * products.service.ts (CR-005 Sub-phase 3d) but had no HTTP route until this
 * phase (see products.router.ts). "Required configuration" here means at
 * least one snack option per required slot — productReadinessService
 * already blocks "Add to POS" for a required slot with zero active snack
 * options, so this panel's job is just to make reaching that state possible.
 */
export function FlavorSlotPanel({ productId, variantId, variantLabel, lifecycleStatus }: FlavorSlotPanelProps) {
  const { data: slots, isLoading, isError, refetch } = useFlavorSlots(productId, variantId);
  const removeSlot = useRemoveFlavorSlot(productId, variantId);
  const requiresReason = lifecycleStatus === 'ACTIVE';

  const [slotDialog, setSlotDialog] = useState<{ open: boolean; slot?: FlavorSlotResponse }>({ open: false });
  const [snackDialogSlotId, setSnackDialogSlotId] = useState<string | null>(null);
  const [deletingSlot, setDeletingSlot] = useState<FlavorSlotResponse | null>(null);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Mix &amp; Max Slots</CardTitle>
          <CardDescription>
            Optional — only for a size that lets the customer pick from other snacks (e.g. &quot;choose
            2 flavors&quot;). Skip for a plain single-flavor or flavor-less size.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setSlotDialog({ open: true })}>
          <Plus className="mr-2 h-4 w-4" />
          Add Slot
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <LoadingSpinner />
          </div>
        ) : isError ? (
          <ErrorState retry={() => void refetch()} />
        ) : !slots || slots.length === 0 ? (
          <EmptyState title="No Mix & Max slots" description="This size sells as-is with no slot-based choices." />
        ) : (
          slots
            .sort((a, b) => a.slot_index - b.slot_index)
            .map((slot) => (
              <SlotRow
                key={slot.id}
                productId={productId}
                variantId={variantId}
                slot={slot}
                requiresReason={requiresReason}
                onEdit={() => setSlotDialog({ open: true, slot })}
                onDelete={() => setDeletingSlot(slot)}
                onAddSnackOption={() => setSnackDialogSlotId(slot.id)}
              />
            ))
        )}
      </CardContent>

      <FlavorSlotFormDialog
        open={slotDialog.open}
        onOpenChange={(open) => setSlotDialog((prev) => ({ ...prev, open }))}
        productId={productId}
        variantId={variantId}
        slot={slotDialog.slot}
        requiresReason={requiresReason}
      />

      {snackDialogSlotId && (
        <SnackOptionFormDialog
          open
          onOpenChange={(open) => !open && setSnackDialogSlotId(null)}
          productId={productId}
          variantId={variantId}
          slotId={snackDialogSlotId}
          excludeSnackVariantIds={(slots ?? []).find((s) => s.id === snackDialogSlotId)?.snack_options.map((o) => o.snack_product_variant_id) ?? []}
          requiresReason={requiresReason}
        />
      )}

      {deletingSlot && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeletingSlot(null)}
          title={`Remove ${deletingSlot.label}?`}
          description={`Removing this slot also removes its snack-option list for ${variantLabel}. This cannot be undone.`}
          confirmLabel="Remove"
          variant="danger"
          onConfirm={async () => {
            await removeSlot.mutateAsync(deletingSlot.id);
          }}
        />
      )}
    </Card>
  );
}

function SlotRow({
  productId,
  variantId,
  slot,
  requiresReason,
  onEdit,
  onDelete,
  onAddSnackOption,
}: {
  productId: string;
  variantId: string;
  slot: FlavorSlotResponse;
  requiresReason: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onAddSnackOption: () => void;
}) {
  const removeSnackOption = useRemoveSnackOption(productId, variantId, slot.id);

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium">
            {slot.label} <span className="text-muted-foreground text-xs">— {slot.flavor_qty} {slot.unit}</span>
          </p>
          <Badge variant={slot.required ? 'active' : 'outline'} className="mt-1">
            {slot.required ? 'Required' : 'Optional'}
          </Badge>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="mt-2 space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">Snack options</p>
          <Button size="sm" variant="ghost" onClick={onAddSnackOption}>
            <Plus className="mr-1 h-3 w-3" />
            Add
          </Button>
        </div>
        {slot.snack_options.length === 0 ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {slot.required
              ? 'No snack options yet — this slot blocks "Add to POS" until at least one is added.'
              : 'No snack options yet.'}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {slot.snack_options.map((option) => (
              <Badge key={option.id} variant="outline" className="gap-1">
                {option.snack_variant_name ?? option.snack_product_variant_id.slice(0, 8)}
                <button
                  type="button"
                  aria-label="Remove snack option"
                  // POS-PERF-P41 — removes at once; busy until the server answers (the hook toasts the result).
                  onClick={() => void removeSnackOption.mutateAsync(option.id).catch(() => undefined)}
                  disabled={requiresReason || removeSnackOption.isPending}
                  aria-busy={removeSnackOption.isPending && removeSnackOption.variables === option.id}
                  className="ml-1"
                  title={requiresReason ? 'Removing from an ACTIVE variant requires a reason — use Edit on the slot instead' : 'Removes it now'}
                >
                  {removeSnackOption.isPending && removeSnackOption.variables === option.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
