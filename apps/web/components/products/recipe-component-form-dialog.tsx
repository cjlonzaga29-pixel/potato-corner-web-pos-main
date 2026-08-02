'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ProductComponentResponse, UnitOfMeasureResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useInventoryItems, useUnitsOfMeasure } from '@/hooks/queries/use-universal-inventory';
import { useCreateProductComponent, useUpdateProductComponent } from '@/hooks/queries/use-product-components';
import { useAllActiveProductOptions } from '@/hooks/queries/use-product-options';

/** Sentinel Select value standing in for product_option_id = null (Base Recipe) — Radix Select disallows an empty-string item value. */
const BASE_RECIPE_VALUE = '__base_recipe__';

interface RecipeComponentFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productVariantId: string;
  existingComponents: ProductComponentResponse[];
  editingComponent?: ProductComponentResponse;
  /**
   * Manage Deduction flow (Product Option page): the product option this
   * deduction belongs to is fixed by context, so the Product Option select
   * is replaced with a read-only label and the admin only edits inventory
   * item, quantity, and unit.
   */
  fixedProductOptionId?: string;
  fixedProductOptionLabel?: string;
}

/** CR-011.2 — preferred recipe unit per base unit code, when a compatible (same-dimension) unit with that code exists; otherwise falls back to the base unit itself. */
const PREFERRED_RECIPE_UNIT_CODE: Record<string, string> = {
  kg: 'g',
  l: 'ml',
  pc: 'pc',
  tbsp: 'tbsp',
};

function pickDefaultRecipeUnit(compatibleUnits: UnitOfMeasureResponse[], baseUnit: UnitOfMeasureResponse | undefined): string {
  if (!baseUnit) return '';
  const preferredCode = PREFERRED_RECIPE_UNIT_CODE[baseUnit.code.toLowerCase()];
  const preferred = preferredCode ? compatibleUnits.find((u) => u.code.toLowerCase() === preferredCode) : undefined;
  return (preferred ?? baseUnit).id;
}

/**
 * Create/edit one ProductComponent Recipe/BOM row (CR-011.1, unit conversion
 * per CR-011.2). Quantity and recipe unit may both be entered/changed — the
 * recipe unit is restricted to units sharing the selected inventory item's
 * base unit UnitDimension (e.g. grams for a kg-based item), converted to the
 * item's base unit only when shadow BOM deduction runs.
 *
 * useInventoryItems(false) (includeInactive=false, the default) already
 * excludes soft-deleted/inactive items from the picker, so an inactive item
 * can't be selected here.
 */
export function RecipeComponentFormDialog({
  open,
  onOpenChange,
  productVariantId,
  existingComponents,
  editingComponent,
  fixedProductOptionId,
  fixedProductOptionLabel,
}: RecipeComponentFormDialogProps) {
  const isEdit = Boolean(editingComponent);

  const [inventoryItemId, setInventoryItemId] = useState('');
  const [quantityRequired, setQuantityRequired] = useState('');
  const [recipeUnitId, setRecipeUnitId] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [productOptionId, setProductOptionId] = useState<string | null>(null);

  const createComponent = useCreateProductComponent(productVariantId);
  const updateComponent = useUpdateProductComponent(productVariantId, editingComponent?.id ?? '');
  const mutation = isEdit ? updateComponent : createComponent;

  const { data: inventoryItems, isLoading: itemsLoading } = useInventoryItems(false);
  const { data: units, isLoading: unitsLoading } = useUnitsOfMeasure(false);
  const { data: productOptions, isLoading: productOptionsLoading } = useAllActiveProductOptions();

  const selectedItem = inventoryItems?.find((item) => item.id === inventoryItemId);
  const baseUnitCode = isEdit ? editingComponent?.base_unit_code : selectedItem?.base_unit_code;
  const baseUnit = units?.find((u) => u.code === baseUnitCode);
  const compatibleUnits = baseUnit ? (units ?? []).filter((u) => u.dimension === baseUnit.dimension) : [];

  useEffect(() => {
    if (!open) return;
    if (editingComponent) {
      setInventoryItemId(editingComponent.inventory_item_id);
      setQuantityRequired(String(editingComponent.quantity_required));
      setRecipeUnitId(editingComponent.recipe_unit_id);
      setIsActive(editingComponent.is_active);
      setProductOptionId(editingComponent.product_option_id);
    } else {
      setInventoryItemId('');
      setQuantityRequired('');
      setRecipeUnitId('');
      setIsActive(true);
      setProductOptionId(fixedProductOptionId ?? null);
    }
  }, [open, editingComponent, fixedProductOptionId]);

  // Default the recipe unit whenever the selected item (add mode) resolves a
  // base unit and no recipe unit has been chosen yet.
  useEffect(() => {
    if (isEdit || !baseUnit || recipeUnitId) return;
    setRecipeUnitId(pickDefaultRecipeUnit(compatibleUnits, baseUnit));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, baseUnit?.id]);

  const usedItemIds = new Set(existingComponents.map((component) => component.inventory_item_id));
  const availableItems = (inventoryItems ?? []).filter((item) => !usedItemIds.has(item.id));

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
  }

  function handleInventoryItemChange(nextItemId: string) {
    setInventoryItemId(nextItemId);
    setRecipeUnitId('');
  }

  async function handleSubmit() {
    const numericQuantity = Number(quantityRequired);
    if (isEdit) {
      await updateComponent.mutateAsync({
        quantity_required: numericQuantity,
        recipe_unit_id: recipeUnitId,
        is_active: isActive,
        product_option_id: productOptionId,
      });
    } else {
      if (!inventoryItemId) return;
      await createComponent.mutateAsync({
        product_variant_id: productVariantId,
        inventory_item_id: inventoryItemId,
        quantity_required: numericQuantity,
        recipe_unit_id: recipeUnitId || undefined,
        product_option_id: productOptionId,
      });
    }
    handleOpenChange(false);
  }

  const isValid =
    (isEdit || Boolean(inventoryItemId)) && quantityRequired !== '' && Number(quantityRequired) > 0 && Boolean(recipeUnitId);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Recipe Component' : 'Add Recipe Component'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Change the quantity or the unit it was recorded in.'
              : 'Choose an inventory item and how much of it this variant consumes.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isEdit ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p className="font-medium">{editingComponent?.inventory_item_name}</p>
              {editingComponent?.inventory_item_sku && <p className="text-muted-foreground">SKU: {editingComponent.inventory_item_sku}</p>}
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="recipe-component-item">Inventory Item</Label>
              <Select value={inventoryItemId} onValueChange={handleInventoryItemChange} disabled={itemsLoading}>
                <SelectTrigger id="recipe-component-item">
                  <SelectValue placeholder={itemsLoading ? 'Loading…' : 'Select an inventory item'} />
                </SelectTrigger>
                <SelectContent>
                  {availableItems.length === 0 && !itemsLoading ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">No available inventory items to add</div>
                  ) : (
                    availableItems.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="recipe-component-quantity">Quantity Required</Label>
              <Input
                id="recipe-component-quantity"
                type="number"
                min="0"
                step="0.0001"
                value={quantityRequired}
                onChange={(event) => setQuantityRequired(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="recipe-component-unit">Unit</Label>
              <Select value={recipeUnitId} onValueChange={setRecipeUnitId} disabled={unitsLoading || compatibleUnits.length === 0}>
                <SelectTrigger id="recipe-component-unit">
                  <SelectValue placeholder={unitsLoading ? 'Loading…' : 'Unit'} />
                </SelectTrigger>
                <SelectContent>
                  {compatibleUnits.map((unit) => (
                    <SelectItem key={unit.id} value={unit.id}>
                      {unit.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="recipe-component-option">Product Option</Label>
            {fixedProductOptionId ? (
              <div className="rounded-md border bg-muted/30 p-2 text-sm">{fixedProductOptionLabel ?? 'Selected option'}</div>
            ) : (
              <Select
                value={productOptionId ?? BASE_RECIPE_VALUE}
                onValueChange={(next) => setProductOptionId(next === BASE_RECIPE_VALUE ? null : next)}
                disabled={productOptionsLoading}
              >
                <SelectTrigger id="recipe-component-option">
                  <SelectValue placeholder={productOptionsLoading ? 'Loading…' : 'Base Recipe'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={BASE_RECIPE_VALUE}>Base Recipe</SelectItem>
                  {(productOptions ?? []).map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.option_group_name}: {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {isEdit && (
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="recipe-component-active">Active</Label>
                <p className="text-xs text-muted-foreground">Inactive components are excluded from Recipe Readiness and POS deduction.</p>
              </div>
              <Switch id="recipe-component-active" checked={isActive} onCheckedChange={setIsActive} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!isValid || mutation.isPending}>
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isEdit ? 'Save Changes' : 'Add Component'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
