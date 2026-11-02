import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P58 — custom product types against a real Postgres: duplicate names
 * decided by the database, branch scope and live authority, assignment rules,
 * filters and counts, deactivation, branch copies, the request shapes older
 * clients send, and that a type's name changes no price, discount, publication
 * or stock.
 *
 * Requires TEST_DATABASE_URL pointing at a disposable, migrated database.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const { config } = await import('../../config/index.js');
const { app } = await import('../../app.js');
const { productTypesService } = await import('./product-types.service.js');
const { productsService } = await import('../products/products.service.js');
const { discountsService } = await import('../discounts/discounts.service.js');
const { transactionsService } = await import('../transactions/transactions.service.js');

describe.skipIf(!canRunIntegrationTests)('P58 custom product types', () => {
  const tag = randomUUID().slice(0, 8);
  const ids = { branchA: '', branchB: '', branchC: '', supAB: '', supA: '', supC: '', supAC: '', admin: '', cashier: '', shift: '', potato: '' };
  const promotionIds: string[] = [];
  const actor = (id: string) => ({ id, role: 'supervisor' });
  const jwtFor = (id: string, branchIds: string[]): JwtPayload => ({ user_id: id, role: 'supervisor', email: `${id}@t.test`, branch_ids: branchIds, iat: 0, exp: 0 });
  const unique = (name: string) => `${name} ${randomUUID().slice(0, 6)}`;

  async function user(role: 'supervisor' | 'super_admin' | 'staff', name: string) {
    const row = await prisma.user.create({
      data: { email: `${name}-${tag}@potatocorner.test`, passwordHash: 'unused', role, firstName: 'P58', lastName: name, employmentType: 'regular', mustChangePassword: false },
    });
    return row.id;
  }

  async function createType(name: string, branchIds: string[], by = ids.supAB) {
    const type = await productTypesService.create({ name, branch_ids: branchIds }, actor(by), null);
    return { ...type, id: type.id as string };
  }

  function createProduct(overrides: Record<string, unknown>, by = ids.supAB) {
    return productsService.createProduct({ name: unique(`P58 Product ${tag}`), status: 'active', branch_exclusive: false, ...overrides } as never, actor(by), null);
  }

  /** A sellable product set up directly, for checkout and publication state. */
  async function sellable(name: string, classification: 'regular' | 'promotional' | 'seasonal', branches: string[], price = 100) {
    const row = await prisma.product.create({ data: { name: unique(`P58 ${name} ${tag}`), status: 'active', everPublished: true, classification, isSeasonal: classification === 'seasonal' } });
    const variant = await prisma.productVariant.create({ data: { productId: row.id, name: 'Regular', sizeLabel: 'Regular', basePrice: price, isActive: true } });
    await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: ids.potato, quantityRequired: 10 } });
    for (const branchId of branches) await prisma.branchProductAvailability.create({ data: { branchId, productId: row.id, isAvailable: true } });
    return { productId: row.id, variantId: variant.id };
  }

  async function code(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
      return 'NO_ERROR';
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
  }

  beforeAll(async () => {
    ids.supAB = await user('supervisor', 'supab');
    ids.supA = await user('supervisor', 'supa');
    ids.supC = await user('supervisor', 'supc');
    ids.supAC = await user('supervisor', 'supac');
    ids.admin = await user('super_admin', 'admin');
    ids.cashier = await user('staff', 'cashier');
    for (const key of ['branchA', 'branchB', 'branchC'] as const) {
      ids[key] = (await prisma.branch.create({ data: { name: `P58 ${key} ${tag}`, code: `P58${key.slice(-1)}-${tag}`, address: '1 Test St', city: 'Testville' } })).id;
    }
    await prisma.userBranchAssignment.createMany({
      data: [
        { userId: ids.supAB, branchId: ids.branchA },
        { userId: ids.supAB, branchId: ids.branchB },
        { userId: ids.supA, branchId: ids.branchA },
        { userId: ids.supC, branchId: ids.branchC },
        { userId: ids.supAC, branchId: ids.branchA },
        { userId: ids.supAC, branchId: ids.branchC },
      ],
    });
    const unit = await prisma.unitOfMeasure.create({ data: { code: `p58-g-${tag}`, name: 'P58 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    ids.potato = (await prisma.inventoryItem.create({ data: { name: `P58 potato ${tag}`, baseUnitId: unit.id } })).id;
    await prisma.inventoryStock.create({ data: { branchId: ids.branchA, inventoryItemId: ids.potato, quantityOnHand: 100000 } });
    ids.shift = (await prisma.shift.create({ data: { branchId: ids.branchA, cashierId: ids.cashier, openedBy: ids.cashier, status: 'active', openingCashAmount: 0, startedAt: new Date() } })).id;
  });

  afterAll(async () => {
    const branches = [ids.branchA, ids.branchB, ids.branchC];
    await prisma.$executeRaw`DELETE FROM "transaction_items" WHERE "transaction_id" IN (SELECT id FROM "transactions" WHERE "branch_id" = ANY(${branches}))`;
    await prisma.$executeRaw`DELETE FROM "inventory_deduction_jobs" WHERE "branch_id" = ANY(${branches})`;
    await prisma.$executeRaw`DELETE FROM "transactions" WHERE "branch_id" = ANY(${branches})`;
    await prisma.$executeRaw`DELETE FROM "checkout_attempts" WHERE "branch_id" = ANY(${branches})`;
    await prisma.promotion.deleteMany({ where: { id: { in: promotionIds } } });
  });

  // ---------------------------------------------------------------- names
  it('creates Marketing and One-time, listed after the built-ins with their scope', async () => {
    const marketing = await createType(`Marketing ${tag}`, [ids.branchA, ids.branchB]);
    const oneTime = await createType(`One-time ${tag}`, [ids.branchA]);
    const { types } = await productTypesService.list(jwtFor(ids.supAB, []), { include_inactive: true, branch_id: ids.branchA });
    expect(types.slice(0, 3).map((t) => t.key)).toEqual(['regular', 'promotional', 'seasonal']);
    expect(types.filter((t) => t.id === marketing.id || t.id === oneTime.id).map((t) => t.name).sort()).toEqual([`Marketing ${tag}`, `One-time ${tag}`].sort());
    expect(marketing).toMatchObject({ is_builtin: false, is_active: true, can_manage: true, product_count: 0 });
  });

  it('eight concurrent creates of one name, spelled differently: exactly one wins, the rest are refused cleanly', async () => {
    const base = `race ${tag}`;
    const spellings = [base, base.toUpperCase(), `  ${base}  `, base.replace(' ', '   '), base, base, base.toUpperCase(), base];
    // The Zod transform the router runs tidies display names; the database compares the normalized form.
    const results = await Promise.allSettled(
      spellings.map((name) => productTypesService.create({ name: name.trim().replace(/\s+/g, ' '), branch_ids: [ids.branchA, ids.branchB] }, actor(ids.supAB), null)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.every((r) => r.reason.code === 'PRODUCT_TYPE_NAME_TAKEN' && r.reason.statusCode === 409)).toBe(true);
    expect(await prisma.productType.count({ where: { normalizedName: base, isActive: true } })).toBe(1);
  });

  it('the database refuses an overlapping duplicate and a built-in name even without the service', async () => {
    const name = `direct ${tag}`;
    await createType(name, [ids.branchA]);
    await expect(
      prisma.$transaction(async (tx) => {
        const row = await tx.productType.create({ data: { name, normalizedName: name, createdById: ids.supAB } });
        await tx.productTypeBranch.create({ data: { productTypeId: row.id, branchId: ids.branchA, normalizedName: name, isActive: true } });
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.productType.create({ data: { name: 'Regular', normalizedName: 'regular', createdById: ids.supAB } })).rejects.toThrow();
  });

  it('a name is unique per branch: another branch may reuse it, an overlapping scope may not', async () => {
    const name = `Shared ${tag}`;
    await createType(name, [ids.branchA]);
    await expect(createType(name, [ids.branchC], ids.supC)).resolves.toMatchObject({ name });
    expect(await code(createType(name.toUpperCase(), [ids.branchA, ids.branchB]))).toBe('PRODUCT_TYPE_NAME_TAKEN');
    expect(await code(productTypesService.create({ name, branch_ids: [ids.branchC, ids.branchA] }, actor(ids.supAC), null))).toBe('PRODUCT_TYPE_NAME_TAKEN');
  });

  it('a rename or reactivation into a taken name is refused by the index, atomically', async () => {
    const taken = await createType(`Taken ${tag}`, [ids.branchA]);
    const other = await createType(`Other ${tag}`, [ids.branchA]);
    expect(await code(productTypesService.update(other.id, { name: `TAKEN ${tag}`, expected_version: other.version }, actor(ids.supAB), null))).toBe('PRODUCT_TYPE_NAME_TAKEN');
    expect((await prisma.productType.findUniqueOrThrow({ where: { id: other.id } })).name).toBe(`Other ${tag}`);

    await productTypesService.setActive(taken.id, false, taken.version, actor(ids.supAB), null);
    // The name is free while Taken is inactive, then Taken can't come back.
    const renamed = await productTypesService.update(other.id, { name: `Taken ${tag}`, expected_version: other.version }, actor(ids.supAB), null);
    expect(renamed.name).toBe(`Taken ${tag}`);
    expect(await code(productTypesService.setActive(taken.id, true, taken.version + 1, actor(ids.supAB), null))).toBe('PRODUCT_TYPE_NAME_TAKEN');
    expect((await prisma.productType.findUniqueOrThrow({ where: { id: taken.id } })).isActive).toBe(false);
  });

  it('a stale edit is a conflict, not an overwrite', async () => {
    const type = await createType(`Stale ${tag}`, [ids.branchA]);
    await productTypesService.update(type.id, { description: 'first', expected_version: type.version }, actor(ids.supAB), null);
    expect(await code(productTypesService.update(type.id, { description: 'second', expected_version: type.version }, actor(ids.supAB), null))).toBe('PRODUCT_TYPE_CONFLICT');
  });

  // ---------------------------------------------------------------- authority
  it('built-ins cannot be changed through the API', async () => {
    expect(await code(productTypesService.update('regular', { name: 'Everyday', expected_version: 1 }, actor(ids.supAB), null))).toBe('PRODUCT_TYPE_BUILT_IN');
    expect(await code(productTypesService.setActive('seasonal', false, 1, actor(ids.supAB), null))).toBe('PRODUCT_TYPE_BUILT_IN');
  });

  it('overlap lets a supervisor see and use a type; only full coverage lets them change it', async () => {
    const shared = await createType(`Scope ${tag}`, [ids.branchA, ids.branchB]);
    const seenByA = (await productTypesService.list(jwtFor(ids.supA, []), { include_inactive: true })).types.find((t) => t.id === shared.id);
    expect(seenByA?.can_manage).toBe(false);
    expect(await code(productTypesService.update(shared.id, { name: 'Hijack', expected_version: shared.version }, actor(ids.supA), null))).toBe('PRODUCT_TYPE_SCOPE_FORBIDDEN');
    expect(await code(productTypesService.setActive(shared.id, false, shared.version, actor(ids.supA), null))).toBe('PRODUCT_TYPE_SCOPE_FORBIDDEN');
  });

  it('another branch\'s type is invisible, and a shared product does not make it editable', async () => {
    const type = await createType(`Hidden ${tag}`, [ids.branchA], ids.supA);
    const supCTypes = (await productTypesService.list(jwtFor(ids.supC, []), { include_inactive: true })).types;
    expect(supCTypes.some((t) => t.id === type.id)).toBe(false);
    expect(await code(productTypesService.update(type.id, { name: 'Mine', expected_version: 1 }, actor(ids.supC), null))).toBe('PRODUCT_TYPE_NOT_FOUND');

    // A product shared across A and C doesn't reach through to the type.
    const widened = await createType(`Widened ${tag}`, [ids.branchA, ids.branchC], ids.supAC);
    const shared = await createProduct({ branch_ids: [ids.branchA, ids.branchC], product_type: widened.id }, ids.supAC);
    expect(shared.product_type).toMatchObject({ name: `Widened ${tag}` });
    expect(await code(productTypesService.update(widened.id, { name: 'Taken over', expected_version: 1 }, actor(ids.supA), null))).toBe('PRODUCT_TYPE_SCOPE_FORBIDDEN');
  });

  it('a revoked assignment stops working at once, whatever the JWT still says', async () => {
    const supD = await user('supervisor', `supd-${randomUUID().slice(0, 4)}`);
    await prisma.userBranchAssignment.create({ data: { userId: supD, branchId: ids.branchA } });
    const type = await createType(`Revoked ${tag}`, [ids.branchA], supD);
    await prisma.userBranchAssignment.updateMany({ where: { userId: supD }, data: { removedAt: new Date() } });

    expect(await code(productTypesService.update(type.id, { name: 'After', expected_version: 1 }, actor(supD), null))).toBe('PRODUCT_TYPE_NOT_FOUND');
    expect(await code(createType(`Revoked 2 ${tag}`, [ids.branchA], supD))).toBe('BRANCH_ACCESS_DENIED');
    expect(await code(createProduct({ branch_ids: [ids.branchA], product_type: type.id }, supD))).toBe('BRANCH_ACCESS_DENIED');
    const listed = (await productTypesService.list(jwtFor(supD, [ids.branchA]), { include_inactive: true })).types;
    expect(listed.some((t) => t.id === type.id)).toBe(false);
  });

  it('scope may widen to branches the supervisor holds, and never narrow', async () => {
    const type = await createType(`Widen ${tag}`, [ids.branchA]);
    expect(await code(productTypesService.update(type.id, { branch_ids: [ids.branchA, ids.branchC], expected_version: 1 }, actor(ids.supAB), null))).toBe('BRANCH_ACCESS_DENIED');
    const widened = await productTypesService.update(type.id, { branch_ids: [ids.branchA, ids.branchB], expected_version: 1 }, actor(ids.supAB), null);
    expect(widened.branches.map((b) => b.branch_id).sort()).toEqual([ids.branchA, ids.branchB].sort());
    expect(await code(productTypesService.update(type.id, { branch_ids: [ids.branchA], expected_version: widened.version }, actor(ids.supAB), null))).toBe('PRODUCT_TYPE_SCOPE_NARROWING');
  });

  it('routes: staff are refused; a supervisor token creates through validation; a built-in name is a 422', async () => {
    const sign = (payload: object) => jwt.sign(payload, config.jwt.privateKey, { algorithm: 'RS256', expiresIn: '5m' });
    const supervisor = sign({ user_id: ids.supAB, role: 'supervisor', email: `supab-${tag}@potatocorner.test`, branch_ids: [ids.branchA, ids.branchB] });
    const staff = sign({ user_id: ids.cashier, role: 'staff', email: `cashier-${tag}@potatocorner.test`, branch_ids: [ids.branchA] });
    const body = { name: `  Route   ${tag} `, branch_ids: [ids.branchA] };

    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const call = (method: string, path: string, token: string, json?: object) =>
      fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(json && { body: JSON.stringify(json) }),
      });
    try {
      expect((await call('GET', '/api/product-types', staff)).status).toBe(403);
      expect((await call('POST', '/api/product-types', staff, body)).status).toBe(403);
      expect((await call('POST', '/api/product-types', supervisor, { ...body, name: ' REGULAR ' })).status).toBe(422);
      const created = await call('POST', '/api/product-types', supervisor, body);
      expect(created.status).toBe(201);
      expect(((await created.json()) as { data: { name: string } }).data.name).toBe(`Route ${tag}`);
      expect((await call('PATCH', `/api/product-types/${randomUUID()}`, supervisor, { name: 'x', expected_version: 1 })).status).toBe(404);
      expect((await call('POST', '/api/product-types/regular/deactivate', supervisor, { expected_version: 1 })).status).toBe(409);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // ---------------------------------------------------------------- assignment
  it('a new product takes a type valid at every selected branch and nothing else', async () => {
    const onlyA = await createType(`Only A ${tag}`, [ids.branchA]);
    const both = await createType(`Both ${tag}`, [ids.branchA, ids.branchB]);
    const hidden = await createType(`Only C ${tag}`, [ids.branchC], ids.supC);

    const multi = await createProduct({ branch_ids: [ids.branchA, ids.branchB], product_type: both.id });
    expect(multi.product_type).toMatchObject({ id: both.id, name: `Both ${tag}`, is_builtin: false });
    expect(multi).toMatchObject({ classification: 'regular', is_seasonal: false });

    const before = await prisma.product.count();
    expect(await code(createProduct({ branch_ids: [ids.branchA, ids.branchB], product_type: onlyA.id }))).toBe('PRODUCT_TYPE_BRANCH_MISMATCH');
    expect(await code(createProduct({ branch_ids: [ids.branchA], product_type: hidden.id }))).toBe('PRODUCT_TYPE_NOT_FOUND');
    expect(await code(createProduct({ branch_ids: [ids.branchA], product_type: randomUUID() }))).toBe('PRODUCT_TYPE_NOT_FOUND');
    expect(await prisma.product.count()).toBe(before);
  });

  it('a product can\'t later be sold outside its type\'s scope, on any publish path', async () => {
    const type = await createType(`Fence ${tag}`, [ids.branchA]);
    const legacy = await sellable('Legacy shared', 'regular', [ids.branchA]);
    await productsService.updateProduct(legacy.productId, { product_type: type.id }, actor(ids.supA), null);

    const refused = 'PRODUCT_TYPE_BRANCH_MISMATCH';
    expect(await code(productsService.updateBranchProductAvailability(legacy.productId, ids.branchB, true, actor(ids.supAB), null))).toBe(refused);
    expect(await code(productsService.bulkUpdateBranchProductAvailability(legacy.productId, [{ branch_id: ids.branchB, is_available: true }], actor(ids.supAB), null))).toBe(refused);
    expect(await code(productsService.publishProductToBranches(legacy.productId, [ids.branchB], actor(ids.supAB), null))).toBe(refused);
    expect(await prisma.branchProductAvailability.count({ where: { productId: legacy.productId, branchId: ids.branchB } })).toBe(0);
  });

  it('assigning respects the optimistic version and the product\'s whole branch set', async () => {
    const onlyA = await createType(`Assign A ${tag}`, [ids.branchA]);
    const shared = await createProduct({ branch_ids: [ids.branchA, ids.branchB] });
    expect(await code(productsService.updateProduct(shared.id, { product_type: onlyA.id }, actor(ids.supAB), null))).toBe('PRODUCT_TYPE_BRANCH_MISMATCH');
    const both = await createType(`Assign AB ${tag}`, [ids.branchA, ids.branchB]);
    expect(await code(productsService.updateProduct(shared.id, { product_type: both.id, expected_version: shared.version + 5 }, actor(ids.supAB), null))).toBe('PRODUCT_CONFLICT');
    const saved = await productsService.updateProduct(shared.id, { product_type: both.id, expected_version: shared.version }, actor(ids.supAB), null);
    expect(saved).toMatchObject({ version: shared.version + 1, product_type: { id: both.id } });
  });

  // ---------------------------------------------------------------- old/new request compatibility
  it('old client shapes: resending the same classification keeps a custom type; a different one is an explicit choice', async () => {
    const type = await createType(`Compat ${tag}`, [ids.branchA]);
    const product = await createProduct({ branch_ids: [ids.branchA], product_type: type.id });

    // The P57 form always sends classification and season dates with its edit.
    const edited = await productsService.updateProduct(product.id, { name: unique('Edited by old form'), classification: 'regular', seasonal_start_date: null, seasonal_end_date: null, expected_version: product.version }, actor(ids.supAB), null);
    expect(edited.product_type).toMatchObject({ id: type.id });
    const legacyFlag = await productsService.updateProduct(product.id, { is_seasonal: false }, actor(ids.supAB), null);
    expect(legacyFlag.product_type).toMatchObject({ id: type.id });

    const moved = await productsService.updateProduct(product.id, { classification: 'promotional' }, actor(ids.supAB), null);
    expect(moved).toMatchObject({ classification: 'promotional', is_seasonal: false, product_type: { key: 'promotional', is_builtin: true } });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).productTypeId).toBeNull();
  });

  it('old client shapes: create with classification or is_seasonal, and old list filters, behave as before', async () => {
    const seasonal = await createProduct({ branch_ids: [ids.branchB], is_seasonal: true });
    expect(seasonal).toMatchObject({ classification: 'seasonal', is_seasonal: true, product_type: { key: 'seasonal', name: 'Seasonal' } });
    const promo = await createProduct({ branch_ids: [ids.branchB], classification: 'promotional' });
    expect(promo).toMatchObject({ classification: 'promotional', product_type: { key: 'promotional' } });
    const plain = await createProduct({ branch_ids: [ids.branchB] });
    expect(plain).toMatchObject({ classification: 'regular', product_type: { key: 'regular' } });

    // `classification` keeps its column meaning: it still finds a custom-typed product whose column matches.
    const type = await createType(`Old filter ${tag}`, [ids.branchB]);
    const custom = await createProduct({ branch_ids: [ids.branchB], product_type: type.id });
    const list = await productsService.getAllProducts(jwtFor(ids.supAB, []), { branch_id: ids.branchB, classification: 'regular', page: 1, limit: 100 });
    expect(list.products.map((p) => p.id)).toEqual(expect.arrayContaining([plain.id, custom.id]));
  });

  it('a row an older API wrote, with no product type, reads as its classification', async () => {
    const row = await prisma.product.create({ data: { name: unique(`Old API ${tag}`), status: 'active', classification: 'seasonal', isSeasonal: true } });
    const detail = await productsService.getProductById(row.id, jwtFor(ids.supAB, []));
    expect(detail.product_type).toEqual({ key: 'seasonal', id: null, name: 'Seasonal', is_builtin: true, is_active: true });
  });

  it('the schemas refuse a request that contradicts itself', async () => {
    const { updateProductSchema, createProductTypeSchema } = await import('@potato-corner/shared');
    const uuid = randomUUID();
    expect(updateProductSchema.safeParse({ product_type: uuid, classification: 'regular' }).success).toBe(false);
    expect(updateProductSchema.safeParse({ product_type: 'regular', classification: 'promotional' }).success).toBe(false);
    expect(updateProductSchema.safeParse({ product_type: 'seasonal', is_seasonal: false }).success).toBe(false);
    expect(updateProductSchema.safeParse({ product_type: 'regular', classification: 'regular' }).success).toBe(true);
    expect(updateProductSchema.safeParse({ product_type: 'marketing' }).success).toBe(false);
    expect(createProductTypeSchema.safeParse({ name: ' seasonal ', branch_ids: [uuid] }).success).toBe(false);
    expect(createProductTypeSchema.safeParse({ name: '   ', branch_ids: [uuid] }).success).toBe(false);
  });

  // ---------------------------------------------------------------- lists and counts
  describe('lists and counts at one branch', () => {
    const branchList = (extra: Record<string, unknown>) => productsService.getAllProducts(jwtFor(ids.supC, []), { branch_id: ids.branchC, page: 1, limit: 2, sort_by: 'name', sort_order: 'asc', ...extra } as never);
    let marketing = '';

    beforeAll(async () => {
      marketing = (await createType(`Counted ${tag}`, [ids.branchC], ids.supC)).id;
      const make = async (name: string, data: { classification?: 'promotional'; productTypeId?: string }, available: boolean) => {
        const row = await prisma.product.create({ data: { name: `${name} ${tag}`, status: 'active', everPublished: true, ...data } });
        await prisma.branchProductAvailability.create({ data: { branchId: ids.branchC, productId: row.id, isAvailable: available } });
      };
      await make('Alpha Marketing', { productTypeId: marketing }, true);
      await make('Beta Marketing', { productTypeId: marketing }, true);
      await make('Gamma Marketing', { productTypeId: marketing }, true);
      await make('Delta Marketing', { productTypeId: marketing }, false);
      await make('Alpha Regular', {}, true);
      await make('Alpha Promo', { classification: 'promotional' }, false);
      const draft = await prisma.product.create({ data: { name: `Draft Marketing ${tag}`, status: 'draft', productTypeId: marketing } });
      await prisma.branchProductAvailability.create({ data: { branchId: ids.branchC, productId: draft.id, isAvailable: false } });
    });

    it('a type view, its tab counts, its total and its pages all agree', async () => {
      const first = await branchList({ view: 'active', product_type: marketing });
      expect(first.counts).toEqual({ active: 3, drafts: 1, inactive: 1 });
      expect(first.total).toBe(3);
      expect(first.products).toHaveLength(2);
      const second = await branchList({ view: 'active', product_type: marketing, page: 2 });
      expect(second.products).toHaveLength(1);
      expect(new Set([...first.products, ...second.products].map((p) => p.id)).size).toBe(3);
      expect(first.products.every((p) => p.product_type?.id === marketing)).toBe(true);
    });

    it('a built-in view excludes custom types, and type counts follow the tab', async () => {
      const regular = await branchList({ view: 'active', product_type: 'regular' });
      expect(regular.counts).toEqual({ active: 1, drafts: 0, inactive: 0 });
      expect(regular.products.map((p) => p.product_type?.key)).toEqual(['regular']);
      expect(regular.type_counts).toEqual({ [marketing]: 3, regular: 1 });
      const inactive = await branchList({ view: 'inactive' });
      expect(inactive.type_counts).toEqual({ [marketing]: 1, promotional: 1 });
      expect(inactive.counts).toMatchObject({ active: 4, inactive: 2 });
      expect(inactive.total).toBe(2);
    });

    it('type combines with search, and every count narrows with it', async () => {
      const result = await branchList({ view: 'active', product_type: marketing, search: 'Alpha' });
      expect(result.total).toBe(1);
      expect(result.counts).toEqual({ active: 1, drafts: 0, inactive: 0 });
      expect(result.type_counts).toEqual({ [marketing]: 1, regular: 1 });
    });

    it('another branch\'s type id finds nothing here', async () => {
      const elsewhere = await createType(`Elsewhere ${tag}`, [ids.branchA]);
      const result = await branchList({ view: 'active', product_type: elsewhere.id });
      expect(result).toMatchObject({ total: 0, counts: { active: 0, drafts: 0, inactive: 0 } });
    });
  });

  // ---------------------------------------------------------------- rename and deactivate
  it('renaming changes current labels and nothing else, including a past sale', async () => {
    const type = await createType(`Rename ${tag}`, [ids.branchA]);
    const item = await sellable('Renamed', 'regular', [ids.branchA]);
    await productsService.updateProduct(item.productId, { product_type: type.id }, actor(ids.supA), null);
    const sale = await sellOne(item);
    const itemsBefore = await prisma.transactionItem.findMany({ where: { transactionId: sale.id } });
    const versionBefore = (await prisma.product.findUniqueOrThrow({ where: { id: item.productId } })).version;

    await productTypesService.update(type.id, { name: `Renamed ${tag}`, expected_version: type.version }, actor(ids.supAB), null);

    expect((await productsService.getProductById(item.productId, jwtFor(ids.supA, []))).product_type).toMatchObject({ name: `Renamed ${tag}` });
    expect(await prisma.transactionItem.findMany({ where: { transactionId: sale.id } })).toEqual(itemsBefore);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: item.productId } })).version).toBe(versionBefore);
  });

  it('deactivating stops new assignments and changes no product, availability, variant or stock', async () => {
    const type = await createType(`Retire ${tag}`, [ids.branchA]);
    const item = await sellable('Retired', 'regular', [ids.branchA]);
    await productsService.updateProduct(item.productId, { product_type: type.id }, actor(ids.supA), null);
    const snapshot = () => prisma.product.findUniqueOrThrow({ where: { id: item.productId }, include: { branchAvailability: true, variants: { include: { productComponents: true } } } });
    const stock = () => prisma.inventoryStock.findMany({ where: { inventoryItemId: ids.potato }, select: { quantityOnHand: true, quantityReserved: true } });
    const before = await snapshot();
    const stockBefore = await stock();

    const deactivated = await productTypesService.setActive(type.id, false, type.version, actor(ids.supAB), null);
    expect(deactivated).toMatchObject({ is_active: false, product_count: 1 });
    expect(await snapshot()).toEqual(before);
    expect(await stock()).toEqual(stockBefore);

    // Still found, labelled inactive, in All Types and in its own view.
    const all = await productsService.getAllProducts(jwtFor(ids.supA, []), { branch_id: ids.branchA, view: 'active', search: before.name, page: 1, limit: 25 });
    expect(all.products[0]?.product_type).toMatchObject({ id: type.id, is_active: false });
    const own = await productsService.getAllProducts(jwtFor(ids.supA, []), { branch_id: ids.branchA, view: 'active', product_type: type.id, page: 1, limit: 25 });
    expect(own.total).toBe(1);

    // Still on the POS catalog.
    const catalog = await productsService.getPosCatalog(ids.branchA);
    expect(catalog.products.some((p) => p.id === item.productId)).toBe(true);

    // No new assignment; unrelated edits, even resending the same type, still save.
    expect(await code(createProduct({ branch_ids: [ids.branchA], product_type: type.id }))).toBe('PRODUCT_TYPE_INACTIVE');
    const other = await createProduct({ branch_ids: [ids.branchA] });
    expect(await code(productsService.updateProduct(other.id, { product_type: type.id }, actor(ids.supAB), null))).toBe('PRODUCT_TYPE_INACTIVE');
    const edited = await productsService.updateProduct(item.productId, { description: 'unrelated edit' }, actor(ids.supA), null);
    expect(edited.product_type).toMatchObject({ id: type.id, is_active: false });
    const resent = await productsService.updateProduct(item.productId, { description: 'again', product_type: type.id }, actor(ids.supA), null);
    expect(resent.product_type).toMatchObject({ id: type.id });

    // A referenced type can't be hard-deleted, even directly.
    await expect(prisma.productType.delete({ where: { id: type.id } })).rejects.toThrow();

    const back = await productTypesService.setActive(type.id, true, deactivated.version, actor(ids.supAB), null);
    expect(back.is_active).toBe(true);
  });

  it('assignment racing deactivation: never an assignment after the type went inactive', async () => {
    for (let round = 0; round < 8; round += 1) {
      const type = await createType(`Racing ${round} ${tag}`, [ids.branchA]);
      const product = await createProduct({ branch_ids: [ids.branchA] }, ids.supA);
      const [assign, deactivate] = await Promise.allSettled([
        productsService.updateProduct(product.id, { product_type: type.id }, actor(ids.supA), null),
        productTypesService.setActive(type.id, false, type.version, actor(ids.supAB), null),
      ]);
      expect(deactivate.status).toBe('fulfilled');
      const row = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
      if (assign.status === 'fulfilled') expect(row.productTypeId).toBe(type.id);
      else {
        expect((assign.reason as { code: string }).code).toBe('PRODUCT_TYPE_INACTIVE');
        expect(row.productTypeId).toBeNull();
      }
    }
  });

  // ---------------------------------------------------------------- branch copies
  it('a branch copy keeps a type valid at its branch, or needs an explicit choice; the scope never widens', async () => {
    const both = await createType(`Copy both ${tag}`, [ids.branchA, ids.branchC], ids.supAC);
    const shared = await createProduct({ branch_ids: [ids.branchA, ids.branchC], product_type: both.id }, ids.supAC);
    const kept = await productsService.forkProductForBranch(shared.id, ids.branchA, actor(ids.supA), null);
    expect(kept.product_type).toMatchObject({ id: both.id });
    expect(kept.classification).toBe('regular');
    // A retry returns the same copy, with no choice needed.
    expect((await productsService.forkProductForBranch(shared.id, ids.branchA, actor(ids.supA), null)).id).toBe(kept.id);

    // The source's type went inactive: the copy at C needs a choice, and the type's scope didn't grow.
    await productTypesService.setActive(both.id, false, both.version, actor(ids.supAC), null);
    expect(await code(productsService.forkProductForBranch(shared.id, ids.branchC, actor(ids.supC), null))).toBe('PRODUCT_TYPE_SELECTION_REQUIRED');
    expect(await code(productsService.forkProductForBranch(shared.id, ids.branchC, actor(ids.supC), null, both.id))).toBe('PRODUCT_TYPE_INACTIVE');
    expect(await prisma.product.count({ where: { forkedFromProductId: shared.id, exclusiveBranchId: ids.branchC } })).toBe(0);

    const elsewhere = await createType(`Copy elsewhere ${tag}`, [ids.branchA]);
    expect(await code(productsService.forkProductForBranch(shared.id, ids.branchC, actor(ids.supC), null, elsewhere.id))).toBe('PRODUCT_TYPE_NOT_FOUND');

    const local = await createType(`Copy local ${tag}`, [ids.branchC], ids.supC);
    const chosen = await productsService.forkProductForBranch(shared.id, ids.branchC, actor(ids.supC), null, local.id);
    expect(chosen.product_type).toMatchObject({ id: local.id });
    const scope = await prisma.productTypeBranch.findMany({ where: { productTypeId: both.id } });
    expect(scope.map((row) => row.branchId).sort()).toEqual([ids.branchA, ids.branchC].sort());
  });

  it('a branch copy may be given a built-in explicitly', async () => {
    const both = await createType(`Copy builtin ${tag}`, [ids.branchA, ids.branchB]);
    const shared = await createProduct({ branch_ids: [ids.branchA, ids.branchB], product_type: both.id });
    const copy = await productsService.forkProductForBranch(shared.id, ids.branchB, actor(ids.supAB), null, 'seasonal');
    expect(copy).toMatchObject({ classification: 'seasonal', is_seasonal: true, product_type: { key: 'seasonal' } });
  });

  // ---------------------------------------------------------------- no automatic behavior
  async function sellOne(item: { productId: string; variantId: string }, promotionAck?: { promotionId: string; unitDiscount: number }) {
    return transactionsService.createTransaction(
      {
        branchId: ids.branchA,
        shiftId: ids.shift,
        cashierId: ids.cashier,
        items: [{ productId: item.productId, productVariantId: item.variantId, quantity: 1, ...(promotionAck ? { promotionAck } : {}) }],
        paymentMethod: 'cash',
        cashTendered: 5000,
        isOfflineTransaction: false,
        idempotencyKey: null,
      },
      null,
    );
  }

  it('types named Promotional-sounding things change no price, stock, tax or publication', async () => {
    const stock = async () => {
      const row = await prisma.inventoryStock.findFirstOrThrow({ where: { branchId: ids.branchA, inventoryItemId: ids.potato } });
      return row.quantityOnHand.toNumber() - row.quantityReserved.toNumber();
    };
    /** Same recipe, same effect: what a sale takes from stock now, and that it queued its one deduction job. */
    const sellAndMeasure = async (item: { productId: string; variantId: string }) => {
      const before = await stock();
      const sale = await sellOne(item);
      expect(await prisma.inventoryDeductionJob.count({ where: { transactionId: sale.id } })).toBe(1);
      return { sale, taken: before - (await stock()) };
    };

    const control = await sellable('Control', 'regular', [ids.branchA]);
    const { sale: controlSale, taken: controlTaken } = await sellAndMeasure(control);

    for (const name of [`Promo 50% off ${tag}`, `One-time ${randomUUID().slice(0, 4)}`, `Discount Marketing ${tag}`]) {
      const type = await createType(name, [ids.branchA]);
      const item = await sellable(`Typed ${name}`, 'regular', [ids.branchA]);
      const before = await prisma.product.findUniqueOrThrow({ where: { id: item.productId }, include: { branchAvailability: true } });
      const saved = await productsService.updateProduct(item.productId, { product_type: type.id }, actor(ids.supA), null);
      expect(saved).toMatchObject({ status: 'active', classification: 'regular', is_seasonal: false });
      const after = await prisma.product.findUniqueOrThrow({ where: { id: item.productId }, include: { branchAvailability: true } });
      expect(after.branchAvailability).toEqual(before.branchAvailability);
      expect(after.everPublished).toBe(before.everPublished);

      const catalog = await productsService.getPosCatalog(ids.branchA);
      const variant = catalog.products.find((p) => p.id === item.productId)?.variants[0];
      expect(variant?.promotion ?? null).toBeNull();

      const { sale, taken } = await sellAndMeasure(item);
      expect(taken).toBe(controlTaken);
      expect(sale.total_amount).toBe(controlSale.total_amount);
      expect(sale.vat_amount).toBe(controlSale.vat_amount);
      expect(sale.discount_amount).toBe(0);
      // Nothing single-use about a name like One-time: it sells again.
      await expect(sellOne(item)).resolves.toBeTruthy();
    }
  });

  it('promotion eligibility follows classification alone, not the type or its name', async () => {
    const jwtAB = jwtFor(ids.supAB, []);
    const marketing = await createType(`Eligibility ${tag}`, [ids.branchA]);
    const promotional = await createType(`Promotional Stuff ${tag}`, [ids.branchA]);

    // A new product with a custom type can't have a promotion, whatever it's called.
    const fresh = await sellable('Fresh', 'regular', [ids.branchA]);
    await productsService.updateProduct(fresh.productId, { product_type: promotional.id }, actor(ids.supA), null);
    await expect(
      discountsService.createPromotion(jwtAB, { name: unique('No'), discount_kind: 'fixed_amount', discount_value: 10, is_enabled: true, product_ids: [fresh.productId], branch_ids: [ids.branchA] }, null),
    ).rejects.toMatchObject({ statusCode: 422 });

    // A Promotional product moved to a custom type keeps its running promotion, at the same discount.
    const promo = await sellable('Promo kept', 'promotional', [ids.branchA]);
    const promotion = await discountsService.createPromotion(jwtAB, { name: unique('Kept'), discount_kind: 'fixed_amount', discount_value: 10, is_enabled: true, product_ids: [promo.productId], branch_ids: [ids.branchA] }, null);
    promotionIds.push(promotion.id);
    const discountOf = async () => (await productsService.getPosCatalog(ids.branchA)).products.find((p) => p.id === promo.productId)?.variants[0]?.promotion ?? null;
    const before = await discountOf();
    expect(before).not.toBeNull();
    const moved = await productsService.updateProduct(promo.productId, { product_type: marketing.id }, actor(ids.supA), null);
    expect(moved).toMatchObject({ classification: 'promotional', product_type: { id: marketing.id } });
    expect(await discountOf()).toEqual(before);

    // And renaming or deactivating its type doesn't stop it.
    await productTypesService.update(marketing.id, { name: `Clearance ${tag}`, expected_version: marketing.version }, actor(ids.supAB), null);
    await productTypesService.setActive(marketing.id, false, marketing.version + 1, actor(ids.supAB), null);
    expect(await discountOf()).toEqual(before);
  });
});
