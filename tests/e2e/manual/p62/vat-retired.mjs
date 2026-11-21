// POS-PERF-P63 — VAT retired, checked in the real UI on the LOCAL stack
// (stack.sh: production builds, service worker active). LOCAL ONLY: lib.mjs
// refuses a non-localhost web URL and db.mjs a non-local p62_* database.
//
//   node tests/e2e/manual/p62/vat-retired.mjs
//
// 1. A supervisor-created type named "PWD" is a manual peso discount:
//    subtotal − amount, no VAT, recorded as manual_total_v1.
// 2. Checkout shows no VAT anywhere.
// 3. An offline sale queues, then syncs once on reconnect as a manual total.
// 4. Admin and Supervisor Settings show no VAT or statutory-rate editors.
import fs from 'node:fs';
import { WEB, OUT, check, record, saveResults, openProfile, login, waitForController, dumpAria, shot, sleep } from './lib.mjs';
import { prisma, mainBranchId } from './db.mjs';

const PIN_ANA = process.env.P62_PIN_ANA;
if (!PIN_ANA) throw new Error('Set P62_PIN_ANA from the stack env file');
const TILE = 'P62 Fries 1, Regular, ₱101.00';

async function ensurePwdType() {
  const branchId = await mainBranchId();
  const supervisor = await prisma.user.findFirstOrThrow({ where: { email: 'supervisor@potatocorner.test' } });
  const existing = await prisma.manualDiscountType.findFirst({ where: { branchId, name: 'PWD', isActive: true } });
  if (existing) return existing;
  // Fixture only, on the local p62_* database: what a supervisor creates on the Discounts page.
  return prisma.manualDiscountType.create({
    data: { id: crypto.randomUUID(), branchId, name: 'PWD', applyToPos: true, requireProof: false, amountMode: 'manual', productScope: 'all', createdById: supervisor.id },
  });
}

async function startCashier(page) {
  await page.getByRole('textbox', { name: 'Staff PIN' }).fill(PIN_ANA);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue as Ana' }).click();
  await page.getByRole('tab', { name: 'Products' }).waitFor({ timeout: 30_000 });
}

async function addAndCheckout(page) {
  await page.getByRole('tab', { name: 'Products' }).click();
  await page.getByRole('button', { name: TILE }).first().click();
  await page.getByRole('button', { name: /^Checkout/ }).click();
  await page.getByRole('dialog', { name: 'Checkout' }).waitFor();
}

async function terminalFlows() {
  const branchId = await mainBranchId();
  const since = new Date(Date.now() - 1000);
  await ensurePwdType();
  const context = await openProfile('p63-terminal');
  const page = context.pages()[0] ?? (await context.newPage());
  await login(page, 'branch');
  const sw = await waitForController(page);
  record('service worker controls the terminal', Boolean(sw), { sw });
  await page.goto(`${WEB}/branch/terminal`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await startCashier(page);

  try {
    // 1 + 2. "PWD"-named manual type, ₱15 off, and no VAT on the checkout screen.
    await addAndCheckout(page);
    await page.getByRole('radio', { name: 'Apply discount' }).click();
    await page.getByRole('combobox', { name: 'Discount type' }).click();
    await page.getByRole('option', { name: 'PWD', exact: true }).click();
    await page.getByLabel(/Discount amount/i).fill('15');
    await page.getByPlaceholder('Cash tendered').fill('200');
    const dialogText = (await page.getByRole('dialog', { name: 'Checkout' }).innerText()).replace(/\s+/g, ' ');
    check('checkout screen shows no VAT', !/\bVAT\b|VATable|VAT-exempt/i.test(dialogText), { sample: dialogText.slice(0, 300) });
    check('checkout shows the amount to pay as subtotal − ₱15 (₱86.00)', /86\.00/.test(dialogText), {});
    const answered = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/transactions', { timeout: 60_000 });
    await page.getByRole('button', { name: /^Charge/ }).click();
    const reply = await (await answered).json().catch(() => null);
    await page.getByText('Sale completed').waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Next Customer' }).click().catch(() => {});
    const sale = reply?.data?.id ? await prisma.transaction.findUnique({ where: { id: reply.data.id } }) : null;
    check('"PWD" sale recorded as a manual total: 101 − 15 = 86, VAT 0', sale
      && Number(sale.subtotal) === 101 && Number(sale.discountAmount) === 15 && Number(sale.totalAmount) === 86
      && Number(sale.vatAmount) === 0 && sale.discountType === 'manual' && sale.calculationMode === 'manual_total_v1'
      && sale.manualDiscountSnapshot?.name === 'PWD', { total: sale && Number(sale.totalAmount), mode: sale?.calculationMode, name: sale?.manualDiscountSnapshot?.name });

    // 3. Offline sale, then reconnect: synced exactly once, as a manual total.
    await context.setOffline(true);
    await sleep(1500);
    await addAndCheckout(page);
    await page.getByPlaceholder('Cash tendered').fill('200');
    await page.getByRole('button', { name: /^Charge/ }).click();
    await sleep(3000);
    await dumpAria(page, 'p63-offline-after-charge');
    await shot(page, 'p63-offline-after-charge');
    await page.getByRole('button', { name: 'Next Customer' }).click().catch(() => {});
    const queuedBefore = await prisma.transaction.count({ where: { branchId, createdAt: { gte: since }, isOfflineTransaction: true } });
    check('offline: nothing reaches the server while offline', queuedBefore === 0, { queuedBefore });
    await context.setOffline(false);
    let offline = [];
    for (let i = 0; i < 40 && offline.length === 0; i++) {
      await sleep(3000);
      offline = await prisma.transaction.findMany({ where: { branchId, createdAt: { gte: since }, isOfflineTransaction: true } });
    }
    await sleep(6000);
    offline = await prisma.transaction.findMany({ where: { branchId, createdAt: { gte: since }, isOfflineTransaction: true } });
    check('offline sale synced exactly once on reconnect, manual total ₱101, VAT 0', offline.length === 1
      && Number(offline[0].totalAmount) === 101 && Number(offline[0].vatAmount) === 0 && offline[0].calculationMode === 'manual_total_v1',
      { count: offline.length, total: offline[0] && Number(offline[0].totalAmount), mode: offline[0]?.calculationMode });
  } catch (error) {
    await dumpAria(page, 'p63-terminal-failure');
    await shot(page, 'p63-terminal-failure');
    record('terminal flow aborted', false, { error: String(error).slice(0, 300) });
  }

  await sleep(8000); // background deduction
  const all = await prisma.transaction.findMany({ where: { branchId, createdAt: { gte: since } } });
  check('db: 2 sales, every one a manual total with VAT 0 and deducted', all.length === 2
    && all.every((t) => t.calculationMode === 'manual_total_v1' && Number(t.vatAmount) === 0 && t.inventoryDeductionStatus === 'completed'),
    { count: all.length, statuses: all.map((t) => t.inventoryDeductionStatus) });
  await context.close();
}

async function settingsScreens() {
  for (const [who, path] of [['admin', '/admin/settings?tab=discounts'], ['supervisor', '/supervisor/settings']]) {
    const context = await openProfile(`p63-${who}`);
    const page = context.pages()[0] ?? (await context.newPage());
    await login(page, who);
    await page.goto(`${WEB}${path}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(1500);
    const text = (await page.getByRole('main').innerText()).replace(/\s+/g, ' ');
    await shot(page, `p63-settings-${who}`);
    check(`${who} settings: no VAT, statutory or PWD/Senior rate editor`, !/\bVAT\b|Statutory|Senior Citizen|Legacy discount settings|Discount rates at/i.test(text), { sample: text.slice(0, 400) });
    if (who === 'admin') check('admin settings: the per-branch discount decision switch is still there', /Cashier must choose a discount/.test(text), {});
    await context.close();
  }
}

try {
  await terminalFlows();
  await settingsScreens();
} finally {
  await prisma.$disconnect();
}
fs.mkdirSync(OUT, { recursive: true });
const failed = saveResults('p63-vat-retired');
process.exit(failed ? 1 : 0);
