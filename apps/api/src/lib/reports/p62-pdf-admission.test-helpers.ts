// POS-PERF-P67 — test-only helper for the P62 "queued job whose deadline can no
// longer be met" scenario. Shared by p62-pdf-isolation.test.ts (deterministic
// assertions) and p62-pdf-admission.bench.test.ts (opt-in timing distribution).
import { PdfRenderError, type createPdfRenderPool, type PdfRenderKind } from './pdf-render-pool.js';

type Pool = ReturnType<typeof createPdfRenderPool>;

export interface Settled {
  code: string;
  error: PdfRenderError | null;
  /** performance.now() when the promise settled. */
  at: number;
}

export function settle(promise: Promise<unknown>): Promise<Settled> {
  return promise.then(
    () => ({ code: 'resolved', error: null, at: performance.now() }),
    (error: unknown) => ({
      code: error instanceof PdfRenderError ? error.code : `other:${String(error)}`,
      error: error instanceof PdfRenderError ? error : null,
      at: performance.now(),
    }),
  );
}

export interface OverrunScenario {
  first: Settled;
  second: Settled;
  /** Worker spawn + ready + the 100ms learning render. Never inside the measured window. */
  warmupMs: number;
  workersBeforeWindow: number;
  /** Window start (t0) to the 1s overrun's settlement: 1000ms nominal + timer/IPC latency. */
  overrunMs: number;
  /** Window start to the queued job's refusal. */
  queuedMs: number;
  /** Refusal minus overrun settlement: ~0 when refused the moment its turn came; >= the 100ms render if it had been run. */
  gapMs: number;
  /** Worst main-thread timer gap seen during the window (machine-load indicator). */
  worstLoopGapMs: number;
  stats: ReturnType<Pool['stats']>;
}

/**
 * The pool learns ~100ms per render, a same-size job then takes 1s (the estimate
 * is wrong), and a 100ms job with an 800ms deadline is queued behind it: admitted
 * on arrival, but by the time its turn comes its deadline can no longer be met.
 */
export async function runOverrunScenario(p: Pool, kind: PdfRenderKind): Promise<OverrunScenario> {
  const w0 = performance.now();
  await p.render(kind, [100]); // learns ~100ms (spawns the worker and waits for ready)
  const warmupMs = performance.now() - w0;
  const workersBeforeWindow = p.stats().workers;

  let worstLoopGapMs = 0;
  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    worstLoopGapMs = Math.max(worstLoopGapMs, now - last);
    last = now;
  }, 10);
  try {
    const t0 = performance.now();
    const overrun = settle(p.render(kind, [1000]));
    const queued = settle(p.render(kind, [100], undefined, Date.now() + 800));
    const [first, second] = await Promise.all([overrun, queued]);
    return {
      first,
      second,
      warmupMs,
      workersBeforeWindow,
      overrunMs: first.at - t0,
      queuedMs: second.at - t0,
      gapMs: second.at - first.at,
      worstLoopGapMs,
      stats: p.stats(),
    };
  } finally {
    clearInterval(ticker);
  }
}

export function round(scenario: OverrunScenario) {
  const r = (n: number) => Math.round(n);
  return {
    first: scenario.first.code,
    second: scenario.second.code,
    warmupMs: r(scenario.warmupMs),
    overrunMs: r(scenario.overrunMs),
    queuedMs: r(scenario.queuedMs),
    gapMs: r(scenario.gapMs),
    worstLoopGapMs: r(scenario.worstLoopGapMs),
  };
}
