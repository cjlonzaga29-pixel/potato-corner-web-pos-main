'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ProductVariantResponse, RecipeResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useBranches } from '@/hooks/queries/use-branches';
import { useIngredients } from '@/hooks/queries/use-inventory';
import { useCreateRecipe, useUpdateRecipe } from '@/hooks/queries/use-recipes';

const BASE_FLAVOR_VALUE = '__base__';

interface RecipeLineFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant: ProductVariantResponse;
  existingLines: RecipeResponse[];
  editingLine?: RecipeResponse;
}

/**
 * Create/edit one master recipe ingredient line. There is no aggregate
 * "recipe" entity to save at once — each line is its own POST/PATCH against
 * the recipes API, and PATCH only allows changing quantity/unit (ingredient,
 * flavor, and branch are immutable once a line exists).
 */
export function RecipeLineFormDialog({ open, onOpenChange, variant, existingLines, editingLine }: RecipeLineFormDialogProps) {
  const isEdit = Boolean(editingLine);
  const createRecipe = useCreateRecipe(variant.id);
  const updateRecipe = useUpdateRecipe(variant.id, editingLine?.id ?? '');
  const mutation = isEdit ? updateRecipe : createRecipe;

  const [branchId, setBranchId] = useState('');
  const [ingredientId, setIngredientId] = useState('');
  const [flavorId, setFlavorId] = useState(BASE_FLAVOR_VALUE);
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');

  const { data: branchData, isLoading: branchesLoading } = useBranches({ status: 'active', limit: 100 });
  const { data: ingredients, isLoading: ingredientsLoading } = useIngredients(branchId || undefined);

  useEffect(() => {
    if (!open) return;
    if (editingLine) {
      setIngredientId(editingLine.ingredient_id);
      setFlavorId(editingLine.flavor_id ?? BASE_FLAVOR_VALUE);
      setQuantity(String(editingLine.quantity));
      setUnit(editingLine.unit);
      setBranchId('');
    } else {
      setBranchId('');
      setIngredientId('');
      setFlavorId(BASE_FLAVOR_VALUE);
      setQuantity('');
      setUnit('');
    }
  }, [open, editingLine]);

  // The API has no friendly message for the (variant, ingredient, flavor)
  // unique-constraint conflict on create, so this is filtered out client-side.
  const usedCombos = new Set(existingLines.map((line) => `${line.ingredient_id}::${line.flavor_id ?? ''}`));
  const effectiveFlavorId = flavorId === BASE_FLAVOR_VALUE ? '' : flavorId;
  const availableIngredients = (ingredients ?? []).filter(
    (ingredient) => !usedCombos.has(`${ingredient.id}::${effectiveFlavorId}`),
  );

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
  }

  async function handleSubmit() {
    const numericQuantity = Number(quantity);
    if (isEdit) {
      await updateRecipe.mutateAsync({ quantity: numericQuantity, unit });
    } else {
      if (!ingredientId) return;
      await createRecipe.mutateAsync({
        product_variant_id: variant.id,
        ingredient_id: ingredientId,
        flavor_id: flavorId === BASE_FLAVOR_VALUE ? null : flavorId,
        quantity: numericQuantity,
        unit,
      });
    }
    handleOpenChange(false);
  }

  const isValid = isEdit
    ? quantity !== '' && unit.trim() !== ''
    : Boolean(ingredientId) && quantity !== '' && unit.trim() !== '';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Ingredient Line' : 'Add Ingredient Line'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Quantity and unit are the only fields that can change after a line is created.'
              : `Add an ingredient to the master recipe for ${variant.name} (${variant.size_label}).`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isEdit ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p className="font-medium">{editingLine?.ingredient_name}</p>
              <p className="text-muted-foreground">
                {editingLine?.flavor_name ? `Flavor: ${editingLine.flavor_name}` : 'Base ingredient (all flavors)'}
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="recipe-line-flavor">Applies To</Label>
                <Select value={flavorId} onValueChange={setFlavorId}>
                  <SelectTrigger id="recipe-line-flavor">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={BASE_FLAVOR_VALUE}>Base ingredient (all flavors)</SelectItem>
                    {variant.flavors.map((flavor) => (
                      <SelectItem key={flavor.flavor_id} value={flavor.flavor_id}>
                        {flavor.name} only
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="recipe-line-branch">Ingredient Source Branch</Label>
                <Select
                  value={branchId}
                  onValueChange={(value) => {
                    setBranchId(value);
                    setIngredientId('');
                  }}
                  disabled={branchesLoading}
                >
                  <SelectTrigger id="recipe-line-branch">
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
                <p className="text-xs text-muted-foreground">
                  Master recipe lines are pinned to one branch&apos;s ingredient stock — that branch is deducted from whenever any
                  branch sells this variant, unless the selling branch has its own recipe override.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="recipe-line-ingredient">Ingredient</Label>
                <Select
                  value={ingredientId}
                  onValueChange={(value) => {
                    setIngredientId(value);
                    const ingredient = ingredients?.find((candidate) => candidate.id === value);
                    if (ingredient) setUnit(ingredient.unit);
                  }}
                  disabled={!branchId || ingredientsLoading}
                >
                  <SelectTrigger id="recipe-line-ingredient">
                    <SelectValue
                      placeholder={!branchId ? 'Select a branch first' : ingredientsLoading ? 'Loading…' : 'Select an ingredient'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {availableIngredients.length === 0 && branchId && !ingredientsLoading ? (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">No available ingredients for this combination</div>
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
              <Label htmlFor="recipe-line-quantity">Quantity</Label>
              <Input
                id="recipe-line-quantity"
                type="number"
                min="0"
                step="0.0001"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="recipe-line-unit">Unit</Label>
              <Input id="recipe-line-unit" value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="g, ml, pcs" />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!isValid || mutation.isPending}>
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isEdit ? 'Save Changes' : 'Add Line'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
