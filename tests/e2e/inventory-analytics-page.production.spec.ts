// Production E2E suite for the Inventory Analytics dashboard
// (apps/web/app/(admin)/admin/reports/inventory-analytics/page.tsx).
// Read-only — no data-writing operations, uses the shared session from
// helpers/prod-login.ts.
import { expect } from '@playwright/test';
import { test } from './helpers/prod-login';

const PANEL_TITLES = ['Fast Movers', 'Slow Movers', 'Waste Trends', 'Turnover by Branch', 'Reorder Recommendations'];

test('inventory analytics page loads and renders panels', async ({ page }) => {
  await page.goto('/admin/reports/inventory-analytics');
  await expect(page.getByRole('heading', { name: 'Inventory Analytics' })).toBeVisible();
  for (const title of PANEL_TITLES) {
    await expect(page.getByText(title)).toBeVisible();
  }
});

test('period filter updates URL', async ({ page }) => {
  await page.goto('/admin/reports/inventory-analytics');
  await page.getByLabel('Period').click();
  await page.getByRole('option', { name: 'Last 90 days' }).click();
  await expect(page).toHaveURL(/period=90d/);
});
