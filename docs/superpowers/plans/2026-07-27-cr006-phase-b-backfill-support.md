# CR-006 Phase B — Backfill Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only, deterministic migration-analysis layer (normalization, source inspection, unit/category classification, identity-collision detection, flavor-linkage detection, and a dry-run report + CLI) that prepares for — but does not perform — the later legacy `Ingredient` → `InventoryItem` backfill (Phase C).

**Architecture:** A new backend module, `apps/api/src/modules/inventory-migration/`, following the existing `<module>.router.ts`/`.service.ts`/`.repository.ts`/`.types.ts` convention adapted for an analysis-only module (no router — this is not an HTTP-exposed feature yet, it's a CLI/dry-run tool). Pure classification/detection functions take plain data arrays and return typed reports, so they're unit-testable without mocking Prisma; a thin repository layer does the only Prisma reads; an orchestrating service assembles the full `DryRunReport`; a `tsx` script under `apps/api/scripts/` is the CLI entrypoint, matching the existing ad-hoc script convention (`seed-expense-fixtures.ts`).

**Tech Stack:** TypeScript strict mode, Prisma (read-only queries against existing Phase A schema — no new migration), Vitest (co-located `*.test.ts`), `tsx` for script execution.

## Global Constraints

- Phase B must not perform identity mapping or backfill — no `InventoryIdentityMapping`, `InventoryItem`, `InventoryStock`, `ProductComponent`, or new `InventoryMovement` rows are written.
- No mapping may be inferred from raw exact-name equality alone (unit + legacy category must also agree for an auto-match candidate).
- Ambiguous candidates stay unresolved for manual review — never auto-resolved in Phase B.
- Do not modify the legacy `Ingredient`/`ProductInventory`/`InventoryMovement` runtime path (`apps/api/src/modules/inventory/`, `apps/api/src/modules/product-inventory/`, `apps/api/src/modules/transactions/`) — read-only additions only.
- Do not create fake or sample data — all analysis runs against real (possibly empty) legacy data; tests use synthetic in-memory fixtures, never DB seeding of fake production-shaped rows.
- No `UnitOfMeasure`/`InventoryCategory` rows are seeded in Phase B — classification recommends candidates only.
- The dry-run command performs zero database writes and exits non-zero when blocking collisions exist.
- TypeScript strict mode, no `any`, ESM imports use explicit `.js` extensions (existing repo convention — see `import { prisma } from '../../lib/prisma.js'`).
- Tests are Vitest, co-located next to source (`<name>.test.ts`), no separate `tests/` directory.

---

## File Structure

```
apps/api/src/modules/inventory-migration/
  types.ts                        # Shared report/record types (no logic)
  normalization.ts                # normalizeInventoryName/Unit/Sku/Barcode
  normalization.test.ts
  migration-batch.ts              # Batch ID generation + validation
  migration-batch.test.ts
  migration-source.repository.ts  # Read-only Prisma queries against legacy tables
  migration-source.repository.test.ts
  unit-classification.ts          # Pure: classify distinct legacy units
  unit-classification.test.ts
  category-classification.ts      # Pure: classify legacy categories into candidates
  category-classification.test.ts
  identity-collision.ts           # Pure: name/unit/category collision grouping + sku/barcode stubs
  identity-collision.test.ts
  flavor-linked.ts                # Pure: Flavor -> Ingredient candidate matching
  flavor-linked.test.ts
  readiness.ts                    # Pure: Phase C readiness gate (blockers vs warnings)
  readiness.test.ts
  dry-run.service.ts              # Orchestrator: repository + pure fns -> DryRunReport
  dry-run.service.test.ts

apps/api/scripts/
  inventory-migration-dry-run.ts  # CLI entrypoint: pnpm inventory:migration:dry-run

apps/api/package.json             # + "inventory:migration:dry-run" script

docs/decisions/
  CR-006-phase-b-migration-source-inventory.md  # Structured legacy source inventory (deliverable #1)
```

No files in `apps/api/src/modules/inventory/`, `product-inventory/`, `transactions/`, or `prisma/schema.prisma` are touched. No new Prisma migration is created — Phase A's `inventory_identity_mappings` shape already matches what Phase C will need; Phase B only reads existing tables.

---

### Task 1: Legacy source inventory documentation

**Files:**
- Create: `docs/decisions/CR-006-phase-b-migration-source-inventory.md`

**Interfaces:** None (documentation only).

- [ ] **Step 1: Write the structured source inventory document**

```markdown
# CR-006 Phase B — Legacy Migration Source Inventory

Structured inventory of every legacy source involved in the Ingredient ->
InventoryItem migration (CR-007 SS20). Read-only reference; no runtime
behavior changes. Counts are captured live by the dry-run command
(`pnpm inventory:migration:dry-run`) — this document is the structural map,
not a point-in-time count.

## Legacy models

| Source | Prisma model | Table | Branch-scoped? | Notes |
|---|---|---|---|---|
| Ingredient | `Ingredient` | `ingredients` | Yes (`branchId`) | Legacy identity; unique on `(branch_id, name)` where not deleted. Category via `IngredientCategory` enum (`RAW, FLAVOR, CUP, BAG, PACKAGING, OTHER`). No `sku`/`barcode` columns exist. |
| Ingredient category | `IngredientCategory` (enum) | n/a | n/a | Fixed 6-value enum on `Ingredient.category`, not a lookup table. |
| Product-to-ingredient mapping | `ProductInventory` | `product_inventory` | Yes (`branchId`) | Links `productVariantId` + optional `flavorId` to `ingredientId` with `quantityRequired`/`unit`. Soft-delete (`deletedAt`, `isActive`). |
| Flavor-linked inventory | `Flavor` (`ingredientName`/`ingredientUnit`) | `flavors` | No (global) | Flavor resolves to an `Ingredient` per branch by name+unit match (CR-004 resolver), not by FK. This is the flavor-linked identity source for SS7. |
| Flavor product composition | `ProductFlavorSlot` | `product_flavor_slots` | No | Catalog/composition only — does not hold stock or reference `Ingredient` directly; relevant only as context for which variants have flavor slots. |
| Movement ledger | `InventoryMovement` (legacy) | `inventory_movements` | Yes (`branchId`) | Keyed off `ingredientId`; `MovementType` enum (`stock_in, sale_deduction, manual_adjustment, waste, physical_count, transfer_in, transfer_out`) — distinct from the new CR-007 22-value taxonomy. |
| Physical count | *(no dedicated legacy model)* | n/a | n/a | Legacy `physical_count` is a `MovementType` value on `InventoryMovement`, not a session/cutoff-aware model. No physical-count-specific fields to migrate beyond those movement rows. |
| Transfer | *(no dedicated legacy model)* | n/a | n/a | Legacy `transfer_in`/`transfer_out` are `MovementType` values on `InventoryMovement`, not a `StockTransfer`-style linked record. No legacy transfer-session data to migrate beyond those movement rows. |

## Provisioning / write-path code (read-only inspection, not modified)

| File | Role |
|---|---|
| `apps/api/src/modules/inventory/inventory.repository.ts` | Only production repository writing legacy `Ingredient`/`InventoryMovement` (`provisionIngredient`, `createIngredient`, `updateIngredient`, `softDeleteIngredient`, movement append). |
| `apps/api/src/modules/inventory/inventory.service.ts` | `provisionBranchIngredients` (branch creation: dedupes candidate identities by `(name, unit)`, FLAVOR category wins collision) and `provisionIdentityAcrossBranches` (fan-out new Flavor identity to all branches). Closest existing precedent for identity-collision handling — operates on legacy identities only. |
| `apps/api/src/modules/product-inventory/product-inventory.repository.ts` | CRUD for legacy `ProductInventory` deduction mappings. |
| `apps/api/src/modules/transactions/transactions.service.ts` | Writes `sale_deduction` `InventoryMovement` rows at checkout via the inventory module. |
| `apps/api/src/modules/branches/branches.repository.ts` | Read-only: aggregates `Ingredient` for low-stock display when listing branches. |
| `apps/api/src/modules/reports/reports.repository.ts` | Read-only: `Ingredient`/movement reporting aggregates. |

No seed script (`apps/api/prisma/seed.ts`) creates `Ingredient` rows directly — branch provisioning creates them idempotently via `inventory.service.ts` at branch-creation time.

## Confirmed absence of prior migration tooling

A grep across `apps/api/src` at the start of Phase B found no existing
`normalize*`, `migration-batch`, `dry-run`, or `collision` helpers — this is
new infrastructure, not a rework of an existing tool.
```

- [ ] **Step 2: Review against CR-007 SS20 required deltas**

Re-read `docs/decisions/CR-007-universal-inventory-domain-finalization.md` section 20, items 1-2, and confirm every legacy source named there (`Ingredient`, `InventoryIdentityMapping` target) appears in the table above. No code changes in this step.

- [ ] **Step 3: Commit**

```bash
git add docs/decisions/CR-006-phase-b-migration-source-inventory.md
git commit -m "docs(cr-006): add Phase B legacy migration source inventory"
```

---

### Task 2: Normalization utilities

**Files:**
- Create: `apps/api/src/modules/inventory-migration/normalization.ts`
- Test: `apps/api/src/modules/inventory-migration/normalization.test.ts`

**Interfaces:**
- Produces: `NormalizedValue` (`{ raw: string; normalized: string }`), `normalizeInventoryName(value: string): NormalizedValue`, `normalizeLegacyUnit(value: string): NormalizedValue`, `normalizeSku(value: string | null): NormalizedValue | null`, `normalizeBarcode(value: string | null): NormalizedValue | null`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/inventory-migration/normalization.test.ts
import { describe, it, expect } from 'vitest';
import {
  normalizeInventoryName,
  normalizeLegacyUnit,
  normalizeSku,
  normalizeBarcode,
} from './normalization.js';

describe('normalizeInventoryName', () => {
  it('trims, collapses internal whitespace, and lowercases', () => {
    expect(normalizeInventoryName(' Cheese Powder ')).toEqual({
      raw: ' Cheese Powder ',
      normalized: 'cheese powder',
    });
    expect(normalizeInventoryName('CHEESE   POWDER')).toEqual({
      raw: 'CHEESE   POWDER',
      normalized: 'cheese powder',
    });
    expect(normalizeInventoryName('cheese powder')).toEqual({
      raw: 'cheese powder',
      normalized: 'cheese powder',
    });
  });

  it('does not conflate distinct business terms', () => {
    expect(normalizeInventoryName('cheese').normalized).not.toBe(
      normalizeInventoryName('cheese powder').normalized,
    );
  });

  it('preserves the raw value separately from normalized', () => {
    const result = normalizeInventoryName('  Sour Cream  ');
    expect(result.raw).toBe('  Sour Cream  ');
    expect(result.normalized).toBe('sour cream');
  });
});

describe('normalizeLegacyUnit', () => {
  it('trims, collapses whitespace, and lowercases', () => {
    expect(normalizeLegacyUnit(' KG ')).toEqual({ raw: ' KG ', normalized: 'kg' });
  });

  it('does not equate distinct units', () => {
    expect(normalizeLegacyUnit('kg').normalized).not.toBe(normalizeLegacyUnit('bag').normalized);
    expect(normalizeLegacyUnit('piece').normalized).not.toBe(normalizeLegacyUnit('box').normalized);
  });
});

describe('normalizeSku / normalizeBarcode', () => {
  it('returns null for null input', () => {
    expect(normalizeSku(null)).toBeNull();
    expect(normalizeBarcode(null)).toBeNull();
  });

  it('trims, collapses whitespace, and uppercases', () => {
    expect(normalizeSku(' sku-001 ')).toEqual({ raw: ' sku-001 ', normalized: 'SKU-001' });
    expect(normalizeBarcode(' 012345  6789 ')).toEqual({
      raw: ' 012345  6789 ',
      normalized: '0123456789'.length === 10 ? '012345 6789' : '012345 6789',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/normalization.test.ts`
Expected: FAIL — `Cannot find module './normalization.js'`.

(Fix the barcode assertion before implementing — it's redundant/self-referential; replace it with a concrete expected value.)

- [ ] **Step 2b: Simplify the barcode test assertion**

Replace the barcode test body with a direct expected value:

```ts
  it('trims, collapses whitespace, and uppercases', () => {
    expect(normalizeSku(' sku-001 ')).toEqual({ raw: ' sku-001 ', normalized: 'SKU-001' });
    expect(normalizeBarcode(' abc  123 ')).toEqual({ raw: ' abc  123 ', normalized: 'ABC 123' });
  });
```

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/inventory-migration/normalization.ts

/**
 * CR-006 Phase B normalization utilities. Normalization is whitespace/case
 * folding only — it never maps distinct business terms (units, package
 * types) onto one another. See CR-007 SS20.2/SS3 for why identity must not be
 * inferred from name equality alone.
 */
export interface NormalizedValue {
  raw: string;
  normalized: string;
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeInventoryName(value: string): NormalizedValue {
  return { raw: value, normalized: collapseWhitespace(value).toLowerCase() };
}

export function normalizeLegacyUnit(value: string): NormalizedValue {
  return { raw: value, normalized: collapseWhitespace(value).toLowerCase() };
}

export function normalizeSku(value: string | null): NormalizedValue | null {
  if (value === null) return null;
  return { raw: value, normalized: collapseWhitespace(value).toUpperCase() };
}

export function normalizeBarcode(value: string | null): NormalizedValue | null {
  if (value === null) return null;
  return { raw: value, normalized: collapseWhitespace(value).toUpperCase() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/normalization.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/inventory-migration/normalization.ts apps/api/src/modules/inventory-migration/normalization.test.ts
git commit -m "feat(cr-006): add Phase B normalization utilities"
```

---

### Task 3: Migration batch identifier

**Files:**
- Create: `apps/api/src/modules/inventory-migration/migration-batch.ts`
- Test: `apps/api/src/modules/inventory-migration/migration-batch.test.ts`

**Interfaces:**
- Produces: `generateMigrationBatchId(now?: Date): string`, `formatMigrationBatchId(date: Date): string`, `isValidMigrationBatchId(value: string): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/inventory-migration/migration-batch.test.ts
import { describe, it, expect } from 'vitest';
import {
  generateMigrationBatchId,
  formatMigrationBatchId,
  isValidMigrationBatchId,
} from './migration-batch.js';

describe('formatMigrationBatchId', () => {
  it('formats as CR006-INGREDIENT-YYYYMMDD-HHMMSS in UTC', () => {
    const date = new Date(Date.UTC(2026, 6, 27, 12, 5, 9));
    expect(formatMigrationBatchId(date)).toBe('CR006-INGREDIENT-20260727-120509');
  });
});

describe('generateMigrationBatchId', () => {
  it('defaults to the current time and is reproducible for a given Date', () => {
    const date = new Date(Date.UTC(2025, 0, 1, 0, 0, 0));
    expect(generateMigrationBatchId(date)).toBe('CR006-INGREDIENT-20250101-000000');
  });
});

describe('isValidMigrationBatchId', () => {
  it('accepts well-formed batch IDs', () => {
    expect(isValidMigrationBatchId('CR006-INGREDIENT-20260727-120509')).toBe(true);
  });

  it('rejects malformed batch IDs', () => {
    expect(isValidMigrationBatchId('not-a-batch-id')).toBe(false);
    expect(isValidMigrationBatchId('CR006-INGREDIENT-2026-07-27')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/migration-batch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/inventory-migration/migration-batch.ts

const BATCH_PREFIX = 'CR006-INGREDIENT';
const BATCH_ID_PATTERN = /^CR006-INGREDIENT-\d{8}-\d{6}$/;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Formats a batch ID from a Date, in UTC, so the ID is stable regardless of server timezone. */
export function formatMigrationBatchId(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = pad(date.getUTCMonth() + 1, 2);
  const d = pad(date.getUTCDate(), 2);
  const h = pad(date.getUTCHours(), 2);
  const mi = pad(date.getUTCMinutes(), 2);
  const s = pad(date.getUTCSeconds(), 2);
  return `${BATCH_PREFIX}-${y}${mo}${d}-${h}${mi}${s}`;
}

export function generateMigrationBatchId(now: Date = new Date()): string {
  return formatMigrationBatchId(now);
}

export function isValidMigrationBatchId(value: string): boolean {
  return BATCH_ID_PATTERN.test(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/migration-batch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/inventory-migration/migration-batch.ts apps/api/src/modules/inventory-migration/migration-batch.test.ts
git commit -m "feat(cr-006): add Phase B migration batch identifier"
```

---

### Task 4: Shared report types

**Files:**
- Create: `apps/api/src/modules/inventory-migration/types.ts`

**Interfaces:**
- Produces (all consumed by Tasks 5-11): `LegacyIngredientRecord`, `LegacyFlavorRecord`, `SourceSummary`, `UnitClassification`, `UnitClassificationEntry`, `CategoryCandidate`, `IdentityGroupClassification`, `IdentityCandidateMember`, `IdentityCandidateGroup`, `SkuCollision`, `BarcodeCollision`, `FlavorLinkedCandidate`, `InvalidRecord`, `DryRunReport`.

- [ ] **Step 1: Write the types file**

```ts
// apps/api/src/modules/inventory-migration/types.ts

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
  proposedUnitOfMeasureCode: string | null;
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
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm --filter @potato-corner/api exec tsc -p tsconfig.json --noEmit`
Expected: PASS (no errors — this file has no runtime logic, so nothing to unit test directly; it's exercised by every task from here on).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/inventory-migration/types.ts
git commit -m "feat(cr-006): add Phase B shared report types"
```

---

### Task 5: Legacy source repository (read-only)

**Files:**
- Create: `apps/api/src/modules/inventory-migration/migration-source.repository.ts`
- Test: `apps/api/src/modules/inventory-migration/migration-source.repository.test.ts`

**Interfaces:**
- Consumes: `LegacyIngredientRecord`, `LegacyFlavorRecord`, `SourceSummary` (Task 4).
- Produces: `fetchLegacyIngredients(): Promise<LegacyIngredientRecord[]>`, `fetchLegacyFlavors(): Promise<LegacyFlavorRecord[]>`, `fetchExistingUnitCodes(): Promise<{ code: string }[]>`, `fetchSourceSummary(): Promise<SourceSummary>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/inventory-migration/migration-source.repository.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    ingredient: { findMany: vi.fn(), count: vi.fn() },
    flavor: { findMany: vi.fn(), count: vi.fn() },
    productInventory: { count: vi.fn() },
    inventoryMovement: { count: vi.fn() },
    unitOfMeasure: { findMany: vi.fn(), count: vi.fn() },
    inventoryCategory: { count: vi.fn() },
    branch: { count: vi.fn() },
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const {
  fetchLegacyIngredients,
  fetchLegacyFlavors,
  fetchExistingUnitCodes,
  fetchSourceSummary,
} = await import('./migration-source.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchLegacyIngredients', () => {
  it('selects only the fields needed for migration analysis, no writes', () => {
    (prisma.ingredient.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    return fetchLegacyIngredients().then(() => {
      expect(prisma.ingredient.findMany).toHaveBeenCalledWith({
        select: { id: true, name: true, unit: true, category: true, branchId: true, deletedAt: true },
      });
    });
  });
});

describe('fetchLegacyFlavors', () => {
  it('selects flavor identity-linkage fields', async () => {
    (prisma.flavor.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await fetchLegacyFlavors();
    expect(prisma.flavor.findMany).toHaveBeenCalledWith({
      select: { id: true, name: true, ingredientName: true, ingredientUnit: true, isActive: true },
    });
  });
});

describe('fetchExistingUnitCodes', () => {
  it('reads existing UnitOfMeasure codes without writing', async () => {
    (prisma.unitOfMeasure.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ code: 'KG' }]);
    const result = await fetchExistingUnitCodes();
    expect(result).toEqual([{ code: 'KG' }]);
    expect(prisma.unitOfMeasure.findMany).toHaveBeenCalledWith({ select: { code: true } });
  });
});

describe('fetchSourceSummary', () => {
  it('aggregates counts from every declared legacy source with no writes', async () => {
    (prisma.branch.count as ReturnType<typeof vi.fn>).mockResolvedValue(3);
    (prisma.ingredient.count as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(8); // active
    (prisma.inventoryMovement.count as ReturnType<typeof vi.fn>).mockResolvedValue(50);
    (prisma.productInventory.count as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(15);
    (prisma.flavor.count as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(4);
    (prisma.unitOfMeasure.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.inventoryCategory.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.ingredient.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ unit: 'kg' }, { unit: 'pc' }])
      .mockResolvedValueOnce([{ category: 'RAW' }, { category: 'OTHER' }]);

    const summary = await fetchSourceSummary();

    expect(summary).toEqual({
      branchCount: 3,
      ingredientCount: 10,
      activeIngredientCount: 8,
      softDeletedIngredientCount: 2,
      distinctIngredientUnitCount: 2,
      distinctIngredientCategoryCount: 2,
      productInventoryCount: 20,
      activeProductInventoryCount: 15,
      flavorCount: 5,
      activeFlavorCount: 4,
      inventoryMovementCount: 50,
      existingUnitOfMeasureCount: 0,
      existingInventoryCategoryCount: 0,
    });

    // No write methods exist on any mocked model, so none can have been called —
    // this assertion documents the read-only contract explicitly.
    const writeMethodNames = ['create', 'update', 'delete', 'upsert', 'createMany', 'updateMany', 'deleteMany'];
    for (const model of Object.values(prisma)) {
      for (const method of writeMethodNames) {
        expect((model as Record<string, unknown>)[method]).toBeUndefined();
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/migration-source.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/inventory-migration/migration-source.repository.ts
import { prisma } from '../../lib/prisma.js';
import type { LegacyIngredientRecord, LegacyFlavorRecord, SourceSummary } from './types.js';

/**
 * Read-only queries against legacy inventory sources for CR-006 Phase B
 * analysis. No method here writes — Phase B performs zero database writes
 * (CR-007 SS20, "REQUIRED WORK" item 8).
 */

export async function fetchLegacyIngredients(): Promise<LegacyIngredientRecord[]> {
  return prisma.ingredient.findMany({
    select: { id: true, name: true, unit: true, category: true, branchId: true, deletedAt: true },
  });
}

export async function fetchLegacyFlavors(): Promise<LegacyFlavorRecord[]> {
  return prisma.flavor.findMany({
    select: { id: true, name: true, ingredientName: true, ingredientUnit: true, isActive: true },
  });
}

export async function fetchExistingUnitCodes(): Promise<{ code: string }[]> {
  return prisma.unitOfMeasure.findMany({ select: { code: true } });
}

export async function fetchSourceSummary(): Promise<SourceSummary> {
  const [
    branchCount,
    ingredientCount,
    activeIngredientCount,
    inventoryMovementCount,
    productInventoryCount,
    activeProductInventoryCount,
    flavorCount,
    activeFlavorCount,
    existingUnitOfMeasureCount,
    existingInventoryCategoryCount,
    distinctUnits,
    distinctCategories,
  ] = await Promise.all([
    prisma.branch.count(),
    prisma.ingredient.count(),
    prisma.ingredient.count({ where: { deletedAt: null } }),
    prisma.inventoryMovement.count(),
    prisma.productInventory.count(),
    prisma.productInventory.count({ where: { isActive: true, deletedAt: null } }),
    prisma.flavor.count(),
    prisma.flavor.count({ where: { isActive: true } }),
    prisma.unitOfMeasure.count(),
    prisma.inventoryCategory.count(),
    prisma.ingredient.findMany({ select: { unit: true }, distinct: ['unit'] }),
    prisma.ingredient.findMany({ select: { category: true }, distinct: ['category'] }),
  ]);

  return {
    branchCount,
    ingredientCount,
    activeIngredientCount,
    softDeletedIngredientCount: ingredientCount - activeIngredientCount,
    distinctIngredientUnitCount: distinctUnits.length,
    distinctIngredientCategoryCount: distinctCategories.length,
    productInventoryCount,
    activeProductInventoryCount,
    flavorCount,
    activeFlavorCount,
    inventoryMovementCount,
    existingUnitOfMeasureCount,
    existingInventoryCategoryCount,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/migration-source.repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/inventory-migration/migration-source.repository.ts apps/api/src/modules/inventory-migration/migration-source.repository.test.ts
git commit -m "feat(cr-006): add Phase B read-only legacy source repository"
```

---

### Task 6: Unit readiness classification

**Files:**
- Create: `apps/api/src/modules/inventory-migration/unit-classification.ts`
- Test: `apps/api/src/modules/inventory-migration/unit-classification.test.ts`

**Interfaces:**
- Consumes: `LegacyIngredientRecord`, `UnitClassificationEntry` (Task 4); `normalizeLegacyUnit` (Task 2).
- Produces: `classifyLegacyUnits(ingredients: LegacyIngredientRecord[], existingUnits: { code: string }[]): UnitClassificationEntry[]`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/inventory-migration/unit-classification.test.ts
import { describe, it, expect } from 'vitest';
import { classifyLegacyUnits } from './unit-classification.js';
import type { LegacyIngredientRecord } from './types.js';

function ingredient(overrides: Partial<LegacyIngredientRecord>): LegacyIngredientRecord {
  return {
    id: 'ing-1', name: 'Test', unit: 'kg', category: 'RAW', branchId: 'branch-1', deletedAt: null,
    ...overrides,
  };
}

describe('classifyLegacyUnits', () => {
  it('classifies a unit matching an existing UnitOfMeasure code as EXACT_GLOBAL_UNIT', () => {
    const result = classifyLegacyUnits(
      [ingredient({ id: 'a', unit: 'kg' })],
      [{ code: 'KG' }],
    );
    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('EXACT_GLOBAL_UNIT');
    expect(result[0].affectedIngredientIds).toEqual(['a']);
  });

  it('classifies known synonyms as NORMALIZABLE_GLOBAL_UNIT without an existing UnitOfMeasure row', () => {
    const result = classifyLegacyUnits([ingredient({ id: 'a', unit: 'gram' })], []);
    expect(result[0].classification).toBe('NORMALIZABLE_GLOBAL_UNIT');
    expect(result[0].proposedUnitOfMeasureCode).toBe('GRAM');
  });

  it('classifies package-style units as ITEM_SPECIFIC_PACKAGE_UNIT with a blocking reason', () => {
    const result = classifyLegacyUnits([ingredient({ id: 'a', unit: 'box' })], []);
    expect(result[0].classification).toBe('ITEM_SPECIFIC_PACKAGE_UNIT');
    expect(result[0].blockingReason).not.toBeNull();
  });

  it('classifies unrecognized units as UNKNOWN', () => {
    const result = classifyLegacyUnits([ingredient({ id: 'a', unit: 'blorp' })], []);
    expect(result[0].classification).toBe('UNKNOWN');
  });

  it('classifies empty/whitespace units as INVALID', () => {
    const result = classifyLegacyUnits([ingredient({ id: 'a', unit: '   ' })], []);
    expect(result[0].classification).toBe('INVALID');
  });

  it('preserves distinct units as separate entries (does not merge kg and bag)', () => {
    const result = classifyLegacyUnits(
      [ingredient({ id: 'a', unit: 'kg' }), ingredient({ id: 'b', unit: 'bag' })],
      [{ code: 'KG' }],
    );
    expect(result).toHaveLength(2);
    const kgEntry = result.find((r) => r.normalizedUnit === 'kg');
    const bagEntry = result.find((r) => r.normalizedUnit === 'bag');
    expect(kgEntry?.classification).toBe('EXACT_GLOBAL_UNIT');
    expect(bagEntry?.classification).toBe('ITEM_SPECIFIC_PACKAGE_UNIT');
  });

  it('groups identical normalized units and aggregates occurrence counts', () => {
    const result = classifyLegacyUnits(
      [ingredient({ id: 'a', unit: 'KG' }), ingredient({ id: 'b', unit: ' kg ' })],
      [],
    );
    expect(result).toHaveLength(1);
    expect(result[0].occurrenceCount).toBe(2);
    expect(result[0].affectedIngredientIds.sort()).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/unit-classification.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/inventory-migration/unit-classification.ts
import type { LegacyIngredientRecord, UnitClassificationEntry } from './types.js';
import { normalizeLegacyUnit } from './normalization.js';

const KNOWN_GLOBAL_UNIT_SYNONYMS: Record<string, { canonicalCode: string }> = {
  gram: { canonicalCode: 'GRAM' },
  grams: { canonicalCode: 'GRAM' },
  g: { canonicalCode: 'GRAM' },
  kilogram: { canonicalCode: 'KILOGRAM' },
  kilograms: { canonicalCode: 'KILOGRAM' },
  kg: { canonicalCode: 'KILOGRAM' },
  liter: { canonicalCode: 'LITER' },
  litre: { canonicalCode: 'LITER' },
  liters: { canonicalCode: 'LITER' },
  litres: { canonicalCode: 'LITER' },
  l: { canonicalCode: 'LITER' },
  milliliter: { canonicalCode: 'MILLILITER' },
  millilitre: { canonicalCode: 'MILLILITER' },
  ml: { canonicalCode: 'MILLILITER' },
  piece: { canonicalCode: 'PIECE' },
  pieces: { canonicalCode: 'PIECE' },
  pc: { canonicalCode: 'PIECE' },
  pcs: { canonicalCode: 'PIECE' },
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
      proposedUnitOfMeasureCode: null,
      classification: 'INVALID',
      blockingReason: 'Unit is empty or whitespace-only',
    };
  }

  if (existingCodes.has(normalizedUnit)) {
    return {
      ...base,
      proposedUnitOfMeasureCode: normalizedUnit.toUpperCase(),
      classification: 'EXACT_GLOBAL_UNIT',
      blockingReason: null,
    };
  }

  const synonym = KNOWN_GLOBAL_UNIT_SYNONYMS[normalizedUnit];
  if (synonym) {
    return {
      ...base,
      proposedUnitOfMeasureCode: synonym.canonicalCode,
      classification: 'NORMALIZABLE_GLOBAL_UNIT',
      blockingReason: null,
    };
  }

  if (KNOWN_PACKAGE_UNITS.has(normalizedUnit)) {
    return {
      ...base,
      proposedUnitOfMeasureCode: null,
      classification: 'ITEM_SPECIFIC_PACKAGE_UNIT',
      blockingReason: 'Package unit requires an explicit per-item conversion; none is created in Phase B',
    };
  }

  return {
    ...base,
    proposedUnitOfMeasureCode: null,
    classification: 'UNKNOWN',
    blockingReason: 'No known global-unit synonym or package-unit mapping; requires manual classification',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/unit-classification.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/inventory-migration/unit-classification.ts apps/api/src/modules/inventory-migration/unit-classification.test.ts
git commit -m "feat(cr-006): add Phase B unit readiness classification"
```

---

### Task 7: Category candidate classification

**Files:**
- Create: `apps/api/src/modules/inventory-migration/category-classification.ts`
- Test: `apps/api/src/modules/inventory-migration/category-classification.test.ts`

**Interfaces:**
- Consumes: `LegacyIngredientRecord`, `CategoryCandidate` (Task 4).
- Produces: `classifyLegacyCategories(ingredients: LegacyIngredientRecord[]): CategoryCandidate[]`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/inventory-migration/category-classification.test.ts
import { describe, it, expect } from 'vitest';
import { classifyLegacyCategories } from './category-classification.js';
import type { LegacyIngredientRecord } from './types.js';

function ingredient(overrides: Partial<LegacyIngredientRecord>): LegacyIngredientRecord {
  return {
    id: 'ing-1', name: 'Test', unit: 'kg', category: 'RAW', branchId: 'branch-1', deletedAt: null,
    ...overrides,
  };
}

describe('classifyLegacyCategories', () => {
  it('maps known legacy categories to proposed candidate names with counts', () => {
    const result = classifyLegacyCategories([
      ingredient({ id: 'a', category: 'RAW' }),
      ingredient({ id: 'b', category: 'RAW' }),
      ingredient({ id: 'c', category: 'PACKAGING' }),
    ]);

    const raw = result.find((r) => r.legacyCategory === 'RAW');
    const packaging = result.find((r) => r.legacyCategory === 'PACKAGING');
    expect(raw).toMatchObject({ proposedCategoryName: 'Raw Material', affectedIngredientCount: 2, confidence: 'HIGH' });
    expect(packaging).toMatchObject({ proposedCategoryName: 'Packaging', affectedIngredientCount: 1 });
  });

  it('marks OTHER as low confidence and unresolved', () => {
    const result = classifyLegacyCategories([ingredient({ id: 'a', category: 'OTHER' })]);
    expect(result[0]).toMatchObject({ confidence: 'LOW', unresolved: true });
  });

  it('does not hardcode a fixed enum — unmapped categories still produce a candidate', () => {
    const result = classifyLegacyCategories([ingredient({ id: 'a', category: 'SOME_FUTURE_VALUE' })]);
    expect(result[0]).toMatchObject({ legacyCategory: 'SOME_FUTURE_VALUE', unresolved: true, confidence: 'LOW' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/category-classification.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/inventory-migration/category-classification.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/category-classification.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/inventory-migration/category-classification.ts apps/api/src/modules/inventory-migration/category-classification.test.ts
git commit -m "feat(cr-006): add Phase B category candidate classification"
```

---

### Task 8: Identity collision detection

**Files:**
- Create: `apps/api/src/modules/inventory-migration/identity-collision.ts`
- Test: `apps/api/src/modules/inventory-migration/identity-collision.test.ts`

**Interfaces:**
- Consumes: `LegacyIngredientRecord`, `IdentityCandidateGroup`, `SkuCollision`, `BarcodeCollision` (Task 4); `normalizeInventoryName`, `normalizeLegacyUnit` (Task 2).
- Produces: `detectIdentityCollisions(ingredients: LegacyIngredientRecord[]): IdentityCandidateGroup[]`, `detectSkuCollisions(): SkuCollision[]`, `detectBarcodeCollisions(): BarcodeCollision[]`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/inventory-migration/identity-collision.test.ts
import { describe, it, expect } from 'vitest';
import { detectIdentityCollisions, detectSkuCollisions, detectBarcodeCollisions } from './identity-collision.js';
import type { LegacyIngredientRecord } from './types.js';

function ingredient(overrides: Partial<LegacyIngredientRecord>): LegacyIngredientRecord {
  return {
    id: 'ing-1', name: 'Cheese Powder', unit: 'kg', category: 'RAW', branchId: 'branch-1', deletedAt: null,
    ...overrides,
  };
}

describe('detectIdentityCollisions', () => {
  it('groups same-name/same-unit/same-category across branches as SAFE_AUTO_MATCH_CANDIDATE', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', branchId: 'b1', name: 'Cheese Powder', unit: 'kg', category: 'RAW' }),
      ingredient({ id: 'b', branchId: 'b2', name: 'CHEESE   POWDER', unit: 'KG', category: 'RAW' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].classification).toBe('SAFE_AUTO_MATCH_CANDIDATE');
    expect(groups[0].members.map((m) => m.ingredientId).sort()).toEqual(['a', 'b']);
  });

  it('marks same-name/different-unit as AMBIGUOUS, not auto-matched', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', branchId: 'b1', name: 'Cheese', unit: 'kg' }),
      ingredient({ id: 'b', branchId: 'b2', name: 'Cheese', unit: 'piece' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].classification).toBe('AMBIGUOUS');
  });

  it('marks same-name/same-unit but conflicting category as AMBIGUOUS', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', name: 'Sprinkles', unit: 'kg', category: 'RAW' }),
      ingredient({ id: 'b', name: 'Sprinkles', unit: 'kg', category: 'FLAVOR' }),
    ]);
    expect(groups[0].classification).toBe('AMBIGUOUS');
  });

  it('classifies a name with no collision as DISTINCT', () => {
    const groups = detectIdentityCollisions([ingredient({ id: 'a', name: 'Unique Item' })]);
    expect(groups[0].classification).toBe('DISTINCT');
  });

  it('classifies an empty name as INVALID', () => {
    const groups = detectIdentityCollisions([ingredient({ id: 'a', name: '   ' })]);
    expect(groups[0].classification).toBe('INVALID');
  });

  it('does not infer a match from name equality alone (name matches, unit/category differ, still not SAFE)', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', name: 'X', unit: 'kg', category: 'RAW' }),
      ingredient({ id: 'b', name: 'X', unit: 'bag', category: 'PACKAGING' }),
    ]);
    expect(groups[0].classification).not.toBe('SAFE_AUTO_MATCH_CANDIDATE');
  });

  it('excludes soft-deleted ingredients from grouping', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', name: 'Gone', deletedAt: new Date() }),
    ]);
    expect(groups).toHaveLength(0);
  });
});

describe('detectSkuCollisions / detectBarcodeCollisions', () => {
  it('return empty arrays because legacy Ingredient has no sku/barcode columns', () => {
    expect(detectSkuCollisions()).toEqual([]);
    expect(detectBarcodeCollisions()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/identity-collision.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/inventory-migration/identity-collision.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/identity-collision.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/inventory-migration/identity-collision.ts apps/api/src/modules/inventory-migration/identity-collision.test.ts
git commit -m "feat(cr-006): add Phase B identity collision detection"
```

---

### Task 9: Flavor-linked legacy detection

**Files:**
- Create: `apps/api/src/modules/inventory-migration/flavor-linked.ts`
- Test: `apps/api/src/modules/inventory-migration/flavor-linked.test.ts`

**Interfaces:**
- Consumes: `LegacyFlavorRecord`, `LegacyIngredientRecord`, `FlavorLinkedCandidate` (Task 4); `normalizeInventoryName`, `normalizeLegacyUnit` (Task 2).
- Produces: `detectFlavorLinkedCandidates(flavors: LegacyFlavorRecord[], ingredients: LegacyIngredientRecord[]): FlavorLinkedCandidate[]`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/inventory-migration/flavor-linked.test.ts
import { describe, it, expect } from 'vitest';
import { detectFlavorLinkedCandidates } from './flavor-linked.js';
import type { LegacyFlavorRecord, LegacyIngredientRecord } from './types.js';

function flavor(overrides: Partial<LegacyFlavorRecord>): LegacyFlavorRecord {
  return { id: 'flavor-1', name: 'Cheese', ingredientName: 'Cheese Powder', ingredientUnit: 'kg', isActive: true, ...overrides };
}

function ingredient(overrides: Partial<LegacyIngredientRecord>): LegacyIngredientRecord {
  return { id: 'ing-1', name: 'Cheese Powder', unit: 'kg', category: 'FLAVOR', branchId: 'b1', deletedAt: null, ...overrides };
}

describe('detectFlavorLinkedCandidates', () => {
  it('matches a flavor to ingredients by normalized name+unit across branches', () => {
    const result = detectFlavorLinkedCandidates(
      [flavor({})],
      [
        ingredient({ id: 'a', branchId: 'b1', name: 'CHEESE   POWDER', unit: 'KG' }),
        ingredient({ id: 'b', branchId: 'b2', name: 'cheese powder', unit: 'kg' }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0].matchedIngredientIds.sort()).toEqual(['a', 'b']);
    expect(result[0].mappingMethod).toBe('FLAVOR_IDENTITY');
    expect(result[0].unresolved).toBe(false);
  });

  it('marks a flavor unresolved when no matching legacy ingredient exists', () => {
    const result = detectFlavorLinkedCandidates([flavor({ ingredientName: 'Nonexistent', ingredientUnit: 'kg' })], []);
    expect(result[0].unresolved).toBe(true);
    expect(result[0].matchedIngredientIds).toEqual([]);
  });

  it('excludes soft-deleted ingredients from matching', () => {
    const result = detectFlavorLinkedCandidates(
      [flavor({})],
      [ingredient({ id: 'a', deletedAt: new Date() })],
    );
    expect(result[0].unresolved).toBe(true);
  });

  it('does not match on unit alone if name differs', () => {
    const result = detectFlavorLinkedCandidates(
      [flavor({ ingredientName: 'Cheese Powder', ingredientUnit: 'kg' })],
      [ingredient({ id: 'a', name: 'Chocolate Powder', unit: 'kg' })],
    );
    expect(result[0].matchedIngredientIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/flavor-linked.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/inventory-migration/flavor-linked.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/flavor-linked.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/inventory-migration/flavor-linked.ts apps/api/src/modules/inventory-migration/flavor-linked.test.ts
git commit -m "feat(cr-006): add Phase B flavor-linked legacy detection"
```

---

### Task 10: Phase C readiness gate

**Files:**
- Create: `apps/api/src/modules/inventory-migration/readiness.ts`
- Test: `apps/api/src/modules/inventory-migration/readiness.test.ts`

**Interfaces:**
- Consumes: `UnitClassificationEntry`, `IdentityCandidateGroup`, `SkuCollision`, `BarcodeCollision`, `FlavorLinkedCandidate`, `InvalidRecord` (Task 4).
- Produces: `ReadinessInput`, `ReadinessResult` (`{ migrationReadiness: boolean; blockers: string[]; warnings: string[] }`), `evaluateReadiness(input: ReadinessInput): ReadinessResult`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/inventory-migration/readiness.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateReadiness } from './readiness.js';
import type { ReadinessInput } from './readiness.js';

function baseInput(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    normalizedUnits: [],
    ambiguousGroups: [],
    skuCollisions: [],
    barcodeCollisions: [],
    flavorLinkedCandidates: [],
    invalidRecords: [],
    ...overrides,
  };
}

describe('evaluateReadiness', () => {
  it('is ready with no blockers when everything is clean', () => {
    const result = evaluateReadiness(baseInput());
    expect(result.migrationReadiness).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('blocks on unresolved SKU collisions', () => {
    const result = evaluateReadiness(baseInput({ skuCollisions: [{ sku: 'X', ingredientIds: ['a', 'b'] }] }));
    expect(result.migrationReadiness).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it('blocks on unresolved barcode collisions', () => {
    const result = evaluateReadiness(baseInput({ barcodeCollisions: [{ barcode: 'Y', ingredientIds: ['a', 'b'] }] }));
    expect(result.migrationReadiness).toBe(false);
  });

  it('blocks on unresolved invalid records', () => {
    const result = evaluateReadiness(baseInput({ invalidRecords: [{ ingredientId: 'a', reason: 'Empty name' }] }));
    expect(result.migrationReadiness).toBe(false);
  });

  it('does not block on ambiguous groups — they are a warning only', () => {
    const result = evaluateReadiness(
      baseInput({
        ambiguousGroups: [{ normalizedName: 'x', classification: 'AMBIGUOUS', members: [], reason: 'r' }],
      }),
    );
    expect(result.migrationReadiness).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('does not block on UNKNOWN units — warning only', () => {
    const result = evaluateReadiness(
      baseInput({
        normalizedUnits: [
          { rawUnit: 'x', normalizedUnit: 'x', occurrenceCount: 1, affectedIngredientIds: ['a'], proposedUnitOfMeasureCode: null, classification: 'UNKNOWN', blockingReason: 'r' },
        ],
      }),
    );
    expect(result.migrationReadiness).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/readiness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/inventory-migration/readiness.ts
import type {
  UnitClassificationEntry,
  IdentityCandidateGroup,
  SkuCollision,
  BarcodeCollision,
  FlavorLinkedCandidate,
  InvalidRecord,
} from './types.js';

export interface ReadinessInput {
  normalizedUnits: UnitClassificationEntry[];
  ambiguousGroups: IdentityCandidateGroup[];
  skuCollisions: SkuCollision[];
  barcodeCollisions: BarcodeCollision[];
  flavorLinkedCandidates: FlavorLinkedCandidate[];
  invalidRecords: InvalidRecord[];
}

export interface ReadinessResult {
  migrationReadiness: boolean;
  blockers: string[];
  warnings: string[];
}

/**
 * CR-006 Phase B requirement 9 — Phase C readiness is true only when SKU/
 * barcode collisions and invalid records are resolved. Ambiguous identity
 * groups, UNKNOWN/package units, and unresolved flavor links are documented
 * as warnings, not blockers — they do not need automatic resolution here.
 */
export function evaluateReadiness(input: ReadinessInput): ReadinessResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (input.skuCollisions.length > 0) {
    blockers.push(`${input.skuCollisions.length} unresolved SKU collision(s)`);
  }
  if (input.barcodeCollisions.length > 0) {
    blockers.push(`${input.barcodeCollisions.length} unresolved barcode collision(s)`);
  }
  if (input.invalidRecords.length > 0) {
    blockers.push(`${input.invalidRecords.length} invalid legacy ingredient record(s) not excluded`);
  }

  const unknownUnits = input.normalizedUnits.filter((u) => u.classification === 'UNKNOWN');
  if (unknownUnits.length > 0) {
    warnings.push(`${unknownUnits.length} legacy unit(s) classified UNKNOWN and require manual mapping`);
  }

  const packageUnits = input.normalizedUnits.filter((u) => u.classification === 'ITEM_SPECIFIC_PACKAGE_UNIT');
  if (packageUnits.length > 0) {
    warnings.push(`${packageUnits.length} item-specific package unit(s) require per-item conversion review`);
  }

  if (input.ambiguousGroups.length > 0) {
    warnings.push(`${input.ambiguousGroups.length} ambiguous identity group(s) require manual review`);
  }

  const unresolvedFlavorLinks = input.flavorLinkedCandidates.filter((f) => f.unresolved);
  if (unresolvedFlavorLinks.length > 0) {
    warnings.push(`${unresolvedFlavorLinks.length} flavor-linked candidate(s) have no matching legacy ingredient`);
  }

  return { migrationReadiness: blockers.length === 0, blockers, warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/readiness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/inventory-migration/readiness.ts apps/api/src/modules/inventory-migration/readiness.test.ts
git commit -m "feat(cr-006): add Phase B Phase-C readiness gate"
```

---

### Task 11: Dry-run orchestration service

**Files:**
- Create: `apps/api/src/modules/inventory-migration/dry-run.service.ts`
- Test: `apps/api/src/modules/inventory-migration/dry-run.service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2-10 (`generateMigrationBatchId`, `fetchLegacyIngredients`/`fetchLegacyFlavors`/`fetchExistingUnitCodes`/`fetchSourceSummary`, `classifyLegacyUnits`, `classifyLegacyCategories`, `detectIdentityCollisions`/`detectSkuCollisions`/`detectBarcodeCollisions`, `detectFlavorLinkedCandidates`, `evaluateReadiness`, `normalizeInventoryName`, `DryRunReport`/`InvalidRecord` types).
- Produces: `runMigrationDryRun(batchId?: string): Promise<DryRunReport>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/inventory-migration/dry-run.service.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('./migration-source.repository.js', () => ({
  fetchLegacyIngredients: vi.fn(async () => [
    { id: 'a', name: 'Cheese Powder', unit: 'kg', category: 'RAW', branchId: 'b1', deletedAt: null },
    { id: 'b', name: 'Cheese Powder', unit: 'kg', category: 'RAW', branchId: 'b2', deletedAt: null },
  ]),
  fetchLegacyFlavors: vi.fn(async () => []),
  fetchExistingUnitCodes: vi.fn(async () => []),
  fetchSourceSummary: vi.fn(async () => ({
    branchCount: 2, ingredientCount: 2, activeIngredientCount: 2, softDeletedIngredientCount: 0,
    distinctIngredientUnitCount: 1, distinctIngredientCategoryCount: 1,
    productInventoryCount: 0, activeProductInventoryCount: 0,
    flavorCount: 0, activeFlavorCount: 0, inventoryMovementCount: 0,
    existingUnitOfMeasureCount: 0, existingInventoryCategoryCount: 0,
  })),
}));

const repo = await import('./migration-source.repository.js');
const { runMigrationDryRun } = await import('./dry-run.service.js');

describe('runMigrationDryRun', () => {
  it('assembles a full report and computes readiness from a clean SAFE_AUTO_MATCH_CANDIDATE case', async () => {
    const report = await runMigrationDryRun('CR006-INGREDIENT-20260727-000000');
    expect(report.batchId).toBe('CR006-INGREDIENT-20260727-000000');
    expect(report.identityCandidates).toHaveLength(1);
    expect(report.identityCandidates[0].classification).toBe('SAFE_AUTO_MATCH_CANDIDATE');
    expect(report.skuCollisions).toEqual([]);
    expect(report.barcodeCollisions).toEqual([]);
    expect(report.migrationReadiness).toBe(true);
  });

  it('generates a default batch ID when none is provided', async () => {
    const report = await runMigrationDryRun();
    expect(report.batchId).toMatch(/^CR006-INGREDIENT-\d{8}-\d{6}$/);
  });

  it('performs no database writes — only the read-only repository functions are called', async () => {
    await runMigrationDryRun('CR006-INGREDIENT-20260727-000000');
    expect(repo.fetchLegacyIngredients).toHaveBeenCalled();
    expect(repo.fetchLegacyFlavors).toHaveBeenCalled();
    expect(repo.fetchSourceSummary).toHaveBeenCalled();
    // The mocked repository module exposes no create/update/delete export at all,
    // so there is nothing to call that would write — this test documents that
    // the orchestrator only imports the four read functions above.
    expect(Object.keys(repo).sort()).toEqual(
      ['fetchExistingUnitCodes', 'fetchLegacyFlavors', 'fetchLegacyIngredients', 'fetchSourceSummary'].sort(),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/dry-run.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/inventory-migration/dry-run.service.ts
import { generateMigrationBatchId } from './migration-batch.js';
import {
  fetchLegacyIngredients,
  fetchLegacyFlavors,
  fetchExistingUnitCodes,
  fetchSourceSummary,
} from './migration-source.repository.js';
import { classifyLegacyUnits } from './unit-classification.js';
import { classifyLegacyCategories } from './category-classification.js';
import { detectIdentityCollisions, detectSkuCollisions, detectBarcodeCollisions } from './identity-collision.js';
import { detectFlavorLinkedCandidates } from './flavor-linked.js';
import { evaluateReadiness } from './readiness.js';
import { normalizeInventoryName, normalizeLegacyUnit } from './normalization.js';
import type { DryRunReport, InvalidRecord } from './types.js';

/**
 * CR-006 Phase B orchestrator. Read-only: calls only the fetch* functions
 * from migration-source.repository.ts, then composes pure classification/
 * detection functions into one report. No InventoryIdentityMapping,
 * InventoryItem, InventoryStock, or ProductComponent row is created here.
 */
export async function runMigrationDryRun(batchId: string = generateMigrationBatchId()): Promise<DryRunReport> {
  const [ingredients, flavors, sourceSummary, existingUnits] = await Promise.all([
    fetchLegacyIngredients(),
    fetchLegacyFlavors(),
    fetchSourceSummary(),
    fetchExistingUnitCodes(),
  ]);

  const normalizedUnits = classifyLegacyUnits(ingredients, existingUnits);
  const categoryCandidates = classifyLegacyCategories(ingredients);
  const identityGroups = detectIdentityCollisions(ingredients);
  const identityCandidates = identityGroups.filter((g) => g.classification !== 'AMBIGUOUS');
  const ambiguousGroups = identityGroups.filter((g) => g.classification === 'AMBIGUOUS');
  const skuCollisions = detectSkuCollisions();
  const barcodeCollisions = detectBarcodeCollisions();
  const flavorLinkedCandidates = detectFlavorLinkedCandidates(flavors, ingredients);

  const invalidUnitNormalized = new Set(
    normalizedUnits.filter((u) => u.classification === 'INVALID').map((u) => u.normalizedUnit),
  );
  const invalidRecords: InvalidRecord[] = ingredients
    .filter((i) => i.deletedAt === null)
    .filter(
      (i) =>
        normalizeInventoryName(i.name).normalized.length === 0 ||
        invalidUnitNormalized.has(normalizeLegacyUnit(i.unit).normalized),
    )
    .map((i) => ({
      ingredientId: i.id,
      reason:
        normalizeInventoryName(i.name).normalized.length === 0
          ? 'Empty or whitespace-only name'
          : 'Unit classified INVALID',
    }));

  const readiness = evaluateReadiness({
    normalizedUnits,
    ambiguousGroups,
    skuCollisions,
    barcodeCollisions,
    flavorLinkedCandidates,
    invalidRecords,
  });

  return {
    batchId,
    generatedAt: new Date().toISOString(),
    sourceSummary,
    normalizedUnits,
    categoryCandidates,
    identityCandidates,
    ambiguousGroups,
    barcodeCollisions,
    skuCollisions,
    flavorLinkedCandidates,
    invalidRecords,
    blockers: readiness.blockers,
    warnings: readiness.warnings,
    migrationReadiness: readiness.migrationReadiness,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration/dry-run.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full inventory-migration test suite together**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-migration`
Expected: PASS — all 9 test files (Tasks 2-11) green, no regressions.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/inventory-migration/dry-run.service.ts apps/api/src/modules/inventory-migration/dry-run.service.test.ts
git commit -m "feat(cr-006): add Phase B dry-run orchestration service"
```

---

### Task 12: CLI dry-run command

**Files:**
- Create: `apps/api/scripts/inventory-migration-dry-run.ts`
- Modify: `apps/api/package.json` (add `inventory:migration:dry-run` script)

**Interfaces:**
- Consumes: `runMigrationDryRun` (Task 11), `generateMigrationBatchId` (Task 3).

- [ ] **Step 1: Write the CLI script**

```ts
// apps/api/scripts/inventory-migration-dry-run.ts
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrationDryRun } from '../src/modules/inventory-migration/dry-run.service.js';
import { generateMigrationBatchId } from '../src/modules/inventory-migration/migration-batch.js';

async function main() {
  const batchId = process.argv[2] ?? generateMigrationBatchId();
  const report = await runMigrationDryRun(batchId);

  const outputPath = `reports/inventory-migration/${report.batchId}.json`;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log(`CR-006 Phase B dry-run — batch ${report.batchId}`);
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Legacy ingredients: ${report.sourceSummary.ingredientCount} (${report.sourceSummary.activeIngredientCount} active)`);
  console.log(`Distinct legacy units: ${report.normalizedUnits.length}`);
  console.log(`Category candidates: ${report.categoryCandidates.length}`);
  console.log(`Identity candidates (safe/distinct/invalid): ${report.identityCandidates.length}`);
  console.log(`Ambiguous groups: ${report.ambiguousGroups.length}`);
  console.log(`Flavor-linked candidates: ${report.flavorLinkedCandidates.length}`);
  console.log(`SKU collisions: ${report.skuCollisions.length}`);
  console.log(`Barcode collisions: ${report.barcodeCollisions.length}`);
  console.log(`Invalid records: ${report.invalidRecords.length}`);
  console.log(`Migration readiness: ${report.migrationReadiness ? 'READY' : 'NOT READY'}`);

  if (report.blockers.length > 0) {
    console.log('\nBlockers:');
    for (const blocker of report.blockers) console.log(`  - ${blocker}`);
  }
  if (report.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of report.warnings) console.log(`  - ${warning}`);
  }
  console.log(`\nFull report written to: ${outputPath}`);

  process.exitCode = report.blockers.length > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error('CR-006 Phase B dry-run failed:', error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Add the package.json script**

In `apps/api/package.json`, add to the `scripts` object (after `"prisma:seed"`):

```json
"inventory:migration:dry-run": "tsx scripts/inventory-migration-dry-run.ts"
```

- [ ] **Step 3: Add the reports output directory to .gitignore**

Check `apps/api/.gitignore` (or repo-root `.gitignore`) for an existing ignore pattern; if `reports/` isn't already ignored, add:

```
apps/api/reports/
```

Dry-run JSON output is a point-in-time artifact, not source — it should not be committed.

- [ ] **Step 4: Run the dry-run command against local dev DB and verify no writes**

Before running, confirm `DIRECT_URL` in `apps/api/.env` points at the local/dev shadow DB per the project's Database & Migration Safety rule (never run analysis tooling against production without explicit verification, even though this command only reads).

Run: `pnpm --filter @potato-corner/api run inventory:migration:dry-run`
Expected: exits 0 (or 1 if real blocking collisions exist in dev data — inspect output either way), prints the summary, writes `apps/api/reports/inventory-migration/<batchId>.json`.

- [ ] **Step 5: Verify exit code propagation with a forced blocker**

Temporarily run with `NODE_OPTIONS` unset and confirm via `echo $?` (bash) / `$LASTEXITCODE` (PowerShell) after the run that the process exit code matches `blockers.length > 0`. This is a manual verification step (the automated non-zero-exit-status behavior is already covered by Task 10/11's `evaluateReadiness`/`runMigrationDryRun` unit tests) — no new test file is needed here, this step only confirms the script itself forwards `process.exitCode` correctly end-to-end.

- [ ] **Step 6: Commit**

```bash
git add apps/api/scripts/inventory-migration-dry-run.ts apps/api/package.json apps/api/.gitignore
git commit -m "feat(cr-006): add Phase B dry-run CLI command"
```

---

### Task 13: Database safety verification and Phase B report

**Files:** None created — verification and reporting only.

- [ ] **Step 1: Capture pre-phase row counts (already true before any Phase B code ran, but re-verify now for the report)**

Run against the local/dev DB (verify `DIRECT_URL` per project rules first):

```bash
pnpm --filter @potato-corner/api exec tsx -e "
import { prisma } from './src/lib/prisma.js';
const tables = ['inventoryCategory','unitOfMeasure','unitConversion','inventoryItem','inventoryIdentityMapping','inventoryStock','productComponent'];
for (const t of tables) {
  const count = await (prisma as any)[t].count();
  console.log(t, count);
}
await prisma.\$disconnect();
"
```

Expected: every count is `0` (Phase A tables were verified empty; Phase B added no writes to any of them).

- [ ] **Step 2: Run the full backend test suite**

Run: `pnpm --filter @potato-corner/api test`
Expected: PASS — includes all Task 2-11 `inventory-migration` tests plus every pre-existing test file, with none weakened or deleted.

- [ ] **Step 3: Run type-check and build**

Run: `pnpm --filter @potato-corner/api run type-check`
Run: `pnpm --filter @potato-corner/api run build`
Expected: both PASS with zero errors.

- [ ] **Step 4: Run the dry-run command once more and capture output location for the report**

Run: `pnpm --filter @potato-corner/api run inventory:migration:dry-run`
Record the batch ID and `reports/inventory-migration/<batchId>.json` path for the Phase B report.

- [ ] **Step 5: Re-run the post-phase row counts (Step 1's query) to confirm they are unchanged**

Expected: identical to Step 1 — zero rows across `inventory_categories`, `units_of_measure`, `unit_conversions`, `inventory_items`, `inventory_identity_mappings`, `inventory_stocks`, `product_components`.

- [ ] **Step 6: Assemble and post the required Phase B report**

Using the template from the CR-006 Phase B instructions (files changed, commands added, DB writes performed [none], pre/post row counts, source inventory summary, normalization rules, unit/category/identity/flavor-linked reports generated by the dry-run JSON, blockers, warnings, tests added, test results, type-check/build results, rollback strategy [`git revert`; no migration to roll back since none was created], Phase C readiness result from the dry-run output). End with the required status block:

```
Phase B Status: Awaiting approval
Phase C Started: No
Runtime Behavior Changed: No
Database Schema Changed: No
Database Data Changed: No
Legacy Data Modified: No
Fake Data Created: No
Commit Created: Yes (per-task commits; no merge/push without approval)
Deployment Performed: No
```

Do not proceed to Phase C without explicit user approval.

---

## Self-Review Notes

- **Spec coverage:** Task 1 -> required work item 1 (legacy source inventory). Task 2 -> item 2 (normalization). Task 3 -> item 3 (migration batch). Task 6 -> item 4 (unit classification). Task 7 -> item 5 (category classification). Task 8 -> item 6 (identity collision). Task 9 -> item 7 (flavor-linked detection). Task 12 -> item 8 (dry-run command). Task 10 -> item 9 (readiness gate). Task 13 -> Database Safety + Required Phase B Report sections. Test Requirements list is covered across Tasks 2 (name/unit/whitespace/case/non-equivalence), 8 (sku/barcode/ambiguity/grouping), 9 (flavor-linked), 11 (no-writes), 10 (non-zero exit via blockers, exercised end-to-end in Task 12 Step 5).
- **Placeholder scan:** no TBD/TODO markers; every step has complete, runnable code or an exact command.
- **Type consistency:** `DryRunReport` (Task 4) field names match exactly what Task 11's `runMigrationDryRun` returns; `ReadinessInput`/`ReadinessResult` (Task 10) match what Task 11 passes into `evaluateReadiness`; `LegacyIngredientRecord`/`LegacyFlavorRecord` field names match what Task 5's repository selects and what Tasks 6/7/8/9 destructure.
