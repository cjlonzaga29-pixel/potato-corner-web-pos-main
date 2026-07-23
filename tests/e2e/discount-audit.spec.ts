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
test.describe('Discount audit', () => {
  test('discount audit panel: loads, filters, and exports', async ({ page }) => {
    await test.step('discount audit panel loads and shows seeded rows', async () => {
      await page.goto('/login', { waitUntil: 'networkidle' });
      await page.getByLabel('Email').fill('admin@potatocorner.test');
      await page.getByRole('textbox', { name: 'Password' }).fill('SuperAdmin123');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL('**/admin/dashboard', { timeout: NAV_TIMEOUT });

      await page.getByRole('link', { name: 'Reports', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/reports$/, { timeout: NAV_TIMEOUT });
      await page.getByRole('tab', { name: 'Discount Compliance' }).click();
      await expect(page.getByText('Discount Audit Trail')).toBeVisible({ timeout: NAV_TIMEOUT });

      const rows = page.locator('table').filter({ hasText: 'Receipt #' }).locator('tbody tr');
      await expect(rows.first()).toBeVisible({ timeout: NAV_TIMEOUT });
      expect(await rows.count()).toBeGreaterThanOrEqual(5);

      await expect(page.getByText('Flagged').first()).toBeVisible();
    });

    await test.step('filter by discount type narrows results', async () => {
      const rows = page.locator('table').filter({ hasText: 'Receipt #' }).locator('tbody tr');
      const countBefore = await rows.count();

      await page.getByLabel('Discount Type').click();
      await page.getByRole('option', { name: 'PWD', exact: true }).click();
      await expect(page).toHaveURL(/discount_type=pwd/);

      await expect(rows.first()).toBeVisible();
      // useDiscountAudit keeps showing the previous (unfiltered) result set
      // while the filtered request is in flight (keepPreviousData), so
      // comparing the row count against itself right after the click races
      // the refetch. Poll on the actual condition we care about — every
      // visible row is PWD — which only becomes true once the filtered
      // response has landed.
      await expect
        .poll(
          async () => {
            const texts = await rows.locator('td:nth-child(3)').allTextContents();
            return texts.length > 0 && texts.every((text) => text === 'PWD');
          },
          { timeout: NAV_TIMEOUT },
        )
        .toBe(true);

      const discountTypeTexts = await rows.locator('td:nth-child(3)').allTextContents();
      expect(discountTypeTexts.length).toBeGreaterThan(0);
      expect(discountTypeTexts.length).toBeLessThanOrEqual(countBefore);
      for (const text of discountTypeTexts) {
        expect(text).toBe('PWD');
      }
    });

    await test.step('csv export downloads a file', async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Export CSV' }).click(),
      ]);

      expect(download.suggestedFilename()).toMatch(/\.csv$/);
    });
  });
});
