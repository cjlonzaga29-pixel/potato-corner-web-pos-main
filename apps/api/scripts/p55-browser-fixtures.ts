// POS-PERF-P55 — local-only fixture for the real-browser verification of
// manual peso discounts. Run after prisma/seed.ts and
// scripts/seed-pos-demo-inventory.ts on a NEW disposable database: clocks the
// seeded staff user in at MAIN01 (the terminal needs an open attendance
// record) and makes sure the demo Water item has plenty of stock. Prints ids
// and names only — never passwords or connection strings.
//
// Cashier switching (P55 release verification): with P55_FIXTURE_PASSWORD
// (12+ chars) and P55_PIN_ANA / P55_PIN_BEN / P55_PIN_CARL set, it also
// creates two PIN staff at MAIN01 (Ana, Ben) for the seeded Branch Account,
// a second branch P55S01 with its own Branch Account and one PIN staff
// (Carl), and an open attendance record for each, so Switch Cashier and
// Start Break / Resume can be driven in a browser.
//
// Usage (from apps/api): ALLOW_DATABASE_SEED=true DATABASE_URL=... DIRECT_URL=... npx tsx --env-file=.env scripts/p55-browser-fixtures.ts
import bcrypt from 'bcrypt';
import { PrismaClient, Prisma } from '@prisma/client';

function assertDisposableLocal(): void {
  if (process.env.ALLOW_DATABASE_SEED !== 'true') throw new Error('Refusing: set ALLOW_DATABASE_SEED=true');
  if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('Refusing: PRODUCTION_DATABASE_URL_DIRECT is set');
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = process.env[name];
    if (!raw) throw new Error(`Refusing: ${name} is not set`);
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1') throw new Error(`Refusing: ${name} is not 127.0.0.1`);
    if (!/^\/p55[bco]_\d+$/.test(url.pathname)) throw new Error(`Refusing: ${name} is not a p55b_/p55c_/p55o_<digits> database`);
  }
}

assertDisposableLocal();
const prisma = new PrismaClient();

async function upsertUser(input: { email: string | null; employeeId: string; role: 'branch' | 'staff' | 'supervisor'; firstName: string; lastName: string; branchId: string }, password: string) {
  const passwordHash = input.email ? await bcrypt.hash(password, 12) : null;
  const user = await prisma.user.upsert({
    where: { employeeId: input.employeeId },
    update: { isActive: true, status: 'active', loginAttempts: 0, lockedUntil: null },
    create: {
      email: input.email,
      passwordHash,
      role: input.role,
      firstName: input.firstName,
      lastName: input.lastName,
      employeeId: input.employeeId,
      employmentType: 'regular',
      mustChangePassword: false,
    },
  });
  const existing = await prisma.userBranchAssignment.findFirst({ where: { userId: user.id, branchId: input.branchId, removedAt: null } });
  if (!existing) await prisma.userBranchAssignment.create({ data: { userId: user.id, branchId: input.branchId } });
  return user;
}

async function ensureClockedIn(employeeId: string, branchId: string): Promise<void> {
  const open = await prisma.attendanceRecord.findFirst({ where: { employeeId, branchId, clockOutServerTime: null, deletedAt: null } });
  if (!open) {
    await prisma.attendanceRecord.create({
      data: { employeeId, branchId, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' },
    });
  }
}

async function cashierSwitchFixtures(main: { id: string }) {
  const password = process.env.P55_FIXTURE_PASSWORD;
  if (!password) return null;
  if (password.length < 12) throw new Error('Refusing: P55_FIXTURE_PASSWORD needs 12+ chars');
  const pinAna = process.env.P55_PIN_ANA;
  const pinBen = process.env.P55_PIN_BEN;
  const pinCarl = process.env.P55_PIN_CARL;
  if (!pinAna || !pinBen || !pinCarl) throw new Error('Refusing: set P55_PIN_ANA / P55_PIN_BEN / P55_PIN_CARL');
  const { staffPinService } = await import('../src/modules/staff-pin/staff-pin.service.js');

  const south = await prisma.branch.upsert({
    where: { code: 'P55S01' },
    update: {},
    create: { name: 'P55 South Branch', code: 'P55S01', address: '1 Test Avenue', city: 'Makati', status: 'active' },
  });
  const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@potatocorner.test' } });
  await upsertUser({ email: 'p55-branch-south@local.test', employeeId: 'P55-BR-S', role: 'branch', firstName: 'South', lastName: 'Terminal', branchId: south.id }, password);
  await upsertUser({ email: 'p55-supervisor-south@local.test', employeeId: 'P55-SUP-S', role: 'supervisor', firstName: 'Sid', lastName: 'Supervisor', branchId: south.id }, password);
  const ana = await upsertUser({ email: null, employeeId: 'P55-ANA', role: 'staff', firstName: 'Ana', lastName: 'Reyes', branchId: main.id }, password);
  const ben = await upsertUser({ email: null, employeeId: 'P55-BEN', role: 'staff', firstName: 'Ben', lastName: 'Cruz', branchId: main.id }, password);
  const carl = await upsertUser({ email: null, employeeId: 'P55-CARL', role: 'staff', firstName: 'Carl', lastName: 'Diaz', branchId: south.id }, password);

  const adminActor = { user_id: admin.id, role: 'super_admin', email: admin.email, iat: 0, exp: 9999999999 } as const;
  for (const [userId, pin] of [[ana.id, pinAna], [ben.id, pinBen], [carl.id, pinCarl]] as const) {
    await staffPinService.setPin(userId, pin, adminActor as never, null);
  }
  await ensureClockedIn(ana.id, main.id);
  await ensureClockedIn(ben.id, main.id);
  await ensureClockedIn(carl.id, south.id);
  return { south: { id: south.id, code: south.code }, staff: { ana: ana.id, ben: ben.id, carl: carl.id } };
}

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
  const switching = await cashierSwitchFixtures(branch);
  console.log(JSON.stringify({ branch: { id: branch.id, code: branch.code }, staff: staff.id, attendance: open ? 'kept' : 'opened', switching }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
