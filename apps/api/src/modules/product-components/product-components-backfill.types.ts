/**
 * CR-011.1 — legacy ProductInventory -> ProductComponent backfill. Marks
 * every row this backfill creates with this createdBy value, so a re-run
 * (or the manual-row-protection check) can tell a backfill-created row
 * apart from one an Admin created through the API.
 */
export const BACKFILL_CREATED_BY = 'system:cr011-legacy-backfill';

export type BackfillRowAction = 'create' | 'skip_existing_backfilled' | 'skip_manual';

export interface BackfillRow {
  action: BackfillRowAction;
  productVariantId: string;
  inventoryItemId: string;
  legacyIngredientName: string;
  quantityRequired: number;
}

export interface BackfillUnresolvedMapping {
  legacyIngredientId: string;
  legacyIngredientName: string;
  reason: string;
}

export interface BackfillConflict {
  productVariantId: string;
  inventoryItemId: string;
  legacyIngredientName: string;
  reason: string;
  sourceValues: { productInventoryId: string; quantityRequired: number; unit: string }[];
}

export interface BackfillReport {
  generatedAt: string;
  dryRun: boolean;
  eligibleProductInventoryRows: number;
  excludedFlavorSpecificRows: number;
  candidatePairs: number;
  created: number;
  skippedExistingBackfilled: number;
  skippedManual: number;
  rows: BackfillRow[];
  unresolvedMappings: BackfillUnresolvedMapping[];
  conflicts: BackfillConflict[];
}
