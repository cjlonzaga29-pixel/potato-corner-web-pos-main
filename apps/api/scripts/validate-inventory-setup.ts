// Dry-run validator for docs/inventory-setup/*.csv templates.
// Reads the completed CSV templates and reports issues. Never writes,
// imports, connects to a database, or applies a migration.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SETUP_DIR = path.resolve(__dirname, '../../../docs/inventory-setup');

export const FILES = {
  ingredients: 'ingredients-template.csv',
  productBom: 'product-bom-template.csv',
  flavorBom: 'flavor-bom-template.csv',
  mixMax: 'mix-max-snack-options-template.csv',
  openingStock: 'opening-stock-template.csv',
} as const;

// Catalog reference, mirrored from apps/api/prisma/seed-catalog.ts.
const FLAVOR_NAMES = ['Cheese', 'BBQ', 'Sour Cream', 'White Cheddar', 'Sour Cheese', 'Chili BBQ', 'Chili Cheese', 'Sweet Corn'];

const CATALOG: Record<string, string[]> = {
  'Flavored Fries': ['Regular', 'Large', 'Jumbo', 'Mega', 'Giga', 'Tera'],
  Loopys: ['Large', 'Mega'],
  'Crunchy Chicken Pops': ['Regular', 'Large', 'Mega'],
  'Mix & Max': ['Large Mix', 'Mega Mix', 'Tera Mix'],
  Drinks: ['Water', 'Soda'],
};

const ITEM_TYPES = ['RAW_MATERIAL', 'PACKAGING', 'FINISHED_GOOD', 'SEASONING'];
const MAPPING_TYPES = ['BASE', 'PACKAGING', 'FINISHED_GOOD'];
const OPTIONAL_INGREDIENT_NOTE = /optional/i;
const MIX_SLOT_COUNT: Record<string, number> = { 'Large Mix': 2, 'Mega Mix': 2, 'Tera Mix': 3 };

export interface Issue {
  file: string;
  line?: number;
  message: string;
}

export interface ValidationReport {
  result: 'PASS' | 'FAIL';
  errors: Issue[];
  warnings: Issue[];
  missingCoverage: string[];
  duplicateRecords: Issue[];
  unitMismatches: Issue[];
  summary: {
    branches: number;
    inventoryItems: number;
    productBomMappings: number;
    flavorMappings: number;
    mixMaxSnackOptions: number;
    openingStockRows: number;
  };
}

class Context {
  errors: Issue[] = [];
  warnings: Issue[] = [];

  err(file: string, line: number | undefined, message: string) {
    this.errors.push({ file, line, message });
  }
  warn(file: string, line: number | undefined, message: string) {
    this.warnings.push({ file, line, message });
  }
}

// --- minimal RFC4180-style CSV parser (quoted values, embedded commas, "" escapes) ---
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (c === '\r') {
      i += 1;
      continue;
    }
    if (c === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

interface ParsedCsv {
  headers: string[];
  rows: { values: Record<string, string>; line: number }[];
}

function loadCsv(ctx: Context, baseDir: string, fileKey: keyof typeof FILES, requiredHeaders: string[]): ParsedCsv {
  const fileName = FILES[fileKey];
  const filePath = path.join(baseDir, fileName);
  const text = readFileSync(filePath, 'utf8');
  const table = parseCsv(text);
  if (table.length === 0) {
    ctx.err(fileName, undefined, 'File is empty.');
    return { headers: [], rows: [] };
  }
  const headers = table[0].map((h) => h.trim());

  const seenHeaders = new Set<string>();
  for (const h of headers) {
    if (seenHeaders.has(h)) ctx.err(fileName, 1, `Duplicate header column "${h}".`);
    seenHeaders.add(h);
  }
  for (const required of requiredHeaders) {
    if (!headers.includes(required)) ctx.err(fileName, 1, `Missing required header "${required}".`);
  }

  const rows: ParsedCsv['rows'] = [];
  const seenLogical = new Set<string>();
  for (let r = 1; r < table.length; r += 1) {
    const line = r + 1;
    const raw = table[r];
    if (raw.length === 1 && raw[0].trim() === '') {
      ctx.err(fileName, line, 'Completely blank row.');
      continue;
    }
    if (raw.length !== headers.length) {
      ctx.err(fileName, line, `Row has ${raw.length} columns, expected ${headers.length}.`);
      continue;
    }
    const trimmed = raw.map((v) => v.trim());
    if (trimmed.every((v) => v === '')) {
      ctx.err(fileName, line, 'Completely blank row.');
      continue;
    }
    const values: Record<string, string> = {};
    headers.forEach((h, idx) => {
      values[h] = trimmed[idx];
    });
    const logicalKey = JSON.stringify(trimmed);
    if (seenLogical.has(logicalKey)) ctx.err(fileName, line, 'Duplicate logical record (identical row).');
    seenLogical.add(logicalKey);
    rows.push({ values, line });
  }
  return { headers, rows };
}

function isNonNegativeNumber(v: string): boolean {
  if (v.trim() === '') return false;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}
function isPositiveNumber(v: string): boolean {
  if (v.trim() === '') return false;
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}
function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime());
}
function isBoolean(v: string): boolean {
  return ['true', 'false', 'yes', 'no', '1', '0'].includes(v.toLowerCase());
}

// ---------------- Ingredients ----------------
interface IngredientRecord {
  branch: string;
  name: string;
  itemType: string;
  stockUnit: string;
  optional: boolean;
  line: number;
}

function validateIngredients(ctx: Context, baseDir: string): { byBranchAndName: Map<string, IngredientRecord>; count: number } {
  const file = FILES.ingredients;
  const { rows } = loadCsv(ctx, baseDir, 'ingredients', [
    'branch_name',
    'inventory_item_name',
    'item_type',
    'stock_unit',
    'cost_per_unit',
    'reorder_level',
  ]);
  const byBranchAndName = new Map<string, IngredientRecord>();
  const dupCheck = new Set<string>();

  for (const { values, line } of rows) {
    const branch = values.branch_name;
    const name = values.inventory_item_name;
    const optional = OPTIONAL_INGREDIENT_NOTE.test(values.notes ?? '');

    if (!branch) ctx.err(file, line, 'branch_name is required.');
    if (!name) ctx.err(file, line, 'inventory_item_name is required.');
    if (!ITEM_TYPES.includes(values.item_type)) {
      ctx.err(file, line, `item_type "${values.item_type}" must be one of ${ITEM_TYPES.join(', ')}.`);
    }
    if (!values.stock_unit) ctx.err(file, line, 'stock_unit is required.');
    if (!isNonNegativeNumber(values.cost_per_unit)) ctx.err(file, line, `cost_per_unit "${values.cost_per_unit}" must be a non-negative number.`);
    if (!isNonNegativeNumber(values.reorder_level)) ctx.err(file, line, `reorder_level "${values.reorder_level}" must be a non-negative number.`);

    if (branch && name) {
      const key = `${branch}::${name}`;
      if (dupCheck.has(key)) {
        ctx.err(file, line, `Duplicate branch_name + inventory_item_name "${branch} / ${name}".`);
      } else {
        dupCheck.add(key);
        byBranchAndName.set(key, { branch, name, itemType: values.item_type, stockUnit: values.stock_unit, optional, line });
      }
    }
  }
  return { byBranchAndName, count: byBranchAndName.size };
}

// ---------------- Product BOM ----------------
function validateProductBom(ctx: Context, baseDir: string, ingredients: Map<string, IngredientRecord>, branches: Set<string>) {
  const file = FILES.productBom;
  const { rows } = loadCsv(ctx, baseDir, 'productBom', [
    'branch_name',
    'product_name',
    'variant_name',
    'inventory_item_name',
    'mapping_type',
    'quantity_required',
    'unit',
    'required_from_user',
  ]);

  const dupCheck = new Set<string>();
  const coverage = new Map<string, Map<string, Set<string>>>();
  let count = 0;

  for (const { values, line } of rows) {
    const { branch_name: branch, product_name: product, variant_name: variant, inventory_item_name: itemName, mapping_type: mappingType } = values;

    const catalogVariants = CATALOG[product];
    if (!catalogVariants) {
      ctx.err(file, line, `product_name "${product}" does not exist in the catalog.`);
    } else if (!catalogVariants.includes(variant)) {
      ctx.err(file, line, `variant_name "${variant}" does not exist for product "${product}" in the catalog.`);
    }

    const ingredientKey = `${branch}::${itemName}`;
    const ingredient = ingredients.get(ingredientKey);
    if (!ingredient) {
      ctx.err(file, line, `inventory_item_name "${itemName}" not found in ingredients-template.csv for branch "${branch}".`);
    }

    if (!MAPPING_TYPES.includes(mappingType)) {
      ctx.err(file, line, `mapping_type "${mappingType}" must be one of ${MAPPING_TYPES.join(', ')}.`);
    }
    if (!isPositiveNumber(values.quantity_required)) {
      ctx.err(file, line, `quantity_required "${values.quantity_required}" must be greater than zero.`);
    }
    if (ingredient && values.unit && values.unit !== ingredient.stockUnit) {
      ctx.err(file, line, `unit "${values.unit}" does not match inventory item stock_unit "${ingredient.stockUnit}".`);
    }
    if (values.required_from_user.toUpperCase() === 'YES') {
      ctx.err(file, line, 'required_from_user is still YES; value has not been completed.');
    }

    const dupKey = `${branch}::${product}::${variant}::${itemName}::${mappingType}`;
    if (dupCheck.has(dupKey)) {
      ctx.err(file, line, 'Duplicate branch + product + variant + inventory item + mapping_type.');
    } else {
      dupCheck.add(dupKey);
      count += 1;
    }

    if (branch && product && variant && itemName) {
      if (!coverage.has(branch)) coverage.set(branch, new Map());
      const byProduct = coverage.get(branch)!;
      const covKey = `${product}::${variant}`;
      if (!byProduct.has(covKey)) byProduct.set(covKey, new Set());
      byProduct.get(covKey)!.add(itemName);
    }
  }

  const missingCoverage: string[] = [];
  for (const branch of branches) {
    const byProduct = coverage.get(branch) ?? new Map<string, Set<string>>();
    for (const variant of CATALOG['Flavored Fries']) {
      const items = byProduct.get(`Flavored Fries::${variant}`) ?? new Set<string>();
      if (!items.has('Fries Base')) missingCoverage.push(`${branch} / Flavored Fries ${variant}: missing Fries Base`);
      if (!items.has('Cooking Oil')) missingCoverage.push(`${branch} / Flavored Fries ${variant}: missing Cooking Oil`);
      const hasContainer = [...items].some((i) => /Cup|Container/i.test(i));
      if (!hasContainer) missingCoverage.push(`${branch} / Flavored Fries ${variant}: missing matching container`);
    }
    for (const variant of CATALOG.Loopys) {
      const items = byProduct.get(`Loopys::${variant}`) ?? new Set<string>();
      if (!items.has('Loopys Base')) missingCoverage.push(`${branch} / Loopys ${variant}: missing Loopys Base`);
      const hasPackaging = [...items].some((i) => /Container|Cup/i.test(i));
      if (!hasPackaging) missingCoverage.push(`${branch} / Loopys ${variant}: missing packaging`);
    }
    for (const variant of CATALOG['Crunchy Chicken Pops']) {
      const items = byProduct.get(`Crunchy Chicken Pops::${variant}`) ?? new Set<string>();
      if (!items.has('Chicken Pops')) missingCoverage.push(`${branch} / Crunchy Chicken Pops ${variant}: missing Chicken Pops`);
      const hasPackaging = [...items].some((i) => /Container|Cup/i.test(i));
      if (!hasPackaging) missingCoverage.push(`${branch} / Crunchy Chicken Pops ${variant}: missing packaging`);
    }
    const disallowed = ['Fries Base', 'Loopys Base', 'Chicken Pops'];
    for (const variant of CATALOG['Mix & Max']) {
      const items = byProduct.get(`Mix & Max::${variant}`) ?? new Set<string>();
      const hasParentPackaging = [...items].some((i) => /Box/i.test(i));
      if (!hasParentPackaging) missingCoverage.push(`${branch} / Mix & Max ${variant}: missing parent packaging`);
      for (const bad of disallowed) {
        if (items.has(bad)) ctx.err(file, undefined, `${branch} / Mix & Max ${variant}: must not contain "${bad}".`);
      }
      const hasSeasoning = [...items].some((i) => /Powder/i.test(i));
      if (hasSeasoning) ctx.err(file, undefined, `${branch} / Mix & Max ${variant}: must not contain seasoning.`);
    }
    for (const variant of CATALOG.Drinks) {
      const drinkRows = rows.filter(
        (r) => r.values.branch_name === branch && r.values.product_name === 'Drinks' && r.values.variant_name === variant,
      );
      for (const r of drinkRows) {
        if (r.values.mapping_type !== 'FINISHED_GOOD') {
          ctx.err(file, r.line, `Drinks / ${variant} must use mapping_type FINISHED_GOOD.`);
        }
      }
    }
  }

  return { count, missingCoverage };
}

// ---------------- Flavor BOM ----------------
function validateFlavorBom(ctx: Context, baseDir: string, ingredients: Map<string, IngredientRecord>, branches: Set<string>) {
  const file = FILES.flavorBom;
  const { rows } = loadCsv(ctx, baseDir, 'flavorBom', [
    'branch_name',
    'product_name',
    'variant_name',
    'flavor_name',
    'inventory_item_name',
    'quantity_required',
    'unit',
    'required_from_user',
  ]);

  const dupCheck = new Set<string>();
  const coverage = new Map<string, Map<string, Set<string>>>();
  let count = 0;

  for (const { values, line } of rows) {
    const { branch_name: branch, product_name: product, variant_name: variant, flavor_name: flavor, inventory_item_name: itemName } = values;

    if (product !== 'Flavored Fries') ctx.err(file, line, `product_name must be "Flavored Fries", got "${product}".`);
    if (!CATALOG['Flavored Fries'].includes(variant)) ctx.err(file, line, `variant_name "${variant}" does not exist for Flavored Fries.`);
    if (!FLAVOR_NAMES.includes(flavor)) ctx.err(file, line, `flavor_name "${flavor}" does not exist in the catalog.`);

    const ingredientKey = `${branch}::${itemName}`;
    const ingredient = ingredients.get(ingredientKey);
    if (!ingredient) {
      ctx.err(file, line, `Seasoning inventory item "${itemName}" not found in ingredients-template.csv for branch "${branch}".`);
    } else if (ingredient.itemType !== 'SEASONING') {
      ctx.err(file, line, `inventory_item_name "${itemName}" is not a SEASONING item.`);
    }

    if (!isPositiveNumber(values.quantity_required)) {
      ctx.err(file, line, `quantity_required "${values.quantity_required}" must be greater than zero.`);
    }
    if (ingredient && values.unit && values.unit !== ingredient.stockUnit) {
      ctx.err(file, line, `unit "${values.unit}" does not match seasoning stock_unit "${ingredient.stockUnit}".`);
    }
    if (values.required_from_user.toUpperCase() === 'YES') {
      ctx.err(file, line, 'required_from_user is still YES; value has not been completed.');
    }

    const dupKey = `${branch}::${variant}::${flavor}`;
    if (dupCheck.has(dupKey)) {
      ctx.err(file, line, 'Duplicate mapping for branch + variant + flavor (must be exactly one).');
    } else {
      dupCheck.add(dupKey);
      count += 1;
    }

    if (branch && variant && flavor) {
      if (!coverage.has(branch)) coverage.set(branch, new Map());
      const byVariant = coverage.get(branch)!;
      if (!byVariant.has(variant)) byVariant.set(variant, new Set());
      byVariant.get(variant)!.add(flavor);
    }
  }

  const missingCoverage: string[] = [];
  for (const branch of branches) {
    const byVariant = coverage.get(branch) ?? new Map<string, Set<string>>();
    for (const variant of CATALOG['Flavored Fries']) {
      const flavors = byVariant.get(variant) ?? new Set<string>();
      for (const flavor of FLAVOR_NAMES) {
        if (!flavors.has(flavor)) missingCoverage.push(`${branch} / Flavored Fries ${variant}: missing flavor "${flavor}"`);
      }
    }
  }

  return { count, missingCoverage };
}

// ---------------- Mix & Max snack options ----------------
function validateMixMax(ctx: Context, baseDir: string) {
  const file = FILES.mixMax;
  const { rows } = loadCsv(ctx, baseDir, 'mixMax', [
    'mix_variant',
    'slot_index',
    'slot_label',
    'allowed_snack_product',
    'allowed_snack_variant',
    'required',
  ]);

  const dupCheck = new Set<string>();
  const slots = new Map<string, Map<number, number>>();
  let count = 0;

  for (const { values, line } of rows) {
    const mixVariant = values.mix_variant;
    const slotIndex = Number(values.slot_index);

    if (!['Large Mix', 'Mega Mix', 'Tera Mix'].includes(mixVariant)) {
      ctx.err(file, line, `mix_variant "${mixVariant}" must be one of Large Mix, Mega Mix, Tera Mix.`);
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 1) {
      ctx.err(file, line, `slot_index "${values.slot_index}" must be a positive integer.`);
    }

    const catalogVariants = CATALOG[values.allowed_snack_product];
    if (!catalogVariants) {
      ctx.err(file, line, `allowed_snack_product "${values.allowed_snack_product}" does not exist in the catalog.`);
    }
    if (!values.allowed_snack_variant) {
      ctx.err(file, line, 'allowed_snack_variant must not be blank.');
    } else if (catalogVariants && !catalogVariants.includes(values.allowed_snack_variant)) {
      ctx.err(
        file,
        line,
        `allowed_snack_variant "${values.allowed_snack_variant}" does not exist under product "${values.allowed_snack_product}".`,
      );
    }
    if (!isBoolean(values.required)) {
      ctx.err(file, line, `required "${values.required}" must be a valid boolean.`);
    }

    const dupKey = `${mixVariant}::${values.slot_index}::${values.allowed_snack_product}::${values.allowed_snack_variant}`;
    if (dupCheck.has(dupKey)) {
      ctx.err(file, line, 'Duplicate mix variant + slot index + snack product + snack variant.');
    } else {
      dupCheck.add(dupKey);
      count += 1;
    }

    if (mixVariant && Number.isInteger(slotIndex)) {
      if (!slots.has(mixVariant)) slots.set(mixVariant, new Map());
      const bySlot = slots.get(mixVariant)!;
      bySlot.set(slotIndex, (bySlot.get(slotIndex) ?? 0) + 1);
    }
  }

  const missingCoverage: string[] = [];
  for (const [mixVariant, expectedSlots] of Object.entries(MIX_SLOT_COUNT)) {
    const bySlot = slots.get(mixVariant);
    if (!bySlot) {
      missingCoverage.push(`Mix & Max ${mixVariant}: no slots defined (expected ${expectedSlots}).`);
      continue;
    }
    const indexes = [...bySlot.keys()].sort((a, b) => a - b);
    const expectedIndexes = Array.from({ length: expectedSlots }, (_, i) => i + 1);
    const isContiguous = JSON.stringify(indexes) === JSON.stringify(expectedIndexes);
    if (!isContiguous) {
      ctx.err(
        file,
        undefined,
        `Mix & Max ${mixVariant} slot indexes ${JSON.stringify(indexes)} must be contiguous starting at 1 with exactly ${expectedSlots} slots.`,
      );
    }
    for (const idx of expectedIndexes) {
      if (!bySlot.has(idx) || bySlot.get(idx) === 0) {
        missingCoverage.push(`Mix & Max ${mixVariant} slot ${idx}: no snack options available.`);
      }
    }
  }

  return { count, missingCoverage };
}

// ---------------- Opening stock ----------------
function validateOpeningStock(ctx: Context, baseDir: string, ingredients: Map<string, IngredientRecord>) {
  const file = FILES.openingStock;
  const { rows } = loadCsv(ctx, baseDir, 'openingStock', [
    'branch_name',
    'inventory_item_name',
    'opening_quantity',
    'unit',
    'unit_cost',
    'effective_date',
  ]);

  const dupCheck = new Set<string>();
  const seenBranchItem = new Map<string, Set<string>>();
  let count = 0;

  for (const { values, line } of rows) {
    const branch = values.branch_name;
    const itemName = values.inventory_item_name;
    const ingredientKey = `${branch}::${itemName}`;
    const ingredient = ingredients.get(ingredientKey);

    if (!ingredient) {
      ctx.err(file, line, `inventory item "${itemName}" not found in ingredients-template.csv for branch "${branch}".`);
    }
    if (!isNonNegativeNumber(values.opening_quantity)) {
      ctx.err(file, line, `opening_quantity "${values.opening_quantity}" must be a non-negative number.`);
    }
    if (ingredient && values.unit && values.unit !== ingredient.stockUnit) {
      ctx.err(file, line, `unit "${values.unit}" does not match inventory item stock_unit "${ingredient.stockUnit}".`);
    }
    if (!isNonNegativeNumber(values.unit_cost)) {
      ctx.err(file, line, `unit_cost "${values.unit_cost}" must be a non-negative number.`);
    }
    if (!isIsoDate(values.effective_date)) {
      ctx.err(file, line, `effective_date "${values.effective_date}" must be a valid ISO date (YYYY-MM-DD).`);
    }

    const dupKey = `${branch}::${itemName}`;
    if (dupCheck.has(dupKey)) {
      ctx.err(file, line, 'Duplicate branch + inventory item row.');
    } else {
      dupCheck.add(dupKey);
      count += 1;
    }

    if (branch && itemName) {
      if (!seenBranchItem.has(branch)) seenBranchItem.set(branch, new Set());
      seenBranchItem.get(branch)!.add(itemName);
    }
  }

  const missingCoverage: string[] = [];
  const byBranch = new Map<string, IngredientRecord[]>();
  for (const record of ingredients.values()) {
    if (!byBranch.has(record.branch)) byBranch.set(record.branch, []);
    byBranch.get(record.branch)!.push(record);
  }
  for (const [branch, records] of byBranch) {
    for (const record of records) {
      if (record.optional) continue;
      const present = seenBranchItem.get(branch)?.has(record.name);
      if (!present) missingCoverage.push(`${branch} / ${record.name}: missing opening-stock row.`);
    }
  }

  return { count, missingCoverage };
}

// ---------------- Orchestration ----------------
export function runValidation(baseDir: string = DEFAULT_SETUP_DIR): ValidationReport {
  const ctx = new Context();

  const ingredientResult = validateIngredients(ctx, baseDir);
  const branches = new Set([...ingredientResult.byBranchAndName.values()].map((r) => r.branch));
  const productBomResult = validateProductBom(ctx, baseDir, ingredientResult.byBranchAndName, branches);
  const flavorBomResult = validateFlavorBom(ctx, baseDir, ingredientResult.byBranchAndName, branches);
  const mixMaxResult = validateMixMax(ctx, baseDir);
  const openingStockResult = validateOpeningStock(ctx, baseDir, ingredientResult.byBranchAndName);

  const missingCoverage = [
    ...productBomResult.missingCoverage,
    ...flavorBomResult.missingCoverage,
    ...mixMaxResult.missingCoverage,
    ...openingStockResult.missingCoverage,
  ];

  const duplicateRecords = [...ctx.errors, ...ctx.warnings].filter((i) => i.message.toLowerCase().includes('duplicate'));
  const unitMismatches = ctx.errors.filter((i) => i.message.includes('does not match') && i.message.toLowerCase().includes('unit'));

  return {
    result: ctx.errors.length === 0 ? 'PASS' : 'FAIL',
    errors: ctx.errors,
    warnings: ctx.warnings,
    missingCoverage,
    duplicateRecords,
    unitMismatches,
    summary: {
      branches: branches.size,
      inventoryItems: ingredientResult.count,
      productBomMappings: productBomResult.count,
      flavorMappings: flavorBomResult.count,
      mixMaxSnackOptions: mixMaxResult.count,
      openingStockRows: openingStockResult.count,
    },
  };
}

function printReport(report: ValidationReport) {
  const errorsByFile = new Map<string, Issue[]>();
  for (const issue of report.errors) {
    if (!errorsByFile.has(issue.file)) errorsByFile.set(issue.file, []);
    errorsByFile.get(issue.file)!.push(issue);
  }

  console.log('='.repeat(70));
  console.log('INVENTORY SETUP VALIDATION — DRY RUN (no data imported, no DB access)');
  console.log('='.repeat(70));
  console.log(`Overall result: ${report.result}`);
  console.log(`Error count: ${report.errors.length}`);
  console.log(`Warning count: ${report.warnings.length}`);

  console.log('\n--- Errors by file ---');
  if (errorsByFile.size === 0) {
    console.log('(none)');
  } else {
    for (const [file, issues] of errorsByFile) {
      console.log(`\n${file} (${issues.length} error${issues.length === 1 ? '' : 's'}):`);
      for (const issue of issues) {
        console.log(`  line ${issue.line ?? '-'}: ${issue.message}`);
      }
    }
  }

  console.log('\n--- Missing BOM / mapping coverage ---');
  console.log(report.missingCoverage.length === 0 ? '(none)' : report.missingCoverage.map((m) => `  - ${m}`).join('\n'));

  console.log('\n--- Duplicate records ---');
  console.log(
    report.duplicateRecords.length === 0
      ? '(none)'
      : report.duplicateRecords.map((d) => `  - ${d.file} line ${d.line ?? '-'}: ${d.message}`).join('\n'),
  );

  console.log('\n--- Unit mismatches ---');
  console.log(
    report.unitMismatches.length === 0 ? '(none)' : report.unitMismatches.map((u) => `  - ${u.file} line ${u.line ?? '-'}: ${u.message}`).join('\n'),
  );

  console.log('\n--- Summary counts ---');
  console.log(`  branches: ${report.summary.branches}`);
  console.log(`  inventory items: ${report.summary.inventoryItems}`);
  console.log(`  product BOM mappings: ${report.summary.productBomMappings}`);
  console.log(`  flavor mappings: ${report.summary.flavorMappings}`);
  console.log(`  Mix & Max snack options: ${report.summary.mixMaxSnackOptions}`);
  console.log(`  opening-stock rows: ${report.summary.openingStockRows}`);
}

const isMain = path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const report = runValidation();
  printReport(report);
  process.exit(report.result === 'PASS' ? 0 : 1);
}
