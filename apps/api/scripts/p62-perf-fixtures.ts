// POS-PERF-P62 — local-only dataset for repeatable performance measurements and
// browser verification. Run after prisma/seed.ts on a NEW disposable database:
// eight branches over 90 days, one busy branch (default 20,000 sales), the seeded
// supervisor over three of them, two cashiers with PINs clocked in at MAIN01, and an
// open shift. Row counts and values are deterministic; nothing here is real data.
// Prisma only (no raw SQL, per .claude/CLAUDE.md), inserted in createMany batches.
// Historical sales are already deducted (`completed`) and carry no deduction job, so
// no background worker acts on them. Prints ids and counts only.
//
// Usage (from apps/api): ALLOW_DATABASE_SEED=true P62_PIN_ANA=... P62_PIN_BEN=... npx tsx scripts/p62-perf-fixtures.ts
import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma, type PaymentMethod, type TransactionStatus, type ExpenseCategory, type InventoryStockMovementType } from '@prisma/client';

const BUSY_SALES = Number(process.env.P62_BUSY_SALES || 20000);
const OTHER_SALES = Number(process.env.P62_OTHER_SALES || 5000);
const DAYS = 90;
const BATCH = 2000;
const DAY_MS = 86_400_000;

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

/** Cyclic pick; the arrays are non-empty constants, so the index always exists. */
function pick<T>(list: readonly T[], n: number): T {
  return list[n % list.length] as T;
}

async function inBatches<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) await insert(rows.slice(i, i + BATCH));
}

const PAYMENTS: PaymentMethod[] = ['cash', 'cash', 'gcash', 'maya'];
const MOVES: InventoryStockMovementType[] = ['RECEIVING', 'ADJUSTMENT_OUT', 'WASTE', 'SALE'];
const CATEGORIES: ExpenseCategory[] = ['utilities', 'supplies', 'staff_meals', 'miscellaneous'];

async function main(): Promise<void> {
  const pins = { ana: process.env.P62_PIN_ANA, ben: process.env.P62_PIN_BEN };
  if (!pins.ana || !pins.ben) throw new Error('Refusing: set P62_PIN_ANA and P62_PIN_BEN');
  if (await prisma.inventoryItem.count({ where: { name: { startsWith: 'P62 Item' } } })) {
    throw new Error('Refusing: P62 fixtures already exist; use a new disposable database');
  }
  const now = Date.now();
  const mainBranch = await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN01' } });
  const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@potatocorner.test' } });
  const supervisor = await prisma.user.findFirstOrThrow({ where: { email: 'supervisor@potatocorner.test' } });

  const branchIds: string[] = [mainBranch.id];
  for (let n = 1; n <= 7; n += 1) {
    const branch = await prisma.branch.upsert({ where: { code: `P62B${n}` }, update: {}, create: { name: `P62 Branch ${n}`, code: `P62B${n}`, address: 'x', city: 'x', status: 'active' } });
    branchIds.push(branch.id);
    if (n <= 2 && !(await prisma.userBranchAssignment.findFirst({ where: { userId: supervisor.id, branchId: branch.id, removedAt: null } }))) {
      await prisma.userBranchAssignment.create({ data: { userId: supervisor.id, branchId: branch.id } });
    }
  }

  const { staffPinService } = await import('../src/modules/staff-pin/staff-pin.service.js');
  const cashier = async (employeeId: string, firstName: string, lastName: string, pin: string) => {
    const row = await prisma.user.upsert({ where: { employeeId }, update: { isActive: true, status: 'active' }, create: { role: 'staff', firstName, lastName, employeeId, employmentType: 'regular', mustChangePassword: false } });
    if (!(await prisma.userBranchAssignment.findFirst({ where: { userId: row.id, branchId: mainBranch.id, removedAt: null } }))) {
      await prisma.userBranchAssignment.create({ data: { userId: row.id, branchId: mainBranch.id } });
    }
    await staffPinService.setPin(row.id, pin, { user_id: admin.id, role: 'super_admin', email: admin.email, iat: 0, exp: 9999999999 } as never, null);
    if (!(await prisma.attendanceRecord.findFirst({ where: { employeeId: row.id, branchId: mainBranch.id, clockOutServerTime: null, deletedAt: null } }))) {
      await prisma.attendanceRecord.create({ data: { employeeId: row.id, branchId: mainBranch.id, clockInServerTime: new Date(now - 3600_000), clockInGpsLat: 14.6, clockInGpsLng: 121, clockInGpsStatus: 'within_radius' } });
    }
    return row;
  };
  const ana = await cashier('P62-Ana', 'Ana', 'Reyes', pins.ana);
  const ben = await cashier('P62-Ben', 'Ben', 'Cruz', pins.ben);

  const pc = await prisma.unitOfMeasure.upsert({ where: { code: 'pc' }, update: {}, create: { code: 'pc', name: 'Piece', dimension: 'COUNT', isBaseUnit: true } });
  const g = await prisma.unitOfMeasure.upsert({ where: { code: 'g' }, update: {}, create: { code: 'g', name: 'Gram', dimension: 'WEIGHT', isBaseUnit: true } });

  const items = Array.from({ length: 60 }, (_, i) => ({ id: randomUUID(), name: `P62 Item ${i + 1}`, baseUnitId: (i + 1) % 3 === 0 ? g.id : pc.id, unitCost: new Prisma.Decimal(1 + ((i + 1) % 7)) }));
  await prisma.inventoryItem.createMany({ data: items });
  await inBatches(branchIds.flatMap((branchId) => items.map((item) => ({ branchId, inventoryItemId: item.id, quantityOnHand: new Prisma.Decimal(100000), quantityReserved: new Prisma.Decimal(0), unitCost: new Prisma.Decimal(2) }))), (data) => prisma.inventoryStock.createMany({ data }));

  const firstVariant = { id: '', productId: '', price: 100, productName: '' };
  for (let n = 1; n <= 30; n += 1) {
    const product = await prisma.product.create({ data: { name: `P62 Fries ${n}`, category: 'P62', status: 'active', classification: 'regular', everPublished: true } });
    for (const [size, price] of [['Regular', 100 + n], ['Large', 150 + n]] as const) {
      const variant = await prisma.productVariant.create({ data: { productId: product.id, name: size, sizeLabel: size, basePrice: new Prisma.Decimal(price), isActive: true, lifecycleStatus: 'ACTIVE' } });
      await prisma.productComponent.createMany({
        data: [0, 1, 2].map((offset) => ({ productVariantId: variant.id, inventoryItemId: pick(items, n + offset).id, quantityRequired: new Prisma.Decimal(1 + offset) })),
      });
      if (!firstVariant.id) Object.assign(firstVariant, { id: variant.id, productId: product.id, price, productName: product.name });
    }
    await prisma.branchProductAvailability.createMany({ data: branchIds.map((branchId) => ({ branchId, productId: product.id, isAvailable: true })) });
  }

  // Sales, items, shifts, attendance, movements and expenses per branch; the first is the busy one.
  const counts = { transactions: 0, movements: 0, expenses: 0 };
  for (const [index, branchId] of branchIds.entries()) {
    const sales = index === 0 ? BUSY_SALES : OTHER_SALES;
    const code = `P62${index}`;
    const cashierId = index % 2 === 0 ? ana.id : ben.id;
    const days = Array.from({ length: DAYS }, (_, d) => d + 1);
    await prisma.shift.createMany({ data: days.map((d) => ({ branchId, cashierId: ana.id, openedBy: ana.id, status: 'closed' as const, openingCashAmount: new Prisma.Decimal(500), startedAt: new Date(now - d * DAY_MS), closedAt: new Date(now - d * DAY_MS + 8 * 3600_000) })) });
    await prisma.attendanceRecord.createMany({ data: days.map((d) => ({ employeeId: cashierId, branchId, clockInServerTime: new Date(now - d * DAY_MS), clockOutServerTime: new Date(now - d * DAY_MS + 8 * 3600_000), clockInGpsStatus: 'within_radius' as const })) });

    const txs = Array.from({ length: sales }, (_, i) => {
      const n = i + 1;
      const status: TransactionStatus = n % 97 === 0 ? 'voided' : n % 89 === 0 ? 'refunded' : 'completed';
      const amount = new Prisma.Decimal(100 + (n % 50));
      return {
        id: randomUUID(), transactionNumber: `PC-${code}-${String(n).padStart(7, '0')}`, branchId, cashierId, status,
        paymentMethod: pick(PAYMENTS, n), subtotal: amount, discountAmount: new Prisma.Decimal(0), vatAmount: new Prisma.Decimal(0), vatExemptAmount: new Prisma.Decimal(0), totalAmount: amount,
        inventoryDeductionStatus: 'completed' as const, createdAt: new Date(now - (n / sales) * DAYS * DAY_MS),
      };
    });
    await inBatches(txs, (data) => prisma.transaction.createMany({ data }));
    await inBatches(txs.map((t) => ({ transactionId: t.id, productId: firstVariant.productId, productVariantId: firstVariant.id, productNameSnapshot: firstVariant.productName, variantNameSnapshot: 'Regular', unitPriceSnapshot: t.totalAmount, quantity: 1, lineTotal: t.totalAmount })), (data) => prisma.transactionItem.createMany({ data }));

    const moves = Array.from({ length: sales }, (_, i) => {
      const n = i + 1;
      const item = pick(items, n);
      return { branchId, inventoryItemId: item.id, movementType: pick(MOVES, n), quantityChange: new Prisma.Decimal(1), quantityBefore: new Prisma.Decimal(n), quantityAfter: new Prisma.Decimal(n + 1), unitId: item.baseUnitId, notes: `p62 ${n}`, createdAt: new Date(now - (n / sales) * DAYS * DAY_MS) };
    });
    await inBatches(moves, (data) => prisma.inventoryStockMovement.createMany({ data }));

    const expenseCount = index === 0 ? 2000 : 300;
    await inBatches(Array.from({ length: expenseCount }, (_, i) => {
      const n = i + 1;
      return { branchId, category: pick(CATEGORIES, n), amount: new Prisma.Decimal((n % 977) + 0.25), incurredAt: new Date(now - (n % DAYS) * DAY_MS), createdBy: supervisor.id };
    }), (data) => prisma.expense.createMany({ data }));
    counts.transactions += sales;
    counts.movements += sales;
    counts.expenses += expenseCount;
  }

  await prisma.shift.create({ data: { branchId: mainBranch.id, cashierId: ana.id, openedBy: ana.id, status: 'active', openingCashAmount: new Prisma.Decimal(1000), startedAt: new Date(now) } });

  // A custom peso discount with no proof step, for the custom-discount checkout.
  const discount = await prisma.manualDiscountType.create({
    data: { id: randomUUID(), branchId: mainBranch.id, name: 'P62 Staff Treat', applyToPos: true, requireProof: false, amountMode: 'manual', productScope: 'all', createdById: supervisor.id },
  });
  // An Extra Supplies card on a stocked piece item, through its real service.
  const { extraSuppliesService } = await import('../src/modules/extra-supplies/extra-supplies.service.js');
  const supplyItem = items.find((item) => item.baseUnitId === pc.id) ?? pick(items, 0);
  const supply = await extraSuppliesService.create(
    { name: 'P62 Extra Cup', inventory_item_id: supplyItem.id, issue_unit_name: 'cup', entered_quantity: 1, entered_unit_id: pc.id, selling_price: 5, apply_to_pos: true, branch_ids: [mainBranch.id] },
    { id: supervisor.id, role: 'supervisor' },
    null,
  );

  console.warn(JSON.stringify({ branches: branchIds, ana: ana.id, ben: ben.id, variant: firstVariant.id, product: firstVariant.productId, price: firstVariant.price, discount: discount.id, supply: supply.id, supplyItem: supplyItem.id, counts }));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
