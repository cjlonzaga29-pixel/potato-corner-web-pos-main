// POS-PERF-P69 — LOCAL browser fixtures for the POS product type filter, on
// top of the P62 stack (tests/e2e/manual/p62/stack.sh prepare). Refuses
// anything but a 127.0.0.1 p62_ database. Adds, at MAIN01 only:
//   - "P69 Cheese Fries PPO" (Promotional, size Regular, Flavored Fries)
//   - "P69 Iced Tea" (Seasonal, Drinks)
//   - "P69 Campaign Fries" (Regular; the driver assigns it to a custom type)
// each sellable with a P62 recipe, and a branch login for "P62 Branch 1"
// (branch B) whose password comes from P69_BRANCH_B_PASSWORD (never printed).
//
//   ALLOW_DATABASE_SEED=true npx tsx scripts/p69-browser-fixtures.ts
import bcrypt from 'bcrypt';
import { PrismaClient, Prisma } from '@prisma/client';

function assertDisposableLocal(): void {
  if (process.env.ALLOW_DATABASE_SEED !== 'true') throw new Error('Refusing: set ALLOW_DATABASE_SEED=true');
  if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('Refusing: PRODUCTION_DATABASE_URL_DIRECT is set');
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = process.env[name];
    if (!raw) throw new Error(`Refusing: ${name} is not set`);
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1') throw new Error(`Refusing: ${name} is not 127.0.0.1`);
    if (!/^\/p62_[a-z0-9_]+$/.test(url.pathname)) throw new Error(`Refusing: ${name} is not a p62_ database`);
  }
}

assertDisposableLocal();
const prisma = new PrismaClient({ log: [] });

async function main(): Promise<void> {
  const password = process.env.P69_BRANCH_B_PASSWORD;
  if (!password) throw new Error('Refusing: set P69_BRANCH_B_PASSWORD');
  if (await prisma.product.count({ where: { name: { startsWith: 'P69 ' } } })) throw new Error('Refusing: P69 fixtures already exist');
  const main = await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN01' } });
  const branchB = await prisma.branch.findFirstOrThrow({ where: { code: 'P62B1' } });
  const items = await prisma.inventoryItem.findMany({ where: { name: { in: ['P62 Item 1', 'P62 Item 2'] } }, orderBy: { name: 'asc' } });
  if (items.length !== 2) throw new Error('Refusing: run the P62 fixtures first');

  const out: Record<string, string> = { mainBranchId: main.id, branchBId: branchB.id };
  const products = [
    { key: 'cheese', name: 'P69 Cheese Fries PPO', classification: 'promotional' as const, category: 'Flavored Fries', price: 79 },
    { key: 'tea', name: 'P69 Iced Tea', classification: 'seasonal' as const, category: 'Drinks', price: 45 },
    { key: 'campaign', name: 'P69 Campaign Fries', classification: 'regular' as const, category: 'Flavored Fries', price: 89 },
  ];
  for (const spec of products) {
    const product = await prisma.product.create({
      data: { name: spec.name, category: spec.category, status: 'active', classification: spec.classification, isSeasonal: spec.classification === 'seasonal', everPublished: true },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: new Prisma.Decimal(spec.price), isActive: true, lifecycleStatus: 'ACTIVE' },
    });
    await prisma.productComponent.createMany({ data: items.map((item, i) => ({ productVariantId: variant.id, inventoryItemId: item.id, quantityRequired: new Prisma.Decimal(i + 1) })) });
    await prisma.branchProductAvailability.create({ data: { branchId: main.id, productId: product.id, isAvailable: true } });
    out[`${spec.key}ProductId`] = product.id;
  }
  out.itemIds = items.map((i) => i.id).join(',');

  const user = await prisma.user.create({
    data: {
      email: 'branch-b-p69@potatocorner.test',
      passwordHash: await bcrypt.hash(password, 12),
      role: 'branch',
      firstName: 'P69',
      lastName: 'Branch B',
      employmentType: 'regular',
      mustChangePassword: false,
    },
  });
  await prisma.userBranchAssignment.create({ data: { userId: user.id, branchId: branchB.id } });
  // Ids only (no secrets), for the driver.
  console.error(JSON.stringify(out));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
