import type { LegacyIngredientRecord, UnitClassificationEntry } from './types.js';
import { normalizeLegacyUnit } from './normalization.js';

const KNOWN_GLOBAL_UNIT_SYNONYMS: Record<string, { canonicalName: string }> = {
  gram: { canonicalName: 'gram' },
  grams: { canonicalName: 'gram' },
  g: { canonicalName: 'gram' },
  kilogram: { canonicalName: 'kilogram' },
  kilograms: { canonicalName: 'kilogram' },
  kg: { canonicalName: 'kilogram' },
  liter: { canonicalName: 'liter' },
  litre: { canonicalName: 'liter' },
  liters: { canonicalName: 'liter' },
  litres: { canonicalName: 'liter' },
  l: { canonicalName: 'liter' },
  milliliter: { canonicalName: 'milliliter' },
  millilitre: { canonicalName: 'milliliter' },
  ml: { canonicalName: 'milliliter' },
  piece: { canonicalName: 'piece' },
  pieces: { canonicalName: 'piece' },
  pc: { canonicalName: 'piece' },
  pcs: { canonicalName: 'piece' },
};

const KNOWN_PACKAGE_UNITS = new Set([
  'box', 'boxes', 'case', 'cases', 'tray', 'trays', 'sack', 'sacks',
  'bag', 'bags', 'pack', 'packs', 'pouch', 'pouches', 'sachet', 'sachets',
  'bottle', 'bottles', 'jar', 'jars', 'can', 'cans', 'drum', 'drums',
]);

export function classifyLegacyUnits(
  ingredients: LegacyIngredientRecord[],
  existingUnits: { code: string }[],
): UnitClassificationEntry[] {
  const existingCodes = new Set(existingUnits.map((u) => u.code.toLowerCase()));
  const groups = new Map<string, { rawUnit: string; affectedIngredientIds: string[] }>();

  for (const ingredient of ingredients) {
    const { normalized } = normalizeLegacyUnit(ingredient.unit);
    const group = groups.get(normalized);
    if (group) {
      group.affectedIngredientIds.push(ingredient.id);
    } else {
      groups.set(normalized, { rawUnit: ingredient.unit, affectedIngredientIds: [ingredient.id] });
    }
  }

  return Array.from(groups.entries()).map(([normalizedUnit, group]) =>
    classifySingleUnit(normalizedUnit, group.rawUnit, group.affectedIngredientIds, existingCodes),
  );
}

function classifySingleUnit(
  normalizedUnit: string,
  rawUnit: string,
  affectedIngredientIds: string[],
  existingCodes: Set<string>,
): UnitClassificationEntry {
  const occurrenceCount = affectedIngredientIds.length;
  const base = { rawUnit, normalizedUnit, occurrenceCount, affectedIngredientIds };

  if (normalizedUnit.length === 0) {
    return {
      ...base,
      proposedCanonicalUnitName: null,
      classification: 'INVALID',
      blockingReason: 'Unit is empty or whitespace-only',
    };
  }

  if (existingCodes.has(normalizedUnit)) {
    return {
      ...base,
      proposedCanonicalUnitName: normalizedUnit,
      classification: 'EXACT_GLOBAL_UNIT',
      blockingReason: null,
    };
  }

  const synonym = KNOWN_GLOBAL_UNIT_SYNONYMS[normalizedUnit];
  if (synonym) {
    return {
      ...base,
      proposedCanonicalUnitName: synonym.canonicalName,
      classification: 'NORMALIZABLE_GLOBAL_UNIT',
      blockingReason: null,
    };
  }

  if (KNOWN_PACKAGE_UNITS.has(normalizedUnit)) {
    return {
      ...base,
      proposedCanonicalUnitName: null,
      classification: 'ITEM_SPECIFIC_PACKAGE_UNIT',
      blockingReason: 'Package unit requires an explicit per-item conversion; none is created in Phase B',
    };
  }

  return {
    ...base,
    proposedCanonicalUnitName: null,
    classification: 'UNKNOWN',
    blockingReason: 'No known global-unit synonym or package-unit mapping; requires manual classification',
  };
}
