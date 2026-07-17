// AUTHORED, NOT EXECUTED: no local Postgres/Redis instance is available in
// the environment this was written in (see phase-19-debt.md) — never run
// against a live app. Flow taken from reading the real implementation
// (hooks/use-offline.ts, lib/offline/sync-queue.ts, terminal/page.tsx's
// offline branch of handleCharge), not guessed.
//
// New file — "offline processing + reconnect sync" is named explicitly in
// master-execution-plan.md's Testing Strategy section but had no spec file
// at all. Self-contained: seeds its own product and shift (via API) rather
// than depending on pos-workflow.spec.ts's fixtures/state, since Playwright
// doesn't guarantee cross-file execution order.
//
// Mechanism: use-offline.ts listens for the browser's native 'online'/
// 'offline' events and triggers syncOfflineTransactions() on 'online'.
// Playwright's BrowserContext.setOffline() toggles navigator.onLine and
// fires those same events in Chromium, which is what this test relies on —
// this is standard, documented Playwright behavior, not a guess, but has
// still never been run here.
//
// Phase 20 Task 4: syncOfflineTransactions() now POSTs the whole queued
// batch to POST /api/transactions/sync-offline in one call instead of
// looping per transaction — this spec is black-box (UI state only, no
// network assertions) so that change doesn't require any edits here.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedGet, authedPost } from './fixtures/api-helpers';

const OFFLINE_PRODUCT = { name: 'E2E Offline Item', variantName: 'Standard', price: 40.0 };

let branchId: string;
let shiftId: string;

test.beforeAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);

  const branches = await authedGet<{ branches: { id: string; code: string }[] }>(request, '/api/branches', admin.accessToken);
  const branch = branches.data?.branches.find((b) => b.code === 'MAIN01');
  if (!branch) throw new Error('Seeded "Main Branch" (MAIN01) not found — run apps/api/prisma/seed.ts first');
  branchId = branch.id;

  const product = await authedPost<{ id: string }>(request, url, '/api/products', admin.accessToken, {
    name: OFFLINE_PRODUCT.name,
    status: 'active',
    category: 'E2E',
    branch_exclusive: false,
  });
  if (!product.data?.id) throw new Error(`Failed to create offline test product: ${JSON.stringify(product.error)}`);
  await authedPost(request, url, `/api/products/${product.data.id}/variants`, admin.accessToken, {
    name: OFFLINE_PRODUCT.variantName,
    size_label: 'Regular',
    base_price: OFFLINE_PRODUCT.price,
  });

  const supervisor = await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password);
  const shift = await authedPost<{ id: string }>(request, url, '/api/cash/open', supervisor.accessToken, {
    branch_id: branchId,
    cashier_id: supervisor.userId,
    starting_cash: 500,
    denominations: [{ denomination: 500, quantity: 1 }],
  });
  if (!shift.data?.id) throw new Error(`Failed to open shift for offline test: ${JSON.stringify(shift.error)}`);
  shiftId = shift.data.id;
});

test.afterAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const supervisor = await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password);
  // Whatever cash sales the offline sync landed get counted into the
  // expected close amount server-side — closing with the same ₱500 opening
  // count plus the synced sale would mismatch, and this cleanup doesn't
  // need to be variance-free, just needs to not block other spec files. A
  // deliberately generous count avoids a second flagged-shift side effect.
  await authedPost(request, url, `/api/cash/${shiftId}/close`, supervisor.accessToken, {
    denominations: [{ denomination: 500, quantity: 10 }],
    variance_explanation: 'E2E offline-sync spec cleanup — count is intentionally approximate, not a real variance investigation.',
  });
});

test.describe('offline transaction processing + reconnect sync (staff)', () => {
  test.use({ storageState: path.join(__dirname, 'fixtures', 'staff.auth.json') });

  test('a transaction charged while offline is queued locally, then synced automatically on reconnect', async ({ page, request }) => {
    // Load the terminal while online first — TanStack Query caches the
    // product catalog and current-shift lookup, and terminal/page.tsx's own
    // useEffect populates the Dexie offline cache from that live fetch
    // (cacheProductCatalog/cacheBranchPriceOverrides). Charging while
    // offline depends on this cache already being warm.
    await page.goto('/terminal');
    await expect(page.getByText(OFFLINE_PRODUCT.name)).toBeVisible();

    await page.context().setOffline(true);
    await expect(page.getByText('Offline — sales will be queued and synced automatically once you reconnect.')).toBeVisible();

    await page.locator('.cursor-pointer').filter({ hasText: OFFLINE_PRODUCT.variantName }).filter({ hasText: '₱40.00' }).first().click();
    await page.getByPlaceholder('Cash tendered').fill('40');
    await page.getByRole('button', { name: /Charge ₱40\.00/ }).click();

    await expect(page.getByText('Sale queued for sync')).toBeVisible();
    const provisionalIdText = await page.getByText(/Provisional ID: PC-/).textContent();
    expect(provisionalIdText).toContain('OFFLINE');
    await page.getByRole('button', { name: 'Done' }).click();

    // components/pos/pos-header.tsx renders useOffline()'s pendingSyncCount
    // as a "N pending" badge next to the Online/Offline indicator — visible
    // proof the transaction is queued, before reconnecting.
    await expect(page.getByText('1 pending')).toBeVisible();

    await page.context().setOffline(false);
    // syncOfflineTransactions() runs off the browser's 'online' event
    // handler and clears pendingSyncCount back to 0 once the sync
    // succeeds — "1 pending" disappearing is a real, UI-driven completion
    // signal (pendingSyncCount is derived straight from Dexie's
    // syncedAt === null filter, which only flips on a successful API
    // response), not just an absence of visible failure.
    await expect(page.getByText('1 pending')).not.toBeVisible({ timeout: 15_000 });

    // Independent server-side confirmation that the transaction actually
    // landed, not just that the local queue believes it did.
    // page.request can't be used here — it shares the page's cookies, but
    // authenticate.ts requires an Authorization: Bearer header, which lives
    // only in the page's in-memory Zustand store, not exposed to Playwright.
    // A fresh API-level login gets an independent, usable token instead.
    const supervisor = await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password);
    await expect
      .poll(
        async () => {
          // branchGuard (transactions.router.ts's GET /) requires branch_id
          // in the query for a non-super_admin caller — shift_id alone
          // isn't enough to satisfy it.
          const res = await authedGet<{ transactions: { total_amount: number }[] }>(
            request,
            `/api/transactions?branch_id=${branchId}&shift_id=${shiftId}&limit=50`,
            supervisor.accessToken,
          );
          return res.data?.transactions.some((t) => t.total_amount === 40) ?? false;
        },
        { timeout: 15_000, message: 'offline transaction did not sync within 15s of reconnecting' },
      )
      .toBe(true);
  });
});
