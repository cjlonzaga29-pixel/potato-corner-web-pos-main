// POS-PERF-P30R — real-browser verification of PIN-gated POS cashier
// identity: Supervisor PIN management, PIN-gated clock-in, Switch Cashier
// (identity swap without clock-out), PIN revocation, cross-branch denial, and
// inventory-vs-POS purpose separation. Complements the unit-level stale-
// closure regression test in terminal/page.test.tsx, which deterministically
// exercises the exact race (a late 401-retry for an abandoned cashier A
// request resolving after Switch Cashier to B) that is impractical to force
// via real network timing in a browser. Reuses the seeded MAIN01 branch and
// its existing branch/supervisor/staff fixture accounts (test-users.ts).
import crypto from 'node:crypto';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedPost, authedGet } from './fixtures/api-helpers';

const NAV_TIMEOUT = 60_000;

let branchId: string;
let otherBranchId: string;
let adminAccessToken: string;
let branchAccessToken: string;
let jennyUserId: string;
let bobUserId: string;
let bobPin: string;
let jennyPin = '';

let supervisorContext: BrowserContext;
let supervisorPage: Page;
let terminalContext: BrowserContext;
let terminalPage: Page;
let appBaseURL: string;

test.beforeAll(async ({ browser, request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  appBaseURL = url;
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  adminAccessToken = admin.accessToken;

  const branchLogin = await apiLogin(request, TEST_USERS.branch.email, TEST_USERS.branch.password);
  branchAccessToken = branchLogin.accessToken;
  branchId = branchLogin.branchIds[0] as string;

  const branches = await authedGet<{ branches: { id: string; code: string }[] }>(request, '/api/branches', adminAccessToken);
  const main = branches.data?.branches.find((b) => b.code === 'MAIN01');
  if (!main) throw new Error('Seeded "Main Branch" (MAIN01) not found — run apps/api/prisma/seed.ts first');
  branchId = main.id;
  const other = branches.data?.branches.find((b) => b.id !== branchId);
  if (!other) throw new Error('Need a second seeded branch for the cross-branch denial check');
  otherBranchId = other.id;

  const staffLogin = await apiLogin(request, TEST_USERS.staff.email, TEST_USERS.staff.password);
  jennyUserId = staffLogin.userId;

  // A second staff member at the same branch, for the Switch Cashier scenario.
  const suffix = crypto.randomUUID().slice(0, 8);
  const created = await authedPost<{ id: string }>(request, url, '/api/employees', adminAccessToken, {
    first_name: 'Bob',
    last_name: `Cashier-${suffix}`,
    role: 'staff',
    employment_type: 'regular',
    branch_ids: [branchId],
    position: 'Cashier',
  });
  if (!created.data?.id) throw new Error(`Failed to create second staff member: ${JSON.stringify(created.error)}`);
  bobUserId = created.data.id;

  bobPin = String(Math.floor(100000 + Math.random() * 900000));
  const bobPinResult = await authedPost(request, url, `/api/staff-pin/${bobUserId}/pin`, adminAccessToken, { pin: bobPin });
  if (bobPinResult.status >= 300) throw new Error(`Failed to provision Bob's PIN: ${bobPinResult.status} ${JSON.stringify(bobPinResult.error)}`);

  supervisorContext = await browser.newContext();
  supervisorPage = await supervisorContext.newPage();
  await supervisorPage.goto('/login');
  await supervisorPage.getByLabel('Email').fill(TEST_USERS.supervisor.email);
  await supervisorPage.getByRole('textbox', { name: 'Password' }).fill(TEST_USERS.supervisor.password);
  await supervisorPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await supervisorPage.waitForURL(`**${TEST_USERS.supervisor.dashboardPath}`);

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
  await supervisorContext?.close();
  await terminalContext?.close();
});

test.describe.serial('POS-PERF-P30R — session security real-browser verification', () => {
  test.describe.configure({ timeout: 120_000 });

  test('1. Supervisor sees staff PIN status and sets a PIN through the actual UI', async () => {
    await supervisorPage.goto('/supervisor/employees', { waitUntil: 'networkidle' });
    const row = supervisorPage.getByRole('row', { name: /Jenny Santos/ }).first();
    await expect(row).toBeVisible({ timeout: NAV_TIMEOUT });

    await row.getByRole('button').last().click();
    await supervisorPage.getByRole('menuitem', { name: 'Manage Inventory/POS PIN' }).click();

    const dialog = supervisorPage.getByRole('dialog');
    await expect(dialog).toBeVisible();

    jennyPin = String(Math.floor(100000 + Math.random() * 900000));
    await dialog.getByLabel('New PIN (4-6 digits)').fill(jennyPin);
    await dialog.getByLabel('Confirm PIN').fill(jennyPin);
    await dialog.getByRole('button', { name: /Save PIN|Save Reset PIN/ }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });

    await expect(row.getByText('Active').first()).toBeVisible({ timeout: 10_000 });
  });

  test('2. A wrong PIN fails without unlocking POS', async () => {
    await terminalPage.goto('/branch/terminal', { waitUntil: 'networkidle' });
    await expect(terminalPage.getByText("Who's working?")).toBeVisible({ timeout: NAV_TIMEOUT });

    await terminalPage.getByPlaceholder('Enter 4-6 digit PIN').fill('000000');
    await terminalPage.getByRole('button', { name: 'Verify PIN' }).click();
    await expect(terminalPage.getByText('Invalid PIN')).toBeVisible({ timeout: 10_000 });

    // Never reveals a resolved identity, and the catalog/clock-in flow never appears.
    await expect(terminalPage.getByText(/Continue as/)).toHaveCount(0);
    await expect(terminalPage.getByText("Who's working?")).toBeVisible();
  });

  test('3. Correct PIN identifies the staff member and Clock In opens the terminal', async () => {
    await terminalPage.getByPlaceholder('Enter 4-6 digit PIN').fill(jennyPin);
    await terminalPage.getByRole('button', { name: 'Verify PIN' }).click();
    await expect(terminalPage.getByText('Jenny Santos')).toBeVisible({ timeout: 10_000 });

    await terminalPage.getByRole('button', { name: /Continue as Jenny/ }).click();
    await expect(terminalPage.getByText('Clock In to Start Selling')).toBeVisible({ timeout: NAV_TIMEOUT });

    await terminalPage.getByRole('button', { name: 'Clock In', exact: true }).click();
    await expect(terminalPage.getByText('Current Cashier:')).toBeVisible({ timeout: NAV_TIMEOUT });
    await expect(terminalPage.getByText('Jenny Santos')).toBeVisible();
  });

  test('4. Already-clocked-in staff continues without a duplicate attendance record', async () => {
    await terminalPage.reload({ waitUntil: 'networkidle' });
    // The terminal-operator sessionStorage hint re-validates against live
    // attendance and restores Jenny directly — "Who's working?" must never
    // flash back up for a still-clocked-in operator (Task 209.27).
    await expect(terminalPage.getByText('Current Cashier:')).toBeVisible({ timeout: NAV_TIMEOUT });
    await expect(terminalPage.getByText('Jenny Santos')).toBeVisible();
    await expect(terminalPage.getByText("Who's working?")).toHaveCount(0);

    const records = await authedGet<{ records: { clock_out_server_time: string | null }[] }>(
      terminalPage.request,
      `/api/attendance/employee/${jennyUserId}?limit=5`,
      branchAccessToken,
    );
    const openRecords = records.data?.records.filter((r) => r.clock_out_server_time === null) ?? [];
    expect(openRecords.length).toBe(1);
  });

  test('5. Switch Cashier swaps identity without clocking out the prior cashier', async () => {
    await terminalPage.getByRole('button', { name: 'Switch Cashier' }).click();
    await expect(terminalPage.getByText("Who's working?")).toBeVisible({ timeout: 10_000 });

    // Jenny's attendance must still be open — locking/switching is never a clock-out.
    const afterSwitch = await authedGet<{ records: { clock_out_server_time: string | null }[] }>(
      terminalPage.request,
      `/api/attendance/employee/${jennyUserId}?limit=5`,
      branchAccessToken,
    );
    expect(afterSwitch.data?.records.filter((r) => r.clock_out_server_time === null).length).toBe(1);

    await terminalPage.getByPlaceholder('Enter 4-6 digit PIN').fill(bobPin);
    await terminalPage.getByRole('button', { name: 'Verify PIN' }).click();
    await expect(terminalPage.getByText(/Bob Cashier/)).toBeVisible({ timeout: 10_000 });
    await terminalPage.getByRole('button', { name: /Continue as Bob/ }).click();

    await expect(terminalPage.getByText('Clock In to Start Selling')).toBeVisible({ timeout: NAV_TIMEOUT });
    await terminalPage.getByRole('button', { name: 'Clock In', exact: true }).click();
    await expect(terminalPage.getByText(/Bob Cashier/)).toBeVisible({ timeout: NAV_TIMEOUT });

    // Both are now independently clocked in — switching never clocked Jenny out.
    const final = await authedGet<{ records: { clock_out_server_time: string | null }[] }>(
      terminalPage.request,
      `/api/attendance/employee/${jennyUserId}?limit=5`,
      branchAccessToken,
    );
    expect(final.data?.records.filter((r) => r.clock_out_server_time === null).length).toBe(1);
  });

  test('6. Deactivating a PIN rejects a new verification attempt with it', async () => {
    await supervisorPage.goto('/supervisor/employees', { waitUntil: 'networkidle' });
    const row = supervisorPage.getByRole('row', { name: /Jenny Santos/ }).first();
    await row.getByRole('button').last().click();
    await supervisorPage.getByRole('menuitem', { name: 'Manage Inventory/POS PIN' }).click();

    const dialog = supervisorPage.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Deactivate PIN' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
    await expect(row.getByText('Inactive').first()).toBeVisible({ timeout: 10_000 });

    // A fresh verify-pos attempt with the now-deactivated PIN must fail
    // generically — never reveal that the PIN itself used to be valid.
    const result = await authedPost(
      terminalPage.request,
      appBaseURL,
      `/api/staff-pin/branches/${branchId}/verify-pos`,
      branchAccessToken,
      { pin: jennyPin },
    );
    expect(result.status).toBe(401);
    expect((result.error as { code?: string } | null)?.code).toBe('INVALID_PIN');
  });

  test('7. Cross-branch management access is denied', async () => {
    // branch@potatocorner.test is scoped to MAIN01 only — verify-pos against
    // a branch it has no assignment to must be rejected before any PIN check.
    const result = await authedPost(
      terminalPage.request,
      appBaseURL,
      `/api/staff-pin/branches/${otherBranchId}/verify-pos`,
      branchAccessToken,
      { pin: bobPin },
    );
    expect([401, 403]).toContain(result.status);

    // An inventory-purpose verify against a branch Bob isn't assigned to
    // must also be rejected, regardless of which branch-scoped actor asks.
    const crossVerify = await authedPost(
      terminalPage.request,
      appBaseURL,
      `/api/staff-pin/branches/${otherBranchId}/verify`,
      branchAccessToken,
      { pin: bobPin, operation: 'WASTE' },
    );
    expect([401, 403]).toContain(crossVerify.status);
  });

  test('8. An inventory-purpose verification token cannot unlock POS cashier selection', async () => {
    // Uses adminAccessToken (not branchAccessToken) for the inventory-side
    // verify call — the PIN brute-force limiter is keyed per (branchId,
    // actor) (rate-limiter.ts's staffPinVerifyKey), and tests 2/3/5/6/7
    // above already spent branch@'s own budget against this branch in this
    // 5-minute window. consumePosVerification only checks the token's
    // branchId, never which actor originally minted it, so this still
    // exercises the same purpose-separation path end-to-end.
    const inventoryVerify = await authedPost<{ verification_token: string }>(
      terminalPage.request,
      appBaseURL,
      `/api/staff-pin/branches/${branchId}/verify`,
      adminAccessToken,
      { pin: bobPin, operation: 'WASTE' },
    );
    expect(inventoryVerify.status).toBe(200);
    const inventoryToken = inventoryVerify.data?.verification_token;
    expect(inventoryToken).toBeTruthy();

    const selectAttempt = await authedPost(
      terminalPage.request,
      appBaseURL,
      '/api/auth/select-employee',
      branchAccessToken,
      { verification_token: inventoryToken, device_id: crypto.randomUUID() },
    );
    expect(selectAttempt.status).toBe(422);
    expect((selectAttempt.error as { code?: string } | null)?.code).toBe('VERIFICATION_CONTEXT_MISMATCH');
  });

  // POS-PERF-P30R — IDLE_LOCK_MS (terminal/page.tsx) is a real 5-minute wait,
  // not mockable from outside the component, so this is a genuine timed
  // wait rather than a fast synthetic one. Provisions Jenny's PIN directly
  // via the admin API (test 6 above deactivated it, and re-covering the
  // Supervisor UI path again here would be redundant with test 1).
  test('9. Idle lock requires a PIN to unlock, and never clocks the cashier out', async () => {
    test.setTimeout(7 * 60 * 1000);
    const freshPin = String(Math.floor(100000 + Math.random() * 900000));
    const setResult = await authedPost(terminalPage.request, appBaseURL, `/api/staff-pin/${jennyUserId}/pin`, adminAccessToken, { pin: freshPin });
    expect(setResult.status).toBe(200);

    await terminalPage.goto('/branch/terminal', { waitUntil: 'networkidle' });
    await expect(terminalPage.getByText("Who's working?")).toBeVisible({ timeout: NAV_TIMEOUT });
    await terminalPage.getByPlaceholder('Enter 4-6 digit PIN').fill(freshPin);
    await terminalPage.getByRole('button', { name: 'Verify PIN' }).click();
    await expect(terminalPage.getByText('Jenny Santos')).toBeVisible({ timeout: 10_000 });
    await terminalPage.getByRole('button', { name: /Continue as Jenny/ }).click();
    await expect(terminalPage.getByText('Clock In to Start Selling')).toBeVisible({ timeout: NAV_TIMEOUT });
    await terminalPage.getByRole('button', { name: 'Clock In', exact: true }).click();
    await expect(terminalPage.getByText('Current Cashier:')).toBeVisible({ timeout: NAV_TIMEOUT });

    // No pointer/key activity at all for IDLE_LOCK_MS (documented default:
    // 5 minutes) + a margin for scheduling jitter — the idle-lock effect in
    // page.tsx arms on mount and on every reset event, so simply not
    // dispatching any of those events for long enough must trigger it.
    await terminalPage.waitForTimeout(5 * 60 * 1000 + 20_000);

    await expect(terminalPage.getByText("Who's working?")).toBeVisible({ timeout: 10_000 });
    // Idle lock is a terminal-local lock, never a clock-out — attendance
    // must still be open after the lock fires.
    const stillClockedIn = await authedGet<{ records: { clock_out_server_time: string | null }[] }>(
      terminalPage.request,
      `/api/attendance/employee/${jennyUserId}?limit=3`,
      branchAccessToken,
    );
    expect(stillClockedIn.data?.records.filter((r) => r.clock_out_server_time === null).length).toBe(1);

    // The idle-locked screen must require the PIN again — a wrong PIN still fails here too.
    await terminalPage.getByPlaceholder('Enter 4-6 digit PIN').fill('000000');
    await terminalPage.getByRole('button', { name: 'Verify PIN' }).click();
    await expect(terminalPage.getByText('Invalid PIN')).toBeVisible({ timeout: 10_000 });
  });
});
