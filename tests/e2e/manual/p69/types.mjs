// POS-PERF-P69 — POS product type filter and badges, on the LOCAL P62 stack
// (production builds, service worker active). Supervisor work goes through the
// real Supervisor screens; the sale goes through the terminal screens. Database
// reads are read-only and refuse anything but the local p62_* database.
//
//   P62_ROOT_WIN=C:/p69s P62_WEB_URL=http://localhost:56693 node tests/e2e/manual/p69/types.mjs
import fs from 'node:fs';
import { WEB, ROOT, openProfile, login, shot, dumpAria, check, record, saveResults, sleep, waitForController } from '../p62/lib.mjs';

const PIN_ANA = process.env.P62_PIN_ANA;
const B_PASSWORD = process.env.P69_BRANCH_B_PASSWORD;
if (!PIN_ANA || !B_PASSWORD) throw new Error('Set P62_PIN_ANA and P69_BRANCH_B_PASSWORD from the stack env file');
const fixtures = JSON.parse(fs.readFileSync(`${ROOT}/p69-fixtures.json`, 'utf8'));
const { prisma } = await import('../p62/db.mjs');
const TAG = Date.now().toString(36).slice(-4);
const TYPE = `Marketing ${TAG}`;
const RENAMED = `Campaign ${TAG}`;

/** Names of the product cards in the grid, e.g. "P69 Iced Tea" (first part of each card's accessible name). */
async function cardNames(page) {
  const labels = await page.getByTestId('pos-product-grid').getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  return labels.map((l) => l.split(',')[0]);
}
const p69 = (names) => names.filter((n) => n.startsWith('P69 ')).sort();
const typeTab = (page, name) => page.getByRole('tablist', { name: 'Filter by product type' }).getByRole('tab', { name, exact: true });
const categoryTab = (page, name) => page.getByRole('tablist', { name: 'Filter by category' }).getByRole('tab', { name, exact: true });

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

async function stockOf(itemId) {
  const row = await prisma.inventoryStock.findFirst({ where: { branchId: fixtures.mainBranchId, inventoryItemId: itemId } });
  return row ? Number(row.quantityOnHand) : null;
}

async function supervisorSteps(context) {
  const page = context.pages()[0] ?? (await context.newPage());
  await login(page, 'supervisor');
  await page.goto(`${WEB}/supervisor/products`);
  await page.getByRole('button', { name: 'Create Product Type' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create Product Type' });
  await dialog.getByLabel('Name', { exact: true }).fill(TYPE);
  // Scope: branch A (MAIN01) only.
  const mainName = (await prisma.branch.findUniqueOrThrow({ where: { id: fixtures.mainBranchId } })).name;
  await dialog.getByRole('checkbox', { name: mainName, exact: true }).check();
  for (const box of await dialog.getByRole('checkbox').all()) {
    if ((await box.getAttribute('aria-label')) !== mainName) await box.uncheck();
  }
  await dialog.getByRole('button', { name: 'Create Product Type' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 }).catch(async (error) => {
    const snap = await dialog.ariaSnapshot().catch(() => '');
    record('supervisor: create dialog still open', false, { dialog: snap.slice(0, 800) });
    await shot(page, 'p69-create-type-stuck');
    throw error;
  });
  const type = await prisma.productType.findFirst({ where: { name: TYPE }, include: { branches: true } });
  check('supervisor: custom type created through the Products screen, scoped to branch A only', type && type.isActive && type.branches.length === 1 && type.branches[0].branchId === fixtures.mainBranchId, { branches: type?.branches.length });

  // Assign through the existing product editor.
  await page.goto(`${WEB}/supervisor/products/builder?product_id=${fixtures.campaignProductId}`);
  // The builder remembers the last step for a product; go back to step 1.
  await page.getByRole('heading', { name: 'Edit Product' }).waitFor({ timeout: 30_000 });
  const typeField = page.getByRole('combobox', { name: 'Product type' });
  if (!(await typeField.isVisible().catch(() => false))) await page.getByRole('button', { name: '1. Product Details' }).click();
  await typeField.click().catch(async (error) => {
    await shot(page, 'p69-builder');
    await dumpAria(page, 'p69-builder');
    throw error;
  });
  await page.getByRole('option', { name: TYPE }).click();
  await shot(page, 'p69-builder-selected');
  await dumpAria(page, 'p69-builder-selected');
  // The builder's step 1 saves the details (type included) when continuing.
  await page.getByRole('button', { name: 'Continue to Sizes & Prices' }).click();
  let assigned = null;
  for (let i = 0; i < 30 && assigned?.productTypeId !== type?.id; i += 1) {
    await sleep(500);
    assigned = await prisma.product.findUnique({ where: { id: fixtures.campaignProductId } });
  }
  check('supervisor: product assigned to the custom type through the product editor (classification unchanged)', assigned?.productTypeId === type?.id && assigned?.classification === 'regular', { classification: assigned?.classification });
  await shot(page, 'p69-supervisor-assigned');
  return { page, typeId: type?.id };
}

async function terminalSteps(context) {
  const page = context.pages()[0] ?? (await context.newPage());
  await login(page, 'branch');
  const sw = await waitForController(page);
  record('terminal: service worker controls the page', Boolean(sw), { sw: sw?.split('/').pop() });
  await openTerminal(page);

  const tabs = await page.getByRole('tablist', { name: 'Filter by product type' }).getByRole('tab').allTextContents();
  check('terminal A: type tab row shows All Types, built-ins, then the new custom type', tabs[0] === 'All Types' && tabs.slice(1, 4).join('|') === 'Regular|Promotional|Seasonal' && tabs.includes(TYPE), { tabs });
  const cheese = page.getByRole('button', { name: /^P69 Cheese Fries PPO, Regular, .*Type: Promotional$/ });
  check('terminal A: Cheese Fries PPO card shows size Regular and a separate Promotional type badge', (await cheese.count()) === 1 && (await cheese.getByTestId('product-card-type').textContent()) === 'Promotional');
  const campaignBadge = await page.getByRole('button', { name: /^P69 Campaign Fries/ }).getByTestId('product-card-type').textContent().catch(() => null);
  check('terminal A: custom-typed card shows the custom type name', campaignBadge === TYPE, { campaignBadge });

  await typeTab(page, 'Promotional').click();
  check('filter: Promotional', JSON.stringify(p69(await cardNames(page))) === JSON.stringify(['P69 Cheese Fries PPO']), { shown: p69(await cardNames(page)) });
  await typeTab(page, TYPE).click();
  const custom = await cardNames(page);
  check('filter: custom type shows only its product, not under its Regular classification', custom.length === 1 && custom[0] === 'P69 Campaign Fries', { custom });
  await typeTab(page, 'Regular').click();
  check('filter: Regular excludes the custom-typed product', !(await cardNames(page)).includes('P69 Campaign Fries'));
  await typeTab(page, 'Seasonal').click();
  await categoryTab(page, 'Drinks').click();
  check('filter: Seasonal AND Drinks', JSON.stringify(await cardNames(page)) === JSON.stringify(['P69 Iced Tea']));
  await page.getByPlaceholder('Search products…').fill('fries');
  await page.getByText('No products match all of these filters.').waitFor({ timeout: 5000 }).catch(() => {});
  check('filter: Seasonal AND Drinks AND "fries" is empty, with Clear filters', await page.getByRole('button', { name: 'Clear filters' }).isVisible());
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await sleep(600);
  check('filter: Clear filters resets type, category and search', (await typeTab(page, 'All Types').getAttribute('data-state')) === 'active' && (await categoryTab(page, 'All Categories').getAttribute('data-state')) === 'active' && (await page.getByPlaceholder('Search products…').inputValue()) === '');
  await shot(page, 'p69-terminal-desktop');

  // Keyboard: arrow through the type tabs.
  await sleep(800);
  await typeTab(page, 'All Types').focus();
  const start = await page.evaluate(() => document.activeElement?.textContent ?? '');
  await page.keyboard.press('ArrowRight');
  await sleep(300);
  const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
  check('keyboard: ArrowRight moves focus along the type tabs and selects', start === 'All Types' && focused === 'Regular' && (await typeTab(page, 'Regular').getAttribute('data-state')) === 'active', { start, focused });
  await typeTab(page, 'All Types').click();

  // Sale: filter, add, charge. Total and stock deduction must be unchanged by the filter.
  const itemIds = fixtures.itemIds.split(',');
  const before = await Promise.all(itemIds.map(stockOf));
  const since = new Date(Date.now() - 1000);
  await typeTab(page, TYPE).click();
  await page.getByRole('button', { name: /^P69 Campaign Fries/ }).click();
  await typeTab(page, 'Promotional').click();
  check('cart: changing the filter keeps the line', await page.getByRole('button', { name: /^Checkout/ }).isEnabled());
  await page.getByRole('button', { name: /^Checkout/ }).click();
  await page.getByRole('dialog', { name: 'Checkout' }).waitFor();
  await page.getByPlaceholder('Cash tendered').fill('100');
  const answered = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/transactions', { timeout: 60_000 }).catch(() => null);
  await page.getByRole('button', { name: /^Charge/ }).click();
  await page.getByText('Sale completed').waitFor({ timeout: 60_000 });
  const reply = await (await answered)?.json().catch(() => null);
  await page.getByRole('button', { name: 'Next Customer' }).click().catch(() => {});
  const sales = await prisma.transaction.findMany({ where: { branchId: fixtures.mainBranchId, createdAt: { gte: since } } });
  check('checkout: one sale, total ₱89.00 (the product price, no change)', sales.length === 1 && Number(sales[0].totalAmount) === 89, { total: sales[0] && Number(sales[0].totalAmount), reply: reply?.data?.total_amount });
  let after = before;
  for (let i = 0; i < 60; i += 1) {
    after = await Promise.all(itemIds.map(stockOf));
    if (after[0] !== before[0] && after[1] !== before[1]) break;
    await sleep(1000);
  }
  check('checkout: stock deducted exactly by the recipe (1 and 2 units)', before[0] - after[0] === 1 && before[1] - after[1] === 2, { before, after });
  return page;
}

async function branchBSteps(context) {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${WEB}/login`);
  await page.waitForLoadState('domcontentloaded');
  await sleep(1500);
  // A persistent profile may still hold branch B's session: /login then redirects home.
  if (!new URL(page.url()).pathname.startsWith('/branch/dashboard')) {
    await page.getByLabel('Email').fill('branch-b-p69@potatocorner.test');
    await page.getByRole('textbox', { name: 'Password' }).fill(B_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL('**/branch/dashboard', { timeout: 60_000 });
  }
  const own = page.waitForResponse((r) => r.url().includes('/api/products/catalog?branch_id=') && r.request().method() === 'GET', { timeout: 60_000 });
  await page.goto(`${WEB}/branch/terminal`);
  const body = await (await own).json();
  const types = (body.data?.product_types ?? []).map((t) => t.name);
  const names = (body.data?.products ?? []).map((p) => p.name);
  check('branch B: its catalog has neither the branch-A type nor any branch-A-only product', !types.includes(TYPE) && !types.includes(RENAMED) && !names.some((n) => n.startsWith('P69 ')), { types });

  // A forged request for branch A from branch B's session.
  await page.route('**/api/products/catalog?branch_id=*', (route) => route.continue({ url: route.request().url().replace(/branch_id=[^&]+/, `branch_id=${fixtures.mainBranchId}`) }));
  const forged = page.waitForResponse((r) => r.url().includes(`branch_id=${fixtures.mainBranchId}`), { timeout: 60_000 });
  await page.reload();
  const status = (await forged).status();
  check('branch B: requesting branch A\'s catalog is refused', status === 403, { status });
  await page.unroute('**/api/products/catalog?branch_id=*');
}

async function renameAndOffline(supervisorPage, terminalPage, typeId) {
  // The type is scoped to branch A only; the Products page offers it only at branch A (P58 §4).
  await supervisorPage.goto(`${WEB}/supervisor/products`);
  const mainName = (await prisma.branch.findUniqueOrThrow({ where: { id: fixtures.mainBranchId } })).name;
  const switcher = supervisorPage.getByRole('button', { name: /^P62 Branch \d$/ }).first();
  await switcher.waitFor({ timeout: 30_000 });
  await switcher.click();
  await supervisorPage.getByRole('menuitem', { name: new RegExp(`^${mainName} `) }).click();
  await supervisorPage.getByText(`At ${mainName}`).waitFor({ timeout: 30_000 });
  await supervisorPage.goto(`${WEB}/supervisor/products?type=${typeId}`);
  await supervisorPage.getByRole('button', { name: 'Edit Type' }).click().catch(async (error) => {
    await shot(supervisorPage, 'p69-edit-type');
    throw error;
  });
  const dialog = supervisorPage.getByRole('dialog', { name: `Edit ${TYPE}` });
  await dialog.getByLabel('Name', { exact: true }).fill(RENAMED);
  await dialog.getByRole('button', { name: 'Save Changes' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 });

  // The existing refresh: returning to the terminal page refetches the (stale) catalog.
  const page = terminalPage;
  await typeTab(page, TYPE).click();
  await page.goto(`${WEB}/branch/dashboard`);
  await sleep(61_000);
  await openTerminal(page);
  const tabs = await page.getByRole('tablist', { name: 'Filter by product type' }).getByRole('tab').allTextContents();
  check('rename: the terminal shows the new name after its existing refresh, old name gone', tabs.includes(RENAMED) && !tabs.includes(TYPE), { tabs });

  // Offline (no reload: a cold offline reload has no session, see the runbook):
  // the open terminal keeps filtering, and the saved snapshot carries the type list.
  await page.context().setOffline(true);
  await sleep(1500);
  await typeTab(page, RENAMED).click();
  const offline = await cardNames(page);
  check('offline: the open terminal filters by the renamed type', offline.length === 1 && offline[0] === 'P69 Campaign Fries', { offline });
  check('offline: badge shows the renamed type', (await page.getByRole('button', { name: /^P69 Campaign Fries/ }).getByTestId('product-card-type').textContent()) === RENAMED);
  const saved = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('potato-corner-pos');
        open.onerror = () => resolve({ error: 'open failed' });
        open.onsuccess = () => {
          const request = open.result.transaction('cachedProducts', 'readonly').objectStore('cachedProducts').getAll();
          request.onsuccess = () => resolve(request.result.map((r) => ({ branchId: r.branchId, name: r.data?.name, type: r.data?.product_type?.name ?? null, types: Array.isArray(r.productTypes) ? r.productTypes.map((t) => t.name) : null })));
          request.onerror = () => resolve({ error: 'read failed' });
        };
      }),
  );
  const rows = Array.isArray(saved) ? saved : [];
  const campaignRow = rows.find((r) => r.name === 'P69 Campaign Fries');
  check(
    'offline cache: every saved row is branch A, carries the type list with the renamed type, and the product row its type',
    rows.length > 0 && rows.every((r) => r.branchId === fixtures.mainBranchId && r.types?.includes(RENAMED) && !r.types?.includes(TYPE)) && campaignRow?.type === RENAMED,
    { rows: rows.length, campaignType: campaignRow?.type },
  );
  await shot(page, 'p69-terminal-offline');
  await page.context().setOffline(false);
}

async function viewports(page) {
  for (const [name, size] of [['tablet', { width: 1024, height: 768 }], ['phone', { width: 390, height: 844 }]]) {
    await page.setViewportSize(size);
    await sleep(800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const tablist = page.getByRole('tablist', { name: 'Filter by product type' });
    const visible = await tablist.isVisible().catch(() => false);
    check(`${name}: type row visible and no horizontal page scroll`, visible && overflow <= 0, { overflow });
    await shot(page, `p69-terminal-${name}`);
  }
  await page.setViewportSize({ width: 1366, height: 900 });
}

const supCtx = await openProfile('p69sup');
const termCtx = await openProfile('p69term');
// Branch B checks authorization only: a fresh profile with service workers blocked,
// because Playwright's page.route can't rewrite requests a service worker makes.
const bCtx = await openProfile(`p69b-${TAG}`, { serviceWorkers: 'block' });
try {
  const { page: supPage, typeId } = await supervisorSteps(supCtx);
  const termPage = await terminalSteps(termCtx);
  await branchBSteps(bCtx);
  await viewports(termPage);
  await renameAndOffline(supPage, termPage, typeId);
} catch (error) {
  record('driver error', false, { message: String(error?.message ?? error).slice(0, 300) });
} finally {
  await Promise.all([supCtx.close(), termCtx.close(), bCtx.close()]);
  await prisma.$disconnect();
}
process.exitCode = saveResults('p69-types') ? 1 : 0;
