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
test.describe('Branch accounts', () => {
  test('branch accounts page: loads assignments with expected columns', async ({ page }) => {
    await test.step('branch accounts page loads and shows assignments', async () => {
      await page.goto('/login', { waitUntil: 'networkidle' });
      await page.getByLabel('Email').fill('admin@potatocorner.test');
      await page.getByRole('textbox', { name: 'Password' }).fill('SuperAdmin123');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL('**/admin/dashboard', { timeout: NAV_TIMEOUT });

      await page.getByRole('link', { name: 'Branch Accounts' }).click();
      await expect(page).toHaveURL(/\/admin\/branch-accounts$/, { timeout: NAV_TIMEOUT });

      const rows = page.locator('table tbody tr');
      await expect(rows.first()).toBeVisible({ timeout: NAV_TIMEOUT });
      expect(await rows.count()).toBeGreaterThanOrEqual(1);

      const firstRow = rows.first();
      await expect(firstRow.locator('td').nth(0)).not.toBeEmpty();
      await expect(firstRow.locator('td').nth(1)).not.toBeEmpty();
    });

    await test.step('each row has expected columns', async () => {
      const rows = page.locator('table tbody tr');
      const firstRow = rows.first();
      const cells = firstRow.locator('td');
      await expect(cells).toHaveCount(4);

      const branchCell = await cells.nth(0).innerText();
      const nameCell = await cells.nth(1).innerText();
      const emailCell = await cells.nth(2).innerText();

      expect(branchCell.trim().length).toBeGreaterThan(0);
      expect(nameCell.trim().length).toBeGreaterThan(0);
      expect(emailCell).toMatch(/@/);
    });
  });
});
