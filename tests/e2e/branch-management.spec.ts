// AUTHORED, NOT EXECUTED: no local Postgres/Redis instance is available in
// the environment this was written in (see phase-19-debt.md and
// cash-management.spec.ts's header for the same caveat) — never run
// against a live app without first confirming the seeded fixtures
// (apps/api/prisma/seed.ts) are present. Selectors/flows are taken from
// reading the real components (create-branch-dialog.tsx,
// edit-branch-dialog.tsx, change-status-dialog.tsx,
// assign-supervisor-dialog.tsx, app/(admin)/admin/branches/page.tsx and
// .../branches/[branchId]/page.tsx), not guessed.
//
// Covers the gaps called out for the branches module's e2e coverage:
// branch create, branch edit (name/address/GPS), the active-shifts guard
// on closing a branch, and the assign/remove-supervisor mutation actions.
// Those mutation actions live on the branch DETAIL page's Assignments tab
// (apps/web/app/(admin)/admin/branches/[branchId]/page.tsx), not on
// /admin/branch-accounts (that page — branch-accounts.spec.ts — is
// read-only: createBranchAccountsColumns() has no action column).
import { test, expect } from '@playwright/test';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedGet, authedPost } from './fixtures/api-helpers';

const NAV_TIMEOUT = 30_000;

/** Distinguishes this run's throwaway branch from any other branch/test data without needing cleanup. */
function uniqueBranchName(label: string): string {
  return `E2E ${label} ${Date.now()}`;
}

test.describe('Branch create, edit, and supervisor assignment (admin UI)', () => {
  test('create a branch, edit its details, then assign and remove a supervisor', async ({
    page,
  }) => {
    const branchName = uniqueBranchName('CRUD');
    let branchId = '';

    await test.step('login as super_admin', async () => {
      await page.goto('/login', { waitUntil: 'networkidle' });
      await page.getByLabel('Email').fill(TEST_USERS.super_admin.email);
      await page.getByRole('textbox', { name: 'Password' }).fill(TEST_USERS.super_admin.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL('**/admin/dashboard', { timeout: NAV_TIMEOUT });
    });

    await test.step('create a branch via the Create Branch dialog', async () => {
      await page.goto('/admin/branches', { waitUntil: 'networkidle' });

      await page.getByRole('button', { name: 'Create Branch' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Branch Name').fill(branchName);
      await dialog.getByLabel('City').fill('Quezon City');
      await dialog.getByLabel('Address').fill('123 Commonwealth Avenue');
      // Two "Create Branch" buttons exist once the dialog is open (the
      // header button that opened it, and the dialog's own submit button)
      // — scope to the dialog to avoid a strict-mode ambiguity.
      await dialog.getByRole('button', { name: 'Create Branch' }).click();

      // The dialog closes and the list refetches — search narrows the
      // table down to the one row so the click target is unambiguous.
      await expect(page.getByRole('dialog')).toBeHidden({ timeout: NAV_TIMEOUT });
      await page.getByPlaceholder('Search name or code...').fill(branchName);
      const row = page.getByRole('row', { name: new RegExp(branchName) });
      await expect(row).toBeVisible({ timeout: NAV_TIMEOUT });

      await row.click();
      await expect(page).toHaveURL(/\/admin\/branches\/[0-9a-f-]{36}$/, { timeout: NAV_TIMEOUT });
      branchId = page.url().split('/').pop() ?? '';
      expect(branchId).toMatch(/^[0-9a-f-]{36}$/);
      await expect(page.getByRole('heading', { name: branchName })).toBeVisible();
    });

    await test.step('edit the branch name and address via the Settings tab', async () => {
      const updatedName = `${branchName} Updated`;
      await page.getByRole('tab', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'Edit Branch Details' }).click();

      const nameInput = page.getByLabel('Branch Name');
      await nameInput.fill('');
      await nameInput.fill(updatedName);
      const addressInput = page.getByLabel('Address');
      await addressInput.fill('');
      await addressInput.fill('456 Ayala Avenue');
      await page.getByLabel('GPS Latitude').fill('14.5995');
      await page.getByLabel('GPS Longitude').fill('120.9842');

      await page.getByRole('button', { name: 'Save Changes' }).click();
      await expect(page.getByRole('dialog')).toBeHidden({ timeout: NAV_TIMEOUT });
      await expect(page.getByRole('heading', { name: updatedName })).toBeVisible({
        timeout: NAV_TIMEOUT,
      });

      await page.getByRole('tab', { name: 'Overview' }).click();
      await expect(page.getByText('456 Ayala Avenue')).toBeVisible();
      await expect(page.getByText('14.599500, 120.984200')).toBeVisible();
    });

    await test.step('assign a supervisor from the Assignments tab', async () => {
      await page.getByRole('tab', { name: 'Assignments' }).click();
      await expect(page.getByText('No supervisors assigned')).toBeVisible({ timeout: NAV_TIMEOUT });

      await page.getByRole('button', { name: 'Add Supervisor' }).click();
      // The seeded supervisor (Marco Reyes) is only assigned to the seeded
      // "Main Branch" (MAIN01), so on this brand-new branch he shows up
      // with a "Select" button rather than an "Assigned" badge.
      await page.getByPlaceholder('Search supervisors...').fill('Marco Reyes');
      await page.getByRole('button', { name: 'Select' }).click();

      // useAssignSupervisor's onSuccess invalidates ['branch', branchId,
      // 'assignments'] and ['branches'] but not the employees list the
      // dialog itself reads from, so the in-dialog "Select" button doesn't
      // flip to an "Assigned" badge — the assignments list underneath
      // (Assignments tab, outside the dialog) is the query that actually
      // refetches, so that's the assertable signal of success.
      await page.keyboard.press('Escape');
      await expect(page.getByText('No supervisors assigned')).toBeHidden({ timeout: NAV_TIMEOUT });
      await expect(page.getByText('Marco Reyes')).toBeVisible({ timeout: NAV_TIMEOUT });
    });

    await test.step('remove the supervisor from the Assignments tab', async () => {
      const assignmentRow = page.locator('.rounded-md.border.p-3', { hasText: 'Marco Reyes' });
      await assignmentRow.getByRole('button').click();

      await expect(page.getByRole('alertdialog', { name: 'Remove supervisor?' })).toBeVisible({
        timeout: NAV_TIMEOUT,
      });
      await page.getByRole('button', { name: 'Remove' }).click();

      await expect(page.getByText('No supervisors assigned')).toBeVisible({ timeout: NAV_TIMEOUT });
    });
  });
});

test.describe('Branch status change guarded by active shifts (admin UI)', () => {
  test('closing a branch with an active shift is blocked; closing an idle branch succeeds', async ({
    page,
    request,
    baseURL,
  }) => {
    const url = baseURL ?? 'http://localhost:3000';
    const branchName = uniqueBranchName('STATUS');
    let branchId = '';

    await test.step('seed a throwaway branch and an active shift on it via the real API', async () => {
      const admin = await apiLogin(
        request,
        TEST_USERS.super_admin.email,
        TEST_USERS.super_admin.password,
      );

      const created = await authedPost<{ id: string }>(
        request,
        url,
        '/api/branches',
        admin.accessToken,
        {
          name: branchName,
          address: '789 Taft Avenue',
          city: 'Manila',
          status: 'active',
        },
      );
      if (!created.data?.id)
        throw new Error(`Failed to seed branch: ${JSON.stringify(created.error)}`);
      branchId = created.data.id;

      // cash.service.ts's openShift only requires an active cashier — it
      // does not require the cashier be assigned to the branch — so the
      // seeded staff account (Jenny Santos) works as the cashier even
      // though her real assignment is the seeded "Main Branch".
      const staff = await authedGet<{ employees: { id: string; email: string }[] }>(
        request,
        `/api/employees?search=${encodeURIComponent(TEST_USERS.staff.email)}`,
        admin.accessToken,
      );
      const cashierId = staff.data?.employees[0]?.id;
      if (!cashierId)
        throw new Error(`Failed to find seeded staff account: ${JSON.stringify(staff.error)}`);

      const opened = await authedPost(request, url, '/api/cash/open', admin.accessToken, {
        branch_id: branchId,
        cashier_id: cashierId,
        starting_cash: 500,
        denominations: [{ denomination: 500, quantity: 1 }],
      });
      if (opened.status !== 201)
        throw new Error(
          `Failed to open a shift on the seeded branch: ${JSON.stringify(opened.error)}`,
        );
    });

    await test.step('login as super_admin and open the seeded branch', async () => {
      await page.goto('/login', { waitUntil: 'networkidle' });
      await page.getByLabel('Email').fill(TEST_USERS.super_admin.email);
      await page.getByRole('textbox', { name: 'Password' }).fill(TEST_USERS.super_admin.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL('**/admin/dashboard', { timeout: NAV_TIMEOUT });

      await page.goto(`/admin/branches/${branchId}`, { waitUntil: 'networkidle' });
      await expect(page.getByRole('heading', { name: branchName })).toBeVisible({
        timeout: NAV_TIMEOUT,
      });
    });

    await test.step('attempting to close via the Danger Zone is rejected by the active-shifts guard', async () => {
      await page.getByRole('tab', { name: 'Settings' }).click();
      await page.getByLabel(/Type .* to confirm/).fill(branchName);

      const closeButton = page.getByRole('button', { name: 'Close Branch' });
      await expect(closeButton).toBeEnabled();
      await closeButton.click();

      // change-status-dialog.tsx / SettingsTab both surface mutation
      // failures only via toast.error(error.message) (use-branches.ts's
      // useChangeBranchStatus onError) — no inline error element exists,
      // so the BranchError message text is the only assertable surface.
      await expect(page.getByText('Cannot close a branch with active shifts')).toBeVisible({
        timeout: NAV_TIMEOUT,
      });
      // SettingsTab's Status card renders the raw BranchStatus enum value
      // (lowercase), not currentStatusLabel — unlike ChangeStatusDialog,
      // which the Danger Zone button bypasses entirely.
      await expect(page.getByText('Current status: active')).toBeVisible();
    });

    await test.step('closing succeeds once the shift is closed', async () => {
      const admin = await apiLogin(
        request,
        TEST_USERS.super_admin.email,
        TEST_USERS.super_admin.password,
      );
      const current = await authedGet<{ id: string }>(
        request,
        `/api/cash/current?branch_id=${branchId}`,
        admin.accessToken,
      );
      const shiftId = current.data?.id;
      if (!shiftId) throw new Error('Expected the seeded shift to still be active');

      const closed = await authedPost(
        request,
        url,
        `/api/cash/${shiftId}/close`,
        admin.accessToken,
        {
          denominations: [{ denomination: 500, quantity: 1 }],
        },
      );
      if (closed.status !== 200)
        throw new Error(`Failed to close the seeded shift: ${JSON.stringify(closed.error)}`);

      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('tab', { name: 'Settings' }).click();
      await page.getByLabel(/Type .* to confirm/).fill(branchName);
      await page.getByRole('button', { name: 'Close Branch' }).click();

      await expect(page.getByText('Current status: closed')).toBeVisible({ timeout: NAV_TIMEOUT });
    });
  });
});
