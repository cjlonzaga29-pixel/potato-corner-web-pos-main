import { PrismaClient } from '@prisma/client';
import { extractSafeConnectionMetadata } from './db-round-trip-diagnostics.js';

/**
 * POS-PERF-P13 -- opt-in, once-per-process diagnostic comparing trivial
 * query latency through Supabase's transaction-mode pooler (port 6543, the
 * existing production DATABASE_URL) against its session-mode pooler, from
 * two dedicated, bounded-connection Prisma clients. Never touches the
 * shared `prisma` singleton (lib/prisma.ts) or the production DATABASE_URL.
 * Off by default; skipped entirely if DATABASE_URL_SESSION_COMPARISON is
 * unset even when the flag is on, so enabling the flag without the secret
 * configured is a safe no-op, not a boot failure.
 */

const PROBE_LABEL = 'pooler-comparison-diagnostics';
const CALLS_PER_MODE = 6;
const PER_CALL_TIMEOUT_MS = 5_000;
const OVERALL_DEADLINE_MS = 30_000;
export const POOLER_COMPARISON_DELAY_MS = 60_000;
const PROBE_TIMEOUT_ERROR_MESSAGE = 'probe timed out waiting for a response';

export type PoolerMode = 'transaction' | 'session';
type Logger = (...args: unknown[]) => void;

/**
 * Returns a copy of databaseUrl with connection_limit forced to 1. Supported
 * Prisma per-client datasource override (passed via the constructor's
 * `datasources.db.url`, not schema.prisma) -- never mutates the input
 * string, and leaves every other query param (sslmode, pgbouncer, etc)
 * untouched.
 */
export function withDiagnosticConnectionLimit(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('connection_limit', '1');
  return url.toString();
}

/**
 * Races a single SELECT 1 against a timeout. Same cancellation limitation
 * as db-round-trip-diagnostics.ts's raceProbe: Prisma 5.x exposes no API to
 * cancel an in-flight raw query, so losing the race bounds how long this
 * function waits, not whether the underlying query/connection is released.
 */
async function raceSelectOne(prisma: PrismaClient, timeoutMs: number): Promise<number> {
  const startedAt = performance.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(PROBE_TIMEOUT_ERROR_MESSAGE)), timeoutMs);
  });
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return performance.now() - startedAt;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function runSingleCall(
  prisma: PrismaClient,
  mode: PoolerMode,
  callIndex: number,
  log: Logger,
  deadlineAt: number,
): Promise<'continue' | 'stop'> {
  const isFirstCall = callIndex === 0;
  if (performance.now() > deadlineAt) {
    log(`[${PROBE_LABEL}] stopped: overall comparison deadline exceeded`, { mode, callIndex });
    return 'stop';
  }
  try {
    const durationMs = await raceSelectOne(prisma, PER_CALL_TIMEOUT_MS);
    log(`[${PROBE_LABEL}] call`, { mode, callIndex, isFirstCall, durationMs: Math.round(durationMs), outcome: 'completed' });
    return 'continue';
  } catch (error) {
    // Sanitized: never log the raw error, only that this call failed/timed out.
    const outcome = error instanceof Error && error.message === PROBE_TIMEOUT_ERROR_MESSAGE ? 'timed-out' : 'failed';
    log(`[${PROBE_LABEL}] call`, { mode, callIndex, isFirstCall, outcome });
    return 'stop';
  }
}

export interface PoolerComparisonClients {
  transactionClient: PrismaClient;
  sessionClient: PrismaClient;
}

/**
 * Alternates CALLS_PER_MODE calls between the two clients (transaction call
 * 0, session call 0, transaction call 1, ...), strictly sequential -- each
 * call is awaited before the next starts, so the two modes never overlap.
 * Stops the entire comparison (both modes) on the first failed/timed-out
 * call, since a query left outstanding past its timeout may still hold that
 * client's one connection; starting the other mode's next call is left to
 * run (it's a separate client/connection) but no further calls are made on
 * either client once either one has failed. Never throws.
 */
export async function runPoolerComparison(clients: PoolerComparisonClients, log: Logger = console.warn): Promise<void> {
  const deadlineAt = performance.now() + OVERALL_DEADLINE_MS;
  log(`[${PROBE_LABEL}] starting`, { callsPerMode: CALLS_PER_MODE });

  for (let callIndex = 0; callIndex < CALLS_PER_MODE; callIndex += 1) {
    const transactionResult = await runSingleCall(clients.transactionClient, 'transaction', callIndex, log, deadlineAt);
    if (transactionResult === 'stop') return;
    const sessionResult = await runSingleCall(clients.sessionClient, 'session', callIndex, log, deadlineAt);
    if (sessionResult === 'stop') return;
  }

  log(`[${PROBE_LABEL}] complete`, { sampleCountPerMode: CALLS_PER_MODE });
}

/**
 * Flag-gated entry point used at startup. Builds two dedicated, 1-connection
 * clients (one additional connection per mode, two total), runs the
 * alternating comparison, then disconnects both -- in a `finally`, so a
 * failed/timed-out sequence still releases what it can. Never disconnects
 * or otherwise touches the shared `prisma` singleton. Resolves (never
 * rejects) so a failure here can't affect API readiness.
 */
export async function maybeRunPoolerComparison(
  enabled: boolean,
  transactionDatabaseUrl: string,
  sessionDatabaseUrl: string | undefined,
  log: Logger = console.warn,
): Promise<void> {
  if (!enabled) return;
  if (!sessionDatabaseUrl) {
    log(`[${PROBE_LABEL}] skipped: DATABASE_URL_SESSION_COMPARISON is not set`);
    return;
  }

  log(`[${PROBE_LABEL}] connection metadata`, {
    transaction: extractSafeConnectionMetadata(transactionDatabaseUrl),
    session: extractSafeConnectionMetadata(sessionDatabaseUrl),
  });

  const transactionClient = new PrismaClient({ datasources: { db: { url: withDiagnosticConnectionLimit(transactionDatabaseUrl) } } });
  const sessionClient = new PrismaClient({ datasources: { db: { url: withDiagnosticConnectionLimit(sessionDatabaseUrl) } } });

  try {
    await runPoolerComparison({ transactionClient, sessionClient }, log);
  } finally {
    await Promise.allSettled([transactionClient.$disconnect(), sessionClient.$disconnect()]);
  }
}

/**
 * Schedules exactly one comparison run roughly POOLER_COMPARISON_DELAY_MS
 * after the API starts listening -- "after startup has settled", same
 * rationale as db-round-trip-diagnostics's settled follow-up. Does not
 * block startup and does not depend on (or race) the round-trip
 * diagnostics' own settled timer; server.ts is responsible for suppressing
 * that one while this comparison is enabled so the two never compete for
 * the same bounded pool.
 */
export function schedulePoolerComparison(
  enabled: boolean,
  transactionDatabaseUrl: string,
  sessionDatabaseUrl: string | undefined,
  log: Logger = console.warn,
  delayMs: number = POOLER_COMPARISON_DELAY_MS,
  scheduleFn: (callback: () => void, ms: number) => unknown = setTimeout,
): void {
  if (!enabled) return;

  scheduleFn(() => {
    void maybeRunPoolerComparison(enabled, transactionDatabaseUrl, sessionDatabaseUrl, log).catch(() => {
      log(`[${PROBE_LABEL}] unexpected comparison failure (sanitized)`);
    });
  }, delayMs);
}
