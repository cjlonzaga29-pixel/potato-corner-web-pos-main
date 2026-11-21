// POS-PERF-P64 — account removal, Reports-only Admin Extra Supplies and
// Attendance, dashboard cleanup, on the LOCAL P62 stack (production builds,
// service worker active). LOCAL ONLY: ../p62/lib.mjs refuses a non-localhost web
// URL and ../p62/db.mjs a non-local p62_* database. Viewports are Chromium
// emulation (desktop 1366, tablet 820, phone 390), not real devices.
//
//   node tests/e2e/manual/p64/account-and-reports.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { WEB, OUT, check, record, saveResults, openProfile, login, waitForController, dumpAria, shot, sleep } from '../p62/lib.mjs';
import { prisma, mainBranchId } from '../p62/db.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const bcrypt = require('bcrypt');

const RUN = Date.now().toString(36);
const REMOVE_EMAIL = `p64-remove-${RUN}@potatocorner.test`;
const REMOVE_PASSWORD = 'P64-Remove!pass1';
const NAME = { first: 'Rosa', last: `Removable${RUN}` };

/** Fixture on the local p62_* database only: a supervisor with real history (attendance, expense, audit via login). */
async function fixture() {
  const branchId = await mainBranchId();
  let user = await prisma.user.findUnique({ where: { email: REMOVE_EMAIL } });
  if (user?.deletedAt) throw new Error('Fixture already removed — re-run on a fresh stack database');
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: REMOVE_EMAIL,
        passwordHash: await bcrypt.hash(REMOVE_PASSWORD, 12),
        role: 'supervisor',
        firstName: NAME.first,
        lastName: NAME.last,
        employmentType: 'regular',
        employeeId: `PC-EMP-P64-${Date.now()}`,
        mustChangePassword: false,
      },
    });
    await prisma.userBranchAssignment.create({ data: { userId: user.id, branchId, assignedAt: new Date() } });
    await prisma.attendanceRecord.create({
      data: { employeeId: user.id, branchId, clockInServerTime: new Date(Date.now() - 6 * 3600_000), clockOutServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' },
    });
    await prisma.expense.create({
      data: { branchId, category: 'supplies', amount: 123.45, description: 'P64 history expense', incurredAt: new Date(), createdBy: user.id },
    });
  }
  return { user, branchId };
}

const noBadge = async (page, where) => {
  const text = await page.locator('main').innerText().catch(() => '');
  check(`${where}: no Connected/Connecting/Reconnecting badge`, !/\b(Connected|Connecting|Reconnecting|Disconnected)\b/.test(text));
};

async function main() {
  const { user, branchId } = await fixture();
  const since = new Date();

  // ---- The supervisor to be removed is signed in, with a live session.
  const supCtx = await openProfile('p64-sup');
  const sup = supCtx.pages()[0] ?? (await supCtx.newPage());
  await sup.goto(`${WEB}/login`);
  await sup.getByLabel('Email').fill(REMOVE_EMAIL);
  await sup.getByRole('textbox', { name: 'Password' }).fill(REMOVE_PASSWORD);
  await sup.getByRole('button', { name: 'Sign in', exact: true }).click();
  await sup.waitForURL('**/supervisor/dashboard', { timeout: 60_000 });
  record('removable supervisor signed in', true, { sw: await waitForController(sup) });
  await sup.waitForLoadState('networkidle').catch(() => {});
  await noBadge(sup, 'supervisor dashboard');

  // ---- Admin: navigation, dashboard, redirects.
  const adminCtx = await openProfile('p64-admin');
  const admin = adminCtx.pages()[0] ?? (await adminCtx.newPage());
  await login(admin, 'admin');
  record('admin service worker', true, { sw: await waitForController(admin) });
  await admin.waitForLoadState('networkidle').catch(() => {});
  await noBadge(admin, 'admin dashboard');
  const nav = admin.getByRole('navigation').first();
  check('admin sidebar has no Extra Supplies entry', (await nav.getByRole('link', { name: 'Extra Supplies', exact: true }).count()) === 0);
  check('admin sidebar has no Attendance entry', (await nav.getByRole('link', { name: 'Attendance', exact: true }).count()) === 0);
  check('admin sidebar still has Reports', (await nav.getByRole('link', { name: 'Reports', exact: true }).count()) === 1);

  await admin.goto(`${WEB}/admin/extra-supplies?branch_id=${branchId}&date_from=2026-11-01&date_to=2026-11-30&evil=%3Cscript%3E&tab=VOID_REFUND`);
  await admin.waitForURL('**/admin/reports**');
  const redirected = new URL(admin.url());
  check('old Extra Supplies URL redirects to Reports with only supported filters', redirected.searchParams.get('tab') === 'EXTRA_SUPPLIES' && redirected.searchParams.get('branch_id') === branchId && redirected.searchParams.get('date_from') === '2026-11-01' && !redirected.searchParams.has('evil'), { url: redirected.pathname + redirected.search });
  await admin.waitForLoadState('networkidle').catch(() => {});
  await noBadge(admin, 'admin reports');
  check('Extra Supplies report renders under Reports', await admin.getByText(/Extra Supplies/).first().isVisible());
  await dumpAria(admin, 'p64-admin-extra-supplies');
  // CSV from the report's own export.
  const csvButton = admin.getByRole('button', { name: /csv/i }).first();
  if (await csvButton.count()) {
    const [download] = await Promise.all([admin.waitForEvent('download', { timeout: 30_000 }), csvButton.click()]);
    const file = `${OUT}/p64-extra-supplies.csv`;
    await download.saveAs(file);
    const csv = fs.readFileSync(file, 'utf8');
    check('Extra Supplies CSV downloads from Reports and has a header row', csv.split(/\r?\n/)[0].length > 0, { firstLine: csv.split(/\r?\n/)[0].slice(0, 160), lines: csv.split(/\r?\n/).length });
  } else {
    record('Extra Supplies CSV button present', false);
  }
  check('Admin Extra Supplies report has no card setup controls', (await admin.getByRole('button', { name: /new (card|supply)|add (card|supply)|deactivate/i }).count()) === 0);

  await admin.goto(`${WEB}/admin/attendance`);
  await admin.waitForURL('**/admin/reports**');
  check('old Attendance URL redirects to the Attendance Records report', new URL(admin.url()).searchParams.get('tab') === 'ATTENDANCE_RECORDS', { url: new URL(admin.url()).search });
  await admin.waitForLoadState('networkidle').catch(() => {});
  check('Attendance Records report has no clock-in/out or correction controls', (await admin.getByRole('button', { name: /clock (in|out)|correct|override|approve/i }).count()) === 0);

  // ---- Delete the supervisor with history.
  await admin.goto(`${WEB}/admin/supervisors`);
  await admin.waitForLoadState('networkidle').catch(() => {});
  const fullName = `${NAME.first} ${NAME.last}`;
  await admin.getByRole('button', { name: `Delete or deactivate ${fullName}` }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByText(/history is kept/i).waitFor({ timeout: 30_000 });
  check('confirmation says access is removed and history kept, not erased', (await dialog.getByText(/not erased/i).count()) === 1);
  await shot(admin, 'p64-delete-dialog');
  await dumpAria(admin, 'p64-delete-dialog');
  const deleteButton = dialog.getByRole('button', { name: 'Delete account' });
  check('Delete account is disabled until confirmed', await deleteButton.isDisabled());
  await dialog.getByRole('checkbox').click();
  await deleteButton.click();
  await admin.getByText('Account removed — history kept').waitFor({ timeout: 30_000 });
  await admin.waitForLoadState('networkidle').catch(() => {});
  await sleep(1500);
  check('removed supervisor disappears from the normal supervisor list', (await admin.getByText(fullName).count()) === 0);

  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  check('database keeps the row as a non-login historical record', Boolean(row.deletedAt) && !row.isActive && row.status !== 'active');
  check('branch access removed', (await prisma.userBranchAssignment.count({ where: { userId: user.id, removedAt: null } })) === 0);

  // ---- The removed supervisor's existing session loses access.
  let signedOut = false;
  for (let i = 0; i < 20 && !signedOut; i++) {
    await sleep(1000);
    signedOut = new URL(sup.url()).pathname.startsWith('/login');
  }
  if (!signedOut) {
    await sup.reload().catch(() => {});
    await sup.waitForLoadState('networkidle').catch(() => {});
    for (let i = 0; i < 15 && !signedOut; i++) {
      await sleep(1000);
      signedOut = new URL(sup.url()).pathname.startsWith('/login');
    }
  }
  check('existing session of the removed supervisor ends (lands on /login)', signedOut, { url: new URL(sup.url()).pathname });
  await sup.goto(`${WEB}/login`);
  await sup.getByLabel('Email').fill(REMOVE_EMAIL);
  await sup.getByRole('textbox', { name: 'Password' }).fill(REMOVE_PASSWORD);
  await sup.getByRole('button', { name: 'Sign in', exact: true }).click();
  await sup.getByText(/deactivated/i).first().waitFor({ timeout: 30_000 }).catch(() => {});
  check('signing in again is refused', !new URL(sup.url()).pathname.startsWith('/supervisor'), { url: new URL(sup.url()).pathname });

  // ---- History keeps the real name.
  await admin.goto(`${WEB}/admin/expenses`);
  await admin.waitForLoadState('networkidle').catch(() => {});
  await sleep(1500);
  check('historical expense still shows the removed supervisor as Recorded By', (await admin.getByText(fullName).count()) > 0);
  await admin.goto(`${WEB}/admin/reports?tab=ATTENDANCE_RECORDS`);
  await admin.waitForLoadState('networkidle').catch(() => {});
  // The fixture record started up to 6 h ago, possibly the previous Manila day: widen the report's own From date.
  const manilaDate = (d) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  await admin.locator('#attendance-from').fill(manilaDate(new Date(Date.now() - 24 * 3600_000)));
  await admin.locator('#attendance-from').press('Tab');
  await admin.waitForLoadState('networkidle').catch(() => {});
  await sleep(2000);
  await dumpAria(admin, 'p64-admin-attendance-records');
  check('historical attendance in the Admin report still names the removed supervisor', (await admin.getByText(fullName).count()) > 0);
  const audit = await prisma.auditLog.findFirst({ where: { entityId: user.id, action: 'EMPLOYEE_REMOVED' } });
  const adminUser = await prisma.user.findFirstOrThrow({ where: { email: 'admin@potatocorner.test' } });
  check('audit records the removal by the Super Admin', audit?.actorId === adminUser.id);

  // ---- Supervisor (another, normal) and Branch workflows; dashboards across viewports.
  const otherCtx = await openProfile('p64-sup2');
  const other = otherCtx.pages()[0] ?? (await otherCtx.newPage());
  await login(other, 'supervisor');
  await other.waitForLoadState('networkidle').catch(() => {});
  await noBadge(other, 'supervisor dashboard (normal supervisor)');
  await other.goto(`${WEB}/supervisor/attendance`).catch(() => {});
  await other.waitForLoadState('networkidle').catch(() => {});
  check('Supervisor attendance page still loads', !/\/login/.test(other.url()) && (await other.getByText(/attendance/i).count()) > 0, { url: new URL(other.url()).pathname });
  await other.goto(`${WEB}/admin/extra-supplies`);
  await sleep(2000);
  check('a supervisor cannot reach the Admin report via the old URL', !new URL(other.url()).pathname.startsWith('/admin'), { url: new URL(other.url()).pathname });

  const branchCtx = await openProfile('p64-branch');
  const branch = branchCtx.pages()[0] ?? (await branchCtx.newPage());
  const sockets = [];
  branch.on('websocket', (ws) => {
    const entry = { url: ws.url(), received: 0 };
    sockets.push(entry);
    ws.on('framereceived', () => {
      entry.received += 1;
    });
  });
  await login(branch, 'branch');
  record('branch service worker', true, { sw: await waitForController(branch) });
  for (const [label, width, height] of [['desktop', 1366, 900], ['tablet', 820, 1180], ['phone', 390, 844]]) {
    await branch.setViewportSize({ width, height });
    await branch.goto(`${WEB}/branch/dashboard`);
    await branch.waitForLoadState('networkidle').catch(() => {});
    await sleep(1000);
    await noBadge(branch, `branch dashboard ${label}`);
    const order = await branch.evaluate(() => {
      // Innermost element whose own subtree holds the text (a title may wrap an icon, so not only leaves).
      const innermost = (re) => [...document.querySelectorAll('main *')].filter((el) => re.test(el.textContent ?? '') && ![...el.children].some((c) => re.test(c.textContent ?? '')));
      const heading = innermost(/Today's Extra Supplies/)[0];
      const gross = innermost(/Gross Sales Today/)[0];
      const tx = innermost(/Recent Transactions/i)[0];
      const count = innermost(/Today's Extra Supplies/).length;
      const follows = (a, b) => Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      const scrollW = document.documentElement.scrollWidth;
      return { count, afterSales: follows(gross, heading), afterTransactions: tx ? follows(tx, heading) : null, noHScroll: scrollW <= window.innerWidth + 1 };
    });
    check(`branch dashboard ${label}: Extra Supplies summary once, below the main sections, no horizontal scroll`, order.count === 1 && order.afterSales && order.afterTransactions !== false && order.noHScroll, order);
    await shot(branch, `p64-branch-dashboard-${label}`);
  }
  await branch.setViewportSize({ width: 1366, height: 900 });
  await sleep(3000);
  check('realtime socket connected on the branch dashboard and receiving frames', sockets.some((s) => /socket\.io/.test(s.url) && s.received > 0), { sockets: sockets.map((s) => ({ url: new URL(s.url).pathname, received: s.received })) });

  // Offline warnings on the terminal stay.
  await branch.goto(`${WEB}/branch/terminal`);
  await branch.waitForLoadState('networkidle').catch(() => {});
  await branchCtx.setOffline(true);
  await sleep(1500);
  const supplies = branch.getByRole('tab', { name: 'Extra Supplies' });
  if (await supplies.count()) {
    await supplies.click().catch(() => {});
    await sleep(1000);
  }
  const offlineText = await branch.locator('body').innerText();
  check('terminal still shows its offline warning', /offline/i.test(offlineText));
  await shot(branch, 'p64-terminal-offline');
  await branchCtx.setOffline(false);

  console.log(`activity window from ${since.toISOString()}`);
  await Promise.all([supCtx.close(), adminCtx.close(), otherCtx.close(), branchCtx.close()]);
  await prisma.$disconnect();
  return saveResults('p64-account-and-reports');
}

main().then(
  (failed) => process.exit(failed ? 1 : 0),
  async (error) => {
    console.error(error);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  },
);
