import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * P46R2 — checkout enforces each product option group's required choice and
 * configured minimum against the live catalog, at the level the POS actually
 * builds cart lines (see resolveSelectedOptions in transactions.service.ts):
 *
 *  - a folded group (SINGLE, two or more MULTIPLE groups, an optional
 *    MULTIPLE group) carries all its picks on the one line, so the line must
 *    hold at least max(min_selections, required ? 1 : 0);
 *  - a lone required MULTIPLE group is a serving count (Task 182): the POS
 *    splits it one pick per unit, so each line must hold at least one;
 *  - an "Add-ons"-named group is optional whatever its flags (Task 131).
 *
 * Every payload below that is expected to succeed is shaped exactly like one
 * the current POS terminal (apps/web .../terminal/page.tsx#handleAddOnsConfirm)
 * produces. Rejections must leave nothing behind: no Transaction, no
 * InventoryDeductionJob, no reservation, no stock movement.
 *
 * Requires TEST_DATABASE_URL pointing at a disposable, migrated database.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const { transactionsService } = await import('./transactions.service.js');
const { inventoryDeductionService } = await import('../inventory-deduction/inventory-deduction.service.js');

interface OptionSpec {
  name: string;
  price?: number;
  isActive?: boolean;
  /** grams of `mapTo` deducted per occurrence */
  grams?: number;
  mapTo?: string;
}

interface GroupSpec {
  name: string;
  selectionType: 'SINGLE' | 'MULTIPLE';
  required?: boolean;
  minSelections?: number;
  maxSelections?: number | null;
  isActive?: boolean;
  /** ProductVariantOptionGroup.required override (null = inherit the group's) */
  assignmentRequired?: boolean | null;
  options: OptionSpec[];
}

describe.skipIf(!canRunIntegrationTests)('transactions integration — option group requirements (P46R2)', () => {
  const tag = randomUUID().slice(0, 8);
  let cashierId: string;
  let unitId: string;
  let branchId: string;
  let shiftId: string;
  const itemIds: Record<string, string> = {};
  const productIds: string[] = [];
  const groupIds: string[] = [];
  const flavorIds: string[] = [];
  /** product key -> { productId, variantId, options: option name -> id } */
  const catalog: Record<string, { productId: string; variantId: string; options: Record<string, string> }> = {};

  async function createProduct(key: string, groups: GroupSpec[], recipeGrams = 100) {
    const product = await prisma.product.create({ data: { name: `P46R2 ${key} ${tag}`, status: 'active' } });
    productIds.push(product.id);
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 100, isActive: true },
    });
    await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: itemIds.potato as string, quantityRequired: recipeGrams } });
    await prisma.branchProductAvailability.create({ data: { branchId, productId: product.id, isAvailable: true } });
    const options: Record<string, string> = {};
    for (const spec of groups) {
      const group = await prisma.productOptionGroup.create({
        data: {
          code: `p46r2-${tag}-${randomUUID().slice(0, 8)}`,
          name: spec.name,
          selectionType: spec.selectionType,
          required: spec.required ?? false,
          minSelections: spec.minSelections ?? 0,
          maxSelections: spec.maxSelections ?? null,
          isActive: spec.isActive ?? true,
        },
      });
      groupIds.push(group.id);
      for (const optionSpec of spec.options) {
        const option = await prisma.productOption.create({
          data: {
            optionGroupId: group.id,
            code: `${optionSpec.name.toLowerCase().replace(/\W+/g, '-')}-${randomUUID().slice(0, 6)}`,
            name: optionSpec.name,
            priceAdjustment: optionSpec.price ?? 0,
            isActive: optionSpec.isActive ?? true,
          },
        });
        options[optionSpec.name] = option.id;
        if (optionSpec.mapTo) {
          await prisma.productOptionInventoryMapping.create({
            data: { productOptionId: option.id, inventoryItemId: itemIds[optionSpec.mapTo] as string, quantityRequired: optionSpec.grams ?? 0, deductionUnitId: unitId },
          });
        }
      }
      await prisma.productVariantOptionGroup.create({
        data: { productVariantId: variant.id, optionGroupId: group.id, required: spec.assignmentRequired ?? null },
      });
    }
    catalog[key] = { productId: product.id, variantId: variant.id, options };
    return { productId: product.id, variantId: variant.id };
  }

  function line(key: string, optionNames: string[], quantity = 1, extra: Record<string, unknown> = {}) {
    const entry = catalog[key];
    if (!entry) throw new Error(`unknown product ${key}`);
    return {
      productId: entry.productId,
      productVariantId: entry.variantId,
      quantity,
      ...(optionNames.length > 0
        ? {
            selectedOptionIds: optionNames.map((name) => {
              const id = entry.options[name] ?? Object.values(catalog).find((other) => other.options[name])?.options[name];
              if (!id) throw new Error(`unknown option ${name}`);
              return id;
            }),
          }
        : {}),
      ...extra,
    };
  }

  function sale(items: ReturnType<typeof line>[], idempotencyKey: string | null = null) {
    return transactionsService.createTransaction(
      { branchId, shiftId, cashierId, items, paymentMethod: 'cash', cashTendered: 5000, isOfflineTransaction: false, idempotencyKey },
      null,
    );
  }

  async function snapshot() {
    const [transactions, jobs, movements, stocks] = await Promise.all([
      prisma.transaction.count({ where: { branchId } }),
      prisma.inventoryDeductionJob.count({ where: { branchId } }),
      prisma.inventoryStockMovement.count({ where: { branchId } }),
      prisma.inventoryStock.findMany({ where: { branchId }, orderBy: { inventoryItemId: 'asc' } }),
    ]);
    return {
      transactions,
      jobs,
      movements,
      stock: stocks.map((s) => ({ item: s.inventoryItemId, onHand: s.quantityOnHand.toNumber(), reserved: s.quantityReserved.toNumber() })),
    };
  }

  async function onHand(item: string) {
    const row = await prisma.inventoryStock.findUniqueOrThrow({
      where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemIds[item] as string } },
    });
    return row.quantityOnHand.toNumber();
  }

  /** Asserts the request is refused with `code` and leaves no trace of a sale. */
  async function expectRejectedWithoutTrace(items: ReturnType<typeof line>[], code: string) {
    const before = await snapshot();
    const idempotencyKey = randomUUID();
    await expect(sale(items, idempotencyKey)).rejects.toMatchObject({ code, statusCode: 422 });
    expect(await snapshot()).toEqual(before);
    // The fencing row ends 'failed', which is what lets the POS retry the corrected cart under a new key.
    const attempt = await prisma.checkoutAttempt.findUnique({ where: { idempotencyKey } });
    expect(attempt?.status).toBe('failed');
  }

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `p46r2-${tag}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'staff',
        firstName: 'P46R2',
        lastName: 'Cashier',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    cashierId = user.id;
    const unit = await prisma.unitOfMeasure.create({ data: { code: `p46r2-g-${tag}`, name: 'P46R2 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    unitId = unit.id;
    const branch = await prisma.branch.create({
      data: { name: `P46R2 Branch ${tag}`, code: `P46R2-${tag}`, address: '1 Test St', city: 'Testville' },
    });
    branchId = branch.id;
    for (const name of ['potato', 'garlicMayo', 'cheeseDip', 'snack', 'box']) {
      const item = await prisma.inventoryItem.create({ data: { name: `P46R2 ${name} ${tag}`, baseUnitId: unitId } });
      itemIds[name] = item.id;
      await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: item.id, quantityOnHand: 10000 } });
    }
    const shift = await prisma.shift.create({
      data: { branchId, cashierId, openedBy: cashierId, status: 'active', openingCashAmount: 0, startedAt: new Date() },
    });
    shiftId = shift.id;

    // Required single choice + optional extras (max 2) + a *required*
    // "Add-ons" group (optional by Task 131) + a deactivated group.
    await createProduct('fries', [
      {
        name: 'Seasoning',
        selectionType: 'SINGLE',
        required: true,
        maxSelections: 1,
        options: [{ name: 'BBQ' }, { name: 'Cheese' }, { name: 'Sour Cream', isActive: false }],
      },
      { name: 'Extra Dips', selectionType: 'MULTIPLE', maxSelections: 2, options: [{ name: 'Garlic Mayo', price: 10, mapTo: 'garlicMayo', grams: 15 }] },
      { name: 'Add-ons', selectionType: 'MULTIPLE', required: true, minSelections: 1, maxSelections: 2, options: [{ name: 'Cheese Dip', price: 20, mapTo: 'cheeseDip', grams: 30 }] },
      { name: 'Old Sauces', selectionType: 'MULTIPLE', isActive: false, options: [{ name: 'Old Dip' }] },
    ]);
    // Lone required MULTIPLE — serving count (Task 182): "exactly 2" adds two cups, one topping each.
    await createProduct('cup', [
      {
        name: 'Toppings',
        selectionType: 'MULTIPLE',
        required: true,
        minSelections: 2,
        maxSelections: 2,
        options: [{ name: 'Cheese Topping', price: 20, mapTo: 'cheeseDip', grams: 30 }, { name: 'Bacon Bits', price: 15 }],
      },
    ]);
    // Two required MULTIPLE groups — folded onto one line (Task 193B).
    await createProduct('combo', [
      { name: 'Sauces', selectionType: 'MULTIPLE', required: true, minSelections: 2, maxSelections: 2, options: [{ name: 'Ketchup' }, { name: 'Mustard' }] },
      { name: 'Sides', selectionType: 'MULTIPLE', required: true, minSelections: 1, maxSelections: 1, options: [{ name: 'Coleslaw' }] },
    ]);
    // Requirement coming from the assignment override, and from min_selections alone.
    await createProduct('overrides', [
      { name: 'Dressing', selectionType: 'SINGLE', required: false, assignmentRequired: true, maxSelections: 1, options: [{ name: 'Vinaigrette' }] },
      { name: 'Garnish', selectionType: 'SINGLE', required: false, minSelections: 1, maxSelections: 1, options: [{ name: 'Parsley' }] },
    ]);
    // The separate "choose 1–3" interpretation (lone required MULTIPLE, min < max): unchanged, a serving count.
    await createProduct('range', [
      { name: 'Sauce Range', selectionType: 'MULTIPLE', required: true, minSelections: 1, maxSelections: 3, options: [{ name: 'Honey' }, { name: 'Sriracha' }] },
    ]);

    // Mix & Max: a parent with packaging + two slots of one flavored snack, plus a required Dip choice.
    const flavor = await prisma.flavor.create({
      data: { name: `P46R2 Cheddar ${tag}`, ingredientName: 'Cheddar powder', ingredientUnit: 'g' },
    });
    flavorIds.push(flavor.id);
    const snackProduct = await prisma.product.create({ data: { name: `P46R2 Snack ${tag}`, status: 'active' } });
    productIds.push(snackProduct.id);
    const snackVariant = await prisma.productVariant.create({
      data: { productId: snackProduct.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 50, isActive: true },
    });
    await prisma.productVariantFlavor.create({ data: { productVariantId: snackVariant.id, flavorId: flavor.id } });
    await prisma.productComponent.create({ data: { productVariantId: snackVariant.id, inventoryItemId: itemIds.snack as string, quantityRequired: 40 } });
    await prisma.branchProductAvailability.create({ data: { branchId, productId: snackProduct.id, isAvailable: true } });
    const mix = await createProduct('mix', [
      { name: 'Dip', selectionType: 'SINGLE', required: true, maxSelections: 1, options: [{ name: 'Mix Dip', price: 5, mapTo: 'cheeseDip', grams: 10 }] },
    ]);
    await prisma.productComponent.deleteMany({ where: { productVariantId: mix.variantId } });
    await prisma.productComponent.create({ data: { productVariantId: mix.variantId, inventoryItemId: itemIds.box as string, quantityRequired: 1 } });
    for (const slotIndex of [1, 2]) {
      const slot = await prisma.productFlavorSlot.create({
        data: { productVariantId: mix.variantId, slotIndex, label: `Slot ${slotIndex}`, flavorQty: 1, unit: 'pc' },
      });
      await prisma.productFlavorSlotSnackOption.create({ data: { flavorSlotId: slot.id, snackProductVariantId: snackVariant.id } });
    }
    catalog.mix = { ...(catalog.mix as (typeof catalog)[string]), options: { ...catalog.mix?.options, snackVariant: snackVariant.id, flavor: flavor.id } };
  });

  afterAll(async () => {
    // Transaction/TransactionItem/InventoryStockMovement are append-only at the application level (lib/prisma-immutability.ts); raw SQL is the teardown escape hatch.
    await prisma.$executeRaw`DELETE FROM "transaction_items" WHERE "transaction_id" IN (SELECT id FROM "transactions" WHERE "branch_id" = ${branchId})`;
    await prisma.$executeRaw`DELETE FROM "inventory_deduction_jobs" WHERE "branch_id" = ${branchId}`;
    await prisma.$executeRaw`DELETE FROM "transactions" WHERE "branch_id" = ${branchId}`;
    await prisma.$executeRaw`DELETE FROM "inventory_stock_movements" WHERE "branch_id" = ${branchId}`;
    await prisma.$executeRaw`DELETE FROM "checkout_attempts" WHERE "branch_id" = ${branchId}`;
    await prisma.productFlavorSlot.deleteMany({ where: { productVariant: { productId: { in: productIds } } } });
    await prisma.productVariantOptionGroup.deleteMany({ where: { optionGroupId: { in: groupIds } } });
    await prisma.productOptionInventoryMapping.deleteMany({ where: { productOption: { optionGroupId: { in: groupIds } } } });
    await prisma.productOption.deleteMany({ where: { optionGroupId: { in: groupIds } } });
    await prisma.productOptionGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.productVariantFlavor.deleteMany({ where: { flavorId: { in: flavorIds } } });
    await prisma.productComponent.deleteMany({ where: { productVariant: { productId: { in: productIds } } } });
    await prisma.branchProductAvailability.deleteMany({ where: { branchId } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.flavor.deleteMany({ where: { id: { in: flavorIds } } });
    await prisma.shift.deleteMany({ where: { branchId } });
    await prisma.inventoryStock.deleteMany({ where: { branchId } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: Object.values(itemIds) } } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: unitId } });
    await prisma.user.deleteMany({ where: { id: cashierId } });
    await prisma.$disconnect();
  });

  describe('rejected before anything is written', () => {
    it('a required single choice omitted entirely', async () => {
      await expectRejectedWithoutTrace([line('fries', [])], 'PRODUCT_OPTION_REQUIRED');
    });

    it('a required single choice omitted while other groups are picked', async () => {
      await expectRejectedWithoutTrace([line('fries', ['Garlic Mayo', 'Cheese Dip'])], 'PRODUCT_OPTION_REQUIRED');
    });

    it('a folded required MULTIPLE group below its minimum, and one omitted entirely', async () => {
      await expectRejectedWithoutTrace([line('combo', ['Ketchup', 'Coleslaw'])], 'PRODUCT_OPTION_REQUIRED');
      await expectRejectedWithoutTrace([line('combo', ['Ketchup', 'Mustard'])], 'PRODUCT_OPTION_REQUIRED');
    });

    it('a folded group over its maximum (existing P46R limit)', async () => {
      await expectRejectedWithoutTrace([line('combo', ['Ketchup', 'Mustard', 'Ketchup', 'Coleslaw'])], 'PRODUCT_OPTION_LIMIT_EXCEEDED');
      await expectRejectedWithoutTrace([line('fries', ['BBQ', 'Garlic Mayo', 'Garlic Mayo', 'Garlic Mayo'])], 'PRODUCT_OPTION_LIMIT_EXCEEDED');
    });

    it('a duplicate pick in a SINGLE group counts twice and exceeds it', async () => {
      await expectRejectedWithoutTrace([line('fries', ['BBQ', 'BBQ'])], 'PRODUCT_OPTION_LIMIT_EXCEEDED');
    });

    it('a serving-count line with no pick from its group', async () => {
      await expectRejectedWithoutTrace([line('cup', [], 2)], 'PRODUCT_OPTION_REQUIRED');
    });

    it('a requirement set only on the variant assignment, or only by min_selections', async () => {
      await expectRejectedWithoutTrace([line('overrides', ['Parsley'])], 'PRODUCT_OPTION_REQUIRED');
      await expectRejectedWithoutTrace([line('overrides', ['Vinaigrette'])], 'PRODUCT_OPTION_REQUIRED');
    });

    it('a foreign option, an inactive option, and an option from a deactivated group', async () => {
      await expectRejectedWithoutTrace([line('fries', ['BBQ', 'Bacon Bits'])], 'PRODUCT_OPTION_NOT_AVAILABLE');
      await expectRejectedWithoutTrace([line('fries', ['Sour Cream'])], 'PRODUCT_OPTION_NOT_AVAILABLE');
      await expectRejectedWithoutTrace([line('fries', ['BBQ', 'Old Dip'])], 'PRODUCT_OPTION_NOT_AVAILABLE');
    });

    it('one invalid line rejects the whole cart, valid lines included', async () => {
      await expectRejectedWithoutTrace([line('fries', ['BBQ']), line('cup', ['Bacon Bits']), line('combo', ['Coleslaw'])], 'PRODUCT_OPTION_REQUIRED');
    });

    it('a Mix & Max line missing its required option choice', async () => {
      const mix = catalog.mix as (typeof catalog)[string];
      const slots = [1, 2].map((slotIndex) => ({ slotIndex, snackProductVariantId: mix.options.snackVariant as string, flavorId: mix.options.flavor as string }));
      await expectRejectedWithoutTrace([line('mix', [], 1, { selectedFlavors: slots })], 'PRODUCT_OPTION_REQUIRED');
    });
  });

  describe('legitimate POS payloads still succeed', () => {
    it('required single choice with optional extras and the "Add-ons" group left empty (Task 131)', async () => {
      const result = await sale([line('fries', ['BBQ'])]);
      expect(result.status).toBe('completed');
      expect(Number(result.total_amount)).toBe(100);
    });

    it('serving-count split lines (one pick each, identical picks merged) and a single remaining serving', async () => {
      // handleAddOnsConfirm for "Toppings, exactly 2" with Cheese + Bacon → two lines; with Cheese ×2 → one line, qty 2.
      const split = await sale([line('cup', ['Cheese Topping']), line('cup', ['Bacon Bits'])]);
      const merged = await sale([line('cup', ['Cheese Topping'], 2)]);
      // The cart owns quantity (Task 182): a cashier may drop one serving of the pair.
      const single = await sale([line('cup', ['Bacon Bits'])]);
      expect(Number(split.total_amount)).toBe(235);
      expect(Number(merged.total_amount)).toBe(240);
      expect(Number(single.total_amount)).toBe(115);
    });

    it('the "choose 1–3" lone required group keeps its serving-count shape', async () => {
      const result = await sale([line('range', ['Honey']), line('range', ['Sriracha'], 2)]);
      expect(result.status).toBe('completed');
    });

    it('folded required MULTIPLE groups at their targets, with a repeated pick', async () => {
      const result = await sale([line('combo', ['Ketchup', 'Ketchup', 'Coleslaw'])]);
      expect(result.status).toBe('completed');
    });

    it('requirements from the assignment override and from min_selections, satisfied', async () => {
      const result = await sale([line('overrides', ['Vinaigrette', 'Parsley'])]);
      expect(result.status).toBe('completed');
    });

    it('a repeated extra and an explicit product quantity are priced and deducted per occurrence', async () => {
      await inventoryDeductionService.runCycle(50);
      const [mayoBefore, cheeseBefore, potatoBefore] = [await onHand('garlicMayo'), await onHand('cheeseDip'), await onHand('potato')];

      const result = await sale([line('fries', ['Cheese', 'Garlic Mayo', 'Garlic Mayo', 'Cheese Dip'], 3)]);
      // (100 + 2×10 + 20) × 3
      expect(Number(result.total_amount)).toBe(420);
      await inventoryDeductionService.runCycle(50);

      expect(mayoBefore - (await onHand('garlicMayo'))).toBe(90); // 15 g × 2 occurrences × 3
      expect(cheeseBefore - (await onHand('cheeseDip'))).toBe(90); // 30 g × 3
      expect(potatoBefore - (await onHand('potato'))).toBe(300); // 100 g × 3
    });

    it('Mix & Max with its required option choice', async () => {
      const mix = catalog.mix as (typeof catalog)[string];
      const slots = [1, 2].map((slotIndex) => ({ slotIndex, snackProductVariantId: mix.options.snackVariant as string, flavorId: mix.options.flavor as string }));
      await inventoryDeductionService.runCycle(50);
      const [snackBefore, boxBefore] = [await onHand('snack'), await onHand('box')];

      const result = await sale([line('mix', ['Mix Dip'], 1, { selectedFlavors: slots })]);
      expect(Number(result.total_amount)).toBe(105);
      await inventoryDeductionService.runCycle(50);
      expect(boxBefore - (await onHand('box'))).toBe(1);
      expect(snackBefore - (await onHand('snack'))).toBeGreaterThan(0);
    });
  });

  it('a rejected cart, corrected, checks out under a new idempotency key', async () => {
    const rejectedKey = randomUUID();
    await expect(sale([line('fries', ['Garlic Mayo'])], rejectedKey)).rejects.toMatchObject({ code: 'PRODUCT_OPTION_REQUIRED' });
    expect((await prisma.checkoutAttempt.findUnique({ where: { idempotencyKey: rejectedKey } }))?.status).toBe('failed');

    const correctedKey = randomUUID();
    const result = await sale([line('fries', ['BBQ', 'Garlic Mayo'])], correctedKey);
    expect(result.status).toBe('completed');
    expect(Number(result.total_amount)).toBe(110);
    expect(await prisma.transaction.count({ where: { idempotencyKey: { in: [rejectedKey, correctedKey] } } })).toBe(1);
  });

  it('an offline batch reports a queued sale missing a required choice as failed and still syncs the rest', async () => {
    const before = await prisma.transaction.count({ where: { branchId } });
    const now = Date.now();
    const result = await transactionsService.syncOfflineTransactions(
      {
        branchId,
        cashierId,
        deviceId: `p46r2-device-${tag}`,
        transactions: [
          { offlineProvisionalNumber: `PC-P46R2-OFFLINE-${tag}-1`, shiftId, items: [line('fries', [])], paymentMethod: 'cash', cashTendered: 500, clientCreatedAt: now },
          { offlineProvisionalNumber: `PC-P46R2-OFFLINE-${tag}-2`, shiftId, items: [line('fries', ['Cheese'])], paymentMethod: 'cash', cashTendered: 500, clientCreatedAt: now + 1 },
        ],
      },
      null,
    );

    expect(result.results).toEqual([
      expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'PRODUCT_OPTION_REQUIRED' }) }),
      expect.objectContaining({ status: 'synced' }),
    ]);
    expect(await prisma.transaction.count({ where: { branchId } })).toBe(before + 1);
  });
});
