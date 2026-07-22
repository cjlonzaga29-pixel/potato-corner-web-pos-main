// Production E2E suite for the Active Sessions section on the /profile page
// (apps/web/components/profile/active-sessions-section.tsx). Uses the shared
// prod-login session. No revoke operations here — revoking the session
// under test would sign the suite's own session out mid-run.
import { test } from './helpers/prod-login';
import { expect } from '@playwright/test';

test('active sessions section loads on profile page', async ({ page }) => {
  await page.goto('/profile');
  await page.waitForLoadState('networkidle', { timeout: 15000 });
  await page.waitForTimeout(2000);

  await expect(page.getByText('Active Sessions')).toBeVisible();

  const emptyState = page.getByText('No other active sessions');
  const sessionRows = page.getByText(/^Device /);
  await expect(emptyState.or(sessionRows.first())).toBeVisible({ timeout: 15000 });
});

test('current device is marked with "This device" badge', async ({ page }) => {
  await page.goto('/profile');
  await page.waitForLoadState('networkidle', { timeout: 15000 });
  await page.waitForTimeout(2000);

  await expect(page.getByText('This device')).toBeVisible({ timeout: 15000 });
});
