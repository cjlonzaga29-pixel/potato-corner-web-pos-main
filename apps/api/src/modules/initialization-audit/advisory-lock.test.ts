import { describe, it, expect } from 'vitest';

/**
 * Integration-style tests against the real dev database — same rationale as
 * R4/R5's precedent (see run-lifecycle.service.test.ts,
 * record-writer.service.test.ts): actual advisory-lock blocking behavior
 * against concurrent connections can't be meaningfully proven against a
 * mocked Postgres client.
 *
 * Gated on TEST_DATABASE_URL alone (NOT `&& TEST_REDIS_URL`) — this module
 * has no Redis dependency.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { withInitializationLock } = await import('./advisory-lock.js');

describe.skipIf(!canRunIntegrationTests)('withInitializationLock integration', () => {
  it('runs fn and returns its resolved value, with fn receiving the tx client (not the root prisma singleton)', async () => {
    const result = await withInitializationLock(async (tx) => {
      // A real query on `tx` proves it's a usable Prisma.TransactionClient,
      // not e.g. undefined or the root client passed through incorrectly.
      const rows = await tx.$queryRaw<{ one: number }[]>`SELECT 1 as one`;
      expect(rows[0]?.one).toBe(1);
      return 'fn-ran';
    });

    expect(result).toBe('fn-ran');
  });

  it('releases the lock after fn throws — a subsequent call succeeds promptly, proving the rolled-back transaction did not leave the lock held', async () => {
    const boom = new Error('simulated apply failure');

    await expect(
      withInitializationLock(async () => {
        throw boom;
      }),
    ).rejects.toThrow(boom);

    // If the first call's lock were still held (e.g. because the
    // transaction never actually rolled back, or pg_advisory_xact_lock
    // weren't truly transaction-scoped), this second call would hang until
    // it eventually times out. Racing it against a short timeout proves it
    // resolves promptly instead.
    const start = Date.now();
    const result = await Promise.race([
      withInitializationLock(async () => 'second-call-ran'),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 3_000)),
    ]);
    const elapsedMs = Date.now() - start;

    expect(result).toBe('second-call-ran');
    expect(elapsedMs).toBeLessThan(3_000);
  });

  it('a second concurrent call blocks until the first releases — the second fn does not start until the first fn has finished', async () => {
    const events: { call: 1 | 2; phase: 'start' | 'end'; at: number }[] = [];
    const HOLD_MS = 300;

    const first = withInitializationLock(async () => {
      events.push({ call: 1, phase: 'start', at: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      events.push({ call: 1, phase: 'end', at: Date.now() });
      return 'first';
    });

    // Give the first call a brief head start so it reliably acquires the
    // lock before the second call attempts to.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = withInitializationLock(async () => {
      events.push({ call: 2, phase: 'start', at: Date.now() });
      events.push({ call: 2, phase: 'end', at: Date.now() });
      return 'second';
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe('first');
    expect(secondResult).toBe('second');

    const firstEnd = events.find((e) => e.call === 1 && e.phase === 'end')?.at;
    const secondStart = events.find((e) => e.call === 2 && e.phase === 'start')?.at;
    expect(firstEnd).toBeDefined();
    expect(secondStart).toBeDefined();
    if (firstEnd === undefined || secondStart === undefined) throw new Error('unreachable: asserted above');

    // The genuine ordering proof: call 2's fn must not have started before
    // call 1's fn finished. A small tolerance absorbs clock/scheduling jitter
    // -- without real lock blocking, call 2 would start ~immediately
    // (within a few ms of call 1's start), well before call 1's ~300ms hold
    // ends, so this assertion would fail without correct locking.
    expect(secondStart + 5).toBeGreaterThanOrEqual(firstEnd);
  });
});

describe('compile-time shape (no DB access)', () => {
  it('withInitializationLock requires a fn argument — omitting it is a compile-time error', () => {
    // Type-only check: wrapped in a function that is defined but never
    // invoked, so `tsc` still evaluates the `@ts-expect-error` line (it
    // type-checks all reachable-by-declaration code, called or not) while
    // no runtime call — and therefore no real transaction/query — ever
    // occurs. The previous version called this directly at runtime, which
    // actually opened a real (if usually short-lived) transaction against
    // the live database despite the "no DB access" claim in this block's
    // name.
    const neverCalled = (): void => {
      // @ts-expect-error -- fn is required.
      void withInitializationLock();
    };
    void neverCalled;
    expect(true).toBe(true);
  });
});
