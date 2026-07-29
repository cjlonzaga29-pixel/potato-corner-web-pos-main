export type ReadinessIssueSeverity = 'blocking' | 'warning';

export type ReadinessIssueCode =
  | 'VARIANT_NOT_FOUND'
  | 'PRODUCT_INACTIVE'
  | 'VARIANT_INACTIVE'
  | 'VARIANT_LIFECYCLE_BLOCKED'
  | 'PRICE_MISSING'
  | 'BRANCH_NOT_AVAILABLE'
  | 'RECIPE_MISSING'
  | 'INVALID_COMPONENT'
  | 'INVENTORY_STOCK_MISSING'
  | 'FLAVOR_NOT_AVAILABLE_AT_BRANCH'
  | 'MIX_MAX_SLOT_INCOMPLETE'
  | 'MIX_MAX_SNACK_UNAVAILABLE'
  | 'NO_ELIGIBLE_VARIANTS';

export interface ReadinessIssue {
  code: ReadinessIssueCode;
  severity: ReadinessIssueSeverity;
  entityType: 'product' | 'product_variant' | 'flavor' | 'flavor_slot' | 'branch';
  entityId: string;
  message: string;
  recommendedAction: string;
  productId?: string;
  productVariantId?: string;
  branchId?: string;
  flavorId?: string;
  flavorName?: string;
}

/**
 * Booleans mirror the individual gates evaluated below. flavorLinksConsistent
 * and mixMaxSlotsComplete are true when they have nothing to evaluate (a
 * non-flavored / non-Mix&Max variant trivially satisfies them) — they only
 * turn false when a concrete blocking issue was found for that area.
 */
export interface ReadinessChecks {
  variantExists: boolean;
  productActive: boolean;
  variantActive: boolean;
  variantLifecycleActive: boolean;
  priceValid: boolean;
  branchAvailable: boolean;
  recipeReady: boolean;
  componentsValid: boolean;
  inventoryStockReady: boolean;
  flavorLinksConsistent: boolean;
  mixMaxSlotsComplete: boolean;
}

export interface ProductVariantReadinessResult {
  branchId: string;
  productId: string | null;
  productVariantId: string;
  status: 'READY' | 'NOT_READY';
  /** True only when there are zero blockingIssues — the single field every caller should gate on. */
  sellable: boolean;
  /** ProductComponent (Recipe/BOM) has at least one active row. */
  recipeReady: boolean;
  /** Every active ProductComponent row is valid and has an InventoryStock row at this branch. */
  inventoryMappingReady: boolean;
  /** Equivalent to `sellable` — named separately so callers evaluating "is this addable to a POS cart" have a self-describing field. */
  posSellable: boolean;
  completionPercentage: number;
  checks: ReadinessChecks;
  blockingIssues: ReadinessIssue[];
  warnings: ReadinessIssue[];
}

export interface EvaluateReadinessInput {
  branchId: string;
  productVariantId: string;
}

export interface EvaluateReadinessBatchInput {
  branchId: string;
  productVariantIds: string[];
}

export interface EvaluateProductReadinessInput {
  productId: string;
  branchId: string;
}

/**
 * Product-level aggregation over evaluateProductVariantReadinessBatch — a
 * new roll-up layer, not a duplicate of the per-variant engine. Only
 * "eligible" variants (isActive && lifecycleStatus === 'ACTIVE') count toward
 * readiness: a variant an admin has intentionally deactivated/archived
 * should not perpetually block the product from being marked ready.
 */
export interface ProductVariantReadinessSummary {
  productVariantId: string;
  variantName: string;
  status: 'READY' | 'NOT_READY';
  sellable: boolean;
  completionPercentage: number;
  recipeReady: boolean;
  inventoryMappingReady: boolean;
  blockingIssues: ReadinessIssue[];
  warnings: ReadinessIssue[];
}

export interface ProductReadinessResult {
  productId: string;
  branchId: string;
  status: 'READY' | 'NOT_READY';
  sellable: boolean;
  completionPercentage: number;
  variantCount: number;
  eligibleVariantCount: number;
  readyVariantCount: number;
  blockingIssues: ReadinessIssue[];
  warnings: ReadinessIssue[];
  variants: ProductVariantReadinessSummary[];
}
