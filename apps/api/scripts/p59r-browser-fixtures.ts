// POS-PERF-P59 — local-only fixture for driving the real terminal screen with the
// service worker active. Run after prisma/seed.ts on a NEW disposable database.
// One cashier with a PIN, already clocked in at MAIN01, and one product with a
// known recipe and stock, so stock deductions can be checked exactly. The discount
// type itself is created through the Supervisor screen by the driver. Prints ids only.
//
// Usage (from apps/api): ALLOW_DATABASE_SEED=true P59R_PIN_ANA=... npx tsx scripts/p59r-browser-fixtures.ts
import { PrismaClient, Prisma } from '@prisma/client';

function assertDisposableLocal(): void {
  if (process.env.ALLOW_DATABASE_SEED !== 'true') throw new Error('Refusing: set ALLOW_DATABASE_SEED=true');
  if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('Refusing: PRODUCTION_DATABASE_URL_DIRECT is set');
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = process.env[name];
    if (!raw) throw new Error(`Refusing: ${name} is not set`);
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1') throw new Error(`Refusing: ${name} is not 127.0.0.1`);
    if (url.pathname !== '/p59r_browser') throw new Error(`Refusing: ${name} is not the p59r_browser database`);
  }
}

assertDisposableLocal();
const prisma = new PrismaClient();

const STOCK_ON_HAND = 1000;

async function main(): Promise<void> {
  const pin = process.env.P59R_PIN_ANA;
  if (!pin) throw new Error('Refusing: set P59R_PIN_ANA');
  const mainBranch = await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN01' } });
  const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@potatocorner.test' } });

  const unit = await prisma.unitOfMeasure.upsert({ where: { code: 'g' }, update: {}, create: { code: 'g', name: 'Gram', dimension: 'WEIGHT', isBaseUnit: true } });
  const item = (await prisma.inventoryItem.findFirst({ where: { name: 'P59R Potato' } })) ?? (await prisma.inventoryItem.create({ data: { name: 'P59R Potato', baseUnitId: unit.id, trackInventory: true } }));
  const stock = { quantityOnHand: new Prisma.Decimal(STOCK_ON_HAND), quantityReserved: new Prisma.Decimal(0) };
  await prisma.inventoryStock.upsert({ where: { branchId_inventoryItemId: { branchId: mainBranch.id, inventoryItemId: item.id } }, update: stock, create: { branchId: mainBranch.id, inventoryItemId: item.id, ...stock } });

  const product = (await prisma.product.findFirst({ where: { name: 'P59R Fries' } })) ?? (await prisma.product.create({ data: { name: 'P59R Fries', category: 'P59R', status: 'active', classification: 'regular', everPublished: true } }));
  const variant = (await prisma.productVariant.findFirst({ where: { productId: product.id } })) ?? (await prisma.productVariant.create({ data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: new Prisma.Decimal(100), isActive: true, lifecycleStatus: 'ACTIVE' } }));
  const component = await prisma.productComponent.findFirst({ where: { productVariantId: variant.id } });
  if (!component) await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: item.id, quantityRequired: new Prisma.Decimal(5) } });
  await prisma.branchProductAvailability.upsert({ where: { branchId_productId: { branchId: mainBranch.id, productId: product.id } }, update: { isAvailable: true }, create: { branchId: mainBranch.id, productId: product.id, isAvailable: true } });

  const ana = await prisma.user.upsert({
    where: { employeeId: 'P59R-Ana' },
    update: { isActive: true, status: 'active' },
    create: { role: 'staff', firstName: 'Ana', lastName: 'Reyes', employeeId: 'P59R-Ana', employmentType: 'regular', mustChangePassword: false },
  });
  const assigned = await prisma.userBranchAssignment.findFirst({ where: { userId: ana.id, branchId: mainBranch.id, removedAt: null } });
  if (!assigned) await prisma.userBranchAssignment.create({ data: { userId: ana.id, branchId: mainBranch.id } });
  const { staffPinService } = await import('../src/modules/staff-pin/staff-pin.service.js');
  await staffPinService.setPin(ana.id, pin, { user_id: admin.id, role: 'super_admin', email: admin.email, iat: 0, exp: 9999999999 } as never, null);
  const open = await prisma.attendanceRecord.findFirst({ where: { employeeId: ana.id, branchId: mainBranch.id, clockOutServerTime: null, deletedAt: null } });
  if (!open) await prisma.attendanceRecord.create({ data: { employeeId: ana.id, branchId: mainBranch.id, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });

  // A supervisor of another branch: must not be able to view this branch's proof.
  const elsewhere = await prisma.branch.upsert({ where: { code: 'P59RX1' }, update: { status: 'active' }, create: { name: 'P59R Elsewhere', code: 'P59RX1', address: 'x', city: 'x', status: 'active' } });
  const seededSupervisor = await prisma.user.findFirstOrThrow({ where: { email: 'supervisor@potatocorner.test' } });
  const otherSupervisor = await prisma.user.upsert({
    where: { email: 'p59r-other-supervisor@potatocorner.test' },
    update: {},
    create: { email: 'p59r-other-supervisor@potatocorner.test', passwordHash: seededSupervisor.passwordHash, role: 'supervisor', firstName: 'Other', lastName: 'Supervisor', employmentType: 'regular', mustChangePassword: false },
  });
  const otherAssigned = await prisma.userBranchAssignment.findFirst({ where: { userId: otherSupervisor.id, branchId: elsewhere.id, removedAt: null } });
  if (!otherAssigned) await prisma.userBranchAssignment.create({ data: { userId: otherSupervisor.id, branchId: elsewhere.id } });

  console.warn(JSON.stringify({ main: mainBranch.id, item: item.id, product: product.id, variant: variant.id, ana: ana.id }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
