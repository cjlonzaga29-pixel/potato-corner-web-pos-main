import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createProductSchema } from '@potato-corner/shared';

/**
 * POS-PERF-P38R — the product page's per-branch Publish (publishProduct)
 * runs the same publication operation as the builder's Add to POS
 * (publishProductToBranches), against real Postgres. Recipe items start
 * with no InventoryStock rows at the selected branches. Covers: single-branch
 * setup and publication touch only the requested branch, retries add
 * nothing, both paths reject the same invalid configurations without writes,
 * authorization, a concurrent single + multi-branch publish, and that zero
 * stock still stops checkout.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { productsService } = await import('./products.service.js');
const { productsRepository } = await import('./products.repository.js');
const { transactionsService } = await import('../transactions/transactions.service.js');

type Actor = { id: string; role: string };

describe.skipIf(!isLocalDatabase)('POS-PERF-P38R consistent single-branch publication (real Postgres)', () => {
  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const branchIds: string[] = [];
  const itemIds: string[] = [];
  const unitIds: string[] = [];
  const flavorIds: string[] = [];
  const optionGroupIds: string[] = [];
  let supervisor: Actor;
  let cashierId: string;
  let gramId: string;
  let pieceId: string;
  let kgId: string;
  let potato: string;
  let cup: string;
  let powder: string;
  let flavorId: string;

  // A, B — the selection; C — assigned to the supervisor, never selected.
  let branchA: string;
  let branchB: string;
  let branchC: string;

  async function makeBranch(label: string) {
    const branch = await prisma.branch.create({
      data: { name: `P38R Branch ${label} ${suffix}`, code: `P38R${label}-${suffix}`, address: 'Test', city: 'Test' },
    });
    branchIds.push(branch.id);
    await prisma.userBranchAssignment.create({ data: { userId: supervisor.id, branchId: branch.id } });
    return branch.id;
  }

  async function makeItem(label: string, baseUnitId: string) {
    const item = await prisma.inventoryItem.create({ data: { name: `P38R ${label} ${suffix}`, baseUnitId } });
    itemIds.push(item.id);
    return item.id;
  }

  async function createProduct(label: string, selection: string[], components = () => [
    { inventoryItemId: potato, quantityRequired: 150, recipeUnitId: gramId, flavorId: null as string | null },
    { inventoryItemId: cup, quantityRequired: 1, recipeUnitId: pieceId, flavorId: null as string | null },
    { inventoryItemId: powder, quantityRequired: 5, recipeUnitId: gramId, flavorId: flavorId as string | null },
  ]) {
    const created = await productsService.createProduct(
      createProductSchema.parse({ name: `P38R ${label} ${suffix}`, status: 'active', branch_ids: selection }),
      supervisor,
      null,
    );
    const variantIds: string[] = [];
    for (const [name, price] of [['Regular', 59], ['Large', 89]] as const) {
      const variant = await prisma.productVariant.create({
        data: { productId: created.id, name, sizeLabel: name, basePrice: price, isActive: true, lifecycleStatus: 'ACTIVE' },
      });
      variantIds.push(variant.id);
      await prisma.productVariantFlavor.create({ data: { productVariantId: variant.id, flavorId, isAvailable: true } });
      await prisma.productComponent.createMany({ data: components().map((c) => ({ ...c, productVariantId: variant.id })) });
    }
    return { productId: created.id, variantIds };
  }

  async function stockRows(branches: string[], items: string[] = itemIds) {
    return prisma.inventoryStock.findMany({
      where: { branchId: { in: branches }, inventoryItemId: { in: items } },
      orderBy: [{ branchId: 'asc' }, { inventoryItemId: 'asc' }],
    });
  }

  async function publishedAt(productId: string) {
    return (await prisma.branchProductAvailability.findMany({ where: { productId, isAvailable: true } })).map((r) => r.branchId).sort();
  }

  async function assignmentAudits(productId: string) {
    const rows = await prisma.auditLog.findMany({ where: { actorId: supervisor.id, action: 'INVENTORY_ITEM_BRANCH_ASSIGNED' } });
    return rows.filter((r) => (r.afterState as { product_id?: string } | null)?.product_id === productId);
  }

  /** (branch, item) pairs the assignment audits claim were linked — one entry per link. */
  function auditedPairs(audits: Awaited<ReturnType<typeof assignmentAudits>>) {
    return audits
      .flatMap((a) => ((a.afterState as { assigned: string[] }).assigned ?? []).map((branchId) => `${branchId}:${a.entityId}`))
      .sort();
  }

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'P38R', lastName: 'Sup', employmentType: 'regular', email: `p38r-sup-${suffix}@test.local` },
    });
    userIds.push(user.id);
    supervisor = { id: user.id, role: 'supervisor' };
    const cashier = await prisma.user.create({
      data: {
        role: 'staff',
        firstName: 'P38R',
        lastName: 'Cashier',
        employmentType: 'regular',
        email: `p38r-cashier-${suffix}@test.local`,
        mustChangePassword: false,
      },
    });
    userIds.push(cashier.id);
    cashierId = cashier.id;

    const gram = await prisma.unitOfMeasure.create({ data: { code: `p38r-g-${suffix}`, name: 'P38R Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    const piece = await prisma.unitOfMeasure.create({ data: { code: `p38r-pc-${suffix}`, name: 'P38R Piece', dimension: 'COUNT', isBaseUnit: true } });
    // Same dimension as gram, deliberately with no UnitConversion row.
    const kg = await prisma.unitOfMeasure.create({ data: { code: `p38r-kg-${suffix}`, name: 'P38R Kilogram', dimension: 'WEIGHT' } });
    gramId = gram.id;
    pieceId = piece.id;
    kgId = kg.id;
    unitIds.push(gramId, pieceId, kgId);

    potato = await makeItem('Potato', gramId);
    cup = await makeItem('Cup', pieceId);
    powder = await makeItem('Cheese Powder', gramId);
    const flavor = await prisma.flavor.create({ data: { name: `P38R Cheese ${suffix}`, ingredientName: 'Cheese Powder', ingredientUnit: 'g' } });
    flavorId = flavor.id;
    flavorIds.push(flavorId);

    branchA = await makeBranch('A');
    branchB = await makeBranch('B');
    branchC = await makeBranch('C');

    // A already stocks potato, with a real balance, a reservation, thresholds and a cost.
    await prisma.inventoryStock.create({
      data: { branchId: branchA, inventoryItemId: potato, quantityOnHand: 500, quantityReserved: 7, lowStockThreshold: 50, criticalThreshold: 10, unitCost: 2.5 },
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma.$executeRaw`DELETE FROM "transaction_items" WHERE "transaction_id" IN (SELECT id FROM "transactions" WHERE "cashier_id" = ${cashierId})`;
    await prisma.inventoryDeductionJob.deleteMany({ where: { branchId: { in: branchIds } } });
    await prisma.$executeRaw`DELETE FROM "transactions" WHERE "cashier_id" = ${cashierId}`;
    await prisma.inventoryStockMovement.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.shift.deleteMany({ where: { cashierId } });
    const productIds = (await prisma.product.findMany({ where: { createdBy: { in: userIds } }, select: { id: true } })).map((p) => p.id);
    const variantIds = (await prisma.productVariant.findMany({ where: { productId: { in: productIds } }, select: { id: true } })).map((v) => v.id);
    await prisma.productComponent.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productVariantFlavor.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productVariantOptionGroup.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productOption.deleteMany({ where: { optionGroupId: { in: optionGroupIds } } });
    await prisma.productOptionGroup.deleteMany({ where: { id: { in: optionGroupIds } } });
    await prisma.branchProductAvailability.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productChangeLog.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.branchFlavorAvailability.deleteMany({ where: { flavorId: { in: flavorIds } } });
    await prisma.flavor.deleteMany({ where: { id: { in: flavorIds } } });
    await prisma.inventoryStock.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.inventoryItemUnitConversion.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.unitConversion.deleteMany({ where: { OR: [{ fromUnitId: { in: unitIds } }, { toUnitId: { in: unitIds } }] } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: { in: unitIds } } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
  });

  let mainProductId = '';
  let mainVariantIds: string[] = [];
  let potatoAtABefore: Awaited<ReturnType<typeof stockRows>>[number] | undefined;

  it('product page Publish at A succeeds with missing links, sets up and publishes only A', async () => {
    const { productId, variantIds } = await createProduct('Cheese Fries', [branchA, branchB]);
    mainProductId = productId;
    mainVariantIds = variantIds;
    potatoAtABefore = (await stockRows([branchA], [potato]))[0];

    // The product page reads the same plan for just its branch.
    const check = await productsService.getPublicationCheck(productId, [branchA], supervisor);
    expect(check.ready).toBe(true);
    expect(check.branches.map((b) => [b.branch_id, b.status])).toEqual([[branchA, 'ready']]);
    expect(check.branches[0]?.setup_items.map((i) => i.inventory_item_id).sort()).toEqual([cup, powder].sort());

    const row = await productsService.publishProduct(productId, branchA, supervisor, null);
    // Unchanged response contract: one availability row for the requested branch.
    expect(row).toMatchObject({ branch_id: branchA, is_available: true });
    expect(await publishedAt(productId)).toEqual([branchA]);

    // Links at A only: cup + powder created at zero; A's potato row is untouched.
    const atA = await stockRows([branchA]);
    expect(atA.map((r) => r.inventoryItemId).sort()).toEqual([potato, cup, powder].sort());
    for (const created of atA.filter((r) => r.inventoryItemId !== potato)) {
      expect(created.quantityOnHand.toNumber()).toBe(0);
      expect(created.quantityReserved.toNumber()).toBe(0);
      expect(created.lowStockThreshold).toBeNull();
      expect(created.criticalThreshold).toBeNull();
      expect(created.unitCost).toBeNull();
    }
    expect((await stockRows([branchA], [potato]))[0]).toEqual(potatoAtABefore);
    // B is selected but was not requested; C is assigned but not selected.
    expect(await stockRows([branchB, branchC])).toEqual([]);
    expect(await prisma.inventoryStockMovement.count({ where: { inventoryItemId: { in: itemIds } } })).toBe(0);

    expect(auditedPairs(await assignmentAudits(productId))).toEqual([`${branchA}:${cup}`, `${branchA}:${powder}`].sort());
    const availabilityAudits = await prisma.auditLog.findMany({
      where: { actorId: supervisor.id, action: 'PRODUCT_BRANCH_AVAILABILITY_CHANGED', branchId: { in: [branchA, branchB] } },
    });
    expect(availabilityAudits.filter((a) => (a.afterState as { productId?: string }).productId === productId).map((a) => a.branchId)).toEqual([branchA]);

    // B now reads as "Ready to add to POS" with its own setup still to do.
    const both = await productsService.getPublicationCheck(productId, [branchA, branchB], supervisor);
    expect(both.branches.map((b) => b.status)).toEqual(['on_pos', 'ready']);
  });

  it('retrying Publish at A adds no links and no assignment audit entries', async () => {
    const rowsBefore = await stockRows([branchA, branchB, branchC]);
    const auditsBefore = (await assignmentAudits(mainProductId)).length;
    await productsService.publishProduct(mainProductId, branchA, supervisor, null);
    expect(await stockRows([branchA, branchB, branchC])).toEqual(rowsBefore);
    expect((await assignmentAudits(mainProductId)).length).toBe(auditsBefore);
    expect(await prisma.branchProductAvailability.count({ where: { productId: mainProductId, branchId: branchA } })).toBe(1);
  });

  it('builder Add to POS then completes B atomically, without touching A', async () => {
    const atABefore = await stockRows([branchA]);
    const result = await productsService.publishProductToBranches(mainProductId, [branchA, branchB], supervisor, null);
    expect(result.setup.stock_links.map((l) => `${l.branch_id}:${l.inventory_item_id}`).sort()).toEqual(
      [potato, cup, powder].map((id) => `${branchB}:${id}`).sort(),
    );
    expect(await stockRows([branchA])).toEqual(atABefore);
    expect(await publishedAt(mainProductId)).toEqual([branchA, branchB].sort());
    expect(await stockRows([branchC])).toEqual([]);
    // Every (branch, item) link was audited exactly once across both paths.
    expect(auditedPairs(await assignmentAudits(mainProductId))).toEqual(
      [`${branchA}:${cup}`, `${branchA}:${powder}`, ...[potato, cup, powder].map((id) => `${branchB}:${id}`)].sort(),
    );
  });

  it('genuine zero stock still refuses checkout at a branch published with fresh zero links', async () => {
    const shiftB = await prisma.shift.create({
      data: { branchId: branchB, cashierId, openedBy: cashierId, status: 'active', openingCashAmount: 0, startedAt: new Date() },
    });
    const before = await stockRows([branchB]);
    await expect(
      transactionsService.createTransaction(
        {
          branchId: branchB,
          shiftId: shiftB.id,
          cashierId,
          items: [{ productId: mainProductId, productVariantId: mainVariantIds[0] ?? '', flavorId, quantity: 1 }],
          paymentMethod: 'cash',
          cashTendered: 100,
          isOfflineTransaction: false,
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(await stockRows([branchB])).toEqual(before);
  });

  describe('invalid configuration blocks both publication paths the same way, without writes', () => {
    async function expectBothBlocked(productId: string, branch: string, code: string) {
      const check = await productsService.getPublicationCheck(productId, [branch], supervisor);
      expect(check.ready).toBe(false);
      expect(check.issues.map((i) => i.code)).toContain(code);

      const single = productsService.publishProduct(productId, branch, supervisor, null);
      await expect(single).rejects.toMatchObject({ code: 'PRODUCT_NOT_READY', statusCode: 409 });
      const singleError = (await single.catch((e: unknown) => e)) as { details: { blocking_issues: { code: string }[] } };
      expect(singleError.details.blocking_issues.map((i) => i.code)).toContain(code);

      const multi = productsService.publishProductToBranches(productId, [branch], supervisor, null);
      await expect(multi).rejects.toMatchObject({ code: 'PRODUCT_NOT_READY', statusCode: 409 });
      const multiError = (await multi.catch((e: unknown) => e)) as { details: { blocking_issues: { code: string }[] } };
      expect(multiError.details.blocking_issues).toEqual(singleError.details.blocking_issues);

      expect(await stockRows([branch])).toEqual([]);
      expect(await publishedAt(productId)).toEqual([]);
      expect(await assignmentAudits(productId)).toEqual([]);
    }

    it('a recipe unit with no conversion to the base unit', async () => {
      const fresh = await makeBranch('K');
      const { productId } = await createProduct('Kg Recipe', [fresh], () => [
        { inventoryItemId: potato, quantityRequired: 0.15, recipeUnitId: kgId, flavorId: null },
      ]);
      await expectBothBlocked(productId, fresh, 'UNIT_CONVERSION_MISSING');
      expect(await prisma.unitConversion.count({ where: { OR: [{ fromUnitId: kgId }, { toUnitId: kgId }] } })).toBe(0);
    });

    it('an empty required choice', async () => {
      const fresh = await makeBranch('R');
      const { productId, variantIds } = await createProduct('Required Choice', [fresh]);
      const group = await prisma.productOptionGroup.create({
        data: { code: `p38r-sauce-${suffix}`, name: 'Sauce', selectionType: 'SINGLE', required: true, minSelections: 1 },
      });
      optionGroupIds.push(group.id);
      await prisma.productOption.create({ data: { optionGroupId: group.id, code: 'old', name: 'Old Sauce', isActive: false } });
      await prisma.productVariantOptionGroup.create({ data: { productVariantId: variantIds[0] ?? '', optionGroupId: group.id } });
      await expectBothBlocked(productId, fresh, 'REQUIRED_CHOICE_EMPTY');
    });

    it('an archived referenced item, which is never linked or revived', async () => {
      const archived = await makeItem('Old Sauce', gramId);
      await prisma.inventoryItem.update({ where: { id: archived }, data: { deletedAt: new Date() } });
      const fresh = await makeBranch('Z');
      const { productId } = await createProduct('Archived Item', [fresh], () => [
        { inventoryItemId: potato, quantityRequired: 150, recipeUnitId: gramId, flavorId: null },
        { inventoryItemId: archived, quantityRequired: 5, recipeUnitId: gramId, flavorId: null },
      ]);
      await expectBothBlocked(productId, fresh, 'INVALID_COMPONENT');
      expect(await prisma.inventoryStock.count({ where: { inventoryItemId: archived } })).toBe(0);
      expect((await prisma.inventoryItem.findUnique({ where: { id: archived } }))?.deletedAt).not.toBeNull();
    });
  });

  describe('authorization failures write nothing', () => {
    it('an unselected branch (assigned to the supervisor) is refused, for scoped and exclusive products', async () => {
      const scoped = await createProduct('Unselected', [branchA, branchB]);
      await expect(productsService.publishProduct(scoped.productId, branchC, supervisor, null)).rejects.toMatchObject({
        code: 'PRODUCT_BRANCH_NOT_SELECTED',
        statusCode: 403,
      });
      // A one-branch builder selection is branch-exclusive.
      const exclusive = await createProduct('Exclusive', [branchA]);
      await expect(productsService.publishProduct(exclusive.productId, branchC, supervisor, null)).rejects.toMatchObject({
        code: 'PRODUCT_BRANCH_EXCLUSIVE',
        statusCode: 403,
      });
      expect(await stockRows([branchC])).toEqual([]);
      expect(await publishedAt(scoped.productId)).toEqual([]);
      expect(await publishedAt(exclusive.productId)).toEqual([]);
    });

    it('a revoked assignment is refused, re-checked live inside the operation', async () => {
      const g = await makeBranch('G');
      const { productId } = await createProduct('Revoked', [g]);
      await prisma.userBranchAssignment.updateMany({ where: { userId: supervisor.id, branchId: g }, data: { removedAt: new Date() } });
      await expect(productsService.publishProduct(productId, g, supervisor, null)).rejects.toMatchObject({
        code: 'BRANCH_ACCESS_DENIED',
        statusCode: 403,
      });
      expect(await stockRows([g])).toEqual([]);
      expect(await publishedAt(productId)).toEqual([]);
      expect(await assignmentAudits(productId)).toEqual([]);
    });

    it('a branch the supervisor was never assigned to is refused', async () => {
      const foreign = await prisma.branch.create({
        data: { name: `P38R Foreign ${suffix}`, code: `P38RF-${suffix}`, address: 'Test', city: 'Test' },
      });
      branchIds.push(foreign.id);
      const { productId } = await createProduct('Foreign', [branchA]);
      await expect(productsService.publishProduct(productId, foreign.id, supervisor, null)).rejects.toMatchObject({ statusCode: 403 });
      expect(await stockRows([foreign.id])).toEqual([]);
      expect(await publishedAt(productId)).toEqual([]);
    });
  });

  it('a concurrent single-branch and multi-branch publish stay consistent: each link exists and is audited once', async () => {
    const m = await makeBranch('M');
    const n = await makeBranch('N');
    const { productId } = await createProduct('Concurrent', [m, n]);

    const [single, multi] = await Promise.allSettled([
      productsService.publishProduct(productId, m, supervisor, null),
      productsService.publishProductToBranches(productId, [m, n], supervisor, null),
    ]);
    expect(single.status).toBe('fulfilled');
    expect(multi.status).toBe('fulfilled');

    expect(await publishedAt(productId)).toEqual([m, n].sort());
    const rows = await stockRows([m, n]);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.quantityOnHand.toNumber() === 0 && r.quantityReserved.toNumber() === 0)).toBe(true);
    expect(auditedPairs(await assignmentAudits(productId))).toEqual(
      [m, n].flatMap((b) => [potato, cup, powder].map((id) => `${b}:${id}`)).sort(),
    );
    expect(await prisma.branchProductAvailability.count({ where: { productId } })).toBe(2);
  });

  it('a failure during the single-branch publish rolls back its setup', async () => {
    const q = await makeBranch('Q');
    const { productId } = await createProduct('Rollback', [q]);
    const spy = vi.spyOn(productsRepository, 'publishBranchProductAvailability').mockRejectedValueOnce(new Error('simulated failure'));
    try {
      await expect(productsService.publishProduct(productId, q, supervisor, null)).rejects.toThrow('simulated failure');
    } finally {
      spy.mockRestore();
    }
    expect(await stockRows([q])).toEqual([]);
    expect(await publishedAt(productId)).toEqual([]);
    expect(await assignmentAudits(productId)).toEqual([]);

    await productsService.publishProduct(productId, q, supervisor, null);
    expect(await publishedAt(productId)).toEqual([q]);
    expect(await stockRows([q])).toHaveLength(3);
  });
});
