// Product permanent delete — rollout rehearsal with the PREVIOUS API version. LOCAL ONLY.
//
// Real built API processes against ONE disposable embedded Postgres that has
// every migration of this release applied:
//   OLD = the API deployed before this release (built from a separate worktree,
//         e.g. `git worktree add C:/p72/old 58c335eb`, then shared + api build),
//   NEW = this branch's build (`dist/server.js`), with the rollout switch off,
//         and in phase C a second NEW process with it on.
// Races are ordered by database barriers (a row lock held here, then
// pg_stat_activity until the API statement is really waiting on it), never by
// sleeps. Every call is a normal route with a normal signed token. Raw SQL here
// is test coordination only (locks, lookups), never an application write.
//
// Usage (from apps/api, throwaway env such as C:/p69/env.sh sourced):
//   npx tsx scripts/product-delete-mixed-version.ts <old apps/api dir> <out dir>
import EmbeddedPostgres from 'embedded-postgres';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OLD_DIR = process.argv[2] ?? 'C:/p72/old/apps/api';
const OUT = process.argv[3] ?? 'C:/p72/mix';
const NEW_DIR = path.resolve(import.meta.dirname, '..');
if (!existsSync(path.join(OLD_DIR, 'dist/server.js'))) throw new Error(`old API not built: ${OLD_DIR}/dist/server.js`);
if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('Refusing: PRODUCTION_DATABASE_URL_DIRECT is set');
mkdirSync(OUT, { recursive: true });
// A request still in flight when a failed scenario stops the APIs must not hide that scenario's error.
process.on('unhandledRejection', (error) => console.error('unhandled rejection (after a stop):', String(error)));

const PG_PORT = 56751;
const DB_NAME = 'p62_pdelmix';
const DB = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
const PORTS = { OLD: 56752, NEW: 56753, NEWON: 56754 } as const;
type Api = keyof typeof PORTS;
const pg = new EmbeddedPostgres({ databaseDir: path.join(OUT, `pg-${Date.now().toString(36)}`), user: 'postgres', password: 'postgres', port: PG_PORT, persistent: false });

process.env.DATABASE_URL = DB;
process.env.DIRECT_URL = DB;
const { PrismaClient, Prisma } = await import('@prisma/client');
const { generateTestToken } = await import('../src/test-utils/auth-tokens.js');
let db!: InstanceType<typeof PrismaClient>;

// ---------------------------------------------------------------- results
type Check = { scenario: string; name: string; pass: boolean; detail?: unknown };
const checks: Check[] = [];
const notes: { scenario: string; note: string; detail?: unknown }[] = [];
let scenario = '';
function check(name: string, pass: boolean, detail?: unknown) {
  checks.push({ scenario, name, pass, detail });
  console.warn(`${pass ? 'PASS' : 'FAIL'} [${scenario}] ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
}
function note(text: string, detail?: unknown) {
  notes.push({ scenario, note: text, detail });
  console.warn(`NOTE [${scenario}] ${text}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
}

// ---------------------------------------------------------------- processes
const procs: Partial<Record<Api, ChildProcess>> = {};
async function startApi(name: Api) {
  const log = createWriteStream(path.join(OUT, `api-${name}.log`), { flags: 'a' });
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: name === 'OLD' ? OLD_DIR : NEW_DIR,
    env: { ...process.env, DATABASE_URL: DB, DIRECT_URL: DB, API_PORT: String(PORTS[name]), NODE_ENV: 'production', PRODUCT_PERMANENT_DELETE_ENABLED: name === 'NEWON' ? 'true' : 'false' },
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
async function killApi(name: Api) {
  const child = procs[name];
  if (!child) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await exited;
  delete procs[name];
}

type Body = { data?: Record<string, unknown> | null; error?: { code?: string; message?: string; details?: unknown } | null };
type Res = { status: number; body: Body };
async function call(api: Api, method: string, url: string, token: string, body?: unknown): Promise<Res> {
  const res = await fetch(`http://127.0.0.1:${PORTS[api]}${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-device-id': 'pdel-mix' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Body = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: { message: text.slice(0, 200) } };
  }
  return { status: res.status, body: parsed };
}
const brief = (r: Res) => ({ status: r.status, code: r.body.error?.code ?? null });

// ---------------------------------------------------------------- barriers
type Barrier = { pid: number; release: () => Promise<void> };
async function hold(lockSql: ReturnType<typeof Prisma.sql>): Promise<Barrier> {
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
async function waitBlocked(pattern: string, blocker?: number): Promise<void> {
  for (let i = 0; i < 600; i++) {
    const rows = await db.$queryRaw<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE ${pattern}
        AND (${blocker ?? null}::int IS NULL OR ${blocker ?? null}::int = ANY(pg_blocking_pids(pid)))`;
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 50)); // polling interval for an observed lock wait
  }
  throw new Error(`timed out waiting for a blocked statement like ${pattern}`);
}
/** Resolves once a sale's line INSERT is waiting on a lock; fails fast if the sale answered first. */
async function lineWaits(saleP: Promise<Res>): Promise<void> {
  const early = saleP.then((r) => {
    throw new Error(`sale answered before waiting: ${JSON.stringify(brief(r))} ${r.body.error?.message ?? ''}`);
  });
  early.catch(() => {});
  await Promise.race([waitBlocked('%INSERT INTO "public"."transaction_items"%'), early]);
}
async function waitJobsSettled(transactionIds: string[]) {
  for (let i = 0; i < 600; i++) {
    const open = await db.inventoryDeductionJob.count({ where: { transactionId: { in: transactionIds }, status: { in: ['pending', 'processing'] } } });
    if (open === 0) return;
    await new Promise((r) => setTimeout(r, 100)); // polling the worker's own progress
  }
  throw new Error('deduction jobs did not settle');
}

// ---------------------------------------------------------------- fixtures
const RUN = Date.now().toString(36);
const fx = { branch: '', shift: '', staff: '', sup: '', item: '', unit: '' };
const tok = { staff: '', sup: '' };
type P = { id: string; variant: string };
async function makeProduct(label: string, opts: { component?: boolean } = {}): Promise<P> {
  const product = await db.product.create({ data: { name: `MIX ${label} ${RUN}`, status: 'active', everPublished: true, createdBy: fx.sup } });
  const variant = await db.productVariant.create({ data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 50, isActive: true, lifecycleStatus: 'ACTIVE' } });
  if (opts.component !== false) await db.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: fx.item, quantityRequired: 3 } });
  await db.branchProductAvailability.create({ data: { branchId: fx.branch, productId: product.id, isAvailable: true } });
  return { id: product.id, variant: variant.id };
}
async function setup() {
  fx.branch = (await db.branch.create({ data: { name: `MIX Branch ${RUN}`, code: `MIX-${RUN}`.toUpperCase().slice(0, 20), address: '1 Mix St', city: 'Testville', status: 'active' } })).id;
  const mk = async (role: 'staff' | 'supervisor', first: string) =>
    (await db.user.create({ data: { role, firstName: first, lastName: `Mix${RUN}`, email: role === 'staff' ? null : `${first.toLowerCase()}-${RUN}@mix.test`, employeeId: role === 'staff' ? `MIX-${RUN}` : null, employmentType: 'regular', mustChangePassword: false } })).id;
  fx.staff = await mk('staff', 'Cash');
  fx.sup = await mk('supervisor', 'Sup');
  await db.userBranchAssignment.createMany({ data: [fx.staff, fx.sup].map((userId) => ({ userId, branchId: fx.branch })) });
  await db.attendanceRecord.create({ data: { employeeId: fx.staff, branchId: fx.branch, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });
  fx.shift = (await db.shift.create({ data: { branchId: fx.branch, cashierId: fx.staff, openedBy: fx.staff, status: 'active', openingCashAmount: 1000, startedAt: new Date() } })).id;
  fx.unit = (await db.unitOfMeasure.create({ data: { code: `mix-g-${RUN}`, name: 'Mix Gram', dimension: 'WEIGHT', isBaseUnit: true } })).id;
  fx.item = (await db.inventoryItem.create({ data: { name: `MIX potato ${RUN}`, baseUnitId: fx.unit, trackInventory: true } })).id;
  await db.inventoryStock.create({ data: { branchId: fx.branch, inventoryItemId: fx.item, quantityOnHand: 1_000_000 } });
  tok.staff = generateTestToken('staff', { userId: fx.staff, branchIds: [fx.branch] });
  tok.sup = generateTestToken('supervisor', { userId: fx.sup, branchIds: [fx.branch], email: `sup-${RUN}@mix.test` });
}

const MANUAL = { tax_basis: { calculation_mode: 'manual_total_v1', vat_rate: null, discount_rate: null }, discount_flow: 'manual_v1', discount_choice: 'none_applicable' };
type Line = P & { flavorId?: string };
const item = (p: Line, quantity = 1) => ({ product_id: p.id, product_variant_id: p.variant, quantity, ...(p.flavorId ? { flavor_id: p.flavorId } : {}) });
const sale = (api: Api, p: Line, key: string = randomUUID()) =>
  call(api, 'POST', '/api/transactions', tok.staff, { branch_id: fx.branch, items: [item(p)], payment_method: 'cash', cash_tendered: 1000, is_offline_transaction: false, idempotency_key: key, ...MANUAL });
const offline = (api: Api, p: P, number: string) =>
  call(api, 'POST', '/api/transactions/sync-offline', tok.staff, {
    branch_id: fx.branch,
    transactions: [{ offline_provisional_number: number, items: [item(p)], payment_method: 'cash', cash_tendered: 100, client_created_at: Date.now(), ...MANUAL }],
  });
const saleId = (r: Res) => String((r.body.data as { id?: string; transaction?: { id?: string } } | null)?.id ?? (r.body.data as { transaction?: { id?: string } } | null)?.transaction?.id ?? '');
const stockRow = () => Prisma.sql`SELECT 1 FROM inventory_stocks WHERE branch_id = ${fx.branch} AND inventory_item_id = ${fx.item} FOR UPDATE`;
/** The stock-row barrier must stop the sale, not a deduction worker still finishing an earlier sale. */
async function stockBarrier(): Promise<Barrier> {
  const ids = (await db.transaction.findMany({ where: { branchId: fx.branch }, select: { id: true } })).map((t) => t.id);
  await waitJobsSettled(ids);
  return hold(stockRow());
}
const historyPrint = async (productId: string) => {
  const [row] = await db.$queryRaw<{ h: string | null; n: bigint }[]>`
    SELECT count(*) AS n, md5(string_agg(ROW(ti.*)::text || ROW(t.*)::text, '|' ORDER BY ti.id)) AS h
    FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id WHERE ti.product_id = ${productId}`;
  return `${row?.n}:${row?.h}`;
};

// ---------------------------------------------------------------- phase A: old API alone on the migrated DB
async function phaseA(p: Record<string, P>) {
  scenario = 'A old API on migrated DB, before any permanent delete';
  const key = randomUUID();
  const s1 = await sale('OLD', p.sold, key);
  check('checkout 201', s1.status === 201, brief(s1));
  const replay = await sale('OLD', p.sold, key);
  check('completed-sale replay returns the original sale', replay.status < 300 && saleId(replay) === saleId(s1), { ...brief(replay), same: saleId(replay) === saleId(s1) });
  const s2 = await sale('OLD', p.sold);
  check('second checkout 201', s2.status === 201, brief(s2));

  const hold = await call('OLD', 'POST', '/api/transactions/hold', tok.staff, { branch_id: fx.branch, shift_id: fx.shift, items: [item(p.held)] });
  check('hold 201', hold.status === 201, brief(hold));
  const holdId = String(hold.body.data?.id ?? '');

  const edit = await call('OLD', 'PATCH', `/api/products/${p.sold.id}`, tok.sup, { name: `MIX Sold renamed ${RUN}` });
  check('product edit 200', edit.status === 200, brief(edit));
  const size = await call('OLD', 'POST', `/api/products/${p.sold.id}/variants`, tok.sup, { name: 'Large', size_label: 'Large', base_price: 70, is_active: true });
  check('size add 201', size.status === 201, brief(size));
  const sizeId = String(size.body.data?.id ?? '');
  const sizeEdit = await call('OLD', 'PATCH', `/api/products/${p.sold.id}/variants/${sizeId}`, tok.sup, { base_price: 75 });
  check('size edit 200', sizeEdit.status === 200, brief(sizeEdit));
  const logs = await db.productChangeLog.count({ where: { productVariantId: sizeId } });
  const sizeDelete = await call('OLD', 'DELETE', `/api/products/${p.sold.id}/variants/${sizeId}`, tok.sup);
  check(
    `unsold size delete behaves as before the migration (${logs} change log(s): ${logs > 0 ? '409' : '204'})`,
    logs > 0 ? sizeDelete.status === 409 && sizeDelete.body.error?.code === 'VARIANT_HAS_DEPENDENCIES' : sizeDelete.status === 204,
    brief(sizeDelete),
  );

  await waitJobsSettled([saleId(s1), saleId(s2)]);
  const jobs = await db.inventoryDeductionJob.findMany({ where: { transactionId: { in: [saleId(s1), saleId(s2)] } }, select: { status: true } });
  check('old worker completed both deductions', jobs.length === 2 && jobs.every((j) => j.status === 'completed'), jobs);
  const refund = await call('OLD', 'POST', `/api/transactions/${saleId(s2)}/refund`, tok.sup, { refund_reason: 'Rehearsal refund on old API' });
  check('refund 200', refund.status === 200, brief(refund));
  const off = await offline('OLD', p.sold, `PC-MIX-${RUN}-OFFLINE-1`);
  const offResult = (off.body.data?.results as { status?: string }[] | undefined)?.[0];
  check('offline sync records the sale', off.status === 200 && offResult?.status !== 'failed' && (await db.transaction.count({ where: { offlineProvisionalNumber: `PC-MIX-${RUN}-OFFLINE-1` } })) === 1, { ...brief(off), result: offResult });

  // The old API's plain DELETE must not be able to permanently remove anything with history.
  const before = await historyPrint(p.sold.id);
  const del = await call('OLD', 'DELETE', `/api/products/${p.sold.id}`, tok.sup);
  check('old plain DELETE of a sold product refused as before (409 PRODUCT_HAS_DEPENDENCIES)', del.status === 409 && del.body.error?.code === 'PRODUCT_HAS_DEPENDENCIES', brief(del));
  check('sold product, sizes and history unchanged', (await db.product.findUnique({ where: { id: p.sold.id } })) !== null && (await db.productVariant.count({ where: { id: p.sold.variant } })) === 1 && (await historyPrint(p.sold.id)) === before);
  const delHeld = await call('OLD', 'DELETE', `/api/products/${p.held.id}`, tok.sup);
  check('old plain DELETE of a product in a held order refused (409)', delHeld.status === 409, brief(delHeld));
  check('held order intact', (await db.holdOrderItem.count({ where: { holdOrderId: holdId, productId: p.held.id } })) === 1);
  const delSoldSize = await call('OLD', 'DELETE', `/api/products/${p.sold.id}/variants/${p.sold.variant}`, tok.sup);
  check('old size delete of a sold size refused (409 VARIANT_HAS_DEPENDENCIES)', delSoldSize.status === 409 && delSoldSize.body.error?.code === 'VARIANT_HAS_DEPENDENCIES', brief(delSoldSize));
  const delClean = await call('OLD', 'DELETE', `/api/products/${p.clean.id}`, tok.sup);
  check('old plain DELETE of a product with no history still works (204)', delClean.status === 204, brief(delClean));
  const release = await call('OLD', 'POST', `/api/transactions/hold/${holdId}/release`, tok.staff, {});
  check('hold release', release.status < 300, brief(release));
  return { completedKey: key, completedId: saleId(s1) };
}

// ---------------------------------------------------------------- phase B: old + new concurrently, switch off
async function phaseB(p: Record<string, P>) {
  scenario = 'B old + new concurrently, permanent delete switched off';
  const preview = await call('NEW', 'GET', `/api/products/${p.sold.id}/deletion-preview`, tok.sup);
  check('new preview: can_delete false while switched off', preview.status === 200 && preview.body.data?.can_delete === false, { ...brief(preview), reason: preview.body.data?.forbidden_reason });
  const del = await call('NEW', 'DELETE', `/api/products/${p.sold.id}`, tok.sup, { confirm: 'PERMANENTLY_DELETE' });
  check('new DELETE refused while switched off (409 PRODUCT_PERMANENT_DELETE_DISABLED)', del.status === 409 && del.body.error?.code === 'PRODUCT_PERMANENT_DELETE_DISABLED', brief(del));
  const s = await sale('NEW', p.sold);
  check('new checkout 201 alongside old', s.status === 201, brief(s));

  scenario = 'B1 race: new checkout in flight, old size delete arrives';
  {
    const barrier = await stockBarrier();
    const key = randomUUID();
    const saleP = sale('NEW', p.race1, key);
    await waitBlocked('%inventory_stocks%', barrier.pid); // the sale line INSERT (FOR KEY SHARE on the size) is done
    const delP = call('OLD', 'DELETE', `/api/products/${p.race1.id}/variants/${p.race1.variant}`, tok.sup);
    await waitBlocked('%product_variants%'); // the size DELETE waits for the in-flight sale
    await barrier.release();
    const [sr, dr] = await Promise.all([saleP, delP]);
    check('sale committed (201)', sr.status === 201, brief(sr));
    check('old size delete then sees the sale and refuses (409)', dr.status === 409 && dr.body.error?.code === 'VARIANT_HAS_DEPENDENCIES', brief(dr));
    check('size still exists', (await db.productVariant.count({ where: { id: p.race1.variant } })) === 1);
  }

  scenario = 'B2 race: old checkout in flight, new size delete arrives';
  {
    const barrier = await stockBarrier();
    const saleP = sale('OLD', p.race2);
    await waitBlocked('%inventory_stocks%', barrier.pid);
    const delP = call('NEW', 'DELETE', `/api/products/${p.race2.id}/variants/${p.race2.variant}`, tok.sup);
    await waitBlocked('%product_variants%');
    await barrier.release();
    const [sr, dr] = await Promise.all([saleP, delP]);
    check('old sale committed (201)', sr.status === 201, brief(sr));
    check('new size delete then sees the sale and refuses (409)', dr.status === 409 && dr.body.error?.code === 'VARIANT_HAS_DEPENDENCIES', brief(dr));
  }

  scenario = 'B3 size delete first: cannot arise for a sellable size';
  {
    // A size sells only with a recipe (RECIPE_MISSING otherwise), and a size with
    // recipe components can't be deleted on its own (product_components RESTRICT,
    // unchanged). So "size delete commits, then a sale of it arrives" needs no
    // new handling; the delete-first order is exercised by C2 (whole product).
    const extra = await db.productVariant.create({ data: { productId: p.race3.id, name: 'Large', sizeLabel: 'Large', basePrice: 60, isActive: true, lifecycleStatus: 'ACTIVE' } });
    const noRecipe = await sale('OLD', { id: p.race3.id, variant: extra.id });
    check('a size without a recipe cannot be sold (422 RECIPE_MISSING)', noRecipe.status === 422 && noRecipe.body.error?.code === 'RECIPE_MISSING', brief(noRecipe));
    const newDelete = await call('NEW', 'DELETE', `/api/products/${p.race3.id}/variants/${p.race3.variant}`, tok.sup);
    check('NEW: an unsold size with a recipe is refused (409 VARIANT_HAS_DEPENDENCIES)', newDelete.status === 409 && newDelete.body.error?.code === 'VARIANT_HAS_DEPENDENCIES', brief(newDelete));
    // The old API answers this RESTRICT (23001) with a 500: pre-existing, fixed on this branch. Nothing is deleted either way.
    const oldDelete = await call('OLD', 'DELETE', `/api/products/${p.race3.id}/variants/${p.race3.variant}`, tok.sup);
    check('OLD: the same delete is refused (pre-existing 500 for a recipe RESTRICT) and the size stays', oldDelete.status >= 400 && (await db.productVariant.count({ where: { id: p.race3.variant } })) === 1, brief(oldDelete));
  }
}

// ---------------------------------------------------------------- phase C: what the switch protects against
async function phaseC(p: Record<string, P>, a: { completedKey: string; completedId: string }) {
  scenario = 'C1 race (switch on): old checkout in flight, permanent delete arrives';
  let soldDuringRace = '';
  {
    const barrier = await stockBarrier();
    const saleP = sale('OLD', p.del1);
    await waitBlocked('%inventory_stocks%', barrier.pid);
    const delP = call('NEWON', 'DELETE', `/api/products/${p.del1.id}`, tok.sup, { confirm: 'PERMANENTLY_DELETE' });
    await waitBlocked('%"products"%'); // the delete's FOR UPDATE waits for the sale's FOR KEY SHARE
    await barrier.release();
    const [sr, dr] = await Promise.all([saleP, delP]);
    soldDuringRace = saleId(sr);
    check('old sale committed first (201)', sr.status === 201, brief(sr));
    check('permanent delete then completes (200), the sale is history', dr.status === 200, brief(dr));
    await waitJobsSettled([soldDuringRace]);
    const job = await db.inventoryDeductionJob.findFirst({ where: { transactionId: soldDuringRace } });
    const moves = await db.inventoryStockMovement.count({ where: { referenceId: soldDuringRace } });
    check('its deduction completed from the snapshot', job?.status === 'completed' && moves > 0, { job: job?.status, moves });
  }

  scenario = 'C2 race (switch on): permanent delete holds the product, old checkout arrives';
  {
    const barrier = await hold(Prisma.sql`SELECT 1 FROM branch_product_availability WHERE product_id = ${p.del2.id} FOR UPDATE`);
    const delP = call('NEWON', 'DELETE', `/api/products/${p.del2.id}`, tok.sup, { confirm: 'PERMANENTLY_DELETE' });
    await waitBlocked('%branch_product_availability%', barrier.pid);
    const key = randomUUID();
    const saleP = sale('OLD', p.del2, key);
    await lineWaits(saleP);
    await barrier.release();
    const [dr, sr] = await Promise.all([delP, saleP]);
    check('permanent delete commits (200)', dr.status === 200, brief(dr));
    check('old checkout refused, nothing recorded', sr.status >= 400 && (await db.transaction.count({ where: { idempotencyKey: key } })) === 0, brief(sr));
    note('old API answer when the trigger refuses its line (new API answers 409 PRODUCT_DELETED)', brief(sr));
    const retry = await sale('OLD', p.del2, key);
    check('old retry of the same key: still nothing recorded', retry.status >= 400 && (await db.transaction.count({ where: { idempotencyKey: key } })) === 0, brief(retry));
    note('old API answer to that retry (its attempt was left in progress by the 500)', { ...brief(retry), attempt: (await db.checkoutAttempt.findUnique({ where: { idempotencyKey: key } }).catch(() => null))?.status ?? null });
  }

  scenario = 'C3 old API after the first permanent delete (rollback compatibility)';
  {
    // p.sold has the phase A sales (completed, refunded, offline). Delete it on the new API.
    const sales = await db.transaction.findMany({ where: { items: { some: { productId: p.sold.id } } }, select: { id: true, status: true } });
    const del = await call('NEWON', 'DELETE', `/api/products/${p.sold.id}`, tok.sup, { confirm: 'PERMANENTLY_DELETE' });
    check('sold product permanently deleted on the new API', del.status === 200, brief(del));
    const completed = sales.find((s) => s.status === 'completed' && s.id === a.completedId) ?? sales.find((s) => s.status === 'completed');
    for (const api of ['NEW', 'OLD'] as const) {
      const receipt = await call(api, 'GET', `/api/transactions/${completed?.id}`, tok.sup);
      const record = (name: string, pass: boolean, detail: Record<string, unknown>) => (api === 'NEW' ? check(name, pass, detail) : note(name, { pass, ...detail }));
      const items = (receipt.body.data as { items?: { product_name?: string }[] } | null)?.items ?? [];
      record(`${api} GET receipt of a sale of the deleted product`, receipt.status === 200 && items.length > 0, { ...brief(receipt), names: items.map((i) => i.product_name) });
      const list = await call(api, 'GET', `/api/transactions?branch_id=${fx.branch}`, tok.sup);
      record(`${api} list transactions`, list.status === 200, brief(list));
      const report = await call(api, 'GET', `/api/reports/product-performance?branch_id=${fx.branch}`, tok.sup);
      const rows = JSON.stringify(report.body.data ?? '');
      record(`${api} product performance report`, report.status === 200 && !rows.includes('Unknown Product'), { ...brief(report), shows_unknown_product: rows.includes('Unknown Product') });
      const replay = await sale(api, p.sold, a.completedKey);
      check(`${api} completed-sale replay still returns the original sale`, replay.status < 300 && saleId(replay) === a.completedId, brief(replay));
      const live = await sale(api, p.sold);
      check(`${api} new checkout of the deleted product refused, nothing recorded`, live.status >= 400, brief(live));
      note(`${api} checkout answer for the deleted product`, brief(live));
      const off = await offline(api, p.sold, `PC-MIX-${RUN}-OFFLINE-${api}`);
      const r = (off.body.data?.results as { status?: string; error?: { code?: string } }[] | undefined)?.[0];
      check(`${api} offline sync of the deleted product refused per item, nothing recorded`, off.status === 200 && r?.status !== 'success' && (await db.transaction.count({ where: { offlineProvisionalNumber: `PC-MIX-${RUN}-OFFLINE-${api}` } })) === 0, { ...brief(off), result: r });
      note(`${api} offline per-item code (new web keeps PRODUCT_DELETED for reconciliation; any other code is retried)`, r?.error?.code ?? r?.status);
    }
    const toRefund = sales.filter((s) => s.status === 'completed' && s.id !== a.completedId);
    const oldRefund = toRefund[0] ? await call('OLD', 'POST', `/api/transactions/${toRefund[0].id}/refund`, tok.sup, { refund_reason: 'Rollback rehearsal refund' }) : null;
    if (oldRefund) note('OLD refund of a sale of the deleted product', brief(oldRefund));
    const newRefund = await call('NEW', 'POST', `/api/transactions/${a.completedId}/refund`, tok.sup, { refund_reason: 'Rehearsal refund on new API' });
    check('NEW refund of a sale of the deleted product (200)', newRefund.status === 200, brief(newRefund));
    if (soldDuringRace) {
      const oldReceipt = await call('OLD', 'GET', `/api/transactions/${soldDuringRace}`, tok.sup);
      note('OLD GET receipt of the C1 sale', brief(oldReceipt));
    }
  }
}

// ---------------------------------------------------------------- main
async function main() {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  execSync('npx prisma migrate deploy', { cwd: NEW_DIR, stdio: 'inherit', env: { ...process.env, DATABASE_URL: DB, DIRECT_URL: DB } });
  db = new PrismaClient({ datasources: { db: { url: `${DB}?connection_limit=12` } }, log: [] });
  try {
    await setup();
    const p: Record<string, P> = {};
    for (const label of ['sold', 'held', 'clean', 'race1', 'race2', 'race3', 'del1', 'del2']) p[label] = await makeProduct(label, { component: label !== 'clean' });

    await startApi('OLD');
    const a = await phaseA(p);
    await startApi('NEW');
    await phaseB(p);
    await startApi('NEWON');
    await phaseC(p, a);
  } catch (error) {
    console.error(`SCENARIO ERROR in [${scenario}]:`, error);
    check('scenario ran to completion', false, String(error));
  } finally {
    for (const name of Object.keys(procs) as Api[]) await killApi(name);
    const failed = checks.filter((c) => !c.pass);
    writeFileSync(path.join(OUT, `results-${RUN}.json`), JSON.stringify({ run: RUN, checks, notes }, null, 2));
    console.warn(`\n${checks.length - failed.length}/${checks.length} checks passed; ${notes.length} notes`);
    await db?.$disconnect();
    await pg.stop().catch(() => undefined);
    if (failed.length > 0) process.exitCode = 1;
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
