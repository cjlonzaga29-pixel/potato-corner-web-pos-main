// POS-PERF-P58R — local-only fixture for the real-browser and service-worker
// verification of custom types with branch copies, manual discounts and offline
// sales. Run after prisma/seed.ts on a NEW disposable database. MAIN01 and P58RS1
// are the seeded supervisor's branches; P58RX1 is not assigned to them. Prints ids only.
//
// Usage (from apps/api): ALLOW_DATABASE_SEED=true P58R_PIN_ANA=... P58R_PIN_BEN=... npx tsx --env-file=<env> scripts/p58r-browser-fixtures.ts
import { PrismaClient, Prisma } from '@prisma/client';

function assertDisposableLocal(): void {
  if (process.env.ALLOW_DATABASE_SEED !== 'true') throw new Error('Refusing: set ALLOW_DATABASE_SEED=true');
  if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('Refusing: PRODUCTION_DATABASE_URL_DIRECT is set');
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = process.env[name];
    if (!raw) throw new Error(`Refusing: ${name} is not set`);
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1') throw new Error(`Refusing: ${name} is not 127.0.0.1`);
    if (url.pathname !== '/p58r_browser') throw new Error(`Refusing: ${name} is not the p58r_browser database`);
  }
}

assertDisposableLocal();
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const mainBranch = await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN01' } });
  const south = await prisma.branch.create({ data: { name: 'P58R South', code: 'P58RS1', address: 'x', city: 'x', status: 'active' } });
  const other = await prisma.branch.create({ data: { name: 'P58R Elsewhere', code: 'P58RX1', address: 'x', city: 'x', status: 'active' } });
  const supervisor = await prisma.user.findFirstOrThrow({ where: { email: 'supervisor@potatocorner.test' } });
  const otherSupervisor = await prisma.user.create({
    data: { email: 'p58r-other@potatocorner.test', passwordHash: 'unused', role: 'supervisor', firstName: 'P58R', lastName: 'Other', employmentType: 'regular', mustChangePassword: false },
  });
  const assign = async (userId: string, branchId: string) => {
    const assigned = await prisma.userBranchAssignment.findFirst({ where: { userId, branchId, removedAt: null } });
    if (!assigned) await prisma.userBranchAssignment.create({ data: { userId, branchId } });
  };
  for (const branchId of [mainBranch.id, south.id]) await assign(supervisor.id, branchId);
  for (const branchId of [mainBranch.id, other.id]) await assign(otherSupervisor.id, branchId);

  const unit = await prisma.unitOfMeasure.upsert({ where: { code: 'g' }, update: {}, create: { code: 'g', name: 'Gram', dimension: 'WEIGHT', isBaseUnit: true } });
  const item = await prisma.inventoryItem.create({ data: { name: 'P58R Plenty', baseUnitId: unit.id, trackInventory: true } });
  for (const branchId of [mainBranch.id, south.id, other.id]) {
    await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: item.id, quantityOnHand: new Prisma.Decimal(100000), quantityReserved: new Prisma.Decimal(0) } });
  }

  const makeType = async (name: string, branchIds: string[], isActive = true) => {
    const normalizedName = name.toLowerCase();
    const row = await prisma.productType.create({ data: { name, normalizedName, isActive, createdById: otherSupervisor.id } });
    await prisma.productTypeBranch.createMany({ data: branchIds.map((branchId) => ({ productTypeId: row.id, branchId, normalizedName, isActive })) });
    return row.id;
  };
  const marketing = await makeType('P58R Marketing', [mainBranch.id]);
  const southOnly = await makeType('P58R South Only', [south.id]);
  const hidden = await makeType('P58R Hidden Elsewhere', [other.id]);
  const cross = await makeType('P58R Cross', [mainBranch.id, other.id]);
  const retired = await makeType('P58R Retired', [mainBranch.id, other.id], false);

  const makeProduct = async (name: string, classification: 'regular' | 'promotional', productTypeId: string | null, branchIds: string[]) => {
    const product = await prisma.product.create({ data: { name, category: 'P58R', status: 'active', classification, productTypeId, everPublished: true } });
    const variant = await prisma.productVariant.create({ data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: new Prisma.Decimal(100), isActive: true, lifecycleStatus: 'ACTIVE' } });
    await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: item.id, quantityRequired: new Prisma.Decimal(1) } });
    await prisma.branchProductAvailability.createMany({ data: branchIds.map((branchId) => ({ branchId, productId: product.id, isAvailable: true })) });
    return product.id;
  };
  const typed = await makeProduct('P58R Marketing Fries', 'regular', marketing, [mainBranch.id]);
  const control = await makeProduct('P58R Control Fries', 'regular', null, [mainBranch.id]);
  const promo = await makeProduct('P58R Promo Fries', 'promotional', null, [mainBranch.id]);
  const crossSource = await makeProduct('P58R Cross Fries', 'regular', cross, [mainBranch.id, other.id]);
  const retiredSource = await makeProduct('P58R Retired Fries', 'regular', retired, [mainBranch.id, other.id]);

  const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@potatocorner.test' } });
  const { staffPinService } = await import('../src/modules/staff-pin/staff-pin.service.js');
  const cashiers: Record<string, string> = {};
  for (const [first, last, pin] of [['Ana', 'Reyes', process.env.P58R_PIN_ANA], ['Ben', 'Cruz', process.env.P58R_PIN_BEN]] as const) {
    if (!pin) continue;
    const user = await prisma.user.create({ data: { role: 'staff', firstName: first, lastName: last, employeeId: `P58R-${first}`, employmentType: 'regular', mustChangePassword: false } });
    cashiers[first] = user.id;
    await assign(user.id, mainBranch.id);
    await staffPinService.setPin(user.id, pin, { user_id: admin.id, role: 'super_admin', email: admin.email, iat: 0, exp: 9999999999 } as never, null);
    await prisma.attendanceRecord.create({ data: { employeeId: user.id, branchId: mainBranch.id, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });
  }

  console.log(JSON.stringify({ main: mainBranch.id, south: south.id, other: other.id, supervisor: supervisor.id, otherSupervisor: otherSupervisor.id, item: item.id, marketing, southOnly, hidden, cross, retired, typed, control, promo, crossSource, retiredSource, cashiers }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
