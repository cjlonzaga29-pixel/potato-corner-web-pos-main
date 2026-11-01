// POS-PERF-P56 — local-only fixture for the real-browser verification of stock
// consistency, payroll setup and the flat PIN screen. Run after prisma/seed.ts
// and scripts/seed-pos-demo-inventory.ts on a NEW disposable database. Each
// shortage case gets its own item and product at MAIN01; P56S01 stocks the same
// items differently (branch switching); P56X01 is not assigned to the seeded
// supervisor (authorization). Prints ids and names only.
//
// Usage (from apps/api): ALLOW_DATABASE_SEED=true P56_PIN_ANA=... npx tsx --env-file=.env scripts/p56-browser-fixtures.ts
import { PrismaClient, Prisma } from '@prisma/client';

function assertDisposableLocal(): void {
  if (process.env.ALLOW_DATABASE_SEED !== 'true') throw new Error('Refusing: set ALLOW_DATABASE_SEED=true');
  if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('Refusing: PRODUCTION_DATABASE_URL_DIRECT is set');
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = process.env[name];
    if (!raw) throw new Error(`Refusing: ${name} is not set`);
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1') throw new Error(`Refusing: ${name} is not 127.0.0.1`);
    if (url.pathname !== '/p56_browser') throw new Error(`Refusing: ${name} is not the p56_browser database`);
  }
}

assertDisposableLocal();
const prisma = new PrismaClient();

interface StockLevel {
  onHand: number;
  reserved?: number;
  low?: number;
  critical?: number;
}

interface StockCase {
  key: string;
  itemName: string;
  productName: string;
  recipeQuantity: number;
  track: boolean;
  main: StockLevel | null;
  south: StockLevel | null;
  /** A supervisor turned this product off at MAIN01. */
  disabledAtMain?: boolean;
}

const CASES: StockCase[] = [
  { key: 'ZERO', itemName: 'P56 Zero Cheese', productName: 'P56 Zero Fries', recipeQuantity: 1, track: true, main: { onHand: 0 }, south: { onHand: 40 } },
  { key: 'POSITIVE', itemName: 'P56 Positive Salt', productName: 'P56 Positive Fries', recipeQuantity: 1, track: true, main: { onHand: 50 }, south: { onHand: 50 } },
  { key: 'RESERVED', itemName: 'P56 Reserved Oil', productName: 'P56 Reserved Fries', recipeQuantity: 1, track: true, main: { onHand: 5, reserved: 5 }, south: { onHand: 5 } },
  { key: 'SHORT', itemName: 'P56 Short Spice', productName: 'P56 Short Fries', recipeQuantity: 10, track: true, main: { onHand: 3 }, south: { onHand: 30 } },
  { key: 'LOW', itemName: 'P56 Low Paper', productName: 'P56 Low Fries', recipeQuantity: 1, track: true, main: { onHand: 8, low: 10, critical: 2 }, south: { onHand: 80 } },
  { key: 'UNTRACKED', itemName: 'P56 Untracked Napkin', productName: 'P56 Untracked Fries', recipeQuantity: 1, track: false, main: { onHand: 0 }, south: { onHand: 0 } },
  { key: 'DISABLED', itemName: 'P56 Disabled Sauce', productName: 'P56 Disabled Fries', recipeQuantity: 1, track: true, main: { onHand: 20 }, south: { onHand: 20 }, disabledAtMain: true },
  { key: 'UNASSIGNED', itemName: 'P56 Unassigned Cup', productName: 'P56 Unassigned Fries', recipeQuantity: 1, track: true, main: null, south: { onHand: 9 } },
];

async function main() {
  const mainBranch = await prisma.branch.findUniqueOrThrow({ where: { code: 'MAIN01' } });
  const south = await prisma.branch.upsert({ where: { code: 'P56S01' }, update: {}, create: { name: 'P56 South Branch', code: 'P56S01', address: '1 Test Avenue', city: 'Makati', status: 'active' } });
  const other = await prisma.branch.upsert({ where: { code: 'P56X01' }, update: {}, create: { name: 'P56 Other Branch', code: 'P56X01', address: '2 Test Avenue', city: 'Makati', status: 'active' } });

  const supervisor = await prisma.user.findFirstOrThrow({ where: { email: 'supervisor@potatocorner.test' } });
  const assigned = await prisma.userBranchAssignment.findFirst({ where: { userId: supervisor.id, branchId: south.id, removedAt: null } });
  if (!assigned) await prisma.userBranchAssignment.create({ data: { userId: supervisor.id, branchId: south.id } });

  const unit = await prisma.unitOfMeasure.upsert({ where: { code: 'pc-demo' }, update: {}, create: { code: 'pc-demo', name: 'Piece (demo)', dimension: 'COUNT', isBaseUnit: true } });

  for (const stockCase of CASES) {
    const sku = `P56-${stockCase.key}`;
    const item =
      (await prisma.inventoryItem.findFirst({ where: { sku } })) ??
      (await prisma.inventoryItem.create({ data: { name: stockCase.itemName, sku, baseUnitId: unit.id, trackInventory: stockCase.track } }));
    for (const [branchId, stock] of [[mainBranch.id, stockCase.main], [south.id, stockCase.south]] as const) {
      if (!stock) continue;
      const data = {
        quantityOnHand: new Prisma.Decimal(stock.onHand),
        quantityReserved: new Prisma.Decimal(stock.reserved ?? 0),
        lowStockThreshold: stock.low === undefined ? null : new Prisma.Decimal(stock.low),
        criticalThreshold: stock.critical === undefined ? null : new Prisma.Decimal(stock.critical),
      };
      await prisma.inventoryStock.upsert({
        where: { branchId_inventoryItemId: { branchId, inventoryItemId: item.id } },
        update: data,
        create: { branchId, inventoryItemId: item.id, ...data },
      });
    }

    const product =
      (await prisma.product.findFirst({ where: { name: stockCase.productName } })) ??
      (await prisma.product.create({ data: { name: stockCase.productName, category: 'P56', status: 'active' } }));
    const variant =
      (await prisma.productVariant.findFirst({ where: { productId: product.id, sizeLabel: 'Regular' } })) ??
      (await prisma.productVariant.create({ data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: new Prisma.Decimal(50), isActive: true, lifecycleStatus: 'ACTIVE' } }));
    const component = await prisma.productComponent.findFirst({ where: { productVariantId: variant.id, inventoryItemId: item.id } });
    if (!component) {
      await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: item.id, quantityRequired: new Prisma.Decimal(stockCase.recipeQuantity), recipeUnitId: null } });
    }
    for (const [branchId, isAvailable] of [[mainBranch.id, !stockCase.disabledAtMain], [south.id, true]] as const) {
      await prisma.branchProductAvailability.upsert({
        where: { branchId_productId: { branchId, productId: product.id } },
        update: { isAvailable },
        create: { branchId, productId: product.id, isAvailable },
      });
    }
  }

  // Water sells at MAIN01 for the checkout regression.
  const water = await prisma.inventoryItem.findFirstOrThrow({ where: { sku: 'DEMO-WATER' } });
  await prisma.inventoryStock.updateMany({ where: { branchId: mainBranch.id, inventoryItemId: water.id }, data: { quantityOnHand: new Prisma.Decimal(1000), lowStockThreshold: null, criticalThreshold: null } });

  let ana: string | null = null;
  const pinAna = process.env.P56_PIN_ANA;
  if (pinAna) {
    const { staffPinService } = await import('../src/modules/staff-pin/staff-pin.service.js');
    const user = await prisma.user.upsert({
      where: { employeeId: 'P56-ANA' },
      update: { isActive: true, status: 'active' },
      create: { role: 'staff', firstName: 'Ana', lastName: 'Reyes', employeeId: 'P56-ANA', employmentType: 'regular', mustChangePassword: false },
    });
    const existing = await prisma.userBranchAssignment.findFirst({ where: { userId: user.id, branchId: mainBranch.id, removedAt: null } });
    if (!existing) await prisma.userBranchAssignment.create({ data: { userId: user.id, branchId: mainBranch.id } });
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@potatocorner.test' } });
    await staffPinService.setPin(user.id, pinAna, { user_id: admin.id, role: 'super_admin', email: admin.email, iat: 0, exp: 9999999999 } as never, null);
    const open = await prisma.attendanceRecord.findFirst({ where: { employeeId: user.id, branchId: mainBranch.id, clockOutServerTime: null, deletedAt: null } });
    if (!open) await prisma.attendanceRecord.create({ data: { employeeId: user.id, branchId: mainBranch.id, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });
    ana = user.id;
  }

  console.log(JSON.stringify({ main: mainBranch.id, south: south.id, other: other.id, ana }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
