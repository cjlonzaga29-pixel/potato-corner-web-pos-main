import type { LegacyIngredientRecord, CategoryCandidate } from './types.js';

/**
 * Migration candidates only — CR-007 SS20.5 forbids hardcoding a fixed
 * food-specific enum. These are proposals against the configurable
 * InventoryCategory table, not universal schema constants.
 */
const CATEGORY_CANDIDATE_MAP: Record<string, { name: string; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; notes: string | null }> = {
  RAW: { name: 'Raw Material', confidence: 'HIGH', notes: null },
  FLAVOR: { name: 'Flavor', confidence: 'HIGH', notes: 'Distinct from generic Seasoning; carries flavor-linked identity semantics (see flavor-linked.ts)' },
  CUP: { name: 'Packaging', confidence: 'HIGH', notes: null },
  BAG: { name: 'Packaging', confidence: 'HIGH', notes: null },
  PACKAGING: { name: 'Packaging', confidence: 'HIGH', notes: null },
  OTHER: { name: 'Other', confidence: 'LOW', notes: 'Legacy OTHER bucket; requires manual review before assigning a real category' },
};

export function classifyLegacyCategories(ingredients: LegacyIngredientRecord[]): CategoryCandidate[] {
  const counts = new Map<string, number>();
  for (const ingredient of ingredients) {
    counts.set(ingredient.category, (counts.get(ingredient.category) ?? 0) + 1);
  }

  return Array.from(counts.entries()).map(([legacyCategory, affectedIngredientCount]) => {
    const mapping = CATEGORY_CANDIDATE_MAP[legacyCategory];
    if (mapping) {
      return {
        legacyCategory,
        proposedCategoryName: mapping.name,
        affectedIngredientCount,
        confidence: mapping.confidence,
        unresolved: mapping.confidence === 'LOW',
        notes: mapping.notes,
      };
    }
    return {
      legacyCategory,
      proposedCategoryName: legacyCategory,
      affectedIngredientCount,
      confidence: 'LOW' as const,
      unresolved: true,
      notes: 'No known mapping for this legacy category value',
    };
  });
}
