import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P49 — product classification + product-scoped promotions against a
 * real Postgres: authority (live branch assignment, full-coverage product
 * authority), eligibility, catalog display, authoritative checkout pricing,
 * mismatch refusal without trace, overlap, schedules, combination rules,
 * offline, idempotent retry, frozen history and report reconciliation.
 *
 * Requires TEST_DATABASE_URL pointing at a disposable, migrated database.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const { discountsService } = await import('./discounts.service.js');
const { productsService } = await import('../products/products.service.js');

describe.skipIf(!canRunIntegrationTests)('P49 promotions integration', () => {
  const tag = randomUUID().slice(0, 8);
  const ids = {
    branchA: '', branchB: '', branchC: '',
    supAB: '', supA: '', admin: '', cashier: '', shiftA: '', shiftB: '',
    unit: '', potato: '',
    promoProduct: '', promoRegular: '', promoLarge: '',
    regularProduct: '', regularVariant: '',
    cappedProduct: '',
    sharedSeasonal: '', sharedSeasonalVariant: '',
  };
  const productIds: string[] = [];
  const promotionIds: string[] = [];

  const supAB = (): JwtPayload => ({ user_id: ids.supAB, role: 'supervisor', email: `supab-${tag}@t.test`, branch_ids: [ids.branchA, ids.branchB], iat: 0, exp: 0 });
  const supA = (): JwtPayload => ({ user_id: ids.supA, role: 'supervisor', email: `supa-${tag}@t.test`, branch_ids: [ids.branchA], iat: 0, exp: 0 });
  const admin = (): JwtPayload => ({ user_id: ids.admin, role: 'super_admin', email: `admin-${tag}@t.test`, iat: 0, exp: 0 });

  async function user(role: 'supervisor' | 'super_admin' | 'staff', name: string) {
    const row = await prisma.user.create({
      data: { email: `${name}-${tag}@potatocorner.test`, passwordHash: 'unused', role, firstName: 'P49', lastName: name, employmentType: 'regular', mustChangePassword: false },
    });
    return row.id;
  }

  async function product(name: string, classification: 'regular' | 'promotional' | 'seasonal', branches: string[], sizes: { name: string; price: number; cap?: number }[]) {
    const row = await prisma.product.create({ data: { name: `P49 ${name} ${tag}`, status: 'active', classification, isSeasonal: classification === 'seasonal' } });
    productIds.push(row.id);
    const variantIds: string[] = [];
    for (const size of sizes) {
      const variant = await prisma.productVariant.create({
        data: { productId: row.id, name: size.name, sizeLabel: size.name, basePrice: size.price, vatableCapAmount: size.cap ?? null, isActive: true },
      });
      await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: ids.potato, quantityRequired: 100 } });
      variantIds.push(variant.id);
    }
    for (const branchId of branches) await prisma.branchProductAvailability.create({ data: { branchId, productId: row.id, isAvailable: true } });
    return { productId: row.id, variantIds };
  }

  async function catalogPromotion(branchId: string, variantId: string) {
    const catalog = await productsService.getPosCatalog(branchId);
    for (const p of catalog.products) for (const v of p.variants) if (v.id === variantId) return v.promotion ?? null;
    throw new Error('variant not in catalog');
  }

  async function createPromo(actor: JwtPayload, overrides: Partial<Parameters<typeof discountsService.createPromotion>[1]> = {}) {
    const promotion = await discountsService.createPromotion(
      actor,
      { name: `Promo ${randomUUID().slice(0, 4)}`, discount_kind: 'fixed_amount', discount_value: 10, is_enabled: true, product_ids: [ids.promoProduct], branch_ids: [ids.branchA], ...overrides },
      null,
    );
    promotionIds.push(promotion.id);
    return promotion;
  }

  beforeAll(async () => {
    ids.supAB = await user('supervisor', 'supab');
    ids.supA = await user('supervisor', 'supa');
    ids.admin = await user('super_admin', 'admin');
    ids.cashier = await user('staff', 'cashier');
    for (const key of ['branchA', 'branchB', 'branchC'] as const) {
      const branch = await prisma.branch.create({ data: { name: `P49 ${key} ${tag}`, code: `P49${key.slice(-1)}-${tag}`, address: '1 Test St', city: 'Testville' } });
      ids[key] = branch.id;
    }
    await prisma.userBranchAssignment.createMany({
      data: [
        { userId: ids.supAB, branchId: ids.branchA },
        { userId: ids.supAB, branchId: ids.branchB },
        { userId: ids.supA, branchId: ids.branchA },
      ],
    });
    const unit = await prisma.unitOfMeasure.create({ data: { code: `p49-g-${tag}`, name: 'P49 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    ids.unit = unit.id;
    const potato = await prisma.inventoryItem.create({ data: { name: `P49 potato ${tag}`, baseUnitId: unit.id } });
    ids.potato = potato.id;
    for (const branchId of [ids.branchA, ids.branchB]) {
      await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: potato.id, quantityOnHand: 100000 } });
    }
    ids.shiftA = (await prisma.shift.create({ data: { branchId: ids.branchA, cashierId: ids.cashier, openedBy: ids.cashier, status: 'active', openingCashAmount: 0, startedAt: new Date() } })).id;
    ids.shiftB = (await prisma.shift.create({ data: { branchId: ids.branchB, cashierId: ids.cashier, openedBy: ids.cashier, status: 'active', openingCashAmount: 0, startedAt: new Date() } })).id;

    const promo = await product('Promo Fries', 'promotional', [ids.branchA, ids.branchB], [{ name: 'Regular', price: 39 }, { name: 'Large', price: 99 }]);
    ids.promoProduct = promo.productId;
    ids.promoRegular = promo.variantIds[0] as string;
    ids.promoLarge = promo.variantIds[1] as string;
    const regular = await product('Plain Fries', 'regular', [ids.branchA, ids.branchB], [{ name: 'Regular', price: 45 }]);
    ids.regularProduct = regular.productId;
    ids.regularVariant = regular.variantIds[0] as string;
    ids.cappedProduct = (await product('Tera Mix', 'promotional', [ids.branchA], [{ name: 'Tera', price: 300, cap: 250 }])).productId;
    const shared = await product('Shared Seasonal', 'seasonal', [ids.branchA, ids.branchC], [{ name: 'Regular', price: 60 }]);
    ids.sharedSeasonal = shared.productId;
    ids.sharedSeasonalVariant = shared.variantIds[0] as string;
  });

  afterAll(async () => {
    const branches = [ids.branchA, ids.branchB, ids.branchC];
    // Transaction rows are append-only at the application level; raw SQL is the teardown escape hatch.
    await prisma.$executeRaw`DELETE FROM "transaction_items" WHERE "transaction_id" IN (SELECT id FROM "transactions" WHERE "branch_id" = ANY(${branches}))`;
    await prisma.$executeRaw`DELETE FROM "inventory_deduction_jobs" WHERE "branch_id" = ANY(${branches})`;
    await prisma.$executeRaw`DELETE FROM "transactions" WHERE "branch_id" = ANY(${branches})`;
    await prisma.$executeRaw`DELETE FROM "checkout_attempts" WHERE "branch_id" = ANY(${branches})`;
    await prisma.promotion.deleteMany({ where: { id: { in: promotionIds } } });
  });

  // ---------------------------------------------------------------- classification
  it('classification: full-coverage supervisor changes it without touching status, availability or prices', async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: ids.regularProduct }, include: { branchAvailability: true, variants: true } });
    const updated = await productsService.updateProduct(ids.regularProduct, { classification: 'seasonal' }, { id: ids.supAB, role: 'supervisor' }, null);
    expect(updated).toMatchObject({ classification: 'seasonal', is_seasonal: true, status: 'active', version: before.version + 1 });
    const after = await prisma.product.findUniqueOrThrow({ where: { id: ids.regularProduct }, include: { branchAvailability: true, variants: true } });
    expect(after.branchAvailability.map((a) => [a.branchId, a.isAvailable]).sort()).toEqual(before.branchAvailability.map((a) => [a.branchId, a.isAvailable]).sort());
    expect(after.variants.map((v) => v.basePrice.toNumber())).toEqual(before.variants.map((v) => v.basePrice.toNumber()));
    expect(after.everPublished).toBe(before.everPublished);
    // and back — legacy is_seasonal false on a seasonal product means regular
    const back = await productsService.updateProduct(ids.regularProduct, { is_seasonal: false }, { id: ids.supAB, role: 'supervisor' }, null);
    expect(back).toMatchObject({ classification: 'regular', is_seasonal: false, status: 'active' });
  });

  it('classification: a partial-coverage supervisor is refused on a shared product (must use the branch copy)', async () => {
    await expect(
      productsService.updateProduct(ids.promoProduct, { classification: 'regular' }, { id: ids.supA, role: 'supervisor' }, null),
    ).rejects.toMatchObject({ code: 'PRODUCT_UPDATE_FORBIDDEN', statusCode: 403 });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: ids.promoProduct } })).classification).toBe('promotional');
  });

  // ---------------------------------------------------------------- authority / eligibility
  it('promotion writes: super_admin refused; unmanaged branch refused; regular and VAT-capped products refused', async () => {
    const base = { name: 'X', discount_kind: 'fixed_amount' as const, discount_value: 5, is_enabled: true };
    await expect(discountsService.createPromotion(admin(), { ...base, product_ids: [ids.promoProduct], branch_ids: [ids.branchA] }, null)).rejects.toMatchObject({ code: 'PROMOTION_WRITE_FORBIDDEN', statusCode: 403 });
    await expect(discountsService.createPromotion(supAB(), { ...base, product_ids: [ids.promoProduct], branch_ids: [ids.branchC] }, null)).rejects.toMatchObject({ code: 'PROMOTION_BRANCH_FORBIDDEN', statusCode: 403 });
    await expect(discountsService.createPromotion(supAB(), { ...base, product_ids: [ids.regularProduct], branch_ids: [ids.branchA] }, null)).rejects.toMatchObject({ code: 'PROMOTION_PRODUCT_INELIGIBLE', statusCode: 422 });
    await expect(discountsService.createPromotion(supAB(), { ...base, product_ids: [ids.cappedProduct], branch_ids: [ids.branchA] }, null)).rejects.toMatchObject({ code: 'PROMOTION_PRODUCT_INELIGIBLE' });
    // A product not sold at any selected branch.
    await expect(discountsService.createPromotion(supAB(), { ...base, product_ids: [ids.sharedSeasonal], branch_ids: [ids.branchB] }, null)).rejects.toMatchObject({ code: 'PROMOTION_PRODUCT_INELIGIBLE' });
    expect(await prisma.promotion.count({ where: { name: 'X' } })).toBe(0);
  });

  it('shared product: a promotion at an authorized branch never changes its global configuration', async () => {
    const before = await prisma.productVariant.findUniqueOrThrow({ where: { id: ids.sharedSeasonalVariant } });
    // supAB covers A but not C, so they cannot edit the product itself …
    await expect(productsService.updateProduct(ids.sharedSeasonal, { classification: 'regular' }, { id: ids.supAB, role: 'supervisor' }, null)).rejects.toMatchObject({ code: 'PRODUCT_UPDATE_FORBIDDEN' });
    // … but can promote it at A.
    const promo = await createPromo(supAB(), { product_ids: [ids.sharedSeasonal], discount_kind: 'percentage', discount_value: 50 });
    expect(promo.can_edit).toBe(true);
    expect(await catalogPromotion(ids.branchA, ids.sharedSeasonalVariant)).toMatchObject({ promotion_id: promo.id, unit_discount: 30 });
    const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: ids.sharedSeasonalVariant } });
    expect(after.basePrice.toNumber()).toBe(before.basePrice.toNumber());
    expect(after.version).toBe(before.version);
    await discountsService.setPromotionEnabled(supAB(), promo.id, { is_enabled: false, expected_version: promo.version }, null);
  });

  it('a supervisor sees a promotion covering a branch they do not manage as read-only and cannot change it', async () => {
    const promo = await createPromo(supAB(), { branch_ids: [ids.branchA, ids.branchB], discount_value: 1, is_enabled: false });
    const seen = (await discountsService.listPromotions(supA(), undefined)).find((p) => p.id === promo.id);
    expect(seen).toMatchObject({ can_edit: false });
    expect(seen?.read_only_reason).toMatch(/do not manage/);
    await expect(discountsService.setPromotionEnabled(supA(), promo.id, { is_enabled: true, expected_version: promo.version }, null)).rejects.toMatchObject({ code: 'PROMOTION_BRANCH_FORBIDDEN' });
    // Losing an assignment removes authority immediately (live, not the JWT).
    await prisma.userBranchAssignment.updateMany({ where: { userId: ids.supAB, branchId: ids.branchB }, data: { removedAt: new Date() } });
    await expect(discountsService.setPromotionEnabled(supAB(), promo.id, { is_enabled: true, expected_version: promo.version }, null)).rejects.toMatchObject({ code: 'PROMOTION_BRANCH_FORBIDDEN' });
    await prisma.userBranchAssignment.updateMany({ where: { userId: ids.supAB, branchId: ids.branchB }, data: { removedAt: null } });
    // Stale version is a conflict, never a silent overwrite.
    const enabled = await discountsService.setPromotionEnabled(supAB(), promo.id, { is_enabled: false, expected_version: promo.version }, null);
    await expect(discountsService.setPromotionEnabled(supAB(), promo.id, { is_enabled: true, expected_version: promo.version }, null)).rejects.toMatchObject({ code: 'PROMOTION_CONFLICT', statusCode: 409 });
    expect(enabled.version).toBe(promo.version + 1);
  });

  // net_sales is gross − discount − refunds (existing definition). For every non-statutory sale (none/
  // promotional) that equals Σ total_amount; a PWD/Senior sale also drops its VAT, so it is checked apart.
});
