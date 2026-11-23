// Product permanent delete — LOCAL browser fixtures on top of the P62 stack
// (tests/e2e/manual/p62/stack.sh prepare), with the built API running.
// Refuses anything but a 127.0.0.1 p62_ database and a 127.0.0.1 API.
// Adds, at MAIN01, each with one size and a P62 recipe line:
//   - "PDEL Unsold Fries"   never sold
//   - "PDEL Sold Fries"     sold once through the real checkout API (cashier Ana)
//   - "PDEL Shared Fries"   also set up at a branch outside the seeded supervisor's assignment (view only)
//   - "PDEL Held Fries"     in an unresolved held order (blocked)
// and prints ids to stdout as JSON (no secrets).
//
//   ALLOW_DATABASE_SEED=true npx tsx scripts/product-delete-browser-fixtures.ts
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { generateStaffToken } from '../src/test-utils/auth-tokens.js';

function assertDisposableLocal(): void {
  if (process.env.ALLOW_DATABASE_SEED !== 'true') throw new Error('Refusing: set ALLOW_DATABASE_SEED=true');
  if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('Refusing: PRODUCTION_DATABASE_URL_DIRECT is set');
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = process.env[name];
    if (!raw) throw new Error(`Refusing: ${name} is not set`);
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1') throw new Error(`Refusing: ${name} is not 127.0.0.1`);
    if (!/^\/p62_[a-z0-9_]+$/.test(url.pathname)) throw new Error(`Refusing: ${name} is not a p62_ database`);
  }
  if (new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://invalid').hostname !== '127.0.0.1') throw new Error('Refusing: API is not 127.0.0.1');
}

assertDisposableLocal();
const prisma = new PrismaClient({ log: [] });
const API = process.env.NEXT_PUBLIC_API_URL as string;
// A rerun after a browser pass (which deletes some of them) uses a new tag, e.g. PDEL_TAG=PDEL2.
const TAG = process.env.PDEL_TAG ?? 'PDEL';
if (!/^PDEL[0-9]*$/.test(TAG)) throw new Error('Refusing: PDEL_TAG must look like PDEL or PDEL2');

async function main(): Promise<void> {
  if (await prisma.product.count({ where: { name: { startsWith: `${TAG} ` } } })) throw new Error(`Refusing: ${TAG} fixtures already exist`);
  const main = await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN01' } });
  const supervisor = await prisma.user.findFirstOrThrow({ where: { email: 'supervisor@potatocorner.test' } });
  const assigned = new Set((await prisma.userBranchAssignment.findMany({ where: { userId: supervisor.id } })).map((a) => a.branchId));
  if (!assigned.has(main.id)) throw new Error('Refusing: the seeded supervisor is not assigned to MAIN01');
  const outside =
    (await prisma.branch.findFirst({ where: { status: 'active', id: { notIn: [...assigned] } } })) ??
    (await prisma.branch.create({ data: { name: 'PDEL Outside Branch', code: 'PDELOUT', address: 'x', city: 'x', status: 'active' } }));
  const item = await prisma.inventoryItem.findFirstOrThrow({ where: { name: 'P62 Item 1' } });

  async function product(name: string, branchIds: string[]) {
    const created = await prisma.product.create({ data: { name, status: 'active', everPublished: true, category: 'Fries', createdBy: supervisor.id } });
    const variant = await prisma.productVariant.create({ data: { productId: created.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 60, isActive: true, lifecycleStatus: 'ACTIVE' } });
    await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: item.id, quantityRequired: 1 } });
    for (const branchId of branchIds) await prisma.branchProductAvailability.create({ data: { branchId, productId: created.id, isAvailable: true } });
    return { id: created.id, variantId: variant.id };
  }

  const unsold = await product(`${TAG} Unsold Fries`, [main.id]);
  const sold = await product(`${TAG} Sold Fries`, [main.id]);
  const shared = await product(`${TAG} Shared Fries`, [main.id, outside.id]);
  const held = await product(`${TAG} Held Fries`, [main.id]);

  const ana = await prisma.user.findFirstOrThrow({ where: { role: 'staff', firstName: 'Ana', branchAssignments: { some: { branchId: main.id } } } });
  const token = generateStaffToken(main.id, { userId: ana.id });
  const res = await fetch(`${API}/api/transactions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch_id: main.id,
      items: [{ product_id: sold.id, product_variant_id: sold.variantId, quantity: 1, promotion: null }],
      payment_method: 'cash',
      cash_tendered: 100,
      is_offline_transaction: false,
      idempotency_key: randomUUID(),
      tax_basis: { calculation_mode: 'manual_total_v1', vat_rate: null, discount_rate: null },
      discount_flow: 'manual_v1',
      discount_choice: 'none_applicable',
    }),
  });
  const body = (await res.json()) as { data?: { id: string; receipt_number: string }; error?: { code: string } };
  if (res.status !== 201 || !body.data) throw new Error(`Sale failed: ${res.status} ${body.error?.code ?? ''}`);

  const shift = await prisma.shift.findFirstOrThrow({ where: { branchId: main.id, status: 'active' }, orderBy: { startedAt: 'desc' } });
  await prisma.holdOrder.create({
    data: {
      branchId: main.id,
      shiftId: shift.id,
      cashierId: ana.id,
      expiresAt: new Date(Date.now() + 6 * 3600_000),
      items: { create: [{ productId: held.id, productVariantId: held.variantId, productNameSnapshot: `${TAG} Held Fries`, variantNameSnapshot: 'Regular', unitPriceSnapshot: 60, quantity: 1 }] },
    },
  });

  process.stdout.write(
    `${JSON.stringify({ tag: TAG, mainBranchId: main.id, outsideBranchId: outside.id, outsideBranchName: outside.name, unsold, sold, shared, held, saleId: body.data.id, receipt: body.data.receipt_number })}\n`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
