import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FILES, runValidation } from './validate-inventory-setup';

// Complete, valid fixture set for a single branch, kept minimal but covering
// every business rule so individual tests can mutate one row at a time.
const BRANCH = 'Branch A';

function ingredientsCsv(rows: string[]): string {
  return ['branch_name,inventory_item_name,item_type,stock_unit,cost_per_unit,reorder_level,notes', ...rows].join('\n');
}

const baseIngredients = [
  `${BRANCH},Fries Base,RAW_MATERIAL,kg,10,5,`,
  `${BRANCH},Cooking Oil,RAW_MATERIAL,L,20,5,`,
  `${BRANCH},Regular Fries Cup,PACKAGING,pc,1,50,`,
  `${BRANCH},Cheese Powder,SEASONING,kg,15,2,`,
  `${BRANCH},Bottled Water,FINISHED_GOOD,pc,20,10,`,
];

function productBomCsv(rows: string[]): string {
  return [
    'branch_name,product_name,variant_name,inventory_item_name,mapping_type,quantity_required,unit,required_from_user,notes',
    ...rows,
  ].join('\n');
}

const baseProductBom = [
  `${BRANCH},Flavored Fries,Regular,Fries Base,BASE,0.2,kg,NO,`,
  `${BRANCH},Flavored Fries,Regular,Cooking Oil,BASE,0.05,L,NO,`,
  `${BRANCH},Flavored Fries,Regular,Regular Fries Cup,PACKAGING,1,pc,NO,`,
  `${BRANCH},Drinks,Water,Bottled Water,FINISHED_GOOD,1,pc,NO,`,
];

function flavorBomCsv(rows: string[]): string {
  return ['branch_name,product_name,variant_name,flavor_name,inventory_item_name,quantity_required,unit,required_from_user,notes', ...rows].join(
    '\n',
  );
}

const baseFlavorBom = [`${BRANCH},Flavored Fries,Regular,Cheese,Cheese Powder,0.01,kg,NO,`];

function mixMaxCsv(rows: string[]): string {
  return ['mix_variant,slot_index,slot_label,allowed_snack_product,allowed_snack_variant,required,notes', ...rows].join('\n');
}

const baseMixMax = ['Large Mix,1,Slot 1,Flavored Fries,Regular,TRUE,', 'Large Mix,2,Slot 2,Loopys,Large,FALSE,'];

function openingStockCsv(rows: string[]): string {
  return ['branch_name,inventory_item_name,opening_quantity,unit,unit_cost,effective_date,notes', ...rows].join('\n');
}

const baseOpeningStock = [
  `${BRANCH},Fries Base,10,kg,10,2026-01-01,`,
  `${BRANCH},Cooking Oil,10,L,20,2026-01-01,`,
  `${BRANCH},Regular Fries Cup,100,pc,1,2026-01-01,`,
  `${BRANCH},Cheese Powder,5,kg,15,2026-01-01,`,
  `${BRANCH},Bottled Water,20,pc,20,2026-01-01,`,
];

let tmpDir: string;

function writeFixtures(overrides: Partial<Record<keyof typeof FILES, string>> = {}) {
  writeFileSync(path.join(tmpDir, FILES.ingredients), overrides.ingredients ?? ingredientsCsv(baseIngredients));
  writeFileSync(path.join(tmpDir, FILES.productBom), overrides.productBom ?? productBomCsv(baseProductBom));
  writeFileSync(path.join(tmpDir, FILES.flavorBom), overrides.flavorBom ?? flavorBomCsv(baseFlavorBom));
  writeFileSync(path.join(tmpDir, FILES.mixMax), overrides.mixMax ?? mixMaxCsv(baseMixMax));
  writeFileSync(path.join(tmpDir, FILES.openingStock), overrides.openingStock ?? openingStockCsv(baseOpeningStock));
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'inventory-setup-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('validate-inventory-setup', () => {
  it('passes on a valid, complete sample', () => {
    writeFixtures();
    const report = runValidation(tmpDir);
    expect(report.result).toBe('PASS');
    expect(report.errors).toHaveLength(0);
  });

  it('reports a missing required value', () => {
    writeFixtures({
      ingredients: ingredientsCsv([`,Fries Base,RAW_MATERIAL,kg,10,5,`, ...baseIngredients.slice(1)]),
    });
    const report = runValidation(tmpDir);
    expect(report.result).toBe('FAIL');
    expect(report.errors.some((e) => e.file === FILES.ingredients && e.message.includes('branch_name is required'))).toBe(true);
  });

  it('reports an invalid quantity', () => {
    writeFixtures({
      productBom: productBomCsv([`${BRANCH},Flavored Fries,Regular,Fries Base,BASE,0,kg,NO,`, ...baseProductBom.slice(1)]),
    });
    const report = runValidation(tmpDir);
    expect(report.errors.some((e) => e.file === FILES.productBom && e.message.includes('quantity_required'))).toBe(true);
  });

  it('rejects a duplicate ingredient', () => {
    writeFixtures({
      ingredients: ingredientsCsv([...baseIngredients, `${BRANCH},Fries Base,RAW_MATERIAL,kg,10,5,`]),
    });
    const report = runValidation(tmpDir);
    expect(report.errors.some((e) => e.file === FILES.ingredients && e.message.includes('Duplicate branch_name + inventory_item_name'))).toBe(
      true,
    );
  });

  it('reports a unit mismatch', () => {
    writeFixtures({
      productBom: productBomCsv([`${BRANCH},Flavored Fries,Regular,Fries Base,BASE,0.2,g,NO,`, ...baseProductBom.slice(1)]),
    });
    const report = runValidation(tmpDir);
    expect(report.unitMismatches.length).toBeGreaterThan(0);
  });

  it('reports missing Fries packaging coverage', () => {
    writeFixtures({
      productBom: productBomCsv(baseProductBom.filter((r) => !r.includes('Regular Fries Cup'))),
    });
    const report = runValidation(tmpDir);
    expect(report.missingCoverage.some((m) => m.includes('missing matching container'))).toBe(true);
  });

  it('rejects Mix & Max parent containing snack ingredients', () => {
    writeFixtures({
      productBom: productBomCsv([...baseProductBom, `${BRANCH},Mix & Max,Large Mix,Fries Base,BASE,1,kg,NO,`]),
    });
    const report = runValidation(tmpDir);
    expect(report.errors.some((e) => e.message.includes('must not contain "Fries Base"'))).toBe(true);
  });

  it('reports a missing flavor mapping', () => {
    writeFixtures({ flavorBom: flavorBomCsv([]) });
    const report = runValidation(tmpDir);
    expect(report.missingCoverage.some((m) => m.includes('missing flavor "Cheese"'))).toBe(true);
  });

  it('reports an invalid Mix & Max slot count', () => {
    writeFixtures({
      mixMax: mixMaxCsv(['Large Mix,1,Slot 1,Flavored Fries,Regular,TRUE,']),
    });
    const report = runValidation(tmpDir);
    expect(report.errors.some((e) => e.file === FILES.mixMax && e.message.includes('must be contiguous'))).toBe(true);
  });

  it('reports a blank allowed snack variant', () => {
    writeFixtures({
      mixMax: mixMaxCsv(['Large Mix,1,Slot 1,Flavored Fries,,TRUE,', 'Large Mix,2,Slot 2,Loopys,Large,FALSE,']),
    });
    const report = runValidation(tmpDir);
    expect(report.errors.some((e) => e.file === FILES.mixMax && e.message.includes('must not be blank'))).toBe(true);
  });

  it('reports a missing opening-stock row', () => {
    writeFixtures({
      openingStock: openingStockCsv(baseOpeningStock.filter((r) => !r.includes('Bottled Water'))),
    });
    const report = runValidation(tmpDir);
    expect(report.missingCoverage.some((m) => m.includes('Bottled Water: missing opening-stock row'))).toBe(true);
  });
});
