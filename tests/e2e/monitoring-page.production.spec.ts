// Production E2E suite for the Super Admin monitoring dashboard
// (apps/web/app/(admin)/admin/monitoring/page.tsx). Read-only — no
// data-writing operations, uses the shared session from helpers/prod-login.ts.
import { expect } from '@playwright/test';
import { test } from './helpers/prod-login';

const PANEL_TITLES = ['Live Transaction Feed', 'Active Cashiers', 'Live Alerts Stream', 'Branch Connection Status'];

test('monitoring page loads and renders 4 panels', async ({ page }) => {
  await page.goto('/admin/monitoring');
  await expect(page.getByRole('heading', { name: 'Real-Time Monitoring' })).toBeVisible();
  await expect(page.getByText('Connected').or(page.getByText('Reconnecting')).or(page.getByText('Disconnected'))).toBeVisible();
  for (const title of PANEL_TITLES) {
    await expect(page.getByText(title)).toBeVisible();
  }
});

test('connection status shows connected within 5s', async ({ page }) => {
  await page.goto('/admin/monitoring');
  await expect(page.getByTitle('Connected')).toBeVisible({ timeout: 5000 });
});
