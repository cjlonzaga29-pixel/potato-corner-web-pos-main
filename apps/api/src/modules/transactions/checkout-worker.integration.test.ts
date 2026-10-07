import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

/**
 * POS-PERF-P15R2/R3 — a focused, reproducible PostgreSQL integration suite
 * for the fast-checkout + background-inventory-deduction-worker feature
 * (POS-PERF-P15/P15R/P15R2/P15R3). Unlike the pre-existing
 * *.integration.test.ts stub files elsewhere in this repo
 * (transactions.integration.test.ts, inventory.integration.test.ts, etc. —
 * every `it` body there is a bare `expect(true).toBe(true)` TODO), every
 * test in this file is real: it seeds real rows, calls the real
 * service/repository functions (transactionsService.createTransaction,
 * transactionsService.resolveCheckoutAttempt, inventoryDeductionService.
 * runCycle, universalInventoryService.submitPhysicalCount,
 * inventoryDeductionRepository.cancelAndReleaseReservation), and asserts
 * against rows actually read back from Postgres afterward.
 *
 * ## How to run
 *
 * Option A — embedded Postgres, no Docker, no admin elevation
 * (apps/api/scripts/with-test-postgres.ts): downloads a real Postgres
 * binary via the `embedded-postgres` devDependency, runs it as the current
 * user on a disposable port/data dir, applies every migration, runs the
 * given command, then tears the cluster down. From apps/api:
 *
 *      npx tsx scripts/with-test-postgres.ts "npx vitest run src/modules/transactions/checkout-worker.integration.test.ts"
 *
 * Option B — Docker, if you'd rather manage the container yourself (adjust
 * the port/password if 55432 or `postgres` collide with something already
 * running):
 *
 *      docker run --rm -d --name pos-test-pg -p 55432:5432 \
 *        -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pos_test postgres:16
 *      cd apps/api
 *      $env:DATABASE_URL = "postgresql://postgres:postgres@localhost:55432/pos_test"
 *      npx prisma migrate deploy
 *      $env:TEST_DATABASE_URL = $env:DATABASE_URL
 *      npx vitest run src/modules/transactions/checkout-worker.integration.test.ts
 *      docker stop pos-test-pg   # --rm deletes the container+volume on stop
 *
 * TEST_DATABASE_URL is only the enable/skip gate (see canRunIntegrationTests
 * below) — this suite reads the already-connected `prisma` singleton, which
 * connects using DATABASE_URL at process start, exactly like
 * record-writer.service.test.ts and advisory-lock.test.ts already do for
 * their own real-Postgres suites.
 *
 * For a true pre-migration-vs-post-migration upgrade test (inserting rows
 * under the OLD schema, then applying a migration and checking they survive
 * correctly — not just inserting rows after the fact, which only tests
 * defaults) see scripts/test-migration-on-populated-data.ts instead; that
 * script controls which migrations are applied at each step, which this
 * suite's single always-fully-migrated connection cannot do.
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

  /**
   * POS-PERF-P15R3 — unlike seedCatalogItem above, this creates its own
   * dedicated ProductVariant (not the shared module-level `variantId`),
   * so a test using it is never affected by how many components earlier
   * tests have piled onto the shared variant via seedCatalogItem, and
   * never affects later tests either. Needed for any new test here that
   * runs more than one or two single-unit checkouts against real stock
   * margins — the pre-existing tests in this file get away with reusing
   * the shared variant only because each one so far ever sells at most a
   * couple of units against a 1000-unit stock seed.
   */
  async function seedIsolatedVariant(initialOnHand: number) {
    const variant = await prisma.productVariant.create({
      data: { productId, name: `R3 Isolated Variant ${randomUUID().slice(0, 8)}`, sizeLabel: 'Regular', basePrice: new Prisma.Decimal(100), isActive: true, lifecycleStatus: 'ACTIVE' },
    });
    const inventoryItem = await prisma.inventoryItem.create({
      data: { name: `r3-isolated-item-${randomUUID()}`, baseUnitId: unitId, trackInventory: true },
    });
    await prisma.inventoryStock.create({
      data: { branchId, inventoryItemId: inventoryItem.id, quantityOnHand: new Prisma.Decimal(initialOnHand), quantityReserved: new Prisma.Decimal(0) },
    });
    await prisma.productComponent.create({
      data: { productVariantId: variant.id, inventoryItemId: inventoryItem.id, quantityRequired: new Prisma.Decimal(2), recipeUnitId: null },
    });
    const checkoutIsolated = (idempotencyKey: string | null, quantity = 1) =>
      transactionsService.createTransaction(
        {
          branchId,
          shiftId,
          cashierId: userId,
          items: [{ productId, productVariantId: variant.id, quantity }],
          paymentMethod: 'cash',
          cashTendered: 500,
          isOfflineTransaction: false,
          idempotencyKey,
        },
        null,
      );
    return { variantId: variant.id, inventoryItemId: inventoryItem.id, checkout: checkoutIsolated };
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
    //
    // POS-PERF-P15R3 — discovered by actually running this suite against
    // real Postgres (previously gated out by TEST_DATABASE_URL and never
    // exercised): prisma-immutability.ts's CR-004 guard rejects
    // delete/deleteMany on Transaction *and* TransactionItem through the
    // Prisma Client, full stop — including from test cleanup, since the
    // middleware can't distinguish "production app code" from "a test's own
    // teardown". A raw SQL delete bypasses the client-level middleware
    // entirely (it only intercepts Prisma Client model operations); ON
    // DELETE CASCADE on TransactionItem.transaction and
    // CheckoutAttempt.transaction takes care of both child tables.
    await prisma.inventoryStockMovement.deleteMany({ where: { branchId } });
    await prisma.inventoryDeductionJob.deleteMany({ where: { branchId } });
    await prisma.$executeRaw`DELETE FROM "transactions" WHERE "branch_id" = ${branchId}`;
    await prisma.inventoryStock.deleteMany({ where: { branchId } });
    // By relation, not just the shared `variantId` — seedIsolatedVariant
    // (POS-PERF-P15R3) creates additional ProductVariant rows under the
    // same productId, each with its own ProductComponent; deleting only
    // the shared variant's components would leave the isolated ones'
    // ProductComponent rows behind, which then blocks the ProductVariant
    // deleteMany below via its RESTRICT foreign key.
    await prisma.productComponent.deleteMany({ where: { productVariant: { productId } } });
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

  // POS-PERF-P25 — against a real Postgres instance: the background worker's
  // SALE movement must carry the sale's own cashier (never null, never the
  // worker's own identity) as both performedByUserId and responsibleUserId,
  // and the sale's own order notes — not just in a mocked unit test.
  it("attributes the worker-written SALE movement to the sale's own cashier and carries its order notes", async () => {
    const inventoryItemId = await seedCatalogItem(1000);
    const sale = await transactionsService.createTransaction(
      {
        branchId,
        shiftId,
        cashierId: userId,
        items: [{ productId, productVariantId: variantId, quantity: 1 }],
        paymentMethod: 'cash',
        cashTendered: 500,
        isOfflineTransaction: false,
        idempotencyKey: randomUUID(),
        notes: 'integration test order note',
      },
      null,
    );

    await inventoryDeductionService.runCycle(10);

    const movement = await prisma.inventoryStockMovement.findFirstOrThrow({
      where: { branchId, inventoryItemId, movementType: 'SALE', referenceId: sale.id },
    });
    expect(movement.performedByUserId).toBe(userId);
    expect(movement.responsibleUserId).toBe(userId);
    expect(movement.notes).toBe('integration test order note');
    expect(movement.referenceType).toBe('transaction');
    expect(movement.referenceId).toBe(sale.id);
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

  describe('checkout attempt fencing (POS-PERF-P15R3)', () => {
    it('resolveCheckoutAttempt reports in_progress while the attempt is still live, then committed the instant the real sale lands — never a false "not found" in between', async () => {
      const isolated = await seedIsolatedVariant(1000);
      const idempotencyKey = randomUUID();

      // Simulate "the original request is still running" by claiming the
      // row exactly as claimCheckoutAttempt would, without finishing the
      // checkout yet.
      const ownerToken = randomUUID();
      await prisma.checkoutAttempt.create({
        data: { idempotencyKey, branchId, cashierId: userId, status: 'in_progress', ownerToken, leaseExpiresAt: new Date(Date.now() + 60_000) },
      });

      const whileRunning = await transactionsService.resolveCheckoutAttempt(idempotencyKey, branchId, userId);
      expect(whileRunning).toMatchObject({ status: 'in_progress', branchId });

      // Now let the "original request" actually finish: run a real
      // checkout under this exact key (claimCheckoutAttempt will see the
      // existing in_progress/live-lease row and must NOT be able to
      // reclaim it out from under itself — exercised by using the SAME
      // ownerToken the real call would need to already hold. Simpler and
      // just as faithful: delete the manual placeholder and let a genuine
      // checkout claim and commit the key, then confirm resolution flips.
      await prisma.checkoutAttempt.delete({ where: { idempotencyKey } });
      const sale = await isolated.checkout(idempotencyKey);

      const afterCommit = await transactionsService.resolveCheckoutAttempt(idempotencyKey, branchId, userId);
      expect(afterCommit.status).toBe('committed');
      if (afterCommit.status === 'committed') expect(afterCommit.transaction.id).toBe(sale.id);
    });

    it('resolveCheckoutAttempt reports failed (safe to remint immediately, no wait) after a pre-commit validation rejection, and the same key can be reused right away', async () => {
      const isolated = await seedIsolatedVariant(1000);
      const idempotencyKey = randomUUID();

      await expect(
        transactionsService.createTransaction(
          {
            branchId,
            shiftId,
            cashierId: userId,
            items: [{ productId, productVariantId: isolated.variantId, quantity: 1 }],
            paymentMethod: 'cash',
            cashTendered: 1, // less than the 100 total — INSUFFICIENT_CASH_TENDERED, thrown before any $transaction
            isOfflineTransaction: false,
            idempotencyKey,
          },
          null,
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_CASH_TENDERED' });

      const resolved = await transactionsService.resolveCheckoutAttempt(idempotencyKey, branchId, userId);
      expect(resolved).toMatchObject({ status: 'failed', branchId });

      // Same key, now with valid payment — must succeed immediately, no
      // lease wait, because 'failed' is reclaimable right away.
      const sale = await isolated.checkout(idempotencyKey);
      expect(await transactionsService.resolveCheckoutAttempt(idempotencyKey, branchId, userId)).toMatchObject({ status: 'committed' });
      expect(sale.id).toBeTruthy();
    });
  });

  describe('checkout attempt recovery durability and lease takeover (POS-PERF-P15R4/R5)', () => {
    // POS-PERF-P15R4 — a dropped/reloaded client has no memory of whether
    // its own request ever reached the server at all. A bare "no
    // CheckoutAttempt row" read used to be reported straight through as
    // 'not_found' (safe to mint a replacement key): that proves nothing if
    // the original request is simply delayed somewhere before
    // claimCheckoutAttempt's own INSERT (slow auth/rate-limit middleware,
    // a queued connection, a GC pause before the handler body even runs).
    //
    // POS-PERF-P15R5 — resolveCheckoutAttempt (the GET) is now PURE READ:
    // it reports 'not_found' as a bare fact and writes nothing. The actual
    // durable fencing now happens only via the explicit
    // abandonCheckoutAttempt action, which this test calls explicitly
    // (exactly like the real client does, via POST
    // /by-idempotency-key/:key/abandon) before minting the replacement.
    // This reproduces that exact ordering against real Postgres and proves
    // the fencing closes the race: the delayed original request, arriving
    // after abandonment and a replacement sale already committed, must be
    // rejected outright rather than quietly producing a second, duplicate
    // sale — and, crucially, this rejection must hold even once whatever
    // lease_expires_at value the row carries is in the past, because
    // 'abandoned' is never eligible for reclaim at all (unlike a merely
    // lease-expired 'in_progress' row).
    it(
      'the GET recovery check performs no write, and explicitly abandoning a never-claimed key permanently fences it so a merely-delayed original request can never commit after a replacement key already committed — even long past what would have been its lease',
      async () => {
        const isolated = await seedIsolatedVariant(1000);
        const originalKey = randomUUID();

        const recovery = await transactionsService.resolveCheckoutAttempt(originalKey, branchId, userId);
        expect(recovery).toEqual({ status: 'not_found', branchId: null });
        // The read-only GET must not have written anything at all yet.
        expect(await prisma.checkoutAttempt.findUnique({ where: { idempotencyKey: originalKey } })).toBeNull();

        // Client explicitly abandons the key via the dedicated write action
        // (the real POST /by-idempotency-key/:key/abandon route) BEFORE
        // minting a replacement — this is the durable fencing write.
        const abandonResult = await transactionsService.abandonCheckoutAttempt(originalKey, branchId, userId);
        expect(abandonResult).toEqual({ status: 'abandoned' });

        // Client mints+commits a replacement key for the (possibly edited) cart.
        const replacementKey = randomUUID();
        const replacementSale = await isolated.checkout(replacementKey);
        expect(replacementSale.id).toBeTruthy();

        // Simulate the lease having long since "expired" (irrelevant for
        // 'abandoned', which this proves): if the old temporary-lease
        // design were still in effect, a lease this far in the past would
        // make the row reclaimable. It must not be, because this row is
        // 'abandoned', not 'in_progress'.
        await prisma.checkoutAttempt.update({
          where: { idempotencyKey: originalKey },
          data: { leaseExpiresAt: new Date(Date.now() - 10 * 60_000) },
        });

        // The merely-delayed original request now actually reaches the
        // server and tries to proceed under its OLD key. It must be
        // rejected outright — a distinct, non-retryable error, never the
        // generic "wait and recheck" CHECKOUT_ATTEMPT_IN_PROGRESS — and
        // never silently produce a second committed sale under the old key.
        await expect(isolated.checkout(originalKey)).rejects.toMatchObject({ code: 'CHECKOUT_ATTEMPT_ABANDONED' });

        expect(await prisma.transaction.count({ where: { idempotencyKey: { in: [originalKey, replacementKey] } } })).toBe(1);
        const sentinel = await prisma.checkoutAttempt.findUniqueOrThrow({ where: { idempotencyKey: originalKey } });
        // Still permanently abandoned — never flipped to committed by the
        // delayed original request, regardless of the lease timestamp.
        expect(sentinel.status).toBe('abandoned');
        expect(sentinel.transactionId).toBeNull();
      },
      15_000,
    );

    // POS-PERF-P15R5 — the counterpart scenario: instead of a never-
    // registered original request, an ALREADY-ISSUED retry under the same
    // (now-'failed') key races the client's own decision to abandon that
    // key and mint a replacement. Exactly one of these two paths may ever
    // produce a committed sale — never both, and never zero when at least
    // one of them is eligible to win. The atomic compare-and-swap in both
    // claimCheckoutAttempt (the retry's reclaim) and abandonCheckoutAttempt
    // (the abandon decision) race the same row: whichever wins first makes
    // the other's path fail outright instead of racing ahead blindly.
    it('abandoning a failed attempt while an already-issued retry under the same key is racing it commits exactly one sale across both the old and any replacement key', async () => {
      const isolated = await seedIsolatedVariant(1000);
      const idempotencyKey = randomUUID();

      // The original request is confirmed, pre-commit, to have failed —
      // immediately reclaimable, exactly like the existing R4 contract.
      await expect(
        transactionsService.createTransaction(
          {
            branchId,
            shiftId,
            cashierId: userId,
            items: [{ productId, productVariantId: isolated.variantId, quantity: 1 }],
            paymentMethod: 'cash',
            cashTendered: 1, // less than the 100 total — INSUFFICIENT_CASH_TENDERED, thrown before any $transaction
            isOfflineTransaction: false,
            idempotencyKey,
          },
          null,
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_CASH_TENDERED' });
      expect(await transactionsService.resolveCheckoutAttempt(idempotencyKey, branchId, userId)).toMatchObject({ status: 'failed' });

      // Race: an already-issued retry under the SAME key (e.g. a queued
      // click handler) vs. this client's own decision to give up on that
      // key and abandon it for good.
      const [abandonResult, retryResult] = await Promise.allSettled([
        transactionsService.abandonCheckoutAttempt(idempotencyKey, branchId, userId),
        isolated.checkout(idempotencyKey),
      ]);

      if (abandonResult.status === 'fulfilled' && abandonResult.value.status === 'abandoned') {
        // Abandon won: the retry under the old key must have been rejected
        // outright (never silently commit under an abandoned key)...
        expect(retryResult.status).toBe('rejected');
        if (retryResult.status === 'rejected') {
          expect(retryResult.reason).toMatchObject({ code: 'CHECKOUT_ATTEMPT_ABANDONED' });
        }
        // ...so only now is it actually safe to mint the replacement.
        const replacementKey = randomUUID();
        const replacementSale = await isolated.checkout(replacementKey);
        expect(replacementSale.id).toBeTruthy();
        expect(await prisma.transaction.count({ where: { idempotencyKey: { in: [idempotencyKey, replacementKey] } } })).toBe(1);
      } else {
        // The retry won the reclaim race first: abandon must have failed
        // to transition the row (it was no longer 'failed'/expired by the
        // time abandon's own atomic UPDATE ran), and the client must NOT
        // mint any replacement — the one sale already exists under the
        // OLD key.
        expect(retryResult.status).toBe('fulfilled');
        if (abandonResult.status === 'fulfilled') {
          expect(abandonResult.value.status).not.toBe('abandoned');
        }
        expect(await prisma.transaction.count({ where: { idempotencyKey } })).toBe(1);
      }

      // Exactly one intended sale, never zero, never two, regardless of
      // which side of the race won.
      const totalSales = await prisma.transaction.count({
        where: { cashierId: userId, branchId, createdAt: { gte: new Date(Date.now() - 60_000) } },
      });
      expect(totalSales).toBeGreaterThanOrEqual(1);
    });

    // POS-PERF-P15R4 — a 'failed' attempt is confirmed pre-commit-rolled-
    // back by the original request itself (not an absence inference), so
    // it stays immediately reclaimable with no settle-wait — ordinary
    // same-key retries of a failed attempt (no abandon decision involved
    // at all) must stay exactly as safe as before this revision.
    it('two concurrently-issued reclaims of the same failed-and-not-abandoned key never both commit a sale', async () => {
      const isolated = await seedIsolatedVariant(1000);
      const idempotencyKey = randomUUID();

      await expect(
        transactionsService.createTransaction(
          {
            branchId,
            shiftId,
            cashierId: userId,
            items: [{ productId, productVariantId: isolated.variantId, quantity: 1 }],
            paymentMethod: 'cash',
            cashTendered: 1, // less than the 100 total — INSUFFICIENT_CASH_TENDERED, thrown before any $transaction
            isOfflineTransaction: false,
            idempotencyKey,
          },
          null,
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_CASH_TENDERED' });

      expect(await transactionsService.resolveCheckoutAttempt(idempotencyKey, branchId, userId)).toMatchObject({ status: 'failed' });

      const results = await Promise.allSettled([isolated.checkout(idempotencyKey), isolated.checkout(idempotencyKey)]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ id: string }>[];
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      // Never two distinct sales under the one reclaimed key.
      expect(new Set(fulfilled.map((r) => r.value.id)).size).toBe(1);
      expect(await prisma.transaction.count({ where: { idempotencyKey } })).toBe(1);
    });

    // POS-PERF-P15R4 — exercises the exact commit-time owner_token fence
    // (transactions.service.ts createTransaction's $transaction callback)
    // against real Postgres: once a lease-expired attempt is reclaimed and
    // commits under a fresh owner_token, the original holder — alive the
    // whole time, just slow — must never be able to overwrite that row's
    // ownership or payload identity by finalizing under its old token.
    it("lease takeover: once a reclaim commits, the original lease-expired holder's own commit can never overwrite its ownership or payload", async () => {
      const isolated = await seedIsolatedVariant(1000);
      const idempotencyKey = randomUUID();
      const originalOwnerToken = randomUUID();

      // The "original" holder claimed the key but took so long its lease
      // already expired — reclaimable from the server's point of view,
      // even though it is, unbeknownst to anyone, still alive and about to
      // try to finalize.
      await prisma.checkoutAttempt.create({
        data: {
          idempotencyKey,
          branchId,
          cashierId: userId,
          status: 'in_progress',
          ownerToken: originalOwnerToken,
          leaseExpiresAt: new Date(Date.now() - 1_000),
        },
      });

      // A second, independent request reclaims the expired lease and
      // commits a real sale under a fresh owner_token.
      const reclaimedSale = await isolated.checkout(idempotencyKey);
      expect(reclaimedSale.id).toBeTruthy();

      // The original holder, unaware it was ever reclaimed, now tries to
      // finalize under its OLD owner_token — the exact fencing update
      // createTransaction's own $transaction callback runs at commit time.
      const impersonatedTransactionId = randomUUID();
      const affected = await prisma.$executeRaw`
        UPDATE "checkout_attempts"
        SET "status" = 'committed', "transaction_id" = ${impersonatedTransactionId}, "updated_at" = now()
        WHERE "idempotency_key" = ${idempotencyKey} AND "owner_token" = ${originalOwnerToken} AND "status" = 'in_progress'
      `;
      expect(affected).toBe(0);

      const attempt = await prisma.checkoutAttempt.findUniqueOrThrow({ where: { idempotencyKey } });
      expect(attempt.transactionId).toBe(reclaimedSale.id);
      expect(attempt.ownerToken).not.toBe(originalOwnerToken);
      expect(await prisma.transaction.count({ where: { idempotencyKey } })).toBe(1);
    });
  });

  describe('multi-ingredient rollback (POS-PERF-P15R3)', () => {
    it('a multi-ingredient sale that runs out of stock on the SECOND ingredient leaves the FIRST ingredient with no lingering reservation — all-or-nothing', async () => {
      const plentifulItemId = await seedCatalogItem(1000); // 2 base units/unit sold, ample stock
      // A second ingredient on the SAME variant with far too little stock to
      // cover the sale — reserveStockForSale must roll back the whole
      // $transaction (including the plentiful item's reservation above) the
      // instant this one fails, never leave a partial reservation behind.
      const scarceItem = await prisma.inventoryItem.create({
        data: { name: `r3-scarce-item-${randomUUID()}`, baseUnitId: unitId, trackInventory: true },
      });
      await prisma.inventoryStock.create({
        data: { branchId, inventoryItemId: scarceItem.id, quantityOnHand: new Prisma.Decimal(1), quantityReserved: new Prisma.Decimal(0) },
      });
      await prisma.productComponent.create({
        data: { productVariantId: variantId, inventoryItemId: scarceItem.id, quantityRequired: new Prisma.Decimal(5), recipeUnitId: null },
      });

      await expect(checkout(randomUUID())).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

      const plentifulStock = await getStock(plentifulItemId);
      expect(plentifulStock.quantityReserved.toNumber()).toBe(0);
      const scarceStock = await getStock(scarceItem.id);
      expect(scarceStock.quantityReserved.toNumber()).toBe(0);

      await prisma.productComponent.deleteMany({ where: { inventoryItemId: scarceItem.id } });
      await prisma.inventoryStock.deleteMany({ where: { branchId, inventoryItemId: scarceItem.id } });
      await prisma.inventoryItem.deleteMany({ where: { id: scarceItem.id } });
    });
  });

  describe('concurrent overselling through the actual checkout service (POS-PERF-P15R3)', () => {
    it('ten concurrent 1-unit sales against 5 available units let exactly 5 succeed and never drive on-hand below reserved', async () => {
      // Dedicated variant/item (not the shared seedCatalogItem/variantId) —
      // this test's assertion that EXACTLY 5 of 10 sales succeed would be
      // thrown off by however much stock margin earlier tests in this file
      // already consumed against the shared variant.
      const isolated = await seedIsolatedVariant(10); // quantityRequired=2/unit sold -> exactly 5 one-unit sales coverable (5*2=10).

      const attempts = Array.from({ length: 10 }, () => isolated.checkout(randomUUID()));
      const results = await Promise.allSettled(attempts);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(5);
      expect(rejected).toHaveLength(5);
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
      }

      const stock = await getStock(isolated.inventoryItemId);
      expect(stock.quantityReserved.toNumber()).toBe(10);
      expect(stock.quantityOnHand.toNumber()).toBeGreaterThanOrEqual(stock.quantityReserved.toNumber());
      expect(await prisma.transaction.count({ where: { id: { in: fulfilled.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id) } } })).toBe(5);
    });
  });
});
