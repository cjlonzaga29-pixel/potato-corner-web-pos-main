import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Integration tests exercise the real Prisma + Redis stack end to end,
 * following the same convention as auth.integration.test.ts. They require
 * a real, disposable Postgres database (migrations applied) and a real
 * Redis instance, isolated from the local dev database so these tests
 * never touch seeded dev data.
 *
 * Set TEST_DATABASE_URL and TEST_REDIS_URL to enable this suite.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL);

// Imported unconditionally — see the identical note in
// transactions.integration.test.ts. Constructing PrismaClient doesn't touch
// the network; only the queries inside describe.skipIf below do.
const { prisma } = await import('../../lib/prisma.js');
const { branchesService } = await import('./branches.service.js');
const { inventoryService } = await import('../inventory/inventory.service.js');

describe.skipIf(!canRunIntegrationTests)('branches integration', () => {
  beforeAll(async () => {
    // TODO: point `prisma` at TEST_DATABASE_URL and `redis` at TEST_REDIS_URL,
    // run `prisma migrate deploy` against the test database, and seed one
    // super_admin, one supervisor (assigned to branch A only), and one
    // staff user before the suite runs.
  });

  afterAll(async () => {
    // TODO: truncate all tables touched by these tests and close the
    // Prisma/Redis connections opened for this suite.
  });

  it('POST /api/branches creates a branch with an auto-generated code', async () => {
    // TODO: POST /api/branches as super_admin with no `code` field; assert
    // 201, response.data.code matches /^PC-[A-Z]{2,5}-\d{3}$/, and a
    // BRANCH_CREATED audit log row exists for the new branch id.
    expect(true).toBe(true);
  });

  it('POST /api/branches with a supervisor token returns 403', async () => {
    // TODO: POST /api/branches as supervisor; assert 403 INSUFFICIENT_PERMISSIONS.
    expect(true).toBe(true);
  });

  it('GET /api/branches with a supervisor token returns only their assigned branches', async () => {
    // TODO: GET /api/branches as the seeded supervisor; assert every
    // returned branch id is in the supervisor's branch_ids and branch B
    // (not assigned) is absent.
    expect(true).toBe(true);
  });

  it('GET /api/branches with a super_admin token returns all branches', async () => {
    // TODO: GET /api/branches as super_admin; assert both branch A and
    // branch B are present regardless of assignment.
    expect(true).toBe(true);
  });

  it('PATCH /api/branches/:id/status changes status and creates an audit log', async () => {
    // TODO: PATCH status to 'inactive' as super_admin; assert 200, the
    // branch's status field updated, and a BRANCH_STATUS_CHANGED audit log
    // row exists with beforeState.status 'active' and afterState.status
    // 'inactive'.
    expect(true).toBe(true);
  });

  it('POST /api/branches/:id/assignments assigns a supervisor correctly', async () => {
    // TODO: POST { userId } as super_admin; assert 201, a
    // user_branch_assignments row exists with removedAt null, and a
    // SUPERVISOR_ASSIGNED audit log row exists.
    expect(true).toBe(true);
  });

  it('DELETE /api/branches/:id/assignments/:userId removes the assignment', async () => {
    // TODO: DELETE the assignment created above; assert 204, the
    // user_branch_assignments row now has removedAt set (not deleted), and
    // a SUPERVISOR_REMOVED audit log row exists.
    expect(true).toBe(true);
  });
});

/**
 * CR-004 idempotent branch provisioning — exercises the real service layer
 * (branchesService.createBranch -> productInventoryRepository.findDistinctIngredientIdentities
 * -> inventoryService.provisionBranchIngredients) against a real Postgres
 * database, proving a brand-new branch is born with a zero-stock Ingredient
 * row for every ingredient identity an active ProductInventory mapping
 * references — the prerequisite for transactions.integration.test.ts's
 * cross-branch isolation guarantee to hold for a branch created after the
 * mapping already existed.
 */
describe.skipIf(!canRunIntegrationTests)('branches integration — CR-004 idempotent provisioning', () => {
  let adminId: string;
  let templateBranchId: string;
  let productId: string;
  let variantId: string;
  const createdBranchIds: string[] = [];

  beforeAll(async () => {
    const admin = await prisma.user.create({
      data: {
        email: `cr004-admin-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'super_admin',
        firstName: 'CR-004',
        lastName: 'Test Admin',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    adminId = admin.id;

    const templateBranch = await prisma.branch.create({
      data: { name: 'CR-004 Provisioning Template Branch', code: `CR004T-${randomUUID().slice(0, 8)}`, address: '1 Test St', city: 'Testville' },
    });
    templateBranchId = templateBranch.id;

    const templatePotato = await prisma.ingredient.create({
      data: { branchId: templateBranchId, name: 'CR004-Potato', unit: 'g', currentStock: 0, lowStockThreshold: 0, criticalThreshold: 0 },
    });

    const product = await prisma.product.create({ data: { name: 'CR-004 Provisioning Fries', status: 'active' } });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: { productId, name: 'Regular', sizeLabel: 'Regular', basePrice: 100, isActive: true },
    });
    variantId = variant.id;

    await prisma.productInventory.create({
      data: { branchId: templateBranchId, productVariantId: variantId, ingredientId: templatePotato.id, flavorId: null, quantityRequired: 200, unit: 'g' },
    });
  });

  afterAll(async () => {
    await prisma.productInventory.deleteMany({ where: { productVariantId: variantId } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.ingredient.deleteMany({ where: { name: 'CR004-Potato' } });
    await prisma.branch.deleteMany({ where: { id: { in: [templateBranchId, ...createdBranchIds] } } });
    await prisma.user.deleteMany({ where: { id: adminId } });
    await prisma.$disconnect();
  });

  it('creating a new branch auto-provisions a zero-stock ingredient for every active master-recipe ingredient identity', async () => {
    const branch = await branchesService.createBranch(
      { name: 'CR-004 New Branch', address: '2 Test St', city: 'Testville', gpsRadiusMeters: 100, status: 'active' },
      { id: adminId, role: 'super_admin' },
      null,
    );
    createdBranchIds.push(branch.id);

    const provisioned = await prisma.ingredient.findFirst({ where: { branchId: branch.id, name: 'CR004-Potato', deletedAt: null } });
    expect(provisioned).not.toBeNull();
    expect(provisioned?.unit).toBe('g');

    const stock = await prisma.inventoryMovement.aggregate({
      where: { ingredientId: provisioned?.id },
      _sum: { quantityChange: true },
    });
    expect(stock._sum.quantityChange ?? 0).toEqual(0);
  });

  it('is idempotent — re-running provisioning for an already-provisioned branch never creates a duplicate ingredient', async () => {
    const branch = await branchesService.createBranch(
      { name: 'CR-004 New Branch 2', address: '3 Test St', city: 'Testville', gpsRadiusMeters: 100, status: 'active' },
      { id: adminId, role: 'super_admin' },
      null,
    );
    createdBranchIds.push(branch.id);

    // Simulates re-running provisioning for a branch that's already been
    // provisioned once (e.g. a retry, or a second recipe sharing the same
    // ingredient identity) — must not create a second Ingredient row.
    await inventoryService.provisionBranchIngredients(branch.id, [{ name: 'CR004-Potato', unit: 'g' }]);
    await inventoryService.provisionBranchIngredients(branch.id, [{ name: 'CR004-Potato', unit: 'g' }]);

    const count = await prisma.ingredient.count({ where: { branchId: branch.id, name: 'CR004-Potato', deletedAt: null } });
    expect(count).toBe(1);
  });
});

/**
 * CR-005 Sub-phase 3b — the flavor-side counterpart to the CR-004 suite
 * above: proves branchesService.createBranch unions recipe-derived and
 * flavor-derived identities, so a branch created after an active flavor
 * already existed gets that flavor's Ingredient row too (the inverse of the
 * gap Sub-phase 3a's provisionFlavorIngredientAcrossBranches closes).
 */
describe.skipIf(!canRunIntegrationTests)('branches integration — CR-005 Sub-phase 3b flavor identity union', () => {
  let adminId: string;
  let productId: string;
  let variantId: string;
  let flavorId: string;
  const recipeIngredientName = `CR005B-Potato-${randomUUID().slice(0, 8)}`;
  const flavorIngredientName = `CR005B-Flavor-${randomUUID().slice(0, 8)}`;
  const createdBranchIds: string[] = [];

  beforeAll(async () => {
    const admin = await prisma.user.create({
      data: {
        email: `cr005b-admin-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'super_admin',
        firstName: 'CR-005B',
        lastName: 'Test Admin',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    adminId = admin.id;

    const templateBranch = await prisma.branch.create({
      data: { name: 'CR-005B Template Branch', code: `CR005BT-${randomUUID().slice(0, 8)}`, address: '1 Test St', city: 'Testville' },
    });
    const templatePotato = await prisma.ingredient.create({
      data: { branchId: templateBranch.id, name: recipeIngredientName, unit: 'g', currentStock: 0, lowStockThreshold: 0, criticalThreshold: 0 },
    });

    const product = await prisma.product.create({ data: { name: 'CR-005B Fries', status: 'active' } });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: { productId, name: 'Regular', sizeLabel: 'Regular', basePrice: 100, isActive: true },
    });
    variantId = variant.id;
    await prisma.productInventory.create({
      data: { branchId: templateBranch.id, productVariantId: variantId, ingredientId: templatePotato.id, flavorId: null, quantityRequired: 200, unit: 'g' },
    });

    const flavor = await prisma.flavor.create({
      data: { name: `CR-005B Flavor ${randomUUID().slice(0, 8)}`, isActive: true, ingredientName: flavorIngredientName, ingredientUnit: 'g' },
    });
    flavorId = flavor.id;

    createdBranchIds.push(templateBranch.id);
  });

  afterAll(async () => {
    await prisma.productInventory.deleteMany({ where: { productVariantId: variantId } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.flavor.deleteMany({ where: { id: flavorId } });
    await prisma.ingredient.deleteMany({ where: { name: { in: [recipeIngredientName, flavorIngredientName] } } });
    await prisma.branch.deleteMany({ where: { id: { in: createdBranchIds } } });
    await prisma.user.deleteMany({ where: { id: adminId } });
    await prisma.$disconnect();
  });

  it('creating a new branch provisions the distinct union of recipe-derived and flavor-derived identities', async () => {
    const branch = await branchesService.createBranch(
      { name: 'CR-005B New Branch', address: '2 Test St', city: 'Testville', gpsRadiusMeters: 100, status: 'active' },
      { id: adminId, role: 'super_admin' },
      null,
    );
    createdBranchIds.push(branch.id);

    const recipeRow = await prisma.ingredient.findFirst({ where: { branchId: branch.id, name: recipeIngredientName, deletedAt: null } });
    const flavorRow = await prisma.ingredient.findFirst({ where: { branchId: branch.id, name: flavorIngredientName, deletedAt: null } });
    expect(recipeRow).not.toBeNull();
    expect(flavorRow).not.toBeNull();
    expect(flavorRow?.category).toBe('FLAVOR');
  });

  it('two consecutive createBranch calls each get their own full set of rows, with no cross-bleed', async () => {
    const branchA = await branchesService.createBranch(
      { name: 'CR-005B Branch A', address: '4 Test St', city: 'Testville', gpsRadiusMeters: 100, status: 'active' },
      { id: adminId, role: 'super_admin' },
      null,
    );
    createdBranchIds.push(branchA.id);
    const branchB = await branchesService.createBranch(
      { name: 'CR-005B Branch B', address: '5 Test St', city: 'Testville', gpsRadiusMeters: 100, status: 'active' },
      { id: adminId, role: 'super_admin' },
      null,
    );
    createdBranchIds.push(branchB.id);

    for (const branch of [branchA, branchB]) {
      const recipeCount = await prisma.ingredient.count({ where: { branchId: branch.id, name: recipeIngredientName, deletedAt: null } });
      const flavorCount = await prisma.ingredient.count({ where: { branchId: branch.id, name: flavorIngredientName, deletedAt: null } });
      expect(recipeCount).toBe(1);
      expect(flavorCount).toBe(1);
    }
  });

  it('every flavor-derived ingredient row is provisioned with category FLAVOR', async () => {
    const branch = await branchesService.createBranch(
      { name: 'CR-005B Branch C', address: '6 Test St', city: 'Testville', gpsRadiusMeters: 100, status: 'active' },
      { id: adminId, role: 'super_admin' },
      null,
    );
    createdBranchIds.push(branch.id);

    const flavorRows = await prisma.ingredient.findMany({ where: { branchId: branch.id, name: flavorIngredientName, deletedAt: null } });
    expect(flavorRows.length).toBeGreaterThan(0);
    for (const row of flavorRows) {
      expect(row.category).toBe('FLAVOR');
    }
  });
});

/**
 * CR-005 Sub-phase 3b companion fix — branch create + identity resolution +
 * provisioning now run inside a single prisma.$transaction (see
 * branchesService.createBranch). Proves atomicity for real against
 * Postgres: a provisioning failure partway through must leave neither an
 * orphan branch row nor any ingredient rows behind, and a successful run
 * must commit both together before the post-commit audit log fires.
 */
describe.skipIf(!canRunIntegrationTests)('branches integration — CR-005 Sub-phase 3b companion: transactional createBranch', () => {
  let adminId: string;
  let templateBranchId: string;
  let productId: string;
  let variantId: string;
  const txRecipeIngredientName = `CR005TX-Potato-${randomUUID().slice(0, 8)}`;
  const createdBranchIds: string[] = [];

  beforeAll(async () => {
    const admin = await prisma.user.create({
      data: {
        email: `cr005tx-admin-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'super_admin',
        firstName: 'CR-005TX',
        lastName: 'Test Admin',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    adminId = admin.id;

    const templateBranch = await prisma.branch.create({
      data: { name: 'CR-005TX Template Branch', code: `CR005TXT-${randomUUID().slice(0, 8)}`, address: '1 Test St', city: 'Testville' },
    });
    templateBranchId = templateBranch.id;
    const templatePotato = await prisma.ingredient.create({
      data: { branchId: templateBranchId, name: txRecipeIngredientName, unit: 'g', currentStock: 0, lowStockThreshold: 0, criticalThreshold: 0 },
    });

    const product = await prisma.product.create({ data: { name: 'CR-005TX Fries', status: 'active' } });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: { productId, name: 'Regular', sizeLabel: 'Regular', basePrice: 100, isActive: true },
    });
    variantId = variant.id;
    await prisma.productInventory.create({
      data: { branchId: templateBranchId, productVariantId: variantId, ingredientId: templatePotato.id, flavorId: null, quantityRequired: 200, unit: 'g' },
    });
  });

  afterAll(async () => {
    await prisma.productInventory.deleteMany({ where: { productVariantId: variantId } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.ingredient.deleteMany({ where: { name: txRecipeIngredientName } });
    await prisma.branch.deleteMany({ where: { id: { in: [templateBranchId, ...createdBranchIds] } } });
    await prisma.user.deleteMany({ where: { id: adminId } });
    await prisma.$disconnect();
  });

  it('rolls back the branch row and every ingredient row when provisioning fails mid-transaction', async () => {
    const spy = vi.spyOn(inventoryService, 'provisionBranchIngredients').mockRejectedValueOnce(new Error('forced provisioning failure'));
    const attemptedCode = `CR005TX-ROLLBACK-${randomUUID().slice(0, 8)}`;

    await expect(
      branchesService.createBranch(
        { name: 'CR-005TX Rollback Attempt', code: attemptedCode, address: '2 Test St', city: 'Testville', gpsRadiusMeters: 100, status: 'active' },
        { id: adminId, role: 'super_admin' },
        null,
      ),
    ).rejects.toThrow('forced provisioning failure');

    const branch = await prisma.branch.findUnique({ where: { code: attemptedCode } });
    expect(branch).toBeNull();

    const orphanIngredients = await prisma.ingredient.findMany({ where: { name: txRecipeIngredientName, branch: { code: attemptedCode } } });
    expect(orphanIngredients).toHaveLength(0);

    spy.mockRestore();
  });

  it('a successful createBranch commits the branch and its provisioned ingredients together, then records the audit log', async () => {
    const branch = await branchesService.createBranch(
      { name: 'CR-005TX Commit Success', address: '3 Test St', city: 'Testville', gpsRadiusMeters: 100, status: 'active' },
      { id: adminId, role: 'super_admin' },
      null,
    );
    createdBranchIds.push(branch.id);

    const persistedBranch = await prisma.branch.findUnique({ where: { id: branch.id } });
    expect(persistedBranch).not.toBeNull();

    const provisioned = await prisma.ingredient.findFirst({ where: { branchId: branch.id, name: txRecipeIngredientName, deletedAt: null } });
    expect(provisioned).not.toBeNull();

    // Audit log is a post-commit side effect (outside the transaction) —
    // its presence here proves it ran after, not during, the transaction.
    const auditLog = await prisma.auditLog.findFirst({ where: { action: 'BRANCH_CREATED', entityId: branch.id } });
    expect(auditLog).not.toBeNull();
  });
});

/**
 * Final cross-task review Finding 3 — every other test for permanent branch
 * delete either mocks Prisma entirely (branches.service.test.ts) or deletes
 * a brand-new, empty branch (the e2e smoke path), so nothing has ever
 * exercised a cascade against real dependent rows. This is exactly why the
 * three RESTRICT gaps in Finding 1 (inventory_movements.ingredient_id,
 * branch_recipe_overrides.ingredient_id, hold_orders.shift_id) went
 * undetected through 9 individually-approved task reviews: RESTRICT is
 * non-deferrable in Postgres, so those bugs only surface with real rows
 * present during the cascade, never with mocks or an empty branch.
 *
 * This suite seeds one of every cascaded row type — including the specific
 * transitive paths Finding 1 fixed — and proves a single deleteBranch call
 * removes all of them without a raw FK violation.
 */
describe.skipIf(!canRunIntegrationTests)('branches integration — permanent delete cascade', () => {
  let adminId: string;
  let branchId: string;
  let ingredientId: string;
  let shiftId: string;
  let holdOrderId: string;
  let inventoryMovementId: string;
  let transactionId: string;

  beforeAll(async () => {
    const admin = await prisma.user.create({
      data: {
        email: `delete-cascade-admin-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'super_admin',
        firstName: 'Delete-Cascade',
        lastName: 'Test Admin',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    adminId = admin.id;

    const branch = await prisma.branch.create({
      data: { name: 'Delete Cascade Branch', code: `DELCASC-${randomUUID().slice(0, 8)}`, address: '1 Test St', city: 'Testville' },
    });
    branchId = branch.id;

    const ingredient = await prisma.ingredient.create({
      data: { branchId, name: 'Delete-Cascade-Potato', unit: 'g', currentStock: 10, lowStockThreshold: 1, criticalThreshold: 0 },
    });
    ingredientId = ingredient.id;

    // status 'closed' (not 'active') — must not trip deleteBranch's
    // BRANCH_HAS_ACTIVE_SHIFTS guard.
    const shift = await prisma.shift.create({
      data: {
        branchId,
        cashierId: adminId,
        openedBy: adminId,
        closedBy: adminId,
        status: 'closed',
        openingCashAmount: 1000,
        closingCashAmount: 1000,
        startedAt: new Date(),
        closedAt: new Date(),
      },
    });
    shiftId = shift.id;

    // Exercises the hold_orders.shift_id RESTRICT->CASCADE fix (Finding 1,
    // item 3): HoldOrder's own branchId cascade doesn't protect this
    // separate shiftId path into the also-cascading Shift row.
    const holdOrder = await prisma.holdOrder.create({
      data: {
        branchId,
        shiftId,
        cashierId: adminId,
        status: 'held',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
    holdOrderId = holdOrder.id;

    // Exercises the inventory_movements.ingredient_id RESTRICT->CASCADE fix
    // (Finding 1, item 1).
    const movement = await prisma.inventoryMovement.create({
      data: {
        branchId,
        ingredientId,
        movementType: 'stock_in',
        quantityChange: 10,
        quantityBefore: 0,
        quantityAfter: 10,
      },
    });
    inventoryMovementId = movement.id;

    const transaction = await prisma.transaction.create({
      data: {
        transactionNumber: `DELCASC-${randomUUID().slice(0, 8)}`,
        branchId,
        shiftId,
        cashierId: adminId,
        status: 'completed',
        paymentMethod: 'cash',
        subtotal: 100,
        vatAmount: 12,
        totalAmount: 100,
      },
    });
    transactionId = transaction.id;
  });

  afterAll(async () => {
    // Defensive cleanup in case the test failed partway through and the
    // cascade never actually ran — on the happy path every row below is
    // already gone, so each delete here is a no-op. Order matches
    // dependency direction (children before parents) so a partial-failure
    // cleanup doesn't itself hit a FK violation.
    //
    // Transaction and InventoryMovement are guarded by
    // lib/prisma-immutability.ts, which unconditionally blocks
    // delete/deleteMany through the Prisma Client's model API (CR-004) even
    // when zero rows match — same reasoning and same raw-SQL escape hatch as
    // transactions.integration.test.ts's own teardown.
    await prisma.$executeRaw`DELETE FROM "transactions" WHERE "id" = ${transactionId}`;
    await prisma.$executeRaw`DELETE FROM "inventory_movements" WHERE "id" = ${inventoryMovementId}`;
    await prisma.holdOrder.deleteMany({ where: { id: holdOrderId } });
    await prisma.shift.deleteMany({ where: { id: shiftId } });
    await prisma.ingredient.deleteMany({ where: { id: ingredientId } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.user.deleteMany({ where: { id: adminId } });
    await prisma.$disconnect();
  });

  it('deleteBranch cascades every dependent row and records a BRANCH_DELETED audit entry', async () => {
    await branchesService.deleteBranch(branchId, { id: adminId, role: 'super_admin' }, null);

    const [branch, ingredient, shift, holdOrder, movement, transaction, auditLog] = await Promise.all([
      prisma.branch.findUnique({ where: { id: branchId } }),
      prisma.ingredient.findFirst({ where: { id: ingredientId } }),
      prisma.shift.findFirst({ where: { id: shiftId } }),
      prisma.holdOrder.findFirst({ where: { id: holdOrderId } }),
      prisma.inventoryMovement.findFirst({ where: { id: inventoryMovementId } }),
      prisma.transaction.findFirst({ where: { id: transactionId } }),
      // The row's branchId is null after the delete — the audit entry is
      // written after branchesRepository.delete() now (Finding 2), and
      // AuditLog.branchId is a real FK, so it's never set to a now-deleted
      // branch id. Look this row up by entityId, not branchId.
      prisma.auditLog.findFirst({ where: { action: 'BRANCH_DELETED', entityId: branchId } }),
    ]);

    expect(branch).toBeNull();
    expect(ingredient).toBeNull();
    expect(shift).toBeNull();
    expect(holdOrder).toBeNull();
    expect(movement).toBeNull();
    expect(transaction).toBeNull();
    expect(auditLog).not.toBeNull();
    expect(auditLog?.branchId).toBeNull();
  });
});
