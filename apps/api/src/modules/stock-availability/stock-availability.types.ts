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

/** POS-PERF-P24R — one catalog variant's flavors, so evaluateCatalogStock can check every sellable (flavor) configuration rather than just the base recipe. Empty when the variant has no flavors (base recipe is the only configuration). */
export interface CatalogStockRequest {
  productVariantId: string;
  flavorIds: string[];
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
