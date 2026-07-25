'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ProductInventoryResponse, ProductVariantResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
}

/**
 * Create/edit one ProductInventory stock mapping for a variant. Business-neutral
 * by design (Phase 6) — this is additive, informational stock bookkeeping, not
 * the Recipe deduction engine, so it never mentions flavors or recipes. Editing
 * only allows changing quantity/unit, matching updateProductInventorySchema.
 */
export function InventoryMappingFormDialog({
  open,
  onOpenChange,
  variant,
  existingMappings,
  editingMapping,
}: InventoryMappingFormDialogProps) {
  const isEdit = Boolean(editingMapping);
  const createMapping = useCreateProductInventory(variant.id);
  const updateMapping = useUpdateProductInventory(variant.id, editingMapping?.id ?? '');
  const mutation = isEdit ? updateMapping : createMapping;

  const [branchId, setBranchId] = useState('');
  const [ingredientId, setIngredientId] = useState('');
  const [quantityRequired, setQuantityRequired] = useState('');
  const [unit, setUnit] = useState('');

  const { data: branchData, isLoading: branchesLoading } = useBranches({ status: 'active', limit: 100 });
  const { data: ingredients, isLoading: ingredientsLoading } = useIngredients(branchId || undefined);

  useEffect(() => {
    if (!open) return;
    if (editingMapping) {
      setIngredientId(editingMapping.ingredient_id);
      setQuantityRequired(String(editingMapping.quantity_required));
      setUnit(editingMapping.unit);
      setBranchId('');
    } else {
      setBranchId('');
      setIngredientId('');
      setQuantityRequired('');
      setUnit('');
    }
  }, [open, editingMapping]);

  const usedIngredientIds = new Set(existingMappings.map((mapping) => mapping.ingredient_id));
  const availableIngredients = (ingredients ?? []).filter((ingredient) => !usedIngredientIds.has(ingredient.id));

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
  }

  async function handleSubmit() {
    const numericQuantity = Number(quantityRequired);
    if (isEdit) {
      await updateMapping.mutateAsync({ quantity_required: numericQuantity, unit });
    } else {
      if (!ingredientId) return;
      await createMapping.mutateAsync({
        product_variant_id: variant.id,
        ingredient_id: ingredientId,
        quantity_required: numericQuantity,
        unit,
      });
    }
    handleOpenChange(false);
  }

  const isValid = isEdit
    ? quantityRequired !== '' && unit.trim() !== ''
    : Boolean(ingredientId) && quantityRequired !== '' && unit.trim() !== '';

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
                    {availableIngredients.length === 0 && branchId && !ingredientsLoading ? (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">No available inventory items for this branch</div>
                    ) : (
                      availableIngredients.map((ingredient) => (
                        <SelectItem key={ingredient.id} value={ingredient.id}>
                          {ingredient.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
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
