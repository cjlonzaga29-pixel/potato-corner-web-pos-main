import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';

/**
 * POS-PERF-P55 — manual peso discounts, supervisor discount types and proof
 * photos, through the real Express app against a real Postgres:
 *
 *   - supervisor branch isolation for type management (other branch, forged
 *     JWT branch claim, staff, super_admin), statutory names reserved,
 *     duplicate names, stale saves, audit before/after, deactivate (never
 *     delete) and the POS offer list;
 *   - no discount and a manual ₱ discount in the new flow, with the VAT path
 *     unchanged (commercial/taxable) and the statutory PWD formula unchanged;
 *   - invalid, over-subtotal and changed-total amounts refused with nothing
 *     written;
 *   - proof required, uploaded through the real route, bound to cashier +
 *     branch + shift, consumed exactly once, kept after a failed sale;
 *   - idempotent retry / lost-response recovery never applies the amount twice;
 *   - no automatic promotion in the new flow, legacy clients unchanged;
 *   - offline sync refuses a queued manual discount visibly;
 *   - history (name snapshot), reports (own 'manual' group), refunds and
 *     inventory reservation.
 *
 * Supabase Storage is replaced by an in-memory bucket (no network); the
 * upload route, multer limits, sharp conversion and the registry row are real.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const storedObjects = new Map<string, number>();
vi.mock('../../lib/notify.js', () => ({ notifyBranch: vi.fn(), notifySuperAdmin: vi.fn(), notifyUser: vi.fn() }));
// P55R2 — this suite now makes more than the general limiter's 100 requests a
// minute from one IP (it runs before authentication); only that limiter is
// bypassed here. Route-specific limiters (login, PIN, receipts) stay real.
vi.mock('../../middleware/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middleware/rate-limiter.js')>()),
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../lib/supabase.js', () => ({
  supabaseAdmin: {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, body: Buffer) => {
          storedObjects.set(`${bucket}/${path}`, body.length);
          return { data: { path }, error: null };
        },
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `http://storage.test/${bucket}/${path}?token=t` }, error: null }),
      }),
    },
  },
}));

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { discountsService } = await import('../discounts/discounts.service.js');
const { reportsRepository } = await import('../reports/reports.repository.js');
const { generateStaffToken, generateSupervisorToken, generateSuperAdminToken, generateBranchToken } = await import('../../test-utils/auth-tokens.js');

type ApiBody = { data: Record<string, unknown> | null; error: { code: string; message?: string; details?: unknown } | null };

describe.skipIf(!isLocalDatabase)('P55 manual peso discounts (real Express + Postgres)', () => {
  const tag = randomUUID().slice(0, 8);
  const ids = {
    branchA: '', branchB: '', supA: '', supB: '', supForged: '', admin: '', ana: '', ben: '', cara: '', branchUser: '',
    unit: '', potato: '', product: '', variant: '', promoProduct: '', promoVariant: '',
  };
  const tokens = { ana: '', ben: '', cara: '', supA: '', supB: '', supForged: '', admin: '', branch: '' };
  const promotionIds: string[] = [];
  let server: Server;
  let baseUrl = '';
  let setupSucceeded = false;
  let png: Buffer;

  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Device-ID': `p55-${tag}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as ApiBody };
  }

  async function uploadProof(token: string, branchId: string) {
    const form = new FormData();
    form.set('branch_id', branchId);
    form.set('type', 'live_capture');
    form.set('proof', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'customer-id.png');
    const res = await fetch(`${baseUrl}/api/transactions/discount-proof`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, body: (await res.json()) as ApiBody };
  }

  const item = (quantity = 2) => ({ product_id: ids.product, product_variant_id: ids.variant, quantity, promotion: null });
  // P55R2 — what the new checkout sends for every sale except the statutory discount.
  const MANUAL_TOTAL_BASIS = { calculation_mode: 'manual_total_v1', vat_rate: null, discount_rate: null };

  function manualSale(
    token: string,
    opts: {
      key?: string;
      manual?: Record<string, unknown> | null;
      choice?: 'none_applicable' | 'selected' | null;
      items?: unknown[];
      cash?: number;
      extra?: Record<string, unknown>;
    } = {},
  ) {
    return call('POST', '/api/transactions', token, {
      branch_id: ids.branchA,
      items: opts.items ?? [item()],
      payment_method: 'cash',
      cash_tendered: opts.cash ?? 1000,
      is_offline_transaction: false,
      idempotency_key: opts.key ?? randomUUID(),
      tax_basis: MANUAL_TOTAL_BASIS,
      discount_flow: 'manual_v1',
      ...(opts.choice === null ? {} : { discount_choice: opts.choice ?? (opts.manual ? 'selected' : 'none_applicable') }),
      // The rollback fence: a manual discount always travels with discount_type 'manual'.
      ...(opts.manual ? { discount_type: 'manual', manual_discount: opts.manual } : {}),
      ...opts.extra,
    });
  }

  async function saleCount() {
    return prisma.transaction.count({ where: { branchId: ids.branchA } });
  }

  async function availableStock() {
    const stock = await prisma.inventoryStock.findFirstOrThrow({ where: { branchId: ids.branchA, inventoryItemId: ids.potato } });
    return stock.quantityOnHand.toNumber() - stock.quantityReserved.toNumber();
  }

  beforeAll(async () => {
    png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer();
    for (const key of ['branchA', 'branchB'] as const) {
      ids[key] = (await prisma.branch.create({ data: { name: `P55 ${key} ${tag}`, code: `P55${key.slice(-1)}-${tag}`, address: 'x', city: 'x', status: 'active' } })).id;
    }
    const mk = async (role: 'staff' | 'supervisor' | 'branch' | 'super_admin', first: string) =>
      (
        await prisma.user.create({
          data: { role, firstName: first, lastName: `P55${tag}`, email: `${first.toLowerCase()}-${tag}@p55.test`, employeeId: role === 'staff' ? `P55-${first}-${tag}` : null, employmentType: 'regular', mustChangePassword: false },
        })
      ).id;
    ids.ana = await mk('staff', 'Ana');
    ids.ben = await mk('staff', 'Ben');
    ids.cara = await mk('staff', 'Cara');
    ids.supA = await mk('supervisor', 'SupA');
    ids.supB = await mk('supervisor', 'SupB');
    ids.supForged = await mk('supervisor', 'SupForged');
    ids.admin = await mk('super_admin', 'Admin');
    ids.branchUser = await mk('branch', 'Counter');
    await prisma.userBranchAssignment.createMany({
      data: [
        { userId: ids.ana, branchId: ids.branchA },
        { userId: ids.ben, branchId: ids.branchA },
        { userId: ids.cara, branchId: ids.branchB },
        { userId: ids.supA, branchId: ids.branchA },
        { userId: ids.supB, branchId: ids.branchB },
        { userId: ids.supForged, branchId: ids.branchB },
        { userId: ids.branchUser, branchId: ids.branchA },
      ],
    });
    ids.unit = (await prisma.unitOfMeasure.create({ data: { code: `p55-g-${tag}`, name: 'P55 Gram', dimension: 'WEIGHT', isBaseUnit: true } })).id;
    ids.potato = (await prisma.inventoryItem.create({ data: { name: `P55 potato ${tag}`, baseUnitId: ids.unit } })).id;
    for (const branchId of [ids.branchA, ids.branchB]) await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: ids.potato, quantityOnHand: 1000000 } });
    ids.product = (await prisma.product.create({ data: { name: `P55 Fries ${tag}`, status: 'active', classification: 'regular' } })).id;
    ids.variant = (await prisma.productVariant.create({ data: { productId: ids.product, name: 'Mega', sizeLabel: 'Mega', basePrice: 250, isActive: true } })).id;
    await prisma.productComponent.create({ data: { productVariantId: ids.variant, inventoryItemId: ids.potato, quantityRequired: 100 } });
    ids.promoProduct = (await prisma.product.create({ data: { name: `P55 Promo ${tag}`, status: 'active', classification: 'promotional' } })).id;
    ids.promoVariant = (await prisma.productVariant.create({ data: { productId: ids.promoProduct, name: 'Regular', sizeLabel: 'Regular', basePrice: 100, isActive: true } })).id;
    await prisma.productComponent.create({ data: { productVariantId: ids.promoVariant, inventoryItemId: ids.potato, quantityRequired: 50 } });
    for (const branchId of [ids.branchA, ids.branchB]) {
      await prisma.branchProductAvailability.createMany({ data: [{ branchId, productId: ids.product, isAvailable: true }, { branchId, productId: ids.promoProduct, isAvailable: true }] });
    }
    for (const employeeId of [ids.ana, ids.ben]) {
      await prisma.attendanceRecord.create({ data: { employeeId, branchId: ids.branchA, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });
    }
    await prisma.attendanceRecord.create({ data: { employeeId: ids.cara, branchId: ids.branchB, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });
    tokens.ana = generateStaffToken(ids.branchA, { userId: ids.ana });
    tokens.ben = generateStaffToken(ids.branchA, { userId: ids.ben });
    tokens.cara = generateStaffToken(ids.branchB, { userId: ids.cara });
    tokens.supA = generateSupervisorToken([ids.branchA], { userId: ids.supA });
    tokens.supB = generateSupervisorToken([ids.branchB], { userId: ids.supB });
    // Forged claim: the JWT says branch A, the live assignment is branch B only.
    tokens.supForged = generateSupervisorToken([ids.branchA, ids.branchB], { userId: ids.supForged });
    tokens.admin = generateSuperAdminToken({ userId: ids.admin });
    tokens.branch = generateBranchToken(ids.branchA, { userId: ids.branchUser });

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    setupSucceeded = true;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (!setupSucceeded) return;
    const branches = [ids.branchA, ids.branchB];
    await prisma.discountProofUpload.deleteMany({ where: { branchId: { in: branches } } });
    await prisma.$executeRaw`DELETE FROM "transaction_items" WHERE "transaction_id" IN (SELECT id FROM "transactions" WHERE "branch_id" = ANY(${branches}))`;
    await prisma.$executeRaw`DELETE FROM "inventory_deduction_jobs" WHERE "branch_id" = ANY(${branches})`;
    await prisma.$executeRaw`DELETE FROM "transactions" WHERE "branch_id" = ANY(${branches})`;
    await prisma.$executeRaw`DELETE FROM "checkout_attempts" WHERE "branch_id" = ANY(${branches})`;
    await prisma.manualDiscountType.deleteMany({ where: { branchId: { in: branches } } });
    for (const id of promotionIds) {
      await prisma.promotionProduct.deleteMany({ where: { promotionId: id } });
      await prisma.promotionBranch.deleteMany({ where: { promotionId: id } });
      await prisma.promotion.delete({ where: { id } });
    }
    await prisma.attendanceRecord.deleteMany({ where: { branchId: { in: branches } } });
    await prisma.shift.deleteMany({ where: { branchId: { in: branches } } });
  });

  async function createType(token: string, branchId: string, name: string, requireProof = false, applyToPos = true) {
    return call('POST', '/api/discounts/manual-types', token, { branch_id: branchId, name, apply_to_pos: applyToPos, require_proof: requireProof });
  }

  it('supervisor discount types: branch isolation, forged claims, reserved names, stale saves, audit, deactivate', async () => {
    const created = await createType(tokens.supA, ids.branchA, 'Employee');
    expect(created.status).toBe(201);
    const typeId = created.body.data?.id as string;
    expect(created.body.data).toMatchObject({ name: 'Employee', apply_to_pos: true, require_proof: false, is_active: true, version: 1, can_edit: true });

    // Other branch's supervisor, a forged JWT branch claim, staff, Branch Account and super_admin cannot write.
    expect((await createType(tokens.supB, ids.branchA, 'Staff meal')).status).toBe(403);
    expect((await createType(tokens.supForged, ids.branchA, 'Staff meal')).body.error?.code).toBe('BRANCH_ACCESS_DENIED');
    expect((await createType(tokens.ana, ids.branchA, 'Staff meal')).status).toBe(403);
    expect((await createType(tokens.branch, ids.branchA, 'Staff meal')).status).toBe(403);
    expect((await createType(tokens.admin, ids.branchA, 'Staff meal')).status).toBe(403);
    expect((await call('PATCH', `/api/discounts/manual-types/${typeId}`, tokens.supB, { name: 'Hijack', expected_version: 1 })).status).toBe(403);
    expect((await call('PATCH', `/api/discounts/manual-types/${typeId}`, tokens.supForged, { name: 'Hijack', expected_version: 1 })).status).toBe(403);
    expect((await call('POST', `/api/discounts/manual-types/${typeId}/deactivate`, tokens.supB, { expected_version: 1 })).status).toBe(403);
    expect((await call('GET', `/api/discounts/manual-types?branch_id=${ids.branchA}`, tokens.supB)).status).toBe(403);

    // Statutory names are reserved; names are unique per branch (case-insensitive) but free across branches.
    for (const name of ['PWD', 'Senior Citizen', 'pwd discount', 'OSCA ID']) {
      const res = await createType(tokens.supA, ids.branchA, name);
      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe('STATUTORY_DISCOUNT_NAME_RESERVED');
    }
    expect((await createType(tokens.supA, ids.branchA, 'employee')).body.error?.code).toBe('MANUAL_DISCOUNT_TYPE_NAME_TAKEN');
    expect((await createType(tokens.supB, ids.branchB, 'Employee')).status).toBe(201);
    // Concurrent creates of one name (any case): the partial unique index lets exactly one through.
    const raced = await Promise.all(['Rush', 'rush', 'RUSH', 'Rush', 'Rush'].map((name) => createType(tokens.supA, ids.branchA, name, false, false)));
    expect(raced.filter((res) => res.status === 201)).toHaveLength(1);
    expect(raced.filter((res) => res.body.error?.code === 'MANUAL_DISCOUNT_TYPE_NAME_TAKEN')).toHaveLength(4);
    expect(await prisma.manualDiscountType.count({ where: { branchId: ids.branchA, isActive: true, name: { equals: 'rush', mode: 'insensitive' } } })).toBe(1);
    // An empty name is refused by validation.
    expect((await createType(tokens.supA, ids.branchA, '')).status).toBe(422);

    // Edit with stale-save protection; audit before/after.
    const edited = await call('PATCH', `/api/discounts/manual-types/${typeId}`, tokens.supA, { require_proof: true, expected_version: 1 });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ require_proof: true, version: 2 });
    const stale = await call('PATCH', `/api/discounts/manual-types/${typeId}`, tokens.supA, { require_proof: false, expected_version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe('MANUAL_DISCOUNT_TYPE_CONFLICT');
    expect((await prisma.manualDiscountType.findUniqueOrThrow({ where: { id: typeId } })).requireProof).toBe(true);
    const audits = await prisma.auditLog.findMany({ where: { entityId: typeId }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.action)).toEqual(['MANUAL_DISCOUNT_TYPE_CREATED', 'MANUAL_DISCOUNT_TYPE_UPDATED']);
    expect(audits[1]?.beforeState).toMatchObject({ require_proof: false, version: 1 });
    expect(audits[1]?.afterState).toMatchObject({ require_proof: true, version: 2 });
    await call('PATCH', `/api/discounts/manual-types/${typeId}`, tokens.supA, { require_proof: false, expected_version: 2 });

    // POS list: own branch only, active + Apply to POS only; a staff query branch_id is ignored.
    const hidden = await createType(tokens.supA, ids.branchA, 'Not on POS', false, false);
    expect(hidden.status).toBe(201);
    const posList = await call('GET', `/api/discounts/manual-types/pos?branch_id=${ids.branchB}`, tokens.ana);
    expect(posList.status).toBe(200);
    const posNames = (posList.body.data as unknown as { name: string }[]).map((t) => t.name);
    expect(posNames).toEqual(['Employee']);

    // Deactivate (never delete); deactivated types are not offered and cannot be edited.
    const temp = await createType(tokens.supA, ids.branchA, 'Temporary');
    const tempId = temp.body.data?.id as string;
    const deactivated = await call('POST', `/api/discounts/manual-types/${tempId}/deactivate`, tokens.supA, { expected_version: 1 });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.data).toMatchObject({ is_active: false, can_edit: false });
    expect((await call('PATCH', `/api/discounts/manual-types/${tempId}`, tokens.supA, { name: 'Back', expected_version: 2 })).body.error?.code).toBe('MANUAL_DISCOUNT_TYPE_INACTIVE');
    expect(await prisma.manualDiscountType.count({ where: { id: tempId } })).toBe(1);
    const listed = await call('GET', `/api/discounts/manual-types?branch_id=${ids.branchA}&include_inactive=true`, tokens.supA);
    expect((listed.body.data as unknown as { id: string; is_active: boolean }[]).find((t) => t.id === tempId)?.is_active).toBe(false);
    // A deactivated name can be reused by a new active type.
    expect((await createType(tokens.supA, ids.branchA, 'Temporary')).status).toBe(201);
    // Admin reads every branch, read-only.
    const adminList = await call('GET', `/api/discounts/manual-types?branch_id=${ids.branchA}`, tokens.admin);
    expect(adminList.status).toBe(200);
    expect((adminList.body.data as unknown as { can_edit: boolean }[]).every((t) => !t.can_edit)).toBe(true);
  });

  it('checkout: no discount, manual ₱50 off ₱500 with no VAT calculated, statutory PWD unchanged, combinations refused', async () => {
    const type = await prisma.manualDiscountType.findFirstOrThrow({ where: { branchId: ids.branchA, name: 'Employee', isActive: true } });

    const none = await manualSale(tokens.ana);
    expect(none.status).toBe(201);
    // P55R2 — no discount: amount to pay = subtotal; VAT not calculated (null, not ₱53.57 and not ₱0).
    expect(none.body.data).toMatchObject({ subtotal: 500, discount_amount: 0, discount_type: null, total_amount: 500, calculation_mode: 'manual_total_v1', vat_amount: null, vat_exempt_amount: null, manual_discount: null });

    const stockBefore = await availableStock();
    const manual = await manualSale(tokens.ana, { manual: { discount_type_id: type.id, type_version: type.version, amount: 50, expected_total_amount: 450 } });
    expect(manual.status).toBe(201);
    // P55R2 — ₱500 − ₱50 = ₱450; no VAT extracted, added or deducted.
    expect(manual.body.data).toMatchObject({ subtotal: 500, discount_amount: 50, discount_type: 'manual', total_amount: 450, calculation_mode: 'manual_total_v1', vat_amount: null, vat_exempt_amount: null, change_given: 550 });
    expect(manual.body.data?.manual_discount).toEqual({ discount_type_id: type.id, name: 'Employee', amount: 50, require_proof: false });
    // Recipe × quantity reserved (2 × 100 g), same as any sale.
    expect(stockBefore - (await availableStock())).toBe(200);
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: manual.body.data?.id as string } });
    expect(row.manualDiscountTypeId).toBe(type.id);
    expect(row.discountRateUsed).toBeNull();
    expect(row.cashierId).toBe(ids.ana);
    expect(row.manualDiscountSnapshot).toMatchObject({ version: 2, source: 'manual', calculation_mode: 'manual_total_v1', name: 'Employee', amount: 50, eligible_subtotal: 500, type_version: type.version, entered_by_id: ids.ana });
    // Stored distinctly from a zero-VAT/exempt result: the mode column and a snapshot with no rate and no treatment.
    expect(row.calculationMode).toBe('manual_total_v1');
    expect([row.vatAmount.toNumber(), row.vatExemptAmount.toNumber()]).toEqual([0, 0]);
    expect(row.taxSnapshot).toEqual({
      version: 2, calculation_mode: 'manual_total_v1', vat_calculated: false, vat_registration: expect.any(String), discount_flow: 'manual_v1',
      discount_source: 'manual', manual_discount_type_id: type.id, require_discount_choice: false, discount_choice: 'selected',
    });
    expect(row.taxSnapshot).not.toHaveProperty('vat_rate_percent');
    expect(row.taxSnapshot).not.toHaveProperty('treatment');
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: none.body.data?.id as string } })).calculationMode).toBe('manual_total_v1');

    // The statutory PWD formula is untouched in the new flow (₱500 → ÷1.12 → −20% → ₱357.14, VAT ₱0).
    const pwd = await manualSale(tokens.ana, { choice: 'selected', extra: { discount_type: 'pwd', discount_id_reference: `PWD-${tag}`, tax_basis: { vat_rate: 12, discount_rate: 20 } } });
    expect(pwd.status).toBe(201);
    expect(pwd.body.data).toMatchObject({ discount_type: 'pwd', calculation_mode: 'legacy_vat_v1', vat_amount: 0, total_amount: 357.14, manual_discount: null });
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: pwd.body.data?.id as string } })).taxSnapshot).toMatchObject({ version: 1, calculation_mode: 'legacy_vat_v1', treatment: 'vat_exempt' });

    const before = await saleCount();
    const refusals: [Record<string, unknown>, number, string][] = [
      // PWD + manual cannot even be expressed: discount_type must be 'manual' with manual_discount.
      [{ discount_type: 'pwd', discount_id_reference: 'X', manual_discount: { discount_type_id: type.id, type_version: type.version, amount: 10 } }, 422, 'VALIDATION_ERROR'],
      [{ discount_type: 'employee', tax_basis: { vat_rate: 12, discount_rate: 20 } }, 422, 'DISCOUNT_NOT_SUPPORTED_IN_MANUAL_FLOW'],
      [{ discount_type: 'promotional' }, 400, 'DISCOUNT_TYPE_NOT_SUPPORTED'],
    ];
    for (const [extra, status, code] of refusals) {
      const res = await manualSale(tokens.ana, { choice: 'selected', extra });
      expect(res.status, code).toBe(status);
      expect(res.body.error?.code).toBe(code);
    }
    expect((await manualSale(tokens.ana, { choice: null })).body.error?.code).toBe('DISCOUNT_CHOICE_REQUIRED');
    expect((await manualSale(tokens.ana, { choice: 'selected' })).body.error?.code).toBe('DISCOUNT_CHOICE_CONFLICT');
    expect((await manualSale(tokens.ana, { choice: 'none_applicable', manual: { discount_type_id: type.id, type_version: type.version, amount: 10 } })).body.error?.code).toBe('DISCOUNT_CHOICE_CONFLICT');
    // 'manual' can never be sent as a discount_type.
    expect((await manualSale(tokens.ana, { choice: 'selected', extra: { discount_type: 'manual', discount_amount: 400 } })).body.error?.code).toBe('VALIDATION_ERROR');

    // P55R2 — the calculation is explicit and cannot be forged or mixed.
    const modeRefusals: [Record<string, unknown>, string][] = [
      // The new flow without the mode (e.g. the unreleased first-pass build): never silently VAT-calculated.
      [{ tax_basis: { vat_rate: 12, discount_rate: null } }, 'CALCULATION_MODE_REQUIRED'],
      [{ tax_basis: undefined }, 'CALCULATION_MODE_REQUIRED'],
      // Statutory PWD/Senior cannot be charged as a manual total, nor without a basis.
      [{ discount_type: 'pwd', discount_id_reference: 'PWD-X', discount_choice: 'selected' }, 'STATUTORY_DISCOUNT_REQUIRES_TAX_CALCULATION'],
      [{ discount_type: 'senior_citizen', discount_id_reference: 'SC-X', discount_choice: 'selected', tax_basis: undefined }, 'CALCULATION_MODE_REQUIRED'],
      // Unknown or inconsistent modes are refused by validation.
      [{ tax_basis: { calculation_mode: 'no_vat', vat_rate: null, discount_rate: null } }, 'VALIDATION_ERROR'],
      [{ tax_basis: { calculation_mode: 'manual_total_v1', vat_rate: 12, discount_rate: null } }, 'VALIDATION_ERROR'],
      [{ tax_basis: { vat_rate: null, discount_rate: null } }, 'VALIDATION_ERROR'],
      // A top-level mode field is not part of the contract (stripped), so the numeric basis still needs the mode.
      [{ calculation_mode: 'manual_total_v1', tax_basis: { vat_rate: 12, discount_rate: null } }, 'CALCULATION_MODE_REQUIRED'],
    ];
    for (const [extra, code] of modeRefusals) {
      expect((await manualSale(tokens.ben, { extra })).body.error?.code, JSON.stringify(extra)).toBe(code);
    }
    // A legacy client cannot claim the manual total (it would skip the new flow's rules).
    const legacyClaim = await call('POST', '/api/transactions', tokens.ben, {
      branch_id: ids.branchA, items: [item()], payment_method: 'cash', cash_tendered: 1000, is_offline_transaction: false, tax_basis: MANUAL_TOTAL_BASIS,
    });
    expect(legacyClaim.body.error?.code).toBe('CALCULATION_MODE_NOT_SUPPORTED');
    expect(await saleCount()).toBe(before);

    // Old web -> new API: no flow, numeric basis -> the documented legacy VAT calculation, recorded as such.
    const oldWeb = await call('POST', '/api/transactions', tokens.ben, {
      branch_id: ids.branchA, items: [item()], payment_method: 'cash', cash_tendered: 1000, is_offline_transaction: false, tax_basis: { vat_rate: 12, discount_rate: null },
    });
    expect(oldWeb.status).toBe(201);
    expect(oldWeb.body.data).toMatchObject({ total_amount: 500, vat_amount: 53.57, vat_exempt_amount: 0, calculation_mode: 'legacy_vat_v1' });
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: oldWeb.body.data?.id as string } })).calculationMode).toBe('legacy_vat_v1');
  });

  it('amounts: invalid, over-subtotal and changed totals are refused with nothing written; the full subtotal is allowed', async () => {
    const type = await prisma.manualDiscountType.findFirstOrThrow({ where: { branchId: ids.branchA, name: 'Employee', isActive: true } });
    const md = (amount: unknown, extra: Record<string, unknown> = {}) => ({ discount_type_id: type.id, type_version: type.version, amount, ...extra });
    const before = await saleCount();
    const stock = await availableStock();
    for (const amount of [0, -5, 10.005, '50', 1e12]) {
      expect((await manualSale(tokens.ana, { manual: md(amount) })).body.error?.code, String(amount)).toBe('VALIDATION_ERROR');
    }
    const over = await manualSale(tokens.ana, { manual: md(500.01) });
    expect(over.status).toBe(422);
    expect(over.body.error?.code).toBe('MANUAL_DISCOUNT_EXCEEDS_SUBTOTAL');
    expect(over.body.error?.details).toMatchObject({ eligible_subtotal: 500 });
    // The screen showed ₱450, but the cart now prices differently (one item): refused, not charged.
    const changed = await manualSale(tokens.ana, { manual: md(50, { expected_total_amount: 450 }), items: [item(1)] });
    expect(changed.status).toBe(409);
    expect(changed.body.error?.code).toBe('MANUAL_DISCOUNT_TOTAL_CHANGED');
    expect(changed.body.error?.details).toMatchObject({ amounts: { total_amount: 200 } });
    // Forged client totals are never read.
    const forged = await manualSale(tokens.ana, { manual: md(50), extra: { discount_amount: 499, total_amount: 1 } as Record<string, unknown> });
    expect(forged.status).toBe(201);
    expect(forged.body.data).toMatchObject({ discount_amount: 50, total_amount: 450 });
    expect(await saleCount()).toBe(before + 1);
    expect(stock - (await availableStock())).toBe(200);
    // Exactly the subtotal → ₱0 to pay.
    const full = await manualSale(tokens.ana, { manual: md(500), cash: 0 });
    expect(full.status).toBe(201);
    expect(full.body.data).toMatchObject({ total_amount: 0, vat_amount: null, discount_amount: 500 });

    // P55R2 — no VATable cap: on a size whose VAT cap leaves ₱100 non-VATable, the whole subtotal can still be discounted.
    await prisma.productVariant.update({ where: { id: ids.variant }, data: { vatableCapAmount: 200 } });
    try {
      const capped = await manualSale(tokens.ben, { manual: md(450) });
      expect(capped.status).toBe(201);
      expect(capped.body.data).toMatchObject({ subtotal: 500, discount_amount: 450, total_amount: 50, vat_amount: null, vat_exempt_amount: null });
      expect((await manualSale(tokens.ben, { manual: md(500.01) })).body.error?.code).toBe('MANUAL_DISCOUNT_EXCEEDS_SUBTOTAL');
      // The legacy calculation of the same cart is unchanged (₱400 VATable, ₱100 non-VATable).
      const legacy = await call('POST', '/api/transactions', tokens.ben, {
        branch_id: ids.branchA, items: [item()], payment_method: 'cash', cash_tendered: 1000, is_offline_transaction: false, tax_basis: { vat_rate: 12, discount_rate: null },
      });
      expect(legacy.body.data).toMatchObject({ total_amount: 500, vat_amount: 42.86, vat_exempt_amount: 100, calculation_mode: 'legacy_vat_v1' });
    } finally {
      await prisma.productVariant.update({ where: { id: ids.variant }, data: { vatableCapAmount: null } });
    }
    // Centavo rounding: ₱500 − ₱0.29 = ₱499.71 exactly.
    expect((await manualSale(tokens.ben, { manual: md(0.29) })).body.data).toMatchObject({ discount_amount: 0.29, total_amount: 499.71 });
  });

  it('proof: required, bound to cashier/branch/shift, consumed once, kept after a failed sale; legacy keys must be own-branch', async () => {
    const created = await createType(tokens.supA, ids.branchA, 'Loyalty card', true);
    const type = created.body.data as { id: string; version: number };
    const md = (extra: Record<string, unknown> = {}) => ({ discount_type_id: type.id, type_version: type.version, amount: 20, ...extra });
    const before = await saleCount();

    expect((await manualSale(tokens.ana, { manual: md() })).body.error?.code).toBe('MANUAL_DISCOUNT_PROOF_REQUIRED');
    expect((await manualSale(tokens.ana, { manual: md({ proof_upload_id: randomUUID() }) })).body.error?.code).toBe('MANUAL_DISCOUNT_PROOF_INVALID');

    // Real upload route: multer + sharp + registry row. Only an id comes back for checkout.
    const upload = await uploadProof(tokens.ana, ids.branchA);
    expect(upload.status).toBe(200);
    const uploadId = upload.body.data?.discount_proof_upload_id as string;
    expect(uploadId).toMatch(/^[0-9a-f-]{36}$/);
    const registered = await prisma.discountProofUpload.findUniqueOrThrow({ where: { id: uploadId } });
    expect(registered).toMatchObject({ branchId: ids.branchA, uploadedById: ids.ana, transactionId: null });
    expect(storedObjects.has(`discount-proofs/${registered.storageKey}`)).toBe(true);
    // Wrong file type refused by the route.
    const form = new FormData();
    form.set('branch_id', ids.branchA);
    form.set('type', 'gallery_upload');
    form.set('proof', new Blob(['not an image'], { type: 'text/plain' }), 'id.txt');
    const badType = await fetch(`${baseUrl}/api/transactions/discount-proof`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.ana}` }, body: form });
    expect(badType.status).toBe(422);

    // Ben cannot use Ana's proof; a proof from another branch's cashier is refused too.
    expect((await manualSale(tokens.ben, { manual: md({ proof_upload_id: uploadId }) })).body.error?.code).toBe('MANUAL_DISCOUNT_PROOF_INVALID');
    const caraUpload = await uploadProof(tokens.cara, ids.branchB);
    expect((await manualSale(tokens.ana, { manual: md({ proof_upload_id: caraUpload.body.data?.discount_proof_upload_id }) })).body.error?.code).toBe('MANUAL_DISCOUNT_PROOF_INVALID');
    // Cara cannot upload for branch A at all (branch guard).
    expect((await uploadProof(tokens.cara, ids.branchA)).status).toBe(403);

    // A failed sale (cash short) keeps the proof unattached; the replacement sale uses it.
    const short = await manualSale(tokens.ana, { manual: md({ proof_upload_id: uploadId }), cash: 10 });
    expect(short.body.error?.code).toBe('INSUFFICIENT_CASH_TENDERED');
    expect((await prisma.discountProofUpload.findUniqueOrThrow({ where: { id: uploadId } })).transactionId).toBeNull();
    const ok = await manualSale(tokens.ana, { manual: md({ proof_upload_id: uploadId }) });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ has_discount_proof: true, discount_proof_type: 'live_capture', total_amount: 480 });
    expect(JSON.stringify(ok.body.data)).not.toContain(registered.storageKey);
    const sale = await prisma.transaction.findUniqueOrThrow({ where: { id: ok.body.data?.id as string } });
    expect(sale.discountProofKey).toBe(registered.storageKey);
    expect((await prisma.discountProofUpload.findUniqueOrThrow({ where: { id: uploadId } })).transactionId).toBe(sale.id);

    // The same proof can never attach to a second sale.
    expect((await manualSale(tokens.ana, { manual: md({ proof_upload_id: uploadId }) })).body.error?.code).toBe('MANUAL_DISCOUNT_PROOF_ALREADY_USED');
    // Authorized viewing still goes through the branch-scoped signed URL.
    expect((await call('GET', `/api/transactions/${sale.id}/discount-proof`, tokens.supA)).status).toBe(200);
    expect((await call('GET', `/api/transactions/${sale.id}/discount-proof`, tokens.supB)).status).toBe(403);
    expect(await saleCount()).toBe(before + 1);

    // A legacy statutory key pointing at another branch's object is refused (pre-P55 it was attached as-is).
    const legacyForged = await call('POST', '/api/transactions', tokens.ana, {
      branch_id: ids.branchA, items: [item()], payment_method: 'cash', cash_tendered: 1000, is_offline_transaction: false,
      discount_type: 'senior_citizen', discount_id_reference: 'SC-1', discount_proof_key: `${ids.branchB}/x/y.webp`, discount_proof_type: 'live_capture',
    });
    expect(legacyForged.body.error?.code).toBe('DISCOUNT_PROOF_INVALID');
  });

  it('legacy statutory proof keys: only a registered, unused upload by this cashier/branch/shift; real old-client uploads still work', async () => {
    const legacySale = (token: string, key: string, idempotencyKey: string = randomUUID()) =>
      call('POST', '/api/transactions', token, {
        branch_id: ids.branchA, items: [item(1)], payment_method: 'cash', cash_tendered: 1000, is_offline_transaction: false, idempotency_key: idempotencyKey,
        discount_type: 'pwd', discount_id_reference: 'PWD-LEGACY', discount_proof_key: key, discount_proof_type: 'live_capture',
      });
    const before = await saleCount();
    // Made up under the sale's own branch prefix, and a traversal out of it: refused (both were attached before this fix).
    expect((await legacySale(tokens.ana, `${ids.branchA}/made-up/anything.webp`)).body.error?.code).toBe('DISCOUNT_PROOF_INVALID');
    expect((await legacySale(tokens.ana, `${ids.branchA}/../${ids.branchB}/x.webp`)).body.error?.code).toBe('DISCOUNT_PROOF_INVALID');
    // Ana's real upload: Ben cannot attach it; Ana can, exactly once; a same-key retry replays the sale.
    const upload = await uploadProof(tokens.ana, ids.branchA);
    const key = upload.body.data?.discount_proof_key as string;
    expect((await legacySale(tokens.ben, key)).body.error?.code).toBe('DISCOUNT_PROOF_INVALID');
    const idempotencyKey = randomUUID();
    const ok = await legacySale(tokens.ana, key, idempotencyKey);
    expect(ok.status).toBe(201);
    // Legacy PWD formula unchanged: ₱250 → base 223.21, 20% off → ₱178.57, VAT ₱0.
    expect(ok.body.data).toMatchObject({ discount_type: 'pwd', has_discount_proof: true, total_amount: 178.57, vat_amount: 0 });
    const replay = await legacySale(tokens.ana, key, idempotencyKey);
    expect(replay.body.data?.id).toBe(ok.body.data?.id);
    const second = await legacySale(tokens.ana, key);
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe('DISCOUNT_PROOF_ALREADY_USED');
    expect((await prisma.discountProofUpload.findUniqueOrThrow({ where: { storageKey: key } })).transactionId).toBe(ok.body.data?.id);
    expect(await saleCount()).toBe(before + 1);
  });

  it('idempotency: same-key retry and lost-response resolve never apply the amount twice; a changed discount under the same key is refused', async () => {
    const type = await prisma.manualDiscountType.findFirstOrThrow({ where: { branchId: ids.branchA, name: 'Employee', isActive: true } });
    const key = randomUUID();
    const md = (amount: number) => ({ discount_type_id: type.id, type_version: type.version, amount });
    const first = await manualSale(tokens.ana, { key, manual: md(75) });
    expect(first.status).toBe(201);
    const retry = await manualSale(tokens.ana, { key, manual: md(75) });
    expect(retry.status).toBe(201);
    expect(retry.body.data?.id).toBe(first.body.data?.id);
    expect(retry.body.data).toMatchObject({ discount_amount: 75, total_amount: 425 });
    expect((await manualSale(tokens.ana, { key, manual: md(80) })).body.error?.code).toBe('IDEMPOTENCY_KEY_REUSE');
    expect((await manualSale(tokens.ana, { key })).body.error?.code).toBe('IDEMPOTENCY_KEY_REUSE');
    // P55R2 — nor under the other calculation: a no-discount manual total replayed by a VAT-calculating client is refused.
    const totalKey = randomUUID();
    expect((await manualSale(tokens.ben, { key: totalKey })).status).toBe(201);
    const asLegacy = await call('POST', '/api/transactions', tokens.ben, {
      branch_id: ids.branchA, items: [item()], payment_method: 'cash', cash_tendered: 1000, is_offline_transaction: false, idempotency_key: totalKey, tax_basis: { vat_rate: 12, discount_rate: null },
    });
    expect(asLegacy.body.error?.code).toBe('IDEMPOTENCY_KEY_REUSE');
    expect(await prisma.transaction.count({ where: { idempotencyKey: totalKey } })).toBe(1);
    const resolved = await call('GET', `/api/transactions/by-idempotency-key/${key}?branch_id=${ids.branchA}`, tokens.branch);
    expect(resolved.status).toBe(200);
    expect(JSON.stringify(resolved.body.data)).toContain(first.body.data?.id as string);
    expect(await prisma.transaction.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it('promotions: never applied in the new flow; legacy clients keep pre-P55 behavior', async () => {
    const supA = { user_id: ids.supA, role: 'supervisor' as const, email: 'x', branch_ids: [ids.branchA], iat: 0, exp: 0 };
    const promotion = await discountsService.createPromotion(
      supA,
      { name: `P55 auto ${tag}`, discount_kind: 'fixed_amount', discount_value: 10, is_enabled: true, product_ids: [ids.promoProduct], branch_ids: [ids.branchA] },
      null,
    );
    promotionIds.push(promotion.id);
    const promoItem = { product_id: ids.promoProduct, product_variant_id: ids.promoVariant, quantity: 1 };

    // Legacy client: the automatic promotion still applies, exactly as before.
    const legacy = await call('POST', '/api/transactions', tokens.ana, {
      branch_id: ids.branchA, items: [{ ...promoItem, promotion: { promotion_id: promotion.id, unit_discount: 10 } }], payment_method: 'cash', cash_tendered: 1000,
      is_offline_transaction: false, tax_basis: { vat_rate: 12, discount_rate: null },
    });
    expect(legacy.status).toBe(201);
    expect(legacy.body.data).toMatchObject({ discount_type: 'promotional', discount_amount: 10, total_amount: 90, vat_amount: 9.64, calculation_mode: 'legacy_vat_v1' });

    // New flow: a line claiming the promotion is refused; without it nothing is deducted automatically.
    const claimed = await manualSale(tokens.ana, { items: [{ ...promoItem, promotion: { promotion_id: promotion.id, unit_discount: 10 } }] });
    expect(claimed.body.error?.code).toBe('PROMOTION_NOT_APPLIED_IN_MANUAL_FLOW');
    const plain = await manualSale(tokens.ana, { items: [{ ...promoItem, promotion: null }] });
    expect(plain.body.data).toMatchObject({ discount_type: null, discount_amount: 0, total_amount: 100, vat_amount: null });
    const type = await prisma.manualDiscountType.findFirstOrThrow({ where: { branchId: ids.branchA, name: 'Employee', isActive: true } });
    const withManual = await manualSale(tokens.ana, { items: [{ ...promoItem, promotion: null }], manual: { discount_type_id: type.id, type_version: type.version, amount: 5 } });
    expect(withManual.body.data).toMatchObject({ discount_type: 'manual', discount_amount: 5, total_amount: 95 });
    const lines = await prisma.transactionItem.findMany({ where: { transactionId: withManual.body.data?.id as string } });
    expect(lines.every((l) => l.discountAmount.toNumber() === 0 && l.promotionId === null)).toBe(true);
    // Classification untouched.
    expect((await prisma.product.findUniqueOrThrow({ where: { id: ids.promoProduct } })).classification).toBe('promotional');
    // A manual discount without the flow flag is refused by validation (old field meanings never change).
    const noFlow = await call('POST', '/api/transactions', tokens.ana, {
      branch_id: ids.branchA, items: [item()], payment_method: 'cash', cash_tendered: 1000, is_offline_transaction: false,
      manual_discount: { discount_type_id: type.id, type_version: type.version, amount: 5 },
    });
    expect(noFlow.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('type changes: deactivated or edited types are refused at checkout; history keeps its snapshot', async () => {
    const created = await createType(tokens.supA, ids.branchA, 'Barkada');
    const type = created.body.data as { id: string; version: number };
    const sold = await manualSale(tokens.ana, { manual: { discount_type_id: type.id, type_version: 1, amount: 30 } });
    expect(sold.status).toBe(201);

    await call('PATCH', `/api/discounts/manual-types/${type.id}`, tokens.supA, { name: 'Barkada Promo', expected_version: 1 });
    const stale = await manualSale(tokens.ana, { manual: { discount_type_id: type.id, type_version: 1, amount: 30 } });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe('MANUAL_DISCOUNT_TYPE_CHANGED');
    // The earlier sale still reads the name it was rung with.
    const history = await call('GET', `/api/transactions/${sold.body.data?.id as string}`, tokens.supA);
    expect((history.body.data?.manual_discount as { name: string }).name).toBe('Barkada');
    const receipt = await fetch(`${baseUrl}/api/receipts/${sold.body.data?.receipt_number as string}`);
    const receiptBody = (await receipt.json()) as ApiBody;
    expect(receiptBody.data).toMatchObject({ discount_type: 'manual', manual_discount_name: 'Barkada', discount_amount: 30, calculation_mode: 'manual_total_v1', vat_amount: null, vat_exempt_amount: null });

    await call('POST', `/api/discounts/manual-types/${type.id}/deactivate`, tokens.supA, { expected_version: 2 });
    const gone = await manualSale(tokens.ana, { manual: { discount_type_id: type.id, type_version: 3, amount: 30 } });
    expect(gone.body.error?.code).toBe('MANUAL_DISCOUNT_TYPE_UNAVAILABLE');
    // Branch B's type cannot be used at branch A.
    const other = await prisma.manualDiscountType.findFirstOrThrow({ where: { branchId: ids.branchB, name: 'Employee' } });
    expect((await manualSale(tokens.ana, { manual: { discount_type_id: other.id, type_version: other.version, amount: 5 } })).body.error?.code).toBe('MANUAL_DISCOUNT_TYPE_UNAVAILABLE');
    const listed = await call('GET', `/api/discounts/manual-types?branch_id=${ids.branchA}&include_inactive=true`, tokens.supA);
    expect((listed.body.data as unknown as { id: string; sale_count: number }[]).find((t) => t.id === type.id)?.sale_count).toBe(1);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: sold.body.data?.id as string } })).totalAmount.toNumber()).toBe(470);
  });

  it('offline: a queued manual discount is refused visibly while other queued sales sync', async () => {
    const type = await prisma.manualDiscountType.findFirstOrThrow({ where: { branchId: ids.branchA, name: 'Employee', isActive: true } });
    const base = { items: [item(1)], payment_method: 'cash', cash_tendered: 1000, client_created_at: Date.now() - 60_000, tax_basis: MANUAL_TOTAL_BASIS };
    const legacyBasis = { vat_rate: 12, discount_rate: null };
    const res = await call('POST', '/api/transactions/sync-offline', tokens.ana, {
      branch_id: ids.branchA,
      transactions: [
        { ...base, offline_provisional_number: `PC-P55-${tag}-OFFLINE-0001`, discount_flow: 'manual_v1', manual_discount: { discount_type_id: type.id, type_version: type.version, amount: 10 } },
        { ...base, offline_provisional_number: `PC-P55-${tag}-OFFLINE-0002`, discount_flow: 'manual_v1', discount_choice: 'none_applicable' },
        // P55R2 — an old queued sale keeps its original VAT calculation.
        { ...base, offline_provisional_number: `PC-P55-${tag}-OFFLINE-0003`, tax_basis: legacyBasis },
        // P55R2 — a new-flow sale queued without the mode is never converted to the VAT calculation: refused visibly.
        { ...base, offline_provisional_number: `PC-P55-${tag}-OFFLINE-0004`, discount_flow: 'manual_v1', discount_choice: 'none_applicable', tax_basis: legacyBasis },
      ],
    });
    expect(res.status).toBe(200);
    const results = res.body.data?.results as { offline_provisional_number: string; status: string; error?: { code: string; message?: string } }[];
    expect(results[0]).toMatchObject({ status: 'failed', error: { code: 'MANUAL_DISCOUNT_OFFLINE_UNSUPPORTED' } });
    expect(results[0]?.error?.message).toContain('not recorded');
    expect(results[1]).toMatchObject({ status: 'synced', transaction: { total_amount: 250, calculation_mode: 'manual_total_v1', vat_amount: null } });
    expect(results[2]).toMatchObject({ status: 'synced', transaction: { total_amount: 250, calculation_mode: 'legacy_vat_v1', vat_amount: 26.79 } });
    expect(results[3]).toMatchObject({ status: 'failed', error: { code: 'CALCULATION_MODE_REQUIRED' } });
    expect(results[3]?.error?.message).toContain('not recorded');
    for (const n of ['0001', '0004']) expect(await prisma.transaction.count({ where: { offlineProvisionalNumber: `PC-P55-${tag}-OFFLINE-${n}` } })).toBe(0);
    // A retried sync of the same queued sale (lost response) returns the same sale, never a duplicate.
    const firstId = (results[1] as unknown as { transaction: { id: string } }).transaction.id;
    const again = await call('POST', '/api/transactions/sync-offline', tokens.ana, {
      branch_id: ids.branchA,
      transactions: [{ ...base, offline_provisional_number: `PC-P55-${tag}-OFFLINE-0002`, discount_flow: 'manual_v1', discount_choice: 'none_applicable' }],
    });
    expect((again.body.data?.results as { status: string; transaction?: { id: string } }[])[0]?.transaction?.id).toBe(firstId);
    expect(await prisma.transaction.count({ where: { offlineProvisionalNumber: `PC-P55-${tag}-OFFLINE-0002` } })).toBe(1);
  });

  it('reports and refunds: manual sales are their own group and stored totals reconcile', async () => {
    const rows = await reportsRepository.getDiscountCompliance({ branchId: ids.branchA } as Parameters<typeof reportsRepository.getDiscountCompliance>[0]);
    const manualRow = rows.find((r) => r.discount_type === 'manual');
    const manualSales = await prisma.transaction.findMany({ where: { branchId: ids.branchA, discountType: 'manual', status: 'completed' } });
    expect(manualRow?.transaction_count).toBe(manualSales.length);
    expect(manualRow?.total_discount_amount).toBeCloseTo(manualSales.reduce((s, t) => s + t.discountAmount.toNumber(), 0), 2);
    // P55R2 — VAT not calculated: no exempt/non-VATable figure (null), not ₱0.
    expect(manualRow).toMatchObject({ calculation_mode: 'manual_total_v1', total_vat_exempt_sales: null, total_vat_exempt_amount: null });
    expect(rows.find((r) => r.discount_type === 'pwd')).toMatchObject({ calculation_mode: 'legacy_vat_v1' });
    // Daily Sales: VAT totals only VAT-calculated sales; manual-total sales are counted apart.
    const completed = await prisma.transaction.findMany({ where: { branchId: ids.branchA, status: 'completed' } });
    const daily = await reportsRepository.getDailySales({ branchId: ids.branchA, page: 1, limit: 25 });
    const sum = (list: typeof completed, f: (t: (typeof completed)[number]) => number) => Math.round(list.reduce((a, t) => a + f(t), 0) * 100) / 100;
    const notCalculated = completed.filter((t) => t.calculationMode === 'manual_total_v1');
    const calculated = completed.filter((t) => t.calculationMode !== 'manual_total_v1');
    expect(calculated.length).toBeGreaterThan(0);
    expect(daily.reduce((a, r) => a + (r.tax_not_calculated_count ?? 0), 0)).toBe(notCalculated.length);
    expect(Math.round(daily.reduce((a, r) => a + (r.tax_not_calculated_sales ?? 0), 0) * 100) / 100).toBe(sum(notCalculated, (t) => t.totalAmount.toNumber()));
    expect(Math.round(daily.reduce((a, r) => a + r.vat_total, 0) * 100) / 100).toBe(sum(calculated, (t) => t.vatAmount.toNumber()));
    const txRows = await reportsRepository.getDailySalesTransactions({ branchId: ids.branchA, page: 1, limit: 500 } as Parameters<typeof reportsRepository.getDailySalesTransactions>[0]);
    expect(txRows.some((r) => r.vat_amount === null)).toBe(true);
    expect(txRows.filter((r) => r.vat_amount === null).every((r) => r.tax_calculation === 'Not calculated (manual total)')).toBe(true);
    expect(txRows.filter((r) => r.vat_amount !== null).every((r) => r.tax_calculation === null)).toBe(true);
    expect(rows.some((r) => r.discount_type === 'pwd')).toBe(true);
    expect(rows.some((r) => r.discount_type === 'promotional')).toBe(true);
    for (const t of manualSales) expect(t.subtotal.toNumber() - t.discountAmount.toNumber()).toBeCloseTo(t.totalAmount.toNumber(), 2);

    const target = manualSales[0];
    if (!target) throw new Error('no manual sale');
    const refund = await call('POST', `/api/transactions/${target.id}/refund`, tokens.supA, { refund_reason: 'Customer returned the order' });
    expect(refund.status).toBe(200);
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.status).toBe('refunded');
    expect([after.discountAmount.toNumber(), after.totalAmount.toNumber(), after.manualDiscountTypeId]).toEqual([target.discountAmount.toNumber(), target.totalAmount.toNumber(), target.manualDiscountTypeId]);
    expect(after.manualDiscountSnapshot).toEqual(target.manualDiscountSnapshot);
    // P55R2 — refunds keep the original calculation basis; nothing is recomputed.
    expect([after.calculationMode, after.vatAmount.toNumber(), after.taxSnapshot]).toEqual([target.calculationMode, target.vatAmount.toNumber(), target.taxSnapshot]);
    const refundedView = await call('GET', `/api/transactions/${target.id}`, tokens.supA);
    expect(refundedView.body.data).toMatchObject({ status: 'refunded', calculation_mode: 'manual_total_v1', vat_amount: null });
  });
});
