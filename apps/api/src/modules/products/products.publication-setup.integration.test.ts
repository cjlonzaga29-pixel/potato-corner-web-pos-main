import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createProductSchema } from '@potato-corner/shared';

/**
 * POS-PERF-P38 — Add to POS performs the selected branches' setup itself,
 * against real Postgres. The recipe items here are created with no
 * InventoryStock rows anywhere (the reported state: a valid shared item
 * that was never linked to the newly selected branches) — no fixture
 * pre-links them. Covers the publication plan Review reads, the automatic
 * zero-stock links (selected branches only, never existing balances), repeat
 * safety, genuine configuration blockers, authorization and rollback, and
 * that checkout still deducts only the selling branch.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { productsService } = await import('./products.service.js');
const { productsRepository } = await import('./products.repository.js');
const { productReadinessService } = await import('../product-readiness/product-readiness.service.js');
const { transactionsService } = await import('../transactions/transactions.service.js');
const { inventoryDeductionService } = await import('../inventory-deduction/inventory-deduction.service.js');

type Actor = { id: string; role: string };

describe.skipIf(!isLocalDatabase)('POS-PERF-P38 automatic selected-branch setup (real Postgres)', () => {
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
      data: { name: `P38 Branch ${label} ${suffix}`, code: `P38${label}-${suffix}`, address: 'Test', city: 'Test' },
    });
    branchIds.push(branch.id);
    await prisma.userBranchAssignment.create({ data: { userId: supervisor.id, branchId: branch.id } });
    return branch.id;
  }

  async function makeItem(label: string, baseUnitId: string) {
    const item = await prisma.inventoryItem.create({ data: { name: `P38 ${label} ${suffix}`, baseUnitId } });
    itemIds.push(item.id);
    return item.id;
  }

  /** A complete builder product (two sizes, base + flavor-specific recipe, one flavor), created through the real service. */
  async function createProduct(label: string, selection: string[], components = () => [
    { inventoryItemId: potato, quantityRequired: 150, recipeUnitId: gramId, flavorId: null as string | null },
    { inventoryItemId: cup, quantityRequired: 1, recipeUnitId: pieceId, flavorId: null as string | null },
    { inventoryItemId: powder, quantityRequired: 5, recipeUnitId: gramId, flavorId: flavorId as string | null },
  ]) {
    const created = await productsService.createProduct(
      createProductSchema.parse({ name: `P38 ${label} ${suffix}`, status: 'active', branch_ids: selection }),
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
    return prisma.inventoryStock.findMany({ where: { branchId: { in: branches }, inventoryItemId: { in: items } }, orderBy: [{ branchId: 'asc' }, { inventoryItemId: 'asc' }] });
  }

  async function publishedAt(productId: string) {
    return (await prisma.branchProductAvailability.findMany({ where: { productId, isAvailable: true } })).map((r) => r.branchId).sort();
  }

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'P38', lastName: 'Sup', employmentType: 'regular', email: `p38-sup-${suffix}@test.local` },
    });
    userIds.push(user.id);
    supervisor = { id: user.id, role: 'supervisor' };
    const cashier = await prisma.user.create({
      data: { role: 'staff', firstName: 'P38', lastName: 'Cashier', employmentType: 'regular', email: `p38-cashier-${suffix}@test.local`, mustChangePassword: false },
    });
    userIds.push(cashier.id);
    cashierId = cashier.id;

    const gram = await prisma.unitOfMeasure.create({ data: { code: `p38-g-${suffix}`, name: 'P38 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    const piece = await prisma.unitOfMeasure.create({ data: { code: `p38-pc-${suffix}`, name: 'P38 Piece', dimension: 'COUNT', isBaseUnit: true } });
    // Same dimension as gram, deliberately with no UnitConversion row.
    const kg = await prisma.unitOfMeasure.create({ data: { code: `p38-kg-${suffix}`, name: 'P38 Kilogram', dimension: 'WEIGHT' } });
    gramId = gram.id;
    pieceId = piece.id;
    kgId = kg.id;
    unitIds.push(gramId, pieceId, kgId);

    potato = await makeItem('Potato', gramId);
    cup = await makeItem('Cup', pieceId);
    powder = await makeItem('Cheese Powder', gramId);
    const flavor = await prisma.flavor.create({ data: { name: `P38 Cheese ${suffix}`, ingredientName: 'Cheese Powder', ingredientUnit: 'g' } });
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

  it('Review: a complete unpublished A+B product is ready to add, with missing links shown as automatic setup — no "enable this product first" blocker', async () => {
    const { productId, variantIds } = await createProduct('Cheese Fries', [branchA, branchB]);
    mainProductId = productId;
    mainVariantIds = variantIds;
    potatoAtABefore = (await stockRows([branchA], [potato]))[0];
    const rowsBefore = await prisma.inventoryStock.count({ where: { inventoryItemId: { in: itemIds } } });

    const check = await productsService.getPublicationCheck(productId, [branchA, branchB], supervisor);
    expect(check.ready).toBe(true);
    expect(check.issues).toEqual([]);
    expect(check.branches.map((b) => b.status)).toEqual(['ready', 'ready']);
    expect(JSON.stringify(check)).not.toContain('BRANCH_NOT_AVAILABLE');
    const setupA = check.branches.find((b) => b.branch_id === branchA)?.setup_items.map((i) => i.inventory_item_id).sort();
    const setupB = check.branches.find((b) => b.branch_id === branchB)?.setup_items.map((i) => i.inventory_item_id).sort();
    expect(setupA).toEqual([cup, powder].sort()); // A already stocks potato
    expect(setupB).toEqual([potato, cup, powder].sort());

    // The check is a read: nothing was written.
    expect(await prisma.inventoryStock.count({ where: { inventoryItemId: { in: itemIds } } })).toBe(rowsBefore);
    // Readiness itself is unchanged: it still reports the missing link and the unpublished state (checkout relies on it).
    const readiness = await productReadinessService.evaluateProductReadiness({ productId, branchId: branchB });
    expect(readiness.blockingIssues.map((i) => i.code)).toEqual(expect.arrayContaining(['BRANCH_NOT_AVAILABLE', 'INVENTORY_STOCK_MISSING']));
  });

  it('Add to POS creates the needed links only at A and B (never C), at zero, without touching existing balances, then publishes both', async () => {
    const result = await productsService.publishProductToBranches(mainProductId, [branchA, branchB], supervisor, null);
    expect(result.branches.every((b) => b.is_available)).toBe(true);
    expect(await publishedAt(mainProductId)).toEqual([branchA, branchB].sort());
    expect(result.setup.stock_links).toHaveLength(5);

    const created = (await stockRows([branchA, branchB])).filter((r) => !(r.branchId === branchA && r.inventoryItemId === potato));
    expect(created).toHaveLength(5);
    for (const row of created) {
      expect(row.quantityOnHand.toNumber()).toBe(0);
      expect(row.quantityReserved.toNumber()).toBe(0);
      expect(row.lowStockThreshold).toBeNull();
      expect(row.criticalThreshold).toBeNull();
      expect(row.unitCost).toBeNull();
    }
    // The pre-existing row is byte-for-byte unchanged.
    expect((await stockRows([branchA], [potato]))[0]).toEqual(potatoAtABefore);
    // C is assigned to the same supervisor but was not selected.
    expect(await stockRows([branchC])).toEqual([]);
    // No receipts, movements, or deductions as a side effect.
    expect(await prisma.inventoryStockMovement.count({ where: { inventoryItemId: { in: itemIds } } })).toBe(0);

    const audit = await prisma.auditLog.findMany({ where: { actorId: supervisor.id, action: 'INVENTORY_ITEM_BRANCH_ASSIGNED' } });
    expect(audit.map((a) => a.entityId).sort()).toEqual([potato, cup, powder].sort());

    expect(JSON.stringify(await productsService.getPosCatalog(branchA))).toContain(mainProductId);
    expect(JSON.stringify(await productsService.getPosCatalog(branchB))).toContain(mainProductId);
    expect(JSON.stringify(await productsService.getPosCatalog(branchC))).not.toContain(mainProductId);
  });

  it('repeating Add to POS creates no duplicate rows and reports no new setup', async () => {
    const before = await stockRows([branchA, branchB, branchC]);
    const again = await productsService.publishProductToBranches(mainProductId, [branchB, branchA, branchA], supervisor, null);
    expect(again.setup.stock_links).toEqual([]);
    expect(await stockRows([branchA, branchB, branchC])).toEqual(before);
    expect(await prisma.branchProductAvailability.count({ where: { productId: mainProductId } })).toBe(2);
    const check = await productsService.getPublicationCheck(mainProductId, [branchA, branchB], supervisor);
    expect(check.branches.map((b) => b.status)).toEqual(['on_pos', 'on_pos']);
  });

  it('zero stock is not missing setup: a second product on the same items is ready with nothing to set up', async () => {
    const { productId } = await createProduct('Zero Stock', [branchA, branchB]);
    const check = await productsService.getPublicationCheck(productId, [branchA, branchB], supervisor);
    expect(check.ready).toBe(true);
    expect(check.branches.every((b) => b.status === 'ready' && b.setup_items.length === 0 && b.issues.length === 0)).toBe(true);
  });

  it('checkout at A deducts only A inventory; B (zero stock) refuses the sale; B and C stay unchanged', async () => {
    // A delivery at A (test fixture) so A can sell; B keeps its zero rows.
    await prisma.inventoryStock.updateMany({ where: { branchId: branchA, inventoryItemId: { in: [cup, powder] } }, data: { quantityOnHand: 100 } });
    const shiftA = await prisma.shift.create({ data: { branchId: branchA, cashierId, openedBy: cashierId, status: 'active', openingCashAmount: 0, startedAt: new Date() } });
    const before = await stockRows([branchA, branchB, branchC]);

    const sale = await transactionsService.createTransaction(
      {
        branchId: branchA,
        shiftId: shiftA.id,
        cashierId,
        items: [{ productId: mainProductId, productVariantId: mainVariantIds[0] ?? '', flavorId, quantity: 2 }],
        paymentMethod: 'cash',
        cashTendered: 200,
        isOfflineTransaction: false,
      },
      null,
    );
    expect(sale.status).toBe('completed');
    await inventoryDeductionService.runCycle(10);

    const after = await stockRows([branchA, branchB, branchC]);
    const qty = (rows: typeof after, branchId: string, itemId: string) =>
      rows.find((r) => r.branchId === branchId && r.inventoryItemId === itemId)?.quantityOnHand.toNumber();
    expect(qty(after, branchA, potato)).toBe((qty(before, branchA, potato) ?? 0) - 300);
    expect(qty(after, branchA, cup)).toBe(98);
    expect(qty(after, branchA, powder)).toBe(90);
    expect(after.filter((r) => r.branchId !== branchA)).toEqual(before.filter((r) => r.branchId !== branchA));

    const shiftB = await prisma.shift.create({ data: { branchId: branchB, cashierId, openedBy: cashierId, status: 'active', openingCashAmount: 0, startedAt: new Date() } });
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
    expect(await stockRows([branchB, branchC])).toEqual(after.filter((r) => r.branchId !== branchA));
  });

  it('an archived recipe item stays an actionable error: nothing is linked, published, or revived', async () => {
    const archived = await makeItem('Old Sauce', gramId);
    await prisma.inventoryItem.update({ where: { id: archived }, data: { deletedAt: new Date() } });
    const fresh = await makeBranch('D');
    const { productId } = await createProduct('Archived Item', [branchA, fresh], () => [
      { inventoryItemId: potato, quantityRequired: 150, recipeUnitId: gramId, flavorId: null },
      { inventoryItemId: archived, quantityRequired: 5, recipeUnitId: gramId, flavorId: null },
    ]);

    const check = await productsService.getPublicationCheck(productId, [branchA, fresh], supervisor);
    expect(check.ready).toBe(false);
    expect(check.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'INVALID_COMPONENT', fix_step: 'ingredients' })]));
    expect(check.branches.every((b) => b.status === 'missing_setup')).toBe(true);

    await expect(productsService.publishProductToBranches(productId, [branchA, fresh], supervisor, null)).rejects.toMatchObject({
      code: 'PRODUCT_NOT_READY',
      statusCode: 409,
    });
    expect(await stockRows([fresh])).toEqual([]);
    expect(await prisma.inventoryStock.count({ where: { inventoryItemId: archived } })).toBe(0);
    expect((await prisma.inventoryItem.findUnique({ where: { id: archived } }))?.deletedAt).not.toBeNull();
    expect(await publishedAt(productId)).toEqual([]);
  });

  it('a recipe unit with no conversion to the base unit blocks with an actionable error; no conversion is invented', async () => {
    const fresh = await makeBranch('E');
    const { productId } = await createProduct('Kg Recipe', [branchA, fresh], () => [
      { inventoryItemId: potato, quantityRequired: 0.15, recipeUnitId: kgId, flavorId: null },
    ]);

    const check = await productsService.getPublicationCheck(productId, [branchA, fresh], supervisor);
    expect(check.ready).toBe(false);
    const issue = check.issues.find((i) => i.code === 'UNIT_CONVERSION_MISSING');
    expect(issue).toMatchObject({ fix_step: 'ingredients' });
    expect(issue?.message).toContain(`p38-kg-${suffix}`);

    await expect(productsService.publishProductToBranches(productId, [branchA, fresh], supervisor, null)).rejects.toMatchObject({ code: 'PRODUCT_NOT_READY' });
    expect(await stockRows([fresh])).toEqual([]);
    expect(await prisma.unitConversion.count({ where: { OR: [{ fromUnitId: kgId }, { toUnitId: kgId }] } })).toBe(0);
    expect(await prisma.inventoryItemUnitConversion.count({ where: { inventoryItemId: potato } })).toBe(0);

    // Once a supervisor adds the conversion, the same product is ready.
    await prisma.inventoryItemUnitConversion.create({ data: { inventoryItemId: potato, fromUnitId: kgId, toUnitId: gramId, factor: 1000 } });
    expect((await productsService.getPublicationCheck(productId, [branchA, fresh], supervisor)).ready).toBe(true);
  });

  it('a genuinely incomplete recipe or an empty required choice still blocks publication', async () => {
    const created = await productsService.createProduct(
      createProductSchema.parse({ name: `P38 Incomplete ${suffix}`, status: 'active', branch_ids: [branchA, branchB] }),
      supervisor,
      null,
    );
    const variant = await prisma.productVariant.create({
      data: { productId: created.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 50, isActive: true, lifecycleStatus: 'ACTIVE' },
    });
    const group = await prisma.productOptionGroup.create({
      data: { code: `p38-sauce-${suffix}`, name: 'Sauce', selectionType: 'SINGLE', required: true, minSelections: 1 },
    });
    optionGroupIds.push(group.id);
    await prisma.productOption.create({ data: { optionGroupId: group.id, code: 'old', name: 'Old Sauce', isActive: false } });
    await prisma.productVariantOptionGroup.create({ data: { productVariantId: variant.id, optionGroupId: group.id } });

    const check = await productsService.getPublicationCheck(created.id, [branchA, branchB], supervisor);
    expect(check.ready).toBe(false);
    expect(check.issues.map((i) => [i.code, i.fix_step])).toEqual(
      expect.arrayContaining([
        ['RECIPE_MISSING', 'ingredients'],
        ['REQUIRED_CHOICE_EMPTY', 'choices'],
      ]),
    );
    await expect(productsService.publishProductToBranches(created.id, [branchA, branchB], supervisor, null)).rejects.toMatchObject({ code: 'PRODUCT_NOT_READY' });
    expect(await publishedAt(created.id)).toEqual([]);
  });

  it('a flavor turned off at one branch is a notice, not missing setup', async () => {
    const fresh = await makeBranch('F');
    await prisma.branchFlavorAvailability.create({ data: { branchId: fresh, flavorId, isAvailable: false } });
    const { productId } = await createProduct('Flavor Off', [branchA, fresh]);
    const check = await productsService.getPublicationCheck(productId, [branchA, fresh], supervisor);
    expect(check.ready).toBe(true);
    const freshPlan = check.branches.find((b) => b.branch_id === fresh);
    expect(freshPlan?.status).toBe('ready');
    expect(freshPlan?.notices.join(' ')).toContain('turned off');
  });

  it('a revoked branch rejects the whole operation without partial setup or publication', async () => {
    const g = await makeBranch('G');
    const h = await makeBranch('H');
    const { productId } = await createProduct('Revoked', [g, h]);
    await prisma.userBranchAssignment.updateMany({ where: { userId: supervisor.id, branchId: h }, data: { removedAt: new Date() } });

    await expect(productsService.getPublicationCheck(productId, [g, h], supervisor)).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED', statusCode: 403 });
    await expect(productsService.publishProductToBranches(productId, [g, h], supervisor, null)).rejects.toMatchObject({
      code: 'BRANCH_ACCESS_DENIED',
      statusCode: 403,
    });
    expect(await stockRows([g, h])).toEqual([]);
    expect(await publishedAt(productId)).toEqual([]);
  });

  it('a failure at one branch rolls back the entire operation, including setup already done at the other', async () => {
    const i = await makeBranch('I');
    const j = await makeBranch('J');
    const { productId } = await createProduct('Rollback', [i, j]);

    const original = productsRepository.upsertBranchProductAvailability.bind(productsRepository);
    const spy = vi.spyOn(productsRepository, 'upsertBranchProductAvailability').mockImplementation(async (branchId, ...rest) => {
      if (branchId === j) throw new Error('simulated failure at branch J');
      return original(branchId, ...rest);
    });
    try {
      await expect(productsService.publishProductToBranches(productId, [i, j], supervisor, null)).rejects.toThrow('simulated failure at branch J');
    } finally {
      spy.mockRestore();
    }
    expect(await stockRows([i, j])).toEqual([]);
    expect(await publishedAt(productId)).toEqual([]);

    // The same request succeeds afterwards.
    await productsService.publishProductToBranches(productId, [i, j], supervisor, null);
    expect(await publishedAt(productId)).toEqual([i, j].sort());
    expect(await stockRows([i, j])).toHaveLength(6);
  });
});
