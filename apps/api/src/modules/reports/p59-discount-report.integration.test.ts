import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';

/**
 * POS-PERF-P59 — the Discount Report and the saved discount name, through the
 * real Express app against a real Postgres, from checkout to report rows,
 * receipts and generated CSV/PDF files:
 *
 *   - a type named PWD reads PWD everywhere, never "Manual";
 *   - renaming or deactivating a type never changes a past sale's saved name;
 *   - several types, and same-named types at two branches, stay apart;
 *   - proof required, optional, missing and unknown; N/A with none required;
 *   - branch, date and type filters agree with exported rows and totals;
 *   - legacy and manual-total sales keep identical stored amounts;
 *   - refunds, proof access and branch access still work;
 *   - no generated export mentions VAT.
 *
 * Supabase Storage is replaced by an in-memory bucket; everything else is real.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

vi.mock('../../lib/notify.js', () => ({ notifyBranch: vi.fn(), notifySuperAdmin: vi.fn(), notifyUser: vi.fn() }));
vi.mock('../../middleware/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middleware/rate-limiter.js')>()),
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../lib/supabase.js', () => ({
  supabaseAdmin: {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => ({ data: { path }, error: null }),
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `http://storage.test/${bucket}/${path}?token=t` }, error: null }),
      }),
    },
  },
}));

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { generateStaffToken, generateSupervisorToken, generateSuperAdminToken, generateBranchToken } = await import('../../test-utils/auth-tokens.js');

type ApiBody = { data: Record<string, unknown> | null; error: { code: string; message?: string } | null };
interface ReportRow {
  branch_id: string;
  discount_key: string;
  discount_name: string;
  discount_other_names: string[];
  discount_type_id: string | null;
  transaction_count: number;
  total_discount_amount: number;
  proof_required_count: number;
  proof_available_count: number;
  proof_missing_count: number;
  proof_unknown_count: number;
  proof_completion_percent: number | null;
}

describe.skipIf(!isLocalDatabase)('P59 Discount Report (real Express + Postgres)', () => {
  const tag = randomUUID().slice(0, 8);
  const ids = { branchA: '', branchB: '', ana: '', cara: '', supA: '', supB: '', admin: '', branchUser: '', unit: '', potato: '', product: '', variant: '' };
  const tokens = { ana: '', cara: '', supA: '', supB: '', admin: '', branch: '' };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const types = { pwdA: '', pwdB: '', loyalty: '', optional: '' };
  const sales = { pwdWithProof: '', pwdMissing: '', pwdB: '', loyalty1: '', loyalty2: '', optional: '', statutory: '', unknown: '' };
  const receipts: Record<string, string> = {};
  let server: Server;
  let baseUrl = '';
  let setupSucceeded = false;
  let png: Buffer;

  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Device-ID': `p59-${tag}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const isJson = res.headers.get('content-type')?.includes('json');
    return { status: res.status, body: (isJson ? await res.json() : { data: null, error: null }) as ApiBody };
  }

  async function exportFile(token: string, reportType: string, format: 'csv' | 'pdf', branchId: string, discountKey?: string) {
    const res = await fetch(`${baseUrl}/api/reports/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Device-ID': `p59-${tag}` },
      body: JSON.stringify({ report_type: reportType, format, filters: { branch_id: branchId, date_from: today, date_to: today, page: 1, limit: 100, ...(discountKey ? { discount_key: discountKey } : {}) } }),
    });
    return { status: res.status, disposition: res.headers.get('content-disposition') ?? '', bytes: Buffer.from(await res.arrayBuffer()) };
  }

  async function uploadProof(token: string, branchId: string): Promise<string> {
    const form = new FormData();
    form.set('branch_id', branchId);
    form.set('type', 'live_capture');
    form.set('proof', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'id.png');
    const res = await fetch(`${baseUrl}/api/transactions/discount-proof`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    const body = (await res.json()) as ApiBody;
    return body.data?.discount_proof_upload_id as string;
  }

  async function createType(token: string, branchId: string, name: string, requireProof: boolean): Promise<{ id: string; version: number }> {
    const res = await call('POST', '/api/discounts/manual-types', token, { branch_id: branchId, name, apply_to_pos: true, require_proof: requireProof });
    expect(res.status).toBe(201);
    return { id: res.body.data?.id as string, version: res.body.data?.version as number };
  }

  async function sell(token: string, branchId: string, type: { id: string; version: number } | null, amount: number, proofUploadId?: string) {
    const res = await call('POST', '/api/transactions', token, {
      branch_id: branchId,
      items: [{ product_id: ids.product, product_variant_id: ids.variant, quantity: 2, promotion: null }],
      payment_method: 'cash',
      cash_tendered: 1000,
      is_offline_transaction: false,
      idempotency_key: randomUUID(),
      tax_basis: { calculation_mode: 'manual_total_v1', vat_rate: null, discount_rate: null },
      discount_flow: 'manual_v1',
      discount_choice: type ? 'selected' : 'none_applicable',
      ...(type
        ? { discount_type: 'manual', manual_discount: { discount_type_id: type.id, type_version: type.version, amount, ...(proofUploadId ? { proof_upload_id: proofUploadId } : {}) } }
        : {}),
    });
    expect(res.status).toBe(201);
    receipts[res.body.data?.id as string] = res.body.data?.receipt_number as string;
    return res.body.data?.id as string;
  }

  async function report(token: string, branchId: string, discountKey?: string): Promise<ReportRow[]> {
    const qs = new URLSearchParams({ branch_id: branchId, date_from: today, date_to: today, page: '1', limit: '100', ...(discountKey ? { discount_key: discountKey } : {}) });
    const res = await call('GET', `/api/reports/discount-compliance?${qs.toString()}`, token);
    expect(res.status).toBe(200);
    return res.body.data?.data as ReportRow[];
  }

  beforeAll(async () => {
    png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer();
    for (const key of ['branchA', 'branchB'] as const) {
      ids[key] = (await prisma.branch.create({ data: { name: `P59 ${key} ${tag}`, code: `P59${key.slice(-1)}-${tag}`, address: 'x', city: 'x', status: 'active' } })).id;
    }
    const mk = async (role: 'staff' | 'supervisor' | 'branch' | 'super_admin', first: string) =>
      (await prisma.user.create({ data: { role, firstName: first, lastName: `P59${tag}`, email: `${first.toLowerCase()}-${tag}@p59.test`, employeeId: role === 'staff' ? `P59-${first}-${tag}` : null, employmentType: 'regular', mustChangePassword: false } })).id;
    ids.ana = await mk('staff', 'Ana');
    ids.cara = await mk('staff', 'Cara');
    ids.supA = await mk('supervisor', 'SupA');
    ids.supB = await mk('supervisor', 'SupB');
    ids.admin = await mk('super_admin', 'Admin');
    ids.branchUser = await mk('branch', 'Counter');
    await prisma.userBranchAssignment.createMany({
      data: [
        { userId: ids.ana, branchId: ids.branchA },
        { userId: ids.cara, branchId: ids.branchB },
        { userId: ids.supA, branchId: ids.branchA },
        { userId: ids.supB, branchId: ids.branchB },
        { userId: ids.branchUser, branchId: ids.branchA },
      ],
    });
    ids.unit = (await prisma.unitOfMeasure.create({ data: { code: `p59-g-${tag}`, name: 'P59 Gram', dimension: 'WEIGHT', isBaseUnit: true } })).id;
    ids.potato = (await prisma.inventoryItem.create({ data: { name: `P59 potato ${tag}`, baseUnitId: ids.unit } })).id;
    ids.product = (await prisma.product.create({ data: { name: `P59 Fries ${tag}`, status: 'active', classification: 'regular' } })).id;
    ids.variant = (await prisma.productVariant.create({ data: { productId: ids.product, name: 'Mega', sizeLabel: 'Mega', basePrice: 250, isActive: true } })).id;
    await prisma.productComponent.create({ data: { productVariantId: ids.variant, inventoryItemId: ids.potato, quantityRequired: 100 } });
    for (const [branchId, employeeId] of [[ids.branchA, ids.ana], [ids.branchB, ids.cara]] as const) {
      await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: ids.potato, quantityOnHand: 1000000 } });
      await prisma.branchProductAvailability.create({ data: { branchId, productId: ids.product, isAvailable: true } });
      await prisma.attendanceRecord.create({ data: { employeeId, branchId, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });
    }
    tokens.ana = generateStaffToken(ids.branchA, { userId: ids.ana });
    tokens.cara = generateStaffToken(ids.branchB, { userId: ids.cara });
    tokens.supA = generateSupervisorToken([ids.branchA], { userId: ids.supA });
    tokens.supB = generateSupervisorToken([ids.branchB], { userId: ids.supB });
    tokens.admin = generateSuperAdminToken({ userId: ids.admin });
    tokens.branch = generateBranchToken(ids.branchA, { userId: ids.branchUser });

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const pwdA = await createType(tokens.supA, ids.branchA, 'PWD', true);
    const pwdB = await createType(tokens.supB, ids.branchB, 'PWD', true);
    const loyalty = await createType(tokens.supA, ids.branchA, 'Loyalty', false);
    const optional = await createType(tokens.supA, ids.branchA, 'Optional Proof', false);
    Object.assign(types, { pwdA: pwdA.id, pwdB: pwdB.id, loyalty: loyalty.id, optional: optional.id });

    sales.pwdWithProof = await sell(tokens.ana, ids.branchA, pwdA, 50, await uploadProof(tokens.ana, ids.branchA));
    // Proof was required and enforced at checkout: "missing" is simulated by removing the stored evidence afterwards.
    sales.pwdMissing = await sell(tokens.ana, ids.branchA, pwdA, 30, await uploadProof(tokens.ana, ids.branchA));
    // Raw SQL: the app itself refuses to change a sale (CR-004), so only a fixture on this local database can.
    await prisma.$executeRaw`UPDATE "transactions" SET "discount_proof_key" = NULL, "discount_proof_type" = NULL, "discount_proof_uploaded_at" = NULL WHERE "id" = ${sales.pwdMissing}`;
    sales.pwdB = await sell(tokens.cara, ids.branchB, pwdB, 20, await uploadProof(tokens.cara, ids.branchB));
    sales.loyalty1 = await sell(tokens.ana, ids.branchA, loyalty, 10);
    sales.optional = await sell(tokens.ana, ids.branchA, optional, 15, await uploadProof(tokens.ana, ids.branchA));

    // Rename, then sell again: same identity, two saved names.
    const renamed = await call('PATCH', `/api/discounts/manual-types/${loyalty.id}`, tokens.supA, { name: 'Loyalty Card', expected_version: loyalty.version });
    expect(renamed.status).toBe(200);
    sales.loyalty2 = await sell(tokens.ana, ids.branchA, { id: loyalty.id, version: renamed.body.data?.version as number }, 5);

    // A genuine historical statutory sale, through the real legacy calculation.
    const statutory = await call('POST', '/api/transactions', tokens.ana, {
      branch_id: ids.branchA,
      items: [{ product_id: ids.product, product_variant_id: ids.variant, quantity: 2, promotion: null }],
      payment_method: 'cash',
      cash_tendered: 1000,
      is_offline_transaction: false,
      idempotency_key: randomUUID(),
      discount_flow: 'manual_v1',
      discount_choice: 'selected',
      discount_type: 'pwd',
      discount_id_reference: `PWD-${tag}`,
      tax_basis: { vat_rate: 12, discount_rate: 20 },
    });
    expect(statutory.status).toBe(201);
    sales.statutory = statutory.body.data?.id as string;
    receipts[sales.statutory] = statutory.body.data?.receipt_number as string;

    // A manual sale whose identity is genuinely missing (no snapshot, no type link).
    sales.unknown = await sell(tokens.ana, ids.branchA, null, 0);
    await prisma.$executeRaw`UPDATE "transactions" SET "discount_type" = 'manual', "discount_amount" = 7, "discount_proof_key" = ${`${ids.branchA}/orphan.webp`} WHERE "id" = ${sales.unknown}`;
    setupSucceeded = true;
  }, 120_000);

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
    await prisma.attendanceRecord.deleteMany({ where: { branchId: { in: branches } } });
    await prisma.shift.deleteMany({ where: { branchId: { in: branches } } });
  });

  const keyOf = (typeId: string) => `manual:${typeId}`;
  const row = (rows: ReportRow[], key: string) => rows.find((r) => r.discount_key === key);

  it('1. a sale using a custom PWD type reads PWD in the list, detail, audit trail, public receipt and report; the stored code stays manual', async () => {
    const list = await call('GET', `/api/transactions?branch_id=${ids.branchA}&status=completed&discounted_only=true&discount_key=${keyOf(types.pwdA)}&limit=100`, tokens.supA);
    const listed = (list.body.data?.transactions as Array<{ id: string; discount_type: string; manual_discount: { name: string; require_proof: boolean } }>).find((t) => t.id === sales.pwdWithProof);
    expect(listed).toMatchObject({ discount_type: 'manual', manual_discount: { name: 'PWD', require_proof: true } });

    const detail = await call('GET', `/api/transactions/${sales.pwdWithProof}`, tokens.supA);
    expect(detail.body.data?.manual_discount).toMatchObject({ name: 'PWD' });

    const audit = await call('GET', `/api/transactions/discount-audit?branch_id=${ids.branchA}&discount_key=${keyOf(types.pwdA)}&limit=100`, tokens.supA);
    const auditRows = audit.body.data?.data as Array<{ id: string; discountName: string; discountKey: string; discountProofRequirement: string }>;
    expect(auditRows.map((r) => r.id).sort()).toEqual([sales.pwdWithProof, sales.pwdMissing].sort());
    expect(auditRows[0]).toMatchObject({ discountName: 'PWD', discountKey: keyOf(types.pwdA), discountProofRequirement: 'required' });

    const receiptNumber = receipts[sales.pwdWithProof] as string;
    const pub = await fetch(`${baseUrl}/api/receipts/${encodeURIComponent(receiptNumber)}`);
    expect(((await pub.json()) as ApiBody).data).toMatchObject({ discount_type: 'manual', manual_discount_name: 'PWD' });

    const rows = await report(tokens.supA, ids.branchA);
    expect(row(rows, keyOf(types.pwdA))).toMatchObject({ discount_name: 'PWD', discount_type_id: types.pwdA });
    expect(rows.some((r) => r.discount_name === 'Manual')).toBe(false);
  });

  it('1b. generated CSVs print the saved name, for the Supervisor transaction export and the Admin summary export', async () => {
    const supervisor = await exportFile(tokens.supA, 'DISCOUNT_COMPLIANCE', 'csv', ids.branchA);
    expect(supervisor.status).toBe(200);
    expect(supervisor.disposition).toContain('DiscountReport_');
    const lines = supervisor.bytes.toString('utf-8').split('\n');
    expect(lines[0]).toBe('Receipt #,Date/Time,Branch,Cashier,Discount Type,Discount Rate Used,Customer ID / Reference,Discount Amount,Proof Requirement,Proof Available');
    const line = lines.find((l) => l.includes(receipts[sales.pwdWithProof] as string));
    expect(line).toContain(',PWD,');
    expect(lines.slice(1).some((l) => /,Manual,|,manual,/.test(l))).toBe(false);

    const admin = await exportFile(tokens.admin, 'DISCOUNT_COMPLIANCE', 'csv', ids.branchA);
    const adminText = admin.bytes.toString('utf-8');
    expect(adminText.split('\n')[0]).toBe('Branch,Discount Type,Transactions,Total Discount,Proof Required,Proof Available,Proof Missing,Proof Requirement Unknown,Proof Completion');
    expect(adminText).toContain(',PWD,2,80,2,1,1,0,50%');
    expect(adminText).not.toMatch(/,Manual,|,manual,/);
  });

  it('2. renaming a type keeps past names; deactivating keeps them too; identity stays one row', async () => {
    const stored = await prisma.transaction.findUniqueOrThrow({ where: { id: sales.loyalty1 } });
    expect(stored.manualDiscountSnapshot).toMatchObject({ name: 'Loyalty' });
    const first = await call('GET', `/api/transactions/${sales.loyalty1}`, tokens.supA);
    const second = await call('GET', `/api/transactions/${sales.loyalty2}`, tokens.supA);
    expect(first.body.data?.manual_discount).toMatchObject({ name: 'Loyalty' });
    expect(second.body.data?.manual_discount).toMatchObject({ name: 'Loyalty Card' });

    const before = row(await report(tokens.supA, ids.branchA), keyOf(types.loyalty));
    expect(before).toMatchObject({ discount_name: 'Loyalty Card', discount_other_names: ['Loyalty'], transaction_count: 2, total_discount_amount: 15 });

    const current = await prisma.manualDiscountType.findUniqueOrThrow({ where: { id: types.loyalty } });
    expect((await call('POST', `/api/discounts/manual-types/${types.loyalty}/deactivate`, tokens.supA, { expected_version: current.version })).status).toBe(200);

    const after = row(await report(tokens.supA, ids.branchA), keyOf(types.loyalty));
    expect(after).toEqual(before);
    const stillFirst = await call('GET', `/api/transactions/${sales.loyalty1}`, tokens.supA);
    expect(stillFirst.body.data?.manual_discount).toMatchObject({ name: 'Loyalty' });
  });

  it('3. several types stay separate; same-named types at two branches are not the same identity', async () => {
    const a = await report(tokens.admin, ids.branchA);
    const b = await report(tokens.admin, ids.branchB);
    expect(row(a, keyOf(types.pwdA))).toMatchObject({ transaction_count: 2, total_discount_amount: 80 });
    expect(row(b, keyOf(types.pwdB))).toMatchObject({ transaction_count: 1, total_discount_amount: 20 });
    expect(row(a, keyOf(types.pwdB))).toBeUndefined();
    expect(types.pwdA).not.toBe(types.pwdB);
    expect(a.filter((r) => r.discount_name === 'PWD').map((r) => r.discount_key).sort()).toEqual([keyOf(types.pwdA), 'type:pwd'].sort());
  });

  it('4. proof: required with proof, required and missing, optional with proof, and unknown legacy evidence', async () => {
    const rows = await report(tokens.supA, ids.branchA);
    expect(row(rows, keyOf(types.pwdA))).toMatchObject({ proof_required_count: 2, proof_available_count: 1, proof_missing_count: 1, proof_unknown_count: 0, proof_completion_percent: 50 });
    // Optional with a photo attached: still not in the denominator.
    expect(row(rows, keyOf(types.optional))).toMatchObject({ proof_required_count: 0, proof_available_count: 0, proof_missing_count: 0, proof_unknown_count: 0 });
    // The old checkout never enforced statutory proof, and nothing saved says otherwise.
    expect(row(rows, 'type:pwd')).toMatchObject({ discount_name: 'PWD', proof_required_count: 0, proof_unknown_count: 1 });
    // No snapshot: an honest name and an honest requirement, even with a photo on the row.
    expect(row(rows, 'manual:unspecified')).toMatchObject({ discount_name: 'Unspecified discount', proof_required_count: 0, proof_unknown_count: 1 });
  });

  it('4b. the requirement comes from the saved sale: editing the type today changes nothing in the past', async () => {
    const current = await prisma.manualDiscountType.findUniqueOrThrow({ where: { id: types.optional } });
    expect((await call('PATCH', `/api/discounts/manual-types/${types.optional}`, tokens.supA, { require_proof: true, expected_version: current.version })).status).toBe(200);
    expect(row(await report(tokens.supA, ids.branchA), keyOf(types.optional))).toMatchObject({ proof_required_count: 0, proof_completion_percent: null });
  });

  it('5. no proof-required sale reads N/A in the API and the export, never 100%', async () => {
    const rows = await report(tokens.supA, ids.branchA, keyOf(types.optional));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.proof_completion_percent).toBeNull();
    const admin = await exportFile(tokens.admin, 'DISCOUNT_COMPLIANCE', 'csv', ids.branchA, keyOf(types.optional));
    const lines = admin.bytes.toString('utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/,N\/A$/);
    expect(lines[1]).not.toContain('100');
  });

  it('6. branch, date and type filters agree across the aggregate, list, audit trail and exported rows and totals', async () => {
    for (const key of [keyOf(types.pwdA), keyOf(types.loyalty), 'type:pwd', 'manual:unspecified']) {
      const rows = await report(tokens.supA, ids.branchA, key);
      expect(rows.map((r) => r.discount_key)).toEqual([key]);
      const aggregate = rows[0] as ReportRow;

      const list = await call('GET', `/api/transactions?branch_id=${ids.branchA}&status=completed&discounted_only=true&discount_key=${key}&date_from=${today}&date_to=${today}&limit=100`, tokens.supA);
      const listed = list.body.data?.transactions as Array<{ discount_amount: number }>;
      expect(list.body.data?.total).toBe(aggregate.transaction_count);
      expect(listed.reduce((s, t) => s + t.discount_amount, 0)).toBeCloseTo(aggregate.total_discount_amount, 2);

      const audit = await call('GET', `/api/transactions/discount-audit?branch_id=${ids.branchA}&discount_key=${key}&date_from=${today}&date_to=${today}&limit=100`, tokens.supA);
      expect(audit.body.data?.total).toBe(aggregate.transaction_count);

      const csv = await exportFile(tokens.supA, 'DISCOUNT_COMPLIANCE', 'csv', ids.branchA, key);
      const lines = csv.bytes.toString('utf-8').trim().split('\n');
      expect(lines).toHaveLength(aggregate.transaction_count + 1);
      const amountIndex = (lines[0] as string).split(',').indexOf('Discount Amount');
      const exported = lines.slice(1).reduce((s, l) => s + Number(l.split(',')[amountIndex]), 0);
      expect(exported).toBeCloseTo(aggregate.total_discount_amount, 2);
    }

    // Another date range holds none of them.
    const qs = new URLSearchParams({ branch_id: ids.branchA, date_from: '2020-01-01', date_to: '2020-01-02', page: '1', limit: '100' });
    const none = await call('GET', `/api/reports/discount-compliance?${qs.toString()}`, tokens.supA);
    expect(none.body.data?.data).toEqual([]);

    // The unfiltered export covers discounted sales only and matches the aggregate total.
    const all = await report(tokens.supA, ids.branchA);
    const csv = await exportFile(tokens.supA, 'DISCOUNT_COMPLIANCE', 'csv', ids.branchA);
    expect(csv.bytes.toString('utf-8').trim().split('\n')).toHaveLength(all.reduce((s, r) => s + r.transaction_count, 0) + 1);
  });

  it('6b. a malformed type filter is refused, not treated as all types', async () => {
    const qs = new URLSearchParams({ branch_id: ids.branchA, discount_key: 'PWD' });
    expect((await call('GET', `/api/reports/discount-compliance?${qs.toString()}`, tokens.supA)).status).toBe(422);
    expect((await call('GET', `/api/transactions?branch_id=${ids.branchA}&discount_key=PWD`, tokens.supA)).status).toBe(422);
    expect((await call('GET', `/api/transactions/discount-audit?branch_id=${ids.branchA}&discount_key=PWD`, tokens.supA)).status).toBe(422);
  });

  it('7. legacy and manual-total sales keep their calculated amounts; API tax fields stay for older clients', async () => {
    const manual = await prisma.transaction.findUniqueOrThrow({ where: { id: sales.pwdWithProof } });
    expect([manual.subtotal.toNumber(), manual.discountAmount.toNumber(), manual.vatAmount.toNumber(), manual.totalAmount.toNumber(), manual.calculationMode]).toEqual([500, 50, 0, 450, 'manual_total_v1']);
    const manualView = await call('GET', `/api/transactions/${sales.pwdWithProof}`, tokens.supA);
    expect(manualView.body.data).toMatchObject({ total_amount: 450, vat_amount: null, vat_exempt_amount: null, calculation_mode: 'manual_total_v1' });

    // The statutory formula, untouched: ₱500 → ÷1.12 → −20% → ₱357.14, VAT ₱0.
    const legacy = await prisma.transaction.findUniqueOrThrow({ where: { id: sales.statutory } });
    expect([legacy.totalAmount.toNumber(), legacy.vatAmount.toNumber(), legacy.calculationMode]).toEqual([357.14, 0, 'legacy_vat_v1']);
    const legacyView = await call('GET', `/api/transactions/${sales.statutory}`, tokens.supA);
    expect(legacyView.body.data).toMatchObject({ total_amount: 357.14, vat_amount: 0, vat_exempt_amount: expect.any(Number), calculation_mode: 'legacy_vat_v1' });
    const rows = await report(tokens.supA, ids.branchA);
    expect(row(rows, 'type:pwd')).toMatchObject({ total_vat_exempt_sales: 357.14, total_vat_exempt_amount: expect.any(Number) });
    expect(row(rows, keyOf(types.pwdA))).toMatchObject({ total_vat_exempt_sales: null, total_vat_exempt_amount: null });
    const daily = await call('GET', `/api/reports/daily-sales?branch_id=${ids.branchA}&date_from=${today}&date_to=${today}`, tokens.supA);
    expect((daily.body.data?.data as Array<Record<string, unknown>>)[0]).toHaveProperty('vat_total');
    expect((daily.body.data?.data as Array<Record<string, unknown>>)[0]).toHaveProperty('tax_not_calculated_count');
  });

  it('8. refunds, proof access and branch access still work', async () => {
    const pdf = await fetch(`${baseUrl}/api/transactions/${sales.pwdWithProof}/discount-proof`, { headers: { Authorization: `Bearer ${tokens.supA}`, 'X-Device-ID': `p59-${tag}` } });
    expect(pdf.status).toBe(200);
    expect(((await pdf.json()) as ApiBody).data?.discount_proof_url).toEqual(expect.stringContaining('storage.test'));
    const otherBranch = await fetch(`${baseUrl}/api/transactions/${sales.pwdWithProof}/discount-proof`, { headers: { Authorization: `Bearer ${tokens.supB}`, 'X-Device-ID': `p59-${tag}` } });
    expect(otherBranch.status).toBe(403);

    // A supervisor cannot read or export another branch's report, whatever type filter is sent.
    const qs = new URLSearchParams({ branch_id: ids.branchA, discount_key: keyOf(types.pwdA) });
    expect((await call('GET', `/api/reports/discount-compliance?${qs.toString()}`, tokens.supB)).status).toBe(403);
    expect((await exportFile(tokens.supB, 'DISCOUNT_COMPLIANCE', 'csv', ids.branchA, keyOf(types.pwdA))).status).toBe(403);
    expect((await call('GET', `/api/transactions/discount-audit?branch_id=${ids.branchA}&discount_key=${keyOf(types.pwdA)}`, tokens.supB)).status).toBe(403);
    expect((await call('GET', `/api/transactions/discount-audit?branch_id=${ids.branchA}`, tokens.ana)).status).toBe(403);

    // The branch role's export never carries the customer ID.
    const branchCsv = await exportFile(tokens.branch, 'DISCOUNT_COMPLIANCE', 'csv', ids.branchA);
    expect(branchCsv.status).toBe(200);
    expect(branchCsv.bytes.toString('utf-8')).not.toContain('Customer ID');
    expect(branchCsv.bytes.toString('utf-8')).not.toContain(`PWD-${tag}`);

    // A refund changes the status, not the saved amounts or name; the report drops it (completed sales only).
    const before = await prisma.transaction.findUniqueOrThrow({ where: { id: sales.pwdMissing } });
    expect((await call('POST', `/api/transactions/${sales.pwdMissing}/refund`, tokens.supA, { refund_reason: 'Customer returned the order' })).status).toBe(200);
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: sales.pwdMissing } });
    expect(after.status).toBe('refunded');
    expect([after.discountAmount.toNumber(), after.totalAmount.toNumber()]).toEqual([before.discountAmount.toNumber(), before.totalAmount.toNumber()]);
    expect(after.manualDiscountSnapshot).toEqual(before.manualDiscountSnapshot);
    expect(row(await report(tokens.supA, ids.branchA), keyOf(types.pwdA))).toMatchObject({ transaction_count: 1, total_discount_amount: 50, proof_required_count: 1, proof_available_count: 1, proof_completion_percent: 100 });
  });

  it('9. no generated report CSV or PDF mentions VAT or a not-calculated tax message', async () => {
    const forbidden = /\bVAT\b|VAT-|VATable|Tax Calculation|Not calculated/;
    for (const [token, type] of [
      [tokens.supA, 'DAILY_SALES'],
      [tokens.admin, 'DAILY_SALES'],
      [tokens.supA, 'DISCOUNT_COMPLIANCE'],
      [tokens.admin, 'DISCOUNT_COMPLIANCE'],
    ] as const) {
      const csv = await exportFile(token, type, 'csv', ids.branchA);
      expect(csv.status).toBe(200);
      expect(csv.bytes.toString('utf-8')).not.toMatch(forbidden);
      const pdf = await exportFile(token, type, 'pdf', ids.branchA);
      expect(pdf.status).toBe(200);
      expect(pdf.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }
    const transactionPdf = await fetch(`${baseUrl}/api/transactions/export/pdf?branch_id=${ids.branchA}&date_from=${today}&date_to=${today}`, { headers: { Authorization: `Bearer ${tokens.supA}`, 'X-Device-ID': `p59-${tag}` } });
    expect(transactionPdf.status).toBe(200);
    expect(Buffer.from(await transactionPdf.arrayBuffer()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
