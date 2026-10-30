import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computeSaleTax, type JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P50 — VAT/discount calculation and settings against a real
 * Postgres: the stored amounts equal the shared calculation for ordinary,
 * PWD/Senior, Employee and promotional sales (quantities, add-on-like
 * centavo prices, VAT cap); a tax basis that no longer matches is refused
 * before anything is written (live and offline); forged amounts are ignored;
 * history, receipts, reports and refunds/voids never change after a settings
 * change; statutory rows are locked; concurrent settings saves cannot both win.
 *
 * Requires TEST_DATABASE_URL pointing at a disposable, migrated database.
 * Changes the global discount_policy row and restores it in afterAll.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const { transactionsService } = await import('./transactions.service.js');
const { settingsService } = await import('../settings/settings.service.js');
const { discountsService } = await import('../discounts/discounts.service.js');
const { receiptsService } = await import('../receipts/receipts.service.js');
const { reportsRepository } = await import('../reports/reports.repository.js');

const RATES20 = { pwd: 20, senior_citizen: 20, employee: 20 };

describe.skipIf(!canRunIntegrationTests)('P50 VAT settings and calculation integration', () => {
  const tag = randomUUID().slice(0, 8);
  const ids = { branch: '', admin: '', sup: '', cashier: '', shift: '', unit: '', potato: '', fries: '', friesVariant: '', tera: '', teraVariant: '', promo: '', promoVariant: '' };
  const productIds: string[] = [];
  const promotionIds: string[] = [];
  let originalPolicy: unknown = undefined;

  const admin = (): JwtPayload => ({ user_id: ids.admin, role: 'super_admin', email: `admin-${tag}@t.test`, iat: 0, exp: 0 });
  const sup = (): JwtPayload => ({ user_id: ids.sup, role: 'supervisor', email: `sup-${tag}@t.test`, branch_ids: [ids.branch], iat: 0, exp: 0 });

  async function user(role: 'supervisor' | 'super_admin' | 'staff', name: string) {
    const row = await prisma.user.create({
      data: { email: `${name}-${tag}@potatocorner.test`, passwordHash: 'unused', role, firstName: 'P50', lastName: name, employmentType: 'regular', mustChangePassword: false },
    });
    return row.id;
  }

  async function product(name: string, classification: 'regular' | 'promotional', price: number, cap: number | null) {
    const row = await prisma.product.create({ data: { name: `P50 ${name} ${tag}`, status: 'active', classification } });
    productIds.push(row.id);
    const variant = await prisma.productVariant.create({
      data: { productId: row.id, name: 'Regular', sizeLabel: 'Regular', basePrice: price, vatableCapAmount: cap, isActive: true },
    });
    await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: ids.potato, quantityRequired: 100 } });
    await prisma.branchProductAvailability.create({ data: { branchId: ids.branch, productId: row.id, isAvailable: true } });
    return { productId: row.id, variantId: variant.id };
  }

  type Line = { productId: string; productVariantId: string; quantity: number; promotionAck?: { promotionId: string; unitDiscount: number } | null };
  const fries = (quantity: number): Line => ({ productId: ids.fries, productVariantId: ids.friesVariant, quantity });
  const tera = (quantity: number): Line => ({ productId: ids.tera, productVariantId: ids.teraVariant, quantity });

  function sale(
    items: Line[],
    opts: { discountType?: 'pwd' | 'senior_citizen' | 'employee'; taxBasis?: { vatRate: number; discountRate: number | null }; discountAmount?: number; cash?: number } = {},
  ) {
    return transactionsService.createTransaction(
      {
        branchId: ids.branch,
        shiftId: ids.shift,
        cashierId: ids.cashier,
        items,
        paymentMethod: 'cash',
        cashTendered: opts.cash ?? 10000,
        isOfflineTransaction: false,
        idempotencyKey: randomUUID(),
        ...(opts.discountType ? { discountType: opts.discountType } : {}),
        ...(opts.discountType === 'pwd' || opts.discountType === 'senior_citizen' ? { discountIdReference: `ID-${randomUUID().slice(0, 6)}` } : {}),
        ...(opts.taxBasis ? { taxBasis: opts.taxBasis } : {}),
        ...(opts.discountAmount !== undefined ? { discountAmount: opts.discountAmount } : {}),
      },
      null,
    );
  }

  async function trace() {
    const [transactions, jobs, stock] = await Promise.all([
      prisma.transaction.count({ where: { branchId: ids.branch } }),
      prisma.inventoryDeductionJob.count({ where: { branchId: ids.branch } }),
      prisma.inventoryStock.findFirstOrThrow({ where: { branchId: ids.branch, inventoryItemId: ids.potato } }),
    ]);
    return { transactions, jobs, onHand: stock.quantityOnHand.toNumber(), reserved: stock.quantityReserved.toNumber() };
  }

  /** What a refused sale could change. Available (on hand − reserved) is stable even while another suite's job runner completes earlier deductions. */
  async function noTrace() {
    const t = await trace();
    return { transactions: t.transactions, jobs: t.jobs, available: t.onHand - t.reserved };
  }

  async function setEmployeeRate(percentage: number) {
    const current = await settingsService.getDiscountPolicy();
    await settingsService.updateDiscountPolicy({ employee: { percentage }, expectedUpdatedAt: current.updatedAt }, admin(), null);
  }

  function expected(lines: { price: number; quantity: number; cap: number | null; promo?: number }[], type: 'pwd' | 'senior_citizen' | 'employee' | null, rates = RATES20) {
    const taxLines = lines.map((l) => ({ lineTotal: Math.round(l.price * l.quantity * 100) / 100, quantity: l.quantity, vatableCapAmount: l.cap, promotionDiscount: l.promo }));
    const subtotal = Math.round(taxLines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100;
    return { subtotal, ...computeSaleTax(subtotal, taxLines, type, rates) };
  }

  beforeAll(async () => {
    originalPolicy = (await prisma.systemSetting.findUnique({ where: { key: 'discount_policy' } }))?.value;
    ids.admin = await user('super_admin', 'admin');
    ids.sup = await user('supervisor', 'sup');
    ids.cashier = await user('staff', 'cashier');
    ids.branch = (await prisma.branch.create({ data: { name: `P50 Branch ${tag}`, code: `P50-${tag}`, address: '1 Test St', city: 'Testville' } })).id;
    await prisma.userBranchAssignment.create({ data: { userId: ids.sup, branchId: ids.branch } });
    ids.unit = (await prisma.unitOfMeasure.create({ data: { code: `p50-g-${tag}`, name: 'P50 Gram', dimension: 'WEIGHT', isBaseUnit: true } })).id;
    ids.potato = (await prisma.inventoryItem.create({ data: { name: `P50 potato ${tag}`, baseUnitId: ids.unit } })).id;
    await prisma.inventoryStock.create({ data: { branchId: ids.branch, inventoryItemId: ids.potato, quantityOnHand: 1000000 } });
    ids.shift = (await prisma.shift.create({ data: { branchId: ids.branch, cashierId: ids.cashier, openedBy: ids.cashier, status: 'active', openingCashAmount: 0, startedAt: new Date() } })).id;

    ({ productId: ids.fries, variantId: ids.friesVariant } = await product('Fries', 'regular', 39.75, null));
    ({ productId: ids.tera, variantId: ids.teraVariant } = await product('Tera Mix', 'regular', 300, 250));
    ({ productId: ids.promo, variantId: ids.promoVariant } = await product('Promo', 'promotional', 45, null));

    // Start from the statutory default regardless of what other suites left.
    await prisma.systemSetting.deleteMany({ where: { key: 'discount_policy' } });
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "transaction_items" WHERE "transaction_id" IN (SELECT id FROM "transactions" WHERE "branch_id" = ${ids.branch})`;
    await prisma.$executeRaw`DELETE FROM "inventory_deduction_jobs" WHERE "branch_id" = ${ids.branch}`;
    await prisma.$executeRaw`DELETE FROM "transactions" WHERE "branch_id" = ${ids.branch}`;
    await prisma.$executeRaw`DELETE FROM "checkout_attempts" WHERE "branch_id" = ${ids.branch}`;
    await prisma.promotion.deleteMany({ where: { id: { in: promotionIds } } });
    await prisma.systemSetting.deleteMany({ where: { key: 'discount_policy' } });
    if (originalPolicy !== undefined) {
      await prisma.systemSetting.create({ data: { key: 'discount_policy', value: originalPolicy as never, updatedBy: ids.admin } });
    }
  });

  // ------------------------------------------------------------------ calculation
  it('stored amounts equal the shared calculation: ordinary, PWD, Senior, Employee; quantities, centavo prices, VAT cap', async () => {
    const cases: { items: Line[]; spec: { price: number; quantity: number; cap: number | null }[]; type: 'pwd' | 'senior_citizen' | 'employee' | null }[] = [
      { items: [fries(1)], spec: [{ price: 39.75, quantity: 1, cap: null }], type: null },
      { items: [fries(3)], spec: [{ price: 39.75, quantity: 3, cap: null }], type: 'employee' },
      { items: [fries(7), tera(2)], spec: [{ price: 39.75, quantity: 7, cap: null }, { price: 300, quantity: 2, cap: 250 }], type: null },
      { items: [fries(7), tera(2)], spec: [{ price: 39.75, quantity: 7, cap: null }, { price: 300, quantity: 2, cap: 250 }], type: 'pwd' },
      { items: [fries(1)], spec: [{ price: 39.75, quantity: 1, cap: null }], type: 'senior_citizen' },
      { items: [tera(1)], spec: [{ price: 300, quantity: 1, cap: 250 }], type: 'employee' },
    ];
    for (const c of cases) {
      const want = expected(c.spec, c.type);
      const t = await sale(c.items, { ...(c.type ? { discountType: c.type } : {}), taxBasis: { vatRate: 12, discountRate: c.type ? 20 : null } });
      expect({ subtotal: t.subtotal, discount: t.discount_amount, vat: t.vat_amount, exempt: t.vat_exempt_amount, total: t.total_amount }).toEqual({
        subtotal: want.subtotal, discount: want.discountAmount, vat: want.vatAmount, exempt: want.vatExemptAmount, total: want.totalAmount,
      });
      if (c.type === 'pwd' || c.type === 'senior_citizen') expect(t.vat_amount).toBe(0);
    }
  });

  it('promotional sale: discount and VAT from the shared calculation; promotions never combine with Employee', async () => {
    const promotion = await discountsService.createPromotion(
      sup(),
      { name: `P50 promo ${tag}`, discount_kind: 'fixed_amount', discount_value: 5.5, is_enabled: true, product_ids: [ids.promo], branch_ids: [ids.branch] },
      null,
    );
    promotionIds.push(promotion.id);
    const t = await sale([{ productId: ids.promo, productVariantId: ids.promoVariant, quantity: 3, promotionAck: { promotionId: promotion.id, unitDiscount: 5.5 } }], {
      taxBasis: { vatRate: 12, discountRate: null },
    });
    const want = expected([{ price: 45, quantity: 3, cap: null, promo: 16.5 }], null);
    expect({ discount: t.discount_amount, vat: t.vat_amount, total: t.total_amount, type: t.discount_type }).toEqual({
      discount: want.discountAmount, vat: want.vatAmount, total: want.totalAmount, type: 'promotional',
    });
    await expect(
      sale([{ productId: ids.promo, productVariantId: ids.promoVariant, quantity: 1, promotionAck: { promotionId: promotion.id, unitDiscount: 5.5 } }], { discountType: 'employee' }),
    ).rejects.toMatchObject({ code: 'PROMOTION_NOT_COMBINABLE' });
  });

  it('stock: a PWD sale reserves exactly recipe × quantity, same as an undiscounted one', async () => {
    const before = await trace();
    const t = await sale([fries(4)], { discountType: 'pwd', taxBasis: { vatRate: 12, discountRate: 20 } });
    const after = await trace();
    expect(after.transactions).toBe(before.transactions + 1);
    expect(after.reserved - before.reserved + (before.onHand - after.onHand)).toBe(400);
    const items = await prisma.transactionItem.findMany({ where: { transactionId: t.id } });
    expect(items[0]?.deductionSnapshot).toEqual([expect.objectContaining({ inventoryItemId: ids.potato, quantity: 400 })]);
  });

  // ------------------------------------------------------------------ forged / changed basis
  it('forged client values: a typed discount_amount is ignored; a forged VAT rate or discount rate is refused with no trace', async () => {
    const t = await sale([fries(2)], { discountAmount: 70, taxBasis: { vatRate: 12, discountRate: null } });
    expect(t.discount_amount).toBe(0);
    expect(t.total_amount).toBe(79.5);

    const before = await noTrace();
    await expect(sale([fries(2)], { taxBasis: { vatRate: 0, discountRate: null } })).rejects.toMatchObject({ code: 'TAX_SETTINGS_CHANGED', statusCode: 409 });
    await expect(sale([fries(2)], { discountType: 'employee', taxBasis: { vatRate: 12, discountRate: 90 } })).rejects.toMatchObject({ code: 'TAX_SETTINGS_CHANGED' });
    await expect(sale([fries(2)], { discountType: 'employee', taxBasis: { vatRate: 12, discountRate: null } })).rejects.toMatchObject({ code: 'TAX_SETTINGS_CHANGED' });
    expect(await noTrace()).toEqual(before);
  });

  it('settings changed while a cart is open: refused with the amount that would be charged now; recharging with the new basis succeeds', async () => {
    await setEmployeeRate(10);
    try {
      const before = await noTrace();
      const refusal = await sale([fries(3)], { discountType: 'employee', taxBasis: { vatRate: 12, discountRate: 20 } }).catch((error: unknown) => error);
      const want = expected([{ price: 39.75, quantity: 3, cap: null }], 'employee', { ...RATES20, employee: 10 });
      expect(refusal).toMatchObject({
        code: 'TAX_SETTINGS_CHANGED',
        details: {
          shown: { vat_rate: 12, discount_rate: 20 },
          current: { vat_rate: 12, discount_rate: 10 },
          amounts: { subtotal: 119.25, discount_amount: want.discountAmount, vat_amount: want.vatAmount, total_amount: want.totalAmount },
        },
      });
      expect(await noTrace()).toEqual(before);

      const t = await sale([fries(3)], { discountType: 'employee', taxBasis: { vatRate: 12, discountRate: 10 } });
      expect(t.total_amount).toBe(want.totalAmount);
      expect(t.discount_rate_used).toBe(10);
    } finally {
      await setEmployeeRate(20);
    }
  });

  it('older client (no tax basis) keeps the pre-P50 behavior: charged at the current rate', async () => {
    await setEmployeeRate(15);
    try {
      const t = await sale([fries(2)], { discountType: 'employee' });
      expect(t.discount_rate_used).toBe(15);
      expect(t.total_amount).toBe(expected([{ price: 39.75, quantity: 2, cap: null }], 'employee', { ...RATES20, employee: 15 }).totalAmount);
    } finally {
      await setEmployeeRate(20);
    }
  });

  // ------------------------------------------------------------------ offline
  it('offline: a sale queued before a rate change is refused visibly (never repriced); the rest of the batch syncs; an already-synced sale still replays', async () => {
    const device = `dev-${tag}`;
    const queued = (n: string, discount: boolean, basis?: { vatRate: number; discountRate: number | null }) => ({
      offlineProvisionalNumber: `PC-P50-OFFLINE-${n}-${tag}`,
      shiftId: ids.shift,
      items: [fries(2)],
      paymentMethod: 'cash' as const,
      cashTendered: 500,
      clientCreatedAt: Date.now(),
      ...(discount ? { discountType: 'employee' as const } : {}),
      ...(basis ? { taxBasis: basis } : {}),
    });

    // Synced once at 20%.
    const first = await transactionsService.syncOfflineTransactions(
      { branchId: ids.branch, cashierId: ids.cashier, deviceId: device, transactions: [queued('1', true, { vatRate: 12, discountRate: 20 })] },
      null,
    );
    expect(first.results[0]).toMatchObject({ status: 'synced' });

    await setEmployeeRate(10);
    try {
      const before = await trace();
      const second = await transactionsService.syncOfflineTransactions(
        {
          branchId: ids.branch,
          cashierId: ids.cashier,
          deviceId: device,
          transactions: [
            queued('1', true, { vatRate: 12, discountRate: 20 }), // replay of the committed one
            queued('2', true, { vatRate: 12, discountRate: 20 }), // rung at 20%, now 10% → refused
            queued('3', false, { vatRate: 12, discountRate: null }), // unaffected
            queued('4', true), // pre-P50 queued sale: no basis → current rate, as before
          ],
        },
        null,
      );
      const byNumber = new Map(second.results.map((r) => [r.offline_provisional_number.split('-')[3], r]));
      expect(byNumber.get('1')).toMatchObject({ status: 'synced', transaction: { discount_rate_used: 20 } });
      expect(byNumber.get('2')).toMatchObject({ status: 'failed', error: { code: 'TAX_SETTINGS_CHANGED' } });
      expect(byNumber.get('2')?.error?.message).toBe('This offline sale was rung with 20% (VAT 12%), but checkout now uses 10% (VAT 12%). It was not recorded, so the amount collected was not changed.');
      expect(byNumber.get('3')).toMatchObject({ status: 'synced' });
      expect(byNumber.get('4')).toMatchObject({ status: 'synced', transaction: { discount_rate_used: 10 } });
      expect((await trace()).transactions).toBe(before.transactions + 2);
      expect(await prisma.transaction.count({ where: { offlineProvisionalNumber: `PC-P50-OFFLINE-2-${tag}` } })).toBe(0);
    } finally {
      await setEmployeeRate(20);
    }
  });

  // ------------------------------------------------------------------ history
  it('history: receipts, transaction rows and reports read the same after a settings change; void/refund keep the original amounts', async () => {
    const employeeSale = await sale([fries(3)], { discountType: 'employee', taxBasis: { vatRate: 12, discountRate: 20 } });
    const pwdSale = await sale([tera(1)], { discountType: 'pwd', taxBasis: { vatRate: 12, discountRate: 20 } });
    const toVoid = await sale([fries(1)], { taxBasis: { vatRate: 12, discountRate: null } });
    const toRefund = await sale([fries(2)], { discountType: 'employee', taxBasis: { vatRate: 12, discountRate: 20 } });

    const snapshot = async () => ({
      receipts: await Promise.all([employeeSale, pwdSale].map((t) => receiptsService.getPublicReceipt(t.receipt_number))),
      rows: await prisma.transaction.findMany({ where: { id: { in: [employeeSale.id, pwdSale.id, toVoid.id, toRefund.id] } }, orderBy: { id: 'asc' }, select: { subtotal: true, discountAmount: true, vatAmount: true, vatExemptAmount: true, totalAmount: true, discountRateUsed: true } }),
      daily: await reportsRepository.getDailySales({ branchId: ids.branch, page: 1, limit: 100 }),
      compliance: await reportsRepository.getDiscountCompliance({ branchId: ids.branch, page: 1, limit: 100 }),
    });
    const before = await snapshot();
    expect(before.receipts[1]).toMatchObject({ discount_type: 'pwd', vat_amount: 0, vat_exempt_amount: pwdSale.vat_exempt_amount, total_amount: pwdSale.total_amount });

    await setEmployeeRate(5);
    try {
      expect(await snapshot()).toEqual(before);

      await transactionsService.voidTransaction(toVoid.id, 'P50 void after a settings change', { id: ids.sup, role: 'supervisor' }, null);
      await transactionsService.refundTransaction(toRefund.id, 'P50 refund after a settings change', { id: ids.sup, role: 'supervisor' }, null);
      const after = await snapshot();
      expect(after.rows).toEqual(before.rows);
      expect(after.receipts).toEqual(before.receipts);
      const voided = await prisma.transaction.findUniqueOrThrow({ where: { id: toRefund.id } });
      expect(voided.status).toBe('refunded');
      expect(voided.totalAmount.toNumber()).toBe(toRefund.total_amount);
    } finally {
      await setEmployeeRate(20);
    }

    // Compliance: PWD exempt sales = stored PWD totals.
    const pwdRow = (await reportsRepository.getDiscountCompliance({ branchId: ids.branch, page: 1, limit: 100 })).find((r) => r.discount_type === 'pwd');
    const pwdTotals = await prisma.transaction.aggregate({ where: { branchId: ids.branch, status: 'completed', discountType: 'pwd' }, _sum: { totalAmount: true } });
    expect(pwdRow?.total_vat_exempt_sales).toBe(pwdTotals._sum.totalAmount?.toNumber());
  });

  // ------------------------------------------------------------------ settings security
  // POS-PERF-P50R — PWD may be raised (RA 10754 "at least 20%"), never lowered
  // or disabled; Senior stays exactly 20%; a supervisor cannot write the
  // organization-wide row at all.
  it('statutory PWD/Senior bounds hold and supervisors cannot write the organization row; nothing is written or audited', async () => {
    const before = await prisma.systemSetting.findUnique({ where: { key: 'discount_policy' } });
    const auditsBefore = await prisma.auditLog.count({ where: { entityId: 'discount_policy' } });
    for (const data of [{ pwd: { percentage: 15 } }, { senior_citizen: { percentage: 25 } }, { senior_citizen: { percentage: 10 } }, { pwd: { isEnabled: false } }] as const) {
      await expect(settingsService.updateDiscountPolicy(data, admin(), null)).rejects.toMatchObject({ code: 'STATUTORY_DISCOUNT_LOCKED' });
    }
    await expect(settingsService.updateDiscountPolicy({ employee: { percentage: 5 } }, sup(), null)).rejects.toMatchObject({ code: 'ORGANIZATION_DISCOUNTS_ADMIN_ONLY', statusCode: 403 });
    expect(await prisma.systemSetting.findUnique({ where: { key: 'discount_policy' } })).toEqual(before);
    expect(await prisma.auditLog.count({ where: { entityId: 'discount_policy' } })).toBe(auditsBefore);
  });

  it('two concurrent saves from the same loaded version: exactly one wins, the other is refused; each success is audited', async () => {
    const loaded = await settingsService.getDiscountPolicy();
    const auditsBefore = await prisma.auditLog.count({ where: { entityId: 'discount_policy', action: 'DISCOUNT_POLICY_UPDATED' } });
    const results = await Promise.allSettled([
      settingsService.updateDiscountPolicy({ employee: { percentage: 11 }, expectedUpdatedAt: loaded.updatedAt }, admin(), null),
      settingsService.updateDiscountPolicy({ employee: { percentage: 12 }, expectedUpdatedAt: loaded.updatedAt }, admin(), null),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'SETTINGS_CHANGED', statusCode: 409 });
    expect(await prisma.auditLog.count({ where: { entityId: 'discount_policy', action: 'DISCOUNT_POLICY_UPDATED' } })).toBe(auditsBefore + 1);

    // A save from the now-stale version is refused too.
    await expect(settingsService.updateDiscountPolicy({ employee: { percentage: 13 }, expectedUpdatedAt: loaded.updatedAt }, admin(), null)).rejects.toMatchObject({ code: 'SETTINGS_CHANGED' });
    await setEmployeeRate(20);
  });
});
