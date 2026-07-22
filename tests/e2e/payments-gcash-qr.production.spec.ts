// Production E2E smoke suite for the bulk GCash QR assignment page
// (apps/web/app/(admin)/admin/payments/gcash-qr). Deliberately read-only:
// it never selects a file or submits the assign form, since that would
// upload a real image and overwrite a live branch's GCash QR in production.
import { test } from './helpers/prod-login';
import { expect } from '@playwright/test';

test('bulk GCash QR page loads and renders correctly', async ({ page }) => {
  await page.goto('/admin/payments/gcash-qr');
  await page.waitForLoadState('networkidle', { timeout: 15000 });

  await expect(page.getByRole('heading', { name: 'Bulk Assign GCash QR' })).toBeVisible();
  await expect(page.getByLabel('Upload GCash QR image')).toBeVisible();
  await expect(page.getByText(/Select all/)).toBeVisible({ timeout: 15000 });
});

test('assign button is disabled without a file or selected branches', async ({ page }) => {
  await page.goto('/admin/payments/gcash-qr');
  await page.waitForLoadState('networkidle', { timeout: 15000 });

  const assignButton = page.getByRole('button', { name: /Assign to/ });
  await expect(assignButton).toBeVisible();
  await expect(assignButton).toBeDisabled();
});
