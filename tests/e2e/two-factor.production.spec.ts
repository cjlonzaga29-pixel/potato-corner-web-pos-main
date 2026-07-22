// Production E2E suite for the Two-Factor Authentication section on the
// /admin/profile page (apps/web/components/profile/two-factor-section.tsx).
// Uses the shared prod-login session. Does not actually enroll — that would
// require handling a real TOTP secret in the test and would leave 2FA
// enabled on the shared prod-login account for every later test in the suite.
import { test } from './helpers/prod-login';
import { expect } from '@playwright/test';

test('two-factor section loads on profile page', async ({ page }) => {
  await page.goto('/admin/profile');
  await page.waitForLoadState('networkidle', { timeout: 15000 });
  await page.waitForTimeout(2000);

  await expect(page.getByText('Two-Factor Authentication')).toBeVisible();
});

test('enable 2FA button visible when disabled', async ({ page }) => {
  await page.goto('/admin/profile');
  await page.waitForLoadState('networkidle', { timeout: 15000 });
  await page.waitForTimeout(2000);

  await expect(page.getByRole('button', { name: 'Enable 2FA' })).toBeVisible({ timeout: 15000 });
});
