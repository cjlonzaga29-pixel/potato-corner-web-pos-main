import { describe, it, expect, afterEach } from 'vitest';
import { createPdfRenderPool, type PdfRenderKind } from './pdf-render-pool.js';
import { round, runOverrunScenario, type OverrunScenario } from './p62-pdf-admission.test-helpers.js';

/**
 * POS-PERF-P67 — opt-in timing distribution for the P62 deadline-aware admission
 * scenario ("does not start a queued job whose deadline can no longer be met").
 * The always-on test asserts the decision and its ordering; this file measures the
 * wall-clock latency, which depends on machine load (worker setTimeout and
 * cross-thread message latency), and fails only on a statistical regression.
 *
 *   P62_PDF_BENCH=1 [P62_PDF_BENCH_TRIALS=20] npx vitest run src/lib/reports/p62-pdf-admission.bench.test.ts
 */
const enabled = process.env.P62_PDF_BENCH === '1';
const trials = Number(process.env.P62_PDF_BENCH_TRIALS || 10);
const standIn = new URL('./__fixtures__/pdf-worker-standin.mjs', import.meta.url);
const pools: Array<ReturnType<typeof createPdfRenderPool>> = [];

afterEach(async () => {
  for (const created of pools.splice(0)) await created.shutdown();
});

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
};

describe.skipIf(!enabled)('P62 deadline-aware admission timing (opt-in benchmark)', () => {
  it(`refuses the queued job when its turn comes, across ${trials} trials`, async () => {
    const results: OverrunScenario[] = [];
    for (let i = 0; i < trials; i += 1) {
      const p = createPdfRenderPool({ workerUrl: standIn });
      pools.push(p);
      const scenario = await runOverrunScenario(p, 'slow' as PdfRenderKind);
      await p.shutdown();
      results.push(scenario);
      console.info(`P62-BENCH trial ${i + 1} ${JSON.stringify(round(scenario))}`);
    }
    const summary = (pick: (s: OverrunScenario) => number) => {
      const values = results.map(pick);
      return { p50: Math.round(quantile(values, 0.5)), p90: Math.round(quantile(values, 0.9)), max: Math.round(Math.max(...values)) };
    };
    const oldBoundMisses = results.filter((s) => s.queuedMs >= 1_090).length;
    console.info(
      `P62-BENCH summary ${JSON.stringify({
        trials,
        overrunMs: summary((s) => s.overrunMs),
        queuedMs: summary((s) => s.queuedMs),
        gapMs: summary((s) => s.gapMs),
        worstLoopGapMs: summary((s) => s.worstLoopGapMs),
        oldAbsoluteBoundMisses: oldBoundMisses,
      })}`,
    );
    // Every trial: the decision itself.
    for (const s of results) {
      expect(s.first.code).toBe('resolved');
      expect(s.second.code).toBe('PDF_BUSY');
    }
    // Statistical regression check: the refusal follows the overrun by far less than
    // the 100ms render it would have run; typical overrun lateness stays modest.
    expect(quantile(results.map((s) => s.gapMs), 0.5)).toBeLessThan(20);
    expect(quantile(results.map((s) => s.overrunMs), 0.5)).toBeLessThan(1_000 + 250);
  }, 600_000);
});
