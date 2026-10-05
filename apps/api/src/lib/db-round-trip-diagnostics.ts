import type { PrismaClient } from '@prisma/client';

/**
 * POS-PERF-P10 -- opt-in, once-per-process diagnostic that measures how long
 * a trivial database round trip takes through the ordinary shared Prisma
 * client, right after the API starts listening. Separate from
 * CHECKOUT_LATENCY_DIAGNOSTICS_ENABLED (checkout-latency-diagnostics.ts),
 * which measures real checkout requests -- this is a synthetic SELECT 1
 * probe with no relation to any sale.
 *
 * POS-PERF-P11 -- adds a second, "settled" run of the same sequence roughly
 * 60s after the first ("startup") one, so the two can be compared. The
 * settled run is skipped if the startup run left a query outstanding past
 * its per-probe timeout (an unresolved SELECT 1 still occupying a pooled
 * connection is not a safe moment to open a second sequence against the
 * same 5-connection pool). This does not make the settled run "idle" or
 * "connection-warmed" -- it is only known not to be racing the startup run.
 */

const PROBE_LABEL = 'db-round-trip-diagnostics';
const TOTAL_PROBE_COUNT = 6; // one initial + five further, per POS-PERF-P10
const PER_PROBE_TIMEOUT_MS = 5_000;
const OVERALL_DEADLINE_MS = 20_000;
const SETTLED_PROBE_DELAY_MS = 60_000;
const PROBE_TIMEOUT_ERROR_MESSAGE = 'probe timed out waiting for a response';

export type ProbeSequencePhase = 'startup' | 'settled';

export type ProbeSequenceOutcome = 'completed' | 'failed' | 'timed-out' | 'deadline-exceeded';

export interface SafeConnectionMetadata {
  hostname: string | null;
  port: string | null;
  pgbouncer: string | null;
  connectionLimit: string | null;
  poolTimeout: string | null;
  sslmode: string | null;
}

type Logger = (...args: unknown[]) => void;

/**
 * Extracts only an explicit allowlist of connection fields for logging.
 * Never returns the username, password, pathname (database name), the full
 * URL, or any query-string field outside the allowlist below.
 */
export function extractSafeConnectionMetadata(databaseUrl: string): SafeConnectionMetadata {
  const url = new URL(databaseUrl);
  return {
    hostname: url.hostname || null,
    port: url.port || null,
    pgbouncer: url.searchParams.get('pgbouncer'),
    connectionLimit: url.searchParams.get('connection_limit'),
    poolTimeout: url.searchParams.get('pool_timeout'),
    sslmode: url.searchParams.get('sslmode'),
  };
}

/**
 * Races a single SELECT 1 against a timeout.
 *
 * LIMITATION: Prisma 5.x (the installed version) exposes no API to cancel an
 * in-flight raw query against PostgreSQL. Promise.race only stops *this
 * function* from waiting any longer -- if the query is genuinely stuck (e.g.
 * waiting on a connection-pool slot or blocked server-side), the underlying
 * request keeps running against the database/connection pool until it
 * naturally resolves or the connection itself errors; the pooled connection
 * is not released early by losing the race. The timeout bounds how long this
 * diagnostic sequence can block, not whether the query itself stops.
 */
async function raceProbe(prisma: PrismaClient, timeoutMs: number): Promise<number> {
  const startedAt = performance.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('probe timed out waiting for a response')), timeoutMs);
  });
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return performance.now() - startedAt;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Runs the bounded, read-only probe sequence through the given (shared)
 * Prisma client and reports how it ended. Never disconnects the client.
 * Never throws -- a failure here must never affect API readiness. Probes
 * run strictly sequentially (each awaited before the next starts) and stop
 * early after the first failed probe or once the overall diagnostic
 * deadline is exceeded; there are no retries.
 *
 * `timed-out` is distinguished from `failed` because it means raceProbe's
 * timeout fired while the underlying SELECT 1 was still outstanding against
 * the pool (see raceProbe's limitation note above) -- callers use this to
 * avoid opening a second sequence against the same connection while one may
 * still be in flight. `failed` means Prisma itself rejected (e.g. the
 * connection was refused or dropped), which carries no such risk.
 *
 * Emits only: the diagnostic label, per-call index/durationMs, a final
 * sample count, and the caller-supplied safe connection metadata -- never
 * raw errors, SQL text/parameters, or connection strings.
 */
export async function runProbeSequence(
  prisma: PrismaClient,
  connectionMetadata: SafeConnectionMetadata,
  log: Logger,
  phase: ProbeSequencePhase,
): Promise<ProbeSequenceOutcome> {
  const label = `${PROBE_LABEL}:${phase}`;
  const startedAt = performance.now();
  log(`[${label}] connection metadata`, connectionMetadata);

  for (let index = 0; index < TOTAL_PROBE_COUNT; index += 1) {
    if (performance.now() - startedAt > OVERALL_DEADLINE_MS) {
      log(`[${label}] stopped: overall diagnostic deadline exceeded`, { completedProbes: index });
      return 'deadline-exceeded';
    }
    try {
      const durationMs = await raceProbe(prisma, PER_PROBE_TIMEOUT_MS);
      log(`[${label}] probe`, { index, durationMs: Math.round(durationMs) });
    } catch (error) {
      // Sanitized: never log the raw error/exception, only that a probe failed.
      log(`[${label}] stopped: probe failed`, { index });
      return error instanceof Error && error.message === PROBE_TIMEOUT_ERROR_MESSAGE ? 'timed-out' : 'failed';
    }
  }

  log(`[${label}] complete`, { sampleCount: TOTAL_PROBE_COUNT });
  return 'completed';
}

/**
 * Backwards-compatible wrapper around runProbeSequence for the original
 * (startup-only) call sites and tests -- resolves to undefined, same as
 * before POS-PERF-P11 added the settled follow-up and outcome reporting.
 */
export async function runDatabaseRoundTripDiagnostics(
  prisma: PrismaClient,
  connectionMetadata: SafeConnectionMetadata,
  log: Logger = console.warn,
): Promise<void> {
  await runProbeSequence(prisma, connectionMetadata, log, 'startup');
}

/**
 * Flag-gated entry point used at startup. Kept separate from
 * runProbeSequence so the disabled path is trivially testable (zero
 * probes, zero log calls) without stubbing Prisma. Returns the sequence
 * outcome (or undefined when disabled) so a caller can decide whether it's
 * safe to schedule the settled follow-up.
 */
export async function maybeRunDatabaseRoundTripDiagnostics(
  enabled: boolean,
  prisma: PrismaClient,
  connectionMetadata: SafeConnectionMetadata,
  log: Logger = console.warn,
): Promise<ProbeSequenceOutcome | undefined> {
  if (!enabled) return undefined;
  return runProbeSequence(prisma, connectionMetadata, log, 'startup');
}

/**
 * Schedules exactly one "settled" repeat of the same probe sequence roughly
 * SETTLED_PROBE_DELAY_MS after the API started listening, without blocking
 * startup. `startupOutcome` is the (already in-flight) startup run's
 * result: the settled run awaits it first, which both guarantees the two
 * sequences never overlap (they already can't, since they share one
 * sequential loop, but this also rules out the settled timer firing while
 * the startup run is still mid-sequence) and lets this function skip
 * entirely if the startup run ended with a query still outstanding past its
 * timeout -- piling a second sequence onto a 5-connection pool that may
 * still be holding a stuck connection from the first is never safe. Any
 * other startup outcome (completed, failed outright, or deadline-exceeded
 * with no outstanding query) is safe to follow up on.
 */
export function scheduleSettledDatabaseRoundTripDiagnostics(
  enabled: boolean,
  prisma: PrismaClient,
  connectionMetadata: SafeConnectionMetadata,
  startupOutcome: Promise<ProbeSequenceOutcome | undefined>,
  log: Logger = console.warn,
  delayMs: number = SETTLED_PROBE_DELAY_MS,
  scheduleFn: (callback: () => void, ms: number) => unknown = setTimeout,
): void {
  if (!enabled) return;

  scheduleFn(() => {
    void startupOutcome
      .then((outcome) => {
        if (outcome === 'timed-out') {
          log(`[${PROBE_LABEL}:settled] skipped: startup probe left a query outstanding past its timeout`);
          return;
        }
        return runProbeSequence(prisma, connectionMetadata, log, 'settled').then(() => undefined);
      })
      .catch(() => {
        log(`[${PROBE_LABEL}:settled] unexpected diagnostic failure (sanitized)`);
      });
  }, delayMs);
}
