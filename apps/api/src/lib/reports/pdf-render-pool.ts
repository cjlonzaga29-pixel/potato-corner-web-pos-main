// apps/api/src/lib/reports/pdf-render-pool.ts
//
// POS-PERF-P62 — every PDF is rendered in a worker thread, because react-pdf's
// layout is synchronous CPU work: on the request thread a 100-row Transaction PDF
// stopped the event loop, and so every branch's checkout and /health, for 7.7s on
// the P62 test laptop (runbook §3; earlier sessions measured up to 8.4s at about
// 267 rows). A Promise on the same event loop would not help. Each export builder's public function (generatePdf and
// friends) goes through here, so no route can reach the renderer directly; see
// p62-pdf-isolation.test.ts.
//
// This module must stay free of config, Prisma and anything else that reads secrets:
// the builders import it, and the worker imports the builders with an empty
// environment. A job carries only the rows and labels of one file, already authorized
// and scoped by the caller, never a token or credential.
import { AsyncLocalStorage } from 'node:async_hooks';
import { serialize } from 'node:v8';
import { Worker } from 'node:worker_threads';
import type { NextFunction, Request, Response } from 'express';

export type PdfRenderKind = 'report' | 'transactions' | 'expenses' | 'inventorySummary' | 'payroll';

export type PdfRenderErrorCode = 'PDF_BUSY' | 'PDF_TOO_LARGE' | 'PDF_TIMEOUT' | 'PDF_FAILED' | 'PDF_CANCELLED';

const ERROR_RESPONSES: Record<PdfRenderErrorCode, { status: number; message: string; retryAfterSeconds?: number }> = {
  PDF_BUSY: { status: 503, message: 'Several PDFs are being made right now, so this one was not started. Try again in a minute, or download a CSV.', retryAfterSeconds: 60 },
  PDF_TOO_LARGE: { status: 413, message: 'This report is too large for a PDF. Choose a shorter date range, or download a CSV.' },
  PDF_TIMEOUT: { status: 503, message: 'This PDF took too long to make and was stopped. Choose a shorter date range, or download a CSV.', retryAfterSeconds: 60 },
  PDF_FAILED: { status: 500, message: 'This PDF could not be made. No file was created. Try again, or download a CSV.' },
  PDF_CANCELLED: { status: 499, message: 'The PDF was cancelled.' },
};

export class PdfRenderError extends Error {
  readonly statusCode: number;
  readonly retryAfterSeconds: number | undefined;
  constructor(public readonly code: PdfRenderErrorCode) {
    const response = ERROR_RESPONSES[code];
    super(response.message);
    this.name = 'PdfRenderError';
    this.statusCode = response.status;
    this.retryAfterSeconds = response.retryAfterSeconds;
  }
}

/** Limits for one pool. The defaults and the measurements behind them are in the P62 runbook, §3. */
export interface PdfRenderPoolOptions {
  concurrency: number;
  maxQueued: number;
  queueWaitMs: number;
  /** Counted from the moment the worker has loaded the renderer, so a slow start never eats into it. */
  renderTimeoutMs: number;
  /** How long a new worker may take to load the renderer before it is given up on. */
  startupTimeoutMs: number;
  idleMs: number;
  jobsPerWorker: number;
  maxInputBytes: number;
  maxResultBytes: number;
  maxHeapMb: number;
  /** Tests only: a stand-in worker, to prove crash and hang handling. */
  workerUrl?: URL;
}

export const DEFAULT_PDF_POOL_OPTIONS: PdfRenderPoolOptions = {
  concurrency: 1,
  maxQueued: 4,
  queueWaitMs: 60_000,
  renderTimeoutMs: 120_000,
  startupTimeoutMs: 60_000,
  idleMs: 60_000,
  jobsPerWorker: 25,
  maxInputBytes: 32 * 1024 * 1024,
  maxResultBytes: 64 * 1024 * 1024,
  maxHeapMb: 512,
};

interface Job {
  payload: Uint8Array;
  signal: AbortSignal | undefined;
  resolve: (pdf: Buffer) => void;
  reject: (error: PdfRenderError) => void;
  queueTimer: NodeJS.Timeout | null;
  onAbort: (() => void) | null;
}

interface PoolWorker {
  worker: Worker;
  jobs: number;
  idleTimer: NodeJS.Timeout | null;
  current: Job | null;
  renderTimer: NodeJS.Timeout | null;
  /** Set by the worker's { ready: true } message, sent once its imports have loaded. */
  ready: boolean;
}

/**
 * A Prisma Decimal is a class instance, and cloning one for the worker would keep its
 * fields and lose its toString: every amount would print as "[object Object]". Anything
 * that isn't plain data becomes the string the renderer would have printed anyway.
 */
export function toPlainData(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(toPlainData);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return String(value);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toPlainData(entry)]));
}

function defaultWorkerUrl(): URL {
  return new URL(import.meta.url.endsWith('.ts') ? './pdf-render.worker.ts' : './pdf-render.worker.js', import.meta.url);
}

export function createPdfRenderPool(overrides: Partial<PdfRenderPoolOptions> = {}) {
  const options = { ...DEFAULT_PDF_POOL_OPTIONS, ...overrides };
  const queue: Job[] = [];
  const workers = new Set<PoolWorker>();
  let closed = false;

  function settleAbortListener(job: Job): void {
    if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort);
    job.onAbort = null;
  }

  function discard(entry: PoolWorker): void {
    workers.delete(entry);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.renderTimer) clearTimeout(entry.renderTimer);
    void entry.worker.terminate();
  }

  function finish(entry: PoolWorker, job: Job, settle: () => void): void {
    entry.current = null;
    if (entry.renderTimer) clearTimeout(entry.renderTimer);
    entry.renderTimer = null;
    settleAbortListener(job);
    settle();
  }

  function fail(entry: PoolWorker, code: PdfRenderErrorCode): void {
    const job = entry.current;
    discard(entry);
    if (job) finish(entry, job, () => job.reject(new PdfRenderError(code)));
    pump();
  }

  function spawn(): PoolWorker {
    const url = options.workerUrl ?? defaultWorkerUrl();
    const worker = new Worker(url, {
      // Under tsx or vitest the worker is TypeScript too; a production build runs plain JS.
      execArgv: url.pathname.endsWith('.ts') ? ['--import', 'tsx'] : [],
      // Nothing secret reaches the thread. Any import that needs config fails here at once.
      env: { NODE_ENV: process.env.NODE_ENV ?? 'production', TZ: process.env.TZ ?? 'Asia/Manila' },
      resourceLimits: { maxOldGenerationSizeMb: options.maxHeapMb },
    });
    const entry: PoolWorker = { worker, jobs: 0, idleTimer: null, current: null, renderTimer: null, ready: false };
    workers.add(entry);
    worker.on('message', (message: { ready: true } | { ok: true; pdf: Uint8Array } | { ok: false }) => {
      if ('ready' in message) {
        entry.ready = true;
        if (entry.current) armRenderTimer(entry);
        return;
      }
      const job = entry.current;
      if (!job) return;
      if (message.ok && message.pdf.byteLength > options.maxResultBytes) {
        finish(entry, job, () => job.reject(new PdfRenderError('PDF_TOO_LARGE')));
      } else if (message.ok) {
        const pdf = Buffer.from(message.pdf.buffer, message.pdf.byteOffset, message.pdf.byteLength);
        finish(entry, job, () => job.resolve(pdf));
      } else {
        finish(entry, job, () => job.reject(new PdfRenderError('PDF_FAILED')));
      }
      if (entry.jobs >= options.jobsPerWorker) discard(entry);
      else rest(entry);
      pump();
    });
    // Out of memory, an uncaught throw and a clean-but-early exit all arrive here.
    worker.on('error', (error) => {
      console.error('PDF worker failed:', error.name);
      fail(entry, 'PDF_FAILED');
    });
    worker.on('exit', () => {
      if (workers.has(entry)) fail(entry, 'PDF_FAILED');
    });
    return entry;
  }

  function armRenderTimer(entry: PoolWorker): void {
    if (entry.renderTimer) clearTimeout(entry.renderTimer);
    entry.renderTimer = setTimeout(() => fail(entry, 'PDF_TIMEOUT'), options.renderTimeoutMs);
  }

  function rest(entry: PoolWorker): void {
    entry.worker.unref();
    entry.idleTimer = setTimeout(() => discard(entry), options.idleMs);
    entry.idleTimer.unref();
  }

  function run(entry: PoolWorker, job: Job): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    entry.worker.ref();
    entry.current = job;
    entry.jobs += 1;
    if (entry.ready) armRenderTimer(entry);
    else entry.renderTimer = setTimeout(() => fail(entry, 'PDF_FAILED'), options.startupTimeoutMs);
    settleAbortListener(job);
    if (job.signal) {
      // terminate() stops the thread even in the middle of synchronous layout.
      job.onAbort = () => fail(entry, 'PDF_CANCELLED');
      job.signal.addEventListener('abort', job.onAbort, { once: true });
    }
    entry.worker.postMessage(job.payload, [job.payload.buffer as ArrayBuffer]);
  }

  function pump(): void {
    while (queue.length > 0 && !closed) {
      const idle = [...workers].find((entry) => entry.current === null);
      if (!idle && workers.size >= options.concurrency) return;
      const job = queue.shift();
      if (!job) return;
      if (job.queueTimer) clearTimeout(job.queueTimer);
      run(idle ?? spawn(), job);
    }
  }

  return {
    render(kind: PdfRenderKind, args: unknown[], signal?: AbortSignal): Promise<Buffer> {
      return new Promise<Buffer>((resolve, reject) => {
        if (closed || signal?.aborted) {
          reject(new PdfRenderError('PDF_CANCELLED'));
          return;
        }
        const running = [...workers].filter((entry) => entry.current !== null).length;
        if (queue.length >= options.maxQueued && running >= options.concurrency) {
          reject(new PdfRenderError('PDF_BUSY'));
          return;
        }
        const serialized = serialize({ kind, args: toPlainData(args) });
        if (serialized.byteLength > options.maxInputBytes) {
          reject(new PdfRenderError('PDF_TOO_LARGE'));
          return;
        }
        // A copy of its own, because v8.serialize can return a view into a shared pool
        // and the buffer is transferred to the worker.
        const payload = new Uint8Array(serialized);
        const job: Job = { payload, signal, resolve, reject, queueTimer: null, onAbort: null };
        job.queueTimer = setTimeout(() => {
          queue.splice(queue.indexOf(job), 1);
          settleAbortListener(job);
          reject(new PdfRenderError('PDF_BUSY'));
        }, options.queueWaitMs);
        if (signal) {
          job.onAbort = () => {
            queue.splice(queue.indexOf(job), 1);
            if (job.queueTimer) clearTimeout(job.queueTimer);
            reject(new PdfRenderError('PDF_CANCELLED'));
          };
          signal.addEventListener('abort', job.onAbort, { once: true });
        }
        queue.push(job);
        pump();
      });
    },
    stats() {
      return { workers: workers.size, running: [...workers].filter((entry) => entry.current !== null).length, queued: queue.length };
    },
    /** Graceful shutdown: refuses anything queued, and stops what is running. */
    async shutdown(): Promise<void> {
      closed = true;
      for (const job of queue.splice(0)) {
        if (job.queueTimer) clearTimeout(job.queueTimer);
        settleAbortListener(job);
        job.reject(new PdfRenderError('PDF_CANCELLED'));
      }
      for (const entry of [...workers]) fail(entry, 'PDF_CANCELLED');
    },
  };
}

export const pdfRenderPool = createPdfRenderPool();

const clientAbort = new AsyncLocalStorage<AbortSignal>();

/**
 * Stops the render when the person who asked has gone (a closed tab, a dropped
 * connection), so their abandoned file doesn't hold the only worker.
 */
export function cancelPdfWhenClientLeaves(_req: Request, res: Response, next: NextFunction): void {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  clientAbort.run(controller.signal, next);
}

export function renderPdfIsolated(kind: PdfRenderKind, args: unknown[]): Promise<Buffer> {
  return pdfRenderPool.render(kind, args, clientAbort.getStore());
}
