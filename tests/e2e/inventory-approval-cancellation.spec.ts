// POS-PERF-P28R3 — real-browser verification of the manual-inventory
// approval queue's review/correction/cancellation lifecycle, run against a
// disposable local Postgres + API + web stack (see the runbook at
// docs/runbooks/pos-perf-p28-inventory-approval-rollout.md for the server-
// side lineage rules this exercises). Every step below drives the actual
// UI (branch-ops/inventory-adjust-form.tsx and
// branch-ops/inventory-approvals/*) through a real Chromium session. Each
// role (branch/supervisor) gets exactly ONE persistent BrowserContext for
// the whole file, seeded once from its saved storageState
// (fixtures/{role}.auth.json, written by global-setup.ts) and reused
// test-to-test — switching "identity" means switching which already-live
// page we act on, never creating a fresh context from that static file a
// second time. Two earlier approaches both failed: (1) a real UI login per
// step pushed a single run over the API's global rate limiter (100 req/min
// per user — apps/api/src/middleware/rate-limiter.ts#apiLimiter), surfacing
// as spurious "Something went wrong" queue-load failures; (2) re-opening a
// brand-new context from the same static storageState file every switch
// hung on the second reuse of any given role — the saved refresh_token
// cookie is single-use/rotating (see auth.service.ts's rotation-result
// cache), so the SECOND context built from that unchanged-on-disk file
// presented an already-rotated token and could never re-authenticate.
// Direct API calls are limited to:
// fixture seeding (item/category/unit/branch creation), stock-balance
// verification (authoritative source of truth for "stock changed exactly
// once" assertions), and the final cross-branch-access confirmation (the
// UI makes the equivalent action structurally unreachable — see that test).
import path from 'node:path';
import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedGet, authedPost } from './fixtures/api-helpers';
import { seedUniversalItem, UNIVERSAL_ITEM_FIXTURE } from './fixtures/seed-universal-item';

const NAV_TIMEOUT = 30_000;
// Stock reads-after-write go straight to the API (bypassing the Next.js
// rewrite proxy at the web app's baseURL), AND are cache-busted with a
// unique query param each call — a repeated identical-URL GET immediately
// after a mutation was observed returning a stale (pre-mutation) body
// despite the database already holding the committed write, which made
// read-after-write checks flaky.
const API_URL = 'http://localhost:4000';
function freshStockUrl(branchId: string): string {
  return `${API_URL}/api/branches/${branchId}/inventory-stock?_cb=${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

let branchId: string;
let inventoryItemId: string;
let adminAccessToken: string;
let supervisorAccessToken: string;
// This dev database is reused across runs of this spec (not torn down
// between them), so quantities are salted to a fresh random base each run —
// row-disambiguation below matches on exact quantity text, and a collision
// with a leftover row from a prior (possibly failed) run would silently
// pick the wrong row.
const SALT = Math.floor(Math.random() * 9000) + 1000;
const Q_INITIAL = SALT + 1;
const Q_SELF_APPROVAL = SALT + 2;
const Q_RETURN_ORIGINAL = SALT + 3;
const Q_RETURN_CORRECTED = SALT + 4;
const Q_CANCEL = SALT + 5;
const Q_STALENESS_BUMP = SALT + 6;

let branchContext: BrowserContext;
let branchPage: Page;
let supervisorContext: BrowserContext;
let supervisorPage: Page;

test.beforeAll(async ({ browser, request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  adminAccessToken = admin.accessToken;
  const branches = await authedGet<{ branches: { id: string; code: string }[] }>(request, '/api/branches', adminAccessToken);
  const branch = branches.data?.branches.find((b) => b.code === 'MAIN01');
  if (!branch) throw new Error('Seeded "Main Branch" (MAIN01) not found — run apps/api/prisma/seed.ts first');
  branchId = branch.id;

  const item = await seedUniversalItem(request, url, branchId);
  inventoryItemId = item.inventoryItemId;

  const supervisor = await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password);
  supervisorAccessToken = supervisor.accessToken;

  // Best-effort cleanup of dangling PENDING/RETURNED requests this fixture
  // item may have accumulated from an earlier interrupted run, so this
  // run's queue views aren't cluttered with ambiguous old rows.
  for (const status of ['PENDING', 'RETURNED'] as const) {
    const stale = await authedGet<{ requests: { id: string; inventory_item_id: string | null }[] }>(
      request,
      `/api/inventory-approvals?branch_id=${branchId}&status=${status}&limit=100`,
      supervisorAccessToken,
    );
    for (const r of stale.data?.requests ?? []) {
      if (r.inventory_item_id === inventoryItemId) {
        await authedPost(request, url, `/api/inventory-approvals/${r.id}/cancel`, supervisorAccessToken, { reason: 'stale leftover from a prior test run' });
      }
    }
  }

  // One persistent context per role for the whole file — see the header
  // comment on why these are never recreated from the static storageState
  // file mid-run.
  branchContext = await browser.newContext({ storageState: path.join(__dirname, 'fixtures', 'branch.auth.json') });
  branchPage = await branchContext.newPage();
  supervisorContext = await browser.newContext({ storageState: path.join(__dirname, 'fixtures', 'supervisor.auth.json') });
  supervisorPage = await supervisorContext.newPage();
});

test.afterAll(async () => {
  await branchContext?.close();
  await supervisorContext?.close();
});

async function submitAdjustment(page: Page, basePath: string, quantityDelta: number, notes: string): Promise<void> {
  await page.goto(`${basePath}/inventory/adjust`, { waitUntil: 'networkidle' });
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: new RegExp(UNIVERSAL_ITEM_FIXTURE.itemName) }).click();
  await page.getByLabel(/Quantity Change/).fill(String(quantityDelta));
  await page.getByLabel('Notes').fill(notes);
  await page.getByRole('button', { name: 'Submit for Review' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Submit for Review' }).click();
  await page.waitForURL(`**${basePath}/inventory/approvals`, { timeout: NAV_TIMEOUT });
}

/**
 * The queue table (inventory-approval-queue.tsx) renders no notes column —
 * only submitted-at/item/operation/quantity/submitted-by — so rows here are
 * disambiguated by their exact quantity cell text (unique per test in this
 * file; see each call site), not by notes. Notes are only ever checked
 * inside the opened detail dialog, which does render them.
 */
async function openRequestByQuantity(
  page: Page,
  basePath: string,
  status: 'PENDING' | 'APPROVED' | 'RETURNED' | 'CANCELLED',
  quantityText: string,
): Promise<void> {
  const tabName = status === 'PENDING' ? 'Pending Review' : status === 'APPROVED' ? 'Approved' : status === 'RETURNED' ? 'Returned for Correction' : 'Cancelled';
  // Scoped to our fixture item's name too — this database is reused across
  // runs (not torn down), so a leftover row from a prior run could otherwise
  // share the same quantity text and silently win the .first() match.
  const row = page
    .getByRole('row')
    .filter({ hasText: UNIVERSAL_ITEM_FIXTURE.itemName })
    .filter({ has: page.getByText(quantityText, { exact: true }) })
    .first();

  // This test file's request density (many role switches, each a full page
  // load) can legitimately bump into the API's real 100 req/min/user rate
  // limit (apps/api/src/middleware/rate-limiter.ts#apiLimiter) — observed in
  // practice, and can surface at any point in this sequence: the branch-
  // list fetch that picks an active branch (blocking the tabs from ever
  // rendering), or the approvals-list fetch itself (rendering a real
  // "Something went wrong... Try again" state — shared/feedback/
  // error-state.tsx — with a retry button wired to the query's refetch()).
  // Retried here exactly as a real user would: reload, wait out the
  // limiter's window, click retry if shown — never by weakening or
  // bypassing the limiter itself.
  for (let attempt = 0; attempt < 8; attempt++) {
    // Always a fresh navigation, never skipped: the queue list's realtime
    // sync (useInventoryApprovalRealtimeSync) only invalidates on
    // INVENTORY_MOVEMENT_RECORDED, which approve() emits — a new PENDING
    // submission or a return/correct/cancel fires no such event, so a page
    // already sitting on this URL would otherwise show a stale pre-action
    // list until its 10s staleTime and some unrelated refetch trigger
    // happened to line up (which never reliably happens in a headless
    // browser with no focus/blur events) — an earlier "skip if already
    // here" version of this helper hung exactly this way.
    await page.goto(`${basePath}/inventory/approvals`, { waitUntil: 'networkidle' });
    const tab = page.getByRole('tab', { name: tabName });
    const tryAgain = page.getByRole('button', { name: 'Try again' });
    const outcome = await Promise.race([
      tab.waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'tab' as const),
      tryAgain.waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'error' as const),
    ]).catch(() => 'timeout' as const);
    if (outcome === 'error') {
      await page.waitForTimeout(8_000);
      continue; // reload from the top rather than trusting this render's query client state
    }
    if (outcome === 'timeout') continue;
    await tab.click();

    const rowOutcome = await Promise.race([
      row.waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'row' as const),
      tryAgain.waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'error' as const),
    ]).catch(() => 'timeout' as const);
    if (rowOutcome === 'row') break;
    if (rowOutcome === 'error') await page.waitForTimeout(8_000);
    // 'timeout' with no error shown: the row may just not be rendered yet
    // (query still in flight) — loop reloads and re-checks.
  }
  await row.getByRole('button', { name: 'View' }).click();
}

/**
 * Clicks Approve on the open detail dialog and confirms via the AlertDialog
 * it opens (components/shared/confirm-dialog.tsx), waiting on the actual
 * POST .../approve network response rather than the success toast alone —
 * a bare toast-visibility wait was observed resolving before a subsequent
 * direct stock re-read reflected the write.
 */
async function approveViaDialog(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Approve' }).click();
  const [response] = await Promise.all([
    page.waitForResponse((res) => /\/api\/inventory-approvals\/.+\/approve$/.test(res.url()) && res.request().method() === 'POST'),
    page.getByRole('alertdialog').getByRole('button', { name: 'Approve' }).click(),
  ]);
  if (!response.ok()) throw new Error(`Approve request failed: ${response.status()} ${await response.text()}`);
}

async function getItemStock(request: APIRequestContext): Promise<number> {
  const result = await authedGet<{ items: { inventory_item_id: string; quantity_on_hand: number }[] }>(request, freshStockUrl(branchId), adminAccessToken);
  return result.data?.items.find((i) => i.inventory_item_id === inventoryItemId)?.quantity_on_hand ?? 0;
}

test.describe.serial('Inventory approval — real-browser lineage cancellation', () => {
  // The default 30s per-test timeout is too tight for the tests that act as
  // both roles in sequence against two already-live pages, each step doing
  // a full page navigation under Next dev/Turbopack (not production-speed).
  test.describe.configure({ timeout: 240_000 });

  test('branch submits an adjustment → Pending, stock unchanged until approval', async ({ request }) => {
    const before = await getItemStock(request);

    await submitAdjustment(branchPage, '/branch', Q_INITIAL, 'P28R3 browser test: initial submission');

    // Still on the Pending Review tab after redirect — the submitted quantity's row exists and is visible.
    await expect(
      branchPage
        .getByRole('row')
        .filter({ hasText: UNIVERSAL_ITEM_FIXTURE.itemName })
        .filter({ has: branchPage.getByText(String(Q_INITIAL), { exact: true }) })
        .first(),
    ).toBeVisible({ timeout: NAV_TIMEOUT });

    const after = await getItemStock(request);
    expect(after).toBe(before);
  });

  test('a different supervisor approves the pending request → stock changes exactly once', async ({ request }) => {
    const beforeQty = await getItemStock(request);

    await openRequestByQuantity(supervisorPage, '/supervisor', 'PENDING', String(Q_INITIAL));
    await approveViaDialog(supervisorPage);
    await expect(supervisorPage.getByText('Approved', { exact: false }).first()).toBeVisible({ timeout: NAV_TIMEOUT });

    const afterQty = await getItemStock(request);
    expect(afterQty).toBe(beforeQty + Q_INITIAL);
  });

  test('self-approval is denied in the UI: a supervisor cannot approve their own submission', async () => {
    await submitAdjustment(supervisorPage, '/supervisor', Q_SELF_APPROVAL, 'P28R3 browser test: self-approval check');

    await openRequestByQuantity(supervisorPage, '/supervisor', 'PENDING', String(Q_SELF_APPROVAL));
    await expect(supervisorPage.getByText('You submitted this request — it must be reviewed by someone else.')).toBeVisible();
    await expect(supervisorPage.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(supervisorPage.getByText('P28R3 browser test: self-approval check')).toBeVisible();

    // Clean up: cancel it so it doesn't linger as a dangling PENDING row
    // forever claimable by nobody (self-submitted, nobody else expected it).
    await supervisorPage.getByRole('button', { name: 'Cancel Request Permanently' }).click();
    await supervisorPage.getByLabel('Explanation (required)').fill('cleanup after self-approval-denied check');
    await supervisorPage.getByRole('dialog').getByRole('button', { name: 'Cancel Request Permanently' }).click();
  });

  test('cross-branch review is denied: a supervisor with no access to another branch cannot see or act on its requests', async ({ request }) => {
    // authedPost needs a csrf-token cookie on THIS test's own request
    // context (each test gets a fresh one) — logging in here sets it; the
    // cached adminAccessToken from beforeAll is reused regardless.
    await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);

    // A fresh branch neither seeded supervisor is assigned to.
    const otherBranchName = `P28R3 Cross-Branch Check ${Date.now()}`;
    const otherBranch = await authedPost<{ id: string }>(request, 'http://localhost:3000', '/api/branches', adminAccessToken, {
      name: otherBranchName,
      address: '1 Test Ave',
      city: 'Test City',
      status: 'active',
    });
    if (!otherBranch.data?.id) throw new Error(`Failed to seed second branch: ${JSON.stringify(otherBranch.error)}`);

    // Browser-level proof: the real supervisor dashboard's branch selector
    // (components/supervisor/branch-selector.tsx) lists only branches
    // GET /api/branches server-scopes to this supervisor's branch_ids — the
    // new branch, which they were never assigned, must not appear as a
    // selectable option at all.
    await supervisorPage.goto('/supervisor/inventory/approvals', { waitUntil: 'networkidle' });
    const branchSelectorTrigger = supervisorPage.getByRole('button').filter({ hasText: /Main Branch/ });
    if (await branchSelectorTrigger.count()) {
      await branchSelectorTrigger.first().click();
      await expect(supervisorPage.getByRole('menuitem', { name: otherBranchName })).toHaveCount(0);
      await supervisorPage.keyboard.press('Escape');
    }

    // Defense-in-depth confirmation using this supervisor's own real
    // session token (not a fabricated one): the API itself rejects any
    // attempt to list/act on the other branch's approval queue.
    const deniedAttempt = await request.get(`/api/inventory-approvals?branch_id=${otherBranch.data.id}`, {
      headers: { Authorization: `Bearer ${supervisorAccessToken}` },
    });
    const deniedBody = (await deniedAttempt.json()) as { data: unknown; error: { code?: string } | null };
    expect(deniedAttempt.status()).toBe(403);
    expect(deniedBody.error?.code).toBe('BRANCH_ACCESS_DENIED');
  });

  test('return → correct → approve, with revision history visible in the UI', async () => {
    await submitAdjustment(branchPage, '/branch', Q_RETURN_ORIGINAL, 'P28R3 browser test: return-correct-approve lineage');

    await openRequestByQuantity(supervisorPage, '/supervisor', 'PENDING', String(Q_RETURN_ORIGINAL));
    await supervisorPage.getByRole('button', { name: 'Return for Correction' }).click();
    await supervisorPage.getByLabel('Explanation (required)').fill('wrong quantity, please resubmit');
    await supervisorPage.getByRole('dialog').getByRole('button', { name: 'Return for Correction' }).click();

    await openRequestByQuantity(branchPage, '/branch', 'RETURNED', String(Q_RETURN_ORIGINAL));
    await expect(branchPage.getByRole('dialog').getByText('wrong quantity, please resubmit')).toBeVisible();
    await branchPage.getByLabel('Corrected Quantity').fill(String(Q_RETURN_CORRECTED));
    await branchPage.getByRole('button', { name: 'Resubmit for Review' }).click();
    await branchPage.waitForURL('**/branch/inventory/approvals', { timeout: NAV_TIMEOUT });

    await openRequestByQuantity(supervisorPage, '/supervisor', 'PENDING', String(Q_RETURN_CORRECTED));
    // Revision history must be visible before approving the corrected revision.
    await expect(supervisorPage.getByText(/Rev 1:/)).toBeVisible();
    await expect(supervisorPage.getByText(/Rev 2:/)).toBeVisible();
    await approveViaDialog(supervisorPage);
    await expect(supervisorPage.getByText('Approved', { exact: false }).first()).toBeVisible({ timeout: NAV_TIMEOUT });
  });

  test('cancel → terminal status, no approve/correct actions remain available', async () => {
    await submitAdjustment(branchPage, '/branch', Q_CANCEL, 'P28R3 browser test: cancel terminal state');

    await openRequestByQuantity(supervisorPage, '/supervisor', 'PENDING', String(Q_CANCEL));
    await supervisorPage.getByRole('button', { name: 'Cancel Request Permanently' }).click();
    await supervisorPage.getByLabel('Explanation (required)').fill('duplicate submission, no longer needed');
    await supervisorPage.getByRole('dialog').getByRole('button', { name: 'Cancel Request Permanently' }).click();

    await openRequestByQuantity(supervisorPage, '/supervisor', 'CANCELLED', String(Q_CANCEL));
    await expect(supervisorPage.getByRole('dialog').getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(supervisorPage.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(supervisorPage.getByRole('button', { name: 'Return for Correction' })).toHaveCount(0);
    await expect(supervisorPage.getByRole('button', { name: 'Cancel Request Permanently' })).toHaveCount(0);
    await expect(supervisorPage.getByRole('dialog').getByText('duplicate submission, no longer needed')).toBeVisible();
  });

  test('a stale physical count (stock moved after submission) is rejected at approval, not applied', async ({ request }) => {
    await branchPage.goto('/branch/inventory/count', { waitUntil: 'networkidle' });
    const itemRow = branchPage.locator('div.flex.items-center.justify-between').filter({ hasText: UNIVERSAL_ITEM_FIXTURE.itemName });
    await itemRow.getByRole('spinbutton').fill('999');
    await branchPage.getByRole('button', { name: 'Submit Count' }).click();
    await branchPage.getByRole('alertdialog').getByRole('button', { name: 'Submit for Review' }).click();
    await branchPage.waitForURL('**/branch/inventory/approvals', { timeout: NAV_TIMEOUT });

    // An unrelated adjustment, approved in between, moves the stock version
    // the count's staleness fingerprint was taken against.
    await submitAdjustment(branchPage, '/branch', Q_STALENESS_BUMP, 'P28R3 browser test: staleness bump');

    await openRequestByQuantity(supervisorPage, '/supervisor', 'PENDING', String(Q_STALENESS_BUMP));
    await approveViaDialog(supervisorPage);

    const beforeQty = await getItemStock(request);

    // Already on /supervisor/inventory/approvals (approveViaDialog closed
    // the dialog, not navigated away) — no reload needed, the query
    // invalidation after approve already refreshed this list.
    const staleRow = supervisorPage
      .getByRole('row')
      .filter({ hasText: UNIVERSAL_ITEM_FIXTURE.itemName })
      .filter({ hasText: 'Physical Count' })
      .first();
    await staleRow.getByRole('button', { name: 'View' }).click();
    await supervisorPage.getByRole('button', { name: 'Approve' }).click();
    const rejection = supervisorPage.waitForResponse((res) => /\/api\/inventory-approvals\/.+\/approve$/.test(res.url()) && res.request().method() === 'POST');
    await supervisorPage.getByRole('alertdialog').getByRole('button', { name: 'Approve' }).click();
    await rejection;
    // Exact toast text from universal-inventory.service.ts's STALE_PHYSICAL_COUNT error.
    await expect(supervisorPage.getByText(/fresh recount is required/i)).toBeVisible({ timeout: NAV_TIMEOUT });

    const afterQty = await getItemStock(request);
    expect(afterQty).toBe(beforeQty);
  });
});
