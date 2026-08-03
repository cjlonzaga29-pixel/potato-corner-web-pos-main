/**
 * TASK 174 — read-only diagnostic for the branch-account creation bug.
 *
 * Finds every Branch that has no active 'branch'-role UserBranchAssignment,
 * i.e. every branch visible in Branch Management but missing from Branch
 * Accounts. Prints a truth table per orphaned branch. No writes.
 *
 * Usage: tsx scripts/task174-diagnose-branch-accounts.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function maskEmail(email: string | null): string {
  if (!email) return '(none)';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

function maskConnectionString(url: string): string {
  return url.replace(/(:\/\/[^:]+):[^@]+@/, '$1:****@').replace(/(@[^./]+)\.[^/]+/, '$1.***');
}

async function main() {
  console.log('Connecting to:', maskConnectionString(process.env.DATABASE_URL ?? ''));

  const branches = await prisma.branch.findMany({
    select: {
      id: true,
      name: true,
      code: true,
      status: true,
      createdAt: true,
      userAssignments: {
        where: { removedAt: null },
        select: {
          id: true,
          assignedAt: true,
          user: {
            select: { id: true, email: true, role: true, isActive: true, createdAt: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`\nTotal branches: ${branches.length}`);

  const orphaned = branches.filter((b) => !b.userAssignments.some((a) => a.user.role === 'branch'));

  console.log(`Branches with NO active 'branch'-role account: ${orphaned.length}\n`);

  for (const b of orphaned) {
    console.log('================================================');
    console.log(`Branch: ${b.name} (${b.code}) id=${b.id} status=${b.status} createdAt=${b.createdAt.toISOString()}`);
    console.log('Branch exists?                          YES');
    const otherAssignments = b.userAssignments.filter((a) => a.user.role !== 'branch');
    console.log(`Other (non-branch) active assignments:   ${otherAssignments.length}`);
    console.log('Application user (role=branch) exists?  NO (no active assignment)');
    console.log('Branch assignment exists?                NO');
    console.log('Branch Accounts query (findAllAccounts)  will NOT include this branch');
  }

  // Also check for orphaned 'branch'-role users that exist but have no active assignment at all
  // (covers the case where employeesRepository.create partially completed: user row created,
  // but the branchAssignments.createMany step in the same tx did not — shouldn't happen since
  // both are in one $transaction, but checked defensively).
  const branchRoleUsers = await prisma.user.findMany({
    where: { role: 'branch' },
    select: {
      id: true,
      email: true,
      isActive: true,
      createdAt: true,
      branchAssignments: { where: { removedAt: null }, select: { branchId: true } },
    },
  });

  const usersWithNoAssignment = branchRoleUsers.filter((u) => u.branchAssignments.length === 0);
  console.log(`\n'branch'-role users with zero active assignments: ${usersWithNoAssignment.length}`);
  for (const u of usersWithNoAssignment) {
    console.log(
      `  userId=${u.id} email=${maskEmail(u.email)} active=${u.isActive} createdAt=${u.createdAt.toISOString()}`,
    );
  }

  console.log('\nDone. No writes performed.');
  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error('Diagnostic failed:', error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
