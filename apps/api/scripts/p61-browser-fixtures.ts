// POS-PERF-P61 — local-only fixture for driving Extra Supplies on the real screens.
// Run after prisma/seed.ts on a NEW disposable database. Two cashiers with PINs, both
// clocked in at MAIN01; stocked items in known units and costs; a product whose recipe
// uses the same cup, so ordinary packaging can be checked next to extra issues; a
// second branch of the seeded supervisor; and a branch and supervisor it must never
// see. No card or issue is created: the driver makes those on screen. Prints ids only.
//
// Usage (from apps/api): ALLOW_DATABASE_SEED=true P61_PIN_ANA=... P61_PIN_BEN=... npx tsx scripts/p61-browser-fixtures.ts
import { PrismaClient, Prisma } from '@prisma/client';

function assertDisposableLocal(): void {
  if (process.env.ALLOW_DATABASE_SEED !== 'true') throw new Error('Refusing: set ALLOW_DATABASE_SEED=true');
  if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('Refusing: PRODUCTION_DATABASE_URL_DIRECT is set');
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = process.env[name];
    if (!raw) throw new Error(`Refusing: ${name} is not set`);
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1') throw new Error(`Refusing: ${name} is not 127.0.0.1`);
    if (url.pathname !== '/p61_browser') throw new Error(`Refusing: ${name} is not the p61_browser database`);
  }
}

assertDisposableLocal();
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const pins = { ana: process.env.P61_PIN_ANA, ben: process.env.P61_PIN_BEN };
  if (!pins.ana || !pins.ben) throw new Error('Refusing: set P61_PIN_ANA and P61_PIN_BEN');
  const mainBranch = await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN01' } });
  const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@potatocorner.test' } });
  const supervisor = await prisma.user.findFirstOrThrow({ where: { email: 'supervisor@potatocorner.test' } });

  const pc = await prisma.unitOfMeasure.upsert({ where: { code: 'pc' }, update: {}, create: { code: 'pc', name: 'Piece', dimension: 'COUNT', isBaseUnit: true } });
  const pack = await prisma.unitOfMeasure.upsert({ where: { code: 'pack' }, update: {}, create: { code: 'pack', name: 'Pack', dimension: 'COUNT' } });
  const sack = await prisma.unitOfMeasure.upsert({ where: { code: 'sack' }, update: {}, create: { code: 'sack', name: 'Sack', dimension: 'COUNT' } });
  const g = await prisma.unitOfMeasure.upsert({ where: { code: 'g' }, update: {}, create: { code: 'g', name: 'Gram', dimension: 'WEIGHT', isBaseUnit: true } });

  const item = async (name: string, baseUnitId: string) => (await prisma.inventoryItem.findFirst({ where: { name } })) ?? prisma.inventoryItem.create({ data: { name, baseUnitId } });
  const cup = await item('P61 Paper Cup', pc.id);
  const tissue = await item('P61 Tissue', pc.id);
  const potato = await item('P61 Potato', g.id);
  // Conversions are per item: a pack means a different count for each.
  if ((await prisma.inventoryItemUnitConversion.count({ where: { inventoryItemId: tissue.id, fromUnitId: pack.id, toUnitId: pc.id } })) === 0) {
    await prisma.inventoryItemUnitConversion.create({ data: { inventoryItemId: tissue.id, fromUnitId: pack.id, toUnitId: pc.id, factor: 10 } });
  }

  const stock = async (inventoryItemId: string, onHand: number, unitCost: number | null) => {
    const data = { quantityOnHand: new Prisma.Decimal(onHand), quantityReserved: new Prisma.Decimal(0), unitCost: unitCost === null ? null : new Prisma.Decimal(unitCost) };
    await prisma.inventoryStock.upsert({ where: { branchId_inventoryItemId: { branchId: mainBranch.id, inventoryItemId } }, update: data, create: { branchId: mainBranch.id, inventoryItemId, ...data } });
  };
  await stock(cup.id, 100, 2);
  await stock(tissue.id, 100, null);
  await stock(potato.id, 100000, 0.1);

  const product = (await prisma.product.findFirst({ where: { name: 'P61 Fries' } })) ?? (await prisma.product.create({ data: { name: 'P61 Fries', category: 'P61', status: 'active', classification: 'regular', everPublished: true } }));
  const variant = (await prisma.productVariant.findFirst({ where: { productId: product.id } })) ?? (await prisma.productVariant.create({ data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: new Prisma.Decimal(100), isActive: true, lifecycleStatus: 'ACTIVE' } }));
  if ((await prisma.productComponent.count({ where: { productVariantId: variant.id } })) === 0) {
    await prisma.productComponent.createMany({
      data: [
        { productVariantId: variant.id, inventoryItemId: potato.id, quantityRequired: new Prisma.Decimal(100) },
        { productVariantId: variant.id, inventoryItemId: cup.id, quantityRequired: new Prisma.Decimal(1) },
      ],
    });
  }
  await prisma.branchProductAvailability.upsert({ where: { branchId_productId: { branchId: mainBranch.id, productId: product.id } }, update: { isAvailable: true }, create: { branchId: mainBranch.id, productId: product.id, isAvailable: true } });

  const { staffPinService } = await import('../src/modules/staff-pin/staff-pin.service.js');
  const cashier = async (employeeId: string, firstName: string, lastName: string, pin: string) => {
    const row = await prisma.user.upsert({
      where: { employeeId },
      update: { isActive: true, status: 'active' },
      create: { role: 'staff', firstName, lastName, employeeId, employmentType: 'regular', mustChangePassword: false },
    });
    if (!(await prisma.userBranchAssignment.findFirst({ where: { userId: row.id, branchId: mainBranch.id, removedAt: null } }))) {
      await prisma.userBranchAssignment.create({ data: { userId: row.id, branchId: mainBranch.id } });
    }
    await staffPinService.setPin(row.id, pin, { user_id: admin.id, role: 'super_admin', email: admin.email, iat: 0, exp: 9999999999 } as never, null);
    if (!(await prisma.attendanceRecord.findFirst({ where: { employeeId: row.id, branchId: mainBranch.id, clockOutServerTime: null, deletedAt: null } }))) {
      await prisma.attendanceRecord.create({ data: { employeeId: row.id, branchId: mainBranch.id, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsLat: 14.6, clockInGpsLng: 121.0, clockInGpsStatus: 'within_radius' } });
    }
    return row;
  };
  const ana = await cashier('P61-Ana', 'Ana', 'Reyes', pins.ana);
  const ben = await cashier('P61-Ben', 'Ben', 'Cruz', pins.ben);

  const second = await prisma.branch.upsert({ where: { code: 'P61B2' }, update: { status: 'active' }, create: { name: 'P61 Second', code: 'P61B2', address: 'x', city: 'x', status: 'active' } });
  if (!(await prisma.userBranchAssignment.findFirst({ where: { userId: supervisor.id, branchId: second.id, removedAt: null } }))) {
    await prisma.userBranchAssignment.create({ data: { userId: supervisor.id, branchId: second.id } });
  }
  const elsewhere = await prisma.branch.upsert({ where: { code: 'P61X1' }, update: { status: 'active' }, create: { name: 'P61 Elsewhere', code: 'P61X1', address: 'x', city: 'x', status: 'active' } });
  const other = await prisma.user.upsert({
    where: { email: 'p61-other-supervisor@potatocorner.test' },
    update: {},
    create: { email: 'p61-other-supervisor@potatocorner.test', passwordHash: supervisor.passwordHash, role: 'supervisor', firstName: 'Other', lastName: 'Supervisor', employmentType: 'regular', mustChangePassword: false },
  });
  if (!(await prisma.userBranchAssignment.findFirst({ where: { userId: other.id, branchId: elsewhere.id, removedAt: null } }))) {
    await prisma.userBranchAssignment.create({ data: { userId: other.id, branchId: elsewhere.id } });
  }

  console.warn(JSON.stringify({ main: mainBranch.id, second: second.id, elsewhere: elsewhere.id, cup: cup.id, tissue: tissue.id, potato: potato.id, product: product.id, variant: variant.id, ana: ana.id, ben: ben.id, sack: sack.id, pack: pack.id, pc: pc.id }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
