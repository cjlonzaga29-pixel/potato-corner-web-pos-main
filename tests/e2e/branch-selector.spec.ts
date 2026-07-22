import { test, expect } from '@playwright/test';
import { apiLogin, authedGet } from './fixtures/api-helpers';

// Dev-mode Turbopack compiles each route on first hit (can take 10-30s cold),
// so first-navigation assertions need a longer timeout than the 5s default.
const NAV_TIMEOUT = 30_000;

interface BranchRow {
  id: string;
  name: string;
  code: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One test, one login, via the real login form rather than the shared
 * super_admin.auth.json storageState: that fixture's refresh_token cookie
 * rotates on first use (apps/web/hooks/use-auth.ts's silent-refresh-on-mount),
 * and since global-setup.ts writes it once for the whole run, the first spec
 * file to load it consumes it — every other file (or, within a file, every
 * test after the first) loading the same on-disk cookie afterwards trips the
 * API's reuse-detection guard and 401s every request. All cases below share
 * ONE form login plus ONE api-login for branch discovery — both to match the
 * convention in branch-overview-grid.spec.ts / discount-audit.spec.ts, and
 * because the login rate limiter (10 per 15 min, apps/api/src/middleware/
 * rate-limiter.ts) is tight enough that logging in per-case exhausts it.
 */
test.describe('Branch selector', () => {
  test('super admin: default scope, URL override, KPI reactivity, persistence, full branch list', async ({ page, request }) => {
    const { accessToken } = await apiLogin(request, 'admin@potatocorner.test', 'SuperAdmin123');
    const branchesRes = await authedGet<{ branches: BranchRow[] }>(request, '/api/branches?status=active&limit=100', accessToken);
    const branches = branchesRes.data?.branches ?? [];
    expect(branches.length).toBeGreaterThanOrEqual(12);
    const targetBranch = branches[0];
    const targetNamePattern = new RegExp(`^${escapeRegExp(targetBranch.name)}`);

    await page.goto('/login', { waitUntil: 'networkidle' });
    await page.getByLabel('Email').fill('admin@potatocorner.test');
    await page.getByRole('textbox', { name: 'Password' }).fill('SuperAdmin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL('**/admin/dashboard', { timeout: NAV_TIMEOUT });

    const combobox = page.getByRole('combobox');

    await test.step('defaults to All Branches', async () => {
      await expect(combobox).toBeVisible({ timeout: NAV_TIMEOUT });
      await expect(combobox).toHaveText('All Branches');
    });

    await test.step('URL param overrides localStorage on load', async () => {
      await page.evaluate(() => {
        localStorage.setItem(
          'potato-corner:selected-branch',
          JSON.stringify({ state: { selectedBranchId: 'all' }, version: 0 }),
        );
      });

      await page.goto(`/admin/dashboard?branch_id=${targetBranch.id}`, { timeout: NAV_TIMEOUT });
      await expect(combobox).toHaveText(targetNamePattern, { timeout: 2_000 });
    });

    await test.step('selecting a branch updates KPI cards', async () => {
      // Reset to All Branches first so this step's own before/after comparison
      // is meaningful regardless of the URL-override step that ran before it.
      await combobox.click();
      await page.getByRole('option', { name: 'All Branches', exact: true }).click();
      await expect(combobox).toHaveText('All Branches');

      const kpiValues = page.locator('.grid.grid-cols-1.gap-4.sm\\:grid-cols-2.md\\:grid-cols-4 .text-2xl.font-bold');
      await expect(kpiValues.first()).toBeVisible({ timeout: NAV_TIMEOUT });
      const before = await kpiValues.allTextContents();

      await combobox.click();
      await page.getByRole('option', { name: targetNamePattern }).click();
      await expect(combobox).toHaveText(targetNamePattern);

      await expect
        .poll(
          async () => {
            const after = await kpiValues.allTextContents();
            return after.some((value, i) => value !== before[i]);
          },
          { timeout: NAV_TIMEOUT },
        )
        .toBe(true);
    });

    await test.step('selection persists across page refresh', async () => {
      await page.reload();
      await expect(combobox).toHaveText(targetNamePattern, { timeout: NAV_TIMEOUT });
    });

    await test.step('selection persists across navigation away and back', async () => {
      await page.getByRole('link', { name: 'Branches', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/branches$/, { timeout: NAV_TIMEOUT });

      await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/dashboard$/, { timeout: NAV_TIMEOUT });
      await expect(combobox).toHaveText(targetNamePattern, { timeout: NAV_TIMEOUT });
    });

    await test.step('dropdown lists all active branches plus All Branches', async () => {
      await combobox.click();
      await expect(page.getByRole('option', { name: 'All Branches', exact: true })).toBeVisible();
      const options = page.getByRole('option');
      expect(await options.count()).toBeGreaterThanOrEqual(branches.length + 1);
      await page.keyboard.press('Escape');
    });
  });

  test('single-branch supervisor sees read-only label (SKIPPED — feature not wired to a supervisor-reachable route)', async () => {
    // apps/web/app/(admin)/admin/dashboard/page.tsx is the only page importing
    // BranchSelector/useSelectedBranch, and (admin)/layout.tsx is gated to
    // super_admin by middleware.ts. No supervisor-accessible route renders
    // this component yet, so there is nothing to assert against — skipping
    // per the task's own escape hatch rather than asserting on a page the
    // supervisor account can't reach.
    test.skip(true, 'BranchSelector is only rendered on /admin/dashboard, a super_admin-only route');
  });
});
