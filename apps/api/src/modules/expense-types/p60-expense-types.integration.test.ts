import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P60 — expense types against a real Postgres: names decided by the
 * database, live branch scope, stale edits, scope rules forced into their races,
 * recorded names, legacy rows, and one set of totals across the ledger, the
 * breakdown, the dashboards and the exports.
 *
 * Requires TEST_DATABASE_URL pointing at a disposable, migrated database.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const { expenseTypesService } = await import('./expense-types.service.js');
const { expenseTypesRepository } = await import('./expense-types.repository.js');
const { expensesService } = await import('../expenses/expenses.service.js');
const { reportsService } = await import('../reports/reports.service.js');
const { branchesRepository } = await import('../branches/branches.repository.js');
const { resolveDateRangeBoundary } = await import('../../lib/manila-time.js');

type ReportFilterArg = Parameters<typeof reportsService.requestExport>[1];

describe.skipIf(!canRunIntegrationTests)('P60 expense types', () => {
  const tag = randomUUID().slice(0, 8);
  const ids = { branchA: '', branchB: '', branchC: '', supAB: '', supA: '', supC: '', admin: '', branchUser: '' };
  const actor = (id: string) => ({ id, role: 'supervisor' });
  const supervisorJwt = (id: string): JwtPayload => ({ user_id: id, role: 'supervisor', email: `${id}@t.test`, branch_ids: [], iat: 0, exp: 0 });
  const adminJwt = (): JwtPayload => ({ user_id: ids.admin, role: 'super_admin', email: 'a@t.test', iat: 0, exp: 0 });
  const unique = (name: string) => `${name} ${randomUUID().slice(0, 6)}`;

  async function user(role: 'supervisor' | 'super_admin' | 'branch', name: string) {
    const row = await prisma.user.create({
      data: { email: `${name}-${tag}@potatocorner.test`, passwordHash: 'unused', role, firstName: 'P60', lastName: name, employmentType: 'regular', mustChangePassword: false },
    });
    return row.id;
  }

  async function freshBranch(label: string) {
    return (await prisma.branch.create({ data: { name: `P60 ${label} ${randomUUID().slice(0, 6)}`, code: `P60-${randomUUID().slice(0, 8)}`, address: '1 Test St', city: 'Testville' } })).id;
  }

  async function createType(name: string, branchIds: string[], by = ids.supAB) {
    return expenseTypesService.create({ name, branch_ids: branchIds }, actor(by), null);
  }

  function addExpense(branchId: string, typeId: string, amount: number, incurredAt = '2026-08-15', by = ids.supAB, key?: string) {
    return expensesService.createExpense({ branch_id: branchId, expense_type_id: typeId, amount, incurred_at: incurredAt }, supervisorJwt(by), null, key);
  }

  /** A row as it exists from before this batch. */
  function legacyExpense(branchId: string, category: 'utilities' | 'supplies' | 'staff_meals' | 'miscellaneous', amount: number, incurredAt = '2026-08-15') {
    return prisma.expense.create({
      data: { branchId, category, amount, incurredAt: resolveDateRangeBoundary(incurredAt, 'start'), createdBy: ids.supAB, vendorName: 'Old Vendor' },
    });
  }

  async function code(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
      return 'NO_ERROR';
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
  }

  /** Rows at this branch in every table with a branch_id, leaving out what recording an expense is meant to write. */
  async function branchRowCounts(branchId: string) {
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name::text FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'branch_id' AND table_name NOT IN ('expenses', 'expense_type_branches', 'audit_logs', 'notifications')
      ORDER BY 1`;
    const counts: Record<string, number> = {};
    for (const { table_name: table } of tables) {
      const [row] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}" WHERE branch_id = $1`, branchId);
      counts[table] = Number(row?.n ?? 0);
    }
    return counts;
  }

  beforeAll(async () => {
    ids.supAB = await user('supervisor', 'supab');
    ids.supA = await user('supervisor', 'supa');
    ids.supC = await user('supervisor', 'supc');
    ids.admin = await user('super_admin', 'admin');
    ids.branchUser = await user('branch', 'branch');
    ids.branchA = await freshBranch('A');
    ids.branchB = await freshBranch('B');
    ids.branchC = await freshBranch('C');
    await prisma.userBranchAssignment.createMany({
      data: [
        { userId: ids.supAB, branchId: ids.branchA },
        { userId: ids.supAB, branchId: ids.branchB },
        { userId: ids.supA, branchId: ids.branchA },
        { userId: ids.supC, branchId: ids.branchC },
      ],
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------- names and CRUD
  it('creates a type with its scope, writes an audit row, and seeds nothing', async () => {
    const name = unique('Bills');
    const type = await createType(name, [ids.branchA, ids.branchB]);
    expect(type).toMatchObject({ name, is_active: true, version: 1, can_manage: true, expense_count: 0, other_branch_count: 0 });
    expect(type.branches.map((b) => b.branch_id).sort()).toEqual([ids.branchA, ids.branchB].sort());
    const audit = await prisma.auditLog.findFirst({ where: { entityId: type.id, action: 'EXPENSE_TYPE_CREATED' } });
    expect(audit).not.toBeNull();
    const empty = await freshBranch('Empty');
    await prisma.userBranchAssignment.create({ data: { userId: ids.supAB, branchId: empty } });
    const { types } = await expenseTypesService.list(supervisorJwt(ids.supAB), { branch_id: empty, include_inactive: true });
    expect(types).toEqual([]);
  });

  it('refuses a duplicate name at a branch whatever its case or spacing, and allows it at another branch', async () => {
    const name = unique('Rent');
    await createType(name, [ids.branchA]);
    expect(await code(createType(`  ${name.toUpperCase()} `, [ids.branchA]))).toBe('EXPENSE_TYPE_NAME_TAKEN');
    const elsewhere = await createType(name.toUpperCase(), [ids.branchB]);
    expect(elsewhere.is_active).toBe(true);
    // Refused whole: a multi-branch create with one collision adds nothing at the other branch.
    const other = unique('Other');
    await createType(other, [ids.branchA]);
    expect(await code(createType(other, [ids.branchA, ids.branchB]))).toBe('EXPENSE_TYPE_NAME_TAKEN');
    const { types } = await expenseTypesService.list(supervisorJwt(ids.supAB), { branch_id: ids.branchB, include_inactive: true });
    expect(types.some((t) => t.name === other)).toBe(false);
  });

  it('lets the database decide concurrent creates: exactly one wins', async () => {
    const name = unique('Race');
    const results = await Promise.all(Array.from({ length: 6 }, () => code(createType(name, [ids.branchA]))));
    expect(results.filter((r) => r === 'NO_ERROR')).toHaveLength(1);
    expect(results.filter((r) => r === 'EXPENSE_TYPE_NAME_TAKEN')).toHaveLength(5);
    expect(await prisma.expenseType.count({ where: { name } })).toBe(1);
  });

  it('refuses a rename onto an active name, and a stale edit, leaving the row as it was', async () => {
    const taken = unique('Taken');
    await createType(taken, [ids.branchA]);
    const type = await createType(unique('Rename'), [ids.branchA]);
    expect(await code(expenseTypesService.update(type.id, { name: taken, expected_version: type.version }, actor(ids.supAB), null))).toBe('EXPENSE_TYPE_NAME_TAKEN');
    const renamed = await expenseTypesService.update(type.id, { name: unique('Renamed'), expected_version: type.version }, actor(ids.supAB), null);
    expect(renamed.version).toBe(type.version + 1);
    expect(await code(expenseTypesService.update(type.id, { description: 'stale', expected_version: type.version }, actor(ids.supAB), null))).toBe('EXPENSE_TYPE_CONFLICT');
    const row = await prisma.expenseType.findUniqueOrThrow({ where: { id: type.id } });
    expect(row).toMatchObject({ description: null, name: renamed.name, version: renamed.version });
  });

  it('deactivates and reactivates with version checks, frees the name, and refuses reactivating into a taken name', async () => {
    const name = unique('Cycle');
    const type = await createType(name, [ids.branchA]);
    const off = await expenseTypesService.setActive(type.id, false, type.version, actor(ids.supAB), null);
    expect(off.is_active).toBe(false);
    expect(await code(expenseTypesService.setActive(type.id, true, type.version, actor(ids.supAB), null))).toBe('EXPENSE_TYPE_CONFLICT');
    const replacement = await createType(name, [ids.branchA]);
    expect(await code(expenseTypesService.setActive(type.id, true, off.version, actor(ids.supAB), null))).toBe('EXPENSE_TYPE_NAME_TAKEN');
    await expenseTypesService.setActive(replacement.id, false, replacement.version, actor(ids.supAB), null);
    const on = await expenseTypesService.setActive(type.id, true, off.version, actor(ids.supAB), null);
    expect(on.is_active).toBe(true);
    const actions = (await prisma.auditLog.findMany({ where: { entityId: type.id }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['EXPENSE_TYPE_DEACTIVATED', 'EXPENSE_TYPE_REACTIVATED']));
  });

  it('cannot hard-delete a type an expense references', async () => {
    const type = await createType(unique('Referenced'), [ids.branchA]);
    await addExpense(ids.branchA, type.id, 10);
    await expect(prisma.expenseType.delete({ where: { id: type.id } })).rejects.toThrow();
  });

  // ---------------------------------------------------------------- authorization
  it('uses live assignments, never the token: out-of-scope branches are refused with no partial write', async () => {
    const name = unique('Scope');
    expect(await code(createType(name, [ids.branchA, ids.branchC], ids.supAB))).toBe('BRANCH_ACCESS_DENIED');
    expect(await prisma.expenseType.count({ where: { name } })).toBe(0);
    // A token claiming branch C changes nothing.
    const claiming: JwtPayload = { user_id: ids.supAB, role: 'supervisor', email: 'claiming@t.test', branch_ids: [ids.branchC], iat: 0, exp: 0 };
    expect(await code(expenseTypesService.list(claiming, { branch_id: ids.branchC, include_inactive: true }))).toBe('BRANCH_ACCESS_DENIED');
    expect(await code(expensesService.getExpenses(claiming, { branch_id: ids.branchC, page: 1, limit: 25 }))).toBe('BRANCH_ACCESS_DENIED');
    expect(await code(expensesService.getSummary(claiming, { branch_id: ids.branchC }))).toBe('BRANCH_ACCESS_DENIED');
  });

  it('a revoked assignment stops reads, writes, management and replays at once', async () => {
    const sup = await user('supervisor', `revoked-${randomUUID().slice(0, 6)}`);
    const branch = await freshBranch('Revoked');
    await prisma.userBranchAssignment.create({ data: { userId: sup, branchId: branch } });
    const type = await createType(unique('Revoked'), [branch], sup);
    const key = randomUUID();
    const expense = await addExpense(branch, type.id, 25, '2026-08-15', sup, key);

    await branchesRepository.findAllActiveBranchIds(sup);
    await prisma.userBranchAssignment.deleteMany({ where: { userId: sup } });

    expect(await code(expensesService.getExpenses(supervisorJwt(sup), { branch_id: branch, page: 1, limit: 25 }))).toBe('BRANCH_ACCESS_DENIED');
    expect(await code(expensesService.getExpenseResponse(expense.id, supervisorJwt(sup)))).toBe('BRANCH_ACCESS_DENIED');
    expect(await code(addExpense(branch, type.id, 25, '2026-08-15', sup))).toBe('BRANCH_ACCESS_DENIED');
    expect(await code(addExpense(branch, type.id, 25, '2026-08-15', sup, key))).toBe('BRANCH_ACCESS_DENIED');
    expect(await code(expenseTypesService.update(type.id, { description: 'x', expected_version: type.version }, actor(sup), null))).toBe('EXPENSE_TYPE_NOT_FOUND');
    expect(await code(expenseTypesService.setActive(type.id, false, type.version, actor(sup), null))).toBe('EXPENSE_TYPE_NOT_FOUND');
  });

  it('a type shared beyond the supervisor can be used but not changed, and its other branch stays hidden', async () => {
    const type = await createType(unique('Shared'), [ids.branchA, ids.branchB], ids.supAB);
    const { types } = await expenseTypesService.list(supervisorJwt(ids.supA), { branch_id: ids.branchA, include_inactive: true });
    const seen = types.find((t) => t.id === type.id);
    expect(seen).toMatchObject({ can_manage: false, other_branch_count: 1 });
    expect(seen?.branches.map((b) => b.branch_id)).toEqual([ids.branchA]);
    expect(await code(expenseTypesService.update(type.id, { description: 'x', expected_version: type.version }, actor(ids.supA), null))).toBe('EXPENSE_TYPE_SCOPE_FORBIDDEN');
    await expect(addExpense(ids.branchA, type.id, 5, '2026-08-15', ids.supA)).resolves.toMatchObject({ expense_type_id: type.id });
    // Unrelated supervisors don't learn the type exists.
    expect(await code(expenseTypesService.update(type.id, { description: 'x', expected_version: type.version }, actor(ids.supC), null))).toBe('EXPENSE_TYPE_NOT_FOUND');
  });

  it('GET /expenses?branch_id= can no longer read another branch: the old filter replaced the scope', async () => {
    await legacyExpense(ids.branchC, 'utilities', 999);
    const denied = await code(expensesService.getExpenses(supervisorJwt(ids.supA), { branch_id: ids.branchC, page: 1, limit: 25 }));
    expect(denied).toBe('BRANCH_ACCESS_DENIED');
    const own = await expensesService.getExpenses(supervisorJwt(ids.supC), { branch_id: ids.branchC, page: 1, limit: 25 });
    expect(own.total).toBeGreaterThan(0);
  });

  it('PATCH cannot move an expense to a branch outside the caller\'s scope', async () => {
    const type = await createType(unique('Move'), [ids.branchA]);
    const expense = await addExpense(ids.branchA, type.id, 30);
    expect(await code(expensesService.updateExpense(expense.id, { branch_id: ids.branchC }, supervisorJwt(ids.supAB), null))).toBe('BRANCH_ACCESS_DENIED');
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } })).branchId).toBe(ids.branchA);
  });

  // ---------------------------------------------------------------- recording an expense
  it('rejects a foreign, inactive or unknown type server-side, leaving nothing behind', async () => {
    const branch = await freshBranch('Reject');
    await prisma.userBranchAssignment.create({ data: { userId: ids.supAB, branchId: branch } });
    const foreign = await createType(unique('Foreign'), [ids.branchC], ids.supC);
    const inactive = await createType(unique('Inactive'), [branch]);
    await expenseTypesService.setActive(inactive.id, false, inactive.version, actor(ids.supAB), null);
    const key = randomUUID();

    expect(await code(addExpense(branch, foreign.id, 40, '2026-08-15', ids.supAB, key))).toBe('EXPENSE_TYPE_UNAVAILABLE');
    expect(await code(addExpense(branch, randomUUID(), 40))).toBe('EXPENSE_TYPE_UNAVAILABLE');
    expect(await code(addExpense(branch, inactive.id, 40))).toBe('EXPENSE_TYPE_INACTIVE');
    expect(await prisma.expense.count({ where: { branchId: branch } })).toBe(0);
    // A refused attempt keeps no key: the corrected form can submit under it.
    expect(await prisma.expenseIdempotencyKey.count({ where: { key } })).toBe(0);
    const good = await createType(unique('Good'), [branch]);
    await expect(addExpense(branch, good.id, 40, '2026-08-15', ids.supAB, key)).resolves.toMatchObject({ amount: 40 });
  });

  it('double submits and lost replies create one expense; the same key with other details is refused', async () => {
    const type = await createType(unique('Retry'), [ids.branchA]);
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => addExpense(ids.branchA, type.id, 77.5, '2026-08-20', ids.supAB, key)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await prisma.expense.count({ where: { id: { in: results.map((r) => r.id) } } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: results[0]?.id, action: 'EXPENSE_CREATED' } })).toBe(1);

    // The reply was lost and the same form is sent again later.
    const replay = await addExpense(ids.branchA, type.id, 77.5, '2026-08-20', ids.supAB, key);
    expect(replay.id).toBe(results[0]?.id);
    // The type may have been deactivated since: a replay still returns what was saved.
    await expenseTypesService.setActive(type.id, false, type.version, actor(ids.supAB), null);
    expect((await addExpense(ids.branchA, type.id, 77.5, '2026-08-20', ids.supAB, key)).id).toBe(results[0]?.id);

    expect(await code(addExpense(ids.branchA, type.id, 88, '2026-08-20', ids.supAB, key))).toBe('EXPENSE_KEY_REUSED');
    // Another user's key neither replays nor reveals their expense.
    expect(await code(expensesService.createExpense({ branch_id: ids.branchA, category: 'utilities', amount: 77.5, incurred_at: '2026-08-20' }, supervisorJwt(ids.supA), null, key))).toBe('EXPENSE_KEY_REUSED');
  });

  it('recording a type never touches stock, payroll, cash or anything else at the branch', async () => {
    const branch = await freshBranch('Category');
    await prisma.userBranchAssignment.create({ data: { userId: ids.supAB, branchId: branch } });
    const before = await branchRowCounts(branch);
    for (const name of ['Employee Expenses', 'Product Purchases']) {
      const type = await createType(`${name} ${tag}`, [branch]);
      await addExpense(branch, type.id, 1000);
    }
    expect(await branchRowCounts(branch)).toEqual(before);
  });

  // ---------------------------------------------------------------- races
  /** Holds a transaction that has taken the type's lock and written an expense, until released. */
  async function holdExpenseOpen(typeId: string, branchId: string) {
    let locked!: () => void;
    let release!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const committed = prisma.$transaction(
      async (tx) => {
        const usable = await expenseTypesRepository.lockUsable(typeId, branchId, tx);
        expect(usable.usable).toBe(true);
        await tx.expense.create({
          data: { branchId, category: 'miscellaneous', expenseTypeId: typeId, expenseTypeName: 'held', amount: 1, incurredAt: new Date(), createdBy: ids.supAB },
        });
        locked();
        await gate;
      },
      { timeout: 15_000 },
    );
    await lockTaken;
    return { release, committed };
  }

  async function waitForALockWaiter() {
    for (let i = 0; i < 100; i += 1) {
      const [row] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`;
      if (Number(row?.n ?? 0) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  it('removing a branch waits for an expense being recorded there, then refuses', async () => {
    const type = await createType(unique('RaceScope'), [ids.branchA, ids.branchB]);
    const { release, committed } = await holdExpenseOpen(type.id, ids.branchB);
    const narrowing = code(expenseTypesService.update(type.id, { branch_ids: [ids.branchA], expected_version: type.version }, actor(ids.supAB), null));
    expect(await waitForALockWaiter()).toBe(true);
    release();
    await committed;
    expect(await narrowing).toBe('EXPENSE_TYPE_SCOPE_IN_USE');
    expect(await prisma.expenseTypeBranch.count({ where: { expenseTypeId: type.id } })).toBe(2);
  });

  it('an expense can\'t slip in after the branch was removed or the type deactivated', async () => {
    const type = await createType(unique('RaceAfter'), [ids.branchA, ids.branchB]);
    const narrowed = await expenseTypesService.update(type.id, { branch_ids: [ids.branchA], expected_version: type.version }, actor(ids.supAB), null);
    expect(narrowed.branches.map((b) => b.branch_id)).toEqual([ids.branchA]);
    expect(await code(addExpense(ids.branchB, type.id, 2))).toBe('EXPENSE_TYPE_UNAVAILABLE');
    await expenseTypesService.setActive(type.id, false, narrowed.version, actor(ids.supAB), null);
    expect(await code(addExpense(ids.branchA, type.id, 2))).toBe('EXPENSE_TYPE_INACTIVE');
  });

  it('a rename waits for an expense being recorded, whose recorded name stays what it read', async () => {
    const original = unique('RaceName');
    const type = await createType(original, [ids.branchA]);
    const { release, committed } = await holdExpenseOpen(type.id, ids.branchA);
    const renaming = expenseTypesService.update(type.id, { name: unique('RaceRenamed'), expected_version: type.version }, actor(ids.supAB), null);
    expect(await waitForALockWaiter()).toBe(true);
    release();
    await committed;
    const renamed = await renaming;
    const rows = await prisma.expense.findMany({ where: { expenseTypeId: type.id } });
    expect(rows.map((r) => r.expenseTypeName)).toEqual(['held']);
    expect((await addExpense(ids.branchA, type.id, 3)).expense_type_name).toBe(renamed.name);
  });

  // ---------------------------------------------------------------- scope rule
  it('scope edits add freely, remove an unused branch, and refuse one with history, whole', async () => {
    const type = await createType(unique('ScopeEdit'), [ids.branchA]);
    const widened = await expenseTypesService.update(type.id, { branch_ids: [ids.branchA, ids.branchB], expected_version: type.version }, actor(ids.supAB), null);
    expect(widened.branches).toHaveLength(2);
    const narrowed = await expenseTypesService.update(type.id, { branch_ids: [ids.branchA], expected_version: widened.version }, actor(ids.supAB), null);
    expect(narrowed.branches).toHaveLength(1);
    await addExpense(ids.branchA, type.id, 11);
    // Refused whole: the rename in the same request doesn't stick either.
    expect(await code(expenseTypesService.update(type.id, { name: unique('NotKept'), branch_ids: [ids.branchB], expected_version: narrowed.version }, actor(ids.supAB), null))).toBe('EXPENSE_TYPE_SCOPE_IN_USE');
    const row = await prisma.expenseType.findUniqueOrThrow({ where: { id: type.id } });
    expect(row).toMatchObject({ name: type.name, version: narrowed.version });
    expect(await prisma.auditLog.count({ where: { entityId: type.id, action: 'EXPENSE_TYPE_SCOPE_CHANGED' } })).toBe(2);
  });

  it('refuses adding a branch where the name is already active, and an out-of-scope branch', async () => {
    const name = unique('Collide');
    const atB = await createType(name, [ids.branchB]);
    const atA = await createType(`${name} other`, [ids.branchA]);
    const renamedAtA = await expenseTypesService.update(atA.id, { name, expected_version: atA.version }, actor(ids.supAB), null);
    expect(await code(expenseTypesService.update(renamedAtA.id, { branch_ids: [ids.branchA, ids.branchB], expected_version: renamedAtA.version }, actor(ids.supAB), null))).toBe('EXPENSE_TYPE_NAME_TAKEN');
    expect(await code(expenseTypesService.update(renamedAtA.id, { branch_ids: [ids.branchA, ids.branchC], expected_version: renamedAtA.version }, actor(ids.supAB), null))).toBe('BRANCH_ACCESS_DENIED');
    expect(atB.branches).toHaveLength(1);
  });

  // ---------------------------------------------------------------- history
  it('rename and deactivation keep each expense\'s recorded name, amount and proof', async () => {
    const original = unique('History');
    const type = await createType(original, [ids.branchA]);
    const expense = await addExpense(ids.branchA, type.id, 123.45, '2026-08-01');
    await prisma.expense.update({ where: { id: expense.id }, data: { receiptKey: `expenses/${expense.id}/proof.webp`, receiptUrl: 'stored-at-upload' } });

    const renamedName = unique('History Renamed');
    const renamed = await expenseTypesService.update(type.id, { name: renamedName, expected_version: type.version }, actor(ids.supAB), null);
    await expenseTypesService.setActive(type.id, false, renamed.version, actor(ids.supAB), null);

    const row = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id }, include: { expenseType: true } });
    expect(row.expenseTypeName).toBe(original);
    expect(row.expenseType?.name).toBe(renamedName);
    expect(row.expenseType?.isActive).toBe(false);
    expect(row.amount.toNumber()).toBe(123.45);
    expect(row.receiptKey).toBe(`expenses/${expense.id}/proof.webp`);

    await prisma.expense.update({ where: { id: expense.id }, data: { receiptKey: null, receiptUrl: null } });
    const read = await expensesService.getExpenseResponse(expense.id, supervisorJwt(ids.supAB));
    expect(read).toMatchObject({ expense_type_name: original, expense_type_current_name: renamedName, expense_type_is_active: false });

    // A deactivated type's expense stays editable; its recorded name doesn't move.
    const edited = await expensesService.updateExpense(expense.id, { amount: 200 }, supervisorJwt(ids.supAB), null);
    expect(edited).toMatchObject({ amount: 200, expense_type_name: original });
    // But it can't be carried to a new branch or assigned to the deactivated type anew.
    expect(await code(expensesService.updateExpense(expense.id, { branch_id: ids.branchB }, supervisorJwt(ids.supAB), null))).toBe('EXPENSE_TYPE_UNAVAILABLE');
  });

  it('same-named types at different branches stay separate lines and filters', async () => {
    const branchX = await freshBranch('X');
    const branchY = await freshBranch('Y');
    await prisma.userBranchAssignment.createMany({ data: [{ userId: ids.supAB, branchId: branchX }, { userId: ids.supAB, branchId: branchY }] });
    const name = unique('Twin');
    const x = await createType(name, [branchX]);
    const y = await createType(name, [branchY]);
    await addExpense(branchX, x.id, 100);
    await addExpense(branchY, y.id, 50);
    const summary = await expensesService.getSummary(adminJwt(), {});
    const lines = summary.groups.filter((g) => g.name === name);
    expect(lines.map((l) => l.total_amount).sort((a, b) => a - b)).toEqual([50, 100]);
    expect(new Set(lines.map((l) => l.expense_type_id)).size).toBe(2);
    const onlyX = await expensesService.getExpenses(adminJwt(), { expense_type_id: x.id, page: 1, limit: 25 });
    expect(onlyX).toMatchObject({ total: 1, total_amount: 100 });
  });

  // ---------------------------------------------------------------- legacy and old clients
  it('legacy expenses stay visible, counted and labelled, and a category filter never matches a typed row', async () => {
    const branch = await freshBranch('Legacy');
    await prisma.userBranchAssignment.create({ data: { userId: ids.supAB, branchId: branch } });
    await legacyExpense(branch, 'utilities', 100);
    await legacyExpense(branch, 'miscellaneous', 200);
    const type = await createType(unique('Typed'), [branch]);
    await addExpense(branch, type.id, 400);

    const jwt = supervisorJwt(ids.supAB);
    const summary = await expensesService.getSummary(jwt, { branch_id: branch });
    expect(summary).toMatchObject({ total: 3, total_amount: 700 });
    expect(summary.groups.map((g) => [g.kind, g.name, g.total_amount])).toEqual([
      ['type', type.name, 400],
      ['legacy', 'Miscellaneous (legacy)', 200],
      ['legacy', 'Utilities (legacy)', 100],
    ]);

    // The typed row stores 'miscellaneous' only as a placeholder.
    expect(await prisma.expense.count({ where: { branchId: branch, category: 'miscellaneous' } })).toBe(2);
    expect(await expensesService.getExpenses(jwt, { branch_id: branch, category: 'miscellaneous', page: 1, limit: 25 })).toMatchObject({ total: 1, total_amount: 200 });
    expect(await expensesService.getExpenses(jwt, { branch_id: branch, unassigned: true, page: 1, limit: 25 })).toMatchObject({ total: 2, total_amount: 300 });
    expect(await expensesService.getExpenses(jwt, { branch_id: branch, page: 1, limit: 25 })).toMatchObject({ total: 3, total_amount: 700 });
  });

  it('an old client\'s category records a legacy expense under what it chose, and can edit it; it can\'t restate a typed one', async () => {
    const jwt = supervisorJwt(ids.supAB);
    const legacy = await expensesService.createExpense({ branch_id: ids.branchA, category: 'supplies', amount: 60, incurred_at: '2026-08-02' }, jwt, null, randomUUID());
    expect(legacy).toMatchObject({ category: 'supplies', expense_type_id: null, expense_type_name: null });
    expect(await expensesService.updateExpense(legacy.id, { category: 'utilities' }, jwt, null)).toMatchObject({ category: 'utilities', expense_type_id: null });

    const type = await createType(unique('OldEdit'), [ids.branchA]);
    const typed = await addExpense(ids.branchA, type.id, 61);
    // An old form resends the row's own category with every edit.
    expect(await expensesService.updateExpense(typed.id, { category: typed.category, amount: 62 }, jwt, null)).toMatchObject({ amount: 62, expense_type_id: type.id });
    expect(await code(expensesService.updateExpense(typed.id, { category: 'utilities' }, jwt, null))).toBe('EXPENSE_CATEGORY_NOT_EDITABLE');
  });

  it('a legacy expense can be given a type on purpose, recording its name and keeping its category', async () => {
    const legacy = await legacyExpense(ids.branchA, 'utilities', 70);
    const type = await createType(unique('Assign'), [ids.branchA]);
    const updated = await expensesService.updateExpense(legacy.id, { expense_type_id: type.id }, supervisorJwt(ids.supAB), null);
    expect(updated).toMatchObject({ expense_type_id: type.id, expense_type_name: type.name, category: 'utilities' });
  });

  // ---------------------------------------------------------------- pages, totals, exports
  describe('one set of totals', () => {
    let branch = '';
    let bills = { id: '', name: '' };
    let rent = { id: '', name: '' };
    const dateFrom = '2026-09-01';
    const dateTo = '2026-09-30';
    const exportFilters = (extra: Partial<ReportFilterArg> = {}): ReportFilterArg => ({
      branchId: branch,
      dateFrom: resolveDateRangeBoundary(dateFrom, 'start'),
      dateTo: resolveDateRangeBoundary(dateTo, 'end'),
      page: 1,
      limit: 25,
      ...extra,
    });

    beforeAll(async () => {
      branch = await freshBranch('Totals');
      await prisma.userBranchAssignment.create({ data: { userId: ids.supAB, branchId: branch } });
      bills = await createType(unique('Bills'), [branch]);
      rent = await createType(unique('Rent'), [branch]);
      // Same-day ties across more than one page, plus a row outside the dates and a deleted one.
      // POS-PERF-P62 — the 60 rows are independent, so they are created ten at a time;
      // one at a time took 5.1s with two files running and passed 10s in the full suite.
      for (let i = 0; i < 60; i += 10) await Promise.all(Array.from({ length: 10 }, () => addExpense(branch, bills.id, 10.1, '2026-09-10')));
      for (let i = 0; i < 3; i += 1) await addExpense(branch, rent.id, 500, '2026-09-11');
      await legacyExpense(branch, 'utilities', 33.3, '2026-09-12');
      await addExpense(branch, bills.id, 9999, '2026-10-01');
      const deleted = await addExpense(branch, bills.id, 8888, '2026-09-13');
      await expensesService.deleteExpense(deleted.id, { id: ids.admin, role: 'super_admin' }, null);
    });

    it('aggregates cover every matching record, past the page, with no row repeated across pages', async () => {
      const jwt = supervisorJwt(ids.supAB);
      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const result = await expensesService.getExpenses(jwt, { branch_id: branch, expense_type_id: bills.id, date_from: dateFrom, date_to: dateTo, page, limit: 25 });
        expect(result.total).toBe(60);
        expect(result.total_amount).toBeCloseTo(606, 2);
        seen.push(...result.expenses.map((e) => e.id));
      }
      expect(seen).toHaveLength(60);
      expect(new Set(seen).size).toBe(60);
    });

    it('date filters apply to the ledger, which used to ignore them', async () => {
      const jwt = supervisorJwt(ids.supAB);
      const all = await expensesService.getExpenses(jwt, { branch_id: branch, expense_type_id: bills.id, page: 1, limit: 25 });
      expect(all.total).toBe(61);
      const september = await expensesService.getExpenses(jwt, { branch_id: branch, expense_type_id: bills.id, date_from: dateFrom, date_to: dateTo, page: 1, limit: 25 });
      expect(september.total).toBe(60);
    });

    it('ledger, breakdown and both export formats agree, for all expenses and for each view', async () => {
      const jwt = supervisorJwt(ids.supAB);
      const summary = await expensesService.getSummary(jwt, { branch_id: branch, date_from: dateFrom, date_to: dateTo });
      expect(summary.total).toBe(64);
      expect(summary.total_amount).toBeCloseTo(606 + 1500 + 33.3, 2);
      const lineSum = summary.groups.reduce((sum, group) => sum + group.total_amount, 0);
      expect(lineSum).toBeCloseTo(summary.total_amount, 2);

      for (const group of summary.groups) {
        const filter = group.expense_type_id ? { expense_type_id: group.expense_type_id } : { category: group.category ?? undefined };
        const ledger = await expensesService.getExpenses(jwt, { branch_id: branch, date_from: dateFrom, date_to: dateTo, ...filter, page: 1, limit: 25 });
        expect(ledger.total).toBe(group.count);
        expect(ledger.total_amount).toBeCloseTo(group.total_amount, 2);

        const csv = await reportsService.requestExport(
          'EXPENSES',
          exportFilters(group.expense_type_id ? { expenseTypeId: group.expense_type_id } : { expenseCategory: group.category ?? undefined }),
          'csv',
          ids.supAB,
          'supervisor',
          branch,
        );
        if (csv.kind !== 'file') throw new Error('expected a file');
        const lines = csv.buffer.toString('utf-8').trim().split('\n');
        expect(lines[0]).toContain('Type');
        expect(lines).toHaveLength(group.count + 1);
      }

      const csv = await reportsService.requestExport('EXPENSES', exportFilters(), 'csv', ids.supAB, 'supervisor', branch);
      if (csv.kind !== 'file') throw new Error('expected a file');
      const text = csv.buffer.toString('utf-8');
      expect(text).toContain(bills.name);
      expect(text).toContain('Utilities (legacy)');
      expect(text).not.toContain('Miscellaneous');
      const amounts = text.trim().split('\n').slice(1).map((line) => Number(line.split(',')[5]));
      expect(amounts).toHaveLength(64);
      expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBeCloseTo(summary.total_amount, 2);
    });

    it('under the row limit a PDF is a complete file; past it, the PDF is marked partial and the CSV stays whole', async () => {
      const pdf = await reportsService.requestExport('EXPENSES', exportFilters({ expenseTypeId: bills.id }), 'pdf', ids.supAB, 'supervisor', branch);
      if (pdf.kind !== 'file') throw new Error('expected a file');
      expect(pdf.contentType).toBe('application/pdf');
      expect(pdf.buffer.subarray(0, 4).toString()).toBe('%PDF');
      expect(pdf.filename).not.toContain('PARTIAL');

      const big = await freshBranch('Big');
      await prisma.expense.createMany({
        data: Array.from({ length: 101 }, () => ({ branchId: big, category: 'supplies' as const, amount: 1, incurredAt: new Date(), createdBy: ids.supAB })),
      });
      const capped = await reportsService.requestExport('EXPENSES', { branchId: big, page: 1, limit: 25 }, 'pdf', ids.admin, 'super_admin', big);
      if (capped.kind !== 'file') throw new Error('expected a file');
      expect(capped.filename).toContain('PARTIAL');
      const whole = await reportsService.requestExport('EXPENSES', { branchId: big, page: 1, limit: 25 }, 'csv', ids.admin, 'super_admin', big);
      if (whole.kind !== 'file') throw new Error('expected a file');
      expect(whole.filename).not.toContain('PARTIAL');
      expect(whole.buffer.toString('utf-8').trim().split('\n')).toHaveLength(102);
    }, 90_000); // POS-PERF-P62 — two real PDFs through the worker, including its cold start (6.0s idle on the P62 laptop; runbook §7).

    it('no dates in an export means every date, as on the ledger', async () => {
      const csv = await reportsService.requestExport('EXPENSES', { branchId: branch, expenseTypeId: bills.id, page: 1, limit: 25 }, 'csv', ids.supAB, 'supervisor', branch);
      if (csv.kind !== 'file') throw new Error('expected a file');
      expect(csv.buffer.toString('utf-8').trim().split('\n')).toHaveLength(62);
    });

    it('dashboards agree with the summary: same day, branch, and across branches for an Admin', async () => {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
      const dashBranch = await freshBranch('Dash');
      await prisma.userBranchAssignment.create({ data: { userId: ids.supAB, branchId: dashBranch } });
      const type = await createType(unique('Dash'), [dashBranch]);
      await addExpense(dashBranch, type.id, 150.25, today);
      const stats = await branchesRepository.branchStats(dashBranch);
      const summary = await expensesService.getSummary(supervisorJwt(ids.supAB), { branch_id: dashBranch, date_from: today, date_to: today });
      expect(summary.total_amount).toBe(150.25);
      expect(stats.todayExpenses).toBe(summary.total_amount);

      const grouped = await branchesRepository.findAllStatsGrouped();
      const adminSummary = await expensesService.getSummary(adminJwt(), { date_from: today, date_to: today });
      const groupedTotal = grouped.reduce((sum, row) => sum + row.todayExpenses, 0);
      expect(groupedTotal).toBeCloseTo(adminSummary.total_amount, 2);
    });

    it('a supervisor\'s breakdown across branches holds only their branches', async () => {
      const mine = await expensesService.getSummary(supervisorJwt(ids.supC), {});
      const c = await expensesService.getSummary(adminJwt(), { branch_id: ids.branchC });
      expect(mine.total).toBe(c.total);
      expect(mine.total_amount).toBeCloseTo(c.total_amount, 2);
    });
  });

  it('permanently deleting a branch still works once it has types and expenses', async () => {
    const branch = await freshBranch('Delete');
    await prisma.userBranchAssignment.create({ data: { userId: ids.supAB, branchId: branch } });
    const type = await createType(unique('Delete'), [branch]);
    await addExpense(branch, type.id, 5);
    // Rolled back: other test files provision across every branch, and a branch vanishing mid-way would fail them.
    const finished = new Error('roll back');
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.userBranchAssignment.deleteMany({ where: { branchId: branch } });
        await tx.branch.delete({ where: { id: branch } });
        expect(await tx.expenseTypeBranch.count({ where: { expenseTypeId: type.id } })).toBe(0);
        expect(await tx.expense.count({ where: { expenseTypeId: type.id } })).toBe(0);
        throw finished;
      }),
    ).rejects.toBe(finished);
  });
});
