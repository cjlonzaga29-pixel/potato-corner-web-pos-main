import { PrismaClient } from '@prisma/client';

/**
 * POS-PERF-P62 — the organization discount policy is one global row
 * (system_settings 'discount_policy'). p50-tax and p50r-branch-discounts both
 * rewrite it, and vitest runs test files in parallel: in the P62 full API run
 * p50r read the 5% that p50-tax had just set where it expected the 20% default.
 *
 * A file that changes that row holds this session-level advisory lock from its
 * first hook to its last, so those files take turns with each other. Nothing
 * else is serialized. The lock lives on a client with exactly one connection,
 * because a session lock belongs to the connection that took it.
 */
const DISCOUNT_POLICY_LOCK_KEY = 6_205_0001;

export function globalDiscountPolicyLock() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const url = new URL(databaseUrl);
  url.searchParams.set('connection_limit', '1');
  const client = new PrismaClient({ datasourceUrl: url.toString() });
  return {
    acquire: async () => {
      await client.$executeRaw`SELECT pg_advisory_lock(${DISCOUNT_POLICY_LOCK_KEY})`;
    },
    release: async () => {
      await client.$executeRaw`SELECT pg_advisory_unlock(${DISCOUNT_POLICY_LOCK_KEY})`;
      await client.$disconnect();
    },
  };
}

/**
 * How long a file may wait for the other one to finish with the row. Measured in
 * the P62 full run: p50-tax 4.0s for the whole file; this leaves room for a
 * loaded machine without touching any other timeout.
 */
export const DISCOUNT_POLICY_LOCK_WAIT_MS = 60_000;
