// POS-PERF-P62 — local-only dataset for repeatable performance measurements and
// browser verification. Run after prisma/seed.ts on a NEW disposable database:
// eight branches over 90 days, one busy branch (default 20,000 sales), the seeded
// supervisor over three of them, two cashiers with PINs clocked in at MAIN01, and an
// open shift. Row counts are deterministic; nothing here is real data. Prints ids only.
//
// Usage (from apps/api): ALLOW_DATABASE_SEED=true P62_PIN_ANA=... P62_PIN_BEN=... npx tsx scripts/p62-perf-fixtures.ts
import { PrismaClient, Prisma } from '@prisma/client';

const BUSY_SALES = Number(process.env.P62_BUSY_SALES || 20000);
const OTHER_SALES = Number(process.env.P62_OTHER_SALES || 5000);
const DAYS = 90;

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
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const pins = { ana: process.env.P62_PIN_ANA, ben: process.env.P62_PIN_BEN };
  if (!pins.ana || !pins.ben) throw new Error('Refusing: set P62_PIN_ANA and P62_PIN_BEN');
  const main = await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN01' } });
  const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@potatocorner.test' } });
  const supervisor = await prisma.user.findFirstOrThrow({ where: { email: 'supervisor@potatocorner.test' } });

  const branchIds: string[] = [main.id];
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
    if (!(await prisma.userBranchAssignment.findFirst({ where: { userId: row.id, branchId: main.id, removedAt: null } }))) {
      await prisma.userBranchAssignment.create({ data: { userId: row.id, branchId: main.id } });
    }
    await staffPinService.setPin(row.id, pin, { user_id: admin.id, role: 'super_admin', email: admin.email, iat: 0, exp: 9999999999 } as never, null);
    if (!(await prisma.attendanceRecord.findFirst({ where: { employeeId: row.id, branchId: main.id, clockOutServerTime: null, deletedAt: null } }))) {
      await prisma.attendanceRecord.create({ data: { employeeId: row.id, branchId: main.id, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsLat: 14.6, clockInGpsLng: 121, clockInGpsStatus: 'within_radius' } });
    }
    return row;
  };
  const ana = await cashier('P62-Ana', 'Ana', 'Reyes', pins.ana);
  const ben = await cashier('P62-Ben', 'Ben', 'Cruz', pins.ben);

  const pc = await prisma.unitOfMeasure.upsert({ where: { code: 'pc' }, update: {}, create: { code: 'pc', name: 'Piece', dimension: 'COUNT', isBaseUnit: true } });
  const g = await prisma.unitOfMeasure.upsert({ where: { code: 'g' }, update: {}, create: { code: 'g', name: 'Gram', dimension: 'WEIGHT', isBaseUnit: true } });

  await prisma.$executeRawUnsafe(
    `INSERT INTO inventory_items (id, name, base_unit_id, unit_cost, updated_at)
     SELECT gen_random_uuid()::text, 'P62 Item ' || n, CASE WHEN n % 3 = 0 THEN $1 ELSE $2 END, 1 + n % 7, now() FROM generate_series(1, 60) AS n`,
    g.id, pc.id,
  );
  const items = await prisma.inventoryItem.findMany({ where: { name: { startsWith: 'P62 Item' } }, select: { id: true, baseUnitId: true } });
  await prisma.$executeRawUnsafe(
    `INSERT INTO inventory_stocks (id, branch_id, inventory_item_id, quantity_on_hand, quantity_reserved, unit_cost, updated_at)
     SELECT gen_random_uuid()::text, b, i.id, 100000, 0, 2, now() FROM unnest($1::text[]) AS b CROSS JOIN inventory_items i WHERE i.name LIKE 'P62 Item%'`,
    branchIds,
  );

  const firstVariant = { id: '', productId: '', price: 100, name: 'Regular', productName: '' };
  for (let n = 1; n <= 30; n += 1) {
    const product = await prisma.product.create({ data: { name: `P62 Fries ${n}`, category: 'P62', status: 'active', classification: 'regular', everPublished: true } });
    for (const [size, price] of [['Regular', 100 + n], ['Large', 150 + n]] as const) {
      const variant = await prisma.productVariant.create({ data: { productId: product.id, name: size, sizeLabel: size, basePrice: new Prisma.Decimal(price), isActive: true, lifecycleStatus: 'ACTIVE' } });
      await prisma.productComponent.createMany({
        data: [0, 1, 2].map((offset) => ({ productVariantId: variant.id, inventoryItemId: items[(n + offset) % items.length]?.id ?? '', quantityRequired: new Prisma.Decimal(1 + offset) })),
      });
      if (!firstVariant.id) Object.assign(firstVariant, { id: variant.id, productId: product.id, price, productName: product.name });
    }
    await prisma.branchProductAvailability.createMany({ data: branchIds.map((branchId) => ({ branchId, productId: product.id, isAvailable: true })) });
  }

  // Sales, items, shifts, attendance and movements for every branch; the first is the busy one.
  for (const [index, branchId] of branchIds.entries()) {
    const sales = index === 0 ? BUSY_SALES : OTHER_SALES;
    const code = `P62${index}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO shifts (id, branch_id, cashier_id, opened_by, status, opening_cash_amount, started_at, closed_at)
       SELECT gen_random_uuid()::text, $1, $2, $2, 'closed', 500, now() - (d || ' days')::interval, now() - (d || ' days')::interval + interval '8 hours' FROM generate_series(1, ${DAYS}) AS d`,
      branchId, ana.id,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO transactions (id, transaction_number, branch_id, cashier_id, status, payment_method, subtotal, discount_amount, vat_amount, vat_exempt_amount, total_amount, created_at, updated_at)
       SELECT gen_random_uuid()::text, 'PC-${code}-' || lpad(n::text, 7, '0'), $1, $2,
              (CASE WHEN n % 97 = 0 THEN 'voided' WHEN n % 89 = 0 THEN 'refunded' ELSE 'completed' END)::"TransactionStatus",
              (ARRAY['cash','cash','gcash','maya'])[n % 4 + 1]::"PaymentMethod", 100 + n % 50, 0, 0, 0, 100 + n % 50,
              now() - ((n::float / ${sales}) * ${DAYS}) * interval '1 day', now() FROM generate_series(1, ${sales}) AS n`,
      branchId, n2(index) ? ana.id : ben.id,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO transaction_items (id, transaction_id, product_id, product_variant_id, product_name_snapshot, variant_name_snapshot, unit_price_snapshot, quantity, line_total)
       SELECT gen_random_uuid()::text, t.id, $2, $3, $4, 'Regular', t.total_amount, 1, t.total_amount FROM transactions t WHERE t.branch_id = $1`,
      branchId, firstVariant.productId, firstVariant.id, firstVariant.productName,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO attendance_records (id, employee_id, branch_id, clock_in_server_time, clock_out_server_time, clock_in_gps_status, updated_at)
       SELECT gen_random_uuid()::text, $2, $1, now() - (d || ' days')::interval, now() - (d || ' days')::interval + interval '8 hours', 'within_radius', now() FROM generate_series(1, ${DAYS}) AS d`,
      branchId, index % 2 === 0 ? ana.id : ben.id,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO inventory_stock_movements (id, branch_id, inventory_item_id, movement_type, quantity_change, quantity_before, quantity_after, unit_id, notes, created_at)
       SELECT gen_random_uuid()::text, $1, i.id, (ARRAY['RECEIVING','ADJUSTMENT_OUT','WASTE','SALE'])[n % 4 + 1]::"InventoryStockMovementType", 1, n, n + 1, i.base_unit_id, 'p62 ' || n, now() - ((n::float / ${sales}) * ${DAYS}) * interval '1 day'
       FROM generate_series(1, ${sales}) AS n JOIN LATERAL (SELECT id, base_unit_id FROM inventory_items WHERE name = 'P62 Item ' || (n % 60 + 1)) i ON true`,
      branchId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO expenses (id, branch_id, category, amount, incurred_at, created_by, updated_at)
       SELECT gen_random_uuid()::text, $1, (ARRAY['utilities','supplies','staff_meals','miscellaneous'])[n % 4 + 1]::"ExpenseCategory", n % 977 + 0.25, now() - (n % ${DAYS} || ' days')::interval, $2, now() FROM generate_series(1, ${index === 0 ? 2000 : 300}) AS n`,
      branchId, supervisor.id,
    );
  }

  await prisma.shift.create({ data: { branchId: main.id, cashierId: ana.id, openedBy: ana.id, status: 'active', openingCashAmount: new Prisma.Decimal(1000), startedAt: new Date() } });
  await prisma.$executeRawUnsafe('ANALYZE');

  console.warn(JSON.stringify({ branches: branchIds, ana: ana.id, ben: ben.id, variant: firstVariant.id, product: firstVariant.productId, price: firstVariant.price }));
}

function n2(index: number): boolean {
  return index % 2 === 0;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
