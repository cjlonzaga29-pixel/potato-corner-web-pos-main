// POS-PERF-P40 — Admin management and downloads in a real browser, against
// local `pos_verify` + local Supabase storage, with a built apps/api (:4000)
// and apps/web (:3000). Seeds its own branches, supervisors, attendance,
// transactions, proof photos and notifications (fixtures/p40-admin-fixtures.cjs).
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedGet, authedPost } from './fixtures/api-helpers';

test.describe.configure({ mode: 'serial' });
test.setTimeout(600_000);

const suffix = Date.now().toString(36).slice(-6);
const OUT = path.join(__dirname, '..', '..', '.p39-local', 'p40');
fs.mkdirSync(OUT, { recursive: true });

interface Seed {
  branches: { a: string; b: string; c: string };
  names: { a: string; b: string; c: string };
  supervisors: { s1: string; s2: string };
  accountEmail: string;
  attendance: { overnight: string; closed: string };
  proof: { paymentKey: string; discountKey: string; bytes: number };
  pwdReceipt: string;
}
let seed: Seed;

function fixture(args: string[]): string {
  return execFileSync(process.execPath, [path.join(__dirname, 'fixtures', 'p40-admin-fixtures.cjs'), ...args], {
    cwd: path.join(__dirname, '..', '..', 'apps', 'api'),
    encoding: 'utf-8',
  }).trim();
}

// apps/api's global limiter: 100 requests/minute per IP; every local request shares 127.0.0.1.
const waitOutRateLimitWindow = () => new Promise((resolve) => setTimeout(resolve, 61_000));

async function login(page: Page, email: string, password: string, dashboard: string, heading: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(`**${dashboard}`);
  await expect(page.getByRole('heading', { name: heading })).toBeVisible({ timeout: 30_000 });
}

const loginAdmin = (page: Page) => login(page, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password, '/admin/dashboard', 'Super Admin Dashboard');

async function nav(page: Page, label: string, urlGlob: string) {
  await page.getByRole('navigation').getByRole('link', { name: label, exact: true }).click();
  await page.waitForURL(urlGlob);
}

async function noHorizontalPageScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.beforeAll(() => {
  seed = JSON.parse(fixture(['seed', suffix])) as Seed;
  fixture(['notify', TEST_USERS.super_admin.email, seed.branches.a, seed.names.a]);
});

test('dashboard: removed sections, labelled Branch Performance, separate status and connection', async ({ page }) => {
  await loginAdmin(page);
  for (const removed of ['Low Stock Inventory', 'Low Stock Summary', 'Recent Activity']) {
    await expect(page.getByText(removed, { exact: true })).toHaveCount(0);
  }
  const perf = page.locator('div', { has: page.getByText('Branch Performance', { exact: true }) }).filter({ has: page.getByRole('table') }).last();
  await expect(perf.getByText(/Today, \d{4}-\d{2}-\d{2} \(Manila\) · All branches/)).toBeVisible({ timeout: 30_000 });
  for (const header of ['Branch', 'Status', 'Connection', 'Gross Sales', 'Transactions', 'Clocked In']) {
    await expect(perf.getByRole('columnheader', { name: header, exact: true })).toBeVisible();
  }
  const rowA = perf.getByRole('row').filter({ hasText: seed.names.a });
  // Gross sales = subtotal of the 32 completed sales (₱100 each), the same figure the KPI row sums.
  await expect(rowA.getByRole('cell').nth(3)).toHaveText('₱3,200.00', { timeout: 30_000 }); // stats load after the branch list; rows sit under a spinner until then
  await expect(rowA.getByRole('cell').nth(4)).toHaveText('32');
  const rowC = perf.getByRole('row').filter({ hasText: seed.names.c });
  await expect(rowC).toContainText(/inactive/i);
  await expect(rowC.getByRole('cell').nth(3)).toHaveText('—');
  await expect(page.getByText('Branch Status', { exact: true })).toBeVisible();
  await expect(page.getByText('Closed', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'dashboard-desktop.png'), fullPage: true });
});

test('branches: one nav entry, compact list, Manage panel, old URLs, keyboard', async ({ page }) => {
  await waitOutRateLimitWindow();
  await loginAdmin(page);
  const sidebar = page.getByRole('navigation');
  await expect(sidebar.getByRole('link', { name: 'Branches', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Supervisors', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Branch Accounts' })).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: 'Employees' })).toHaveCount(0);

  // Old Branch Accounts URL lands on the combined screen.
  await page.goto('/admin/branch-accounts');
  await page.waitForURL('**/admin/branches');
  await expect(page.getByRole('heading', { name: 'Branches', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder('Search name or code...').fill(suffix);
  for (const header of ['Branch', 'Status', 'Assigned Supervisors', 'Branch Account']) {
    await expect(page.getByRole('columnheader', { name: header, exact: true })).toBeVisible();
  }
  const rowA = page.getByRole('row').filter({ hasText: seed.names.a });
  const rowB = page.getByRole('row').filter({ hasText: seed.names.b });
  await expect(rowA).toContainText(seed.accountEmail, { timeout: 15_000 });
  await expect(rowA).toContainText(`P40SupOne ${suffix}`);
  await expect(rowB).toContainText('Not set up');
  await expect(rowB).toContainText(`P40SupTwo ${suffix}`);
  await page.screenshot({ path: path.join(OUT, 'branches-desktop.png'), fullPage: true });

  // Manage → keyboard-navigable tabs; passwords never displayed.
  await rowA.getByRole('button', { name: `Manage ${seed.names.a}` }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('heading', { name: seed.names.a })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`manage=${seed.branches.a}&tab=details`));
  await panel.getByRole('tab', { name: 'Details' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(panel.getByRole('tab', { name: 'Account' })).toHaveAttribute('data-state', 'active');
  await expect(panel.getByText(seed.accountEmail)).toBeVisible();
  await expect(panel.getByText(/P40Password/)).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(panel.getByText(`P40SupOne ${suffix}`)).toBeVisible();
  // Staff and the branch login account are assigned to A too, but are not supervisors.
  await expect(panel.getByText(`P40StaffA ${suffix}`)).toHaveCount(0);
  await expect(panel.getByText(seed.accountEmail)).toHaveCount(0);
  await page.screenshot({ path: path.join(OUT, 'branch-manage-panel.png') });
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page).not.toHaveURL(/manage=/);

  // A branch without an account: create one from the Account tab.
  await rowB.getByRole('button', { name: `Manage ${seed.names.b}` }).click();
  await page.getByRole('dialog').getByRole('tab', { name: 'Account' }).click();
  await page.getByRole('button', { name: 'Create branch account' }).click();
  const create = page.getByRole('dialog', { name: 'Create branch account' });
  const newAccount = `p40-newacct-${suffix}@test.local`;
  await create.getByLabel('Username (email)').fill(newAccount);
  // Required fields render as "Password*" / "Confirm password*".
  await create.getByRole('textbox', { name: /^Password\*?$/ }).fill('P40Branch!Pass1');
  await create.getByRole('textbox', { name: /^Confirm password\*?$/ }).fill('P40Branch!Pass1');
  await create.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('dialog').getByText(newAccount)).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(rowB).toContainText(newAccount, { timeout: 15_000 });

  // Deep link from a notification opens the right tab.
  await page.goto(`/admin/branches?manage=${seed.branches.c}&tab=supervisors`);
  await expect(page.getByRole('dialog').getByRole('tab', { name: 'Supervisors' })).toHaveAttribute('data-state', 'active', { timeout: 30_000 });
  await expect(page.getByRole('dialog').getByText('No supervisors assigned')).toBeVisible();
});

test('supervisors: renamed page, supervisor-only provisioning enforced server-side', async ({ page, request, baseURL }) => {
  await waitOutRateLimitWindow();
  await loginAdmin(page);
  await page.goto('/admin/employees');
  await page.waitForURL('**/admin/supervisors');
  await expect(page.getByRole('heading', { name: 'Supervisors', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Add Supervisor' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Supervisor' });
  await expect(dialog.getByText('Role', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('First Name').fill('P40New');
  await dialog.getByLabel('Last Name').fill(`Sup${suffix}`);
  await dialog.getByLabel('Email').fill(`p40-newsup-${suffix}@test.local`);
  await dialog.getByLabel('Password').fill('P40Super!Pass1');
  await dialog.getByRole('checkbox').first().check();
  await dialog.getByRole('button', { name: 'Add Supervisor' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await page.getByPlaceholder('Search name, email, or ID...').fill(`Sup${suffix}`);
  await expect(page.getByRole('row').filter({ hasText: `p40-newsup-${suffix}@test.local` })).toBeVisible({ timeout: 15_000 });

  const api = 'http://localhost:4000';
  const { accessToken } = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const base = { first_name: 'Bad', last_name: 'Role', employment_type: 'regular', branch_ids: [seed.branches.a], position: 'Cashier' };
  const asStaff = await authedPost(request, baseURL ?? api, `${api}/api/employees/supervisors`, accessToken, { ...base, role: 'staff' });
  expect(asStaff.status).toBe(422);
  const asBranch = await authedPost(request, baseURL ?? api, `${api}/api/employees/supervisors`, accessToken, {
    ...base,
    role: 'branch',
    email: `p40-bad-${suffix}@test.local`,
    initial_password: 'P40Bad!Pass1',
  });
  expect(asBranch.status).toBe(422);
});

test('attendance: supervisor scope, overnight open shift, Manila times, dashboard reconciliation', async ({ page }) => {
  await waitOutRateLimitWindow();
  await loginAdmin(page);
  await nav(page, 'Attendance', '**/admin/attendance');
  await expect(page.getByRole('heading', { name: 'Attendance Monitoring' })).toBeVisible({ timeout: 30_000 });

  await page.getByLabel('Supervisor').click();
  await page.getByRole('option', { name: `P40SupTwo ${suffix}` }).click();
  await expect(page.getByText(`P40SupTwo ${suffix}'s current branches (${seed.names.b})`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('row').filter({ hasText: `P40StaffB ${suffix}` })).toHaveCount(1);
  await expect(page.getByRole('row').filter({ hasText: `P40StaffA ${suffix}` })).toHaveCount(0);

  await page.getByLabel('Supervisor').click();
  await page.getByRole('option', { name: `P40SupOne ${suffix}` }).click();
  await page.getByRole('button', { name: 'Clocked in now' }).click();
  const overnight = page.getByRole('row').filter({ hasText: `P40StaffA ${suffix}` });
  await expect(overnight).toHaveCount(1, { timeout: 15_000 });
  await expect(overnight).toContainText(/Stale open shift|Still clocked in/);
  await expect(overnight).toContainText(/(AM|PM)/);

  // Reconciliation note shows only without a supervisor filter.
  await page.getByLabel('Supervisor').click();
  await page.getByRole('option', { name: 'Any supervisor' }).click();
  await page.getByLabel('Branch').click();
  await page.getByRole('option', { name: seed.names.a }).click();
  await expect(page.getByText(/Dashboard "Staff Clocked In" for this scope: 1\. Of the open records on this page, 1 count toward it and 0 do not/)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(OUT, 'attendance-open-now.png'), fullPage: true });

  // By date (today) does not list yesterday's still-open overnight shift; the open view does.
  await page.getByRole('button', { name: 'By date' }).click();
  await expect(page.getByText(/to .* \(by clock-in, Manila time\)/)).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: `P40StaffA ${suffix}` })).toHaveCount(0, { timeout: 15_000 });
});

test('reports: wide transaction panel, server pagination, PDF downloads, proof photos', async ({ page }) => {
  await waitOutRateLimitWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  await page.goto('/admin/reports?tab=DAILY_SALES');
  await page.getByLabel('Branch').click();
  await page.getByRole('option', { name: seed.names.a }).click();
  const dailyRow = page.getByRole('row').filter({ hasText: seed.names.a }).first();
  await dailyRow.getByRole('button', { name: 'View Transactions' }).click();

  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('32 transactions match the filters below.')).toBeVisible({ timeout: 30_000 });
  const width = await sheet.evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(1200);
  // Receipt number and cashier never wrap.
  const receiptCell = sheet.getByText(/PC-P40.*-0000\d\d/).first();
  const lineHeight = await receiptCell.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 20);
  expect((await receiptCell.boundingBox())?.height ?? 0).toBeLessThan(lineHeight * 1.6);
  await page.screenshot({ path: path.join(OUT, 'transactions-panel-desktop.png') });

  // Server-side pagination reaches rows beyond the first 25.
  await sheet.getByRole('button', { name: /next page/i }).click();
  await expect(sheet.getByRole('row')).toHaveCount(8, { timeout: 15_000 }); // header + 7

  // Filtered-set PDF.
  const filteredDownload = page.waitForEvent('download');
  await sheet.getByRole('button', { name: 'Download PDF (32 matching)' }).click();
  const filtered = await filteredDownload;
  const filteredPath = path.join(OUT, filtered.suggestedFilename());
  await filtered.saveAs(filteredPath);
  expect(filtered.suggestedFilename()).toMatch(/^transactions-filtered-.*\.pdf$/);
  expect(fs.readFileSync(filteredPath).subarray(0, 5).toString('latin1')).toBe('%PDF-');

  // Search narrows server-side; single-transaction PDF.
  await sheet.getByLabel('Receipt Number').fill(seed.pwdReceipt);
  await expect(sheet.getByText('1 transaction match the filters below.')).toBeVisible({ timeout: 15_000 });
  const singleDownload = page.waitForEvent('download');
  await sheet.getByRole('button', { name: `Download PDF of ${seed.pwdReceipt}` }).click();
  const single = await singleDownload;
  await single.saveAs(path.join(OUT, single.suggestedFilename()));
  expect(single.suggestedFilename()).toBe(`transactions-single-${seed.pwdReceipt}.pdf`);

  // Payment proof: view, then download the actual bytes.
  const pwdRow = sheet.getByRole('row').filter({ hasText: seed.pwdReceipt });
  await pwdRow.getByRole('button', { name: 'View Proof' }).first().click();
  const proof = page.getByRole('dialog', { name: 'Payment Proof' });
  await expect(proof.getByRole('img', { name: 'Payment proof' })).toBeVisible({ timeout: 15_000 });
  const photoDownload = page.waitForEvent('download');
  await proof.getByRole('button', { name: 'Download photo' }).click();
  const photo = await photoDownload;
  const photoPath = path.join(OUT, photo.suggestedFilename());
  await photo.saveAs(photoPath);
  expect(photo.suggestedFilename()).toBe(`payment-proof-${seed.pwdReceipt}.png`);
  const expected = fs.readFileSync(path.join(__dirname, 'fixtures', 'gcash-test.png'));
  expect(Buffer.compare(fs.readFileSync(photoPath), expected)).toBe(0);
  await page.keyboard.press('Escape');

  // Discount proof missing from storage: Storage refuses to sign a link for a
  // missing object, so the dialog shows its error state with a retry instead
  // of a broken image (no photo is invented).
  fixture(['remove-object', 'discount-proofs', seed.proof.discountKey]);
  await pwdRow.getByRole('button', { name: 'View Proof' }).last().click();
  const discount = page.getByRole('dialog', { name: 'Discount Proof' });
  await expect(discount.getByText('Failed to load the discount proof.')).toBeVisible({ timeout: 15_000 });
  await expect(discount.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(discount.getByRole('img', { name: 'Discount proof' })).toHaveCount(0);
  await page.screenshot({ path: path.join(OUT, 'discount-proof-unavailable.png') });
});

test('notifications: server unread count, grouping, recovery evidence, destination, mark all read', async ({ page }) => {
  await waitOutRateLimitWindow();
  await loginAdmin(page);
  const bell = page.getByRole('button', { name: /^Notifications, \d+ unread$/ });
  await expect(bell).toBeVisible({ timeout: 30_000 });
  await bell.click();
  const outage = page.getByRole('link', { name: /Branch Offline/ }).filter({ hasText: seed.names.a }).first();
  await expect(outage).toContainText('×2');
  await expect(outage).toContainText('No recovery received yet');
  await expect(page.getByRole('link', { name: /Branch Offline/ }).filter({ hasText: 'Back online' }).first()).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'notifications-panel.png') });

  await outage.click();
  await page.waitForURL(new RegExp(`/admin/branches\\?manage=${seed.branches.a}&tab=details`));
  await expect(page.getByRole('dialog').getByRole('heading', { name: seed.names.a })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /^Notifications/ }).click();
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible({ timeout: 15_000 });
});

test('work hours: supervisor edits only assigned branches; admin read-only; history untouched', async ({ page, request }) => {
  await waitOutRateLimitWindow();
  const before = fixture(['attendance', seed.attendance.closed]);
  await login(page, `p40-suptwo-${suffix}@test.local`, 'P40Password!1', '/supervisor/dashboard', 'Supervisor Dashboard');
  await nav(page, 'Settings', '**/supervisor/settings');
  const card = page.locator('div.rounded-md.border', { has: page.getByText(seed.names.b, { exact: true }) });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(seed.names.a, { exact: true })).toHaveCount(0);
  await card.getByRole('spinbutton').fill('9.5');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByText(/Branch setting · default for other branches is/)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(OUT, 'supervisor-work-hours.png'), fullPage: true });

  const api = 'http://localhost:4000';
  const { accessToken } = await apiLogin(request, `p40-suptwo-${suffix}@test.local`, 'P40Password!1');
  const other = await authedGet(request, `${api}/api/settings/work-hours/branches/${seed.branches.a}`, accessToken);
  expect(other.status).toBe(403);

  await waitOutRateLimitWindow();
  await loginAdmin(page);
  await page.goto('/admin/settings?tab=work-hours');
  const table = page.getByRole('table', { name: 'Regular work hours by branch' });
  await expect(table.getByRole('row').filter({ hasText: seed.names.b })).toContainText('Branch setting', { timeout: 30_000 });
  await expect(table.getByRole('row').filter({ hasText: seed.names.b })).toContainText('9.5');
  await expect(table.getByRole('row').filter({ hasText: seed.names.a })).toContainText('Default');
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  expect(fixture(['attendance', seed.attendance.closed])).toBe(before);
});

test('narrow viewport: branches, panel, attendance and transactions fit a phone', async ({ page }) => {
  await waitOutRateLimitWindow();
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAdmin(page);
  await page.goto('/admin/branches');
  await expect(page.getByRole('heading', { name: 'Branches', exact: true })).toBeVisible({ timeout: 30_000 });
  await noHorizontalPageScroll(page);
  await page.getByPlaceholder('Search name or code...').fill(suffix);
  await page.getByRole('button', { name: `Manage ${seed.names.a}` }).click();
  const panel = page.getByRole('dialog');
  const box = await panel.boundingBox();
  expect((box?.width ?? 999) <= 390).toBe(true);
  await expect(panel.getByRole('tab', { name: 'Supervisors' })).toBeInViewport();
  await page.screenshot({ path: path.join(OUT, 'branch-panel-phone.png') });
  await page.keyboard.press('Escape');

  await page.goto('/admin/attendance');
  await expect(page.getByRole('heading', { name: 'Attendance Monitoring' })).toBeVisible({ timeout: 30_000 });
  await noHorizontalPageScroll(page);
  await page.screenshot({ path: path.join(OUT, 'attendance-phone.png'), fullPage: true });

  await page.goto('/admin/supervisors');
  await expect(page.getByRole('heading', { name: 'Supervisors', exact: true })).toBeVisible({ timeout: 30_000 });
  await noHorizontalPageScroll(page);
});
