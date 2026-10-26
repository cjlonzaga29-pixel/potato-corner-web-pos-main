import * as Sentry from '@sentry/node';
import { type ClaimedAuditGroup, auditOutboxRepository } from './audit-outbox.repository.js';
import {
  AUDIT_OUTBOX_MAX_ATTEMPTS,
  AUDIT_OUTBOX_RETRY_DELAYS_MS,
  AUDIT_OUTBOX_STALE_LOCK_MS,
  type AuditOutboxCycleResult,
} from './audit-outbox.types.js';

/** First line only, capped: no stack, cause chain or anything resembling a connection string lands in `last_error`. */
function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n')[0] ?? message).slice(0, 500);
}

/**
 * Delivers one claimed group. Never throws for a delivery failure: the
 * outcome (delivered, retried, stuck, skipped) is persisted before it
 * returns, so one group's failure can't abort the rest of the batch.
 */
async function deliver(group: ClaimedAuditGroup): Promise<'delivered' | 'retried' | 'stuck' | 'skipped'> {
  try {
    return (await auditOutboxRepository.deliverGroup(group)) ? 'delivered' : 'skipped';
  } catch (error) {
    const attempts = group.attempts + 1;
    const lastError = sanitizeError(error);
    const exhausted = attempts >= AUDIT_OUTBOX_MAX_ATTEMPTS;
    const delayMs = AUDIT_OUTBOX_RETRY_DELAYS_MS[attempts - 1] ?? AUDIT_OUTBOX_RETRY_DELAYS_MS.at(-1) ?? 1_800_000;
    const updated = await auditOutboxRepository.recordFailure({
      group,
      attempts,
      nextStatus: exhausted ? 'stuck' : 'pending',
      lastError,
      nextAttemptAt: exhausted ? null : new Date(Date.now() + delayMs),
    });
    // 0 rows: the claim was recovered elsewhere, or the delivery committed and only its reply was lost.
    if (updated === 0) return 'skipped';

    const context = {
      groupId: group.groupId,
      attempts,
      events: group.rows.map((row) => ({ event_key: row.eventKey, action: row.action, entity_id: row.entityId })),
      error: lastError,
    };
    if (exhausted) {
      Sentry.captureException(error, { tags: { audit_outbox: 'stuck' }, extra: context });
      console.error('AUDIT_OUTBOX_STUCK', context);
      return 'stuck';
    }
    console.warn('AUDIT_OUTBOX_RETRY', context);
    return 'retried';
  }
}

export const auditOutboxService = {
  /**
   * Claims up to `batchSize` rows' worth of groups and delivers them one
   * group at a time, oldest event first. Within a group, entries keep the
   * order the originating operation recorded them in. `groupIds` limits
   * the cycle to those groups.
   */
  async runCycle(batchSize: number, staleLockMs: number = AUDIT_OUTBOX_STALE_LOCK_MS, groupIds?: string[]): Promise<AuditOutboxCycleResult> {
    const groups = await auditOutboxRepository.claimBatch(batchSize, staleLockMs, groupIds);
    const result: AuditOutboxCycleResult = { claimed: groups.length, delivered: 0, retried: 0, stuck: 0, skipped: 0 };
    for (const group of groups) {
      result[await deliver(group)] += 1;
    }
    return result;
  },
};
