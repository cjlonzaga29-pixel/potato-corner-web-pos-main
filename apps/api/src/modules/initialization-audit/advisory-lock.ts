import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { hashToLockId } from '../../lib/pg-lock.js';
import { sha256Hex } from '../../lib/hash.js';

const INITIALIZATION_LOCK_KEY = 'cr009-reference-init-apply';

/**
 * CR-009 "Concurrency strategy" calls for a session-scoped `pg_advisory_lock`
 * held across the whole apply/rollback call, released in a `finally`. That is
 * unsafe here: `DATABASE_URL` runs through Supabase's PgBouncer in
 * transaction-pooling mode (`?pgbouncer=true`, port 6543 — see
 * `config/index.ts`'s `assertPgBouncerCompatible`), so a bare session-scoped
 * lock acquired on one physical backend connection has no guarantee that a
 * later query — or the eventual unlock — lands on that same backend. The
 * lock can silently fail to protect anything.
 *
 * This follows the same fix already shipped for refresh-token rotation
 * (`auth.repository.ts`'s `withAdvisoryLock`, Phase 20.5/21, commit
 * 9507200): `pg_advisory_xact_lock` is transaction-scoped and releases
 * automatically on commit/rollback, so tying the lock's lifetime to a single
 * `prisma.$transaction` guarantees the acquisition, every guarded query, and
 * the release all happen on the same backend connection. `fn` receives the
 * transaction client `tx` and must use it (not the top-level `prisma`) for
 * every read/write it needs serialized against concurrent callers.
 *
 * This only spans the duration of ONE Prisma transaction — a future
 * multi-transaction apply/rollback orchestration (Phase C0's RC7, out of
 * scope here) would need to compose calls to this primitive itself; that
 * composition question is not solved by this function.
 *
 * `timeout`/`maxWait` are set generously (well above Prisma's 5s/2s
 * defaults) because a future caller's `fn` may run substantially long-running
 * apply work (per CR-009, potentially spanning categories/units/conversions),
 * and may also spend part of that budget blocked waiting for a concurrent
 * caller to release the same lock.
 */
export function withInitializationLock<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const lockId = hashToLockId(sha256Hex(INITIALIZATION_LOCK_KEY));
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
      return fn(tx);
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}
