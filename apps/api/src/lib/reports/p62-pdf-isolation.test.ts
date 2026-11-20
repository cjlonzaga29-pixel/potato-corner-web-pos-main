import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma } from '@prisma/client';
import {
  createPdfRenderPool,
  PdfRenderError,
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
