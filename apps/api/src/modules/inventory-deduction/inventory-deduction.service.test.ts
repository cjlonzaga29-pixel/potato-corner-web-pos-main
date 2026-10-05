import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./inventory-deduction.repository.js', () => ({
  inventoryDeductionRepository: {
    claimBatch: vi.fn(),
    applyDeduction: vi.fn(),
    recordFailure: vi.fn().mockResolvedValue(undefined),
  },
}));

const { inventoryDeductionRepository } = await import('./inventory-deduction.repository.js');
const { inventoryDeductionService } = await import('./inventory-deduction.service.js');

function claimedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: 'job-1', transactionId: 'txn-1', branchId: 'branch-1', attempts: 0, claimToken: 'tok-1', createdAt: new Date(), ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('inventoryDeductionService.runCycle', () => {
  it('claims nothing and returns an all-zero result when no jobs are eligible', async () => {
    vi.mocked(inventoryDeductionRepository.claimBatch).mockResolvedValueOnce([]);

    const result = await inventoryDeductionService.runCycle(25, 300_000);

    expect(result).toEqual({ claimed: 0, completed: 0, retried: 0, failed: 0, skipped: 0 });
  });

  it('processes every claimed job sequentially, in claimed order, and reports a completed outcome for each successful deduction', async () => {
    vi.mocked(inventoryDeductionRepository.claimBatch).mockResolvedValueOnce([claimedRow({ id: 'job-1' }), claimedRow({ id: 'job-2' })] as never);
    vi.mocked(inventoryDeductionRepository.applyDeduction).mockResolvedValue({ applied: true, effects: [] });

    const result = await inventoryDeductionService.runCycle(25, 300_000);

    expect(result).toEqual({ claimed: 2, completed: 2, retried: 0, failed: 0, skipped: 0 });
    expect(vi.mocked(inventoryDeductionRepository.applyDeduction).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(inventoryDeductionRepository.applyDeduction).mock.invocationCallOrder[1] as number,
    );
  });

  it('reports skipped (never retried) when applyDeduction signals the claim guard was lost — exactly-once: nothing was written, so this is not a failure', async () => {
    vi.mocked(inventoryDeductionRepository.claimBatch).mockResolvedValueOnce([claimedRow()] as never);
    vi.mocked(inventoryDeductionRepository.applyDeduction).mockResolvedValueOnce({ applied: false, effects: [] });

    const result = await inventoryDeductionService.runCycle(25, 300_000);

    expect(result).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 0, skipped: 1 });
    expect(inventoryDeductionRepository.recordFailure).not.toHaveBeenCalled();
  });

  it('retries with a bounded backoff below the max attempt count, never marking the job (or its sale) failed yet', async () => {
    vi.mocked(inventoryDeductionRepository.claimBatch).mockResolvedValueOnce([claimedRow({ attempts: 0 })] as never);
    vi.mocked(inventoryDeductionRepository.applyDeduction).mockRejectedValueOnce(new Error('transient db error'));

    const result = await inventoryDeductionService.runCycle(25, 300_000);

    expect(result).toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0, skipped: 0 });
    expect(inventoryDeductionRepository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', attempts: 1, nextStatus: 'pending' }),
    );
    const call = vi.mocked(inventoryDeductionRepository.recordFailure).mock.calls[0]?.[0];
    if (!call) throw new Error('expected recordFailure to have been called');
    expect((call as { nextAttemptAt: Date | null }).nextAttemptAt).toBeInstanceOf(Date);
  });

  it('marks the job (and, via recordFailure, the sale) failed once the max attempt count is exhausted — visible through the existing admin pattern, never silently retried forever', async () => {
    vi.mocked(inventoryDeductionRepository.claimBatch).mockResolvedValueOnce([claimedRow({ attempts: 2 })] as never);
    vi.mocked(inventoryDeductionRepository.applyDeduction).mockRejectedValueOnce(new Error('insufficient stock'));

    const result = await inventoryDeductionService.runCycle(25, 300_000);

    expect(result).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1, skipped: 0 });
    expect(inventoryDeductionRepository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', attempts: 3, nextStatus: 'failed', nextAttemptAt: null }),
    );
  });

  it('never persists a raw error object/stack — only a capped, single-line sanitized message', async () => {
    vi.mocked(inventoryDeductionRepository.claimBatch).mockResolvedValueOnce([claimedRow({ attempts: 0 })] as never);
    const err = new Error('boom\nwith a stack-like second line');
    vi.mocked(inventoryDeductionRepository.applyDeduction).mockRejectedValueOnce(err);

    await inventoryDeductionService.runCycle(25, 300_000);

    const call = vi.mocked(inventoryDeductionRepository.recordFailure).mock.calls[0]?.[0];
    if (!call) throw new Error('expected recordFailure to have been called');
    expect((call as { lastError: string }).lastError).toBe('boom');
  });

  it('one job throwing never aborts the rest of the batch — each job is independently recorded', async () => {
    vi.mocked(inventoryDeductionRepository.claimBatch).mockResolvedValueOnce([
      claimedRow({ id: 'job-1', transactionId: 'txn-1' }),
      claimedRow({ id: 'job-2', transactionId: 'txn-2' }),
    ] as never);
    vi.mocked(inventoryDeductionRepository.applyDeduction)
      .mockRejectedValueOnce(new Error('job-1 fails'))
      .mockResolvedValueOnce({ applied: true, effects: [] });

    const result = await inventoryDeductionService.runCycle(25, 300_000);

    expect(result).toEqual({ claimed: 2, completed: 1, retried: 1, failed: 0, skipped: 0 });
  });
});
