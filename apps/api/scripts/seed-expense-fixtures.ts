import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';

const FIXTURE_VENDOR_PREFIX = 'FIXTURE -';

interface PlannedExpense {
  category: 'utilities' | 'supplies' | 'staff_meals' | 'miscellaneous';
  vendorName: string | null;
  amount: number;
  description: string | null;
  daysAgo: number;
}

const PLAN_TEMPLATES: PlannedExpense[] = [
  { category: 'utilities', vendorName: `${FIXTURE_VENDOR_PREFIX} Meralco`, amount: 8500, description: 'Electricity July', daysAgo: 5 },
  { category: 'supplies', vendorName: `${FIXTURE_VENDOR_PREFIX} Puregold Supplies`, amount: 2340, description: 'Cleaning + kitchen supplies', daysAgo: 12 },
  { category: 'staff_meals', vendorName: null, amount: 850, description: 'Lunch for opening staff', daysAgo: 2 },
  { category: 'miscellaneous', vendorName: `${FIXTURE_VENDOR_PREFIX} Ace Hardware`, amount: 1200, description: 'Repair parts', daysAgo: 20 },
  { category: 'utilities', vendorName: `${FIXTURE_VENDOR_PREFIX} Maynilad`, amount: 3100, description: 'Water bill', daysAgo: 9 },
  { category: 'supplies', vendorName: `${FIXTURE_VENDOR_PREFIX} S&R Membership Shopping`, amount: 4750, description: null, daysAgo: 16 },
  { category: 'staff_meals', vendorName: `${FIXTURE_VENDOR_PREFIX} Jollibee`, amount: 1450, description: 'Team dinner after inventory count', daysAgo: 24 },
  { category: 'miscellaneous', vendorName: null, amount: 150, description: 'Parking fees', daysAgo: 1 },
  { category: 'utilities', vendorName: `${FIXTURE_VENDOR_PREFIX} Globe Telecom`, amount: 1899, description: 'Internet + landline', daysAgo: 28 },
];

async function main() {
  const branches = await prisma.branch.findMany({
    where: { status: 'active' },
    orderBy: { createdAt: 'asc' },
    take: 3,
  });
  if (branches.length < 3) {
    throw new Error(`Need at least 3 active branches to seed fixtures, found ${branches.length}`);
  }
  console.log(`Using branches: ${branches.map((b) => `${b.name} (${b.code})`).join(', ')}`);

  const superAdmin = await prisma.user.findFirst({
    where: { role: 'super_admin', isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!superAdmin) {
    throw new Error('Need at least 1 active super_admin user to seed fixtures');
  }
  console.log(`Using createdBy: ${superAdmin.email}`);

  const deleted = await prisma.expense.deleteMany({
    where: { vendorName: { startsWith: FIXTURE_VENDOR_PREFIX } },
  });
  console.log(`Deleted ${deleted.count} existing fixture expenses.`);

  let total = 0;
  let seq = 0;
  for (const branch of branches) {
    for (let i = 0; i < 3; i++) {
      const plan = PLAN_TEMPLATES[seq % PLAN_TEMPLATES.length];
      const incurredAt = new Date(Date.now() - plan.daysAgo * 24 * 60 * 60 * 1000);

      await prisma.expense.create({
        data: {
          branchId: branch.id,
          category: plan.category,
          amount: plan.amount,
          vendorName: plan.vendorName,
          description: plan.description,
          incurredAt,
          createdBy: superAdmin.id,
        },
      });

      total += plan.amount;
      seq++;
    }
  }

  console.log(`Inserted ${seq} expenses. Total amount: PHP ${total.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
