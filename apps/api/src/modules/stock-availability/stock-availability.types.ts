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
  /** POS-PERF-P56 — what is short across every configuration; empty unless status is 'out_of_stock'. */
  shortages: StockShortage[];
}

/** POS-PERF-P56 — one ingredient that can't cover a single unit: on hand, reservations and recipe quantity are told apart so the POS can say which it is. */
export interface StockShortage {
  inventoryItemId: string;
  name: string;
  reason: 'no_stock' | 'fully_reserved' | 'below_recipe_quantity' | 'not_assigned';
  available: number;
  required: number;
  unitCode: string | null;
  trackInventory: boolean;
}

/** POS-PERF-P57 — one size/configuration a tracked item can't cover; quantities are for one serving, never summed across alternatives. */
export interface RecipeShortageAffected {
  productId: string;
  productName: string;
  variantId: string;
  variantName: string;
  choiceName: string | null;
  choiceKind: 'flavor' | 'option' | 'slot' | 'combination' | null;
  required: number;
  deficit: number;
  blocksSize: boolean;
}

export interface RecipeShortage {
  required: number;
  deficit: number;
  unitCode: string;
  affected: RecipeShortageAffected[];
}

export interface RecipeSetupIssue {
  /** Null when no one item is the cause: a Mix & Max slot with nothing to choose, or a recipe unit with no conversion. */
  inventoryItemId: string | null;
  name: string;
  reason: 'not_assigned' | 'untracked' | 'no_slot_choice' | 'no_unit_conversion';
  productName: string;
  variantName: string;
}

export interface BranchRecipeShortages {
  byItem: Map<string, RecipeShortage>;
  setupIssues: RecipeSetupIssue[];
}

/** POS-PERF-P24R — one catalog variant's flavors, so evaluateCatalogStock can check every sellable (flavor) configuration rather than just the base recipe. Empty when the variant has no flavors (base recipe is the only configuration). */
export interface CatalogStockRequest {
  productVariantId: string;
  flavorIds: string[];
  /** POS-PERF-P57 — what checkout makes the cashier pick, when there's more to it than one flavor. Absent means the flavor check alone decides. */
  choices?: RequiredStockChoices;
}

export interface RequiredStockChoices {
  flavorNames: Map<string, string>;
  slots: { label: string; options: { productVariantId: string; name: string; flavors: { flavorId: string; name: string }[] }[] }[];
  /** One entry per pick checkout requires, so a group needing two picks is listed twice. */
  requiredPicks: { id: string; name: string }[][];
}

export interface CartAvailabilityLineInput {
  productVariantId: string;
  flavorId?: string | null;
  selectedFlavors?: { slotIndex: number; snackProductVariantId: string; flavorId: string }[];
  /** POS-PERF-P41 — add-on options whose inventory mappings checkout also deducts. */
  selectedOptionIds?: string[];
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
