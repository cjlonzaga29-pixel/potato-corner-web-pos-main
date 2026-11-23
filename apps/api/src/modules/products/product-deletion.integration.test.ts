import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * Product permanent delete, through the real Express app against a real
 * (disposable, local) Postgres:
 *
 *   - an unsold product and a sold product are physically removed with their
 *     own setup; shared inventory, flavors, options and other products stay;
 *   - receipts, refunds, the product performance report, stock and stock
 *     movements are unchanged, and a refund after the delete still returns
 *     exactly what the sale deducted;
 *   - shared-product branch scope, staff / super admin / unconfirmed requests;
 *   - blockers (held order, promotion, older sale without a snapshot) with
 *     their specific codes;
 *   - completed-sale replay, live checkout and offline sync of the deleted
 *     product; retry of the delete;
 *   - both orders of the delete/checkout and delete/hold race, ordered by
 *     database lock waits (no sleeps);
 *   - a sold size still can't be deleted on its own (the foreign key that
 *     used to refuse it is gone, the explicit check replaces it).
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const removedImages: string[] = [];
vi.mock('../../lib/notify.js', () => ({ notifyBranch: vi.fn(), notifySuperAdmin: vi.fn(), notifyUser: vi.fn() }));
vi.mock('../../middleware/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middleware/rate-limiter.js')>()),
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../lib/supabase.js', () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          removedImages.push(...paths);
          return { data: null, error: null };
        },
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `http://storage.test/${path}` }, error: null }),
        createSignedUrls: async (paths: string[]) => ({ data: paths.map((path) => ({ path, signedUrl: `http://storage.test/${path}`, error: null })), error: null }),
      }),
    },
  },
}));

// The rollout switch is off by default; this suite exercises the enabled path
// (and switches it off once, below, to prove the refusal).
process.env.PRODUCT_PERMANENT_DELETE_ENABLED = 'true';
const { app } = await import('../../app.js');
const { config } = await import('../../config/index.js');
const { Prisma } = await import('@prisma/client');
const { prisma } = await import('../../lib/prisma.js');
const { generateStaffToken, generateSupervisorToken, generateSuperAdminToken } = await import('../../test-utils/auth-tokens.js');
const { inventoryDeductionService } = await import('../inventory-deduction/inventory-deduction.service.js');
const { reportsRepository } = await import('../reports/reports.repository.js');
const { productDeletionRepository } = await import('./product-deletion.repository.js');

type ApiBody = { data: Record<string, unknown> | null; error: { code: string; message?: string; details?: unknown } | null };
const CONFIRM = { confirm: 'PERMANENTLY_DELETE' };
const BASIS = { calculation_mode: 'manual_total_v1', vat_rate: null, discount_rate: null };

describe.skipIf(!isLocalDatabase)('product permanent delete (real Express + Postgres)', () => {
  const tag = randomUUID().slice(0, 8);
  const branch = { a: '', b: '' };
  const users: Record<string, string> = {};
  const tokens = { ana: '', bea: '', supA: '', supAB: '', admin: '' };
  const products: Record<string, { id: string; variants: Record<string, string> }> = {};
  let unitG = '';
  let plenty = '';
  let flavorId = '';
  let optionGroupId = '';
  let server: Server;
  let baseUrl = '';
  let setupSucceeded = false;

  async function call(method: string, path: string, token: string, body?: unknown, deviceId = `pdel-${tag}`) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Device-ID': deviceId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as ApiBody };
  }

  async function makeProduct(key: string, sizes: string[], available: string[], extra: Record<string, unknown> = {}) {
    const id = (await prisma.product.create({ data: { name: `PDEL ${key} ${tag}`, status: 'active', everPublished: true, createdBy: users.SupAB, ...extra } })).id;
    const variants: Record<string, string> = {};
    for (const size of sizes) {
      const variant = await prisma.productVariant.create({ data: { productId: id, name: size, sizeLabel: size, basePrice: 50, isActive: true, lifecycleStatus: 'ACTIVE' } });
      variants[size] = variant.id;
      await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: plenty, quantityRequired: 3 } });
    }
    for (const branchId of available) await prisma.branchProductAvailability.create({ data: { branchId, productId: id, isAvailable: true } });
    products[key] = { id, variants };
    return products[key];
  }

  const line = (key: string, size = 'Regular', quantity = 1) => ({ product_id: products[key]?.id, product_variant_id: products[key]?.variants[size], quantity, promotion: null });
  const saleBody = (items: unknown[], key: string) => ({
    branch_id: branch.a,
    items,
    payment_method: 'cash',
    cash_tendered: 100000,
    is_offline_transaction: false,
    idempotency_key: key,
    tax_basis: BASIS,
    discount_flow: 'manual_v1',
    discount_choice: 'none_applicable',
  });
  const sale = (items: unknown[], key: string = randomUUID()) => call('POST', '/api/transactions', tokens.ana, saleBody(items, key));
  const stockA = async () => Number((await prisma.inventoryStock.findFirstOrThrow({ where: { branchId: branch.a, inventoryItemId: plenty } })).quantityOnHand);
  const movementCount = () => prisma.inventoryStockMovement.count({ where: { branchId: branch.a, inventoryItemId: plenty } });
  /**
   * Runs deduction cycles until these sales' own jobs are completed. The queue is shared by every test file running in parallel
   * against this database, so one runCycle(10) can claim only other files' older jobs (or another file's worker can hold ours).
   */
  const deductSales = async (transactionIds: string[]) => {
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const done = await prisma.inventoryDeductionJob.count({ where: { transactionId: { in: transactionIds }, status: 'completed' } });
      if (done === transactionIds.length) return;
      const { claimed } = await inventoryDeductionService.runCycle(10);
      if (claimed === 0) await new Promise((resolve) => setTimeout(resolve, 25)); // held by another file's worker
    }
    throw new Error(`deduction jobs not completed for ${transactionIds.join(', ')}`);
  };

  /** Resolves once some backend is waiting on a row lock in this database (the delete/insert race barrier). */
  async function waitForLockWait(): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if ((rows[0]?.n ?? 0n) > 0n) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('no lock wait observed');
  }

  beforeAll(async () => {
    for (const key of ['a', 'b'] as const) {
      branch[key] = (await prisma.branch.create({ data: { name: `PDEL Branch ${key.toUpperCase()} ${tag}`, code: `PDEL${key}-${tag}`, address: 'x', city: 'x', status: 'active' } })).id;
    }
    const mk = async (role: 'staff' | 'supervisor' | 'super_admin', first: string) =>
      (
        await prisma.user.create({
          data: { role, firstName: first, lastName: `PDEL${tag}`, email: `${first.toLowerCase()}-${tag}@pdel.test`, employeeId: role === 'staff' ? `PDEL-${first}-${tag}` : null, employmentType: 'regular', mustChangePassword: false },
        })
      ).id;
    users.Ana = await mk('staff', 'Ana');
    users.Bea = await mk('staff', 'Bea');
    users.SupA = await mk('supervisor', 'SupA');
    users.SupAB = await mk('supervisor', 'SupAB');
    users.Admin = await mk('super_admin', 'Admin');
    await prisma.userBranchAssignment.createMany({
      data: [
        { userId: users.Ana, branchId: branch.a },
        { userId: users.Bea, branchId: branch.b },
        { userId: users.SupA, branchId: branch.a },
        { userId: users.SupAB, branchId: branch.a },
        { userId: users.SupAB, branchId: branch.b },
      ],
    });
    for (const [employeeId, branchId] of [[users.Ana, branch.a], [users.Bea, branch.b]] as const) {
      await prisma.attendanceRecord.create({ data: { employeeId: employeeId as string, branchId, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });
    }
    tokens.ana = generateStaffToken(branch.a, { userId: users.Ana });
    tokens.bea = generateStaffToken(branch.b, { userId: users.Bea });
    tokens.supA = generateSupervisorToken([branch.a], { userId: users.SupA });
    tokens.supAB = generateSupervisorToken([branch.a, branch.b], { userId: users.SupAB });
    tokens.admin = generateSuperAdminToken({ userId: users.Admin });

    unitG = (await prisma.unitOfMeasure.create({ data: { code: `pdel-g-${tag}`, name: 'Gram', dimension: 'WEIGHT', isBaseUnit: true } })).id;
    plenty = (await prisma.inventoryItem.create({ data: { name: `PDEL Plenty ${tag}`, baseUnitId: unitG, trackInventory: true } })).id;
    for (const branchId of [branch.a, branch.b]) await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: plenty, quantityOnHand: 1000 } });
    flavorId = (await prisma.flavor.create({ data: { name: `PDEL Cheese ${tag}`, ingredientName: 'x', ingredientUnit: 'g', isActive: true } })).id;
    optionGroupId = (await prisma.productOptionGroup.create({ data: { code: `pdel-g-${tag}`, name: 'Sauce', selectionType: 'SINGLE', required: false, minSelections: 0, isActive: true } })).id;

    const unsold = await makeProduct('Unsold', ['Regular', 'Large'], [branch.a], { imagePath: `pdel-${tag}/image.webp` });
    await prisma.productVariantFlavor.create({ data: { productVariantId: unsold.variants.Regular as string, flavorId, isAvailable: true } });
    await prisma.productVariantOptionGroup.create({ data: { productVariantId: unsold.variants.Regular as string, optionGroupId } });
    await makeProduct('Sold', ['Regular'], [branch.a]);
    await makeProduct('Other', ['Regular'], [branch.a]);
    await makeProduct('Shared', ['Regular'], [branch.a, branch.b]);
    await makeProduct('Promo', ['Regular'], [branch.a]);
    await makeProduct('Held', ['Regular'], [branch.a]);
    await makeProduct('Legacy', ['Regular'], [branch.a]);
    await makeProduct('RaceSale', ['Regular'], [branch.a]);
    await makeProduct('RaceHold', ['Regular'], [branch.a]);
    await makeProduct('SoldAtB', ['Regular'], [branch.a]);
    // A branch copy of Sold: it must keep working after its source is deleted.
    await makeProduct('Copy', ['Regular'], [branch.a], { forkedFromProductId: products.Sold?.id, branchExclusive: true, exclusiveBranchId: branch.a });

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    setupSucceeded = true;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (!setupSucceeded) return;
    // Best effort: the harness drops the whole disposable cluster afterwards.
    try {
      const branches = Object.values(branch);
      await prisma.$executeRaw`DELETE FROM "hold_order_items" WHERE "hold_order_id" IN (SELECT id FROM "hold_orders" WHERE "branch_id" = ANY(${branches}))`;
      await prisma.$executeRaw`DELETE FROM "hold_orders" WHERE "branch_id" = ANY(${branches})`;
    } catch {
      /* disposable database */
    }
  });

  it('shows the consequences of deleting an unsold product and removes it with only its own setup', async () => {
    const id = products.Unsold?.id as string;
    const preview = await call('GET', `/api/products/${id}/deletion-preview`, tokens.supA);
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({ product: { id, name: `PDEL Unsold ${tag}` }, size_count: 2, sale_count: 0, can_delete: true, has_image: true, blockers: [] });
    expect((preview.body.data?.branches as { name: string }[]).map((b) => b.name)).toEqual([`PDEL Branch A ${tag}`]);

    const stockBefore = await stockA();
    const res = await call('DELETE', `/api/products/${id}`, tokens.supA, CONFIRM);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id, deleted: true });

    expect(await prisma.product.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.productVariant.count({ where: { productId: id } })).toBe(0);
    expect(await prisma.branchProductAvailability.count({ where: { productId: id } })).toBe(0);
    expect(await prisma.productComponent.count({ where: { productVariantId: { in: Object.values(products.Unsold?.variants ?? {}) } } })).toBe(0);
    // Shared catalog and stock untouched.
    expect(await prisma.inventoryItem.findUnique({ where: { id: plenty } })).not.toBeNull();
    expect(await prisma.flavor.findUnique({ where: { id: flavorId } })).not.toBeNull();
    expect(await prisma.productOptionGroup.findUnique({ where: { id: optionGroupId } })).not.toBeNull();
    expect(await prisma.product.findUnique({ where: { id: products.Other?.id as string } })).not.toBeNull();
    expect(await stockA()).toBe(stockBefore);
    expect(removedImages).toContain(`pdel-${tag}/image.webp`);

    const audit = await prisma.auditOutbox.findFirst({ where: { action: 'PRODUCT_PERMANENTLY_DELETED', entityId: id } });
    expect(audit).toMatchObject({ actorId: users.SupA, entityType: 'product' });
    expect((audit?.beforeState as { name: string; sizes: unknown[] }).sizes).toHaveLength(2);

    // Retry after success: a definite answer, nothing changes.
    const retry = await call('DELETE', `/api/products/${id}`, tokens.supA, CONFIRM);
    expect(retry.status).toBe(410);
    expect(retry.body.error?.code).toBe('PRODUCT_ALREADY_DELETED');
  });

  it('deletes a sold product and leaves receipts, refunds, replay, reports, stock and movements unchanged', async () => {
    const id = products.Sold?.id as string;
    const key1 = randomUUID();
    const first = await sale([line('Sold', 'Regular', 2), line('Other')], key1);
    expect(first.status).toBe(201);
    const second = await sale([line('Sold')]);
    expect(second.status).toBe(201);
    const firstId = first.body.data?.id as string;
    const secondId = second.body.data?.id as string;
    await deductSales([firstId, secondId]);

    const receiptBefore = (await call('GET', `/api/transactions/${firstId}`, tokens.supA)).body.data;
    const stockBefore = await stockA();
    const movementsBefore = await movementCount();
    const reportBefore = await reportsRepository.getProductPerformance({ branchId: branch.a, page: 1, limit: 100 });

    const preview = await call('GET', `/api/products/${id}/deletion-preview`, tokens.supA);
    expect(preview.body.data).toMatchObject({ sale_count: 2, branch_copy_count: 1, can_delete: true, blockers: [] });

    const res = await call('DELETE', `/api/products/${id}`, tokens.supA, CONFIRM);
    expect(res.status).toBe(200);
    expect(await prisma.product.findUnique({ where: { id } })).toBeNull();

    // Receipt identical, still naming the product and its original id.
    const receiptAfter = (await call('GET', `/api/transactions/${firstId}`, tokens.supA)).body.data;
    expect(receiptAfter).toEqual(receiptBefore);
    expect((receiptAfter?.items as { product_id: string; product_name: string }[]).find((i) => i.product_id === id)?.product_name).toBe(`PDEL Sold ${tag}`);
    // Stock and movements untouched by the delete.
    expect(await stockA()).toBe(stockBefore);
    expect(await movementCount()).toBe(movementsBefore);
    // Report keeps the same rows and names.
    const reportAfter = await reportsRepository.getProductPerformance({ branchId: branch.a, page: 1, limit: 100 });
    expect(reportAfter).toEqual(reportBefore);
    expect(reportAfter.find((r) => r.product_variant_id === products.Sold?.variants.Regular)?.product_name).toBe(`PDEL Sold ${tag}`);

    // Completed-sale retry returns the original result.
    const replay = await sale([line('Sold', 'Regular', 2), line('Other')], key1);
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.data?.id).toBe(firstId);
    expect(await prisma.transaction.count({ where: { idempotencyKey: key1 } })).toBe(1);

    // Refund after the delete returns exactly what the sale deducted (3 per unit).
    const refund = await call('POST', `/api/transactions/${secondId}/refund`, tokens.supA, { refund_reason: 'Customer returned the order' });
    expect(refund.status).toBe(200);
    expect(refund.body.data?.status).toBe('refunded');
    await inventoryDeductionService.runCycle(10);
    expect(await stockA()).toBe(stockBefore + 3);

    // The branch copy keeps working on its own.
    const copy = await prisma.product.findUniqueOrThrow({ where: { id: products.Copy?.id as string } });
    expect(copy.forkedFromProductId).toBeNull();
    expect((await sale([line('Copy')])).status).toBe(201);
  });

  it('refuses new sales of the deleted product: live checkout and offline sync keep the sale for reconciliation', async () => {
    const live = await sale([line('Sold')]);
    expect(live.status).toBe(409);
    expect(live.body.error?.code).toBe('PRODUCT_DELETED');

    const offline = await call('POST', '/api/transactions/sync-offline', tokens.ana, {
      branch_id: branch.a,
      transactions: [
        { offline_provisional_number: `PC-PDEL-${tag}-OFFLINE-1`, items: [line('Sold')], payment_method: 'cash', cash_tendered: 100, tax_basis: BASIS, discount_flow: 'manual_v1', discount_choice: 'none_applicable', client_created_at: Date.now() },
      ],
    });
    expect(offline.status).toBe(200);
    const result = (offline.body.data?.results as { status: string; error?: { code: string } }[])[0];
    expect(result).toMatchObject({ status: 'failed', error: { code: 'PRODUCT_DELETED' } });
    expect(await prisma.transaction.count({ where: { offlineProvisionalNumber: `PC-PDEL-${tag}-OFFLINE-1` } })).toBe(0);

    // Catalog and lists no longer show it.
    const catalog = await call('GET', `/api/products/catalog?branch_id=${branch.a}`, tokens.ana);
    expect(JSON.stringify(catalog.body.data)).not.toContain(products.Sold?.id as string);
    const list = await call('GET', `/api/products?branch_id=${branch.a}&view=active&limit=100`, tokens.supA);
    expect(JSON.stringify(list.body.data)).not.toContain(products.Sold?.id as string);
  });

  it('enforces branch scope and confirmation server-side', async () => {
    const id = products.Shared?.id as string;
    const preview = await call('GET', `/api/products/${id}/deletion-preview`, tokens.supA);
    expect(preview.body.data).toMatchObject({ can_delete: false, blockers: [] });
    expect(preview.body.data?.forbidden_reason).toContain(`PDEL Branch B ${tag}`);

    const denied = await call('DELETE', `/api/products/${id}`, tokens.supA, CONFIRM);
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code).toBe('PRODUCT_DELETE_FORBIDDEN');
    expect(denied.body.error?.message).toContain(`PDEL Branch B ${tag}`);
    for (const token of [tokens.ana, tokens.admin]) {
      expect((await call('DELETE', `/api/products/${id}`, token, CONFIRM)).status).toBe(403);
    }
    expect((await call('DELETE', `/api/products/${id}`, tokens.supAB)).status).toBe(422);
    expect((await call('DELETE', `/api/products/${id}`, tokens.supAB, { confirm: 'yes' })).status).toBe(422);
    expect(await prisma.product.findUnique({ where: { id } })).not.toBeNull();

    // A supervisor of every branch involved may delete it.
    expect((await call('DELETE', `/api/products/${id}`, tokens.supAB, CONFIRM)).status).toBe(200);
  });

  it('also scopes by every live branch the product was sold at', async () => {
    const id = products.SoldAtB?.id as string;
    // Sold at B while it was set up there, then taken off B's setup entirely.
    await prisma.branchProductAvailability.create({ data: { branchId: branch.b, productId: id, isAvailable: true } });
    const atB = await call('POST', '/api/transactions', tokens.bea, { ...saleBody([line('SoldAtB')], randomUUID()), branch_id: branch.b });
    expect(atB.status).toBe(201);
    await prisma.branchProductAvailability.deleteMany({ where: { productId: id, branchId: branch.b } });

    const denied = await call('DELETE', `/api/products/${id}`, tokens.supA, CONFIRM);
    expect(denied.status).toBe(403);
    expect(denied.body.error?.message).toContain(`PDEL Branch B ${tag}`);
    expect(await prisma.product.findUnique({ where: { id } })).not.toBeNull();
    expect((await call('DELETE', `/api/products/${id}`, tokens.supAB, CONFIRM)).status).toBe(200);
  });

  it('explains each blocker precisely and changes nothing', async () => {
    const promo = products.Promo?.id as string;
    const promotion = await prisma.promotion.create({ data: { name: `PDEL Weekend ${tag}`, discountKind: 'fixed_amount', discountValue: 5, createdById: users.SupAB as string } });
    await prisma.promotionProduct.create({ data: { promotionId: promotion.id, productId: promo } });
    const blocked = await call('DELETE', `/api/products/${promo}`, tokens.supA, CONFIRM);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error?.code).toBe('PRODUCT_DELETE_BLOCKED');
    const blockers = (blocked.body.error?.details as { blockers: { code: string; names: string[]; next_action: string }[] }).blockers;
    expect(blockers).toEqual([expect.objectContaining({ code: 'PRODUCT_DELETE_IN_PROMOTION', names: [`PDEL Weekend ${tag}`] })]);
    expect(await prisma.product.findUnique({ where: { id: promo } })).not.toBeNull();

    // A held (unresolved) order.
    await sale([line('Held')]);
    const shift = await prisma.shift.findFirstOrThrow({ where: { branchId: branch.a, status: 'active' } });
    const hold = await call('POST', '/api/transactions/hold', tokens.ana, { branch_id: branch.a, shift_id: shift.id, items: [line('Held')] });
    expect(hold.status).toBe(201);
    const heldRes = await call('DELETE', `/api/products/${products.Held?.id}`, tokens.supA, CONFIRM);
    expect(heldRes.status).toBe(409);
    expect((heldRes.body.error?.details as { blockers: { code: string }[] }).blockers[0]?.code).toBe('PRODUCT_DELETE_HELD_ORDERS');
    // Released, the order no longer blocks; the held line itself is history and stays.
    expect((await call('POST', `/api/transactions/hold/${hold.body.data?.id}/release`, tokens.ana, {})).status).toBeLessThan(300);
    expect((await call('DELETE', `/api/products/${products.Held?.id}`, tokens.supA, CONFIRM)).status).toBe(200);
    expect(await prisma.holdOrderItem.count({ where: { productId: products.Held?.id as string } })).toBe(1);

    // A completed sale recorded before deduction snapshots existed.
    const legacySale = await sale([line('Legacy')]);
    await prisma.$executeRaw`UPDATE "transaction_items" SET "deduction_snapshot" = NULL WHERE "transaction_id" = ${legacySale.body.data?.id as string}`;
    const legacy = await call('DELETE', `/api/products/${products.Legacy?.id}`, tokens.supA, CONFIRM);
    expect(legacy.status).toBe(409);
    expect((legacy.body.error?.details as { blockers: { code: string }[] }).blockers[0]?.code).toBe('PRODUCT_DELETE_LEGACY_SALES');
  });

  it('a sold size still cannot be deleted on its own', async () => {
    const res = await call('DELETE', `/api/products/${products.Other?.id}/variants/${products.Other?.variants.Regular}`, tokens.supA);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('VARIANT_HAS_DEPENDENCIES');
  });

  it('history guard: any other delete of a product or size with history is refused like the old foreign key', async () => {
    const sold = products.Other as { id: string; variants: Record<string, string> };
    expect(await prisma.transactionItem.count({ where: { productId: sold.id } })).toBeGreaterThan(0);
    // The pre-release API's plain delete cascade, run against the migrated database.
    const oldCascade = prisma.$transaction(async (tx) => {
      await tx.branchProductAvailability.deleteMany({ where: { productId: sold.id } });
      for (const variantId of Object.values(sold.variants)) {
        await tx.productVariantFlavor.deleteMany({ where: { productVariantId: variantId } });
        await tx.productComponent.deleteMany({ where: { productVariantId: variantId } });
        await tx.productVariant.delete({ where: { id: variantId } });
      }
      await tx.product.delete({ where: { id: sold.id } });
    });
    const error = await oldCascade.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as { code: string }).code).toBe('P2003');
    expect(await prisma.productVariant.count({ where: { productId: sold.id } })).toBe(1);
    expect(await prisma.branchProductAvailability.count({ where: { productId: sold.id } })).toBe(1);

    // The product row itself is guarded too (a line naming it, even with no size left to guard).
    const productOnly = await prisma.$executeRaw`DELETE FROM "products" WHERE "id" = ${sold.id}`.then(() => null, (e: unknown) => e);
    expect(String(productOnly)).toContain('transaction_items_product_id_fkey');

    // A size with only a change log is still protected, as before.
    const logged = await prisma.productVariant.create({ data: { productId: sold.id, name: 'Logged', sizeLabel: 'Logged', basePrice: 50, isActive: false } });
    await prisma.productChangeLog.create({ data: { productVariantId: logged.id, version: 1, changedById: users.SupAB as string, reason: 'pdel guard test', snapshotJson: {} } });
    const sizeDelete = await call('DELETE', `/api/products/${sold.id}/variants/${logged.id}`, tokens.supA);
    expect(sizeDelete.status).toBe(409);
    expect(sizeDelete.body.error?.code).toBe('VARIANT_HAS_DEPENDENCIES');
    const rawSizeDelete = await prisma.productVariant.delete({ where: { id: logged.id } }).then(() => null, (e: unknown) => e);
    expect((rawSizeDelete as { code?: string }).code).toBe('P2003');

    // Nothing with history: the guard does not get in the way.
    const fresh = await prisma.product.create({ data: { name: `PDEL Fresh ${tag}`, status: 'draft' } });
    await prisma.productVariant.create({ data: { productId: fresh.id, name: 'R', sizeLabel: 'R', basePrice: 1 } });
    await prisma.$transaction([prisma.productVariant.deleteMany({ where: { productId: fresh.id } }), prisma.product.delete({ where: { id: fresh.id } })]);
    expect(await prisma.product.findUnique({ where: { id: fresh.id } })).toBeNull();
  });

  it('a new line must name a size of its own product', async () => {
    const shift = await prisma.shift.findFirstOrThrow({ where: { branchId: branch.a, status: 'active' } });
    const mismatch = await prisma.holdOrder
      .create({
        data: {
          branchId: branch.a,
          shiftId: shift.id,
          cashierId: users.Ana as string,
          expiresAt: new Date(Date.now() + 900_000),
          items: { create: [{ productId: products.Other?.id as string, productVariantId: products.Promo?.variants.Regular as string, productNameSnapshot: 'x', variantNameSnapshot: 'Regular', unitPriceSnapshot: 50, quantity: 1 }] },
        },
      })
      .then(() => null, (e: unknown) => e);
    expect(String(mismatch)).toContain('PRODUCT_VARIANT_MISMATCH');
  });

  it('rollout switch off: preview says so and the delete is refused, nothing changes', async () => {
    const mutable = config as { productPermanentDeleteEnabled: boolean };
    mutable.productPermanentDeleteEnabled = false;
    try {
      const id = products.Other?.id as string;
      const preview = await call('GET', `/api/products/${id}/deletion-preview`, tokens.supA);
      expect(preview.status).toBe(200);
      expect(preview.body.data).toMatchObject({ can_delete: false, blockers: [] });
      expect(String(preview.body.data?.forbidden_reason)).toContain('not switched on');
      const res = await call('DELETE', `/api/products/${id}`, tokens.supA, CONFIRM);
      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe('PRODUCT_PERMANENT_DELETE_DISABLED');
      expect(await prisma.product.findUnique({ where: { id } })).not.toBeNull();
    } finally {
      mutable.productPermanentDeleteEnabled = true;
    }
  });

  it('race: a checkout waiting on an in-progress delete is refused, charges nothing, and its retry is refused the same way', async () => {
    const target = products.RaceSale as { id: string; variants: Record<string, string> };
    let locked!: () => void;
    let release!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const deletion = prisma.$transaction(
      async (tx) => {
        await productDeletionRepository.lockForDelete(tx, target.id);
        locked();
        await gate;
        await productDeletionRepository.deleteProductAndOwnSetup(tx, target.id, Object.values(target.variants));
      },
      { timeout: 30_000 },
    );
    await isLocked;
    const key = randomUUID();
    const checkout = sale([line('RaceSale')], key);
    await waitForLockWait();
    release();
    await deletion;
    const res = await checkout;
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('PRODUCT_DELETED');
    expect(await prisma.transaction.count({ where: { idempotencyKey: key } })).toBe(0);

    const retry = await sale([line('RaceSale')], key);
    expect(retry.status).toBe(409);
    expect(retry.body.error?.code).toBe('PRODUCT_DELETED');
    expect(await prisma.transaction.count({ where: { idempotencyKey: key } })).toBe(0);
  });

  it('race: a delete waiting on an uncommitted held order sees it and is blocked', async () => {
    const target = products.RaceHold as { id: string; variants: Record<string, string> };
    const shift = await prisma.shift.findFirstOrThrow({ where: { branchId: branch.a, status: 'active' } });
    let inserted!: () => void;
    let release!: () => void;
    const isInserted = new Promise<void>((resolve) => (inserted = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const holdTx = prisma.$transaction(
      async (tx) => {
        await tx.holdOrder.create({
          data: {
            branchId: branch.a,
            shiftId: shift.id,
            cashierId: users.Ana as string,
            expiresAt: new Date(Date.now() + 900_000),
            items: {
              create: [
                { productId: target.id, productVariantId: target.variants.Regular as string, productNameSnapshot: 'x', variantNameSnapshot: 'Regular', unitPriceSnapshot: 50, quantity: 1 },
              ],
            },
          },
        });
        inserted();
        await gate;
      },
      { timeout: 30_000 },
    );
    await isInserted;
    const deletion = call('DELETE', `/api/products/${target.id}`, tokens.supA, CONFIRM);
    await waitForLockWait();
    release();
    await holdTx;
    const res = await deletion;
    expect(res.status).toBe(409);
    expect((res.body.error?.details as { blockers: { code: string }[] }).blockers[0]?.code).toBe('PRODUCT_DELETE_HELD_ORDERS');
    expect(await prisma.product.findUnique({ where: { id: target.id } })).not.toBeNull();
  });
});
