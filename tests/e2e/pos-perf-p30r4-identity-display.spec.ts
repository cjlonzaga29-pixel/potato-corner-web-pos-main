// POS-PERF-P30R4 — real-browser verification that the Responsible Staff /
// Identity Status display (introduced in commit 596fe11, fixed here for the
// legacy responsible_user_name fallback) renders correctly across the three
// components it touches: Inventory Approval Queue, Inventory Approval Detail
// Dialog, and the manual Stock Adjustments History. Follows the same
// persistent-context-per-role pattern as inventory-approval-cancellation.spec.ts
// (see that file's header comment for why contexts are reused, not recreated).
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedGet, authedPost } from './fixtures/api-helpers';
import { seedUniversalItem, UNIVERSAL_ITEM_FIXTURE } from './fixtures/seed-universal-item';

const NAV_TIMEOUT = 30_000;
const SALT = Math.floor(Math.random() * 9000) + 1000;
const Q_FOR_REVIEW = SALT + 1;
const Q_SUPERVISOR_DIRECT = SALT + 2;
const Q_LEGACY_ROW = SALT + 3;

let branchId: string;
let inventoryItemId: string;
let adminAccessToken: string;
let supervisorAccessToken: string;
let supervisorUserId: string;
let staffUserId: string;
let staffPin: string;

let branchContext: BrowserContext;
let branchPage: Page;
let supervisorContext: BrowserContext;
let supervisorPage: Page;

test.beforeAll(async ({ browser, request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  adminAccessToken = admin.accessToken;
  const branches = await authedGet<{ branches: { id: string; code: string }[] }>(request, '/api/branches', adminAccessToken);
  const branch = branches.data?.branches.find((b) => b.code === 'MAIN01');
  if (!branch) throw new Error('Seeded "Main Branch" (MAIN01) not found — run apps/api/prisma/seed.ts first');
  branchId = branch.id;

  const item = await seedUniversalItem(request, url, branchId);
  inventoryItemId = item.inventoryItemId;

  const supervisor = await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password);
  supervisorAccessToken = supervisor.accessToken;
  supervisorUserId = supervisor.userId;

  const staffLogin = await apiLogin(request, TEST_USERS.staff.email, TEST_USERS.staff.password);
  staffUserId = staffLogin.userId;
  staffPin = String(Math.floor(100000 + Math.random() * 900000));
  const pinResult = await authedPost(request, url, `/api/staff-pin/${staffLogin.userId}/pin`, adminAccessToken, { pin: staffPin });
  if (pinResult.status >= 300) throw new Error(`Failed to provision staff PIN: ${pinResult.status} ${JSON.stringify(pinResult.error)}`);

  // Also provision the supervisor's own PIN — needed for the "supervisor
  // direct recording / verifies themselves" case below.
  await authedPost(request, url, `/api/staff-pin/${supervisor.userId}/pin`, adminAccessToken, { pin: staffPin });

  branchContext = await browser.newContext({ storageState: path.join(__dirname, 'fixtures', 'branch.auth.json') });
  branchPage = await branchContext.newPage();
  supervisorContext = await browser.newContext({ storageState: path.join(__dirname, 'fixtures', 'supervisor.auth.json') });
  supervisorPage = await supervisorContext.newPage();
});

test.afterAll(async () => {
  await branchContext?.close();
  await supervisorContext?.close();
});

/**
 * isDirectRecord mirrors inventory-adjust-form.tsx's own role check
 * (supervisor/super_admin bypass Pending Review and write immediately,
 * labeled "Save Adjustment" instead of "Submit for Review" — both the
 * submit button AND its ConfirmDialog confirm button use that label).
 */
async function submitAdjustment(
  page: Page,
  basePath: string,
  quantityDelta: number,
  notes: string,
  pin: string,
  isDirectRecord: boolean,
): Promise<void> {
  const submitLabel = isDirectRecord ? 'Save Adjustment' : 'Submit for Review';
  await page.goto(`${basePath}/inventory/adjust`, { waitUntil: 'networkidle' });
  // Scoped to the "Select an item" placeholder specifically (not just the
  // first combobox on the page) — the Supervisor/Branch chrome's own branch
  // switcher in the sidebar can otherwise outrank the form's own item select.
  const itemTrigger = page.getByRole('combobox').filter({ hasText: 'Select an item' });
  await itemTrigger.waitFor({ state: 'visible', timeout: 15_000 });
  await itemTrigger.click();
  await page.getByRole('option', { name: new RegExp(UNIVERSAL_ITEM_FIXTURE.itemName) }).click();
  // Only rendered once the form's watched item resolves to a real stock row.
  await expect(page.getByText('Current stock:')).toBeVisible({ timeout: 10_000 });
  await page.getByLabel(/Quantity Change/).fill(String(quantityDelta));
  await page.getByLabel('Notes').fill(notes);

  const fixturePath = path.join(__dirname, 'fixtures', 'gcash-test.png');
  await page.getByRole('button', { name: 'Upload Photo' }).click();
  await page.locator('input[type="file"]').setInputFiles(fixturePath);
  await expect(page.getByText('Uploaded')).toBeVisible({ timeout: 15_000 });

  await page.getByPlaceholder('Enter 4-6 digit PIN').fill(pin);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText(/Verified —/)).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: submitLabel }).click();
  const confirmButton = page.getByRole('alertdialog').getByRole('button', { name: submitLabel });
  if (await confirmButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await confirmButton.click();
  }
}

/**
 * Navigates to the approvals queue's given tab and waits for the fixture
 * row to be visible, retrying through the API rate limiter exactly like
 * inventory-approval-cancellation.spec.ts's openRequestByQuantity. Returns
 * the located row WITHOUT clicking Review — callers that only need the
 * queue row for assertions must never click, since Review opens a
 * client-side dialog (not a navigation), and a stray goBack() afterward
 * would navigate real browser history instead of just closing it.
 */
async function locateApprovalRow(page: Page, basePath: string, status: 'PENDING' | 'APPROVED', quantityText: string) {
  const tabName = status === 'PENDING' ? 'Pending Review' : 'Approved';
  const row = page
    .getByRole('row')
    .filter({ hasText: UNIVERSAL_ITEM_FIXTURE.itemName })
    .filter({ has: page.getByText(quantityText, { exact: true }) })
    .first();

  for (let attempt = 0; attempt < 8; attempt++) {
    await page.goto(`${basePath}/inventory/approvals`, { waitUntil: 'networkidle' });
    const tab = page.getByRole('tab', { name: tabName });
    const tryAgain = page.getByRole('button', { name: 'Try again' });
    const outcome = await Promise.race([
      tab.waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'tab' as const),
      tryAgain.waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'error' as const),
    ]).catch(() => 'timeout' as const);
    if (outcome === 'error') {
      await page.waitForTimeout(8_000);
      continue;
    }
    if (outcome === 'timeout') continue;
    await tab.click();

    const rowOutcome = await Promise.race([
      row.waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'row' as const),
      tryAgain.waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'error' as const),
    ]).catch(() => 'timeout' as const);
    if (rowOutcome === 'row') break;
    if (rowOutcome === 'error') await page.waitForTimeout(8_000);
  }
  return row;
}

test.describe.serial('POS-PERF-P30R4 — Responsible Staff / Identity Status real-browser verification', () => {
  test.describe.configure({ timeout: 240_000 });

  test('Approval Queue + Detail Dialog: branch account submits for a different PIN-verified staff member', async ({ page: _page }) => {
    const consoleErrors: string[] = [];
    supervisorPage.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await submitAdjustment(branchPage, '/branch', Q_FOR_REVIEW, 'P30R4 browser test: staff-verified submission', staffPin, false);
    await expect(branchPage).toHaveURL(/\/branch\/inventory\/approvals/, { timeout: NAV_TIMEOUT });

    // Queue row: Submitted By (Account) vs Responsible Staff must be two
    // distinct, non-conflated values, and the badge must say PIN Verified.
    // Asserted BEFORE opening the dialog — Review opens a client-side modal,
    // not a navigation, so there is no "go back" to the list afterward.
    const row = await locateApprovalRow(supervisorPage, '/supervisor', 'PENDING', String(Q_FOR_REVIEW));
    await expect(row.getByText('Jenny Santos')).toBeVisible();
    await expect(row.getByText('PIN Verified')).toBeVisible();
    await expect(row).not.toContainText('Not recorded');

    await row.getByRole('button', { name: 'Review' }).click();
    const dialog = supervisorPage.getByRole('dialog');
    await expect(dialog.getByText('Responsible Staff')).toBeVisible();
    await expect(dialog.getByText('Jenny Santos')).toBeVisible();
    await expect(dialog.getByText('PIN Verified')).toBeVisible();
    // Identity Status timestamp renders next to the badge (formatDateTime output).
    await expect(dialog.getByText(/Identity Status/)).toBeVisible();

    await page_screenshot(supervisorPage, 'approval-detail-dialog-pin-verified');

    expect(consoleErrors.filter((e) => e.includes('cannot contain a nested'))).toHaveLength(0);

    await supervisorPage.getByRole('button', { name: 'Approve' }).click();
    await Promise.all([
      supervisorPage.waitForResponse((res) => /\/api\/inventory-approvals\/.+\/approve$/.test(res.url()) && res.request().method() === 'POST'),
      supervisorPage.getByRole('alertdialog').getByRole('button', { name: 'Approve' }).click(),
    ]);
  });

  test('Adjustment History: approved request and a supervisor direct-recorded adjustment both show correct identity', async () => {
    await submitAdjustment(supervisorPage, '/supervisor', Q_SUPERVISOR_DIRECT, 'P30R4 browser test: supervisor direct record', staffPin, true);
    // Supervisor role bypasses Pending Review — this lands directly on the
    // Adjustment History page's movements list, not the approvals queue.
    await expect(supervisorPage).toHaveURL(/\/supervisor\/inventory(?!\/)/, { timeout: NAV_TIMEOUT });

    await supervisorPage.goto('/supervisor/inventory/adjust', { waitUntil: 'networkidle' });
    await expect(supervisorPage.getByText('Adjustment History')).toBeVisible({ timeout: NAV_TIMEOUT });

    const approvedRow = supervisorPage.getByRole('row').filter({ hasText: String(Q_FOR_REVIEW) }).first();
    await expect(approvedRow.getByText('Jenny Santos')).toBeVisible({ timeout: NAV_TIMEOUT });
    await expect(approvedRow.getByText('PIN Verified')).toBeVisible();

    const directRow = supervisorPage.getByRole('row').filter({ hasText: String(Q_SUPERVISOR_DIRECT) }).first();
    await expect(directRow).toBeVisible();
    await expect(directRow.getByText('PIN Verified')).toBeVisible();

    await page_screenshot(supervisorPage, 'adjustment-history-desktop');

    await supervisorPage.setViewportSize({ width: 375, height: 800 });
    await supervisorPage.reload({ waitUntil: 'networkidle' });
    await expect(supervisorPage.getByText('Adjustment History')).toBeVisible({ timeout: NAV_TIMEOUT });
    await page_screenshot(supervisorPage, 'adjustment-history-narrow');
    await supervisorPage.setViewportSize({ width: 1280, height: 800 });
  });

  test('Adjustment History: a legacy pre-PIN row (responsible_user_id only) shows the preserved name as Not PIN verified, never "Not recorded"', async () => {
    // The current API has no write path that can ever produce a
    // responsible_user_id-only row anymore (every receive/adjust/waste route
    // now mandates a verified staff PIN) — this shape only exists in
    // pre-P29 production data, so it is seeded directly via Prisma against
    // apps/api's own workspace to reproduce it on this disposable local DB.
    execFileSync(
      process.execPath,
      [path.join(__dirname, 'fixtures', 'seed-legacy-movement.cjs'), branchId, inventoryItemId, String(Q_LEGACY_ROW), staffUserId],
      { cwd: path.join(__dirname, '..', '..', 'apps', 'api'), stdio: 'inherit' },
    );

    await supervisorPage.goto('/supervisor/inventory/adjust', { waitUntil: 'networkidle' });
    await expect(supervisorPage.getByText('Adjustment History')).toBeVisible({ timeout: NAV_TIMEOUT });

    const legacyRow = supervisorPage.getByRole('row').filter({ hasText: 'legacy pre-PIN row' }).first();
    await expect(legacyRow).toBeVisible({ timeout: NAV_TIMEOUT });
    // Both "Recorded By (Account)" and "Responsible Staff" show the same
    // name here (the seed fixture used the same user for both), so this
    // asserts on count rather than a single getByText match.
    await expect(legacyRow.getByText('Jenny Santos')).toHaveCount(2);
    await expect(legacyRow).not.toContainText('Not recorded');
    await expect(legacyRow.getByText('Not PIN verified')).toBeVisible();

    await page_screenshot(supervisorPage, 'adjustment-history-legacy-row');
  });
});

async function page_screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(__dirname, '..', '..', 'test-results', `${name}.png`), fullPage: true });
}
