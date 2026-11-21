// POS-PERF-P59 — local-only fixture for the real-browser verification of the
// Discount Report. Run after prisma/seed.ts on a NEW disposable database. MAIN01
// and P59N01 are the seeded supervisor's branches; each gets a type named PWD, so
// the two must stay separate. Sales themselves are rung through the real API by
// the browser driver. Prints ids only.
//
// Usage (from apps/api): ALLOW_DATABASE_SEED=true npx tsx scripts/p59-browser-fixtures.ts
import { PrismaClient, Prisma } from '@prisma/client';

function assertDisposableLocal(): void {
  if (process.env.ALLOW_DATABASE_SEED !== 'true') throw new Error('Refusing: set ALLOW_DATABASE_SEED=true');
  if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('Refusing: PRODUCTION_DATABASE_URL_DIRECT is set');
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = process.env[name];
    if (!raw) throw new Error(`Refusing: ${name} is not set`);
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1') throw new Error(`Refusing: ${name} is not 127.0.0.1`);
    if (url.pathname !== '/p59_browser') throw new Error(`Refusing: ${name} is not the p59_browser database`);
  }
}

assertDisposableLocal();
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const mainBranch = await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN01' } });
  const north = await prisma.branch.upsert({ where: { code: 'P59N01' }, update: { status: 'active' }, create: { name: 'P59 North', code: 'P59N01', address: 'x', city: 'x', status: 'active' } });
  const supervisor = await prisma.user.findFirstOrThrow({ where: { email: 'supervisor@potatocorner.test' } });
  const staff = await prisma.user.findFirstOrThrow({ where: { email: 'staff@potatocorner.test' } });
  for (const branchId of [mainBranch.id, north.id]) {
    const assigned = await prisma.userBranchAssignment.findFirst({ where: { userId: supervisor.id, branchId, removedAt: null } });
    if (!assigned) await prisma.userBranchAssignment.create({ data: { userId: supervisor.id, branchId } });
  }

  const unit = await prisma.unitOfMeasure.upsert({ where: { code: 'g' }, update: {}, create: { code: 'g', name: 'Gram', dimension: 'WEIGHT', isBaseUnit: true } });
  const item = (await prisma.inventoryItem.findFirst({ where: { name: 'P59 Plenty' } })) ?? (await prisma.inventoryItem.create({ data: { name: 'P59 Plenty', baseUnitId: unit.id, trackInventory: true } }));
  const product = (await prisma.product.findFirst({ where: { name: 'P59 Fries' } })) ?? (await prisma.product.create({ data: { name: 'P59 Fries', category: 'P59', status: 'active', classification: 'regular', everPublished: true } }));
  const variant = (await prisma.productVariant.findFirst({ where: { productId: product.id } })) ?? (await prisma.productVariant.create({ data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: new Prisma.Decimal(250), isActive: true, lifecycleStatus: 'ACTIVE' } }));
  const component = await prisma.productComponent.findFirst({ where: { productVariantId: variant.id } });
  if (!component) await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: item.id, quantityRequired: new Prisma.Decimal(1) } });
  for (const branchId of [mainBranch.id, north.id]) {
    const stock = { quantityOnHand: new Prisma.Decimal(100000), quantityReserved: new Prisma.Decimal(0) };
    await prisma.inventoryStock.upsert({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: item.id } }, update: stock, create: { branchId, inventoryItemId: item.id, ...stock } });
    await prisma.branchProductAvailability.upsert({ where: { branchId_productId: { branchId, productId: product.id } }, update: { isAvailable: true }, create: { branchId, productId: product.id, isAvailable: true } });
  }
  const clockedIn = await prisma.attendanceRecord.findFirst({ where: { employeeId: staff.id, clockOutServerTime: null } });
  if (!clockedIn) await prisma.attendanceRecord.create({ data: { employeeId: staff.id, branchId: mainBranch.id, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });

  // One open attendance record per employee: North's sale is rung by its own crew.
  const northStaff = await prisma.user.upsert({
    where: { email: 'p59-north-staff@potatocorner.test' },
    update: {},
    create: { email: 'p59-north-staff@potatocorner.test', passwordHash: staff.passwordHash, role: 'staff', firstName: 'North', lastName: 'Crew', employeeId: 'P59-NORTH', employmentType: 'regular', mustChangePassword: false },
  });
  const assignedNorth = await prisma.userBranchAssignment.findFirst({ where: { userId: northStaff.id, branchId: north.id, removedAt: null } });
  if (!assignedNorth) await prisma.userBranchAssignment.create({ data: { userId: northStaff.id, branchId: north.id } });
  const northClockedIn = await prisma.attendanceRecord.findFirst({ where: { employeeId: northStaff.id, clockOutServerTime: null } });
  if (!northClockedIn) await prisma.attendanceRecord.create({ data: { employeeId: northStaff.id, branchId: north.id, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });

  console.warn(JSON.stringify({ main: mainBranch.id, north: north.id, product: product.id, variant: variant.id, supervisor: supervisor.id, staff: staff.id }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
