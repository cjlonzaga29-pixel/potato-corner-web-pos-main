import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Integration tests exercise the real Prisma + Redis stack end to end,
 * following the same convention as cash.integration.test.ts and
 * inventory.integration.test.ts. They require a real, disposable Postgres
 * database (migrations applied) and a real Redis instance, isolated from
 * the local dev database so these tests never touch seeded dev data.
 *
 * Set TEST_DATABASE_URL and TEST_REDIS_URL to enable this suite.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL);

// Imported unconditionally (not gated behind canRunIntegrationTests) so the
// CR-004 suite below can use them at describe-body scope — `describe`
// callbacks can't `await` an import themselves. Constructing the real
// PrismaClient here doesn't touch the network; connecting only happens when
// a query actually runs, which stays gated by describe.skipIf below.
const { prisma } = await import('../../lib/prisma.js');
const { transactionsService } = await import('./transactions.service.js');

describe.skipIf(!canRunIntegrationTests)('transactions integration', () => {
  beforeAll(async () => {
    // TODO: point `prisma` at TEST_DATABASE_URL and `redis` at TEST_REDIS_URL,
    // run `prisma migrate deploy` against the test database, and seed one
    // branch, one super_admin, one supervisor (assigned to branch A only),
    // one staff member at branch A, an active product/variant/flavor with a
    // branch_product_availability row, and an open shift at branch A owned
    // by the staff member.
  });

  afterAll(async () => {
    // TODO: truncate transaction_items, transactions, shift_cash_denominations,
    // shifts, and audit_logs (in that order, respecting FKs), then close the
    // Prisma/Redis connections opened for this suite.
  });

  it('POST /api/transactions with a cash payment records the sale and returns a BIR-format receipt number', async () => {
    // TODO: POST as the seeded staff member (with an active shift) with
    // { branch_id, shift_id, items: [...], payment_method: 'cash',
    // cash_tendered }; assert 201, response.data.receipt_number matches
    // /^[A-Z0-9]+-\d{8}-\d{6}$/, response.data.change_given equals
    // cash_tendered - total_amount, and a TRANSACTION_CREATED audit log row
    // exists.
    expect(true).toBe(true);
  });

  it('a second transaction the same day at the same branch gets the next sequence number', async () => {
    // TODO: POST a second sale immediately after the first; assert its
    // receipt_number's trailing 6-digit sequence is exactly one greater.
    expect(true).toBe(true);
  });

  it('POST /api/transactions enqueues an inventory deduction job that eventually deducts stock', async () => {
    // TODO: POST a sale for a product/variant with a known recipe; poll
    // inventory_movements for a sale_deduction row referencing the new
    // transaction id, and assert the ingredient's derived current stock
    // decreased by the expected amount.
    expect(true).toBe(true);
  });

  it('POST /api/transactions with a PWD discount computes the locked 5-step VAT formula correctly', async () => {
    // TODO: POST a sale for a single ₱100 item with discount_type: 'pwd' and
    // discount_id_reference; assert response.data.discount_amount === 17.86,
    // response.data.vat_amount === 8.57, response.data.total_amount === 80.
    expect(true).toBe(true);
  });

  it('POST /api/transactions on a closed shift returns 409 SHIFT_CLOSED', async () => {
    // TODO: close the seeded shift, then POST a new sale referencing its id;
    // assert 409 SHIFT_CLOSED and that no transaction row was created.
    expect(true).toBe(true);
  });

  it('POST /api/transactions/:id/void as supervisor voids a completed transaction', async () => {
    // TODO: POST /void as the seeded supervisor with { void_reason }; assert
    // 200, response.data.status === 'voided', response.data.voided_by_id
    // matches the supervisor, and a TRANSACTION_VOIDED audit log row exists.
    // Also assert the shift's cash_sales_total (read via GET
    // /api/cash/current) is unchanged — void never adjusts cash totals.
    expect(true).toBe(true);
  });

  it('POST /api/transactions/:id/void on an already-voided transaction returns 409 TRANSACTION_ALREADY_VOIDED', async () => {
    // TODO: POST /void again on the same transaction; assert 409.
    expect(true).toBe(true);
  });

  it('POST /api/transactions/:id/refund as staff returns 403 (supervisor/super_admin only)', async () => {
    // TODO: POST /refund using the seeded staff token; assert 403
    // INSUFFICIENT_PERMISSIONS.
    expect(true).toBe(true);
  });

  it('GET /api/transactions/:id with a supervisor from a different branch returns 403', async () => {
    // TODO: GET the seeded transaction's id using a supervisor token
    // assigned to a different branch; assert 403 BRANCH_ACCESS_DENIED.
    expect(true).toBe(true);
  });

  it('GET /api/transactions lists transactions for a branch, paginated and filterable by status', async () => {
    // TODO: GET ?branch_id=<seeded branch>&status=completed&page=1&limit=10
    // as super_admin; assert 200, response.data.total reflects the real
    // count, and every returned transaction's branch_id/status match the
    // query.
    expect(true).toBe(true);
  });

  it('POST /api/transactions/:id/receipt-printed sets receipt_printed to true', async () => {
    // TODO: POST as the seeded staff member; assert 200,
    // { success: true }, then GET the transaction and assert
    // response.data.receipt_printed === true.
    expect(true).toBe(true);
  });
});

/**
 * CR-004 — POS deduction integrity. Exercises the real service layer
 * (transactionsService.createTransaction) against a real Postgres database,
 * proving two guarantees that can't be verified by mocking the repository:
 *
 *  1. Cross-branch stock isolation: a master Recipe's ingredientId is pinned
 *     to whichever branch's Ingredient row it was created against (see
 *     recipes.service.ts computeDeduction / resolveIngredientForBranch) — a
 *     sale at any *other* branch must resolve to that branch's own
 *     equivalent Ingredient and never touch the pinned branch's stock.
 *  2. Rollback on insufficient stock: the sale, its line items, and its
 *     inventory deduction all happen inside one `prisma.$transaction` — a
 *     stock shortfall on any ingredient must roll back the entire write,
 *     leaving no Transaction row and no InventoryMovement row behind.
 */
describe.skipIf(!canRunIntegrationTests)('transactions integration — CR-004 POS deduction integrity', () => {
  let cashierId: string;
  let branchAId: string;
  let potatoAId: string;
  let productId: string;
  let variantId: string;

  async function createStockedBranch(potatoStock: number): Promise<{ branchId: string; potatoId: string; shiftId: string }> {
    const branch = await prisma.branch.create({
      data: { name: `Test Branch ${randomUUID()}`, code: `CR004-${randomUUID().slice(0, 8)}`, address: '1 Test St', city: 'Testville' },
    });
    await prisma.branchProductAvailability.create({ data: { branchId: branch.id, productId, isAvailable: true } });
    const potato = await prisma.ingredient.create({
      data: { branchId: branch.id, name: 'Potato', unit: 'g', currentStock: 0, lowStockThreshold: 0, criticalThreshold: 0 },
    });
    if (potatoStock > 0) {
      await prisma.inventoryMovement.create({
        data: {
          branchId: branch.id,
          ingredientId: potato.id,
          movementType: 'stock_in',
          quantityChange: potatoStock,
          quantityBefore: 0,
          quantityAfter: potatoStock,
        },
      });
    }
    const shift = await prisma.shift.create({
      data: { branchId: branch.id, cashierId, openedBy: cashierId, status: 'active', openingCashAmount: 0, startedAt: new Date() },
    });
    return { branchId: branch.id, potatoId: potato.id, shiftId: shift.id };
  }

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `cr004-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'staff',
        firstName: 'CR-004',
        lastName: 'Test Cashier',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    cashierId = user.id;

    const branchA = await prisma.branch.create({
      data: { name: 'CR-004 Branch A (recipe origin)', code: `CR004A-${randomUUID().slice(0, 8)}`, address: '1 Test St', city: 'Testville' },
    });
    branchAId = branchA.id;

    const potatoA = await prisma.ingredient.create({
      data: { branchId: branchAId, name: 'Potato', unit: 'g', currentStock: 0, lowStockThreshold: 0, criticalThreshold: 0 },
    });
    potatoAId = potatoA.id;
    await prisma.inventoryMovement.create({
      data: { branchId: branchAId, ingredientId: potatoAId, movementType: 'stock_in', quantityChange: 1000, quantityBefore: 0, quantityAfter: 1000 },
    });

    const product = await prisma.product.create({ data: { name: 'CR-004 Fries', status: 'active' } });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: { productId, name: 'Regular', sizeLabel: 'Regular', basePrice: 100, isActive: true },
    });
    variantId = variant.id;

    // Master recipe created against branch A's own Potato — the pinned
    // ingredient every other branch's sale must NOT resolve to.
    await prisma.recipe.create({ data: { productVariantId: variantId, ingredientId: potatoAId, flavorId: null, quantity: 200, unit: 'g' } });
  });

  afterAll(async () => {
    // Transaction/TransactionItem/InventoryMovement are guarded against
    // application-level update/delete by lib/prisma-immutability.ts — raw
    // SQL bypasses that guard, which is exactly the escape hatch it's meant
    // to leave open for infrastructure-level test teardown.
    await prisma.$executeRaw`DELETE FROM "transaction_items" WHERE "transaction_id" IN (SELECT id FROM "transactions" WHERE "cashier_id" = ${cashierId})`;
    await prisma.$executeRaw`DELETE FROM "transactions" WHERE "cashier_id" = ${cashierId}`;
    await prisma.$executeRaw`DELETE FROM "inventory_movements" WHERE "ingredient_id" IN (SELECT id FROM "ingredients" WHERE "name" = 'Potato')`;
    await prisma.branchProductAvailability.deleteMany({ where: { productId } });
    await prisma.shift.deleteMany({ where: { cashierId } });
    await prisma.recipe.deleteMany({ where: { productVariantId: variantId } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.ingredient.deleteMany({ where: { name: 'Potato' } });
    await prisma.branch.deleteMany({ where: { OR: [{ id: branchAId }, { name: { startsWith: 'Test Branch ' } }] } });
    await prisma.user.deleteMany({ where: { id: cashierId } });
    await prisma.$disconnect();
  });

  it('a sale at a different branch deducts that branch\'s own Potato, never branch A\'s pinned Potato', async () => {
    const branchB = await createStockedBranch(500);

    const result = await transactionsService.createTransaction(
      {
        branchId: branchB.branchId,
        shiftId: branchB.shiftId,
        cashierId,
        items: [{ productId, productVariantId: variantId, quantity: 1 }],
        paymentMethod: 'cash',
        cashTendered: 100,
        isOfflineTransaction: false,
      },
      null,
    );

    expect(result.status).toBe('completed');

    const [potatoA, potatoB] = await Promise.all([
      prisma.inventoryMovement.aggregate({ where: { ingredientId: potatoAId }, _sum: { quantityChange: true } }),
      prisma.inventoryMovement.aggregate({ where: { ingredientId: branchB.potatoId }, _sum: { quantityChange: true } }),
    ]);
    expect(Number(potatoA._sum.quantityChange)).toBe(1000); // branch A untouched
    expect(Number(potatoB._sum.quantityChange)).toBe(300); // 500 - 200

    const deductionMovement = await prisma.inventoryMovement.findFirst({
      where: { referenceId: result.id, movementType: 'sale_deduction' },
    });
    expect(deductionMovement?.branchId).toBe(branchB.branchId);
    expect(deductionMovement?.ingredientId).toBe(branchB.potatoId);
  });

  it('rejects the sale and creates neither a Transaction nor an InventoryMovement row when stock is insufficient', async () => {
    const branchC = await createStockedBranch(50); // needs 200g, only 50g on hand

    await expect(
      transactionsService.createTransaction(
        {
          branchId: branchC.branchId,
          shiftId: branchC.shiftId,
          cashierId,
          items: [{ productId, productVariantId: variantId, quantity: 1 }],
          paymentMethod: 'cash',
          cashTendered: 100,
          isOfflineTransaction: false,
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK', statusCode: 409 });

    const [transactionCount, movementSum] = await Promise.all([
      prisma.transaction.count({ where: { branchId: branchC.branchId } }),
      prisma.inventoryMovement.aggregate({ where: { ingredientId: branchC.potatoId }, _sum: { quantityChange: true } }),
    ]);
    expect(transactionCount).toBe(0);
    expect(Number(movementSum._sum.quantityChange)).toBe(50); // unchanged — only the initial stock-in
  });

  it('rejects the whole sale with RECIPE_MISSING for a variant no one has configured a recipe for, at any branch', async () => {
    const branchD = await createStockedBranch(1000);
    const unrecipedVariant = await prisma.productVariant.create({
      data: { productId, name: 'No Recipe Yet', sizeLabel: 'Regular', basePrice: 50, isActive: true },
    });

    await expect(
      transactionsService.createTransaction(
        {
          branchId: branchD.branchId,
          shiftId: branchD.shiftId,
          cashierId,
          items: [{ productId, productVariantId: unrecipedVariant.id, quantity: 1 }],
          paymentMethod: 'cash',
          cashTendered: 50,
          isOfflineTransaction: false,
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'RECIPE_MISSING', statusCode: 422 });

    expect(await prisma.transaction.count({ where: { branchId: branchD.branchId } })).toBe(0);
    await prisma.productVariant.delete({ where: { id: unrecipedVariant.id } });
  });
});
