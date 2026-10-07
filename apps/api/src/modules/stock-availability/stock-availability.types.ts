/**
 * POS-PERF-P24 — quantity-based stock status, layered on top of
 * productReadinessService's config/BOM readiness. Never equates raw
 * ingredient quantity with sellable product units: every figure here is
 * "how many whole units of this product/configuration can still be sold",
 * derived by dividing available ingredient stock by the recipe's per-unit
 * requirement and taking the worst-case (minimum) across every ingredient.
 */

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock' | 'unknown';

export interface VariantStockResult {
  productVariantId: string;
  status: StockStatus;
  /** Null when status is 'unknown' or 'out_of_stock' (0), or not reliably calculable. */
  maxSellableUnits: number | null;
}

export interface CartAvailabilityLineInput {
  productVariantId: string;
  flavorId?: string | null;
  selectedFlavors?: { slotIndex: number; snackProductVariantId: string; flavorId: string }[];
  quantity: number;
}

export interface CartAvailabilityShortfall {
  inventoryItemId: string;
  itemName: string;
  available: number;
  required: number;
}

export interface CartAvailabilityResult {
  ok: boolean;
  shortfalls: CartAvailabilityShortfall[];
}
