// Production E2E suite for /admin/settings (apps/web/app/(admin)/admin/settings).
// Uses the shared prod-login session — no mutation operations, since this
// suite runs against production and must never persist config changes.
import { test } from './helpers/prod-login';
import { expect } from '@playwright/test';

test('settings page loads and shows 3 tabs', async ({ page }) => {
  await page.goto('/admin/settings');
  await page.waitForLoadState('networkidle', { timeout: 15000 });

  await expect(page.getByRole('heading', { name: 'System Settings' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Security' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Receipt Templates' })).toBeVisible();
});

test('tab switching updates URL', async ({ page }) => {
  await page.goto('/admin/settings');
  await page.waitForLoadState('networkidle', { timeout: 15000 });

  await page.getByRole('tab', { name: 'Notifications' }).click();

  await expect(page).toHaveURL(/[?&]tab=notifications/);
});
