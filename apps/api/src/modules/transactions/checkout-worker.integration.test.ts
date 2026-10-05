import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

/**
 * POS-PERF-P15R2 — a focused, reproducible PostgreSQL integration suite for
 * the fast-checkout + background-inventory-deduction-worker feature
 * (POS-PERF-P15/P15R/P15R2). Unlike the pre-existing *.integration.test.ts
 * stub files elsewhere in this repo (transactions.integration.test.ts,
 * inventory.integration.test.ts, etc. — every `it` body there is a bare
 * `expect(true).toBe(true)` TODO), every test in this file is real: it
 * seeds real rows, calls the real service/repository functions
 * (transactionsService.createTransaction, inventoryDeductionService.
 * runCycle, universalInventoryService.submitPhysicalCount,
 * inventoryDeductionRepository.cancelAndReleaseReservation), and asserts
 * against rows actually read back from Postgres afterward.
 *
 * ## How to run
 *
 * 1. Start a disposable, non-production Postgres instance. Easiest via
 *    Docker (adjust the port/password if 55432 or `postgres` collide with
 *    something already running):
 *
 *      docker run --rm -d --name pos-test-pg -p 55432:5432 \
 *        -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pos_test postgres:16
 *
 * 2. Point Prisma at it and apply every migration (including
 *    20261005150000_add_fast_checkout_background_deduction, the migration
 *    this suite's "populated tables" test exercises):
 *
 *      cd apps/api
 *      $env:DATABASE_URL = "postgresql://postgres:postgres@localhost:55432/pos_test"
 *      npx prisma migrate deploy
 *
 * 3. Run this suite with the same DATABASE_URL, plus TEST_DATABASE_URL set
 *    to the same value (TEST_DATABASE_URL is only the enable/skip gate —
 *    see canRunIntegrationTests below; this suite reads the already-
 *    connected `prisma` singleton, which connects using DATABASE_URL at
 *    process start, exactly like record-writer.service.test.ts and
 *    advisory-lock.test.ts already do for their own real-Postgres suites):
 *
 *      $env:TEST_DATABASE_URL = $env:DATABASE_URL
 *      npx vitest run src/modules/transactions/checkout-worker.integration.test.ts
 *
 * 4. Tear down: docker stop pos-test-pg (the --rm flag deletes the
 *    container and its volume on stop — nothing persists).
 *
 * Never point this at a shared dev/staging/production database — several
 * tests race concurrent writers against the same rows and will corrupt
 * unrelated data if run against anything real.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const { transactionsService } = await import('./transactions.service.js');
const { inventoryDeductionService } = await import('../inventory-deduction/inventory-deduction.service.js');
const { inventoryDeductionRepository } = await import('../inventory-deduction/inventory-deduction.repository.js');
const { universalInventoryService } = await import('../universal-inventory/universal-inventory.service.js');

describe.skipIf(!canRunIntegrationTests)('checkout + inventory-deduction worker integration (POS-PERF-P15R2)', () => {
  let branchId: string;
  let userId: string;
  let shiftId: string;
  let unitId: string;
  let productId: string;
  let variantId: string;

  /** One InventoryItem + InventoryStock + ProductComponent trio, fully isolated per test (not shared) so concurrent-writer tests in this file never race each other's stock rows. quantityRequired is fixed at 2 base units per unit sold. */
  async function seedCatalogItem(initialOnHand: number) {
    const inventoryItem = await prisma.inventoryItem.create({
      data: { name: `r2-item-${randomUUID()}`, baseUnitId: unitId, trackInventory: true },
    });
    await prisma.inventoryStock.create({
      data: { branchId, inventoryItemId: inventoryItem.id, quantityOnHand: new Prisma.Decimal(initialOnHand), quantityReserved: new Prisma.Decimal(0) },
    });
    await prisma.productComponent.create({
      data: { productVariantId: variantId, inventoryItemId: inventoryItem.id, quantityRequired: new Prisma.Decimal(2), recipeUnitId: null },
    });
    return inventoryItem.id;
  }

  async function getStock(inventoryItemId: string) {
    const stock = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId } } });
    return stock;
  }

  async function checkout(idempotencyKey: string | null) {
    return transactionsService.createTransaction(
      {
        branchId,
        shiftId,
        cashierId: userId,
        items: [{ productId, productVariantId: variantId, quantity: 1 }],
        paymentMethod: 'cash',
        cashTendered: 500,
        isOfflineTransaction: false,
        idempotencyKey,
      },
      null,
    );
  }

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);

    const branch = await prisma.branch.create({
      data: { name: `R2 Test Branch ${suffix}`, code: `R2T${suffix}`, address: '1 Test St', city: 'Testville' },
    });
    branchId = branch.id;

    const user = await prisma.user.create({
      data: {
        email: `r2-checkout-worker-${suffix}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'staff',
        firstName: 'R2',
        lastName: 'Checkout Worker Test',
        employmentType: 'regular',
      },
    });
    userId = user.id;

    const shift = await prisma.shift.create({
      data: { branchId, cashierId: userId, openedBy: userId, status: 'active', openingCashAmount: new Prisma.Decimal(1000), startedAt: new Date() },
    });
    shiftId = shift.id;

    const unit = await prisma.unitOfMeasure.create({
      data: { code: `r2pc-${suffix}`, name: 'R2 Test Piece', dimension: 'COUNT', isBaseUnit: true },
    });
    unitId = unit.id;

    const product = await prisma.product.create({ data: { name: `R2 Test Product ${suffix}`, status: 'active' } });
    productId = product.id;

    const variant = await prisma.productVariant.create({
      data: { productId, name: 'Regular', sizeLabel: 'Regular', basePrice: new Prisma.Decimal(100), isActive: true, lifecycleStatus: 'ACTIVE' },
    });
    variantId = variant.id;

    await prisma.branchProductAvailability.create({ data: { branchId, productId, isAvailable: true } });
  });

  afterAll(async () => {
    // Explicit dependency-ordered cleanup rather than relying on cascades —
    // this suite is the only writer of every row it created (randomUUID-
    // suffixed names/codes/emails), so there is nothing else to preserve.
    await prisma.inventoryStockMovement.deleteMany({ where: { branchId } });
    await prisma.inventoryDeductionJob.deleteMany({ where: { branchId } });
    await prisma.transactionItem.deleteMany({ where: { transaction: { branchId } } });
    await prisma.transaction.deleteMany({ where: { branchId } });
    await prisma.inventoryStock.deleteMany({ where: { branchId } });
    await prisma.productComponent.deleteMany({ where: { productVariantId: variantId } });
    await prisma.branchProductAvailability.deleteMany({ where: { branchId } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.shift.deleteMany({ where: { branchId } });
    const items = await prisma.inventoryItem.findMany({ where: { baseUnitId: unitId }, select: { id: true } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: unitId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.$disconnect();
  });

  it('a duplicate concurrent checkout under the same idempotency key yields exactly one sale, one job, and one reservation', async () => {
    const inventoryItemId = await seedCatalogItem(1000);
    const idempotencyKey = randomUUID();

    const [resultA, resultB] = await Promise.all([checkout(idempotencyKey), checkout(idempotencyKey)]);

    expect(resultA.id).toBe(resultB.id);

    const transactionCount = await prisma.transaction.count({ where: { idempotencyKey } });
    expect(transactionCount).toBe(1);

    const jobCount = await prisma.inventoryDeductionJob.count({ where: { transactionId: resultA.id } });
    expect(jobCount).toBe(1);

    // quantityRequired=2 * quantity sold=1, reserved exactly once — not
    // twice, which is what a naive "both requests reserve, then one fails
    // at insert" implementation would produce.
    const stock = await getStock(inventoryItemId);
    expect(stock.quantityReserved.toNumber()).toBe(2);
    expect(stock.quantityOnHand.toNumber()).toBe(1000);
  });

  it('a retry under the same idempotency key after success returns the same authorized sale, never a second one', async () => {
    await seedCatalogItem(1000);
    const idempotencyKey = randomUUID();

    const first = await checkout(idempotencyKey);
    const retry = await checkout(idempotencyKey);

    expect(retry.id).toBe(first.id);
    expect(await prisma.transaction.count({ where: { idempotencyKey } })).toBe(1);
  });

  it('reservation rollback: voiding a sale before the worker claims its job cancels the job and releases the reservation', async () => {
    const inventoryItemId = await seedCatalogItem(1000);
    const sale = await checkout(randomUUID());

    const beforeVoid = await getStock(inventoryItemId);
    expect(beforeVoid.quantityReserved.toNumber()).toBe(2);

    await transactionsService.voidTransaction(sale.id, 'Integration test void', { id: userId, role: 'staff' }, null);

    const job = await inventoryDeductionRepository.findJobByTransactionId(sale.id);
    expect(job?.status).toBe('cancelled');

    const afterVoid = await getStock(inventoryItemId);
    expect(afterVoid.quantityReserved.toNumber()).toBe(0);
    // Nothing was ever actually deducted (the job never ran), so on-hand is untouched.
    expect(afterVoid.quantityOnHand.toNumber()).toBe(1000);
  });

  it('competing workers: two concurrent runCycle calls deduct a given job exactly once, never twice', async () => {
    const inventoryItemId = await seedCatalogItem(1000);
    const sale = await checkout(randomUUID());

    await Promise.all([inventoryDeductionService.runCycle(10), inventoryDeductionService.runCycle(10)]);

    const job = await inventoryDeductionRepository.findJobByTransactionId(sale.id);
    expect(job?.status).toBe('completed');

    const stock = await getStock(inventoryItemId);
    // Deducted exactly once: 1000 - 2, reservation fully released.
    expect(stock.quantityOnHand.toNumber()).toBe(998);
    expect(stock.quantityReserved.toNumber()).toBe(0);

    const movementCount = await prisma.inventoryStockMovement.count({
      where: { branchId, inventoryItemId, movementType: 'SALE', referenceId: sale.id },
    });
    expect(movementCount).toBe(1);
  });

  it('a stale processing claim (crashed worker) is reclaimed by the next cycle and completed exactly once', async () => {
    const inventoryItemId = await seedCatalogItem(1000);
    const sale = await checkout(randomUUID());

    const job = await inventoryDeductionRepository.findJobByTransactionId(sale.id);
    if (!job) throw new Error('unreachable: checkout always creates a job');

    // Simulate a worker that claimed the job and then crashed before
    // applying the deduction: status stuck at 'processing', lockedAt far in
    // the past, claimToken belonging to nobody who will ever finish it.
    await prisma.inventoryDeductionJob.update({
      where: { id: job.id },
      data: { status: 'processing', claimToken: 'stale-crashed-worker-token', lockedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    // staleLockMs well under the 10-minute-old lock above, so this cycle's
    // claimableWhere treats it as eligible for reclaim.
    await inventoryDeductionService.runCycle(10, 60_000);

    const reclaimed = await inventoryDeductionRepository.findJobByTransactionId(sale.id);
    expect(reclaimed?.status).toBe('completed');

    const stock = await getStock(inventoryItemId);
    expect(stock.quantityOnHand.toNumber()).toBe(998);
    expect(stock.quantityReserved.toNumber()).toBe(0);

    const movementCount = await prisma.inventoryStockMovement.count({
      where: { branchId, inventoryItemId, movementType: 'SALE', referenceId: sale.id },
    });
    expect(movementCount).toBe(1);
  });

  it('void/refund race: voiding a job the worker has already claimed ("processing") is rejected with a retryable 409, never double-reverses', async () => {
    const inventoryItemId = await seedCatalogItem(1000);
    const sale = await checkout(randomUUID());
    const job = await inventoryDeductionRepository.findJobByTransactionId(sale.id);
    if (!job) throw new Error('unreachable: checkout always creates a job');

    // Claim it (as the worker would), but never apply — the job is now
    // genuinely 'processing' from a real claim, not a simulated stale one.
    await prisma.inventoryDeductionJob.update({ where: { id: job.id }, data: { status: 'processing', claimToken: randomUUID(), lockedAt: new Date() } });

    await expect(transactionsService.voidTransaction(sale.id, 'Integration test void race', { id: userId, role: 'staff' }, null)).rejects.toMatchObject({
      code: 'INVENTORY_DEDUCTION_IN_PROGRESS',
    });

    // Reservation must be untouched — the void never got far enough to release it.
    const stock = await getStock(inventoryItemId);
    expect(stock.quantityReserved.toNumber()).toBe(2);
    const transaction = await prisma.transaction.findUniqueOrThrow({ where: { id: sale.id } });
    expect(transaction.status).toBe('completed');
  });

  it('physical count vs. a concurrent reservation: on-hand never ends up below reserved, regardless of which one wins the race', async () => {
    const inventoryItemId = await seedCatalogItem(10);

    // A second, independent sale (cart quantity 4 → reserves 4*2=8 base
    // units) racing a physical count that would set on-hand to 3 — fired
    // concurrently via Promise.allSettled so either interleaving is
    // exercised: if the reservation commits first, the count must see
    // quantityReserved=8 and reject (3 < 8); if the count commits first, the
    // reservation's own atomic conditional UPDATE must see on-hand=3 and
    // fail with INSUFFICIENT_STOCK (3-0=3 < 8 needed) instead of driving
    // on-hand below reserved.
    const racingSale = checkout2Units(inventoryItemId);
    const physicalCount = universalInventoryService.submitPhysicalCount(
      { branchId, counts: [{ inventoryItemId, countedQuantity: 3 }] },
      { id: userId, role: 'supervisor' },
      null,
    );

    await Promise.allSettled([racingSale, physicalCount]);

    const stock = await getStock(inventoryItemId);
    expect(stock.quantityOnHand.toNumber()).toBeGreaterThanOrEqual(stock.quantityReserved.toNumber());

    async function checkout2Units(itemId: string) {
      // A dedicated variant/component pair reserving 8 base units of this
      // same item (4 sold * quantityRequired 2), independent of the shared
      // `variantId` the rest of this file uses, so this test's reservation
      // size is self-contained and doesn't depend on another test's catalog
      // item.
      const variant = await prisma.productVariant.create({
        data: { productId, name: `R2 Racing Variant ${randomUUID().slice(0, 8)}`, sizeLabel: 'Regular', basePrice: new Prisma.Decimal(50), isActive: true, lifecycleStatus: 'ACTIVE' },
      });
      await prisma.productComponent.create({
        data: { productVariantId: variant.id, inventoryItemId: itemId, quantityRequired: new Prisma.Decimal(2), recipeUnitId: null },
      });
      return transactionsService.createTransaction(
        {
          branchId,
          shiftId,
          cashierId: userId,
          items: [{ productId, productVariantId: variant.id, quantity: 4 }],
          paymentMethod: 'cash',
          cashTendered: 500,
          isOfflineTransaction: false,
          idempotencyKey: randomUUID(),
        },
        null,
      );
    }
  });

  it('migration safety on populated tables: the fast-checkout migration\'s additive columns behave correctly against real rows (20261005150000)', async () => {
    // Multiple NULL idempotency_key rows must coexist — Postgres never
    // treats two NULLs as equal under a unique index, so the partial
    // uniqueness this migration added must not collide for legacy/offline-
    // synced transactions that predate (or simply omit) this field.
    const legacyA = await prisma.transaction.create({
      data: {
        transactionNumber: `R2-LEGACY-${randomUUID()}`,
        branchId,
        cashierId: userId,
        paymentMethod: 'cash',
        subtotal: new Prisma.Decimal(10),
        vatAmount: new Prisma.Decimal(1.07),
        totalAmount: new Prisma.Decimal(10),
        idempotencyKey: null,
      },
    });
    const legacyB = await prisma.transaction.create({
      data: {
        transactionNumber: `R2-LEGACY-${randomUUID()}`,
        branchId,
        cashierId: userId,
        paymentMethod: 'cash',
        subtotal: new Prisma.Decimal(20),
        vatAmount: new Prisma.Decimal(2.14),
        totalAmount: new Prisma.Decimal(20),
        idempotencyKey: null,
      },
    });
    expect(legacyA.idempotencyKey).toBeNull();
    expect(legacyB.idempotencyKey).toBeNull();

    // A freshly-inserted InventoryStock row that never mentions
    // quantity_reserved must still default it to exactly 0 — the migration
    // promises every pre-existing and newly-provisioned row starts
    // unreserved, never a NULL that downstream arithmetic would choke on.
    const freshItem = await prisma.inventoryItem.create({ data: { name: `r2-migration-item-${randomUUID()}`, baseUnitId: unitId } });
    await prisma.$executeRaw`
      INSERT INTO "inventory_stocks" ("id", "branch_id", "inventory_item_id", "quantity_on_hand", "updated_at")
      VALUES (${randomUUID()}, ${branchId}, ${freshItem.id}, 50, now())
    `;
    const freshStock = await prisma.inventoryStock.findUniqueOrThrow({
      where: { branchId_inventoryItemId: { branchId, inventoryItemId: freshItem.id } },
    });
    expect(freshStock.quantityReserved.toNumber()).toBe(0);
    expect(freshStock.quantityOnHand.toNumber() - freshStock.quantityReserved.toNumber()).toBe(50);

    await prisma.inventoryStock.deleteMany({ where: { branchId, inventoryItemId: freshItem.id } });
    await prisma.inventoryItem.deleteMany({ where: { id: freshItem.id } });
  });
});
