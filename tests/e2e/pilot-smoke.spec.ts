// POS-PERF-P44 — production-safe pilot smoke. This is what deploy-production.yml
// runs after the web promote is verified. See
// docs/runbooks/pos-perf-p44-pilot-and-e2e-readiness.md.
//
// Boundaries (enforced, not just intended):
// - Only dedicated automation accounts, from process.env (never hardcoded).
// - helpers/read-only-guard.ts aborts every browser write except
//   login/refresh/logout and fails the test that tried it; realtime is
//   blocked so no branch presence notification is queued.
// - No PIN is ever entered: the branch terminal is checked at its locked
//   "Open POS Terminal" screen, so nobody is clocked in.
// - The invalid-login case uses an address that cannot exist, so no real
//   account's lockout counter moves and no LOGIN_FAILURE row names a user.
//
// What it does write, by design: each successful sign-in creates a session
// (refresh token row), a LOGIN_SUCCESS audit row and updates last_login_at;
// sign-out revokes that session. That is the whole footprint.
//
// Run via: npx playwright test --config=tests/e2e/playwright.pilot.config.ts
import type { Page } from '@playwright/test';
import { test, expect } from './helpers/read-only-guard';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name} — copy tests/e2e/.env.e2e.example to tests/e2e/.env.e2e and fill it in`);
  }
  return value;
}

const SUPER_ADMIN = { email: requireEnv('E2E_SUPER_ADMIN_EMAIL'), password: requireEnv('E2E_SUPER_ADMIN_PASSWORD') };
const SUPERVISOR = { email: requireEnv('E2E_SUPERVISOR_EMAIL'), password: requireEnv('E2E_SUPERVISOR_PASSWORD') };
const BRANCH = { email: requireEnv('E2E_BRANCH_EMAIL'), password: requireEnv('E2E_BRANCH_PASSWORD') };

// RFC 2606 reserves .invalid, so this address can never belong to an account.
const NONEXISTENT_EMAIL = 'e2e-smoke-no-such-account@pilot-smoke.invalid';

// Wipes password field values immediately after submit — no artifact is
// captured by this suite's config, but a local re-run with tracing must not
// be able to snapshot a live password either.
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

async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Log out' }).first().click();
  await page.waitForURL(/\/login$/);
}

// The config blocks service workers (so every request stays under the
// read-only guard); workbox-window then reads `.waiting` on the registration
// it never got. That one message is caused by the harness, not the app.
const SERVICE_WORKER_BLOCKED_ERROR = "Cannot read properties of undefined (reading 'waiting')";

// Known app defect found by POS-PERF-P44 (runbook §6.3): middleware.ts's
// matcher exempts sw.js and workbox-* but not next-pwa's swe-worker-<hash>.js,
// so that script is redirected to /login and the browser parses HTML as JS.
// Tolerated only while it is the sole script served as HTML; remove this
// once the matcher is fixed.
const KNOWN_HTML_SCRIPT = /^\/swe-worker-[0-9a-f]+\.js$/;
const HTML_AS_SCRIPT_ERROR = "Unexpected token '<'";

/** Records uncaught page errors (minus the two explained above) so a test can assert none happened. */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  const htmlScripts: string[] = [];
  page.on('response', (response) => {
    const contentType = response.headers()['content-type'] ?? '';
    if (response.request().resourceType() === 'script' && contentType.includes('text/html')) {
      htmlScripts.push(new URL(response.url()).pathname);
    }
  });
  page.on('pageerror', (err) => {
    if (err.message === SERVICE_WORKER_BLOCKED_ERROR) return;
    if (err.message === HTML_AS_SCRIPT_ERROR && htmlScripts.length > 0 && htmlScripts.every((p) => KNOWN_HTML_SCRIPT.test(p))) {
      test.info().annotations.push({ type: 'known-defect', description: `script served as HTML: ${htmlScripts.join(', ')}` });
      return;
    }
    errors.push(err.message);
  });
  return errors;
}

async function expectHealthyPage(page: Page): Promise<void> {
  await expect(page.getByText(/application error/i)).toHaveCount(0);
  await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
}

async function expectRedirectedAway(page: Page, path: string, landing: RegExp): Promise<void> {
  await page.goto(path);
  await page.waitForURL(landing);
  await expect(page).not.toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}(\\?|$)`));
}

test('deployment readiness: web liveness and login page', async ({ page, request }) => {
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ data: { status: 'ok' } });

  const response = await page.goto('/login');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('super admin: dashboard, navigation and admin pages render', async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await login(page, SUPER_ADMIN.email, SUPER_ADMIN.password);
  await page.waitForURL('**/admin/dashboard**');
  await expect(page.getByRole('heading', { name: 'Super Admin Dashboard' })).toBeVisible();

  const sidebar = page.getByRole('complementary');
  const pages: Array<{ link: string; url: RegExp; heading: string }> = [
    { link: 'Branches', url: /\/admin\/branches/, heading: 'Branches' },
    { link: 'Supervisors', url: /\/admin\/supervisors/, heading: 'Supervisors' },
    { link: 'Attendance', url: /\/admin\/attendance/, heading: 'Attendance Monitoring' },
    { link: 'Reports', url: /\/admin\/reports/, heading: 'Reports' },
    { link: 'Settings', url: /\/admin\/settings/, heading: 'System Settings' },
  ];
  for (const target of pages) {
    await sidebar.getByRole('link', { name: target.link }).click();
    await page.waitForURL(target.url);
    await expect(page.getByRole('heading', { name: target.heading, exact: true })).toBeVisible();
    await expectHealthyPage(page);
  }

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join('; ')}`).toEqual([]);
  await logout(page);
});

test('supervisor: dashboard and product catalog render; admin area denied', async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await login(page, SUPERVISOR.email, SUPERVISOR.password);
  await page.waitForURL('**/supervisor/dashboard**');
  await expect(page.getByRole('heading', { name: 'Supervisor Dashboard' })).toBeVisible();

  await page.getByRole('complementary').getByRole('link', { name: 'Products', exact: true }).click();
  await page.waitForURL(/\/supervisor\/products/);
  await expect(page.getByRole('heading', { name: 'Products', exact: true })).toBeVisible();
  // Loading must resolve to the product list or its explicit empty state, not hang or error.
  await expect(page.getByTestId('products-list').or(page.getByText('Nothing on POS here yet'))).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('list', { name: 'Loading products' })).toHaveCount(0);
  await expectHealthyPage(page);

  await expectRedirectedAway(page, '/admin/dashboard', /\/supervisor\//);

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join('; ')}`).toEqual([]);
  await logout(page);
});

test('branch: dashboard and locked POS terminal render without a PIN; other areas denied', async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await login(page, BRANCH.email, BRANCH.password);
  await page.waitForURL('**/branch/dashboard**');
  await expect(page.getByRole('heading', { name: 'Branch Dashboard' })).toBeVisible();

  await page.goto('/branch/terminal');
  await expect(page.getByRole('heading', { name: 'Open POS Terminal' })).toBeVisible();
  await expect(page.getByText('Terminal Locked')).toBeVisible();
  // Locked means locked: no catalog or cart before a PIN — and this test never enters one.
  await expect(page.getByRole('heading', { name: /POS Terminal — product catalog/ })).toHaveCount(0);
  await expectHealthyPage(page);

  await expectRedirectedAway(page, '/admin/dashboard', /\/branch\//);
  await expectRedirectedAway(page, '/supervisor/dashboard', /\/branch\//);
  // Staff-only branch pages (POS-PERF-P26) are closed to the branch account.
  await expectRedirectedAway(page, '/branch/employees', /\/branch\//);

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join('; ')}`).toEqual([]);
  await page.goto('/branch/dashboard');
  await logout(page);
});

test('signed-out visitor is sent to login', async ({ page }) => {
  await page.goto('/admin/dashboard');
  await page.waitForURL(/\/login/);
});

test('invalid login is rejected without touching a real account', async ({ page }) => {
  await login(page, NONEXISTENT_EMAIL, 'not-a-real-password');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('.text-destructive').first()).toBeVisible();
});
