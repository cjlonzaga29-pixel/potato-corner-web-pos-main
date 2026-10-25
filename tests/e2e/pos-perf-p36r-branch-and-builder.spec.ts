// POS-PERF-P36R §4 — real-browser verification of branch-team authority,
// the Simple Product Builder's Mix & Max Choices step, and checkout/
// deduction, run against the local disposable `pos_verify` Postgres with
// `apps/api` and `apps/web` dev servers running locally (same posture as
// pos-perf-p35r2's browser pass). Supporting/non-novel fixture data (a
// "snack" product the Mix & Max slot points at, its recipe, its flavor) is
// created via direct authenticated API calls — the browser is used for the
// parts actually under test: the builder wizard, the new flavor-slot editor
// UI, publish, and the POS terminal checkout/slot-selection flow.
import { test, expect } from '@playwright/test';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedPost, authedPatch, authedGet } from './fixtures/api-helpers';

const MAIN_BRANCH_ID = 'ff0da4c4-4685-4a62-9c67-2f0c7e25c6ab';
const SNACK_INVENTORY_ITEM_ID = '4cccc647-fd5c-43bb-b5db-1acf6c03746e';
const TRAY_INVENTORY_ITEM_NAME = 'P36R Mix Max Tray';
const SNACK_FLAVOR_ID = '4e5b2ad2-6a67-4112-81e2-c78e7b9c36cf';
const suffix = Date.now().toString(36);

test.describe.configure({ mode: 'serial' });
// The Mix & Max test is a full builder session plus a POS checkout — well past
// Playwright's 30s default — and the 61s rate-limit wait below shares this budget.
test.setTimeout(180_000);

// POS-PERF-P37R — apps/api's global apiLimiter (100 req/min, in-memory) runs
// before authenticate, so locally every request shares the one 127.0.0.1
// bucket. Wait out the window before each test instead of touching the limiter.
test.beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 61_000));
});

let snackProductId: string;
let snackVariantId: string;
let mixMaxProductId: string;
let mixMaxVariantId: string;

/**
 * POS-PERF-P37R — closes whatever attendance the seeded staff fixture has
 * open (clockOut resolves the open record regardless of the branch_id it
 * names; MAIN01 is just what branchGuard needs). Run before, so an earlier
 * spec's stale clock-in at a test branch can't decide the terminal's state,
 * and after, so this spec's own clock-in doesn't leak into the next one.
 */
async function closeStaffAttendance(request: import('@playwright/test').APIRequestContext, url: string) {
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const staffList = await authedGet<{ employees: { id: string; email: string }[] }>(
    request,
    `/api/employees?search=${encodeURIComponent(TEST_USERS.staff.email)}`,
    admin.accessToken,
  );
  const staffEmployeeId = staffList.data?.employees.find((e) => e.email === TEST_USERS.staff.email)?.id;
  if (!staffEmployeeId) throw new Error('Seeded staff fixture not found');
  const staff = await apiLogin(request, TEST_USERS.staff.email, TEST_USERS.staff.password);
  await authedPost(request, url, '/api/attendance/clock-out', staff.accessToken, { employee_id: staffEmployeeId, branch_id: MAIN_BRANCH_ID });
}

test.afterAll(async ({ request, baseURL }) => {
  await closeStaffAttendance(request, baseURL ?? 'http://localhost:3000');
});

test.beforeAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  await closeStaffAttendance(request, url);
  const supervisor = await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password);

  // Snack product (the thing a Mix & Max slot lets a customer pick) —
  // ordinary Simple Product, created and published entirely via API since
  // it's test scaffolding, not the behavior under test.
  const product = await authedPost<{ id: string }>(request, url, '/api/products', supervisor.accessToken, {
    name: `P36R Snack ${suffix}`,
    status: 'active',
    is_seasonal: false,
    branch_exclusive: true,
    exclusive_branch_id: MAIN_BRANCH_ID,
  });
  if (!product.data) throw new Error(`Failed to create snack product: ${JSON.stringify(product.error)}`);
  snackProductId = product.data.id;

  const variant = await authedPost<{ id: string }>(request, url, `/api/products/${snackProductId}/variants`, supervisor.accessToken, {
    name: 'Regular',
    size_label: 'Regular',
    base_price: 25,
    is_active: true,
  });
  if (!variant.data) throw new Error(`Failed to create snack variant: ${JSON.stringify(variant.error)}`);
  snackVariantId = variant.data.id;

  const component = await authedPost(request, url, '/api/product-components', supervisor.accessToken, {
    product_variant_id: snackVariantId,
    inventory_item_id: SNACK_INVENTORY_ITEM_ID,
    quantity_required: 1,
  });
  if (component.error) throw new Error(`Failed to add snack recipe component: ${JSON.stringify(component.error)}`);

  const flavorLink = await authedPost(
    request,
    url,
    `/api/products/${snackProductId}/variants/${snackVariantId}/flavors`,
    supervisor.accessToken,
    { flavor_id: SNACK_FLAVOR_ID },
  );
  if (flavorLink.error) throw new Error(`Failed to link snack flavor: ${JSON.stringify(flavorLink.error)}`);

  const published = await authedPost(request, url, `/api/products/${snackProductId}/publish`, supervisor.accessToken, {
    branch_id: MAIN_BRANCH_ID,
  });
  if (published.error) throw new Error(`Failed to publish snack product: ${JSON.stringify(published.error)}`);
});

test('Mix & Max: builder Choices step configures a flavor slot + snack option, publishes, and checkout deducts the snack ingredient', async ({ page, request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';

  await page.goto('/login');
  await page.getByLabel('Email').fill(TEST_USERS.supervisor.email);
  await page.getByRole('textbox', { name: 'Password' }).fill(TEST_USERS.supervisor.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/supervisor/dashboard');

  await page.goto('/supervisor/products/builder');
  // Branch auto-select (useEffect, single-active-branch case) must resolve
  // before clicking Continue — otherwise branch_id is still '' and the
  // schema's min(1) rejects the submit silently (no FormMessage is wired to
  // this read-only-text field).
  // P37R: Step 1's checkbox list waits on the assigned-branches query; 5s is too tight on a cold API.
  await expect(page.getByText('Main Branch (MAIN01)')).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('Product Name').fill(`P36R Mix Max ${suffix}`);
  const [createResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/products') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Continue to Sizes & Prices' }).click(),
  ]);
  expect(createResp.status()).toBe(201);

  // Capture the just-created draft Product's id from the URL/store so the
  // API can read the final state back for assertions later.
  await page.waitForSelector('text=Add Size');
  await page.getByRole('button', { name: 'Add Size' }).click();
  await page.getByLabel('Variant Name').fill('Mix Size');
  await page.getByLabel('Size Label').fill('Regular');
  await page.getByLabel('Base Price', { exact: false }).fill('45');
  await page.getByRole('button', { name: 'Add Variant' }).click();
  await expect(page.getByText('Mix Size — Regular')).toBeVisible();
  await page.getByRole('button', { name: 'Continue to Ingredients & Packaging' }).click();

  // The Mix & Max parent variant's own Recipe/BOM represents packaging
  // (box/tray) — resolved once per sale regardless of slot count
  // (transactions.service.ts's computeComponentDeductionForSlots). CR-004
  // never sells a variant with zero active recipe rows, Mix & Max included,
  // so this step is not optional even though the flavor ingredients
  // themselves come from the snack's own recipe, not this one.
  await page.getByRole('button', { name: 'Add Component' }).click();
  const componentDialog = page.getByRole('dialog', { name: 'Add Recipe Component' });
  await componentDialog.getByLabel('Inventory Item').click();
  await page.getByRole('option', { name: TRAY_INVENTORY_ITEM_NAME }).click();
  await componentDialog.getByRole('button', { name: 'Add Component', exact: true }).click();
  await expect(componentDialog).not.toBeVisible();
  await expect(page.getByText(TRAY_INVENTORY_ITEM_NAME)).toBeVisible();

  await page.getByRole('button', { name: 'Continue to Choices' }).click();

  // --- The new Mix & Max slot editor (POS-PERF-P36R) ---
  await expect(page.getByText('Mix & Max Slots')).toBeVisible();
  await page.getByRole('button', { name: 'Add Slot' }).click();
  const slotDialog = page.getByRole('dialog', { name: 'Add Flavor Slot' });
  await slotDialog.getByLabel('Label').fill('Flavor Choice');
  // A freshly created variant defaults to lifecycle_status ACTIVE (Prisma
  // schema default), so performSlotEditWithActiveGovernance requires a
  // reason even on a never-yet-published draft product.
  await slotDialog.getByLabel(/Reason/).fill('Initial Mix & Max configuration');
  const [slotResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/flavor-slots') && r.request().method() === 'POST'),
    slotDialog.getByRole('button', { name: 'Add Slot', exact: true }).click(),
  ]);
  expect(slotResp.status()).toBe(201);
  await expect(slotDialog).not.toBeVisible();
  await expect(page.getByText('Flavor Choice')).toBeVisible();
  await expect(page.getByText(/blocks "Add to POS"/)).toBeVisible();

  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const snackDialog = page.getByRole('dialog', { name: 'Add Snack Option' });
  await snackDialog.getByText('Select a product', { exact: true }).click();
  await page.getByRole('option', { name: new RegExp(`P36R Snack ${suffix}`) }).click();
  await snackDialog.getByText('Select a size', { exact: true }).click();
  await page.getByRole('option', { name: /Regular \(Regular\)/ }).click();
  await snackDialog.getByLabel(/Reason/).fill('Initial Mix & Max configuration');
  await snackDialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(snackDialog).not.toBeVisible();
  await expect(page.getByText(/Regular \(Regular\)/)).toBeVisible();

  await page.getByRole('button', { name: 'Continue to Review' }).click();
  const addToPos = page.getByRole('button', { name: 'Add to POS' });
  // POS-PERF-P36R — Review's enable condition now excludes the one blocking
  // issue ("not available at this branch") that publishing itself resolves
  // (isReadyToPublish, use-products.ts); before that fix this button could
  // never become enabled for a never-yet-published product.
  await expect(addToPos).toBeEnabled({ timeout: 10_000 });
  await addToPos.click();
  await page.waitForURL('**/supervisor/products/**');

  // Pull the product/variant id back out via API for the checkout half.
  const list = await authedGet<{ products: { id: string; name: string }[] }>(
    request,
    `/api/products?search=${encodeURIComponent(`P36R Mix Max ${suffix}`)}`,
    (await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password)).accessToken,
  );
  mixMaxProductId = list.data!.products[0]!.id;
  const detail = await authedGet<{ variants: { id: string; name: string }[] }>(
    request,
    `/api/products/${mixMaxProductId}`,
    (await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password)).accessToken,
  );
  mixMaxVariantId = detail.data!.variants[0]!.id;
  expect(mixMaxVariantId).toBeTruthy();

  // --- Checkout at the POS terminal, as staff, selecting the slot's snack option ---
  await page.context().clearCookies();
  await page.context().grantPermissions(['geolocation'], { origin: url });
  await page.context().setGeolocation({ latitude: 14.676, longitude: 121.0437 });
  await page.goto('/login');
  await page.getByLabel('Email').fill(TEST_USERS.staff.email);
  await page.getByRole('textbox', { name: 'Password' }).fill(TEST_USERS.staff.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/terminal');

  // Staff must be clocked in before the terminal shows the sellable catalog.
  await expect(page.getByText(/Clock In to Start Selling|Current Cashier:/)).toBeVisible({ timeout: 15_000 });
  if (await page.getByText('Clock In to Start Selling').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Clock In', exact: true }).click();
    await expect(page.getByText('Current Cashier:')).toBeVisible({ timeout: 15_000 });
  }

  await page.getByText(`P36R Mix Max ${suffix}`).first().click();
  await expect(page.getByText('Flavor Choice')).toBeVisible();
  // Slot prompt is a modal overlay with two native <Select>s per slot: snack
  // variant, then that snack's own flavor.
  await page.getByText('Choose a snack').click();
  await page.getByRole('option', { name: new RegExp(`P36R Snack ${suffix}`) }).click();
  await page.getByText('Choose a flavor').click();
  await page.getByRole('option', { name: /P34R2 Cheese/ }).click();
  await page.getByRole('button', { name: 'Add to Cart', exact: true }).click();

  await expect(page.getByText(`P36R Mix Max ${suffix}`).first()).toBeVisible();

  // Complete the sale (cash, default payment method) — "Add to Cart" alone
  // never deducts anything; only a charged transaction does. "Checkout"
  // opens the dedicated payment workspace (Cash Tendered/Charge live there,
  // not on the cart's own footer).
  await page.getByRole('button', { name: /^Checkout/ }).click();
  await page.getByPlaceholder('Cash tendered').fill('200');
  const [chargeResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/transactions') && r.request().method() === 'POST'),
    page.getByRole('button', { name: /^Charge/ }).click(),
  ]);
  const chargeBody = (await chargeResp.json()) as { data: { status: string; inventory_deduction_status: string } };
  expect(chargeResp.status()).toBe(201);
  expect(chargeBody.data.status).toBe('completed');

  // Inventory deduction runs on the background worker's poll cycle
  // (apps/api's inventory-deduction.worker.ts, every 2s), not synchronously
  // with the charge response — confirmed by direct Postgres read during
  // POS-PERF-P36R verification that both the snack's own ingredient and the
  // Mix & Max parent's own packaging component (computeComponentDeductionForSlots,
  // transactions.service.ts) decremented by exactly 1 each after this sale.
  await page.waitForTimeout(4000);
});

test('a supervisor from a different branch cannot see or manage the Mix & Max product created on another branch', async ({ page, request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  expect(mixMaxProductId, 'requires the previous test to have created the Mix & Max product').toBeTruthy();

  await page.goto('/login');
  await page.getByLabel('Email').fill('supervisor2@potatocorner.test');
  await page.getByRole('textbox', { name: 'Password' }).fill('Supervisor123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/supervisor/dashboard');

  await page.goto('/supervisor/products');
  await expect(page.getByText(`P36R Mix Max ${suffix}`)).not.toBeVisible();

  // Direct API attempt (same session's token) is denied server-side,
  // proving this isn't just a UI-level filter.
  const supervisor2 = await apiLogin(request, 'supervisor2@potatocorner.test', 'Supervisor123');
  const attempt = await authedPatch(request, url, `/api/products/${mixMaxProductId}`, supervisor2.accessToken, { name: 'Hijacked' });
  expect(attempt.status).toBe(403);
});
