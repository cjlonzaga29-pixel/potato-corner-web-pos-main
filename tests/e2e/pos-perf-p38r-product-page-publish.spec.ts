// POS-PERF-P38R — the product page's per-branch Publish, in a real browser,
// for a product whose recipe items have NO inventory link at its branch
// (fixtures/p38-branch-setup.cjs seed + fixtures/p38r-single-publish.cjs).
// Before P38R that Publish stayed disabled (its gate still blocked on
// INVENTORY_STOCK_MISSING) while the builder's Add to POS would have set the
// links up. Now: Publish is enabled and lists the zero-stock links it adds;
// a maintenance pause keeps the page and its error on screen; Publish sets
// up and publishes only its own branch, leaves A's existing balance alone,
// and a repeat adds nothing. A genuinely invalid recipe (no unit
// conversion) keeps Publish disabled with an actionable message, and its
// API publish is refused. Run against local `pos_verify` with a fresh
// apps/api (:4000) and apps/web (:3000), same posture as the P37/P38 specs.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedPost, authedPatch, authedGet } from './fixtures/api-helpers';

test.describe.configure({ mode: 'serial' });
test.setTimeout(420_000);

const suffix = Date.now().toString(36);
const sup = { email: `p38r-sup-${suffix}@test.local`, password: 'P38RSupervisorPass!1' };
const names = { a: `P38R Branch A ${suffix}`, b: `P38R Branch B ${suffix}`, c: `P38R Branch C ${suffix}` };

let branchA = '';
let branchB = '';
let branchC = '';
let fx = { potatoId: '', potatoName: '', cupId: '', cupName: '', flavorId: '', flavorName: '' };
let productId = '';
let invalidProductId = '';

type StockCell = { on_hand: number; reserved: number; low: number | null } | null;

function runFixture(script: string, args: string[]): string {
  return execFileSync(process.execPath, [path.join(__dirname, 'fixtures', script), ...args], {
    cwd: path.join(__dirname, '..', '..', 'apps', 'api'),
    encoding: 'utf-8',
  });
}

function readStock(): Record<string, Record<string, StockCell>> {
  return JSON.parse(runFixture('p38-branch-setup.cjs', ['read', `${fx.potatoId},${fx.cupId}`, branchA, branchB, branchC])) as Record<
    string,
    Record<string, StockCell>
  >;
}

function auditedLinks(id: string): string[] {
  return JSON.parse(runFixture('p38r-single-publish.cjs', ['audits', id])) as string[];
}

// apps/api's global apiLimiter: 100 requests/minute per IP, in-memory; every
// local request shares 127.0.0.1. Same pacing as the P36R/P37/P38 specs.
function waitOutRateLimitWindow() {
  return new Promise((resolve) => setTimeout(resolve, 61_000));
}

async function setWriteGate(request: APIRequestContext, url: string, enabled: boolean) {
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const state = await request.storageState();
  const csrf = state.cookies.find((c) => c.name === 'csrf-token' && new URL(url).hostname === c.domain);
  const res = await request.put('/api/settings/write-gate', {
    data: enabled ? { enabled: true, reason: 'POS-PERF-P38R browser spec: maintenance rejection check' } : { enabled: false },
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

async function catalogHas(request: APIRequestContext, token: string, branchId: string, id: string): Promise<boolean> {
  const res = await authedGet(request, `/api/products/catalog?branch_id=${branchId}`, token);
  expect(res.status).toBe(200);
  return JSON.stringify(res.data).includes(id);
}

async function openPublication(page: Page, id: string) {
  await page.goto(`/supervisor/products/${id}`);
  await page.getByRole('tab', { name: /Variants, Flavors & Recipe/ }).click({ timeout: 15_000 });
  await expect(page.getByText('Readiness & Publication')).toBeVisible();
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
    first_name: 'P38R',
    last_name: 'Supervisor',
    role: 'supervisor',
    employment_type: 'regular',
    branch_ids: [branchA, branchB, branchC],
    initial_password: sup.password,
  });
  if (!res.data?.id) throw new Error(`Failed to seed supervisor: ${JSON.stringify(res.error)}`);
  await clearMustChangePassword(request, sup.email, sup.password);

  // Items with no stock rows at A/B/C — except Potato at A (500 on hand, 7 reserved, low 50).
  fx = JSON.parse(runFixture('p38-branch-setup.cjs', ['seed', branchA, `r${suffix}`])) as typeof fx;

  // Two products the builder would create for a one-branch selection (branch-exclusive to A).
  const supervisor = await apiLogin(request, sup.email, sup.password);
  for (const [label, kg] of [['Cheese Fries', false], ['Kg Recipe', true]] as const) {
    const product = await authedPost<{ id: string }>(request, url, '/api/products', supervisor.accessToken, {
      name: `P38R ${label} ${suffix}`,
      status: 'active',
      branch_ids: [branchA],
    });
    if (!product.data?.id) throw new Error(`Failed to create product: ${JSON.stringify(product.error)}`);
    runFixture('p38r-single-publish.cjs', ['configure', product.data.id, fx.potatoId, fx.cupId, fx.flavorId, ...(kg ? ['kg'] : [])]);
    if (kg) invalidProductId = product.data.id;
    else productId = product.data.id;
  }
});

test.afterAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  await setWriteGate(request, url, false).catch(() => undefined);
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  for (const id of [branchA, branchB, branchC]) {
    if (id) await authedPatch(request, url, `/api/branches/${id}`, admin.accessToken, { status: 'inactive' });
  }
});

test('product page Publish succeeds with missing inventory links and sets up only its own branch', async ({ page, request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  await waitOutRateLimitWindow();
  await loginAs(page, sup.email, sup.password, '**/supervisor/dashboard');
  await openPublication(page, productId);

  // Sale readiness still lists the unpublished state and the missing link; neither disables Publish.
  await expect(page.getByTestId('publication-summary')).toHaveText('Ready to publish.', { timeout: 15_000 });
  await expect(page.getByTestId('publication-setup-items')).toContainText(`zero stock: ${fx.cupName}`); // A already stocks potato
  await expect(page.getByTestId('publication-setup-items')).not.toContainText(fx.potatoName);
  await expect(page.getByTestId('publication-issues')).toHaveCount(0);
  const publish = page.getByRole('button', { name: 'Publish', exact: true });
  await expect(publish).toBeEnabled();

  // --- Maintenance: the write gate rejects; the page and its error stay ---
  await setWriteGate(request, url, true);
  try {
    const [gated] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/products/${productId}/publish`) && r.request().method() === 'POST'),
      publish.click(),
    ]);
    expect(gated.status()).toBe(503);
    await expect(page.getByTestId('product-publish-error')).toContainText('Publishing is paused for maintenance');
    await page.waitForTimeout(6_000); // a toast would be gone by now; this message is not
    await expect(page.getByTestId('product-publish-error')).toBeVisible();
    await expect(page.getByText('Not published at your branch', { exact: true })).toBeVisible();
    expect(page.url()).toContain(`/supervisor/products/${productId}`);
  } finally {
    await setWriteGate(request, url, false);
  }
  const before = readStock();
  expect(before[branchA]?.[fx.cupId]).toBeNull(); // the rejected attempt set nothing up
  expect(auditedLinks(productId)).toEqual([]);

  await waitOutRateLimitWindow();
  // --- Publish ---
  const [publishResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/products/${productId}/publish`) && r.request().method() === 'POST'),
    publish.click(),
  ]);
  expect(publishResp.status()).toBe(200);
  const body = (await publishResp.json()) as { data: { branch_id: string; is_available: boolean } };
  expect(body.data).toMatchObject({ branch_id: branchA, is_available: true }); // unchanged response contract
  await expect(page.getByText('Published at your branch', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('publication-summary')).toHaveText('On POS at your branch.');
  await expect(page.getByRole('button', { name: 'Unpublish' })).toBeVisible();
  await expect(page.getByTestId('product-publish-error')).toHaveCount(0);

  const after = readStock();
  expect(after[branchA]?.[fx.potatoId]).toEqual({ on_hand: 500, reserved: 7, low: 50 }); // untouched
  expect(after[branchA]?.[fx.cupId]).toEqual({ on_hand: 0, reserved: 0, low: null });
  expect(after[branchB]).toEqual({ [fx.potatoId]: null, [fx.cupId]: null });
  expect(after[branchC]).toEqual({ [fx.potatoId]: null, [fx.cupId]: null });
  expect(auditedLinks(productId)).toEqual([`${branchA}:${fx.cupId}`]);

  const supToken = (await apiLogin(request, sup.email, sup.password)).accessToken;
  expect(await catalogHas(request, supToken, branchA, productId)).toBe(true);
  expect(await catalogHas(request, supToken, branchB, productId)).toBe(false);

  // --- Retry: nothing new is linked or audited ---
  const retry = await authedPost<{ branch_id: string }>(request, url, `/api/products/${productId}/publish`, supToken, { branch_id: branchA });
  expect(retry.status).toBe(200);
  expect(readStock()).toEqual(after);
  expect(auditedLinks(productId)).toEqual([`${branchA}:${fx.cupId}`]);
});

test('genuinely invalid setup keeps Publish disabled with an actionable message, and its API publish is refused', async ({ page, request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  await waitOutRateLimitWindow();
  await loginAs(page, sup.email, sup.password, '**/supervisor/dashboard');
  await openPublication(page, invalidProductId);

  await expect(page.getByTestId('publication-summary')).toHaveText('Fix the setup below before publishing.', { timeout: 15_000 });
  await expect(page.getByTestId('publication-issues')).toContainText('there is no conversion from');
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();

  const stockBefore = readStock();
  const supToken = (await apiLogin(request, sup.email, sup.password)).accessToken;
  const single = await authedPost(request, url, `/api/products/${invalidProductId}/publish`, supToken, { branch_id: branchA });
  expect(single.status).toBe(409);
  expect(JSON.stringify(single.error)).toContain('PRODUCT_NOT_READY');
  const multi = await authedPost(request, url, `/api/products/${invalidProductId}/publish-branches`, supToken, { branch_ids: [branchA] });
  expect(multi.status).toBe(409);
  expect(JSON.stringify(multi.error)).toContain('PRODUCT_NOT_READY');
  expect(readStock()).toEqual(stockBefore);
  expect(auditedLinks(invalidProductId)).toEqual([]);
  expect(await catalogHas(request, supToken, branchA, invalidProductId)).toBe(false);
});
