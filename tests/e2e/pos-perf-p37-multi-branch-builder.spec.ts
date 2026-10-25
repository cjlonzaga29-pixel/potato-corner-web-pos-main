// POS-PERF-P37 — "create once, select multiple branches", in a real browser:
// the Product Builder's "Available at branches" checkboxes -> builder steps
// -> Review -> Add to POS, then real checkouts at each selected branch. Run
// against the local disposable `pos_verify` Postgres with `apps/api` (:4000)
// and `apps/web` (:3000) dev servers already running locally, same posture as
// the P36R/P36R6 browser specs. Branches, supervisors, staff reassignment,
// and sales go through the real admin/supervisor/staff API; only the
// per-branch InventoryStock balances are seeded/read directly
// (fixtures/p37-branch-stock.cjs — see its header for why).
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedPost, authedPatch, authedGet } from './fixtures/api-helpers';

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

const suffix = Date.now().toString(36);
const MAIN_BRANCH_ID = 'ff0da4c4-4685-4a62-9c67-2f0c7e25c6ab'; // seeded "Main Branch" — the seeded staff fixture's home branch, restored in afterAll.

const multiSup = { email: `p37-multi-${suffix}@test.local`, password: 'P37MultiSupPass!1' };
const partialSup = { email: `p37-partial-${suffix}@test.local`, password: 'P37PartialPass!1' };

const names = {
  a: `P37 Branch A ${suffix}`,
  b: `P37 Branch B ${suffix}`,
  c: `P37 Branch C ${suffix}`,
  inactive: `P37 Branch Closed ${suffix}`,
  unassigned: `P37 Branch Other ${suffix}`,
};
const productName = `P37 Cheese Fries ${suffix}`;

let branchA = '';
let branchB = '';
let branchC = '';
let branchUnassigned = '';
let itemId = '';
let itemName = '';
let productId = '';
let variantId = '';
let staffEmployeeId = '';

function runStockFixture(args: string[]): string {
  return execFileSync(process.execPath, [path.join(__dirname, 'fixtures', 'p37-branch-stock.cjs'), ...args], {
    cwd: path.join(__dirname, '..', '..', 'apps', 'api'),
    encoding: 'utf-8',
  });
}

function readStock(): Record<string, number | null> {
  return JSON.parse(runStockFixture(['read', itemId, branchA, branchB, branchC])) as Record<string, number | null>;
}

/** Same as P36R6: accounts created with initial_password must clear must_change_password before any write. */
async function clearMustChangePassword(request: APIRequestContext, email: string, password: string) {
  const login = await apiLogin(request, email, password);
  const state = await request.storageState();
  const csrfCookie = state.cookies.find((c) => c.name === 'csrf-token');
  const csrfToken = csrfCookie ? decodeURIComponent(csrfCookie.value) : '';
  const res = await request.post('/api/auth/change-password', {
    headers: { Authorization: `Bearer ${login.accessToken}`, 'X-CSRF-Token': csrfToken, 'X-Device-Id': randomUUID() },
    data: { current_password: password, new_password: password, confirm_password: password },
  });
  if (!res.ok()) throw new Error(`Failed to clear must_change_password for ${email}: ${res.status()} ${await res.text()}`);
}

async function loginAs(page: Page, email: string, password: string, dashboardGlob: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(dashboardGlob);
}

async function catalogHas(request: APIRequestContext, token: string, branchId: string): Promise<boolean> {
  const res = await authedGet<{ categories?: unknown }>(request, `/api/products/catalog?branch_id=${branchId}`, token);
  expect(res.status).toBe(200);
  return JSON.stringify(res.data).includes(productId);
}

/** Clocks the seeded staff fixture in at `branchId` and rings up one unit; waits for the async inventory deduction to complete. */
async function sellOneAt(request: APIRequestContext, url: string, branchId: string) {
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const reassign = await authedPatch(request, url, `/api/employees/${staffEmployeeId}`, admin.accessToken, { branch_ids: [branchId] });
  expect(reassign.status).toBe(200);

  const staff = await apiLogin(request, TEST_USERS.staff.email, TEST_USERS.staff.password);
  await authedPost(request, url, '/api/attendance/clock-out', staff.accessToken, { employee_id: staffEmployeeId, branch_id: branchId });
  const clockIn = await authedPost(request, url, '/api/attendance/clock-in', staff.accessToken, {
    employee_id: staffEmployeeId,
    branch_id: branchId,
    gps_lat: 14.676,
    gps_lng: 121.0437,
  });
  expect(clockIn.error, JSON.stringify(clockIn.error)).toBeNull();

  const sale = await authedPost<{ id: string; status: string }>(request, url, '/api/transactions', staff.accessToken, {
    branch_id: branchId,
    items: [{ product_id: productId, product_variant_id: variantId, quantity: 1 }],
    payment_method: 'cash',
    cash_tendered: 50,
  });
  expect(sale.status, JSON.stringify(sale.error)).toBe(201);
  expect(sale.data?.status).toBe('completed');

  await expect
    .poll(
      async () =>
        (await authedGet<{ inventory_deduction_status: string }>(request, `/api/transactions/${sale.data?.id}`, admin.accessToken)).data
          ?.inventory_deduction_status,
      // The deduction worker polls every ~2s; matching that keeps this spec well
      // under the API's global 100 req/min limiter (app.ts apiLimiter, keyed by IP).
      { timeout: 30_000, intervals: [2_000] },
    )
    .toBe('completed');
  await authedPost(request, url, '/api/attendance/clock-out', staff.accessToken, { employee_id: staffEmployeeId, branch_id: branchId });
}

test.beforeAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);

  const created: Record<string, string> = {};
  for (const [key, name] of Object.entries(names)) {
    const res = await authedPost<{ id: string }>(request, url, '/api/branches', admin.accessToken, {
      name,
      address: `1 ${name} St`,
      city: 'Test City',
      status: 'active',
    });
    if (!res.data?.id) throw new Error(`Failed to seed branch ${name}: ${JSON.stringify(res.error)}`);
    created[key] = res.data.id;
  }
  branchA = created.a ?? '';
  branchB = created.b ?? '';
  branchC = created.c ?? '';
  branchUnassigned = created.unassigned ?? '';
  const branchInactive = created.inactive ?? '';

  for (const [account, branchIds] of [
    [multiSup, [branchA, branchB, branchC, branchInactive]],
    [partialSup, [branchA]],
  ] as const) {
    const res = await authedPost<{ id: string }>(request, url, '/api/employees', admin.accessToken, {
      email: account.email,
      first_name: 'P37',
      last_name: account === multiSup ? 'Multi' : 'Partial',
      role: 'supervisor',
      employment_type: 'regular',
      branch_ids: branchIds,
      initial_password: account.password,
    });
    if (!res.data?.id) throw new Error(`Failed to seed supervisor ${account.email}: ${JSON.stringify(res.error)}`);
    await clearMustChangePassword(request, account.email, account.password);
  }

  // Assigned while active, then closed — "Select all" must not include it.
  const deactivate = await authedPatch(request, url, `/api/branches/${branchInactive}`, admin.accessToken, { status: 'inactive' });
  if (deactivate.status !== 200) throw new Error(`Failed to deactivate branch: ${JSON.stringify(deactivate.error)}`);

  // Recipe item stocked at A (500) and B (300); C deliberately has no stock row.
  const seeded = JSON.parse(runStockFixture(['seed', branchA, branchB, suffix])) as { itemId: string; itemName: string };
  itemId = seeded.itemId;
  itemName = seeded.itemName;

  const staffList = await authedGet<{ employees: { id: string; email: string }[] }>(
    request,
    `/api/employees?search=${encodeURIComponent(TEST_USERS.staff.email)}`,
    admin.accessToken,
  );
  staffEmployeeId = staffList.data?.employees.find((e) => e.email === TEST_USERS.staff.email)?.id ?? '';
  if (!staffEmployeeId) throw new Error('Seeded staff fixture not found');
});

// apps/api's global apiLimiter allows 100 requests/minute per IP (in-memory,
// fixed 1-minute window) and every local request shares 127.0.0.1; one full
// browser builder session spends most of that. Waiting out the window before
// each test (and mid-way through the first) keeps this spec deterministic without touching the
// limiter (see docs/decisions/POS-PERF-P36R6-branch-copy-browser-verification.md §4).
function waitOutRateLimitWindow() {
  return new Promise((resolve) => setTimeout(resolve, 61_000));
}

test.beforeEach(async () => {
  await waitOutRateLimitWindow();
});

test.afterAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  if (!staffEmployeeId) return;
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  await authedPatch(request, url, `/api/employees/${staffEmployeeId}`, admin.accessToken, { branch_ids: [MAIN_BRANCH_ID] });
  // Branches with sales can't be deleted; deactivate them so they don't crowd
  // other specs' branch selectors (e.g. P36R2 Scenario 5's "Main Branch" pick).
  for (const id of [branchA, branchB, branchC, branchUnassigned]) {
    if (id) await authedPatch(request, url, `/api/branches/${id}`, admin.accessToken, { status: 'inactive' });
  }
});

test('checkboxes -> builder -> Save Draft -> Review -> Add to POS publishes once, at the selected branches only', async ({ page, request }) => {
  await loginAs(page, multiSup.email, multiSup.password, '**/supervisor/dashboard');
  await page.goto('/supervisor/products/builder');

  // --- Step 1: "Available at branches" ---
  await expect(page.getByText('Available at branches')).toBeVisible();
  await expect(page.getByText('This product publishes only to this branch.')).toHaveCount(0);
  const boxA = page.getByRole('checkbox', { name: names.a, exact: true });
  const boxB = page.getByRole('checkbox', { name: names.b, exact: true });
  const boxC = page.getByRole('checkbox', { name: names.c, exact: true });
  await expect(boxA).toBeVisible();
  await expect(boxB).toBeVisible();
  await expect(boxC).toBeVisible();
  // Inactive assigned branch and an unassigned branch are never offered.
  await expect(page.getByRole('checkbox', { name: names.inactive })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: names.unassigned })).toHaveCount(0);

  // More than one branch -> nothing preselected; Continue requires a pick.
  await expect(boxA).not.toBeChecked();
  const continueButton = page.getByRole('button', { name: 'Continue to Sizes & Prices' });
  await expect(continueButton).toBeDisabled();

  await page.getByRole('checkbox', { name: 'Select all assigned branches' }).click();
  await expect(page.getByTestId('builder-branch-count')).toContainText('3 branches selected');
  await boxC.click();
  await expect(page.getByTestId('builder-branch-count')).toContainText(`2 branches selected: ${names.a}, ${names.b}`);

  // Reload before the product exists — the branch selection is recovered.
  // A reload drops the in-memory access token; the refresh round-trip plus the
  // branch list can take several seconds locally, hence the longer wait.
  await page.reload();
  await expect(page.getByRole('checkbox', { name: names.a, exact: true })).toBeChecked({ timeout: 20_000 });
  await expect(page.getByRole('checkbox', { name: names.b, exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: names.c, exact: true })).not.toBeChecked();

  await page.getByLabel('Product Name').fill(productName);
  const [createResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/products') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Continue to Sizes & Prices' }).click(),
  ]);
  expect(createResp.status()).toBe(201);
  const createBody = createResp.request().postDataJSON() as { branch_ids: string[]; exclusive_branch_id?: string };
  expect([...createBody.branch_ids].sort()).toEqual([branchA, branchB].sort());
  expect(createBody.exclusive_branch_id).toBeUndefined();
  productId = ((await createResp.json()) as { data: { id: string } }).data.id;

  // --- Step 2: Sizes ---
  await page.getByRole('button', { name: 'Add Size' }).click();
  await page.getByLabel('Variant Name').fill('Regular');
  await page.getByLabel('Size Label').fill('Regular');
  await page.getByLabel('Base Price', { exact: false }).fill('50');
  await page.getByRole('button', { name: 'Add Variant' }).click();
  await expect(page.getByText('Regular — Regular')).toBeVisible();

  // Step navigation back to Details keeps the selection (now server-backed).
  await page.getByRole('button', { name: /1\. Product Details/ }).click();
  await expect(page.getByTestId('builder-selected-branches')).toHaveText(`Available at: ${names.a}, ${names.b}`);
  await page.getByRole('button', { name: 'Continue to Sizes & Prices' }).click();
  await page.getByRole('button', { name: 'Continue to Ingredients & Packaging' }).click();

  // --- Step 3: one shared recipe ---
  await expect(page.getByText(`This recipe is shared by ${names.a}, ${names.b}`)).toBeVisible();
  await page.getByRole('button', { name: 'Add Component' }).click();
  const componentDialog = page.getByRole('dialog', { name: 'Add Recipe Component' });
  await componentDialog.getByLabel('Inventory Item').click();
  await page.getByRole('option', { name: itemName }).click();
  // WEIGHT items default Quantity Required to 0 (recipe-component-form-dialog.tsx), which is invalid until set.
  await componentDialog.getByLabel('Quantity Required').fill('10');
  await componentDialog.getByRole('button', { name: 'Add Component', exact: true }).click();
  await expect(componentDialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Continue to Choices' }).click();
  await page.getByRole('button', { name: 'Continue to Review' }).click();

  // --- Step 5: Review shows the selection; survives a reload ---
  await expect(page.getByTestId('review-selected-branches')).toContainText(names.a);
  await expect(page.getByTestId('review-selected-branches')).toContainText(names.b);
  await expect(page.getByTestId('review-selected-branches')).not.toContainText(names.c);
  await page.reload();
  await expect(page.getByTestId('review-selected-branches')).toContainText(names.a, { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Add to POS' })).toBeEnabled({ timeout: 15_000 });

  // Save Draft: configured, but sellable nowhere.
  await page.getByRole('button', { name: 'Save Draft' }).click();
  await page.waitForURL('**/supervisor/products');
  const supToken = (await apiLogin(request, multiSup.email, multiSup.password)).accessToken;
  expect(await catalogHas(request, supToken, branchA)).toBe(false);
  expect(await catalogHas(request, supToken, branchB)).toBe(false);

  const detail = await authedGet<{ variants: { id: string }[]; branch_availability: { branch_id: string; is_available: boolean }[] }>(
    request,
    `/api/products/${productId}`,
    supToken,
  );
  variantId = detail.data?.variants[0]?.id ?? '';
  expect(detail.data?.branch_availability.map((r) => r.branch_id).sort()).toEqual([branchA, branchB].sort());
  expect(detail.data?.branch_availability.every((r) => !r.is_available)).toBe(true);

  // Re-open the saved draft through Edit and publish from Review.
  await page.goto(`/supervisor/products/builder?product_id=${productId}`);
  await page.getByRole('button', { name: 'Continue to Sizes & Prices' }).click();
  await page.getByRole('button', { name: 'Continue to Ingredients & Packaging' }).click();
  await page.getByRole('button', { name: 'Continue to Choices' }).click();
  await page.getByRole('button', { name: 'Continue to Review' }).click();
  const addToPos = page.getByRole('button', { name: 'Add to POS' });
  await expect(addToPos).toBeEnabled({ timeout: 15_000 });
  const [publishResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/products/${productId}/publish-branches`) && r.request().method() === 'POST'),
    addToPos.click(),
  ]);
  expect(publishResp.status()).toBe(200);
  await page.waitForURL(`**/supervisor/products/${productId}`);
  await waitOutRateLimitWindow();

  expect(await catalogHas(request, supToken, branchA)).toBe(true);
  expect(await catalogHas(request, supToken, branchB)).toBe(true);
  expect(await catalogHas(request, supToken, branchC)).toBe(false);

  const products = await authedGet<{ products: { id: string }[] }>(request, `/api/products?search=${encodeURIComponent(productName)}`, supToken);
  expect(products.data?.products).toHaveLength(1);
});

test('retry of Add to POS is idempotent; forged, unselected, and partial-authority requests are rejected without writes', async ({ request, baseURL }) => {
  expect(productId, 'requires the published product from the previous test').toBeTruthy();
  const url = baseURL ?? 'http://localhost:3000';
  const multi = await apiLogin(request, multiSup.email, multiSup.password);

  const retry = await authedPost<{ branches: unknown[] }>(request, url, `/api/products/${productId}/publish-branches`, multi.accessToken, {
    branch_ids: [branchB, branchA, branchA],
  });
  expect(retry.status).toBe(200);

  const forged = await authedPost(request, url, `/api/products/${productId}/publish-branches`, multi.accessToken, {
    branch_ids: [branchA, branchUnassigned],
  });
  expect(forged.status).toBe(403);
  const unselected = await authedPost(request, url, `/api/products/${productId}/publish`, multi.accessToken, { branch_id: branchC });
  expect(unselected.status).toBe(403);

  const partial = await apiLogin(request, partialSup.email, partialSup.password);
  const rename = await authedPatch(request, url, `/api/products/${productId}`, partial.accessToken, { name: 'Hijacked' });
  expect(rename.status).toBe(403);
  const partialPublish = await authedPost(request, url, `/api/products/${productId}/publish-branches`, partial.accessToken, {
    branch_ids: [branchA, branchB],
  });
  expect(partialPublish.status).toBe(403);

  const detail = await authedGet<{ name: string; branch_availability: { branch_id: string; is_available: boolean }[] }>(
    request,
    `/api/products/${productId}`,
    multi.accessToken,
  );
  expect(detail.data?.name).toBe(productName);
  expect(detail.data?.branch_availability).toHaveLength(2);
  expect(detail.data?.branch_availability.every((r) => r.is_available)).toBe(true);
});

test('checkout at Branch A deducts only A stock; checkout at Branch B deducts only B stock', async ({ request, baseURL }) => {
  expect(variantId, 'requires the published product from the first test').toBeTruthy();
  const url = baseURL ?? 'http://localhost:3000';

  const start = readStock();
  expect(start[branchA]).toBe(500);
  expect(start[branchB]).toBe(300);
  expect(start[branchC]).toBeNull(); // publishing created no stock anywhere

  await sellOneAt(request, url, branchA);
  const afterA = readStock();
  const perSale = (start[branchA] ?? 0) - (afterA[branchA] ?? 0);
  expect(perSale).toBeGreaterThan(0);
  expect(afterA[branchB]).toBe(start[branchB]);

  await sellOneAt(request, url, branchB);
  const afterB = readStock();
  expect(afterB[branchA]).toBe(afterA[branchA]);
  expect(afterB[branchB]).toBe((start[branchB] ?? 0) - perSale);
  expect(afterB[branchC]).toBeNull();
});

test('a selected branch missing inventory setup keeps Add to POS disabled, and the API refuses to publish any branch', async ({ page, request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const multi = await apiLogin(request, multiSup.email, multiSup.password);
  const created = await authedPost<{ id: string }>(request, url, '/api/products', multi.accessToken, {
    name: `P37 Needs Setup ${suffix}`,
    status: 'active',
    is_seasonal: false,
    branch_ids: [branchA, branchC],
  });
  expect(created.status).toBe(201);
  const id = created.data?.id ?? '';
  const variant = await authedPost<{ id: string }>(request, url, `/api/products/${id}/variants`, multi.accessToken, {
    name: 'Regular',
    size_label: 'Regular',
    base_price: 40,
    is_active: true,
  });
  const component = await authedPost(request, url, '/api/product-components', multi.accessToken, {
    product_variant_id: variant.data?.id,
    inventory_item_id: itemId,
    quantity_required: 1,
  });
  expect(component.error, JSON.stringify(component.error)).toBeNull();

  await loginAs(page, multiSup.email, multiSup.password, '**/supervisor/dashboard');
  await page.goto(`/supervisor/products/builder?product_id=${id}`);
  await page.getByRole('button', { name: 'Continue to Sizes & Prices' }).click();
  await page.getByRole('button', { name: 'Continue to Ingredients & Packaging' }).click();
  await page.getByRole('button', { name: 'Continue to Choices' }).click();
  await page.getByRole('button', { name: 'Continue to Review' }).click();
  await expect(page.getByRole('heading', { name: names.c })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Add to POS' })).toBeDisabled();

  const attempt = await authedPost<null>(request, url, `/api/products/${id}/publish-branches`, multi.accessToken, { branch_ids: [branchA, branchC] });
  expect(attempt.status).toBe(409);
  expect(JSON.stringify(attempt.error)).toContain('INVENTORY_STOCK_MISSING');
  const detail = await authedGet<{ branch_availability: { is_available: boolean }[] }>(request, `/api/products/${id}`, multi.accessToken);
  expect(detail.data?.branch_availability.every((r) => !r.is_available)).toBe(true);
  expect(readStock()[branchC]).toBeNull();
});

test('a single-branch supervisor gets their branch preselected and creates a branch-exclusive product as before', async ({ page }) => {
  await loginAs(page, partialSup.email, partialSup.password, '**/supervisor/dashboard');
  await page.goto('/supervisor/products/builder');
  await expect(page.getByRole('checkbox', { name: names.a, exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select all assigned branches' })).toHaveCount(0);
  await expect(page.getByTestId('builder-branch-count')).toContainText(`1 branch selected: ${names.a}`);

  await page.getByLabel('Product Name').fill(`P37 Single ${suffix}`);
  const [createResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/products') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Continue to Sizes & Prices' }).click(),
  ]);
  expect(createResp.status()).toBe(201);
  const body = (await createResp.json()) as { data: { branch_exclusive: boolean; exclusive_branch_id: string; branch_selection_scoped: boolean } };
  expect(body.data.branch_exclusive).toBe(true);
  expect(body.data.exclusive_branch_id).toBe(branchA);
  expect(body.data.branch_selection_scoped).toBe(false);
});
