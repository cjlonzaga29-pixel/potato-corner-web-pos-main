import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createProductSchema } from '@potato-corner/shared';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/node', async (importOriginal) => ({ ...(await importOriginal<typeof import('@sentry/node')>()), captureException: sentry.captureException }));

/**
 * POS-PERF-P38R3 — what happens after publication commits, against real
 * Postgres with controlled faults. The transaction commits before the
 * hash-chained audit entries are written and before the HTTP response is
 * sent, so a client can lose the response to a publication that succeeded.
 * Covers: slow audit writes after commit, transient and persistent audit
 * failures (including a lost reply to an audit INSERT that did land), a
 * retry after a lost response, and concurrent retries — none may duplicate
 * inventory links or audit entries, and no required entry may vanish
 * silently.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { productsService } = await import('./products.service.js');

type Actor = { id: string; role: string };

/** Fault injection on audit_logs inserts only. Inactive unless a test sets it. */
const faults = {
  auditDelayMs: 0,
  /** Fail this many audit INSERT attempts before the statement runs. */
  failBefore: 0,
  /** Run this many audit INSERTs, then throw as if the reply was lost. */
  failAfter: 0,
  failAlways: false,
};

describe.skipIf(!isLocalDatabase)('POS-PERF-P38R3 publication result and retry safety (real Postgres)', () => {
  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const branchIds: string[] = [];
  const itemIds: string[] = [];
  const unitIds: string[] = [];
  const flavorIds: string[] = [];
  let supervisor: Actor;
  let gramId: string;
  let pieceId: string;
  let potato: string;
  let cup: string;
  let flavorId: string;
  let branchA: string;
  let branchB: string;

  async function makeBranch(label: string) {
    const branch = await prisma.branch.create({
      data: { name: `P38R3 Branch ${label} ${suffix}`, code: `P38R3${label}-${suffix}`, address: 'Test', city: 'Test' },
    });
    branchIds.push(branch.id);
    await prisma.userBranchAssignment.create({ data: { userId: supervisor.id, branchId: branch.id } });
    return branch.id;
  }

  async function makeItem(label: string, baseUnitId: string) {
    const item = await prisma.inventoryItem.create({ data: { name: `P38R3 ${label} ${suffix}`, baseUnitId } });
    itemIds.push(item.id);
    return item.id;
  }

  async function createProduct(label: string, selection: string[]) {
    const created = await productsService.createProduct(
      createProductSchema.parse({ name: `P38R3 ${label} ${suffix}`, status: 'active', branch_ids: selection }),
      supervisor,
      null,
    );
    const variant = await prisma.productVariant.create({
      data: { productId: created.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 59, isActive: true, lifecycleStatus: 'ACTIVE' },
    });
    await prisma.productVariantFlavor.create({ data: { productVariantId: variant.id, flavorId, isAvailable: true } });
    await prisma.productComponent.createMany({
      data: [
        { productVariantId: variant.id, inventoryItemId: potato, quantityRequired: 150, recipeUnitId: gramId, flavorId: null },
        { productVariantId: variant.id, inventoryItemId: cup, quantityRequired: 1, recipeUnitId: pieceId, flavorId: null },
      ],
    });
    return created.id;
  }

  async function publishedAt(productId: string) {
    return (await prisma.branchProductAvailability.findMany({ where: { productId, isAvailable: true } })).map((r) => r.branchId).sort();
  }

  async function linkCount(branches: string[]) {
    return prisma.inventoryStock.count({ where: { branchId: { in: branches }, inventoryItemId: { in: itemIds } } });
  }

  /** Every audit entry this publication flow writes for one product, by kind. */
  async function audits(productId: string) {
    const rows = await prisma.auditLog.findMany({
      where: { actorId: supervisor.id, action: { in: ['INVENTORY_ITEM_BRANCH_ASSIGNED', 'PRODUCT_BRANCH_AVAILABILITY_CHANGED'] } },
      orderBy: { createdAt: 'asc' },
    });
    const mine = rows.filter((r) => {
      const after = r.afterState as { product_id?: string; productId?: string } | null;
      return after?.product_id === productId || after?.productId === productId;
    });
    return {
      assigned: mine
        .filter((r) => r.action === 'INVENTORY_ITEM_BRANCH_ASSIGNED')
        .flatMap((r) => (r.afterState as { assigned: string[] }).assigned.map((b) => `${b}:${r.entityId}`))
        .sort(),
      availability: mine
        .filter((r) => r.action === 'PRODUCT_BRANCH_AVAILABILITY_CHANGED')
        .map((r) => r.branchId)
        .sort(),
      hashes: mine.map((r) => r.currentHash),
    };
  }

  function expectedPairs(branches: string[]) {
    return branches.flatMap((b) => [potato, cup].map((i) => `${b}:${i}`)).sort();
  }

  beforeAll(async () => {
    prisma.$use(async (params, next) => {
      if (params.model !== 'AuditLog' || params.action !== 'create') return next(params);
      if (faults.auditDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, faults.auditDelayMs));
      if (faults.failAlways) throw new Error('simulated audit outage');
      if (faults.failBefore > 0) {
        faults.failBefore -= 1;
        throw new Error('simulated audit failure before insert');
      }
      const result: unknown = await next(params);
      if (faults.failAfter > 0) {
        faults.failAfter -= 1;
        throw new Error('simulated lost reply after audit insert');
      }
      return result;
    });

    const user = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'P38R3', lastName: 'Sup', employmentType: 'regular', email: `p38r3-sup-${suffix}@test.local` },
    });
    userIds.push(user.id);
    supervisor = { id: user.id, role: 'supervisor' };

    const gram = await prisma.unitOfMeasure.create({ data: { code: `p38r3-g-${suffix}`, name: 'P38R3 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    const piece = await prisma.unitOfMeasure.create({ data: { code: `p38r3-pc-${suffix}`, name: 'P38R3 Piece', dimension: 'COUNT', isBaseUnit: true } });
    gramId = gram.id;
    pieceId = piece.id;
    unitIds.push(gramId, pieceId);
    potato = await makeItem('Potato', gramId);
    cup = await makeItem('Cup', pieceId);
    const flavor = await prisma.flavor.create({ data: { name: `P38R3 Cheese ${suffix}`, ingredientName: 'Cheese Powder', ingredientUnit: 'g' } });
    flavorId = flavor.id;
    flavorIds.push(flavorId);
    branchA = await makeBranch('A');
    branchB = await makeBranch('B');
  });

  afterEach(() => {
    Object.assign(faults, { auditDelayMs: 0, failBefore: 0, failAfter: 0, failAlways: false });
    sentry.captureException.mockClear();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    const productIds = (await prisma.product.findMany({ where: { createdBy: { in: userIds } }, select: { id: true } })).map((p) => p.id);
    const variantIds = (await prisma.productVariant.findMany({ where: { productId: { in: productIds } }, select: { id: true } })).map((v) => v.id);
    await prisma.productComponent.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productVariantFlavor.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.branchProductAvailability.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productChangeLog.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.branchFlavorAvailability.deleteMany({ where: { flavorId: { in: flavorIds } } });
    await prisma.flavor.deleteMany({ where: { id: { in: flavorIds } } });
    await prisma.inventoryStock.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: { in: unitIds } } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
  });

  let productId = '';

  it('commits before slow audit writes finish: the publication is visible while the response is still pending', async () => {
    productId = await createProduct('Slow Audit', [branchA, branchB]);
    faults.auditDelayMs = 400;
    let settled = false;
    const pending = productsService.publishProductToBranches(productId, [branchA, branchB], supervisor, null).finally(() => {
      settled = true;
    });

    // Another connection sees the committed publication before the call returns.
    const deadline = Date.now() + 10_000;
    while ((await publishedAt(productId)).length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await publishedAt(productId)).toEqual([branchA, branchB].sort());
    expect(await linkCount([branchA, branchB])).toBe(4);
    expect(settled).toBe(false);

    const result = await pending;
    expect(result.setup.stock_links).toHaveLength(4);
    const written = await audits(productId);
    expect(written.assigned).toEqual(expectedPairs([branchA, branchB]));
    expect(written.availability).toEqual([branchA, branchB].sort());
  });

  it('a retry after a lost response writes nothing: no links, no assignment or availability entries, rows untouched', async () => {
    const before = await audits(productId);
    const rowsBefore = await prisma.branchProductAvailability.findMany({ where: { productId }, orderBy: { branchId: 'asc' } });

    const retry = await productsService.publishProductToBranches(productId, [branchA, branchB], supervisor, null);

    expect(retry.setup.stock_links).toEqual([]);
    expect(retry.branches.map((b) => [b.branch_id, b.is_available])).toEqual([
      [branchA, true],
      [branchB, true],
    ]);
    expect(await linkCount([branchA, branchB])).toBe(4);
    expect(await audits(productId)).toEqual(before);
    expect(await prisma.branchProductAvailability.findMany({ where: { productId }, orderBy: { branchId: 'asc' } })).toEqual(rowsBefore);
  });

  it('concurrent retries of an already-published operation all succeed and write nothing', async () => {
    const before = await audits(productId);
    const results = await Promise.all(
      [0, 1, 2].map(() => productsService.publishProductToBranches(productId, [branchA, branchB], supervisor, null)),
    );
    expect(results.every((r) => r.setup.stock_links.length === 0 && r.branches.every((b) => b.is_available))).toBe(true);
    expect(await audits(productId)).toEqual(before);
  });

  it('a retry racing the original first publication links and audits every branch exactly once', async () => {
    const racedProduct = await createProduct('Raced', [branchA, branchB]);
    const results = await Promise.all(
      [0, 1, 2].map(() => productsService.publishProductToBranches(racedProduct, [branchA, branchB], supervisor, null)),
    );
    expect(results.flatMap((r) => r.setup.stock_links)).toHaveLength(0); // links already exist from the first product
    expect(await publishedAt(racedProduct)).toEqual([branchA, branchB].sort());
    expect((await audits(racedProduct)).availability).toEqual([branchA, branchB].sort());
  });

  it('single-branch Publish: a retry at an already-published branch writes no availability entry', async () => {
    const single = await createProduct('Single', [branchA]);
    await productsService.publishProduct(single, branchA, supervisor, null);
    const before = await audits(single);
    expect(before.availability).toEqual([branchA]);

    const row = await productsService.publishProduct(single, branchA, supervisor, null);
    expect(row.is_available).toBe(true);
    expect(await audits(single)).toEqual(before);
  });

  it('a transient audit failure after commit is retried: every entry is written exactly once', async () => {
    const fresh = await makeBranch('T');
    const transient = await createProduct('Transient', [fresh]);
    faults.failBefore = 2;

    const result = await productsService.publishProductToBranches(transient, [fresh], supervisor, null);

    expect(result.setup.stock_links).toHaveLength(2);
    const written = await audits(transient);
    expect(written.assigned).toEqual(expectedPairs([fresh]));
    expect(written.availability).toEqual([fresh]);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('a lost reply to an audit INSERT that landed is not written twice', async () => {
    const fresh = await makeBranch('L');
    const lostReply = await createProduct('Lost Reply', [fresh]);
    faults.failAfter = 1;

    await productsService.publishProductToBranches(lostReply, [fresh], supervisor, null);

    const written = await audits(lostReply);
    expect(written.assigned).toEqual(expectedPairs([fresh]));
    expect(written.availability).toEqual([fresh]);
    expect(new Set(written.hashes).size).toBe(written.hashes.length);
  });

  it('a persistent audit outage after commit still reports the committed publication, and reports every missing entry loudly', async () => {
    const fresh = await makeBranch('O');
    const outage = await createProduct('Outage', [fresh]);
    faults.failAlways = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await productsService.publishProductToBranches(outage, [fresh], supervisor, null);

    expect(result.branches.map((b) => b.is_available)).toEqual([true]);
    expect(await publishedAt(outage)).toEqual([fresh]);
    expect(await audits(outage)).toEqual({ assigned: [], availability: [], hashes: [] });
    // 2 assignment entries + 1 availability entry: each one reported with its full content.
    expect(sentry.captureException).toHaveBeenCalledTimes(3);
    const reported = errors.mock.calls.filter((call) => call[0] === 'AUDIT_ENTRY_NOT_RECORDED');
    expect(reported.map((call) => (call[1] as { entry: { action: string } }).entry.action).sort()).toEqual([
      'INVENTORY_ITEM_BRANCH_ASSIGNED',
      'INVENTORY_ITEM_BRANCH_ASSIGNED',
      'PRODUCT_BRANCH_AVAILABILITY_CHANGED',
    ]);

    // Retrying once the outage is over changes nothing.
    faults.failAlways = false;
    const retry = await productsService.publishProductToBranches(outage, [fresh], supervisor, null);
    expect(retry.setup.stock_links).toEqual([]);
    expect(await linkCount([fresh])).toBe(2);
  });
});
