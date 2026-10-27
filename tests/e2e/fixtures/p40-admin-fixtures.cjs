// POS-PERF-P40 — fixtures for the Admin management browser spec. Local
// pos_verify + local Supabase storage only (refuses any non-127.0.0.1 URL).
// Run with cwd = apps/api so its .env is loaded.
//
//   seed <suffix>                   -> JSON ids for the scenario below
//   remove-object <bucket> <key>    -> deletes one storage object (simulates an unavailable photo)
//   attendance <recordId>           -> { overtime_minutes, actual_work_minutes, updated_at }
//
// Scenario: branches A (active, has a branch account), B (active, no
// account), C (inactive). Supervisor S1 assigned A+B, S2 assigned B
// (overlap on B). Staff at A has an overnight open shift started the
// previous Manila evening; staff at B has a closed shift today. 32
// completed GCash sales at A today (more than one 25-row page), one of them
// PWD-discounted with payment and discount proof photos in private buckets.
require(require('node:path').join(__dirname, '..', '..', '..', 'apps', 'api', 'node_modules', 'dotenv')).config();
const path = require('node:path');
const fs = require('node:fs');
const apiModules = path.join(__dirname, '..', '..', '..', 'apps', 'api', 'node_modules');
const { PrismaClient } = require(path.join(apiModules, '@prisma', 'client'));
const bcrypt = require(path.join(apiModules, 'bcrypt'));
const { createClient } = require(path.join(apiModules, '@supabase', 'supabase-js'));

function assertLocal() {
  for (const name of ['DATABASE_URL', 'SUPABASE_URL']) {
    const value = process.env[name] ?? '';
    if (!/(^|@|\/\/)(127\.0\.0\.1|localhost)(:|\/)/.test(value)) throw new Error(`${name} is not local — refusing to run`);
  }
}

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
function manilaMidnightUtc(daysAgo = 0) {
  const nowManila = new Date(Date.now() + MANILA_OFFSET_MS);
  const midnightManilaAsUtc = Date.UTC(nowManila.getUTCFullYear(), nowManila.getUTCMonth(), nowManila.getUTCDate() - daysAgo);
  return new Date(midnightManilaAsUtc - MANILA_OFFSET_MS);
}

async function ensureBucket(storage, name) {
  const { data } = await storage.listBuckets();
  if (!data?.some((b) => b.name === name)) await storage.createBucket(name, { public: false });
}

async function seed(suffix) {
  const prisma = new PrismaClient();
  const storage = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY).storage;
  try {
    const branch = (label, status) =>
      prisma.branch.create({ data: { name: `P40 ${label} ${suffix}`, code: `P40${label}${suffix}`.slice(0, 20), address: 'Test', city: 'Test City', status } });
    const a = await branch('A', 'active');
    const b = await branch('B', 'active');
    const c = await branch('C', 'inactive');

    const passwordHash = await bcrypt.hash('P40Password!1', 10);
    const login = (role, label, extra = {}) =>
      prisma.user.create({
        data: { role, firstName: `P40${label}`, lastName: suffix, employmentType: 'regular', email: `p40-${label.toLowerCase()}-${suffix}@test.local`, passwordHash, mustChangePassword: false, ...extra },
      });
    const s1 = await login('supervisor', 'SupOne');
    const s2 = await login('supervisor', 'SupTwo');
    const account = await login('branch', 'Account', { firstName: '', lastName: '' });
    const staff = (label) => prisma.user.create({ data: { role: 'staff', firstName: `P40${label}`, lastName: suffix, employmentType: 'regular', position: 'Cashier' } });
    const staffA = await staff('StaffA');
    const staffB = await staff('StaffB');

    const assign = (userId, branchId) => prisma.userBranchAssignment.create({ data: { userId, branchId, assignedAt: new Date() } });
    await assign(s1.id, a.id);
    await assign(s1.id, b.id);
    await assign(s2.id, b.id);
    await assign(account.id, a.id);
    await assign(staffA.id, a.id);
    await assign(staffB.id, b.id);

    const todayStart = manilaMidnightUtc(0);
    const overnight = await prisma.attendanceRecord.create({
      data: { employeeId: staffA.id, branchId: a.id, clockInServerTime: new Date(todayStart.getTime() - 3 * 3600_000), clockInGpsStatus: 'within_radius' },
    });
    const closed = await prisma.attendanceRecord.create({
      data: {
        employeeId: staffB.id,
        branchId: b.id,
        clockInServerTime: new Date(Math.max(todayStart.getTime() + 60_000, Date.now() - 4 * 3600_000)),
        clockOutServerTime: new Date(Date.now() - 60_000),
        clockInGpsStatus: 'within_radius',
        actualWorkMinutes: 180,
        overtimeMinutes: 0,
      },
    });

    for (const bucket of ['payment-proofs', 'discount-proofs']) await ensureBucket(storage, bucket);
    const image = fs.readFileSync(path.join(__dirname, 'gcash-test.png'));
    const paymentKey = `p40/${suffix}/payment.png`;
    const discountKey = `p40/${suffix}/discount.png`;
    for (const [bucket, key] of [['payment-proofs', paymentKey], ['discount-proofs', discountKey]]) {
      const { error } = await storage.from(bucket).upload(key, image, { contentType: 'image/png', upsert: true });
      if (error) throw error;
    }

    const span = Math.max(60_000, Date.now() - todayStart.getTime() - 120_000);
    for (let n = 1; n <= 32; n += 1) {
      const pwd = n === 1;
      await prisma.transaction.create({
        data: {
          transactionNumber: `PC-P40${suffix}-${String(n).padStart(6, '0')}`,
          branchId: a.id,
          cashierId: staffA.id,
          paymentMethod: 'gcash',
          gcashReference: `GC${suffix}${n}`,
          subtotal: 100,
          vatAmount: pwd ? 0 : 10.71,
          discountAmount: pwd ? 17.86 : 0,
          discountType: pwd ? 'pwd' : null,
          totalAmount: pwd ? 71.43 : 100,
          status: 'completed',
          paymentProofKey: pwd ? paymentKey : null,
          paymentProofType: pwd ? 'gallery_upload' : null,
          paymentProofUploadedAt: pwd ? new Date() : null,
          discountProofKey: pwd ? discountKey : null,
          discountProofType: pwd ? 'live_capture' : null,
          discountProofUploadedAt: pwd ? new Date() : null,
          createdAt: new Date(todayStart.getTime() + 60_000 + Math.floor((span * n) / 33)),
        },
      });
    }

    console.log(
      JSON.stringify({
        branches: { a: a.id, b: b.id, c: c.id },
        names: { a: a.name, b: b.name, c: c.name },
        supervisors: { s1: s1.id, s2: s2.id },
        accountEmail: account.email,
        attendance: { overnight: overnight.id, closed: closed.id },
        proof: { paymentKey, discountKey, bytes: image.length },
        pwdReceipt: `PC-P40${suffix}-000001`,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  assertLocal();
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'seed') return seed(args[0]);
  if (mode === 'remove-object') {
    const storage = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY).storage;
    const { error } = await storage.from(args[0]).remove([args[1]]);
    if (error) throw error;
    console.log(JSON.stringify({ removed: args[1] }));
    return;
  }
  if (mode === 'notify') {
    // notify <recipientEmail> <branchId> <branchName>: an earlier outage that recovered, then
    // a current outage reported twice (no recovery yet), and one unrelated stock alert.
    const [email, branchId, branchName] = args;
    const prisma = new PrismaClient();
    try {
      const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
      const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000);
      const rows = [
        { type: 'branch_offline', payload: { type: 'branch_offline', branchId, branchName, lastSeenAt: at(95).toISOString() }, createdAt: at(95) },
        { type: 'branch_online', payload: { type: 'branch_online', branchId, branchName }, createdAt: at(80) },
        { type: 'branch_offline', payload: { type: 'branch_offline', branchId, branchName, lastSeenAt: at(30).toISOString() }, createdAt: at(30) },
        { type: 'branch_offline', payload: { type: 'branch_offline', branchId, branchName, lastSeenAt: at(10).toISOString() }, createdAt: at(10) },
        { type: 'low_stock', payload: { type: 'low_stock', branchId, ingredientName: 'P40 Potato', currentQuantity: 1, threshold: 5 }, createdAt: at(5) },
      ];
      for (const row of rows) await prisma.notification.create({ data: { ...row, recipientUserId: user.id, branchId } });
      console.log(JSON.stringify({ created: rows.length }));
    } finally {
      await prisma.$disconnect();
    }
    return;
  }
  if (mode === 'attendance') {
    const prisma = new PrismaClient();
    try {
      const r = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: args[0] } });
      console.log(JSON.stringify({ overtime_minutes: r.overtimeMinutes, actual_work_minutes: r.actualWorkMinutes, updated_at: r.updatedAt.toISOString() }));
    } finally {
      await prisma.$disconnect();
    }
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
