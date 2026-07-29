export type ReadinessIssueSeverity = 'blocking' | 'warning';

export type ReadinessIssueCode =
  | 'VARIANT_NOT_FOUND'
  | 'PRODUCT_INACTIVE'
  | 'VARIANT_INACTIVE'
  | 'VARIANT_LIFECYCLE_BLOCKED'
  | 'PRICE_MISSING'
  | 'BRANCH_NOT_AVAILABLE'
  | 'BASE_INVENTORY_MAPPING_MISSING'
  | 'FLAVOR_INVENTORY_MAPPING_MISSING'
  | 'UNLINKED_FLAVOR_MAPPING'
  | 'FLAVOR_NOT_AVAILABLE_AT_BRANCH'
  | 'MIX_MAX_SLOT_INCOMPLETE'
  | 'MIX_MAX_SNACK_UNAVAILABLE'
  | 'RECIPE_MISSING'
  | 'RECIPE_FLAVOR_SCOPE_UNSUPPORTED';

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
  baseInventoryMapped: boolean;
  flavorLinksConsistent: boolean;
  mixMaxSlotsComplete: boolean;
  recipeReady: boolean;
}

export interface ProductVariantReadinessResult {
  branchId: string;
  productId: string | null;
  productVariantId: string;
  status: 'READY' | 'NOT_READY';
  /** True only when there are zero blockingIssues — the single field every caller should gate on. */
  sellable: boolean;
  /** ProductComponent (BOM) has at least one active row — distinct from inventoryMappingReady, see RECIPE_FLAVOR_SCOPE_UNSUPPORTED. */
  recipeReady: boolean;
  /** ProductInventory mapping coverage (base + required flavor + Mix & Max snack mappings) is complete. */
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
