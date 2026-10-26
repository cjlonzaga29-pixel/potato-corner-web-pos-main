import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createProductSchema } from '@potato-corner/shared';

/**
 * POS-PERF-P38R2 — the publication transaction's budget, against real
 * Postgres. The shared Prisma client is replaced by one that records every
 * SQL statement and has production's 5-connection pool. Covers: batched
 * readiness equals per-branch readiness, the in-transaction statement count
 * does not grow with the branch count, concurrent publications of one
 * product no longer starve the pool, and the batched availability write.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const queryLog: string[] = [];

vi.mock('../../lib/prisma.js', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const { immutabilityMiddleware } = await import('../../lib/prisma-immutability.js');
  const url = new URL(process.env.DATABASE_URL ?? '');
  // Production's pool size (db-round-trip-diagnostics: "the same 5-connection pool").
  url.searchParams.set('connection_limit', '5');
  const client = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [{ emit: 'event', level: 'query' }] });
  client.$on('query', (e) => queryLog.push(e.query));
  client.$use(immutabilityMiddleware);
  return { prisma: client, disconnectPrisma: () => client.$disconnect() };
});

const { prisma } = await import('../../lib/prisma.js');
const { runAuditOutboxCycle } = await import('../audit-outbox/audit-outbox.worker.js');
const { productsService } = await import('./products.service.js');
const { productsRepository } = await import('./products.repository.js');
const { productReadinessService } = await import('../product-readiness/product-readiness.service.js');

/** Statements issued between the publication transaction's BEGIN and COMMIT. */
function statementsInTransaction(log: string[]): number {
  const begin = log.findIndex((q) => q.startsWith('BEGIN'));
  const commit = log.findIndex((q) => q.startsWith('COMMIT'));
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(commit).toBeGreaterThan(begin);
  return commit - begin - 1;
}

describe.skipIf(!isLocalDatabase)('POS-PERF-P38R2 publication transaction budget (real Postgres)', () => {
  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  /** POS-PERF-P38R4 — publication's audit entries are written by the audit outbox worker; deliver this suite's pending ones now. */
  async function deliverAudits() {
    const pending = await prisma.auditOutbox.findMany({ where: { actorId: { in: userIds }, status: { not: 'delivered' } }, select: { groupId: true } });
    if (pending.length > 0) await runAuditOutboxCycle({ groupIds: [...new Set(pending.map((row) => row.groupId))], batchSize: 1000 });
  }
  const branchIds: string[] = [];
  const itemIds: string[] = [];
  const unitIds: string[] = [];
  const flavorIds: string[] = [];
  const optionGroupIds: string[] = [];
  let supervisor: { id: string; role: string };
  let gramId: string;
  let pieceId: string;
  let potato: string;
  let cup: string;
  let powder: string;
  let sauce: string;
  let flavorId: string;
  let optionGroupId: string;

  async function makeBranch(label: string) {
    const branch = await prisma.branch.create({
      data: { name: `P38R2 Branch ${label} ${suffix}`, code: `P38R2${label}-${suffix}`, address: 'Test', city: 'Test' },
    });
    branchIds.push(branch.id);
    await prisma.userBranchAssignment.create({ data: { userId: supervisor.id, branchId: branch.id } });
    return branch.id;
  }

  async function makeItem(label: string, baseUnitId: string) {
    const item = await prisma.inventoryItem.create({ data: { name: `P38R2 ${label} ${suffix}`, baseUnitId } });
    itemIds.push(item.id);
    return item.id;
  }

  /** Two sizes: potato + cup base, flavor-specific powder, and a sauce choice mapped to inventory. */
  async function createProduct(label: string, selection: string[]) {
    const created = await productsService.createProduct(
      createProductSchema.parse({ name: `P38R2 ${label} ${suffix}`, status: 'active', branch_ids: selection }),
      supervisor,
      null,
    );
    for (const [name, price] of [['Regular', 59], ['Large', 89]] as const) {
      const variant = await prisma.productVariant.create({
        data: { productId: created.id, name, sizeLabel: name, basePrice: price, isActive: true, lifecycleStatus: 'ACTIVE' },
      });
      await prisma.productVariantFlavor.create({ data: { productVariantId: variant.id, flavorId, isAvailable: true } });
      await prisma.productComponent.createMany({
        data: [
          { productVariantId: variant.id, inventoryItemId: potato, quantityRequired: 150, recipeUnitId: gramId },
          { productVariantId: variant.id, inventoryItemId: cup, quantityRequired: 1, recipeUnitId: pieceId },
          { productVariantId: variant.id, inventoryItemId: powder, quantityRequired: 5, recipeUnitId: gramId, flavorId },
        ],
      });
      await prisma.productVariantOptionGroup.create({ data: { productVariantId: variant.id, optionGroupId } });
    }
    return created.id;
  }

  async function publishedAt(productId: string) {
    return (await prisma.branchProductAvailability.findMany({ where: { productId, isAvailable: true } })).map((r) => r.branchId).sort();
  }

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'P38R2', lastName: 'Sup', employmentType: 'regular', email: `p38r2-sup-${suffix}@test.local` },
    });
    userIds.push(user.id);
    supervisor = { id: user.id, role: 'supervisor' };
    gramId = (await prisma.unitOfMeasure.create({ data: { code: `p38r2-g-${suffix}`, name: 'P38R2 Gram', dimension: 'WEIGHT', isBaseUnit: true } })).id;
    pieceId = (await prisma.unitOfMeasure.create({ data: { code: `p38r2-pc-${suffix}`, name: 'P38R2 Piece', dimension: 'COUNT', isBaseUnit: true } })).id;
    unitIds.push(gramId, pieceId);
    potato = await makeItem('Potato', gramId);
    cup = await makeItem('Cup', pieceId);
    powder = await makeItem('Cheese Powder', gramId);
    sauce = await makeItem('Sauce', gramId);
    const flavor = await prisma.flavor.create({ data: { name: `P38R2 Cheese ${suffix}`, ingredientName: 'Cheese Powder', ingredientUnit: 'g' } });
    flavorId = flavor.id;
    flavorIds.push(flavorId);
    const group = await prisma.productOptionGroup.create({
      data: { code: `p38r2-sauce-${suffix}`, name: 'Sauce', selectionType: 'SINGLE', required: true, minSelections: 1 },
    });
    optionGroupId = group.id;
    optionGroupIds.push(group.id);
    const option = await prisma.productOption.create({ data: { optionGroupId: group.id, code: 'cheese', name: 'Cheese Sauce' } });
    await prisma.productOptionInventoryMapping.create({ data: { productOptionId: option.id, inventoryItemId: sauce, quantityRequired: 10, deductionUnitId: gramId } });
  });

  afterAll(async () => {
    const productIds = (await prisma.product.findMany({ where: { createdBy: { in: userIds } }, select: { id: true } })).map((p) => p.id);
    const variantIds = (await prisma.productVariant.findMany({ where: { productId: { in: productIds } }, select: { id: true } })).map((v) => v.id);
    await prisma.productComponent.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productVariantFlavor.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productVariantOptionGroup.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productOptionInventoryMapping.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.productOption.deleteMany({ where: { optionGroupId: { in: optionGroupIds } } });
    await prisma.productOptionGroup.deleteMany({ where: { id: { in: optionGroupIds } } });
    await prisma.branchProductAvailability.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productChangeLog.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.branchFlavorAvailability.deleteMany({ where: { flavorId: { in: flavorIds } } });
    await prisma.flavor.deleteMany({ where: { id: { in: flavorIds } } });
    await prisma.inventoryStock.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: { in: unitIds } } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditOutbox.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
    await prisma.$disconnect();
  });

  it('batched readiness equals per-branch readiness at branches in different states', async () => {
    const stocked = await makeBranch('RS');
    const bare = await makeBranch('RB');
    const flavorOff = await makeBranch('RF');
    const productId = await createProduct('Readiness', [stocked, bare, flavorOff]);
    await prisma.inventoryStock.createMany({
      data: [potato, cup, powder, sauce].flatMap((id) => [stocked, flavorOff].map((branchId) => ({ branchId, inventoryItemId: id }))),
    });
    await productsService.publishProduct(productId, stocked, supervisor, null);
    await prisma.branchFlavorAvailability.create({ data: { branchId: flavorOff, flavorId, isAvailable: false } });

    const selection = [stocked, bare, flavorOff];
    const batched = await productReadinessService.evaluateProductReadinessForBranches({ productId, branchIds: selection });
    for (const branchId of selection) {
      expect(batched.get(branchId)).toEqual(await productReadinessService.evaluateProductReadiness({ productId, branchId }));
    }
    // The three states really differ, so the comparison is not trivially equal.
    expect(selection.map((id) => batched.get(id)?.status)).toEqual(['READY', 'NOT_READY', 'NOT_READY']);
    expect(batched.get(bare)?.blockingIssues.map((i) => i.code)).toContain('INVENTORY_STOCK_MISSING');
    expect(batched.get(flavorOff)?.blockingIssues.map((i) => i.code)).toContain('FLAVOR_NOT_AVAILABLE_AT_BRANCH');
  });

  it('the publication transaction issues the same number of statements for one branch as for six', async () => {
    const one = [await makeBranch('S1')];
    const six = [];
    for (let i = 0; i < 6; i++) six.push(await makeBranch(`S6${i}`));
    const productOne = await createProduct('Budget One', one);
    const productSix = await createProduct('Budget Six', six);

    queryLog.length = 0;
    const resultOne = await productsService.publishProductToBranches(productOne, one, supervisor, null);
    const countOne = statementsInTransaction(queryLog);
    queryLog.length = 0;
    const resultSix = await productsService.publishProductToBranches(productSix, six, supervisor, null);
    const countSix = statementsInTransaction(queryLog);

    // Both create links (4 items) at every branch; the six-branch transaction does 6× the work in the same statements.
    expect(resultOne.setup.stock_links).toHaveLength(4);
    expect(resultSix.setup.stock_links).toHaveLength(24);
    expect(countSix).toBe(countOne);
    // Before P38R2 this was ~30 statements for one branch plus ~19 per further branch (~125 for six).
    expect(countSix).toBeLessThanOrEqual(45);
    expect(await publishedAt(productSix)).toEqual([...six].sort());
  });

  it('six concurrent publications of one product on a 5-connection pool all succeed, each link once', async () => {
    const branches = [];
    for (let i = 0; i < 6; i++) branches.push(await makeBranch(`C${i}`));
    const productId = await createProduct('Concurrent', branches);

    // Before P38R2 every one of these failed (P2028/P2024): the waiters held
    // the pool's connections while the lock holder needed one more for its reads.
    const outcomes = await Promise.allSettled(branches.map((branchId) => productsService.publishProduct(productId, branchId, supervisor, null)));
    expect(outcomes.map((o) => o.status)).toEqual(branches.map(() => 'fulfilled'));
    expect(await publishedAt(productId)).toEqual([...branches].sort());
    const links = await prisma.inventoryStock.findMany({ where: { branchId: { in: branches } }, select: { quantityOnHand: true } });
    expect(links).toHaveLength(branches.length * 4);
    expect(links.every((l) => l.quantityOnHand.toNumber() === 0)).toBe(true);
    await deliverAudits();
    const audits = await prisma.auditLog.findMany({ where: { actorId: supervisor.id, action: 'INVENTORY_ITEM_BRANCH_ASSIGNED' } });
    const pairs = audits
      .filter((a) => (a.afterState as { product_id?: string }).product_id === productId)
      .flatMap((a) => (a.afterState as { assigned: string[] }).assigned.map((b) => `${b}:${a.entityId}`));
    expect(pairs).toHaveLength(branches.length * 4);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('the batched availability write flips an existing row, creates absent ones, and keeps branch order and shape', async () => {
    const existing = await makeBranch('WE');
    const absent = await makeBranch('WA');
    const productId = (await productsService.createProduct(createProductSchema.parse({ name: `P38R2 Write ${suffix}`, status: 'active' }), { id: userIds[0] ?? '', role: 'super_admin' }, null)).id;
    await prisma.branchProductAvailability.deleteMany({ where: { productId } });
    await prisma.branchProductAvailability.create({ data: { branchId: existing, productId, isAvailable: false, updatedBy: null } });

    const rows = await prisma.$transaction((tx) => productsRepository.publishBranchProductAvailability([absent, existing], productId, supervisor.id, tx));

    expect(rows.map((r) => [r.branchId, r.isAvailable, r.updatedBy])).toEqual([
      [absent, true, supervisor.id],
      [existing, true, supervisor.id],
    ]);
    expect(rows[1]?.branch).toEqual({ id: existing, code: `P38R2WE-${suffix}`, name: `P38R2 Branch WE ${suffix}`, city: 'Test' });
    expect(await prisma.branchProductAvailability.count({ where: { productId } })).toBe(2);
  });
});
