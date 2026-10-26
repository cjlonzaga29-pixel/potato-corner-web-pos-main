// POS-PERF-P38R3 — what the supervisor sees when a publication's answer is
// slow or lost, in a real browser against a real API and local `pos_verify`.
// Publication commits before its audit entries are written and before the
// response is sent, so the browser can lose the answer to a publication that
// succeeded. Faults are injected with page.route on the browser's own
// requests: the real request reaches the API and commits, then the answer is
// held and dropped. The UI must check the server's state (a read-only GET)
// before claiming failure, say "Could not confirm" when it can't, never
// repeat the publish itself, and a retry must add nothing twice. Same
// posture as the P38/P38R specs: fresh apps/api (:4000) and apps/web (:3000).
import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedPost, authedPatch } from './fixtures/api-helpers';

test.describe.configure({ mode: 'serial' });
test.setTimeout(420_000);

const suffix = Date.now().toString(36);
const sup = { email: `p38r3-sup-${suffix}@test.local`, password: 'P38R3SupervisorPass!1' };
const names = { a: `P38R3 Branch A ${suffix}`, b: `P38R3 Branch B ${suffix}` };

type Fx = { potatoId: string; potatoName: string; cupId: string; cupName: string; flavorId: string; flavorName: string };
type Product = { id: string; fx: Fx };

let branchA = '';
let branchB = '';
const products: Record<'normal' | 'lost' | 'page' | 'unsent', Product> = {
  normal: { id: '', fx: {} as Fx },
  lost: { id: '', fx: {} as Fx },
  page: { id: '', fx: {} as Fx },
  unsent: { id: '', fx: {} as Fx },
};

function runFixture(script: string, args: string[]): string {
  return execFileSync(process.execPath, [path.join(__dirname, 'fixtures', script), ...args], {
    cwd: path.join(__dirname, '..', '..', 'apps', 'api'),
    encoding: 'utf-8',
  });
}

/** Links that exist now for this product's two items at A and B, as "branch:item". */
function links(p: Product): string[] {
  const stock = JSON.parse(runFixture('p38-branch-setup.cjs', ['read', `${p.fx.potatoId},${p.fx.cupId}`, branchA, branchB])) as Record<
    string,
    Record<string, unknown>
  >;
  return Object.entries(stock)
    .flatMap(([branch, items]) => Object.entries(items).filter(([, cell]) => cell !== null).map(([item]) => `${branch}:${item}`))
    .sort();
}

function auditedLinks(p: Product): string[] {
  return JSON.parse(runFixture('p38r-single-publish.cjs', ['audits', p.id])) as string[];
}

function availability(p: Product): { published: string[]; audited: string[] } {
  return JSON.parse(runFixture('p38r-single-publish.cjs', ['availability', p.id])) as { published: string[]; audited: string[] };
}

// apps/api's global apiLimiter: 100 requests/minute per IP (see the P38R spec).
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

async function loginAs(page: Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email').fill(sup.email);
  await page.getByRole('textbox', { name: 'Password' }).fill(sup.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/supervisor/dashboard');
  // Navigating on before the dashboard has rendered sometimes bounced back to it (seen twice in this spec's runs).
  await expect(page.getByRole('heading', { name: 'Supervisor Dashboard' })).toBeVisible({ timeout: 30_000 });
}

/** Opens the builder's Review step for a product created through the API (the persisted draft is how a reload resumes it). */
async function openReview(page: Page, productId: string) {
  await page.evaluate((id) => {
    localStorage.setItem('potato-corner:product-builder-draft', JSON.stringify({ state: { productId: id, step: 'review', draftBranchIds: [] }, version: 0 }));
  }, productId);
  for (let attempt = 1; ; attempt++) {
    await page.goto('/supervisor/products/builder');
    try {
      await expect(page.getByTestId('review-branch-status')).toHaveCount(2, { timeout: 20_000 });
      return;
    } catch (error) {
      console.log(`[p38r3] Review not shown (attempt ${attempt}); page is at ${page.url()}`);
      if (attempt === 2) throw error;
    }
  }
}

/** Records every publish POST and publication-check GET the browser sends for this product. */
function trackRequests(page: Page, productId: string) {
  const seen: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes(`/api/products/${productId}/publish`) && req.method() === 'POST') seen.push(`POST ${new URL(url).pathname}`);
    if (url.includes(`/api/products/${productId}/publication-check`)) seen.push('GET publication-check');
  });
  return seen;
}

test.beforeAll(async ({ request, baseURL }) => {
  test.setTimeout(180_000); // four seeded products; the default 30 s hook budget is not enough on a busy host
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const created: Record<string, string> = {};
  for (const [key, name] of Object.entries(names)) {
    const res = await authedPost<{ id: string }>(request, url, '/api/branches', admin.accessToken, { name, address: `1 ${name} St`, city: 'Test City', status: 'active' });
    if (!res.data?.id) throw new Error(`Failed to seed branch ${name}: ${JSON.stringify(res.error)}`);
    created[key] = res.data.id;
  }
  branchA = created.a ?? '';
  branchB = created.b ?? '';

  const res = await authedPost<{ id: string }>(request, url, '/api/employees', admin.accessToken, {
    email: sup.email,
    first_name: 'P38R3',
    last_name: 'Supervisor',
    role: 'supervisor',
    employment_type: 'regular',
    branch_ids: [branchA, branchB],
    initial_password: sup.password,
  });
  if (!res.data?.id) throw new Error(`Failed to seed supervisor: ${JSON.stringify(res.error)}`);
  await clearMustChangePassword(request, sup.email, sup.password);

  // Each product gets its own items, so each publication has links to create.
  const supervisor = await apiLogin(request, sup.email, sup.password);
  for (const key of Object.keys(products) as (keyof typeof products)[]) {
    const fx = JSON.parse(runFixture('p38-branch-setup.cjs', ['seed', branchA, `r3${key}${suffix}`])) as Fx;
    const selection = key === 'page' ? [branchA] : [branchA, branchB];
    const product = await authedPost<{ id: string }>(request, url, '/api/products', supervisor.accessToken, {
      name: `P38R3 ${key} ${suffix}`,
      status: 'active',
      branch_ids: selection,
    });
    if (!product.data?.id) throw new Error(`Failed to create product: ${JSON.stringify(product.error)}`);
    runFixture('p38r-single-publish.cjs', ['configure', product.data.id, fx.potatoId, fx.cupId, fx.flavorId]);
    products[key] = { id: product.data.id, fx };
  }
});

test.afterAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  for (const id of [branchA, branchB]) {
    if (id) await authedPatch(request, url, `/api/branches/${id}`, admin.accessToken, { status: 'inactive' });
  }
});

test('normal Add to POS: one POST, links and entries written once', async ({ page }) => {
  const p = products.normal;
  await waitOutRateLimitWindow();
  await loginAs(page);
  const seen = trackRequests(page, p.id);
  await openReview(page, p.id);

  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/products/${p.id}/publish-branches`) && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Add to POS' }).click(),
  ]);
  expect(resp.status()).toBe(200);
  await page.waitForURL(`**/supervisor/products/${p.id}`);

  expect(seen.filter((s) => s.startsWith('POST'))).toHaveLength(1);
  // Potato at A already existed (500 on hand); publication added the other three.
  expect(links(p)).toEqual([`${branchA}:${p.fx.cupId}`, `${branchA}:${p.fx.potatoId}`, `${branchB}:${p.fx.cupId}`, `${branchB}:${p.fx.potatoId}`].sort());
  expect(auditedLinks(p)).toEqual([`${branchA}:${p.fx.cupId}`, `${branchB}:${p.fx.cupId}`, `${branchB}:${p.fx.potatoId}`].sort());
  expect(availability(p)).toEqual({ published: [branchA, branchB].sort(), audited: [branchA, branchB].sort() });
});

test('Add to POS answer delayed, then lost after commit while the browser goes offline: "Could not confirm", no stale cached answer, and reconnecting shows it on POS', async ({
  page,
  request,
  baseURL,
}) => {
  const url = baseURL ?? 'http://localhost:3000';
  const p = products.lost;
  await waitOutRateLimitWindow();
  await loginAs(page);
  const seen = trackRequests(page, p.id);
  await openReview(page, p.id); // its check is now in the service worker's /api cache, from before the publish

  let serverStatus = 0;
  let releaseAnswer: () => void = () => undefined;
  const answerHeld = new Promise<void>((resolve) => {
    releaseAnswer = resolve;
  });
  await page.route(`**/api/products/${p.id}/publish-branches`, async (route: Route) => {
    const response = await route.fetch(); // the real request reaches the API and commits
    serverStatus = response.status();
    await answerHeld;
    await route.abort('connectionreset'); // …and the answer never arrives
  });

  const addToPos = page.getByRole('button', { name: 'Add to POS' });
  await addToPos.click();

  // Delayed answer: it has already committed, while the browser is still waiting.
  await expect.poll(() => serverStatus, { timeout: 30_000 }).toBe(200);
  expect(availability(p).published).toEqual([branchA, branchB].sort());
  await page.waitForTimeout(3_000);
  await expect(addToPos).toBeDisabled(); // pending: no second click possible
  await expect(page.getByTestId('builder-write-error')).toHaveCount(0);

  // The connection drops: the answer is lost, and the status check can't reach the server either.
  await page.context().setOffline(true);
  releaseAnswer();

  const alert = page.getByTestId('builder-write-error');
  await expect(alert).toContainText('Could not confirm whether this was added to POS', { timeout: 20_000 });
  await expect(alert).not.toContainText("Couldn't add to POS");
  await expect(alert).not.toContainText('Not on POS yet'); // the pre-publish cached plan was not taken as the answer
  await expect(alert).toContainText('Nothing you entered was lost.');
  await expect(addToPos).toBeDisabled(); // Check again comes first: no blind repeat
  expect(page.url()).toContain('/supervisor/products/builder'); // the builder is kept

  // Check again while still offline: still honest, still a read.
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(alert).toContainText('Could not confirm whether this was added to POS', { timeout: 20_000 });
  expect(seen.filter((s) => s.startsWith('POST'))).toHaveLength(1);

  // Reconnecting reloads the page (next-pwa reloadOnOnline); the builder resumes at Review with the server's state.
  await page.context().setOffline(false);
  await expect(page.getByTestId('review-branch-status')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId('review-branch-status').filter({ hasText: 'On POS' })).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Already on POS' })).toBeDisabled();
  expect(seen.filter((s) => s.startsWith('POST'))).toHaveLength(1);

  const linked = [`${branchA}:${p.fx.cupId}`, `${branchB}:${p.fx.cupId}`, `${branchB}:${p.fx.potatoId}`].sort();
  expect(auditedLinks(p)).toEqual(linked);
  expect(availability(p)).toEqual({ published: [branchA, branchB].sort(), audited: [branchA, branchB].sort() });

  // A retry of the already-committed operation (as an older client would send) adds nothing.
  const supToken = (await apiLogin(request, sup.email, sup.password)).accessToken;
  const retry = await authedPost<{ setup: { stock_links: unknown[] } }>(request, url, `/api/products/${p.id}/publish-branches`, supToken, {
    branch_ids: [branchA, branchB],
  });
  expect(retry.status).toBe(200);
  expect(retry.data?.setup.stock_links).toEqual([]);
  expect(auditedLinks(p)).toEqual(linked);
  expect(availability(p)).toEqual({ published: [branchA, branchB].sort(), audited: [branchA, branchB].sort() });
});

test('product page Publish answer lost after commit: reconciled from the server state, shown as published', async ({ page }) => {
  const p = products.page;
  await waitOutRateLimitWindow();
  await loginAs(page);
  const seen = trackRequests(page, p.id);
  await page.goto(`/supervisor/products/${p.id}`);
  await page.getByRole('tab', { name: /Variants, Flavors & Recipe/ }).click({ timeout: 15_000 });
  await expect(page.getByTestId('publication-summary')).toHaveText('Ready to publish.', { timeout: 15_000 });

  await page.route(`**/api/products/${p.id}/publish`, async (route: Route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort('connectionreset');
  });
  await page.getByRole('button', { name: 'Publish', exact: true }).click();

  await expect(page.getByText('Published at your branch', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('publication-summary')).toHaveText('On POS at your branch.');
  await expect(page.getByTestId('product-publish-error')).toHaveCount(0);
  expect(seen.filter((s) => s.startsWith('POST'))).toHaveLength(1);
  expect(seen).toContain('GET publication-check');

  expect(auditedLinks(p)).toEqual([`${branchA}:${p.fx.cupId}`]);
  expect(availability(p)).toEqual({ published: [branchA], audited: [branchA] });
});

test('Add to POS never reached the server: "Not on POS yet", nothing written by the check, and the retry publishes once', async ({ page }) => {
  const p = products.unsent;
  await waitOutRateLimitWindow();
  await loginAs(page);
  const seen = trackRequests(page, p.id);
  await openReview(page, p.id);

  await page.route(`**/api/products/${p.id}/publish-branches`, (route: Route) => route.abort('connectionrefused'));
  const addToPos = page.getByRole('button', { name: 'Add to POS' });
  await addToPos.click();

  const alert = page.getByTestId('builder-write-error');
  await expect(alert).toContainText('Not on POS yet', { timeout: 15_000 });
  await expect(alert).toContainText('Trying again is safe');
  const untouched = [`${branchA}:${p.fx.potatoId}`];
  expect(links(p)).toEqual(untouched);
  expect(availability(p)).toEqual({ published: [], audited: [] });

  // Check again reads again; still nothing is written.
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(alert).toContainText('Not on POS yet');
  expect(links(p)).toEqual(untouched);
  expect(availability(p)).toEqual({ published: [], audited: [] });
  expect(seen.filter((s) => s.startsWith('POST'))).toHaveLength(1);

  // Connectivity is back: the supervisor's retry publishes once.
  await page.unroute(`**/api/products/${p.id}/publish-branches`);
  await expect(addToPos).toBeEnabled();
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/products/${p.id}/publish-branches`) && r.request().method() === 'POST'),
    addToPos.click(),
  ]);
  expect(resp.status()).toBe(200);
  await page.waitForURL(`**/supervisor/products/${p.id}`);
  expect(auditedLinks(p)).toEqual([`${branchA}:${p.fx.cupId}`, `${branchB}:${p.fx.cupId}`, `${branchB}:${p.fx.potatoId}`].sort());
  expect(availability(p)).toEqual({ published: [branchA, branchB].sort(), audited: [branchA, branchB].sort() });
});
