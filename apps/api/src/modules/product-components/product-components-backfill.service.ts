import { productComponentsBackfillRepository as repo } from './product-components-backfill.repository.js';
import { productComponentsRepository } from './product-components.repository.js';
import { BACKFILL_CREATED_BY } from './product-components-backfill.types.js';
import type { BackfillConflict, BackfillReport, BackfillRow, BackfillUnresolvedMapping } from './product-components-backfill.types.js';

interface SourceValue {
  productInventoryId: string;
  quantityRequired: number;
  unit: string;
}

interface PairGroup {
  productVariantId: string;
  inventoryItemId: string;
  legacyIngredientName: string;
  values: SourceValue[];
}

function pairKey(productVariantId: string, inventoryItemId: string): string {
  return `${productVariantId}::${inventoryItemId}`;
}

function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase();
}

function distinctValueSignatures(values: SourceValue[]): Set<string> {
  return new Set(values.map((v) => `${v.quantityRequired}::${normalizeUnit(v.unit)}`));
}

/**
 * CR-011.1 — copies eligible active ProductInventory mappings into
 * ProductComponent via InventoryIdentityMapping. Read-only when
 * `confirm: false` (the default): computes and returns the exact same plan
 * a confirmed run would execute, without writing anything. Never deletes or
 * modifies ProductInventory, and never overwrites a ProductComponent row
 * this backfill didn't create itself (see BACKFILL_CREATED_BY).
 */
export async function runProductComponentBackfill(confirm: boolean = false): Promise<BackfillReport> {
  const [totalActive, eligibleRows] = await Promise.all([
    repo.countActiveProductInventoryRows(),
    repo.fetchEligibleProductInventoryRows(),
  ]);

  const legacyIngredientIds = [...new Set(eligibleRows.map((r) => r.ingredientId))];
  const identityMappings = await repo.fetchIdentityMappingsForIngredients(legacyIngredientIds);
  const mappingByIngredientId = new Map(identityMappings.map((m) => [m.legacyIngredientId, m]));

  const unresolvedMappings: BackfillUnresolvedMapping[] = [];
  const pairs = new Map<string, PairGroup>();

  for (const row of eligibleRows) {
    const mapping = mappingByIngredientId.get(row.ingredientId);
    const legacyIngredientName = row.ingredient.name;

    if (!mapping || !mapping.inventoryItemId || mapping.mappingStatus === 'PENDING' || mapping.mappingStatus === 'AMBIGUOUS' || mapping.mappingStatus === 'REJECTED') {
      unresolvedMappings.push({
        legacyIngredientId: row.ingredientId,
        legacyIngredientName,
        reason: mapping ? `Identity mapping status is ${mapping.mappingStatus}, not resolved` : 'No InventoryIdentityMapping row exists for this ingredient',
      });
      continue;
    }
    if (mapping.mappingMethod === 'FLAVOR_IDENTITY') {
      unresolvedMappings.push({
        legacyIngredientId: row.ingredientId,
        legacyIngredientName,
        reason: 'Identity mapping is flavor-linked (FLAVOR_IDENTITY) — ProductComponent has no flavor-aware column',
      });
      continue;
    }

    const key = pairKey(row.productVariantId, mapping.inventoryItemId);
    const group = pairs.get(key) ?? { productVariantId: row.productVariantId, inventoryItemId: mapping.inventoryItemId, legacyIngredientName, values: [] };
    group.values.push({ productInventoryId: row.id, quantityRequired: row.quantityRequired.toNumber(), unit: row.unit });
    pairs.set(key, group);
  }

  const baseUnits = await repo.fetchInventoryItemBaseUnits([...new Set([...pairs.values()].map((g) => g.inventoryItemId))]);
  const baseUnitByItemId = new Map(baseUnits.map((i) => [i.id, i.baseUnit.code]));

  const conflicts: BackfillConflict[] = [];
  const rows: BackfillRow[] = [];
  let created = 0;
  let skippedExistingBackfilled = 0;
  let skippedManual = 0;

  for (const group of pairs.values()) {
    const signatures = distinctValueSignatures(group.values);
    if (signatures.size > 1) {
      conflicts.push({
        productVariantId: group.productVariantId,
        inventoryItemId: group.inventoryItemId,
        legacyIngredientName: group.legacyIngredientName,
        reason: 'Source ProductInventory rows disagree on quantity/unit across branches',
        sourceValues: group.values,
      });
      continue;
    }

    const value = group.values[0];
    if (!value || !(value.quantityRequired > 0)) {
      conflicts.push({
        productVariantId: group.productVariantId,
        inventoryItemId: group.inventoryItemId,
        legacyIngredientName: group.legacyIngredientName,
        reason: 'Source quantity_required is not greater than zero',
        sourceValues: group.values,
      });
      continue;
    }

    const baseUnitCode = baseUnitByItemId.get(group.inventoryItemId);
    if (!baseUnitCode || normalizeUnit(baseUnitCode) !== normalizeUnit(value.unit)) {
      conflicts.push({
        productVariantId: group.productVariantId,
        inventoryItemId: group.inventoryItemId,
        legacyIngredientName: group.legacyIngredientName,
        reason: `Legacy unit "${value.unit}" does not match the resolved item's base unit${baseUnitCode ? ` "${baseUnitCode}"` : ' (item not found)'} — requires manual conversion`,
        sourceValues: group.values,
      });
      continue;
    }

    const existing = await repo.findExistingComponent(group.productVariantId, group.inventoryItemId);
    let action: BackfillRow['action'];
    if (!existing) {
      action = 'create';
      created += 1;
      if (confirm) {
        await productComponentsRepository.create({
          productVariantId: group.productVariantId,
          inventoryItemId: group.inventoryItemId,
          quantityRequired: value.quantityRequired,
          createdBy: BACKFILL_CREATED_BY,
        });
      }
    } else if (existing.deletedAt === null && existing.createdBy === BACKFILL_CREATED_BY) {
      action = 'skip_existing_backfilled';
      skippedExistingBackfilled += 1;
    } else {
      action = 'skip_manual';
      skippedManual += 1;
    }

    rows.push({
      action,
      productVariantId: group.productVariantId,
      inventoryItemId: group.inventoryItemId,
      legacyIngredientName: group.legacyIngredientName,
      quantityRequired: value.quantityRequired,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    dryRun: !confirm,
    eligibleProductInventoryRows: eligibleRows.length,
    excludedFlavorSpecificRows: totalActive - eligibleRows.length,
    candidatePairs: pairs.size,
    created,
    skippedExistingBackfilled,
    skippedManual,
    rows,
    unresolvedMappings,
    conflicts,
  };
}
