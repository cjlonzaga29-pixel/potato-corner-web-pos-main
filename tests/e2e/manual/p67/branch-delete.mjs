// POS-PERF-P67 — permanent branch deletion keeping history, on the LOCAL P62
// stack (production builds, service worker active). LOCAL ONLY: ../p62/lib.mjs
// refuses a non-localhost web URL and ../p62/db.mjs a non-local p62_* database.
// Chromium emulation (desktop 1366, phone 390), not real devices. Every row it
// creates or deletes is its own fixture branch in that local database.
//
//   node tests/e2e/manual/p67/branch-delete.mjs
import { createRequire } from 'node:module';
import { WEB, check, record, saveResults, openProfile, login, waitForController, dumpAria, shot, sleep } from '../p62/lib.mjs';
import { prisma } from '../p62/db.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const bcrypt = require('bcrypt');

const RUN = Date.now().toString(36);
const PASSWORD = 'P67-Branch!pass1';
const HOUR = 3600_000;

/** A branch with settled history, its own branch login account and one staff member. */
async function fixture(label, { openShift = false } = {}) {
  const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@potatocorner.test' } });
  const branch = await prisma.branch.create({
    data: { name: `P67 ${label} ${RUN}`, code: `P67${label.slice(0, 3).toUpperCase()}-${RUN}`, address: '1 History St', city: 'Testville', status: 'active' },
  });
  const staff = await prisma.user.create({ data: { role: 'staff', firstName: 'Hana', lastName: `History${RUN}`, employmentType: 'regular', mustChangePassword: false } });
  const email = `p67-${label.toLowerCase()}-${RUN}@potatocorner.test`;
  const account = await prisma.user.create({
    data: { role: 'branch', email, passwordHash: await bcrypt.hash(PASSWORD, 12), firstName: 'Branch', lastName: `${label}${RUN}`, employmentType: 'regular', mustChangePassword: false },
  });
  await prisma.userBranchAssignment.createMany({ data: [{ userId: staff.id, branchId: branch.id }, { userId: account.id, branchId: branch.id }] });
  const shift = await prisma.shift.create({
    data: { branchId: branch.id, cashierId: staff.id, openedBy: staff.id, closedBy: staff.id, status: 'closed', openingCashAmount: 500, closingCashAmount: 750, startedAt: new Date(Date.now() - 6 * HOUR), closedAt: new Date(Date.now() - 2 * HOUR) },
  });
  const sale = await prisma.transaction.create({
    data: { transactionNumber: `P67-${label}-${RUN}`, branchId: branch.id, shiftId: shift.id, cashierId: staff.id, status: 'completed', paymentMethod: 'cash', subtotal: 250, vatAmount: 0, totalAmount: 250 },
  });
  await prisma.attendanceRecord.create({
    data: { employeeId: staff.id, branchId: branch.id, clockInServerTime: new Date(Date.now() - 5 * HOUR), clockOutServerTime: new Date(Date.now() - 3 * HOUR), clockInGpsStatus: 'within_radius' },
  });
  await prisma.expense.create({ data: { branchId: branch.id, category: 'supplies', amount: 123.45, description: `P67 history expense ${RUN}`, incurredAt: new Date(), createdBy: admin.id } });
  if (openShift) {
    await prisma.shift.create({ data: { branchId: branch.id, cashierId: staff.id, openedBy: staff.id, status: 'active', openingCashAmount: 0, startedAt: new Date() } });
  }
  return { branch, staff, account, email, sale };
}

async function counts(branchId) {
  const where = { branchId };
  return {
    sales: await prisma.transaction.count({ where }),
    shifts: await prisma.shift.count({ where }),
    attendance: await prisma.attendanceRecord.count({ where }),
    expenses: await prisma.expense.count({ where }),
  };
}

async function openDelete(page, branchId) {
  await page.goto(`${WEB}/admin/branches/${branchId}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Permanently Delete Branch' }).click();
  return page.getByRole('dialog');
}

async function main() {
  const target = await fixture('Main');
  const blocked = await fixture('Busy', { openShift: true });
  const before = await counts(target.branch.id);

  // ---- The branch's own account is signed in on its terminal browser.
  const branchCtx = await openProfile('p67-branch');
  const terminal = branchCtx.pages()[0] ?? (await branchCtx.newPage());
  await terminal.goto(`${WEB}/login`);
  await terminal.getByLabel('Email').fill(target.email);
  await terminal.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await terminal.getByRole('button', { name: 'Sign in', exact: true }).click();
  await terminal.waitForURL('**/branch/**', { timeout: 60_000 });
  record('branch account signed in', true, { sw: await waitForController(terminal) });

  const adminCtx = await openProfile('p67-admin');
  const admin = adminCtx.pages()[0] ?? (await adminCtx.newPage());
  await login(admin, 'admin');
  record('admin signed in', true, { sw: await waitForController(admin) });

  // ---- Settings wording no longer says delete destroys records.
  await admin.goto(`${WEB}/admin/branches/${target.branch.id}`);
  await admin.getByRole('tab', { name: 'Settings' }).click();
  const settingsText = await admin.locator('main').innerText();
  check('settings: delete text says history is kept', /history are kept under its name/i.test(settingsText) && !/all of its data/i.test(settingsText));

  // ---- Blocked branch: instructions, no delete.
  let dialog = await openDelete(admin, blocked.branch.id);
  await dialog.getByText(/can’t be deleted yet/).waitFor({ timeout: 20_000 });
  check('blocked: open shift instruction shown', await dialog.getByText(/Close every open shift and count its cash/).isVisible());
  check('blocked: no delete button', (await dialog.getByRole('button', { name: /permanently delete branch/i }).count()) === 0);
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  check('blocked: branch still exists', (await prisma.branch.findUnique({ where: { id: blocked.branch.id } })) !== null);

  // ---- Deletable branch at phone width: wording, gating, cancel.
  await admin.setViewportSize({ width: 390, height: 844 });
  dialog = await openDelete(admin, target.branch.id);
  await dialog.getByRole('heading', { name: `Permanently delete ${target.branch.name}?` }).waitFor({ timeout: 20_000 });
  const text = await dialog.innerText();
  await dumpAria(admin, 'p67-dialog');
  await shot(admin, 'p67-dialog-phone');
  check('dialog: names branch and code', text.includes(target.branch.name) && text.includes(target.branch.code));
  check('dialog: irreversible warning', /can’t be undone in the application/.test(text));
  check('dialog: says history stays, with counts', /Kept, under this branch’s name and code/.test(text) && /1 sale/.test(text) && /1 expense/.test(text));
  check('dialog: lists the branch login account removed', /branch login account/.test(text));
  check('dialog: no horizontal scroll at 390', await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  const button = dialog.getByRole('button', { name: /permanently delete branch/i });
  check('gating: disabled before typing', await button.isDisabled());
  await dialog.getByLabel(/branch name/i).fill(target.branch.name.toLowerCase());
  await dialog.getByLabel(/branch code/i).fill(target.branch.code.toLowerCase());
  await dialog.getByRole('checkbox').click();
  check('gating: wrong-case code keeps it disabled', await button.isDisabled());
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await sleep(500);
  check('cancel: branch still exists and nothing changed', (await prisma.branch.findUnique({ where: { id: target.branch.id } })) !== null);
  await admin.setViewportSize({ width: 1366, height: 900 });

  // ---- Delete.
  dialog = await openDelete(admin, target.branch.id);
  await dialog.getByLabel(/branch name/i).waitFor({ timeout: 20_000 });
  await dialog.getByLabel(/branch name/i).fill(`  ${target.branch.name.toUpperCase()} `);
  await dialog.getByLabel(/branch code/i).fill(target.branch.code);
  await dialog.getByRole('checkbox').click();
  check('gating: case-insensitive name + exact code enables delete', await dialog.getByRole('button', { name: /permanently delete branch/i }).isEnabled());
  const deleteRequests = [];
  admin.on('request', (request) => {
    if (request.method() === 'DELETE' && new URL(request.url()).pathname === `/api/branches/${target.branch.id}`) deleteRequests.push(request.url());
  });
  await dialog.getByRole('button', { name: /permanently delete branch/i }).dblclick();
  await admin.waitForURL('**/admin/branches', { timeout: 30_000 });
  await sleep(1000);
  check('double click sends one delete request', deleteRequests.length === 1, { requests: deleteRequests.length });
  check('branch row physically absent', (await prisma.branch.findUnique({ where: { id: target.branch.id } })) === null);
  const recordRow = await prisma.branchRecord.findUnique({ where: { id: target.branch.id } });
  check('branch record kept with original name/code, marked deleted', recordRow?.name === target.branch.name && recordRow?.code === target.branch.code && recordRow?.deletedAt !== null);
  const after = await counts(target.branch.id);
  check('history counts unchanged', JSON.stringify(after) === JSON.stringify(before), { before, after });
  const sale = await prisma.transaction.findUniqueOrThrow({ where: { id: target.sale.id }, include: { branch: true } });
  check('sale amount and branch name kept', Number(sale.totalAmount) === 250 && sale.branch.name === target.branch.name);
  check('branch login account deleted', (await prisma.user.findUnique({ where: { id: target.account.id } })) === null);
  check('staff account kept, without this branch', (await prisma.user.findUnique({ where: { id: target.staff.id } })) !== null && (await prisma.userBranchAssignment.count({ where: { branchId: target.branch.id } })) === 0);
  const listText = await admin.locator('main').innerText();
  check('branch list no longer shows it', !listText.includes(target.branch.name));

  // ---- The branch's open terminal browser is signed out; re-login refused.
  await terminal.reload().catch(() => {});
  await terminal.waitForURL('**/login**', { timeout: 60_000 }).catch(() => {});
  check('branch terminal lands on /login', new URL(terminal.url()).pathname.startsWith('/login'), { url: terminal.url() });
  await terminal.getByLabel('Email').fill(target.email);
  await terminal.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await terminal.getByRole('button', { name: 'Sign in', exact: true }).click();
  await sleep(3000);
  check('re-login refused', new URL(terminal.url()).pathname.startsWith('/login'));

  // ---- History still visible to the Admin, under the deleted branch's name.
  await admin.goto(`${WEB}/admin/expenses`);
  await admin.waitForLoadState('networkidle').catch(() => {});
  await sleep(2000);
  const expensesText = await admin.locator('main').innerText();
  await shot(admin, 'p67-admin-expenses');
  check('Admin expenses still list the deleted branch expense', expensesText.includes(`P67 history expense ${RUN}`) || expensesText.includes(target.branch.name), {});
  await admin.goto(`${WEB}/admin/reports?tab=ATTENDANCE_RECORDS`);
  await admin.waitForLoadState('networkidle').catch(() => {});
  await sleep(2000);
  const attendanceText = await admin.locator('main').innerText();
  await shot(admin, 'p67-admin-attendance');
  check('Admin attendance records still name the deleted branch', attendanceText.includes(target.branch.name));

  await Promise.all([branchCtx.close(), adminCtx.close()]);
  await prisma.$disconnect();
  return saveResults('p67-branch-delete');
}

main()
  .then((failed) => {
    process.exitCode = failed > 0 ? 1 : 0;
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect().catch(() => {});
    process.exitCode = 1;
  });
