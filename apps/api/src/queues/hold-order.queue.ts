import { SOCKET_EVENTS } from '@potato-corner/shared';
import { transactionsRepository } from '../modules/transactions/transactions.repository.js';
import { recordAuditLog } from '../middleware/audit-log.js';
import { notifyBranch } from '../lib/notify.js';

export interface HoldOrderExpiryJobData {
  holdOrderId: string;
  branchId: string;
  shiftId: string;
}

/**
 * Phase 21: BullMQ removed — a plain setTimeout replaces the delayed job
 * (see lib/job-runner.ts's design note). Process-lifetime only: a restart
 * before the timer fires drops it silently, same as the old queue's
 * `jobId: holdOrderId` dedup being lost — acceptable per
 * processHoldOrderExpiry's existing no-op-if-not-held guard below, and the
 * comment this function already carried: "a missed expiry check is caught
 * by the next read of the hold order's expiresAt, not silently lost."
 */
export function enqueueHoldOrderExpiry(data: HoldOrderExpiryJobData, delayMs: number): Promise<void> {
  setTimeout(() => {
    processHoldOrderExpiry(data).catch((error: unknown) => {
      console.error(`Hold order expiry check failed for ${data.holdOrderId}:`, error);
    });
  }, delayMs);
  return Promise.resolve();
}

export async function processHoldOrderExpiry(job: HoldOrderExpiryJobData): Promise<void> {
  const { holdOrderId, branchId, shiftId } = job;

  const result = await transactionsRepository.expireHoldOrderIfStillHeld(holdOrderId);
  // count === 0 means the hold was already released (or expired by a
  // duplicate timer firing, e.g. two enqueueHoldOrderExpiry calls for the
  // same hold) before this fired — nothing left to do.
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
