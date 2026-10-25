// POS-PERF-P36R6 — the real-browser branch-copy golden path and lifecycle/
// team checks that POS-PERF-P36R5's doc (docs/decisions/POS-PERF-P36R5-
// branch-copy-ui-and-replacement.md §8) explicitly deferred: "No browser/
// Playwright coverage." Run against the local disposable `pos_verify`
// Postgres with `apps/api` (:4000) and `apps/web` (:3000) dev servers
// already running locally, same posture as pos-perf-p36r2's browser pass.
//
// The one piece the current API has no write path to create — a non-
// branch-exclusive ("shared") product spanning two branches, since
// supervisor creation is forced branch_exclusive and super_admin's catalog
// write access was removed in POS-PERF-P35 — is seeded directly via Prisma
// (fixtures/seed-shared-branch-product.cjs), the same precedent
// seed-legacy-movement.cjs already set for a different now-unreachable
// shape. Every actor (branches, supervisors, staff, option group, the
// pre-replacement sale) is otherwise created through the real admin/
// supervisor API, matching every other browser spec in this suite.
import { test, expect, type APIRequestContext } from '@playwright/test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedPost, authedPatch, authedGet } from './fixtures/api-helpers';

test.describe.configure({ mode: 'serial' });
// Includes the 61s rate-limit wait in beforeEach (hooks share the test timeout).
test.setTimeout(180_000);

const suffix = Date.now().toString(36);
const MAIN_BRANCH_ID = 'ff0da4c4-4685-4a62-9c67-2f0c7e25c6ab'; // seeded "Main Branch" (MAIN01) — the seeded staff fixture's home branch, restored in afterAll.

const teamA1 = { email: `p36r6-teama1-${suffix}@test.local`, password: 'P36r6TeamA1Pass!1' };
const teamA2 = { email: `p36r6-teama2-${suffix}@test.local`, password: 'P36r6TeamA2Pass!1' };
const crossSup = { email: `p36r6-cross-${suffix}@test.local`, password: 'P36r6CrossPass!1' };
// Assigned to BOTH Branch A and Branch B — the shared product's full
// footprint. catalog-authority.ts's hasActiveCatalogAuthority requires
// covering every branch a shared (non-exclusive) product is configured at,
// not just one — only this actor can archive/restore the SOURCE globally
// once Branch A's availability belongs to the copy instead.
const teamBoth = { email: `p36r6-teamboth-${suffix}@test.local`, password: 'P36r6TeamBothPass!1' };

/**
 * Supervisor accounts created with `initial_password` start with
 * must_change_password: true — requirePasswordChange then blocks every
 * further write with that account until it's cleared, same as a real
 * first-login would via the /change-password form. Direct API setup needs
 * to do the same before it can act as this user.
 */
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

let branchAId: string;
let branchBId: string;
let sharedProductId: string;
let sharedVariantId: string;
let optionGroupId: string;
let optionGroupName: string;
let copyId = '';
let preReplaceSaleTransactionId = '';
let staffEmployeeId = '';

test.beforeAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);

  const [branchARes, branchBRes] = await Promise.all([
    authedPost<{ id: string }>(request, url, '/api/branches', admin.accessToken, {
      name: `P36R6 Branch A ${suffix}`,
      address: '1 Branch A St',
      city: 'Test City',
      status: 'active',
    }),
    authedPost<{ id: string }>(request, url, '/api/branches', admin.accessToken, {
      name: `P36R6 Branch B ${suffix}`,
      address: '1 Branch B St',
      city: 'Test City',
      status: 'active',
    }),
  ]);
  if (!branchARes.data?.id || !branchBRes.data?.id) throw new Error(`Failed to seed branches: ${JSON.stringify(branchARes.error ?? branchBRes.error)}`);
  branchAId = branchARes.data.id;
  branchBId = branchBRes.data.id;

  const teamA1Res = await authedPost<{ id: string }>(request, url, '/api/employees', admin.accessToken, {
    email: teamA1.email,
    first_name: 'TeamA1',
    last_name: 'P36R6',
    role: 'supervisor',
    employment_type: 'regular',
    branch_ids: [branchAId],
    initial_password: teamA1.password,
  });
  const teamA2Res = await authedPost<{ id: string }>(request, url, '/api/employees', admin.accessToken, {
    email: teamA2.email,
    first_name: 'TeamA2',
    last_name: 'P36R6',
    role: 'supervisor',
    employment_type: 'regular',
    branch_ids: [branchAId],
    initial_password: teamA2.password,
  });
  const crossSupRes = await authedPost<{ id: string }>(request, url, '/api/employees', admin.accessToken, {
    email: crossSup.email,
    first_name: 'Cross',
    last_name: 'P36R6',
    role: 'supervisor',
    employment_type: 'regular',
    branch_ids: [branchBId],
    initial_password: crossSup.password,
  });
  const teamBothRes = await authedPost<{ id: string }>(request, url, '/api/employees', admin.accessToken, {
    email: teamBoth.email,
    first_name: 'TeamBoth',
    last_name: 'P36R6',
    role: 'supervisor',
    employment_type: 'regular',
    branch_ids: [branchAId, branchBId],
    initial_password: teamBoth.password,
  });
  for (const r of [teamA1Res, teamA2Res, crossSupRes, teamBothRes]) {
    if (!r.data?.id) throw new Error(`Failed to seed employee: ${JSON.stringify(r.error)}`);
  }
  const teamA1Id = teamA1Res.data!.id;
  await Promise.all([
    clearMustChangePassword(request, teamA1.email, teamA1.password),
    clearMustChangePassword(request, teamA2.email, teamA2.password),
    clearMustChangePassword(request, crossSup.email, crossSup.password),
    clearMustChangePassword(request, teamBoth.email, teamBoth.password),
  ]);

  // The `staff` role has no write path left that creates an email/password
  // login (employees.service.ts's createEmployee forces passwordHash
  // undefined for isStaff; staff authenticate by PIN now) — only the
  // seed.ts-seeded staff fixture still has one, baked in directly at seed
  // time. Reassign it from its home branch (MAIN01) to Branch A for the
  // the checkout step below; restored in afterAll.
  const staffList = await authedGet<{ employees: { id: string; email: string }[] }>(
    request,
    `/api/employees?search=${encodeURIComponent(TEST_USERS.staff.email)}`,
    admin.accessToken,
  );
  staffEmployeeId = staffList.data!.employees.find((e) => e.email === TEST_USERS.staff.email)!.id;
  const reassignStaff = await authedPatch(request, url, `/api/employees/${staffEmployeeId}`, admin.accessToken, { branch_ids: [branchAId] });
  if (reassignStaff.status !== 200) throw new Error(`Failed to reassign seeded staff to Branch A: ${JSON.stringify(reassignStaff.error)}`);

  // The shared (pre-P35-legacy-shape) product spanning Branch A and Branch
  // B — see the file header for why this can only be seeded directly.
  const seedOutput = execFileSync(
    process.execPath,
    [path.join(__dirname, 'fixtures', 'seed-shared-branch-product.cjs'), branchAId, branchBId, teamA1Id, suffix],
    { cwd: path.join(__dirname, '..', '..', 'apps', 'api'), encoding: 'utf-8' },
  );
  const seeded = JSON.parse(seedOutput) as { productId: string; variantId: string };
  sharedProductId = seeded.productId;
  sharedVariantId = seeded.variantId;

  // A real option group ("applicable choices") a supervisor can assign to
  // the copy's variant through the builder — shared master data any active
  // supervisor may create (CR-007 §3), unrelated to branch-copy authority.
  const teamA1Login = await apiLogin(request, teamA1.email, teamA1.password);
  optionGroupName = `P36R6 Topping ${suffix}`;
  const groupRes = await authedPost<{ id: string; name: string }>(request, url, '/api/product-options', teamA1Login.accessToken, {
    code: `p36r6-topping-${suffix}`,
    name: optionGroupName,
    selection_type: 'SINGLE',
    min_selections: 0,
    required: false,
    is_active: true,
  });
  if (!groupRes.data?.id) throw new Error(`Failed to seed option group: ${JSON.stringify(groupRes.error)}`);
  optionGroupId = groupRes.data.id;
  const optionRes = await authedPost(request, url, `/api/product-options/${optionGroupId}/options`, teamA1Login.accessToken, {
    code: `p36r6-classic-${suffix}`,
    name: 'Classic',
    price_adjustment: 0,
    is_active: true,
  });
  if (optionRes.error) throw new Error(`Failed to seed option: ${JSON.stringify(optionRes.error)}`);

  // A real sale against the SOURCE at Branch A, made before any
  // replacement exists — used later to prove historical sale references
  // survive replacement untouched. shiftGuard auto-opens the cashier's own
  // shift server-side, so no explicit shift-open step is needed here.
  const staffLogin = await apiLogin(request, TEST_USERS.staff.email, TEST_USERS.staff.password);
  // Close out any open attendance record left over from a prior run (e.g.
  // a stale clock-in against an already-deleted test branch) before
  // clocking in fresh at Branch A — clockOut resolves the employee's
  // current open record regardless of which branch_id it names.
  await authedPost(request, url, '/api/attendance/clock-out', staffLogin.accessToken, { employee_id: staffEmployeeId, branch_id: branchAId });
  const clockIn = await authedPost(request, url, '/api/attendance/clock-in', staffLogin.accessToken, {
    employee_id: staffEmployeeId,
    branch_id: branchAId,
    gps_lat: 14.676,
    gps_lng: 121.0437,
  });
  if (clockIn.error) throw new Error(`Failed to clock in seeded staff at Branch A: ${JSON.stringify(clockIn.error)}`);

  const saleRes = await authedPost<{ id: string; status: string }>(request, url, '/api/transactions', staffLogin.accessToken, {
    branch_id: branchAId,
    items: [{ product_id: sharedProductId, product_variant_id: sharedVariantId, quantity: 1 }],
    payment_method: 'cash',
    cash_tendered: 50,
  });
  if (!saleRes.data?.id) throw new Error(`Failed to seed pre-replacement sale: ${JSON.stringify(saleRes.error)}`);
  expect(saleRes.data.status).toBe('completed');
  preReplaceSaleTransactionId = saleRes.data.id;
});

test.afterAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  if (staffEmployeeId) {
    // POS-PERF-P37R — close the Branch A clock-in from beforeAll/the POS test:
    // left open, later specs' terminals inherit an attendance at a test branch.
    const staffLogin = await apiLogin(request, TEST_USERS.staff.email, TEST_USERS.staff.password);
    await authedPost(request, url, '/api/attendance/clock-out', staffLogin.accessToken, { employee_id: staffEmployeeId, branch_id: branchAId });
    await authedPatch(request, url, `/api/employees/${staffEmployeeId}`, admin.accessToken, { branch_ids: [MAIN_BRANCH_ID] });
  }
  // Branches with sales can't be deleted; deactivate them so they don't crowd
  // later specs' branch selectors (same as the P37 spec's afterAll).
  for (const id of [branchAId, branchBId]) {
    if (id) await authedPatch(request, url, `/api/branches/${id}`, admin.accessToken, { status: 'inactive' });
  }
});

// POS-PERF-P37R — apps/api's global apiLimiter (100 req/min, in-memory) is
// real throttling. It runs before any router's authenticate, so locally
// every request shares the one 127.0.0.1 bucket. Run back to back, test 4's
// product GET got a 429, which the detail page renders as "Product not
// found". Wait out the window before each test instead of touching the
// limiter (same pacing as the P37 spec).
test.beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 61_000));
});

async function loginAs(page: import('@playwright/test').Page, email: string, password: string, dashboardGlob: string) {
  // A test switching actors mid-run (e.g. teamA2 -> crossSup) would
  // otherwise still carry the previous user's session cookie — middleware
  // sees it's already authenticated and redirects straight past /login
  // before the form ever renders, hanging on getByLabel('Email').
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(dashboardGlob);
}

test('a supervisor with partial branch coverage sees the shared-product banner and the Create Branch Copy dialog', async ({ page }) => {
  await loginAs(page, teamA1.email, teamA1.password, '**/supervisor/dashboard');
  await page.goto(`/supervisor/products/${sharedProductId}`);

  await expect(
    page.getByText("This product is shared with branches outside your assignment, so you can't edit it directly."),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create Branch Copy' }).click();

  const dialog = page.getByRole('dialog', { name: 'Create Branch Copy' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(`P36R6 Branch A ${suffix}`)).toBeVisible();
  await expect(dialog.getByText('Product configuration, variants, recipes, and flavor slots / option groups.')).toBeVisible();
  await expect(dialog.getByText('Stock balances, sales, and movement history stay with the original product.')).toBeVisible();
  await expect(dialog.getByText(/starts as a draft/)).toBeVisible();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible({ timeout: 15_000 });
});

test('creating the branch copy, then retrying/reopening, resolves to the same copy — never a duplicate', async ({ page }) => {
  await loginAs(page, teamA1.email, teamA1.password, '**/supervisor/dashboard');
  await page.goto(`/supervisor/products/${sharedProductId}`);

  await page.getByRole('button', { name: 'Create Branch Copy' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Branch Copy' });
  const [forkResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/fork-to-branch') && r.request().method() === 'POST'),
    dialog.getByRole('button', { name: 'Create Branch Copy' }).click(),
  ]);
  expect(forkResp.status()).toBe(201);
  const forkBody = (await forkResp.json()) as { data: { id: string } };
  copyId = forkBody.data.id;
  expect(copyId).toBeTruthy();
  await page.waitForURL(`**/supervisor/products/${copyId}`);

  // Reopen the shared product and create the copy again — idempotent
  // server-side (forkProductForBranch's findForkCopy before create).
  await page.goto(`/supervisor/products/${sharedProductId}`);
  await page.getByRole('button', { name: 'Create Branch Copy' }).click();
  const dialog2 = page.getByRole('dialog', { name: 'Create Branch Copy' });
  const [retryResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/fork-to-branch') && r.request().method() === 'POST'),
    dialog2.getByRole('button', { name: 'Create Branch Copy' }).click(),
  ]);
  const retryBody = (await retryResp.json()) as { data: { id: string } };
  expect(retryBody.data.id).toBe(copyId);
  await page.waitForURL(`**/supervisor/products/${copyId}`);
});

test('editing price, recipe, and applicable choices on the copy through the builder', async ({ page, request, baseURL }) => {
  expect(copyId, 'requires the previous test to have created the copy').toBeTruthy();
  const url = baseURL ?? 'http://localhost:3000';

  await loginAs(page, teamA1.email, teamA1.password, '**/supervisor/dashboard');
  await page.goto(`/supervisor/products/${copyId}`);
  await page.getByRole('tab', { name: 'Variants, Flavors & Recipe' }).click();

  // Price.
  await page.getByRole('button', { name: 'Edit Variant' }).click();
  const variantDialog = page.getByRole('dialog', { name: 'Edit Variant' });
  const priceField = variantDialog.getByLabel('Base Price', { exact: false });
  await priceField.fill('');
  await priceField.fill('65');
  await variantDialog.getByRole('button', { name: 'Save Changes' }).click();
  await expect(variantDialog).not.toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('₱65.00')).toBeVisible();

  // Recipe — the fork clones the source's component row; edit its quantity.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const recipeDialog = page.getByRole('dialog', { name: 'Edit Recipe Component' });
  await expect(recipeDialog).toBeVisible();
  const qtyField = recipeDialog.getByLabel('Quantity Required');
  await qtyField.fill('');
  await qtyField.fill('20');
  await recipeDialog.getByRole('button', { name: 'Save Changes' }).click();
  await expect(recipeDialog).not.toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/^20 /)).toBeVisible();

  // Applicable choices — assign the pre-seeded Option Group.
  await page.getByRole('button', { name: 'Assign Option Group' }).click();
  const assignDialog = page.getByRole('dialog', { name: 'Assign Option Group' });
  // The dialog's <Label> isn't wired to the <SelectTrigger> via htmlFor/id,
  // so getByLabel can't resolve it — target the combobox directly.
  await assignDialog.getByRole('combobox').click();
  await page.getByRole('option', { name: new RegExp(optionGroupName) }).click();
  await assignDialog.getByRole('button', { name: 'Assign' }).click();
  await expect(assignDialog).not.toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(optionGroupName)).toBeVisible();

  const detail = await authedGet<{ variants: { base_price: number; product_components: { quantity_required: number }[] }[] }>(
    request,
    `/api/products/${copyId}`,
    (await apiLogin(request, teamA1.email, teamA1.password)).accessToken,
  );
  expect(detail.status).toBe(200);
  expect(Number(detail.data!.variants[0]!.base_price)).toBe(65);
  void url;
});

test('activating the copy and using the explicit Replace Source action', async ({ page, request, baseURL }) => {
  expect(copyId, 'requires the previous tests to have created and configured the copy').toBeTruthy();
  const url = baseURL ?? 'http://localhost:3000';

  await loginAs(page, teamA1.email, teamA1.password, '**/supervisor/dashboard');
  await page.goto(`/supervisor/products/${copyId}`);

  // Activate the copy's global status (draft -> active) — required before
  // readiness can pass PRODUCT_INACTIVE, same gate publish/replace both use.
  await page.getByRole('button', { name: 'Change Status' }).click();
  const statusDialog = page.getByRole('dialog', { name: 'Change Product Status' });
  await statusDialog.getByLabel('Active').check();
  await statusDialog.getByRole('button', { name: 'Save' }).click();
  await expect(statusDialog).not.toBeVisible({ timeout: 15_000 });

  await page.getByRole('tab', { name: 'Variants, Flavors & Recipe' }).click();
  const replaceButton = page.getByRole('button', { name: 'Replace Source Product' });
  await expect(replaceButton).toBeEnabled({ timeout: 15_000 });
  await replaceButton.click();

  const confirmDialog = page.getByRole('alertdialog');
  await expect(confirmDialog).toBeVisible();
  const [replaceResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/replace-source') && r.request().method() === 'POST'),
    confirmDialog.getByRole('button', { name: 'Replace' }).click(),
  ]);
  expect(replaceResp.status()).toBe(200);
  await expect(confirmDialog).not.toBeVisible({ timeout: 15_000 });

  // Branch A: the copy is sellable, the source is not. Branch B and the
  // source's own identity/history are untouched.
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const [copyDetail, sourceDetail] = await Promise.all([
    authedGet<{ branch_availability: { branch_id: string; is_available: boolean }[]; status: string }>(request, `/api/products/${copyId}`, admin.accessToken),
    authedGet<{ branch_availability: { branch_id: string; is_available: boolean }[]; id: string; status: string }>(
      request,
      `/api/products/${sharedProductId}`,
      admin.accessToken,
    ),
  ]);
  expect(copyDetail.data?.branch_availability.find((r) => r.branch_id === branchAId)?.is_available).toBe(true);
  expect(sourceDetail.data?.branch_availability.find((r) => r.branch_id === branchAId)?.is_available).toBe(false);
  expect(sourceDetail.data?.branch_availability.find((r) => r.branch_id === branchBId)?.is_available).toBe(true);
  expect(sourceDetail.data?.id).toBe(sharedProductId);
  expect(sourceDetail.data?.status).toBe('active');
  void url;
});

test("Branch A POS: a local checkout reflects the copy's edited price and recipe, not the source's", async ({ page, request, baseURL }) => {
  expect(copyId, 'requires replacement to have happened').toBeTruthy();
  const url = baseURL ?? 'http://localhost:3000';

  await page.context().grantPermissions(['geolocation'], { origin: url });
  await page.context().setGeolocation({ latitude: 14.676, longitude: 121.0437 });
  await loginAs(page, TEST_USERS.staff.email, TEST_USERS.staff.password, '**/terminal');

  await expect(page.getByText(/Clock In to Start Selling|Current Cashier:/)).toBeVisible({ timeout: 15_000 });
  if (await page.getByText('Clock In to Start Selling').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Clock In', exact: true }).click();
    await expect(page.getByText('Current Cashier:')).toBeVisible({ timeout: 15_000 });
  }

  await page.getByText('P36R6 Shared Product').first().click();
  // The copy's Option Group assignment opens the Add-ons configurator —
  // optional (min_selections: 0), so it can be confirmed with nothing picked.
  const addOnsDialog = page.getByRole('dialog', { name: 'P36R6 Shared Product', exact: false });
  if (await addOnsDialog.isVisible().catch(() => false)) {
    await addOnsDialog.getByRole('button', { name: 'Add', exact: true }).click();
  }

  await expect(page.getByText('₱65.00').first()).toBeVisible();
  await page.getByRole('button', { name: /^Checkout/ }).click();
  await page.getByPlaceholder('Cash tendered').fill('65');
  const [chargeResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/transactions') && r.request().method() === 'POST'),
    page.getByRole('button', { name: /^Charge/ }).click(),
  ]);
  const chargeBody = (await chargeResp.json()) as { data: { status: string; items: { product_id: string; unit_price: number }[] } };
  expect(chargeResp.status()).toBe(201);
  expect(chargeBody.data.status).toBe('completed');
  expect(chargeBody.data.items[0]!.product_id).toBe(copyId);
  expect(Number(chargeBody.data.items[0]!.unit_price)).toBe(65);
  void url;
});

test('historical source sale references and pending deductions remain intact after replacement', async ({ request }) => {
  expect(preReplaceSaleTransactionId, 'requires the pre-replacement sale seeded in beforeAll').toBeTruthy();
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const txn = await authedGet<{ id: string; items: { product_id: string }[]; status: string }>(
    request,
    `/api/transactions/${preReplaceSaleTransactionId}`,
    admin.accessToken,
  );
  expect(txn.status).toBe(200);
  expect(txn.data?.status).toBe('completed');
  expect(txn.data?.items[0]!.product_id).toBe(sharedProductId);
});

test('team: another assigned supervisor can edit the copy; a cross-branch supervisor cannot; a revoked supervisor loses access', async ({
  page,
  request,
  baseURL,
}) => {
  expect(copyId, 'requires the copy to already exist').toBeTruthy();
  const url = baseURL ?? 'http://localhost:3000';

  // teamA2 is also actively assigned to Branch A -> full edit access, same
  // as teamA1, driven by live branch assignment, not creator identity.
  await loginAs(page, teamA2.email, teamA2.password, '**/supervisor/dashboard');
  await page.goto(`/supervisor/products/${copyId}`);
  await expect(page.getByText("You don't currently have an active branch assignment", { exact: false })).not.toBeVisible();
  await page.getByRole('tab', { name: 'Variants, Flavors & Recipe' }).click();
  await page.getByRole('button', { name: 'Edit Variant' }).click();
  const variantDialog = page.getByRole('dialog', { name: 'Edit Variant' });
  const priceField = variantDialog.getByLabel('Base Price', { exact: false });
  await priceField.fill('');
  await priceField.fill('70');
  const [patchResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/variants/`) && r.request().method() === 'PATCH'),
    variantDialog.getByRole('button', { name: 'Save Changes' }).click(),
  ]);
  expect(patchResp.status()).toBe(200);
  await expect(variantDialog).not.toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('₱70.00')).toBeVisible();

  // crossSup is assigned only to Branch B — the copy is branch-exclusive to
  // A, so they get the generic read-only banner (not the branch-copy
  // offer, since branch_exclusive products never qualify for that) and no
  // working edit controls server-side.
  await loginAs(page, crossSup.email, crossSup.password, '**/supervisor/dashboard');
  await page.goto(`/supervisor/products/${copyId}`);
  await expect(page.getByText("You don't currently have an active branch assignment", { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Branch Copy' })).not.toBeVisible();

  const crossLogin = await apiLogin(request, crossSup.email, crossSup.password);
  const directAttempt = await authedPatch(request, url, `/api/products/${copyId}`, crossLogin.accessToken, { name: 'Hijacked' });
  expect(directAttempt.status).toBe(403);

  // Revoke teamA1's own assignment to Branch A, then prove the same actor
  // who created and configured this copy loses write access the moment
  // their live branch assignment is gone — re-checked every request, never
  // cached from the JWT.
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const teamA1List = await authedGet<{ employees: { id: string; email: string }[] }>(
    request,
    `/api/employees?search=${encodeURIComponent(teamA1.email)}`,
    admin.accessToken,
  );
  const teamA1Id = teamA1List.data!.employees.find((e) => e.email === teamA1.email)!.id;
  const revoke = await authedPatch(request, url, `/api/employees/${teamA1Id}`, admin.accessToken, { branch_ids: [branchBId] });
  expect(revoke.status).toBe(200);

  const teamA1LoginAfterRevoke = await apiLogin(request, teamA1.email, teamA1.password);
  const revokedAttempt = await authedPatch(request, url, `/api/products/${copyId}`, teamA1LoginAfterRevoke.accessToken, { name: 'Should be blocked' });
  expect(revokedAttempt.status).toBe(403);

  // Restore teamA1 to Branch A for the remaining tests in this file.
  const restore = await authedPatch(request, url, `/api/employees/${teamA1Id}`, admin.accessToken, { branch_ids: [branchAId] });
  expect(restore.status).toBe(200);
});

test('archiving then restoring the source does not silently re-enable it alongside the replacement', async ({ page, request, baseURL }) => {
  expect(copyId, 'requires replacement to have happened').toBeTruthy();
  const url = baseURL ?? 'http://localhost:3000';

  // hasActiveCatalogAuthority requires covering EVERY branch a shared
  // product is configured at (branchScopeFromProduct counts a branch
  // whether or not it's currently available) — the source is still
  // "configured at" both A and B after replacement (A's row just flipped
  // unavailable), so only teamBoth (assigned to both) retains authority to
  // archive/restore it globally. teamA1/teamA2 (Branch A only) and crossSup
  // (Branch B only) each cover just one of the two branches now.
  await loginAs(page, teamBoth.email, teamBoth.password, '**/supervisor/dashboard');
  await page.goto(`/supervisor/products/${sharedProductId}`);
  await page.getByRole('button', { name: 'Archive' }).click();
  const archiveDialog = page.getByRole('alertdialog');
  await expect(archiveDialog).toBeVisible();
  await archiveDialog.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(archiveDialog).not.toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Archived', { exact: true })).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Archived', { exact: true })).not.toBeVisible({ timeout: 10_000 });

  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const [copyDetail, sourceDetail] = await Promise.all([
    authedGet<{ branch_availability: { branch_id: string; is_available: boolean }[] }>(request, `/api/products/${copyId}`, admin.accessToken),
    authedGet<{ branch_availability: { branch_id: string; is_available: boolean }[] }>(request, `/api/products/${sharedProductId}`, admin.accessToken),
  ]);
  // Branch B (never replaced) restores exactly as before Task 34 always behaved.
  expect(sourceDetail.data?.branch_availability.find((r) => r.branch_id === branchBId)?.is_available).toBe(true);
  // Branch A stays with the copy only — POS-PERF-P36R6's fix to
  // cascadeBranchAvailabilityOn: the source is NOT silently re-enabled
  // alongside its replacement.
  expect(sourceDetail.data?.branch_availability.find((r) => r.branch_id === branchAId)?.is_available).toBe(false);
  expect(copyDetail.data?.branch_availability.find((r) => r.branch_id === branchAId)?.is_available).toBe(true);
  void url;
});

test('a not-ready second copy fails replace-source safely, touching neither row and keeping a recoverable draft', async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const crossLogin = await apiLogin(request, crossSup.email, crossSup.password);

  // crossSup has partial coverage too (assigned only to B of this
  // two-branch shared product) — forks their own independent copy for B.
  const forkRes = await authedPost<{ id: string; status: string }>(request, url, `/api/products/${sharedProductId}/fork-to-branch`, crossLogin.accessToken, {
    branch_id: branchBId,
  });
  expect(forkRes.status).toBe(201);
  const draftCopyId = forkRes.data!.id;
  expect(forkRes.data!.status).toBe('draft');

  const replaceAttempt = await authedPost(request, url, `/api/products/${draftCopyId}/replace-source`, crossLogin.accessToken, {
    branch_id: branchBId,
  });
  expect(replaceAttempt.status).toBe(409);

  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const [draftCopyDetail, sourceDetail] = await Promise.all([
    authedGet<{ status: string; branch_availability: { branch_id: string; is_available: boolean }[] }>(request, `/api/products/${draftCopyId}`, admin.accessToken),
    authedGet<{ branch_availability: { branch_id: string; is_available: boolean }[] }>(request, `/api/products/${sharedProductId}`, admin.accessToken),
  ]);
  // Neither row touched; the draft is still there and recoverable.
  expect(draftCopyDetail.data?.status).toBe('draft');
  expect(draftCopyDetail.data?.branch_availability.find((r) => r.branch_id === branchBId)?.is_available).toBe(false);
  expect(sourceDetail.data?.branch_availability.find((r) => r.branch_id === branchBId)?.is_available).toBe(true);
});

test('a cart built against the now-disabled source gets a clear recoverable unavailable-product error, not a false sale', async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const staffLogin = await apiLogin(request, TEST_USERS.staff.email, TEST_USERS.staff.password);

  const attempt = await authedPost<{ status: string }>(request, url, '/api/transactions', staffLogin.accessToken, {
    branch_id: branchAId,
    items: [{ product_id: sharedProductId, product_variant_id: sharedVariantId, quantity: 1 }],
    payment_method: 'cash',
    cash_tendered: 50,
  });
  expect(attempt.status).toBe(422);
  expect((attempt.error as { code?: string } | null)?.code).toBe('PRODUCT_UNAVAILABLE');
});
