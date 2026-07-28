/**
 * CR-012.1 -- Shadow BOM Deduction Calculation.
 *
 * Read-only, shadow-mode comparison of what a future ProductComponent/BOM
 * deduction would have been against the legacy ProductInventory deduction
 * that actually ran for a completed POS sale line. Nothing in this module
 * writes InventoryMovement/InventoryStock/ProductInventory, and nothing here
 * is read by any POS/inventory/reporting runtime path -- it exists purely to
 * build confidence ahead of a future CR that cuts POS deduction over to BOM.
 */

export const SHADOW_BOM_CLASSIFICATIONS = [
  'MATCH',
  'BOM_NOT_READY',
  'MISSING_LEGACY_MAPPING',
  'MISSING_BOM_COMPONENT',
  'EXTRA_BOM_COMPONENT',
  'QUANTITY_MISMATCH',
  'UNIT_CONVERSION_UNSUPPORTED',
  'FLAVOR_DEPENDENCY',
  'ERROR',
] as const;

export type ShadowBomClassification = (typeof SHADOW_BOM_CLASSIFICATIONS)[number];

/** A legacy ProductInventory deduction line, normalized onto its canonical InventoryItem via an accepted InventoryIdentityMapping. */
export interface NormalizedLegacyLine {
  inventoryItemId: string;
  baseUnitId: string;
  quantity: number;
}

/** A BOM (ProductComponent) deduction line -- already expressed in the InventoryItem's own base unit, no mapping/normalization needed. */
export interface BomDeductionLine {
  inventoryItemId: string;
  baseUnitId: string;
  quantity: number;
}

/**
 * Result of normalizing the legacy deduction lines for one sale line.
 * `ok: false` short-circuits `compareDeductions` straight to the given
 * classification -- MISSING_LEGACY_MAPPING (an ingredient has no accepted
 * identity mapping yet) takes priority over UNIT_CONVERSION_UNSUPPORTED (the
 * mapping exists, but the legacy row's free-text `unit` doesn't match the
 * mapped InventoryItem's base unit, so quantities aren't directly
 * comparable without a conversion this module intentionally does not do).
 */
export type NormalizeLegacyResult =
  | { ok: true; lines: NormalizedLegacyLine[] }
  | { ok: false; classification: 'MISSING_LEGACY_MAPPING' | 'UNIT_CONVERSION_UNSUPPORTED' };

export interface ShadowComparisonInput {
  transactionId: string;
  saleLineId: string;
  branchId: string;
  productVariantId: string;
  quantitySold: number;
}

export interface PersistedComparison {
  transactionId: string;
  saleLineId: string;
  branchId: string;
  productVariantId: string;
  legacyCalculation: unknown;
  bomCalculation: unknown;
  classification: ShadowBomClassification;
  errorDetails: unknown;
}

export interface ShadowBomReportFilters {
  since?: Date;
  until?: Date;
  branchId?: string;
  productVariantId?: string;
  classification?: ShadowBomClassification;
}
