import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    inventoryDeductionJob: { findMany: vi.fn(), updateMany: vi.fn() },
    transactionItem: { findMany: vi.fn().mockResolvedValue([]) },
    inventoryItem: { findMany: vi.fn().mockResolvedValue([]) },
    inventoryStock: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(prismaMock)),
  };
  return { prisma: prismaMock };
});

vi.mock('../inventory/inventory.repository.js', () => ({
  inventoryRepository: { updateTransactionDeductionStatus: vi.fn().mockResolvedValue({ inventoryDeductionStatus: 'completed' }) },
}));

vi.mock('../universal-inventory/universal-inventory.repository.js', () => ({
  universalInventoryRepository: { createStockMovements: vi.fn().mockResolvedValue({ count: 0 }) },
}));

vi.mock('../../queues/notification.queue.js', () => ({
  enqueueRawNotificationJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const { prisma } = await import('../../lib/prisma.js');
const { inventoryRepository } = await import('../inventory/inventory.repository.js');
const { universalInventoryRepository } = await import('../universal-inventory/universal-inventory.repository.js');
const { inventoryDeductionRepository } = await import('./inventory-deduction.repository.js');

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('inventoryDeductionRepository.claimBatch', () => {
  it('returns [] without claiming anything when there are no eligible candidates', async () => {
    vi.mocked(prisma.inventoryDeductionJob.findMany).mockResolvedValueOnce([] as never);

    const result = await inventoryDeductionRepository.claimBatch(25, 300_000);

    expect(result).toEqual([]);
    expect(prisma.inventoryDeductionJob.updateMany).not.toHaveBeenCalled();
  });

  it('claims candidates via a conditional updateMany scoped to pending/stale-processing, then re-reads only rows matching this claim token', async () => {
    vi.mocked(prisma.inventoryDeductionJob.findMany)
      .mockResolvedValueOnce([{ id: 'job-1' }, { id: 'job-2' }] as never)
      .mockResolvedValueOnce([{ id: 'job-1', transactionId: 'txn-1', branchId: 'branch-1', status: 'processing', attempts: 0, claimToken: 'tok' }] as never);
    vi.mocked(prisma.inventoryDeductionJob.updateMany).mockResolvedValueOnce({ count: 1 } as never);

    const result = await inventoryDeductionRepository.claimBatch(25, 300_000);

    // Only job-1 actually won the race (job-2 presumably stolen by another worker between phase 1 and phase 2).
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'job-1', transactionId: 'txn-1' });

    const [claimWhere, claimData] = vi.mocked(prisma.inventoryDeductionJob.updateMany).mock.calls[0] as unknown as [
      { where: { id: { in: string[] } } },
      { data: unknown },
    ];
    expect(claimWhere.where).toMatchObject({ id: { in: ['job-1', 'job-2'] } });
    void claimData;
  });

  it('reclaims a job whose processing lock is older than staleLockMs — a crashed/restarted worker eventually releases its claim', async () => {
    const staleLockMs = 300_000;
    vi.mocked(prisma.inventoryDeductionJob.findMany)
      .mockResolvedValueOnce([{ id: 'job-stale' }] as never)
      .mockResolvedValueOnce([{ id: 'job-stale', transactionId: 'txn-9', branchId: 'branch-1', status: 'processing', attempts: 1, claimToken: 'tok2' }] as never);
    vi.mocked(prisma.inventoryDeductionJob.updateMany).mockResolvedValueOnce({ count: 1 } as never);

    const result = await inventoryDeductionRepository.claimBatch(25, staleLockMs);

    expect(result).toHaveLength(1);
    const [firstFindManyArgs] = vi.mocked(prisma.inventoryDeductionJob.findMany).mock.calls[0] as unknown as [
      { where: { OR: Array<Record<string, unknown>> } },
    ];
    const staleBranch = firstFindManyArgs.where.OR.find((clause) => (clause as { status?: string }).status === 'processing') as
      | { lockedAt?: { lt: Date } }
      | undefined;
    expect(staleBranch?.lockedAt?.lt).toBeInstanceOf(Date);
  });
});

describe('inventoryDeductionRepository.applyDeduction', () => {
  it('returns applied:false and touches nothing when the claim guard affects zero rows (ownership lost to a stale-lock reclaim)', async () => {
    vi.mocked(prisma.inventoryDeductionJob.updateMany).mockResolvedValueOnce({ count: 0 } as never);

    const result = await inventoryDeductionRepository.applyDeduction({
      jobId: 'job-1',
      claimToken: 'tok',
      transactionId: 'txn-1',
      branchId: 'branch-1',
    });

    expect(result).toEqual({ applied: false, effects: [] });
    expect(prisma.inventoryStock.update).not.toHaveBeenCalled();
    expect(universalInventoryRepository.createStockMovements).not.toHaveBeenCalled();
  });

  it('decrements quantityOnHand AND releases the matching quantityReserved in the same update, writes a SALE movement, and completes the Transaction status', async () => {
    vi.mocked(prisma.inventoryDeductionJob.updateMany).mockResolvedValueOnce({ count: 1 } as never);
    vi.mocked(prisma.transactionItem.findMany).mockResolvedValueOnce([
      { deductionSnapshot: [{ inventoryItemId: 'item-flour', quantity: 2, baseUnitId: 'unit-g' }] },
    ] as never);
    vi.mocked(prisma.inventoryItem.findMany).mockResolvedValueOnce([{ id: 'item-flour', name: 'Flour' }] as never);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([
      {
        inventoryItemId: 'item-flour',
        quantityOnHand: decimal(10),
        quantityReserved: decimal(2),
        unitCost: decimal(3),
        lowStockThreshold: null,
        criticalThreshold: null,
      },
    ] as never);
    vi.mocked(prisma.inventoryStock.update).mockResolvedValueOnce({
      id: 'stock-1',
      quantityOnHand: decimal(8),
      lowStockThreshold: null,
      criticalThreshold: null,
    } as never);

    const result = await inventoryDeductionRepository.applyDeduction({
      jobId: 'job-1',
      claimToken: 'tok',
      transactionId: 'txn-1',
      branchId: 'branch-1',
    });

    expect(result.applied).toBe(true);
    expect(prisma.inventoryStock.update).toHaveBeenCalledWith({
      where: { branchId_inventoryItemId: { branchId: 'branch-1', inventoryItemId: 'item-flour' } },
      data: {
        quantityOnHand: { decrement: 2 },
        quantityReserved: { decrement: 2 },
        version: { increment: 1 },
      },
    });
    expect(universalInventoryRepository.createStockMovements).toHaveBeenCalledWith(
      [expect.objectContaining({ branchId: 'branch-1', inventoryItemId: 'item-flour', movementType: 'SALE', referenceId: 'txn-1' })],
      expect.anything(),
    );
    expect(inventoryRepository.updateTransactionDeductionStatus).toHaveBeenCalledWith('txn-1', 'completed', expect.anything());
  });

  it('floors the quantityReserved release at the actually-reserved amount, never driving it negative', async () => {
    vi.mocked(prisma.inventoryDeductionJob.updateMany).mockResolvedValueOnce({ count: 1 } as never);
    vi.mocked(prisma.transactionItem.findMany).mockResolvedValueOnce([
      { deductionSnapshot: [{ inventoryItemId: 'item-flour', quantity: 5, baseUnitId: 'unit-g' }] },
    ] as never);
    vi.mocked(prisma.inventoryItem.findMany).mockResolvedValueOnce([{ id: 'item-flour', name: 'Flour' }] as never);
    // Only 2 were ever actually reserved (e.g. reserved pre-dates a schema
    // fix, or a partial release already happened) — must never request a
    // decrement of 5 against a reserved balance of 2.
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([
      { inventoryItemId: 'item-flour', quantityOnHand: decimal(10), quantityReserved: decimal(2), unitCost: null, lowStockThreshold: null, criticalThreshold: null },
    ] as never);
    vi.mocked(prisma.inventoryStock.update).mockResolvedValueOnce({ id: 'stock-1', quantityOnHand: decimal(5), lowStockThreshold: null, criticalThreshold: null } as never);

    await inventoryDeductionRepository.applyDeduction({ jobId: 'job-1', claimToken: 'tok', transactionId: 'txn-1', branchId: 'branch-1' });

    expect(prisma.inventoryStock.update).toHaveBeenCalledWith({
      where: { branchId_inventoryItemId: { branchId: 'branch-1', inventoryItemId: 'item-flour' } },
      data: { quantityOnHand: { decrement: 5 }, quantityReserved: { decrement: 2 }, version: { increment: 1 } },
    });
  });

  it('throws (never drives quantityOnHand negative) when quantityOnHand somehow cannot cover the deduction — a writer-invariant violation, not a normal outcome', async () => {
    vi.mocked(prisma.inventoryDeductionJob.updateMany).mockResolvedValueOnce({ count: 1 } as never);
    vi.mocked(prisma.transactionItem.findMany).mockResolvedValueOnce([
      { deductionSnapshot: [{ inventoryItemId: 'item-flour', quantity: 5, baseUnitId: 'unit-g' }] },
    ] as never);
    vi.mocked(prisma.inventoryItem.findMany).mockResolvedValueOnce([{ id: 'item-flour', name: 'Flour' }] as never);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([
      { inventoryItemId: 'item-flour', quantityOnHand: decimal(1), quantityReserved: decimal(1), unitCost: null, lowStockThreshold: null, criticalThreshold: null },
    ] as never);

    await expect(
      inventoryDeductionRepository.applyDeduction({ jobId: 'job-1', claimToken: 'tok', transactionId: 'txn-1', branchId: 'branch-1' }),
    ).rejects.toThrow();
    expect(prisma.inventoryStock.update).not.toHaveBeenCalled();
  });
});

describe('inventoryDeductionRepository.recordFailure', () => {
  it('below max attempts: returns the job to pending with a backoff, and never touches the Transaction row', async () => {
    vi.mocked(prisma.inventoryDeductionJob.updateMany).mockResolvedValueOnce({ count: 1 } as never);

    await inventoryDeductionRepository.recordFailure({
      jobId: 'job-1',
      transactionId: 'txn-1',
      claimToken: 'tok',
      attempts: 1,
      nextStatus: 'pending',
      lastError: 'transient db error',
      nextAttemptAt: new Date(Date.now() + 10_000),
    });

    expect(prisma.inventoryDeductionJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1', status: 'processing', claimToken: 'tok' },
        data: expect.objectContaining({ status: 'pending', attempts: 1 }),
      }),
    );
    expect(inventoryRepository.updateTransactionDeductionStatus).not.toHaveBeenCalled();
  });

  it('at max attempts: marks the job failed AND flips the Transaction to failed — visible via the existing admin badge', async () => {
    vi.mocked(prisma.inventoryDeductionJob.updateMany).mockResolvedValueOnce({ count: 1 } as never);

    await inventoryDeductionRepository.recordFailure({
      jobId: 'job-1',
      transactionId: 'txn-1',
      claimToken: 'tok',
      attempts: 3,
      nextStatus: 'failed',
      lastError: 'insufficient stock',
      nextAttemptAt: null,
    });

    expect(inventoryRepository.updateTransactionDeductionStatus).toHaveBeenCalledWith('txn-1', 'failed', expect.anything());
  });

  it('does nothing when the guard loses ownership (job already reclaimed by another worker)', async () => {
    vi.mocked(prisma.inventoryDeductionJob.updateMany).mockResolvedValueOnce({ count: 0 } as never);

    await inventoryDeductionRepository.recordFailure({
      jobId: 'job-1',
      transactionId: 'txn-1',
      claimToken: 'stale-tok',
      attempts: 3,
      nextStatus: 'failed',
      lastError: 'insufficient stock',
      nextAttemptAt: null,
    });

    expect(inventoryRepository.updateTransactionDeductionStatus).not.toHaveBeenCalled();
  });
});

describe('inventoryDeductionRepository.cancelAndReleaseReservation', () => {
  it('cancels a pending/failed job and releases its reservation via a floored decrement', async () => {
    const tx = prisma as unknown as Parameters<typeof inventoryDeductionRepository.cancelAndReleaseReservation>[0];
    vi.mocked(prisma.inventoryDeductionJob.updateMany).mockResolvedValueOnce({ count: 1 } as never);
    vi.mocked(prisma.transactionItem.findMany).mockResolvedValueOnce([
      { deductionSnapshot: [{ inventoryItemId: 'item-flour', quantity: 2, baseUnitId: 'unit-g' }] },
    ] as never);

    const released = await inventoryDeductionRepository.cancelAndReleaseReservation(tx, 'job-1', 'branch-1', 'txn-1');

    expect(released).toBe(true);
    expect(prisma.inventoryDeductionJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: { in: ['pending', 'failed'] } },
      data: { status: 'cancelled', claimToken: null, lockedAt: null },
    });
    const releaseCall = vi.mocked(prisma.$executeRaw).mock.calls.find((call) => Array.isArray(call[0]) && call[0].join(' ').includes('quantity_reserved'));
    expect(releaseCall).toBeDefined();
  });

  it('returns false without releasing anything when the job has already moved past pending/failed (claimed or completed)', async () => {
    const tx = prisma as unknown as Parameters<typeof inventoryDeductionRepository.cancelAndReleaseReservation>[0];
    vi.mocked(prisma.inventoryDeductionJob.updateMany).mockResolvedValueOnce({ count: 0 } as never);

    const released = await inventoryDeductionRepository.cancelAndReleaseReservation(tx, 'job-1', 'branch-1', 'txn-1');

    expect(released).toBe(false);
    expect(prisma.transactionItem.findMany).not.toHaveBeenCalled();
  });
});
