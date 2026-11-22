// POS-PERF-P68 — branch email reuse, Force Delete and branch-scoped staff, on the
// LOCAL P62 stack (production builds, service worker active). LOCAL ONLY:
// ../p62/lib.mjs refuses a non-localhost web URL and ../p62/db.mjs a non-local
// p62_* database. Chromium emulation (desktop 1366, phone 390), not real
// devices. Every row it creates is its own fixture in that local database.
//
//   node tests/e2e/manual/p68/lifecycle.mjs
import { createRequire } from 'node:module';
import { WEB, check, record, saveResults, openProfile, login, waitForController, shot, sleep } from '../p62/lib.mjs';
import { prisma } from '../p62/db.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const bcrypt = require('bcrypt');

const RUN = Date.now().toString(36);
const PASSWORD = 'P68-Branch!pass1';
const HOUR = 3600_000;

async function blockedBranch() {
  const branch = await prisma.branch.create({ data: { name: `P68 Busy ${RUN}`, code: `P68B-${RUN}`, address: '1 Busy St', city: 'Testville', status: 'active' } });
  const staff = await prisma.user.create({ data: { role: 'staff', firstName: 'Bea', lastName: `Busy${RUN}`, employmentType: 'regular', mustChangePassword: false } });
  await prisma.userBranchAssignment.create({ data: { userId: staff.id, branchId: branch.id } });
  const shift = await prisma.shift.create({ data: { branchId: branch.id, cashierId: staff.id, openedBy: staff.id, status: 'active', openingCashAmount: 300, startedAt: new Date(Date.now() - HOUR) } });
  await prisma.attendanceRecord.create({ data: { employeeId: staff.id, branchId: branch.id, clockInServerTime: new Date(Date.now() - 2 * HOUR), clockInGpsStatus: 'within_radius' } });
  const item = await prisma.inventoryItem.findFirstOrThrow({});
  await prisma.inventoryStock.upsert({
    where: { branchId_inventoryItemId: { branchId: branch.id, inventoryItemId: item.id } },
    create: { branchId: branch.id, inventoryItemId: item.id, quantityOnHand: 7 },
    update: { quantityOnHand: 7 },
  });
  const sale = await prisma.transaction.create({
    data: { transactionNumber: `P68-B-${RUN}`, branchId: branch.id, shiftId: shift.id, cashierId: staff.id, status: 'completed', paymentMethod: 'cash', subtotal: 80, vatAmount: 0, totalAmount: 80 },
  });
  return { branch, staff, shift, sale };
}

async function createBranchViaUi(page, name, email) {
  await page.goto(`${WEB}/admin/branches`);
  await page.getByRole('button', { name: 'Create Branch' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/branch name/i).fill(name);
  await dialog.getByLabel(/^city/i).fill('Testville');
  await dialog.getByLabel(/address/i).fill('12 Reuse Street');
  await dialog.getByLabel(/username/i).fill(email);
  await dialog.getByLabel(/^password/i).fill(PASSWORD);
  await dialog.getByLabel(/confirm password/i).fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create Branch' }).click();
  return dialog;
}

async function main() {
  const adminCtx = await openProfile('p68a');
  const admin = adminCtx.pages()[0] ?? (await adminCtx.newPage());
  await login(admin, 'admin');
  record('admin signed in', true, { sw: await waitForController(admin) });

  // ---------------- A: leftover email, field error, values kept
  const leftoverEmail = `p68-left-${RUN}@potatocorner.test`;
  const leftover = await prisma.user.create({
    data: { role: 'branch', email: leftoverEmail, passwordHash: await bcrypt.hash(PASSWORD, 12), firstName: '', lastName: '', employmentType: 'regular', mustChangePassword: false },
  });
  let dialog = await createBranchViaUi(admin, `P68 Blocked ${RUN}`, leftoverEmail.toUpperCase());
  await dialog.getByText(/leftover branch login/).waitFor({ timeout: 20_000 });
  check('A: leftover conflict shown beside Username with the account id', (await dialog.innerText()).includes(leftover.id));
  check('A: typed values kept', (await dialog.getByLabel(/branch name/i).inputValue()) === `P68 Blocked ${RUN}`);
  check('A: no branch created', (await prisma.branch.count({ where: { name: `P68 Blocked ${RUN}` } })) === 0);
  check('A: leftover not auto-deleted', (await prisma.user.findUnique({ where: { id: leftover.id } })) !== null);
  await shot(admin, 'p68-create-conflict');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // ---------------- A: create, delete normally, recreate with the same email
  const reuseEmail = `p68-reuse-${RUN}@potatocorner.test`;
  dialog = await createBranchViaUi(admin, `P68 Reuse One ${RUN}`, reuseEmail);
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 });
  const first = await prisma.branch.findFirstOrThrow({ where: { name: `P68 Reuse One ${RUN}` } });
  const firstAccount = await prisma.user.findUniqueOrThrow({ where: { email: reuseEmail } });
  await admin.goto(`${WEB}/admin/branches/${first.id}`);
  await admin.getByRole('tab', { name: 'Settings' }).click();
  await admin.getByRole('button', { name: 'Permanently Delete Branch' }).click();
  dialog = admin.getByRole('dialog');
  await dialog.getByLabel(/branch name/i).waitFor({ timeout: 20_000 });
  await dialog.getByLabel(/branch name/i).fill(first.name);
  await dialog.getByLabel(/branch code/i).fill(first.code);
  await dialog.getByRole('checkbox').click();
  await dialog.getByRole('button', { name: /permanently delete branch/i }).click();
  await admin.waitForURL('**/admin/branches', { timeout: 30_000 });
  dialog = await createBranchViaUi(admin, `P68 Reuse Two ${RUN}`, reuseEmail);
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 });
  const secondAccount = await prisma.user.findUnique({ where: { email: reuseEmail }, include: { branchAssignments: true } });
  const second = await prisma.branch.findFirst({ where: { name: `P68 Reuse Two ${RUN}` } });
  check('A: same email reused after delete, new account id', Boolean(secondAccount) && secondAccount.id !== firstAccount.id);
  check('A: new account is only on the new branch', secondAccount?.branchAssignments.length === 1 && secondAccount.branchAssignments[0].branchId === second?.id);

  // ---------------- B: Force Delete from the blocked Delete dialog
  const busy = await blockedBranch();
  await admin.goto(`${WEB}/admin/branches/${busy.branch.id}`);
  await admin.getByRole('tab', { name: 'Settings' }).click();
  await admin.getByRole('button', { name: 'Permanently Delete Branch' }).click();
  dialog = admin.getByRole('dialog');
  await dialog.getByText(/can’t be deleted yet/).waitFor({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Force Delete Branch…' }).click();
  dialog = admin.getByRole('dialog');
  await dialog.getByRole('heading', { name: `Force delete ${busy.branch.name}?` }).waitFor({ timeout: 20_000 });
  await admin.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  const text = await dialog.innerText();
  await shot(admin, 'p68-force-dialog-phone');
  check('B: dialog names branch and code', text.includes(busy.branch.name) && text.includes(busy.branch.code));
  check('B: lists open shift, clock-in and stock with outcomes', /open shift/.test(text) && /open attendance/.test(text) && /stock balance/.test(text) && /NOT zeroed/.test(text));
  check('B: states the offline limit', /cannot see or delete sales queued/.test(text));
  check('B: no horizontal scroll at 390', await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  const forceButton = dialog.getByRole('button', { name: /force delete branch/i });
  check('B: disabled before confirming', await forceButton.isDisabled());
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await sleep(500);
  check('B: cancel changed nothing', (await prisma.branch.findUnique({ where: { id: busy.branch.id } }))?.deletionFencedAt === null && (await prisma.branchDeletionOperation.count({ where: { branchId: busy.branch.id } })) === 0);
  await admin.setViewportSize({ width: 1366, height: 900 });

  await admin.goto(`${WEB}/admin/branches/${busy.branch.id}`);
  await admin.getByRole('tab', { name: 'Settings' }).click();
  await admin.getByRole('button', { name: 'Permanently Delete Branch' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Force Delete Branch…' }).click();
  dialog = admin.getByRole('dialog');
  await dialog.getByLabel(/branch name/i).waitFor({ timeout: 20_000 });
  await dialog.getByLabel(/branch name/i).fill(busy.branch.name);
  await dialog.getByLabel(/branch code/i).fill(busy.branch.code);
  await dialog.getByRole('checkbox').click();
  const posts = [];
  admin.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === `/api/branches/${busy.branch.id}/force-delete`) posts.push(r.url());
  });
  await dialog.getByRole('button', { name: /force delete branch/i }).dblclick();
  await admin.waitForURL('**/admin/branches', { timeout: 60_000 });
  await sleep(800);
  check('B: double click sends one request', posts.length === 1, { posts: posts.length });
  const op = await prisma.branchDeletionOperation.findFirst({ where: { branchId: busy.branch.id } });
  check('B: operation completed', op?.status === 'completed');
  check('B: branch row gone, record kept', (await prisma.branch.findUnique({ where: { id: busy.branch.id } })) === null && (await prisma.branchRecord.findUnique({ where: { id: busy.branch.id } }))?.deletedAt !== null);
  const shift = await prisma.shift.findUniqueOrThrow({ where: { id: busy.shift.id } });
  check('B: shift terminated, no cash count invented', shift.status === 'terminated' && shift.closingCashAmount === null && shift.closedAt === null);
  check('B: sale kept with its amount', Number((await prisma.transaction.findUniqueOrThrow({ where: { id: busy.sale.id } })).totalAmount) === 80);

  await admin.goto(`${WEB}/admin/branches/closure-items`);
  await admin.getByTestId('closure-items').waitFor({ timeout: 20_000 });
  const closureText = await admin.locator('main').innerText();
  await shot(admin, 'p68-closure-items');
  check('B: unresolved items listed under the deleted branch', closureText.includes(busy.branch.name) && /open shift/.test(closureText) && /stock balance/.test(closureText));
  await admin.getByRole('button', { name: 'Mark reconciled' }).first().click();
  await admin.getByRole('dialog').getByLabel('How was it settled?').fill('Counted on site by the owner');
  await admin.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await sleep(1500);
  check('B: one item reconciled with note and actor', (await prisma.branchClosureItem.count({ where: { branchId: busy.branch.id, reconciledAt: { not: null }, reconciliationNote: 'Counted on site by the owner' } })) === 1);

  // ---------------- C: supervisor staff list scoped to the selected branch
  const supCtx = await openProfile('p68s');
  const sup = supCtx.pages()[0] ?? (await supCtx.newPage());
  await login(sup, 'supervisor');
  record('supervisor signed in', true, { sw: await waitForController(sup) });
  await sup.goto(`${WEB}/supervisor/employees`);
  await sup.getByRole('heading', { name: 'Branch Staff' }).waitFor({ timeout: 30_000 });
  await sleep(1500);
  const supervisor = await prisma.user.findFirstOrThrow({ where: { email: 'supervisor@potatocorner.test' } });
  const listText = await sup.locator('main').innerText();
  check('C: the supervisor’s own row is not listed as staff', !listText.includes(`${supervisor.firstName} ${supervisor.lastName}`));
  // Waits: the total appears once the selected branch's list has loaded (it is hidden while a switch loads).
  check('C: staff total shown', await sup.getByTestId('staff-total').waitFor({ timeout: 15_000 }).then(() => true, () => false));
  await sup.getByRole('button', { name: 'Create Employee' }).click();
  const createDialog = sup.getByRole('dialog');
  await createDialog.getByLabel(/first name/i).fill('Pia');
  await createDialog.getByLabel(/last name/i).fill(`New${RUN}`);
  const position = createDialog.getByLabel(/position/i);
  if (await position.count()) await position.fill('Cashier');
  await createDialog.locator('button[type=submit]').click();
  await sup.getByText(`Pia New${RUN}`).waitFor({ timeout: 30_000 });
  const row = sup.getByRole('row').filter({ hasText: `Pia New${RUN}` });
  await row.getByText('No PIN').waitFor({ timeout: 20_000 });
  check('C: new staff appears at once with No PIN and Set PIN', (await row.getByRole('button', { name: `Set PIN for Pia New${RUN}` }).count()) === 1);
  check('C: Edit, Status and Delete offered', (await row.getByRole('button', { name: `Edit Pia New${RUN}` }).count()) === 1 && (await row.getByRole('button', { name: `Delete Pia New${RUN} permanently` }).count()) === 1);
  const created = await prisma.user.findFirstOrThrow({ where: { firstName: 'Pia', lastName: `New${RUN}` }, include: { branchAssignments: true } });
  check('C: created as STAFF on exactly one branch', created.role === 'staff' && created.branchAssignments.length === 1);
  await shot(sup, 'p68-staff-list');

  await Promise.all([adminCtx.close(), supCtx.close()]);
  await prisma.$disconnect();
  return saveResults('p68-lifecycle');
}

main()
  .then((failed) => {
    process.exitCode = failed > 0 ? 1 : 0;
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect().catch(() => {});
    // A failed step must not leave browsers (and this process) running.
    process.exit(1);
  });
