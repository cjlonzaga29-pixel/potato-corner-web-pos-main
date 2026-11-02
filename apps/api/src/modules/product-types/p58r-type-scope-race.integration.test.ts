import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P58R — a product with a custom type is never available at a branch
 * outside that type's scope, whichever write lands first. Each race is forced
 * rather than hoped for: one side pauses inside its transaction, the test
 * confirms from pg_locks that the other side is really queued on the product's
 * catalog lock, then lets the first finish.
 *
 * Requires TEST_DATABASE_URL pointing at a disposable, migrated database.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const { productCatalogLockId } = await import('../../lib/pg-lock.js');
const { productTypesService } = await import('./product-types.service.js');
const { productsService } = await import('../products/products.service.js');
const { productsRepository } = await import('../products/products.repository.js');
const { inventoryRepository } = await import('../inventory/inventory.repository.js');
const { discountsService } = await import('../discounts/discounts.service.js');
const { productInventoryRepository } = await import('../product-inventory/product-inventory.repository.js');

const MISMATCH = 'PRODUCT_TYPE_BRANCH_MISMATCH';

type Settled = { status: 'fulfilled' | 'rejected'; code?: string; statusCode?: number };

describe.skipIf(!canRunIntegrationTests)('P58R type-scope race', () => {
  const tag = randomUUID().slice(0, 8);
  const ids = { branchA: '', branchB: '', sup: '', item: '' };
  const actor = () => ({ id: ids.sup, role: 'supervisor' });
  const unique = (name: string) => `P58R ${name} ${randomUUID().slice(0, 6)}`;

  /** A legacy shared product sellable at A, with no row at B: enabling B creates the row. */
  async function legacyShared(status: 'active' | 'archived' = 'active') {
    const product = await prisma.product.create({ data: { name: unique(`Shared ${tag}`), status, everPublished: true } });
    const variant = await prisma.productVariant.create({ data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 100, isActive: true } });
    await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: ids.item, quantityRequired: 1 } });
    await prisma.branchProductAvailability.create({ data: { branchId: ids.branchA, productId: product.id, isAvailable: true } });
    return product;
  }

  async function typeAtA(name = 'Scope') {
    const type = await productTypesService.create({ name: unique(`${name} ${tag}`), branch_ids: [ids.branchA] }, actor(), null);
    return type.id as string;
  }

  /** Stops a repository call just before it runs, until released. The caller's transaction and lock stay open meanwhile. */
  function pauseBefore<K extends keyof typeof productsRepository>(method: K) {
    let arrived!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const original = productsRepository[method] as (...args: unknown[]) => unknown;
    const spy = vi.spyOn(productsRepository, method as never).mockImplementationOnce(((...args: unknown[]) => {
      arrived();
      return released.then(() => original.apply(productsRepository, args));
    }) as never);
    return { reached, release, spy };
  }

  function settle(promise: Promise<unknown>): Promise<Settled> {
    return promise.then(
      () => ({ status: 'fulfilled' as const }),
      (error: { code?: string; statusCode?: number }) => ({ status: 'rejected' as const, code: error.code, statusCode: error.statusCode }),
    );
  }

  /** True once another backend is really queued on this product's lock; false if `other` finished without ever queuing. */
  async function queuedOnCatalogLock(productId: string, other: Promise<unknown>): Promise<boolean> {
    const lockId = productCatalogLockId(productId);
    let finished = false;
    void other.finally(() => (finished = true));
    for (let tries = 0; tries < 200; tries += 1) {
      const rows = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = ${lockId}`;
      if (Number(rows[0]?.waiting ?? 0) > 0) return true;
      if (finished) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  /** The invariant itself, from the database. */
  async function availableOutsideScope(productId: string): Promise<string[]> {
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
      select: { branchAvailability: { where: { isAvailable: true }, select: { branchId: true } }, productType: { select: { branches: { select: { branchId: true } } } } },
    });
    if (!product.productType) return [];
    const scope = new Set(product.productType.branches.map((row) => row.branchId));
    return product.branchAvailability.map((row) => row.branchId).filter((id) => !scope.has(id));
  }

  const rowAtB = (productId: string) => prisma.branchProductAvailability.findUnique({ where: { branchId_productId: { branchId: ids.branchB, productId } } });

  const enablePaths: [string, (productId: string) => Promise<unknown>][] = [
    ['per-branch toggle', (productId) => productsService.updateBranchProductAvailability(productId, ids.branchB, true, actor(), null)],
    ['bulk availability', (productId) => productsService.bulkUpdateBranchProductAvailability(productId, [{ branch_id: ids.branchB, is_available: true }], actor(), null)],
    ['branch status change', (productId) => productsService.changeProductStatus(productId, { status: 'active', branch_id: ids.branchB } as never, actor(), null)],
  ];

  beforeAll(async () => {
    ids.sup = (await prisma.user.create({ data: { email: `sup-${tag}@potatocorner.test`, passwordHash: 'unused', role: 'supervisor', firstName: 'P58R', lastName: 'Sup', employmentType: 'regular', mustChangePassword: false } })).id;
    for (const key of ['branchA', 'branchB'] as const) {
      ids[key] = (await prisma.branch.create({ data: { name: `P58R ${key} ${tag}`, code: `R${key.slice(-1)}-${tag}`, address: '1 Test St', city: 'Testville' } })).id;
    }
    await prisma.userBranchAssignment.createMany({ data: [{ userId: ids.sup, branchId: ids.branchA }, { userId: ids.sup, branchId: ids.branchB }] });
    const unit = await prisma.unitOfMeasure.create({ data: { code: `p58r-g-${tag}`, name: 'P58R Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    ids.item = (await prisma.inventoryItem.create({ data: { name: `P58R potato ${tag}`, baseUnitId: unit.id } })).id;
    for (const branchId of [ids.branchA, ids.branchB]) await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: ids.item, quantityOnHand: 1000 } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(enablePaths)('%s', (_name, enable) => {
    it('type assignment first: the enable waits, then is refused, and writes nothing', async () => {
      const product = await legacyShared();
      const typeId = await typeAtA();
      const pause = pauseBefore('update');

      const assign = settle(productsService.updateProduct(product.id, { product_type: typeId, expected_version: product.version }, actor(), null));
      await pause.reached;
      const enabling = settle(enable(product.id));
      const queued = await queuedOnCatalogLock(product.id, enabling);
      pause.release();

      expect(await assign).toEqual({ status: 'fulfilled' });
      expect(await enabling).toEqual({ status: 'rejected', code: MISMATCH, statusCode: 422 });
      expect(queued).toBe(true);
      expect(await rowAtB(product.id)).toBeNull();
      expect(await availableOutsideScope(product.id)).toEqual([]);
      const row = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(row).toMatchObject({ productTypeId: typeId, version: product.version + 1 });
    });

    it('availability enable first: the assignment waits, then is refused, and writes nothing', async () => {
      const product = await legacyShared();
      const typeId = await typeAtA();
      const pause = pauseBefore('upsertBranchProductAvailability');

      const enabling = settle(enable(product.id));
      await pause.reached;
      const assign = settle(productsService.updateProduct(product.id, { product_type: typeId, expected_version: product.version }, actor(), null));
      const queued = await queuedOnCatalogLock(product.id, assign);
      pause.release();

      expect(await enabling).toEqual({ status: 'fulfilled' });
      expect(await assign).toEqual({ status: 'rejected', code: MISMATCH, statusCode: 422 });
      expect(queued).toBe(true);
      expect((await rowAtB(product.id))?.isAvailable).toBe(true);
      const row = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(row).toMatchObject({ productTypeId: null, version: product.version });
    });
  });

  it('bulk: one out-of-scope branch refuses the batch, and the in-scope change in it is not kept', async () => {
    const product = await legacyShared();
    await productsService.updateProduct(product.id, { product_type: await typeAtA() }, actor(), null);
    await prisma.branchProductAvailability.update({ where: { branchId_productId: { branchId: ids.branchA, productId: product.id } }, data: { isAvailable: false } });

    const refused = await settle(
      productsService.bulkUpdateBranchProductAvailability(product.id, [{ branch_id: ids.branchA, is_available: true }, { branch_id: ids.branchB, is_available: true }], actor(), null),
    );
    expect(refused).toEqual({ status: 'rejected', code: MISMATCH, statusCode: 422 });
    expect(await rowAtB(product.id)).toBeNull();
    expect((await prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: ids.branchA, productId: product.id } } })).isAvailable).toBe(false);
  });

  it('publish holds the same lock: assignment first refuses the publish, publish first refuses the assignment', async () => {
    const first = await legacyShared();
    const firstType = await typeAtA();
    const assignPause = pauseBefore('update');
    const assign = settle(productsService.updateProduct(first.id, { product_type: firstType }, actor(), null));
    await assignPause.reached;
    const publish = settle(productsService.publishProductToBranches(first.id, [ids.branchB], actor(), null));
    expect(await queuedOnCatalogLock(first.id, publish)).toBe(true);
    assignPause.release();
    expect(await assign).toEqual({ status: 'fulfilled' });
    expect(await publish).toEqual({ status: 'rejected', code: MISMATCH, statusCode: 422 });
    expect(await rowAtB(first.id)).toBeNull();

    const second = await legacyShared();
    const secondType = await typeAtA();
    const publishPause = pauseBefore('publishBranchProductAvailability');
    const publishing = settle(productsService.publishProductToBranches(second.id, [ids.branchB], actor(), null));
    await publishPause.reached;
    const assigning = settle(productsService.updateProduct(second.id, { product_type: secondType }, actor(), null));
    expect(await queuedOnCatalogLock(second.id, assigning)).toBe(true);
    publishPause.release();
    expect(await publishing).toEqual({ status: 'fulfilled' });
    expect(await assigning).toEqual({ status: 'rejected', code: MISMATCH, statusCode: 422 });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: second.id } })).productTypeId).toBeNull();
  });

  it('turning a product off never waits for the lock, so an urgent disable is not held up by a publication', async () => {
    const product = await legacyShared();
    const typeId = await typeAtA();
    const pause = pauseBefore('update');
    const assign = settle(productsService.updateProduct(product.id, { product_type: typeId }, actor(), null));
    await pause.reached;

    await productsService.updateBranchProductAvailability(product.id, ids.branchA, false, actor(), null);

    pause.release();
    expect(await assign).toEqual({ status: 'fulfilled' });
    expect((await prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: ids.branchA, productId: product.id } } })).isAvailable).toBe(false);
  });

  it('restore turns on only branches in the type\'s scope, and leaves an out-of-scope row off', async () => {
    const product = await legacyShared();
    await productsService.updateProduct(product.id, { product_type: await typeAtA() }, actor(), null);
    // An unavailable row outside the scope: a disable, or a row older than the assignment.
    await productsService.updateBranchProductAvailability(product.id, ids.branchB, false, actor(), null);
    await productsService.changeProductStatus(product.id, { status: 'archived' } as never, actor(), null);

    await productsService.changeProductStatus(product.id, { status: 'active' } as never, actor(), null);

    expect((await rowAtB(product.id))?.isAvailable).toBe(false);
    expect(await availableOutsideScope(product.id)).toEqual([]);
    expect((await prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: ids.branchA, productId: product.id } } })).isAvailable).toBe(true);
  });

  it('restore racing a type assignment reads the committed type under the lock', async () => {
    const product = await legacyShared();
    await productsService.updateBranchProductAvailability(product.id, ids.branchB, false, actor(), null);
    const wide = await productTypesService.create({ name: unique(`Wide ${tag}`), branch_ids: [ids.branchA, ids.branchB] }, actor(), null);
    const pause = pauseBefore('update');
    const assign = settle(productsService.updateProduct(product.id, { product_type: wide.id as string }, actor(), null));
    await pause.reached;
    await prisma.product.update({ where: { id: product.id }, data: { status: 'archived' } });
    const restoring = settle(productsService.changeProductStatus(product.id, { status: 'active' } as never, actor(), null));
    expect(await queuedOnCatalogLock(product.id, restoring)).toBe(true);
    pause.release();
    expect(await assign).toEqual({ status: 'fulfilled' });
    expect(await restoring).toEqual({ status: 'fulfilled' });
    expect(await availableOutsideScope(product.id)).toEqual([]);
  });

  it('a stock-driven flavor cascade does not add a branch row to a custom-typed product', async () => {
    const product = await legacyShared();
    await productsService.updateProduct(product.id, { product_type: await typeAtA() }, actor(), null);
    const untyped = await legacyShared();
    const flavor = await prisma.flavor.create({ data: { name: unique(`Flavor ${tag}`), ingredientName: unique(`Powder ${tag}`), ingredientUnit: 'g' } });
    for (const row of [product, untyped]) {
      const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId: row.id } });
      await prisma.productVariantFlavor.create({ data: { productVariantId: variant.id, flavorId: flavor.id } });
    }

    vi.spyOn(productInventoryRepository, 'findByIngredientId').mockResolvedValueOnce([{ flavorId: flavor.id, productVariantId: randomUUID() }] as never);
    const { affectedProducts } = await inventoryRepository.runOutOfStockCascade(ids.branchB, ids.item);

    expect(await rowAtB(product.id)).toBeNull();
    // A legacy shared product with no custom type keeps the historical row.
    expect((await rowAtB(untyped.id))?.isAvailable).toBe(false);
    expect(affectedProducts.map((row) => row.productId)).toEqual([untyped.id]);
  });

  it('a branch copy gets the type it was checked against, even if the source changes meanwhile', async () => {
    const source = await legacyShared();
    const pause = pauseBefore('forkProductCascade');
    const forking = productsService.forkProductForBranch(source.id, ids.branchA, actor(), null);
    await pause.reached;

    // After the fork's check saw no type: the source gets one, which is then deactivated.
    const typeId = await typeAtA('Moved');
    await productsService.updateProduct(source.id, { product_type: typeId }, actor(), null);
    const type = await prisma.productType.findUniqueOrThrow({ where: { id: typeId } });
    await productTypesService.setActive(typeId, false, type.version, actor(), null);
    pause.release();

    const copy = await forking;
    expect(copy.product_type?.id ?? null).toBeNull();
    expect(await prisma.product.findUniqueOrThrow({ where: { id: copy.id } })).toMatchObject({ productTypeId: null, classification: 'regular' });
  });

  it('a copy replacing its source stays inside its type\'s scope', async () => {
    const source = await legacyShared();
    await prisma.branchProductAvailability.create({ data: { branchId: ids.branchB, productId: source.id, isAvailable: true } });
    const typeId = await typeAtA('Replace');
    const copy = await productsService.forkProductForBranch(source.id, ids.branchA, actor(), null, typeId);
    await prisma.product.update({ where: { id: copy.id }, data: { status: 'active' } });

    await productsService.replaceSharedProductAtBranch(copy.id, ids.branchA, actor(), null);

    expect(await availableOutsideScope(copy.id)).toEqual([]);
    const rows = await prisma.branchProductAvailability.findMany({ where: { productId: copy.id, isAvailable: true } });
    expect(rows.map((row) => row.branchId)).toEqual([ids.branchA]);
  });

  it('the notice\'s claims hold: a custom type keeps a running promotion, built-in Regular stops it, and the promotion row is untouched', async () => {
    const product = await prisma.product.create({ data: { name: unique(`Promo ${tag}`), status: 'active', everPublished: true, classification: 'promotional' } });
    const variant = await prisma.productVariant.create({ data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 100, isActive: true } });
    await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: ids.item, quantityRequired: 1 } });
    await prisma.branchProductAvailability.create({ data: { branchId: ids.branchA, productId: product.id, isAvailable: true } });
    const jwt = { user_id: ids.sup, role: 'supervisor', email: 'p58r@t.test', branch_ids: [ids.branchA], iat: 0, exp: 0 } as JwtPayload;
    const promotion = await discountsService.createPromotion(jwt, { name: unique('Kept'), discount_kind: 'fixed_amount', discount_value: 10, is_enabled: true, product_ids: [product.id], branch_ids: [ids.branchA] } as never, null);
    const discount = async () => (await productsService.getPosCatalog(ids.branchA)).products.find((row) => row.id === product.id)?.variants[0]?.promotion ?? null;
    const before = await discount();
    expect(before).not.toBeNull();

    await productsService.updateProduct(product.id, { product_type: await typeAtA('Label') }, actor(), null);
    expect(await discount()).toEqual(before);

    await productsService.updateProduct(product.id, { product_type: 'regular', classification: 'regular' }, actor(), null);
    expect(await discount()).toBeNull();
    expect((await prisma.promotion.findUniqueOrThrow({ where: { id: promotion.id } })).isEnabled).toBe(true);
  });

  it('a mixed bulk keeps the lock\'s guarantee for its enabled branch and applies its disabled one', async () => {
    const product = await legacyShared();
    await prisma.branchProductAvailability.create({ data: { branchId: ids.branchB, productId: product.id, isAvailable: true } });
    await productsService.bulkUpdateBranchProductAvailability(product.id, [{ branch_id: ids.branchA, is_available: true }, { branch_id: ids.branchB, is_available: false }], actor(), null);
    const rows = await prisma.branchProductAvailability.findMany({ where: { productId: product.id } });
    expect(new Map(rows.map((row) => [row.branchId, row.isAvailable]))).toEqual(new Map([[ids.branchA, true], [ids.branchB, false]]));
  });
});
