// POS-PERF-P38 — automatic selected-branch setup, in a real browser: select two
// branches -> two sizes, ingredients/packaging, a flavor -> Review -> Add to
// POS -> both branch catalogs. The recipe items have NO inventory link at
// either selected branch (fixtures/p38-branch-setup.cjs creates them without
// one), which is the reported "Cheese Fries is not available at this branch"
// blocker. Also: a maintenance pause keeps the builder intact, existing
// balances are untouched, nothing is linked at the unselected branch C, a
// repeat Add to POS duplicates nothing, and a sale at A deducts only A while
// zero stock at B refuses the sale. Run against local `pos_verify` with a
// fresh apps/api (:4000) and apps/web (:3000), same posture as the P37 spec.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedPost, authedPatch, authedGet } from './fixtures/api-helpers';

test.describe.configure({ mode: 'serial' });
test.setTimeout(420_000);

const suffix = Date.now().toString(36);
const MAIN_BRANCH_ID = 'ff0da4c4-4685-4a62-9c67-2f0c7e25c6ab'; // seeded "Main Branch" — the seeded staff fixture's home branch, restored in afterAll.
const sup = { email: `p38-sup-${suffix}@test.local`, password: 'P38SupervisorPass!1' };
const names = { a: `P38 Branch A ${suffix}`, b: `P38 Branch B ${suffix}`, c: `P38 Branch C ${suffix}` };
const productName = `P38 Cheese Fries ${suffix}`;

let branchA = '';
let branchB = '';
let branchC = '';
let fx = { potatoId: '', potatoName: '', cupId: '', cupName: '', flavorId: '', flavorName: '' };
let productId = '';
let regularVariantId = '';
let staffEmployeeId = '';

type StockCell = { on_hand: number; reserved: number; low: number | null } | null;

function runFixture(args: string[]): string {
  return execFileSync(process.execPath, [path.join(__dirname, 'fixtures', 'p38-branch-setup.cjs'), ...args], {
    cwd: path.join(__dirname, '..', '..', 'apps', 'api'),
    encoding: 'utf-8',
  });
}

function readStock(): Record<string, Record<string, StockCell>> {
  return JSON.parse(runFixture(['read', `${fx.potatoId},${fx.cupId}`, branchA, branchB, branchC])) as Record<string, Record<string, StockCell>>;
}

// apps/api's global apiLimiter: 100 requests/minute per IP, in-memory; every
// local request shares 127.0.0.1. Same pacing as the P36R/P37 specs.
function waitOutRateLimitWindow() {
  return new Promise((resolve) => setTimeout(resolve, 61_000));
}

async function setWriteGate(request: APIRequestContext, url: string, enabled: boolean) {
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const state = await request.storageState();
  const csrf = state.cookies.find((c) => c.name === 'csrf-token' && new URL(url).hostname === c.domain);
  const res = await request.put('/api/settings/write-gate', {
    data: enabled ? { enabled: true, reason: 'POS-PERF-P38 browser spec: maintenance rejection check' } : { enabled: false },
    headers: { Authorization: `Bearer ${admin.accessToken}`, 'X-CSRF-Token': csrf ? decodeURIComponent(csrf.value) : '' },
  });
  if (!res.ok()) throw new Error(`write gate ${enabled ? 'close' : 'open'} failed: ${res.status()} ${await res.text()}`);
}

async function clearMustChangePassword(request: APIRequestContext, email: string, password: string) {
  const login = await apiLogin(request, email, password);
  const state = await request.storageState();
  const csrfCookie = state.cookies.find((c) => c.name === 'csrf-token');
  const res = await request.post('/api/auth/change-password', {
    headers: { Authorization: `Bearer ${login.accessToken}`, 'X-CSRF-Token': csrfCookie ? decodeURIComponent(csrfCookie.value) : '', 'X-Device-Id': randomUUID() },
    data: { current_password: password, new_password: password, confirm_password: password },
  });
  if (!res.ok()) throw new Error(`Failed to clear must_change_password: ${res.status()} ${await res.text()}`);
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
  const res = await authedGet(request, `/api/products/catalog?branch_id=${branchId}`, token);
  expect(res.status).toBe(200);
  return JSON.stringify(res.data).includes(productId);
}

async function addComponent(page: Page, sizeLabel: string, itemName: string, quantity: string) {
  const panel = page.locator('div.bg-card').filter({ hasText: `Inventory items consumed by ${sizeLabel}` }).last();
  await panel.getByRole('button', { name: 'Add Component' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Recipe Component' });
  await dialog.getByLabel('Inventory Item').click();
  await page.getByRole('option', { name: itemName }).click();
  await dialog.getByLabel('Quantity Required').fill(quantity);
  await dialog.getByRole('button', { name: 'Add Component', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(panel.getByText(itemName)).toBeVisible();
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

  const res = await authedPost<{ id: string }>(request, url, '/api/employees', admin.accessToken, {
    email: sup.email,
    first_name: 'P38',
    last_name: 'Supervisor',
    role: 'supervisor',
    employment_type: 'regular',
    branch_ids: [branchA, branchB, branchC],
    initial_password: sup.password,
  });
  if (!res.data?.id) throw new Error(`Failed to seed supervisor: ${JSON.stringify(res.error)}`);
  await clearMustChangePassword(request, sup.email, sup.password);

  // Items created AFTER the branches, with no stock rows at A/B/C — except Potato at A (500 on hand, 7 reserved).
  fx = JSON.parse(runFixture(['seed', branchA, suffix])) as typeof fx;

  const staffList = await authedGet<{ employees: { id: string; email: string }[] }>(
    request,
    `/api/employees?search=${encodeURIComponent(TEST_USERS.staff.email)}`,
    admin.accessToken,
  );
  staffEmployeeId = staffList.data?.employees.find((e) => e.email === TEST_USERS.staff.email)?.id ?? '';
  if (!staffEmployeeId) throw new Error('Seeded staff fixture not found');
});

test.afterAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  await setWriteGate(request, url, false).catch(() => undefined);
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  if (staffEmployeeId) {
    await authedPatch(request, url, `/api/employees/${staffEmployeeId}`, admin.accessToken, { branch_ids: [MAIN_BRANCH_ID] });
    const staff = await apiLogin(request, TEST_USERS.staff.email, TEST_USERS.staff.password);
    await authedPost(request, url, '/api/attendance/clock-out', staff.accessToken, { employee_id: staffEmployeeId, branch_id: MAIN_BRANCH_ID });
  }
  for (const id of [branchA, branchB, branchC]) {
    if (id) await authedPatch(request, url, `/api/branches/${id}`, admin.accessToken, { status: 'inactive' });
  }
});

test('select A+B -> sizes, ingredients, flavor -> Review -> Add to POS sets up both branches and publishes once', async ({ page, request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  await waitOutRateLimitWindow();
  await loginAs(page, sup.email, sup.password, '**/supervisor/dashboard');
  await page.goto('/supervisor/products/builder');

  // --- Step 1: details + branch selection ---
  await page.getByRole('checkbox', { name: names.a, exact: true }).click({ timeout: 15_000 });
  await page.getByRole('checkbox', { name: names.b, exact: true }).click();
  await expect(page.getByTestId('builder-branch-count')).toContainText('2 branches selected');
  await page.getByLabel('Product Name').fill(productName);
  const [createResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/products') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Continue to Sizes & Prices' }).click(),
  ]);
  expect(createResp.status()).toBe(201);
  productId = ((await createResp.json()) as { data: { id: string } }).data.id;

  // --- Step 2: two sizes ---
  for (const [name, price] of [['Regular', '59'], ['Large', '89']] as const) {
    await page.getByRole('button', { name: 'Add Size' }).click();
    await page.getByLabel('Variant Name').fill(name);
    await page.getByLabel('Size Label').fill(name);
    await page.getByLabel('Base Price', { exact: false }).fill(price);
    await page.getByRole('button', { name: 'Add Variant' }).click();
    await expect(page.getByText(`${name} — ${name}`)).toBeVisible();
  }
  await page.getByRole('button', { name: 'Continue to Ingredients & Packaging' }).click();

  // --- Step 3: ingredient + packaging per size (shared recipe) ---
  await expect(page.getByText(/Add to POS adds it\s+to that branch's inventory at zero stock/)).toBeVisible();
  await addComponent(page, 'Regular (Regular)', fx.potatoName, '150');
  await addComponent(page, 'Regular (Regular)', fx.cupName, '1');
  await waitOutRateLimitWindow();
  await addComponent(page, 'Large (Large)', fx.potatoName, '250');
  await addComponent(page, 'Large (Large)', fx.cupName, '1');
  // No misleading per-branch inventory badge before Add to POS.
  await expect(page.getByText('Inventory Incomplete')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue to Choices' }).click();

  // --- Step 4: one flavor per size ---
  for (const index of [0, 1]) {
    await page.getByRole('button', { name: 'Link Flavor' }).nth(index).click();
    const dialog = page.getByRole('dialog', { name: 'Link Flavor' });
    await dialog.getByRole('combobox').first().click();
    await page.getByRole('option', { name: fx.flavorName }).click();
    await dialog.getByRole('button', { name: 'Link Flavor' }).click();
    await expect(dialog).not.toBeVisible();
  }
  await expect(page.getByText(fx.flavorName)).toHaveCount(2);
  await waitOutRateLimitWindow();
  await page.getByRole('button', { name: 'Continue to Review' }).click();

  // --- Step 5: Review — simple statuses, no circular "enable it first" blocker ---
  const statuses = page.getByTestId('review-branch-status');
  await expect(statuses).toHaveCount(2, { timeout: 15_000 });
  await expect(statuses.filter({ hasText: names.a })).toContainText('Ready to add to POS');
  await expect(statuses.filter({ hasText: names.b })).toContainText('Ready to add to POS');
  await expect(statuses.filter({ hasText: names.a })).toContainText(`zero stock: ${fx.cupName}`); // A already stocks potato
  await expect(statuses.filter({ hasText: names.b })).toContainText(`${fx.potatoName}, ${fx.cupName}`);
  await expect(page.getByTestId('review-selected-branches')).not.toContainText(names.c);
  await expect(page.getByText('Stock is tracked separately at each branch', { exact: false })).toBeVisible();
  await expect(page.getByText('Not added to POS yet')).toBeVisible();
  await expect(page.getByText('is not available at this branch')).toHaveCount(0);
  await expect(page.getByText('Manage Branch Availability')).toHaveCount(0);
  await expect(page.getByText(/\d+(\.\d+)?%/)).toHaveCount(0);
  await expect(page.getByTestId('review-missing-setup')).toHaveCount(0);
  const addToPos = page.getByRole('button', { name: 'Add to POS' });
  await expect(addToPos).toBeEnabled();

  // --- Maintenance: the write gate rejects; the builder keeps everything ---
  await setWriteGate(request, url, true);
  try {
    const [gated] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/products/${productId}/publish-branches`) && r.request().method() === 'POST'),
      addToPos.click(),
    ]);
    expect(gated.status()).toBe(503);
    await expect(page.getByTestId('builder-write-error')).toContainText('Add to POS is paused for maintenance');
    await page.waitForTimeout(6_000); // a toast would be gone by now; this message is not
    await expect(page.getByTestId('builder-write-error')).toBeVisible();
    await expect(statuses).toHaveCount(2);
    expect(page.url()).toContain('/supervisor/products/builder');
  } finally {
    await setWriteGate(request, url, false);
  }
  const before = readStock();
  expect(before[branchB]?.[fx.potatoId]).toBeNull(); // the rejected attempt set nothing up
  expect(before[branchB]?.[fx.cupId]).toBeNull();

  await waitOutRateLimitWindow();
  // --- Add to POS ---
  const [publishResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/products/${productId}/publish-branches`) && r.request().method() === 'POST'),
    addToPos.click(),
  ]);
  expect(publishResp.status()).toBe(200);
  await page.waitForURL(`**/supervisor/products/${productId}`);

  const supToken = (await apiLogin(request, sup.email, sup.password)).accessToken;
  expect(await catalogHas(request, supToken, branchA)).toBe(true);
  expect(await catalogHas(request, supToken, branchB)).toBe(true);
  expect(await catalogHas(request, supToken, branchC)).toBe(false);

  const after = readStock();
  expect(after[branchA]?.[fx.potatoId]).toEqual({ on_hand: 500, reserved: 7, low: 50 }); // untouched
  expect(after[branchA]?.[fx.cupId]).toEqual({ on_hand: 0, reserved: 0, low: null });
  expect(after[branchB]?.[fx.potatoId]).toEqual({ on_hand: 0, reserved: 0, low: null });
  expect(after[branchB]?.[fx.cupId]).toEqual({ on_hand: 0, reserved: 0, low: null });
  expect(after[branchC]).toEqual({ [fx.potatoId]: null, [fx.cupId]: null });

  const detail = await authedGet<{ variants: { id: string; name: string }[] }>(request, `/api/products/${productId}`, supToken);
  regularVariantId = detail.data?.variants.find((v) => v.name === 'Regular')?.id ?? '';
  expect(regularVariantId).toBeTruthy();
});

test('repeat Add to POS duplicates nothing; a sale at A deducts only A; zero stock at B refuses the sale', async ({ request, baseURL }) => {
  expect(regularVariantId, 'requires the published product from the previous test').toBeTruthy();
  const url = baseURL ?? 'http://localhost:3000';
  await waitOutRateLimitWindow();

  const supervisor = await apiLogin(request, sup.email, sup.password);
  const start = readStock();
  const retry = await authedPost<{ setup: { stock_links: unknown[] } }>(request, url, `/api/products/${productId}/publish-branches`, supervisor.accessToken, {
    branch_ids: [branchB, branchA],
  });
  expect(retry.status).toBe(200);
  expect(retry.data?.setup.stock_links).toEqual([]);
  expect(readStock()).toEqual(start);

  // A delivery of cups at A (fixture), then one Regular at A.
  runFixture(['deliver', branchA, fx.cupId, '100']);
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  // Staff carry exactly one branch, so the seeded staff fixture is reassigned per sale (same as P37's sellOneAt).
  expect((await authedPatch(request, url, `/api/employees/${staffEmployeeId}`, admin.accessToken, { branch_ids: [branchA] })).status).toBe(200);
  let staff = await apiLogin(request, TEST_USERS.staff.email, TEST_USERS.staff.password);
  const item = { product_id: productId, product_variant_id: regularVariantId, flavor_id: fx.flavorId, quantity: 1 };

  await authedPost(request, url, '/api/attendance/clock-out', staff.accessToken, { employee_id: staffEmployeeId, branch_id: branchA });
  const clockInA = await authedPost(request, url, '/api/attendance/clock-in', staff.accessToken, {
    employee_id: staffEmployeeId,
    branch_id: branchA,
    gps_lat: 14.676,
    gps_lng: 121.0437,
  });
  expect(clockInA.error, JSON.stringify(clockInA.error)).toBeNull();
  const sale = await authedPost<{ id: string; status: string }>(request, url, '/api/transactions', staff.accessToken, {
    branch_id: branchA,
    items: [item],
    payment_method: 'cash',
    cash_tendered: 100,
  });
  expect(sale.status, JSON.stringify(sale.error)).toBe(201);
  await expect
    .poll(
      async () =>
        (await authedGet<{ inventory_deduction_status: string }>(request, `/api/transactions/${sale.data?.id}`, admin.accessToken)).data
          ?.inventory_deduction_status,
      { timeout: 30_000, intervals: [2_000] },
    )
    .toBe('completed');
  await authedPost(request, url, '/api/attendance/clock-out', staff.accessToken, { employee_id: staffEmployeeId, branch_id: branchA });

  const afterA = readStock();
  expect(afterA[branchA]?.[fx.potatoId]).toEqual({ on_hand: 350, reserved: 7, low: 50 });
  expect(afterA[branchA]?.[fx.cupId]).toEqual({ on_hand: 99, reserved: 0, low: null });
  expect(afterA[branchB]).toEqual(start[branchB]);
  expect(afterA[branchC]).toEqual(start[branchC]);

  // Configured and published at B, but B has zero stock: checkout refuses, nothing changes.
  expect((await authedPatch(request, url, `/api/employees/${staffEmployeeId}`, admin.accessToken, { branch_ids: [branchB] })).status).toBe(200);
  staff = await apiLogin(request, TEST_USERS.staff.email, TEST_USERS.staff.password);
  await authedPost(request, url, '/api/attendance/clock-out', staff.accessToken, { employee_id: staffEmployeeId, branch_id: branchB });
  const clockInB = await authedPost(request, url, '/api/attendance/clock-in', staff.accessToken, {
    employee_id: staffEmployeeId,
    branch_id: branchB,
    gps_lat: 14.676,
    gps_lng: 121.0437,
  });
  expect(clockInB.error, JSON.stringify(clockInB.error)).toBeNull();
  const refused = await authedPost(request, url, '/api/transactions', staff.accessToken, {
    branch_id: branchB,
    items: [item],
    payment_method: 'cash',
    cash_tendered: 100,
  });
  await authedPost(request, url, '/api/attendance/clock-out', staff.accessToken, { employee_id: staffEmployeeId, branch_id: branchB });
  expect(refused.status).toBe(409);
  expect(JSON.stringify(refused.error)).toContain('INSUFFICIENT_STOCK');
  expect(readStock()).toEqual(afterA);
});
