import type {
  LegacyIngredientRecord,
  IdentityCandidateGroup,
  IdentityCandidateMember,
  SkuCollision,
  BarcodeCollision,
} from './types.js';
import { normalizeInventoryName, normalizeLegacyUnit } from './normalization.js';

/**
 * CR-007 SS20.4/SS3 — matching normalized names alone is never sufficient.
 * A group is SAFE_AUTO_MATCH_CANDIDATE only when every member also shares
 * unit and legacy category; any disagreement drops it to AMBIGUOUS for
 * manual review rather than being auto-resolved here.
 */
export function detectIdentityCollisions(ingredients: LegacyIngredientRecord[]): IdentityCandidateGroup[] {
  const active = ingredients.filter((i) => i.deletedAt === null);
  const byName = new Map<string, LegacyIngredientRecord[]>();

  for (const ingredient of active) {
    const { normalized } = normalizeInventoryName(ingredient.name);
    const list = byName.get(normalized);
    if (list) list.push(ingredient);
    else byName.set(normalized, [ingredient]);
  }

  const groups: IdentityCandidateGroup[] = [];

  for (const [normalizedName, members] of byName) {
    if (normalizedName.length === 0) {
      groups.push({
        normalizedName,
        classification: 'INVALID',
        members: toMembers(members),
        reason: 'Ingredient name is empty or whitespace-only',
      });
      continue;
    }

    if (members.length === 1) {
      groups.push({
        normalizedName,
        classification: 'DISTINCT',
        members: toMembers(members),
        reason: 'Only one legacy ingredient shares this normalized name',
      });
      continue;
    }

    const subkeyOf = (i: LegacyIngredientRecord) => `${normalizeLegacyUnit(i.unit).normalized}::${i.category}`;
    const distinctSubkeys = new Set(members.map(subkeyOf));

    if (distinctSubkeys.size === 1) {
      groups.push({
        normalizedName,
        classification: 'SAFE_AUTO_MATCH_CANDIDATE',
        members: toMembers(members),
        reason: 'Same normalized name, unit, and legacy category across all members',
      });
    } else {
      groups.push({
        normalizedName,
        classification: 'AMBIGUOUS',
        members: toMembers(members),
        reason: 'Same normalized name but conflicting unit and/or legacy category across members',
      });
    }
  }

  return groups;
}

function toMembers(ingredients: LegacyIngredientRecord[]): IdentityCandidateMember[] {
  return ingredients.map((i) => ({
    ingredientId: i.id,
    branchId: i.branchId,
    rawName: i.name,
    rawUnit: i.unit,
    legacyCategory: i.category,
  }));
}

/**
 * Legacy `Ingredient` has no `sku`/`barcode` columns (see
 * docs/decisions/CR-006-phase-b-migration-source-inventory.md) — these
 * always return empty until a legacy SKU/barcode source exists to check.
 * Kept as explicit functions (not omitted) so the dry-run report's
 * skuCollisions/barcodeCollisions sections are structurally present per
 * CR-006 Phase B requirement 6, with the reason documented here rather than
 * silently absent.
 */
export function detectSkuCollisions(): SkuCollision[] {
  return [];
}

export function detectBarcodeCollisions(): BarcodeCollision[] {
  return [];
}
