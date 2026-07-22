import { test, expect } from '@playwright/test';

// Dev-mode Turbopack compiles each route on first hit (can take 10-30s cold),
// so first-navigation assertions need a longer timeout than the 5s default.
const NAV_TIMEOUT = 30_000;

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
test.describe('Branch overview grid', () => {
  test('dashboard branch grid: shows all branches and card click navigates', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'networkidle' });
    await page.getByLabel('Email').fill('admin@potatocorner.test');
    await page.getByRole('textbox', { name: 'Password' }).fill('SuperAdmin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL('**/admin/dashboard', { timeout: NAV_TIMEOUT });

    await test.step('dashboard grid shows all active branches including zero-activity ones', async () => {
      await expect(page.getByText('MAIN01')).toBeVisible({ timeout: NAV_TIMEOUT });

      const grid = page.locator('.grid').filter({ has: page.getByText('MAIN01') });
      const cards = grid.locator('> div');
      expect(await cards.count()).toBeGreaterThanOrEqual(12);
    });

    await test.step('clicking a branch card navigates to that branch detail', async () => {
      const grid = page.locator('.grid').filter({ has: page.getByText('MAIN01') });
      const firstCard = grid.locator('> div').first();
      await expect(firstCard).toBeVisible();
      await firstCard.click();

      await expect(page).toHaveURL(/\/admin\/branches\/[0-9a-f-]{36}$/, { timeout: NAV_TIMEOUT });
    });
  });
});
