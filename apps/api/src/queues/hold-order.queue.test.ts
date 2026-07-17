import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { HoldOrderExpiryJobData } from './hold-order.queue.js';

/**
 * Same reasoning as inventory.queue.test.ts: bullmq's Queue/Worker
 * constructors are inert here so importing this file doesn't require a live
 * Redis connection — processHoldOrderExpiry is tested directly, never
 * through the real Queue/Worker dispatch machinery.
 */
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn() })),
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn() })),
}));

vi.mock('../lib/redis.js', () => ({
  redis: {},
  createWorkerConnection: vi.fn().mockReturnValue({ on: vi.fn() }),
}));

vi.mock('../modules/transactions/transactions.repository.js', () => ({
  transactionsRepository: {
    expireHoldOrderIfStillHeld: vi.fn(),
  },
}));

vi.mock('../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/notify.js', () => ({
  notifyBranch: vi.fn(),
}));

const { transactionsRepository } = await import('../modules/transactions/transactions.repository.js');
const { recordAuditLog } = await import('../middleware/audit-log.js');
const { notifyBranch } = await import('../lib/notify.js');
const { processHoldOrderExpiry } = await import('./hold-order.queue.js');

function job(data: HoldOrderExpiryJobData): Job<HoldOrderExpiryJobData> {
  return { data } as Job<HoldOrderExpiryJobData>;
}

const jobData: HoldOrderExpiryJobData = { holdOrderId: 'hold-1', branchId: 'branch-1', shiftId: 'shift-1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('processHoldOrderExpiry', () => {
  it('marks a still-held order expired, writes the held_order_expired audit event, and broadcasts the toast trigger', async () => {
    vi.mocked(transactionsRepository.expireHoldOrderIfStillHeld).mockResolvedValue({ count: 1 });

    await processHoldOrderExpiry(job(jobData));

    expect(transactionsRepository.expireHoldOrderIfStillHeld).toHaveBeenCalledWith('hold-1');
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'held_order_expired', entityType: 'hold_order', entityId: 'hold-1', branchId: 'branch-1' }),
    );
    expect(notifyBranch).toHaveBeenCalledWith('branch-1', 'hold_order:expired', {
      holdOrderId: 'hold-1',
      branchId: 'branch-1',
      shiftId: 'shift-1',
    });
  });

  it('is a no-op when the hold order was already released before the job fired (race with a manual release)', async () => {
    vi.mocked(transactionsRepository.expireHoldOrderIfStillHeld).mockResolvedValue({ count: 0 });

    await processHoldOrderExpiry(job(jobData));

    expect(recordAuditLog).not.toHaveBeenCalled();
    expect(notifyBranch).not.toHaveBeenCalled();
  });
});
