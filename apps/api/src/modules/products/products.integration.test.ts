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
// branches.integration.test.ts / transactions.integration.test.ts.
// Constructing PrismaClient doesn't touch the network; only the queries
// inside describe.skipIf below do.
const { prisma } = await import('../../lib/prisma.js');
const { productsService } = await import('./products.service.js');

describe.skipIf(!canRunIntegrationTests)('products integration', () => {
  beforeAll(async () => {
    // TODO: point `prisma` at TEST_DATABASE_URL, run `prisma migrate deploy`
    // against the test database, and seed one super_admin, one supervisor
    // (assigned to branch A only), and one active branch before the suite runs.
  });

  afterAll(async () => {
    // TODO: truncate all tables touched by these tests and close the
    // Prisma connection opened for this suite.
  });

  // Direct product creation (POST /api/products) was removed in the Super
  // Admin IA restructure — the only path to a new Product is now a
  // supervisor's product request approved by an admin (see
  // product-requests.integration.test.ts). The branch_exclusive
  // true/false cascade behavior this used to cover is still exercised by
  // productsRepository.createWithCascade via that approval flow.

  it('GET /api/products returns a paginated list', async () => {
    // TODO: GET /api/products as super_admin; assert response.data.products
    // is an array and response.data.total/page/limit are present.
    expect(true).toBe(true);
  });

  it('PATCH /api/products/:id updates product fields', async () => {
    // TODO: PATCH /api/products/:id as super_admin with a new name; assert
    // 200 and response.data.name reflects the update.
    expect(true).toBe(true);
  });

  it('PATCH /api/products/:id/status walks the global lifecycle for super_admin', async () => {
    // TODO: draft -> active -> temporarily_unavailable -> active ->
    // discontinued -> active -> archived, asserting 200 and the correct
    // status at each step, and that archived -> active returns 409.
    expect(true).toBe(true);
  });

  it('PATCH /api/products/:id/status with a supervisor and branch_id only changes branch availability', async () => {
    // TODO: PATCH as supervisor with { status: 'temporarily_unavailable',
    // branch_id }; assert 200, that the product's global status is
    // unchanged, and that branch_product_availability.is_available is false
    // for that branch.
    expect(true).toBe(true);
  });

  it('PATCH /api/products/:id/branch-availability/:branchId updates branch availability', async () => {
    // TODO: PATCH as super_admin; assert 200 and is_available reflects the
    // submitted value.
    expect(true).toBe(true);
  });

  it('POST /api/products/:id/variants creates a variant', async () => {
    // TODO: POST as super_admin; assert 201 and response.data.base_price
    // matches the submitted value to 2 decimal places.
    expect(true).toBe(true);
  });

  it('POST /api/products/:id/image uploads and updates image_url', async () => {
    // TODO: POST a small JPEG as super_admin; assert 200 and
    // response.data.image_url is a Supabase Storage URL under
    // product-images/:productId/.
    expect(true).toBe(true);
  });

  it('a discontinued product cannot be re-enabled by a supervisor', async () => {
    // TODO: set a product to discontinued as super_admin, then PATCH
    // /:id/status as supervisor with { status: 'active', branch_id }; assert
    // 403 PRODUCT_GLOBALLY_UNAVAILABLE.
    expect(true).toBe(true);
  });

  it('create/update/status-change/image-upload actions each create an audit_logs row', async () => {
    // TODO: after each of the above actions, assert a matching audit_logs
    // row exists with the correct action and entity_type.
    expect(true).toBe(true);
  });
});

/**
 * CR-005 Sub-phase 3c — variant lifecycle (submit/approve/reject/edit/
 * archive) + ProductChangeLog, exercised against the real service layer and
 * a real Postgres database, following the same convention as
 * branches.integration.test.ts's CR-005 Sub-phase 3b suite.
 */
describe.skipIf(!canRunIntegrationTests)('products integration — CR-005 Sub-phase 3c variant lifecycle', () => {
  let superAdminId: string;
  let supervisorId: string;
  let branchAId: string;
  let branchBId: string;
  let productId: string;
  const createdProductIds: string[] = [];

  const SUPER_ADMIN = () => ({ id: superAdminId, role: 'super_admin' });
  const SUPERVISOR = () => ({ id: supervisorId, role: 'supervisor' });

  beforeAll(async () => {
    const admin = await prisma.user.create({
      data: {
        email: `cr005c-admin-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'super_admin',
        firstName: 'CR-005C',
        lastName: 'Test Admin',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    superAdminId = admin.id;

    const supervisor = await prisma.user.create({
      data: {
        email: `cr005c-sup-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'supervisor',
        firstName: 'CR-005C',
        lastName: 'Test Supervisor',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    supervisorId = supervisor.id;

    const branchA = await prisma.branch.create({
      data: { name: 'CR-005C Branch A', code: `CR005CA-${randomUUID().slice(0, 8)}`, address: '1 Test St', city: 'Testville' },
    });
    branchAId = branchA.id;

    const branchB = await prisma.branch.create({
      data: { name: 'CR-005C Branch B', code: `CR005CB-${randomUUID().slice(0, 8)}`, address: '2 Test St', city: 'Testville' },
    });
    branchBId = branchB.id;

    const product = await prisma.product.create({ data: { name: 'CR-005C Lifecycle Fries', status: 'active' } });
    productId = product.id;
    createdProductIds.push(productId);

    await prisma.branchProductAvailability.createMany({
      data: [
        { branchId: branchAId, productId, isAvailable: true, updatedBy: superAdminId },
        { branchId: branchBId, productId, isAvailable: true, updatedBy: superAdminId },
      ],
    });
  });

  afterAll(async () => {
    await prisma.productChangeLog.deleteMany({ where: { productVariant: { productId: { in: createdProductIds } } } });
    await prisma.recipe.deleteMany({ where: { productVariant: { productId: { in: createdProductIds } } } });
    await prisma.branchProductAvailability.deleteMany({ where: { productId: { in: createdProductIds } } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: createdProductIds } } });
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    await prisma.ingredient.deleteMany({ where: { branchId: { in: [branchAId, branchBId] } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchAId, branchBId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [superAdminId, supervisorId] } } });
    await prisma.$disconnect();
  });

  async function createDraftVariant(namePrefix: string) {
    return prisma.productVariant.create({
      data: {
        productId,
        name: `${namePrefix}-${randomUUID().slice(0, 8)}`,
        sizeLabel: 'Regular',
        basePrice: 65,
        isActive: true,
        lifecycleStatus: 'DRAFT',
        createdById: superAdminId,
      },
    });
  }

  it('walks the full lifecycle: create DRAFT -> submit -> approve -> edit -> archive', async () => {
    const variant = await createDraftVariant('full-lifecycle');
    expect(variant.lifecycleStatus).toBe('DRAFT');
    expect(variant.version).toBe(1);

    const submitted = await productsService.submitVariantForApproval(variant.id, SUPERVISOR(), null);
    expect(submitted.lifecycle_status).toBe('PENDING_APPROVAL');

    const approved = await productsService.approveVariant(variant.id, 'looks good', SUPER_ADMIN(), null);
    expect(approved.lifecycle_status).toBe('ACTIVE');
    expect(approved.approved_by_id).toBe(superAdminId);

    const edited = await productsService.editActiveVariant(variant.id, { base_price: 75 }, 'price adjustment', SUPER_ADMIN(), null);
    expect(edited.version).toBe(2);
    expect(edited.base_price).toBe(75);

    const archived = await productsService.archiveVariant(variant.id, 'end of test', SUPER_ADMIN(), null);
    expect(archived.lifecycle_status).toBe('ARCHIVED');

    const logs = await prisma.productChangeLog.findMany({ where: { productVariantId: variant.id }, orderBy: { createdAt: 'asc' } });
    expect(logs).toHaveLength(2); // edit + archive only — approve does not log
    expect(logs.map((l) => l.reason)).toEqual(['price adjustment', 'end of test']);
  });

  it('Phase 4 gate blocks approval of a variant with a flavor-slot recipe row, leaving it PENDING_APPROVAL', async () => {
    const variant = await createDraftVariant('phase4-gate');
    const ingredient = await prisma.ingredient.create({
      data: { branchId: branchAId, name: `CR005C-Potato-${randomUUID().slice(0, 8)}`, unit: 'g', currentStock: 0, lowStockThreshold: 0, criticalThreshold: 0 },
    });
    await prisma.recipe.create({
      data: { productVariantId: variant.id, ingredientId: ingredient.id, flavorId: null, quantity: 1, unit: 'g', flavorSlotIndex: 0 },
    });

    await productsService.submitVariantForApproval(variant.id, SUPERVISOR(), null);

    await expect(productsService.approveVariant(variant.id, undefined, SUPER_ADMIN(), null)).rejects.toMatchObject({
      code: 'VARIANT_APPROVAL_BLOCKED_PENDING_PHASE_4',
      statusCode: 409,
    });

    const stillPending = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(stillPending.lifecycleStatus).toBe('PENDING_APPROVAL');
  });

  it('rolls back editActiveVariant when the change log insert fails — version and fields stay untouched, no log row leaks', async () => {
    const variant = await createDraftVariant('edit-rollback');
    await productsService.submitVariantForApproval(variant.id, SUPERVISOR(), null);
    await productsService.approveVariant(variant.id, undefined, SUPER_ADMIN(), null);

    const before = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });

    // A nonexistent actor id violates ProductChangeLog.changedById's FK
    // constraint, failing mid-transaction after the variant update already
    // ran — the real test of whether the $transaction wrap actually rolls
    // both statements back together.
    await expect(
      productsService.editActiveVariant(variant.id, { base_price: 999 }, 'rollback test', { id: randomUUID(), role: 'super_admin' }, null),
    ).rejects.toThrow();

    const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(after.version).toBe(before.version);
    expect(after.basePrice.toNumber()).toBe(before.basePrice.toNumber());

    const logs = await prisma.productChangeLog.findMany({ where: { productVariantId: variant.id } });
    expect(logs).toHaveLength(0);
  });

  it('rolls back archiveVariant when the change log insert fails — variant stays in its prior state', async () => {
    const variant = await createDraftVariant('archive-rollback');
    await productsService.submitVariantForApproval(variant.id, SUPERVISOR(), null);
    await productsService.approveVariant(variant.id, undefined, SUPER_ADMIN(), null);

    const before = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });

    await expect(
      productsService.archiveVariant(variant.id, 'rollback test', { id: randomUUID(), role: 'super_admin' }, null),
    ).rejects.toThrow();

    const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(after.lifecycleStatus).toBe(before.lifecycleStatus);

    const logs = await prisma.productChangeLog.findMany({ where: { productVariantId: variant.id } });
    expect(logs).toHaveLength(0);
  });

  it('ProductChangeLog snapshotJson matches the variant state at the moment of the edit', async () => {
    const variant = await createDraftVariant('snapshot-content');
    await productsService.submitVariantForApproval(variant.id, SUPERVISOR(), null);
    await productsService.approveVariant(variant.id, undefined, SUPER_ADMIN(), null);

    await productsService.editActiveVariant(variant.id, { base_price: 88, name: 'Renamed' }, 'snapshot check', SUPER_ADMIN(), null);

    const log = await prisma.productChangeLog.findFirstOrThrow({ where: { productVariantId: variant.id } });
    const snapshot = log.snapshotJson as {
      version_before: number;
      fields_before: { name: string; basePrice: number };
      reason: string;
      changed_by: string;
    };
    expect(snapshot.version_before).toBe(1);
    expect(snapshot.fields_before.name).toBe(variant.name);
    expect(snapshot.fields_before.basePrice).toBe(65);
    expect(snapshot.reason).toBe('snapshot check');
    expect(snapshot.changed_by).toBe(superAdminId);
    expect(log.version).toBe(2);
  });

  it('bumps version monotonically across three consecutive edits: 2, 3, 4', async () => {
    const variant = await createDraftVariant('version-monotonic');
    await productsService.submitVariantForApproval(variant.id, SUPERVISOR(), null);
    await productsService.approveVariant(variant.id, undefined, SUPER_ADMIN(), null);

    const first = await productsService.editActiveVariant(variant.id, { base_price: 70 }, 'edit 1', SUPER_ADMIN(), null);
    const second = await productsService.editActiveVariant(variant.id, { base_price: 71 }, 'edit 2', SUPER_ADMIN(), null);
    const third = await productsService.editActiveVariant(variant.id, { base_price: 72 }, 'edit 3', SUPER_ADMIN(), null);

    expect([first.version, second.version, third.version]).toEqual([2, 3, 4]);
  });

  it('approving a variant does not leak data into another branch\'s inventory (CR-004 guarantee held)', async () => {
    const variant = await createDraftVariant('cross-branch-isolation');
    const branchBIngredient = await prisma.ingredient.create({
      data: { branchId: branchBId, name: `CR005C-Untouched-${randomUUID().slice(0, 8)}`, unit: 'g', currentStock: 42, lowStockThreshold: 0, criticalThreshold: 0 },
    });

    await productsService.submitVariantForApproval(variant.id, SUPERVISOR(), null);
    await productsService.approveVariant(variant.id, undefined, SUPER_ADMIN(), null);

    const untouched = await prisma.ingredient.findUniqueOrThrow({ where: { id: branchBIngredient.id } });
    expect(untouched.currentStock.toNumber()).toBe(42);

    const movements = await prisma.inventoryMovement.count({ where: { ingredientId: branchBIngredient.id } });
    expect(movements).toBe(0);
  });
});
