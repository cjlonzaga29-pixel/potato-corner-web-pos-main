// POS-PERF-P69R — an open POS terminal follows supervisor catalog changes
// without a reload, on the LOCAL P62 stack (production builds, service worker
// active). Supervisor work goes through the real Supervisor screens in a
// separate browser profile (another session); the terminal is never reloaded
// or navigated while an update is measured. Database reads are read-only and
// refuse anything but the local p62_* database.
//
//   P62_ROOT_WIN=C:/p69rs P62_WEB_URL=http://localhost:56723 node tests/e2e/manual/p69/realtime.mjs
import fs from 'node:fs';
import { WEB, ROOT, openProfile, login, shot, dumpAria, check, record, saveResults, sleep, waitForController } from '../p62/lib.mjs';

const PIN_ANA = process.env.P62_PIN_ANA;
const B_PASSWORD = process.env.P69_BRANCH_B_PASSWORD;
if (!PIN_ANA || !B_PASSWORD) throw new Error('Set P62_PIN_ANA and P69_BRANCH_B_PASSWORD from the stack env file');
const fixtures = JSON.parse(fs.readFileSync(`${ROOT}/p69-fixtures.json`, 'utf8'));
const { prisma } = await import('../p62/db.mjs');
const TAG = Date.now().toString(36).slice(-4);
const TYPE = `Live ${TAG}`;
const RENAMED = `Live2 ${TAG}`;
const OFFLINE_NAME = `Live3 ${TAG}`;

const typeTab = (page, name) => page.getByRole('tablist', { name: 'Filter by product type' }).getByRole('tab', { name, exact: true });
const tabNames = (page) => page.getByRole('tablist', { name: 'Filter by product type' }).getByRole('tab').allTextContents().catch(() => []);
const latencies = {};

/** Terminal catalog GETs (page or service worker), excluding Refresh's one-off confirmed reads. */
function countCatalogRequests(context, label) {
  const counter = { label, count: 0, urls: [] };
  context.on('request', (request) => {
    const url = request.url();
    if (request.method() === 'GET' && url.includes('/api/products/catalog?branch_id=') && !url.includes('fresh=')) {
      counter.count += 1;
      counter.urls.push(new URL(url).searchParams.get('branch_id'));
    }
  });
  return counter;
}

/** Polls `condition` on the open page every 100 ms; returns ms from `since` until true, or null. */
async function waitUntil(condition, since, timeoutMs = 180_000) {
  while (Date.now() - since < timeoutMs) {
    if (await condition().catch(() => false)) return Date.now() - since;
    await sleep(100);
  }
  return null;
}

async function startCashier(page) {
  const pin = page.getByRole('textbox', { name: 'Staff PIN' });
  if (!(await pin.isVisible().catch(() => false))) return;
  await pin.fill(PIN_ANA);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue as Ana' }).click();
}

async function openTerminal(page) {
  await page.goto(`${WEB}/branch/terminal`);
  await page.waitForLoadState('domcontentloaded');
  await sleep(1500);
  await startCashier(page);
  await page.getByRole('tab', { name: 'Products' }).click().catch(() => {});
  await page.getByTestId('pos-product-grid').waitFor({ timeout: 60_000 });
}

async function mainBranchName() {
  return (await prisma.branch.findUniqueOrThrow({ where: { id: fixtures.mainBranchId } })).name;
}

/** Puts the supervisor's branch switcher on MAIN01 (the type is scoped there only). */
async function supervisorAtMain(page) {
  await page.goto(`${WEB}/supervisor/products`);
  const name = await mainBranchName();
  if (await page.getByText(`At ${name}`).isVisible().catch(() => false)) return;
  const switcher = page.getByRole('button', { name: /^P62 Branch \d$|^Main/ }).first();
  await switcher.waitFor({ timeout: 30_000 });
  await switcher.click();
  await page.getByRole('menuitem', { name: new RegExp(`^${name} `) }).click();
  await page.getByText(`At ${name}`).waitFor({ timeout: 30_000 });
}

async function createType(page) {
  await page.goto(`${WEB}/supervisor/products`);
  await page.getByRole('button', { name: 'Create Product Type' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create Product Type' });
  await dialog.getByLabel('Name', { exact: true }).fill(TYPE);
  const name = await mainBranchName();
  await dialog.getByRole('checkbox', { name, exact: true }).check();
  for (const box of await dialog.getByRole('checkbox').all()) {
    if ((await box.getAttribute('aria-label')) !== name) await box.uncheck();
  }
  const committed = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/product-types', { timeout: 60_000 });
  const clickedAt = Date.now();
  await dialog.getByRole('button', { name: 'Create Product Type' }).click();
  const response = await committed;
  return { clickedAt, committedAt: Date.now(), ok: response.ok() };
}

async function assignProduct(page) {
  await page.goto(`${WEB}/supervisor/products/builder?product_id=${fixtures.campaignProductId}`);
  await page.getByRole('heading', { name: 'Edit Product' }).waitFor({ timeout: 30_000 });
  const typeField = page.getByRole('combobox', { name: 'Product type' });
  if (!(await typeField.isVisible().catch(() => false))) await page.getByRole('button', { name: '1. Product Details' }).click();
  await typeField.click();
  await page.getByRole('option', { name: TYPE }).click();
  const committed = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/products/${fixtures.campaignProductId}`, { timeout: 60_000 });
  const clickedAt = Date.now();
  await page.getByRole('button', { name: 'Continue to Sizes & Prices' }).click();
  const response = await committed;
  return { clickedAt, committedAt: Date.now(), ok: response.ok() };
}

async function renameType(page, typeId, from, to) {
  await supervisorAtMain(page);
  await page.goto(`${WEB}/supervisor/products?type=${typeId}`);
  await page.getByRole('button', { name: 'Edit Type' }).click();
  const dialog = page.getByRole('dialog', { name: `Edit ${from}` });
  await dialog.getByLabel('Name', { exact: true }).fill(to);
  const committed = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/product-types/${typeId}`, { timeout: 60_000 });
  const clickedAt = Date.now();
  await dialog.getByRole('button', { name: 'Save Changes' }).click();
  const response = await committed;
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  return { clickedAt, committedAt: Date.now(), ok: response.ok() };
}

function measure(name, change, ms) {
  latencies[name] = { fromClickMs: ms === null ? null : ms + (change.committedAt - change.clickedAt), fromCommitMs: ms };
  check(`live: ${name} reaches the open terminal without a reload`, change.ok && ms !== null, latencies[name]);
}

async function offlineDb(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('potato-corner-pos');
        open.onerror = () => resolve({ error: 'open failed' });
        open.onsuccess = () => {
          const db = open.result;
          const counts = {};
          const names = [...db.objectStoreNames];
          let left = names.length;
          if (left === 0) resolve(counts);
          for (const name of names) {
            const request = db.transaction(name, 'readonly').objectStore(name).count();
            request.onsuccess = () => {
              counts[name] = request.result;
              left -= 1;
              if (left === 0) resolve(counts);
            };
            request.onerror = () => {
              left -= 1;
              if (left === 0) resolve(counts);
            };
          }
        };
      }),
  );
}

const supCtx = await openProfile(`p69rsup-${TAG}`);
const termCtx = await openProfile(`p69rterm-${TAG}`);
const bCtx = await openProfile(`p69rb-${TAG}`);
const termRequests = countCatalogRequests(termCtx, 'terminal A');
const bRequests = countCatalogRequests(bCtx, 'terminal B');

try {
  // Terminal A (branch account, cashier Ana) and terminal B (another branch) stay open.
  const term = termCtx.pages()[0] ?? (await termCtx.newPage());
  await login(term, 'branch');
  const sw = await waitForController(term);
  record('terminal A: service worker controls the page', Boolean(sw), { sw: sw?.split('/').pop() });
  await openTerminal(term);
  check('terminal A: Refresh products is offered', await term.getByRole('button', { name: 'Refresh products' }).isVisible());

  const b = bCtx.pages()[0] ?? (await bCtx.newPage());
  await b.goto(`${WEB}/login`);
  await b.getByLabel('Email').fill('branch-b-p69@potatocorner.test');
  await b.getByRole('textbox', { name: 'Password' }).fill(B_PASSWORD);
  await b.getByRole('button', { name: 'Sign in', exact: true }).click();
  await b.waitForURL('**/branch/dashboard', { timeout: 60_000 });
  await b.goto(`${WEB}/branch/terminal`);
  await sleep(4000);

  const sup = supCtx.pages()[0] ?? (await supCtx.newPage());
  await login(sup, 'supervisor');
  await sleep(3000);
  const aBefore = termRequests.count;
  const bBefore = bRequests.count;

  // 1. Create a type scoped to branch A.
  const created = await createType(sup);
  measure('type create', created, await waitUntil(async () => (await tabNames(term)).includes(TYPE), created.committedAt));
  const type = await prisma.productType.findFirst({ where: { name: TYPE } });

  // 2. Assign a product to it through the product editor.
  const assigned = await assignProduct(sup);
  const badge = () => term.getByRole('button', { name: /^P69 Campaign Fries/ }).getByTestId('product-card-type').textContent();
  measure('product type reassignment', assigned, await waitUntil(async () => (await badge()) === TYPE, assigned.committedAt));

  // 3. Rename it, with the custom tab selected on the terminal.
  await typeTab(term, TYPE).click();
  const renamed = await renameType(sup, type.id, TYPE, RENAMED);
  measure('type rename', renamed, await waitUntil(async () => (await tabNames(term)).includes(RENAMED) && !(await tabNames(term)).includes(TYPE), renamed.committedAt));
  check('rename keeps the terminal\'s selected type tab', (await typeTab(term, RENAMED).getAttribute('data-state')) === 'active');
  await sleep(2500);
  const aDuring = termRequests.count - aBefore;
  const bDuring = bRequests.count - bBefore;
  check('requests: terminal A refetched the catalog about once per change, no storm (3 changes)', aDuring >= 3 && aDuring <= 6, { catalogGets: aDuring });
  check('isolation: terminal B fetched nothing for branch A\'s changes', bDuring === 0, { catalogGets: bDuring });
  const bTabs = await tabNames(b);
  check('isolation: terminal B shows neither branch-A type name', !bTabs.includes(TYPE) && !bTabs.includes(RENAMED), { bTabs });
  check('isolation: B\'s requests were only for branch B', bRequests.urls.every((id) => id === fixtures.branchBId), { ids: [...new Set(bRequests.urls)].length });
  await shot(term, 'p69r-live');

  // 4. Disconnect the terminal, change the type meanwhile, reconnect.
  await termCtx.setOffline(true);
  await sleep(2000);
  await typeTab(term, RENAMED).click();
  const offlineNames = await term.getByTestId('pos-product-grid').getByRole('button').evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') ?? '').split(',')[0]));
  check('offline: the open terminal keeps filtering from its saved catalog', offlineNames.length === 1 && offlineNames[0] === 'P69 Campaign Fries', { offlineNames });
  check('offline: Refresh products is disabled', await term.getByRole('button', { name: 'Refresh products' }).isDisabled());
  const missed = await renameType(sup, type.id, RENAMED, OFFLINE_NAME);
  await sleep(5000);
  const sawWhileOffline = (await tabNames(term)).includes(OFFLINE_NAME);
  record('offline: (info) change seen while the terminal was offline', true, { sawWhileOffline });
  const reconnectedAt = Date.now();
  await termCtx.setOffline(false);
  const recovered = await waitUntil(async () => (await tabNames(term)).includes(OFFLINE_NAME), reconnectedAt);
  latencies['missed change after reconnect'] = { fromReconnectMs: recovered };
  check('reconnect: a change made while disconnected appears after reconnecting, without a reload', missed.ok && recovered !== null, latencies['missed change after reconnect']);

  // 5. Refresh products keeps the cart.
  await typeTab(term, 'All Types').click();
  await term.getByRole('button', { name: /^P69 Campaign Fries/ }).click();
  const confirmed = term.waitForResponse((r) => r.url().includes('/api/products/catalog?branch_id=') && r.url().includes('fresh='), { timeout: 60_000 });
  await term.getByRole('button', { name: 'Refresh products' }).click();
  const refreshStatus = (await confirmed).status();
  await term.getByText('Products refreshed').waitFor({ timeout: 30_000 }).catch(() => {});
  check('refresh: Refresh products reads the catalog from the network and keeps the cart line', refreshStatus === 200 && (await term.getByRole('button', { name: /^Checkout/ }).isEnabled()), { refreshStatus });

  // 6. One local sale: total and stock deduction unchanged.
  const itemIds = fixtures.itemIds.split(',');
  const stockOf = async (itemId) => Number((await prisma.inventoryStock.findFirst({ where: { branchId: fixtures.mainBranchId, inventoryItemId: itemId } }))?.quantityOnHand ?? NaN);
  const before = await Promise.all(itemIds.map(stockOf));
  const since = new Date(Date.now() - 1000);
  await term.getByRole('button', { name: /^Checkout/ }).click();
  await term.getByRole('dialog', { name: 'Checkout' }).waitFor();
  await term.getByPlaceholder('Cash tendered').fill('100');
  await term.getByRole('button', { name: /^Charge/ }).click();
  await term.getByText('Sale completed').waitFor({ timeout: 60_000 });
  await term.getByRole('button', { name: 'Next Customer' }).click().catch(() => {});
  const sales = await prisma.transaction.findMany({ where: { branchId: fixtures.mainBranchId, createdAt: { gte: since } } });
  check('checkout: one sale, total ₱89.00', sales.length === 1 && Number(sales[0].totalAmount) === 89, { total: sales[0] && Number(sales[0].totalAmount) });
  let after = before;
  for (let i = 0; i < 60; i += 1) {
    after = await Promise.all(itemIds.map(stockOf));
    if (after[0] !== before[0] && after[1] !== before[1]) break;
    await sleep(1000);
  }
  check('checkout: stock deducted exactly by the recipe (1 and 2 units)', before[0] - after[0] === 1 && before[1] - after[1] === 2, { before, after });

  // 7. Cold reload while offline, with storage preserved.
  const storedBefore = await offlineDb(term);
  await termCtx.setOffline(true);
  await sleep(1500);
  await term.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const notice = term.getByRole('heading', { name: "Can't confirm your sign-in while offline" });
  const shown = await notice.waitFor({ timeout: 60_000 }).then(() => true).catch(() => false);
  await shot(term, 'p69r-offline-cold');
  if (!shown) await dumpAria(term, 'p69r-offline-cold');
  check('offline cold reload: says the sign-in can\'t be confirmed offline, not "No branch assigned"', shown && !(await term.getByText('No branch assigned').isVisible().catch(() => false)));
  check('offline cold reload: says device data is kept', await term.getByText(/saved on this device are kept/).isVisible().catch(() => false));
  const storedAfter = await offlineDb(term);
  check('offline cold reload: IndexedDB stores are unchanged (catalog, queued sales, drafts)', JSON.stringify(storedBefore) === JSON.stringify(storedAfter), { storedBefore, storedAfter });
  const backAt = Date.now();
  await termCtx.setOffline(false);
  const restoredMs = await waitUntil(async () => !(await notice.isVisible()) && (await term.getByRole('textbox', { name: 'Staff PIN' }).isVisible().catch(() => false) || (await term.getByTestId('pos-product-grid').isVisible().catch(() => false))), backAt, 60_000);
  latencies['session restore after reconnect'] = { fromReconnectMs: restoredMs };
  check('reconnect after cold offline reload: the terminal continues on its own (no reload)', restoredMs !== null, latencies['session restore after reconnect']);
  await shot(term, 'p69r-restored');
} catch (error) {
  record('driver error', false, { message: String(error?.message ?? error).slice(0, 300) });
} finally {
  record('latencies', true, latencies);
  await Promise.all([supCtx.close(), termCtx.close(), bCtx.close()]);
  await prisma.$disconnect();
}
process.exitCode = saveResults('p69r-realtime') ? 1 : 0;
