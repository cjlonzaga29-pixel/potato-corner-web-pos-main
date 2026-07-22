import 'dotenv/config';
import bcrypt from 'bcrypt';
import { prisma } from '../src/lib/prisma.js';
import { encryptField, hashField } from '../src/lib/encryption.js';

const BCRYPT_COST_FACTOR = 12;
const REUSE_CUSTOMER_ID = 'PWD-TEST-12345';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** PWD/Senior Citizen VAT-exempt math, matching transactions.service.ts computeAmounts. */
function computeStatutoryDiscountAmounts(subtotal: number) {
  const vatableBase = subtotal / 1.12;
  const discountAmount = round2(vatableBase * 0.2);
  const discountedBase = round2(vatableBase - discountAmount);
  return { discountAmount, vatAmount: 0, vatExemptAmount: 0, totalAmount: discountedBase };
}

async function getOrCreateCashier(branchId: string, branchCode: string) {
  const existingAssignment = await prisma.userBranchAssignment.findFirst({
    where: { branchId, removedAt: null, user: { role: 'staff', isActive: true } },
    include: { user: true },
  });
  if (existingAssignment) return existingAssignment.user;

  const email = `fixture-cashier-${branchCode.toLowerCase()}@potatocorner.test`;
  const passwordHash = await bcrypt.hash('FixtureCashier123', BCRYPT_COST_FACTOR);
  const user = await prisma.user.upsert({
    where: { email },
    update: { isActive: true },
    create: {
      email,
      passwordHash,
      role: 'staff',
      firstName: 'Fixture',
      lastName: `Cashier-${branchCode}`,
      employmentType: 'regular',
      mustChangePassword: false,
    },
  });

  const existing = await prisma.userBranchAssignment.findFirst({
    where: { userId: user.id, branchId, removedAt: null },
  });
  if (!existing) {
    await prisma.userBranchAssignment.create({ data: { userId: user.id, branchId } });
  }
  return user;
}

async function main() {
  const branches = await prisma.branch.findMany({
    where: { status: 'active' },
    orderBy: { createdAt: 'asc' },
    take: 3,
  });
  if (branches.length < 2) {
    throw new Error(`Need at least 2 active branches to seed fixtures, found ${branches.length}`);
  }
  console.log(`Using branches: ${branches.map((b) => `${b.name} (${b.code})`).join(', ')}`);

  const products = await prisma.product.findMany({
    where: { status: 'active' },
    include: { variants: { where: { isActive: true }, take: 1 } },
    take: 2,
  });
  const usableProducts = products.filter((p) => p.variants.length > 0);
  if (usableProducts.length === 0) {
    throw new Error('Need at least 1 active product with an active variant to seed fixtures');
  }
  console.log(`Using products: ${usableProducts.map((p) => p.name).join(', ')}`);

  const cashiersByBranch = new Map<string, Awaited<ReturnType<typeof getOrCreateCashier>>>();
  for (const branch of branches) {
    cashiersByBranch.set(branch.id, await getOrCreateCashier(branch.id, branch.code));
  }

  interface PlannedTx {
    branch: (typeof branches)[number];
    discountType: 'pwd' | 'senior_citizen';
    customerId: string;
    daysAgo: number;
  }

  const plans: PlannedTx[] = [];

  // Reused customer ID — 5 uses across branches within 30 days, to trip the fraud rule.
  for (let i = 0; i < 5; i++) {
    plans.push({
      branch: branches[i % branches.length],
      discountType: i % 2 === 0 ? 'pwd' : 'senior_citizen',
      customerId: REUSE_CUSTOMER_ID,
      daysAgo: i + 1,
    });
  }

  // Other customer IDs, 1-2 uses each, to round out the audit trail.
  const otherCustomers = ['PWD-TEST-20001', 'SC-TEST-30002', 'SC-TEST-30003'];
  otherCustomers.forEach((customerId, idx) => {
    plans.push({
      branch: branches[idx % branches.length],
      discountType: idx % 2 === 0 ? 'pwd' : 'senior_citizen',
      customerId,
      daysAgo: idx + 2,
    });
  });
  plans.push({
    branch: branches[0],
    discountType: 'senior_citizen',
    customerId: otherCustomers[0],
    daysAgo: 6,
  });

  const createdTransactionIds: string[] = [];
  const reuseTransactionIds: string[] = [];
  const reuseBranchIds = new Set<string>();

  let seq = 1;
  for (const plan of plans) {
    const cashier = cashiersByBranch.get(plan.branch.id);
    if (!cashier) {
      throw new Error(`No cashier found for branch ${plan.branch.id}; every plan.branch must come from the seeded branches array`);
    }
    const product = usableProducts[seq % usableProducts.length];
    const variant = product.variants[0];
    const quantity = 1 + (seq % 3);
    const unitPrice = variant.basePrice.toNumber();
    const subtotal = round2(unitPrice * quantity);
    const { discountAmount, vatAmount, vatExemptAmount, totalAmount } = computeStatutoryDiscountAmounts(subtotal);

    const createdAt = new Date(Date.now() - plan.daysAgo * 24 * 60 * 60 * 1000);
    const receiptNumber = `${plan.branch.code}-FIXTURE-${String(seq).padStart(4, '0')}`;

    const transaction = await prisma.transaction.create({
      data: {
        transactionNumber: receiptNumber,
        branchId: plan.branch.id,
        shiftId: null,
        cashierId: cashier.id,
        status: 'completed',
        paymentMethod: 'cash',
        subtotal,
        discountAmount,
        discountType: plan.discountType,
        discountCustomerIdEncrypted: encryptField(plan.customerId),
        discountCustomerIdHash: hashField(plan.customerId),
        vatAmount,
        vatExemptAmount,
        totalAmount,
        amountTendered: totalAmount,
        changeAmount: 0,
        isOfflineTransaction: false,
        createdAt,
        updatedAt: createdAt,
        items: {
          create: [
            {
              productId: product.id,
              productVariantId: variant.id,
              flavorId: null,
              productNameSnapshot: product.name,
              variantNameSnapshot: variant.name,
              flavorNameSnapshot: null,
              unitPriceSnapshot: unitPrice,
              quantity,
              lineTotal: subtotal,
            },
          ],
        },
      },
    });

    createdTransactionIds.push(transaction.id);
    if (plan.customerId === REUSE_CUSTOMER_ID) {
      reuseTransactionIds.push(transaction.id);
      reuseBranchIds.add(plan.branch.id);
    }
    seq++;
  }

  console.log(`Created ${createdTransactionIds.length} transactions.`);
  console.log(`Reuse customer (${REUSE_CUSTOMER_ID}) transactions: ${reuseTransactionIds.join(', ')}`);

  const reuseHash = hashField(REUSE_CUSTOMER_ID);
  const fraudAlert = await prisma.fraudAlert.create({
    data: {
      alertType: 'discount_id_reuse',
      severity: 'high',
      branchId: branches[0].id,
      status: 'open',
      evidence: {
        customer_id_hash: reuseHash,
        occurrence_count: reuseTransactionIds.length,
        window_days: 30,
        transaction_ids: reuseTransactionIds,
        branch_ids: [...reuseBranchIds],
      },
    },
  });
  console.log(`Created FraudAlert ${fraudAlert.id}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
