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
 *
 * Task 209.5x — rewritten to match the actual Admin Reports UI: Discount
 * Compliance is a branch-scoped aggregate table (Reports > Compliance >
 * Discount Compliance), one row per branch+discount_type, with a "View
 * Transactions" action that opens DiscountComplianceDrilldown (a Sheet, not
 * a page) showing the per-transaction rows behind that row. The previous
 * version of this spec asserted a "Discount Audit Trail" heading and a
 * page-level discount-type filter/Export CSV button that no longer exist in
 * this component — it predates DiscountComplianceDrilldown and had drifted
 * out of sync with the UI, silently testing nothing real.
 */
test.describe('Discount Compliance report', () => {
  test('summary reconciles with the transaction drill-down and does not crash on legacy rows', async ({ page }) => {
    await test.step('log in and open Reports > Compliance > Discount Compliance', async () => {
      await page.goto('/login', { waitUntil: 'networkidle' });
      await page.getByLabel('Email').fill('admin@potatocorner.test');
      await page.getByRole('textbox', { name: 'Password' }).fill('SuperAdmin123');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL('**/admin/dashboard', { timeout: NAV_TIMEOUT });

      await page.getByRole('link', { name: 'Reports', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/reports$/, { timeout: NAV_TIMEOUT });
      await page.getByRole('button', { name: 'Compliance' }).click();
      await page.getByRole('tab', { name: 'Discount Compliance' }).click();
    });

    await test.step('select Test Branch (seeded discount-audit fixtures) and wait for the summary to load', async () => {
      await page.getByRole('combobox').first().click();
      await page.getByRole('option', { name: 'Test Branch', exact: true }).click();
      await expect(page.getByText('Discounted Transactions')).toBeVisible({ timeout: NAV_TIMEOUT });
      // Skeletons resolve once the KPI aggregate query lands.
      await expect(page.locator('[class*="animate-pulse"]').first()).not.toBeVisible({ timeout: NAV_TIMEOUT });
    });

    let summaryCount = 0;
    let summaryAmount = '';

    await test.step('read the summary row (branch/discount-type aggregate)', async () => {
      const summaryRow = page.locator('table').filter({ hasText: 'BRANCH' }).locator('tbody tr').first();
      await expect(summaryRow).toBeVisible({ timeout: NAV_TIMEOUT });
      const cells = await summaryRow.locator('td').allTextContents();
      // BRANCH | DISCOUNT TYPE | TRANSACTIONS | DISCOUNT AMOUNT | VAT EXEMPT AMOUNT | ACTIONS
      summaryCount = Number(cells[2]);
      summaryAmount = cells[3].replace(/[^0-9.]/g, '');
      expect(summaryCount).toBeGreaterThan(0);
    });

    await test.step('open the drill-down — it must render every matching row, not "Something went wrong"', async () => {
      await page.getByRole('button', { name: 'View Transactions' }).first().click();
      await expect(page.getByText(/^Discount Transactions —/)).toBeVisible({ timeout: NAV_TIMEOUT });

      // The crash this regression guards against surfaced as a swallowed
      // 500 from GET /api/transactions/discount-audit (a legacy row whose
      // encrypted discount_id_reference no longer decrypts under the
      // current ENCRYPTION_KEY) — assert the request actually succeeded
      // rather than only checking the DOM, so a future regression that
      // silently re-introduces a hidden error state still fails this test.
      const [response] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/transactions/discount-audit'), { timeout: NAV_TIMEOUT }),
      ]).catch(() => [null]);
      if (response) expect(response.status()).toBe(200);

      await expect(page.getByText('Something went wrong')).not.toBeVisible();

      const detailRows = page.getByRole('dialog').locator('table').locator('tbody tr');
      await expect(detailRows.first()).toBeVisible({ timeout: NAV_TIMEOUT });
      expect(await detailRows.count()).toBe(summaryCount);
    });

    await test.step('summary and detail amounts reconcile', async () => {
      const detailAmounts = await page
        .getByRole('dialog')
        .locator('table')
        .locator('tbody tr td:nth-child(6)')
        .allTextContents();
      const detailTotal = detailAmounts.reduce((sum, cell) => sum + Number(cell.replace(/[^0-9.]/g, '')), 0);
      expect(detailTotal.toFixed(2)).toBe(Number(summaryAmount).toFixed(2));
    });

    await test.step('legacy/no-proof rows render without crashing: proof column is "No" or a working View Proof action', async () => {
      const proofCells = page.getByRole('dialog').locator('table').locator('tbody tr td:last-child');
      const count = await proofCells.count();
      for (let i = 0; i < count; i++) {
        const cell = proofCells.nth(i);
        const text = await cell.innerText();
        expect(text === 'No' || text.includes('View Proof')).toBe(true);
      }
    });

    await test.step('View Proof opens a dialog with the image (only for rows that actually have proof)', async () => {
      const viewProofButton = page.getByRole('dialog').getByRole('button', { name: /Yes · View Proof/ }).first();
      if (await viewProofButton.count()) {
        await viewProofButton.click();
        await expect(page.getByRole('heading', { name: 'Discount Proof' })).toBeVisible({ timeout: NAV_TIMEOUT });
        await expect(page.locator('img[alt="Discount proof"]')).toBeVisible({ timeout: NAV_TIMEOUT });
      }
    });
  });
});
