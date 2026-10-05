import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  extractSafeConnectionMetadata,
  maybeRunDatabaseRoundTripDiagnostics,
  runDatabaseRoundTripDiagnostics,
  scheduleSettledDatabaseRoundTripDiagnostics,
} from './db-round-trip-diagnostics.js';

function makeFakePrisma(queryRaw: (...args: unknown[]) => Promise<unknown>) {
  return {
    $queryRaw: vi.fn(queryRaw),
    $disconnect: vi.fn(),
  } as unknown as PrismaClient & { $queryRaw: ReturnType<typeof vi.fn>; $disconnect: ReturnType<typeof vi.fn> };
}

const METADATA = {
  hostname: 'db.example.internal',
  port: '6543',
  pgbouncer: 'true',
  connectionLimit: '5',
  poolTimeout: '10',
  sslmode: 'require',
};

describe('extractSafeConnectionMetadata', () => {
  it('returns only the allowlisted fields, never credentials/pathname/full URL/other query params', () => {
    const result = extractSafeConnectionMetadata(
      'postgresql://someuser:s3cr3t@db.example.internal:6543/mydb?pgbouncer=true&connection_limit=5&pool_timeout=10&sslmode=require&application_name=secretapp',
    );
    expect(result).toEqual(METADATA);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('someuser');
    expect(serialized).not.toContain('s3cr3t');
    expect(serialized).not.toContain('mydb');
    expect(serialized).not.toContain('secretapp');
  });
});

describe('maybeRunDatabaseRoundTripDiagnostics', () => {
  it('disabled: performs zero probes and emits no metadata', async () => {
    const prisma = makeFakePrisma(async () => [{ '?column?': 1 }]);
    const log = vi.fn();
    await maybeRunDatabaseRoundTripDiagnostics(false, prisma, METADATA, log);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('enabled: executes exactly the bounded read-only sequence (one initial + five further)', async () => {
    const prisma = makeFakePrisma(async () => [{ '?column?': 1 }]);
    const log = vi.fn();
    await maybeRunDatabaseRoundTripDiagnostics(true, prisma, METADATA, log);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(6);
    const probeLogs = log.mock.calls.filter(([message]) => message.includes('] probe'));
    expect(probeLogs).toHaveLength(6);
    probeLogs.forEach(([, payload], expectedIndex) => {
      expect(payload).toMatchObject({ index: expectedIndex });
      expect(typeof (payload as { durationMs: number }).durationMs).toBe('number');
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('connection metadata'), METADATA);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('complete'), { sampleCount: 6 });
  });
});

describe('runDatabaseRoundTripDiagnostics', () => {
  it('runs probes sequentially, never overlapping', async () => {
    let busy = false;
    let overlapDetected = false;
    const prisma = makeFakePrisma(async () => {
      if (busy) overlapDetected = true;
      busy = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      busy = false;
      return [{ '?column?': 1 }];
    });
    await runDatabaseRoundTripDiagnostics(prisma, METADATA, vi.fn());
    expect(overlapDetected).toBe(false);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(6);
  });

  it('a failing probe stops further probes and is sanitized (no raw error logged)', async () => {
    let callCount = 0;
    const prisma = makeFakePrisma(async () => {
      callCount += 1;
      if (callCount === 3) throw new Error('raw postgres connection error with sensitive detail');
      return [{ '?column?': 1 }];
    });
    const log = vi.fn();
    await runDatabaseRoundTripDiagnostics(prisma, METADATA, log);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    const allLoggedText = JSON.stringify(log.mock.calls);
    expect(allLoggedText).not.toContain('raw postgres connection error');
    expect(allLoggedText).not.toContain('sensitive detail');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stopped: probe failed'), { index: 2 });
  });

  it('never calls $disconnect on the shared client', async () => {
    const prisma = makeFakePrisma(async () => [{ '?column?': 1 }]);
    await runDatabaseRoundTripDiagnostics(prisma, METADATA, vi.fn());
    expect(prisma.$disconnect).not.toHaveBeenCalled();
  });

  it('resolves (never rejects) even when every probe fails, so API startup is unaffected', async () => {
    const prisma = makeFakePrisma(async () => {
      throw new Error('connection refused');
    });
    await expect(runDatabaseRoundTripDiagnostics(prisma, METADATA, vi.fn())).resolves.toBeUndefined();
  });
});

describe('scheduleSettledDatabaseRoundTripDiagnostics', () => {
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
    scheduleSettledDatabaseRoundTripDiagnostics(false, makeFakePrisma(async () => [1]), METADATA, Promise.resolve('completed'), vi.fn(), 60_000, scheduleFn);
    expect(scheduleFn).not.toHaveBeenCalled();
  });

  it('enabled: schedules exactly one timer at the given delay', () => {
    const { scheduleFn } = makeFakeScheduler();
    scheduleSettledDatabaseRoundTripDiagnostics(
      true,
      makeFakePrisma(async () => [1]),
      METADATA,
      Promise.resolve('completed'),
      vi.fn(),
      60_000,
      scheduleFn,
    );
    expect(scheduleFn).toHaveBeenCalledTimes(1);
    expect(scheduleFn).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });

  it('after a completed startup run, fires the settled sequence (six more probes, labeled "settled")', async () => {
    const prisma = makeFakePrisma(async () => [{ '?column?': 1 }]);
    const log = vi.fn();
    const scheduler = makeFakeScheduler();
    scheduleSettledDatabaseRoundTripDiagnostics(true, prisma, METADATA, Promise.resolve('completed'), log, 60_000, scheduler.scheduleFn);

    scheduler.fire();
    await vi.waitFor(() => expect(prisma.$queryRaw).toHaveBeenCalledTimes(6));
    const allLoggedText = JSON.stringify(log.mock.calls);
    expect(allLoggedText).toContain('settled');
  });

  it('skips the settled sequence when the startup run timed out with a query still outstanding', async () => {
    const prisma = makeFakePrisma(async () => [{ '?column?': 1 }]);
    const log = vi.fn();
    const scheduler = makeFakeScheduler();
    scheduleSettledDatabaseRoundTripDiagnostics(true, prisma, METADATA, Promise.resolve('timed-out'), log, 60_000, scheduler.scheduleFn);

    scheduler.fire();
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    const allLoggedText = JSON.stringify(log.mock.calls);
    expect(allLoggedText).toContain('skipped');
    expect(allLoggedText).not.toContain('idle');
    expect(allLoggedText).not.toContain('connection-warmed');
    expect(allLoggedText).not.toContain('warmed');
  });

  it('does not start the settled sequence until the startup run has actually settled (no overlap)', async () => {
    const prisma = makeFakePrisma(async () => [{ '?column?': 1 }]);
    const log = vi.fn();
    const scheduler = makeFakeScheduler();
    let resolveStartup: ((outcome: 'completed') => void) | undefined;
    const startupOutcome = new Promise<'completed'>((resolve) => {
      resolveStartup = resolve;
    });
    scheduleSettledDatabaseRoundTripDiagnostics(true, prisma, METADATA, startupOutcome, log, 60_000, scheduler.scheduleFn);

    scheduler.fire();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(prisma.$queryRaw).not.toHaveBeenCalled();

    resolveStartup?.('completed');
    await vi.waitFor(() => expect(prisma.$queryRaw).toHaveBeenCalledTimes(6));
  });
});
