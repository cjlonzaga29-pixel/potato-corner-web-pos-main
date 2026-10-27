// POS-PERF-P39 — the supervisor Products page and its Edit popup in a real
// browser, against local `pos_verify` with a fresh built apps/api (:4000) and
// apps/web (:3000), same posture as the P37/P38 specs. Covers: Active / Drafts
// / Inactive tabs and counts for the selected branch, compact rows at desktop,
// tablet and phone widths, the Edit popup's staged Details (save, discard on
// close), section forms opening inside the popup (no second modal), sizes,
// recipe, choices and Mix & Max reachable, branch-only deactivation, Continue
// Setup reopening the builder draft, and Archive / Delete through the
// existing rules (delete refused while a recipe refers to the product).
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedPost, authedPatch, authedGet } from './fixtures/api-helpers';

test.describe.configure({ mode: 'serial' });
test.setTimeout(420_000);

const suffix = Date.now().toString(36);
const sup = { email: `p39-sup-${suffix}@test.local`, password: 'P39SupervisorPass!1' };
const names = { a: `P39 Branch A ${suffix}`, b: `P39 Branch B ${suffix}` };
const product = {
  configured: `P39 Configured ${suffix}`,
  draft: `P39 Draft ${suffix}`,
  deletable: `P39 Deletable ${suffix}`,
  paused: `P39 Paused ${suffix}`,
  archived: `P39 Archived ${suffix}`,
};

let branchA = '';
let branchB = '';
const ids: Record<keyof typeof product, string> = { configured: '', draft: '', deletable: '', paused: '', archived: '' };

function runFixture(script: string, args: string[]): string {
  return execFileSync(process.execPath, [path.join(__dirname, 'fixtures', script), ...args], {
    cwd: path.join(__dirname, '..', '..', 'apps', 'api'),
    encoding: 'utf-8',
  });
}

// apps/api's global apiLimiter: 100 requests/minute per IP, in-memory; every
// local request shares 127.0.0.1. Same pacing as the P36R/P37/P38 specs.
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
  // The sidebar's branch selector persists only the branch id (sessionStorage).
  await page.addInitScript((id) => sessionStorage.setItem('potato-corner-active-branch', JSON.stringify({ state: { activeBranchId: id }, version: 0 })), branchA);
  await page.goto('/login');
  await page.getByLabel('Email').fill(sup.email);
  await page.getByRole('textbox', { name: 'Password' }).fill(sup.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/supervisor/dashboard');
  // Let the post-login navigation finish rendering, or it can replace the page we open next.
  await expect(page.getByRole('heading', { name: 'Supervisor Dashboard' })).toBeVisible({ timeout: 30_000 });
}

async function openProducts(page: Page) {
  // Navigate in-app, as a supervisor does. A page.goto reload drops the in-memory access token and
  // forces a token refresh, which on a loaded machine can exceed Prisma's interactive-transaction
  // timeout and log the session out (pre-existing; see the runbook's limitations).
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

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.beforeAll(async ({ request, baseURL }) => {
  // Hooks don't inherit the file-level test timeout; setup makes ~20 API calls plus fixture runs.
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
    first_name: 'P39',
    last_name: 'Supervisor',
    role: 'supervisor',
    employment_type: 'regular',
    branch_ids: [branchA, branchB],
    initial_password: sup.password,
  });
  if (!res.data?.id) throw new Error(`Failed to seed supervisor: ${JSON.stringify(res.error)}`);
  await clearMustChangePassword(request, sup.email, sup.password);

  const fx = JSON.parse(runFixture('p38-branch-setup.cjs', ['seed', branchA, `p39${suffix}`])) as { potatoId: string; cupId: string; flavorId: string };
  const supervisor = await apiLogin(request, sup.email, sup.password);
  const token = supervisor.accessToken;
  async function create(key: keyof typeof product, branchIds: string[]) {
    const created = await authedPost<{ id: string }>(request, url, '/api/products', token, { name: product[key], status: 'active', branch_ids: branchIds });
    if (!created.data?.id) throw new Error(`Failed to create ${key}: ${JSON.stringify(created.error)}`);
    ids[key] = created.data.id;
    return created.data.id;
  }

  // Active at A: two sizes, a recipe and a flavor (fixture), published through the real endpoint.
  await create('configured', [branchA]);
  runFixture('p38r-single-publish.cjs', ['configure', ids.configured, fx.potatoId, fx.cupId, fx.flavorId]);
  const published = await authedPost(request, url, `/api/products/${ids.configured}/publish`, token, { branch_id: branchA });
  if (published.status !== 200) throw new Error(`publish failed: ${published.status} ${JSON.stringify(published.error)}`);
  // Drafts: a builder draft shared by A and B with one size, and one with nothing yet.
  await create('draft', [branchA, branchB]);
  await authedPost(request, url, `/api/products/${ids.draft}/variants`, token, { name: 'Regular', size_label: 'Regular', base_price: 49 });
  await create('deletable', [branchA]);
  // Inactive: on POS once, then taken off; and archived.
  await create('paused', [branchA]);
  await authedPatch(request, url, `/api/products/${ids.paused}/branch-availability/${branchA}`, token, { is_available: true });
  await authedPost(request, url, `/api/products/${ids.paused}/unpublish`, token, { branch_id: branchA });
  await create('archived', [branchA]);
  await authedPatch(request, url, `/api/products/${ids.archived}/status`, token, { status: 'archived' });
});

test.afterAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  for (const id of [branchA, branchB]) {
    if (id) await authedPatch(request, url, `/api/branches/${id}`, admin.accessToken, { status: 'inactive' });
  }
});

test('tabs classify by the selected branch, with counts, at desktop, tablet and phone widths', async ({ page }) => {
  await waitOutRateLimitWindow();
  await loginAtBranchA(page);
  await openProducts(page);

  await expectCounts(page, 1, 2, 2);
  await expect(row(page, product.configured).getByTestId('product-row-status')).toHaveText('On POS');
  await expect(row(page, product.configured).getByLabel('Branches')).toContainText(names.a);

  await tab(page, 'Drafts').click();
  await expect(row(page, product.draft).getByTestId('product-row-status')).toHaveText('Draft');
  await expect(row(page, product.draft).getByRole('button', { name: 'Continue Setup' })).toBeVisible();
  await expect(row(page, product.deletable)).toBeVisible();

  await tab(page, 'Inactive').click();
  await expect(row(page, product.archived).getByTestId('product-row-status')).toHaveText('Archived');
  await expect(row(page, product.paused).getByTestId('product-row-status')).toHaveText(`Off POS at ${names.a}`);
  await expect(page.getByTestId('product-row')).toHaveCount(2);

  for (const [width, height, label] of [
    [1440, 900, 'desktop'],
    [820, 1180, 'tablet'],
    [390, 844, 'phone'],
  ] as const) {
    await page.setViewportSize({ width, height });
    await tab(page, 'Active').click();
    await expect(row(page, product.configured)).toBeVisible();
    await noHorizontalOverflow(page);
    const box = await row(page, product.configured).boundingBox();
    expect(box?.height ?? 999).toBeLessThan(label === 'phone' ? 200 : 90);
    await page.screenshot({ path: test.info().outputPath(`p39-products-${label}.png`) });
  }
});

test('Edit popup: staged details, section forms inside the popup, and branch-only deactivation', async ({ page, request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  await waitOutRateLimitWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAtBranchA(page);
  await openProducts(page);

  await row(page, product.configured).getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByTestId('product-editor');
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('tab')).toHaveText(['Details', 'Sizes & Prices', 'Ingredients', 'Choices', 'Branches']);

  // Details: save, then a discarded edit on close.
  const nameField = editor.getByRole('textbox', { name: /Product Name/ });
  await nameField.fill(`${product.configured} Renamed`);
  await expect(editor.getByText('Unsaved changes')).toBeVisible();
  await editor.getByRole('button', { name: 'Save details' }).click();
  await expect(editor.getByText('All details saved')).toBeVisible({ timeout: 15_000 });
  await editor.getByRole('textbox', { name: /Description/ }).fill('Not kept');
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Discard your unsaved details?');
  await editor.getByRole('button', { name: 'Discard and close' }).click();
  await expect(editor).toBeHidden();
  const supervisor = await apiLogin(request, sup.email, sup.password);
  const saved = await authedGet<{ name: string; description: string | null; version: number }>(request, `/api/products/${ids.configured}`, supervisor.accessToken);
  expect(saved.data?.name).toBe(`${product.configured} Renamed`);
  expect(saved.data?.description ?? null).not.toBe('Not kept');

  // Sizes: Add Size opens inside the popup — still one overlay — and saves on its own.
  await row(page, `${product.configured} Renamed`).getByRole('button', { name: 'Edit' }).click();
  await editor.getByRole('tab', { name: 'Sizes & Prices' }).click();
  await editor.getByRole('button', { name: 'Add Size' }).click();
  const sizeForm = editor.getByRole('dialog', { name: 'Add Variant' });
  await expect(sizeForm).toBeVisible();
  expect(await page.locator('[data-state="open"].fixed.inset-0').count()).toBe(1);
  await expect(editor.getByRole('tab', { name: 'Details' })).toBeDisabled();
  await sizeForm.getByRole('textbox', { name: /Variant Name/ }).fill('Party');
  await sizeForm.getByRole('textbox', { name: /Size Label/ }).fill('Party');
  await sizeForm.getByRole('textbox', { name: /Base Price/ }).fill('199');
  await sizeForm.getByRole('button', { name: 'Add Variant' }).click();
  await expect(sizeForm).toBeHidden({ timeout: 15_000 });
  await expect(editor.getByText('Party — Party')).toBeVisible();
  await expect(editor.getByRole('tab', { name: 'Details' })).toBeEnabled();

  // Ingredients: the recipe lines are there; Add Component opens inside the popup and Escape backs out of it only.
  await editor.getByRole('tab', { name: 'Ingredients' }).click();
  await expect(editor.getByText(/P38 Potato/).first()).toBeVisible({ timeout: 15_000 });
  await editor.getByRole('button', { name: 'Add Component' }).first().click();
  await expect(editor.locator('[data-hosted-dialog]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(editor.locator('[data-hosted-dialog]')).toHaveCount(0);
  await expect(editor).toBeVisible();

  // Choices: the linked flavor, option groups and Mix & Max slots are reachable the same way.
  await editor.getByRole('tab', { name: 'Choices' }).click();
  await expect(editor.getByText(/P38 Cheese/).first()).toBeVisible();
  await editor.getByRole('button', { name: 'Assign Option Group' }).first().click();
  await expect(editor.locator('[data-hosted-dialog]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await editor.getByRole('button', { name: 'Add Slot' }).first().click();
  await expect(editor.locator('[data-hosted-dialog]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(editor.locator('[data-hosted-dialog]')).toHaveCount(0);

  // Keyboard focus stays inside the popup.
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  expect(await editor.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  // Branches: deactivate at A only, confirmed inside the popup.
  await editor.getByRole('tab', { name: 'Branches' }).click();
  const branchRow = editor.getByTestId('product-editor-branch').filter({ hasText: names.a });
  await expect(branchRow).toContainText('On POS');
  await branchRow.getByRole('button', { name: 'Deactivate here' }).click();
  const confirm = editor.getByRole('alertdialog');
  await expect(confirm).toContainText(`at ${names.a}`);
  await confirm.getByRole('button', { name: 'Deactivate here' }).click();
  await expect(branchRow).toContainText('Not on POS', { timeout: 15_000 });
  await page.screenshot({ path: test.info().outputPath('p39-editor-desktop.png') });
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor).toBeHidden();
  await expectCounts(page, 0, 2, 3);
  const catalog = await authedGet(request, `/api/products/catalog?branch_id=${branchA}`, supervisor.accessToken);
  expect(JSON.stringify(catalog.data)).not.toContain(ids.configured);
  void url;
});

test('narrow phone: the Edit popup fits the screen and scrolls inside', async ({ page }) => {
  await waitOutRateLimitWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAtBranchA(page);
  await openProducts(page);
  // The sidebar collapses at phone width, so narrow the screen once the page is open.
  await page.setViewportSize({ width: 390, height: 844 });
  await tab(page, 'Inactive').click();
  await row(page, `${product.configured} Renamed`).getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByTestId('product-editor');
  await expect(editor.getByRole('tab', { name: 'Details' })).toBeVisible({ timeout: 30_000 });
  // Measure once the open animation (zoom + slide) has finished.
  await expect
    .poll(async () => {
      const box = await editor.boundingBox();
      return Boolean(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844);
    }, { timeout: 10_000 })
    .toBe(true);
  await editor.getByRole('tab', { name: 'Choices' }).click();
  await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('p39-editor-phone.png') });
});

test('Continue Setup reopens the saved builder draft; Delete is refused while a recipe refers to the product, Archive works', async ({ page, request }) => {
  await waitOutRateLimitWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAtBranchA(page);
  await openProducts(page);

  // Delete a product nothing refers to.
  await tab(page, 'Drafts').click();
  await row(page, product.deletable).getByRole('button', { name: `More actions for ${product.deletable}` }).click();
  await page.getByRole('menuitem', { name: 'Archive or delete…' }).click();
  const remove = page.getByTestId('remove-product-dialog');
  await remove.getByRole('textbox', { name: /Type DELETE/ }).fill('DELETE');
  await remove.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(remove).toBeHidden({ timeout: 15_000 });
  await expect(row(page, product.deletable)).toHaveCount(0);
  const supervisor = await apiLogin(request, sup.email, sup.password);
  expect((await authedGet(request, `/api/products/${ids.deletable}`, supervisor.accessToken)).status).toBe(404);

  // Delete refused for the configured product (recipe lines refer to it); Archive instead.
  await tab(page, 'Inactive').click();
  const configuredName = `${product.configured} Renamed`;
  await row(page, configuredName).getByRole('button', { name: `More actions for ${configuredName}` }).click();
  await page.getByRole('menuitem', { name: 'Archive or delete…' }).click();
  await remove.getByRole('textbox', { name: /Type DELETE/ }).fill('DELETE');
  await remove.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByTestId('remove-product-error')).toContainText("can't be deleted permanently", { timeout: 15_000 });
  await remove.getByRole('button', { name: `Archive ${configuredName}` }).click();
  await expect(remove).toBeHidden({ timeout: 15_000 });
  await expect(row(page, configuredName).getByTestId('product-row-status')).toHaveText('Archived');
  const archived = await authedGet<{ status: string; variants: unknown[] }>(request, `/api/products/${ids.configured}`, supervisor.accessToken);
  expect(archived.data?.status).toBe('archived');
  expect(archived.data?.variants.length).toBe(3);

  // Continue Setup on the shared draft.
  await tab(page, 'Drafts').click();
  await row(page, product.draft).getByRole('button', { name: 'Continue Setup' }).click();
  await page.waitForURL(`**/supervisor/products/builder?product_id=${ids.draft}`);
  await expect(page.getByTestId('builder-selected-branches')).toContainText(names.a);
  await expect(page.getByTestId('builder-selected-branches')).toContainText(names.b);
  await page.getByRole('button', { name: /Continue to Sizes/ }).click();
  await expect(page.getByText('Regular — Regular')).toBeVisible();
});
