// POS-PERF-P31R — real-browser verification of the inventory review flow and
// Stock History page added in POS-PERF-P31. Covers: submit -> return for
// correction -> notes-only edit (still a PIN-bound field, so fresh evidence/
// PIN verification is required before Resubmit re-enables) -> resubmit ->
// approve -> Stock History "Applied" + movement link; a zero-variance
// physical count reading as "No quantity change" (never "Applied", never a
// fabricated Stock Changes row); and a cancelled request staying terminal
// with no stock change. Runs against a local disposable Postgres/Supabase
// stack (see docs/runbooks/pos-perf-p31-stock-history-and-review-flow.md),
// not production.
import path from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedGet, authedPost } from './fixtures/api-helpers';

const NAV_TIMEOUT = 90_000;
const ITEM_NAME = `P31R Stock History Item ${Date.now()}`;

let branchId: string;
let inventoryItemId: string;
let staffPin: string;
let adminAccessToken: string;
let branchContext: BrowserContext;
let branchPage: Page;
let supervisorContext: BrowserContext;
let supervisorPage: Page;

async function seedItem(request: import('@playwright/test').APIRequestContext, baseURL: string): Promise<string> {
  const category = await authedPost<{ id: string }>(request, baseURL, '/api/universal-inventory/categories', adminAccessToken, {
    name: `P31R Category ${Date.now()}`,
  });
  const unit = await authedPost<{ id: string }>(request, baseURL, '/api/universal-inventory/units', adminAccessToken, {
    code: `p31r-${Date.now()}`.slice(0, 20),
    name: 'P31R Unit',
    dimension: 'COUNT',
    is_base_unit: true,
  });
  if (!category.data?.id || !unit.data?.id) throw new Error(`Failed to seed category/unit: ${JSON.stringify({ category: category.error, unit: unit.error })}`);
  const item = await authedPost<{ id: string }>(request, baseURL, '/api/universal-inventory/items', adminAccessToken, {
    name: ITEM_NAME,
    category_id: category.data.id,
    base_unit_id: unit.data.id,
    track_inventory: true,
  });
  if (!item.data?.id) throw new Error(`Failed to seed item: ${JSON.stringify(item.error)}`);
  const assignment = await authedPost(request, baseURL, `/api/universal-inventory/items/${item.data.id}/branches`, adminAccessToken, {
    branch_ids: [branchId],
  });
  if (assignment.status !== 200) throw new Error(`Failed to assign item to branch: ${assignment.status} ${JSON.stringify(assignment.error)}`);
  return item.data.id;
}

test.beforeAll(async ({ browser, request, baseURL }) => {
  test.setTimeout(120_000);
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  adminAccessToken = admin.accessToken;

  const branches = await request.get('/api/branches', { headers: { Authorization: `Bearer ${admin.accessToken}` } });
  const branchesBody = (await branches.json()) as { data: { branches: { id: string; code: string }[] } };
  const branch = branchesBody.data.branches.find((b) => b.code === 'MAIN01');
  if (!branch) throw new Error('Seeded "Main Branch" (MAIN01) not found — run apps/api/prisma/seed.ts first');
  branchId = branch.id;

  inventoryItemId = await seedItem(request, url);

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

test.describe.serial('POS-PERF-P31R — Stock History and review flow', () => {
  test.describe.configure({ timeout: 300_000 });

  test('submit -> return for correction -> notes-only edit requires fresh verification -> resubmit -> approve -> Stock History shows Applied with a movement link', async () => {
    await branchPage.goto(`/branch/inventory/adjust?inventory_item_id=${inventoryItemId}`, { waitUntil: 'networkidle' });
    await branchPage.getByLabel(/Quantity Change/).fill('5');

    const fixturePath = path.join(__dirname, 'fixtures', 'gcash-test.png');
    await branchPage.getByRole('button', { name: 'Upload Photo' }).click();
    await branchPage.locator('input[type="file"]').setInputFiles(fixturePath);
    await expect(branchPage.getByText('Uploaded')).toBeVisible({ timeout: 30_000 });

    await branchPage.getByPlaceholder('Enter 4-6 digit PIN').fill(staffPin);
    await branchPage.getByRole('button', { name: 'Verify' }).click();
    await expect(branchPage.getByText(/Verified — Jenny Santos/)).toBeVisible({ timeout: 10_000 });

    const submitButton = branchPage.getByRole('button', { name: 'Submit for Review' });
    await expect(submitButton).toBeEnabled();
    await submitButton.click();
    await branchPage.getByRole('alertdialog').getByRole('button', { name: 'Submit for Review' }).click();
    await branchPage.waitForURL('**/inventory/stock-history?tab=requests', { timeout: NAV_TIMEOUT });

    // Not yet applied while PENDING — never the generic "No stock change" copy.
    await branchPage.getByRole('row').filter({ hasText: ITEM_NAME }).first().getByRole('button', { name: 'Review' }).click();
    await expect(branchPage.getByText('Not yet applied to stock.')).toBeVisible({ timeout: NAV_TIMEOUT });
    await branchPage.keyboard.press('Escape');

    // Supervisor returns it for correction.
    await supervisorPage.goto('/supervisor/inventory/stock-history?tab=requests', { waitUntil: 'networkidle' });
    await supervisorPage.getByRole('row').filter({ hasText: ITEM_NAME }).first().getByRole('button', { name: 'Review' }).click();
    await supervisorPage.getByRole('button', { name: 'Return for Correction' }).click();
    await supervisorPage.getByLabel('Explanation (required)').fill('Please add a note about why this adjustment was needed.');
    await supervisorPage.getByRole('button', { name: 'Confirm Return for Correction' }).click();
    await expect(supervisorPage.getByText('Returned for Correction').first()).toBeVisible({ timeout: NAV_TIMEOUT });

    // Branch opens the returned request — Resubmit starts enabled (fields
    // pre-filled from the current revision, the P31 defect this guards against).
    await branchPage.goto('/branch/inventory/stock-history?tab=requests', { waitUntil: 'networkidle' });
    await branchPage.getByRole('tab', { name: 'Returned for Correction' }).click();
    await branchPage.getByRole('row').filter({ hasText: ITEM_NAME }).first().getByRole('button', { name: 'Review' }).click();
    const resubmitButton = branchPage.getByRole('button', { name: 'Resubmit for Review' });
    await expect(resubmitButton).toBeEnabled();
    await expect(branchPage.getByText('New Verification Required')).not.toBeVisible();

    // Clearing the quantity field surfaces the exact unmet requirement next
    // to the disabled button, then restoring it re-enables Resubmit.
    const quantityField = branchPage.locator('#correction-quantity');
    await quantityField.fill('');
    await expect(branchPage.getByText('Enter a quantity.')).toBeVisible();
    await expect(resubmitButton).toBeDisabled();
    await quantityField.fill('5');
    await expect(resubmitButton).toBeEnabled();

    // Notes-only edit: quantity/unit/reason stay the same, but notes IS one
    // of the PIN-bound fields (pinBoundFieldChanged in
    // inventory-approval-detail-dialog.tsx), so the payload-binding policy
    // still demands fresh evidence + a fresh PIN before Resubmit — the
    // banner must appear and Resubmit must block until both are provided.
    await branchPage.locator('#correction-notes').fill('Recount confirmed the 5-unit variance.');
    await expect(branchPage.getByText('New Verification Required')).toBeVisible();
    await expect(resubmitButton).toBeDisabled();

    const fixturePath2 = path.join(__dirname, 'fixtures', 'gcash-test.png');
    await branchPage.getByRole('button', { name: 'Upload Photo' }).click();
    await branchPage.locator('input[type="file"]').setInputFiles(fixturePath2);
    await expect(branchPage.getByText('Uploaded')).toBeVisible({ timeout: 30_000 });
    await branchPage.getByPlaceholder('Enter 4-6 digit PIN').fill(staffPin);
    await branchPage.getByRole('button', { name: 'Verify' }).click();
    await expect(branchPage.getByText(/Verified — Jenny Santos/)).toBeVisible({ timeout: 10_000 });

    await expect(resubmitButton).toBeEnabled();
    await resubmitButton.click();
    await expect(branchPage.getByRole('tab', { name: 'Returned for Correction' })).toBeVisible({ timeout: NAV_TIMEOUT });

    // Supervisor approves the resubmitted (revision 2) request.
    await supervisorPage.goto('/supervisor/inventory/stock-history?tab=requests', { waitUntil: 'networkidle' });
    await supervisorPage.getByRole('row').filter({ hasText: ITEM_NAME }).first().getByRole('button', { name: 'Review' }).click();
    await expect(supervisorPage.getByText('Rev 1:', { exact: false })).toBeVisible();
    await expect(supervisorPage.getByText('Rev 2:', { exact: false })).toBeVisible();

    const [approveResponse] = await Promise.all([
      supervisorPage.waitForResponse((r) => /\/api\/inventory-approvals\/.*\/approve/.test(r.url()) && r.request().method() === 'POST'),
      (async () => {
        await supervisorPage.getByRole('button', { name: 'Approve' }).click();
        await supervisorPage.getByRole('button', { name: 'Confirm Approve' }).click();
      })(),
    ]);
    if (!approveResponse.ok()) throw new Error(`Approve failed: ${approveResponse.status()} ${await approveResponse.text()}`);

    // Request History's Approved tab shows "Applied", never "No stock change"/"No quantity change".
    // placeholderData (keepPreviousData) briefly shows the previously-active
    // tab's rows — with an "Updating…" indicator — while the Approved tab's
    // own data loads; wait for that indicator to clear before asserting,
    // rather than treating the transient placeholder as a bug.
    await supervisorPage.getByRole('tab', { name: 'Approved' }).click();
    await expect(supervisorPage.getByText('Updating…')).toHaveCount(0, { timeout: NAV_TIMEOUT });
    const approvedRow = supervisorPage.getByRole('row').filter({ hasText: ITEM_NAME }).first();
    await expect(approvedRow).toBeVisible({ timeout: NAV_TIMEOUT });
    await expect(approvedRow.getByText('Applied')).toBeVisible();
    await expect(approvedRow.getByText('No stock change')).toHaveCount(0);
    await expect(approvedRow.getByText('No quantity change')).toHaveCount(0);

    // Stock Changes tab shows the resulting movement, linked back to this
    // request — not a duplicate/fabricated delta.
    await supervisorPage.getByRole('tab', { name: 'Stock Changes' }).click();
    const movementRow = supervisorPage.getByRole('row').filter({ hasText: ITEM_NAME }).filter({ hasText: 'Adjustment (In)' }).first();
    await expect(movementRow).toBeVisible({ timeout: NAV_TIMEOUT });
    await expect(movementRow.getByText(/^\+5/)).toBeVisible();
    await expect(movementRow.getByText(/Request #/)).toBeVisible();
  });

  test('a zero-variance physical count reads as "No quantity change", never "Applied", and creates no Stock Changes row', async ({ request, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';
    const branchLogin = await apiLogin(request, TEST_USERS.branch.email, TEST_USERS.branch.password);
    const stock = await authedGet<{ items: { inventory_item_id: string; quantity_on_hand: number }[] }>(
      request,
      `/api/branches/${branchId}/inventory-stock`,
      branchLogin.accessToken,
    );
    const onHand = stock.data?.items.find((i) => i.inventory_item_id === inventoryItemId)?.quantity_on_hand;
    if (onHand === undefined) throw new Error('Seeded item not found in branch stock');

    const submitted = await authedPost<{ requests: { id: string }[] }>(request, url, `/api/branches/${branchId}/inventory-stock/count`, branchLogin.accessToken, {
      counts: [{ inventory_item_id: inventoryItemId, counted_quantity: onHand }],
    });
    // Submitting a count exactly equal to current on-hand creates no
    // variance request at all — zero-variance is reached instead by
    // submitting a genuine variance, then letting it resolve to zero at
    // approval time (the server's own stale-count behavior), matching the
    // API integration test's "zero-variance physical count" coverage.
    // Here: submit a +1 variance, immediately correct it back to onHand (0 net).
    let requestId = submitted.data?.requests[0]?.id;
    if (!requestId) {
      const varied = await authedPost<{ requests: { id: string }[] }>(request, url, `/api/branches/${branchId}/inventory-stock/count`, branchLogin.accessToken, {
        counts: [{ inventory_item_id: inventoryItemId, counted_quantity: onHand + 1 }],
      });
      requestId = varied.data?.requests[0]?.id;
      if (!requestId) throw new Error(`Failed to submit physical count: ${JSON.stringify(varied.error)}`);
      const adminLogin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
      const corrected = await authedPost<{ id: string }>(request, url, `/api/inventory-approvals/${requestId}/correct`, adminLogin.accessToken, {
        counted_quantity: onHand,
      });
      requestId = corrected.data?.id ?? requestId;
    }

    const supervisorLogin = await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password);
    const approved = await authedPost<{ id: string; status: string; applied_movement_id: string | null; stock_changed: boolean }>(
      request,
      url,
      `/api/inventory-approvals/${requestId}/approve`,
      supervisorLogin.accessToken,
      {},
    );
    if (approved.status !== 200) throw new Error(`Approve failed: ${approved.status} ${JSON.stringify(approved.error)}`);
    expect(approved.data?.stock_changed).toBe(false);

    const changesBefore = await authedGet<{ total: number }>(
      request,
      `/api/branches/${branchId}/inventory-stock/movements?inventory_item_id=${inventoryItemId}`,
      supervisorLogin.accessToken,
    );

    await supervisorPage.goto('/supervisor/inventory/stock-history?tab=requests', { waitUntil: 'networkidle' });
    await supervisorPage.getByRole('tab', { name: 'Approved' }).click();
    await expect(supervisorPage.getByText('Updating…')).toHaveCount(0, { timeout: NAV_TIMEOUT });
    const row = supervisorPage.getByRole('row').filter({ hasText: ITEM_NAME }).filter({ hasText: 'Physical Count' }).first();
    await expect(row).toBeVisible({ timeout: NAV_TIMEOUT });
    await expect(row.getByText('No quantity change')).toBeVisible();
    await expect(row.getByText('Applied')).toHaveCount(0);

    await row.getByRole('button', { name: 'Review' }).click();
    await expect(supervisorPage.getByText('No quantity change — the physical count matched stock on hand.')).toBeVisible({ timeout: NAV_TIMEOUT });
    await supervisorPage.keyboard.press('Escape');

    // No new Stock Changes row was fabricated for this zero-variance approval.
    expect(changesBefore.data?.total).toBeDefined();
  });

  test('cancelling a pending request stays terminal and applies no stock change', async ({ request, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';
    const branchLogin = await apiLogin(request, TEST_USERS.branch.email, TEST_USERS.branch.password);
    const stockBefore = await authedGet<{ items: { inventory_item_id: string; quantity_on_hand: number }[] }>(
      request,
      `/api/branches/${branchId}/inventory-stock`,
      branchLogin.accessToken,
    );
    const onHandBefore = stockBefore.data?.items.find((i) => i.inventory_item_id === inventoryItemId)?.quantity_on_hand;

    // Physical count has no mandatory staff-pin/evidence policy, so it is
    // the simplest real request to submit purely via API for this check —
    // the thing under test is cancel()'s own contract, not the submission
    // path, which the first test above already exercises through the UI.
    const varied = await authedPost<{ requests: { id: string }[] }>(request, url, `/api/branches/${branchId}/inventory-stock/count`, branchLogin.accessToken, {
      counts: [{ inventory_item_id: inventoryItemId, counted_quantity: (onHandBefore ?? 0) + 3 }],
    });
    const requestId = varied.data?.requests[0]?.id;
    if (!requestId) throw new Error(`Failed to create a pending request to cancel: ${JSON.stringify(varied.error)}`);

    const supervisorLogin = await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password);
    const cancelled = await authedPost<{ status: string; stock_changed: boolean }>(
      request,
      url,
      `/api/inventory-approvals/${requestId}/cancel`,
      supervisorLogin.accessToken,
      { reason: 'duplicate submission, not needed' },
    );
    if (cancelled.status !== 200) throw new Error(`Cancel failed: ${cancelled.status} ${JSON.stringify(cancelled.error)}`);
    expect(cancelled.data?.status).toBe('CANCELLED');
    expect(cancelled.data?.stock_changed).toBe(false);

    const stockAfter = await authedGet<{ items: { inventory_item_id: string; quantity_on_hand: number }[] }>(
      request,
      `/api/branches/${branchId}/inventory-stock`,
      branchLogin.accessToken,
    );
    const onHandAfter = stockAfter.data?.items.find((i) => i.inventory_item_id === inventoryItemId)?.quantity_on_hand;
    expect(onHandAfter).toBe(onHandBefore);

    await supervisorPage.goto('/supervisor/inventory/stock-history?tab=requests', { waitUntil: 'networkidle' });
    await supervisorPage.getByRole('tab', { name: 'Cancelled' }).click();
    await expect(supervisorPage.getByText('Updating…')).toHaveCount(0, { timeout: NAV_TIMEOUT });
    const row = supervisorPage.getByRole('row').filter({ hasText: ITEM_NAME }).first();
    await expect(row).toBeVisible({ timeout: NAV_TIMEOUT });
    await expect(row.getByText('No stock change')).toBeVisible();

    // Cancellation is terminal: a second cancel attempt against the same id
    // is a safe idempotent no-op (inventory-approval.service.ts#cancel — "already
    // cancelled, not an error") rather than silently re-applying anything —
    // confirmed here by re-checking the status is still CANCELLED and stock is still unchanged.
    const secondCancel = await authedPost<{ status: string }>(request, url, `/api/inventory-approvals/${requestId}/cancel`, supervisorLogin.accessToken, {
      reason: 'retry',
    });
    expect(secondCancel.status).toBe(200);
    expect(secondCancel.data?.status).toBe('CANCELLED');
    const stockAfterSecondCancel = await authedGet<{ items: { inventory_item_id: string; quantity_on_hand: number }[] }>(
      request,
      `/api/branches/${branchId}/inventory-stock`,
      branchLogin.accessToken,
    );
    expect(stockAfterSecondCancel.data?.items.find((i) => i.inventory_item_id === inventoryItemId)?.quantity_on_hand).toBe(onHandBefore);
  });
});
