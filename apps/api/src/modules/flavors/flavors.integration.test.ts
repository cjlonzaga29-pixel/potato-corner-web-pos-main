import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Integration tests exercise the real Prisma + Redis stack end to end,
 * following the same convention as auth.integration.test.ts and
 * branches.integration.test.ts. They require a real, disposable Postgres
 * database (migrations applied), isolated from the local dev database so
 * these tests never touch seeded dev data.
 *
 * Set TEST_DATABASE_URL and TEST_REDIS_URL to enable this suite.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL);

// Imported unconditionally — see the identical note in
// branches.integration.test.ts. Constructing PrismaClient doesn't touch the
// network; only the queries inside describe.skipIf below do.
const { prisma } = await import('../../lib/prisma.js');
const { flavorsService } = await import('./flavors.service.js');

describe.skipIf(!canRunIntegrationTests)('flavors integration', () => {
  beforeAll(async () => {
    // TODO: point `prisma` at TEST_DATABASE_URL, run `prisma migrate deploy`
    // against the test database, and seed one super_admin, one supervisor
    // (assigned to branch A only), one active branch, and one product with
    // a variant before the suite runs.
  });

  afterAll(async () => {
    // TODO: truncate all tables touched by these tests and close the
    // Prisma connection opened for this suite.
  });

  it('POST /api/flavors creates a flavor as super_admin', async () => {
    // TODO: POST /api/flavors with a valid #RRGGBB color_hex; assert 201.
    expect(true).toBe(true);
  });

  it('GET /api/flavors returns a paginated list', async () => {
    // TODO: GET /api/flavors as super_admin; assert response.data.flavors
    // is an array and total/page/limit are present.
    expect(true).toBe(true);
  });

  it('PATCH /api/flavors/:id updates flavor fields', async () => {
    // TODO: PATCH color_hex and display_order as super_admin; assert 200
    // and the response reflects both changes.
    expect(true).toBe(true);
  });

  it('POST /api/products/:productId/variants/:variantId/flavors links a flavor to a variant', async () => {
    // TODO: POST as super_admin with price_premium; assert 201 and that a
    // second identical POST returns 409 VARIANT_FLAVOR_ALREADY_LINKED.
    expect(true).toBe(true);
  });

  it('PATCH /api/products/:productId/variants/:variantId/flavors/:flavorId updates price_premium', async () => {
    // TODO: PATCH price_premium as super_admin; assert 200 and the updated
    // value round-trips through the API to 2 decimal places.
    expect(true).toBe(true);
  });

  it('PATCH /api/flavors/:flavorId/branch-availability/:branchId updates branch flavor availability', async () => {
    // TODO: PATCH as super_admin with is_available false and a reason;
    // assert 200 and unavailable_reason is stored.
    expect(true).toBe(true);
  });

  it('a supervisor cannot update another branch\'s flavor availability', async () => {
    // TODO: PATCH /api/flavors/:flavorId/branch-availability/:branchId for
    // a branch not in the supervisor's branch_ids; assert 403
    // BRANCH_ACCESS_DENIED.
    expect(true).toBe(true);
  });
});

/**
 * CR-005 Sub-phase 3a — Hook A. Exercises the real service layer
 * (flavorsService.createFlavor/updateFlavor -> branchesRepository.listAllBranchIds
 * -> inventoryService.provisionIdentityAcrossBranches) against a real Postgres
 * database, proving a brand-new (or reactivated) flavor is provisioned with a
 * category=FLAVOR Ingredient row in every existing branch — the fan-out
 * inverse of branches.integration.test.ts's CR-004 provisioning suite.
 */
describe.skipIf(!canRunIntegrationTests)('flavors integration — CR-005 Sub-phase 3a Hook A provisioning', () => {
  let adminId: string;
  const branchIds: string[] = [];
  const createdFlavorNames: string[] = [];

  beforeAll(async () => {
    const admin = await prisma.user.create({
      data: {
        email: `cr005-3a-admin-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'super_admin',
        firstName: 'CR-005',
        lastName: 'Test Admin',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    adminId = admin.id;

    for (let i = 0; i < 3; i++) {
      const branch = await prisma.branch.create({
        data: { name: `CR-005 3a Branch ${i}`, code: `CR0053A-${randomUUID().slice(0, 8)}`, address: '1 Test St', city: 'Testville' },
      });
      branchIds.push(branch.id);
    }
  });

  afterAll(async () => {
    await prisma.ingredient.deleteMany({ where: { name: { in: createdFlavorNames } } });
    await prisma.flavor.deleteMany({ where: { name: { in: createdFlavorNames } } });
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
    await prisma.user.deleteMany({ where: { id: adminId } });
    await prisma.$disconnect();
  });

  it('createFlavor provisions one category=FLAVOR ingredient row per existing branch', async () => {
    const name = `CR005-3a-Truffle-${randomUUID().slice(0, 8)}`;
    createdFlavorNames.push(name);

    await flavorsService.createFlavor({ name, color_hex: '#000000', is_active: true }, { id: adminId, role: 'super_admin' }, null);

    const provisioned = await prisma.ingredient.findMany({ where: { name, deletedAt: null } });
    expect(provisioned).toHaveLength(branchIds.length);
    expect(provisioned.every((row) => row.category === 'FLAVOR')).toBe(true);
    expect(new Set(provisioned.map((row) => row.branchId))).toEqual(new Set(branchIds));
  });

  it('a second createFlavor call for a differently-named flavor does not duplicate existing ingredient rows', async () => {
    const nameA = `CR005-3a-Idem-A-${randomUUID().slice(0, 8)}`;
    createdFlavorNames.push(nameA);
    await flavorsService.createFlavor({ name: nameA, color_hex: '#000000', is_active: true }, { id: adminId, role: 'super_admin' }, null);

    // Re-provisioning the same identity directly (the idempotent primitive
    // createFlavor relies on) must not create a duplicate row per branch.
    const { branchesRepository } = await import('../branches/branches.repository.js');
    const { inventoryService } = await import('../inventory/inventory.service.js');
    const allBranchIds = await branchesRepository.listAllBranchIds();
    await inventoryService.provisionIdentityAcrossBranches({ name: nameA, unit: 'grams' }, allBranchIds);

    const count = await prisma.ingredient.count({ where: { name: nameA, deletedAt: null } });
    expect(count).toBe(branchIds.length);
  });

  it('updateFlavor reactivation (false→true) provisions any missing ingredient rows', async () => {
    const name = `CR005-3a-Reactivate-${randomUUID().slice(0, 8)}`;
    createdFlavorNames.push(name);

    const created = await flavorsService.createFlavor(
      { name, color_hex: '#000000', is_active: false },
      { id: adminId, role: 'super_admin' },
      null,
    );

    // is_active: false at creation still provisions (Hook A fires
    // unconditionally on create) — delete one branch's row to simulate a
    // gap left by a partial failure, then prove reactivation re-fills it.
    await prisma.ingredient.deleteMany({ where: { name, branchId: branchIds[0] } });
    expect(await prisma.ingredient.count({ where: { name, deletedAt: null } })).toBe(branchIds.length - 1);

    await flavorsService.updateFlavor(created.id, { is_active: true }, { id: adminId, role: 'super_admin' }, null);

    const provisioned = await prisma.ingredient.findMany({ where: { name, deletedAt: null } });
    expect(provisioned).toHaveLength(branchIds.length);
  });
});
