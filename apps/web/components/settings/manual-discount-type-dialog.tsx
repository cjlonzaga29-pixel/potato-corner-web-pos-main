'use client';

import { useEffect, useState } from 'react';
import { MANUAL_DISCOUNT_TYPE_NAME_MAX, isStatutoryDiscountName, STATUTORY_DISCOUNT_NAME_MESSAGE, type ManualDiscountTypeResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ManualDiscountTypeSaveError, useCreateManualDiscountType, useUpdateManualDiscountType } from '@/hooks/queries/use-manual-discount-types';

interface ManualDiscountTypeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branchId: string;
  branchName: string;
  /** null = create a new type. */
  editing: ManualDiscountTypeResponse | null;
}

/**
 * POS-PERF-P55 — Create / Edit discount type. Name and two switches only:
 * the cashier enters the peso amount at checkout, so there is no rate,
 * amount or schedule here. Turning a required proof photo off needs an
 * explicit confirmation so a proof-required type never silently becomes
 * proof-optional. Edits carry the version this dialog opened with; a newer
 * save is never overwritten.
 */
export function ManualDiscountTypeDialog({ open, onOpenChange, branchId, branchName, editing }: ManualDiscountTypeDialogProps) {
  const create = useCreateManualDiscountType();
  const update = useUpdateManualDiscountType();
  const [name, setName] = useState('');
  const [applyToPos, setApplyToPos] = useState(true);
  const [requireProof, setRequireProof] = useState(false);
  const [confirmProofOff, setConfirmProofOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setApplyToPos(editing?.apply_to_pos ?? true);
    setRequireProof(editing?.require_proof ?? false);
    setConfirmProofOff(false);
    setError(null);
    // Reset only when a different type/version is opened — a background
    // refetch of the same version must not wipe what the supervisor typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id, editing?.version]);

  const trimmed = name.trim();
  const statutory = trimmed.length > 0 && isStatutoryDiscountName(trimmed);
  const turningProofOff = editing?.require_proof === true && !requireProof;
  const unchanged = editing !== null && trimmed === editing.name && applyToPos === editing.apply_to_pos && requireProof === editing.require_proof;
  const pending = create.isPending || update.isPending;
  const canSave = trimmed.length > 0 && !statutory && !unchanged && (!turningProofOff || confirmProofOff) && !pending;

  function handleSave() {
    if (!canSave) return;
    setError(null);
    const onError = (err: Error) => {
      setError(
        err instanceof ManualDiscountTypeSaveError && err.code === 'MANUAL_DISCOUNT_TYPE_CONFLICT'
          ? 'Someone else changed this discount type after you opened it. Close this window to see the latest version, then make your change again.'
          : err.message,
      );
    };
    const onSuccess = () => onOpenChange(false);
    if (editing) {
      update.mutate(
        {
          id: editing.id,
          expected_version: editing.version,
          ...(trimmed !== editing.name ? { name: trimmed } : {}),
          ...(applyToPos !== editing.apply_to_pos ? { apply_to_pos: applyToPos } : {}),
          ...(requireProof !== editing.require_proof ? { require_proof: requireProof } : {}),
        },
        { onSuccess, onError },
      );
    } else {
      create.mutate({ branch_id: branchId, name: trimmed, apply_to_pos: applyToPos, require_proof: requireProof }, { onSuccess, onError });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit discount type' : 'New discount type'}</DialogTitle>
          <DialogDescription>
            For {branchName} only. Cashiers choose this type and type the discount in pesos for each sale.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="manual-type-name">Name</Label>
            <Input
              id="manual-type-name"
              value={name}
              maxLength={MANUAL_DISCOUNT_TYPE_NAME_MAX}
              placeholder="e.g. Employee"
              aria-invalid={statutory}
              aria-describedby={statutory ? 'manual-type-name-error' : undefined}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            {statutory && (
              <p id="manual-type-name-error" className="text-xs text-destructive">
                {STATUTORY_DISCOUNT_NAME_MESSAGE}
              </p>
            )}
          </div>

          <div className="flex items-start justify-between gap-3 rounded-md border p-3">
            <div className="min-w-0">
              <Label htmlFor="manual-type-pos" className="font-medium">
                Apply to POS
              </Label>
              <p className="text-xs text-muted-foreground">Cashiers at {branchName} can choose it at checkout.</p>
            </div>
            <Switch id="manual-type-pos" checked={applyToPos} onCheckedChange={setApplyToPos} />
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor="manual-type-proof" className="font-medium">
                  Require proof photo
                </Label>
                <p className="text-xs text-muted-foreground">The cashier must take or upload a photo (e.g. an ID) before Charge is enabled.</p>
              </div>
              <Switch
                id="manual-type-proof"
                checked={requireProof}
                onCheckedChange={(checked) => {
                  setRequireProof(checked);
                  setConfirmProofOff(false);
                }}
              />
            </div>
            {turningProofOff && (
              <label className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                <Checkbox checked={confirmProofOff} onCheckedChange={(checked) => setConfirmProofOff(checked === true)} aria-label="Confirm proof photo is no longer required" />
                <span>This type currently requires a proof photo. Turn it off so cashiers can apply it without a photo? Past sales keep their photos.</span>
              </label>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            VAT: a manual discount is an ordinary (taxable) discount — it comes off the price with VAT, and VAT is charged on what remains. PWD and Senior
            Citizen discounts are set by law and are handled separately at checkout.
          </p>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {pending ? 'Saving…' : editing ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
