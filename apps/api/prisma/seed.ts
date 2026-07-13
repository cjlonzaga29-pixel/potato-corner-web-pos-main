import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// Locked rule (Phase 1) — never lowered, including in seed data.
const BCRYPT_COST_FACTOR = 12;

const SEED_USERS = [
  {
    email: 'admin@potatocorner.test',
    password: 'SuperAdmin123',
    role: 'super_admin' as const,
    firstName: 'Ana',
    lastName: 'Delacruz',
    employeeId: 'SA001',
    assignBranch: false,
  },
  {
    email: 'supervisor@potatocorner.test',
    password: 'Supervisor123',
    role: 'supervisor' as const,
    firstName: 'Marco',
    lastName: 'Reyes',
    employeeId: 'SV001',
    assignBranch: true,
  },
  {
    email: 'staff@potatocorner.test',
    password: 'Staff123',
    role: 'staff' as const,
    firstName: 'Jenny',
    lastName: 'Santos',
    employeeId: 'ST001',
    assignBranch: true,
  },
];

async function main() {
  const branch = await prisma.branch.upsert({
    where: { code: 'MAIN01' },
    update: {},
    create: {
      name: 'Main Branch',
      code: 'MAIN01',
      address: '123 Rizal Street',
      city: 'Quezon City',
      status: 'active',
    },
  });

  for (const seedUser of SEED_USERS) {
    const passwordHash = await bcrypt.hash(seedUser.password, BCRYPT_COST_FACTOR);

    const user = await prisma.user.upsert({
      where: { email: seedUser.email },
      update: {
        passwordHash,
        role: seedUser.role,
        isActive: true,
        loginAttempts: 0,
        lockedUntil: null,
        mustChangePassword: false,
      },
      create: {
        email: seedUser.email,
        passwordHash,
        role: seedUser.role,
        firstName: seedUser.firstName,
        lastName: seedUser.lastName,
        employeeId: seedUser.employeeId,
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });

    if (seedUser.assignBranch) {
      const existingAssignment = await prisma.userBranchAssignment.findFirst({
        where: { userId: user.id, branchId: branch.id, removedAt: null },
      });
      if (!existingAssignment) {
        await prisma.userBranchAssignment.create({
          data: { userId: user.id, branchId: branch.id },
        });
      }
    }
  }

  console.log(`\nBranch: ${branch.name} (${branch.code})\n`);
  console.log('Seeded login credentials:');
  for (const seedUser of SEED_USERS) {
    console.log(`  ${seedUser.role.padEnd(12)} ${seedUser.email.padEnd(28)} ${seedUser.password}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
