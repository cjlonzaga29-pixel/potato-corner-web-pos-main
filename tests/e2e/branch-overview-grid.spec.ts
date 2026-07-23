import { test, expect } from '@playwright/test';

// Dev-mode Turbopack compiles each route on first hit (can take 10-30s cold),
// so first-navigation assertions need a longer timeout than the 5s default.
const NAV_TIMEOUT = 30_000;

/**
 * Covers the same "see every branch, click through to detail" behavior the
 * old dashboard branch-card grid provided — that grid was removed from
 * /admin/dashboard as part of the Super Admin IA restructure (Dashboard is
 * now overview/monitoring only; branch management, including the full
 * clickable branch list, lives solely on /admin/branches).
 *
 * One test, one login, via the real login form rather than the shared
 * super_admin.auth.json storageState: that fixture's refresh_token cookie
 * rotates on first use (apps/web/hooks/use-auth.ts's silent-refresh-on-mount),
 * and since global-setup.ts writes it once for the whole run, the first spec
 * file to load it consumes it — every other file loading the same on-disk
 * cookie afterwards trips the API's reuse-detection guard and 401s every
 * request. Logging in fresh here costs one more of the login rate limiter's
 * 10-per-15-min budget (apps/api/src/middleware/rate-limiter.ts) but avoids
 * that cross-file collision entirely.
 */
test.describe('Branch list page', () => {
  test('branches list: shows all branches and row click navigates to detail', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'networkidle' });
    await page.getByLabel('Email').fill('admin@potatocorner.test');
    await page.getByRole('textbox', { name: 'Password' }).fill('SuperAdmin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL('**/admin/dashboard', { timeout: NAV_TIMEOUT });

    await page.getByRole('link', { name: 'Branches', exact: true }).click();
    await page.waitForURL('**/admin/branches', { timeout: NAV_TIMEOUT });

    await test.step('branches table lists all active branches including zero-activity ones', async () => {
      await expect(page.getByText('MAIN01')).toBeVisible({ timeout: NAV_TIMEOUT });

      const rows = page.getByRole('row');
      expect(await rows.count()).toBeGreaterThanOrEqual(13); // header row + >=12 branches
    });

    await test.step('clicking a branch row navigates to that branch detail', async () => {
      const row = page.getByRole('row', { name: /MAIN01/ });
      await row.click();

      await expect(page).toHaveURL(/\/admin\/branches\/[0-9a-f-]{36}$/, { timeout: NAV_TIMEOUT });
    });
  });
});
