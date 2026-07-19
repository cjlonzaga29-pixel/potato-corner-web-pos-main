import { prisma } from './prisma.js';

/**
 * Phase 21: Postgres replacement for Redis INCR-based ID generation.
 * INSERT ... ON CONFLICT DO UPDATE is a single atomic statement — two
 * concurrent callers for the same key can never observe or return the same
 * value, the same guarantee Redis INCR gave. Row created on first use.
 */
export async function nextCounterValue(key: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ value: number }[]>`
    INSERT INTO id_counters (key, value) VALUES (${key}, 1)
    ON CONFLICT (key) DO UPDATE SET value = id_counters.value + 1
    RETURNING value
  `;
  const row = rows[0];
  if (!row) throw new Error(`nextCounterValue: INSERT ... RETURNING returned no row for key "${key}"`);
  return row.value;
}
