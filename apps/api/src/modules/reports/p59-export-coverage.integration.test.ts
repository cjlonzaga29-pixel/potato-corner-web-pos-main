import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * POS-PERF-P59 — the Discount Report export's real row limits, through the real
 * Express app against a real Postgres: one row below, exactly at and one row
 * above each limit, for a type filter and for the unfiltered report. The sales
 * are copies of one real checkout's row, so the report reads ordinary data.
 * Only the rendered PDF's arguments are captured here; the renderer still runs.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const pdfCalls = vi.hoisted(() => ({ coverage: [] as Array<{ partial: boolean; note: string } | undefined>, rowCounts: [] as number[] }));

vi.mock('../../lib/notify.js', () => ({ notifyBranch: vi.fn(), notifySuperAdmin: vi.fn(), notifyUser: vi.fn() }));
vi.mock('../../middleware/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middleware/rate-limiter.js')>()),
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../lib/reports/pdf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/reports/pdf.js')>();
  return {
    ...actual,
    generatePdf: (async (...args: Parameters<typeof actual.generatePdf>) => {
      pdfCalls.coverage.push(args[5]);
      pdfCalls.rowCounts.push(args[2].length);
      return actual.generatePdf(...args);
    }) as typeof actual.generatePdf,
  };
});

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { generateStaffToken, generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

interface ReportRow {
  discount_key: string;
  transaction_count: number;
  total_discount_amount: number;
}

const PWD_AMOUNT = 2.5;
const OTHER_AMOUNT = 7;
const OTHER_SALES = 5;
const OLD_SALES = 3;

describe.skipIf(!isLocalDatabase)('P59 Discount Report export limits (real Express + Postgres)', () => {
  const tag = randomUUID().slice(0, 8);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const ids = { branch: '', staff: '', supervisor: '', product: '', variant: '' };
  const tokens = { staff: '', supervisor: '' };
  const keys = { pwd: '', other: '' };
  let templateId = '';
  let otherTemplateId = '';
  let pwdCount = 0;
  let server: Server;
  let baseUrl = '';

  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Device-ID': `p59-${tag}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as { data: Record<string, unknown> } };
  }

  async function exportFile(format: 'csv' | 'pdf', discountKey?: string) {
    const res = await fetch(`${baseUrl}/api/reports/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.supervisor}`, 'Content-Type': 'application/json', 'X-Device-ID': `p59-${tag}` },
      body: JSON.stringify({ report_type: 'DISCOUNT_COMPLIANCE', format, filters: { branch_id: ids.branch, date_from: today, date_to: today, page: 1, limit: 100, ...(discountKey ? { discount_key: discountKey } : {}) } }),
    });
    expect(res.status).toBe(200);
    return { disposition: res.headers.get('content-disposition') ?? '', bytes: Buffer.from(await res.arrayBuffer()) };
  }

  async function aggregate(): Promise<ReportRow[]> {
    const qs = new URLSearchParams({ branch_id: ids.branch, date_from: today, date_to: today, page: '1', limit: '100' });
    const res = await call('GET', `/api/reports/discount-compliance?${qs.toString()}`, tokens.supervisor);
    expect(res.status).toBe(200);
    return res.body.data.data as unknown as ReportRow[];
  }

  async function sell(type: { id: string; version: number }, amount: number): Promise<string> {
    const res = await call('POST', '/api/transactions', tokens.staff, {
      branch_id: ids.branch,
      items: [{ product_id: ids.product, product_variant_id: ids.variant, quantity: 1, promotion: null }],
      payment_method: 'cash',
      cash_tendered: 1000,
      is_offline_transaction: false,
      idempotency_key: randomUUID(),
      tax_basis: { calculation_mode: 'manual_total_v1', vat_rate: null, discount_rate: null },
      discount_flow: 'manual_v1',
      discount_choice: 'selected',
      discount_type: 'manual',
      manual_discount: { discount_type_id: type.id, type_version: type.version, amount },
    });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  /** Raw SQL: the only way to copy every column of a sale without restating the model. A fixture on this local database only. */
  async function copySale(sourceId: string, count: number, createdAt?: Date): Promise<void> {
    if (count <= 0) return;
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'transactions'`;
    const names = columns.map((c) => c.column_name);
    const select = names.map((name) => {
      if (name === 'id') return 'gen_random_uuid()';
      if (name === 'transaction_number') return `'P59X-${tag}-' || gen_random_uuid()`;
      if (name === 'idempotency_key') return 'gen_random_uuid()::text';
      if (name === 'created_at' && createdAt) return `'${createdAt.toISOString()}'::timestamptz`;
      return `"${name}"`;
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "transactions" (${names.map((n) => `"${n}"`).join(', ')}) SELECT ${select.join(', ')} FROM "transactions" CROSS JOIN generate_series(1, ${count}) WHERE "id" = '${sourceId}'`,
    );
  }

  async function raisePwdCountTo(target: number): Promise<void> {
    await copySale(templateId, target - pwdCount);
    pwdCount = target;
  }

  function csvSummary(bytes: Buffer) {
    const lines = bytes.toString('utf-8').split('\n');
    const partial = lines[0]?.startsWith('"PARTIAL EXPORT') ?? false;
    const body = partial ? lines.slice(1) : lines;
    const headers = (body[0] ?? '').split(',');
    const amountIndex = headers.indexOf('Discount Amount');
    const rows = body.slice(1);
    const cents = rows.reduce((sum, line) => sum + Math.round(Number(line.split(',')[amountIndex]) * 100), 0);
    return { partial, notice: partial ? lines[0] : null, headers, rowCount: rows.length, total: cents / 100 };
  }

  beforeAll(async () => {
    ids.branch = (await prisma.branch.create({ data: { name: `P59 cov ${tag}`, code: `P59C-${tag}`, address: 'x', city: 'x', status: 'active' } })).id;
    const mk = async (role: 'staff' | 'supervisor', first: string) =>
      (await prisma.user.create({ data: { role, firstName: first, lastName: `P59${tag}`, email: `${first.toLowerCase()}-${tag}@p59.test`, employeeId: role === 'staff' ? `P59C-${first}-${tag}` : null, employmentType: 'regular', mustChangePassword: false } })).id;
    ids.staff = await mk('staff', 'Ana');
    ids.supervisor = await mk('supervisor', 'Sup');
    await prisma.userBranchAssignment.createMany({ data: [{ userId: ids.staff, branchId: ids.branch }, { userId: ids.supervisor, branchId: ids.branch }] });
    const unit = await prisma.unitOfMeasure.create({ data: { code: `p59c-${tag}`, name: 'P59 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    const item = await prisma.inventoryItem.create({ data: { name: `P59 cov ${tag}`, baseUnitId: unit.id } });
    ids.product = (await prisma.product.create({ data: { name: `P59 Cov ${tag}`, status: 'active', classification: 'regular' } })).id;
    ids.variant = (await prisma.productVariant.create({ data: { productId: ids.product, name: 'Mega', sizeLabel: 'Mega', basePrice: 250, isActive: true } })).id;
    await prisma.productComponent.create({ data: { productVariantId: ids.variant, inventoryItemId: item.id, quantityRequired: 1 } });
    await prisma.inventoryStock.create({ data: { branchId: ids.branch, inventoryItemId: item.id, quantityOnHand: 1000 } });
    await prisma.branchProductAvailability.create({ data: { branchId: ids.branch, productId: ids.product, isAvailable: true } });
    await prisma.attendanceRecord.create({ data: { employeeId: ids.staff, branchId: ids.branch, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });
    tokens.staff = generateStaffToken(ids.branch, { userId: ids.staff });
    tokens.supervisor = generateSupervisorToken([ids.branch], { userId: ids.supervisor });

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const createType = async (name: string) => {
      const res = await call('POST', '/api/discounts/manual-types', tokens.supervisor, { branch_id: ids.branch, name, apply_to_pos: true, require_proof: false });
      expect(res.status).toBe(201);
      return { id: res.body.data.id as string, version: res.body.data.version as number };
    };
    const pwd = await createType('PWD');
    const other = await createType('Loyalty');
    templateId = await sell(pwd, PWD_AMOUNT);
    otherTemplateId = await sell(other, OTHER_AMOUNT);
    pwdCount = 1;
    await copySale(otherTemplateId, OTHER_SALES - 1);
    // Outside the exported date range: must count toward nothing.
    await copySale(templateId, OLD_SALES, new Date(Date.now() - 10 * 24 * 3600_000));

    const rows = await aggregate();
    keys.pwd = rows.find((r) => r.total_discount_amount === PWD_AMOUNT)?.discount_key ?? '';
    keys.other = rows.find((r) => r.total_discount_amount === OTHER_AMOUNT * OTHER_SALES)?.discount_key ?? '';
    expect(keys.pwd).not.toBe('');
    expect(keys.other).not.toBe('');
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('CSV below and exactly at 10,000 rows is complete and unchanged; one above is labelled partial', async () => {
    for (const target of [9_999, 10_000]) {
      await raisePwdCountTo(target);
      const file = await exportFile('csv', keys.pwd);
      const csv = csvSummary(file.bytes);
      expect(file.disposition).not.toContain('PARTIAL');
      expect(csv.partial).toBe(false);
      expect(csv.headers[0]).toBe('Receipt #');
      expect(csv.rowCount).toBe(target);
      // Complete: the file's own rows add up to the report's aggregate.
      const pwd = (await aggregate()).find((r) => r.discount_key === keys.pwd);
      expect(pwd?.transaction_count).toBe(target);
      expect(pwd?.total_discount_amount).toBe(csv.total);
    }

    await raisePwdCountTo(10_001);
    const file = await exportFile('csv', keys.pwd);
    const csv = csvSummary(file.bytes);
    expect(file.disposition).toContain('_PARTIAL.csv');
    expect(csv.partial).toBe(true);
    expect(csv.headers[0]).toBe('Receipt #');
    expect(csv.rowCount).toBe(10_000);
    expect(csv.total).toBe(10_000 * PWD_AMOUNT);
    expect(csv.notice).toContain('newest 10,000 matching');
    expect(csv.notice).toContain('NOT in this file');
    expect(csv.notice).toContain('these exported rows only: PHP 25,000.00');
    // The aggregate still counts every matching sale, so the two totals visibly differ.
    const pwd = (await aggregate()).find((r) => r.discount_key === keys.pwd);
    expect(pwd?.transaction_count).toBe(10_001);
    expect(pwd?.total_discount_amount).toBe(10_001 * PWD_AMOUNT);
  }, 300_000);

  it('the unfiltered report counts every type, and other types and dates never fill a filtered file', async () => {
    // 10,001 PWD plus 5 others: the unfiltered file is partial and may hold the newest of any type.
    const unfiltered = csvSummary((await exportFile('csv')).bytes);
    expect(unfiltered.partial).toBe(true);
    expect(unfiltered.rowCount).toBe(10_000);

    const other = await exportFile('csv', keys.other);
    const otherCsv = csvSummary(other.bytes);
    expect(other.disposition).not.toContain('PARTIAL');
    expect(otherCsv.partial).toBe(false);
    expect(otherCsv.rowCount).toBe(OTHER_SALES);
    expect(otherCsv.total).toBe(OTHER_SALES * OTHER_AMOUNT);
  }, 300_000);
});

describe.skipIf(!isLocalDatabase)('P59 Discount Report PDF limit (real Express + Postgres)', () => {
  const tag = randomUUID().slice(0, 8);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  let branchId = '';
  let supervisorToken = '';
  let templateId = '';
  let count = 0;
  let server: Server;
  let baseUrl = '';

  async function copySale(howMany: number): Promise<void> {
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'transactions'`;
    const names = columns.map((c) => c.column_name);
    const select = names.map((name) => {
      if (name === 'id') return 'gen_random_uuid()';
      if (name === 'transaction_number') return `'P59P-${tag}-' || gen_random_uuid()`;
      if (name === 'idempotency_key') return 'gen_random_uuid()::text';
      return `"${name}"`;
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "transactions" (${names.map((n) => `"${n}"`).join(', ')}) SELECT ${select.join(', ')} FROM "transactions" CROSS JOIN generate_series(1, ${howMany}) WHERE "id" = '${templateId}'`,
    );
  }

  async function exportPdf() {
    const res = await fetch(`${baseUrl}/api/reports/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${supervisorToken}`, 'Content-Type': 'application/json', 'X-Device-ID': `p59-${tag}` },
      body: JSON.stringify({ report_type: 'DISCOUNT_COMPLIANCE', format: 'pdf', filters: { branch_id: branchId, date_from: today, date_to: today, page: 1, limit: 100 } }),
    });
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    return { disposition: res.headers.get('content-disposition') ?? '' };
  }

  beforeAll(async () => {
    branchId = (await prisma.branch.create({ data: { name: `P59 pdf ${tag}`, code: `P59P-${tag}`, address: 'x', city: 'x', status: 'active' } })).id;
    const mk = async (role: 'staff' | 'supervisor', first: string) =>
      (await prisma.user.create({ data: { role, firstName: first, lastName: `P59${tag}`, email: `${first.toLowerCase()}-${tag}@p59.test`, employeeId: role === 'staff' ? `P59P-${first}-${tag}` : null, employmentType: 'regular', mustChangePassword: false } })).id;
    const staffId = await mk('staff', 'Ana');
    const supervisorId = await mk('supervisor', 'Sup');
    await prisma.userBranchAssignment.createMany({ data: [{ userId: staffId, branchId }, { userId: supervisorId, branchId }] });
    const unit = await prisma.unitOfMeasure.create({ data: { code: `p59p-${tag}`, name: 'P59 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    const item = await prisma.inventoryItem.create({ data: { name: `P59 pdf ${tag}`, baseUnitId: unit.id } });
    const product = await prisma.product.create({ data: { name: `P59 Pdf ${tag}`, status: 'active', classification: 'regular' } });
    const variant = await prisma.productVariant.create({ data: { productId: product.id, name: 'Mega', sizeLabel: 'Mega', basePrice: 250, isActive: true } });
    await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: item.id, quantityRequired: 1 } });
    await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: item.id, quantityOnHand: 1000 } });
    await prisma.branchProductAvailability.create({ data: { branchId, productId: product.id, isAvailable: true } });
    await prisma.attendanceRecord.create({ data: { employeeId: staffId, branchId, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });
    supervisorToken = generateSupervisorToken([branchId], { userId: supervisorId });
    const staffToken = generateStaffToken(branchId, { userId: staffId });

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { 'Content-Type': 'application/json', 'X-Device-ID': `p59-${tag}` };
    const typeRes = await fetch(`${baseUrl}/api/discounts/manual-types`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${supervisorToken}` }, body: JSON.stringify({ branch_id: branchId, name: 'PWD', apply_to_pos: true, require_proof: false }) });
    const type = ((await typeRes.json()) as { data: { id: string; version: number } }).data;
    const saleRes = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${staffToken}` },
      body: JSON.stringify({
        branch_id: branchId,
        items: [{ product_id: product.id, product_variant_id: variant.id, quantity: 1, promotion: null }],
        payment_method: 'cash',
        cash_tendered: 1000,
        is_offline_transaction: false,
        idempotency_key: randomUUID(),
        tax_basis: { calculation_mode: 'manual_total_v1', vat_rate: null, discount_rate: null },
        discount_flow: 'manual_v1',
        discount_choice: 'selected',
        discount_type: 'manual',
        manual_discount: { discount_type_id: type.id, type_version: type.version, amount: PWD_AMOUNT },
      }),
    });
    expect(saleRes.status).toBe(201);
    templateId = ((await saleRes.json()) as { data: { id: string } }).data.id;
    count = 1;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('below and exactly at 100 rows reads complete; one above is labelled partial', async () => {
    for (const target of [99, 100]) {
      await copySale(target - count);
      count = target;
      const file = await exportPdf();
      expect(file.disposition).not.toContain('PARTIAL');
      expect(pdfCalls.rowCounts.at(-1)).toBe(target);
      expect(pdfCalls.coverage.at(-1)?.partial).toBe(false);
      expect(pdfCalls.coverage.at(-1)?.note).toContain(`all ${target.toLocaleString('en-PH')} matching`);
      expect(pdfCalls.coverage.at(-1)?.note).toContain(`PHP ${(target * PWD_AMOUNT).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`);
    }

    await copySale(1);
    const file = await exportPdf();
    expect(file.disposition).toContain('_PARTIAL.pdf');
    expect(pdfCalls.rowCounts.at(-1)).toBe(100);
    expect(pdfCalls.coverage.at(-1)?.partial).toBe(true);
    expect(pdfCalls.coverage.at(-1)?.note).toContain('newest 100 matching');
    expect(pdfCalls.coverage.at(-1)?.note).toContain('these exported rows only: PHP 250.00');
  }, 300_000);
});
