// POS-PERF-P55 — local-only fixture for the real-browser verification of
// manual peso discounts. Run after prisma/seed.ts and
// scripts/seed-pos-demo-inventory.ts on a NEW disposable database: clocks the
// seeded staff user in at MAIN01 (the terminal needs an open attendance
// record) and makes sure the demo Water item has plenty of stock. Prints ids
// and names only — never passwords or connection strings.
//
// Usage (from apps/api): ALLOW_DATABASE_SEED=true DATABASE_URL=... DIRECT_URL=... npx tsx scripts/p55-browser-fixtures.ts
import { PrismaClient, Prisma } from '@prisma/client';

function assertDisposableLocal(): void {
  if (process.env.ALLOW_DATABASE_SEED !== 'true') throw new Error('Refusing: set ALLOW_DATABASE_SEED=true');
  if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('Refusing: PRODUCTION_DATABASE_URL_DIRECT is set');
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = process.env[name];
    if (!raw) throw new Error(`Refusing: ${name} is not set`);
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1') throw new Error(`Refusing: ${name} is not 127.0.0.1`);
    if (!/^\/p55b_\d+$/.test(url.pathname)) throw new Error(`Refusing: ${name} is not a p55b_<digits> database`);
  }
}

assertDisposableLocal();
const prisma = new PrismaClient();

async function main() {
  const branch = await prisma.branch.findUniqueOrThrow({ where: { code: 'MAIN01' } });
  const staff = await prisma.user.findFirstOrThrow({ where: { email: 'staff@potatocorner.test' } });
  const open = await prisma.attendanceRecord.findFirst({ where: { employeeId: staff.id, branchId: branch.id, clockOutServerTime: null, deletedAt: null } });
  if (!open) {
    await prisma.attendanceRecord.create({
      data: { employeeId: staff.id, branchId: branch.id, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' },
    });
  }
  const water = await prisma.inventoryItem.findFirstOrThrow({ where: { sku: 'DEMO-WATER' } });
  await prisma.inventoryStock.updateMany({ where: { branchId: branch.id, inventoryItemId: water.id }, data: { quantityOnHand: new Prisma.Decimal(100000) } });
  console.log(JSON.stringify({ branch: { id: branch.id, code: branch.code }, staff: staff.id, attendance: open ? 'kept' : 'opened' }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
