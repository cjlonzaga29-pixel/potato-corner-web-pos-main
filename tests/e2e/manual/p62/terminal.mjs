// POS-PERF-P62 — real terminal UI flows on the LOCAL stack, production builds,
// service worker active. Sales are made through the terminal screens, never the
// API. Each sale's outcome is then checked in the database (Prisma, local
// p62_browser only): one transaction, one deduction, one collection.
//
//   node tests/e2e/manual/p62/terminal.mjs discover   # ARIA snapshots for selectors
//   node tests/e2e/manual/p62/terminal.mjs flows
import fs from 'node:fs';
import { WEB, openProfile, login, dumpAria, shot, check, record, saveResults, sleep, waitForController } from './lib.mjs';

const mode = process.argv[2];
const PIN_ANA = process.env.P62_PIN_ANA;
if (!PIN_ANA) throw new Error('Set P62_PIN_ANA from the stack env file');

async function openTerminal(context) {
  const page = context.pages()[0] ?? (await context.newPage());
  await login(page, 'branch');
  await waitForController(page);
  await page.goto(`${WEB}/branch/terminal`);
  await page.waitForLoadState('networkidle').catch(() => {});
  return page;
}

/**
 * Steps, separated by "|": pin | click:<role>:<name> | clicktext:<text> | fill:<placeholder>:<value>
 * | wait:<ms> | dump:<name>. Prints the main region of each dump.
 */
async function discover() {
  const steps = (process.argv[3] ?? 'dump:start').split('|');
  const context = await openProfile('terminal');
  const page = await openTerminal(context);
  await sleep(1500);
  for (const step of steps) {
    const [op, a, ...rest] = step.split(':');
    const b = rest.join(':');
    if (op === 'pin') await page.getByRole('textbox', { name: 'Staff PIN' }).fill(PIN_ANA);
    else if (op === 'click') await page.getByRole(a, { name: b, exact: false }).first().click();
    else if (op === 'clicktext') await page.getByText(a, { exact: false }).first().click();
    else if (op === 'fill') await page.getByPlaceholder(a).fill(b);
    else if (op === 'filllabel') await page.getByLabel(a, { exact: true }).fill(b);
    else if (op === 'wait') await sleep(Number(a));
    else if (op === 'dump') {
      await sleep(800);
      const snap = await dumpAria(page, `terminal-${a}`);
      await shot(page, `terminal-${a}`);
      const main = snap.slice(Math.max(0, snap.indexOf('- main')));
      console.log(`===== ${a}\n${main.slice(0, Number(process.env.P62_DUMP_CHARS || 2500))}`);
    }
  }
  await context.close();
}

async function startCashier(page) {
  await page.getByRole('textbox', { name: 'Staff PIN' }).fill(PIN_ANA);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue as Ana' }).click();
  await page.getByRole('tab', { name: 'Products' }).waitFor({ timeout: 30_000 });
}

async function addAndCheckout(page, tile) {
  await page.getByRole('tab', { name: 'Products' }).click();
  await page.getByRole('button', { name: tile }).first().click();
  await page.getByRole('button', { name: /^Checkout/ }).click();
  await page.getByRole('dialog', { name: 'Checkout' }).waitFor();
}

/** Clicks Charge and waits for the terminal's own success state; returns the sale's server reply. */
async function charge(page, { lose = false } = {}) {
  const context = page.context();
  let reply = null;
  if (lose) {
    // Lost response: the server processes the sale, the browser never gets the answer.
    await context.route('**/api/transactions', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const res = await route.fetch();
      reply = await res.json().catch(() => null);
      await route.abort('connectionreset');
    });
  }
  const answered = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/transactions', { timeout: 60_000 }).catch(() => null);
  const t0 = Date.now();
  await page.getByRole('button', { name: /^Charge/ }).click();
  if (lose) {
    await sleep(4000);
    await context.unroute('**/api/transactions');
    return { reply, ms: Date.now() - t0 };
  }
  await page.getByText('Sale completed').waitFor({ timeout: 60_000 });
  const ms = Date.now() - t0;
  reply = await (await answered)?.json().catch(() => null);
  await page.getByRole('button', { name: 'Next Customer' }).click().catch(() => {});
  return { reply, ms };
}

async function issueSupply(page, { quantity, free, cash, lose = false }) {
  const context = page.context();
  await page.getByRole('tab', { name: 'Extra Supplies' }).click();
  await page.getByLabel('Quantity of P62 Extra Cup', { exact: true }).fill(String(quantity));
  if (free) {
    await page.getByRole('radio', { name: 'Give free' }).click();
    await page.getByLabel('Reason', { exact: true }).fill('P62 browser check: customer asked for an extra cup');
  } else {
    await page.getByRole('radio', { name: 'With payment' }).click();
    await page.getByLabel('Cash received', { exact: true }).fill(String(cash));
  }
  await page.getByRole('button', { name: 'Review' }).click();
  let reply = null;
  if (lose) {
    await context.route('**/api/extra-supplies/issues', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const res = await route.fetch();
      reply = await res.json().catch(() => null);
      await route.abort('connectionreset');
    });
  }
  // The review is inline: "Review before confirming", then Back / Confirm.
  const review = page.getByRole('heading', { name: 'Review before confirming' });
  await review.waitFor({ timeout: 15_000 });
  const t0 = Date.now();
  await page.getByRole('main').getByRole('button', { name: 'Confirm', exact: true }).click();
  if (lose) {
    await sleep(4000);
    await context.unroute('**/api/extra-supplies/issues');
    return { reply, ms: Date.now() - t0 };
  }
  await review.waitFor({ state: 'hidden', timeout: 60_000 });
  const ms = Date.now() - t0;
  await sleep(800);
  await dumpAria(page, `supply-done-${free ? 'free' : 'paid'}`);
  return { ms };
}

async function flows() {
  const { activitySince, supplyStock, prisma } = await import('./db.mjs');
  const fixtures = JSON.parse(fs.readFileSync('C:/p62/fixtures.json', 'utf8'));
  const since = new Date(Date.now() - 1000);
  const stock0 = await supplyStock(fixtures.supplyItem);
  const context = await openProfile('terminal-flows');
  const page = await openTerminal(context);
  await startCashier(page);
  const timings = {};

  try {
    // 1. Ordinary sale, no discount, cash.
    await addAndCheckout(page, 'P62 Fries 1, Regular, ₱101.00');
    await page.getByPlaceholder('Cash tendered').fill('200');
    const plain = await charge(page);
    timings.plainSaleMs = plain.ms;
    check('terminal: no-discount cash sale completes through the UI', plain.reply?.data?.id, { ms: plain.ms, total: plain.reply?.data?.total_amount });

    // 2. Custom peso discount.
    await addAndCheckout(page, 'P62 Fries 2, Regular, ₱102.00');
    await page.getByRole('radio', { name: 'Apply discount' }).click();
    await page.getByRole('combobox', { name: 'Discount type' }).click();
    await page.getByRole('option', { name: 'P62 Staff Treat' }).click();
    await page.getByLabel('Discount amount (₱)', { exact: true }).fill('20');
    await page.getByPlaceholder('Cash tendered').fill('100');
    const discounted = await charge(page);
    timings.discountSaleMs = discounted.ms;
    check('terminal: custom-discount sale completes with the peso discount', discounted.reply?.data?.id && Number(discounted.reply?.data?.discount_amount) === 20, { ms: discounted.ms, total: discounted.reply?.data?.total_amount, discount: discounted.reply?.data?.discount_amount });

    // 3, 4. Free and paid Extra Supplies.
    const free = await issueSupply(page, { quantity: 1, free: true });
    const paid = await issueSupply(page, { quantity: 2, free: false, cash: 10 });
    timings.freeSupplyMs = free.ms;
    timings.paidSupplyMs = paid.ms;
    record('terminal: free and paid supply issues confirmed on screen', true, { freeMs: free.ms, paidMs: paid.ms });

    // 5. Lost sale response -> reload -> resolution.
    await addAndCheckout(page, 'P62 Fries 3, Regular, ₱103.00');
    await page.getByPlaceholder('Cash tendered').fill('200');
    const lostSale = await charge(page, { lose: true });
    await shot(page, 'lost-sale-before-reload');
    await page.reload();
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(5000);
    await dumpAria(page, 'lost-sale-after-reload');
    await shot(page, 'lost-sale-after-reload');
    const resolved = page.getByRole('dialog', { name: 'Sale completed' });
    const shown = await resolved.isVisible().catch(() => false);
    const text = shown ? (await resolved.innerText()).replace(/\s+/g, ' ').slice(0, 120) : null;
    check('terminal: after a lost reply and reload, the terminal shows the sale as completed', Boolean(lostSale.reply?.data?.id) && shown && /103\.00/.test(text ?? ''), { committed: Boolean(lostSale.reply?.data?.id), shown, text });
    if (shown) await resolved.getByRole('button', { name: 'Next Customer' }).click();

    // 6. Lost paid-supply response -> reload -> resolution.
    if (!(await page.getByRole('tab', { name: 'Products' }).isVisible().catch(() => false))) await startCashier(page).catch(() => {});
    const lostSupply = await issueSupply(page, { quantity: 1, free: false, cash: 5, lose: true });
    await page.reload();
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(5000);
    await dumpAria(page, 'lost-supply-after-reload');
    await shot(page, 'lost-supply-after-reload');
    const supplyText = (await page.getByRole('main').innerText().catch(() => '')).replace(/\s+/g, ' ');
    record('terminal: lost supply reply, server outcome and screen after reload', Boolean(lostSupply.reply?.data), { committed: Boolean(lostSupply.reply?.data), screen: supplyText.slice(0, 200) });
  } catch (error) {
    await dumpAria(page, 'flows-failure');
    await shot(page, 'flows-failure');
    record('terminal: flow aborted', false, { error: String(error).slice(0, 300) });
  }

  // Database: one transaction per sale, one deduction each, one issue per supply operation.
  await sleep(8000); // background deduction
  const db = await activitySince(since);
  const stock1 = await supplyStock(fixtures.supplyItem);
  const keys = db.transactions.map((t) => t.idempotencyKey).filter(Boolean);
  check('db: exactly one transaction per sale (3 sales, the lost one included)', db.transactions.length === 3 && new Set(keys).size === keys.length, { count: db.transactions.length, totals: db.transactions.map((t) => t.totalAmount) });
  check('db: every sale deducted exactly once (3 recipe lines each)', db.transactions.every((t) => t.inventoryDeductionStatus === 'completed') && db.saleMovements === 9, { movements: db.saleMovements, statuses: db.transactions.map((t) => t.inventoryDeductionStatus) });
  check('db: exactly one issue per supply operation (free, paid, lost paid)', db.issues.length === 3, { issues: db.issues });
  check('db: supply stock fell by exactly the units issued (1 + 2 + 1)', stock0 !== null && stock0 - stock1 === 4, { before: stock0, after: stock1 });
  check('db: one collection per paid issue (10 + 5)', db.issues.filter((i) => i.kind === 'paid').reduce((s, i) => s + i.amountCollected, 0) === 15, {});
  fs.writeFileSync('C:/p62/out/terminal-timings.json', JSON.stringify(timings, null, 2));
  await prisma.$disconnect();
  await context.close();
}

const run = { discover, flows }[mode];
if (!run) { console.error('usage: terminal.mjs discover|flows'); process.exit(2); }
await run();
const failed = saveResults(`terminal-${mode}`);
process.exit(failed ? 1 : 0);
