import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Controlled dashboard low-stock KPI parity test.
 *
 * Proves (or disproves) that a proposed InventoryStock-based low-stock
 * calculation can reproduce branchesRepository.branchStats's existing
 * Ingredient + InventoryMovement calculation, before anything in
 * branches.repository.ts is touched. This suite makes NO production code
 * changes — it only queries the real (unmodified) legacy code path via
 * branchesRepository.branchStats and a proposed query defined locally below,
 * then compares the two counts per active branch.
 *
 * Requires a real, disposable Postgres database — never Supabase. Set
 * TEST_DATABASE_URL (and point DATABASE_URL/DIRECT_URL at the same
 * database via temporary shell env vars, never apps/api/.env) to enable
 * this suite. See the runtime host guard in assertSafeDatabaseHost below.
 *
 * ---------------------------------------------------------------------
 * PROPOSED PARITY RULE (documented per task spec §3)
 * ---------------------------------------------------------------------
 * An InventoryStock row counts as "low stock" when:
 *   - branchId matches the branch being queried
 *   - InventoryItem.deletedAt IS NULL
 *   - InventoryStock.lowStockThreshold IS NOT NULL
 *   - InventoryStock.quantityOnHand <= InventoryStock.lowStockThreshold
 *
 * criticalThreshold is explicitly NOT part of this KPI (whether or not it
 * exceeds lowStockThreshold is irrelevant to the count).
 *
 * Known, intentional divergences from the legacy calculation:
 *   - Null lowStockThreshold rows are EXCLUDED (legacy Ingredient.lowStockThreshold
 *     is a required column, so the legacy calc has no equivalent case — this
 *     is new proposed-side behavior, not a bug).
 *   - Missing InventoryStock rows are EXCLUDED (an Ingredient with no matching
 *     InventoryStock row for that branch contributes nothing to the proposed
 *     count, even if the legacy calc would have counted it as low stock).
 *   - An unresolved InventoryIdentityMapping (no accepted InventoryItem) has
 *     no InventoryStock row to join through at all, so it cannot be
 *     represented by the proposed KPI under any circumstance.
 *   - Zero and negative InventoryStock.quantityOnHand values count as low
 *     stock whenever a non-null threshold permits it (quantity <= threshold),
 *     mirroring the legacy calc's identical treatment of zero/negative
 *     Ingredient current stock.
 */

const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Refuses to run against anything but a local/disposable database. Called
 * as the first line of beforeAll, before any fixture insert.
 */
function assertSafeDatabaseHost(): void {
  const url = process.env.DATABASE_URL ?? '';
  const bannedSubstrings = ['supabase.com', 'supabase.co', 'nliuhztaezaujzgtsrwp', 'dtqcmmbpashoqvejbyoj'];
  for (const banned of bannedSubstrings) {
    if (url.includes(banned)) {
      throw new Error(
        `Refusing to run branches-low-stock-parity.integration.test.ts: DATABASE_URL contains banned identifier "${banned}". This suite must only run against a local or disposable database, never Supabase.`,
      );
    }
  }

  const hostMatch = url.match(/@([^:/@]+)(?::\d+)?\//);
  const host = hostMatch?.[1];
  const allowedHosts = new Set(['localhost', '127.0.0.1']);
  if (!host || !allowedHosts.has(host)) {
    throw new Error(
      `Refusing to run branches-low-stock-parity.integration.test.ts: DATABASE_URL host "${host ?? '(unresolved)'}" is not localhost/127.0.0.1. Point DATABASE_URL/DIRECT_URL/TEST_DATABASE_URL at a local or disposable CI Postgres instance via temporary env vars (never apps/api/.env) before running this suite.`,
    );
  }
}

// Imported unconditionally — constructing PrismaClient doesn't touch the
// network; only the queries inside describe.skipIf below do. Same pattern
// as branches.integration.test.ts.
const { prisma } = await import('../../lib/prisma.js');
const { branchesRepository } = await import('./branches.repository.js');

/**
 * The proposed replacement query. Lives here, not in branches.repository.ts —
 * this suite demonstrates what a future implementation could look like
 * without changing production code yet. Filters app-side for the same
 * reason branchStats's legacy calc does (see its comment): Prisma's filter
 * API can't compare two columns of the same row without raw SQL.
 */
async function proposedLowStockCount(branchId: string): Promise<number> {
  const rows = await prisma.inventoryStock.findMany({
    where: {
      branchId,
      lowStockThreshold: { not: null },
      inventoryItem: { deletedAt: null },
    },
    select: { quantityOnHand: true, lowStockThreshold: true },
  });
  return rows.filter((row) => row.quantityOnHand.toNumber() <= (row.lowStockThreshold?.toNumber() ?? Infinity)).length;
}

describe.skipIf(!canRunIntegrationTests)('dashboard low-stock KPI parity — Ingredient/InventoryMovement vs InventoryItem/InventoryStock', () => {
  let unitId: string;
  let branchActive1Id: string;
  let branchActive2Id: string;
  let branchInactiveId: string;

  const ingredientIds: string[] = [];
  const inventoryItemIds: string[] = [];
  const standaloneMappingIds: string[] = [];
  const branchIds: string[] = [];

  /**
   * Seeds one legacy Ingredient + matching InventoryMovement(s) totalling
   * `quantity`, mirroring how the real deduction/stock-in path builds up
   * current stock as a ledger sum rather than a stored field.
   */
  async function seedLegacyIngredient(params: {
    branchId: string;
    lowStockThreshold: number;
    quantity: number;
    deleted?: boolean;
  }): Promise<string> {
    const ingredient = await prisma.ingredient.create({
      data: {
        branchId: params.branchId,
        name: `parity-ingredient-${randomUUID()}`,
        unit: 'g',
        currentStock: 0,
        lowStockThreshold: params.lowStockThreshold,
        criticalThreshold: 0,
        deletedAt: params.deleted ? new Date() : null,
      },
    });
    ingredientIds.push(ingredient.id);

    await prisma.inventoryMovement.create({
      data: {
        branchId: params.branchId,
        ingredientId: ingredient.id,
        movementType: params.quantity < 0 ? 'waste' : 'stock_in',
        quantityChange: params.quantity,
        quantityBefore: 0,
        quantityAfter: params.quantity,
      },
    });

    return ingredient.id;
  }

  async function seedInventoryItem(deleted = false): Promise<string> {
    const item = await prisma.inventoryItem.create({
      data: {
        name: `parity-item-${randomUUID()}`,
        baseUnitId: unitId,
        deletedAt: deleted ? new Date() : null,
      },
    });
    inventoryItemIds.push(item.id);
    return item.id;
  }

  async function resolveMapping(legacyIngredientId: string, inventoryItemId: string): Promise<void> {
    await prisma.inventoryIdentityMapping.create({
      data: {
        legacyIngredientId,
        inventoryItemId,
        legacyName: 'parity-fixture',
        legacyUnit: 'g',
        mappingStatus: 'AUTO_MATCHED',
        mappingMethod: 'NORMALIZED_NAME_UNIT_CATEGORY',
      },
    });
  }

  async function leaveMappingUnresolved(legacyIngredientId: string): Promise<void> {
    const mapping = await prisma.inventoryIdentityMapping.create({
      data: {
        legacyIngredientId,
        inventoryItemId: null,
        legacyName: 'parity-fixture-unresolved',
        legacyUnit: 'g',
        mappingStatus: 'AMBIGUOUS',
      },
    });
    standaloneMappingIds.push(mapping.id);
  }

  async function seedStock(params: {
    branchId: string;
    inventoryItemId: string;
    quantityOnHand: number;
    lowStockThreshold: number | null;
    criticalThreshold?: number | null;
  }): Promise<void> {
    await prisma.inventoryStock.create({
      data: {
        branchId: params.branchId,
        inventoryItemId: params.inventoryItemId,
        quantityOnHand: params.quantityOnHand,
        lowStockThreshold: params.lowStockThreshold,
        criticalThreshold: params.criticalThreshold ?? null,
      },
    });
  }

  /** Seeds one full scenario: legacy Ingredient/InventoryMovement + proposed InventoryItem/InventoryIdentityMapping/InventoryStock, wired the same way real migrated data would be. */
  async function seedFullScenario(params: {
    branchId: string;
    lowStockThreshold: number;
    quantity: number;
    stockLowStockThreshold: number | null;
    criticalThreshold?: number | null;
    deleted?: boolean;
    skipStockRow?: boolean;
  }): Promise<{ ingredientId: string; inventoryItemId: string }> {
    const ingredientId = await seedLegacyIngredient({
      branchId: params.branchId,
      lowStockThreshold: params.lowStockThreshold,
      quantity: params.quantity,
      deleted: params.deleted,
    });
    const inventoryItemId = await seedInventoryItem(params.deleted);
    await resolveMapping(ingredientId, inventoryItemId);
    if (!params.skipStockRow) {
      await seedStock({
        branchId: params.branchId,
        inventoryItemId,
        quantityOnHand: params.quantity,
        lowStockThreshold: params.stockLowStockThreshold,
        criticalThreshold: params.criticalThreshold,
      });
    }
    return { ingredientId, inventoryItemId };
  }

  beforeAll(async () => {
    assertSafeDatabaseHost();

    const unit = await prisma.unitOfMeasure.create({
      data: { code: `parity-g-${randomUUID().slice(0, 8)}`, name: 'Parity Gram', dimension: 'WEIGHT', isBaseUnit: true },
    });
    unitId = unit.id;

    const branchActive1 = await prisma.branch.create({
      data: { name: 'Parity Active Branch 1', code: `PARITY-A1-${randomUUID().slice(0, 8)}`, address: '1 Test St', city: 'Testville', status: 'active' },
    });
    branchActive1Id = branchActive1.id;

    const branchActive2 = await prisma.branch.create({
      data: { name: 'Parity Active Branch 2', code: `PARITY-A2-${randomUUID().slice(0, 8)}`, address: '2 Test St', city: 'Testville', status: 'active' },
    });
    branchActive2Id = branchActive2.id;

    const branchInactive = await prisma.branch.create({
      data: { name: 'Parity Inactive Branch', code: `PARITY-IN-${randomUUID().slice(0, 8)}`, address: '3 Test St', city: 'Testville', status: 'inactive' },
    });
    branchInactiveId = branchInactive.id;

    branchIds.push(branchActive1Id, branchActive2Id, branchInactiveId);

    // --- Scenario 1: quantity above low-stock threshold — not low on either side ---
    await seedFullScenario({ branchId: branchActive1Id, lowStockThreshold: 10, quantity: 50, stockLowStockThreshold: 10 });

    // --- Scenario 2: quantity equal to low-stock threshold — low on both sides ---
    await seedFullScenario({ branchId: branchActive1Id, lowStockThreshold: 10, quantity: 10, stockLowStockThreshold: 10 });

    // --- Scenario 3: quantity below low-stock threshold — low on both sides ---
    await seedFullScenario({ branchId: branchActive1Id, lowStockThreshold: 10, quantity: 5, stockLowStockThreshold: 10 });

    // --- Scenario 4: quantity equal to zero — low on both sides ---
    await seedFullScenario({ branchId: branchActive1Id, lowStockThreshold: 10, quantity: 0, stockLowStockThreshold: 10 });

    // --- Scenario 5: negative quantity — low on both sides ---
    await seedFullScenario({ branchId: branchActive1Id, lowStockThreshold: 10, quantity: -5, stockLowStockThreshold: 10 });

    // --- Scenario 6: deleted item — excluded on both sides regardless of quantity ---
    await seedFullScenario({ branchId: branchActive1Id, lowStockThreshold: 10, quantity: 5, stockLowStockThreshold: 10, deleted: true });

    // --- Scenario 7: null InventoryStock.lowStockThreshold — legacy counts it, proposed excludes it (documented divergence) ---
    await seedFullScenario({ branchId: branchActive1Id, lowStockThreshold: 10, quantity: 5, stockLowStockThreshold: null });

    // --- Scenario 8: zero InventoryStock.lowStockThreshold (not null) — low on both sides ---
    await seedFullScenario({ branchId: branchActive1Id, lowStockThreshold: 0, quantity: 0, stockLowStockThreshold: 0 });

    // --- Scenario 9: missing InventoryStock row — legacy counts it, proposed excludes it (documented divergence: incomplete migration data) ---
    await seedFullScenario({ branchId: branchActive1Id, lowStockThreshold: 10, quantity: 5, stockLowStockThreshold: 10, skipStockRow: true });

    // --- Scenario 10: unresolved InventoryIdentityMapping — legacy counts it, proposed cannot represent it at all (no InventoryItem/InventoryStock to join through) ---
    const s10IngredientId = await seedLegacyIngredient({ branchId: branchActive1Id, lowStockThreshold: 10, quantity: 5 });
    await leaveMappingUnresolved(s10IngredientId);

    // --- Scenario 12: InventoryStock.criticalThreshold > lowStockThreshold — proves criticalThreshold never leaks into the KPI on either side ---
    await seedFullScenario({ branchId: branchActive1Id, lowStockThreshold: 10, quantity: 15, stockLowStockThreshold: 10, criticalThreshold: 20 });

    // --- Branch isolation control: a second, independent low-stock item on branchActive2 ---
    await seedFullScenario({ branchId: branchActive2Id, lowStockThreshold: 5, quantity: 2, stockLowStockThreshold: 5 });
    await seedFullScenario({ branchId: branchActive2Id, lowStockThreshold: 5, quantity: 100, stockLowStockThreshold: 5 });

    // --- Scenario 11: inactive branch — a low-stock item that must not appear in either active-branch count ---
    await seedFullScenario({ branchId: branchInactiveId, lowStockThreshold: 10, quantity: 5, stockLowStockThreshold: 10 });
  });

  afterAll(async () => {
    // InventoryItem delete cascades its InventoryIdentityMapping (onDelete:
    // Cascade) and InventoryStock (onDelete: Cascade) rows.
    await prisma.inventoryItem.deleteMany({ where: { id: { in: inventoryItemIds } } });
    // Scenario 10's mapping has no InventoryItem to cascade from.
    await prisma.inventoryIdentityMapping.deleteMany({ where: { id: { in: standaloneMappingIds } } });
    // Branch delete cascades Ingredient (onDelete: Cascade), which in turn
    // cascades InventoryMovement (onDelete: Cascade) and any remaining
    // InventoryStock (onDelete: Cascade) rows.
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: unitId } });

    // Cleanliness postcondition — thrown (not `expect`) so a leak fails the
    // suite via the hook itself rather than a separate, skippable test.
    const [remainingBranches, remainingIngredients, remainingItems, remainingMappings, remainingStocks, remainingMovements, remainingUnit] = await Promise.all([
      prisma.branch.count({ where: { id: { in: branchIds } } }),
      prisma.ingredient.count({ where: { id: { in: ingredientIds } } }),
      prisma.inventoryItem.count({ where: { id: { in: inventoryItemIds } } }),
      prisma.inventoryIdentityMapping.count({ where: { legacyIngredientId: { in: ingredientIds } } }),
      prisma.inventoryStock.count({ where: { branchId: { in: branchIds } } }),
      prisma.inventoryMovement.count({ where: { ingredientId: { in: ingredientIds } } }),
      prisma.unitOfMeasure.count({ where: { id: unitId } }),
    ]);
    const leaked = { remainingBranches, remainingIngredients, remainingItems, remainingMappings, remainingStocks, remainingMovements, remainingUnit };
    const totalLeaked = Object.values(leaked).reduce((a, b) => a + b, 0);
    if (totalLeaked > 0) {
      throw new Error(`Fixture teardown left rows behind: ${JSON.stringify(leaked)}`);
    }

    await prisma.$disconnect();
  });

  it('branchActive1: legacy count is 8 (scenarios 2,3,4,5,7,8,9,10)', async () => {
    const stats = await branchesRepository.branchStats(branchActive1Id);
    expect(stats.lowStockIngredientCount).toBe(8);
  });

  it('branchActive1: proposed count is 5 (scenarios 2,3,4,5,8 — 7,9,10 excluded by rule, 1,6,12 correctly not low)', async () => {
    const count = await proposedLowStockCount(branchActive1Id);
    expect(count).toBe(5);
  });

  it('branchActive1: parity difference is 3, fully explained by null-threshold, missing-stock, and unresolved-mapping exclusions', async () => {
    const legacy = (await branchesRepository.branchStats(branchActive1Id)).lowStockIngredientCount;
    const proposed = await proposedLowStockCount(branchActive1Id);
    expect(legacy - proposed).toBe(3);
  });

  it('branchActive2: legacy and proposed counts match exactly (1 of 2 items low, branch-isolated from branchActive1 fixtures)', async () => {
    const legacy = (await branchesRepository.branchStats(branchActive2Id)).lowStockIngredientCount;
    const proposed = await proposedLowStockCount(branchActive2Id);
    expect(legacy).toBe(1);
    expect(proposed).toBe(1);
    expect(legacy - proposed).toBe(0);
  });

  it('inactive branch scenario 11 does not leak into either active branch count', async () => {
    const legacyInactive = (await branchesRepository.branchStats(branchInactiveId)).lowStockIngredientCount;
    // branchStats itself doesn't filter by status (it's called per explicit
    // branchId), but the dashboard's aggregate entry point,
    // findAllStatsGrouped, only iterates branches with status 'active' — so
    // the inactive branch's low-stock item is correctly visible when queried
    // directly but excluded from the active-branch roll-up.
    expect(legacyInactive).toBe(1);

    const allStats = await branchesRepository.findAllStatsGrouped();
    const activeBranchIdsInRollup = allStats.map((s) => s.branchId);
    expect(activeBranchIdsInRollup).not.toContain(branchInactiveId);
    expect(activeBranchIdsInRollup).toContain(branchActive1Id);
    expect(activeBranchIdsInRollup).toContain(branchActive2Id);
  });

});
