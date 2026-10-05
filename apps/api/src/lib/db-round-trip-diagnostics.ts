import type { PrismaClient } from '@prisma/client';

/**
 * POS-PERF-P10 -- opt-in, once-per-process diagnostic that measures how long
 * a trivial database round trip takes through the ordinary shared Prisma
 * client, right after the API starts listening. Separate from
 * CHECKOUT_LATENCY_DIAGNOSTICS_ENABLED (checkout-latency-diagnostics.ts),
 * which measures real checkout requests -- this is a synthetic SELECT 1
 * probe with no relation to any sale.
 */

const PROBE_LABEL = 'db-round-trip-diagnostics';
const TOTAL_PROBE_COUNT = 6; // one initial + five further, per POS-PERF-P10
const PER_PROBE_TIMEOUT_MS = 5_000;
const OVERALL_DEADLINE_MS = 20_000;

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
 * Prisma client. Never disconnects the client. Never throws -- a failure
 * here must never affect API readiness. Probes run strictly sequentially
 * (each awaited before the next starts) and stop early after the first
 * failed probe or once the overall diagnostic deadline is exceeded; there
 * are no retries.
 *
 * Emits only: the diagnostic label, per-call index/durationMs, a final
 * sample count, and the caller-supplied safe connection metadata -- never
 * raw errors, SQL text/parameters, or connection strings.
 */
export async function runDatabaseRoundTripDiagnostics(
  prisma: PrismaClient,
  connectionMetadata: SafeConnectionMetadata,
  log: Logger = console.warn,
): Promise<void> {
  const startedAt = performance.now();
  log(`[${PROBE_LABEL}] connection metadata`, connectionMetadata);

  for (let index = 0; index < TOTAL_PROBE_COUNT; index += 1) {
    if (performance.now() - startedAt > OVERALL_DEADLINE_MS) {
      log(`[${PROBE_LABEL}] stopped: overall diagnostic deadline exceeded`, { completedProbes: index });
      return;
    }
    try {
      const durationMs = await raceProbe(prisma, PER_PROBE_TIMEOUT_MS);
      log(`[${PROBE_LABEL}] probe`, { index, durationMs: Math.round(durationMs) });
    } catch {
      // Sanitized: never log the raw error/exception, only that a probe failed.
      log(`[${PROBE_LABEL}] stopped: probe failed`, { index });
      return;
    }
  }

  log(`[${PROBE_LABEL}] complete`, { sampleCount: TOTAL_PROBE_COUNT });
}

/**
 * Flag-gated entry point used at startup. Kept separate from
 * runDatabaseRoundTripDiagnostics so the disabled path is trivially
 * testable (zero probes, zero log calls) without stubbing Prisma.
 */
export async function maybeRunDatabaseRoundTripDiagnostics(
  enabled: boolean,
  prisma: PrismaClient,
  connectionMetadata: SafeConnectionMetadata,
  log: Logger = console.warn,
): Promise<void> {
  if (!enabled) return;
  await runDatabaseRoundTripDiagnostics(prisma, connectionMetadata, log);
}
