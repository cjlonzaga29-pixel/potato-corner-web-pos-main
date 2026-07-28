'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ProductInventoryResponse, ProductVariantResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { useBranches } from '@/hooks/queries/use-branches';
import { useIngredients } from '@/hooks/queries/use-inventory';
import { useCreateProductInventory, useUpdateProductInventory } from '@/hooks/queries/use-product-inventory';

interface InventoryMappingFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant: ProductVariantResponse;
  existingMappings: ProductInventoryResponse[];
  editingMapping?: ProductInventoryResponse;
  /** Branch the mapping being edited belongs to. ProductInventoryResponse carries no branch_id, so the caller must supply it for edit mode. */
  editingBranchId?: string;
}

/**
 * Create/edit one ProductInventory stock mapping for a variant (Phase 6 —
 * the mapping checkout actually reads to unblock a sale). Editing only
 * allows changing quantity/unit/active-status, matching
 * updateProductInventorySchema — the item, branch, and flavor scope are
 * fixed once created (delete + recreate to change those). A flavor-specific
 * mapping (flavor_id set) overrides the base mapping for the same inventory
 * item at sale time rather than stacking with it — see product-inventory
 * .service.ts computeDeduction.
 */
export function InventoryMappingFormDialog({
  open,
  onOpenChange,
  variant,
  existingMappings,
  editingMapping,
  editingBranchId,
}: InventoryMappingFormDialogProps) {
  const isEdit = Boolean(editingMapping);

  const [branchId, setBranchId] = useState('');
  const [ingredientId, setIngredientId] = useState('');
  const [isFlavorSpecific, setIsFlavorSpecific] = useState(false);
  const [flavorId, setFlavorId] = useState('');
  const [quantityRequired, setQuantityRequired] = useState('');
  const [unit, setUnit] = useState('');

  const createMapping = useCreateProductInventory(variant.id);
  const updateMapping = useUpdateProductInventory(branchId, variant.id, editingMapping?.id ?? '');
  const mutation = isEdit ? updateMapping : createMapping;

  const { data: branchData, isLoading: branchesLoading } = useBranches({ status: 'active', limit: 100 });
  const { data: ingredients, isLoading: ingredientsLoading } = useIngredients(branchId || undefined);

  useEffect(() => {
    if (!open) return;
    if (editingMapping) {
      setIngredientId(editingMapping.ingredient_id);
      setIsFlavorSpecific(Boolean(editingMapping.flavor_id));
      setFlavorId(editingMapping.flavor_id ?? '');
      setQuantityRequired(String(editingMapping.quantity_required));
      setUnit(editingMapping.unit);
      setBranchId(editingBranchId ?? '');
    } else {
      setBranchId('');
      setIngredientId('');
      setIsFlavorSpecific(false);
      setFlavorId('');
      setQuantityRequired('');
      setUnit('');
    }
  }, [open, editingMapping, editingBranchId]);

  const selectedFlavorId = isFlavorSpecific ? flavorId || null : null;
  const isDuplicate = !isEdit
    ? existingMappings.some((mapping) => mapping.ingredient_id === ingredientId && mapping.flavor_id === selectedFlavorId)
    : false;

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
  }

  async function handleSubmit() {
    const numericQuantity = Number(quantityRequired);
    if (isEdit) {
      if (!branchId) return;
      await updateMapping.mutateAsync({ quantity_required: numericQuantity, unit });
    } else {
      if (!branchId || !ingredientId || isDuplicate) return;
      await createMapping.mutateAsync({
        branch_id: branchId,
        product_variant_id: variant.id,
        ingredient_id: ingredientId,
        flavor_id: selectedFlavorId,
        quantity_required: numericQuantity,
        unit,
      });
    }
    handleOpenChange(false);
  }

  const isValid = isEdit
    ? Boolean(branchId) && quantityRequired !== '' && unit.trim() !== ''
    : Boolean(branchId) &&
      Boolean(ingredientId) &&
      quantityRequired !== '' &&
      unit.trim() !== '' &&
      !isDuplicate &&
      (!isFlavorSpecific || Boolean(flavorId));

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Inventory Item' : 'Add Inventory Item'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Quantity and unit are the only fields that can change after an inventory item is linked.'
              : `Link a stock item to ${variant.name} (${variant.size_label}) and set how much is required per unit sold.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isEdit ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p className="font-medium">{editingMapping?.ingredient_name}</p>
              {editingMapping?.flavor_name && (
                <p className="text-xs text-muted-foreground">Flavor-specific: applies only when {editingMapping.flavor_name} is sold</p>
              )}
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="inventory-mapping-branch">Inventory Source Branch</Label>
                <Select
                  value={branchId}
                  onValueChange={(value) => {
                    setBranchId(value);
                    setIngredientId('');
                  }}
                  disabled={branchesLoading}
                >
                  <SelectTrigger id="inventory-mapping-branch">
                    <SelectValue placeholder={branchesLoading ? 'Loading…' : 'Select a branch'} />
                  </SelectTrigger>
                  <SelectContent>
                    {(branchData?.branches ?? []).map((branch) => (
                      <SelectItem key={branch.id} value={branch.id}>
                        {branch.name} ({branch.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="inventory-mapping-item">Inventory Item</Label>
                <Select
                  value={ingredientId}
                  onValueChange={(value) => {
                    setIngredientId(value);
                    const ingredient = ingredients?.find((candidate) => candidate.id === value);
                    if (ingredient) setUnit(ingredient.unit);
                  }}
                  disabled={!branchId || ingredientsLoading}
                >
                  <SelectTrigger id="inventory-mapping-item">
                    <SelectValue
                      placeholder={!branchId ? 'Select a branch first' : ingredientsLoading ? 'Loading…' : 'Select an inventory item'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(ingredients ?? []).length === 0 && branchId && !ingredientsLoading ? (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">No inventory items for this branch</div>
                    ) : (
                      (ingredients ?? []).map((ingredient) => (
                        <SelectItem key={ingredient.id} value={ingredient.id}>
                          {ingredient.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>

              {variant.flavors.length > 0 && (
                <div className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="inventory-mapping-flavor-specific"
                      checked={isFlavorSpecific}
                      onCheckedChange={(checked) => {
                        setIsFlavorSpecific(checked === true);
                        if (checked !== true) setFlavorId('');
                      }}
                    />
                    <Label htmlFor="inventory-mapping-flavor-specific" className="cursor-pointer font-normal">
                      Only applies to a specific flavor
                    </Label>
                  </div>
                  {isFlavorSpecific && (
                    <Select value={flavorId} onValueChange={setFlavorId}>
                      <SelectTrigger id="inventory-mapping-flavor">
                        <SelectValue placeholder="Select a flavor" />
                      </SelectTrigger>
                      <SelectContent>
                        {variant.flavors.map((flavor) => (
                          <SelectItem key={flavor.flavor_id} value={flavor.flavor_id}>
                            {flavor.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <p className="text-xs text-muted-foreground">
                    A flavor-specific mapping overrides (not adds to) a base mapping for the same inventory item when that flavor is
                    sold.
                  </p>
                </div>
              )}

              {isDuplicate && (
                <p className="text-xs text-destructive">
                  A mapping for this inventory item{isFlavorSpecific ? ' and flavor' : ''} already exists for this variant.
                </p>
              )}
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="inventory-mapping-quantity">Quantity Required</Label>
              <Input
                id="inventory-mapping-quantity"
                type="number"
                min="0"
                step="0.0001"
                value={quantityRequired}
                onChange={(event) => setQuantityRequired(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inventory-mapping-unit">Unit</Label>
              <Input
                id="inventory-mapping-unit"
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                placeholder="g, ml, pcs"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!isValid || mutation.isPending}>
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isEdit ? 'Save Changes' : 'Add Item'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
