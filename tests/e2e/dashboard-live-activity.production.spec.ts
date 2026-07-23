// Production E2E suite for the Super Admin dashboard's Live Activity section
// (apps/web/app/(admin)/admin/dashboard/page.tsx). The standalone
// /admin/monitoring page was merged into /admin/dashboard as part of the
// Super Admin IA restructure — this suite now exercises the same 4 panels
// in their new home. Read-only — no data-writing operations, uses the
// shared session from helpers/prod-login.ts.
import { expect } from '@playwright/test';
import { test } from './helpers/prod-login';

const PANEL_TITLES = ['Live Transaction Feed', 'Active Cashiers', 'Live Alerts Stream', 'Branch Connection Status'];

test('dashboard Live Activity section renders 4 panels', async ({ page }) => {
  await page.goto('/admin/dashboard');
  await expect(page.getByRole('heading', { name: 'Live Activity' })).toBeVisible();
  await expect(page.getByText('Connected').or(page.getByText('Reconnecting')).or(page.getByText('Disconnected'))).toBeVisible();
  for (const title of PANEL_TITLES) {
    await expect(page.getByText(title)).toBeVisible();
  }
});

test('connection status shows connected within 5s', async ({ page }) => {
  await page.goto('/admin/dashboard');
  await expect(page.getByTitle('Connected')).toBeVisible({ timeout: 5000 });
});
