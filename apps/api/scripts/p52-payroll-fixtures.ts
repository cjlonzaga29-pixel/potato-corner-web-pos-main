// POS-PERF-P52 — disposable LOCAL fixtures for payroll verification.
//
// Usage (from apps/api, against a disposable local database only, after the
// repo seed):
//   ALLOW_DATABASE_SEED=true P52_FIXTURE_PASSWORD=... P52_PIN_ANA=... P52_PIN_BEN=... \
//     npx tsx scripts/p52-payroll-fixtures.ts
//
// Refuses unless DATABASE_URL and DIRECT_URL both point at 127.0.0.1/localhost
// AND the database name is `p52_<digits>`. Creates (idempotently) only
// PRE-P52 data — branches, accounts, staff, assignments (including one
// transfer), PINs and attendance history in October 2026 — so the same
// script populates a database before the P52 migration for the rehearsal.
// It never creates rates, payroll policies or payroll runs: those are set up
// through the API/UI during verification. Prints ids and names only — never
// passwords, PINs or connection strings.
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

function assertDisposableLocal(): void {
  if (process.env.ALLOW_DATABASE_SEED !== 'true') throw new Error('Refusing: set ALLOW_DATABASE_SEED=true');
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = process.env[name];
    if (!raw) throw new Error(`Refusing: ${name} is not set`);
    const url = new URL(raw);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error(`Refusing: ${name} is not local`);
    if (!/^\/p52_\d+$/.test(url.pathname)) throw new Error(`Refusing: ${name} is not a p52_<digits> database`);
  }
}

assertDisposableLocal();
const password = process.env.P52_FIXTURE_PASSWORD;
if (!password || password.length < 12) throw new Error('Refusing: set P52_FIXTURE_PASSWORD (12+ chars)');

const prisma = new PrismaClient();

/** Manila wall-clock "2026-10-16 08:00" → Date. */
function mnl(local: string): Date {
  return new Date(`${local.replace(' ', 'T')}:00+08:00`);
}

async function upsertUser(input: {
  email: string | null;
  employeeId: string;
  role: 'super_admin' | 'supervisor' | 'branch' | 'staff';
  firstName: string;
  lastName: string;
}) {
  const passwordHash = input.email ? await bcrypt.hash(password as string, 12) : null;
  return prisma.user.upsert({
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
}

async function assign(userId: string, branchId: string, assignedAt: Date, removedAt: Date | null = null) {
  const existing = await prisma.userBranchAssignment.findFirst({ where: { userId, branchId, assignedAt } });
  if (!existing) await prisma.userBranchAssignment.create({ data: { userId, branchId, assignedAt, removedAt } });
}

async function shift(employeeId: string, branchId: string, from: string, to: string | null, extra: { breakMinutes?: number; breaks?: Array<[string, string]> } = {}) {
  const clockIn = mnl(from);
  const clockOut = to ? mnl(to) : null;
  const record = await prisma.attendanceRecord.create({
    data: {
      employeeId,
      branchId,
      clockInServerTime: clockIn,
      clockInGpsLat: 14.6507,
      clockInGpsLng: 121.0494,
      clockInGpsStatus: 'within_radius',
      clockOutServerTime: clockOut,
      breakMinutes: extra.breakMinutes ?? 0,
      actualWorkMinutes: clockOut ? Math.round((clockOut.getTime() - clockIn.getTime()) / 60000) - (extra.breakMinutes ?? 0) : null,
    },
  });
  for (const [start, end] of extra.breaks ?? []) {
    await prisma.attendanceBreak.create({
      data: { attendanceRecordId: record.id, startedAt: mnl(start), endedAt: mnl(end), startedBy: employeeId, endedBy: employeeId, endReason: 'resumed' },
    });
  }
  return record;
}

async function main() {
  const { staffPinService } = await import('../src/modules/staff-pin/staff-pin.service.js');
  const north = await prisma.branch.findUniqueOrThrow({ where: { code: 'MAIN01' } });
  await prisma.branch.update({ where: { id: north.id }, data: { gpsLatitude: 14.6507, gpsLongitude: 121.0494, gpsRadiusMeters: 500 } });
  const south = await prisma.branch.upsert({
    where: { code: 'P52S01' },
    update: {},
    create: { name: 'P52 South Branch', code: 'P52S01', address: '1 Test Avenue', city: 'Makati', status: 'active', gpsLatitude: 14.6507, gpsLongitude: 121.0494, gpsRadiusMeters: 500 },
  });

  const longAgo = new Date('2026-01-01T00:00:00Z');
  const admin = await upsertUser({ email: 'p52-admin@local.test', employeeId: 'P52-ADMIN', role: 'super_admin', firstName: 'Paz', lastName: 'Admin' });
  const supN = await upsertUser({ email: 'p52-sup-north@local.test', employeeId: 'P52-SUP-N', role: 'supervisor', firstName: 'Sol', lastName: 'North' });
  const supS = await upsertUser({ email: 'p52-sup-south@local.test', employeeId: 'P52-SUP-S', role: 'supervisor', firstName: 'Sam', lastName: 'South' });
  const brN = await upsertUser({ email: 'p52-branch-north@local.test', employeeId: 'P52-BR-N', role: 'branch', firstName: 'North', lastName: 'Terminal' });
  const brS = await upsertUser({ email: 'p52-branch-south@local.test', employeeId: 'P52-BR-S', role: 'branch', firstName: 'South', lastName: 'Terminal' });
  const ana = await upsertUser({ email: null, employeeId: 'P52-ANA', role: 'staff', firstName: 'Ana', lastName: 'Reyes' });
  const ben = await upsertUser({ email: null, employeeId: 'P52-BEN', role: 'staff', firstName: 'Ben', lastName: 'Cruz' });
  const carl = await upsertUser({ email: null, employeeId: 'P52-CARL', role: 'staff', firstName: 'Carl', lastName: 'Diaz' });
  const dana = await upsertUser({ email: null, employeeId: 'P52-DANA', role: 'staff', firstName: 'Dana', lastName: 'Lim' });
  const eve = await upsertUser({ email: null, employeeId: 'P52-EVE', role: 'staff', firstName: 'Maria Concepcion Evangelista', lastName: 'de los Santos-Villanueva-Montemayor' });
  const fe = await upsertUser({ email: null, employeeId: 'P52-FE', role: 'staff', firstName: '=HYPERLINK("http://x")', lastName: 'Formula' });

  await assign(supN.id, north.id, longAgo);
  await assign(supS.id, south.id, longAgo);
  await assign(brN.id, north.id, longAgo);
  await assign(brS.id, south.id, longAgo);
  for (const u of [ana, ben, eve, fe]) await assign(u.id, north.id, longAgo);
  await assign(carl.id, south.id, longAgo);
  // Dana transferred North → South on 2026-10-20 (Manila midnight).
  await assign(dana.id, north.id, longAgo, mnl('2026-10-20 00:00'));
  await assign(dana.id, south.id, mnl('2026-10-20 00:00'));

  const adminActor = { user_id: admin.id, role: 'super_admin', email: admin.email, iat: 0, exp: 9999999999 } as const;
  for (const [userId, pin] of [
    [ana.id, process.env.P52_PIN_ANA],
    [ben.id, process.env.P52_PIN_BEN],
  ] as const) {
    if (!pin) throw new Error('Refusing: set P52_PIN_ANA / P52_PIN_BEN');
    await staffPinService.setPin(userId, pin, adminActor as never, null);
  }

  if ((await prisma.attendanceRecord.count({ where: { employeeId: ana.id } })) === 0) {
    // ---- 1–15 October (previous period) ----
    await shift(ana.id, north.id, '2026-10-14 08:00', '2026-10-14 16:00');
    await shift(carl.id, south.id, '2026-10-14 09:00', '2026-10-14 17:00', { breakMinutes: 30 });
    // Overnight shift starting on the cutoff day: belongs to 1–15 in full.
    await shift(ben.id, north.id, '2026-10-15 22:00', '2026-10-16 06:00');

    // ---- 16–31 October (current period) ----
    // P51 interval break; break_minutes holds the same 60 minutes (must not be subtracted twice).
    await shift(ana.id, north.id, '2026-10-16 08:00', '2026-10-16 17:00', { breakMinutes: 60, breaks: [['2026-10-16 12:00', '2026-10-16 13:00']] });
    // Legacy break total, no intervals.
    await shift(ana.id, north.id, '2026-10-17 08:00', '2026-10-17 17:00', { breakMinutes: 60 });
    // Overnight across the 2026-10-20 midnight (a rate change is set to start that day during verification), with a night break.
    await shift(ana.id, north.id, '2026-10-19 22:00', '2026-10-20 06:30', { breakMinutes: 30, breaks: [['2026-10-20 02:00', '2026-10-20 02:30']] });
    // Corrected record: original soft-deleted, correction row with legacy break minutes.
    const original = await shift(ana.id, north.id, '2026-10-22 08:00', '2026-10-22 20:00');
    await prisma.attendanceRecord.update({ where: { id: original.id }, data: { deletedAt: mnl('2026-10-23 09:00') } });
    await prisma.attendanceRecord.create({
      data: {
        employeeId: ana.id,
        branchId: north.id,
        clockInServerTime: mnl('2026-10-22 08:00'),
        clockInGpsLat: 14.6507,
        clockInGpsLng: 121.0494,
        clockInGpsStatus: 'within_radius',
        clockOutServerTime: mnl('2026-10-22 16:30'),
        breakMinutes: 30,
        actualWorkMinutes: 480,
        status: 'corrected',
        correctionReason: 'Fixture: forgot to clock out at 16:30',
        correctedBy: supN.id,
        originalRecordId: original.id,
      },
    });
    // 9 h without breaks → possible overtime flag.
    await shift(ben.id, north.id, '2026-10-16 09:00', '2026-10-16 18:00');
    // Dana: North before the transfer, South after.
    await shift(dana.id, north.id, '2026-10-16 08:00', '2026-10-16 12:00');
    await shift(dana.id, north.id, '2026-10-18 08:00', '2026-10-18 12:00');
    await shift(dana.id, south.id, '2026-10-21 08:00', '2026-10-21 16:00', { breakMinutes: 30 });
    await shift(eve.id, north.id, '2026-10-23 08:00', '2026-10-23 12:00');
    await shift(fe.id, north.id, '2026-10-24 08:00', '2026-10-24 12:00');
    await shift(carl.id, south.id, '2026-10-21 09:00', '2026-10-21 17:00', { breakMinutes: 30 });
  }

  console.warn('P52 fixtures ready:', {
    branches: { north: north.id, south: south.id },
    supervisors: { north: supN.id, south: supS.id },
    staff: { ana: ana.id, ben: ben.id, carl: carl.id, dana: dana.id, eve: eve.id, fe: fe.id },
  });
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
