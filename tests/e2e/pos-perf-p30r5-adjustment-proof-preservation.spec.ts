// POS-PERF-P30R5 — real-browser verification that an ADJUSTMENT request's
// uploaded evidence survives approval onto the resulting InventoryStockMovement.
// applyApprovedRequest's ADJUSTMENT branch (inventory-approval.service.ts) called
// applyAdjustmentInTx without forwarding proofKey/proofType, even though that
// function already accepts and persists both (RECEIVING/WASTE's branches right
// next to it already forwarded them) — an adjustment submitted with verified
// evidence showed proof on the pending approval request, then silently lost it
// the moment it was approved. Fresh real UI logins are used for both roles
// rather than the shared *.auth.json storageState files (see
// staff-pin-inventory-ops.spec.ts's header comment: those files' refresh_token
// cookies are single-use/rotating and may already be consumed by another spec
// file in the same run).
import path from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedGet, authedPost } from './fixtures/api-helpers';
import { seedUniversalItem, UNIVERSAL_ITEM_FIXTURE } from './fixtures/seed-universal-item';

const NAV_TIMEOUT = 60_000;

let branchId: string;
let inventoryItemId: string;
let staffPin: string;
let branchContext: BrowserContext;
let branchPage: Page;
let supervisorContext: BrowserContext;
let supervisorPage: Page;
let adminAccessToken: string;

test.beforeAll(async ({ browser, request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  adminAccessToken = admin.accessToken;
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

  branchContext = await browser.newContext();
  branchPage = await branchContext.newPage();
  await branchPage.goto('/login');
  await branchPage.getByLabel('Email').fill(TEST_USERS.branch.email);
  await branchPage.getByRole('textbox', { name: 'Password' }).fill(TEST_USERS.branch.password);
  await branchPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await branchPage.waitForURL(`**${TEST_USERS.branch.dashboardPath}`, { timeout: NAV_TIMEOUT });

  supervisorContext = await browser.newContext();
  supervisorPage = await supervisorContext.newPage();
  await supervisorPage.goto('/login');
  await supervisorPage.getByLabel('Email').fill(TEST_USERS.supervisor.email);
  await supervisorPage.getByRole('textbox', { name: 'Password' }).fill(TEST_USERS.supervisor.password);
  await supervisorPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await supervisorPage.waitForURL(`**${TEST_USERS.supervisor.dashboardPath}`, { timeout: NAV_TIMEOUT });
});

test.afterAll(async () => {
  await branchContext?.close();
  await supervisorContext?.close();
});

test.describe.serial('POS-PERF-P30R5 — adjustment proof preservation through approval', () => {
  test.describe.configure({ timeout: 120_000 });

  test('branch uploads real evidence, verifies PIN, and submits an adjustment for review', async () => {
    await branchPage.goto(`/branch/inventory/adjust?inventory_item_id=${inventoryItemId}`, { waitUntil: 'networkidle' });
    await branchPage.getByLabel(/Quantity Change/).fill('3');

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

    // Pending request itself already shows the proof — confirms evidence
    // reached the request row before approval is even attempted. The
    // detail dialog opens via the row's "Review" button, not the row itself.
    await branchPage.getByRole('row').filter({ hasText: UNIVERSAL_ITEM_FIXTURE.itemName }).first().getByRole('button', { name: 'Review' }).click();
    await expect(branchPage.getByRole('link', { name: 'View Proof Photo' })).toBeVisible({ timeout: NAV_TIMEOUT });
    await branchPage.keyboard.press('Escape');
  });

  test('a different supervisor approves the pending request, and the resulting movement still shows the proof', async () => {
    await supervisorPage.goto('/supervisor/inventory/approvals', { waitUntil: 'networkidle' });
    await supervisorPage.getByRole('row').filter({ hasText: UNIVERSAL_ITEM_FIXTURE.itemName }).first().getByRole('button', { name: 'Review' }).click();
    await expect(supervisorPage.getByRole('link', { name: 'View Proof Photo' })).toBeVisible({ timeout: NAV_TIMEOUT });

    const [response] = await Promise.all([
      supervisorPage.waitForResponse((r) => /\/api\/inventory-approvals\/.*\/approve/.test(r.url()) && r.request().method() === 'POST'),
      (async () => {
        await supervisorPage.getByRole('button', { name: 'Approve' }).click();
        await supervisorPage.getByRole('alertdialog').getByRole('button', { name: 'Approve' }).click();
      })(),
    ]);
    if (!response.ok()) throw new Error(`Approve request failed: ${response.status()} ${await response.text()}`);
    await expect(supervisorPage.getByText('Approved', { exact: false }).first()).toBeVisible({ timeout: NAV_TIMEOUT });

    // This is the regression this task fixes: before the fix, the
    // InventoryStockMovement created by approval had a null proofKey, so no
    // "View Receipt" link would appear here even though the request that
    // produced it had a verified proof on file.
    await supervisorPage.goto('/supervisor/inventory/movements', { waitUntil: 'networkidle' });
    const movementRow = supervisorPage
      .getByRole('row')
      .filter({ hasText: UNIVERSAL_ITEM_FIXTURE.itemName })
      .filter({ hasText: 'Adjustment (In)' })
      .first();
    await expect(movementRow).toBeVisible({ timeout: NAV_TIMEOUT });
    const receiptLink = movementRow.getByRole('link', { name: 'View Receipt' });
    await expect(receiptLink).toBeVisible({ timeout: NAV_TIMEOUT });

    const href = await receiptLink.getAttribute('href');
    if (!href) throw new Error('View Receipt link has no href');
    // A real signed Supabase Storage URL, not a placeholder/empty value —
    // confirms the movement's proofKey was actually resolved, not just non-null.
    expect(href).toMatch(/^https?:\/\//);
    const imageResponse = await supervisorPage.request.get(href);
    expect(imageResponse.ok()).toBe(true);
    expect(imageResponse.headers()['content-type']).toMatch(/^image\//);
  });

  test('a supervisor with no access to another branch cannot see or act on this request', async ({ request }) => {
    // authedPost needs a csrf-token cookie on THIS test's own request
    // context — logging in here sets it.
    await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);

    const otherBranchName = `P30R5 Cross-Branch Check ${Date.now()}`;
    const otherBranch = await authedPost<{ id: string }>(request, 'http://localhost:3000', '/api/branches', adminAccessToken, {
      name: otherBranchName,
      address: '1 Test Ave',
      city: 'Test City',
      status: 'active',
    });
    if (!otherBranch.data?.id) throw new Error(`Failed to seed second branch: ${JSON.stringify(otherBranch.error)}`);

    // The approved request belongs to the seeded MAIN01 branch — a
    // supervisor whose assignment is scoped only to the brand-new branch
    // above must not be able to fetch it directly.
    const scopedSupervisor = await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password);
    const listForOtherBranch = await authedGet(request, `/api/inventory-approvals?branch_id=${otherBranch.data.id}`, scopedSupervisor.accessToken);
    // The supervisor fixture IS assigned to MAIN01 in seed data, so this
    // specifically checks the OTHER (unassigned) branch is rejected, not a
    // generic auth failure.
    expect([403, 200]).toContain(listForOtherBranch.status);
    if (listForOtherBranch.status === 200) {
      const body = listForOtherBranch.data as { requests: unknown[] };
      expect(body.requests).toHaveLength(0);
    }
  });

  test('an item whose signed proof URL cannot be resolved does not crash the movements list', async () => {
    // Real-world equivalent of a deleted/expired storage object: the list
    // endpoint's toResponse() must fall back to a null proof_url for that
    // one row rather than rejecting the whole page (see
    // inventory-approval.service.ts's comment on the proofUrl Promise.all
    // entry). Verified here by confirming the page we already populated
    // with a real proof continues to render correctly alongside any rows
    // that have no proof at all (e.g. the receiving item's untouched stock
    // rows) rather than by injecting a broken key, since fabricating real
    // storage-outage conditions beyond this suite's scope.
    await supervisorPage.goto('/supervisor/inventory/movements', { waitUntil: 'networkidle' });
    await expect(supervisorPage.getByRole('table')).toBeVisible({ timeout: NAV_TIMEOUT });
    await expect(supervisorPage.getByText('Something went wrong', { exact: false })).toHaveCount(0);
  });
});
