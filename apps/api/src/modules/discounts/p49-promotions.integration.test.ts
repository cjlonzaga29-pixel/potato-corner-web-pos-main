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
const { transactionsService } = await import('../transactions/transactions.service.js');
const { receiptsService } = await import('../receipts/receipts.service.js');
const { reportsRepository } = await import('../reports/reports.repository.js');
const { manilaDateKey } = await import('../../lib/manila-time.js');

function shiftDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

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
  const today = manilaDateKey(new Date());

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

  function line(productId: string, variantId: string, quantity: number, promotion?: { promotionId: string; unitDiscount: number } | null) {
    return { productId, productVariantId: variantId, quantity, ...(promotion !== undefined ? { promotionAck: promotion } : {}) };
  }

  function sale(
    items: ReturnType<typeof line>[],
    opts: { branchId?: string; shiftId?: string; idempotencyKey?: string | null; discountType?: 'pwd'; offline?: boolean } = {},
  ) {
    return transactionsService.createTransaction(
      {
        branchId: opts.branchId ?? ids.branchA,
        shiftId: opts.shiftId ?? ids.shiftA,
        cashierId: ids.cashier,
        items,
        paymentMethod: 'cash',
        cashTendered: 5000,
        isOfflineTransaction: opts.offline ?? false,
        idempotencyKey: opts.idempotencyKey ?? null,
        ...(opts.discountType ? { discountType: opts.discountType, discountIdReference: `PWD-${randomUUID().slice(0, 6)}` } : {}),
        ...(opts.offline ? { offlineProvisionalNumber: `PC-P49-OFFLINE-${randomUUID().slice(0, 6)}`, deviceId: `dev-${tag}` } : {}),
      },
      null,
    );
  }

  async function trace() {
    const [transactions, jobs, stock] = await Promise.all([
      prisma.transaction.count({ where: { branchId: { in: [ids.branchA, ids.branchB] } } }),
      prisma.inventoryDeductionJob.count({ where: { branchId: { in: [ids.branchA, ids.branchB] } } }),
      prisma.inventoryStock.findMany({ where: { branchId: { in: [ids.branchA, ids.branchB] } }, orderBy: [{ branchId: 'asc' }] }),
    ]);
    return { transactions, jobs, stock: stock.map((s) => [s.branchId, s.quantityOnHand.toNumber(), s.quantityReserved.toNumber()]) };
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

  // ---------------------------------------------------------------- checkout
  let tenOff: Awaited<ReturnType<typeof createPromo>>;
  let promoSaleId = '';

  it('checkout applies a fixed per-unit discount from current configuration and persists the breakdown', async () => {
    tenOff = await createPromo(supAB(), { name: 'Ten Off', discount_kind: 'fixed_amount', discount_value: 10 });
    expect(await catalogPromotion(ids.branchA, ids.promoRegular)).toMatchObject({ promotion_id: tenOff.id, unit_discount: 10 });
    expect(await catalogPromotion(ids.branchB, ids.promoRegular)).toBeNull(); // branch-scoped
    expect(await catalogPromotion(ids.branchA, ids.regularVariant)).toBeNull(); // regular product never discounted

    const sold = await sale([line(ids.promoProduct, ids.promoRegular, 3, { promotionId: tenOff.id, unitDiscount: 10 })]);
    promoSaleId = sold.id;
    expect(sold).toMatchObject({ subtotal: 117, discount_amount: 30, discount_type: 'promotional', discount_rate_used: null, total_amount: 87, vat_amount: 9.32 });
    expect(sold.items?.[0]).toMatchObject({ unit_price: 39, line_total: 117, discount_amount: 30, promotion: { promotion_id: tenOff.id, name: 'Ten Off', unit_discount: 10 } });
    const row = await prisma.transactionItem.findFirstOrThrow({ where: { transactionId: sold.id } });
    expect(row.promotionId).toBe(tenOff.id);
    expect(row.promotionSnapshot).toMatchObject({ base_price: 39, unit_discount: 10, quantity: 3, version: tenOff.version, discount_kind: 'fixed_amount' });
  });

  it('inventory arithmetic is unchanged by the promotion (same deduction lines and reservation as a regular-priced sale)', async () => {
    const promoItem = await prisma.transactionItem.findFirstOrThrow({ where: { transactionId: promoSaleId } });
    const plain = await sale([line(ids.promoProduct, ids.promoRegular, 3)]); // legacy client: no promotion
    const plainItem = await prisma.transactionItem.findFirstOrThrow({ where: { transactionId: plain.id } });
    const strip = (snapshot: unknown) => (snapshot as { inventoryItemId: string; quantity: number }[]).map((l) => [l.inventoryItemId, l.quantity]);
    expect(strip(promoItem.deductionSnapshot)).toEqual(strip(plainItem.deductionSnapshot));
    expect(plain).toMatchObject({ subtotal: 117, discount_amount: 0, discount_type: null, total_amount: 117 });
    expect(await prisma.inventoryDeductionJob.count({ where: { transactionId: { in: [promoSaleId, plain.id] } } })).toBe(2);
  });

  it('refuses forged amounts, unshown promotions and unselected branches with PROMOTION_CHANGED, leaving no trace', async () => {
    const before = await trace();
    const key = randomUUID();
    await expect(sale([line(ids.promoProduct, ids.promoRegular, 1, { promotionId: tenOff.id, unitDiscount: 39 })], { idempotencyKey: key })).rejects.toMatchObject({ code: 'PROMOTION_CHANGED', statusCode: 409 });
    expect((await prisma.checkoutAttempt.findUnique({ where: { idempotencyKey: key } }))?.status).toBe('failed');
    await expect(sale([line(ids.promoProduct, ids.promoRegular, 1, null)])).rejects.toMatchObject({ code: 'PROMOTION_CHANGED' });
    await expect(sale([line(ids.promoProduct, ids.promoRegular, 1, { promotionId: tenOff.id, unitDiscount: 10 })], { branchId: ids.branchB, shiftId: ids.shiftB })).rejects.toMatchObject({ code: 'PROMOTION_CHANGED' });
    await expect(sale([line(ids.regularProduct, ids.regularVariant, 1, { promotionId: tenOff.id, unitDiscount: 10 })])).rejects.toMatchObject({ code: 'PROMOTION_CHANGED' });
    expect(await trace()).toEqual(before);
  });

  it('details name the changed line, what was shown and what is current', async () => {
    try {
      await sale([line(ids.promoProduct, ids.promoRegular, 1, null)]);
      throw new Error('expected refusal');
    } catch (error) {
      expect((error as { details?: unknown }).details).toMatchObject({
        lines: [{ line_index: 0, shown: null, current: { promotion_id: tenOff.id, unit_discount: 10 } }],
      });
    }
  });

  it('PWD/Senior keeps its statutory formula and is never combined with a promotion', async () => {
    await expect(sale([line(ids.promoProduct, ids.promoRegular, 1, { promotionId: tenOff.id, unitDiscount: 10 })], { discountType: 'pwd' })).rejects.toMatchObject({ code: 'PROMOTION_NOT_COMBINABLE', statusCode: 422 });
    const pwd = await sale([line(ids.promoProduct, ids.promoRegular, 1, null)], { discountType: 'pwd' });
    // 39 / 1.12 = 34.821…; 20% = 6.96; total = round2(34.82… - 6.96) = 27.86, VAT 0 — unchanged statutory path.
    expect(pwd).toMatchObject({ subtotal: 39, discount_type: 'pwd', discount_amount: 6.96, vat_amount: 0, total_amount: 27.86 });
    expect(pwd.items?.[0]).toMatchObject({ discount_amount: 0, promotion: null });
  });

  it('offline: a queued sale claiming a promotion is refused visibly; one without is charged the regular price', async () => {
    await expect(sale([line(ids.promoProduct, ids.promoRegular, 1, { promotionId: tenOff.id, unitDiscount: 10 })], { offline: true })).rejects.toMatchObject({ code: 'PROMOTION_OFFLINE_UNSUPPORTED', statusCode: 422 });
    const offline = await sale([line(ids.promoProduct, ids.promoRegular, 2, null)], { offline: true });
    expect(offline).toMatchObject({ subtotal: 78, discount_amount: 0, total_amount: 78, is_offline_transaction: true });
    // Through the sync endpoint's service path: the claim fails per item, the other item still syncs.
    const result = await transactionsService.syncOfflineTransactions(
      {
        branchId: ids.branchA,
        cashierId: ids.cashier,
        deviceId: `dev-sync-${tag}`,
        transactions: [
          { offlineProvisionalNumber: `PC-P49-OFF-${tag}-1`, shiftId: ids.shiftA, items: [line(ids.promoProduct, ids.promoRegular, 1, { promotionId: tenOff.id, unitDiscount: 10 })], paymentMethod: 'cash', cashTendered: 100, clientCreatedAt: 1 },
          { offlineProvisionalNumber: `PC-P49-OFF-${tag}-2`, shiftId: ids.shiftA, items: [line(ids.promoProduct, ids.promoRegular, 1)], paymentMethod: 'cash', cashTendered: 100, clientCreatedAt: 2 },
        ],
      },
      null,
    );
    const byNumber = Object.fromEntries((result as { results: { offline_provisional_number: string; status: string; error?: { code: string } }[] }).results.map((r) => [r.offline_provisional_number, r]));
    expect(byNumber[`PC-P49-OFF-${tag}-1`]).toMatchObject({ status: 'failed', error: { code: 'PROMOTION_OFFLINE_UNSUPPORTED' } });
    expect(byNumber[`PC-P49-OFF-${tag}-2`]).toMatchObject({ status: 'synced' });
  });

  it('overlap: each size gets exactly one promotion, the larger unit discount, deterministically', async () => {
    const twenty = await createPromo(supAB(), { name: 'Twenty Pct', discount_kind: 'percentage', discount_value: 20 });
    // Regular 39: 20% = 7.80 < ₱10 → Ten Off. Large 99: 20% = 19.80 > ₱10 → Twenty Pct.
    expect(await catalogPromotion(ids.branchA, ids.promoRegular)).toMatchObject({ promotion_id: tenOff.id, unit_discount: 10 });
    expect(await catalogPromotion(ids.branchA, ids.promoLarge)).toMatchObject({ promotion_id: twenty.id, unit_discount: 19.8 });
    const sold = await sale([
      line(ids.promoProduct, ids.promoRegular, 2, { promotionId: tenOff.id, unitDiscount: 10 }),
      line(ids.promoProduct, ids.promoLarge, 1, { promotionId: twenty.id, unitDiscount: 19.8 }),
    ]);
    // gross 78 + 99 = 177; discount 20 + 19.80 = 39.80; total 137.20; VAT = round2(137.20 × 12/112) = 14.70
    expect(sold).toMatchObject({ subtotal: 177, discount_amount: 39.8, total_amount: 137.2, vat_amount: 14.7 });
    await discountsService.setPromotionEnabled(supAB(), twenty.id, { is_enabled: false, expected_version: twenty.version }, null);
  });

  it('percentage rounding is per unit, then × quantity', async () => {
    const promo = await createPromo(supAB(), { name: 'Fifteen', discount_kind: 'percentage', discount_value: 15, product_ids: [ids.sharedSeasonal] });
    // 60 × 15% = 9.00 per unit
    expect(await catalogPromotion(ids.branchA, ids.sharedSeasonalVariant)).toMatchObject({ unit_discount: 9 });
    await discountsService.updatePromotion(supAB(), promo.id, { name: 'Fifteen', discount_kind: 'percentage', discount_value: 12.5, is_enabled: true, product_ids: [ids.sharedSeasonal], branch_ids: [ids.branchA], expected_version: promo.version }, null);
    // 60 × 12.5% = 7.50; × 3 = 22.50
    const sold = await sale([line(ids.sharedSeasonal, ids.sharedSeasonalVariant, 3, { promotionId: promo.id, unitDiscount: 7.5 })]);
    expect(sold).toMatchObject({ subtotal: 180, discount_amount: 22.5, total_amount: 157.5 });
    const latest = await prisma.promotion.findUniqueOrThrow({ where: { id: promo.id } });
    await discountsService.setPromotionEnabled(supAB(), promo.id, { is_enabled: false, expected_version: latest.version }, null);
  });

  it('schedules: future start and past end do not apply; today on either boundary does', async () => {
    const future = await createPromo(supAB(), { name: 'Future', discount_value: 30, starts_on: shiftDays(today, 1) });
    const past = await createPromo(supAB(), { name: 'Past', discount_value: 30, ends_on: shiftDays(today, -1) });
    expect(future.schedule_state).toBe('scheduled');
    expect(past.schedule_state).toBe('expired');
    expect(await catalogPromotion(ids.branchA, ids.promoRegular)).toMatchObject({ promotion_id: tenOff.id });
    const edge = await createPromo(supAB(), { name: 'Today Only', discount_value: 30, starts_on: today, ends_on: today });
    expect(edge.schedule_state).toBe('active');
    expect(await catalogPromotion(ids.branchA, ids.promoRegular)).toMatchObject({ promotion_id: edge.id, unit_discount: 30 });
    await discountsService.setPromotionEnabled(supAB(), edge.id, { is_enabled: false, expected_version: edge.version }, null);
  });

  it('a changed promotion never rewrites history, and checkout against the stale amount is refused', async () => {
    const updated = await discountsService.updatePromotion(
      supAB(),
      tenOff.id,
      { name: 'Ten Off (now 5)', discount_kind: 'fixed_amount', discount_value: 5, is_enabled: true, product_ids: [ids.promoProduct], branch_ids: [ids.branchA], expected_version: tenOff.version },
      null,
    );
    expect(updated.version).toBe(tenOff.version + 1);
    await expect(sale([line(ids.promoProduct, ids.promoRegular, 1, { promotionId: tenOff.id, unitDiscount: 10 })])).rejects.toMatchObject({ code: 'PROMOTION_CHANGED' });

    const history = await transactionsService.getTransactionById(promoSaleId).catch(() => null);
    const stored = await prisma.transaction.findUniqueOrThrow({ where: { id: promoSaleId }, include: { items: true } });
    expect(stored.discountAmount.toNumber()).toBe(30);
    expect(stored.totalAmount.toNumber()).toBe(87);
    expect(stored.items[0]?.promotionSnapshot).toMatchObject({ name: 'Ten Off', unit_discount: 10 });
    if (history) expect(history).toMatchObject({ discount_amount: 30, total_amount: 87 });

    const receipt = await receiptsService.getPublicReceipt(stored.transactionNumber);
    expect(receipt.items[0]).toMatchObject({ line_total: 117, discount_amount: 30, promotion_name: 'Ten Off' });
    expect(receipt.subtotal - receipt.discount_amount).toBe(receipt.total_amount);
    tenOff = updated;
  });

  it('retry with the same idempotency key replays the original sale even after the promotion is disabled', async () => {
    const key = randomUUID();
    const items = [line(ids.promoProduct, ids.promoRegular, 2, { promotionId: tenOff.id, unitDiscount: 5 })];
    const first = await sale(items, { idempotencyKey: key });
    expect(first).toMatchObject({ discount_amount: 10, total_amount: 68 });
    const disabled = await discountsService.setPromotionEnabled(supAB(), tenOff.id, { is_enabled: false, expected_version: tenOff.version }, null);
    const count = await prisma.transaction.count({ where: { idempotencyKey: key } });
    const replay = await sale(items, { idempotencyKey: key });
    expect(replay.id).toBe(first.id);
    expect(replay).toMatchObject({ discount_amount: 10, total_amount: 68 });
    expect(await prisma.transaction.count({ where: { idempotencyKey: key } })).toBe(count);
    // A fresh attempt with the now-disabled promotion is refused.
    await expect(sale(items)).rejects.toMatchObject({ code: 'PROMOTION_CHANGED' });
    expect(await catalogPromotion(ids.branchA, ids.promoRegular)).toBeNull();
    // Re-enabling revalidates eligibility (product still promotional → ok).
    tenOff = await discountsService.setPromotionEnabled(supAB(), tenOff.id, { is_enabled: true, expected_version: disabled.version }, null);
  });

  it('reclassifying the product to Regular stops the discount immediately, and re-enabling is then refused', async () => {
    expect(await catalogPromotion(ids.branchA, ids.promoRegular)).toMatchObject({ promotion_id: tenOff.id });
    await prisma.product.update({ where: { id: ids.promoProduct }, data: { classification: 'regular', isSeasonal: false } });
    expect(await catalogPromotion(ids.branchA, ids.promoRegular)).toBeNull();
    await expect(sale([line(ids.promoProduct, ids.promoRegular, 1, { promotionId: tenOff.id, unitDiscount: 5 })])).rejects.toMatchObject({ code: 'PROMOTION_CHANGED' });
    const disabled = await discountsService.setPromotionEnabled(supAB(), tenOff.id, { is_enabled: false, expected_version: tenOff.version }, null);
    await expect(discountsService.setPromotionEnabled(supAB(), tenOff.id, { is_enabled: true, expected_version: disabled.version }, null)).rejects.toMatchObject({ code: 'PROMOTION_PRODUCT_INELIGIBLE' });
    await prisma.product.update({ where: { id: ids.promoProduct }, data: { classification: 'promotional' } });
  });

  // net_sales is gross − discount − refunds (existing definition). For every non-statutory sale (none/
  // promotional) that equals Σ total_amount; a PWD/Senior sale also drops its VAT, so it is checked apart.
  it('daily sales report reconciles with stored sale totals', async () => {
    const rows = await reportsRepository.getDailySales({ branchId: ids.branchA, page: 1, limit: 100 });
    const sums = await prisma.transaction.aggregate({ where: { branchId: ids.branchA, status: 'completed' }, _sum: { subtotal: true, discountAmount: true, totalAmount: true } });
    const gross = rows.reduce((s, r) => s + r.gross_sales, 0);
    const discount = rows.reduce((s, r) => s + r.discount_total, 0);
    const net = rows.reduce((s, r) => s + r.net_sales, 0);
    expect(Math.round(gross * 100)).toBe(Math.round((sums._sum.subtotal?.toNumber() ?? 0) * 100));
    expect(Math.round(discount * 100)).toBe(Math.round((sums._sum.discountAmount?.toNumber() ?? 0) * 100));
    expect(Math.round(net * 100)).toBe(Math.round(((sums._sum.subtotal?.toNumber() ?? 0) - (sums._sum.discountAmount?.toNumber() ?? 0)) * 100));
    const nonStatutory = await prisma.transaction.findMany({
      where: { branchId: ids.branchA, status: 'completed', OR: [{ discountType: null }, { discountType: 'promotional' }] },
      include: { items: true },
    });
    for (const t of nonStatutory) {
      expect(Math.round((t.subtotal.toNumber() - t.discountAmount.toNumber()) * 100)).toBe(Math.round(t.totalAmount.toNumber() * 100));
      // Line breakdown sums to the transaction: Σ line_total = subtotal, Σ line discount = discount.
      expect(Math.round(t.items.reduce((s, i) => s + i.lineTotal.toNumber(), 0) * 100)).toBe(Math.round(t.subtotal.toNumber() * 100));
      expect(Math.round(t.items.reduce((s, i) => s + i.discountAmount.toNumber(), 0) * 100)).toBe(Math.round(t.discountAmount.toNumber() * 100));
    }
    expect(nonStatutory.some((t) => t.discountType === 'promotional')).toBe(true);
  });
});
