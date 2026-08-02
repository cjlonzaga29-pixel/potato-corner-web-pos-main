'use client';

import { forwardRef, useEffect, useImperativeHandle } from 'react';
import type { InventoryCategoryResponse, InventoryItemResponse, UnitOfMeasureResponse } from '@potato-corner/shared';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useProductComponents, useCreateProductComponent, useUpdateProductComponent, useDeleteProductComponent } from '@/hooks/queries/use-product-components';
import { useOptionDeductionState } from './use-option-deduction-state';

export interface VariantDeductionCardHandle {
  save: () => Promise<void>;
}

interface VariantDeductionCardProps {
  variantId: string;
  variantLabel: string;
  optionId: string;
  open: boolean;
  showHeader: boolean;
  categories: InventoryCategoryResponse[] | undefined;
  inventoryItems: InventoryItemResponse[] | undefined;
  units: UnitOfMeasureResponse[] | undefined;
}

/** One ProductComponent row (this variant + this option) editor. Rendered once per variant assigned to the option's group. */
export const VariantDeductionCard = forwardRef<VariantDeductionCardHandle, VariantDeductionCardProps>(function VariantDeductionCard(
  { variantId, variantLabel, optionId, open, showHeader, categories, inventoryItems, units },
  ref,
) {
  const deduction = useOptionDeductionState({ open, inventoryItems, units });

  const { data: components } = useProductComponents(variantId);
  const existingComponent = components?.find((component) => component.product_option_id === optionId);

  useEffect(() => {
    deduction.hydrateFromExistingComponent(existingComponent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingComponent?.id, existingComponent?.quantity_required, existingComponent?.inventory_item_id]);

  const createComponent = useCreateProductComponent(variantId);
  const updateComponent = useUpdateProductComponent(variantId, existingComponent?.id ?? '');
  const deleteComponent = useDeleteProductComponent(variantId);

  useImperativeHandle(ref, () => ({
    async save() {
      const hasDeductionInput = Boolean(deduction.inventoryItemId) && deduction.quantityRequired !== '' && Number(deduction.quantityRequired) > 0;

      if (!hasDeductionInput) {
        if (existingComponent) await deleteComponent.mutateAsync(existingComponent.id);
        return;
      }

      if (!deduction.baseUnit) return;

      if (existingComponent && existingComponent.inventory_item_id === deduction.inventoryItemId) {
        await updateComponent.mutateAsync({
          quantity_required: Number(deduction.quantityRequired),
          recipe_unit_id: deduction.baseUnit.id,
        });
      } else {
        if (existingComponent) await deleteComponent.mutateAsync(existingComponent.id);
        await createComponent.mutateAsync({
          product_variant_id: variantId,
          inventory_item_id: deduction.inventoryItemId,
          quantity_required: Number(deduction.quantityRequired),
          recipe_unit_id: deduction.baseUnit.id,
          product_option_id: optionId,
        });
      }
    },
  }));

  return (
    <div className={showHeader ? 'space-y-3 rounded-md border p-3' : 'space-y-3'}>
      {showHeader && <p className="text-sm font-medium">{variantLabel}</p>}

      <div className="space-y-2">
        <Label htmlFor={`deduction-category-${variantId}`}>Inventory Category</Label>
        <Select value={deduction.categoryId} onValueChange={deduction.setCategoryId}>
          <SelectTrigger id={`deduction-category-${variantId}`}>
            <SelectValue placeholder="Select a category" />
          </SelectTrigger>
          <SelectContent>
            {(categories ?? []).map((category) => (
              <SelectItem key={category.id} value={category.id}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`deduction-item-${variantId}`}>Inventory Item</Label>
        <Select value={deduction.inventoryItemId} onValueChange={deduction.setInventoryItemId} disabled={!deduction.categoryId}>
          <SelectTrigger id={`deduction-item-${variantId}`}>
            <SelectValue placeholder={deduction.categoryId ? 'Select an item' : 'Select a category first'} />
          </SelectTrigger>
          <SelectContent>
            {deduction.itemsInCategory.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>Base Unit</Label>
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
            {deduction.baseUnit ? `${deduction.baseUnit.code} — ${deduction.baseUnit.name}` : '—'}
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`deduction-quantity-${variantId}`}>Quantity Required</Label>
          <Input
            id={`deduction-quantity-${variantId}`}
            type="number"
            min="0"
            step="0.0001"
            value={deduction.quantityRequired}
            onChange={(event) => deduction.setQuantityRequired(event.target.value)}
          />
        </div>
      </div>

      {deduction.selectedItem && deduction.quantityRequired !== '' && (
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <p className="text-xs font-medium uppercase text-muted-foreground">Deduction Preview</p>
          <p className="mt-2 font-medium">{deduction.selectedItem.name}</p>
          <p className="text-base font-semibold">
            {deduction.quantityRequired} {deduction.baseUnit?.code ?? ''}
          </p>
          {deduction.selectedItem.category_name && <p className="text-xs text-muted-foreground">from {deduction.selectedItem.category_name}</p>}
          <p className="text-xs text-muted-foreground">per item sold</p>
        </div>
      )}
    </div>
  );
});
