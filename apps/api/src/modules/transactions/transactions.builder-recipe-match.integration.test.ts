import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * POS-PERF-P36 §6 — end-to-end inventory match for a Simple Product
 * Builder-style recipe: 150g fries + 1 cup + 2 tissues + 5g of the selected
 * flavor per serving (test fixtures only, per the task spec). Follows
 * transactions.integration.test.ts's CR-004 real-Postgres pattern (same
 * gate, same real transactionsService.createTransaction + background
 * inventoryDeductionService.runCycle drain) rather than inventing a new
 * harness, extended to cover: multi-ingredient exact-match deduction,
 * per-flavor isolation, a shared ingredient summed correctly across two
 * different cart lines in one sale, a non-base-unit recipe authored in a
 * different unit than the item's base unit, insufficient-stock atomicity
 * across every ingredient (not just the short one), and exactly-once
 * background-deduction idempotency on a repeated drain.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const { transactionsService } = await import('./transactions.service.js');
const { inventoryDeductionService } = await import('../inventory-deduction/inventory-deduction.service.js');

describe.skipIf(!canRunIntegrationTests)('Simple Product Builder recipe — end-to-end inventory match (real Postgres)', () => {
  let cashierId: string;
  let gramUnitId: string;
  let pieceUnitId: string;
  let kgUnitId: string;
  let friesId: string;
  let cupId: string;
  let tissueId: string;
  let flavorXPowderId: string;
  let flavorYPowderId: string;
  let flavorX: { id: string };
  let flavorY: { id: string };
  let productId: string;
  let variantId: string; // the fries recipe: 150g fries + 1 cup + 2 tissues + 5g selected flavor
  let cupOnlyVariantId: string; // a second product variant sharing the Cup ingredient
  let kgRecipeVariantId: string; // recipe authored in kg, proving unit conversion to the item's base unit (g)
  const createdBranchIds: string[] = [];

  async function createStockedBranch(stocks: { itemId: string; quantity: number }[]): Promise<{ branchId: string; shiftId: string }> {
    const branch = await prisma.branch.create({
      data: { name: `P36 Branch ${randomUUID()}`, code: `P36-${randomUUID().slice(0, 8)}`, address: '1 Test St', city: 'Testville' },
    });
    createdBranchIds.push(branch.id);
    await prisma.branchProductAvailability.createMany({
      data: [
        { branchId: branch.id, productId, isAvailable: true },
      ],
    });
    await prisma.inventoryStock.createMany({
      data: stocks.map((s) => ({ branchId: branch.id, inventoryItemId: s.itemId, quantityOnHand: s.quantity })),
    });
    const shift = await prisma.shift.create({
      data: { branchId: branch.id, cashierId, openedBy: cashierId, status: 'active', openingCashAmount: 0, startedAt: new Date() },
    });
    return { branchId: branch.id, shiftId: shift.id };
  }

  async function allStockOf(branchId: string, itemIds: string[]) {
    const rows = await prisma.inventoryStock.findMany({ where: { branchId, inventoryItemId: { in: itemIds } } });
    return new Map(rows.map((r) => [r.inventoryItemId, r.quantityOnHand.toNumber()]));
  }

  function stockOf(stock: Map<string, number>, itemId: string): number {
    const value = stock.get(itemId);
    if (value === undefined) throw new Error(`no inventory_stock row for item ${itemId}`);
    return value;
  }

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `p36-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'staff',
        firstName: 'P36',
        lastName: 'Test Cashier',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    cashierId = user.id;

    const gram = await prisma.unitOfMeasure.create({ data: { code: `p36-g-${randomUUID().slice(0, 8)}`, name: 'P36 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    gramUnitId = gram.id;
    const piece = await prisma.unitOfMeasure.create({ data: { code: `p36-pc-${randomUUID().slice(0, 8)}`, name: 'P36 Piece', dimension: 'COUNT', isBaseUnit: true } });
    pieceUnitId = piece.id;
    const kg = await prisma.unitOfMeasure.create({ data: { code: `p36-kg-${randomUUID().slice(0, 8)}`, name: 'P36 Kilogram', dimension: 'WEIGHT' } });
    kgUnitId = kg.id;
    await prisma.unitConversion.create({ data: { fromUnitId: kgUnitId, toUnitId: gramUnitId, factor: 1000 } });

    const fries = await prisma.inventoryItem.create({ data: { name: `P36 Raw Fries ${randomUUID()}`, baseUnitId: gramUnitId } });
    friesId = fries.id;
    const cup = await prisma.inventoryItem.create({ data: { name: `P36 Small Cup ${randomUUID()}`, baseUnitId: pieceUnitId } });
    cupId = cup.id;
    const tissue = await prisma.inventoryItem.create({ data: { name: `P36 Tissue ${randomUUID()}`, baseUnitId: pieceUnitId } });
    tissueId = tissue.id;
    const flavorXPowder = await prisma.inventoryItem.create({ data: { name: `P36 Flavor X Powder ${randomUUID()}`, baseUnitId: gramUnitId } });
    flavorXPowderId = flavorXPowder.id;
    const flavorYPowder = await prisma.inventoryItem.create({ data: { name: `P36 Flavor Y Powder ${randomUUID()}`, baseUnitId: gramUnitId } });
    flavorYPowderId = flavorYPowder.id;

    flavorX = await prisma.flavor.create({ data: { name: `P36 Flavor X ${randomUUID()}`, ingredientName: 'Flavor X Powder', ingredientUnit: 'g' } });
    flavorY = await prisma.flavor.create({ data: { name: `P36 Flavor Y ${randomUUID()}`, ingredientName: 'Flavor Y Powder', ingredientUnit: 'g' } });

    const product = await prisma.product.create({ data: { name: `P36 Cheese Fries ${randomUUID()}`, status: 'active' } });
    productId = product.id;

    const variant = await prisma.productVariant.create({
      data: { productId, name: 'Regular', sizeLabel: 'Regular', basePrice: 100, isActive: true },
    });
    variantId = variant.id;
    await prisma.productVariantFlavor.createMany({
      data: [
        { productVariantId: variantId, flavorId: flavorX.id, isAvailable: true },
        { productVariantId: variantId, flavorId: flavorY.id, isAvailable: true },
      ],
    });
    // Base recipe (flavorId null): 150g fries + 1 cup + 2 tissues per serving.
    await prisma.productComponent.createMany({
      data: [
        { productVariantId: variantId, inventoryItemId: friesId, quantityRequired: 150, recipeUnitId: gramUnitId },
        { productVariantId: variantId, inventoryItemId: cupId, quantityRequired: 1, recipeUnitId: pieceUnitId },
        { productVariantId: variantId, inventoryItemId: tissueId, quantityRequired: 2, recipeUnitId: pieceUnitId },
      ],
    });
    // Flavor-specific: 5g of whichever flavor powder is selected.
    await prisma.productComponent.createMany({
      data: [
        { productVariantId: variantId, inventoryItemId: flavorXPowderId, quantityRequired: 5, recipeUnitId: gramUnitId, flavorId: flavorX.id },
        { productVariantId: variantId, inventoryItemId: flavorYPowderId, quantityRequired: 5, recipeUnitId: gramUnitId, flavorId: flavorY.id },
      ],
    });

    // A second variant on the SAME product, sharing the Cup ingredient, to
    // prove a shared ingredient across two different cart lines in one sale
    // deducts additively rather than one line overwriting the other.
    const cupOnlyVariant = await prisma.productVariant.create({
      data: { productId, name: 'Cup Only', sizeLabel: 'Small', basePrice: 20, isActive: true },
    });
    cupOnlyVariantId = cupOnlyVariant.id;
    await prisma.productComponent.create({
      data: { productVariantId: cupOnlyVariantId, inventoryItemId: cupId, quantityRequired: 1, recipeUnitId: pieceUnitId },
    });

    // A third variant whose fries quantity is authored in kg (0.15kg), not
    // the item's base unit (g) — proving convertQuantity resolves it to the
    // same 150g via the UnitConversion row created above.
    const kgRecipeVariant = await prisma.productVariant.create({
      data: { productId, name: 'Kg Recipe', sizeLabel: 'Regular', basePrice: 100, isActive: true },
    });
    kgRecipeVariantId = kgRecipeVariant.id;
    await prisma.productComponent.create({
      data: { productVariantId: kgRecipeVariantId, inventoryItemId: friesId, quantityRequired: 0.15, recipeUnitId: kgUnitId },
    });
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "transaction_items" WHERE "transaction_id" IN (SELECT id FROM "transactions" WHERE "cashier_id" = ${cashierId})`;
    await prisma.$executeRaw`DELETE FROM "transactions" WHERE "cashier_id" = ${cashierId}`;
    await prisma.$executeRaw`DELETE FROM "inventory_stock_movements" WHERE "inventory_item_id" IN (${friesId}, ${cupId}, ${tissueId}, ${flavorXPowderId}, ${flavorYPowderId})`;
    await prisma.branchProductAvailability.deleteMany({ where: { productId } });
    await prisma.shift.deleteMany({ where: { cashierId } });
    await prisma.productComponent.deleteMany({ where: { productVariantId: { in: [variantId, cupOnlyVariantId, kgRecipeVariantId] } } });
    await prisma.productVariantFlavor.deleteMany({ where: { productVariantId: variantId } });
    await prisma.inventoryStock.deleteMany({ where: { inventoryItemId: { in: [friesId, cupId, tissueId, flavorXPowderId, flavorYPowderId] } } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.branch.deleteMany({ where: { id: { in: createdBranchIds } } });
    await prisma.flavor.deleteMany({ where: { id: { in: [flavorX.id, flavorY.id] } } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: [friesId, cupId, tissueId, flavorXPowderId, flavorYPowderId] } } });
    await prisma.unitConversion.deleteMany({ where: { fromUnitId: kgUnitId } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: { in: [gramUnitId, pieceUnitId, kgUnitId] } } });
    await prisma.user.deleteMany({ where: { id: cashierId } });
    await prisma.$disconnect();
  });

  it('3 servings of one flavor deduct exactly 450g fries, 3 cups, 6 tissues, and 15g of that flavor — the other flavor is untouched', async () => {
    const { branchId, shiftId } = await createStockedBranch([
      { itemId: friesId, quantity: 10_000 },
      { itemId: cupId, quantity: 100 },
      { itemId: tissueId, quantity: 100 },
      { itemId: flavorXPowderId, quantity: 1000 },
      { itemId: flavorYPowderId, quantity: 1000 },
    ]);

    const before = await allStockOf(branchId, [friesId, cupId, tissueId, flavorXPowderId, flavorYPowderId]);

    const result = await transactionsService.createTransaction(
      {
        branchId,
        shiftId,
        cashierId,
        items: [{ productId, productVariantId: variantId, flavorId: flavorX.id, quantity: 3 }],
        paymentMethod: 'cash',
        cashTendered: 300,
        isOfflineTransaction: false,
      },
      null,
    );
    expect(result.status).toBe('completed');

    await inventoryDeductionService.runCycle(10);

    const after = await allStockOf(branchId, [friesId, cupId, tissueId, flavorXPowderId, flavorYPowderId]);
    expect(stockOf(before, friesId) - stockOf(after, friesId)).toBe(450);
    expect(stockOf(before, cupId) - stockOf(after, cupId)).toBe(3);
    expect(stockOf(before, tissueId) - stockOf(after, tissueId)).toBe(6);
    expect(stockOf(before, flavorXPowderId) - stockOf(after, flavorXPowderId)).toBe(15);
    expect(after.get(flavorYPowderId)).toBe(before.get(flavorYPowderId)); // untouched

    const movements = await prisma.inventoryStockMovement.findMany({ where: { referenceId: result.id, movementType: 'SALE' } });
    expect(movements.map((m) => m.inventoryItemId).sort()).toEqual([cupId, flavorXPowderId, friesId, tissueId].sort());
  });

  it('a shared ingredient (Cup) across two different cart lines in one sale deducts additively, not overwritten', async () => {
    const { branchId, shiftId } = await createStockedBranch([
      { itemId: friesId, quantity: 10_000 },
      { itemId: cupId, quantity: 100 },
      { itemId: tissueId, quantity: 100 },
      { itemId: flavorXPowderId, quantity: 1000 },
      { itemId: flavorYPowderId, quantity: 1000 },
    ]);
    // cupOnlyVariantId also needs branch availability (createStockedBranch only seeds the parent productId's row, which both variants share).

    const before = await allStockOf(branchId, [cupId]);

    const result = await transactionsService.createTransaction(
      {
        branchId,
        shiftId,
        cashierId,
        items: [
          { productId, productVariantId: variantId, flavorId: flavorY.id, quantity: 3 }, // 3 cups
          { productId, productVariantId: cupOnlyVariantId, quantity: 2 }, // 2 cups
        ],
        paymentMethod: 'cash',
        cashTendered: 1000,
        isOfflineTransaction: false,
      },
      null,
    );
    expect(result.status).toBe('completed');

    await inventoryDeductionService.runCycle(10);

    const after = await allStockOf(branchId, [cupId]);
    expect(stockOf(before, cupId) - stockOf(after, cupId)).toBe(5); // 3 + 2, summed correctly across both lines
  });

  it('a recipe authored in kg (0.15kg) resolves through UnitConversion to the same 150g deduction as the gram-authored recipe', async () => {
    const { branchId, shiftId } = await createStockedBranch([{ itemId: friesId, quantity: 10_000 }]);
    const before = await allStockOf(branchId, [friesId]);

    await transactionsService.createTransaction(
      {
        branchId,
        shiftId,
        cashierId,
        items: [{ productId, productVariantId: kgRecipeVariantId, quantity: 1 }],
        paymentMethod: 'cash',
        cashTendered: 100,
        isOfflineTransaction: false,
      },
      null,
    );
    await inventoryDeductionService.runCycle(10);

    const after = await allStockOf(branchId, [friesId]);
    expect(stockOf(before, friesId) - stockOf(after, friesId)).toBe(150);
  });

  it('insufficient stock on just one ingredient (Cup) rejects the whole sale — no Transaction and no movement row for ANY ingredient', async () => {
    const { branchId, shiftId } = await createStockedBranch([
      { itemId: friesId, quantity: 10_000 },
      { itemId: cupId, quantity: 2 }, // needs 3
      { itemId: tissueId, quantity: 100 },
      { itemId: flavorXPowderId, quantity: 1000 },
      { itemId: flavorYPowderId, quantity: 1000 },
    ]);

    await expect(
      transactionsService.createTransaction(
        {
          branchId,
          shiftId,
          cashierId,
          items: [{ productId, productVariantId: variantId, flavorId: flavorX.id, quantity: 3 }],
          paymentMethod: 'cash',
          cashTendered: 300,
          isOfflineTransaction: false,
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    expect(await prisma.transaction.count({ where: { branchId } })).toBe(0);
    const after = await allStockOf(branchId, [friesId, cupId, tissueId, flavorXPowderId]);
    expect(after.get(friesId)).toBe(10_000); // fries untouched even though it had plenty of stock
    expect(after.get(cupId)).toBe(2);
    const movementCount = await prisma.inventoryStockMovement.count({ where: { branchId, movementType: 'SALE' } });
    expect(movementCount).toBe(0);
  });

  it('draining the background deduction cycle twice deducts exactly once — the second drain is a no-op', async () => {
    const { branchId, shiftId } = await createStockedBranch([
      { itemId: friesId, quantity: 10_000 },
      { itemId: cupId, quantity: 100 },
      { itemId: tissueId, quantity: 100 },
      { itemId: flavorXPowderId, quantity: 1000 },
      { itemId: flavorYPowderId, quantity: 1000 },
    ]);

    const result = await transactionsService.createTransaction(
      {
        branchId,
        shiftId,
        cashierId,
        items: [{ productId, productVariantId: variantId, flavorId: flavorX.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashTendered: 100,
        isOfflineTransaction: false,
      },
      null,
    );

    await inventoryDeductionService.runCycle(10);
    const afterFirstDrain = await allStockOf(branchId, [friesId]);

    await inventoryDeductionService.runCycle(10); // same job, already completed — must not deduct again
    const afterSecondDrain = await allStockOf(branchId, [friesId]);

    expect(afterSecondDrain.get(friesId)).toBe(afterFirstDrain.get(friesId));
    const movementCount = await prisma.inventoryStockMovement.count({ where: { referenceId: result.id, inventoryItemId: friesId, movementType: 'SALE' } });
    expect(movementCount).toBe(1);
  });
});
