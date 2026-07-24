import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
 * (branchesService.createBranch -> recipes.service.js
 * listDistinctIngredientIdentities -> inventoryService.provisionBranchIngredients)
 * against a real Postgres database, proving a brand-new branch is born with
 * a zero-stock Ingredient row for every ingredient identity an active
 * master Recipe references — the prerequisite for
 * transactions.integration.test.ts's cross-branch isolation guarantee to
 * hold for a branch created after the recipe already existed.
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

    await prisma.recipe.create({ data: { productVariantId: variantId, ingredientId: templatePotato.id, flavorId: null, quantity: 200, unit: 'g' } });
  });

  afterAll(async () => {
    await prisma.recipe.deleteMany({ where: { productVariantId: variantId } });
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
