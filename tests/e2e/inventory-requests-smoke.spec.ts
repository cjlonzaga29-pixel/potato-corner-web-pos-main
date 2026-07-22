// Smoke coverage for the inventory-request approval flow (supervisor) and
// GCash QR management (super admin). Auth reuses the storageState fixtures
// produced by global-setup.ts (same pattern as inventory.spec.ts) rather
// than re-submitting the login form — no credentials are hardcoded here,
// they come from fixtures/test-users.ts via that setup.
import { test, expect } from '@playwright/test';
import path from 'node:path';

test.describe('Inventory Requests + GCash QR — Smoke', () => {
  test.describe('supervisor inventory request lifecycle', () => {
    test.use({ storageState: path.join(__dirname, 'fixtures', 'supervisor.auth.json') });

    test('submit, list, and approve an inventory request', async ({ page }) => {
      const smokeRequestRow = page.getByRole('row').filter({ hasText: 'smoke test' });

      await test.step('A) Supervisor submits inventory request', async () => {
        await page.goto('/supervisor/inventory');
        await expect(page.locator('tbody tr')).not.toHaveCount(0, { timeout: 15_000 });
        await page.getByRole('button', { name: 'Request Stock In' }).first().waitFor({ state: 'visible', timeout: 15_000 });
        await page.getByRole('button', { name: 'Request Stock In' }).first().click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await dialog.locator('input[type="number"]').fill('1');
        await dialog.getByPlaceholder('Reason for this request').fill('smoke test');
        await dialog.getByRole('button', { name: 'Submit Request' }).click();

        await expect(page.getByText('Inventory request submitted')).toBeVisible();
        await expect(dialog).toBeHidden();
      });

      await test.step('B) Supervisor sees request in pending list', async () => {
        await page.goto('/supervisor/inventory-requests');

        for (const column of ['Branch', 'Ingredient', 'Type', 'Quantity', 'Reason']) {
          await expect(page.getByRole('columnheader', { name: column })).toBeVisible();
        }

        await expect(smokeRequestRow.first()).toBeVisible();
      });

      await test.step('C) Supervisor approves the request', async () => {
        await smokeRequestRow.first().getByRole('button', { name: 'Approve' }).click();

        await expect(page.getByText('Inventory request approved')).toBeVisible();
        // Row removal depends on a react-query invalidation that also races
        // the socket-driven INVENTORY_REQUEST_APPROVED invalidation
        // (useRealtimeInvalidate) — poll instead of a single assertion.
        await expect.poll(() => smokeRequestRow.count(), { timeout: 10_000 }).toBe(0);
      });
    });
  });

  test.describe('admin GCash QR management', () => {
    test.use({ storageState: path.join(__dirname, 'fixtures', 'super_admin.auth.json') });

    test('upload and remove a GCash QR code', async ({ page }) => {
      await test.step('D) Admin uploads GCash QR', async () => {
        await page.goto('/admin/branches');
        const firstBranchRow = page.locator('tbody tr').filter({ hasNotText: 'Loading' }).first();
        await firstBranchRow.waitFor({ state: 'visible', timeout: 15_000 });
        await firstBranchRow.click();
        await page.waitForURL('**/admin/branches/**');

        await page.getByRole('tab', { name: 'Settings' }).click();
        await expect(page.getByText('GCash QR Code')).toBeVisible();

        await page.locator('#gcash-qr-upload').setInputFiles(path.join(__dirname, 'fixtures', 'gcash-test.png'));

        await expect(page.getByText('Branch updated')).toBeVisible();
        await expect(page.getByAltText('GCash QR code')).toBeVisible();
      });

      await test.step('E) Admin removes GCash QR', async () => {
        await page.getByRole('button', { name: 'Remove QR' }).click();

        await expect(page.getByText('Branch updated').last()).toBeVisible();
        await expect.poll(() => page.getByAltText('GCash QR code').count(), { timeout: 10_000 }).toBe(0);
      });
    });
  });
});
