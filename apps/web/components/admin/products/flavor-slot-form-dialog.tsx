'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { FlavorSlotResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { FormSaveError } from '@/components/shared/forms/form-save-error';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { useAddFlavorSlot, useUpdateFlavorSlot } from '@/hooks/queries/use-flavor-slots';

interface FlavorSlotFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  variantId: string;
  slot?: FlavorSlotResponse;
  /** Required on an ACTIVE variant (products.service.ts's performSlotEditWithActiveGovernance) — prompted for inline rather than a separate step. */
  requiresReason: boolean;
}

/**
 * POS-PERF-P36R — add/edit one Mix & Max ProductFlavorSlot (a single
 * customer-facing choice, e.g. "Flavor 1"). Separate from snack-option
 * assignment (FlavorSlotSnackOptionDialog), which decides WHICH snack
 * variants are sellable into this slot once it exists.
 */
export function FlavorSlotFormDialog({ open, onOpenChange, productId, variantId, slot, requiresReason }: FlavorSlotFormDialogProps) {
  const addSlot = useAddFlavorSlot(productId, variantId);
  const updateSlot = useUpdateFlavorSlot(productId, variantId, slot?.id ?? '');

  const [label, setLabel] = useState('');
  const [flavorQty, setFlavorQty] = useState('1');
  const [unit, setUnit] = useState('scoop');
  const [required, setRequired] = useState(true);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open) return;
    setLabel(slot?.label ?? '');
    setFlavorQty(slot ? String(slot.flavor_qty) : '1');
    setUnit(slot?.unit ?? 'scoop');
    setRequired(slot?.required ?? true);
    setReason('');
    addSlot.reset();
    updateSlot.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-sync only when the form opens or the slot changes
  }, [open, slot]);

  const isPending = addSlot.isPending || updateSlot.isPending;
  const qty = Number(flavorQty);
  const canSubmit = label.trim().length > 0 && unit.trim().length > 0 && qty > 0 && (!requiresReason || reason.trim().length > 0);

  // POS-PERF-P41 — Back/Escape in the product editor ask before discarding these.
  const hasUnsavedInput =
    open &&
      (label !== (slot?.label ?? '') ||
        flavorQty !== (slot ? String(slot.flavor_qty) : '1') ||
        unit !== (slot?.unit ?? 'scoop') ||
        required !== (slot?.required ?? true) ||
        reason !== '');

  async function handleSubmit() {
    if (!canSubmit) return;
    try {
      await saveSlot();
    } catch {
      // Shown inline (FormSaveError); the entered values stay.
      return;
    }
    onOpenChange(false);
  }

  async function saveSlot() {
    if (slot) {
      await updateSlot.mutateAsync({
        label: label.trim(),
        flavor_qty: qty,
        unit: unit.trim(),
        required,
        reason: requiresReason ? reason.trim() : undefined,
      });
    } else {
      await addSlot.mutateAsync({
        label: label.trim(),
        flavor_qty: qty,
        unit: unit.trim(),
        required,
        reason: requiresReason ? reason.trim() : undefined,
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" hasUnsavedInput={hasUnsavedInput}>
        <DialogHeader>
          <DialogTitle>{slot ? 'Edit Flavor Slot' : 'Add Flavor Slot'}</DialogTitle>
          <DialogDescription>
            A slot is one customer-facing choice (e.g. &quot;Flavor 1&quot;). Which snack variants are
            sellable into it is configured separately, once the slot exists.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="slot-label">Label</Label>
            <Input id="slot-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Flavor 1" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="slot-qty">Quantity</Label>
              <Input id="slot-qty" type="number" min="0.001" step="0.001" value={flavorQty} onChange={(e) => setFlavorQty(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slot-unit">Unit</Label>
              <Input id="slot-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="scoop" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="slot-required" checked={required} onCheckedChange={(checked) => setRequired(checked === true)} />
            <Label htmlFor="slot-required" className="font-normal">
              Customer must choose for this slot
            </Label>
          </div>
          {requiresReason && (
            <div className="space-y-2">
              <Label htmlFor="slot-reason">Reason (required — this variant is already live on POS)</Label>
              <Input id="slot-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this change is needed" />
            </div>
          )}
        </div>

        <FormSaveError error={(slot ? updateSlot.error : addSlot.error)} />

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit || isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {slot ? 'Save' : 'Add Slot'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
