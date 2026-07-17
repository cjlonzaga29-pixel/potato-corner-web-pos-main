// AUTHORED, NOT EXECUTED: no local Postgres/Redis instance is available in
// the environment this was written in (see phase-19-debt.md) — never run
// against a live app. Selectors/flows taken from reading the real
// components and cash.service.ts, not guessed.
//
// Two of the three flows this file covers have NO frontend page at all:
// - Variance approval (POST /api/cash/:shiftId/approve-variance) — there is
//   no admin UI for it; only price-overrides and product-requests have
//   approval pages under apps/web/app/(admin)/admin/approvals/. Tested at
//   the API layer directly, with that gap called out explicitly rather than
//   silently worked around.
// - Cashier handover detection (SHIFT_UNAUTHORIZED_CLOSE, cash.service.ts
//   closeShift) — apps/web/app/(pos)/shift/close/page.tsx has no visible
//   error rendering for a failed close mutation at all (no {closeShift.
//   error && ...} block), so a UI-driven version of this test could only
//   assert "the button stops spinning," which proves nothing. Tested at the
//   API layer instead. Both gaps are worth a product decision in Phase 20,
//   not silently patched over here — hardening doesn't include building new
//   UI.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedPost, authedGet } from './fixtures/api-helpers';
import { seedSecondSupervisor, SECOND_SUPERVISOR } from './fixtures/seed-second-supervisor';

interface ShiftApi {
  id: string;
  status: string;
  variance_approved: boolean | null;
  cash_variance: number;
}

let branchId: string;
let flaggedShiftId: string;

test.beforeAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const branches = await authedGet<{ branches: { id: string; code: string }[] }>(request, '/api/branches', admin.accessToken);
  const branch = branches.data?.branches.find((b) => b.code === 'MAIN01');
  if (!branch) throw new Error('Seeded "Main Branch" (MAIN01) not found — run apps/api/prisma/seed.ts first');
  branchId = branch.id;

  await seedSecondSupervisor(request, url, branchId);
});

test.describe('cash count variance calculation (UI, supervisor)', () => {
  test.use({ storageState: path.join(__dirname, 'fixtures', 'supervisor.auth.json') });

  test('closing short of expected cash requires a >=50-char explanation before it can be flagged for review', async ({ page }) => {
    await page.goto('/shift/open');
    await page.getByLabel('Quantity of ₱500.00 bills or coins').fill('1');
    await page.getByRole('button', { name: 'Open Shift' }).click();
    await page.waitForURL('**/shift');

    await page.goto('/shift/close');
    await expect(page.getByText('₱500.00').first()).toBeVisible(); // Expected Cash, zero sales this shift

    // Count ₱50.00 short — outside VARIANCE_TOLERANCE (0), triggers the
    // review-flag card and the minimum-length explanation gate.
    await page.getByLabel('Quantity of ₱200.00 bills or coins').fill('2');
    await page.getByLabel('Quantity of ₱50.00 bills or coins').fill('1');

    await expect(page.getByText('flagged for review')).toBeVisible();
    const closeButton = page.getByRole('button', { name: 'Close Shift' });
    await expect(closeButton).toBeDisabled();

    await page.getByLabel(/Explain the variance/).fill('Drawer was short — cashier reported dropping and losing a fifty-peso bill during rush.');
    await expect(closeButton).toBeEnabled();
    await closeButton.click();

    await page.waitForURL('**/shift');
    await expect(page.getByRole('heading', { name: 'No active shift' })).toBeVisible();
  });
});

test('variance approval — API only, no admin UI exists for this yet', async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const supervisor = await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password);
  const shifts = await authedGet<{ shifts: ShiftApi[] }>(
    request,
    `/api/cash?branch_id=${branchId}&status=flagged&limit=1`,
    supervisor.accessToken,
  );
  const flagged = shifts.data?.shifts[0];
  if (!flagged) throw new Error('No flagged shift found — expected the previous test to have created one');
  flaggedShiftId = flagged.id;
  expect(flagged.variance_approved).toBeNull();

  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const approval = await authedPost<ShiftApi>(request, url, `/api/cash/${flaggedShiftId}/approve-variance`, admin.accessToken, {
    approved: true,
    notes: 'Verified against cashier statement — approved.',
  });

  expect(approval.status).toBe(200);
  expect(approval.data?.status).toBe('closed');
  expect(approval.data?.variance_approved).toBe(true);
});

test('cashier handover detection — API only, closing another supervisor\'s shift is rejected', async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const supervisor1 = await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password);

  const opened = await authedPost<ShiftApi>(request, url, '/api/cash/open', supervisor1.accessToken, {
    branch_id: branchId,
    cashier_id: supervisor1.userId,
    starting_cash: 200,
    denominations: [{ denomination: 200, quantity: 1 }],
  });
  expect(opened.status).toBe(201);
  const shiftId = opened.data?.id;
  if (!shiftId) throw new Error('Shift open failed — no id in response');

  const supervisor2 = await apiLogin(request, SECOND_SUPERVISOR.email, SECOND_SUPERVISOR.password);
  const closeAttempt = await authedPost(request, url, `/api/cash/${shiftId}/close`, supervisor2.accessToken, {
    denominations: [{ denomination: 200, quantity: 1 }],
  });

  expect(closeAttempt.status).toBe(403);
  expect(closeAttempt.error).toMatchObject({ code: 'SHIFT_UNAUTHORIZED_CLOSE' });

  // Cleanup — close it as the supervisor who actually opened it, so this
  // spec doesn't leave a dangling active shift for other spec files.
  const cleanup = await authedPost(request, url, `/api/cash/${shiftId}/close`, supervisor1.accessToken, {
    denominations: [{ denomination: 200, quantity: 1 }],
  });
  expect(cleanup.status).toBe(200);
});
