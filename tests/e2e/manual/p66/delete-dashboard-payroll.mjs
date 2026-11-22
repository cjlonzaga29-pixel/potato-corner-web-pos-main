// POS-PERF-P66 — permanent account deletion, dashboard panel removal and the
// Supervisor payroll entry, on the LOCAL P62 stack (production builds, service
// worker active). LOCAL ONLY: ../p62/lib.mjs refuses a non-localhost web URL and
// ../p62/db.mjs a non-local p62_* database. Viewports are Chromium emulation
// (desktop 1366, tablet 820, phone 390), not real devices. Nothing here
// finalizes payroll or touches a non-local account.
//
//   node tests/e2e/manual/p66/delete-dashboard-payroll.mjs
import { createRequire } from 'node:module';
import { WEB, check, record, saveResults, openProfile, login, waitForController, dumpAria, shot, sleep } from '../p62/lib.mjs';
import { prisma, mainBranchId } from '../p62/db.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const bcrypt = require('bcrypt');

const RUN = Date.now().toString(36);
const EMAIL = `p66-delete-${RUN}@potatocorner.test`;
const PASSWORD = 'P66-Delete!pass1';
const NAME = { first: 'Dina', last: `Deletable${RUN}` };
const FULL = `${NAME.first} ${NAME.last}`;
const VIEWPORTS = [['desktop', 1366, 900], ['tablet', 820, 1180], ['phone', 390, 844]];

/** Local p62_* database only: a supervisor with history in an FK'd table P47 never counted (expense type), plus expense, attendance, audit. */
async function fixture() {
  const branchId = await mainBranchId();
  const user = await prisma.user.create({
    data: {
      email: EMAIL,
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      role: 'supervisor',
      firstName: NAME.first,
      lastName: NAME.last,
      employmentType: 'regular',
      mustChangePassword: false,
    },
  });
  await prisma.userBranchAssignment.create({ data: { userId: user.id, branchId, assignedAt: new Date() } });
  await prisma.attendanceRecord.create({
    data: { employeeId: user.id, branchId, clockInServerTime: new Date(Date.now() - 3 * 3600_000), clockOutServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' },
  });
  await prisma.expense.create({ data: { branchId, category: 'supplies', amount: 123.45, description: 'P66 history expense', incurredAt: new Date(), createdBy: user.id } });
  await prisma.expenseType.create({ data: { name: `P66 Ice ${RUN}`, normalizedName: `p66 ice ${RUN}`, createdById: user.id } });
  return { user, branchId };
}

async function noRemovedPanels(page, where) {
  const text = await page.locator('main').innerText().catch(() => '');
  check(`${where}: no "Today's Expenses by Type" panel or View ledger`, !/Expenses by Type/i.test(text) && !/View ledger/i.test(text));
  check(`${where}: no "Today's Extra Supplies" panel or View history`, !/Today.s Extra Supplies/i.test(text) && !/View history/i.test(text));
  check(`${where}: small Today's Expenses KPI still shown`, /Today.s Expenses/i.test(text));
  const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check(`${where}: no horizontal scroll`, noHScroll);
}

async function dashboardRequests(page, path) {
  const urls = [];
  const listener = (request) => urls.push(new URL(request.url()).pathname + new URL(request.url()).search);
  page.on('request', listener);
  await page.goto(`${WEB}${path}`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(1500);
  page.off('request', listener);
  return urls.filter((u) => u.startsWith('/api/'));
}

async function main() {
  const { user, branchId } = await fixture();

  // ---- The supervisor to be deleted is signed in.
  const supCtx = await openProfile('p66-sup');
  const sup = supCtx.pages()[0] ?? (await supCtx.newPage());
  await sup.goto(`${WEB}/login`);
  await sup.getByLabel('Email').fill(EMAIL);
  await sup.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await sup.getByRole('button', { name: 'Sign in', exact: true }).click();
  await sup.waitForURL('**/supervisor/dashboard', { timeout: 60_000 });
  record('deletable supervisor signed in', true, { sw: await waitForController(sup) });

  // ---- Admin: dashboard without the two panels, Reports destinations.
  const adminCtx = await openProfile('p66-admin');
  const admin = adminCtx.pages()[0] ?? (await adminCtx.newPage());
  await login(admin, 'admin');
  record('admin service worker', true, { sw: await waitForController(admin) });
  const adminRequests = await dashboardRequests(admin, '/admin/dashboard');
  await noRemovedPanels(admin, 'admin dashboard');
  check('admin dashboard requests no expense-by-type or extra-supply summary', !adminRequests.some((u) => /expenses\/summary|extra-supplies\/(summary|report)/.test(u)), { api: adminRequests });
  await admin.goto(`${WEB}/admin/reports?tab=EXTRA_SUPPLIES`);
  await admin.waitForLoadState('networkidle').catch(() => {});
  check('Admin Reports › Extra Supplies still renders', (await admin.getByText(/Extra Supplies/).count()) > 0);
  await admin.goto(`${WEB}/admin/expenses`);
  await admin.waitForLoadState('networkidle').catch(() => {});
  await sleep(1000);
  check('Admin expense ledger still loads', !/\/login/.test(admin.url()) && (await admin.getByText(/Expense/i).count()) > 0);

  // ---- Delete the supervisor with history.
  await admin.goto(`${WEB}/admin/supervisors`);
  await admin.waitForLoadState('networkidle').catch(() => {});
  await admin.getByRole('button', { name: `Delete ${FULL} permanently` }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByText(/This cannot be undone in the application/).waitFor({ timeout: 30_000 });
  check('dialog: suggested warning with the selected name', (await dialog.getByText(`Permanently delete ${FULL}?`, { exact: false }).count()) > 0);
  check('dialog: lists what stays (history counts)', (await dialog.getByText(/attendance record|expense record/).count()) > 0);
  check('dialog: does not claim backups are erased', (await dialog.getByText(/backup/i).count()) === 0);
  await shot(admin, 'p66-delete-dialog');
  await dumpAria(admin, 'p66-delete-dialog');
  const button = dialog.getByRole('button', { name: 'Delete permanently' });
  await dialog.getByLabel(/to confirm/i).fill(NAME.first);
  await dialog.getByRole('checkbox').click();
  check('Delete stays disabled with a partial name', await button.isDisabled());
  await dialog.getByLabel(/to confirm/i).fill(FULL.toLowerCase());
  check('Delete enabled once the name matches (case-insensitive) and acknowledged', await button.isEnabled());
  await button.click();
  await admin.getByText('Account permanently deleted').waitFor({ timeout: 30_000 });
  await sleep(1500);
  check('deleted supervisor disappears from the supervisor list', (await admin.getByText(FULL).count()) === 0);

  check('database: account row is gone', (await prisma.user.findUnique({ where: { id: user.id } })) === null);
  check('database: no branch access, sessions or PINs left', (await prisma.userBranchAssignment.count({ where: { userId: user.id } })) + (await prisma.refreshToken.count({ where: { userId: user.id } })) === 0);
  const person = await prisma.person.findUnique({ where: { id: user.id } });
  check('database: attribution record kept, marked deleted, no credentials', Boolean(person?.accountDeletedAt) && !('email' in (person ?? {})));
  check('database: history rows kept', (await prisma.expense.count({ where: { createdBy: user.id } })) === 1 && (await prisma.attendanceRecord.count({ where: { employeeId: user.id } })) === 1);

  // ---- The deleted supervisor's open session ends; signing in is refused.
  let signedOut = false;
  for (let i = 0; i < 20 && !signedOut; i++) {
    await sleep(1000);
    signedOut = new URL(sup.url()).pathname.startsWith('/login');
  }
  if (!signedOut) {
    await sup.reload().catch(() => {});
    for (let i = 0; i < 15 && !signedOut; i++) {
      await sleep(1000);
      signedOut = new URL(sup.url()).pathname.startsWith('/login');
    }
  }
  check('existing session of the deleted supervisor ends (lands on /login)', signedOut, { url: new URL(sup.url()).pathname });
  await sup.goto(`${WEB}/login`);
  await sup.getByLabel('Email').fill(EMAIL);
  await sup.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await sup.getByRole('button', { name: 'Sign in', exact: true }).click();
  await sleep(4000);
  check('signing in again is refused', !new URL(sup.url()).pathname.startsWith('/supervisor'), { url: new URL(sup.url()).pathname });

  // ---- History after deletion still names the person.
  await admin.goto(`${WEB}/admin/expenses`);
  await admin.waitForLoadState('networkidle').catch(() => {});
  await sleep(1500);
  check('historical expense still shows the deleted supervisor', (await admin.getByText(FULL).count()) > 0);
  await admin.goto(`${WEB}/admin/reports?tab=ATTENDANCE_RECORDS`);
  await admin.waitForLoadState('networkidle').catch(() => {});
  await sleep(2000);
  check('Admin Attendance Records still names the deleted supervisor', (await admin.getByText(FULL).count()) > 0);

  // ---- Supervisor: dashboard and the payroll entry.
  const otherCtx = await openProfile('p66-sup2');
  const other = otherCtx.pages()[0] ?? (await otherCtx.newPage());
  await login(other, 'supervisor');
  const supRequests = await dashboardRequests(other, '/supervisor/dashboard');
  await noRemovedPanels(other, 'supervisor dashboard');
  check('supervisor dashboard requests no expense-by-type or extra-supply summary', !supRequests.some((u) => /expenses\/summary|extra-supplies\/(summary|report)/.test(u)), { api: supRequests });
  await other.goto(`${WEB}/supervisor/extra-supplies`);
  await other.waitForLoadState('networkidle').catch(() => {});
  check('Supervisor Extra Supplies management still loads', !/\/login/.test(other.url()) && (await other.getByText(/Extra Supplies/).count()) > 0);
  for (const [label, width, height] of VIEWPORTS) {
    await other.setViewportSize({ width, height });
    await other.goto(`${WEB}/supervisor/reports/payroll`);
    await other.waitForLoadState('networkidle').catch(() => {});
    await sleep(1500);
    const settingsEntries = await other.getByRole('button', { name: 'Payroll Settings' }).count() + (await other.getByRole('tab', { name: /Payroll Settings/ }).count());
    check(`payroll ${label}: exactly one Payroll Settings entry`, settingsEntries === 1, { settingsEntries });
    check(`payroll ${label}: states it is attendance-based basic pay`, (await other.getByText(/attendance-based basic pay/i).count()) > 0);
    const noHScroll = await other.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check(`payroll ${label}: no horizontal page scroll`, noHScroll);
    await shot(other, `p66-payroll-${label}`);
  }
  await other.setViewportSize({ width: 1366, height: 900 });
  await dumpAria(other, 'p66-payroll');
  await other.getByRole('button', { name: 'Payroll Settings' }).click();
  const back = other.getByRole('button', { name: /Back to payroll/ }).first();
  await back.waitFor({ timeout: 15_000 }).catch(() => {});
  check('Payroll Settings opens with a way back to payroll', (await back.count()) > 0);
  if (await back.count()) await back.click();
  await sleep(800);
  check('back on the payroll flow', (await other.getByRole('button', { name: 'Payroll Settings' }).count()) === 1);

  // ---- Branch dashboard across viewports.
  const branchCtx = await openProfile('p66-branch');
  const branch = branchCtx.pages()[0] ?? (await branchCtx.newPage());
  await login(branch, 'branch');
  record('branch service worker', true, { sw: await waitForController(branch) });
  for (const [label, width, height] of VIEWPORTS) {
    await branch.setViewportSize({ width, height });
    const requests = await dashboardRequests(branch, '/branch/dashboard');
    await noRemovedPanels(branch, `branch dashboard ${label}`);
    check(`branch dashboard ${label}: no extra-supply summary request`, !requests.some((u) => /extra-supplies\/(summary|report)/.test(u)), { api: requests });
    await shot(branch, `p66-branch-dashboard-${label}`);
  }
  await branch.setViewportSize({ width: 1366, height: 900 });
  await branch.goto(`${WEB}/branch/terminal`);
  await branch.waitForLoadState('networkidle').catch(() => {});
  await branchCtx.setOffline(true);
  await sleep(1500);
  check('terminal still shows its offline warning', /offline/i.test(await branch.locator('body').innerText()));
  await branchCtx.setOffline(false);

  await Promise.all([supCtx.close(), adminCtx.close(), otherCtx.close(), branchCtx.close()]);
  await prisma.$disconnect();
  void branchId;
  return saveResults('p66-delete-dashboard-payroll');
}

main().then(
  (failed) => process.exit(failed ? 1 : 0),
  async (error) => {
    console.error(error);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  },
);
