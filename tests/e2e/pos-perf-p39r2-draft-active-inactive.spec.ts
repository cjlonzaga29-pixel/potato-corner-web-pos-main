// POS-PERF-P39R2 — Draft / Active / Inactive from products.ever_published in a
// real browser, against local `pos_verify` with a fresh built apps/api (:4000)
// and apps/web (:3000), same posture as the P39 spec. A product created
// through the builder's API is a Draft (Continue Setup reopens it), Add to POS
// makes it Active, deactivating it at every branch in the Edit popup makes it
// Inactive — and after its audit delivery is made to fail (every outbox intent
// about it stuck, every audit_logs entry about it deleted) a reload and a
// reopen still show it Inactive, never a Draft. A never-published product stays
// a Draft throughout.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedPost, authedPatch, authedGet } from './fixtures/api-helpers';

test.describe.configure({ mode: 'serial' });
test.setTimeout(420_000);

const suffix = Date.now().toString(36);
const sup = { email: `p39r2-sup-${suffix}@test.local`, password: 'P39R2SupervisorPass!1' };
const names = { a: `P39R2 Branch A ${suffix}`, b: `P39R2 Branch B ${suffix}` };
const product = { published: `P39R2 Published ${suffix}`, draft: `P39R2 Never ${suffix}` };

let branchA = '';
let branchB = '';
const ids = { published: '', draft: '' };

function runFixture(script: string, args: string[]): string {
  return execFileSync(process.execPath, [path.join(__dirname, 'fixtures', script), ...args], {
    cwd: path.join(__dirname, '..', '..', 'apps', 'api'),
    encoding: 'utf-8',
  });
}

function productState(productId: string) {
  return JSON.parse(runFixture('p39r2-audit-history.cjs', ['state', productId])) as { status: string; ever_published: boolean; on: string[] };
}

// apps/api's global apiLimiter: 100 requests/minute per IP, in-memory. Same pacing as the P39 spec.
function waitOutRateLimitWindow() {
  return new Promise((resolve) => setTimeout(resolve, 61_000));
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

async function loginAtBranchA(page: Page) {
  await page.context().clearCookies();
  await page.addInitScript((id) => sessionStorage.setItem('potato-corner-active-branch', JSON.stringify({ state: { activeBranchId: id }, version: 0 })), branchA);
  await page.goto('/login');
  await page.getByLabel('Email').fill(sup.email);
  await page.getByRole('textbox', { name: 'Password' }).fill(sup.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/supervisor/dashboard');
  await expect(page.getByRole('heading', { name: 'Supervisor Dashboard' })).toBeVisible({ timeout: 30_000 });
}

async function openProducts(page: Page) {
  await page.getByRole('navigation').getByRole('link', { name: 'Products', exact: true }).click();
  await page.waitForURL('**/supervisor/products');
  await expect(page.getByRole('heading', { name: 'Products', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder('Search products...').fill(suffix);
  await expect(page.getByText(`At ${names.a}`)).toBeVisible({ timeout: 15_000 });
}

function tab(page: Page, label: 'Active' | 'Drafts' | 'Inactive') {
  return page.getByTestId(`products-tab-${label.toLowerCase()}`);
}

function row(page: Page, name: string) {
  return page.getByTestId('product-row').filter({ has: page.getByRole('link', { name, exact: true }) });
}

async function expectCounts(page: Page, active: number, drafts: number, inactive: number) {
  await expect(tab(page, 'Active')).toContainText(`Active${active}`, { timeout: 15_000 });
  await expect(tab(page, 'Drafts')).toContainText(`Drafts${drafts}`);
  await expect(tab(page, 'Inactive')).toContainText(`Inactive${inactive}`);
}

/** Opens the builder's Review step for a product (the persisted draft is how a reload resumes it); same as the P38R3 spec. */
async function openReview(page: Page, productId: string) {
  await page.evaluate((id) => {
    localStorage.setItem('potato-corner:product-builder-draft', JSON.stringify({ state: { productId: id, step: 'review', draftBranchIds: [] }, version: 0 }));
  }, productId);
  await page.goto('/supervisor/products/builder');
  await expect(page.getByTestId('review-branch-status')).toHaveCount(2, { timeout: 30_000 });
}

test.beforeAll(async ({ request, baseURL }) => {
  test.setTimeout(300_000);
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  for (const [key, name] of Object.entries(names)) {
    const res = await authedPost<{ id: string }>(request, url, '/api/branches', admin.accessToken, { name, address: `1 ${name} St`, city: 'Test City', status: 'active' });
    if (!res.data?.id) throw new Error(`Failed to seed branch ${name}: ${JSON.stringify(res.error)}`);
    if (key === 'a') branchA = res.data.id;
    else branchB = res.data.id;
  }
  const res = await authedPost<{ id: string }>(request, url, '/api/employees', admin.accessToken, {
    email: sup.email,
    first_name: 'P39R2',
    last_name: 'Supervisor',
    role: 'supervisor',
    employment_type: 'regular',
    branch_ids: [branchA, branchB],
    initial_password: sup.password,
  });
  if (!res.data?.id) throw new Error(`Failed to seed supervisor: ${JSON.stringify(res.error)}`);
  await clearMustChangePassword(request, sup.email, sup.password);

  const fx = JSON.parse(runFixture('p38-branch-setup.cjs', ['seed', branchA, `p39r2${suffix}`])) as { potatoId: string; cupId: string; flavorId: string };
  const supervisor = await apiLogin(request, sup.email, sup.password);
  for (const key of ['published', 'draft'] as const) {
    const created = await authedPost<{ id: string }>(request, url, '/api/products', supervisor.accessToken, { name: product[key], status: 'active', branch_ids: [branchA, branchB] });
    if (!created.data?.id) throw new Error(`Failed to create ${key}: ${JSON.stringify(created.error)}`);
    ids[key] = created.data.id;
  }
  // Ready to publish (sizes, recipe, flavor), but not published: a builder draft.
  runFixture('p38r-single-publish.cjs', ['configure', ids.published, fx.potatoId, fx.cupId, fx.flavorId]);
});

test.afterAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  for (const id of [branchA, branchB]) {
    if (id) await authedPatch(request, url, `/api/branches/${id}`, admin.accessToken, { status: 'inactive' });
  }
});

test('Draft -> Add to POS -> Active -> deactivated everywhere -> Inactive, and still Inactive after a reload once audit delivery has failed', async ({ page, request }) => {
  await waitOutRateLimitWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAtBranchA(page);
  await openProducts(page);

  // --- Drafts: both products; Continue Setup reopens the saved builder draft ---
  await expectCounts(page, 0, 2, 0);
  await tab(page, 'Drafts').click();
  await expect(row(page, product.published).getByTestId('product-row-status')).toHaveText('Draft');
  await row(page, product.published).getByRole('button', { name: 'Continue Setup' }).click();
  await page.waitForURL(`**/supervisor/products/builder?product_id=${ids.published}`);
  await expect(page.getByTestId('builder-selected-branches')).toContainText(names.a);
  await expect(page.getByTestId('builder-selected-branches')).toContainText(names.b);
  expect(productState(ids.published)).toEqual({ status: 'active', ever_published: false, on: [] });

  // --- Publish: the builder's Add to POS at A and B ---
  await openReview(page, ids.published);
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/products/${ids.published}/publish-branches`) && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Add to POS' }).click(),
  ]);
  expect(resp.status()).toBe(200);
  await page.waitForURL(`**/supervisor/products/${ids.published}`);
  expect(productState(ids.published)).toEqual({ status: 'active', ever_published: true, on: [branchA, branchB].sort() });

  await openProducts(page);
  await expectCounts(page, 1, 1, 0);
  await expect(row(page, product.published).getByTestId('product-row-status')).toHaveText('On POS');

  // --- Deactivate everywhere, in the Edit popup's Branches tab ---
  await row(page, product.published).getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByTestId('product-editor');
  await expect(editor).toBeVisible();
  await editor.getByRole('tab', { name: 'Branches' }).click();
  for (const name of [names.a, names.b]) {
    const branchRow = editor.getByTestId('product-editor-branch').filter({ hasText: name });
    await expect(branchRow).toContainText('On POS');
    await branchRow.getByRole('button', { name: 'Deactivate here' }).click();
    const confirm = editor.getByRole('alertdialog');
    await expect(confirm).toContainText(`at ${name}`);
    await confirm.getByRole('button', { name: 'Deactivate here' }).click();
    await expect(branchRow).toContainText('Not on POS', { timeout: 15_000 });
  }
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor).toBeHidden();
  await expectCounts(page, 0, 1, 1);
  await tab(page, 'Inactive').click();
  await expect(row(page, product.published).getByTestId('product-row-status')).toHaveText(`Off POS at ${names.a}`);
  expect(productState(ids.published)).toEqual({ status: 'active', ever_published: true, on: [] });

  // --- Audit delivery fails: no outbox intent will be delivered and no audit_logs entry is left ---
  const stranded = JSON.parse(runFixture('p39r2-audit-history.cjs', ['strand', ids.published])) as { outbox_stuck: number; audit_logs_deleted: number };
  expect(stranded.outbox_stuck).toBeGreaterThan(0);

  // --- Reload: still Inactive, the never-published product still a Draft ---
  // A reload refreshes the access token. Under load that refresh can exceed Prisma's 5 s transaction
  // timeout (P2028; pre-existing, see the P39 runbook) and the app falls back to the dashboard. The
  // spec records which happened and, after a fallback, opens Products again in-app.
  await page.reload();
  const productsHeading = page.getByRole('heading', { name: 'Products', exact: true });
  const dashboardHeading = page.getByRole('heading', { name: 'Supervisor Dashboard' });
  await expect(productsHeading.or(dashboardHeading)).toBeVisible({ timeout: 30_000 });
  if (await dashboardHeading.isVisible()) {
    test.info().annotations.push({ type: 'reload', description: 'token refresh fell back to the dashboard (pre-existing P2028); reopened Products in-app' });
    await openProducts(page);
  } else {
    test.info().annotations.push({ type: 'reload', description: 'reload stayed on Products' });
    await page.getByPlaceholder('Search products...').fill(suffix);
  }
  await expectCounts(page, 0, 1, 1);
  await tab(page, 'Inactive').click();
  await expect(row(page, product.published).getByTestId('product-row-status')).toHaveText(`Off POS at ${names.a}`);
  await expect(row(page, product.published).getByRole('button', { name: 'Edit' })).toBeVisible();
  await tab(page, 'Drafts').click();
  await expect(row(page, product.draft).getByTestId('product-row-status')).toHaveText('Draft');
  await expect(page.getByTestId('product-row')).toHaveCount(1);

  // --- Reopen: the Edit popup on the Inactive product still works ---
  await tab(page, 'Inactive').click();
  await row(page, product.published).getByRole('button', { name: 'Edit' }).click();
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('tab')).toHaveText(['Details', 'Sizes & Prices', 'Ingredients & Packaging', 'Flavors & Choices', 'Branches']);
  await editor.getByRole('tab', { name: 'Branches' }).click();
  await expect(editor.getByTestId('product-editor-branch').filter({ hasText: names.a })).toContainText('Not on POS');
  await page.screenshot({ path: test.info().outputPath('p39r2-inactive-after-audit-failure.png') });
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor).toBeHidden();

  // Continue Setup still reopens the never-published draft.
  await tab(page, 'Drafts').click();
  await row(page, product.draft).getByRole('button', { name: 'Continue Setup' }).click();
  await page.waitForURL(`**/supervisor/products/builder?product_id=${ids.draft}`);
  await expect(page.getByTestId('builder-selected-branches')).toContainText(names.b);

  // The server's own answer agrees with the page.
  const supervisor = await apiLogin(request, sup.email, sup.password);
  const listed = await authedGet<{ counts: Record<string, number> }>(request, `/api/products?branch_id=${branchA}&view=inactive&search=${suffix}&page=1&limit=25`, supervisor.accessToken);
  expect(listed.data?.counts).toEqual({ active: 0, drafts: 1, inactive: 1 });
});
