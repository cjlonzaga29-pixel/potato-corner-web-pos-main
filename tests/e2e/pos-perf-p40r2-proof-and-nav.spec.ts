// POS-PERF-P40R2 — the P40R fixes in a real browser: Supervisors/Branches
// highlighting on old URLs, the Attendance supervisor label, and the proof
// photo states (valid, missing, temporarily unavailable, old-API download
// answer). Reuses the P40 seed (fixtures/p40-admin-fixtures.cjs).
//
// Needs a built apps/api and apps/web against a disposable local database
// and local Supabase Storage (never a shared verification database), with
// PLAYWRIGHT_BASE_URL set to the web build and:
//   E2E_STORAGE_PROXY_URL  fixtures/storage-fault-proxy.cjs, with the API's
//                          SUPABASE_URL pointed at it. Without it the
//                          unavailable-storage test is skipped.
//   P40_SEED_SUFFIX + P40_SEED_JSON  reuse an existing P40 seed (its suffix
//                          and the JSON `seed` printed) instead of seeding.
import { test, expect, type Page, type Locator } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { TEST_USERS } from './fixtures/test-users';

test.describe.configure({ mode: 'serial' });
test.setTimeout(600_000);
// The production web build registers the PWA service worker, and page.route
// never sees requests a service worker handles — block it so the old-API mock
// applies and request counts are the page's own.
test.use({ serviceWorkers: 'block' });

const PROXY = process.env.E2E_STORAGE_PROXY_URL;
const suffix = process.env.P40_SEED_SUFFIX ?? Date.now().toString(36).slice(-6);
const OUT = path.join(__dirname, '..', '..', '.p39-local', 'p40r2');
fs.mkdirSync(OUT, { recursive: true });

interface Seed {
  branches: { a: string; b: string; c: string };
  names: { a: string; b: string; c: string };
  supervisors: { s1: string; s2: string };
  proof: { paymentKey: string; discountKey: string; bytes: number };
  pwdReceipt: string;
}
let seed: Seed;

function fixture(args: string[]): string {
  return execFileSync(process.execPath, [path.join(__dirname, 'fixtures', 'p40-admin-fixtures.cjs'), ...args], {
    cwd: path.join(__dirname, '..', '..', 'apps', 'api'),
    encoding: 'utf-8',
  }).trim();
}

async function storageMode(mode: 'pass' | 'down') {
  const res = await fetch(`${PROXY}/__ctl?mode=${mode}`);
  expect(res.ok).toBe(true);
}

// apps/api's global limiter: 100 requests/minute per IP; every local request shares 127.0.0.1.
const waitOutRateLimitWindow = () => new Promise((resolve) => setTimeout(resolve, 61_000));

async function loginAdmin(page: Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email').fill(TEST_USERS.super_admin.email);
  await page.getByRole('textbox', { name: 'Password' }).fill(TEST_USERS.super_admin.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/admin/dashboard');
  await expect(page.getByRole('heading', { name: 'Super Admin Dashboard' })).toBeVisible({ timeout: 30_000 });
}

/** The sidebar marks the active item with the primary tint (no other state is rendered). */
async function expectActive(link: Locator, active: boolean) {
  if (active) await expect(link).toHaveClass(/text-primary/);
  else await expect(link).not.toHaveClass(/text-primary/);
}

async function openTransactions(page: Page) {
  await page.goto('/admin/reports?tab=DAILY_SALES');
  await page.getByLabel('Branch').click();
  await page.getByRole('option', { name: seed.names.a }).click();
  await page.getByRole('row').filter({ hasText: seed.names.a }).first().getByRole('button', { name: 'View Transactions' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('32 transactions match the filters below.')).toBeVisible({ timeout: 30_000 });
  await sheet.getByLabel('Receipt Number').fill(seed.pwdReceipt);
  await expect(sheet.getByText('1 transaction match the filters below.')).toBeVisible({ timeout: 15_000 });
  return sheet;
}

test.beforeAll(() => {
  seed = JSON.parse(process.env.P40_SEED_JSON ?? fixture(['seed', suffix])) as Seed;
});

test('navigation: Supervisors and Branches stay highlighted on old and person URLs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  // The breadcrumb is a navigation too; the desktop sidebar is the page's <aside>.
  const sidebar = page.getByRole('complementary');
  const supervisors = sidebar.getByRole('link', { name: 'Supervisors', exact: true });
  const branches = sidebar.getByRole('link', { name: 'Branches', exact: true });
  const breadcrumb = page.getByRole('navigation', { name: 'breadcrumb' });

  await page.goto('/admin/supervisors');
  await expect(page.getByRole('heading', { name: 'Supervisors', exact: true })).toBeVisible({ timeout: 30_000 });
  await expectActive(supervisors, true);
  await expect(breadcrumb).toContainText('Supervisors');

  // Person pages kept their /admin/employees/:id URL.
  await page.goto(`/admin/employees/${seed.supervisors.s1}`);
  await expect(page.getByRole('heading', { name: new RegExp(`P40SupOne ${suffix}`) })).toBeVisible({ timeout: 30_000 });
  await expectActive(supervisors, true);
  await expectActive(branches, false);
  await expect(breadcrumb).toContainText('Supervisors');
  await expect(breadcrumb).not.toContainText(seed.supervisors.s1);
  await page.screenshot({ path: path.join(OUT, 'supervisor-detail-nav.png') });

  // The old list URL redirects and keeps the highlight.
  await page.goto('/admin/employees');
  await page.waitForURL('**/admin/supervisors');
  await expectActive(supervisors, true);

  await page.goto('/admin/branch-accounts');
  await page.waitForURL('**/admin/branches');
  await expect(page.getByRole('heading', { name: 'Branches', exact: true })).toBeVisible({ timeout: 30_000 });
  await expectActive(branches, true);
  await expectActive(supervisors, false);
  await expect(breadcrumb).toContainText('Branches');

  // Narrow: the breadcrumb is hidden below `sm`; the mobile navigation sheet carries the highlight.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/admin/employees/${seed.supervisors.s1}`);
  await expect(page.getByRole('heading', { name: new RegExp(`P40SupOne ${suffix}`) })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const sheet = page.getByRole('dialog', { name: 'Navigation' });
  await expectActive(sheet.getByRole('link', { name: 'Supervisors', exact: true }), true);
  await expectActive(sheet.getByRole('link', { name: 'Branches', exact: true }), false);
  await page.screenshot({ path: path.join(OUT, 'supervisor-detail-nav-phone.png') });
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

test('attendance: supervisor filter says current branches and explains it', async ({ page }) => {
  await waitOutRateLimitWindow();
  await loginAdmin(page);
  await page.goto('/admin/attendance');
  await expect(page.getByRole('heading', { name: 'Attendance Monitoring' })).toBeVisible({ timeout: 30_000 });
  const filter = page.getByLabel('Supervisor (current branches)');
  await expect(filter).toBeVisible();
  const hint = page.locator('#attendance-supervisor-filter-hint');
  await expect(hint).toHaveText('Uses the branches this supervisor is assigned to now, not who supervised when each record was made.');
  await expect(filter).toHaveAttribute('aria-describedby', /attendance-supervisor-filter-hint/);

  // Keyboard: open the filter, pick a supervisor; the choice and the scope line stay after switching views.
  await expect(filter).toBeEnabled({ timeout: 30_000 }); // disabled while the supervisor list loads
  await filter.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('option', { name: `P40SupTwo ${suffix}` }).click({ timeout: 15_000 });
  await expect(page.getByText(`P40SupTwo ${suffix}'s current branches (${seed.names.b})`)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'By date' }).click();
  await expect(filter).toContainText(`P40SupTwo ${suffix}`);
  await expect(page.getByText(`P40SupTwo ${suffix}'s current branches (${seed.names.b})`)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(OUT, 'attendance-supervisor-label.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(hint).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(OUT, 'attendance-supervisor-label-phone.png'), fullPage: true });
});

test('proof photos: valid download, temporary failure retries, missing file stops, old-API answer refused', async ({ page }) => {
  await waitOutRateLimitWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  const sheet = await openTransactions(page);
  const row = sheet.getByRole('row').filter({ hasText: seed.pwdReceipt });
  const viewPayment = row.getByRole('button', { name: 'View Proof' }).first();
  const viewDiscount = row.getByRole('button', { name: 'View Proof' }).last();
  const expected = fs.readFileSync(path.join(__dirname, 'fixtures', 'gcash-test.png'));

  // Valid photo: inline image, then Download photo saves the exact bytes.
  await viewPayment.click();
  const payment = page.getByRole('dialog', { name: 'Payment Proof' });
  await expect(payment.getByRole('img', { name: 'Payment proof' })).toBeVisible({ timeout: 15_000 });
  const download = page.waitForEvent('download');
  await payment.getByRole('button', { name: 'Download photo' }).click();
  const photo = await download;
  const photoPath = path.join(OUT, photo.suggestedFilename());
  await photo.saveAs(photoPath);
  expect(photo.suggestedFilename()).toBe(`payment-proof-${seed.pwdReceipt}.png`);
  expect(Buffer.compare(fs.readFileSync(photoPath), expected)).toBe(0);
  await page.screenshot({ path: path.join(OUT, 'payment-proof-valid.png') });

  // Old API (web deployed first): ?download=1 is ignored and the inline shape comes back.
  // The client refuses instead of navigating to "undefined".
  const undefinedRequests: string[] = [];
  page.on('request', (r) => {
    if (/\/undefined(\?|$)/.test(r.url())) undefinedRequests.push(r.url());
  });
  await page.route('**/api/transactions/*/payment-proof?download=1', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { payment_proof_url: 'http://127.0.0.1:9/inline.png', payment_proof_type: 'gallery_upload', uploaded_at: new Date().toISOString() }, error: null, meta: null }),
    }),
  );
  const urlBefore = page.url();
  let downloaded = false;
  page.on('download', () => {
    downloaded = true;
  });
  await payment.getByRole('button', { name: 'Download photo' }).click();
  await expect(payment.getByText('Download photo is not available until the server update finishes. Please try again later. Try again.')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1_000);
  expect(page.url()).toBe(urlBefore);
  expect(downloaded).toBe(false);
  expect(undefinedRequests).toEqual([]);
  await page.screenshot({ path: path.join(OUT, 'payment-proof-old-api-download.png') });
  await page.unroute('**/api/transactions/*/payment-proof?download=1');

  // P41R4 — Tab stays inside the open viewer.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    await expect(payment.locator(':focus')).toHaveCount(1);
  }

  // Keyboard: Escape closes the dialog, focus returns to its trigger, the panel keeps its filter.
  await page.keyboard.press('Escape');
  await expect(payment).toBeHidden();
  await expect(viewPayment).toBeFocused();
  await expect(sheet.getByLabel('Receipt Number')).toHaveValue(seed.pwdReceipt);
  await expect(sheet.getByText('1 transaction match the filters below.')).toBeVisible();

  // Confirmed missing file: "Photo unavailable", no retry or download, and no repeated requests.
  fixture(['remove-object', 'discount-proofs', seed.proof.discountKey]);
  const discountRequests: string[] = [];
  page.on('request', (r) => {
    if (/\/discount-proof(\?|$)/.test(r.url())) discountRequests.push(r.url());
  });
  await viewDiscount.click();
  const discount = page.getByRole('dialog', { name: 'Discount Proof' });
  await expect(discount.getByText('Photo unavailable')).toBeVisible({ timeout: 15_000 });
  await expect(discount.getByText(/no longer in storage/)).toBeVisible();
  await expect(discount.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(discount.getByRole('button', { name: 'Download photo' })).toHaveCount(0);
  await expect(discount.getByRole('img', { name: 'Discount proof' })).toHaveCount(0);
  await page.waitForTimeout(8_000); // longer than the retry backoff a retryable failure gets
  expect(discountRequests).toHaveLength(1);
  await page.screenshot({ path: path.join(OUT, 'discount-proof-missing.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  // Right after the resize the box can still report the desktop width; wait for the relayout.
  await expect.poll(async () => (await discount.boundingBox())?.width ?? 999).toBeLessThanOrEqual(390);
  await expect(discount.getByText('Photo unavailable')).toBeInViewport();
  await page.screenshot({ path: path.join(OUT, 'discount-proof-missing-phone.png') });
  await page.keyboard.press('Escape');
  await expect(viewDiscount).toBeFocused();

  // P41R4 — closing the panel returns focus to the View Transactions that opened it.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('row').filter({ hasText: seed.names.a }).first().getByRole('button', { name: 'View Transactions' })).toBeFocused();
});

test('proof photos: storage unavailable offers Try again and recovers', async ({ page }) => {
  test.skip(!PROXY, 'E2E_STORAGE_PROXY_URL not set');
  await waitOutRateLimitWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  const sheet = await openTransactions(page);
  const viewPayment = sheet.getByRole('row').filter({ hasText: seed.pwdReceipt }).getByRole('button', { name: 'View Proof' }).first();

  await storageMode('down');
  try {
    await viewPayment.click();
    const payment = page.getByRole('dialog', { name: 'Payment Proof' });
    // The query retries twice before showing the error.
    await expect(payment.getByText('Failed to load the payment proof.')).toBeVisible({ timeout: 60_000 });
    const tryAgain = payment.getByRole('button', { name: 'Try again' });
    await expect(tryAgain).toBeVisible();
    await expect(payment.getByText('Photo unavailable')).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, 'payment-proof-storage-down.png') });

    await storageMode('pass');
    await tryAgain.focus();
    await page.keyboard.press('Enter');
    await expect(payment.getByRole('img', { name: 'Payment proof' })).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT, 'payment-proof-recovered.png') });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => (await payment.boundingBox())?.width ?? 999).toBeLessThanOrEqual(390);
    await expect(payment.getByRole('button', { name: 'Download photo' })).toBeInViewport();
    await page.screenshot({ path: path.join(OUT, 'payment-proof-recovered-phone.png') });
  } finally {
    await storageMode('pass');
  }
});
