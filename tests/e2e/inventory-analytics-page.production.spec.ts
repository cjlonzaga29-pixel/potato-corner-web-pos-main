// Production E2E suite for the Inventory Analytics tab
// (apps/web/components/reports/inventory-analytics-panel.tsx, rendered
// inside apps/web/app/(admin)/admin/reports/page.tsx). The standalone
// /admin/reports/inventory-analytics route was folded into the Reports
// page as part of the Super Admin IA restructure. Read-only — no
// data-writing operations, uses the shared session from helpers/prod-login.ts.
import { expect } from '@playwright/test';
import { test } from './helpers/prod-login';

const PANEL_TITLES = ['Fast Movers', 'Slow Movers', 'Waste Trends', 'Turnover by Branch', 'Reorder Recommendations'];

test('inventory analytics tab loads and renders panels', async ({ page }) => {
  await page.goto('/admin/reports?tab=INVENTORY_ANALYTICS');
  await expect(page.getByRole('tab', { name: 'Inventory Analytics', selected: true })).toBeVisible();
  for (const title of PANEL_TITLES) {
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
  }
});

test('period filter updates URL', async ({ page }) => {
  await page.goto('/admin/reports?tab=INVENTORY_ANALYTICS');
  await page.getByLabel('Period').click();
  await page.getByRole('option', { name: 'Last 90 days' }).click();
  await expect(page).toHaveURL(/inv_period=90d/);
});
