import { test, expect } from '@playwright/test';

// Dev-mode Turbopack compiles each route on first hit (can take 10-30s cold),
// so first-navigation assertions need a longer timeout than the 5s default.
const NAV_TIMEOUT = 30_000;

const ALLOWED_ACTIONS = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILURE',
  'LOGOUT',
  'LOGOUT_ALL_DEVICES',
  'PIN_LOGIN_SUCCESS',
  'ACCOUNT_UNLOCKED',
];

/**
 * One test, one login, via the real login form rather than the shared
 * super_admin.auth.json storageState: that fixture's refresh_token cookie
 * rotates on first use (apps/web/hooks/use-auth.ts's silent-refresh-on-mount),
 * and since global-setup.ts writes it once for the whole run, the first spec
 * file to load it consumes it — every other file loading the same on-disk
 * cookie afterwards trips the API's reuse-detection guard and 401s every
 * request. Logging in fresh here costs one more of the login rate limiter's
 * 10-per-15-min budget (apps/api/src/middleware/rate-limiter.ts) but avoids
 * that cross-file collision entirely. test.step keeps the sub-cases the
 * task asked for distinguishable in the report without re-authenticating
 * within this file.
 */
test.describe('Login audit', () => {
  test('login audit page: shows login events, and employee activity tab reuses them', async ({ page }) => {
    await test.step('login audit page loads and shows only login events', async () => {
      await page.goto('/login', { waitUntil: 'networkidle' });
      await page.getByLabel('Email').fill('admin@potatocorner.test');
      await page.getByRole('textbox', { name: 'Password' }).fill('SuperAdmin123');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL('**/admin/dashboard', { timeout: NAV_TIMEOUT });

      await page.getByRole('link', { name: 'Login Audit' }).click();
      await expect(page).toHaveURL(/\/admin\/login-audit$/, { timeout: NAV_TIMEOUT });

      const rows = page.locator('table tbody tr');
      await expect(rows.first()).toBeVisible({ timeout: NAV_TIMEOUT });
      expect(await rows.count()).toBeGreaterThanOrEqual(1);

      const actionBadges = rows.locator('td:nth-child(4) div');
      const badgeCount = await actionBadges.count();
      expect(badgeCount).toBeGreaterThan(0);
      for (let i = 0; i < badgeCount; i++) {
        const text = (await actionBadges.nth(i).innerText()).trim();
        expect(ALLOWED_ACTIONS).toContain(text);
      }
    });

    await test.step('employee detail activity tab shows audit log', async () => {
      await page.goto('/admin/employees', { waitUntil: 'networkidle' });
      const rows = page.locator('table tbody tr');
      await expect(rows.first()).toBeVisible({ timeout: NAV_TIMEOUT });
      await rows.first().click();
      await expect(page).toHaveURL(/\/admin\/employees\/[0-9a-f-]{36}$/, { timeout: NAV_TIMEOUT });

      await page.getByRole('tab', { name: 'Activity' }).click();

      await expect(page.getByText('later phase')).toHaveCount(0);

      const table = page.locator('table');
      await expect(table.getByRole('columnheader', { name: 'Timestamp' })).toBeVisible({ timeout: NAV_TIMEOUT });
      await expect(table.getByRole('columnheader', { name: 'Action' })).toBeVisible();
    });
  });
});
