import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * POS-PERF-P59 — Supervisor report coverage, through the real Express app against
 * a real Postgres: each record-level export at, below and one row above its PDF
 * limit, read from the file actually downloaded; server pages; and the aggregate
 * behind the cards, against one branch with another branch's rows beside it.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

vi.mock('../../lib/notify.js', () => ({ notifyBranch: vi.fn(), notifySuperAdmin: vi.fn(), notifyUser: vi.fn() }));
vi.mock('../../middleware/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middleware/rate-limiter.js')>()),
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { generateStaffToken, generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

/** The text a PDF draws: its streams inflated, and the hex strings of its text operators decoded. */
function pdfText(bytes: Buffer): string {
  const source = bytes.toString('latin1');
  const parts: string[] = [];
  const streamPattern = /stream\r?\n/g;
  let match = streamPattern.exec(source);
  while (match) {
    const start = match.index + match[0].length;
    const end = source.indexOf('endstream', start);
    try {
      const content = inflateSync(bytes.subarray(start, end)).toString('latin1');
      for (const operator of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
        const hex = [...(operator[1] ?? '').matchAll(/<([0-9a-fA-F]*)>/g)].map((m) => m[1]).join('');
        parts.push(Buffer.from(hex, 'hex').toString('latin1'));
      }
    } catch {
      // Not a deflated text stream, such as an embedded font.
    }
    match = streamPattern.exec(source);
  }
  return parts.join(' ');
}

function csvDataRows(text: string): string[] {
  const lines = text.split('\n');
  return lines.slice(lines[0]?.startsWith('"PARTIAL EXPORT') || lines[0]?.startsWith('PARTIAL EXPORT') ? 2 : 1);
}

const SALE_DISCOUNT = 2.5;
const SALE_TOTAL = 247.5;

describe.skipIf(!isLocalDatabase)('P59 Supervisor report coverage (real Express + Postgres)', () => {
  const tag = randomUUID().slice(0, 8);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const ids = { branch: '', otherBranch: '', staff: '', otherStaff: '', supervisor: '', product: '', variant: '', item: '', otherItem: '' };
  const tokens = { staff: '', supervisor: '', otherSupervisor: '' };
  let templateId = '';
  let completedCount = 0;
  let server: Server;
  let baseUrl = '';

  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Device-ID': `p59-${tag}` });

  async function postJson(path: string, token: string, body: unknown) {
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { data: Record<string, unknown> } };
  }

  async function getData<T>(path: string, token = tokens.supervisor): Promise<{ status: number; data: T }> {
    const res = await fetch(`${baseUrl}${path}`, { headers: headers(token) });
    return { status: res.status, data: ((await res.json()) as { data: T }).data };
  }

  async function exportFile(reportType: string, format: 'csv' | 'pdf', filters: Record<string, unknown> = {}, token = tokens.supervisor) {
    const res = await fetch(`${baseUrl}/api/reports/export`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ report_type: reportType, format, filters: { branch_id: ids.branch, date_from: today, date_to: today, page: 1, limit: 100, ...filters } }),
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    return { status: res.status, disposition: res.headers.get('content-disposition') ?? '', bytes };
  }

  /** Raw SQL: the only way to copy every column of a sale without restating the model. A fixture on this local database only. */
  async function copySale(sourceId: string, count: number, overrides: Record<string, string> = {}): Promise<void> {
    if (count <= 0) return;
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'transactions'`;
    const names = columns.map((c) => c.column_name);
    const select = names.map((name) => {
      if (overrides[name]) return overrides[name];
      if (name === 'id') return 'gen_random_uuid()';
      if (name === 'transaction_number') return `'P59C-${tag}-' || gen_random_uuid()`;
      if (name === 'idempotency_key') return 'gen_random_uuid()::text';
      return `"${name}"`;
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "transactions" (${names.map((n) => `"${n}"`).join(', ')}) SELECT ${select.join(', ')} FROM "transactions" CROSS JOIN generate_series(1, ${count}) WHERE "id" = '${sourceId}'`,
    );
  }

  async function raiseCompletedTo(target: number): Promise<void> {
    await copySale(templateId, target - completedCount);
    completedCount = target;
  }

  beforeAll(async () => {
    const makeBranch = async (name: string) => (await prisma.branch.create({ data: { name: `${name} ${tag}`, code: `${name}-${tag}`, address: 'x', city: 'x', status: 'active' } })).id;
    ids.branch = await makeBranch('P59A');
    ids.otherBranch = await makeBranch('P59B');
    const makeUser = async (role: 'staff' | 'supervisor', first: string, branchId: string) => {
      const user = await prisma.user.create({ data: { role, firstName: first, lastName: `P59${tag}`, email: `${first.toLowerCase()}-${tag}@p59.test`, employeeId: role === 'staff' ? `P59R-${first}-${tag}` : null, employmentType: 'regular', mustChangePassword: false } });
      await prisma.userBranchAssignment.create({ data: { userId: user.id, branchId } });
      return user.id;
    };
    ids.staff = await makeUser('staff', 'Ana', ids.branch);
    ids.otherStaff = await makeUser('staff', 'Ben', ids.otherBranch);
    ids.supervisor = await makeUser('supervisor', 'Sup', ids.branch);
    const otherSupervisor = await makeUser('supervisor', 'Oth', ids.otherBranch);
    const unit = await prisma.unitOfMeasure.create({ data: { code: `p59r-${tag}`, name: 'P59 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    ids.item = (await prisma.inventoryItem.create({ data: { name: `P59 cov ${tag}`, baseUnitId: unit.id } })).id;
    ids.otherItem = (await prisma.inventoryItem.create({ data: { name: `P59 cov other ${tag}`, baseUnitId: unit.id } })).id;
    ids.product = (await prisma.product.create({ data: { name: `P59 Fries ${tag}`, status: 'active', classification: 'regular' } })).id;
    ids.variant = (await prisma.productVariant.create({ data: { productId: ids.product, name: 'Mega', sizeLabel: 'Mega', basePrice: 250, isActive: true } })).id;
    await prisma.productComponent.create({ data: { productVariantId: ids.variant, inventoryItemId: ids.item, quantityRequired: 1 } });
    await prisma.inventoryStock.create({ data: { branchId: ids.branch, inventoryItemId: ids.item, quantityOnHand: 1000 } });
    await prisma.branchProductAvailability.create({ data: { branchId: ids.branch, productId: ids.product, isAvailable: true } });
    await prisma.attendanceRecord.create({ data: { employeeId: ids.staff, branchId: ids.branch, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });
    tokens.staff = generateStaffToken(ids.branch, { userId: ids.staff });
    tokens.supervisor = generateSupervisorToken([ids.branch], { userId: ids.supervisor });
    tokens.otherSupervisor = generateSupervisorToken([ids.otherBranch], { userId: otherSupervisor });

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const typeRes = await postJson('/api/discounts/manual-types', tokens.supervisor, { branch_id: ids.branch, name: 'PWD', apply_to_pos: true, require_proof: false });
    expect(typeRes.status).toBe(201);
    const saleRes = await postJson('/api/transactions', tokens.staff, {
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
      manual_discount: { discount_type_id: typeRes.body.data.id, type_version: typeRes.body.data.version, amount: SALE_DISCOUNT },
    });
    expect(saleRes.status).toBe(201);
    templateId = saleRes.body.data.id as string;
    completedCount = 1;
    // Another branch's sale: must count toward nothing here.
    await copySale(templateId, 7, { branch_id: `'${ids.otherBranch}'`, cashier_id: `'${ids.otherStaff}'` });
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('Daily Sales PDF: 99 and exactly 100 read complete in the file, 101 is partial with the newest 100 and their own totals', async () => {
    for (const target of [99, 100]) {
      await raiseCompletedTo(target);
      const file = await exportFile('DAILY_SALES', 'pdf');
      expect(file.status).toBe(200);
      expect(file.disposition).not.toContain('PARTIAL');
      const text = pdfText(file.bytes);
      expect(text).toContain(`Coverage: all ${target} matching completed sales`);
      expect(text).not.toContain('PARTIAL EXPORT');
    }

    await raiseCompletedTo(101);
    const file = await exportFile('DAILY_SALES', 'pdf');
    expect(file.disposition).toContain('_PARTIAL.pdf');
    const text = pdfText(file.bytes);
    expect(text).toContain('PARTIAL EXPORT');
    expect(text).toContain('newest 100 matching completed sales');
    expect(text).toContain(`Sales for these exported rows only: PHP ${(100 * SALE_TOTAL).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`);
    expect(text).toContain(`Discounts for these exported rows only: PHP ${(100 * SALE_DISCOUNT).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`);
  }, 180_000);

  it('Discount Report PDF stops at 100 whatever the request says; CSV stays the larger complete option, with saved names and amounts', async () => {
    const small = await exportFile('DISCOUNT_COMPLIANCE', 'pdf', { limit: 1 });
    expect(small.disposition).toContain('_PARTIAL.pdf');
    const text = pdfText(small.bytes);
    expect(text).toContain('newest 100 matching discounted sales');
    expect(text).toContain('Discount Amount for these exported rows only: PHP 250.00');
    expect(text).toContain('PWD');

    const tooMany = await exportFile('DISCOUNT_COMPLIANCE', 'pdf', { limit: 5000 });
    expect(tooMany.status).toBe(422);

    const csv = await exportFile('DISCOUNT_COMPLIANCE', 'csv');
    expect(csv.disposition).not.toContain('PARTIAL');
    const csvText = csv.bytes.toString('utf-8');
    expect(csvText.startsWith('Receipt #')).toBe(true);
    expect(csvDataRows(csvText)).toHaveLength(101);
    expect(csvText).toContain(',PWD,');
  }, 120_000);

  it('the period summary covers every sale, while a partial file total covers only its rows', async () => {
    const qs = new URLSearchParams({ branch_id: ids.branch, date_from: today, date_to: today });
    const { status, data } = await getData<{ sales: { completed_count: number; completed_total_amount: number; completed_discount_amount: number } }>(`/api/reports/period-summary?${qs.toString()}`);
    expect(status).toBe(200);
    expect(data.sales.completed_count).toBe(101);
    expect(data.sales.completed_total_amount).toBe(101 * SALE_TOTAL);
    expect(data.sales.completed_discount_amount).toBe(101 * SALE_DISCOUNT);

    const refused = await getData(`/api/reports/period-summary?${qs.toString()}`, tokens.otherSupervisor);
    expect(refused.status).toBe(403);
    const refusedExport = await exportFile('DAILY_SALES', 'csv', {}, tokens.otherSupervisor);
    expect(refusedExport.status).toBe(403);
  }, 60_000);

  it('rows with equal timestamps page without gaps or repeats, in the same order as the export', async () => {
    const list = (page: number) => getData<{ transactions: Array<{ id: string; receipt_number: string }>; total: number }>(`/api/transactions?branch_id=${ids.branch}&status=completed&date_from=${today}&date_to=${today}&page=${page}&limit=60`);
    const first = await list(1);
    const second = await list(2);
    expect(first.data.total).toBe(101);
    const receipts = [...first.data.transactions, ...second.data.transactions].map((t) => t.receipt_number);
    expect(new Set(receipts).size).toBe(101);

    const csv = (await exportFile('DAILY_SALES', 'csv')).bytes.toString('utf-8');
    expect(csvDataRows(csv).map((line) => line.split(',')[0])).toEqual(receipts);
  }, 60_000);

  it('Void/Refund: one newest-first list, complete up to 100 in a PDF and partial above it, with amounts for its own rows only', async () => {
    await copySale(templateId, 60, { status: `'voided'`, void_reason: `'test'` });
    await copySale(templateId, 40, { status: `'refunded'`, refund_reason: `'test'` });
    const exact = await exportFile('VOID_REFUND', 'pdf');
    expect(exact.disposition).not.toContain('PARTIAL');
    expect(pdfText(exact.bytes)).toContain('Coverage: all 100 matching voided or refunded sales');

    await copySale(templateId, 1, { status: `'refunded'`, refund_reason: `'test'` });
    const above = await exportFile('VOID_REFUND', 'pdf');
    expect(above.disposition).toContain('_PARTIAL.pdf');
    expect(pdfText(above.bytes)).toContain('newest 100 matching voided or refunded sales');

    const page = await getData<{ transactions: Array<{ status: string }>; total: number }>(`/api/transactions?branch_id=${ids.branch}&status_group=void_refund&date_from=${today}&date_to=${today}&page=1&limit=25`);
    expect(page.data.total).toBe(101);
    expect(page.data.transactions).toHaveLength(25);
    expect(page.data.transactions.every((t) => t.status === 'voided' || t.status === 'refunded')).toBe(true);

    const qs = new URLSearchParams({ branch_id: ids.branch, date_from: today, date_to: today });
    const summary = await getData<{ sales: { completed_count: number; voided_count: number; refunded_count: number; refunded_total_amount: number } }>(`/api/reports/period-summary?${qs.toString()}`);
    expect(summary.data.sales).toMatchObject({ completed_count: 101, voided_count: 60, refunded_count: 41, refunded_total_amount: 41 * SALE_TOTAL });
  }, 120_000);

  it('Sold Product Transactions: its export uses the screen filters, holds every status, and names itself', async () => {
    // Copies carry no items, so this product filter finds only the real sale.
    const qs = new URLSearchParams({ branch_id: ids.branch, date_from: today, date_to: today, product_name: `P59 Fries ${tag}`, page: '1', limit: '25' });
    const filtered = await getData<{ total: number }>(`/api/transactions?${qs.toString()}`);
    expect(filtered.data.total).toBe(1);
    const productFile = await exportFile('DAILY_SALES', 'csv', { report_view: 'sold_product_transactions', product_name: `P59 Fries ${tag}` });
    expect(csvDataRows(productFile.bytes.toString('utf-8'))).toHaveLength(1);
    expect(productFile.disposition).toContain('SoldProductTransactions_');

    const allStatuses = await exportFile('DAILY_SALES', 'csv', { report_view: 'sold_product_transactions' });
    const text = allStatuses.bytes.toString('utf-8');
    expect(csvDataRows(text)).toHaveLength(101 + 60 + 41);
    expect(text).toContain(',voided');
    expect(text).toContain(',refunded');

    const voidedOnly = await exportFile('DAILY_SALES', 'csv', { report_view: 'sold_product_transactions', status: 'voided' });
    expect(csvDataRows(voidedOnly.bytes.toString('utf-8'))).toHaveLength(60);

    const cashierFilter = await getData<{ total: number }>(`/api/transactions?branch_id=${ids.branch}&cashier_id=${ids.otherStaff}&date_from=${today}&date_to=${today}`);
    expect(cashierFilter.data.total).toBe(0);

    const pdf = await exportFile('DAILY_SALES', 'pdf', { report_view: 'sold_product_transactions' });
    expect(pdf.disposition).toContain('SoldProductTransactions_');
    expect(pdf.disposition).toContain('_PARTIAL.pdf');
    expect(pdfText(pdf.bytes)).toContain('Sold Product Transactions');
  }, 120_000);

  it('Inventory Movement and Attendance PDFs: 100 complete, 101 partial, with counts from the aggregate and no other branch', async () => {
    const at = new Date();
    const movement = (branchId: string, inventoryItemId: string, movementType: 'WASTE' | 'RECEIVING') => ({ branchId, inventoryItemId, movementType, quantityChange: 1, quantityBefore: 0, quantityAfter: 1, createdAt: at });
    const existing = await prisma.inventoryStockMovement.count({ where: { branchId: ids.branch } });
    await prisma.inventoryStockMovement.createMany({ data: Array.from({ length: 100 - existing }, () => movement(ids.branch, ids.item, 'WASTE')) });
    await prisma.inventoryStockMovement.createMany({ data: Array.from({ length: 5 }, () => movement(ids.otherBranch, ids.otherItem, 'RECEIVING')) });

    const attendance = (branchId: string, employeeId: string) => ({ branchId, employeeId, clockInServerTime: at, clockOutServerTime: at, clockInGpsStatus: 'within_radius' as const, actualWorkMinutes: 60, overtimeMinutes: 6 });
    await prisma.attendanceRecord.createMany({ data: Array.from({ length: 99 }, () => attendance(ids.branch, ids.staff)) });
    await prisma.attendanceRecord.createMany({ data: Array.from({ length: 3 }, () => attendance(ids.otherBranch, ids.otherStaff)) });

    const exactMovement = await exportFile('INVENTORY_MOVEMENT', 'pdf');
    expect(exactMovement.disposition).not.toContain('PARTIAL');
    expect(pdfText(exactMovement.bytes)).toContain('Coverage: all 100 matching stock movements');
    const exactAttendance = await exportFile('ATTENDANCE_SUMMARY', 'pdf');
    expect(exactAttendance.disposition).not.toContain('PARTIAL');
    expect(pdfText(exactAttendance.bytes)).toContain('Coverage: all 100 matching attendance records');

    await prisma.inventoryStockMovement.create({ data: movement(ids.branch, ids.item, 'RECEIVING') });
    await prisma.attendanceRecord.create({ data: attendance(ids.branch, ids.staff) });
    const aboveMovement = await exportFile('INVENTORY_MOVEMENT', 'pdf');
    expect(aboveMovement.disposition).toContain('_PARTIAL.pdf');
    expect(pdfText(aboveMovement.bytes)).toContain('newest 100 matching stock movements');
    const aboveAttendance = await exportFile('ATTENDANCE_SUMMARY', 'pdf');
    expect(aboveAttendance.disposition).toContain('_PARTIAL.pdf');
    expect(pdfText(aboveAttendance.bytes)).toContain('newest 100 matching attendance records');

    const movementCsv = await exportFile('INVENTORY_MOVEMENT', 'csv');
    expect(movementCsv.disposition).not.toContain('PARTIAL');
    expect(csvDataRows(movementCsv.bytes.toString('utf-8'))).toHaveLength(101);

    const qs = new URLSearchParams({ branch_id: ids.branch, date_from: today, date_to: today });
    const { data } = await getData<{ movements: { total_count: number; receiving_count: number }; attendance: { record_count: number; open_count: number; work_minutes: number; overtime_minutes: number } }>(`/api/reports/period-summary?${qs.toString()}`);
    expect(data.movements.total_count).toBe(101);
    expect(data.movements.receiving_count).toBe(1);
    expect(data.attendance).toEqual({ record_count: 101, open_count: 1, work_minutes: 100 * 60, overtime_minutes: 100 * 6 });
  }, 180_000);

  it('a request for a Supervisor report beyond its limit cannot reach the PDF renderer through another route', async () => {
    await prisma.shift.deleteMany({ where: { branchId: ids.branch } }).catch(() => undefined);
    const shift = await exportFile('SHIFT_SUMMARY', 'pdf');
    expect(shift.status).toBe(200);
    expect(pdfText(shift.bytes)).toContain('Coverage: all 0 matching shifts');
  }, 60_000);
});
