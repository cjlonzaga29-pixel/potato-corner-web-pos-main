// POS-PERF-P66 — Supervisor payroll in the browser: missing setup -> Payroll
// Settings -> back, draft before rates (never shown as ₱0), rates set from the
// checklist and Settings, a rate change inside the period, review, Cancel,
// explicit finalization, read-only finalized state, branch switching, layouts
// and Admin reporting. LOCAL ONLY: ../p62/lib.mjs refuses a non-localhost web
// URL and ../p62/db.mjs a non-local p62_* database. Finalizes payroll only for
// a staff fixture created here in that local database. Viewports are Chromium
// emulation (desktop 1366, tablet 820, phone 390), not real devices.
//
//   node tests/e2e/manual/p66/payroll-flow.mjs
import { WEB, check, record, saveResults, openProfile, login, waitForController, shot } from '../p62/lib.mjs';
import { prisma } from '../p62/db.mjs';

const RUN = Date.now().toString(36);
const STAFF = { first: 'Pia', last: `Payroll${RUN}` };
const FULL = `${STAFF.first} ${STAFF.last}`;
const DAY = 86_400_000;

const manilaKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(d);
const addDays = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** Manila wall-clock time on a business date, as a UTC instant (Manila is UTC+8, no DST). */
const manila = (key, hh, mm = 0) => new Date(Date.parse(`${key}T00:00:00Z`) + ((hh - 8) * 60 + mm) * 60_000);

/** The semi-monthly (cutoff 15) period before the one containing today. */
function previousPeriod(todayKey) {
  const [y, m, d] = todayKey.split('-').map(Number);
  if (d > 15) return { start: `${todayKey.slice(0, 7)}-01`, end: `${todayKey.slice(0, 7)}-15` };
  const prev = new Date(Date.UTC(y, m - 2, 1));
  const last = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  const p = prev.toISOString().slice(0, 7);
  return { start: `${p}-16`, end: `${p}-${String(last).padStart(2, '0')}` };
}

const TODAY = manilaKey(new Date());
const PERIOD = previousPeriod(TODAY);
const DAY1 = addDays(PERIOD.start, 2); // 8 h shift, 30 min unpaid break: 7.5 h at ₱80
const RATE_CHANGE = addDays(PERIOD.start, 7);
const DAY2 = addDays(PERIOD.start, 9); // 4 h shift at ₱90
const EXPECTED_TOTAL = '₱960.00';
// A branch created here (local database only), so no other attendance or setup can affect the run.
const BRANCH = { code: `P66P${RUN.slice(-6).toUpperCase()}`, name: `P66 Payroll ${RUN}` };
const contexts = [];

async function fixture() {
  const branchId = (await prisma.branch.create({ data: { name: BRANCH.name, code: BRANCH.code, address: 'x', city: 'x', status: 'active' } })).id;
  const supervisor = await prisma.user.findFirstOrThrow({ where: { email: 'supervisor@potatocorner.test' } });
  await prisma.userBranchAssignment.create({ data: { userId: supervisor.id, branchId } });
  const staff = await prisma.user.create({
    data: { role: 'staff', firstName: STAFF.first, lastName: STAFF.last, employeeId: `P66PAY-${RUN}`, employmentType: 'regular', mustChangePassword: false },
  });
  await prisma.userBranchAssignment.create({ data: { userId: staff.id, branchId, assignedAt: new Date(Date.now() - 40 * DAY) } });
  const shift1 = await prisma.attendanceRecord.create({
    data: { employeeId: staff.id, branchId, clockInServerTime: manila(DAY1, 9), clockOutServerTime: manila(DAY1, 17), clockInGpsStatus: 'within_radius' },
  });
  await prisma.attendanceBreak.create({ data: { attendanceRecordId: shift1.id, startedAt: manila(DAY1, 12), endedAt: manila(DAY1, 12, 30), startedBy: staff.id, endedBy: staff.id, endReason: 'resumed' } });
  await prisma.attendanceRecord.create({
    data: { employeeId: staff.id, branchId, clockInServerTime: manila(DAY2, 9), clockOutServerTime: manila(DAY2, 13), clockInGpsStatus: 'within_radius' },
  });
  return { staff, branchId };
}

const mainText = (page) => page.locator('main').innerText().catch(() => '');
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function chooseBranch(page, name) {
  const trigger = page.getByRole('button', { name: /^(Main Branch|P62 Branch \d|P66 Payroll \w+)$/ }).first();
  if ((await trigger.innerText()).includes(name)) return;
  await trigger.click();
  await page.getByRole('menuitem', { name: new RegExp(name) }).click();
  await page.waitForTimeout(500);
}

async function addRate(page, { date, amount, reason }) {
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.locator('#rate-effective').fill(date);
  await dialog.locator('#rate-hourly').fill(amount);
  await dialog.locator('#rate-reason').fill(reason);
  await dialog.getByRole('button', { name: 'Add rate' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
}

async function main() {
  record('dates', true, { today: TODAY, period: PERIOD, day1: DAY1, rateChange: RATE_CHANGE, day2: DAY2 });
  const { staff, branchId } = await fixture();
  const serverErrors = [];

  const ctx = await openProfile(`p66pay-sup-${RUN}`);
  contexts.push(ctx);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('response', (r) => {
    if (r.status() >= 500) serverErrors.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  await login(page, 'supervisor');
  record('supervisor service worker', true, { sw: await waitForController(page) });
  await page.goto(`${WEB}/supervisor/reports/payroll`);
  await chooseBranch(page, BRANCH.name);
  await page.getByTestId('payroll-setup-checklist').waitFor();

  // ---- 1. Missing setup: checklist only, nothing priced.
  let text = await mainText(page);
  check('missing setup: checklist lists items to finish', /Payroll setup: \d items? to finish/.test(text));
  check('missing setup: says no pay is calculated until the policy is saved', (await page.getByTestId('payroll-not-configured').count()) === 1);
  check('missing setup: no ₱0 amounts and no pay-period step', !/₱0\.00/.test(text) && !/Step 1 of 3/.test(text));
  check('branch context shown once', (await page.getByTestId('payroll-branch').count()) === 1 && (await page.getByTestId('payroll-branch').innerText()).includes(BRANCH.name));
  await shot(page, 'p66pay-missing-setup');

  // ---- 2. Keyboard: Set up -> Payroll Settings; a refused save keeps the inputs.
  await page.getByRole('button', { name: 'Set up branch payroll policy' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Payroll Settings' }).waitFor();
  check('Set up (keyboard Enter) opens Payroll Settings with Back to payroll', (await page.getByRole('button', { name: /Back to payroll/ }).count()) > 0);
  await page.locator('#payroll-timezone').fill('Asia/Manila');
  await page.locator('#period-semi').click();
  await page.locator('#payroll-cutoff').fill('30');
  await page.locator('#break-unpaid').click();
  await page.getByRole('button', { name: 'Save policy' }).click();
  // Scoped to the form: Next.js keeps an empty route-announcer alert on every page.
  const formAlert = page.locator('form [role="alert"]').first();
  await formAlert.waitFor({ timeout: 15_000 });
  const alertText = (await formAlert.innerText()).trim();
  check('invalid cutoff refused with a message in the form', alertText === 'Enter the first cutoff day (1–27).', { alert: alertText });
  check('refused save keeps the inputs', (await page.locator('#payroll-timezone').inputValue()) === 'Asia/Manila' && (await page.locator('#payroll-cutoff').inputValue()) === '30' && (await page.locator('#period-semi').getAttribute('data-state')) === 'checked');
  check('refused save wrote no policy', (await prisma.payrollPolicy.count({ where: { branchId } })) === 0);
  await page.locator('#payroll-cutoff').fill('15');
  await page.getByRole('button', { name: 'Save policy' }).click();
  await page.getByRole('heading', { name: 'Payroll', exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText('Step 1 of 3').waitFor({ timeout: 30_000 });
  check('saving the policy returns to payroll at step 1', (await page.getByRole('heading', { name: 'Payroll Settings' }).count()) === 0);
  text = await mainText(page);
  check('checklist: policy ready, rates still missing for the fixture', /Version 1/.test(text) && (await page.getByRole('button', { name: new RegExp(`Set rate for\\s+${FULL}`) }).count()) === 1);

  // ---- 3. Draft before any rate: hours are never shown as ₱0 pay.
  const trigger = page.locator('#payroll-period');
  check('default pay period is the previous cutoff, with readable dates and status', /Not started/.test(await trigger.innerText()) && (await trigger.innerText()).includes(PERIOD.end.slice(8).replace(/^0/, '')), { period: await trigger.innerText() });
  // A failed request keeps the selection (service-worker note: recorded if the route is not hit).
  let aborted = false;
  await page.route('**/payroll/branches/*/runs', (route) => {
    if (route.request().method() === 'POST' && !aborted) {
      aborted = true;
      return route.abort('failed');
    }
    return route.continue();
  });
  const periodBefore = await trigger.innerText();
  await page.getByRole('button', { name: 'Prepare draft payroll' }).click();
  await page.waitForTimeout(1500);
  if (aborted) {
    check('failed Prepare shows an error and keeps the period', /The draft was not prepared/.test(await mainText(page)) && (await trigger.innerText()) === periodBefore);
    check('failed Prepare wrote no run', (await prisma.payrollRun.count({ where: { branchId } })) === 0);
    await page.getByRole('button', { name: 'Prepare draft payroll' }).click();
  } else {
    record('failed Prepare: request not interceptable (service worker); covered by component tests', true);
  }
  await page.unroute('**/payroll/branches/*/runs');
  await page.getByText('Step 2 of 3').waitFor({ timeout: 30_000 });
  const row = () => page.getByTestId('payroll-review-table').getByRole('row').filter({ hasText: FULL });
  text = await row().innerText();
  check('draft without a rate: "Needs a rate", not ₱0', /Needs a rate/.test(text) && !/₱0\.00/.test(text), { row: text });
  check('draft without a rate: footer totals say "Needs a rate", not ₱0', !/(^|\s)₱0\.00(\s|$)/m.test(await page.getByTestId('payroll-review-table').locator('tfoot').innerText()) && /Needs a rate/.test(await page.getByTestId('payroll-review-table').locator('tfoot').innerText()));
  await row().getByRole('button', { name: /Details/ }).click();
  const noRateDetails = await page.getByRole('region', { name: `Payroll details for ${FULL}` }).innerText();
  check('draft without a rate: calculation details say "Needs a rate", not ₱0', /Needs a rate/.test(noRateDetails) && !/Basic pay\s*₱0\.00/.test(noRateDetails) && !/Calculated total\s*₱0\.00/.test(noRateDetails));
  await row().getByRole('button', { name: /Hide details/ }).click();
  check('draft without a rate: Finalize disabled with a reason', await page.getByRole('button', { name: /^Finalize payroll/ }).isDisabled() && /must be resolved before/.test(await mainText(page)));

  // ---- 4. Rates: starting rate from the checklist, then a change inside the period and today's rate in Settings.
  await page.getByRole('button', { name: new RegExp(`Set rate for\\s+${FULL}`) }).click();
  await addRate(page, { date: PERIOD.start, amount: '80', reason: 'P66 starting rate' });
  await page.getByRole('button', { name: 'Payroll Settings' }).click();
  await page.getByRole('heading', { name: 'Payroll Settings' }).waitFor();
  const rateRow = page.getByRole('row').filter({ hasText: FULL });
  await rateRow.getByRole('button', { name: 'Add rate' }).click();
  await addRate(page, { date: RATE_CHANGE, amount: '90', reason: 'P66 mid-period increase' });
  await rateRow.getByRole('button', { name: 'Add rate' }).click();
  await addRate(page, { date: TODAY, amount: '95', reason: 'P66 current rate' });
  check('rates stored (80, 90, 95)', (await prisma.employeePayRate.count({ where: { employeeId: staff.id, voidedAt: null } })) === 3);
  await page.getByRole('button', { name: /Back to payroll/ }).first().focus();
  await page.keyboard.press('Enter');
  await page.getByText('Step 2 of 3').waitFor({ timeout: 30_000 });
  check('back to payroll keeps the open draft', (await page.locator('#payroll-period').innerText()) === periodBefore.replace('Not started', 'Draft') || /Draft/.test(await page.locator('#payroll-period').innerText()));

  // ---- 5. Review: period-effective rates, never today's.
  await page.waitForFunction((name) => [...document.querySelectorAll('[data-testid="payroll-review-table"] tr')].some((tr) => tr.textContent.includes(name) && tr.textContent.includes('₱90.00/h')), FULL, { timeout: 30_000 });
  text = await row().innerText();
  check('review: ₱80.00/h and ₱90.00/h for this period', /₱80\.00\/h/.test(text) && /₱90\.00\/h/.test(text), { row: text });
  check("review: today's ₱95.00/h is not used for the older cutoff", !/₱95\.00/.test(text));
  check('review: explains the rate change inside the period', /The rate changed during this period/.test(text));
  check(`review: basic pay ${EXPECTED_TOTAL} (7.5 h × 80 + 4 h × 90, unpaid break)`, text.includes(EXPECTED_TOTAL), { row: text });
  await row().getByRole('button').first().click();
  await page.getByRole('region', { name: `Payroll details for ${FULL}` }).waitFor();
  check('calculation details expand for the employee', true);
  check('review: one employee list (table) on desktop', (await page.getByTestId('payroll-review-cards').isVisible()) === false);
  await shot(page, 'p66pay-review-desktop');

  // ---- 6. Finalize: Cancel writes nothing, then explicit confirmation.
  const finalizeBtn = page.getByRole('button', { name: /^Finalize payroll/ });
  check('Finalize enabled once checks pass', await finalizeBtn.isEnabled());
  await finalizeBtn.click();
  const dialog = page.getByRole('dialog', { name: 'Finalize payroll' });
  await dialog.waitFor();
  check('dialog: Finalize disabled until acknowledged', await dialog.getByRole('button', { name: 'Finalize', exact: true }).isDisabled());
  check('dialog: states it excludes statutory items', /does not include/i.test(await dialog.innerText()));
  check(`dialog: total ${EXPECTED_TOTAL}`, (await dialog.innerText()).includes(EXPECTED_TOTAL));
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'hidden' });
  check('Cancel: nothing finalized', (await prisma.payrollRun.count({ where: { branchId, status: 'finalized' } })) === 0);
  await finalizeBtn.click();
  await dialog.waitFor();
  await dialog.locator('#payroll-ack').focus();
  await page.keyboard.press('Space');
  await dialog.getByRole('button', { name: 'Finalize', exact: true }).focus();
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 });
  await page.getByText(/Read-only\. Finalized by/).waitFor({ timeout: 30_000 });
  const run = await prisma.payrollRun.findFirst({ where: { branchId, status: 'finalized' } });
  check('database: one finalized run with total 960.00 and snapshots', run !== null && Number(run.calculatedTotal) === 960 && run.rateSnapshot !== null && run.finalizedByName !== null, { total: run && Number(run.calculatedTotal) });
  text = await mainText(page);
  check('finalized: read-only, no Finalize or Discard', (await page.getByRole('button', { name: /^Finalize payroll/ }).count()) === 0 && (await page.getByRole('button', { name: 'Discard draft' }).count()) === 0);
  check('finalized: Revise and Mark as paid offered instead', (await page.getByRole('button', { name: 'Revise…' }).count()) === 1);

  // ---- 7. Snapshot does not follow a later rate change; reload keeps it.
  await prisma.employeePayRate.updateMany({ where: { employeeId: staff.id, effectiveFrom: new Date(`${RATE_CHANGE}T00:00:00Z`) }, data: { voidedAt: new Date(), voidedBy: staff.id, voidReason: 'P66 local snapshot check' } });
  await page.reload();
  await page.getByText(/Read-only\. Finalized by/).waitFor({ timeout: 30_000 });
  text = await row().innerText();
  check('finalized snapshot unchanged after a rate is voided (still ₱90.00/h and total)', /₱90\.00\/h/.test(text) && text.includes(EXPECTED_TOTAL), { row: text });
  check('period selector shows Finalized', /Finalized/.test(await page.locator('#payroll-period').innerText()));

  // ---- 8. Branch switching: no stale payroll.
  await chooseBranch(page, 'P62 Branch 1');
  await page.getByTestId('payroll-setup-checklist').waitFor();
  await page.waitForTimeout(1000);
  text = await mainText(page);
  check('other branch: own (unconfigured) payroll, no stale run or employee', /P62 Branch 1/.test(await page.getByTestId('payroll-branch').innerText()) && !text.includes(FULL) && !text.includes(EXPECTED_TOTAL) && (await page.getByTestId('payroll-not-configured').count()) === 1);
  await chooseBranch(page, BRANCH.name);
  await page.getByText(/Read-only\. Finalized by/).waitFor({ timeout: 30_000 });
  check(`back on ${BRANCH.name}: finalized run shown again`, (await mainText(page)).includes(EXPECTED_TOTAL));

  // ---- 9. Layouts.
  for (const [label, width, height] of [['desktop', 1366, 900], ['tablet', 820, 1180], ['phone', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(400);
    const cards = await page.getByTestId('payroll-review-cards').isVisible();
    const table = await page.getByTestId('payroll-review-table').isVisible();
    check(`${label}: ${width < 768 ? 'cards' : 'table'} only, no horizontal scroll`, (width < 768 ? cards && !table : table && !cards) && (await noHScroll(page)), { cards, table });
    await shot(page, `p66pay-finalized-${label}`);
  }
  await page.setViewportSize({ width: 1366, height: 900 });

  // ---- 10. Admin reporting sees the finalized payroll.
  const adminCtx = await openProfile(`p66pay-admin-${RUN}`);
  contexts.push(adminCtx);
  const admin = adminCtx.pages()[0] ?? (await adminCtx.newPage());
  await login(admin, 'admin');
  await admin.goto(`${WEB}/admin/reports/payroll`);
  await admin.getByRole('combobox').first().click();
  await admin.getByRole('option', { name: new RegExp(BRANCH.name) }).first().click();
  await admin.getByText(/Read-only\. Finalized by/).waitFor({ timeout: 30_000 });
  check('Admin Reports -> Payroll shows the finalized run', (await mainText(admin)).includes(EXPECTED_TOTAL));
  await adminCtx.close();

  check('no 5xx responses during the run', serverErrors.length === 0, { serverErrors });
  await ctx.close();
}

try {
  await main();
} catch (error) {
  record('driver stopped', false, { error: String(error?.message ?? error).slice(0, 400) });
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await prisma.$disconnect();
}
const failed = saveResults('p66-payroll-flow');
process.exitCode = failed ? 1 : 0;
