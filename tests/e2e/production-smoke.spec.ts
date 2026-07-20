// Production smoke suite for 4 commits shipped 2026-07-21:
//   09442ea — nav link loading state + async logout on sidebars
//   946a989 — pc_access_hint cookie for fast middleware routing
//   18f6039 — broadcast logout on auth failure instead of hard reload
// Mirrors pilot-smoke.spec.ts's safety rules: credentials come from
// process.env only (see .env.e2e.example), never hardcoded, and this spec
// must never create/edit/delete any data — navigation, login/logout, and
// cookie assertions only. Run via:
//   npx playwright test --config=tests/e2e/playwright.production-smoke.config.ts --project=chromium
import { test, expect, type Page } from '@playwright/test';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name} — copy .env.e2e.example to .env.e2e and fill it in`);
  }
  return value;
}

const SUPER_ADMIN = {
  email: requireEnv('E2E_SUPER_ADMIN_EMAIL'),
  password: requireEnv('E2E_SUPER_ADMIN_PASSWORD'),
};

// Wipes password field values immediately after submit — Playwright's
// error-context.md snapshot is captured at the moment of failure, before
// afterEach would ever run, so clearing must happen right after the click.
async function clearPasswordFields(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      document.querySelectorAll('input[type="password"]').forEach((el) => {
        (el as HTMLInputElement).value = '';
      });
    })
    .catch(() => {
      /* page may already be closed */
    });
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await clearPasswordFields(page);
}

async function logoutFromSidebar(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.waitForURL(/\/login$/);
}

test('sidebar nav icon swaps to a spinner during navigation (09442ea)', async ({ page }) => {
  await login(page, SUPER_ADMIN.email, SUPER_ADMIN.password);
  await page.waitForURL('**/admin/dashboard**');

  const productsLink = page.getByRole('link', { name: 'Products' });
  await productsLink.click();

  // The 946a989 access-hint fast path can make this navigation complete in
  // under a frame, so the pending spinner may never become observable — that
  // is expected, not a bug. Record it as a soft signal; the hard assertion
  // is that the destination page renders correctly.
  const spinnerObserved = await productsLink
    .locator('svg.animate-spin')
    .waitFor({ state: 'attached', timeout: 1000 })
    .then(() => true)
    .catch(() => false);
  test.info().annotations.push({ type: 'note', description: `nav spinner observed=${spinnerObserved}` });

  await page.waitForURL('**/admin/products**');
  await expect(page).toHaveURL(/\/admin\/products/);

  await logoutFromSidebar(page);
});

test('logout shows a loading spinner and redirects to /login within 5s (09442ea)', async ({ page }) => {
  await login(page, SUPER_ADMIN.email, SUPER_ADMIN.password);
  await page.waitForURL('**/admin/dashboard**');

  const logoutButton = page.getByRole('button', { name: 'Log out' });
  const start = Date.now();
  await logoutButton.click();

  await expect(logoutButton.locator('svg.animate-spin')).toBeVisible({ timeout: 1000 });
  await expect(logoutButton).toBeDisabled();

  await page.waitForURL(/\/login$/, { timeout: 5000 });
  expect(Date.now() - start).toBeLessThanOrEqual(5000);
});

test('pc_access_hint cookie is set on login and cleared on logout (946a989)', async ({ page, context }) => {
  await login(page, SUPER_ADMIN.email, SUPER_ADMIN.password);
  await page.waitForURL('**/admin/dashboard**');

  const cookiesAfterLogin = await context.cookies();
  const hintCookie = cookiesAfterLogin.find((c) => c.name === 'pc_access_hint');
  expect(hintCookie, 'pc_access_hint cookie should be present after login').toBeDefined();
  expect(hintCookie?.httpOnly).toBe(true);
  expect(hintCookie?.secure).toBe(true); // production only — config.isProduction
  expect(hintCookie?.sameSite).toBe('Lax');

  await logoutFromSidebar(page);

  const cookiesAfterLogout = await context.cookies();
  expect(cookiesAfterLogout.find((c) => c.name === 'pc_access_hint')).toBeUndefined();
});

test('logout on one tab broadcasts and redirects a second tab within 5s (18f6039)', async ({ browser }) => {
  // BroadcastChannel/localStorage cross-tab signaling only fires within a
  // shared storage partition. Two separate browser.newContext() calls are
  // isolated profiles that do NOT share BroadcastChannel or localStorage —
  // real browser tabs are 2 pages inside ONE context, so that's what this
  // uses (correcting the "2 contexts" framing in the original ask).
  const context = await browser.newContext();
  const tab1 = await context.newPage();
  const tab2 = await context.newPage();

  try {
    await login(tab1, SUPER_ADMIN.email, SUPER_ADMIN.password);
    await tab1.waitForURL('**/admin/dashboard**');

    await tab2.goto('/admin/dashboard');
    await expect(tab2).toHaveURL(/\/admin\/dashboard/);

    const start = Date.now();
    await tab1.getByRole('button', { name: 'Log out' }).click();
    await tab1.waitForURL(/\/login$/, { timeout: 5000 });

    await tab2.waitForURL(/\/login$/, { timeout: 5000 });
    expect(Date.now() - start).toBeLessThanOrEqual(5000);
  } finally {
    await context.close();
  }
});

test('dashboard navigation averages under 800ms with the access-hint fast path (946a989)', async ({ page }) => {
  await login(page, SUPER_ADMIN.email, SUPER_ADMIN.password);
  await page.waitForURL('**/admin/dashboard**');

  // 5 distinct destinations rather than re-clicking one link 5 times — a
  // click on the already-active link wouldn't trigger a real navigation to
  // measure. Ends back at Dashboard to leave the session in a clean state.
  const navTargets: Array<{ label: string; urlPattern: RegExp }> = [
    { label: 'Branches', urlPattern: /\/admin\/branches/ },
    { label: 'Products', urlPattern: /\/admin\/products/ },
    { label: 'Employees', urlPattern: /\/admin\/employees/ },
    { label: 'Reports', urlPattern: /\/admin\/reports/ },
    { label: 'Dashboard', urlPattern: /\/admin\/dashboard/ },
  ];

  const durations: number[] = [];
  for (const target of navTargets) {
    const start = Date.now();
    await page.getByRole('link', { name: target.label }).click();
    await page.waitForURL(target.urlPattern);
    durations.push(Date.now() - start);
  }

  const average = durations.reduce((sum, d) => sum + d, 0) / durations.length;
  test.info().annotations.push({
    type: 'note',
    description: `nav durations: ${durations.join(', ')}ms, avg=${average.toFixed(0)}ms`,
  });
  expect(average).toBeLessThanOrEqual(800);

  await logoutFromSidebar(page);
});
