import { universalInventoryRepository as repo } from './universal-inventory.repository.js';

/**
 * TASK 209.56D — owner-confirmed density for Potato Corner flavor powders:
 * 1 tbsp = 0.006 kg. This is a physical-material fact for these specific
 * ingredients, not a general tbsp<->kg rule, so it is written as an
 * InventoryItemUnitConversion row per item (TASK 115's item-specific
 * override), never a global UnitConversion row. Do not add unrelated tbsp
 * ingredients to this list without separate owner confirmation of their
 * density, and do not reuse this factor for Henlin without independently
 * verifying its powders are the same physical material.
 */
export const POTATO_CORNER_TBSP_TO_KG_FACTOR = 0.006;

export const POTATO_CORNER_FLAVOR_POWDER_ITEM_NAMES = [
  'BBQ Flavor Powder',
  'Cheese Flavor Powder',
  'Chili BBQ Flavor Powder',
  'Chili Cheese Flavor Powder',
  'Golden Sweet Corn Flavor Powder',
  'Sour Cheese Flavor Powder',
  'Sour Cream Flavor Powder',
  'Sweet Corn Flavor Powder',
  'Truffle Flavor Powder',
  'White Cheddar Flavor Powder',
] as const;

export interface PowderConversionSeedReport {
  /** Item conversion rows created (or, in dry-run, that would be created). */
  created: { itemName: string; itemId: string }[];
  /** Item already has this exact tbsp->kg factor configured — no-op. */
  alreadyConfigured: { itemName: string; itemId: string }[];
  /** Item has a tbsp->kg conversion but with a different factor — never overwritten automatically. */
  conflicting: { itemName: string; itemId: string; existingFactor: string }[];
  /** Item's base unit is not tbsp (renamed/reconfigured since this list was written) — skipped, not forced. */
  baseUnitMismatch: { itemName: string; itemId: string; baseUnitCode: string }[];
  /** Name from the canonical list has no matching active InventoryItem. */
  notFound: string[];
}

/**
 * Idempotent: re-running with apply=true after a successful run creates
 * nothing new (already-configured rows are recognized and skipped). Never
 * touches items outside POTATO_CORNER_FLAVOR_POWDER_ITEM_NAMES, never
 * overwrites an existing differing factor, never creates a global
 * UnitConversion row.
 */
export async function seedPotatoCornerPowderConversions(apply: boolean): Promise<PowderConversionSeedReport> {
  const [tbspUnit, kgUnit] = await Promise.all([repo.findUnitByCode('tbsp'), repo.findUnitByCode('kg')]);
  if (!tbspUnit) throw new Error('Seed aborted: no active "tbsp" UnitOfMeasure found.');
  if (!kgUnit) throw new Error('Seed aborted: no active "kg" UnitOfMeasure found.');

  const report: PowderConversionSeedReport = {
    created: [],
    alreadyConfigured: [],
    conflicting: [],
    baseUnitMismatch: [],
    notFound: [],
  };

  for (const itemName of POTATO_CORNER_FLAVOR_POWDER_ITEM_NAMES) {
    const item = await repo.findItemByName(itemName);
    if (!item) {
      report.notFound.push(itemName);
      continue;
    }

    if (item.baseUnitId !== tbspUnit.id) {
      const baseUnit = await repo.findUnitById(item.baseUnitId);
      report.baseUnitMismatch.push({ itemName, itemId: item.id, baseUnitCode: baseUnit?.code ?? item.baseUnitId });
      continue;
    }

    const existing = await repo.findItemConversion(item.id, tbspUnit.id, kgUnit.id);
    if (existing) {
      if (existing.factor.toNumber() === POTATO_CORNER_TBSP_TO_KG_FACTOR) {
        report.alreadyConfigured.push({ itemName, itemId: item.id });
      } else {
        report.conflicting.push({ itemName, itemId: item.id, existingFactor: existing.factor.toString() });
      }
      continue;
    }

    if (apply) {
      await repo.createItemConversion({
        inventoryItemId: item.id,
        fromUnitId: tbspUnit.id,
        toUnitId: kgUnit.id,
        factor: POTATO_CORNER_TBSP_TO_KG_FACTOR,
      });
    }
    report.created.push({ itemName, itemId: item.id });
  }

  return report;
}
