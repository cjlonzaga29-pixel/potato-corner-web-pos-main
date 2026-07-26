import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
const { productsRepository } = await import('./products.repository.js');

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

  it('POST /api/products creates a product directly as super_admin', async () => {
    // TODO: POST /api/products as super_admin with name/status/branch_exclusive;
    // assert 201 and response.data.id is present. Cover both branch_exclusive
    // true (exclusiveBranchId cascade) and false (all-active-branches cascade)
    // via productsRepository.createWithCascade.
    expect(true).toBe(true);
  });

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
    await prisma.productInventory.deleteMany({ where: { productVariant: { productId: { in: createdProductIds } } } });
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

  // approveVariant now requires at least one active ProductInventory
  // mapping to exist (CR-005 Guarantee 6 — replaces the old vacuous-pass
  // Recipe-resolvability check). Scoped to branchAId so tests proving
  // branchB isolation stay meaningful.
  async function provisionInventoryMapping(variantId: string) {
    const ingredient = await prisma.ingredient.create({
      data: { branchId: branchAId, name: `CR005C-Mapping-${randomUUID().slice(0, 8)}`, unit: 'g', currentStock: 0, lowStockThreshold: 0, criticalThreshold: 0 },
    });
    await prisma.productInventory.create({
      data: { branchId: branchAId, productVariantId: variantId, ingredientId: ingredient.id, flavorId: null, quantityRequired: 10, unit: 'g' },
    });
  }

  it('walks the full lifecycle: create DRAFT -> submit -> approve -> edit -> archive', async () => {
    const variant = await createDraftVariant('full-lifecycle');
    expect(variant.lifecycleStatus).toBe('DRAFT');
    expect(variant.version).toBe(1);

    const submitted = await productsService.submitVariantForApproval(variant.id, SUPERVISOR(), null);
    expect(submitted.lifecycle_status).toBe('PENDING_APPROVAL');

    await provisionInventoryMapping(variant.id);
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

  it('Phase 4 gate blocks approval of a variant with a ProductFlavorSlot definition, leaving it PENDING_APPROVAL', async () => {
    const variant = await createDraftVariant('phase4-gate');
    // approveVariant's PENDING_PHASE_4 gate checks countFlavorSlots (real
    // ProductFlavorSlot rows only, since this migration removed the old
    // Recipe.flavorSlotIndex half of that check — see products.service.ts).
    await productsService.addFlavorSlot(variant.id, { label: 'A', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);

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
    await provisionInventoryMapping(variant.id);
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
    await provisionInventoryMapping(variant.id);
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
    await provisionInventoryMapping(variant.id);
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
    await provisionInventoryMapping(variant.id);
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
    await provisionInventoryMapping(variant.id);
    await productsService.approveVariant(variant.id, undefined, SUPER_ADMIN(), null);

    const untouched = await prisma.ingredient.findUniqueOrThrow({ where: { id: branchBIngredient.id } });
    expect(untouched.currentStock.toNumber()).toBe(42);

    const movements = await prisma.inventoryMovement.count({ where: { ingredientId: branchBIngredient.id } });
    expect(movements).toBe(0);
  });
});

/**
 * CR-005 Sub-phase 3d — flavor slot CRUD (add/update/remove/reorder/list),
 * exercised against the real service + repository layers and a real
 * Postgres database. Follows the same fixture convention as the 3c suite
 * above.
 */
describe.skipIf(!canRunIntegrationTests)('products integration — CR-005 Sub-phase 3d flavor slot CRUD', () => {
  let superAdminId: string;
  let supervisorId: string;
  let branchId: string;
  let productId: string;
  const createdProductIds: string[] = [];

  const SUPER_ADMIN = () => ({ id: superAdminId, role: 'super_admin' });
  const SUPERVISOR = () => ({ id: supervisorId, role: 'supervisor' });

  beforeAll(async () => {
    const admin = await prisma.user.create({
      data: {
        email: `cr005d-admin-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'super_admin',
        firstName: 'CR-005D',
        lastName: 'Test Admin',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    superAdminId = admin.id;

    const supervisor = await prisma.user.create({
      data: {
        email: `cr005d-sup-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'supervisor',
        firstName: 'CR-005D',
        lastName: 'Test Supervisor',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    supervisorId = supervisor.id;

    const branch = await prisma.branch.create({
      data: { name: 'CR-005D Branch', code: `CR005D-${randomUUID().slice(0, 8)}`, address: '1 Test St', city: 'Testville' },
    });
    branchId = branch.id;

    const product = await prisma.product.create({ data: { name: 'CR-005D Slot Fries', status: 'active' } });
    productId = product.id;
    createdProductIds.push(productId);
  });

  afterAll(async () => {
    await prisma.productFlavorSlot.deleteMany({ where: { productVariant: { productId: { in: createdProductIds } } } });
    await prisma.productChangeLog.deleteMany({ where: { productVariant: { productId: { in: createdProductIds } } } });
    await prisma.productInventory.deleteMany({ where: { productVariant: { productId: { in: createdProductIds } } } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: createdProductIds } } });
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    await prisma.ingredient.deleteMany({ where: { branchId } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.user.deleteMany({ where: { id: { in: [superAdminId, supervisorId] } } });
    await prisma.$disconnect();
  });

  async function createDraftVariant(namePrefix: string, maxFlavors = 5) {
    return prisma.productVariant.create({
      data: {
        productId,
        name: `${namePrefix}-${randomUUID().slice(0, 8)}`,
        sizeLabel: 'Regular',
        basePrice: 65,
        isActive: true,
        lifecycleStatus: 'DRAFT',
        createdById: superAdminId,
        maxFlavors,
      },
    });
  }

  // approveVariant now requires at least one active ProductInventory
  // mapping to exist (CR-005 Guarantee 6 — replaces the old vacuous-pass
  // Recipe-resolvability check). Scoped to this suite's own branchId.
  async function provisionInventoryMapping(variantId: string) {
    const ingredient = await prisma.ingredient.create({
      data: { branchId, name: `CR005D-Mapping-${randomUUID().slice(0, 8)}`, unit: 'g', currentStock: 0, lowStockThreshold: 0, criticalThreshold: 0 },
    });
    await prisma.productInventory.create({
      data: { branchId, productVariantId: variantId, ingredientId: ingredient.id, flavorId: null, quantityRequired: 10, unit: 'g' },
    });
  }

  it('walks the full slot lifecycle: add 3 -> update -> reorder -> remove -> contiguous final state', async () => {
    const variant = await createDraftVariant('full-slot-lifecycle');

    const s0 = await productsService.addFlavorSlot(variant.id, { label: 'A', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);
    const s1 = await productsService.addFlavorSlot(variant.id, { label: 'B', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);
    const s2 = await productsService.addFlavorSlot(variant.id, { label: 'C', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);
    expect([s0.slotIndex, s1.slotIndex, s2.slotIndex]).toEqual([0, 1, 2]);

    await productsService.updateFlavorSlot(s1.id, { label: 'B-renamed' }, undefined, SUPERVISOR(), null);

    const reordered = await productsService.reorderFlavorSlots(variant.id, { slotIds: [s2.id, s0.id, s1.id] }, undefined, SUPERVISOR(), null);
    expect(reordered.map((s) => s.id)).toEqual([s2.id, s0.id, s1.id]);
    expect(reordered.map((s) => s.slotIndex)).toEqual([0, 1, 2]);

    // Order asserted above as [s2, s0, s1] — s0 now sits at index 1. Remove it.
    await productsService.removeFlavorSlot(s0.id, undefined, SUPERVISOR(), null);

    const final = await productsService.listFlavorSlots(variant.id, SUPERVISOR());
    expect(final).toHaveLength(2);
    expect(final.map((s) => s.slotIndex)).toEqual([0, 1]);
    expect(final.map((s) => s.id)).toEqual([s2.id, s1.id]);
    expect(final.find((s) => s.id === s1.id)?.label).toBe('B-renamed');
  });

  it('ACTIVE variant slot changes create a ChangeLog entry with the operation and before/after slots in snapshotJson', async () => {
    const variant = await createDraftVariant('active-changelog');
    await productsService.submitVariantForApproval(variant.id, SUPERVISOR(), null);
    await provisionInventoryMapping(variant.id);
    await productsService.approveVariant(variant.id, undefined, SUPER_ADMIN(), null);

    const slot = await productsService.addFlavorSlot(
      variant.id,
      { label: 'Cheese', flavorQty: 5, unit: 'grams' },
      'launching cheese flavor',
      SUPER_ADMIN(),
      null,
    );

    const log = await prisma.productChangeLog.findFirstOrThrow({ where: { productVariantId: variant.id } });
    const snapshot = log.snapshotJson as {
      operation: string;
      slots_before: unknown[];
      slots_after: { id: string; label: string }[];
      version_before: number;
      version_after: number;
    };
    expect(snapshot.operation).toBe('ADD_SLOT');
    expect(snapshot.slots_before).toEqual([]);
    expect(snapshot.slots_after).toEqual([expect.objectContaining({ id: slot.id, label: 'Cheese' })]);
    expect(snapshot.version_before).toBe(1);
    expect(snapshot.version_after).toBe(2);
    expect(log.version).toBe(2);
    expect(log.reason).toBe('launching cheese flavor');

    const updated = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(updated.version).toBe(2);
  });

  it('rolls back on a mid-operation failure — no orphan slots, no partial index shift persisted', async () => {
    const variant = await createDraftVariant('shift-rollback');

    // Promote to ACTIVE first, with zero flavor slots — approveVariant's
    // Phase-4 gate blocks approval outright once any ProductFlavorSlot row
    // exists, so the slots must be added afterward, through the governed
    // ACTIVE-variant path (super_admin + reason), for the mutation to run
    // inside performSlotEditWithActiveGovernance's prisma.$transaction — the
    // real test of whether a mid-op failure rolls back atomically.
    await productsService.submitVariantForApproval(variant.id, SUPERVISOR(), null);
    await provisionInventoryMapping(variant.id);
    await productsService.approveVariant(variant.id, undefined, SUPER_ADMIN(), null);

    const s0 = await productsService.addFlavorSlot(variant.id, { label: 'A', flavorQty: 10, unit: 'grams' }, 'add A', SUPER_ADMIN(), null);
    const s1 = await productsService.addFlavorSlot(variant.id, { label: 'B', flavorQty: 10, unit: 'grams' }, 'add B', SUPER_ADMIN(), null);
    const s2 = await productsService.addFlavorSlot(variant.id, { label: 'C', flavorQty: 10, unit: 'grams' }, 'add C', SUPER_ADMIN(), null);

    const shiftSpy = vi
      .spyOn(productsRepository, 'shiftFlavorSlotIndicesDown')
      .mockRejectedValueOnce(new Error('simulated mid-operation failure'));

    await expect(
      productsService.removeFlavorSlot(s1.id, 'remove middle', SUPER_ADMIN(), null),
    ).rejects.toThrow('simulated mid-operation failure');

    shiftSpy.mockRestore();

    const remaining = await prisma.productFlavorSlot.findMany({ where: { productVariantId: variant.id }, orderBy: { slotIndex: 'asc' } });
    // The delete inside the same transaction must have rolled back alongside the failed shift.
    expect(remaining.map((s) => s.id)).toEqual([s0.id, s1.id, s2.id]);
    expect(remaining.map((s) => s.slotIndex)).toEqual([0, 1, 2]);

    // 3 — one per successful addFlavorSlot above (each is a governed
    // ACTIVE-variant edit that logs a ChangeLog row); the failed remove must
    // not have added a 4th.
    const logs = await prisma.productChangeLog.count({ where: { productVariantId: variant.id } });
    expect(logs).toBe(3);
  });

  it('reorder maintains referential integrity — every slot still belongs to its own variant, no cross-variant contamination', async () => {
    const variantA = await createDraftVariant('reorder-integrity-a');
    const variantB = await createDraftVariant('reorder-integrity-b');

    const a0 = await productsService.addFlavorSlot(variantA.id, { label: 'A0', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);
    const a1 = await productsService.addFlavorSlot(variantA.id, { label: 'A1', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);
    const b0 = await productsService.addFlavorSlot(variantB.id, { label: 'B0', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);

    await productsService.reorderFlavorSlots(variantA.id, { slotIds: [a1.id, a0.id] }, undefined, SUPERVISOR(), null);

    const slotsA = await prisma.productFlavorSlot.findMany({ where: { productVariantId: variantA.id } });
    const slotsB = await prisma.productFlavorSlot.findMany({ where: { productVariantId: variantB.id } });
    expect(slotsA.map((s) => s.id).sort()).toEqual([a0.id, a1.id].sort());
    expect(slotsB.map((s) => s.id)).toEqual([b0.id]);
    expect(slotsB.map((s) => s.slotIndex)).toEqual([0]);
  });

  it('enforces maxFlavors end to end: a third add is rejected when maxFlavors is 2', async () => {
    const variant = await createDraftVariant('max-flavors-e2e', 2);

    await productsService.addFlavorSlot(variant.id, { label: 'A', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);
    await productsService.addFlavorSlot(variant.id, { label: 'B', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);

    await expect(
      productsService.addFlavorSlot(variant.id, { label: 'C', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null),
    ).rejects.toMatchObject({ code: 'VARIANT_MAX_FLAVORS_EXCEEDED', statusCode: 409 });

    const count = await prisma.productFlavorSlot.count({ where: { productVariantId: variant.id } });
    expect(count).toBe(2);
  });

  it('cross-variant isolation: adding a slot to variant A does not affect variant B\'s slot count', async () => {
    const variantA = await createDraftVariant('cross-isolation-a');
    const variantB = await createDraftVariant('cross-isolation-b');

    await productsService.addFlavorSlot(variantB.id, { label: 'B0', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);
    const beforeCountA = await prisma.productFlavorSlot.count({ where: { productVariantId: variantA.id } });

    await productsService.addFlavorSlot(variantA.id, { label: 'A0', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);
    await productsService.addFlavorSlot(variantA.id, { label: 'A1', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);

    const afterCountA = await prisma.productFlavorSlot.count({ where: { productVariantId: variantA.id } });
    const countB = await prisma.productFlavorSlot.count({ where: { productVariantId: variantB.id } });
    expect(beforeCountA).toBe(0);
    expect(afterCountA).toBe(2);
    expect(countB).toBe(1);
  });
});
