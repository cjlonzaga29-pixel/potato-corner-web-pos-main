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
  constructor(
    public readonly code: PdfRenderErrorCode,
    override?: { message: string; retryAfterSeconds: number | undefined },
  ) {
    const response = ERROR_RESPONSES[code];
    super(override?.message ?? response.message);
    this.name = 'PdfRenderError';
    this.statusCode = response.status;
    this.retryAfterSeconds = override ? override.retryAfterSeconds : response.retryAfterSeconds;
  }
}

/**
 * POS-PERF-P62 — answers for an interactive request that could not finish before
 * its deadline, given at once instead of after waiting the deadline out.
 */
export function busyUntil(waitMs: number): PdfRenderError {
  const seconds = Math.min(120, Math.max(5, Math.ceil(waitMs / 1000) + 2));
  return new PdfRenderError('PDF_BUSY', {
    message: `Another PDF is being made right now, and this one could not be finished in time, so it was not started. Try again in about ${seconds} seconds, choose a shorter date range, or download a CSV.`,
    retryAfterSeconds: seconds,
  });
}

export function tooLongToFinish(): PdfRenderError {
  return new PdfRenderError('PDF_TIMEOUT', {
    message: 'This PDF would take too long to make, so it was not started. Choose a shorter date range, or download a CSV.',
    retryAfterSeconds: undefined,
  });
}

/** Abort reason for an interactive request that ran past PDF_REQUEST_DEADLINE_MS. */
export const PDF_REQUEST_DEADLINE = Symbol('pdf-request-deadline');

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

/**
 * POS-PERF-P62 — the estimate learns half from each new render, so a change in data
 * shape shows within a few exports; a prediction must be at least 10% past the
 * deadline before anything is refused on it (measured spread of equal 7-day
 * renders: about ±8%, runbook §3).
 */
const ESTIMATE_WEIGHT = 0.5;
const ESTIMATE_FIT = 0.9;

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
  kind: PdfRenderKind;
  /** Serialized input size: render time grows with it (runbook §3). */
  bytes: number;
  /** Interactive requests only: the moment the person's request gives up (PDF_REQUEST_DEADLINE_MS). */
  deadlineAt: number | undefined;
  arrivedAt: number;
  /** When the renderer started on it (after worker start-up), for the timing estimate. */
  startedAt: number | null;
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

/**
 * Operating-system locations only, never configuration: without them Windows
 * resolves os.tmpdir() to the relative path "undefined\temp", and tsx (tests,
 * development) writes its cache into the working directory.
 */
const WORKER_OS_VARIABLES = ['TEMP', 'TMP', 'TMPDIR', 'SystemRoot'] as const;

export function workerEnvironment(): Record<string, string> {
  const env: Record<string, string> = { NODE_ENV: process.env.NODE_ENV ?? 'production', TZ: process.env.TZ ?? 'Asia/Manila' };
  for (const name of WORKER_OS_VARIABLES) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

function defaultWorkerUrl(): URL {
  return new URL(import.meta.url.endsWith('.ts') ? './pdf-render.worker.ts' : './pdf-render.worker.js', import.meta.url);
}

export function createPdfRenderPool(overrides: Partial<PdfRenderPoolOptions> = {}) {
  const options = { ...DEFAULT_PDF_POOL_OPTIONS, ...overrides };
  const queue: Job[] = [];
  const workers = new Set<PoolWorker>();
  let closed = false;

  // POS-PERF-P62 — deadline-aware admission. Measured (runbook §3): every refused
  // interactive PDF used to wait the full 25s deadline before being told, and the
  // job behind a long render was started and then terminated part-way, wasting the
  // only worker. Render time grows with the input, so the pool learns each kind's
  // milliseconds per serialized byte from finished renders, and refuses at once a
  // request that cannot finish before its own deadline. Until a kind has a
  // measurement nothing is refused on a prediction.
  const msPerByte = new Map<PdfRenderKind, number>();
  const estimateMs = (job: Pick<Job, 'kind' | 'bytes'>): number | undefined => {
    const rate = msPerByte.get(job.kind);
    return rate === undefined ? undefined : rate * job.bytes;
  };
  function learn(job: Job, renderMs: number): void {
    const rate = renderMs / Math.max(job.bytes, 1);
    const previous = msPerByte.get(job.kind);
    msPerByte.set(job.kind, previous === undefined ? rate : previous * (1 - ESTIMATE_WEIGHT) + rate * ESTIMATE_WEIGHT);
  }
  /** When a job joining the end of the queue would start, by the estimates known now. */
  function expectedStartAt(now: number): number {
    const slots: number[] = [];
    for (const entry of workers) {
      if (!entry.current) continue;
      const estimate = estimateMs(entry.current);
      slots.push(estimate === undefined ? now : Math.max(now, (entry.current.startedAt ?? now) + estimate));
    }
    while (slots.length < options.concurrency) slots.push(now);
    slots.sort((a, b) => a - b);
    for (const job of queue) {
      slots[0] = (slots[0] ?? now) + (estimateMs(job) ?? 0);
      slots.sort((a, b) => a - b);
    }
    return slots[0] ?? now;
  }
  /** The refusal for a job that can't finish by its deadline if it starts at startAt, or null. */
  function deadlineRefusal(job: Job, startAt: number, now: number): PdfRenderError | null {
    const estimate = estimateMs(job);
    if (job.deadlineAt === undefined || estimate === undefined) return null;
    if (startAt + estimate * ESTIMATE_FIT <= job.deadlineAt) return null;
    // Even started the moment it arrived it couldn't finish: waiting wouldn't help.
    if (job.arrivedAt + estimate * ESTIMATE_FIT > job.deadlineAt) return tooLongToFinish();
    return busyUntil(startAt - now);
  }

  /** A request deadline (cancelPdfWhenClientLeaves) aborts with DEADLINE; anything else is the client leaving. */
  const abortCode = (signal: AbortSignal | undefined, running: boolean): PdfRenderErrorCode =>
    signal?.reason === PDF_REQUEST_DEADLINE ? (running ? 'PDF_TIMEOUT' : 'PDF_BUSY') : 'PDF_CANCELLED';

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
      env: workerEnvironment(),
      resourceLimits: { maxOldGenerationSizeMb: options.maxHeapMb },
    });
    const entry: PoolWorker = { worker, jobs: 0, idleTimer: null, current: null, renderTimer: null, ready: false };
    workers.add(entry);
    worker.on('message', (message: { ready: true } | { ok: true; pdf: Uint8Array } | { ok: false }) => {
      if ('ready' in message) {
        entry.ready = true;
        if (entry.current) {
          entry.current.startedAt = Date.now();
          armRenderTimer(entry);
        }
        return;
      }
      const job = entry.current;
      if (!job) return;
      if (message.ok && job.startedAt !== null) learn(job, Date.now() - job.startedAt);
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
    if (entry.ready) {
      job.startedAt = Date.now();
      armRenderTimer(entry);
    }
    else entry.renderTimer = setTimeout(() => fail(entry, 'PDF_FAILED'), options.startupTimeoutMs);
    settleAbortListener(job);
    if (job.signal) {
      // terminate() stops the thread even in the middle of synchronous layout.
      job.onAbort = () => fail(entry, abortCode(job.signal, true));
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
      // Don't start what the deadline would stop part-way: that time belongs to the next job.
      const now = Date.now();
      const refusal = deadlineRefusal(job, now, now);
      if (refusal) {
        settleAbortListener(job);
        job.reject(refusal);
        continue;
      }
      run(idle ?? spawn(), job);
    }
  }

  return {
    /** deadlineAt: an interactive request's deadline (epoch ms); the background queue passes none. */
    render(kind: PdfRenderKind, args: unknown[], signal?: AbortSignal, deadlineAt?: number): Promise<Buffer> {
      return new Promise<Buffer>((resolve, reject) => {
        if (closed || signal?.aborted) {
          reject(new PdfRenderError(closed ? 'PDF_CANCELLED' : abortCode(signal, false)));
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
        const arrivedAt = Date.now();
        const job: Job = { kind, bytes: payload.byteLength, deadlineAt, arrivedAt, startedAt: null, payload, signal, resolve, reject, queueTimer: null, onAbort: null };
        const refusal = deadlineRefusal(job, expectedStartAt(arrivedAt), arrivedAt);
        if (refusal) {
          reject(refusal);
          return;
        }
        job.queueTimer = setTimeout(() => {
          queue.splice(queue.indexOf(job), 1);
          settleAbortListener(job);
          reject(new PdfRenderError('PDF_BUSY'));
        }, options.queueWaitMs);
        if (signal) {
          job.onAbort = () => {
            queue.splice(queue.indexOf(job), 1);
            if (job.queueTimer) clearTimeout(job.queueTimer);
            reject(new PdfRenderError(abortCode(signal, false)));
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

const clientAbort = new AsyncLocalStorage<{ signal: AbortSignal; deadlineAt: number }>();

/**
 * POS-PERF-P62 — an interactive PDF request must answer before the proxy in front
 * of the API gives up on it. Measured: the web's /api rewrite cut every export at
 * 30.0s and the browser got a bare 500 instead of the message below (P62 runbook
 * §3). 25s leaves room for the route's own database reads and the transfer. Past
 * it, a job still queued is refused PDF_BUSY and a running one PDF_TIMEOUT, both
 * telling the person to try a shorter range or CSV; the thread is terminated.
 */
export const PDF_REQUEST_DEADLINE_MS = Number(process.env.PDF_REQUEST_DEADLINE_MS || 25_000);

/**
 * Stops the render when the person who asked has gone (a closed tab, a dropped
 * connection), so their abandoned file doesn't hold the only worker, and at the
 * request deadline above. The background report queue doesn't pass through here.
 */
export function cancelPdfWhenClientLeaves(_req: Request, res: Response, next: NextFunction): void {
  const controller = new AbortController();
  const deadlineAt = Date.now() + PDF_REQUEST_DEADLINE_MS;
  const deadline = setTimeout(() => controller.abort(PDF_REQUEST_DEADLINE), PDF_REQUEST_DEADLINE_MS);
  deadline.unref();
  res.once('close', () => {
    clearTimeout(deadline);
    if (!res.writableEnded) controller.abort();
  });
  clientAbort.run({ signal: controller.signal, deadlineAt }, next);
}

export function renderPdfIsolated(kind: PdfRenderKind, args: unknown[]): Promise<Buffer> {
  const request = clientAbort.getStore();
  return pdfRenderPool.render(kind, args, request?.signal, request?.deadlineAt);
}
