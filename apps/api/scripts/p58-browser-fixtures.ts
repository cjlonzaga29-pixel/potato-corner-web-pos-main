// POS-PERF-P58 — local-only fixture for the real-browser verification of custom
// product types. Run after prisma/seed.ts on a NEW disposable database. MAIN01 and
// P58S01 are the seeded supervisor's branches; P58X01 is not assigned to them, and
// holds another supervisor's type. Products of each built-in type sit at MAIN01,
// plus one shared with P58X01 for the branch-copy path. Prints ids only.
//
// Usage (from apps/api): ALLOW_DATABASE_SEED=true npx tsx scripts/p58-browser-fixtures.ts
import { PrismaClient, Prisma } from '@prisma/client';

function assertDisposableLocal(): void {
  if (process.env.ALLOW_DATABASE_SEED !== 'true') throw new Error('Refusing: set ALLOW_DATABASE_SEED=true');
  if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('Refusing: PRODUCTION_DATABASE_URL_DIRECT is set');
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = process.env[name];
    if (!raw) throw new Error(`Refusing: ${name} is not set`);
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1') throw new Error(`Refusing: ${name} is not 127.0.0.1`);
    if (url.pathname !== '/p58_browser') throw new Error(`Refusing: ${name} is not the p58_browser database`);
  }
}

assertDisposableLocal();
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const mainBranch = await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN01' } });
  const south = await prisma.branch.upsert({ where: { code: 'P58S01' }, update: { status: 'active' }, create: { name: 'P58 South', code: 'P58S01', address: 'x', city: 'x', status: 'active' } });
  const other = await prisma.branch.upsert({ where: { code: 'P58X01' }, update: { status: 'active' }, create: { name: 'P58 Elsewhere', code: 'P58X01', address: 'x', city: 'x', status: 'active' } });
  const supervisor = await prisma.user.findFirstOrThrow({ where: { email: 'supervisor@potatocorner.test' } });
  for (const branchId of [mainBranch.id, south.id]) {
    const assigned = await prisma.userBranchAssignment.findFirst({ where: { userId: supervisor.id, branchId, removedAt: null } });
    if (!assigned) await prisma.userBranchAssignment.create({ data: { userId: supervisor.id, branchId } });
  }

  const unit = await prisma.unitOfMeasure.upsert({ where: { code: 'g' }, update: {}, create: { code: 'g', name: 'Gram', dimension: 'WEIGHT', isBaseUnit: true } });
  const item = (await prisma.inventoryItem.findFirst({ where: { name: 'P58 Plenty' } })) ?? (await prisma.inventoryItem.create({ data: { name: 'P58 Plenty', baseUnitId: unit.id, trackInventory: true } }));
  for (const branchId of [mainBranch.id, south.id, other.id]) {
    const data = { quantityOnHand: new Prisma.Decimal(100000), quantityReserved: new Prisma.Decimal(0) };
    await prisma.inventoryStock.upsert({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: item.id } }, update: data, create: { branchId, inventoryItemId: item.id, ...data } });
  }

  const makeProduct = async (name: string, classification: 'regular' | 'promotional' | 'seasonal', branchIds: string[]) => {
    const product = (await prisma.product.findFirst({ where: { name } })) ?? (await prisma.product.create({ data: { name, category: 'P58', status: 'active', classification, isSeasonal: classification === 'seasonal', everPublished: true } }));
    const variant = (await prisma.productVariant.findFirst({ where: { productId: product.id } })) ?? (await prisma.productVariant.create({ data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: new Prisma.Decimal(100), isActive: true, lifecycleStatus: 'ACTIVE' } }));
    const component = await prisma.productComponent.findFirst({ where: { productVariantId: variant.id } });
    if (!component) await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: item.id, quantityRequired: new Prisma.Decimal(1) } });
    for (const branchId of branchIds) {
      await prisma.branchProductAvailability.upsert({ where: { branchId_productId: { branchId, productId: product.id } }, update: { isAvailable: true }, create: { branchId, productId: product.id, isAvailable: true } });
    }
    return product.id;
  };

  const regular = await makeProduct('P58 Plain Fries', 'regular', [mainBranch.id, south.id]);
  const promotional = await makeProduct('P58 Promo Fries', 'promotional', [mainBranch.id]);
  await makeProduct('P58 Holiday Fries', 'seasonal', [mainBranch.id]);
  const shared = await makeProduct('P58 Shared Fries', 'regular', [mainBranch.id, other.id]);

  // A type at a branch outside the seeded supervisor's assignment.
  const otherSupervisor = await prisma.user.upsert({
    where: { email: 'p58-other@potatocorner.test' },
    update: {},
    create: { email: 'p58-other@potatocorner.test', passwordHash: 'unused', role: 'supervisor', firstName: 'P58', lastName: 'Other', employmentType: 'regular', mustChangePassword: false },
  });
  const hiddenExisting = await prisma.productType.findFirst({ where: { normalizedName: 'p58 elsewhere type' } });
  const hidden = hiddenExisting ?? (await prisma.productType.create({ data: { name: 'P58 Elsewhere Type', normalizedName: 'p58 elsewhere type', createdById: otherSupervisor.id } }));
  await prisma.productTypeBranch.upsert({
    where: { productTypeId_branchId: { productTypeId: hidden.id, branchId: other.id } },
    update: {},
    create: { productTypeId: hidden.id, branchId: other.id, normalizedName: hidden.normalizedName, isActive: true },
  });

  // Enough custom types to prove the navigation holds up, at the second branch only.
  for (let n = 1; n <= 30; n += 1) {
    const name = n === 30 ? `Campaign ${'x'.repeat(50)}` : `Campaign ${n}`;
    const normalizedName = name.toLowerCase();
    const existing = await prisma.productType.findFirst({ where: { normalizedName } });
    const row = existing ?? (await prisma.productType.create({ data: { name, normalizedName, createdById: supervisor.id } }));
    await prisma.productTypeBranch.upsert({
      where: { productTypeId_branchId: { productTypeId: row.id, branchId: south.id } },
      update: {},
      create: { productTypeId: row.id, branchId: south.id, normalizedName, isActive: true },
    });
  }

  console.warn(JSON.stringify({ main: mainBranch.id, south: south.id, other: other.id, regular, promotional, shared, hiddenType: hidden.id, supervisor: supervisor.id }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
