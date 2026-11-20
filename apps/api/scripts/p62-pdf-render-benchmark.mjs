// POS-PERF-P62 — PDF rendering on the production build: cold start, and the
// request thread's worst stall while a Transaction PDF renders on it (the old
// behaviour) versus in the isolated worker (the P62 behaviour).
//
// Plain Node against dist/, no tsx, no database, no secrets. Run after
// `npm run build` (tsc) from apps/api:
//   node scripts/p62-pdf-render-benchmark.mjs [rows,rows,...] [repetitions] [out.json]
// Prints JSON and, when a path is given, writes it there.
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';

const rowCounts = (process.argv[2] ?? '100,300').split(',').map(Number);
const repetitions = Number(process.argv[3] ?? 3);
const out = process.argv[4];

process.env.NODE_ENV = 'production';
process.env.TZ = 'Asia/Manila';

const coldStart = performance.now();
const exportsModule = await import('../dist/lib/reports/transactions-export.js');
const poolModule = await import('../dist/lib/reports/pdf-render-pool.js');
const builderImportMs = performance.now() - coldStart;

function rows(count) {
  return Array.from({ length: count }, (_, index) => ({
    created_at: '2026-11-20 10:00',
    branch: 'P62 Branch',
    receipt_number: `PC-P62-20261120-${String(index + 1).padStart(6, '0')}`,
    cashier: 'Ana Cruz',
    payment: index % 4 === 0 ? 'gcash' : 'cash',
    reference: index % 4 === 0 ? `GC${100000 + index}` : '—',
    subtotal: '125.00',
    discount: index % 3 === 0 ? '12.50' : '0.00',
    discount_type: index % 3 === 0 ? 'Loyalty' : '—',
    customer_id: '—',
    total: index % 3 === 0 ? '112.50' : '125.00',
    status: 'completed',
  }));
}

/** Runs fn while a 10ms timer measures the worst gap the event loop could not answer in. */
async function measure(fn) {
  let worst = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 10);
  const started = performance.now();
  const pdf = await fn();
  const totalMs = performance.now() - started;
  clearInterval(timer);
  worst = Math.max(worst, performance.now() - last);
  return { totalMs: Math.round(totalMs), worstLoopGapMs: Math.round(worst), bytes: pdf.byteLength, pages: (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length };
}

const scope = (count) => ({ kind: 'filtered', filterLines: ['Branch: P62 Branch'], totalCount: count });

// First worker job pays the worker's own start-up (loading react-pdf).
const firstWorkerJob = await measure(() => exportsModule.generateTransactionsPdf(rows(1), scope(1), 'POTATO CORNER'));

const results = [];
for (const count of rowCounts) {
  for (let rep = 1; rep <= repetitions; rep += 1) {
    results.push({ mode: 'request-thread', rows: count, rep, ...(await measure(() => exportsModule.renderTransactionsPdf(rows(count), scope(count), 'POTATO CORNER'))) });
    results.push({ mode: 'worker', rows: count, rep, ...(await measure(() => exportsModule.generateTransactionsPdf(rows(count), scope(count), 'POTATO CORNER'))) });
  }
}
await poolModule.pdfRenderPool.shutdown();

let sha = 'unknown';
try {
  sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch {
  // not a git checkout
}
const report = {
  recordedAt: new Date().toISOString(),
  sha,
  workingTreeDirty: (() => {
    try {
      return execSync('git status --porcelain -- src', { encoding: 'utf8' }).trim().length > 0;
    } catch {
      return null;
    }
  })(),
  node: process.version,
  machine: { platform: process.platform, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? 'unknown', memoryGb: Math.round(os.totalmem() / 1e9), loadAvg: os.loadavg() },
  builderImportMs: Math.round(builderImportMs),
  firstWorkerJob,
  results,
};
const json = JSON.stringify(report, null, 2);
if (out) writeFileSync(out, `${json}\n`);
console.log(json);
