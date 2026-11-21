import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma } from '@prisma/client';
import {
  createPdfRenderPool,
  PdfRenderError,
  PDF_REQUEST_DEADLINE,
  PDF_REQUEST_DEADLINE_MS,
  toPlainData,
  type PdfRenderKind,
} from './pdf-render-pool.js';
import { generateTransactionsPdf, type TransactionExportRow } from './transactions-export.js';

/**
 * POS-PERF-P62 — PDF rendering runs in a bounded worker pool, never on the
 * request thread. Stand-in workers (__fixtures__/pdf-worker-standin.mjs) prove
 * crash, hang, cancellation and size handling; the real worker renders a
 * paginated Transaction PDF while the main thread keeps answering.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const standIn = new URL('./__fixtures__/pdf-worker-standin.mjs', import.meta.url);
const pools: Array<ReturnType<typeof createPdfRenderPool>> = [];

function pool(overrides: Parameters<typeof createPdfRenderPool>[0] = {}) {
  const created = createPdfRenderPool({ workerUrl: standIn, ...overrides });
  pools.push(created);
  return created;
}

const asKind = (kind: string) => kind as PdfRenderKind;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof PdfRenderError ? error.code : `other:${String(error)}`;
  }
}

afterEach(async () => {
  for (const created of pools.splice(0)) await created.shutdown();
});

describe('PDF deadline-aware admission (P62)', () => {
  /** Rejection with its timing: how long the caller waited for the answer. */
  async function outcome(promise: Promise<unknown>) {
    const t0 = Date.now();
    try {
      await promise;
      return { code: 'resolved', ms: Date.now() - t0, error: null as PdfRenderError | null };
    } catch (error) {
      return { code: error instanceof PdfRenderError ? error.code : 'other', ms: Date.now() - t0, error: error instanceof PdfRenderError ? error : null };
    }
  }

  it('refuses at once, with how long to wait, a request that could not finish before its deadline', async () => {
    const p = pool();
    await p.render(asKind('slow'), [400]); // a measurement: ~400ms for this size
    const first = p.render(asKind('slow'), [400], undefined, Date.now() + 10_000);
    // Long enough for the job alone (~400ms), not after the one running ahead of it.
    const second = await outcome(p.render(asKind('slow'), [400], undefined, Date.now() + 600));
    expect(second.code).toBe('PDF_BUSY');
    expect(second.ms).toBeLessThan(100); // not after waiting out the deadline
    expect(second.error?.retryAfterSeconds).toBeGreaterThanOrEqual(5);
    expect(second.error?.message).toMatch(/Try again in about \d+ seconds, choose a shorter date range, or download a CSV/);
    expect(await codeOf(first)).toBe('resolved');
  });

  it('admits a request that fits before its deadline', async () => {
    const p = pool();
    await p.render(asKind('slow'), [200]);
    const first = p.render(asKind('slow'), [200], undefined, Date.now() + 10_000);
    const second = p.render(asKind('slow'), [200], undefined, Date.now() + 5_000);
    expect(await Promise.all([codeOf(first), codeOf(second)])).toEqual(['resolved', 'resolved']);
  });

  it('refuses nothing on a prediction before the first measurement', async () => {
    const p = pool();
    expect(await codeOf(p.render(asKind('slow'), [300], undefined, Date.now() + 50))).toBe('resolved');
  });

  it('says at once when even an idle worker could not finish in time (shorter range or CSV)', async () => {
    const p = pool();
    await p.render(asKind('slow'), [400]);
    const result = await outcome(p.render(asKind('slow'), [400], undefined, Date.now() + 200));
    expect(result.code).toBe('PDF_TIMEOUT');
    expect(result.ms).toBeLessThan(100);
    expect(result.error?.message).toMatch(/would take too long to make, so it was not started/);
    expect(result.error?.retryAfterSeconds).toBeUndefined();
  });

  it('does not start a queued job whose deadline can no longer be met when its turn comes', async () => {
    const p = pool();
    await p.render(asKind('slow'), [100]); // learns ~100ms
    const t0 = Date.now();
    const overrun = p.render(asKind('slow'), [1000]); // the same size, but 1s: the estimate is wrong
    // Admitted: predicted to start at ~100ms. The overrun also teaches the pool a
    // higher estimate (~550ms), still inside this job's own 800ms window.
    const queued = outcome(p.render(asKind('slow'), [100], undefined, Date.now() + 800));
    const [first, second] = await Promise.all([codeOf(overrun), queued]);
    expect(first).toBe('resolved');
    expect(second.code).toBe('PDF_BUSY');
    // Refused when its turn came (~1s), not started and run for another ~100ms.
    expect(Date.now() - t0).toBeLessThan(1_090);
    expect(p.stats()).toMatchObject({ running: 0, queued: 0 });
  });

  it('leaves requests without a deadline (the background report queue) alone', async () => {
    const p = pool();
    await p.render(asKind('slow'), [300]);
    const jobs = [p.render(asKind('slow'), [300]), p.render(asKind('slow'), [300]), p.render(asKind('slow'), [300])];
    expect(await Promise.all(jobs.map(codeOf))).toEqual(['resolved', 'resolved', 'resolved']);
  });
});

describe('PDF render pool (P62)', () => {
  it('renders through a worker and returns the bytes', async () => {
    const pdf = await pool().render(asKind('ok'), []);
    expect(pdf.toString()).toBe('%PDF-ok');
  });

  it('refuses work beyond the running and queued limits with PDF_BUSY, and runs the rest', async () => {
    const limited = pool({ concurrency: 1, maxQueued: 2 });
    const jobs = Array.from({ length: 5 }, () => limited.render(asKind('slow'), [150]));
    const codes = await Promise.all(jobs.map(codeOf));
    expect(codes.filter((code) => code === 'resolved')).toHaveLength(3);
    expect(codes.filter((code) => code === 'PDF_BUSY')).toHaveLength(2);
    expect(limited.stats()).toMatchObject({ running: 0, queued: 0 });
  });

  it('gives up on a job that waited too long in the queue', async () => {
    const limited = pool({ concurrency: 1, maxQueued: 4, queueWaitMs: 100 });
    const first = limited.render(asKind('slow'), [400]);
    const second = limited.render(asKind('ok'), []);
    expect(await codeOf(second)).toBe('PDF_BUSY');
    expect(await codeOf(first)).toBe('resolved');
  });

  it('stops a synchronous hang with PDF_TIMEOUT and keeps serving afterwards', async () => {
    const limited = pool({ renderTimeoutMs: 300 });
    const started = Date.now();
    expect(await codeOf(limited.render(asKind('hang'), []))).toBe('PDF_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await limited.render(asKind('ok'), [])).toString()).toBe('%PDF-ok');
  });

  it('gives up on a worker that never finishes loading, without counting load time against renders', async () => {
    const stuck = pool({ workerUrl: new URL('./__fixtures__/pdf-worker-never-ready.mjs', import.meta.url), startupTimeoutMs: 300, renderTimeoutMs: 60_000 });
    expect(await codeOf(stuck.render(asKind('ok'), []))).toBe('PDF_FAILED');
    expect(stuck.stats().workers).toBe(0);
  });

  it('reports a worker crash, an early exit and a render failure as PDF_FAILED, then recovers', async () => {
    const limited = pool();
    expect(await codeOf(limited.render(asKind('crash'), []))).toBe('PDF_FAILED');
    expect(await codeOf(limited.render(asKind('exit'), []))).toBe('PDF_FAILED');
    expect(await codeOf(limited.render(asKind('fail'), []))).toBe('PDF_FAILED');
    expect((await limited.render(asKind('ok'), [])).toString()).toBe('%PDF-ok');
  });

  it('refuses oversized input before it reaches a worker, and an oversized result after', async () => {
    const limited = pool({ maxInputBytes: 1024, maxResultBytes: 2048 });
    expect(await codeOf(limited.render(asKind('ok'), ['x'.repeat(4096)]))).toBe('PDF_TOO_LARGE');
    expect(limited.stats().workers).toBe(0);
    expect(await codeOf(limited.render(asKind('big'), [4096]))).toBe('PDF_TOO_LARGE');
  });

  it('cancels queued and running jobs when the caller goes away', async () => {
    const limited = pool({ concurrency: 1 });
    const running = new AbortController();
    const queued = new AbortController();
    const first = limited.render(asKind('hang'), [], running.signal);
    const second = limited.render(asKind('ok'), [], queued.signal);
    queued.abort();
    expect(await codeOf(second)).toBe('PDF_CANCELLED');
    running.abort();
    expect(await codeOf(first)).toBe('PDF_CANCELLED');
    expect((await limited.render(asKind('ok'), [])).toString()).toBe('%PDF-ok');
  });

  it('at the request deadline, a queued job is PDF_BUSY and a running one PDF_TIMEOUT; the pool recovers', async () => {
    // P62 browser run: the web's /api rewrite cut exports at 30.0s with a bare 500.
    const limited = pool({ concurrency: 1 });
    const running = new AbortController();
    const queued = new AbortController();
    const first = limited.render(asKind('hang'), [], running.signal);
    const second = limited.render(asKind('ok'), [], queued.signal);
    queued.abort(PDF_REQUEST_DEADLINE);
    expect(await codeOf(second)).toBe('PDF_BUSY');
    running.abort(PDF_REQUEST_DEADLINE);
    expect(await codeOf(first)).toBe('PDF_TIMEOUT');
    expect(limited.stats()).toMatchObject({ running: 0, queued: 0 });
    const late = new AbortController();
    late.abort(PDF_REQUEST_DEADLINE);
    expect(await codeOf(limited.render(asKind('ok'), [], late.signal))).toBe('PDF_BUSY');
    expect((await limited.render(asKind('ok'), [])).toString()).toBe('%PDF-ok');
    expect(PDF_REQUEST_DEADLINE_MS).toBeLessThan(30_000);
  });

  it('shutdown refuses queued work, stops running work and accepts nothing more', async () => {
    const limited = pool({ concurrency: 1 });
    const running = limited.render(asKind('hang'), []);
    const queued = limited.render(asKind('ok'), []);
    await limited.shutdown();
    expect(await codeOf(running)).toBe('PDF_CANCELLED');
    expect(await codeOf(queued)).toBe('PDF_CANCELLED');
    expect(await codeOf(limited.render(asKind('ok'), []))).toBe('PDF_CANCELLED');
  });

  it('gives the worker no secrets: NODE_ENV, TZ and OS temp locations only', async () => {
    process.env.P62_CANARY_SECRET = 'must-not-reach-the-worker';
    try {
      const keys = JSON.parse((await pool().render(asKind('env'), [])).toString()) as string[];
      expect(keys).toEqual(expect.arrayContaining(['NODE_ENV', 'TZ']));
      expect(keys.every((key) => ['NODE_ENV', 'TZ', 'TEMP', 'TMP', 'TMPDIR', 'SystemRoot'].includes(key))).toBe(true);
      expect(keys).not.toContain('P62_CANARY_SECRET');
    } finally {
      delete process.env.P62_CANARY_SECRET;
    }
  });

  it('turns class instances such as Prisma Decimal into their printed text', () => {
    expect(toPlainData({ total: new Prisma.Decimal('1234.50'), when: new Date(0), rows: [{ n: 1 }] })).toEqual({
      total: '1234.5',
      when: new Date(0),
      rows: [{ n: 1 }],
    });
  });
});

describe('PDF routing (P62)', () => {
  const src = path.resolve(here, '../..');
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) files.push(full);
    }
  })(src);

  it('only the PDF worker imports a render* builder, and only builder files call renderToBuffer', () => {
    const renderers = /\b(renderReportPdf|renderTransactionsPdf|renderExpensesPdf|renderInventorySummaryPdf|renderPayrollPdf)\b/;
    const builders = new Set(['pdf.ts', 'transactions-export.ts', 'expenses-export.ts', 'inventory-summary-export.ts', 'payroll-export.ts']);
    const importers: string[] = [];
    const rendererCallers: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const base = path.basename(file);
      if (/^import[^;]*from/m.test(text) && text.split('\n').some((line) => line.startsWith('import') && renderers.test(line))) importers.push(base);
      if (/renderToBuffer\(/.test(text)) rendererCallers.push(base);
    }
    expect(importers).toEqual(['pdf-render.worker.ts']);
    expect(rendererCallers.every((name) => builders.has(name))).toBe(true);
  });

  it('every route that can return a PDF cancels the render when the client leaves', () => {
    const routers = ['modules/reports/reports.router.ts', 'modules/transactions/transactions.router.ts', 'modules/payroll/payroll.router.ts'];
    for (const router of routers) {
      expect(readFileSync(path.join(src, router), 'utf8')).toContain('cancelPdfWhenClientLeaves');
    }
  });
});

describe('real worker render (P62)', () => {
  function rows(count: number): TransactionExportRow[] {
    return Array.from({ length: count }, (_, index) => ({
      created_at: '2026-11-20 10:00',
      branch: 'P62 Branch',
      receipt_number: `PC-P62-20261120-${String(index + 1).padStart(6, '0')}`,
      cashier: 'Ana Cruz',
      payment: 'cash',
      reference: '—',
      subtotal: '125.00',
      discount: index % 3 === 0 ? '12.50' : '0.00',
      discount_type: index % 3 === 0 ? 'Loyalty' : '—',
      customer_id: '—',
      total: index % 3 === 0 ? '112.50' : '125.00',
      status: 'completed',
    }));
  }

  /** The text a PDF draws: its streams inflated, and the hex strings of its text operators decoded. */
  function pdfText(bytes: Buffer): string {
    const source = bytes.toString('latin1');
    const parts: string[] = [];
    for (const match of source.matchAll(/stream\r?\n/g)) {
      const start = (match.index ?? 0) + match[0].length;
      try {
        const content = inflateSync(bytes.subarray(start, source.indexOf('endstream', start))).toString('latin1');
        for (const op of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
          parts.push(Buffer.from([...(op[1] ?? '').matchAll(/<([0-9a-fA-F]*)>/g)].map((m) => m[1]).join(''), 'hex').toString('latin1'));
        }
      } catch {
        // Not a deflated text stream (an embedded font).
      }
    }
    return parts.join(' ');
  }
  const sheets = (pdf: Buffer) => pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;

  // POS-PERF-P62 — the cells' line height was resolved against another font size,
  // so every single-line row took about twice its height: 12 rows a sheet, 50 sheets
  // for 600 rows. Each 24-row group now fits its sheet (the first spills, under the title).
  it('fits a 24-row group of single-line rows on one sheet, and keeps every row and the page numbers', async () => {
    const pdf = await generateTransactionsPdf(rows(600), { kind: 'filtered', filterLines: ['Branch: P62 Branch'], totalCount: 600 }, 'POTATO CORNER');
    expect(sheets(pdf)).toBeLessThanOrEqual(27);
    const text = pdfText(pdf);
    for (const n of [1, 24, 25, 300, 600]) expect(text).toContain(`PC-P62-20261120-${String(n).padStart(6, '0')}`);
    expect(text).toContain(`Page ${sheets(pdf)} of ${sheets(pdf)}`);
  }, 120_000);

  it('still wraps long values over several lines without losing a row', async () => {
    const long = rows(120).map((row, i) => ({ ...row, cashier: 'Maria Concepcion Dela Cruz-Santiago Villanueva', discount_type: i % 2 ? 'Senior Citizen (RA 9994) with supporting ID on file' : row.discount_type }));
    const pdf = await generateTransactionsPdf(long, { kind: 'filtered', filterLines: ['Branch: P62 Branch'], totalCount: 120 }, 'POTATO CORNER');
    const single = await generateTransactionsPdf(rows(120), { kind: 'filtered', filterLines: ['Branch: P62 Branch'], totalCount: 120 }, 'POTATO CORNER');
    // Taller wrapped rows need more sheets than the same rows on one line each.
    expect(sheets(pdf)).toBeGreaterThan(sheets(single));
    const text = pdfText(pdf);
    for (let n = 1; n <= 120; n += 1) expect(text).toContain(`PC-P62-20261120-${String(n).padStart(6, '0')}`);
  }, 120_000);

  it('paginates a large Transaction PDF and keeps the main thread responsive while it renders', async () => {
    let worstGapMs = 0;
    let last = performance.now();
    const started = performance.now();
    let renderMs = 0;
    const ticker = setInterval(() => {
      const now = performance.now();
      worstGapMs = Math.max(worstGapMs, now - last);
      last = now;
    }, 10);
    try {
      const pdf = await generateTransactionsPdf(rows(600), { kind: 'filtered', filterLines: ['Branch: P62 Branch'], totalCount: 600 }, 'POTATO CORNER');
      renderMs = performance.now() - started;
      const text = pdf.toString('latin1');
      expect(text.startsWith('%PDF')).toBe(true);
      const pages = text.match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
      // 600 rows at 24 rows a sheet: 25 pages, not one page holding everything.
      expect(pages).toBeGreaterThanOrEqual(25);
    } finally {
      clearInterval(ticker);
    }
    // The timer kept firing throughout. On the request thread the whole render
    // (tens of seconds here) is one gap; machine load alone explains the rest.
    console.info(`P62 worker render: ${Math.round(renderMs)}ms, worst main-thread gap ${Math.round(worstGapMs)}ms`);
    expect(worstGapMs).toBeLessThan(Math.min(2000, renderMs / 10));
  }, 120_000);
});
