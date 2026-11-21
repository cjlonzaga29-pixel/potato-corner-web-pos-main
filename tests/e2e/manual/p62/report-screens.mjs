// POS-PERF-P62 — report totals read off the actual Admin, Supervisor and Branch
// screens for one branch and date range, reconciled with the API and with the
// database. LOCAL stack only (stack.sh; db.mjs refuses anything but a p62_* DB).
//
//   . $P62_ROOT/env.sh && node tests/e2e/manual/p62/report-screens.mjs
//
// Each role uses only what its own screens offer: Admin picks the branch in the
// report filter, the Supervisor in the sidebar branch selector, and the Branch
// account is bound to its branch. No role is given access it doesn't have.
// Every figure is compared against the database computed independently here,
// with the definitions the screens state (reports.repository.ts):
//   completed: count, sum(subtotal) = gross, sum(discount), sum(total) = sales after discounts
//   refunded: count, sum(total) · voided: count, sum(total)
//   Admin "Net Sales" = gross − discounts − refunds · expenses: sum(amount), not deleted
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { WEB, OUT, ROOT, ACCOUNTS, openProfile, login, check, record, saveResults, shot, sleep } from './lib.mjs';
import { prisma } from './db.mjs';

const DAYS = Number(process.env.P62_REPORT_DAYS || 7);
const manila = (d) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
const TO = manila(new Date());
const FROM = manila(new Date(Date.now() - (DAYS - 1) * 86_400_000));
const BRANCH_CODE = 'MAIN01';
const PACE_MS = Number(process.env.P62_PACE_MS || 4000);

const money = (s) => (s == null ? null : Number(String(s).replace(/[^0-9.-]/g, '')));
const round2 = (n) => Math.round(n * 100) / 100;

/** title -> displayed value, for every KPI card currently on screen. */
async function readKpis(page) {
  await page.waitForFunction(() => !document.querySelector('.app-kpi-card .animate-pulse, .app-kpi-card [data-slot="skeleton"]'), null, { timeout: 30_000 }).catch(() => {});
  await sleep(800);
  return page.evaluate(() => {
    const out = {};
    for (const card of document.querySelectorAll('.app-kpi-card')) {
      const title = card.querySelector('.app-kpi-label')?.textContent?.trim();
      const lines = card.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
      if (title) out[title] = lines.find((l, i) => i > 0 && /[0-9]/.test(l) && l !== title) ?? lines[1] ?? null;
    }
    return out;
  });
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  await sleep(1200);
}

// ---------- database, independently ----------
const branch = await prisma.branch.findFirstOrThrow({ where: { code: BRANCH_CODE } });
const gte = new Date(`${FROM}T00:00:00.000+08:00`);
const lte = new Date(`${TO}T23:59:59.999+08:00`);
const tx = await prisma.transaction.groupBy({ by: ['status'], where: { branchId: branch.id, createdAt: { gte, lte } }, _count: { _all: true }, _sum: { subtotal: true, discountAmount: true, totalAmount: true } });
const st = (s) => tx.find((r) => r.status === s);
const n = (v) => (v == null ? 0 : Number(v));
const exp = await prisma.expense.aggregate({ where: { branchId: branch.id, deletedAt: null, incurredAt: { gte, lte } }, _sum: { amount: true }, _count: { _all: true } });
const db = {
  completedCount: st('completed')?._count._all ?? 0,
  gross: round2(n(st('completed')?._sum.subtotal)),
  discounts: round2(n(st('completed')?._sum.discountAmount)),
  completedTotal: round2(n(st('completed')?._sum.totalAmount)),
  voidedCount: st('voided')?._count._all ?? 0,
  voidedTotal: round2(n(st('voided')?._sum.totalAmount)),
  refundedCount: st('refunded')?._count._all ?? 0,
  refundedTotal: round2(n(st('refunded')?._sum.totalAmount)),
  expenses: round2(n(exp._sum.amount)),
  expenseCount: exp._count._all,
};
db.netSales = round2(db.gross - db.discounts - db.refundedTotal);
const TODAY = TO;
const WINDOW_FROM = manila(new Date(Date.now() - 7 * 86_400_000));
const dayStart = new Date(`${TODAY}T00:00:00.000+08:00`);
const winStart = new Date(`${WINDOW_FROM}T00:00:00.000+08:00`);
const today = await prisma.transaction.aggregate({ where: { branchId: branch.id, status: 'completed', createdAt: { gte: dayStart, lte } }, _count: { _all: true }, _sum: { subtotal: true } });
const todayExp = await prisma.expense.aggregate({ where: { branchId: branch.id, deletedAt: null, incurredAt: { gte: dayStart, lte } }, _sum: { amount: true } });
const win = await prisma.transaction.aggregate({ where: { branchId: branch.id, status: 'completed', createdAt: { gte: winStart, lte } }, _sum: { subtotal: true } });
db.todayCompleted = today._count._all;
db.todayGross = round2(n(today._sum.subtotal));
db.todayExpenses = round2(n(todayExp._sum.amount));
db.windowFrom = WINDOW_FROM;
db.windowGross = round2(n(win._sum.subtotal));
record('db: authoritative figures', true, { branch: BRANCH_CODE, from: FROM, to: TO, ...db });

// ---------- API, as each role ----------
async function apiSession(role) {
  const device = randomUUID();
  const res = await fetch(`${WEB}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ACCOUNTS[role].email, password: ACCOUNTS[role].password, device_id: device }) });
  const body = await res.json();
  return { token: body.data.access_token, device };
}
const q = `branch_id=${branch.id}&date_from=${FROM}&date_to=${TO}`;
const api = {};
for (const role of ['admin', 'supervisor', 'branch']) {
  const s = await apiSession(role);
  const get = async (p) => (await (await fetch(`${WEB}${p}`, { headers: { authorization: `Bearer ${s.token}`, 'x-device-id': s.device } })).json()).data;
  const period = await get(`/api/reports/period-summary?${q}`);
  const daily = await get(`/api/reports/daily-sales?${q}&page=1&limit=100`);
  const rows = daily?.data ?? [];
  const sum = (k) => round2(rows.reduce((a, r) => a + r[k], 0));
  api[role] = {
    completedCount: period?.sales.completed_count,
    completedTotal: round2(period?.sales.completed_total_amount ?? NaN),
    discounts: round2(period?.sales.completed_discount_amount ?? NaN),
    voidedCount: period?.sales.voided_count,
    refundedCount: period?.sales.refunded_count,
    voidedTotal: round2(period?.sales.voided_total_amount ?? NaN),
    refundedTotal: round2(period?.sales.refunded_total_amount ?? NaN),
    dsrGross: sum('gross_sales'),
    dsrNet: sum('net_sales'),
    dsrExpenses: sum('expense_total'),
  };
  await sleep(PACE_MS);
}
record('api: figures per role', true, api);

// ---------- screens ----------
const screens = {};

// Admin: report filter branch + dates.
{
  fs.rmSync(`${ROOT}/prof-reports-admin`, { recursive: true, force: true });
  const ctx = await openProfile('reports-admin');
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await login(page, 'admin');
  await page.goto(`${WEB}/admin/reports`);
  await settle(page);
  await page.locator('#report-filter-branch').click();
  await page.getByRole('option', { name: new RegExp(branch.name) }).click();
  await page.locator('#report-filter-from').fill(FROM);
  await page.locator('#report-filter-to').fill(TO);
  await settle(page);
  const fin = await readKpis(page);
  await shot(page, 'reports-admin-financial');
  await page.getByRole('tab', { name: 'Daily Sales Report (DSR)' }).click();
  await settle(page);
  const dsr = await readKpis(page);
  await page.getByRole('tab', { name: 'Expenses' }).click();
  await settle(page);
  const expenses = await readKpis(page);
  await page.getByRole('button', { name: 'Compliance' }).click();
  await page.getByRole('tab', { name: 'Void / Refund' }).click();
  await settle(page);
  const voids = await readKpis(page);
  screens.admin = { fin, dsr, expenses, voids };
  await ctx.close();
}

/** The dashboard's KPI cards plus the "Gross Sales — Last 7 Days" figure (not a KPI card). */
async function readDashboard(page) {
  const kpis = await readKpis(page);
  const text = await page.locator('main').innerText();
  const m = text.match(/Gross Sales — Last 7 Days\s+(₱[0-9,.]+)/);
  return { ...kpis, 'Gross Sales — Last 7 Days': m ? m[1] : null };
}

// Supervisor: Reports (same filters as Admin) and Dashboard, branch from the sidebar selector.
{
  await sleep(PACE_MS);
  fs.rmSync(`${ROOT}/prof-reports-supervisor`, { recursive: true, force: true });
  const ctx = await openProfile('reports-supervisor');
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await login(page, 'supervisor');
  await settle(page);
  const trigger = page.locator('aside').getByRole('button', { name: /Branch|P62|MAIN/ }).first();
  if (!((await trigger.textContent().catch(() => '')) ?? '').includes(branch.name)) {
    await trigger.click();
    await page.getByRole('menuitem', { name: new RegExp(branch.name) }).click();
    await settle(page);
  }
  const selected = await trigger.textContent().catch(() => '');
  const dashboard = await readDashboard(page);
  await shot(page, 'reports-supervisor-dashboard');
  await page.goto(`${WEB}/supervisor/reports`);
  await settle(page);
  await page.locator('#reports-from').fill(FROM);
  await page.locator('#reports-to').fill(TO);
  const refresh = page.getByRole('button', { name: /^Refresh/ });
  if (await refresh.isEnabled()) await refresh.click();
  await settle(page);
  const sales = await readKpis(page);
  await shot(page, 'reports-supervisor-sales');
  await page.getByRole('tab', { name: 'Void/Refund' }).click();
  await settle(page);
  const voids = await readKpis(page);
  screens.supervisor = { selectedBranch: selected?.trim(), dashboard, sales, voids };
  await ctx.close();
}

// Branch account: no Reports screen (middleware: staff only); its totals are on its Dashboard.
{
  await sleep(PACE_MS);
  fs.rmSync(`${ROOT}/prof-reports-branch`, { recursive: true, force: true });
  const ctx = await openProfile('reports-branch');
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await login(page, 'branch');
  await settle(page);
  const dashboard = await readDashboard(page);
  await shot(page, 'reports-branch-dashboard');
  await page.goto(`${WEB}/branch/reports`);
  await settle(page);
  screens.branch = { dashboard, reportsUrl: new URL(page.url()).pathname };
  await ctx.close();
}
record('screens: values as displayed', true, screens);

// ---------- reconcile ----------
const eq = (a, b) => a !== null && b !== null && Math.abs(a - b) < 0.005;
const cmp = (label, shown, expected) => check(`reconcile: ${label}`, eq(shown, expected), { shown, expected });

cmp('Admin Financial Summary · Gross Sales = DB gross', money(screens.admin.fin['Gross Sales']), db.gross);
cmp('Admin Financial Summary · Discounts = DB discounts', money(screens.admin.fin['Discounts']), db.discounts);
cmp('Admin Financial Summary · Refunds = DB refunded total', money(screens.admin.fin['Refunds']), db.refundedTotal);
cmp('Admin Financial Summary · Net Sales = DB gross − discounts − refunds', money(screens.admin.fin['Net Sales']), db.netSales);
cmp('Admin Financial Summary · Operating Expenses = DB expenses', money(screens.admin.fin['Operating Expenses']), db.expenses);
cmp('Admin DSR · Completed = DB completed count', money(screens.admin.dsr['Completed']), db.completedCount);
cmp('Admin DSR · Voided = DB voided count', money(screens.admin.dsr['Voided']), db.voidedCount);
cmp('Admin DSR · Refunded = DB refunded count', money(screens.admin.dsr['Refunded']), db.refundedCount);
cmp('Admin Expenses · Total Amount = DB expenses', money(screens.admin.expenses['Total Amount']), db.expenses);
cmp('Admin Void/Refund · Voided = DB voided count', money(screens.admin.voids['Voided']), db.voidedCount);
cmp('Admin Void/Refund · Refunded = DB refunded count', money(screens.admin.voids['Refunded']), db.refundedCount);
{
  const s = screens.supervisor;
  check('screens: the Supervisor selected the same branch in its own selector', s.selectedBranch?.includes(branch.name), { selected: s.selectedBranch });
  cmp('Supervisor Reports · Total Transactions = DB completed count', money(s.sales['Total Transactions']), db.completedCount);
  cmp('Supervisor Reports · Total Sales — Selected Period = DB completed totals', money(s.sales['Total Sales — Selected Period']), db.completedTotal);
  cmp('Supervisor Reports · Discounts Given = DB discounts', money(s.sales['Discounts Given']), db.discounts);
  cmp('Supervisor Reports · Total Voided = DB voided count', money(s.voids['Total Voided']), db.voidedCount);
  cmp('Supervisor Reports · Total Refunded = DB refunded count', money(s.voids['Total Refunded']), db.refundedCount);
  cmp('Supervisor Reports · Voided Amount = DB voided total', money(s.voids['Voided Amount']), db.voidedTotal);
  cmp('Supervisor Reports · Refunded Amount = DB refunded total', money(s.voids['Refunded Amount']), db.refundedTotal);
}
check('screens: the Branch account has no Reports screen (sent to its dashboard)', screens.branch.reportsUrl !== '/branch/reports', { url: screens.branch.reportsUrl });
for (const role of ['supervisor', 'branch']) {
  const d = screens[role].dashboard;
  const R = role[0].toUpperCase() + role.slice(1);
  cmp(`${R} Dashboard · Gross Sales Today = DB today gross`, money(d['Gross Sales Today']), db.todayGross);
  cmp(`${R} Dashboard · Today's Transactions = DB today completed`, money(d["Today's Transactions"]), db.todayCompleted);
  cmp(`${R} Dashboard · Today's Expenses = DB today expenses`, money(d["Today's Expenses"]), db.todayExpenses);
  cmp(`${R} Dashboard · Gross Sales — Last 7 Days = DB gross ${db.windowFrom}..${TO}`, money(d['Gross Sales — Last 7 Days']), db.windowGross);
}
for (const role of ['admin', 'supervisor', 'branch']) {
  const a = api[role];
  check(`reconcile: API as ${role} = DB`, eq(a.completedCount, db.completedCount) && eq(a.completedTotal, db.completedTotal) && eq(a.discounts, db.discounts) && eq(a.voidedCount, db.voidedCount) && eq(a.refundedCount, db.refundedCount) && eq(a.dsrGross, db.gross) && eq(a.dsrNet, db.netSales) && eq(a.dsrExpenses, db.expenses), a);
}

fs.writeFileSync(`${OUT}/report-screens.json`, JSON.stringify({ branch: BRANCH_CODE, from: FROM, to: TO, db, api, screens }, null, 2));
await prisma.$disconnect();
process.exit(saveResults('report-screens-checks') ? 1 : 0);
