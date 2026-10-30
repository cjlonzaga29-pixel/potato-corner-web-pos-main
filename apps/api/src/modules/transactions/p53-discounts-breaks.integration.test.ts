import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * POS-PERF-P53 — P50R (branch-scoped discounts, required discount choice,
 * tax snapshots) and P51 (Start Break / Resume Work, shiftGuard ON_BREAK)
 * together, through the real Express app against a real Postgres:
 *
 *   - a break that spans a branch discount change: Resume continues the same
 *     record, the stale rate is refused with nothing written, the new one
 *     sells and snapshots its source;
 *   - another cashier sells (with the required discount decision) while the
 *     first is on break;
 *   - a stale pre-break token cannot create a new sale, live or offline;
 *   - a sale the server already committed stays recoverable while its
 *     cashier is on break (read-only resolve with the Branch Account token),
 *     a same-key retry never duplicates it or reassigns its cashier, and a
 *     fenced (abandoned) key can never commit later;
 *   - a queued offline sale waits (whole-batch ON_BREAK, nothing written) and
 *     after Resume gets its per-row TAX_SETTINGS_CHANGED rejection with
 *     details, never a silent reprice;
 *   - the supervisor summary shows On Break, and other-branch supervisors,
 *     staff and Branch Account tokens are refused settings/attendance
 *     actions they do not own.
 *
 * Same loopback-only convention as attendance-breaks.integration.test.ts and
 * universal-inventory.http-concurrency.integration.test.ts (platform fetch,
 * no supertest).
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

vi.mock('../../lib/notify.js', () => ({ notifyBranch: vi.fn(), notifySuperAdmin: vi.fn(), notifyUser: vi.fn() }));

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { settingsService } = await import('../settings/settings.service.js');
const { generateStaffToken, generateSupervisorToken, generateBranchToken } = await import('../../test-utils/auth-tokens.js');

type ApiBody = { data: Record<string, unknown> | null; error: { code: string; message?: string; details?: unknown } | null };

describe.skipIf(!isLocalDatabase)('P53 discounts + breaks (real Express + Postgres)', () => {
  const tag = randomUUID().slice(0, 8);
  const ids = { branchA: '', branchB: '', supA: '', supB: '', ana: '', ben: '', branchUser: '', unit: '', potato: '', product: '', variant: '' };
  const tokens = { ana: '', ben: '', supA: '', supB: '', branch: '' };
  let server: Server;
  let baseUrl = '';
  let setupSucceeded = false;

  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Device-ID': `p53-${tag}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as ApiBody };
  }

  const item = (quantity = 1) => ({ product_id: ids.product, product_variant_id: ids.variant, quantity });

  function checkout(token: string, opts: { key?: string; employeeRate?: number; discountChoice?: 'none_applicable' | 'selected' } = {}) {
    return call('POST', '/api/transactions', token, {
      branch_id: ids.branchA,
      items: [item()],
      payment_method: 'cash',
      cash_tendered: 1000,
      is_offline_transaction: false,
      idempotency_key: opts.key ?? randomUUID(),
      ...(opts.employeeRate !== undefined ? { discount_type: 'employee', tax_basis: { vat_rate: 12, discount_rate: opts.employeeRate } } : { tax_basis: { vat_rate: 12, discount_rate: null } }),
      ...(opts.discountChoice ? { discount_choice: opts.discountChoice } : {}),
    });
  }

  async function saveBranchDiscounts(token: string, branchId: string, data: { employee?: { percentage: number; isEnabled: boolean } | null; requireDiscountChoice?: boolean }) {
    const current = await call('GET', `/api/settings/discounts/branches/${branchId}`, token);
    const override = (current.body.data?.override ?? null) as { employee?: unknown; pwdPercentage?: number | null; requireDiscountChoice?: boolean } | null;
    return call('PUT', `/api/settings/discounts/branches/${branchId}`, token, {
      employee: data.employee === undefined ? (override?.employee ?? null) : data.employee,
      pwdPercentage: override?.pwdPercentage ?? null,
      requireDiscountChoice: data.requireDiscountChoice ?? override?.requireDiscountChoice ?? false,
      expectedUpdatedAt: (current.body.data?.updatedAt as string | null | undefined) ?? null,
    });
  }

  async function salesFor(branchId: string) {
    return prisma.transaction.findMany({ where: { branchId }, select: { id: true, cashierId: true, idempotencyKey: true, discountRateUsed: true, taxSnapshot: true } });
  }

  async function availableStock() {
    const stock = await prisma.inventoryStock.findFirstOrThrow({ where: { branchId: ids.branchA, inventoryItemId: ids.potato } });
    return stock.quantityOnHand.toNumber() - stock.quantityReserved.toNumber();
  }

  beforeAll(async () => {
    for (const key of ['branchA', 'branchB'] as const) {
      ids[key] = (await prisma.branch.create({ data: { name: `P53 ${key} ${tag}`, code: `P53${key.slice(-1)}-${tag}`, address: 'x', city: 'x', status: 'active' } })).id;
    }
    const mk = async (role: 'staff' | 'supervisor' | 'branch', first: string) =>
      (
        await prisma.user.create({
          data: { role, firstName: first, lastName: `P53${tag}`, email: `${first.toLowerCase()}-${tag}@p53.test`, employeeId: role === 'staff' ? `P53-${first}-${tag}` : null, employmentType: 'regular', mustChangePassword: false },
        })
      ).id;
    ids.ana = await mk('staff', 'Ana');
    ids.ben = await mk('staff', 'Ben');
    ids.supA = await mk('supervisor', 'SupA');
    ids.supB = await mk('supervisor', 'SupB');
    ids.branchUser = await mk('branch', 'Counter');
    await prisma.userBranchAssignment.createMany({
      data: [
        { userId: ids.ana, branchId: ids.branchA },
        { userId: ids.ben, branchId: ids.branchA },
        { userId: ids.supA, branchId: ids.branchA },
        { userId: ids.supB, branchId: ids.branchB },
        { userId: ids.branchUser, branchId: ids.branchA },
      ],
    });
    ids.unit = (await prisma.unitOfMeasure.create({ data: { code: `p53-g-${tag}`, name: 'P53 Gram', dimension: 'WEIGHT', isBaseUnit: true } })).id;
    ids.potato = (await prisma.inventoryItem.create({ data: { name: `P53 potato ${tag}`, baseUnitId: ids.unit } })).id;
    for (const branchId of [ids.branchA, ids.branchB]) await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: ids.potato, quantityOnHand: 1000000 } });
    ids.product = (await prisma.product.create({ data: { name: `P53 Fries ${tag}`, status: 'active', classification: 'regular' } })).id;
    ids.variant = (await prisma.productVariant.create({ data: { productId: ids.product, name: 'Regular', sizeLabel: 'Regular', basePrice: 112, isActive: true } })).id;
    await prisma.productComponent.create({ data: { productVariantId: ids.variant, inventoryItemId: ids.potato, quantityRequired: 100 } });
    for (const branchId of [ids.branchA, ids.branchB]) await prisma.branchProductAvailability.create({ data: { branchId, productId: ids.product, isAvailable: true } });
    // Both cashiers clocked in at North; Ana's token is minted now and reused
    // after her break starts (a stale token still inside its TTL).
    for (const employeeId of [ids.ana, ids.ben]) {
      await prisma.attendanceRecord.create({
        data: { employeeId, branchId: ids.branchA, clockInServerTime: new Date(Date.now() - 2 * 3600_000), clockInGpsStatus: 'within_radius' },
      });
    }
    tokens.ana = generateStaffToken(ids.branchA, { userId: ids.ana });
    tokens.ben = generateStaffToken(ids.branchA, { userId: ids.ben });
    tokens.supA = generateSupervisorToken([ids.branchA], { userId: ids.supA });
    tokens.supB = generateSupervisorToken([ids.branchB], { userId: ids.supB });
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
    await prisma.$executeRaw`DELETE FROM "transaction_items" WHERE "transaction_id" IN (SELECT id FROM "transactions" WHERE "branch_id" = ANY(${branches}))`;
    await prisma.$executeRaw`DELETE FROM "inventory_deduction_jobs" WHERE "branch_id" = ANY(${branches})`;
    await prisma.$executeRaw`DELETE FROM "transactions" WHERE "branch_id" = ANY(${branches})`;
    await prisma.$executeRaw`DELETE FROM "checkout_attempts" WHERE "branch_id" = ANY(${branches})`;
    await prisma.attendanceRecord.deleteMany({ where: { branchId: { in: branches } } });
    await prisma.shift.deleteMany({ where: { branchId: { in: branches } } });
    await prisma.systemSetting.deleteMany({ where: { key: { in: branches.flatMap((b) => [`discount_policy:branch:${b}`, `tax_profile:branch:${b}`]) } } });
  });

  it('end to end: break across a discount change, a second cashier, stale tokens, lost responses, queued sales and authority', async () => {
    const orgEmployee = (await settingsService.getEffectiveDiscountPolicy(ids.branchA)).policy.employee.percentage;
    const newEmployee = orgEmployee === 10 ? 12 : 10;

    // 1. Ana sells while Working; the response is "lost" (we keep only the key).
    const lostKey = randomUUID();
    const first = await checkout(tokens.ana, { key: lostKey, employeeRate: orgEmployee });
    expect(first.status).toBe(201);
    const committedId = first.body.data?.id as string;

    // 2. Ana starts a break on the same open record.
    const start = await call('POST', '/api/attendance/break/start', tokens.ana, { branch_id: ids.branchA });
    expect(start.status).toBe(201);
    expect(start.body.data?.attendance_state).toBe('on_break');

    // 3. Her stale token cannot create a new sale — live or offline — and nothing is written.
    const stockBefore = await availableStock();
    const salesBefore = (await salesFor(ids.branchA)).length;
    const staleNew = await checkout(tokens.ana, { employeeRate: orgEmployee });
    expect(staleNew.status).toBe(403);
    expect(staleNew.body.error?.code).toBe('ON_BREAK');
    const queuedId = `PC-P53-${tag}-OFFLINE-0001`;
    const queuedSale = {
      offline_provisional_number: queuedId,
      items: [item()],
      payment_method: 'cash',
      cash_tendered: 1000,
      discount_type: 'employee',
      tax_basis: { vat_rate: 12, discount_rate: orgEmployee },
      client_created_at: Date.now() - 60_000,
    };
    const staleSync = await call('POST', '/api/transactions/sync-offline', tokens.ana, { branch_id: ids.branchA, transactions: [queuedSale] });
    expect(staleSync.status).toBe(403);
    expect(staleSync.body.error?.code).toBe('ON_BREAK');
    expect((await salesFor(ids.branchA)).length).toBe(salesBefore);
    expect(await availableStock()).toBe(stockBefore);

    // 4. The sale she already committed stays recoverable while she is on
    //    break: the same-key retry is refused before any write (no duplicate),
    //    and the read-only resolve (Branch Account token) returns it, still hers.
    const sameKeyOnBreak = await checkout(tokens.ana, { key: lostKey, employeeRate: orgEmployee });
    expect(sameKeyOnBreak.status).toBe(403);
    expect(sameKeyOnBreak.body.error?.code).toBe('ON_BREAK');
    const resolved = await call('GET', `/api/transactions/by-idempotency-key/${lostKey}?branch_id=${ids.branchA}`, tokens.branch);
    expect(resolved.status).toBe(200);
    expect(resolved.body.data?.status).toBe('committed');
    expect((resolved.body.data?.transaction as { id: string }).id).toBe(committedId);
    // Abandoning a committed key reports the sale instead of fencing it.
    const abandonCommitted = await call('POST', `/api/transactions/by-idempotency-key/${lostKey}/abandon`, tokens.branch, { branch_id: ids.branchA });
    expect(abandonCommitted.body.data?.status).toBe('committed');
    // The refused on-break attempt's key was never claimed; fencing it is
    // what lets the terminal mint a replacement safely.
    const refusedKey = randomUUID();
    expect((await checkout(tokens.ana, { key: refusedKey })).body.error?.code).toBe('ON_BREAK');
    const fenced = await call('POST', `/api/transactions/by-idempotency-key/${refusedKey}/abandon`, tokens.branch, { branch_id: ids.branchA });
    expect(fenced.body.data?.status).toBe('abandoned');

    // 5. A supervisor changes North's Employee rate and requires a discount decision, during Ana's break.
    const saved = await saveBranchDiscounts(tokens.supA, ids.branchA, { employee: { percentage: newEmployee, isEnabled: true }, requireDiscountChoice: true });
    expect(saved.status).toBe(200);

    // 6. Ben sells while Ana remains on break: the decision is required and actionable.
    const noChoice = await checkout(tokens.ben);
    expect(noChoice.status).toBeGreaterThanOrEqual(400);
    expect(noChoice.body.error?.code).toBe('DISCOUNT_CHOICE_REQUIRED');
    const benSale = await checkout(tokens.ben, { discountChoice: 'none_applicable' });
    expect(benSale.status).toBe(201);
    const benRow = (await salesFor(ids.branchA)).find((s) => s.id === (benSale.body.data?.id as string));
    expect(benRow?.cashierId).toBe(ids.ben);
    // Ben resubmitting Ana's committed key never makes him its cashier or a second sale.
    await checkout(tokens.ben, { key: lostKey, employeeRate: orgEmployee });
    const underLostKey = (await salesFor(ids.branchA)).filter((s) => s.idempotencyKey === lostKey);
    expect(underLostKey).toHaveLength(1);
    expect(underLostKey[0]?.cashierId).toBe(ids.ana);

    // 7. Supervisor dashboard: Ana On Break, Ben Working.
    const summary = await call('GET', `/api/attendance/branch/${ids.branchA}/summary`, tokens.supA);
    expect(summary.status).toBe(200);
    const rows = summary.body.data?.clocked_in as { employee_id: string; attendance_state: string }[];
    expect(rows.find((r) => r.employee_id === ids.ana)?.attendance_state).toBe('on_break');
    expect(rows.find((r) => r.employee_id === ids.ben)?.attendance_state).toBe('working');
    expect(summary.body.data?.on_break_count).toBe(1);

    // 8. Unauthorized settings / attendance actions are refused.
    expect((await call('GET', `/api/attendance/branch/${ids.branchA}/summary`, tokens.supB)).status).toBe(403);
    expect((await saveBranchDiscounts(tokens.supB, ids.branchA, { requireDiscountChoice: false })).status).toBe(403);
    expect((await call('PUT', `/api/settings/discounts/branches/${ids.branchA}`, tokens.ben, { employee: null, pwdPercentage: null, requireDiscountChoice: false, expectedUpdatedAt: null })).status).toBe(403);
    expect((await call('POST', '/api/attendance/break/start', tokens.branch, { branch_id: ids.branchA })).status).toBe(403);
    expect((await call('POST', '/api/attendance/break/end', tokens.ben, { branch_id: ids.branchB })).status).toBe(403);
    // Ben ending "a break" acts only on Ben (he has none) — Ana's stays open.
    expect((await call('POST', '/api/attendance/break/end', tokens.ben, { branch_id: ids.branchA })).body.error?.code).toBe('NOT_ON_BREAK');
    expect(await prisma.attendanceBreak.count({ where: { attendanceRecord: { employeeId: ids.ana }, endedAt: null } })).toBe(1);
    expect((await call('PUT', `/api/settings/tax/branches/${ids.branchA}`, tokens.supA, { vatRegistration: 'vat_registered', expectedUpdatedAt: null })).status).toBe(403);

    // 9. Ana resumes on the SAME record (no new clock-in).
    const resume = await call('POST', '/api/attendance/break/end', tokens.ana, { branch_id: ids.branchA });
    expect(resume.status).toBe(200);
    expect(resume.body.data?.attendance_state).toBe('working');
    expect(await prisma.attendanceRecord.count({ where: { employeeId: ids.ana, clockOutServerTime: null } })).toBe(1);

    // 10. After Resume: her lost-response retry replays the original sale (no duplicate, still hers).
    const replay = await checkout(tokens.ana, { key: lostKey, employeeRate: orgEmployee });
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.data?.id).toBe(committedId);
    expect((await salesFor(ids.branchA)).filter((s) => s.idempotencyKey === lostKey)).toHaveLength(1);
    // The fenced key can never commit later.
    const lateFenced = await checkout(tokens.ana, { key: refusedKey, discountChoice: 'none_applicable' });
    expect(lateFenced.status).toBeGreaterThanOrEqual(400);
    expect((await salesFor(ids.branchA)).filter((s) => s.idempotencyKey === refusedKey)).toHaveLength(0);

    // 11. The pre-break rate is refused with nothing written; the new rate sells and snapshots its source.
    const countBeforeStale = (await salesFor(ids.branchA)).length;
    const staleRate = await checkout(tokens.ana, { employeeRate: orgEmployee, discountChoice: 'selected' });
    expect(staleRate.body.error?.code).toBe('TAX_SETTINGS_CHANGED');
    expect((await salesFor(ids.branchA)).length).toBe(countBeforeStale);
    const fresh = await checkout(tokens.ana, { employeeRate: newEmployee, discountChoice: 'selected' });
    expect(fresh.status).toBe(201);
    const freshRow = (await salesFor(ids.branchA)).find((s) => s.id === (fresh.body.data?.id as string));
    expect(freshRow?.cashierId).toBe(ids.ana);
    expect(freshRow?.discountRateUsed?.toNumber()).toBe(newEmployee);
    expect(freshRow?.taxSnapshot).toMatchObject({ discount_rate_source: 'branch' });

    // 12. The queued offline sale (rung at the pre-change rate) now syncs
    //     under its original cashier and gets a per-row rejection with details.
    const sync = await call('POST', '/api/transactions/sync-offline', tokens.ana, { branch_id: ids.branchA, transactions: [queuedSale] });
    expect(sync.status).toBe(200);
    const results = sync.body.data?.results as { offline_provisional_number: string; status: string; error?: { code: string; message?: string } }[];
    expect(results).toHaveLength(1);
    expect(results[0]?.offline_provisional_number).toBe(queuedId);
    expect(results[0]?.status).not.toBe('synced');
    expect(results[0]?.error?.code).toBe('TAX_SETTINGS_CHANGED');
    expect(results[0]?.error?.message).toBeTruthy();
  });
});
