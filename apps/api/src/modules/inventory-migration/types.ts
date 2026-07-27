export interface LegacyIngredientRecord {
  id: string;
  name: string;
  unit: string;
  category: string;
  branchId: string;
  deletedAt: Date | null;
}

export interface LegacyFlavorRecord {
  id: string;
  name: string;
  ingredientName: string;
  ingredientUnit: string;
  isActive: boolean;
}

export interface SourceSummary {
  branchCount: number;
  ingredientCount: number;
  activeIngredientCount: number;
  softDeletedIngredientCount: number;
  distinctIngredientUnitCount: number;
  distinctIngredientCategoryCount: number;
  productInventoryCount: number;
  activeProductInventoryCount: number;
  flavorCount: number;
  activeFlavorCount: number;
  inventoryMovementCount: number;
  existingUnitOfMeasureCount: number;
  existingInventoryCategoryCount: number;
}

export type UnitClassification =
  | 'EXACT_GLOBAL_UNIT'
  | 'NORMALIZABLE_GLOBAL_UNIT'
  | 'ITEM_SPECIFIC_PACKAGE_UNIT'
  | 'UNKNOWN'
  | 'INVALID';

export interface UnitClassificationEntry {
  rawUnit: string;
  normalizedUnit: string;
  occurrenceCount: number;
  affectedIngredientIds: string[];
  /**
   * Advisory only — a human-readable canonical unit name, never a
   * UnitOfMeasure.code/id. No UnitOfMeasure row is assumed to exist;
   * resolving to an actual FK is Phase C work.
   */
  proposedCanonicalUnitName: string | null;
  classification: UnitClassification;
  blockingReason: string | null;
}

export interface CategoryCandidate {
  legacyCategory: string;
  proposedCategoryName: string;
  affectedIngredientCount: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  unresolved: boolean;
  notes: string | null;
}

export type IdentityGroupClassification =
  | 'SAFE_AUTO_MATCH_CANDIDATE'
  | 'AMBIGUOUS'
  | 'DISTINCT'
  | 'INVALID';

export interface IdentityCandidateMember {
  ingredientId: string;
  branchId: string;
  rawName: string;
  rawUnit: string;
  legacyCategory: string;
}

export interface IdentityCandidateGroup {
  normalizedName: string;
  classification: IdentityGroupClassification;
  members: IdentityCandidateMember[];
  reason: string;
}

export interface SkuCollision {
  sku: string;
  ingredientIds: string[];
}

export interface BarcodeCollision {
  barcode: string;
  ingredientIds: string[];
}

export interface FlavorLinkedCandidate {
  flavorId: string;
  flavorName: string;
  normalizedIngredientName: string;
  normalizedIngredientUnit: string;
  matchedIngredientIds: string[];
  mappingMethod: 'FLAVOR_IDENTITY';
  unresolved: boolean;
}

export interface InvalidRecord {
  ingredientId: string;
  reason: string;
}

export interface DryRunReport {
  batchId: string;
  generatedAt: string;
  sourceSummary: SourceSummary;
  normalizedUnits: UnitClassificationEntry[];
  categoryCandidates: CategoryCandidate[];
  identityCandidates: IdentityCandidateGroup[];
  ambiguousGroups: IdentityCandidateGroup[];
  barcodeCollisions: BarcodeCollision[];
  skuCollisions: SkuCollision[];
  flavorLinkedCandidates: FlavorLinkedCandidate[];
  invalidRecords: InvalidRecord[];
  blockers: string[];
  warnings: string[];
  migrationReadiness: boolean;
}
