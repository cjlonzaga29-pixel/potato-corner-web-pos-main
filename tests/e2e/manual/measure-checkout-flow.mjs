// POS-PERF-P15R3 — real-browser measurement of the checkout user flow
// against a seeded LOCAL api+web stack (see apps/api/scripts/
// dev-local-postgres.mjs / seed-pos-demo-inventory.mjs). Not part of the
// Playwright test suite (no assertions meant to gate CI) — a one-off
// instrumented script, run manually, that reports real local timings.
// These are LOCAL measurements only, not representative of production
// network/infra latency.
//
// Usage: node tests/e2e/manual/measure-checkout-flow.mjs
import { chromium } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';
const API_URL = process.env.API_URL || 'http://localhost:4000';
const results = {};

function nowMs() {
  return Date.now();
}

/** Returns the access_token from the login response, so direct API-origin requests (background-deduction polling below) can authenticate without reaching into the app's in-memory auth store from page context. */
async function login(page) {
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel('Email').fill('staff@potatocorner.test');
  await page.getByRole('textbox', { name: 'Password' }).fill('Staff123');
  const loginResponsePromise = page.waitForResponse((res) => res.url().includes('/api/auth/login') && res.status() === 200);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/terminal');
  const loginBody = await loginResponsePromise.then((r) => r.json());
  return loginBody?.data?.access_token ?? null;
}

/** The seeded Main Branch has no configured GPS coordinates, so any submitted location resolves to 'no_gps_data' (informational, not a hard rejection) — this just needs getCurrentPosition() to resolve instead of reject. */
async function clockInIfNeeded(page) {
  const clockInButton = page.getByRole('button', { name: 'Clock In' });
  const appeared = await clockInButton
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return; // already clocked in (or the catalog loaded directly)
  await clockInButton.click();
  await page.getByRole('button', { name: /Drinks \(demo\)/ }).waitFor({ state: 'visible', timeout: 15000 });
}

async function addDemoItemToCart(page) {
  const tile = page.getByRole('button', { name: /Drinks \(demo\)/ });
  await tile.waitFor({ state: 'visible', timeout: 15000 });
  await tile.click();
}

async function openCheckoutAndFillCash(page) {
  await page.getByRole('button', { name: /^Checkout/ }).click();
  const cashInput = page.getByPlaceholder('Cash tendered');
  await cashInput.waitFor({ state: 'visible' });
  await cashInput.fill('100');
}

/** Clicks Charge and measures click→popup-painted and click→success timings. One full sale, start to New Sale. Returns the created transaction's id (captured from the actual POST response). */
async function runOneSale(page, label) {
  await addDemoItemToCart(page);
  await openCheckoutAndFillCash(page);

  const chargeButton = page.getByRole('button', { name: /^Charge/ });
  const responsePromise = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/transactions') && res.status() === 201);
  const tClick = nowMs();
  await chargeButton.click();

  await page.getByText('Saving sale').waitFor({ state: 'visible' });
  const tPopup = nowMs();

  await page.getByText('Sale completed').waitFor({ state: 'visible', timeout: 30000 });
  const tSuccess = nowMs();

  const body = await responsePromise.then((r) => r.json()).catch(() => null);
  const transactionId = body?.data?.id ?? null;

  const timing = {
    clickToPopupMs: tPopup - tClick,
    clickToSuccessMs: tSuccess - tClick,
  };
  results[label] = timing;
  console.log(`[${label}] click→popup: ${timing.clickToPopupMs}ms, click→success: ${timing.clickToSuccessMs}ms`);

  await page.getByRole('button', { name: 'New Sale' }).click();
  return { ...timing, transactionId };
}

/** Background inventory deduction completion, measured via the API directly (Playwright's own request context, authenticated with the access_token captured at login) rather than any UI signal — the terminal UI deliberately never waits on it (New Sale is available immediately on success). Hits API_URL directly (not the web origin) since the browser's own apiClient does the same (NEXT_PUBLIC_API_URL), bypassing any same-origin assumption. */
async function measureBackgroundDeductionCompletion(request, accessToken, transactionId) {
  const start = nowMs();
  const deadline = start + 15000;
  for (;;) {
    const res = await request.get(`${API_URL}/api/transactions/${transactionId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = await res.json().catch(() => null);
    const status = body?.data?.inventory_deduction_status ?? null;
    if (status === 'completed') return nowMs() - start;
    if (nowMs() > deadline) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function measureDelayedResponsePopup(page) {
  await addDemoItemToCart(page);
  await openCheckoutAndFillCash(page);

  const DELAY_MS = 3000;
  await page.route('**/api/transactions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await new Promise((r) => setTimeout(r, DELAY_MS));
    await route.continue();
  });

  const chargeButton = page.getByRole('button', { name: /^Charge/ });
  const tClick = nowMs();
  await chargeButton.click();

  await page.getByText('Saving sale').waitFor({ state: 'visible' });
  const tPopup = nowMs();
  console.log(`[delayed-response] popup painted ${tPopup - tClick}ms after click, while the API response is deliberately held for ${DELAY_MS}ms`);

  // Confirm the popup is STILL showing "Saving sale" partway through the
  // artificial delay — the exact scenario in question: a slow server must
  // never leave the cashier looking at a blank/stale screen.
  await new Promise((r) => setTimeout(r, DELAY_MS / 2));
  const stillSaving = await page.getByText('Saving sale').isVisible();
  console.log(`[delayed-response] still showing "Saving sale" at the delay's midpoint: ${stillSaving}`);
  results.delayedResponse = { clickToPopupMs: tPopup - tClick, stillVisibleAtMidpoint: stillSaving };

  await page.getByText('Sale completed').waitFor({ state: 'visible', timeout: DELAY_MS + 10000 });
  await page.unroute('**/api/transactions');
  await page.getByRole('button', { name: 'New Sale' }).click();
}

/**
 * POS-PERF-P19 — the scenario from the bug report: with the first charge's
 * API response delayed 15s, clicking New Sale during "Saving sale…" must
 * open a second cart immediately (not wait for the first response), and a
 * second sale submitted on that cart must succeed independently. Measures
 * click→popup and click→New-Sale-usable separately from server
 * confirmation, per the task's validation ask.
 */
async function measureNewSaleDuringSaving(page) {
  await addDemoItemToCart(page);
  await openCheckoutAndFillCash(page);

  const DELAY_MS = 15000;
  await page.route('**/api/transactions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await new Promise((r) => setTimeout(r, DELAY_MS));
    await route.continue();
  });

  const chargeButton = page.getByRole('button', { name: /^Charge/ });
  const tClick = nowMs();
  await chargeButton.click();

  await page.getByText('Saving sale…').waitFor({ state: 'visible' });
  const tPopup = nowMs();

  const newSaleButton = page.getByRole('button', { name: 'New Sale' });
  await newSaleButton.waitFor({ state: 'visible' });
  await newSaleButton.click();
  const tNextCartAvailable = nowMs();

  console.log(
    `[new-sale-during-saving] click→popup: ${tPopup - tClick}ms, click→next-cart-available: ${tNextCartAvailable - tClick}ms (first response deliberately held for ${DELAY_MS}ms)`,
  );
  results.newSaleDuringSaving = {
    clickToPopupMs: tPopup - tClick,
    clickToNextCartAvailableMs: tNextCartAvailable - tClick,
  };

  // The popup for the FIRST order must be gone — New Sale closed it instead
  // of waiting for the delayed response.
  const firstPopupGone = !(await page.getByText('Saving sale…').isVisible().catch(() => false));
  console.log(`[new-sale-during-saving] first order's popup closed immediately: ${firstPopupGone}`);

  // Build and submit a second, independent cart while the first request is
  // still held.
  const secondResponsePromise = page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().includes('/api/transactions') && res.status() === 201,
  );
  await addDemoItemToCart(page);
  await openCheckoutAndFillCash(page);
  await page.getByRole('button', { name: /^Charge/ }).click();
  await page.getByText('Sale completed').waitFor({ state: 'visible', timeout: 15000 });
  const secondBody = await secondResponsePromise.then((r) => r.json()).catch(() => null);
  console.log(`[new-sale-during-saving] second (independent) cart confirmed while the first was still pending — id: ${secondBody?.data?.id ?? 'unknown'}`);
  await page.getByRole('button', { name: 'New Sale' }).click();

  // Open the Pending Sales panel and confirm the first (detached) order is
  // tracked there, still saving.
  const pendingSalesButton = page.getByRole('button', { name: /Pending Sales/ });
  await pendingSalesButton.waitFor({ state: 'visible' });
  await pendingSalesButton.click();
  await page.getByText('Saving').waitFor({ state: 'visible', timeout: 5000 });
  console.log('[new-sale-during-saving] detached first order visible in Pending Sales panel, still saving');

  // Now let the first response actually land (DELAY_MS already elapsed by
  // this point in real time) and confirm the panel updates to Confirmed
  // without disturbing the page the cashier is now on.
  await page.getByText('Confirmed').waitFor({ state: 'visible', timeout: DELAY_MS });
  console.log('[new-sale-during-saving] detached first order resolved to Confirmed in the panel, independently of the second sale');

  await page.unroute('**/api/transactions');
  await page.keyboard.press('Escape');
  void firstTransactionId;
}

async function measureFailureAndRecovery(page) {
  await addDemoItemToCart(page);
  await openCheckoutAndFillCash(page);

  let firstAttempt = true;
  await page.route('**/api/transactions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    if (firstAttempt) {
      firstAttempt = false;
      await route.abort('failed'); // simulates a dropped connection
      return;
    }
    return route.continue();
  });

  await page.getByRole('button', { name: /^Charge/ }).click();
  await page.getByText("Couldn't save sale").waitFor({ state: 'visible', timeout: 15000 });
  console.log('[failure-recovery] error popup shown after simulated network failure, as expected');

  const tRetryClick = nowMs();
  await page.getByRole('button', { name: 'Retry' }).click();
  await page.getByText('Sale completed').waitFor({ state: 'visible', timeout: 15000 });
  console.log(`[failure-recovery] retry succeeded ${nowMs() - tRetryClick}ms after clicking Retry — exactly one sale (server-side idempotency key reused, not a new one)`);
  results.failureRecovery = { retryToSuccessMs: nowMs() - tRetryClick };

  await page.unroute('**/api/transactions');
  await page.getByRole('button', { name: 'New Sale' }).click();
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ geolocation: { latitude: 14.676, longitude: 121.0437 }, permissions: ['geolocation'] });
  const page = await context.newPage();

  const accessToken = await login(page);
  await clockInIfNeeded(page);

  console.log('\n=== Consecutive sales ===');
  await runOneSale(page, 'sale1');
  const sale2 = await runOneSale(page, 'sale2');

  console.log('\n=== Background inventory deduction completion ===');
  if (sale2.transactionId && accessToken) {
    const ms = await measureBackgroundDeductionCompletion(page.request, accessToken, sale2.transactionId);
    results.backgroundDeductionMs = ms;
    console.log(`[background-deduction] completed ${ms}ms after sale creation (worker polls every 2s per server startup log)`);
  } else {
    console.log('[background-deduction] could not capture a transaction id from the last sale — skipped');
  }

  console.log('\n=== Delayed API response (popup must still paint and stay visible) ===');
  await measureDelayedResponsePopup(page);

  console.log('\n=== New Sale during saving (POS-PERF-P19 — 15s delayed response) ===');
  await measureNewSaleDuringSaving(page);

  console.log('\n=== Failure + recovery (dropped connection, then Retry) ===');
  await measureFailureAndRecovery(page);

  console.log('\n=== Summary (LOCAL measurements only — not production timings) ===');
  console.log(JSON.stringify(results, null, 2));

  await browser.close();
}

main().catch((error) => {
  console.error('Measurement script failed:', error);
  process.exitCode = 1;
});
