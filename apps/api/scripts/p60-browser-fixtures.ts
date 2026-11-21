// POS-PERF-P60 — local-only fixture for driving the Expenses screens. Run after
// prisma/seed.ts on a NEW disposable database. More than one page of legacy
// expenses at MAIN01 under every old category, a second branch assigned to the
// seeded supervisor, and a third branch with its own supervisor and expenses that
// the first must never see. No expense type is created: the driver makes those on
// screen. Prints ids only.
//
// Usage (from apps/api): ALLOW_DATABASE_SEED=true npx tsx scripts/p60-browser-fixtures.ts
import { PrismaClient, Prisma } from '@prisma/client';

function assertDisposableLocal(): void {
  if (process.env.ALLOW_DATABASE_SEED !== 'true') throw new Error('Refusing: set ALLOW_DATABASE_SEED=true');
  if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('Refusing: PRODUCTION_DATABASE_URL_DIRECT is set');
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = process.env[name];
    if (!raw) throw new Error(`Refusing: ${name} is not set`);
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1') throw new Error(`Refusing: ${name} is not 127.0.0.1`);
    if (url.pathname !== '/p60_browser') throw new Error(`Refusing: ${name} is not the p60_browser database`);
  }
}

assertDisposableLocal();
const prisma = new PrismaClient();

const LEGACY_ROWS = 30;
const CATEGORIES = ['utilities', 'supplies', 'staff_meals', 'miscellaneous'] as const;

async function main(): Promise<void> {
  const main = await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN01' } });
  const supervisor = await prisma.user.findFirstOrThrow({ where: { email: 'supervisor@potatocorner.test' } });

  const second = await prisma.branch.upsert({ where: { code: 'P60B2' }, update: { status: 'active' }, create: { name: 'P60 Second', code: 'P60B2', address: 'x', city: 'x', status: 'active' } });
  const assigned = await prisma.userBranchAssignment.findFirst({ where: { userId: supervisor.id, branchId: second.id, removedAt: null } });
  if (!assigned) await prisma.userBranchAssignment.create({ data: { userId: supervisor.id, branchId: second.id } });

  const elsewhere = await prisma.branch.upsert({ where: { code: 'P60X1' }, update: { status: 'active' }, create: { name: 'P60 Elsewhere', code: 'P60X1', address: 'x', city: 'x', status: 'active' } });
  const other = await prisma.user.upsert({
    where: { email: 'p60-other-supervisor@potatocorner.test' },
    update: {},
    create: { email: 'p60-other-supervisor@potatocorner.test', passwordHash: supervisor.passwordHash, role: 'supervisor', firstName: 'Other', lastName: 'Supervisor', employmentType: 'regular', mustChangePassword: false },
  });
  const otherAssigned = await prisma.userBranchAssignment.findFirst({ where: { userId: other.id, branchId: elsewhere.id, removedAt: null } });
  if (!otherAssigned) await prisma.userBranchAssignment.create({ data: { userId: other.id, branchId: elsewhere.id } });

  // Same Manila business date, so pages have to break ties.
  const incurredAt = new Date('2026-10-14T16:00:00.000Z');
  if ((await prisma.expense.count({ where: { branchId: main.id, vendorName: 'P60 Legacy' } })) === 0) {
    await prisma.expense.createMany({
      data: Array.from({ length: LEGACY_ROWS }, (_, n) => ({
        branchId: main.id,
        category: CATEGORIES[n % CATEGORIES.length] ?? 'miscellaneous',
        amount: new Prisma.Decimal(100 + n),
        vendorName: 'P60 Legacy',
        incurredAt,
        createdBy: supervisor.id,
      })),
    });
    await prisma.expense.create({ data: { branchId: elsewhere.id, category: 'utilities', amount: new Prisma.Decimal(777), vendorName: 'P60 Foreign', incurredAt, createdBy: other.id } });
  }

  console.warn(JSON.stringify({ main: main.id, second: second.id, elsewhere: elsewhere.id }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
