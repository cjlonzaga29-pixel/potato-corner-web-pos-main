import { randomUUID } from 'node:crypto';
import type { AuditOutbox, Prisma } from '@prisma/client';
import { config } from '../../config/index.js';
import { prisma } from '../../lib/prisma.js';
import { auditChainLockId } from '../../lib/pg-lock.js';
import { GENESIS_HASH, computeAuditHash, type AuditLogEntry } from '../../middleware/audit-log.js';
import type { AuditIntent } from './audit-outbox.types.js';

export interface ClaimedAuditGroup {
  groupId: string;
  claimToken: string;
  /** Failed delivery attempts so far. Every row of a group shares it: the group only ever changes state as a whole. */
  attempts: number;
  /** In `position` order: the order the originating operation recorded its events. */
  rows: AuditOutbox[];
}

const DELIVERY_TRANSACTION_OPTIONS = { maxWait: config.posTransaction.maxWaitMs, timeout: config.posTransaction.timeoutMs };

/**
 * Rows eligible for a claim attempt: `pending` rows whose backoff has
 * elapsed (or that never had one), plus `processing` rows whose claim is
 * older than `staleLockMs` — a worker that crashed or stalled mid-delivery
 * releases its claim to whoever polls next. `stuck` and `delivered` rows are
 * never claimed automatically.
 */
function claimableWhere(now: Date, staleCutoff: Date): Prisma.AuditOutboxWhereInput {
  return {
    OR: [
      { status: 'pending', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      { status: 'processing', lockedAt: { lt: staleCutoff } },
    ],
  };
}

/**
 * jsonb stores an object's keys shorter-first, then bytewise, and reads them
 * back in that order. Building the hashed object in the same order means
 * the hash can be recomputed from the stored row (an object hashed in its
 * caller's key order cannot be, once jsonb reorders it). Top level only:
 * nested values here were already read back from jsonb.
 */
function inJsonbKeyOrder(value: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(value).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

/**
 * The audit entry a row becomes. `after_state` gains the event's
 * occurrence time and identity, so the entry keeps both once it is in
 * audit_logs (whose `created_at` is the later delivery time) and can be
 * traced back to its outbox row. Both are covered by the entry's hash.
 */
function toAuditEntry(row: AuditOutbox): AuditLogEntry {
  const after = row.afterState;
  const trace = { occurred_at: row.occurredAt.toISOString(), audit_event_id: row.eventKey };
  return {
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    actorId: row.actorId,
    actorRole: row.actorRole,
    branchId: row.branchId,
    beforeState: row.beforeState ?? undefined,
    afterState: after === null ? inJsonbKeyOrder(trace) : typeof after === 'object' && !Array.isArray(after) ? inJsonbKeyOrder({ ...after, ...trace }) : after,
    ipAddress: row.ipAddress,
  };
}

export const auditOutboxRepository = {
  /**
   * Persists `intents` as one group inside the caller's transaction, in one
   * statement. They commit or roll back with the change they describe.
   * Writes nothing for an empty list. Returns the group id (null if empty).
   */
  async enqueue(tx: Prisma.TransactionClient, intents: AuditIntent[]): Promise<string | null> {
    if (intents.length === 0) return null;
    const groupId = randomUUID();
    const occurredAt = new Date();
    await tx.auditOutbox.createMany({
      data: intents.map((intent, position) => ({
        eventKey: `${groupId}:${position}`,
        groupId,
        position,
        action: intent.action,
        entityType: intent.entityType,
        entityId: intent.entityId ?? null,
        actorId: intent.actorId ?? null,
        actorRole: intent.actorRole,
        branchId: intent.branchId ?? null,
        beforeState: (intent.beforeState ?? undefined) as Prisma.InputJsonValue | undefined,
        afterState: (intent.afterState ?? undefined) as Prisma.InputJsonValue | undefined,
        ipAddress: intent.ipAddress ?? null,
        occurredAt,
      })),
    });
    return groupId;
  },

  /**
   * Same two-phase, token-stamped claim as the inventory deduction and
   * projection outboxes, at group granularity: pick up to `batchSize`
   * eligible rows oldest-first, then flip every row of their groups to
   * `processing` under a fresh `claimToken` with one `updateMany` scoped by
   * the same eligibility predicate. Postgres re-checks that predicate under
   * each row's lock, so two racing workers can never both claim a row; the
   * re-read by token returns only what this call won. `groupIds` limits
   * the claim to those groups (the recovery script; tests).
   */
  async claimBatch(batchSize: number, staleLockMs: number, groupIds?: string[]): Promise<ClaimedAuditGroup[]> {
    const now = new Date();
    const staleCutoff = new Date(now.getTime() - staleLockMs);
    const claimToken = randomUUID();

    const candidates = await prisma.auditOutbox.findMany({
      where: { ...claimableWhere(now, staleCutoff), ...(groupIds ? { groupId: { in: groupIds } } : {}) },
      orderBy: [{ occurredAt: 'asc' }, { groupId: 'asc' }, { position: 'asc' }],
      take: batchSize,
      select: { groupId: true },
    });
    const candidateGroupIds = [...new Set(candidates.map((row) => row.groupId))];
    if (candidateGroupIds.length === 0) return [];

    await prisma.auditOutbox.updateMany({
      where: { groupId: { in: candidateGroupIds }, ...claimableWhere(now, staleCutoff) },
      data: { status: 'processing', claimToken, lockedAt: now },
    });

    const claimed = await prisma.auditOutbox.findMany({
      where: { groupId: { in: candidateGroupIds }, claimToken },
      orderBy: [{ groupId: 'asc' }, { position: 'asc' }],
    });
    return candidateGroupIds.flatMap((groupId) => {
      const rows = claimed.filter((row) => row.groupId === groupId);
      return rows.length === 0 ? [] : [{ groupId, claimToken, attempts: Math.max(...rows.map((row) => row.attempts)), rows }];
    });
  },

  /**
   * Appends the group's entries to the hash chain and acknowledges them in
   * ONE transaction, so an entry is in audit_logs if and only if its rows
   * are `delivered`. A crash before COMMIT leaves neither (the rows fall
   * back to stale-claim recovery); a crash after COMMIT leaves both, and a
   * delivered row is never claimed again.
   *
   * 1. The ownership guard runs first: `processing` + this claim's token.
   *    It row-locks the group, so a stale-claim recovery that re-claimed it
   *    (or another worker finalizing it) either already moved it — 0 rows,
   *    return false, nothing written — or waits for this commit and then
   *    no longer matches.
   * 2. `auditChainLockId` serializes chain appends between outbox workers.
   * 3. One read of the chain's tail, then one `createMany`: each entry is
   *    chained to the previous one with the same hash appendAuditLog uses,
   *    and stamped with strictly increasing `created_at` later than the
   *    tail's, so the chain's "newest entry" lookup (`created_at DESC`)
   *    keeps returning the last entry of this group.
   */
  async deliverGroup(group: ClaimedAuditGroup): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const guard = await tx.auditOutbox.updateMany({
        where: { groupId: group.groupId, status: 'processing', claimToken: group.claimToken },
        data: { status: 'delivered', deliveredAt: new Date(), claimToken: null, lockedAt: null },
      });
      if (guard.count === 0) return false;
      if (guard.count !== group.rows.length) {
        // Unreachable while groups change state as a whole; refuse rather than deliver part of a group.
        throw new Error(`audit outbox group ${group.groupId}: claimed ${group.rows.length} rows but owns ${guard.count}`);
      }

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${auditChainLockId()})`;
      const tail = await tx.auditLog.findFirst({ orderBy: { createdAt: 'desc' }, select: { currentHash: true, createdAt: true } });

      // Ends at "now" unless the tail is newer (another instance's clock): always strictly after the tail, 1 ms apart.
      const count = group.rows.length;
      const firstMs = Math.max(Date.now() - (count - 1), (tail?.createdAt.getTime() ?? Number.NEGATIVE_INFINITY) + 1);
      let previousHash = tail?.currentHash ?? GENESIS_HASH;
      const data = group.rows.map((row, index) => {
        const entry = toAuditEntry(row);
        const currentHash = computeAuditHash(entry, previousHash);
        const record = {
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          actorId: entry.actorId ?? null,
          actorRole: entry.actorRole,
          branchId: entry.branchId ?? null,
          beforeState: (entry.beforeState ?? undefined) as Prisma.InputJsonValue | undefined,
          afterState: (entry.afterState ?? undefined) as Prisma.InputJsonValue | undefined,
          ipAddress: entry.ipAddress ?? null,
          previousHash,
          currentHash,
          createdAt: new Date(firstMs + index),
        };
        previousHash = currentHash;
        return record;
      });
      await tx.auditLog.createMany({ data });
      return true;
    }, DELIVERY_TRANSACTION_OPTIONS);
  },

  /**
   * Records a failed delivery for the whole group: back to `pending` with a
   * backoff, or `stuck` once attempts are exhausted. Guarded on
   * `processing` + this claim's token, so a worker whose claim was
   * recovered elsewhere — or whose delivery actually committed but whose
   * reply was lost (the rows are already `delivered`) — changes nothing.
   * Returns the number of rows updated.
   */
  async recordFailure(params: {
    group: ClaimedAuditGroup;
    attempts: number;
    nextStatus: 'pending' | 'stuck';
    lastError: string;
    nextAttemptAt: Date | null;
  }): Promise<number> {
    const result = await prisma.auditOutbox.updateMany({
      where: { groupId: params.group.groupId, status: 'processing', claimToken: params.group.claimToken },
      data: {
        status: params.nextStatus,
        attempts: params.attempts,
        lastError: params.lastError,
        nextAttemptAt: params.nextAttemptAt,
        claimToken: null,
        lockedAt: null,
      },
    });
    return result.count;
  },

  /**
   * Manual recovery: returns at most `limit` `stuck` groups (or exactly
   * `groupId`) to `pending` with a fresh attempt budget. Never touches a
   * delivered row. `last_error` is kept until the next attempt overwrites it.
   */
  async requeueStuck(params: { groupId?: string; limit: number }): Promise<string[]> {
    const rows = await prisma.auditOutbox.findMany({
      where: { status: 'stuck', ...(params.groupId ? { groupId: params.groupId } : {}) },
      orderBy: [{ occurredAt: 'asc' }, { groupId: 'asc' }],
      select: { groupId: true },
    });
    const groupIds = [...new Set(rows.map((row) => row.groupId))].slice(0, params.limit);
    if (groupIds.length === 0) return [];
    await prisma.auditOutbox.updateMany({
      where: { groupId: { in: groupIds }, status: 'stuck' },
      data: { status: 'pending', attempts: 0, nextAttemptAt: null, claimToken: null, lockedAt: null },
    });
    return groupIds;
  },

  /** Row counts by status, plus the oldest undelivered event's occurrence time. */
  async status(): Promise<{ counts: Record<string, number>; oldestUndeliveredAt: Date | null }> {
    const grouped = await prisma.auditOutbox.groupBy({ by: ['status'], _count: { _all: true } });
    const oldest = await prisma.auditOutbox.findFirst({
      where: { status: { not: 'delivered' } },
      orderBy: { occurredAt: 'asc' },
      select: { occurredAt: true },
    });
    return {
      counts: Object.fromEntries(grouped.map((row) => [row.status, row._count._all])),
      oldestUndeliveredAt: oldest?.occurredAt ?? null,
    };
  },
};
