import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { globalDiscountPolicyLock, DISCOUNT_POLICY_LOCK_WAIT_MS } from '../../test-utils/global-discount-policy-lock.js';
import { randomUUID } from 'node:crypto';
import type { JwtPayload } from '@potato-corner/shared';

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
const { settingsService } = await import('../settings/settings.service.js');


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


  /** What a refused sale could change. Available (on hand − reserved) is stable even while another suite's job runner completes earlier deductions. */

  async function setEmployeeRate(percentage: number) {
    const current = await settingsService.getDiscountPolicy();
    await settingsService.updateDiscountPolicy({ employee: { percentage }, expectedUpdatedAt: current.updatedAt }, admin(), null);
  }

  // POS-PERF-P62 — this file rewrites the global discount_policy row: take turns with the other file that does.
  const policyLock = globalDiscountPolicyLock();
  beforeAll(() => policyLock.acquire(), DISCOUNT_POLICY_LOCK_WAIT_MS);
  afterAll(() => policyLock.release());

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

  // ------------------------------------------------------------------ forged / changed basis

  // ------------------------------------------------------------------ offline

  // ------------------------------------------------------------------ history

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
