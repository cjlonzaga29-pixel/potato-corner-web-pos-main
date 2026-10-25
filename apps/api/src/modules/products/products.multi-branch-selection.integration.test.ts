import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createProductSchema, publishProductToBranchesSchema } from '@potato-corner/shared';

/**
 * POS-PERF-P37 — "create once, select multiple branches", against real
 * Postgres: one product + exactly the selected branch rows, all-or-nothing
 * publication across the selection, live-assignment rechecks, the
 * branch-spread guard for branchSelectionScoped products, and that the
 * existing full-coverage authority / branch-copy rules still hold for them.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { productsService } = await import('./products.service.js');

type Actor = { id: string; role: string };

describe.skipIf(!isLocalDatabase)('POS-PERF-P37 multi-branch product selection (real Postgres)', () => {
  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const branchIds: string[] = [];
  let unitId: string;
  let itemId: string;

  // Branch roles in this file:
  //   A, B — selected for the product; supervisor assigned
  //   C    — supervisor assigned, never selected
  //   X    — active branch the supervisor is NOT assigned to
  //   Z    — supervisor assigned, but the branch itself is inactive
  let branchA: string;
  let branchB: string;
  let branchC: string;
  let branchX: string;
  let branchZ: string;
  let supervisor: Actor;
  let partialSupervisor: Actor; // assigned to A only

  async function makeUser(label: string): Promise<Actor> {
    const user = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'P37', lastName: label, employmentType: 'regular', email: `p37-${label}-${suffix}@test.local` },
    });
    userIds.push(user.id);
    return { id: user.id, role: 'supervisor' };
  }

  async function makeBranch(label: string, status: 'active' | 'inactive' = 'active') {
    const branch = await prisma.branch.create({
      data: { name: `P37 Branch ${label} ${suffix}`, code: `P37${label}-${suffix}`, address: 'Test', city: 'Test', status },
    });
    branchIds.push(branch.id);
    return branch.id;
  }

  async function assign(actor: Actor, branchId: string) {
    await prisma.userBranchAssignment.create({ data: { userId: actor.id, branchId } });
  }

  /** A multi-branch product created through the real service, then given a complete recipe (variant + one component). */
  async function createConfiguredProduct(label: string, selection: string[]) {
    const created = await productsService.createProduct(
      createProductSchema.parse({ name: `P37 ${label} ${suffix}`, status: 'active', branch_ids: selection }),
      supervisor,
      null,
    );
    const variant = await prisma.productVariant.create({
      data: { productId: created.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 50, isActive: true, lifecycleStatus: 'ACTIVE' },
    });
    await prisma.productComponent.create({
      data: { productVariantId: variant.id, inventoryItemId: itemId, quantityRequired: 10, recipeUnitId: unitId },
    });
    return { productId: created.id, variantId: variant.id, created };
  }

  async function availabilityRows(productId: string) {
    return prisma.branchProductAvailability.findMany({ where: { productId }, orderBy: { branchId: 'asc' } });
  }

  beforeAll(async () => {
    supervisor = await makeUser('sup');
    partialSupervisor = await makeUser('partial');
    branchA = await makeBranch('A');
    branchB = await makeBranch('B');
    branchC = await makeBranch('C');
    branchX = await makeBranch('X');
    branchZ = await makeBranch('Z', 'inactive');
    for (const id of [branchA, branchB, branchC, branchZ]) await assign(supervisor, id);
    await assign(partialSupervisor, branchA);

    const unit = await prisma.unitOfMeasure.create({ data: { code: `p37-g-${suffix}`, name: 'P37 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    unitId = unit.id;
    const item = await prisma.inventoryItem.create({ data: { name: `P37 Item ${suffix}`, baseUnitId: unitId } });
    itemId = item.id;
    // A and B are set up for this recipe item; C deliberately is not.
    await prisma.inventoryStock.createMany({
      data: [
        { branchId: branchA, inventoryItemId: itemId, quantityOnHand: 500 },
        { branchId: branchB, inventoryItemId: itemId, quantityOnHand: 300 },
      ],
    });
  });

  afterAll(async () => {
    const productIds = (await prisma.product.findMany({ where: { createdBy: { in: userIds } }, select: { id: true } })).map((p) => p.id);
    const variantIds = (await prisma.productVariant.findMany({ where: { productId: { in: productIds } }, select: { id: true } })).map((v) => v.id);
    await prisma.productComponent.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.branchProductAvailability.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productChangeLog.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } });
    // Fork copies reference their source via forkedFromProductId — delete copies first.
    await prisma.product.deleteMany({ where: { id: { in: productIds }, forkedFromProductId: { not: null } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.inventoryStock.deleteMany({ where: { inventoryItemId: itemId } });
    await prisma.inventoryItem.deleteMany({ where: { id: itemId } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: unitId } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
  });

  it('schemas reject an empty selection and combining branch_ids with the legacy exclusive fields', () => {
    expect(createProductSchema.safeParse({ name: 'Empty', branch_ids: [] }).success).toBe(false);
    expect(publishProductToBranchesSchema.safeParse({ branch_ids: [] }).success).toBe(false);
    expect(createProductSchema.safeParse({ name: 'Mixed', branch_ids: [randomUUID()], branch_exclusive: true, exclusive_branch_id: randomUUID() }).success).toBe(false);
    expect(createProductSchema.safeParse({ name: 'Bad id', branch_ids: ['not-a-uuid'] }).success).toBe(false);
  });

  it('creates exactly one product with unpublished rows at exactly the selected branches (duplicates collapsed)', async () => {
    const name = `P37 Once ${suffix}`;
    const created = await productsService.createProduct(
      createProductSchema.parse({ name, status: 'active', branch_ids: [branchA, branchB, branchA] }),
      supervisor,
      null,
    );

    expect(await prisma.product.count({ where: { name } })).toBe(1);
    expect(created.branch_exclusive).toBe(false);
    expect(created.exclusive_branch_id).toBeNull();
    expect(created.branch_selection_scoped).toBe(true);

    const rows = await availabilityRows(created.id);
    expect(rows.map((r) => r.branchId).sort()).toEqual([branchA, branchB].sort());
    expect(rows.every((r) => r.isAvailable === false)).toBe(true);
    // Nothing seeded at unselected branches, assigned (C) or not (X).
    expect(rows.some((r) => r.branchId === branchC || r.branchId === branchX)).toBe(false);
  });

  it('a single selected branch keeps the existing branch-exclusive shape', async () => {
    const created = await productsService.createProduct(
      createProductSchema.parse({ name: `P37 Single ${suffix}`, status: 'active', branch_ids: [branchA] }),
      supervisor,
      null,
    );
    expect(created.branch_exclusive).toBe(true);
    expect(created.exclusive_branch_id).toBe(branchA);
    expect(created.branch_selection_scoped).toBe(false);
    expect((await availabilityRows(created.id)).map((r) => r.branchId)).toEqual([branchA]);
  });

  it('the legacy single-branch request shape still works unchanged', async () => {
    const created = await productsService.createProduct(
      createProductSchema.parse({ name: `P37 Legacy Shape ${suffix}`, status: 'active', branch_exclusive: true, exclusive_branch_id: branchB }),
      supervisor,
      null,
    );
    expect(created.branch_exclusive).toBe(true);
    expect(created.exclusive_branch_id).toBe(branchB);
  });

  it('a supervisor request with no branch scope is still rejected, never treated as company-wide', async () => {
    const name = `P37 No Scope ${suffix}`;
    await expect(
      productsService.createProduct(createProductSchema.parse({ name, status: 'active' }), supervisor, null),
    ).rejects.toMatchObject({ code: 'SUPERVISOR_EXCLUSIVE_BRANCH_REQUIRED', statusCode: 403 });
    expect(await prisma.product.count({ where: { name } })).toBe(0);
  });

  it.each([
    ['an unassigned branch', () => branchX, 'BRANCH_ACCESS_DENIED', 403],
    ['a forged (non-existent) branch id', () => randomUUID(), 'BRANCH_SELECTION_INVALID', 422],
    ['an inactive assigned branch', () => branchZ, 'BRANCH_SELECTION_INVALID', 422],
  ])('rejects creation when the selection includes %s, with no partial writes', async (_label, badBranch, code, statusCode) => {
    const name = `P37 Forged ${randomUUID().slice(0, 6)}`;
    await expect(
      productsService.createProduct(createProductSchema.parse({ name, status: 'active', branch_ids: [branchA, badBranch()] }), supervisor, null),
    ).rejects.toMatchObject({ code, statusCode });
    expect(await prisma.product.count({ where: { name } })).toBe(0);
  });

  it('Save Draft state: a created, fully configured product is absent from every selected POS until Add to POS', async () => {
    const { productId } = await createConfiguredProduct('Draft', [branchA, branchB]);
    for (const branchId of [branchA, branchB, branchC]) {
      const catalog = await productsService.getPosCatalog(branchId);
      expect(JSON.stringify(catalog)).not.toContain(productId);
    }
  });

  it('Add to POS publishes at exactly the selected branches; a retry duplicates nothing', async () => {
    const { productId } = await createConfiguredProduct('Publish', [branchA, branchB]);

    const result = await productsService.publishProductToBranches(productId, [branchA, branchB], supervisor, null);
    expect(result.branches.map((b) => b.branch_id).sort()).toEqual([branchA, branchB].sort());
    expect(result.branches.every((b) => b.is_available)).toBe(true);

    expect(JSON.stringify(await productsService.getPosCatalog(branchA))).toContain(productId);
    expect(JSON.stringify(await productsService.getPosCatalog(branchB))).toContain(productId);
    expect(JSON.stringify(await productsService.getPosCatalog(branchC))).not.toContain(productId);

    // Retry (e.g. a lost response) — same unique rows, no new ones, still one product.
    await productsService.publishProductToBranches(productId, [branchB, branchA, branchA], supervisor, null);
    const rows = await availabilityRows(productId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.isAvailable)).toBe(true);
    expect(await prisma.product.count({ where: { name: `P37 Publish ${suffix}` } })).toBe(1);
  });

  it('a branch missing inventory setup blocks the whole publication, leaving every selected branch unpublished', async () => {
    // C has no InventoryStock row for the recipe item.
    const { productId } = await createConfiguredProduct('Missing Setup', [branchA, branchC]);

    const error = await productsService.publishProductToBranches(productId, [branchA, branchC], supervisor, null).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'PRODUCT_NOT_READY', statusCode: 409 });
    const details = (error as { details: { branches: { branch_id: string; blocking_issues: { code: string }[] }[] } }).details;
    expect(details.branches.map((b) => b.branch_id)).toEqual([branchC]);
    expect(details.branches[0]?.blocking_issues.map((i) => i.code)).toContain('INVENTORY_STOCK_MISSING');

    const rows = await availabilityRows(productId);
    expect(rows.every((r) => r.isAvailable === false)).toBe(true);
    // No stock row was invented at C to make it pass.
    expect(await prisma.inventoryStock.count({ where: { branchId: branchC, inventoryItemId: itemId } })).toBe(0);
  });

  it('a stock shortage (row present, zero on hand) does not block publication — distinct from missing setup', async () => {
    const shortBranch = await makeBranch('S');
    await assign(supervisor, shortBranch);
    await prisma.inventoryStock.create({ data: { branchId: shortBranch, inventoryItemId: itemId, quantityOnHand: 0 } });
    const { productId } = await createConfiguredProduct('Shortage', [branchA, shortBranch]);

    const result = await productsService.publishProductToBranches(productId, [branchA, shortBranch], supervisor, null);
    expect(result.branches.every((b) => b.is_available)).toBe(true);
  });

  it('an assignment revoked between create and publish rejects the whole publication without partial writes', async () => {
    const revocable = await makeBranch('R');
    await assign(supervisor, revocable);
    await prisma.inventoryStock.create({ data: { branchId: revocable, inventoryItemId: itemId, quantityOnHand: 100 } });
    const { productId } = await createConfiguredProduct('Revoked', [branchA, revocable]);

    await prisma.userBranchAssignment.updateMany({ where: { userId: supervisor.id, branchId: revocable }, data: { removedAt: new Date() } });

    await expect(productsService.publishProductToBranches(productId, [branchA, revocable], supervisor, null)).rejects.toMatchObject({
      code: 'BRANCH_ACCESS_DENIED',
      statusCode: 403,
    });
    expect((await availabilityRows(productId)).every((r) => r.isAvailable === false)).toBe(true);
  });

  it('forged/unselected branch ids on publish are rejected without partial writes', async () => {
    const { productId } = await createConfiguredProduct('Forged Publish', [branchA, branchB]);

    // X: not assigned to the actor at all.
    await expect(productsService.publishProductToBranches(productId, [branchA, branchX], supervisor, null)).rejects.toMatchObject({
      code: 'BRANCH_ACCESS_DENIED',
    });
    // C: assigned, but never selected for this product — no spreading.
    await prisma.inventoryStock.create({ data: { branchId: branchC, inventoryItemId: itemId, quantityOnHand: 100 } });
    try {
      await expect(productsService.publishProductToBranches(productId, [branchA, branchC], supervisor, null)).rejects.toMatchObject({
        code: 'PRODUCT_BRANCH_NOT_SELECTED',
        statusCode: 403,
      });
      // The existing single-branch paths enforce the same guard.
      await expect(productsService.publishProduct(productId, branchC, supervisor, null)).rejects.toMatchObject({ code: 'PRODUCT_BRANCH_NOT_SELECTED' });
      await expect(productsService.updateBranchProductAvailability(productId, branchC, true, supervisor, null)).rejects.toMatchObject({
        code: 'PRODUCT_BRANCH_NOT_SELECTED',
      });
      await expect(
        productsService.bulkUpdateBranchProductAvailability(productId, [{ branch_id: branchC, is_available: true }], supervisor, null),
      ).rejects.toMatchObject({ code: 'PRODUCT_BRANCH_NOT_SELECTED' });
    } finally {
      await prisma.inventoryStock.deleteMany({ where: { branchId: branchC, inventoryItemId: itemId } });
    }

    const rows = await availabilityRows(productId);
    expect(rows.map((r) => r.branchId).sort()).toEqual([branchA, branchB].sort());
    expect(rows.every((r) => r.isAvailable === false)).toBe(true);
  });

  it('a legacy shared product (not branch-selection scoped) keeps its existing availability behavior', async () => {
    const legacy = await prisma.product.create({ data: { name: `P37 Legacy Shared ${suffix}`, status: 'active', createdBy: supervisor.id } });
    await prisma.branchProductAvailability.create({ data: { branchId: branchA, productId: legacy.id, isAvailable: false } });

    const row = await productsService.updateBranchProductAvailability(legacy.id, branchC, true, supervisor, null);
    expect(row.is_available).toBe(true);
  });

  it('a partial-authority supervisor cannot change the shared configuration, but can still make a branch copy and replace at their branch', async () => {
    const { productId } = await createConfiguredProduct('Partial', [branchA, branchB]);
    await productsService.publishProductToBranches(productId, [branchA, branchB], supervisor, null);

    await expect(productsService.updateProduct(productId, { name: 'Hijacked' }, partialSupervisor, null)).rejects.toMatchObject({
      code: 'PRODUCT_UPDATE_FORBIDDEN',
      statusCode: 403,
    });
    await expect(
      productsService.changeProductStatus(productId, { status: 'archived' }, partialSupervisor, null),
    ).rejects.toMatchObject({ code: 'PRODUCT_STATUS_FORBIDDEN' });
    // The fully-covering supervisor still can.
    const renamed = await productsService.updateProduct(productId, { name: `P37 Partial Renamed ${suffix}` }, supervisor, null);
    expect(renamed.name).toBe(`P37 Partial Renamed ${suffix}`);

    // Branch-copy workflow for branch-specific changes, unchanged.
    const copy = await productsService.forkProductForBranch(productId, branchA, partialSupervisor, null);
    expect(copy.branch_exclusive).toBe(true);
    expect(copy.exclusive_branch_id).toBe(branchA);
    const retryCopy = await productsService.forkProductForBranch(productId, branchA, partialSupervisor, null);
    expect(retryCopy.id).toBe(copy.id);

    // The fork is created as a draft product — activate it as a supervisor would before replacing.
    await prisma.product.update({ where: { id: copy.id }, data: { status: 'active' } });
    await productsService.replaceSharedProductAtBranch(copy.id, branchA, partialSupervisor, null);

    const sourceRows = await availabilityRows(productId);
    expect(sourceRows.find((r) => r.branchId === branchA)?.isAvailable).toBe(false);
    expect(sourceRows.find((r) => r.branchId === branchB)?.isAvailable).toBe(true);
    const copyRow = await prisma.branchProductAvailability.findUnique({ where: { branchId_productId: { branchId: branchA, productId: copy.id } } });
    expect(copyRow?.isAvailable).toBe(true);
  });

  it('creating and publishing never touches inventory balances', async () => {
    const before = await prisma.inventoryStock.findMany({ where: { inventoryItemId: itemId }, orderBy: { branchId: 'asc' } });
    const { productId } = await createConfiguredProduct('No Stock Change', [branchA, branchB]);
    await productsService.publishProductToBranches(productId, [branchA, branchB], supervisor, null);
    const after = await prisma.inventoryStock.findMany({ where: { inventoryItemId: itemId }, orderBy: { branchId: 'asc' } });
    expect(after.map((s) => [s.branchId, s.quantityOnHand.toString()])).toEqual(before.map((s) => [s.branchId, s.quantityOnHand.toString()]));
  });
});
