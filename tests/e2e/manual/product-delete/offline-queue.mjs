// Product permanent delete — a REAL offline queue (service worker + IndexedDB)
// holding a sale of a product that is permanently deleted before reconnect.
// LOCAL ONLY, on the P62 stack (tests/e2e/manual/p62/stack.sh) with the built
// API started with PRODUCT_PERMANENT_DELETE_ENABLED=true. lib.mjs refuses a
// non-localhost web URL and db.mjs a non-local p62_* database.
//
//   . C:/p71s/env.sh && P62_WEB_URL=http://localhost:56743 P62_ROOT_WIN=C:/p71s P62_OUT=C:/p72/offline1 \
//     node tests/e2e/manual/product-delete/offline-queue.mjs
//
// 1. The terminal loads the catalog online (the fixture product is on it).
// 2. Offline, the cashier rings that product: the sale is queued in IndexedDB.
// 3. A supervisor permanently deletes the product (normal API route).
// 4. Reconnect: the server refuses the sale per item with PRODUCT_DELETED; the
//    queued row STAYS on the device, settled as refused with that reason, and is
//    shown as refused; nothing is recorded or charged; later syncs don't resend it.
import { WEB, OUT, check, record, saveResults, openProfile, login, waitForController, dumpAria, shot, sleep } from '../p62/lib.mjs';
import { prisma, mainBranchId } from '../p62/db.mjs';

const PIN_ANA = process.env.P62_PIN_ANA;
const API = process.env.NEXT_PUBLIC_API_URL;
if (!PIN_ANA) throw new Error('Set P62_PIN_ANA from the stack env file');
if (new URL(API ?? 'http://invalid').hostname !== '127.0.0.1') throw new Error('Refusing: API is not 127.0.0.1');
const TAG = `PDELQ${Date.now().toString(36).slice(-5)}`.toUpperCase();
const NAME = `${TAG} Offline Fries`;

async function fixture() {
  const branchId = await mainBranchId();
  const supervisor = await prisma.user.findFirstOrThrow({ where: { email: 'supervisor@potatocorner.test' } });
  const item = await prisma.inventoryItem.findFirstOrThrow({ where: { name: 'P62 Item 1' } });
  // Fixture only, on the local p62_* database: a ready, published product at MAIN01 (same shape as product-delete-browser-fixtures.ts).
  const product = await prisma.product.create({ data: { name: NAME, status: 'active', everPublished: true, category: 'Fries', createdBy: supervisor.id } });
  const variant = await prisma.productVariant.create({ data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 60, isActive: true, lifecycleStatus: 'ACTIVE' } });
  await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: item.id, quantityRequired: 1 } });
  await prisma.branchProductAvailability.create({ data: { branchId, productId: product.id, isAvailable: true } });
  return { branchId, productId: product.id, variantId: variant.id };
}

async function supervisorToken() {
  const res = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'supervisor@potatocorner.test', password: 'Supervisor123', device_id: crypto.randomUUID() }) });
  const body = await res.json();
  if (!body?.data?.access_token) throw new Error(`supervisor login failed: ${res.status} ${body?.error?.code}`);
  return body.data.access_token;
}

const queueRows = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('potato-corner-pos');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('offlineTransactions', 'readonly');
          const all = tx.objectStore('offlineTransactions').getAll();
          all.onsuccess = () => resolve(all.result.map((r) => ({ id: r.id, syncedAt: r.syncedAt, rejection: r.rejection ?? null, lastError: r.lastError ?? null, items: r.payload?.items?.map((i) => i.product_id) })));
          all.onerror = () => reject(all.error);
        };
      }),
  );

const fx = await fixture();
const since = new Date(Date.now() - 1000);
const context = await openProfile(`pdelq-${TAG.toLowerCase()}`);
const page = context.pages()[0] ?? (await context.newPage());
const syncCalls = [];
page.on('response', (r) => {
  if (new URL(r.url()).pathname === '/api/transactions/sync-offline') syncCalls.push(r.status());
});

try {
  await login(page, 'branch');
  record('service worker controls the terminal', Boolean(await waitForController(page)), {});
  await page.goto(`${WEB}/branch/terminal`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.getByRole('textbox', { name: 'Staff PIN' }).fill(PIN_ANA);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue as Ana' }).click();
  await page.getByRole('tab', { name: 'Products' }).waitFor({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Products' }).click();
  const tile = page.getByRole('button', { name: new RegExp(`^${NAME}, Regular`) }).first();
  await tile.waitFor({ timeout: 30_000 });
  check('1. online: the product is on the terminal', await tile.isVisible(), {});
  const before = await queueRows(page);

  // 2. Offline sale.
  await context.setOffline(true);
  await sleep(1500);
  await tile.click();
  await page.getByRole('button', { name: /^Checkout/ }).click();
  await page.getByRole('dialog', { name: 'Checkout' }).waitFor();
  await page.getByPlaceholder('Cash tendered').fill('100');
  await page.getByRole('button', { name: /^Charge/ }).click();
  await sleep(3000);
  await shot(page, 'pdelq-offline-after-charge');
  await page.getByRole('button', { name: 'Next Customer' }).click().catch(() => {});
  const queued = (await queueRows(page)).filter((r) => !before.some((b) => b.id === r.id));
  check('2. offline: the sale is queued in IndexedDB, unsynced, naming the product', queued.length === 1 && queued[0].syncedAt === null && queued[0].items?.includes(fx.productId), { queued });
  const localId = queued[0]?.id;

  // 3. Permanent delete while the terminal is offline.
  const token = await supervisorToken();
  const del = await fetch(`${API}/api/products/${fx.productId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'PERMANENTLY_DELETE' }) });
  check('3. product permanently deleted while the terminal is offline (200)', del.status === 200 && (await prisma.product.findUnique({ where: { id: fx.productId } })) === null, { status: del.status });

  // 4. Reconnect.
  await context.setOffline(false);
  let row = null;
  for (let i = 0; i < 60 && !row?.rejection; i++) {
    await sleep(2000);
    row = (await queueRows(page)).find((r) => r.id === localId) ?? null;
  }
  check('4a. reconnect: the queued sale is still on the device', Boolean(row), { row });
  check('4b. it is settled as refused with PRODUCT_DELETED, never marked synced', row?.rejection?.code === 'PRODUCT_DELETED' && row?.syncedAt === null, { rejection: row?.rejection, syncedAt: row?.syncedAt });
  const recorded = await prisma.transaction.count({ where: { offlineProvisionalNumber: localId ?? '-' } });
  const anySince = await prisma.transaction.count({ where: { branchId: fx.branchId, createdAt: { gte: since }, isOfflineTransaction: true } });
  check('4c. nothing recorded or charged on the server', recorded === 0 && anySince === 0, { recorded, anySince });
  const callsAfterRefusal = syncCalls.length;
  await page.reload();
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(8000);
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  await dumpAria(page, 'pdelq-after-reconnect');
  await shot(page, 'pdelq-after-reconnect');
  record('4d. terminal text after reconnect (for review)', true, { sample: text.match(/.{0,120}(refused|permanently deleted|not recorded).{0,160}/i)?.[0] ?? text.slice(0, 300) });
  await page.getByRole('tab', { name: /^Pending/ }).click();
  await sleep(1500);
  const pending = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  await shot(page, 'pdelq-pending-tab');
  check('4f. Pending tab shows the sale as refused with the reason (no ghost sale)', /permanently deleted/i.test(pending) && /refused|not recorded/i.test(pending), { sample: pending.slice(0, 400) });
  const stillThere = (await queueRows(page)).find((r) => r.id === localId);
  check('4e. after a reload and further syncs: still kept, still refused, still not recorded', stillThere?.rejection?.code === 'PRODUCT_DELETED' && (await prisma.transaction.count({ where: { offlineProvisionalNumber: localId ?? '-' } })) === 0, { stillThere, syncCallsAfterRefusal: syncCalls.length - callsAfterRefusal });
} catch (error) {
  await dumpAria(page, 'pdelq-failure');
  await shot(page, 'pdelq-failure');
  record('offline queue flow aborted', false, { error: String(error).slice(0, 400) });
} finally {
  await context.close();
  saveResults(`pdelq-${TAG.toLowerCase()}`);
  await prisma.$disconnect();
}
console.warn(`results in ${OUT}`);
