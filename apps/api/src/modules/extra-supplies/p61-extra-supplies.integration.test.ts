import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P61 — Extra Supplies against a real Postgres and the real Express app:
 * card setup and scope, unit conversion, the single stock write under reservations
 * and concurrency, exactly-once issues, cashier attribution through the guards, shift
 * cash, snapshots, and one set of totals across every role and export.
 *
 * Storage is stubbed where noted: this suite checks ordering and failure handling.
 * The real upload path is driven in the browser run (see the runbook).
 *
 * Requires TEST_DATABASE_URL pointing at a disposable, migrated database.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { supabaseAdmin } = await import('../../lib/supabase.js');
const { extraSuppliesService } = await import('./extra-supplies.service.js');
const { cashService } = await import('../cash/cash.service.js');
const { universalInventoryRepository } = await import('../universal-inventory/universal-inventory.repository.js');
const { reportsRepository } = await import('../reports/reports.repository.js');
const { generateStaffToken, generateSupervisorToken, generateSuperAdminToken } = await import('../../test-utils/auth-tokens.js');

describe.skipIf(!canRunIntegrationTests)('P61 extra supplies', () => {
  const tag = randomUUID().slice(0, 8);
  const ids = { branchA: '', branchB: '', branchC: '', supAB: '', supC: '', admin: '', cashier: '', cashier2: '', cashierB: '', unitPc: '', unitBox: '', unitNoConv: '', unitG: '', unitKg: '', itemCup: '', itemBag: '', itemNoCost: '', shiftA: '', shiftB: '' };
  let server: Server;
  let baseUrl: string;

  const sup = (id = ids.supAB) => ({ id, role: 'supervisor' });
  const supJwt = (id = ids.supAB): JwtPayload => ({ user_id: id, role: 'supervisor', email: `${id}@t.test`, branch_ids: [], iat: 0, exp: 0 });
  const adminJwt = (): JwtPayload => ({ user_id: ids.admin, role: 'super_admin', email: 'a@t.test', iat: 0, exp: 0 });
  const staffJwt = (id: string, branchId: string): JwtPayload => ({ user_id: id, role: 'staff', email: `${id}@t.test`, branch_ids: [branchId], iat: 0, exp: 0 });
  const cashierActor = (id = ids.cashier) => ({ id, role: 'staff' });
  const unique = (name: string) => `${name} ${randomUUID().slice(0, 6)}`;

  async function user(role: 'supervisor' | 'super_admin' | 'staff', name: string) {
    const row = await prisma.user.create({
      data: { email: `${name}-${tag}@potatocorner.test`, passwordHash: 'unused', role, firstName: 'P61', lastName: name, employmentType: 'regular', mustChangePassword: false },
    });
    return row.id;
  }

  async function branch(label: string) {
    return (await prisma.branch.create({ data: { name: `P61 ${label} ${randomUUID().slice(0, 6)}`, code: `P61-${randomUUID().slice(0, 8)}`, address: '1 Test St', city: 'Test', status: 'active' } })).id;
  }

  async function unit(code: string, dimension: 'COUNT' | 'WEIGHT' = 'COUNT') {
    return (await prisma.unitOfMeasure.create({ data: { code: `${code}-${tag}`, name: `${code} ${tag}`, dimension } })).id;
  }

  async function item(name: string, baseUnitId: string, unitCost: number | null = null) {
    return (await prisma.inventoryItem.create({ data: { name: `${name} ${tag}`, baseUnitId, unitCost } })).id;
  }

  async function setStock(branchId: string, inventoryItemId: string, onHand: number, reserved = 0, unitCost: number | null = null) {
    await prisma.inventoryStock.upsert({
      where: { branchId_inventoryItemId: { branchId, inventoryItemId } },
      create: { branchId, inventoryItemId, quantityOnHand: onHand, quantityReserved: reserved, unitCost },
      update: { quantityOnHand: onHand, quantityReserved: reserved, unitCost },
    });
  }

  async function stockOf(branchId: string, inventoryItemId: string) {
    const row = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId } } });
    return { onHand: row.quantityOnHand.toNumber(), reserved: row.quantityReserved.toNumber() };
  }

  async function card(overrides: Partial<Parameters<typeof extraSuppliesService.create>[0]> = {}) {
    return extraSuppliesService.create(
      { name: unique('Cup'), inventory_item_id: ids.itemCup, issue_unit_name: 'cup', entered_quantity: 1, entered_unit_id: ids.unitPc, selling_price: 5, apply_to_pos: true, branch_ids: [ids.branchA, ids.branchB], ...overrides },
      sup(),
      null,
    );
  }

  type IssueInput = Parameters<typeof extraSuppliesService.createIssue>[0];
  const freeIssue = (cardId: string, version: number, quantity: number, overrides: Partial<IssueInput> = {}): IssueInput => ({
    operation_id: randomUUID(),
    branch_id: ids.branchA,
    kind: 'free',
    lines: [{ extra_supply_id: cardId, quantity, version }],
    reason: 'Customer asked for extra',
    ...overrides,
  });
  const cashIssue = (cardId: string, version: number, quantity: number, tendered: number, overrides: Partial<IssueInput> = {}): IssueInput => ({
    operation_id: randomUUID(),
    branch_id: ids.branchA,
    kind: 'paid',
    lines: [{ extra_supply_id: cardId, quantity, version }],
    payment_method: 'cash',
    cash_tendered: tendered,
    ...overrides,
  });
  const issue = (input: IssueInput, actor = cashierActor(), branchId = ids.branchA, shiftId = ids.shiftA) => extraSuppliesService.createIssue(input, branchId, shiftId, actor, null);

  async function code(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
      return 'NO_ERROR';
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
  }

  async function openShift(branchId: string, cashierId: string) {
    return (await prisma.shift.create({ data: { branchId, cashierId, openedBy: cashierId, openingCashAmount: 1000, startedAt: new Date() } })).id;
  }

  async function clockIn(employeeId: string, branchId: string) {
    return prisma.attendanceRecord.create({
      data: { employeeId, branchId, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsLat: 14.6, clockInGpsLng: 121.0, clockInGpsStatus: 'within_radius' },
    });
  }

  function post(path: string, token: string, body: unknown) {
    return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Device-ID': randomUUID() }, body: JSON.stringify(body) });
  }
  function get(path: string, token: string) {
    return fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  }

  beforeAll(async () => {
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    ids.supAB = await user('supervisor', 'supab');
    ids.supC = await user('supervisor', 'supc');
    ids.admin = await user('super_admin', 'admin');
    ids.cashier = await user('staff', 'cashier');
    ids.cashier2 = await user('staff', 'cashier2');
    ids.cashierB = await user('staff', 'cashierb');
    ids.branchA = await branch('A');
    ids.branchB = await branch('B');
    ids.branchC = await branch('C');
    await prisma.userBranchAssignment.createMany({
      data: [
        { userId: ids.supAB, branchId: ids.branchA },
        { userId: ids.supAB, branchId: ids.branchB },
        { userId: ids.supC, branchId: ids.branchC },
        { userId: ids.cashier, branchId: ids.branchA },
        { userId: ids.cashier2, branchId: ids.branchA },
        { userId: ids.cashierB, branchId: ids.branchB },
      ],
    });
    ids.unitPc = await unit('pc');
    ids.unitBox = await unit('box');
    ids.unitNoConv = await unit('sack');
    ids.unitG = await unit('g', 'WEIGHT');
    ids.unitKg = await unit('kg', 'WEIGHT');
    await prisma.unitConversion.create({ data: { fromUnitId: ids.unitKg, toUnitId: ids.unitG, factor: 1000 } });
    ids.itemCup = await item('Paper Cup', ids.unitPc);
    ids.itemBag = await item('Plastic Bag', ids.unitG);
    ids.itemNoCost = await item('Tissue', ids.unitPc);
    await prisma.inventoryItemUnitConversion.create({ data: { inventoryItemId: ids.itemCup, fromUnitId: ids.unitBox, toUnitId: ids.unitPc, factor: 50 } });
    ids.shiftA = await openShift(ids.branchA, ids.cashier);
    ids.shiftB = await openShift(ids.branchB, ids.cashierB);
    await setStock(ids.branchA, ids.itemCup, 1000, 0, 2);
    await setStock(ids.branchA, ids.itemBag, 1000, 0, 0.5);
    await setStock(ids.branchA, ids.itemNoCost, 1000);
    await setStock(ids.branchB, ids.itemCup, 1000, 0, 3);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------- setup
  describe('setup', () => {
    it('creates a card that owns no balance and stores the conversion it showed', async () => {
      // POS-PERF-P62 — counted for this file's own item, at every branch. A whole-table
      // count also saw rows other test files created in parallel (failed: 6, expected 4).
      const ownStock = { where: { inventoryItemId: ids.itemCup } };
      const stockRowsBefore = await prisma.inventoryStock.count(ownStock);
      const created = await card({ entered_quantity: 2, entered_unit_id: ids.unitBox });
      expect(created).toMatchObject({ version: 1, is_active: true, entered_quantity: 2, base_quantity: 100, can_manage: true, issue_count: 0 });
      expect(await prisma.inventoryStock.count(ownStock)).toBe(stockRowsBefore);
    });

    it('converts through a global conversion and previews exactly what a save stores', async () => {
      const preview = await extraSuppliesService.previewConversion(ids.itemBag, 0.005, ids.unitKg);
      expect(preview.base_quantity).toBe(5);
      const created = await card({ inventory_item_id: ids.itemBag, entered_quantity: 0.005, entered_unit_id: ids.unitKg });
      expect(created.base_quantity).toBe(5);
    });

    it('refuses a unit with no conversion, and never guesses one', async () => {
      expect(await code(card({ entered_unit_id: ids.unitNoConv }))).toBe('EXTRA_SUPPLY_NO_CONVERSION');
      expect(await code(card({ inventory_item_id: ids.itemCup, entered_unit_id: ids.unitG }))).toBe('EXTRA_SUPPLY_NO_CONVERSION');
    });

    it('refuses a conversion stock cannot record exactly rather than rounding it', async () => {
      expect(await code(card({ inventory_item_id: ids.itemBag, entered_quantity: 0.0000001, entered_unit_id: ids.unitKg }))).toBe('EXTRA_SUPPLY_QUANTITY_PRECISION');
    });

    it('refuses an untracked or deleted item', async () => {
      const untracked = await prisma.inventoryItem.create({ data: { name: `Untracked ${tag}`, baseUnitId: ids.unitPc, trackInventory: false } });
      expect(await code(card({ inventory_item_id: untracked.id }))).toBe('INVENTORY_ITEM_NOT_TRACKED');
      const gone = await prisma.inventoryItem.create({ data: { name: `Gone ${tag}`, baseUnitId: ids.unitPc, deletedAt: new Date() } });
      expect(await code(card({ inventory_item_id: gone.id }))).toBe('INVENTORY_ITEM_NOT_FOUND');
    });

    it('names are unique among active cards per branch, including under a race', async () => {
      const name = unique('Bag');
      await card({ name });
      expect(await code(card({ name: `  ${name.toUpperCase()} ` }))).toBe('EXTRA_SUPPLY_NAME_TAKEN');
      const racing = unique('Race');
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => card({ name: racing })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('a stale edit is refused, and a good one moves the version', async () => {
      const created = await card();
      const edited = await extraSuppliesService.update(created.id, { selling_price: 7, expected_version: created.version }, sup(), null);
      expect(edited).toMatchObject({ selling_price: 7, version: 2 });
      expect(await code(extraSuppliesService.update(created.id, { selling_price: 9, expected_version: created.version }, sup(), null))).toBe('EXTRA_SUPPLY_CONFLICT');
    });

    it('deactivate and reactivate; a name now taken blocks reactivation', async () => {
      const name = unique('Lid');
      const first = await card({ name });
      const off = await extraSuppliesService.setActive(first.id, false, first.version, sup(), null);
      expect(off.is_active).toBe(false);
      await card({ name });
      expect(await code(extraSuppliesService.setActive(first.id, true, off.version, sup(), null))).toBe('EXTRA_SUPPLY_NAME_TAKEN');
    });

    it('enforces live scope: foreign branch, foreign card, partial overlap, revoked assignment', async () => {
      expect(await code(card({ branch_ids: [ids.branchC] }))).toBe('BRANCH_ACCESS_DENIED');
      const created = await card();
      expect(await code(extraSuppliesService.update(created.id, { selling_price: 8, expected_version: 1 }, sup(ids.supC), null))).toBe('EXTRA_SUPPLY_NOT_FOUND');

      // Assigned to A and B, then losing B: can still see the card, can't change it.
      const shrinking = await user('supervisor', `shrink-${randomUUID().slice(0, 4)}`);
      await prisma.userBranchAssignment.createMany({ data: [{ userId: shrinking, branchId: ids.branchA }, { userId: shrinking, branchId: ids.branchB }] });
      const owned = await extraSuppliesService.create(
        { name: unique('Spoon'), inventory_item_id: ids.itemCup, issue_unit_name: 'pc', entered_quantity: 1, entered_unit_id: ids.unitPc, apply_to_pos: true, branch_ids: [ids.branchA, ids.branchB] },
        sup(shrinking),
        null,
      );
      await prisma.userBranchAssignment.updateMany({ where: { userId: shrinking, branchId: ids.branchB }, data: { removedAt: new Date() } });
      expect(await code(extraSuppliesService.update(owned.id, { selling_price: 8, expected_version: 1 }, sup(shrinking), null))).toBe('EXTRA_SUPPLY_SCOPE_FORBIDDEN');
      const listed = await extraSuppliesService.list(supJwt(shrinking), { include_inactive: true });
      expect(listed.supplies.find((s) => s.id === owned.id)).toMatchObject({ can_manage: false, other_branch_count: 1 });
    });

    it('a branch that issued a card cannot be removed from it; one that never did can', async () => {
      const created = await card();
      await issue(freeIssue(created.id, created.version, 1));
      expect(await code(extraSuppliesService.update(created.id, { branch_ids: [ids.branchB], expected_version: created.version }, sup(), null))).toBe('EXTRA_SUPPLY_SCOPE_IN_USE');
      const narrowed = await extraSuppliesService.update(created.id, { branch_ids: [ids.branchA], expected_version: created.version }, sup(), null);
      expect(narrowed.branches.map((b) => b.branch_id)).toEqual([ids.branchA]);
    });

    it('supervisor-only writes through the routes: staff and admin are refused', async () => {
      const body = { name: unique('X'), inventory_item_id: ids.itemCup, issue_unit_name: 'pc', entered_quantity: 1, entered_unit_id: ids.unitPc, branch_ids: [ids.branchA] };
      expect((await post('/api/extra-supplies', generateStaffToken(ids.branchA, { userId: ids.cashier }), body)).status).toBe(403);
      expect((await post('/api/extra-supplies', generateSuperAdminToken({ userId: ids.admin }), body)).status).toBe(403);
      expect((await post('/api/extra-supplies', generateSupervisorToken([ids.branchA], { userId: ids.supAB }), body)).status).toBe(201);
    });

    it('a failed image replacement keeps the old picture, the card and its version', async () => {
      const created = await card();
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      const remove = vi.fn().mockResolvedValue({ data: [], error: null });
      const signed = vi.fn().mockResolvedValue({ data: [], error: null });
      const upload = vi.fn().mockResolvedValue({ data: {}, error: null });
      vi.spyOn(supabaseAdmin.storage, 'from').mockReturnValue({ upload, remove, createSignedUrls: signed } as never);

      await extraSuppliesService.uploadImage(created.id, { buffer: png }, created.version, sup(), null);
      const withImage = await prisma.extraSupply.findUniqueOrThrow({ where: { id: created.id } });
      expect(withImage.imagePath).toMatch(new RegExp(`^extra-supplies/${created.id}/`));
      expect(remove).not.toHaveBeenCalled();

      // The replacement upload fails: nothing about the card moves and nothing is deleted.
      upload.mockResolvedValueOnce({ data: null, error: new Error('storage down') });
      expect(await code(extraSuppliesService.uploadImage(created.id, { buffer: png }, withImage.version, sup(), null))).toBe('EXTRA_SUPPLY_IMAGE_UPLOAD_FAILED');
      const after = await prisma.extraSupply.findUniqueOrThrow({ where: { id: created.id } });
      expect(after.imagePath).toBe(withImage.imagePath);
      expect(after.version).toBe(withImage.version);
      expect(remove).not.toHaveBeenCalled();

      // A good replacement goes to a new path, and only then is the old object removed.
      await extraSuppliesService.uploadImage(created.id, { buffer: png }, after.version, sup(), null);
      const replaced = await prisma.extraSupply.findUniqueOrThrow({ where: { id: created.id } });
      expect(replaced.imagePath).not.toBe(after.imagePath);
      expect(remove).toHaveBeenCalledWith([after.imagePath]);

      // A stale version uploads nothing it keeps: the orphan is cleaned and the live picture stays.
      remove.mockClear();
      expect(await code(extraSuppliesService.uploadImage(created.id, { buffer: png }, after.version, sup(), null))).toBe('EXTRA_SUPPLY_CONFLICT');
      expect((await prisma.extraSupply.findUniqueOrThrow({ where: { id: created.id } })).imagePath).toBe(replaced.imagePath);
    });
  });

  // ---------------------------------------------------------------- free and paid
  describe('free and paid issues', () => {
    it('free: deducts stock with a movement, collects nothing, creates no expense, payroll or sale', async () => {
      const created = await card({ entered_quantity: 2, entered_unit_id: ids.unitPc });
      const before = await stockOf(ids.branchA, ids.itemCup);
      const counts = async () => ({ expenses: await prisma.expense.count({ where: { branchId: ids.branchA } }), transactions: await prisma.transaction.count({ where: { branchId: ids.branchA } }), adjustments: await prisma.payrollAdjustment.count() });
      const countsBefore = await counts();

      const result = await issue(freeIssue(created.id, created.version, 3));
      expect(result).toMatchObject({ kind: 'free', amount_collected: 0, payment_method: null, cashier_id: ids.cashier, shift_id: ids.shiftA, reason: 'Customer asked for extra' });
      expect(result.reference_number).toMatch(/^ES-P61-.*-\d{8}-\d{6}$/);
      expect(result.lines[0]).toMatchObject({ quantity: 3, base_quantity_total: 6, cost_source: 'inventory', unit_cost: 4, line_cost: 12, line_amount: 0, unit_price: null });

      expect((await stockOf(ids.branchA, ids.itemCup)).onHand).toBe(before.onHand - 6);
      expect(await counts()).toEqual(countsBefore);

      const movements = await prisma.inventoryStockMovement.findMany({ where: { referenceType: 'extra_supply_issue', referenceId: result.id } });
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({ movementType: 'ADJUSTMENT_OUT', performedByUserId: ids.cashier, responsibleUserId: ids.cashier });
      expect(movements[0]?.quantityChange.toNumber()).toBe(-6);
      expect(movements[0]?.quantityAfter.toNumber()).toBe(before.onHand - 6);
      expect(movements[0]?.totalCost?.toNumber()).toBe(12);
      expect(movements[0]?.notes).toContain(result.reference_number);
    });

    it('paid: the server calculates the amount, whatever was on screen, and records change', async () => {
      const created = await card({ selling_price: 4.5 });
      const result = await issue(cashIssue(created.id, created.version, 3, 20));
      expect(result).toMatchObject({ kind: 'paid', amount_collected: 13.5, payment_method: 'cash', amount_tendered: 20, change_amount: 6.5 });
      expect(result.lines[0]).toMatchObject({ unit_price: 4.5, line_amount: 13.5 });
    });

    it('paid: too little cash and a card with no price are refused with no writes', async () => {
      const created = await card({ selling_price: 5 });
      const stock = await stockOf(ids.branchA, ids.itemCup);
      expect(await code(issue(cashIssue(created.id, created.version, 2, 9.99)))).toBe('INSUFFICIENT_CASH_TENDERED');
      const noPrice = await card({ selling_price: null });
      expect(await code(issue(cashIssue(noPrice.id, noPrice.version, 1, 100)))).toBe('EXTRA_SUPPLY_NOT_FOR_SALE');
      expect(await stockOf(ids.branchA, ids.itemCup)).toEqual(stock);
    });

    it('paid non-cash needs its own proof: another branch or cashier cannot supply one', async () => {
      const created = await card({ selling_price: 5 });
      const paid = (key: string) => ({
        operation_id: randomUUID(),
        branch_id: ids.branchA,
        kind: 'paid' as const,
        lines: [{ extra_supply_id: created.id, quantity: 1, version: created.version }],
        payment_method: 'gcash' as const,
        payment_proof_key: key,
        payment_proof_type: 'gallery_upload' as const,
      });
      expect(await code(issue(paid(`${ids.branchB}/${ids.shiftB}/${ids.cashier}-1-a.webp`)))).toBe('PAYMENT_PROOF_INVALID');
      expect(await code(issue(paid(`${ids.branchA}/${ids.shiftA}/${ids.cashier2}-1-a.webp`)))).toBe('PAYMENT_PROOF_INVALID');
      const ok = await issue(paid(`${ids.branchA}/${ids.shiftA}/${ids.cashier}-1-a.webp`));
      expect(ok).toMatchObject({ payment_method: 'gcash', amount_collected: 5, amount_tendered: null, has_payment_proof: true });
    });

    it('cost comes from the inventory first, then the configured figure, and unknown never reads as zero', async () => {
      const configured = await card({ inventory_item_id: ids.itemNoCost, configured_issue_cost: 1.25 });
      const a = await issue(freeIssue(configured.id, configured.version, 2));
      expect(a.lines[0]).toMatchObject({ cost_source: 'configured', unit_cost: 1.25, line_cost: 2.5 });
      // A configured cost must not reach the ledger that feeds inventory value.
      const movement = await prisma.inventoryStockMovement.findFirstOrThrow({ where: { referenceId: a.id } });
      expect(movement.totalCost).toBeNull();

      const unknown = await card({ inventory_item_id: ids.itemNoCost });
      const b = await issue(freeIssue(unknown.id, unknown.version, 2));
      expect(b.lines[0]).toMatchObject({ cost_source: 'unknown', unit_cost: null, line_cost: null });

      // The item's own default cost applies when the branch has no override.
      const withItemCost = await item('Straw', ids.unitPc, 0.75);
      await setStock(ids.branchA, withItemCost, 10);
      const c = await card({ inventory_item_id: withItemCost });
      const d = await issue(freeIssue(c.id, c.version, 2));
      expect(d.lines[0]).toMatchObject({ cost_source: 'inventory', unit_cost: 0.75, line_cost: 1.5 });
    });

    it('the request schema refuses browser-supplied identity and payment on a free issue', async () => {
      const { createExtraSupplyIssueSchema } = await import('@potato-corner/shared');
      const base = { operation_id: randomUUID(), branch_id: ids.branchA, lines: [{ extra_supply_id: randomUUID(), quantity: 1, version: 1 }] };
      const stripped = createExtraSupplyIssueSchema.parse({ ...base, kind: 'free', reason: 'x', cashier_id: ids.cashier2, shift_id: ids.shiftB, amount_collected: 0 }) as Record<string, unknown>;
      expect(stripped.cashier_id).toBeUndefined();
      expect(stripped.shift_id).toBeUndefined();
      expect(createExtraSupplyIssueSchema.safeParse({ ...base, kind: 'free' }).success).toBe(false);
      expect(createExtraSupplyIssueSchema.safeParse({ ...base, kind: 'free', reason: 'x', payment_method: 'cash' }).success).toBe(false);
      expect(createExtraSupplyIssueSchema.safeParse({ ...base, kind: 'paid', payment_method: 'cash' }).success).toBe(false);
      expect(createExtraSupplyIssueSchema.safeParse({ ...base, kind: 'paid', payment_method: 'gcash', payment_reference: 'x' }).success).toBe(false);
      expect(createExtraSupplyIssueSchema.safeParse({ ...base, kind: 'free', reason: 'x', lines: [{ ...base.lines[0], quantity: 1.5 }] }).success).toBe(false);
    });
  });

  // ---------------------------------------------------------------- stock
  describe('stock', () => {
    async function freshItem(onHand: number, reserved = 0) {
      const id = await item(`Stock ${randomUUID().slice(0, 6)}`, ids.unitPc);
      await setStock(ids.branchA, id, onHand, reserved, 1);
      return id;
    }

    it('respects reservations: stock held for a pending sale is not available', async () => {
      const itemId = await freshItem(10, 8);
      const created = await card({ inventory_item_id: itemId });
      const cards = await extraSuppliesService.terminalCards(staffJwt(ids.cashier, ids.branchA), ids.branchA);
      expect(cards.cards.find((c) => c.id === created.id)).toMatchObject({ available_issue_quantity: 2, available_base_quantity: 2 });

      expect(await code(issue(freeIssue(created.id, created.version, 3)))).toBe('INSUFFICIENT_STOCK');
      expect(await stockOf(ids.branchA, itemId)).toEqual({ onHand: 10, reserved: 8 });

      await issue(freeIssue(created.id, created.version, 2));
      expect(await stockOf(ids.branchA, itemId)).toEqual({ onHand: 8, reserved: 8 });
    });

    it('aggregates cards sharing an item; a shortage across them writes nothing at all', async () => {
      const itemId = await freshItem(10);
      const other = await freshItem(100);
      const a = await card({ inventory_item_id: itemId, entered_quantity: 2 });
      const b = await card({ inventory_item_id: itemId, entered_quantity: 3 });
      const c = await card({ inventory_item_id: other });
      const issuesBefore = await prisma.extraSupplyIssue.count();
      const movementsBefore = await prisma.inventoryStockMovement.count({ where: { inventoryItemId: { in: [itemId, other] } } });

      // 2 x 3 + 3 x 2 = 12 > 10. Each line alone would pass.
      const shortfall = {
        ...freeIssue(a.id, a.version, 3),
        lines: [
          { extra_supply_id: c.id, quantity: 5, version: c.version },
          { extra_supply_id: a.id, quantity: 3, version: a.version },
          { extra_supply_id: b.id, quantity: 2, version: b.version },
        ],
      };
      expect(await code(issue(shortfall))).toBe('INSUFFICIENT_STOCK');
      expect((await stockOf(ids.branchA, itemId)).onHand).toBe(10);
      expect((await stockOf(ids.branchA, other)).onHand).toBe(100);
      expect(await prisma.extraSupplyIssue.count()).toBe(issuesBefore);
      expect(await prisma.inventoryStockMovement.count({ where: { inventoryItemId: { in: [itemId, other] } } })).toBe(movementsBefore);
      expect(await prisma.extraSupplyOperation.count({ where: { id: shortfall.operation_id } })).toBe(0);

      // 2 x 2 + 3 x 2 = 10 fits exactly, as one movement for the shared item.
      const fits = await issue({ ...freeIssue(a.id, a.version, 2), lines: [{ extra_supply_id: a.id, quantity: 2, version: a.version }, { extra_supply_id: b.id, quantity: 2, version: b.version }] });
      expect((await stockOf(ids.branchA, itemId)).onHand).toBe(0);
      const movements = await prisma.inventoryStockMovement.findMany({ where: { referenceId: fits.id } });
      expect(movements).toHaveLength(1);
      expect(movements[0]?.quantityChange.toNumber()).toBe(-10);
    });

    it('concurrent reservations and issues can never overspend stock', async () => {
      const itemId = await freshItem(10);
      const created = await card({ inventory_item_id: itemId });
      // The same conditional statement reserveStockForSale runs.
      const reserve = (quantity: number) => prisma.$executeRaw`
        UPDATE "inventory_stocks" SET "quantity_reserved" = "quantity_reserved" + ${quantity}, "version" = "version" + 1, "updated_at" = now()
        WHERE "branch_id" = ${ids.branchA} AND "inventory_item_id" = ${itemId} AND "quantity_on_hand" - "quantity_reserved" >= ${quantity}`;
      const attempts = await Promise.allSettled(Array.from({ length: 12 }, (_, n) => (n % 2 === 0 ? reserve(2) : issue(freeIssue(created.id, created.version, 2)))));
      const stock = await stockOf(ids.branchA, itemId);
      const reservedOk = attempts.filter((r, n) => n % 2 === 0 && r.status === 'fulfilled' && r.value === 1).length;
      const issuedOk = attempts.filter((r, n) => n % 2 === 1 && r.status === 'fulfilled').length;
      expect(reservedOk * 2 + issuedOk * 2).toBeLessThanOrEqual(10);
      expect(stock.reserved).toBe(reservedOk * 2);
      expect(stock.onHand).toBe(10 - issuedOk * 2);
      expect(stock.onHand - stock.reserved).toBeGreaterThanOrEqual(0);
      for (const result of attempts) if (result.status === 'rejected') expect((result.reason as { code: string }).code).toBe('INSUFFICIENT_STOCK');
    });

    it('a pending sale still deducts normally after an issue around it', async () => {
      const itemId = await freshItem(10, 4);
      const created = await card({ inventory_item_id: itemId });
      await issue(freeIssue(created.id, created.version, 6));
      expect(await stockOf(ids.branchA, itemId)).toEqual({ onHand: 4, reserved: 4 });
      // The worker's own check: on-hand still covers the sale it reserved for.
      const row = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId: ids.branchA, inventoryItemId: itemId } } });
      expect(row.quantityOnHand.greaterThanOrEqualTo(row.quantityReserved)).toBe(true);
    });

    it('a missing stock row at the branch is a shortage, not an error or a new balance', async () => {
      const itemId = await item(`NoRow ${randomUUID().slice(0, 6)}`, ids.unitPc);
      const created = await card({ inventory_item_id: itemId });
      expect(await code(issue(freeIssue(created.id, created.version, 1)))).toBe('INSUFFICIENT_STOCK');
      expect(await prisma.inventoryStock.count({ where: { inventoryItemId: itemId } })).toBe(0);
    });

    it('stale, deactivated, not-on-POS, out-of-scope and re-based cards are refused with no writes', async () => {
      const itemId = await freshItem(100);
      const created = await card({ inventory_item_id: itemId });
      const edited = await extraSuppliesService.update(created.id, { selling_price: 6, expected_version: created.version }, sup(), null);
      expect(await code(issue(cashIssue(created.id, created.version, 1, 100)))).toBe('EXTRA_SUPPLY_CONFIG_STALE');

      const hidden = await extraSuppliesService.update(created.id, { apply_to_pos: false, expected_version: edited.version }, sup(), null);
      expect(await code(issue(freeIssue(created.id, hidden.version, 1)))).toBe('EXTRA_SUPPLY_UNAVAILABLE');
      const shown = await extraSuppliesService.update(created.id, { apply_to_pos: true, expected_version: hidden.version }, sup(), null);
      const off = await extraSuppliesService.setActive(created.id, false, shown.version, sup(), null);
      expect(await code(issue(freeIssue(created.id, off.version, 1)))).toBe('EXTRA_SUPPLY_UNAVAILABLE');

      const foreign = await extraSuppliesService.create(
        { name: unique('Foreign'), inventory_item_id: ids.itemCup, issue_unit_name: 'pc', entered_quantity: 1, entered_unit_id: ids.unitPc, apply_to_pos: true, branch_ids: [ids.branchC] },
        sup(ids.supC),
        null,
      );
      expect(await code(issue(freeIssue(foreign.id, foreign.version, 1)))).toBe('EXTRA_SUPPLY_UNAVAILABLE');
      expect(await code(issue(freeIssue(randomUUID(), 1, 1)))).toBe('EXTRA_SUPPLY_UNAVAILABLE');

      const reBased = await freshItem(100);
      const c = await card({ inventory_item_id: reBased });
      await prisma.inventoryItem.update({ where: { id: reBased }, data: { baseUnitId: ids.unitBox } });
      expect(await code(issue(freeIssue(c.id, c.version, 1)))).toBe('EXTRA_SUPPLY_INVENTORY_UNAVAILABLE');
      expect((await stockOf(ids.branchA, itemId)).onHand).toBe(100);
    });
  });

  // ---------------------------------------------------------------- exactly once
  describe('exactly once', () => {
    it('double click: concurrent submissions of one operation post one issue, one deduction, one collection', async () => {
      const created = await card({ selling_price: 5 });
      const before = await stockOf(ids.branchA, ids.itemCup);
      const input = cashIssue(created.id, created.version, 2, 10);
      const results = await Promise.all(Array.from({ length: 8 }, () => issue(input)));

      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect((await stockOf(ids.branchA, ids.itemCup)).onHand).toBe(before.onHand - 2);
      const id = results[0]?.id as string;
      expect(await prisma.extraSupplyIssue.count({ where: { id } })).toBe(1);
      expect(await prisma.inventoryStockMovement.count({ where: { referenceId: id } })).toBe(1);
      expect(await prisma.auditOutbox.count({ where: { action: 'EXTRA_SUPPLY_ISSUED', entityId: id } })).toBe(1);
    });

    it('lost reply and reload: the same id, later and under a new device, replays without another deduction', async () => {
      const created = await card();
      const input = freeIssue(created.id, created.version, 1);
      await clockIn(ids.cashier, ids.branchA);
      const token = generateStaffToken(ids.branchA, { userId: ids.cashier });

      const first = await post('/api/extra-supplies/issues', token, input);
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as { data: { id: string } };
      const after = await stockOf(ids.branchA, ids.itemCup);

      const recovered = (await (await get(`/api/extra-supplies/operations/${input.operation_id}`, token)).json()) as { data: { status: string; issue: { id: string } } };
      expect(recovered.data).toMatchObject({ status: 'committed', issue: { id: firstBody.data.id } });

      // post() sends a fresh X-Device-ID each time. Identity is the operation, not the device.
      const retry = await post('/api/extra-supplies/issues', token, input);
      expect(retry.status).toBe(200);
      expect(((await retry.json()) as { data: { id: string; replayed: boolean } }).data).toMatchObject({ id: firstBody.data.id, replayed: true });
      expect(await stockOf(ids.branchA, ids.itemCup)).toEqual(after);
      await prisma.attendanceRecord.updateMany({ where: { employeeId: ids.cashier, clockOutServerTime: null }, data: { clockOutServerTime: new Date() } });
    });

    it('the same id with a changed payload is refused and changes nothing', async () => {
      const created = await card();
      const input = freeIssue(created.id, created.version, 1);
      const posted = await issue(input);
      const stock = await stockOf(ids.branchA, ids.itemCup);
      expect(await code(issue({ ...input, lines: [{ extra_supply_id: created.id, quantity: 2, version: created.version }] }))).toBe('EXTRA_SUPPLY_OPERATION_REUSED');
      expect(await code(issue({ ...input, reason: 'Something else' }))).toBe('EXTRA_SUPPLY_OPERATION_REUSED');
      expect(await stockOf(ids.branchA, ids.itemCup)).toEqual(stock);
      expect(await prisma.extraSupplyIssue.count({ where: { id: posted.id } })).toBe(1);
    });

    it('an id is bound to its cashier and branch: another cashier cannot replay or read it', async () => {
      const created = await card();
      const input = freeIssue(created.id, created.version, 1);
      await issue(input);
      expect(await code(issue(input, cashierActor(ids.cashier2)))).toBe('EXTRA_SUPPLY_OPERATION_CONFLICT');
      expect(await code(issue({ ...input, branch_id: ids.branchB }, cashierActor(ids.cashierB), ids.branchB, ids.shiftB))).toBe('EXTRA_SUPPLY_OPERATION_CONFLICT');
      expect(await extraSuppliesService.getOperation(input.operation_id, cashierActor(ids.cashier2))).toEqual({ status: 'not_found' });
    });

    it('a refused attempt leaves the id free, so fixing the cause under the same id works', async () => {
      const itemId = await item(`Retry ${randomUUID().slice(0, 6)}`, ids.unitPc);
      await setStock(ids.branchA, itemId, 0, 0, 1);
      const created = await card({ inventory_item_id: itemId });
      const input = freeIssue(created.id, created.version, 1);
      expect(await code(issue(input))).toBe('INSUFFICIENT_STOCK');
      expect(await extraSuppliesService.getOperation(input.operation_id, cashierActor())).toEqual({ status: 'not_found' });
      await setStock(ids.branchA, itemId, 5, 0, 1);
      expect(await issue(input)).toMatchObject({ kind: 'free' });
    });

    it('abandoning fences the id against a delayed original; abandoning a posted one reports it instead', async () => {
      const created = await card();
      const stock = await stockOf(ids.branchA, ids.itemCup);
      const input = freeIssue(created.id, created.version, 1);
      expect(await extraSuppliesService.abandonOperation(input.operation_id, ids.branchA, cashierActor())).toEqual({ status: 'abandoned' });
      expect(await code(issue(input))).toBe('EXTRA_SUPPLY_OPERATION_ABANDONED');
      expect(await stockOf(ids.branchA, ids.itemCup)).toEqual(stock);

      const posted = freeIssue(created.id, created.version, 1);
      const result = await issue(posted);
      expect(await extraSuppliesService.abandonOperation(posted.operation_id, ids.branchA, cashierActor())).toMatchObject({ status: 'committed', issue: { id: result.id } });
      expect(await code(extraSuppliesService.abandonOperation(posted.operation_id, ids.branchA, cashierActor(ids.cashier2)))).toBe('EXTRA_SUPPLY_OPERATION_CONFLICT');

      // Racing: exactly one of the two decides, and they agree on what happened.
      const raced = freeIssue(created.id, created.version, 1);
      const [issued, abandoned] = await Promise.allSettled([issue(raced), extraSuppliesService.abandonOperation(raced.operation_id, ids.branchA, cashierActor())]);
      const op = await prisma.extraSupplyOperation.findUniqueOrThrow({ where: { id: raced.operation_id } });
      if (op.status === 'committed') {
        expect(issued.status).toBe('fulfilled');
        expect(abandoned).toMatchObject({ status: 'fulfilled', value: { status: 'committed' } });
      } else {
        expect(issued).toMatchObject({ status: 'rejected', reason: { code: 'EXTRA_SUPPLY_OPERATION_ABANDONED' } });
        expect(abandoned).toMatchObject({ status: 'fulfilled', value: { status: 'abandoned' } });
      }
    });
  });

  // ---------------------------------------------------------------- cashier guards
  describe('cashier session', () => {
    it('attributes to the token, and refuses not clocked in, on break, wrong branch and non-cashier roles', async () => {
      const created = await card();
      const input = () => ({ ...freeIssue(created.id, created.version, 1), cashier_id: ids.cashier2, shift_id: ids.shiftB });
      const token = generateStaffToken(ids.branchA, { userId: ids.cashier });

      const notIn = await post('/api/extra-supplies/issues', token, input());
      expect(notIn.status).toBe(403);
      expect(((await notIn.json()) as { error: { code: string } }).error.code).toBe('NOT_CLOCKED_IN');

      const record = await clockIn(ids.cashier, ids.branchA);
      const posted = await post('/api/extra-supplies/issues', token, input());
      expect(posted.status).toBe(201);
      const body = ((await posted.json()) as { data: { cashier_id: string; shift_id: string; id: string } }).data;
      expect(body.cashier_id).toBe(ids.cashier);
      expect(body.shift_id).toBe(ids.shiftA);

      await prisma.attendanceBreak.create({ data: { attendanceRecordId: record.id, startedAt: new Date(), startedBy: ids.cashier } });
      const stock = await stockOf(ids.branchA, ids.itemCup);
      const onBreak = await post('/api/extra-supplies/issues', token, input());
      expect(onBreak.status).toBe(403);
      expect(((await onBreak.json()) as { error: { code: string } }).error.code).toBe('ON_BREAK');
      expect(await stockOf(ids.branchA, ids.itemCup)).toEqual(stock);

      // Staying on break doesn't stop a cashier learning what happened to their own submission.
      const pending = input();
      expect((await get(`/api/extra-supplies/operations/${pending.operation_id}`, token)).status).toBe(200);

      await prisma.attendanceRecord.update({ where: { id: record.id }, data: { clockOutServerTime: new Date() } });

      const wrongBranch = await post('/api/extra-supplies/issues', token, { ...input(), branch_id: ids.branchB });
      expect(wrongBranch.status).toBe(403);
      expect((await post('/api/extra-supplies/issues', generateSupervisorToken([ids.branchA], { userId: ids.supAB }), input())).status).toBe(403);
      expect((await post('/api/extra-supplies/issues', generateSuperAdminToken({ userId: ids.admin }), input())).status).toBe(403);
    });

    it('a closed shift is refused inside the transaction', async () => {
      const created = await card();
      const closed = await prisma.shift.create({ data: { branchId: ids.branchC, cashierId: ids.cashier, openedBy: ids.cashier, openingCashAmount: 0, startedAt: new Date(), status: 'closed', closedAt: new Date() } });
      expect(await code(issue(freeIssue(created.id, created.version, 1), cashierActor(), ids.branchA, closed.id))).toBe('SHIFT_CLOSED');
    });
  });

  // ---------------------------------------------------------------- shift cash
  describe('shift collections', () => {
    it('cash reaches the expected drawer once; sales totals stay product-only; free and non-cash add nothing to the drawer', async () => {
      const itemId = await item(`Shift ${randomUUID().slice(0, 6)}`, ids.unitPc);
      const branchId = await branch('Shift');
      await prisma.userBranchAssignment.create({ data: { userId: ids.supAB, branchId } });
      await setStock(branchId, itemId, 100, 0, 1);
      const shiftId = await openShift(branchId, ids.cashier);
      await prisma.userBranchAssignment.create({ data: { userId: ids.cashier, branchId } });
      const created = await card({ inventory_item_id: itemId, selling_price: 5, branch_ids: [branchId] });
      const run = (input: IssueInput) => extraSuppliesService.createIssue({ ...input, branch_id: branchId }, branchId, shiftId, cashierActor(), null);

      await run(cashIssue(created.id, created.version, 4, 20));
      await run(freeIssue(created.id, created.version, 3));
      await run({
        operation_id: randomUUID(),
        branch_id: branchId,
        kind: 'paid',
        lines: [{ extra_supply_id: created.id, quantity: 2, version: created.version }],
        payment_method: 'gcash',
        payment_proof_key: `${branchId}/${shiftId}/${ids.cashier}-1-a.webp`,
        payment_proof_type: 'gallery_upload',
      });

      const live = await cashService.getShiftSummary(shiftId);
      expect(live.summary).toMatchObject({ cash_sales_total: 0, gross_sales_total: 0, extra_supply_cash_total: 20, extra_supply_collections_total: 30, total_collections: 30, expected_cash: 1020 });

      const closed = await cashService.closeShift(shiftId, { denominations: [{ denomination: 1000, quantity: 1 }, { denomination: 20, quantity: 1 }], cashierConfirmed: true } as never, { id: ids.cashier, role: 'staff' }, null);
      expect(closed).toMatchObject({ status: 'closed', cash_sales_total: 0, gross_sales_total: 0, expected_closing_cash: 1020, cash_variance: 0 });

      const after = await cashService.getShiftSummary(shiftId);
      expect(after.summary).toMatchObject({ expected_cash: 1020, extra_supply_cash_total: 20, extra_supply_collections_total: 30, total_collections: 30 });
    });
  });

  // ---------------------------------------------------------------- history and reports
  describe('history and reports', () => {
    let reportBranchA = '';
    let reportBranchB = '';
    let cardA: Awaited<ReturnType<typeof card>>;
    let shiftRA = '';
    let shiftRB = '';
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

    beforeAll(async () => {
      reportBranchA = await branch('ReportA');
      reportBranchB = await branch('ReportB');
      await prisma.userBranchAssignment.createMany({ data: [{ userId: ids.supAB, branchId: reportBranchA }, { userId: ids.supAB, branchId: reportBranchB }, { userId: ids.cashier, branchId: reportBranchA }, { userId: ids.cashierB, branchId: reportBranchB }] });
      await setStock(reportBranchA, ids.itemCup, 500, 0, 2);
      await setStock(reportBranchB, ids.itemCup, 500, 0, 2);
      shiftRA = await openShift(reportBranchA, ids.cashier);
      shiftRB = await openShift(reportBranchB, ids.cashierB);
      cardA = await card({ name: unique('Report Cup'), selling_price: 5, branch_ids: [reportBranchA, reportBranchB] });
      const runA = (input: IssueInput) => extraSuppliesService.createIssue({ ...input, branch_id: reportBranchA }, reportBranchA, shiftRA, cashierActor(), null);
      const runB = (input: IssueInput) => extraSuppliesService.createIssue({ ...input, branch_id: reportBranchB }, reportBranchB, shiftRB, cashierActor(ids.cashierB), null);
      for (let n = 0; n < 25; n += 1) await runA(freeIssue(cardA.id, cardA.version, 1));
      await runA(cashIssue(cardA.id, cardA.version, 3, 15));
      await runB(cashIssue(cardA.id, cardA.version, 2, 10));
      await runB(freeIssue(cardA.id, cardA.version, 4));
      // POS-PERF-P62 — 29 real issue transactions that lock the same stock row, so they
      // run one at a time: 6.0s measured with only two files running, over the 10s
      // default hook timeout under the full parallel suite (P62 runbook §7).
    }, 30_000);

    it('the summary covers the whole period, not the page, and matches the rows across pages', async () => {
      const jwt = supJwt();
      const page1 = await extraSuppliesService.listIssues(jwt, { branch_id: reportBranchA, page: 1, limit: 10 });
      expect(page1.issues).toHaveLength(10);
      expect(page1.total).toBe(26);

      const allRows = [];
      for (let page = 1; page <= 3; page += 1) allRows.push(...(await extraSuppliesService.listIssues(jwt, { branch_id: reportBranchA, page, limit: 10 })).issues);
      expect(new Set(allRows.map((row) => row.id)).size).toBe(26);

      const summary = await extraSuppliesService.getSummary(jwt, { branch_id: reportBranchA });
      expect(summary).toMatchObject({ issue_count: 26, units_free: 25, units_paid: 3, amount_collected: 15, inventory_cost: 56, configured_cost: 0, unknown_cost_lines: 0 });
      expect(summary.amount_collected).toBe(allRows.reduce((sum, row) => sum + row.amount_collected, 0));
      expect(summary.by_payment_method).toEqual([{ payment_method: 'cash', amount: 15, line_count: 1 }]);
    });

    it('identical filters give the same details and totals to every role that can see them', async () => {
      const query = { branch_id: reportBranchA, date_from: today, date_to: today };
      const asSupervisor = await extraSuppliesService.getSummary(supJwt(), query);
      const asAdmin = await extraSuppliesService.getSummary(adminJwt(), query);
      const asBranch = await extraSuppliesService.getSummary(staffJwt(ids.cashier, reportBranchA), query);
      expect(asAdmin).toEqual(asSupervisor);
      expect(asBranch).toEqual(asSupervisor);
      const listed = await extraSuppliesService.listIssues(adminJwt(), { ...query, page: 1, limit: 100 });
      expect(listed.total).toBe(asAdmin.issue_count);
    });

    it('consolidated Admin totals are the sum of the per-branch breakdown', async () => {
      const summary = await extraSuppliesService.getSummary(adminJwt(), { extra_supply_id: cardA.id });
      expect(summary.by_branch.map((b) => b.branch_id).sort()).toEqual([reportBranchA, reportBranchB].sort());
      expect(summary.by_branch.reduce((sum, b) => sum + b.amount_collected, 0)).toBe(summary.amount_collected);
      expect(summary.amount_collected).toBe(25);
      expect(summary.units_free).toBe(29);
      expect(summary.units_paid).toBe(5);
      expect(summary.product_sales_total).toBeNull();
      expect(summary.combined_collection_total).toBeNull();
    });

    it('filters by item, free/paid, cashier and date; a future date finds nothing', async () => {
      const free = await extraSuppliesService.getSummary(adminJwt(), { extra_supply_id: cardA.id, kind: 'free' });
      expect(free).toMatchObject({ units_paid: 0, amount_collected: 0, units_free: 29 });
      const byCashier = await extraSuppliesService.listIssues(adminJwt(), { extra_supply_id: cardA.id, cashier_id: ids.cashierB, page: 1, limit: 100 });
      expect(byCashier.total).toBe(2);
      const future = await extraSuppliesService.getSummary(adminJwt(), { extra_supply_id: cardA.id, date_from: '2099-01-01' });
      expect(future.issue_count).toBe(0);
    });

    it('combined collections are product sales plus supply collections, each stated apart', async () => {
      await prisma.transaction.create({
        data: { transactionNumber: `P61-${randomUUID()}`, branchId: reportBranchB, shiftId: shiftRB, cashierId: ids.cashierB, status: 'completed', paymentMethod: 'cash', subtotal: 100, vatAmount: 0, totalAmount: 100 },
      });
      const summary = await extraSuppliesService.getSummary(adminJwt(), { branch_id: reportBranchB });
      expect(summary).toMatchObject({ amount_collected: 10, product_sales_total: 100, combined_collection_total: 110 });
    });

    it('scope: a foreign filter is refused, a foreign issue reads as absent, and unfiltered stays in scope', async () => {
      const foreign = supJwt(ids.supC);
      expect(await code(extraSuppliesService.listIssues(foreign, { branch_id: reportBranchA, page: 1, limit: 10 }))).toBe('BRANCH_ACCESS_DENIED');
      expect(await code(extraSuppliesService.getSummary(foreign, { branch_id: reportBranchA }))).toBe('BRANCH_ACCESS_DENIED');
      const row = (await extraSuppliesService.listIssues(adminJwt(), { branch_id: reportBranchA, page: 1, limit: 1 })).issues[0];
      expect(await code(extraSuppliesService.getIssue(foreign, row?.id as string))).toBe('EXTRA_SUPPLY_ISSUE_NOT_FOUND');
      const unfiltered = await extraSuppliesService.listIssues(foreign, { page: 1, limit: 100 });
      expect(unfiltered.issues.filter((issueRow) => issueRow.branch_id !== ids.branchC)).toHaveLength(0);
    });

    it('snapshots survive a rename, a price change, a cost change and deactivation', async () => {
      const created = await card({ name: unique('Old Name'), selling_price: 5, branch_ids: [reportBranchA] });
      const posted = await extraSuppliesService.createIssue({ ...cashIssue(created.id, created.version, 2, 10), branch_id: reportBranchA }, reportBranchA, shiftRA, cashierActor(), null);
      const renamed = await extraSuppliesService.update(created.id, { name: unique('New Name'), selling_price: 99, expected_version: created.version }, sup(), null);
      await prisma.inventoryStock.update({ where: { branchId_inventoryItemId: { branchId: reportBranchA, inventoryItemId: ids.itemCup } }, data: { unitCost: 50 } });
      await extraSuppliesService.setActive(created.id, false, renamed.version, sup(), null);

      const detail = await extraSuppliesService.getIssue(adminJwt(), posted.id);
      expect(detail.lines[0]).toMatchObject({ supply_name: created.name, current_supply_name: renamed.name, unit_price: 5, line_amount: 10, unit_cost: 2, line_cost: 4 });
      expect(detail.amount_collected).toBe(10);
      expect(detail.movements[0]).toMatchObject({ quantity_change: -2 });

      // Gone from new entry, still in history.
      const cards = await extraSuppliesService.terminalCards(staffJwt(ids.cashier, reportBranchA), reportBranchA);
      expect(cards.cards.some((c) => c.id === created.id)).toBe(false);
      await prisma.inventoryStock.update({ where: { branchId_inventoryItemId: { branchId: reportBranchA, inventoryItemId: ids.itemCup } }, data: { unitCost: 2 } });
    });

    it('inventory movements show the deduction apart from manual adjustments, in lists and report values', async () => {
      const posted = (await extraSuppliesService.listIssues(adminJwt(), { branch_id: reportBranchB, kind: 'free', page: 1, limit: 1 })).issues[0];
      const extra = await universalInventoryRepository.findStockMovements(reportBranchB, { category: 'extra_supplies', page: 1, limit: 50 });
      expect(extra.movements.some((m) => m.referenceId === posted?.id)).toBe(true);
      const adjustments = await universalInventoryRepository.findStockMovements(reportBranchB, { category: 'adjustments', page: 1, limit: 50 });
      expect(adjustments.movements.some((m) => m.referenceType === 'extra_supply_issue')).toBe(false);

      await prisma.inventoryStockMovement.create({
        data: { branchId: reportBranchB, inventoryItemId: ids.itemCup, movementType: 'ADJUSTMENT_OUT', quantityChange: -1, quantityBefore: 1, quantityAfter: 0, totalCost: 7 },
      });
      const stillManual = await universalInventoryRepository.findStockMovements(reportBranchB, { category: 'adjustments', page: 1, limit: 50 });
      expect(stillManual.movements).toHaveLength(1);

      const value = await reportsRepository.getInventoryValueSummary({ branchId: reportBranchB } as never);
      expect(value.adjustment_out_value).toBe(7);
      // 6 units at a carrying cost of 2.
      expect(value.extra_supply_value).toBe(12);
    });

    it('the CSV holds the same lines and total, escapes formulas and labels its coverage', async () => {
      const name = `=HYPERLINK("x") ${randomUUID().slice(0, 4)}`;
      const created = await card({ name, selling_price: 5, branch_ids: [reportBranchB] });
      await extraSuppliesService.createIssue({ ...cashIssue(created.id, created.version, 1, 5), branch_id: reportBranchB }, reportBranchB, shiftRB, cashierActor(ids.cashierB), null);
      const { buffer, filename } = await extraSuppliesService.exportCsv(adminJwt(), { branch_id: reportBranchB });
      const text = buffer.toString('utf8');
      expect(filename).not.toContain('PARTIAL');
      expect(text).toContain('Coverage: all');
      expect(text).toContain('Amount Collected');
      expect(text).toContain(`'=HYPERLINK`);
      const summary = await extraSuppliesService.getSummary(adminJwt(), { branch_id: reportBranchB });
      expect(text).toContain(`Total collected for all of them: PHP ${summary.amount_collected.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`);
    });

    it('a shift with an issue cannot be voided as if untouched', async () => {
      const { cashRepository } = await import('../cash/cash.repository.js');
      expect(await cashRepository.countAnyTransactionsForShift(shiftRA)).toBeGreaterThan(0);
    });
  });
});
