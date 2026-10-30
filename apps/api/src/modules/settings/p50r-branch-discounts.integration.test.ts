import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computeSaleTax, type JwtPayload } from '@potato-corner/shared';

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
const { productsService } = await import('../products/products.service.js');
const { transactionsService } = await import('../transactions/transactions.service.js');
const { receiptsService } = await import('../receipts/receipts.service.js');

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
  const supB = (): JwtPayload => ({ user_id: ids.supB, role: 'supervisor', email: `supb-${tag}@t.test`, branch_ids: [ids.branchB], iat: 0, exp: 0 });
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

  type Line = { productId: string; productVariantId: string; quantity: number; promotionAck?: { promotionId: string; unitDiscount: number } | null };
  const fries = (quantity: number, ack?: { promotionId: string; unitDiscount: number } | null): Line => ({
    productId: ids.fries,
    productVariantId: ids.friesVariant,
    quantity,
    ...(ack !== undefined ? { promotionAck: ack } : {}),
  });

  function sale(
    items: Line[],
    opts: {
      branch?: 'A' | 'B';
      discountType?: 'pwd' | 'senior_citizen' | 'employee';
      taxBasis?: { vatRate: number; discountRate: number | null };
      selectedDiscount?: { promotionId: string; version: number };
      discountChoice?: 'selected' | 'none_applicable';
      offline?: boolean;
      idempotencyKey?: string;
    } = {},
  ) {
    const branchId = opts.branch === 'B' ? ids.branchB : ids.branchA;
    return transactionsService.createTransaction(
      {
        branchId,
        shiftId: opts.branch === 'B' ? ids.shiftB : ids.shiftA,
        cashierId: ids.cashier,
        items,
        paymentMethod: 'cash',
        cashTendered: 10000,
        isOfflineTransaction: opts.offline ?? false,
        idempotencyKey: opts.idempotencyKey ?? randomUUID(),
        ...(opts.discountType ? { discountType: opts.discountType } : {}),
        ...(opts.discountType === 'pwd' || opts.discountType === 'senior_citizen' ? { discountIdReference: `ID-${randomUUID().slice(0, 6)}` } : {}),
        ...(opts.taxBasis ? { taxBasis: opts.taxBasis } : {}),
        ...(opts.selectedDiscount ? { selectedDiscount: opts.selectedDiscount } : {}),
        ...(opts.discountChoice ? { discountChoice: opts.discountChoice } : {}),
        ...(opts.offline ? { offlineProvisionalNumber: `PC-P50R-OFFLINE-${randomUUID().slice(0, 6)}`, deviceId: `dev-${tag}` } : {}),
      },
      null,
    );
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

  async function storedSnapshot(transactionId: string) {
    return (await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId }, select: { taxSnapshot: true } })).taxSnapshot as Record<string, unknown> | null;
  }

  async function noTrace() {
    const [transactions, stock] = await Promise.all([
      prisma.transaction.count({ where: { branchId: { in: [ids.branchA, ids.branchB] } } }),
      prisma.inventoryStock.findMany({ where: { branchId: { in: [ids.branchA, ids.branchB] } }, orderBy: { branchId: 'asc' } }),
    ]);
    return { transactions, available: stock.map((s) => s.quantityOnHand.toNumber() - s.quantityReserved.toNumber()) };
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

  it('organization default vs branch override: only the overridden branch changes, checkout charges it and snapshots the source', async () => {
    const before = await settingsService.getBranchDiscountSettings(ids.branchA, supA());
    expect(before.override).toBeNull();
    expect(before.effective.employee).toMatchObject({ percentage: 20, source: 'organization' });

    const saved = await saveBranch(ids.branchA, supA(), { employee: { percentage: 10, isEnabled: true } });
    expect(saved.effective.employee).toMatchObject({ percentage: 10, source: 'branch' });
    expect((await settingsService.getBranchDiscountSettings(ids.branchB, supB())).effective.employee).toMatchObject({ percentage: 20, source: 'organization' });
    // The organization row itself is untouched.
    expect((await settingsService.getDiscountPolicy()).employee.percentage).toBe(20);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'BRANCH_DISCOUNT_SETTINGS_UPDATED', branchId: ids.branchA }, orderBy: { createdAt: 'desc' } });
    expect(audit.actorId).toBe(ids.supA);
    expect(audit.beforeState).toMatchObject({ override: null, effective: { employee: { percentage: 20 } } });
    expect(audit.afterState).toMatchObject({ override: { employee: { percentage: 10 } }, effective: { employee: { percentage: 10 } } });

    const rates = (pct: number) => ({ pwd: 20, senior_citizen: 20, employee: pct });
    const a = await sale([fries(1)], { discountType: 'employee', taxBasis: { vatRate: 12, discountRate: 10 } });
    expect(a).toMatchObject({ discount_rate_used: 10, total_amount: computeSaleTax(112, [{ lineTotal: 112, quantity: 1, vatableCapAmount: null }], 'employee', rates(10)).totalAmount });
    expect(await storedSnapshot(a.id)).toMatchObject({ discount_rate_source: 'branch', discount_basis: 'vat_inclusive', treatment: 'vatable', vat_rate_percent: 12 });
    const b = await sale([fries(1)], { branch: 'B', discountType: 'employee', taxBasis: { vatRate: 12, discountRate: 20 } });
    expect(b).toMatchObject({ discount_rate_used: 20 });
    expect(await storedSnapshot(b.id)).toMatchObject({ discount_rate_source: 'organization' });

    // A POS showing the organization rate at branch A is refused, never charged.
    await expect(sale([fries(1)], { discountType: 'employee', taxBasis: { vatRate: 12, discountRate: 20 } })).rejects.toMatchObject({ code: 'TAX_SETTINGS_CHANGED' });

    // Staff (and a pre-P50R POS) read their own branch's effective rate from /discount-policy.
    const staffView = await settingsService.getDiscountPolicyFor(staffA(), undefined);
    expect(staffView).toMatchObject({ branchId: ids.branchA, employee: { percentage: 10 } });
    const staffForged = await settingsService.getDiscountPolicyFor(staffA(), ids.branchB);
    expect(staffForged.branchId).toBe(ids.branchA);

    // Back to the organization default.
    const cleared = await saveBranch(ids.branchA, supA(), { employee: null });
    expect(cleared.effective.employee).toMatchObject({ percentage: 20, source: 'organization' });
  });

  it('PWD may be raised per branch (at least 20%, RA 10754) with the VAT-exempt formula; lower values are refused; Senior is not branch-editable', async () => {
    await expect(saveBranch(ids.branchA, supA(), { pwdPercentage: 15 })).rejects.toMatchObject({ code: 'STATUTORY_DISCOUNT_LOCKED' });
    const saved = await saveBranch(ids.branchA, supA(), { pwdPercentage: 25 });
    expect(saved.effective.pwd).toMatchObject({ percentage: 25, isEnabled: true, source: 'branch' });
    expect(saved.effective.senior_citizen).toMatchObject({ percentage: 20, source: 'statute' });

    const pwd = await sale([fries(1)], { discountType: 'pwd', taxBasis: { vatRate: 12, discountRate: 25 } });
    // ₱112 / 1.12 = ₱100 VAT-exclusive; 25% off → ₱75, no VAT.
    expect(pwd).toMatchObject({ discount_amount: 25, vat_amount: 0, total_amount: 75, discount_rate_used: 25 });
    expect(await storedSnapshot(pwd.id)).toMatchObject({ treatment: 'vat_exempt', discount_basis: 'vat_exclusive', discount_rate_source: 'branch' });
    const senior = await sale([fries(1)], { discountType: 'senior_citizen', taxBasis: { vatRate: 12, discountRate: 20 } });
    expect(senior).toMatchObject({ total_amount: 80, vat_amount: 0, discount_rate_used: 20 });
    await saveBranch(ids.branchA, supA(), { pwdPercentage: null });
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
  it('required discount choice: a current POS must send a decision; "No applicable discount" is accepted and recorded; old and offline sales are never refused for it', async () => {
    await saveBranch(ids.branchA, supA(), { requireDiscountChoice: true });
    const trace = await noTrace();
    await expect(sale([fries(1)], { taxBasis: { vatRate: 12, discountRate: null } })).rejects.toMatchObject({ code: 'DISCOUNT_CHOICE_REQUIRED', statusCode: 422 });
    await expect(sale([fries(1)], { discountType: 'employee', discountChoice: 'none_applicable', taxBasis: { vatRate: 12, discountRate: 20 } })).rejects.toMatchObject({ code: 'DISCOUNT_CHOICE_CONFLICT' });
    expect(await noTrace()).toEqual(trace);

    const none = await sale([fries(1)], { discountChoice: 'none_applicable', taxBasis: { vatRate: 12, discountRate: null } });
    expect(none).toMatchObject({ total_amount: 112, discount_amount: 0, vat_amount: 12 });
    expect(await storedSnapshot(none.id)).toMatchObject({ require_discount_choice: true, discount_choice: 'none_applicable' });
    const chosen = await sale([fries(1)], { discountType: 'employee', discountChoice: 'selected', taxBasis: { vatRate: 12, discountRate: 20 } });
    expect(await storedSnapshot(chosen.id)).toMatchObject({ discount_choice: 'selected' });

    const oldClient = await sale([fries(1)]);
    expect(oldClient.total_amount).toBe(112);
    const offline = await sale([fries(1)], { offline: true, taxBasis: { vatRate: 12, discountRate: null } });
    expect(offline.total_amount).toBe(112);
    expect((await settingsService.getDiscountPolicyFor(staffA(), undefined)).requireDiscountChoice).toBe(true);
    await saveBranch(ids.branchA, supA(), { requireDiscountChoice: false });
  });

  // ---------------------------------------------------------------- custom discounts
  it('custom cashier-selected discount: never applied automatically; applied only when chosen, as a VATable discount, with a frozen snapshot', async () => {
    const loyalty = await createCustom(supA());
    expect(loyalty).toMatchObject({ application_mode: 'cashier_selected', schedule_state: 'active' });

    const catalog = await productsService.getPosCatalog(ids.branchA);
    const friesCatalog = catalog.products.find((p) => p.id === ids.fries)?.variants[0];
    expect(friesCatalog?.promotion ?? null).toBeNull();
    const offered = catalog.selectable_discounts?.find((d) => d.promotion_id === loyalty.id);
    expect(offered).toMatchObject({ version: loyalty.version, unit_discounts: { [ids.friesVariant]: 11.2 } });
    expect((await productsService.getPosCatalog(ids.branchB)).selectable_discounts?.some((d) => d.promotion_id === loyalty.id)).toBe(false);

    // Claiming it without selecting it (as if automatic) is refused.
    await expect(sale([fries(1, { promotionId: loyalty.id, unitDiscount: 11.2 })])).rejects.toMatchObject({ code: 'PROMOTION_CHANGED' });

    const tera = { productId: ids.tera, productVariantId: ids.teraVariant, quantity: 1, promotionAck: null };
    const stockBefore = await prisma.inventoryStock.findFirstOrThrow({ where: { branchId: ids.branchA, inventoryItemId: ids.potato } });
    const sold = await sale([fries(2, { promotionId: loyalty.id, unitDiscount: 11.2 }), tera], {
      selectedDiscount: { promotionId: loyalty.id, version: loyalty.version },
      discountChoice: 'selected',
      taxBasis: { vatRate: 12, discountRate: null },
    });
    const expected = computeSaleTax(524, [{ lineTotal: 224, quantity: 2, vatableCapAmount: null, promotionDiscount: 22.4 }, { lineTotal: 300, quantity: 1, vatableCapAmount: 250 }], null, { pwd: 20, senior_citizen: 20, employee: 20 });
    expect(sold).toMatchObject({ discount_type: 'promotional', discount_amount: 22.4, vat_amount: expected.vatAmount, total_amount: expected.totalAmount, vat_exempt_amount: 50 });
    const line = sold.items?.find((i) => i.product_variant_id === ids.friesVariant);
    expect(line).toMatchObject({ discount_amount: 22.4, promotion: { promotion_id: loyalty.id, unit_discount: 11.2 } });
    const stored = await prisma.transactionItem.findFirstOrThrow({ where: { transactionId: sold.id, productVariantId: ids.friesVariant } });
    expect(stored.promotionSnapshot).toMatchObject({ application_mode: 'cashier_selected', version: loyalty.version });
    expect(await storedSnapshot(sold.id)).toMatchObject({ selected_discount_id: loyalty.id, discount_basis: 'vat_inclusive', treatment: 'vatable' });
    // Stock: recipe × quantity, unchanged by the discount (3 units × 100 g).
    const stockAfter = await prisma.inventoryStock.findFirstOrThrow({ where: { branchId: ids.branchA, inventoryItemId: ids.potato } });
    expect(stockAfter.quantityReserved.toNumber() - stockBefore.quantityReserved.toNumber() + (stockBefore.quantityOnHand.toNumber() - stockAfter.quantityOnHand.toNumber())).toBe(300);
  });

  it('custom discount refusals: stale version, disabled, other branch, combined with Employee, offline — nothing written; idempotent retry replays', async () => {
    const custom = await createCustom(supA(), { discount_kind: 'fixed_amount', discount_value: 5 });
    const claim = { promotionId: custom.id, version: custom.version };
    const ack = { promotionId: custom.id, unitDiscount: 5 };

    const key = randomUUID();
    const first = await sale([fries(1, ack)], { selectedDiscount: claim, idempotencyKey: key, taxBasis: { vatRate: 12, discountRate: null } });
    expect(first).toMatchObject({ discount_amount: 5, total_amount: 107 });

    const edited = await discountsService.updatePromotion(
      supA(),
      custom.id,
      { name: custom.name, discount_kind: 'fixed_amount', discount_value: 7, is_enabled: true, application_mode: 'cashier_selected', product_ids: [ids.fries], branch_ids: [ids.branchA], expected_version: custom.version },
      null,
    );
    expect(edited.version).toBe(custom.version + 1);

    // Retry of the committed sale replays it at the original amount.
    const replay = await sale([fries(1, ack)], { selectedDiscount: claim, idempotencyKey: key, taxBasis: { vatRate: 12, discountRate: null } });
    expect(replay.id).toBe(first.id);
    expect(replay.total_amount).toBe(107);

    const trace = await noTrace();
    await expect(sale([fries(1, ack)], { selectedDiscount: claim })).rejects.toMatchObject({ code: 'PROMOTION_CHANGED', statusCode: 409 });
    await expect(sale([fries(1, { ...ack, unitDiscount: 7 })], { selectedDiscount: { promotionId: custom.id, version: edited.version }, discountType: 'employee' })).rejects.toMatchObject({ code: 'PROMOTION_NOT_COMBINABLE' });
    await expect(sale([fries(1, { ...ack, unitDiscount: 7 })], { selectedDiscount: { promotionId: custom.id, version: edited.version }, offline: true })).rejects.toMatchObject({ code: 'PROMOTION_OFFLINE_UNSUPPORTED' });
    await expect(sale([fries(1, { ...ack, unitDiscount: 7 })], { branch: 'B', selectedDiscount: { promotionId: custom.id, version: edited.version } })).rejects.toMatchObject({ code: 'PROMOTION_CHANGED' });
    // A forged unit amount against the current version is refused too.
    await expect(sale([fries(1, { ...ack, unitDiscount: 50 })], { selectedDiscount: { promotionId: custom.id, version: edited.version } })).rejects.toMatchObject({ code: 'PROMOTION_CHANGED' });
    const disabled = await discountsService.setPromotionEnabled(supA(), custom.id, { is_enabled: false, expected_version: edited.version }, null);
    await expect(sale([fries(1, { ...ack, unitDiscount: 7 })], { selectedDiscount: { promotionId: custom.id, version: disabled.version } })).rejects.toMatchObject({ code: 'PROMOTION_CHANGED' });
    expect(await noTrace()).toEqual(trace);

    // History: the committed sale keeps its ₱5 discount after the edit and disable.
    const stored = await prisma.transaction.findUniqueOrThrow({ where: { id: first.id } });
    expect(stored.totalAmount.toNumber()).toBe(107);
    const receipt = await receiptsService.getPublicReceipt(stored.transactionNumber);
    expect(receipt).toMatchObject({ total_amount: 107, discount_amount: 5 });
  });

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
  it('VAT registration: unconfirmed by default and visible; only a Super Admin records it; non-VAT is refused; sales snapshot what applied', async () => {
    const before = await settingsService.getBranchDiscountSettings(ids.branchA, supA());
    expect(before.taxProfile).toMatchObject({ vatRegistration: 'unconfirmed', calculatedAs: 'vat_registered', updatedAt: null });
    expect(before.canEditTaxProfile).toBe(false);
    expect(await settingsService.getTaxConfiguration(staffA(), undefined)).toMatchObject({ scope: 'branch', vatRegistration: 'unconfirmed', vatRatePercent: 12 });

    const earlier = await sale([fries(1)]);
    expect(await storedSnapshot(earlier.id)).toMatchObject({ vat_registration: 'unconfirmed', calculated_as: 'vat_registered' });

    await expect(settingsService.updateBranchTaxProfile(ids.branchA, { vatRegistration: 'vat_registered', note: null, expectedUpdatedAt: null }, supA(), null)).rejects.toMatchObject({ code: 'TAX_PROFILE_ADMIN_ONLY', statusCode: 403 });
    await expect(settingsService.updateBranchTaxProfile(ids.branchA, { vatRegistration: 'non_vat_registered', note: null, expectedUpdatedAt: null }, admin(), null)).rejects.toMatchObject({ code: 'TAX_TREATMENT_NOT_SUPPORTED', statusCode: 422 });
    expect(await prisma.systemSetting.count({ where: { key: `tax_profile:branch:${ids.branchA}` } })).toBe(0);

    const saved = await settingsService.updateBranchTaxProfile(ids.branchA, { vatRegistration: 'vat_registered', note: 'COR seen', expectedUpdatedAt: null }, admin(), null);
    expect(saved).toMatchObject({ vatRegistration: 'vat_registered', note: 'COR seen' });
    await expect(settingsService.updateBranchTaxProfile(ids.branchA, { vatRegistration: 'unconfirmed', note: null, expectedUpdatedAt: null }, admin(), null)).rejects.toMatchObject({ code: 'SETTINGS_CHANGED' });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'BRANCH_TAX_PROFILE_UPDATED', branchId: ids.branchA } });
    expect(audit).toMatchObject({ actorId: ids.admin, beforeState: expect.objectContaining({ vatRegistration: 'unconfirmed' }), afterState: expect.objectContaining({ vatRegistration: 'vat_registered' }) });

    const later = await sale([fries(1)]);
    expect(later).toMatchObject({ total_amount: 112, vat_amount: 12 });
    expect(await storedSnapshot(later.id)).toMatchObject({ vat_registration: 'vat_registered' });
    // The earlier sale's snapshot and amounts are unchanged.
    expect(await storedSnapshot(earlier.id)).toMatchObject({ vat_registration: 'unconfirmed' });
    expect((await settingsService.getBranchDiscountSettings(ids.branchB, supB())).taxProfile.vatRegistration).toBe('unconfirmed');
  });
});
