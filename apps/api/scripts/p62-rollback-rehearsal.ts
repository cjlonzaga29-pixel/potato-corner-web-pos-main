// POS-PERF-P62 — Extra Supplies (P61) rollback rehearsal on a disposable LOCAL
// database. The same file runs from the current tree and from a `git archive`
// of pre-P61 code (500e97e); only the setup and verify phases import P61 code.
//
//   setup   (current code)  open shift: cash and GCash sales, paid cash, free and
//                           GCash supply issues, and one "uncertain" issue whose
//                           reply the client is treated as never having received
//   summary (either code)   the shift's live summary as that code computes it
//   close   (either code)   close the shift counting the drawer that is really there
//   verify  (current code)  records preserved; uncertain issue resolvable again
//
// Ordinary sales are inserted as completed transaction rows: an open shift's
// summary aggregates those rows in both versions, and sale logic did not change
// in P61. Nothing is rebalanced or rewritten. Prints numbers and ids only.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { PrismaClient, Prisma } from '@prisma/client';

const STATE = process.env.P62_ROLLBACK_STATE || 'C:/p62/rollback.json';
const phase = process.argv[2] ?? '';

function assertDisposableLocal(): void {
  if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('Refusing: PRODUCTION_DATABASE_URL_DIRECT is set');
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const url = new URL(process.env[name] ?? 'missing://');
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/p62_rollback') throw new Error(`Refusing: ${name} is not the local p62_rollback database`);
  }
}
assertDisposableLocal();
const prisma = new PrismaClient({ log: [] });

interface State { branch: string; cashier: string; supervisor: string; item: string; card: string; cardVersion: number; shift: string; uncertainOperation: string; drawer: number }

const load = (): State => JSON.parse(fs.readFileSync(STATE, 'utf8')) as State;
const { cashService } = await import('../src/modules/cash/cash.service.js');

function pickSummary(s: Record<string, unknown>) {
  const keys = ['cash_sales_total', 'gcash_sales_total', 'gross_sales_total', 'extra_supply_cash_total', 'extra_supply_collections_total', 'total_collections', 'expected_cash', 'opening_cash', 'closing_cash', 'cash_variance', 'variance_status'];
  return Object.fromEntries(keys.filter((k) => k in s).map((k) => [k, s[k]]));
}

async function setup(): Promise<void> {
  const tag = randomUUID().slice(0, 6);
  const branch = await prisma.branch.create({ data: { name: `Rollback ${tag}`, code: `RB-${tag}`, address: 'x', city: 'x', status: 'active' } });
  const mk = (role: 'staff' | 'supervisor', name: string) => prisma.user.create({ data: { email: `${name}-${tag}@potatocorner.test`, passwordHash: 'unused', role, firstName: 'RB', lastName: name, employmentType: 'regular', mustChangePassword: false } });
  const cashier = await mk('staff', 'cashier');
  const supervisor = await mk('supervisor', 'sup');
  await prisma.userBranchAssignment.createMany({ data: [{ userId: cashier.id, branchId: branch.id }, { userId: supervisor.id, branchId: branch.id }] });
  const pc = await prisma.unitOfMeasure.upsert({ where: { code: 'pc' }, update: {}, create: { code: 'pc', name: 'Piece', dimension: 'COUNT', isBaseUnit: true } });
  const item = await prisma.inventoryItem.create({ data: { name: `RB Cup ${tag}`, baseUnitId: pc.id } });
  await prisma.inventoryStock.create({ data: { branchId: branch.id, inventoryItemId: item.id, quantityOnHand: new Prisma.Decimal(100), quantityReserved: new Prisma.Decimal(0), unitCost: new Prisma.Decimal(1) } });
  const shift = await prisma.shift.create({ data: { branchId: branch.id, cashierId: cashier.id, openedBy: cashier.id, openingCashAmount: new Prisma.Decimal(1000), startedAt: new Date(Date.now() - 3600_000) } });

  let n = 0;
  for (const [method, amount] of [['cash', 120], ['cash', 80], ['gcash', 50]] as const) {
    n += 1;
    await prisma.transaction.create({ data: { transactionNumber: `PC-RB${tag}-${n}`, branchId: branch.id, shiftId: shift.id, cashierId: cashier.id, status: 'completed', paymentMethod: method, subtotal: amount, vatAmount: 0, totalAmount: amount, inventoryDeductionStatus: 'completed' } });
  }

  const { extraSuppliesService } = await import('../src/modules/extra-supplies/extra-supplies.service.js');
  const card = await extraSuppliesService.create({ name: `RB Extra Cup ${tag}`, inventory_item_id: item.id, issue_unit_name: 'cup', entered_quantity: 1, entered_unit_id: pc.id, selling_price: 5, apply_to_pos: true, branch_ids: [branch.id] }, { id: supervisor.id, role: 'supervisor' }, null);
  const actor = { id: cashier.id, role: 'staff' };
  const issue = (input: Record<string, unknown>) => extraSuppliesService.createIssue({ operation_id: randomUUID(), branch_id: branch.id, lines: [{ extra_supply_id: card.id, quantity: 1, version: card.version }], ...input } as never, branch.id, shift.id, actor, null);
  await issue({ kind: 'paid', lines: [{ extra_supply_id: card.id, quantity: 4, version: card.version }], payment_method: 'cash', cash_tendered: 20 });
  await issue({ kind: 'free', lines: [{ extra_supply_id: card.id, quantity: 3, version: card.version }], reason: 'Customer asked for extra' });
  await issue({ kind: 'paid', lines: [{ extra_supply_id: card.id, quantity: 2, version: card.version }], payment_method: 'gcash', payment_proof_key: `${branch.id}/${shift.id}/${cashier.id}-1-a.webp`, payment_proof_type: 'gallery_upload' });
  const uncertainOperation = randomUUID();
  await issue({ operation_id: uncertainOperation, kind: 'paid', payment_method: 'cash', cash_tendered: 5 });

  // The cash really in the drawer: opening + cash sales + cash supply collections.
  const drawer = 1000 + 120 + 80 + 20 + 5;
  const state: State = { branch: branch.id, cashier: cashier.id, supervisor: supervisor.id, item: item.id, card: card.id, cardVersion: card.version, shift: shift.id, uncertainOperation, drawer };
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  const stock = await prisma.inventoryStock.findFirstOrThrow({ where: { branchId: branch.id, inventoryItemId: item.id } });
  console.log(JSON.stringify({ phase, drawer, stock_after_issues: stock.quantityOnHand.toNumber(), summary: pickSummary((await cashService.getShiftSummary(shift.id)).summary as never) }));
}

async function summary(): Promise<void> {
  const s = load();
  const result = await cashService.getShiftSummary(s.shift);
  console.log(JSON.stringify({ phase, shift_status: result.shift.status, summary: pickSummary(result.summary as never) }));
}

async function close(): Promise<void> {
  const s = load();
  const denominations = [{ denomination: 1000, quantity: 1 }, { denomination: 200, quantity: 1 }, { denomination: 20, quantity: 1 }, { denomination: 5, quantity: 1 }];
  // Pre-P61 code sees the supply cash as an overage and requires a written reason;
  // P62_VARIANCE_EXPLANATION supplies the one an operator would have to write.
  const varianceExplanation = process.env.P62_VARIANCE_EXPLANATION;
  const closed = (await cashService.closeShift(s.shift, { denominations, cashierConfirmed: true, ...(varianceExplanation && { varianceExplanation }) } as never, { id: s.cashier, role: 'staff' }, null)) as Record<string, unknown>;
  const keys = ['status', 'cash_sales_total', 'gross_sales_total', 'closing_cash_amount', 'expected_closing_cash', 'cash_variance', 'variance_approved'];
  console.log(JSON.stringify({ phase, counted: s.drawer, closed: Object.fromEntries(keys.map((k) => [k, closed[k]])) }));
}

async function verify(): Promise<void> {
  const s = load();
  const { extraSuppliesService } = await import('../src/modules/extra-supplies/extra-supplies.service.js');
  const issues = await prisma.extraSupplyIssue.count({ where: { shiftId: s.shift } });
  const stock = await prisma.inventoryStock.findFirstOrThrow({ where: { branchId: s.branch, inventoryItemId: s.item } });
  const movements = await prisma.inventoryStockMovement.count({ where: { branchId: s.branch, inventoryItemId: s.item } });
  const op = await extraSuppliesService.getOperation(s.uncertainOperation, { id: s.cashier, role: 'staff' });
  const result = await cashService.getShiftSummary(s.shift);
  const shift = await prisma.shift.findUniqueOrThrow({ where: { id: s.shift } });
  console.log(JSON.stringify({
    phase, issues, stock: stock.quantityOnHand.toNumber(), movements, uncertain_operation: op.status,
    saved: { expected_closing_cash: shift.expectedClosingCash?.toNumber(), cash_variance: shift.cashVariance?.toNumber(), closing_cash: shift.closingCashAmount?.toNumber() },
    summary: pickSummary(result.summary as never),
  }));
}

const phases: Record<string, () => Promise<void>> = { setup, summary, close, verify };
const run = phases[phase];
if (!run) { console.error('usage: p62-rollback-rehearsal.ts setup|summary|close|verify'); process.exit(2); }
run()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (error) => { console.error(error); await prisma.$disconnect(); process.exit(1); });
