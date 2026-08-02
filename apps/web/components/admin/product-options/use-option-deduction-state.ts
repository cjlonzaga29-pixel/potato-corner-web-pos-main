'use client';

import { useEffect, useRef, useState } from 'react';
import type { InventoryItemResponse, ProductOptionResponse, UnitOfMeasureResponse } from '@potato-corner/shared';

interface UseOptionDeductionStateArgs {
  open: boolean;
  option: ProductOptionResponse | null;
  inventoryItems: InventoryItemResponse[] | undefined;
  units: UnitOfMeasureResponse[] | undefined;
}

export interface OptionInventoryDeductionPayload {
  inventory_item_id: string;
  deduction_unit_id: string;
  quantity_required: number;
}

/**
 * Local form state for the Edit Option dialog's Inventory Deduction section,
 * backed by ProductOptionInventoryMapping (one mapping per option — not one
 * ProductComponent row per variant, which this replaces). Tracks whether a
 * mapping existed when the dialog opened so save() can tell "never had one"
 * (omit the key, preserving whatever the backend has) apart from "had one,
 * user cleared it" (send null to delete it).
 */
export function useOptionDeductionState({ open, option, inventoryItems, units }: UseOptionDeductionStateArgs) {
  const [categoryId, setCategoryId] = useState('');
  const [inventoryItemId, setInventoryItemId] = useState('');
  const [deductionUnitId, setDeductionUnitId] = useState('');
  const [quantityRequired, setQuantityRequired] = useState('');
  const hadInitialMapping = useRef(false);

  useEffect(() => {
    if (!open) return;
    const existing = option?.inventory_deduction;
    hadInitialMapping.current = Boolean(existing);
    if (existing) {
      setCategoryId(existing.inventory_category_id ?? '');
      setInventoryItemId(existing.inventory_item_id);
      setDeductionUnitId(existing.deduction_unit_id);
      setQuantityRequired(String(existing.quantity_required));
    } else {
      setCategoryId('');
      setInventoryItemId('');
      setDeductionUnitId('');
      setQuantityRequired('');
    }
  }, [open, option]);

  function handleSetCategoryId(nextCategoryId: string) {
    setCategoryId(nextCategoryId);
    setInventoryItemId('');
    setDeductionUnitId('');
    setQuantityRequired('');
  }

  function handleSetInventoryItemId(nextItemId: string) {
    setInventoryItemId(nextItemId);
    setDeductionUnitId('');
    setQuantityRequired('');
  }

  function remove() {
    setCategoryId('');
    setInventoryItemId('');
    setDeductionUnitId('');
    setQuantityRequired('');
  }

  const itemsInCategory = (inventoryItems ?? []).filter((item) => item.category_id === categoryId);
  const selectedItem = inventoryItems?.find((item) => item.id === inventoryItemId);
  const baseUnit = units?.find((unit) => unit.id === selectedItem?.base_unit_id);
  const compatibleDeductionUnits = baseUnit ? (units ?? []).filter((unit) => unit.dimension === baseUnit.dimension) : [];

  const hasValidInput = Boolean(inventoryItemId) && Boolean(deductionUnitId) && quantityRequired !== '' && Number(quantityRequired) > 0;

  function toPayload(): OptionInventoryDeductionPayload | null | undefined {
    if (hasValidInput) {
      return { inventory_item_id: inventoryItemId, deduction_unit_id: deductionUnitId, quantity_required: Number(quantityRequired) };
    }
    return hadInitialMapping.current ? null : undefined;
  }

  return {
    categoryId,
    setCategoryId: handleSetCategoryId,
    inventoryItemId,
    setInventoryItemId: handleSetInventoryItemId,
    deductionUnitId,
    setDeductionUnitId,
    quantityRequired,
    setQuantityRequired,
    itemsInCategory,
    selectedItem,
    baseUnit,
    compatibleDeductionUnits,
    remove,
    toPayload,
  };
}
