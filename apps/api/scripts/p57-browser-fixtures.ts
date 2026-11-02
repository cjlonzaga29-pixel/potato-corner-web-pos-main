// POS-PERF-P57 — local-only fixture for the real-browser verification of recipe
// shortages, discount types and type-first product creation. Run after
// prisma/seed.ts on a NEW disposable database. MAIN01 reproduces the reported
// shortages; P57S01 stocks the same items well (transfer source, branch
// switching); P57X01 is not assigned to the seeded supervisor. Prints ids only.
//
// Usage (from apps/api): ALLOW_DATABASE_SEED=true P57_PIN_ANA=... P57_PIN_BEN=... npx tsx --env-file=<env> scripts/p57-browser-fixtures.ts
import { PrismaClient, Prisma } from '@prisma/client';

function assertDisposableLocal(): void {
  if (process.env.ALLOW_DATABASE_SEED !== 'true') throw new Error('Refusing: set ALLOW_DATABASE_SEED=true');
  if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('Refusing: PRODUCTION_DATABASE_URL_DIRECT is set');
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = process.env[name];
    if (!raw) throw new Error(`Refusing: ${name} is not set`);
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1') throw new Error(`Refusing: ${name} is not 127.0.0.1`);
    if (url.pathname !== '/p57_browser') throw new Error(`Refusing: ${name} is not the p57_browser database`);
  }
}

assertDisposableLocal();
const prisma = new PrismaClient();

const MAIN_STOCK: Record<string, number> = { 'P57 Raw Fries': 12, 'P57 Chicken Pops': 40, 'P57 Base': 100000, 'P57 Cheese': 5, 'P57 BBQ': 50, 'P57 Plenty': 100000 };

async function main(): Promise<void> {
  const mainBranch = await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN01' } });
  const south = await prisma.branch.upsert({ where: { code: 'P57S01' }, update: { status: 'active' }, create: { name: 'P57 South', code: 'P57S01', address: 'x', city: 'x', status: 'active' } });
  const other = await prisma.branch.upsert({ where: { code: 'P57X01' }, update: { status: 'active' }, create: { name: 'P57 Elsewhere', code: 'P57X01', address: 'x', city: 'x', status: 'active' } });
  const supervisor = await prisma.user.findFirstOrThrow({ where: { email: 'supervisor@potatocorner.test' } });
  for (const branchId of [mainBranch.id, south.id]) {
    const assigned = await prisma.userBranchAssignment.findFirst({ where: { userId: supervisor.id, branchId, removedAt: null } });
    if (!assigned) await prisma.userBranchAssignment.create({ data: { userId: supervisor.id, branchId } });
  }

  const unit = await prisma.unitOfMeasure.upsert({ where: { code: 'g' }, update: {}, create: { code: 'g', name: 'Gram', dimension: 'WEIGHT', isBaseUnit: true } });
  const items: Record<string, string> = {};
  for (const [name, quantity] of Object.entries(MAIN_STOCK)) {
    const item = (await prisma.inventoryItem.findFirst({ where: { name } })) ?? (await prisma.inventoryItem.create({ data: { name, baseUnitId: unit.id, trackInventory: true } }));
    items[name] = item.id;
    for (const [branchId, onHand] of [[mainBranch.id, quantity], [south.id, 5000], [other.id, 5000]] as const) {
      const data = { quantityOnHand: new Prisma.Decimal(onHand), quantityReserved: new Prisma.Decimal(0), lowStockThreshold: null, criticalThreshold: null };
      await prisma.inventoryStock.upsert({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: item.id } }, update: data, create: { branchId, inventoryItemId: item.id, ...data } });
    }
  }

  const makeProduct = async (name: string, classification: 'regular' | 'promotional' | 'seasonal', sizes: { size: string; price: number; recipe: { item: string; quantity: number; flavorId?: string }[] }[]) => {
    const product = (await prisma.product.findFirst({ where: { name } })) ?? (await prisma.product.create({ data: { name, category: 'P57', status: 'active', classification, everPublished: true } }));
    const variants: Record<string, string> = {};
    for (const spec of sizes) {
      const variant =
        (await prisma.productVariant.findFirst({ where: { productId: product.id, sizeLabel: spec.size } })) ??
        (await prisma.productVariant.create({ data: { productId: product.id, name: spec.size, sizeLabel: spec.size, basePrice: new Prisma.Decimal(spec.price), isActive: true, lifecycleStatus: 'ACTIVE' } }));
      variants[spec.size] = variant.id;
      for (const line of spec.recipe) {
        const inventoryItemId = items[line.item] as string;
        const exists = await prisma.productComponent.findFirst({ where: { productVariantId: variant.id, inventoryItemId } });
        if (!exists) await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId, quantityRequired: new Prisma.Decimal(line.quantity), flavorId: line.flavorId ?? null } });
      }
    }
    for (const branchId of [mainBranch.id, south.id, other.id]) {
      await prisma.branchProductAvailability.upsert({ where: { branchId_productId: { branchId, productId: product.id } }, update: { isAvailable: true }, create: { branchId, productId: product.id, isAvailable: true } });
    }
    return { id: product.id, variants };
  };

  await makeProduct('P57 Fries', 'regular', [
    { size: 'Regular', price: 50, recipe: [{ item: 'P57 Raw Fries', quantity: 20 }] },
    { size: 'Large', price: 70, recipe: [{ item: 'P57 Raw Fries', quantity: 40 }] },
  ]);
  await makeProduct('P57 Pops', 'regular', [{ size: 'Regular', price: 60, recipe: [{ item: 'P57 Chicken Pops', quantity: 70 }] }]);
  const classic = await makeProduct('P57 Classic', 'promotional', [{ size: 'Regular', price: 100, recipe: [{ item: 'P57 Plenty', quantity: 1 }] }]);
  await makeProduct('P57 Side', 'seasonal', [{ size: 'Regular', price: 30, recipe: [{ item: 'P57 Plenty', quantity: 1 }] }]);

  const flavor = async (name: string) => (await prisma.flavor.findFirst({ where: { name } })) ?? (await prisma.flavor.create({ data: { name, ingredientName: 'x', ingredientUnit: 'g', isActive: true } }));
  const [cheese, bbq] = [await flavor('P57 Cheese Flavor'), await flavor('P57 BBQ Flavor')];
  const flavored = await makeProduct('P57 Flavored', 'regular', [
    {
      size: 'Regular',
      price: 55,
      recipe: [
        { item: 'P57 Base', quantity: 1 },
        { item: 'P57 Cheese', quantity: 10, flavorId: cheese.id },
        { item: 'P57 BBQ', quantity: 10, flavorId: bbq.id },
      ],
    },
  ]);
  for (const flavorId of [cheese.id, bbq.id]) {
    const productVariantId = flavored.variants.Regular as string;
    const exists = await prisma.productVariantFlavor.findFirst({ where: { productVariantId, flavorId } });
    if (!exists) await prisma.productVariantFlavor.create({ data: { productVariantId, flavorId, isAvailable: true } });
  }

  const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@potatocorner.test' } });
  const { staffPinService } = await import('../src/modules/staff-pin/staff-pin.service.js');
  const cashiers: Record<string, string> = {};
  for (const [first, last, pin] of [['Ana', 'Reyes', process.env.P57_PIN_ANA], ['Ben', 'Cruz', process.env.P57_PIN_BEN]] as const) {
    if (!pin) continue;
    const user = await prisma.user.upsert({
      where: { employeeId: `P57-${first}` },
      update: { isActive: true, status: 'active' },
      create: { role: 'staff', firstName: first, lastName: last, employeeId: `P57-${first}`, employmentType: 'regular', mustChangePassword: false },
    });
    cashiers[first] = user.id;
    const existing = await prisma.userBranchAssignment.findFirst({ where: { userId: user.id, branchId: mainBranch.id, removedAt: null } });
    if (!existing) await prisma.userBranchAssignment.create({ data: { userId: user.id, branchId: mainBranch.id } });
    await staffPinService.setPin(user.id, pin, { user_id: admin.id, role: 'super_admin', email: admin.email, iat: 0, exp: 9999999999 } as never, null);
    const open = await prisma.attendanceRecord.findFirst({ where: { employeeId: user.id, branchId: mainBranch.id, clockOutServerTime: null, deletedAt: null } });
    if (!open) await prisma.attendanceRecord.create({ data: { employeeId: user.id, branchId: mainBranch.id, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });
  }

  console.log(JSON.stringify({ main: mainBranch.id, south: south.id, other: other.id, classic: classic.id, items, cashiers }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
