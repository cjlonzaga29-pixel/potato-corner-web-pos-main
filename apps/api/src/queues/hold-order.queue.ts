import { Queue, Worker, type Job } from 'bullmq';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import { redis, createWorkerConnection } from '../lib/redis.js';
import { transactionsRepository } from '../modules/transactions/transactions.repository.js';
import { recordAuditLog } from '../middleware/audit-log.js';
import { notifyBranch } from '../lib/notify.js';

export interface HoldOrderExpiryJobData {
  holdOrderId: string;
  branchId: string;
  shiftId: string;
}

export const holdOrderQueue = new Queue('hold-order', { connection: redis });

/**
 * Schedules the 15-minute expiry check (Architecture doc §Part 8). jobId =
 * holdOrderId, matching inventory.queue.ts's idempotency pattern — releasing
 * a hold before expiry doesn't need to cancel this job explicitly, since
 * processHoldOrderExpiry below is a no-op against anything not still `held`.
 */
export function enqueueHoldOrderExpiry(data: HoldOrderExpiryJobData, delayMs: number): Promise<Job> {
  return holdOrderQueue.add('hold_order_expiry', data, {
    jobId: data.holdOrderId,
    delay: delayMs,
  });
}

export async function processHoldOrderExpiry(job: Job<HoldOrderExpiryJobData>): Promise<void> {
  const { holdOrderId, branchId, shiftId } = job.data;

  const result = await transactionsRepository.expireHoldOrderIfStillHeld(holdOrderId);
  // count === 0 means the hold was already released (or expired by a
  // duplicate job run) before this fired — nothing left to do.
  if (result.count === 0) return;

  await recordAuditLog({
    action: 'held_order_expired',
    entityType: 'hold_order',
    entityId: holdOrderId,
    actorId: null,
    actorRole: 'system',
    branchId,
    afterState: { hold_order_id: holdOrderId, shift_id: shiftId },
  });

  // Non-blocking toast on expiry (Architecture doc §Part 8) — the frontend
  // listens for this event to surface the toast; no supervisor action or
  // API call is required on the frontend's part.
  notifyBranch(branchId, SOCKET_EVENTS.HOLD_ORDER_EXPIRED, { holdOrderId, branchId, shiftId });
}

/** Hold order queue worker. Single job type (hold_order_expiry), no retries needed — a missed expiry check is caught by the next read of the hold order's expiresAt, not silently lost. */
export const holdOrderWorker = new Worker(
  'hold-order',
  async (job: Job) => {
    if (job.name === 'hold_order_expiry') {
      await processHoldOrderExpiry(job as Job<HoldOrderExpiryJobData>);
      return;
    }
  },
  { connection: createWorkerConnection() },
);
