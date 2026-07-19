import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HoldOrderExpiryJobData } from './hold-order.queue.js';

/**
 * Phase 21: BullMQ removed — enqueueHoldOrderExpiry now uses a plain
 * setTimeout instead of a delayed BullMQ job (see the design note at the top
 * of hold-order.queue.ts). processHoldOrderExpiry itself now takes the plain
 * job-data object directly (no more Job<T> wrapper).
 */
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
const { processHoldOrderExpiry, enqueueHoldOrderExpiry } = await import('./hold-order.queue.js');

const jobData: HoldOrderExpiryJobData = { holdOrderId: 'hold-1', branchId: 'branch-1', shiftId: 'shift-1' };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('processHoldOrderExpiry', () => {
  it('marks a still-held order expired, writes the held_order_expired audit event, and broadcasts the toast trigger', async () => {
    vi.mocked(transactionsRepository.expireHoldOrderIfStillHeld).mockResolvedValue({ count: 1 });

    await processHoldOrderExpiry(jobData);

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

    await processHoldOrderExpiry(jobData);

    expect(recordAuditLog).not.toHaveBeenCalled();
    expect(notifyBranch).not.toHaveBeenCalled();
  });
});

describe('enqueueHoldOrderExpiry', () => {
  it('does not check the hold order before the delay elapses', async () => {
    vi.useFakeTimers();
    vi.mocked(transactionsRepository.expireHoldOrderIfStillHeld).mockResolvedValue({ count: 1 });

    await enqueueHoldOrderExpiry(jobData, 60_000);
    await vi.advanceTimersByTimeAsync(59_000);

    expect(transactionsRepository.expireHoldOrderIfStillHeld).not.toHaveBeenCalled();
  });

  it('checks (and expires) the hold order once the delay elapses', async () => {
    vi.useFakeTimers();
    vi.mocked(transactionsRepository.expireHoldOrderIfStillHeld).mockResolvedValue({ count: 1 });

    await enqueueHoldOrderExpiry(jobData, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(transactionsRepository.expireHoldOrderIfStillHeld).toHaveBeenCalledWith('hold-1');
    expect(notifyBranch).toHaveBeenCalledWith('branch-1', 'hold_order:expired', {
      holdOrderId: 'hold-1',
      branchId: 'branch-1',
      shiftId: 'shift-1',
    });
  });

  it('logs (and does not throw out of the timer) when the expiry check itself fails', async () => {
    vi.useFakeTimers();
    vi.mocked(transactionsRepository.expireHoldOrderIfStillHeld).mockRejectedValue(new Error('db unreachable'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await enqueueHoldOrderExpiry(jobData, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    // Let the rejected processHoldOrderExpiry promise's .catch() handler run.
    await vi.waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());

    expect(consoleErrorSpy).toHaveBeenCalledWith('Hold order expiry check failed for hold-1:', expect.any(Error));

    consoleErrorSpy.mockRestore();
  });
});
