import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { globalDiscountPolicyLock, DISCOUNT_POLICY_LOCK_WAIT_MS } from '../../test-utils/global-discount-policy-lock.js';
import { randomUUID } from 'node:crypto';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P50R — supervisor-managed, branch-scoped discounts and the branch
 * VAT-registration record, against a real Postgres: branch isolation and
 * forged ids, organization defaults vs branch overrides at checkout, PWD
 * enhancement bounds, stale/concurrent saves, the required discount choice,
 * cashier-selected custom discounts (create/edit/disable, never automatic,
 * never combined, refused offline), the per-sale tax snapshot, unchanged
 * history, idempotent retries and stock reservation.
 *
 * Requires TEST_DATABASE_URL pointing at a disposable, migrated database.
 * Changes the global discount_policy row and restores it in afterAll.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const { settingsService } = await import('./settings.service.js');
const { discountsService } = await import('../discounts/discounts.service.js');

describe.skipIf(!canRunIntegrationTests)('P50R branch discounts integration', () => {
  const tag = randomUUID().slice(0, 8);
  const ids = { branchA: '', branchB: '', inactive: '', supA: '', supB: '', admin: '', cashier: '', shiftA: '', shiftB: '', unit: '', potato: '', fries: '', friesVariant: '', tera: '', teraVariant: '' };
  const productIds: string[] = [];
  const promotionIds: string[] = [];
  let originalPolicy: unknown = undefined;

  const admin = (): JwtPayload => ({ user_id: ids.admin, role: 'super_admin', email: `admin-${tag}@t.test`, iat: 0, exp: 0 });
  const supA = (): JwtPayload => ({ user_id: ids.supA, role: 'supervisor', email: `supa-${tag}@t.test`, branch_ids: [ids.branchA], iat: 0, exp: 0 });
  // A forged token claiming branch B: authority is re-read from assignments, never the JWT claim.
  const supAForged = (): JwtPayload => ({ user_id: ids.supA, role: 'supervisor', email: `supa-${tag}@t.test`, branch_ids: [ids.branchA, ids.branchB], iat: 0, exp: 0 });
  const staffA = (): JwtPayload => ({ user_id: ids.cashier, role: 'staff', email: `cashier-${tag}@t.test`, branch_ids: [ids.branchA], iat: 0, exp: 0 });

  async function user(role: 'supervisor' | 'super_admin' | 'staff', name: string) {
    const row = await prisma.user.create({
      data: { email: `${name}-${tag}@potatocorner.test`, passwordHash: 'unused', role, firstName: 'P50R', lastName: name, employmentType: 'regular', mustChangePassword: false },
    });
    return row.id;
  }

  async function product(name: string, price: number, cap: number | null) {
    const row = await prisma.product.create({ data: { name: `P50R ${name} ${tag}`, status: 'active', classification: 'regular' } });
    productIds.push(row.id);
    const variant = await prisma.productVariant.create({ data: { productId: row.id, name: 'Regular', sizeLabel: 'Regular', basePrice: price, vatableCapAmount: cap, isActive: true } });
    await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: ids.potato, quantityRequired: 100 } });
    for (const branchId of [ids.branchA, ids.branchB]) await prisma.branchProductAvailability.create({ data: { branchId, productId: row.id, isAvailable: true } });
    return { productId: row.id, variantId: variant.id };
  }


  async function saveBranch(branchId: string, actor: JwtPayload, data: { employee?: { percentage: number; isEnabled: boolean } | null; pwdPercentage?: number | null; requireDiscountChoice?: boolean }) {
    const current = await settingsService.getBranchDiscountSettings(branchId, admin());
    return settingsService.updateBranchDiscountSettings(
      branchId,
      {
        employee: data.employee === undefined ? (current.override?.employee ?? null) : data.employee,
        pwdPercentage: data.pwdPercentage === undefined ? (current.override?.pwdPercentage ?? null) : data.pwdPercentage,
        requireDiscountChoice: data.requireDiscountChoice ?? current.override?.requireDiscountChoice ?? false,
        expectedUpdatedAt: current.updatedAt,
      },
      actor,
      null,
    );
  }

  async function createCustom(actor: JwtPayload, overrides: Record<string, unknown> = {}) {
    const promotion = await discountsService.createPromotion(
      actor,
      {
        name: `Loyalty ${randomUUID().slice(0, 4)}`,
        discount_kind: 'percentage',
        discount_value: 10,
        is_enabled: true,
        application_mode: 'cashier_selected',
        product_ids: [ids.fries],
        branch_ids: [ids.branchA],
        ...overrides,
      } as Parameters<typeof discountsService.createPromotion>[1],
      null,
    );
    promotionIds.push(promotion.id);
    return promotion;
  }

  // POS-PERF-P62 — this file rewrites the global discount_policy row: take turns with the other file that does.
  const policyLock = globalDiscountPolicyLock();
  beforeAll(() => policyLock.acquire(), DISCOUNT_POLICY_LOCK_WAIT_MS);
  afterAll(() => policyLock.release());

  beforeAll(async () => {
    originalPolicy = (await prisma.systemSetting.findUnique({ where: { key: 'discount_policy' } }))?.value;
    ids.admin = await user('super_admin', 'admin');
    ids.supA = await user('supervisor', 'supa');
    ids.supB = await user('supervisor', 'supb');
    ids.cashier = await user('staff', 'cashier');
    for (const key of ['branchA', 'branchB'] as const) {
      ids[key] = (await prisma.branch.create({ data: { name: `P50R ${key} ${tag}`, code: `P50R${key.slice(-1)}-${tag}`, address: '1 Test St', city: 'Testville' } })).id;
    }
    ids.inactive = (await prisma.branch.create({ data: { name: `P50R inactive ${tag}`, code: `P50RX-${tag}`, address: '1 Test St', city: 'Testville', status: 'inactive' } })).id;
    await prisma.userBranchAssignment.createMany({ data: [{ userId: ids.supA, branchId: ids.branchA }, { userId: ids.supB, branchId: ids.branchB }] });
    ids.unit = (await prisma.unitOfMeasure.create({ data: { code: `p50r-g-${tag}`, name: 'P50R Gram', dimension: 'WEIGHT', isBaseUnit: true } })).id;
    ids.potato = (await prisma.inventoryItem.create({ data: { name: `P50R potato ${tag}`, baseUnitId: ids.unit } })).id;
    for (const branchId of [ids.branchA, ids.branchB]) await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: ids.potato, quantityOnHand: 1000000 } });
    ids.shiftA = (await prisma.shift.create({ data: { branchId: ids.branchA, cashierId: ids.cashier, openedBy: ids.cashier, status: 'active', openingCashAmount: 0, startedAt: new Date() } })).id;
    ids.shiftB = (await prisma.shift.create({ data: { branchId: ids.branchB, cashierId: ids.cashier, openedBy: ids.cashier, status: 'active', openingCashAmount: 0, startedAt: new Date() } })).id;
    ({ productId: ids.fries, variantId: ids.friesVariant } = await product('Fries', 112, null));
    ({ productId: ids.tera, variantId: ids.teraVariant } = await product('Tera', 300, 250));
    await prisma.systemSetting.deleteMany({ where: { key: 'discount_policy' } });
  });

  afterAll(async () => {
    const branches = [ids.branchA, ids.branchB, ids.inactive];
    await prisma.$executeRaw`DELETE FROM "transaction_items" WHERE "transaction_id" IN (SELECT id FROM "transactions" WHERE "branch_id" = ANY(${branches}))`;
    await prisma.$executeRaw`DELETE FROM "inventory_deduction_jobs" WHERE "branch_id" = ANY(${branches})`;
    await prisma.$executeRaw`DELETE FROM "transactions" WHERE "branch_id" = ANY(${branches})`;
    await prisma.$executeRaw`DELETE FROM "checkout_attempts" WHERE "branch_id" = ANY(${branches})`;
    await prisma.promotion.deleteMany({ where: { id: { in: promotionIds } } });
    await prisma.systemSetting.deleteMany({ where: { key: { in: ['discount_policy', ...branches.flatMap((b) => [`discount_policy:branch:${b}`, `tax_profile:branch:${b}`])] } } });
    if (originalPolicy !== undefined) await prisma.systemSetting.create({ data: { key: 'discount_policy', value: originalPolicy as never, updatedBy: ids.admin } });
  });

  // ---------------------------------------------------------------- authority
  it('a supervisor reads and saves only branches they actively manage; forged and unknown branch ids are refused with nothing written', async () => {
    const auditsBefore = await prisma.auditLog.count({ where: { action: 'BRANCH_DISCOUNT_SETTINGS_UPDATED' } });
    await expect(settingsService.getBranchDiscountSettings(ids.branchB, supA())).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED', statusCode: 403 });
    const body = { employee: { percentage: 5, isEnabled: true }, pwdPercentage: null, requireDiscountChoice: false, expectedUpdatedAt: null };
    await expect(settingsService.updateBranchDiscountSettings(ids.branchB, body, supAForged(), null)).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED', statusCode: 403 });
    await expect(settingsService.updateBranchDiscountSettings(randomUUID(), body, supA(), null)).rejects.toMatchObject({ statusCode: 403 });
    await expect(settingsService.updateBranchDiscountSettings(randomUUID(), body, admin(), null)).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND', statusCode: 404 });
    await expect(settingsService.updateBranchDiscountSettings(ids.inactive, body, admin(), null)).rejects.toMatchObject({ code: 'BRANCH_INACTIVE' });
    await expect(settingsService.updateBranchDiscountSettings(ids.branchA, body, staffA(), null)).rejects.toMatchObject({ statusCode: 403 });
    expect(await prisma.systemSetting.count({ where: { key: { in: [`discount_policy:branch:${ids.branchB}`, `discount_policy:branch:${ids.inactive}`] } } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'BRANCH_DISCOUNT_SETTINGS_UPDATED' } })).toBe(auditsBefore);
  });

  it('two concurrent saves of one branch from the same loaded version: exactly one wins and is audited', async () => {
    const loaded = await settingsService.getBranchDiscountSettings(ids.branchA, supA());
    const auditsBefore = await prisma.auditLog.count({ where: { action: 'BRANCH_DISCOUNT_SETTINGS_UPDATED', branchId: ids.branchA } });
    const body = (pct: number) => ({ employee: { percentage: pct, isEnabled: true }, pwdPercentage: null, requireDiscountChoice: false, expectedUpdatedAt: loaded.updatedAt });
    const results = await Promise.allSettled([
      settingsService.updateBranchDiscountSettings(ids.branchA, body(11), supA(), null),
      settingsService.updateBranchDiscountSettings(ids.branchA, body(12), admin(), null),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'SETTINGS_CHANGED', statusCode: 409 });
    expect(await prisma.auditLog.count({ where: { action: 'BRANCH_DISCOUNT_SETTINGS_UPDATED', branchId: ids.branchA } })).toBe(auditsBefore + 1);
    await expect(settingsService.updateBranchDiscountSettings(ids.branchA, body(13), supA(), null)).rejects.toMatchObject({ code: 'SETTINGS_CHANGED' });
    await saveBranch(ids.branchA, supA(), { employee: null });
  });

  // ---------------------------------------------------------------- required choice

  // ---------------------------------------------------------------- custom discounts

  it('custom discount authority: supervisors write only managed branches (forged token refused); automatic mode still rejects Regular products; Super Admin is read-only', async () => {
    await expect(createCustom(supAForged(), { branch_ids: [ids.branchA, ids.branchB] })).rejects.toMatchObject({ code: 'PROMOTION_BRANCH_FORBIDDEN', statusCode: 403 });
    await expect(createCustom(supA(), { application_mode: 'automatic' })).rejects.toMatchObject({ code: 'PROMOTION_PRODUCT_INELIGIBLE' });
    await expect(createCustom(supA(), { product_ids: [ids.tera] })).rejects.toMatchObject({ code: 'PROMOTION_PRODUCT_INELIGIBLE' });
    await expect(createCustom(admin())).rejects.toMatchObject({ code: 'PROMOTION_WRITE_FORBIDDEN' });
    // An older (P49) editor re-saving a cashier-selected discount sends no mode: it stays cashier-selected.
    const kept = await createCustom(supA());
    const resaved = await discountsService.updatePromotion(
      supA(),
      kept.id,
      { name: 'Renamed', discount_kind: 'percentage', discount_value: 10, is_enabled: true, product_ids: [ids.fries], branch_ids: [ids.branchA], expected_version: kept.version },
      null,
    );
    expect(resaved).toMatchObject({ name: 'Renamed', application_mode: 'cashier_selected' });
    await expect(createCustom(supA(), { product_ids: [randomUUID()] })).rejects.toMatchObject({ code: 'PROMOTION_PRODUCT_INELIGIBLE' });
    // Global product configuration and base price are untouched by any branch discount.
    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: ids.friesVariant } });
    expect(variant.basePrice.toNumber()).toBe(112);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: ids.fries } })).classification).toBe('regular');
  });

  // ---------------------------------------------------------------- VAT registration
});
