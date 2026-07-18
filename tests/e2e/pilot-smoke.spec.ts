// Phase 20 Task 10 — read-only production smoke test against the live
// pilot deployment. Credentials come from process.env only (see
// .env.e2e.example); this spec must never hardcode a password. No test
// here creates, edits, or deletes any data — navigation and assertion
// only. Run via: npx playwright test --config=playwright.pilot.config.ts
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
const SUPERVISOR = {
  email: requireEnv('E2E_SUPERVISOR_EMAIL'),
  password: requireEnv('E2E_SUPERVISOR_PASSWORD'),
};
const STAFF = {
  email: requireEnv('E2E_STAFF_EMAIL'),
  password: requireEnv('E2E_STAFF_PASSWORD'),
};

// Wipes password field values immediately after submit — Playwright's
// error-context.md snapshot is captured at the moment of failure (e.g. a
// waitForURL timeout), before afterEach would ever run, so clearing must
// happen right after the click, not on a delayed hook.
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

test('super admin login + dashboard render', async ({ page }) => {
  await login(page, SUPER_ADMIN.email, SUPER_ADMIN.password);
  await page.waitForURL('**/admin/dashboard**');
  await expect(page).toHaveURL(/\/admin\/dashboard/);
  await expect(page.getByRole('heading', { name: 'Super Admin Dashboard' })).toBeVisible();

  for (const label of ['Branches', 'Products', 'Recipes', 'Employees', 'Reports', 'Audit Logs']) {
    await expect(page.getByRole('link', { name: label })).toBeVisible();
  }

  await logoutFromSidebar(page);
});

test('super admin navigation smoke', async ({ page }) => {
  await login(page, SUPER_ADMIN.email, SUPER_ADMIN.password);
  await page.waitForURL('**/admin/dashboard**');

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const navLabels = ['Branches', 'Products', 'Recipes', 'Employees', 'Reports', 'Audit Logs'];
  for (const label of navLabels) {
    await page.getByRole('link', { name: label }).click();
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/application error/i)).toHaveCount(0);
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  }

  expect(pageErrors, `Uncaught page errors during navigation: ${pageErrors.join('; ')}`).toHaveLength(0);

  await logoutFromSidebar(page);
});

test('supervisor login + dashboard render', async ({ page }) => {
  await login(page, SUPERVISOR.email, SUPERVISOR.password);
  await page.waitForURL('**/supervisor/dashboard**');
  await expect(page).toHaveURL(/\/supervisor\/dashboard/);
  await expect(page.getByRole('heading', { name: 'Branch Dashboard' })).toBeVisible();

  await logoutFromSidebar(page);
});

test('staff login + POS terminal render', async ({ page }) => {
  await login(page, STAFF.email, STAFF.password);
  await page.waitForURL('**/terminal**');
  await expect(page).toHaveURL(/\/terminal/);

  // No logout affordance exists on the POS terminal shell — these assertions
  // alone confirm the terminal UI rendered correctly.
  await expect(page.getByRole('link', { name: /Clock In\/Out/ })).toBeVisible();
  await expect(page.getByText('Subtotal', { exact: true })).toBeVisible();
  await expect(page.getByText('Total', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Cash' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Charge/ })).toBeVisible();
});

test('invalid login is rejected', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email' }).fill(STAFF.email);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('WrongPassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await clearPasswordFields(page);

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('.text-destructive').first()).toBeVisible();
});
