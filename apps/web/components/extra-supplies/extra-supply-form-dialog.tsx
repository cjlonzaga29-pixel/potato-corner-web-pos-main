'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { createExtraSupplySchema, updateExtraSupplySchema, type ExtraSupplyResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/hooks/use-auth';
import { useBranches } from '@/hooks/queries/use-branches';
import { useCreateExtraSupply, useExtraSupplyConversionPreview, useRemoveExtraSupplyImage, useUpdateExtraSupply, useUploadExtraSupplyImage } from '@/hooks/queries/use-extra-supplies';
import { useInventoryItems, useUnitsOfMeasure } from '@/hooks/queries/use-universal-inventory';
import { useRestoreFocus } from '@/hooks/use-restore-focus';
import { formatCurrency } from '@/lib/utils';

interface ExtraSupplyFormDialogProps {
  /** Null creates a new card. */
  supply: ExtraSupplyResponse | null;
  defaultBranchId: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

/**
 * POS-PERF-P61 — Create Supply and Edit. A card has no stock of its own: it names an
 * inventory item and what one issue takes from it, and the server's own conversion is
 * shown before anything can be saved. The picture uploads after the card, so a failed
 * upload never loses the card or the picture it already has.
 */
export function ExtraSupplyFormDialog({ supply, defaultBranchId, onOpenChange, onSaved }: ExtraSupplyFormDialogProps) {
  const restoreFocus = useRestoreFocus();
  const { user } = useAuth();
  const { data: branchData, isLoading: branchesLoading } = useBranches({ status: 'active', limit: 100 });
  const { data: items } = useInventoryItems();
  const { data: units } = useUnitsOfMeasure();
  const create = useCreateExtraSupply();
  const update = useUpdateExtraSupply();
  const uploadImage = useUploadExtraSupplyImage();
  const removeImage = useRemoveExtraSupplyImage();

  const [name, setName] = useState(supply?.name ?? '');
  const [itemId, setItemId] = useState(supply?.inventory_item_id ?? '');
  const [issueUnit, setIssueUnit] = useState(supply?.issue_unit_name ?? '');
  const [quantity, setQuantity] = useState(supply ? String(supply.entered_quantity) : '1');
  const [unitId, setUnitId] = useState(supply?.entered_unit_id ?? '');
  const [issueCost, setIssueCost] = useState(supply?.configured_issue_cost != null ? String(supply.configured_issue_cost) : '');
  const [price, setPrice] = useState(supply?.selling_price != null ? String(supply.selling_price) : '');
  const [applyToPos, setApplyToPos] = useState(supply?.apply_to_pos ?? true);
  const [branchIds, setBranchIds] = useState<string[]>(supply ? supply.branches.map((b) => b.branch_id) : []);
  const [image, setImage] = useState<File | null>(null);
  const [dropImage, setDropImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const assigned = user?.branchIds ?? [];
  const myBranches = (branchData?.branches ?? []).filter((b) => assigned.includes(b.id)).sort((a, b) => a.name.localeCompare(b.name));
  const trackedItems = (items ?? []).filter((item) => item.track_inventory);
  const numericQuantity = Number(quantity);
  const preview = useExtraSupplyConversionPreview(itemId && unitId && numericQuantity > 0 ? { itemId, quantity: numericQuantity, unitId } : null);

  // A new card starts at the branch being viewed, or the only one there is.
  useEffect(() => {
    if (supply || branchesLoading) return;
    const initial = defaultBranchId && assigned.includes(defaultBranchId) ? defaultBranchId : myBranches.length === 1 ? myBranches[0]?.id : undefined;
    if (initial) setBranchIds([initial]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the branches arrive
  }, [branchesLoading]);

  // A newly chosen item starts on its own base unit. Nothing else is assumed.
  function chooseItem(id: string) {
    // A Select can report an empty value while its options are still loading. That is not a choice.
    if (!id) return;
    setItemId(id);
    const next = trackedItems.find((item) => item.id === id);
    if (next) setUnitId(next.base_unit_id);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const fields = {
      name,
      inventory_item_id: itemId,
      issue_unit_name: issueUnit,
      entered_quantity: numericQuantity,
      entered_unit_id: unitId,
      configured_issue_cost: issueCost.trim() ? Number(issueCost) : null,
      selling_price: price.trim() ? Number(price) : null,
      apply_to_pos: applyToPos,
      branch_ids: branchIds,
    };
    const parsed = supply ? updateExtraSupplySchema.safeParse({ ...fields, expected_version: supply.version }) : createExtraSupplySchema.safeParse(fields);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check this form.');
      return;
    }
    if (!preview.data) {
      setError(preview.error instanceof Error ? preview.error.message : 'Wait for the conversion check to finish.');
      return;
    }

    setIsSaving(true);
    try {
      const saved = supply
        ? await update.mutateAsync({ id: supply.id, input: updateExtraSupplySchema.parse(parsed.data) })
        : await create.mutateAsync(createExtraSupplySchema.parse(parsed.data));
      try {
        if (image) await uploadImage.mutateAsync({ id: saved.id, file: image, expectedVersion: saved.version });
        else if (dropImage && saved.image_url) await removeImage.mutateAsync({ id: saved.id, expectedVersion: saved.version });
      } catch (caught) {
        // The details are saved. Stay open so the problem is seen, in edit mode against the new version.
        setError(`The details were saved, but the picture wasn't: ${caught instanceof Error ? caught.message : 'try again'}. Any earlier picture is still in place.`);
        return;
      }
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save this supply.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !isSaving && onOpenChange(next)}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto" onCloseAutoFocus={restoreFocus}>
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">{supply ? `Edit ${supply.name}` : 'Create Supply'}</DialogTitle>
          <DialogDescription>A card for an additional cup, tissue or bag. It has no stock of its own: each issue deducts the inventory item you choose here.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4" aria-label={supply ? 'Edit supply' : 'Create supply'}>
          <div className="space-y-2">
            <Label htmlFor="supply-name">Name</Label>
            <Input id="supply-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus />
          </div>

          <div className="space-y-2">
            <Label htmlFor="supply-image">Picture (optional)</Label>
            {supply?.image_url && !image && !dropImage && (
              <div className="flex items-center gap-3">
                <img src={supply.image_url} alt="" className="h-14 w-14 rounded object-cover" />
                <Button type="button" variant="ghost" size="sm" onClick={() => setDropImage(true)}>
                  Remove picture
                </Button>
              </div>
            )}
            {dropImage && <p className="text-sm text-muted-foreground">The picture will be removed when you save.</p>}
            <Input
              id="supply-image"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                setImage(event.target.files?.[0] ?? null);
                setDropImage(false);
              }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="supply-item">Inventory item</Label>
            <Select value={itemId} onValueChange={chooseItem}>
              <SelectTrigger id="supply-item" aria-label="Inventory item">
                <SelectValue placeholder="Choose an existing item" />
              </SelectTrigger>
              <SelectContent>
                {trackedItems.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name} ({item.base_unit_code ?? 'unit'})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {supply && !supply.inventory_item_available && <p className="text-sm text-destructive">This card&apos;s item is deleted, untracked or changed its base unit, so the card can&apos;t be issued until you choose again.</p>}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="supply-issue-unit">Cashier counts in</Label>
              <Input id="supply-issue-unit" value={issueUnit} onChange={(event) => setIssueUnit(event.target.value)} maxLength={30} placeholder="cup" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="supply-quantity">Stock used per issue</Label>
              <Input id="supply-quantity" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="supply-unit">Unit</Label>
              <Select value={unitId} onValueChange={(id) => { if (id) setUnitId(id); }}>
                <SelectTrigger id="supply-unit" aria-label="Unit">
                  <SelectValue placeholder="Unit" />
                </SelectTrigger>
                <SelectContent>
                  {(units ?? []).map((unit) => (
                    <SelectItem key={unit.id} value={unit.id}>
                      {unit.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="rounded-md border p-3 text-sm" role="status" data-testid="supply-conversion">
            {!itemId || !unitId || !(numericQuantity > 0) ? (
              <p className="text-muted-foreground">Choose an item, quantity and unit to see what each issue deducts.</p>
            ) : preview.isFetching ? (
              <p className="text-muted-foreground">Checking the conversion…</p>
            ) : preview.error ? (
              <p className="font-medium text-destructive">{preview.error.message}</p>
            ) : preview.data ? (
              <>
                <p className="font-medium">
                  Each {issueUnit.trim() || 'issue'} deducts {preview.data.base_quantity} {preview.data.base_unit_code} of {preview.data.inventory_item_name}.
                </p>
                {preview.data.entered_unit_code !== preview.data.base_unit_code && (
                  <p className="text-muted-foreground">
                    Converted from {numericQuantity} {preview.data.entered_unit_code} when you save. Later conversion changes won&apos;t change this card until you save it again.
                  </p>
                )}
                <p className="text-muted-foreground">
                  {preview.data.item_unit_cost !== null ? `Inventory cost: ${formatCurrency(preview.data.item_unit_cost)} per ${preview.data.base_unit_code}, unless a branch has its own.` : 'This item has no cost in inventory, so the stated cost below is used if you enter one.'}
                </p>
              </>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="supply-price">Selling price if paid</Label>
              <Input id="supply-price" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="Leave empty for free only" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="supply-cost">Stated issue cost (optional)</Label>
              <Input id="supply-cost" inputMode="decimal" value={issueCost} onChange={(event) => setIssueCost(event.target.value)} />
              <p className="text-xs text-muted-foreground">Per {issueUnit.trim() || 'issued unit'}. Used only if inventory has no cost, and reported as stated rather than calculated.</p>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={applyToPos} aria-label="Apply to POS" onCheckedChange={(checked) => setApplyToPos(checked === true)} />
            Apply to POS
          </label>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium leading-none">Available at branches</legend>
            <div className="max-h-40 space-y-2 overflow-y-auto rounded-md border p-3">
              {branchesLoading && <p className="text-sm text-muted-foreground">Loading your branches…</p>}
              {myBranches.map((branch) => (
                <label key={branch.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={branchIds.includes(branch.id)}
                    aria-label={branch.name}
                    onCheckedChange={(checked) => setBranchIds((current) => (checked === true ? [...new Set([...current, branch.id])] : current.filter((id) => id !== branch.id)))}
                  />
                  {branch.name}
                </label>
              ))}
            </div>
            {supply && <p className="text-xs text-muted-foreground">A branch that has already issued this supply can&apos;t be removed.</p>}
          </fieldset>

          {error && (
            <p className="text-sm font-medium text-destructive" role="alert" data-testid="supply-form-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {supply ? 'Save Changes' : 'Create Supply'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
