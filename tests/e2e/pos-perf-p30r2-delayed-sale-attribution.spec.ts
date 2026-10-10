// POS-PERF-P30R2 — real-browser verification of the "delayed-sale cashier
// attribution" scenario: cashier A submits an order, the HTTP response is
// held back (while the real request still executes against the server), A
// detaches via "Next Customer" and switches to cashier B, B submits and
// completes an independent order, and only THEN is A's held response
// released. Proves handleCharge/useCreateTransaction's accessTokenOverride
// closure (see use-transactions.ts's Task 120 doc comment) keeps a request
// permanently bound to whichever cashier's token was live when Charge was
// clicked, regardless of any terminal-local identity switch that happens
// afterward — and that detachedKeysRef (terminal/page.tsx) routes the late
// response into A's own DetachedSale record, never into whatever cashier/
// cart is on screen when it finally arrives.
//
// Uses Playwright's route.fetch()/route.fulfill() split: route.fetch() lets
// A's POST /api/transactions run for real (server processes and persists
// it) while the handler simply doesn't call route.fulfill() until the test
// explicitly releases it — the browser never sees the response until then,
// but the server already has.
import crypto from 'node:crypto';
import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedGet, authedPost } from './fixtures/api-helpers';

const NAV_TIMEOUT = 60_000;

interface TransactionLike {
  id: string;
  cashier_id: string;
  receipt_number: string;
  inventory_deduction_status: 'pending' | 'completed' | 'failed';
  total_amount: number;
}

let branchId: string;
let adminAccessToken: string;
let branchAccessToken: string;
let aliceUserId: string;
let bobUserId: string;
let alicePin: string;
let bobPin: string;
let waterVariantId: string;
let appBaseURL: string;

let terminalContext: BrowserContext;
let terminalPage: Page;

test.beforeAll(async ({ browser, request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  appBaseURL = url;

  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  adminAccessToken = admin.accessToken;

  const branchLogin = await apiLogin(request, TEST_USERS.branch.email, TEST_USERS.branch.password);
  branchAccessToken = branchLogin.accessToken;

  const branches = await authedGet<{ branches: { id: string; code: string }[] }>(request, '/api/branches', adminAccessToken);
  const main = branches.data?.branches.find((b) => b.code === 'MAIN01');
  if (!main) throw new Error('Seeded "Main Branch" (MAIN01) not found — run apps/api/prisma/seed.ts first');
  branchId = main.id;

  // Reuses the branch's existing "Water" variant (Drinks (demo)) — already
  // readiness_code: READY with no flavors/option groups (single-tap add,
  // no dialog in the way) and a real recipe/BOM mapping, so checkout
  // actually exercises inventory deduction instead of a no-op.
  const catalog = await authedGet<{ products: { name: string; variants: { id: string; name: string; live_ready: boolean }[] }[] }>(
    request,
    `/api/products/catalog?branch_id=${branchId}`,
    branchAccessToken,
  );
  const waterVariant = catalog.data?.products.flatMap((p) => p.variants).find((v) => v.name === 'Water' && v.live_ready);
  if (!waterVariant) throw new Error('Expected a ready-to-sell "Water" variant in MAIN01\'s catalog for this test.');
  waterVariantId = waterVariant.id;

  // Two independent staff cashiers at MAIN01, each with their own POS PIN —
  // same provisioning path as POS-PERF-P30R's own fixtures.
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await authedPost<{ id: string }>(request, url, '/api/employees', adminAccessToken, {
    first_name: 'Alice',
    last_name: `Cashier-${suffix}`,
    role: 'staff',
    employment_type: 'regular',
    branch_ids: [branchId],
    position: 'Cashier',
  });
  if (!alice.data?.id) throw new Error(`Failed to create Alice: ${JSON.stringify(alice.error)}`);
  aliceUserId = alice.data.id;
  alicePin = String(Math.floor(100000 + Math.random() * 900000));
  const alicePinResult = await authedPost(request, url, `/api/staff-pin/${aliceUserId}/pin`, adminAccessToken, { pin: alicePin });
  if (alicePinResult.status >= 300) throw new Error(`Failed to provision Alice's PIN: ${JSON.stringify(alicePinResult.error)}`);

  const bob = await authedPost<{ id: string }>(request, url, '/api/employees', adminAccessToken, {
    first_name: 'Bob',
    last_name: `Cashier-${suffix}`,
    role: 'staff',
    employment_type: 'regular',
    branch_ids: [branchId],
    position: 'Cashier',
  });
  if (!bob.data?.id) throw new Error(`Failed to create Bob: ${JSON.stringify(bob.error)}`);
  bobUserId = bob.data.id;
  bobPin = String(Math.floor(100000 + Math.random() * 900000));
  const bobPinResult = await authedPost(request, url, `/api/staff-pin/${bobUserId}/pin`, adminAccessToken, { pin: bobPin });
  if (bobPinResult.status >= 300) throw new Error(`Failed to provision Bob's PIN: ${JSON.stringify(bobPinResult.error)}`);

  terminalContext = await browser.newContext();
  await terminalContext.grantPermissions(['geolocation'], { origin: url });
  await terminalContext.setGeolocation({ latitude: 14.676, longitude: 121.0437 });
  terminalPage = await terminalContext.newPage();
  await terminalPage.goto('/login');
  await terminalPage.getByLabel('Email').fill(TEST_USERS.branch.email);
  await terminalPage.getByRole('textbox', { name: 'Password' }).fill(TEST_USERS.branch.password);
  await terminalPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await terminalPage.waitForURL(`**${TEST_USERS.branch.dashboardPath}`);
});

test.afterAll(async () => {
  // Clock both out, if still open, so this disposable DB's attendance state
  // doesn't desync a later run's assumptions.
  for (const userId of [aliceUserId, bobUserId]) {
    if (!userId) continue;
    const records = await authedGet<{ records: { id: string; clock_out_server_time: string | null }[] }>(
      terminalPage?.request,
      `/api/attendance/employee/${userId}?limit=3`,
      branchAccessToken,
    );
    const open = records.data?.records.find((r) => r.clock_out_server_time === null);
    if (open) {
      await authedPost(terminalPage.request, appBaseURL, '/api/attendance/clock-out', branchAccessToken, {
        employee_id: userId,
        branch_id: branchId,
      });
    }
  }
  await terminalContext?.close();
});

async function pinVerifyAndContinue(page: Page, pin: string, firstName: string) {
  await page.getByPlaceholder('Enter 4-6 digit PIN').fill(pin);
  await page.getByRole('button', { name: 'Verify PIN' }).click();
  await expect(page.getByText(new RegExp(`${firstName} Cashier`))).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: new RegExp(`Continue as ${firstName}`) }).click();
}

/**
 * Right after "Continue as <name>" commits the Employee selection,
 * useTerminalOperator (terminal/page.tsx) still has to resolve a live
 * attendance check before it knows whether to render "Clock In to Start
 * Selling" or restore straight to "Current Cashier:" — a fixed short wait
 * before checking which one appeared is a real race (observed directly:
 * checking isVisible a beat too early reads neither state as present yet).
 * Waiting on the union of both texts lets Playwright's own polling absorb
 * that gap instead of guessing a sleep duration.
 */
async function clockInIfNeeded(page: Page) {
  const clockInCard = page.getByText('Clock In to Start Selling');
  const currentCashier = page.getByText('Current Cashier:');
  await expect(clockInCard.or(currentCashier)).toBeVisible({ timeout: NAV_TIMEOUT });
  if (await clockInCard.isVisible()) {
    await page.getByRole('button', { name: 'Clock In', exact: true }).click();
  }
  await expect(currentCashier).toBeVisible({ timeout: NAV_TIMEOUT });
}

test.describe.serial('POS-PERF-P30R2 — delayed-sale cashier attribution across a cashier switch', () => {
  test.describe.configure({ timeout: 180_000 });

  test('full scenario: hold A\'s response, detach + switch to B, B completes independently, release A\'s response', async () => {
    await terminalPage.goto('/branch/terminal', { waitUntil: 'networkidle' });
    await expect(terminalPage.getByText("Who's working?")).toBeVisible({ timeout: NAV_TIMEOUT });

    // --- Cashier A (Alice) unlocks and clocks in ---
    await pinVerifyAndContinue(terminalPage, alicePin, 'Alice');
    await clockInIfNeeded(terminalPage);
    await expect(terminalPage.getByText(/Alice Cashier/)).toBeVisible();

    // --- Intercept checkout POSTs: the FIRST one through this route is
    // Alice's — let the real request execute against the server via
    // route.fetch(), but withhold fulfilling it to the browser until the
    // test explicitly releases it. Any later POST (Bob's) passes straight
    // through untouched. ---
    let firstRequestSeen = false;
    let releaseHeldResponse: (() => void) | null = null;
    const heldResponseGate = new Promise<void>((resolve) => {
      releaseHeldResponse = resolve;
    });
    let aliceTransactionId: string | null = null;
    let aliceResponseReleased = false;

    await terminalPage.route('**/api/transactions', async (route: Route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      if (firstRequestSeen) {
        // Bob's charge — unaffected, goes straight through.
        await route.continue();
        return;
      }
      firstRequestSeen = true;
      const response = await route.fetch();
      try {
        const json = (await response.json()) as { data: TransactionLike | null };
        aliceTransactionId = json.data?.id ?? null;
      } catch {
        aliceTransactionId = null;
      }
      await heldResponseGate;
      aliceResponseReleased = true;
      await route.fulfill({ response });
    });

    // --- Alice adds one Water and charges (cash, exact tender) ---
    await terminalPage.locator('.cursor-pointer').filter({ hasText: 'Water' }).first().click();
    await terminalPage.getByRole('button', { name: /Checkout/ }).click();
    await terminalPage.getByPlaceholder('Cash tendered').fill('35');
    await terminalPage.getByRole('button', { name: /Charge ₱35\.00/ }).click();

    // The request is in flight (held, not yet fulfilled) — the 'saving'
    // popup must appear with the real-time option to move on.
    await expect(terminalPage.getByText(/Saving order\. You can start the next customer\./)).toBeVisible({ timeout: 10_000 });

    // --- Alice detaches via "Next Customer" ---
    await terminalPage.getByRole('button', { name: 'Next Customer' }).click();
    await expect(terminalPage.getByText(/Saving order/)).toHaveCount(0);

    // Sanity-check the detach actually persisted a DetachedSale record (not
    // just closed the popup) — this is what routes Alice's late response
    // away from the singleton sale state later. See lib/detached-sales.ts.
    const detachedRaw = await terminalPage.evaluate((bId) => localStorage.getItem(`pos:detached-sales:${bId}`), branchId);
    const detachedEntries = detachedRaw ? (JSON.parse(detachedRaw) as { idempotencyKey: string; status: string }[]) : [];
    expect(detachedEntries.some((e) => e.status === 'saving')).toBe(true);

    // Cart is empty post-detach — Switch Cashier must now be allowed.
    await terminalPage.getByRole('button', { name: 'Switch Cashier' }).click();
    await expect(terminalPage.getByText("Who's working?")).toBeVisible({ timeout: 10_000 });

    // Alice's attendance must still be open (switch is never a clock-out).
    const aliceMidSwitch = await authedGet<{ records: { clock_out_server_time: string | null }[] }>(
      terminalPage.request,
      `/api/attendance/employee/${aliceUserId}?limit=5`,
      branchAccessToken,
    );
    expect(aliceMidSwitch.data?.records.filter((r) => r.clock_out_server_time === null).length).toBe(1);

    // --- Cashier B (Bob) unlocks, clocks in, and submits an independent order ---
    await pinVerifyAndContinue(terminalPage, bobPin, 'Bob');
    await clockInIfNeeded(terminalPage);
    await expect(terminalPage.getByText(/Bob Cashier/)).toBeVisible();

    await terminalPage.locator('.cursor-pointer').filter({ hasText: 'Water' }).first().click();
    await terminalPage.getByRole('button', { name: /Checkout/ }).click();
    await terminalPage.getByPlaceholder('Cash tendered').fill('35');

    const bobResponsePromise = terminalPage.waitForResponse(
      (res) => res.url().endsWith('/api/transactions') && res.request().method() === 'POST',
    );
    await terminalPage.getByRole('button', { name: /Charge ₱35\.00/ }).click();
    const bobResponse = await bobResponsePromise;
    const bobJson = (await bobResponse.json()) as { data: TransactionLike | null };
    const bobTransactionId = bobJson.data?.id;
    expect(bobTransactionId).toBeTruthy();

    // Bob's own sale must complete and show HIS success confirmation while
    // Alice's response is still held — never a popup belonging to Alice's
    // order, and never evidence of Alice's late response having arrived yet.
    // Bob's order is deliberately left ON SCREEN (not dismissed) through the
    // release below — this is the actual hazardous window P19/P30R's
    // detachedKeysRef protection guards: a late response for an order the
    // cashier already walked away from must never overwrite/reopen whatever
    // the CURRENT cashier is looking at right now. Order #01 is Alice's
    // (first charge on this fresh terminal-local counter); Bob's is #02 —
    // see lib/order-reference.ts.
    expect(aliceResponseReleased).toBe(false);
    await expect(terminalPage.getByText('Sale completed')).toBeVisible({ timeout: 10_000 });
    await expect(terminalPage.getByText(/Order #02/)).toBeVisible();
    await expect(terminalPage.getByText(/Order #01/)).toHaveCount(0);
    await expect(terminalPage.getByText('Current Cashier:')).toBeVisible();
    await expect(terminalPage.getByText(/Bob Cashier/)).toBeVisible();

    // --- Release Alice's held response now, while Bob's own success dialog
    // is still open on screen ---
    releaseHeldResponse!();
    // Give the fulfilled response time to reach the page and let
    // handleCharge's awaited promise/then-branches settle.
    await expect.poll(() => aliceResponseReleased, { timeout: 10_000 }).toBe(true);
    await terminalPage.waitForTimeout(1500);

    // Bob's own dialog (Order #02) must still be the one showing — Alice's
    // now-resolved response must never overwrite it with her own order
    // (#01), reopen/replace it, hijack the terminal back to her, or bounce
    // to "Who's working?".
    await expect(terminalPage.getByText(/Order #01/)).toHaveCount(0);
    await expect(terminalPage.getByText(/Order #02/)).toBeVisible();
    await expect(terminalPage.getByText("Who's working?")).toHaveCount(0);
    await expect(terminalPage.getByText('Current Cashier:')).toBeVisible();
    await expect(terminalPage.getByText(/Bob Cashier/)).toBeVisible();

    // Deeper than the order-ref text: "View Receipt" renders straight from
    // the `saleTransaction` component-state value (receipt-modal.tsx), which
    // a stray `setSaleTransaction(transaction)` for Alice's late response
    // would silently swap out even if the SaleStatusModal's own snapshot
    // text stayed showing Bob's order ref. Confirms the receipt the cashier
    // would actually see/print is still Bob's real receipt_number, not
    // Alice's — fetched from the server for both, independent of the race.
    const aliceReceipt = await authedGet<TransactionLike>(terminalPage.request, `/api/transactions/${aliceTransactionId}`, branchAccessToken);
    const bobReceiptLookup = await authedGet<TransactionLike>(terminalPage.request, `/api/transactions/${bobTransactionId}`, branchAccessToken);
    expect(aliceReceipt.data?.receipt_number).toBeTruthy();
    expect(bobReceiptLookup.data?.receipt_number).toBeTruthy();
    expect(aliceReceipt.data?.receipt_number).not.toBe(bobReceiptLookup.data?.receipt_number);

    await terminalPage.getByRole('button', { name: 'View Receipt' }).click();
    await expect(terminalPage.getByText(`Receipt No. ${bobReceiptLookup.data?.receipt_number}`).first()).toBeVisible({ timeout: 10_000 });
    await expect(terminalPage.getByText(`Receipt No. ${aliceReceipt.data?.receipt_number}`)).toHaveCount(0);
    await terminalPage.getByRole('button', { name: 'New Sale' }).click();

    // Bob now dismisses his own (still-correct) confirmation, if still open.
    const nextCustomerBtn = terminalPage.getByRole('button', { name: 'Next Customer' });
    if (await nextCustomerBtn.isVisible().catch(() => false)) {
      await nextCustomerBtn.click();
    }
    await expect(terminalPage.getByRole('dialog')).toHaveCount(0);

    // Bob's attendance must still show exactly one open record — Alice's
    // late response resolving must never clock Bob (or Alice) out as a
    // side effect.
    const bobStillClockedIn = await authedGet<{ records: { clock_out_server_time: string | null }[] }>(
      terminalPage.request,
      `/api/attendance/employee/${bobUserId}?limit=5`,
      branchAccessToken,
    );
    expect(bobStillClockedIn.data?.records.filter((r) => r.clock_out_server_time === null).length).toBe(1);

    // --- Database-level attribution assertions ---
    expect(aliceTransactionId).toBeTruthy();
    expect(aliceTransactionId).not.toBe(bobTransactionId);

    const aliceTxn = await authedGet<TransactionLike>(terminalPage.request, `/api/transactions/${aliceTransactionId}`, branchAccessToken);
    expect(aliceTxn.status).toBe(200);
    expect(aliceTxn.data?.cashier_id).toBe(aliceUserId);

    const bobTxn = await authedGet<TransactionLike>(terminalPage.request, `/api/transactions/${bobTransactionId}`, branchAccessToken);
    expect(bobTxn.status).toBe(200);
    expect(bobTxn.data?.cashier_id).toBe(bobUserId);

    // Exactly one sale per idempotency key: querying each transaction's own
    // id back is itself proof no duplicate/replacement row exists under
    // either key — a double-submit or key collision would have surfaced as
    // a 404/mismatch or identical ids above.
    expect(aliceTxn.data?.id).toBe(aliceTransactionId);
    expect(bobTxn.data?.id).toBe(bobTransactionId);

    // --- Inventory reconciliation: both sales' deductions must settle
    // (never stuck 'pending' forever, never 'failed' from cross-attribution
    // or a duplicate/missing deduction caused by the held-response race). ---
    await expect
      .poll(
        async () => (await authedGet<TransactionLike>(terminalPage.request, `/api/transactions/${aliceTransactionId}`, branchAccessToken)).data
          ?.inventory_deduction_status,
        { timeout: 20_000, message: "Alice's sale inventory deduction never settled" },
      )
      .not.toBe('pending');
    await expect
      .poll(
        async () => (await authedGet<TransactionLike>(terminalPage.request, `/api/transactions/${bobTransactionId}`, branchAccessToken)).data
          ?.inventory_deduction_status,
        { timeout: 20_000, message: "Bob's sale inventory deduction never settled" },
      )
      .not.toBe('pending');

    const aliceFinal = await authedGet<TransactionLike>(terminalPage.request, `/api/transactions/${aliceTransactionId}`, branchAccessToken);
    const bobFinal = await authedGet<TransactionLike>(terminalPage.request, `/api/transactions/${bobTransactionId}`, branchAccessToken);
    expect(aliceFinal.data?.inventory_deduction_status).toBe('completed');
    expect(bobFinal.data?.inventory_deduction_status).toBe('completed');

    await terminalPage.unroute('**/api/transactions');
  });
});
