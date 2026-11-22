// Account deletion releases the email for a fresh account, on the LOCAL P62 stack
// (production builds, service worker active). LOCAL ONLY: ../p62/lib.mjs refuses a
// non-localhost web URL and ../p62/db.mjs a non-local p62_* database. Chromium
// emulation, not real devices. Every row it creates is its own fixture.
//
//   node tests/e2e/manual/p70/email-reuse.mjs
import { createRequire } from 'node:module';
import { WEB, check, record, saveResults, openProfile, login, waitForController, shot, sleep } from '../p62/lib.mjs';
import { prisma } from '../p62/db.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const bcrypt = require('bcrypt');

const RUN = Date.now().toString(36);
const PASSWORD = 'P70-Reuse!pass1';
const EMAIL = `p70-reuse-${RUN}@potatocorner.test`;
const FIRST = 'Rosa';
const LAST = `Reuse${RUN}`;
const FULL = `${FIRST} ${LAST}`;

async function main() {
  const branch = await prisma.branch.findFirstOrThrow({ where: { status: 'active' }, orderBy: { createdAt: 'asc' } });
  const old = await prisma.user.create({
    data: { role: 'supervisor', email: EMAIL, passwordHash: await bcrypt.hash(PASSWORD, 12), firstName: FIRST, lastName: LAST, employmentType: 'regular', mustChangePassword: false },
  });
  await prisma.userBranchAssignment.create({ data: { userId: old.id, branchId: branch.id } });
  await prisma.expense.create({ data: { branchId: branch.id, category: 'supplies', amount: 77.5, incurredAt: new Date(), createdBy: old.id } });

  const ctx = await openProfile('p70a');
  const admin = ctx.pages()[0] ?? (await ctx.newPage());
  await login(admin, 'admin');
  record('admin signed in', true, { sw: await waitForController(admin) });

  // ---- Delete: the dialog explains permanence, history and email reuse.
  await admin.goto(`${WEB}/admin/supervisors`);
  await admin.waitForLoadState('networkidle').catch(() => {});
  await admin.getByRole('button', { name: `Delete ${FULL} permanently` }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByText(/This cannot be undone in the application/).waitFor({ timeout: 30_000 });
  check('dialog: permanent, history remains', (await dialog.getByText(/Past business records will remain/).count()) > 0);
  check('dialog: email released for a new account', (await dialog.getByText(`The email ${EMAIL} is released and can be used for a new account.`, { exact: false }).count()) > 0);
  check('dialog: new account starts fresh', (await dialog.getByText(/gets a new ID and none of this account’s past records, PIN, sessions or access/).count()) > 0);
  check('dialog: Inactive keeps the email', (await dialog.getByText(/the account keeps its email/).count()) > 0);
  await shot(admin, 'p70-delete-dialog');
  await dialog.getByLabel(/to confirm/i).fill(FULL);
  await dialog.getByRole('checkbox').click();
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  await admin.getByText('Account permanently deleted').waitFor({ timeout: 30_000 });
  check('database: old account gone, email free', (await prisma.user.count({ where: { email: { equals: EMAIL, mode: 'insensitive' } } })) === 0);

  // ---- Recreate with the same email in capitals through Add Supervisor.
  async function addSupervisor(email, first) {
    await admin.goto(`${WEB}/admin/supervisors`);
    await admin.waitForLoadState('networkidle').catch(() => {});
    await admin.getByRole('button', { name: 'Add Supervisor' }).click();
    const add = admin.getByRole('dialog');
    await add.getByLabel('First Name').fill(first);
    await add.getByLabel('Last Name').fill(LAST);
    await add.getByLabel('Email').fill(email);
    await add.getByLabel(/^Password/).fill(PASSWORD);
    await add.getByText(`${branch.name} (${branch.code})`).click();
    await add.getByRole('button', { name: 'Add Supervisor' }).click();
    await sleep(3000);
    return add;
  }
  await addSupervisor(EMAIL.toUpperCase(), 'Nora');
  const fresh = await prisma.user.findFirst({ where: { email: EMAIL }, include: { branchAssignments: true, pinCredentials: true, refreshTokens: true } });
  check('recreated: a NEW account id with the normalized email', Boolean(fresh) && fresh.id !== old.id, { fresh: fresh?.id });
  check('recreated: only the access just granted, no PIN or sessions', fresh?.branchAssignments.length === 1 && fresh.pinCredentials.length === 0 && fresh.refreshTokens.length === 0);
  const expense = await prisma.expense.findFirst({ where: { createdBy: old.id }, include: { creator: true } });
  check('history still attributed to the original person', expense?.creator.firstName === FIRST && expense.createdBy !== fresh?.id);

  // ---- A working account keeps its email.
  const dup = await addSupervisor(EMAIL, 'Dup');
  await shot(admin, 'p70-duplicate');
  check('duplicate email refused in the dialog', (await dup.getByText(/already exists|already in use/i).count()) > 0 || (await admin.getByText(/already exists|already in use/i).count()) > 0);
  check('database: still exactly one holder', (await prisma.user.count({ where: { email: { equals: EMAIL, mode: 'insensitive' } } })) === 1);

  await ctx.close();
}

main()
  .catch((error) => record('driver error', false, { error: String(error?.stack ?? error) }))
  .finally(async () => {
    await saveResults('p70-email-reuse');
    await prisma.$disconnect();
  });
