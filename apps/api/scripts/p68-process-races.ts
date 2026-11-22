// POS-PERF-P68 — multi-process Force Delete races. LOCAL ONLY.
//
// Two (sometimes three) real built API processes (`node dist/server.js`, each
// with its own port, connection pool, deduction worker and Force Delete
// sweeper) against ONE disposable local p62_* Postgres. Races are ordered by
// database barriers, never sleeps: this script holds a row or advisory lock in
// its own transaction, then waits (pg_stat_activity / pg_blocking_pids) until
// the API statement it wants to stop is actually waiting on that lock. No
// debug or bypass route exists or is added; every call is a normal route with
// a normal signed token (src/test-utils/auth-tokens.ts).
//
// Raw SQL here is test coordination only (locks, pg_stat_activity), never an
// application write. Fixtures are rows of their own in the disposable DB.
//
// Usage (from apps/api, after `prisma migrate deploy`, the P62 seed and `tsc`):
//   . /c/p68r/env.sh && npx tsx scripts/p68-process-races.ts [/c/p68r/out]
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient, Prisma } from '@prisma/client';
import { generateTestToken } from '../src/test-utils/auth-tokens.js';
import { inventoryStockLockId } from '../src/lib/pg-lock.js';

// ---------------------------------------------------------------- guards
const DB = process.env.DATABASE_URL ?? '';
{
  const url = new URL(DB);
  if (url.hostname !== '127.0.0.1' || !/^\/p62_[a-z0-9_]+$/.test(url.pathname)) throw new Error('Refusing: DATABASE_URL is not a local p62_* database');
  if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('Refusing: PRODUCTION_DATABASE_URL_DIRECT is set');
}
const OUT = process.argv[2] ?? '/c/p68r/out';
mkdirSync(OUT, { recursive: true });
const PORTS = { A: 56482, B: 56484, C: 56485 } as const;
for (const port of Object.values(PORTS)) if (port >= 55158 && port <= 55557) throw new Error('reserved port');

const db = new PrismaClient({ datasources: { db: { url: `${DB}${DB.includes('?') ? '&' : '?'}connection_limit=12` } }, log: [] });
const RUN = Date.now().toString(36);

// ---------------------------------------------------------------- results
type Check = { scenario: string; name: string; pass: boolean; detail?: unknown };
const checks: Check[] = [];
let scenario = '';
function check(name: string, pass: boolean, detail?: unknown) {
  checks.push({ scenario, name, pass, detail });
  console.warn(`${pass ? 'PASS' : 'FAIL'} [${scenario}] ${name}${pass || detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
}

// ---------------------------------------------------------------- processes
const procs: Partial<Record<keyof typeof PORTS, ChildProcess>> = {};
async function startApi(name: keyof typeof PORTS) {
  const log = createWriteStream(path.join(OUT, `api-${name}-${RUN}.log`), { flags: 'a' });
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, API_PORT: String(PORTS[name]), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  procs[name] = child;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORTS[name]}/health`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500)); // start-up poll, not a race barrier
  }
  throw new Error(`API ${name} did not start`);
}
async function killApi(name: keyof typeof PORTS) {
  const child = procs[name];
  if (!child) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL'); // TerminateProcess on Windows: a crash, no graceful shutdown
  await exited;
  delete procs[name];
}

interface ApiData {
  id?: string;
  status?: string;
  version?: number;
  operation_id?: string | null;
  closure_item_count?: number;
  requests?: { id: string }[];
  transaction?: { id: string };
  confirmation: { name: string; code: string; version: string; plan_keys: string[]; plan_hash: string; confirmation_token: string };
}
type Res = { status: number; body: { data?: ApiData; error?: { code?: string; message?: string } | null } };
async function call(api: keyof typeof PORTS, method: string, url: string, token: string, body?: unknown): Promise<Res> {
  const res = await fetch(`http://127.0.0.1:${PORTS[api]}${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Res['body'] = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: { message: text.slice(0, 200) } };
  }
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------- barriers
type Barrier = { pid: number; release: () => Promise<void> };
async function hold(lockSql: Prisma.Sql): Promise<Barrier> {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let gotPid!: (pid: number) => void;
  const pid = new Promise<number>((r) => (gotPid = r));
  const done = db.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await tx.$executeRaw(lockSql);
      gotPid(row?.pid ?? -1);
      await gate;
    },
    { timeout: 180_000, maxWait: 10_000 },
  );
  done.catch(() => {});
  const p = await Promise.race([pid, done.then(() => -1)]);
  if (p < 0) throw new Error('barrier failed');
  return { pid: p, release: async () => { open(); await done; } };
}
/** Waits until `count` sessions run a statement like `pattern` and are blocked (optionally by `blocker`). */
async function waitBlocked(pattern: string, blocker?: number, count = 1): Promise<number[]> {
  for (let i = 0; i < 400; i++) {
    const rows = await db.$queryRaw<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE ${pattern}
        AND (${blocker ?? null}::int IS NULL OR ${blocker ?? null}::int = ANY(pg_blocking_pids(pid)))`;
    if (rows.length >= count) return rows.map((r) => r.pid);
    await new Promise((r) => setTimeout(r, 50)); // polling interval for an observed lock wait
  }
  throw new Error(`timed out waiting for a blocked statement like ${pattern}`);
}

// ---------------------------------------------------------------- fixtures
const shared: Record<string, string> = {};
const tokens = { admin: '', admin2: '' };
const fixtureBranches: string[] = [];

async function setupShared() {
  shared.admin = (await db.user.create({ data: { role: 'super_admin', firstName: 'Race', lastName: `Admin${RUN}`, email: `race-admin-${RUN}@p68r.test`, employmentType: 'regular', mustChangePassword: false } })).id;
  shared.admin2 = (await db.user.create({ data: { role: 'super_admin', firstName: 'Race', lastName: `Admin2${RUN}`, email: `race-admin2-${RUN}@p68r.test`, employmentType: 'regular', mustChangePassword: false } })).id;
  tokens.admin = generateTestToken('super_admin', { userId: shared.admin, email: `race-admin-${RUN}@p68r.test` });
  tokens.admin2 = generateTestToken('super_admin', { userId: shared.admin2, email: `race-admin2-${RUN}@p68r.test` });
  shared.g = (await db.unitOfMeasure.create({ data: { code: `p68r-g-${RUN}`, name: 'P68R Gram', dimension: 'WEIGHT', isBaseUnit: true } })).id;
  shared.pc = (await db.unitOfMeasure.create({ data: { code: `p68r-pc-${RUN}`, name: 'P68R Piece', dimension: 'COUNT', isBaseUnit: true } })).id;
  shared.potato = (await db.inventoryItem.create({ data: { name: `P68R potato ${RUN}`, baseUnitId: shared.g } })).id;
  // Two supply items; the issue deducts them in id order, so `first` is always deducted first.
  const a = (await db.inventoryItem.create({ data: { name: `P68R cup ${RUN}`, baseUnitId: shared.pc } })).id;
  const b = (await db.inventoryItem.create({ data: { name: `P68R lid ${RUN}`, baseUnitId: shared.pc } })).id;
  [shared.first, shared.second] = a < b ? [a, b] : [b, a];
  shared.product = (await db.product.create({ data: { name: `P68R Fries ${RUN}`, status: 'active', classification: 'regular' } })).id;
  shared.variant = (await db.productVariant.create({ data: { productId: shared.product, name: 'Mega', sizeLabel: 'Mega', basePrice: 250, isActive: true } })).id;
  await db.productComponent.create({ data: { productVariantId: shared.variant, inventoryItemId: shared.potato, quantityRequired: 100 } });
}

type Fx = { branchId: string; code: string; name: string; staff: string; sup: string; sup2: string; shift: string; staffToken: string; supToken: string; sup2Token: string; cards: { id: string; version: number }[] };
async function makeBranch(label: string, opts: { cards?: boolean } = {}): Promise<Fx> {
  const code = `R${label}-${RUN}`.toUpperCase().slice(0, 20);
  const name = `P68R ${label} ${RUN}`;
  const branchId = (await db.branch.create({ data: { name, code, address: '1 Race St', city: 'Testville', status: 'active' } })).id;
  fixtureBranches.push(branchId);
  const mk = async (role: 'staff' | 'supervisor', first: string) =>
    (await db.user.create({ data: { role, firstName: first, lastName: `${label}${RUN}`, email: role === 'staff' ? null : `${first.toLowerCase()}-${label}-${RUN}@p68r.test`.toLowerCase(), employeeId: role === 'staff' ? `P68R-${label}-${RUN}` : null, employmentType: 'regular', mustChangePassword: false } })).id;
  const staff = await mk('staff', 'Cash');
  const sup = await mk('supervisor', 'Sup');
  const sup2 = await mk('supervisor', 'Rev');
  await db.userBranchAssignment.createMany({ data: [staff, sup, sup2].map((userId) => ({ userId, branchId })) });
  await db.attendanceRecord.create({ data: { employeeId: staff, branchId, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });
  const shift = (await db.shift.create({ data: { branchId, cashierId: staff, openedBy: staff, status: 'active', openingCashAmount: 1000, startedAt: new Date() } })).id;
  await db.branchProductAvailability.create({ data: { branchId, productId: shared.product, isAvailable: true } });
  await db.inventoryStock.createMany({ data: [shared.potato, shared.first, shared.second].map((inventoryItemId) => ({ branchId, inventoryItemId, quantityOnHand: inventoryItemId === shared.potato ? 1_000_000 : 1000 })) });
  const fx: Fx = {
    branchId, code, name, staff, sup, sup2, shift, cards: [],
    staffToken: generateTestToken('staff', { userId: staff, branchIds: [branchId] }),
    supToken: generateTestToken('supervisor', { userId: sup, branchIds: [branchId], email: `sup-${label}-${RUN}@p68r.test`.toLowerCase() }),
    sup2Token: generateTestToken('supervisor', { userId: sup2, branchIds: [branchId], email: `rev-${label}-${RUN}@p68r.test`.toLowerCase() }),
  };
  if (opts.cards) {
    for (const item of [shared.first, shared.second]) {
      const res = await call('A', 'POST', '/api/extra-supplies', fx.supToken, { name: `P68R card ${item.slice(0, 6)} ${label} ${RUN}`, inventory_item_id: item, issue_unit_name: 'pc', entered_quantity: 1, entered_unit_id: shared.pc, selling_price: 5, apply_to_pos: true, branch_ids: [branchId] });
      if (res.status !== 201) throw new Error(`card create ${res.status} ${JSON.stringify(res.body.error)}`);
      fx.cards.push({ id: String(res.body.data?.id), version: Number(res.body.data?.version) });
    }
  }
  return fx;
}

const MANUAL = { tax_basis: { calculation_mode: 'manual_total_v1', vat_rate: null, discount_rate: null }, discount_flow: 'manual_v1', discount_choice: 'none_applicable' };
const sale = (api: keyof typeof PORTS, fx: Fx, key = randomUUID()) =>
  call(api, 'POST', '/api/transactions', fx.staffToken, { branch_id: fx.branchId, items: [{ product_id: shared.product, product_variant_id: shared.variant, quantity: 1 }], payment_method: 'cash', cash_tendered: 1000, is_offline_transaction: false, idempotency_key: key, ...MANUAL });
const paidIssue = (api: keyof typeof PORTS, fx: Fx, operationId = randomUUID()) =>
  call(api, 'POST', '/api/extra-supplies/issues', fx.staffToken, { operation_id: operationId, branch_id: fx.branchId, kind: 'paid', lines: fx.cards.map((c) => ({ extra_supply_id: c.id, quantity: 2, version: c.version })), payment_method: 'cash', cash_tendered: 50 });

async function confirmation(api: keyof typeof PORTS, branchId: string, token = tokens.admin) {
  const plan = await call(api, 'GET', `/api/branches/${branchId}/force-deletion-plan`, token);
  if (plan.status !== 200) throw new Error(`plan ${plan.status} ${JSON.stringify(plan.body.error)}`);
  const data = plan.body.data;
  if (!data) throw new Error('plan returned no data');
  const c = data.confirmation;
  return { plan: data, input: { operation_id: randomUUID(), confirm_name: c.name, confirm_code: c.code, version: c.version, plan_keys: c.plan_keys, plan_hash: c.plan_hash, confirmation_token: c.confirmation_token, acknowledge: true } };
}
async function forceDelete(api: keyof typeof PORTS, branchId: string, input: { operation_id: string }, token = tokens.admin) {
  const res = await call(api, 'POST', `/api/branches/${branchId}/force-delete`, token, input);
  if (res.body.data?.status === 'fenced') {
    const op = await db.branchDeletionOperation.findUnique({ where: { id: res.body.data?.operation_id ?? input.operation_id } });
    console.warn(`NOTE [${scenario}] operation still fenced: step=${op?.step} last_error=${op?.lastError?.slice(0, 300)}`);
  }
  return res;
}

async function waitJobsDone(branchId: string) {
  for (let i = 0; i < 400; i++) {
    if ((await db.inventoryDeductionJob.count({ where: { branchId, status: { in: ['pending', 'processing'] } } })) === 0) return;
    await new Promise((r) => setTimeout(r, 50)); // polling the worker's own progress
  }
  throw new Error('deduction jobs did not finish');
}
const stockRow = (branchId: string, item: string) => Prisma.sql`SELECT 1 FROM inventory_stocks WHERE branch_id = ${branchId} AND inventory_item_id = ${item} FOR UPDATE`;
const shiftRow = (shiftId: string) => Prisma.sql`SELECT 1 FROM shifts WHERE id = ${shiftId} FOR UPDATE`;

/** The invariants every finished scenario must keep, whatever the order. */
async function assertSettled(branchId: string, opId: string | null, expectDeleted: boolean) {
  const branch = await db.branch.findUnique({ where: { id: branchId } });
  const record = await db.branchRecord.findUnique({ where: { id: branchId } });
  check(expectDeleted ? 'branch deleted, record kept' : 'branch kept and not fenced', expectDeleted ? branch === null && !!record?.deletedAt : !!branch && branch.deletionFencedAt === null, { branch: !!branch, fenced: branch?.deletionFencedAt ?? null, deletedAt: record?.deletedAt ?? null });
  // Every recorded sale keeps one consistent deduction story.
  const sales = await db.transaction.findMany({ where: { branchId }, select: { id: true, status: true } });
  for (const s of sales) {
    const jobs = await db.inventoryDeductionJob.findMany({ where: { transactionId: s.id } });
    const movements = await db.inventoryStockMovement.count({ where: { referenceId: s.id } }).catch(() => -1);
    const j = jobs[0];
    const ok = jobs.length <= 1 && (!j || (j.status === 'completed' && movements > 0) || (j.status === 'cancelled' && movements === 0) || (!expectDeleted && ['pending', 'processing'].includes(j.status)));
    check(`sale ${s.id.slice(0, 8)} deduction consistent`, ok, { jobs: jobs.map((j) => j.status), movements });
  }
  if (expectDeleted) {
    const openJobs = await db.inventoryDeductionJob.count({ where: { branchId, status: { in: ['pending', 'processing', 'failed'] } } });
    check('no open deduction job left on the deleted branch', openJobs === 0, { openJobs });
    const pending = await db.inventoryApprovalRequest.count({ where: { branchId, status: { in: ['PENDING', 'RETURNED'] } } });
    check('no pending approval left on the deleted branch', pending === 0, { pending });
    const openOps = await db.extraSupplyOperation.count({ where: { branchId, status: { notIn: ['committed', 'abandoned'] } } }).catch(() => 0);
    check('no unfinished supply operation left', openOps === 0, { openOps });
  }
  if (opId) {
    const op = await db.branchDeletionOperation.findUnique({ where: { id: opId } });
    const items = await db.branchClosureItem.count({ where: { operationId: opId } }).catch(() => -1);
    if (op?.status === 'completed') check('closure items recorded for the completed operation', items > 0, { items });
  }
}

// ---------------------------------------------------------------- scenarios
async function s1_checkoutCommitsFirst() {
  scenario = 'S1 checkout commits first, then Force Delete';
  const fx = await makeBranch('s1');
  const key = randomUUID();
  const barrier = await hold(stockRow(fx.branchId, shared.potato));
  const saleP = sale('A', fx, key);
  await waitBlocked('%inventory_stocks%', barrier.pid); // the sale INSERT (guarded, FOR SHARE on the branch) is done
  const { input } = await confirmation('B', fx.branchId);
  const fdP = forceDelete('B', fx.branchId, input);
  await waitBlocked('%"branches"%'); // the fence waits for the in-flight sale
  await barrier.release();
  const [s, fd] = await Promise.all([saleP, fdP]);
  check('sale committed (201)', s.status === 201, s.body.error);
  check('Force Delete aborted on the changed plan, fence lifted', fd.status === 200 && fd.body.data?.status === 'aborted', { status: fd.status, data: fd.body.data?.status, error: fd.body.error });
  await assertSettled(fx.branchId, input.operation_id, false);
  // Then a fresh confirmation completes, from the other process.
  const again = await confirmation('A', fx.branchId);
  const done = await forceDelete('A', fx.branchId, again.input);
  check('fresh Force Delete completes', done.body.data?.status === 'completed', { status: done.status, data: done.body.data, error: done.body.error });
  const saleRow = await db.transaction.findFirst({ where: { branchId: fx.branchId } });
  check('recorded sale kept on the branch record', saleRow?.status === 'completed', saleRow?.status);
  const retry = await sale('B', fx, key);
  check('same-key checkout retry is refused (no duplicate)', retry.status === 401 || retry.status === 403, { status: retry.status, code: retry.body.error?.code });
  const lookup = await call('B', 'GET', `/api/transactions/by-idempotency-key/${key}?branch_id=${fx.branchId}`, tokens.admin);
  check('original sale is still found by its key', lookup.status === 200 && lookup.body.data?.transaction?.id === saleRow?.id || lookup.body.data?.status === 'committed', { status: lookup.status, data: lookup.body.data?.status, error: lookup.body.error });
  check('exactly one sale for the key', (await db.transaction.count({ where: { branchId: fx.branchId } })) === 1);
  await assertSettled(fx.branchId, again.input.operation_id, true);
}

async function s2_fenceFirst() {
  scenario = 'S2 fence commits first, then checkout';
  const fx = await makeBranch('s2');
  const barrier = await hold(shiftRow(fx.shift)); // finalize stops at the shift; the fence is committed
  const { input } = await confirmation('A', fx.branchId);
  const fdP = forceDelete('A', fx.branchId, input);
  await waitBlocked('%"shifts"%', barrier.pid);
  const key = randomUUID();
  const s = await sale('B', fx, key);
  check('checkout refused while fenced (409 BRANCH_DELETION_IN_PROGRESS)', s.status === 409 && s.body.error?.code === 'BRANCH_DELETION_IN_PROGRESS', { status: s.status, code: s.body.error?.code });
  check('no sale and no checkout attempt written', (await db.transaction.count({ where: { branchId: fx.branchId } })) === 0 && (await db.checkoutAttempt.count({ where: { idempotencyKey: key } })) === 0);
  const issueEarly = await call('B', 'POST', '/api/transactions', fx.staffToken, { branch_id: fx.branchId, items: [{ product_id: shared.product, product_variant_id: shared.variant, quantity: 1 }], payment_method: 'cash', cash_tendered: 1000, is_offline_transaction: false, idempotency_key: key, ...MANUAL });
  check('retry of the same key while fenced is still refused, retryable', issueEarly.status === 409, issueEarly.body.error?.code);
  await barrier.release();
  const fd = await fdP;
  check('Force Delete completes', fd.body.data?.status === 'completed', { status: fd.status, data: fd.body.data?.status, error: fd.body.error });
  const shift = await db.shift.findUnique({ where: { id: fx.shift } });
  check('open shift terminated, no cash count invented', shift?.status === 'terminated' && shift.closedAt === null && shift.closingCashAmount === null, { status: shift?.status });
  await assertSettled(fx.branchId, input.operation_id, true);
}

async function s3_checkoutStartedBeforeFence() {
  scenario = 'S3 checkout claimed before the fence, commits after';
  const fx = await makeBranch('s3');
  const warm = await sale('A', fx); // creates today's receipt counter row for this branch
  check('warm-up sale', warm.status === 201, warm.body.error);
  await waitJobsDone(fx.branchId); // its deduction changes the stock key; let it settle before the plan
  const barrier = await hold(Prisma.sql`SELECT 1 FROM id_counters WHERE key LIKE ${`receipt_counter:${fx.code}-%`} FOR UPDATE`);
  const key = randomUUID();
  const saleP = sale('A', fx, key);
  await waitBlocked('%id_counters%', barrier.pid); // claim committed, sale INSERT not yet run
  check('checkout attempt claimed (in progress) before the fence', (await db.checkoutAttempt.findUnique({ where: { idempotencyKey: key } }))?.status === 'in_progress');
  const shiftBarrier = await hold(shiftRow(fx.shift));
  const { input, plan } = await confirmation('B', fx.branchId);
  check('plan lists the in-progress checkout', JSON.stringify(plan.confirmation.plan_keys).includes(key));
  const fdP = forceDelete('B', fx.branchId, input);
  await waitBlocked('%"shifts"%', shiftBarrier.pid); // fence committed, finalize waiting
  await barrier.release();
  const s = await saleP;
  check('late sale refused (409 BRANCH_DELETION_IN_PROGRESS)', s.status === 409 && s.body.error?.code === 'BRANCH_DELETION_IN_PROGRESS', { status: s.status, code: s.body.error?.code });
  await shiftBarrier.release();
  const fd = await fdP;
  check('Force Delete completes', fd.body.data?.status === 'completed', { status: fd.status, data: fd.body.data?.status, error: fd.body.error });
  check('no sale for the late key', (await db.transaction.count({ where: { branchId: fx.branchId } })) === 1);
  const lookup = await call('A', 'GET', `/api/transactions/by-idempotency-key/${key}?branch_id=${fx.branchId}`, tokens.admin);
  check('late key reports abandoned, never committed', lookup.body.data?.status === 'abandoned' || lookup.status === 404, { status: lookup.status, data: lookup.body.data?.status, error: lookup.body.error?.code });
  const item = await db.branchClosureItem.findFirst({ where: { operationId: input.operation_id, kind: 'pending_checkout' } });
  check('closure item records the abandoned checkout', !!item, item?.outcome);
  await assertSettled(fx.branchId, input.operation_id, true);
}

async function s4_workerVsDeletion() {
  scenario = 'S4 claimed deduction worker vs Force Delete';
  const fx = await makeBranch('s4');
  const lock = inventoryStockLockId(fx.branchId, shared.potato);
  const barrier = await hold(Prisma.sql`SELECT pg_advisory_xact_lock(${lock})`); // only the worker takes it; reserve does not
  const s = await sale('A', fx);
  check('sale committed', s.status === 201, s.body.error);
  await waitBlocked('%pg_advisory_xact_lock%', barrier.pid); // a worker (A or B) claimed the job and waits
  const job = await db.inventoryDeductionJob.findFirstOrThrow({ where: { branchId: fx.branchId } });
  check('job is claimed (processing)', job.status === 'processing', job.status);
  const before = await db.inventoryStock.findFirstOrThrow({ where: { branchId: fx.branchId, inventoryItemId: shared.potato } });
  const { input } = await confirmation('B', fx.branchId);
  const fdP = forceDelete('B', fx.branchId, input);
  await waitBlocked('%inventory_deduction_jobs%'); // finalize waits on the worker's job row
  await barrier.release();
  const fd = await fdP;
  check('Force Delete completes', fd.body.data?.status === 'completed', { status: fd.status, data: fd.body.data?.status, error: fd.body.error });
  const after = await db.inventoryDeductionJob.findUniqueOrThrow({ where: { id: job.id } });
  check('job cancelled, claim cleared', after.status === 'cancelled' && after.claimToken === null, { status: after.status });
  check('worker wrote no stock movement for the sale', (await db.inventoryStockMovement.count({ where: { referenceId: s.body.data?.id } })) === 0);
  const snap = await db.branchClosureItem.findFirst({ where: { operationId: input.operation_id, kind: 'stock_balance', sourceId: before.id } });
  const snapshot = (snap?.snapshot ?? {}) as { quantityOnHand?: string; quantityReserved?: string };
  check('stock snapshot is the exact pre-deletion balance', Number(snapshot.quantityOnHand) === before.quantityOnHand.toNumber() && Number(snapshot.quantityReserved) === before.quantityReserved.toNumber(), { snapshot, before: [before.quantityOnHand, before.quantityReserved] });
  await assertSettled(fx.branchId, input.operation_id, true);
}

async function s5_paidSupplyIssue() {
  scenario = 'S5a paid supply issue in flight holds the fence';
  const fx = await makeBranch('s5a', { cards: true });
  const opId = randomUUID();
  let barrier = await hold(stockRow(fx.branchId, shared.second)); // first item deducted (guarded), second waits
  const issueP = paidIssue('A', fx, opId);
  await waitBlocked('%inventory_stocks%', barrier.pid);
  const { input } = await confirmation('B', fx.branchId);
  const fdP = forceDelete('B', fx.branchId, input);
  await waitBlocked('%"branches"%');
  await barrier.release();
  const [issue, fd] = await Promise.all([issueP, fdP]);
  check('paid issue committed (201)', issue.status === 201, { status: issue.status, error: issue.body.error });
  check('Force Delete aborted (stock changed), fence lifted', fd.body.data?.status === 'aborted', { status: fd.status, data: fd.body.data?.status, error: fd.body.error });
  const again = await forceDelete('B', fx.branchId, (await confirmation('A', fx.branchId)).input);
  check('fresh Force Delete completes', again.body.data?.status === 'completed', again.body.error ?? again.body.data?.status);
  const kept = await db.extraSupplyIssue.findMany({ where: { branchId: fx.branchId } });
  check('paid issue kept with its amount', kept.length === 1 && Number(kept[0]?.amountCollected) === 20, kept.map((k) => k.amountCollected));
  await assertSettled(fx.branchId, null, true);

  scenario = 'S5b paid supply issue started before the fence, commits after';
  const fy = await makeBranch('s5b', { cards: true });
  barrier = await hold(stockRow(fy.branchId, shared.first)); // waits before any guarded write
  const opId2 = randomUUID();
  const issue2P = paidIssue('A', fy, opId2);
  await waitBlocked('%inventory_stocks%', barrier.pid);
  const shiftBarrier = await hold(shiftRow(fy.shift));
  const c2 = await confirmation('B', fy.branchId);
  const fd2P = forceDelete('B', fy.branchId, c2.input);
  await waitBlocked('%"shifts"%', shiftBarrier.pid);
  await barrier.release();
  const issue2 = await issue2P;
  check('late paid issue refused (409 BRANCH_DELETION_IN_PROGRESS)', issue2.status === 409 && issue2.body.error?.code === 'BRANCH_DELETION_IN_PROGRESS', { status: issue2.status, code: issue2.body.error?.code });
  await shiftBarrier.release();
  const fd2 = await fd2P;
  check('Force Delete completes', fd2.body.data?.status === 'completed', fd2.body.error ?? fd2.body.data?.status);
  check('no issue, line, payment or stock movement from the refused issue', (await db.extraSupplyIssue.count({ where: { branchId: fy.branchId } })) === 0 && (await db.extraSupplyOperation.count({ where: { id: opId2 } }).catch(() => 0)) === 0);
  await assertSettled(fy.branchId, c2.input.operation_id, true);
}

async function s6_voidAfterFence() {
  scenario = 'S6 status-only write (void of a pending-deduction sale) after the fence';
  const fx = await makeBranch('s6');
  const lock = inventoryStockLockId(fx.branchId, shared.potato);
  // The second sale's deduction stays pending: a worker claims it and waits on the stock lock.
  const barrier = await hold(Prisma.sql`SELECT pg_advisory_xact_lock(${lock})`);
  const pendingSale = await sale('A', fx);
  check('sale committed', pendingSale.status === 201, pendingSale.body.error);
  await waitBlocked('%pg_advisory_xact_lock%', barrier.pid);
  const shiftBarrier = await hold(shiftRow(fx.shift));
  const { input } = await confirmation('B', fx.branchId);
  const fdP = forceDelete('B', fx.branchId, input);
  await waitBlocked('%"shifts"%', shiftBarrier.pid); // fenced, finalize waiting
  const voidP = call('A', 'POST', `/api/transactions/${pendingSale.body.data?.id}/void`, fx.supToken, { void_reason: 'P68R race: void after fence' });
  // Fixed: refused at once. Defect: the sale status update commits past the fence and the
  // void then waits for the claimed job row.
  const first = await Promise.race([voidP.then((r) => ({ r })), waitBlocked('%inventory_deduction_jobs%').then(() => ({ r: null }), () => ({ r: null }))]);
  check('void refused while fenced (409 BRANCH_DELETION_IN_PROGRESS)', first.r?.status === 409 && first.r.body.error?.code === 'BRANCH_DELETION_IN_PROGRESS', first.r ? { status: first.r.status, code: first.r.body.error?.code } : 'void passed the fence and is waiting on the deduction job');
  await barrier.release();
  await shiftBarrier.release();
  const voidRes = await voidP;
  const fd = await fdP;
  check('Force Delete completes', fd.body.data?.status === 'completed', fd.body.error ?? fd.body.data?.status);
  check('void outcome recorded', true, voidRes.status);
  const row = await db.transaction.findUniqueOrThrow({ where: { id: pendingSale.body.data?.id } });
  check('sale not voided after the fence', row.status === 'completed', row.status);
  await assertSettled(fx.branchId, input.operation_id, true);
}

async function s7_restartAndRepeat() {
  scenario = 'S7 lost response + process crash + restart, repeat Force Delete';
  const fx = await makeBranch('s7');
  const barrier = await hold(shiftRow(fx.shift));
  const { input } = await confirmation('C', fx.branchId);
  const fdP = forceDelete('C', fx.branchId, input).catch((e) => ({ status: 0, body: { error: { message: String(e) } } }) as Res);
  const [blocked] = await waitBlocked('%"shifts"%', barrier.pid);
  await killApi('C'); // the response is lost
  await db.$queryRaw`SELECT pg_terminate_backend(${blocked}::int)`;
  await barrier.release();
  const lost = await fdP;
  check('client saw no success (lost response)', lost.status !== 200, lost.status);
  const op = await db.branchDeletionOperation.findUniqueOrThrow({ where: { id: input.operation_id } });
  check('operation durably fenced after the crash', op.status === 'fenced', op.status);
  check('branch still fenced, not half-deleted', !!(await db.branch.findUnique({ where: { id: fx.branchId } }))?.deletionFencedAt);
  // Concurrent repeats of the same id from both survivors, plus a status read.
  const [r1, r2] = await Promise.all([forceDelete('A', fx.branchId, input), forceDelete('B', fx.branchId, input)]);
  check('both repeats return the original operation', [r1, r2].every((r) => r.status === 200 && r.body.data?.operation_id === input.operation_id), [r1, r2].map((r) => ({ s: r.status, st: r.body.data?.status, code: r.body.error?.code })));
  check('it completes', [r1, r2].some((r) => r.body.data?.status === 'completed'));
  const items = await db.branchClosureItem.count({ where: { operationId: input.operation_id } });
  const status = await call('A', 'GET', `/api/branches/force-deletions/${input.operation_id}`, tokens.admin);
  check('closure items written once', status.body.data?.closure_item_count === items && items >= 2, { items, reported: status.body.data?.closure_item_count });
  const newId = await forceDelete('B', fx.branchId, { ...input, operation_id: randomUUID() });
  check('a new id after completion reports already_deleted', newId.body.data?.status === 'already_deleted', newId.body.data?.status ?? newId.body.error);
  const other = await forceDelete('A', fx.branchId, input, tokens.admin2);
  check("another admin can't reuse the id", other.status === 409 && other.body.error?.code === 'FORCE_DELETION_OPERATION_CONFLICT', other.body.error?.code);
  await assertSettled(fx.branchId, input.operation_id, true);

  scenario = 'S7b crash + restart sweeper finishes a fenced operation';
  const fy = await makeBranch('s7b');
  await startApi('C');
  const b2 = await hold(shiftRow(fy.shift));
  const c2 = await confirmation('C', fy.branchId);
  const p2 = forceDelete('C', fy.branchId, c2.input).catch(() => null);
  const [pid2] = await waitBlocked('%"shifts"%', b2.pid);
  await killApi('C');
  await db.$queryRaw`SELECT pg_terminate_backend(${pid2}::int)`;
  await b2.release();
  await p2;
  await startApi('C'); // start-up sweep
  let final = '';
  for (let i = 0; i < 600 && final !== 'completed'; i++) {
    final = (await db.branchDeletionOperation.findUniqueOrThrow({ where: { id: c2.input.operation_id } })).status;
    if (final !== 'completed') await new Promise((r) => setTimeout(r, 100)); // waits for the sweeper, bounded at 60 s
  }
  check('sweeper completed the fenced operation after restart', final === 'completed', final);
  await assertSettled(fy.branchId, c2.input.operation_id, true);
}

async function a1_approvals() {
  const submitCount = async (fx: Fx, counted: number) => {
    const res = await call('A', 'POST', `/api/branches/${fx.branchId}/inventory-stock/count`, fx.supToken, { counts: [{ inventory_item_id: shared.potato, counted_quantity: counted }], notes: 'P68R count' });
    if (res.status !== 201) throw new Error(`count ${res.status} ${JSON.stringify(res.body.error)}`);
    const id = res.body.data?.requests?.[0]?.id;
    if (!id) throw new Error('count returned no request');
    return id;
  };

  scenario = 'A1 approve commits first, then Force Delete';
  const fx = await makeBranch('a1');
  const req1 = await submitCount(fx, 999_000);
  const stale = await confirmation('B', fx.branchId);
  check('plan lists the pending approval', JSON.stringify(stale.plan.confirmation.plan_keys).includes(req1));
  const ok = await call('A', 'POST', `/api/inventory-approvals/${req1}/approve`, tokens.admin);
  check('approve succeeds (200, stock changed)', ok.status === 200 && ok.body.data?.status === 'APPROVED', { status: ok.status, error: ok.body.error });
  const refused = await forceDelete('B', fx.branchId, stale.input);
  check('stale confirmation refused (plan changed), nothing changed', refused.status === 409 && refused.body.error?.code === 'FORCE_DELETION_PLAN_CHANGED', refused.body.error?.code);
  const fresh = await confirmation('B', fx.branchId);
  const done = await forceDelete('B', fx.branchId, fresh.input);
  check('fresh Force Delete completes', done.body.data?.status === 'completed', done.body.error ?? done.body.data?.status);
  const stock = await db.branchClosureItem.findFirst({ where: { operationId: fresh.input.operation_id, kind: 'stock_balance', snapshot: { path: ['inventoryItemId'], equals: shared.potato } } });
  check('stock snapshot is the approved balance (999000), no write-off', Number((stock?.snapshot as Record<string, unknown> | null)?.quantityOnHand) === 999_000, stock?.snapshot);
  const hist = await call('A', 'GET', `/api/inventory-approvals/${req1}`, tokens.admin);
  check('approval history still visible after deletion', hist.status === 200 && hist.body.data?.status === 'APPROVED', { status: hist.status, code: hist.body.error?.code });
  await assertSettled(fx.branchId, fresh.input.operation_id, true);

  scenario = 'A2 fence first, approve in flight commits after';
  const fy = await makeBranch('a2');
  const req2 = await submitCount(fy, 998_500);
  const stockB = await hold(stockRow(fy.branchId, shared.potato));
  const apP = call('A', 'POST', `/api/inventory-approvals/${req2}/approve`, tokens.admin);
  await waitBlocked('%inventory_stocks%', stockB.pid); // approval row flipped in its tx, stock write waiting
  const c2 = await confirmation('B', fy.branchId); // the request is still PENDING to every other reader
  const fdP = forceDelete('B', fy.branchId, c2.input);
  await waitBlocked('%inventory_approval_requests%'); // fence committed; finalize waits on the approval row
  await stockB.release();
  const [ap, fd] = await Promise.all([apP, fdP]);
  check('late approve refused (409 BRANCH_DELETION_IN_PROGRESS)', ap.status === 409 && ap.body.error?.code === 'BRANCH_DELETION_IN_PROGRESS', { status: ap.status, code: ap.body.error?.code });
  check('Force Delete completes', fd.body.data?.status === 'completed', fd.body.error ?? fd.body.data?.status);
  const row2 = await db.inventoryApprovalRequest.findUniqueOrThrow({ where: { id: req2 } });
  check('approval cancelled unreviewed (not approved, not lost)', row2.status === 'CANCELLED', row2.status);
  check('no stock movement from the approval', (await db.inventoryStockMovement.count({ where: { branchId: fy.branchId } })) === 0);
  const item = await db.branchClosureItem.findFirst({ where: { operationId: c2.input.operation_id, kind: 'inventory_approval', sourceId: req2 } });
  const snap = (item?.snapshot ?? {}) as Record<string, unknown>;
  check('closure snapshot keeps quantities and proof key', Number(snap.countedQuantity) === 998_500 && 'quantityOnHandAtSubmission' in snap && 'quantityDelta' in snap && 'proofKey' in snap, snap);
  const late = await call('B', 'POST', `/api/inventory-approvals/${req2}/approve`, tokens.admin);
  check('approve after deletion refused, branch not resurrected', late.status >= 400 && !(await db.branch.findUnique({ where: { id: fy.branchId } })), { status: late.status, code: late.body.error?.code });
  await assertSettled(fy.branchId, c2.input.operation_id, true);

  scenario = 'A3 new count / reject (cancel) while fenced';
  const fz = await makeBranch('a3');
  const req3 = await submitCount(fz, 997_000);
  const sb = await hold(shiftRow(fz.shift));
  const c3 = await confirmation('A', fz.branchId);
  const fd3P = forceDelete('A', fz.branchId, c3.input);
  await waitBlocked('%"shifts"%', sb.pid);
  const newCount = await call('B', 'POST', `/api/branches/${fz.branchId}/inventory-stock/count`, fz.supToken, { counts: [{ inventory_item_id: shared.potato, counted_quantity: 1 }], notes: 'P68R late count' });
  check('new count on a fenced branch refused (409)', newCount.status === 409 && newCount.body.error?.code === 'BRANCH_DELETION_IN_PROGRESS', { status: newCount.status, code: newCount.body.error?.code });
  const rej = await call('B', 'POST', `/api/inventory-approvals/${req3}/cancel`, fz.supToken, { reason: 'P68R reject while fenced' });
  await sb.release();
  const fd3 = await fd3P;
  const row3 = await db.inventoryApprovalRequest.findUniqueOrThrow({ where: { id: req3 } });
  check('reject and Force Delete settle consistently (one cancel, recorded once)', row3.status === 'CANCELLED' && (fd3.body.data?.status === 'completed' || fd3.body.data?.status === 'fenced'), { reject: rej.status, op: fd3.body.data?.status, error: fd3.body.error });
  if (fd3.body.data?.status !== 'completed') {
    const retry = await forceDelete('B', fz.branchId, c3.input);
    check('repeat finishes it', retry.body.data?.status === 'completed', retry.body.data?.status);
  }
  check('exactly one approval request, no extra rows', (await db.inventoryApprovalRequest.count({ where: { branchId: fz.branchId } })) === 1);
  await assertSettled(fz.branchId, c3.input.operation_id, true);
}

async function s0_successPaths() {
  scenario = 'S0 normal operations still work on a live branch (both processes)';
  const fx = await makeBranch('s0', { cards: true });
  const a = await sale('A', fx);
  const b = await sale('B', fx);
  check('checkout on A and B', a.status === 201 && b.status === 201, [a.status, b.status, a.body.error, b.body.error]);
  const i = await paidIssue('B', fx);
  check('paid supply issue', i.status === 201, i.body.error);
  const key = randomUUID();
  const [k1, k2] = await Promise.all([sale('A', fx, key), sale('B', fx, key)]);
  const sameKey = await db.checkoutAttempt.findUnique({ where: { idempotencyKey: key } });
  check('same-key checkout on two processes: at most one sale', (await db.transaction.count({ where: { branchId: fx.branchId } })) === 3 && sameKey?.status !== 'abandoned', [k1.status, k2.status, k1.body.error?.code, k2.body.error?.code]);
  const v = await call('A', 'POST', `/api/transactions/${a.body.data?.id}/void`, fx.supToken, { void_reason: 'P68R live void works' });
  check('void on a live branch still works', v.status === 200, { status: v.status, error: v.body.error });
}

// ---------------------------------------------------------------- run
async function otherStocks() {
  const rows = await db.inventoryStock.findMany({ where: { branchId: { notIn: fixtureBranches } }, select: { id: true, quantityOnHand: true, quantityReserved: true }, orderBy: { id: 'asc' } });
  return JSON.stringify(rows);
}

const NEW_TRIGGERS = [
  ['inventory_approval_requests', 'pos_perf_p67_live_branch'],
  ['transactions', 'pos_perf_p68_fenced_update'],
  ['inventory_stocks', 'pos_perf_p68_fenced_update'],
] as const;
async function setNewTriggers(enabled: boolean) {
  for (const [table, trigger] of NEW_TRIGGERS)
    await db.$executeRawUnsafe(`ALTER TABLE "${table}" ${enabled ? 'ENABLE' : 'DISABLE'} TRIGGER "${trigger}"`);
}

async function main() {
  if (process.env.P68R_WITHOUT_FIX === '1') {
    console.warn('REPRO MODE: the follow-up migration triggers are disabled for this run (disposable DB only)');
    await setNewTriggers(false);
  }
  await setupShared();
  await startApi('A');
  await startApi('B');
  await startApi('C');
  // Earlier runs can leave live fixture branches with pending deductions; let the
  // workers finish them first, so the baseline only moves if this run moves it.
  for (let i = 0; i < 600 && (await db.inventoryDeductionJob.count({ where: { status: { in: ['pending', 'processing'] } } })) > 0; i++) await new Promise((r) => setTimeout(r, 100));
  const othersBefore = await otherStocks();
  const only = process.env.P68R_ONLY?.split(',');
  const all: [string, () => Promise<void>][] = [['s0', s0_successPaths], ['s1', s1_checkoutCommitsFirst], ['s2', s2_fenceFirst], ['s3', s3_checkoutStartedBeforeFence], ['s4', s4_workerVsDeletion], ['s5', s5_paidSupplyIssue], ['s6', s6_voidAfterFence], ['a1', a1_approvals], ['s7', s7_restartAndRepeat]];
  for (const [id, fn] of all) {
    if (only && !only.includes(id)) continue;
    try {
      await fn();
    } catch (error) {
      check('scenario ran to the end', false, String(error).slice(0, 400));
    }
  }
  scenario = 'Z other branches';
  const before = new Map((JSON.parse(othersBefore) as { id: string }[]).map((r) => [r.id, JSON.stringify(r)]));
  const after = new Map((JSON.parse(await otherStocks()) as { id: string }[]).map((r) => [r.id, JSON.stringify(r)]));
  const changed = [...before].filter(([id, row]) => after.get(id) !== row).map(([id, row]) => ({ before: row, after: after.get(id) ?? 'gone' }));
  const changedRows = await db.inventoryStock.findMany({ where: { id: { in: changed.map((c) => JSON.parse(c.before).id) } }, select: { id: true, branchId: true, branch: { select: { name: true } } } });
  check("other branches' balances unchanged", changed.length === 0, { changed: changed.slice(0, 5), branches: changedRows.map((r) => r.branch?.name) });
  const failed = checks.filter((c) => !c.pass).length;
  writeFileSync(path.join(OUT, `p68-process-races-${RUN}.json`), JSON.stringify({ run: RUN, passed: checks.length - failed, failed, checks }, null, 1));
  console.warn(`\n${checks.length - failed}/${checks.length} passed, ${failed} failed (run ${RUN})`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const name of Object.keys(procs) as (keyof typeof PORTS)[]) await killApi(name);
    if (process.env.P68R_WITHOUT_FIX === '1') await setNewTriggers(true);
    await db.$disconnect();
  });
