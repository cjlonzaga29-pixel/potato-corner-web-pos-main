// POS-PERF-P29 — real-browser coverage for the staff-PIN-verified
// receive/adjust/waste forms: item-lock on row-launched forms, PIN
// happy/wrong-PIN paths, and the missing-evidence submit block. Reuses the
// same seeded universal-inventory item/branch and persistent-context
// convention as inventory-approval-cancellation.spec.ts (see that file's
// header for why contexts are reused rather than re-logging-in per step).
import path from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedPost } from './fixtures/api-helpers';
import { seedUniversalItem, UNIVERSAL_ITEM_FIXTURE } from './fixtures/seed-universal-item';

const NAV_TIMEOUT = 60_000;

let branchId: string;
let inventoryItemId: string;
let staffPin: string;
let branchContext: BrowserContext;
let branchPage: Page;

test.beforeAll(async ({ browser, request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const branches = await request.get('/api/branches', { headers: { Authorization: `Bearer ${admin.accessToken}` } });
  const branchesBody = (await branches.json()) as { data: { branches: { id: string; code: string }[] } };
  const branch = branchesBody.data.branches.find((b) => b.code === 'MAIN01');
  if (!branch) throw new Error('Seeded "Main Branch" (MAIN01) not found — run apps/api/prisma/seed.ts first');
  branchId = branch.id;

  const item = await seedUniversalItem(request, url, branchId);
  inventoryItemId = item.inventoryItemId;

  const staffLogin = await apiLogin(request, TEST_USERS.staff.email, TEST_USERS.staff.password);
  staffPin = String(Math.floor(100000 + Math.random() * 900000));
  const pinResult = await authedPost(request, url, `/api/staff-pin/${staffLogin.userId}/pin`, admin.accessToken, { pin: staffPin });
  if (pinResult.status >= 300) throw new Error(`Failed to provision staff PIN: ${pinResult.status} ${JSON.stringify(pinResult.error)}`);

  // A fresh real UI login (not the shared branch.auth.json storageState) —
  // that static file's refresh_token cookie is single-use/rotating (see
  // inventory-approval-cancellation.spec.ts's header comment), and that
  // other spec file's own context already rotates it once it runs in the
  // same overall suite. A brand-new login here mints an independent,
  // not-yet-rotated token exclusively for this file's context.
  branchContext = await browser.newContext();
  branchPage = await branchContext.newPage();
  await branchPage.goto('/login');
  await branchPage.getByLabel('Email').fill(TEST_USERS.branch.email);
  await branchPage.getByRole('textbox', { name: 'Password' }).fill(TEST_USERS.branch.password);
  await branchPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await branchPage.waitForURL(`**${TEST_USERS.branch.dashboardPath}`);
});

test.afterAll(async () => {
  await branchContext?.close();
});

test.describe.serial('Staff-PIN-verified inventory operations — real browser', () => {
  test.describe.configure({ timeout: 120_000 });

  test('a row-launched waste form locks the item (no picker) instead of offering the Select', async () => {
    await branchPage.goto(`/branch/inventory/waste?inventory_item_id=${inventoryItemId}`, { waitUntil: 'networkidle' });
    // Locked display renders the item name/unit read-only; the Select combobox for Item must not be present.
    await expect(branchPage.getByText(UNIVERSAL_ITEM_FIXTURE.itemName)).toBeVisible({ timeout: NAV_TIMEOUT });
    await expect(branchPage.getByRole('combobox').filter({ hasText: UNIVERSAL_ITEM_FIXTURE.itemName })).toHaveCount(0);
  });

  test('an incorrect PIN is rejected with a generic error and never enables submit', async () => {
    await branchPage.goto(`/branch/inventory/waste?inventory_item_id=${inventoryItemId}`, { waitUntil: 'networkidle' });
    await branchPage.getByLabel(/Quantity Wasted/).fill('1');

    await branchPage.getByPlaceholder('Enter 4-6 digit PIN').fill('000000');
    await branchPage.getByRole('button', { name: 'Verify' }).click();
    await expect(branchPage.getByText('Invalid PIN')).toBeVisible({ timeout: 10_000 });

    await expect(branchPage.getByRole('button', { name: 'Submit for Review' })).toBeDisabled();
  });

  test('a correct PIN but missing evidence keeps submit blocked', async () => {
    await branchPage.goto(`/branch/inventory/waste?inventory_item_id=${inventoryItemId}`, { waitUntil: 'networkidle' });
    await branchPage.getByLabel(/Quantity Wasted/).fill('1');

    await branchPage.getByPlaceholder('Enter 4-6 digit PIN').fill(staffPin);
    await branchPage.getByRole('button', { name: 'Verify' }).click();
    await expect(branchPage.getByText(/Verified — Jenny Santos/)).toBeVisible({ timeout: 10_000 });

    // No evidence uploaded — submit must stay disabled even with a valid PIN token.
    await expect(branchPage.getByRole('button', { name: 'Submit for Review' })).toBeDisabled();
  });

  test('changing the draft after PIN verification clears the held token (fresh verification required)', async () => {
    await branchPage.goto(`/branch/inventory/waste?inventory_item_id=${inventoryItemId}`, { waitUntil: 'networkidle' });
    await branchPage.getByLabel(/Quantity Wasted/).fill('1');

    await branchPage.getByPlaceholder('Enter 4-6 digit PIN').fill(staffPin);
    await branchPage.getByRole('button', { name: 'Verify' }).click();
    await expect(branchPage.getByText(/Verified — Jenny Santos/)).toBeVisible({ timeout: 10_000 });

    // Changing the quantity after verification must drop back to the PIN entry field.
    await branchPage.getByLabel(/Quantity Wasted/).fill('2');
    await expect(branchPage.getByPlaceholder('Enter 4-6 digit PIN')).toBeVisible({ timeout: 10_000 });
  });

  test('waste with a verified PIN and uploaded evidence submits for review (branch actor)', async () => {
    await branchPage.goto(`/branch/inventory/waste?inventory_item_id=${inventoryItemId}`, { waitUntil: 'networkidle' });
    await branchPage.getByLabel(/Quantity Wasted/).fill('1');

    const fixturePath = path.join(__dirname, 'fixtures', 'gcash-test.png');
    await branchPage.getByRole('button', { name: 'Upload Photo' }).click();
    await branchPage.locator('input[type="file"]').setInputFiles(fixturePath);
    await expect(branchPage.getByText('Uploaded')).toBeVisible({ timeout: 15_000 });

    await branchPage.getByPlaceholder('Enter 4-6 digit PIN').fill(staffPin);
    await branchPage.getByRole('button', { name: 'Verify' }).click();
    await expect(branchPage.getByText(/Verified — Jenny Santos/)).toBeVisible({ timeout: 10_000 });

    const submitButton = branchPage.getByRole('button', { name: 'Submit for Review' });
    await expect(submitButton).toBeEnabled();
    await submitButton.click();
    await branchPage.getByRole('alertdialog').getByRole('button', { name: 'Submit for Review' }).click();
    await branchPage.waitForURL('**/branch/inventory/approvals', { timeout: NAV_TIMEOUT });
  });
});
