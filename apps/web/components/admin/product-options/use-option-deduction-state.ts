'use client';

import { useEffect, useState } from 'react';
import type { InventoryItemResponse, ProductComponentResponse, ProductOptionAssignedVariantResponse, UnitOfMeasureResponse } from '@potato-corner/shared';

interface UseOptionDeductionStateArgs {
  open: boolean;
  optionId: string;
  assignedVariants: ProductOptionAssignedVariantResponse[] | undefined;
  inventoryItems: InventoryItemResponse[] | undefined;
  units: UnitOfMeasureResponse[] | undefined;
}

/**
 * Local form state for the Inventory Deduction section embedded in
 * EditOptionDialog. One option can be assigned to multiple variants
 * (ProductOption is reusable across products), so a variant must still be
 * picked to know which ProductComponent row to write — this is folded into
 * the same dialog rather than a separate "Manage Deduction" workflow.
 */
export function useOptionDeductionState({ open, optionId, assignedVariants, inventoryItems, units }: UseOptionDeductionStateArgs) {
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState('');
  const [inventoryItemId, setInventoryItemId] = useState('');
  const [quantityRequired, setQuantityRequired] = useState('');

  useEffect(() => {
    if (!open) {
      setSelectedVariantId(null);
      setCategoryId('');
      setInventoryItemId('');
      setQuantityRequired('');
      return;
    }
    if (assignedVariants && assignedVariants.length === 1 && assignedVariants[0]) {
      setSelectedVariantId(assignedVariants[0].product_variant_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, optionId, assignedVariants?.length]);

  function handleSetInventoryItemId(nextItemId: string) {
    setInventoryItemId(nextItemId);
    setQuantityRequired('');
  }

  function handleSetCategoryId(nextCategoryId: string) {
    setCategoryId(nextCategoryId);
    setInventoryItemId('');
    setQuantityRequired('');
  }

  function hydrateFromExistingComponent(existingComponent: ProductComponentResponse | undefined) {
    if (!existingComponent) {
      setCategoryId('');
      setInventoryItemId('');
      setQuantityRequired('');
      return;
    }
    const item = inventoryItems?.find((candidate) => candidate.id === existingComponent.inventory_item_id);
    setCategoryId(item?.category_id ?? '');
    setInventoryItemId(existingComponent.inventory_item_id);
    setQuantityRequired(String(existingComponent.quantity_required));
  }

  const itemsInCategory = (inventoryItems ?? []).filter((item) => item.category_id === categoryId);
  const selectedItem = inventoryItems?.find((item) => item.id === inventoryItemId);
  const baseUnit = units?.find((unit) => unit.code === selectedItem?.base_unit_code);

  return {
    selectedVariantId,
    setSelectedVariantId,
    categoryId,
    setCategoryId: handleSetCategoryId,
    inventoryItemId,
    setInventoryItemId: handleSetInventoryItemId,
    quantityRequired,
    setQuantityRequired,
    itemsInCategory,
    selectedItem,
    baseUnit,
    hydrateFromExistingComponent,
  };
}
