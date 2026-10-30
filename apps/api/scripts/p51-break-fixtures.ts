// POS-PERF-P51 — disposable LOCAL fixtures for break-time verification.
//
// Usage (from apps/api, against a disposable local database only):
//   ALLOW_DATABASE_SEED=true P51_FIXTURE_PASSWORD=... npx tsx --env-file=.env scripts/p51-break-fixtures.ts
//
// Refuses unless DATABASE_URL and DIRECT_URL both point at 127.0.0.1/localhost
// AND the database name starts with `p51_`. Creates (idempotently) a second
// branch, one Branch Account per branch, a supervisor scoped to the first
// branch only, three staff with PINs, and attendance history (a closed day
// shift with legacy break minutes, a closed overnight shift, a corrected
// record) so the P51 migration can be rehearsed on populated data. Prints
// ids and names only — never passwords, PINs or connection strings.
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

function assertDisposableLocal(): void {
  if (process.env.ALLOW_DATABASE_SEED !== 'true') throw new Error('Refusing: set ALLOW_DATABASE_SEED=true');
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = process.env[name];
    if (!raw) throw new Error(`Refusing: ${name} is not set`);
    const url = new URL(raw);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error(`Refusing: ${name} is not local`);
    if (!/^\/p51_\d+$/.test(url.pathname)) throw new Error(`Refusing: ${name} is not a p51_<digits> database`);
  }
}

assertDisposableLocal();
const password = process.env.P51_FIXTURE_PASSWORD;
if (!password || password.length < 12) throw new Error('Refusing: set P51_FIXTURE_PASSWORD (12+ chars)');

const prisma = new PrismaClient();
const { staffPinService } = await import('../src/modules/staff-pin/staff-pin.service.js');

const HOUR = 60 * 60 * 1000;

async function upsertUser(input: {
  email: string | null;
  employeeId: string;
  role: 'super_admin' | 'supervisor' | 'branch' | 'staff';
  firstName: string;
  lastName: string;
  branchIds: string[];
}) {
  const passwordHash = input.email ? await bcrypt.hash(password as string, 12) : null;
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
  for (const branchId of input.branchIds) {
    const existing = await prisma.userBranchAssignment.findFirst({ where: { userId: user.id, branchId, removedAt: null } });
    if (!existing) await prisma.userBranchAssignment.create({ data: { userId: user.id, branchId } });
  }
  return user;
}

async function main() {
  const north = await prisma.branch.findUniqueOrThrow({ where: { code: 'MAIN01' } });
  await prisma.branch.update({
    where: { id: north.id },
    data: { gpsLatitude: 14.6507, gpsLongitude: 121.0494, gpsRadiusMeters: 500 },
  });
  const south = await prisma.branch.upsert({
    where: { code: 'P51S01' },
    update: {},
    create: {
      name: 'P51 South Branch',
      code: 'P51S01',
      address: '1 Test Avenue',
      city: 'Makati',
      status: 'active',
      gpsLatitude: 14.5547,
      gpsLongitude: 121.0244,
      gpsRadiusMeters: 500,
    },
  });

  const admin = await upsertUser({ email: 'p51-admin@local.test', employeeId: 'P51-ADMIN', role: 'super_admin', firstName: 'Paz', lastName: 'Admin', branchIds: [] });
  await upsertUser({ email: 'p51-branch-north@local.test', employeeId: 'P51-BR-N', role: 'branch', firstName: 'North', lastName: 'Terminal', branchIds: [north.id] });
  await upsertUser({ email: 'p51-branch-south@local.test', employeeId: 'P51-BR-S', role: 'branch', firstName: 'South', lastName: 'Terminal', branchIds: [south.id] });
  await upsertUser({ email: 'p51-supervisor@local.test', employeeId: 'P51-SUP-N', role: 'supervisor', firstName: 'Sol', lastName: 'Supervisor', branchIds: [north.id] });
  const ana = await upsertUser({ email: null, employeeId: 'P51-ANA', role: 'staff', firstName: 'Ana', lastName: 'Reyes', branchIds: [north.id] });
  const ben = await upsertUser({ email: null, employeeId: 'P51-BEN', role: 'staff', firstName: 'Ben', lastName: 'Cruz', branchIds: [north.id] });
  const carl = await upsertUser({ email: null, employeeId: 'P51-CARL', role: 'staff', firstName: 'Carl', lastName: 'Diaz', branchIds: [south.id] });

  const adminActor = { user_id: admin.id, role: 'super_admin', email: admin.email, iat: 0, exp: 9999999999 } as const;
  const pins = [
    [ana.id, process.env.P51_PIN_ANA],
    [ben.id, process.env.P51_PIN_BEN],
    [carl.id, process.env.P51_PIN_CARL],
  ] as const;
  for (const [userId, pin] of pins) {
    if (!pin) throw new Error('Refusing: set P51_PIN_ANA / P51_PIN_BEN / P51_PIN_CARL');
    await staffPinService.setPin(userId, pin, adminActor as never, null);
  }

  // Attendance history — only created once (skipped if Ana already has any).
  if ((await prisma.attendanceRecord.count({ where: { employeeId: ana.id } })) === 0) {
    const now = Date.now();
    const yesterday8 = new Date(now - 30 * HOUR);
    await prisma.attendanceRecord.create({
      data: {
        employeeId: ana.id,
        branchId: north.id,
        clockInServerTime: yesterday8,
        clockInGpsLat: 14.6507,
        clockInGpsLng: 121.0494,
        clockInGpsStatus: 'within_radius',
        clockOutServerTime: new Date(yesterday8.getTime() + 9 * HOUR),
        breakMinutes: 60,
        actualWorkMinutes: 480,
        overtimeMinutes: 0,
      },
    });
    const overnightIn = new Date(now - 40 * HOUR);
    await prisma.attendanceRecord.create({
      data: {
        employeeId: ben.id,
        branchId: north.id,
        clockInServerTime: overnightIn,
        clockInGpsLat: 14.6507,
        clockInGpsLng: 121.0494,
        clockInGpsStatus: 'within_radius',
        clockOutServerTime: new Date(overnightIn.getTime() + 9 * HOUR),
        breakMinutes: 30,
        actualWorkMinutes: 510,
        overtimeMinutes: 30,
      },
    });
    const original = await prisma.attendanceRecord.create({
      data: {
        employeeId: carl.id,
        branchId: south.id,
        clockInServerTime: new Date(now - 60 * HOUR),
        clockInGpsLat: 14.5547,
        clockInGpsLng: 121.0244,
        clockInGpsStatus: 'within_radius',
        clockOutServerTime: new Date(now - 52 * HOUR),
        breakMinutes: 0,
        actualWorkMinutes: 480,
        overtimeMinutes: 0,
        deletedAt: new Date(now - 50 * HOUR),
      },
    });
    await prisma.attendanceRecord.create({
      data: {
        employeeId: carl.id,
        branchId: south.id,
        clockInServerTime: original.clockInServerTime,
        clockInGpsLat: 14.5547,
        clockInGpsLng: 121.0244,
        clockInGpsStatus: 'within_radius',
        clockOutServerTime: original.clockOutServerTime,
        breakMinutes: 45,
        actualWorkMinutes: 435,
        overtimeMinutes: 0,
        status: 'corrected',
        correctionReason: 'Fixture: forgot to log lunch break',
        correctedBy: admin.id,
        originalRecordId: original.id,
      },
    });
  }

  console.warn('P51 fixtures ready:', {
    branches: { north: north.id, south: south.id },
    staff: { ana: ana.id, ben: ben.id, carl: carl.id },
  });
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
