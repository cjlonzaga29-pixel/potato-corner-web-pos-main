/**
 * Checkout critical-path benchmark — measures transactionsService.createTransaction
 * wall-clock latency for 1/5/10/20-item carts against a real, disposable Postgres
 * database. Never touches production: refuses to run unless DATABASE_URL resolves
 * to localhost/127.0.0.1.
 *
 * Usage: DATABASE_URL=postgresql://user:pass@localhost:5432/potato_corner_bench npx tsx scripts/checkout-perf-benchmark.ts
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.DATABASE_URL ?? '';
let host = '';
try {
  host = new URL(databaseUrl).hostname;
} catch {
  // fall through to the guard below
}
if (host !== 'localhost' && host !== '127.0.0.1') {
  console.error(`Refusing to run: DATABASE_URL host is "${host}", not localhost/127.0.0.1. This benchmark must never run against a remote/production database.`);
  process.exit(1);
}

const prisma = new PrismaClient();

const CART_SIZES = [1, 5, 10, 20];
const ITERATIONS_PER_SIZE = 5;

async function seed(itemCount: number) {
  const branch = await prisma.branch.create({
    data: { name: 'Bench Branch', code: `BENCH-${randomUUID().slice(0, 8)}`, address: 'N/A', city: 'N/A', status: 'active' },
  });

  const baseUnit = await prisma.unitOfMeasure.create({
    data: { code: `g-${randomUUID().slice(0, 8)}`, name: 'gram', dimension: 'WEIGHT', isBaseUnit: true, isActive: true },
  });

  const cashier = await prisma.user.create({
    data: {
      email: `bench-cashier-${randomUUID()}@potatocorner.test`,
      passwordHash: 'x',
      role: 'staff',
      firstName: 'Bench',
      lastName: 'Cashier',
      employeeId: `BC-${randomUUID().slice(0, 8)}`,
      employmentType: 'regular',
      mustChangePassword: false,
      isActive: true,
      status: 'active',
    },
  });

  const shift = await prisma.shift.create({
    data: {
      branchId: branch.id,
      cashierId: cashier.id,
      openedBy: cashier.id,
      status: 'active',
      openingCashAmount: 0,
      startedAt: new Date(),
    },
  });

  const variantIds: string[] = [];
  for (let i = 0; i < itemCount; i++) {
    const inventoryItem = await prisma.inventoryItem.create({
      data: { name: `Bench Ingredient ${i}`, baseUnitId: baseUnit.id, trackInventory: true },
    });
    await prisma.inventoryStock.create({
      data: { branchId: branch.id, inventoryItemId: inventoryItem.id, quantityOnHand: 1_000_000 },
    });

    const product = await prisma.product.create({
      data: { name: `Bench Product ${i}`, status: 'active' },
    });
    await prisma.branchProductAvailability.create({
      data: { branchId: branch.id, productId: product.id, isAvailable: true },
    });
    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        name: 'Regular',
        sizeLabel: 'Regular',
        basePrice: 50,
        isActive: true,
        lifecycleStatus: 'ACTIVE',
      },
    });
    await prisma.productComponent.create({
      data: {
        productVariantId: variant.id,
        inventoryItemId: inventoryItem.id,
        quantityRequired: 10,
        isActive: true,
      },
    });
    variantIds.push(variant.id);
  }

  return { branch, shift, cashier, variantIds };
}

async function main() {
  console.warn(`Seeding fixtures against ${host}...`);
  const results: { cartSize: number; runsMs: number[]; avgMs: number; p95Ms: number }[] = [];

  const { transactionsService } = await import('../src/modules/transactions/transactions.service.js');

  for (const cartSize of CART_SIZES) {
    const { branch, shift, cashier, variantIds } = await seed(cartSize);
    const runsMs: number[] = [];

    const variantsWithProduct = await prisma.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, productId: true },
    });
    const productIdByVariant = new Map(variantsWithProduct.map((v) => [v.id, v.productId]));
    const items = variantIds.map((productVariantId) => ({
      productId: productIdByVariant.get(productVariantId) as string,
      productVariantId,
      quantity: 1,
    }));

    for (let iter = 0; iter < ITERATIONS_PER_SIZE; iter++) {
      const startedAt = performance.now();
      await transactionsService.createTransaction(
        {
          branchId: branch.id,
          shiftId: shift.id,
          cashierId: cashier.id,
          items,
          paymentMethod: 'cash',
          cashTendered: 50 * cartSize + 100,
          isOfflineTransaction: false,
        },
        null,
      );
      runsMs.push(performance.now() - startedAt);
    }

    runsMs.sort((a, b) => a - b);
    const avgMs = runsMs.reduce((s, v) => s + v, 0) / runsMs.length;
    const p95Ms = runsMs[Math.min(runsMs.length - 1, Math.ceil(runsMs.length * 0.95) - 1)];
    results.push({ cartSize, runsMs: runsMs.map((v) => Math.round(v)), avgMs, p95Ms });
    console.warn(`  cart size ${cartSize}: runs=${runsMs.map((v) => Math.round(v)).join(',')}ms avg=${Math.round(avgMs)}ms`);
  }

  console.warn('\n=== BENCHMARK RESULTS ===');
  for (const r of results) {
    console.warn(`${r.cartSize} item(s): avg=${Math.round(r.avgMs)}ms p95=${Math.round(r.p95Ms)}ms runs=[${r.runsMs.join(', ')}]ms`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
