import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  maybeRunPoolerComparison,
  runPoolerComparison,
  schedulePoolerComparison,
  withDiagnosticConnectionLimit,
} from './pooler-comparison-diagnostics.js';

function makeFakePrisma(queryRaw: (...args: unknown[]) => Promise<unknown>) {
  return {
    $queryRaw: vi.fn(queryRaw),
    $disconnect: vi.fn(async () => undefined),
  } as unknown as PrismaClient & { $queryRaw: ReturnType<typeof vi.fn>; $disconnect: ReturnType<typeof vi.fn> };
}

const TRANSACTION_URL = 'postgresql://someuser:s3cr3t@db.example.internal:6543/mydb?pgbouncer=true&sslmode=require';
const SESSION_URL = 'postgresql://someuser:s3cr3t@db.example.internal:5432/mydb?sslmode=require';

describe('withDiagnosticConnectionLimit', () => {
  it('forces connection_limit=1 without touching other params', () => {
    const result = withDiagnosticConnectionLimit(TRANSACTION_URL);
    const url = new URL(result);
    expect(url.searchParams.get('connection_limit')).toBe('1');
    expect(url.searchParams.get('pgbouncer')).toBe('true');
    expect(url.searchParams.get('sslmode')).toBe('require');
  });
});

describe('runPoolerComparison', () => {
  it('alternates strictly sequentially between the two clients, never overlapping', async () => {
    let busy = false;
    let overlapDetected = false;
    const calls: string[] = [];
    function makeClient(label: string) {
      return makeFakePrisma(async () => {
        if (busy) overlapDetected = true;
        busy = true;
        calls.push(label);
        await new Promise((resolve) => setTimeout(resolve, 5));
        busy = false;
        return [{ '?column?': 1 }];
      });
    }
    const transactionClient = makeClient('transaction');
    const sessionClient = makeClient('session');
    await runPoolerComparison({ transactionClient, sessionClient }, vi.fn());

    expect(overlapDetected).toBe(false);
    expect(transactionClient.$queryRaw).toHaveBeenCalledTimes(6);
    expect(sessionClient.$queryRaw).toHaveBeenCalledTimes(6);
    expect(calls.slice(0, 4)).toEqual(['transaction', 'session', 'transaction', 'session']);
  });

  it('labels the first call of each mode separately from subsequent calls', async () => {
    const log = vi.fn();
    const transactionClient = makeFakePrisma(async () => [{ '?column?': 1 }]);
    const sessionClient = makeFakePrisma(async () => [{ '?column?': 1 }]);
    await runPoolerComparison({ transactionClient, sessionClient }, log);

    const callLogs = log.mock.calls.filter(([message]) => message.includes('] call'));
    expect(callLogs).toHaveLength(12);
    const firstTransaction = callLogs.find(([, payload]) => (payload as { mode: string; callIndex: number }).mode === 'transaction' && (payload as { callIndex: number }).callIndex === 0);
    const laterTransaction = callLogs.find(([, payload]) => (payload as { mode: string; callIndex: number }).mode === 'transaction' && (payload as { callIndex: number }).callIndex === 3);
    expect((firstTransaction?.[1] as { isFirstCall: boolean }).isFirstCall).toBe(true);
    expect((laterTransaction?.[1] as { isFirstCall: boolean }).isFirstCall).toBe(false);
  });

  it('a failing call stops the entire comparison and is sanitized (no raw error logged)', async () => {
    let transactionCalls = 0;
    const transactionClient = makeFakePrisma(async () => {
      transactionCalls += 1;
      if (transactionCalls === 2) throw new Error('raw postgres connection error with sensitive detail');
      return [{ '?column?': 1 }];
    });
    const sessionClient = makeFakePrisma(async () => [{ '?column?': 1 }]);
    const log = vi.fn();
    await runPoolerComparison({ transactionClient, sessionClient }, log);

    const allLoggedText = JSON.stringify(log.mock.calls);
    expect(allLoggedText).not.toContain('raw postgres connection error');
    expect(allLoggedText).not.toContain('sensitive detail');
    // One completed transaction call, one completed session call, then the
    // second transaction call fails and stops the whole comparison.
    expect(transactionClient.$queryRaw).toHaveBeenCalledTimes(2);
    expect(sessionClient.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('maybeRunPoolerComparison', () => {
  it('disabled: performs zero queries and never constructs diagnostic clients', async () => {
    const log = vi.fn();
    await maybeRunPoolerComparison(false, TRANSACTION_URL, SESSION_URL, log);
    expect(log).not.toHaveBeenCalled();
  });

  it('enabled but no session comparison URL configured: skips without error, logs the gap', async () => {
    const log = vi.fn();
    await maybeRunPoolerComparison(true, TRANSACTION_URL, undefined, log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('skipped'));
  });

  it('never leaks credentials or the full connection string into logs', async () => {
    const log = vi.fn();
    await maybeRunPoolerComparison(true, TRANSACTION_URL, SESSION_URL, log);
    const allLoggedText = JSON.stringify(log.mock.calls);
    expect(allLoggedText).not.toContain('someuser');
    expect(allLoggedText).not.toContain('s3cr3t');
    expect(allLoggedText).not.toContain('mydb');
  });
});

describe('schedulePoolerComparison', () => {
  function makeFakeScheduler() {
    let pendingCallback: (() => void) | undefined;
    let capturedDelayMs: number | undefined;
    const scheduleFn = vi.fn((callback: () => void, ms: number) => {
      pendingCallback = callback;
      capturedDelayMs = ms;
      return 0;
    });
    return {
      scheduleFn,
      fire: () => pendingCallback?.(),
      get delayMs() {
        return capturedDelayMs;
      },
    };
  }

  it('disabled: never schedules a timer', () => {
    const { scheduleFn } = makeFakeScheduler();
    schedulePoolerComparison(false, TRANSACTION_URL, SESSION_URL, vi.fn(), 60_000, scheduleFn);
    expect(scheduleFn).not.toHaveBeenCalled();
  });

  it('enabled: schedules exactly one timer at the given delay', () => {
    const { scheduleFn } = makeFakeScheduler();
    schedulePoolerComparison(true, TRANSACTION_URL, SESSION_URL, vi.fn(), 60_000, scheduleFn);
    expect(scheduleFn).toHaveBeenCalledTimes(1);
    expect(scheduleFn).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });
});
