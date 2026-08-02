'use client';

import { useEffect, useState } from 'react';
import type { InventoryItemResponse, ProductComponentResponse, UnitOfMeasureResponse } from '@potato-corner/shared';

interface UseOptionDeductionStateArgs {
  open: boolean;
  inventoryItems: InventoryItemResponse[] | undefined;
  units: UnitOfMeasureResponse[] | undefined;
}

/**
 * Local form state for one variant's Inventory Deduction card inside
 * EditOptionDialog. One instance is scoped to a single ProductComponent row
 * (one variant), so multiple variants get independent state via separate
 * hook instances rather than a single selected-variant switch.
 */
export function useOptionDeductionState({ open, inventoryItems, units }: UseOptionDeductionStateArgs) {
  const [categoryId, setCategoryId] = useState('');
  const [inventoryItemId, setInventoryItemId] = useState('');
  const [quantityRequired, setQuantityRequired] = useState('');

  useEffect(() => {
    if (!open) {
      setCategoryId('');
      setInventoryItemId('');
      setQuantityRequired('');
    }
  }, [open]);

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
