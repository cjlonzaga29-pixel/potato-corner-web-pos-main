/**
 * TASK 174 — repairs an orphaned branch (a branch with no active
 * 'branch'-role account) by creating ONLY the missing account, attached to
 * the EXISTING branch id. Never creates a new branch. Idempotent-safe: it
 * refuses to run if the target branch already has an active branch-role
 * assignment, so re-running it is a no-op rather than a duplicate account.
 *
 * The password never appears in source control, logs, or this script's own
 * output — it's read from an environment variable the operator sets in
 * their own shell immediately before running this, and never printed.
 *
 * Usage (run against a shell where DATABASE_URL/DIRECT_URL are already the
 * verified, correct production values):
 *   REPAIR_BRANCH_ID=<uuid> REPAIR_EMAIL=<email> REPAIR_PASSWORD=<password> \
 *     tsx scripts/task174-repair-branch-account.ts             # dry run
 *   REPAIR_BRANCH_ID=<uuid> REPAIR_EMAIL=<email> REPAIR_PASSWORD=<password> \
 *     tsx scripts/task174-repair-branch-account.ts --confirm    # executes
 */
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BCRYPT_COST_FACTOR = 12;

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

function maskConnectionString(url: string): string {
  return url.replace(/(:\/\/[^:]+):[^@]+@/, '$1:****@').replace(/(@[^./]+)\.[^/]+/, '$1.***');
}

async function generateEmployeeId(): Promise<string> {
  const rows = await prisma.$queryRaw<{ value: number }[]>`
    INSERT INTO id_counters (key, value) VALUES ('employee_id_counter', 1)
    ON CONFLICT (key) DO UPDATE SET value = id_counters.value + 1
    RETURNING value
  `;
  const row = rows[0];
  if (!row) throw new Error('generateEmployeeId: no row returned');
  return `PC-EMP-${String(row.value).padStart(6, '0')}`;
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const branchId = process.env.REPAIR_BRANCH_ID;
  const rawEmail = process.env.REPAIR_EMAIL;
  const password = process.env.REPAIR_PASSWORD;

  if (!branchId || !rawEmail || !password) {
    console.error('BLOCKED_BY_SECURE_PASSWORD_INPUT: set REPAIR_BRANCH_ID, REPAIR_EMAIL, and REPAIR_PASSWORD in your own shell before running this script.');
    process.exitCode = 1;
    return;
  }
  const email = rawEmail.trim().toLowerCase();

  console.log(`Mode: ${confirm ? 'EXECUTE (--confirm)' : 'DRY RUN (no writes)'}`);
  console.log('Connecting to:', maskConnectionString(process.env.DATABASE_URL ?? ''));
  console.log('Target branch id:', branchId);
  console.log('Account email (masked):', maskEmail(email));

  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch) {
    console.error(`BLOCKED: no branch found with id ${branchId}. Refusing to create one — this script only repairs an existing branch.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Found branch: ${branch.name} (${branch.code})`);

  const existingAssignment = await prisma.userBranchAssignment.findFirst({
    where: { branchId, removedAt: null, user: { role: 'branch' } },
  });
  if (existingAssignment) {
    console.error('BLOCKED: this branch already has an active branch-role account — refusing to create a duplicate. Nothing to repair.');
    process.exitCode = 1;
    return;
  }

  const existingEmail = await prisma.user.findUnique({ where: { email } });
  if (existingEmail) {
    console.error('BLOCKED: this email is already in use by another account. Choose a different REPAIR_EMAIL.');
    process.exitCode = 1;
    return;
  }

  if (!confirm) {
    console.log('\nDry run complete — verified the branch exists, has no account yet, and the email is free. Re-run with --confirm to create the account.');
    await prisma.$disconnect();
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST_FACTOR);
  const employeeId = await generateEmployeeId();

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        passwordHash,
        role: 'branch',
        firstName: '',
        lastName: '',
        employeeId,
        employmentType: 'regular',
        mustChangePassword: true,
      },
    });
    await tx.userBranchAssignment.create({ data: { userId: user.id, branchId, assignedAt: new Date() } });
    return user;
  });

  console.log(`\nRepair complete. Created user ${result.id} (${employeeId}), role=branch, assigned to branch ${branchId}.`);
  console.log('The account must change its password on first login (mustChangePassword=true).');
  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error('Repair failed:', error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
