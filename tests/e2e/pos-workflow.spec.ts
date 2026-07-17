// AUTHORED, NOT EXECUTED: no local Postgres/Redis instance is available in
// the environment this was written in (see phase-19-debt.md), so this spec
// has never actually been run against a live app. Selectors and flow were
// taken from reading the real components (terminal/page.tsx, shift/open/
// page.tsx, shift/close/page.tsx, denomination-table.tsx, receipt-modal.tsx)
// and the real API contracts (transactions/cash routers) rather than
// guessed — but full execution against seeded infra is still required
// before this can be trusted as a passing regression check.
//
// RBAC note: POST /api/cash/open and /:shiftId/close are adminOrSupervisor-
// only (cash.router.ts) — staff cannot open or close their own shift. The
// flow below is therefore: supervisor opens the shift, staff processes
// transactions against it, supervisor closes it. This matches the actual
// seeded role assignments (apps/api/prisma/seed.ts: only supervisor and
// staff are assigned to the seeded branch; both share the same branch).
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { CATALOG_FIXTURE, seedCatalog } from './fixtures/seed-catalog';
import { apiLogin, authedGet, authedPost } from './fixtures/api-helpers';
import { TEST_USERS } from './fixtures/test-users';

let branchId: string;

test.beforeAll(async ({ request, baseURL }) => {
  const result = await seedCatalog(request, baseURL ?? 'http://localhost:3000');
  branchId = result.branchId;
});

async function addItemToCart(page: Page, variantName: string, priceText: string): Promise<void> {
  await page.locator('.cursor-pointer').filter({ hasText: variantName }).filter({ hasText: priceText }).first().click();
}

async function fillDenomination(page: Page, denominationLabel: string, quantity: number): Promise<void> {
  await page.getByLabel(`Quantity of ${denominationLabel} bills or coins`).fill(String(quantity));
}

test.describe('shift open (supervisor)', () => {
  test.use({ storageState: path.join(__dirname, 'fixtures', 'supervisor.auth.json') });

  test('supervisor opens a shift with a ₱1000.00 starting cash count', async ({ page }) => {
    await page.goto('/shift/open');

    // cashier_id defaults to the logged-in user (react-hook-form
    // defaultValues) — the "(me)" option is pre-selected, no interaction
    // needed before filling the cash count.
    await fillDenomination(page, '₱1000.00', 1);

    await page.getByRole('button', { name: 'Open Shift' }).click();
    await page.waitForURL('**/shift');

    await expect(page.getByRole('heading', { name: 'Current Shift' })).toBeVisible();
    await expect(page.getByText('₱1000.00')).toBeVisible(); // Starting Cash figure
  });
});

test.describe('process transaction — cash payment (staff)', () => {
  test.use({ storageState: path.join(__dirname, 'fixtures', 'staff.auth.json') });

  test('staff charges the Classic item (₱56.00) with exact cash and no discount', async ({ page }) => {
    await page.goto('/terminal');

    await addItemToCart(page, CATALOG_FIXTURE.classicVariantName, '₱56.00');

    await expect(page.getByText('₱56.00', { exact: true })).toBeVisible(); // subtotal line, no discount applied

    const cashInput = page.getByPlaceholder('Cash tendered');
    await cashInput.fill('56');

    const chargeButton = page.getByRole('button', { name: /Charge ₱56\.00/ });
    await expect(chargeButton).toBeEnabled();
    await chargeButton.click();

    await expect(page.getByRole('heading', { name: 'Receipt' })).toBeVisible();
    await expect(page.getByText('Change')).toBeVisible();
    await expect(page.getByText('₱0.00').first()).toBeVisible(); // exact tender → zero change

    await page.getByRole('button', { name: 'Done' }).click();
  });
});

test.describe('process transaction — PWD discount + VAT verification (staff)', () => {
  test.use({ storageState: path.join(__dirname, 'fixtures', 'staff.auth.json') });

  test('PWD discount on the Deluxe item (₱112.00) matches the locked VAT formula, paid via GCash', async ({ page }) => {
    await page.goto('/terminal');

    await addItemToCart(page, CATALOG_FIXTURE.deluxeVariantName, '₱112.00');

    // Select "PWD (20%)" from the discount dropdown.
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'PWD (20%)' }).click();

    await page.getByPlaceholder('PWD / Senior Citizen ID number').fill('PWD-E2E-0001');

    // CLAUDE.md's locked VAT formula, applied to a ₱112.00 VAT-inclusive
    // subtotal: vatable base = 112 / 1.12 = 100.00; discount = 100 * 0.20 =
    // 20.00; discounted base = 80.00; VAT = 80 * 0.12 = 9.60; total = 89.60.
    await expect(page.getByText('-₱20.00')).toBeVisible(); // discount line
    await expect(page.getByText('₱9.60')).toBeVisible(); // VAT line
    await expect(page.getByRole('button', { name: /Charge ₱89\.60/ })).toBeVisible();

    // Pay via GCash so this transaction doesn't touch the cash drawer —
    // keeps the shift-close variance check in the next describe block
    // arithmetically simple (see fixtures/seed-catalog.ts's header comment).
    await page.getByRole('tab', { name: 'GCash' }).click();
    await page.getByPlaceholder('GCash reference number').fill('GCASHE2E01');
    await page.getByText('I manually verified this GCash payment').click();

    const chargeButton = page.getByRole('button', { name: /Charge ₱89\.60/ });
    await expect(chargeButton).toBeEnabled();
    await chargeButton.click();

    await expect(page.getByRole('heading', { name: 'Receipt' })).toBeVisible();
    await expect(page.getByText('Discount (pwd)')).toBeVisible();
    await expect(page.getByText('-₱20.00')).toBeVisible();

    await page.getByRole('button', { name: 'Done' }).click();
  });
});

// API-level, not page-driven: Phase 20 Task 2 only implements the hold-order
// backend (architecture doc §Part 8) — no "Hold" button exists yet anywhere
// in the terminal UI (that's frontend scope, not part of this task's file
// list), so the lifecycle is exercised directly against the API instead of
// through page interactions, the same way seed-catalog.ts's own admin setup
// calls do. Runs after the "shift open" block above and before "shift
// close" below so it reuses that same still-active shift — holding/
// releasing an order creates no Transaction row and touches no cash total,
// so it cannot perturb the ₱1056.00 variance math the shift-close test
// asserts against.
test.describe('hold order lifecycle (staff, API-level)', () => {
  let staffAccessToken: string;
  let shiftId: string;
  let productId: string;
  let variantId: string;

  test.beforeAll(async ({ request, baseURL }) => {
    const staff = await apiLogin(request, TEST_USERS.staff.email, TEST_USERS.staff.password);
    staffAccessToken = staff.accessToken;

    const shiftRes = await authedGet<{ id: string } | null>(request, `/api/cash/current?branch_id=${branchId}`, staffAccessToken);
    if (!shiftRes.data) {
      throw new Error('No active shift found — expected the shift opened by the "shift open (supervisor)" describe block above to still be active.');
    }
    shiftId = shiftRes.data.id;

    const catalogRes = await authedGet<{ products: { id: string; name: string; variants: { id: string; name: string }[] }[] }>(
      request,
      `/api/products/catalog?branch_id=${branchId}`,
      staffAccessToken,
    );
    const product = catalogRes.data?.products.find((p) => p.name === CATALOG_FIXTURE.productName);
    const variant = product?.variants.find((v) => v.name === CATALOG_FIXTURE.classicVariantName);
    if (!product || !variant) {
      throw new Error('Classic variant not found in POS catalog — expected seed-catalog.ts fixture products to be present.');
    }
    productId = product.id;
    variantId = variant.id;
  });

  test('staff holds an order, sees it in the active list for this terminal, then releases it', async ({ request, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';
    const holdRes = await authedPost<{ id: string; status: string }>(request, url, '/api/transactions/hold', staffAccessToken, {
      branch_id: branchId,
      shift_id: shiftId,
      items: [{ product_id: productId, product_variant_id: variantId, quantity: 1 }],
    });
    expect(holdRes.status).toBe(201);
    expect(holdRes.data?.status).toBe('held');

    const listRes = await authedGet<{ hold_orders: { id: string }[] }>(request, `/api/transactions/hold?shift_id=${shiftId}`, staffAccessToken);
    expect(listRes.data?.hold_orders.map((h) => h.id)).toContain(holdRes.data?.id);

    const releaseRes = await authedPost<{ status: string }>(
      request,
      url,
      `/api/transactions/hold/${holdRes.data?.id}/release`,
      staffAccessToken,
      {},
    );
    expect(releaseRes.status).toBe(200);
    expect(releaseRes.data?.status).toBe('released');

    // Released orders drop out of the active list (architecture doc: only
    // held orders count toward the 3-per-terminal cap and appear as active).
    const listAfterRelease = await authedGet<{ hold_orders: { id: string }[] }>(
      request,
      `/api/transactions/hold?shift_id=${shiftId}`,
      staffAccessToken,
    );
    expect(listAfterRelease.data?.hold_orders.map((h) => h.id)).not.toContain(holdRes.data?.id);
  });

  test('enforces the max-3-held-orders-per-terminal limit (architecture doc §Part 8)', async ({ request, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';
    const item = { product_id: productId, product_variant_id: variantId, quantity: 1 };
    const heldIds: string[] = [];

    for (let i = 0; i < 3; i++) {
      const res = await authedPost<{ id: string }>(request, url, '/api/transactions/hold', staffAccessToken, {
        branch_id: branchId,
        shift_id: shiftId,
        items: [item],
      });
      expect(res.status).toBe(201);
      heldIds.push(res.data!.id);
    }

    const fourth = await authedPost<{ id: string }>(request, url, '/api/transactions/hold', staffAccessToken, {
      branch_id: branchId,
      shift_id: shiftId,
      items: [item],
    });
    expect(fourth.status).toBe(409);
    expect((fourth.error as { code?: string } | null)?.code).toBe('HOLD_ORDER_LIMIT_REACHED');

    // Release all three so no held orders are left dangling for the rest of the spec run.
    for (const id of heldIds) {
      await authedPost(request, url, `/api/transactions/hold/${id}/release`, staffAccessToken, {});
    }
  });
});

test.describe('shift close (supervisor)', () => {
  test.use({ storageState: path.join(__dirname, 'fixtures', 'supervisor.auth.json') });

  test('supervisor closes the shift with zero variance', async ({ page }) => {
    await page.goto('/shift/close');

    // Expected cash = ₱1000.00 opening + ₱56.00 cash sale (the PWD/GCash
    // transaction never touched the drawer) = ₱1056.00.
    await expect(page.getByText('₱1056.00').first()).toBeVisible();

    await fillDenomination(page, '₱1000.00', 1);
    await fillDenomination(page, '₱1.00', 56);

    // Zero variance — the "flagged for review" card must not appear, and
    // the explanation textarea (only rendered when outside tolerance)
    // must not be required to submit.
    await expect(page.getByText('flagged for review')).not.toBeVisible();

    await page.getByRole('button', { name: 'Close Shift' }).click();
    await page.waitForURL('**/shift');

    await expect(page.getByRole('heading', { name: 'No active shift' })).toBeVisible();
  });
});
