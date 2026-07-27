import type { LegacyFlavorRecord, LegacyIngredientRecord, FlavorLinkedCandidate } from './types.js';
import { normalizeInventoryName, normalizeLegacyUnit } from './normalization.js';

/**
 * CR-007 SS11.2/SS20 — flavors resolve to physical stock via name+unit today
 * (the interim CR-005 resolver); this identifies those legacy links as
 * FLAVOR_IDENTITY candidates for the later InventoryIdentityMapping
 * backfill. Does not touch the flavor runtime path.
 */
export function detectFlavorLinkedCandidates(
  flavors: LegacyFlavorRecord[],
  ingredients: LegacyIngredientRecord[],
): FlavorLinkedCandidate[] {
  const active = ingredients.filter((i) => i.deletedAt === null);

  return flavors.map((flavor) => {
    const normalizedIngredientName = normalizeInventoryName(flavor.ingredientName).normalized;
    const normalizedIngredientUnit = normalizeLegacyUnit(flavor.ingredientUnit).normalized;

    const matched = active.filter(
      (ingredient) =>
        normalizeInventoryName(ingredient.name).normalized === normalizedIngredientName &&
        normalizeLegacyUnit(ingredient.unit).normalized === normalizedIngredientUnit,
    );

    return {
      flavorId: flavor.id,
      flavorName: flavor.name,
      normalizedIngredientName,
      normalizedIngredientUnit,
      matchedIngredientIds: matched.map((i) => i.id),
      mappingMethod: 'FLAVOR_IDENTITY' as const,
      unresolved: matched.length === 0,
    };
  });
}
