import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    inventoryProjectionOutbox: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    inventoryIdentityMapping: {
      findUnique: vi.fn(),
    },
    inventoryStock: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prismaMock)),
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { inventoryProjectionRepository } = await import('./inventory-projection.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

/** Same convention as e2e.test.ts: a throwing helper instead of `!` under noUncheckedIndexedAccess. */
function firstOf<T>(arr: readonly T[]): T {
  const [head] = arr;
  if (head === undefined) throw new Error('expected a non-empty array');
  return head;
}

function nonNull<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a non-null value');
  return value;
}

describe('inventoryProjectionRepository.claimBatch', () => {
  it('returns [] without claiming anything when there are no eligible candidates', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.findMany).mockResolvedValueOnce([] as never);

    const result = await inventoryProjectionRepository.claimBatch(10, 300_000);

    expect(result).toEqual([]);
    expect(prisma.inventoryProjectionOutbox.updateMany).not.toHaveBeenCalled();
  });

  it('claims candidates via a conditional updateMany, then re-reads only the rows matching this claim token', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.findMany)
      .mockResolvedValueOnce([{ id: 'row-1' }, { id: 'row-2' }] as never)
      .mockResolvedValueOnce([{ id: 'row-1', movementId: 'mv-1', status: 'processing', claimToken: 'irrelevant-to-this-assertion' }] as never);
    vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mockResolvedValueOnce({ count: 1 } as never);

    const result = await inventoryProjectionRepository.claimBatch(10, 300_000);

    // Only row-1 actually won the race (row-2 was presumably stolen by another worker between phase 1 and phase 2).
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'row-1', movementId: 'mv-1', status: 'processing' });

    const claimCall = firstOf(firstOf(vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mock.calls));
    expect(claimCall.where).toMatchObject({ id: { in: ['row-1', 'row-2'] } });
    expect(claimCall.data).toMatchObject({ status: 'processing' });
    expect(claimCall.data.lockedAt).toBeInstanceOf(Date);
    expect(typeof claimCall.data.claimToken).toBe('string');

    // Phase-3 re-read is scoped to this call's exact token, not merely status = 'processing'.
    const findManyCalls = vi.mocked(prisma.inventoryProjectionOutbox.findMany).mock.calls;
    const secondCall = findManyCalls[1];
    if (!secondCall) throw new Error('expected a second findMany call');
    const rereadCall = nonNull(firstOf(secondCall));
    expect(rereadCall.where).toMatchObject({ id: { in: ['row-1', 'row-2'] }, claimToken: claimCall.data.claimToken });
  });

  it('generates a distinct claimToken on every call, so two concurrent claims can never share ownership', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.findMany).mockResolvedValue([{ id: 'row-1' }] as never);
    vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mockResolvedValue({ count: 0 } as never);

    await inventoryProjectionRepository.claimBatch(10, 300_000);
    await inventoryProjectionRepository.claimBatch(10, 300_000);

    const tokens = vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mock.calls.map((c) => firstOf(c).data.claimToken);
    expect(tokens[0]).not.toEqual(tokens[1]);
  });

  it('does not return a row merely because its status is processing under a different (stale) claimToken', async () => {
    // Simulates: another worker's stale lock got reclaimed by someone else in between; phase-3 must not
    // pick it up just because status happens to be 'processing' — only an exact claimToken match counts.
    vi.mocked(prisma.inventoryProjectionOutbox.findMany)
      .mockResolvedValueOnce([{ id: 'row-1' }] as never)
      .mockResolvedValueOnce([] as never); // no row matches *this* worker's token
    vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mockResolvedValueOnce({ count: 0 } as never);

    const result = await inventoryProjectionRepository.claimBatch(10, 300_000);

    expect(result).toEqual([]);
  });

  it('preserves the phase-1 createdAt ordering in the returned batch', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.findMany)
      .mockResolvedValueOnce([{ id: 'row-a' }, { id: 'row-b' }, { id: 'row-c' }] as never)
      .mockResolvedValueOnce([{ id: 'row-c' }, { id: 'row-a' }, { id: 'row-b' }] as never); // re-read comes back in a different order
    vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mockResolvedValueOnce({ count: 3 } as never);

    const result = await inventoryProjectionRepository.claimBatch(10, 300_000);

    expect(result.map((r) => r.id)).toEqual(['row-a', 'row-b', 'row-c']);
  });

  it('reads candidates ordered by createdAt ascending', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.findMany).mockResolvedValueOnce([] as never);

    await inventoryProjectionRepository.claimBatch(25, 300_000);

    expect(prisma.inventoryProjectionOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'asc' }, take: 25 }),
    );
  });

  it('treats a processing row with a lock older than staleLockMs as claimable', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.findMany).mockResolvedValueOnce([] as never);

    await inventoryProjectionRepository.claimBatch(10, 300_000);

    const readCall = nonNull(firstOf(firstOf(vi.mocked(prisma.inventoryProjectionOutbox.findMany).mock.calls)));
    const readWhere = readCall.where as { OR: Array<{ status?: string }> };
    const staleBranch = readWhere.OR.find((clause) => clause.status === 'processing');
    expect(staleBranch).toMatchObject({ status: 'processing', lockedAt: { lt: expect.any(Date) } });
  });
});

describe('inventoryProjectionRepository.findAcceptedMapping', () => {
  it('returns null when no mapping exists', async () => {
    vi.mocked(prisma.inventoryIdentityMapping.findUnique).mockResolvedValueOnce(null as never);
    expect(await inventoryProjectionRepository.findAcceptedMapping('ing-1')).toBeNull();
  });

  it('returns null when the mapping has no inventoryItemId', async () => {
    vi.mocked(prisma.inventoryIdentityMapping.findUnique).mockResolvedValueOnce({
      inventoryItemId: null,
      mappingStatus: 'AUTO_MATCHED',
    } as never);
    expect(await inventoryProjectionRepository.findAcceptedMapping('ing-1')).toBeNull();
  });

  it.each(['PENDING', 'AMBIGUOUS', 'REJECTED'])('returns null when mappingStatus is %s even with an inventoryItemId set', async (status) => {
    vi.mocked(prisma.inventoryIdentityMapping.findUnique).mockResolvedValueOnce({
      inventoryItemId: 'item-1',
      mappingStatus: status,
    } as never);
    expect(await inventoryProjectionRepository.findAcceptedMapping('ing-1')).toBeNull();
  });

  it.each(['AUTO_MATCHED', 'MANUALLY_MATCHED'])('returns the mapping when status is %s and inventoryItemId is set', async (status) => {
    const mapping = { inventoryItemId: 'item-1', mappingStatus: status };
    vi.mocked(prisma.inventoryIdentityMapping.findUnique).mockResolvedValueOnce(mapping as never);
    expect(await inventoryProjectionRepository.findAcceptedMapping('ing-1')).toBe(mapping);
  });
});

describe('inventoryProjectionRepository.deferRow', () => {
  it('flips a processing row to deferred, releases the lock/token, sets a future nextAttemptAt, and never touches attempts', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mockResolvedValueOnce({ count: 1 } as never);
    const before = Date.now();

    await inventoryProjectionRepository.deferRow('row-1', 'token-a');

    expect(prisma.inventoryProjectionOutbox.updateMany).toHaveBeenCalledTimes(1);
    const call = firstOf(firstOf(vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mock.calls));
    expect(call.where).toEqual({ id: 'row-1', status: 'processing', claimToken: 'token-a' });
    expect(call.data).toMatchObject({ status: 'deferred', claimToken: null, lockedAt: null });
    expect(('attempts' in call.data)).toBe(false);
    expect(nonNull(call.data.nextAttemptAt as Date | null).getTime()).toBeGreaterThan(before);
  });

  it('only the correct claimToken can defer a row — a mismatched token is scoped out by the where clause', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mockResolvedValueOnce({ count: 0 } as never);

    await inventoryProjectionRepository.deferRow('row-1', 'wrong-token');

    const call = firstOf(firstOf(vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mock.calls));
    expect(call.where).toEqual({ id: 'row-1', status: 'processing', claimToken: 'wrong-token' });
  });
});

describe('inventoryProjectionRepository.applyProjection', () => {
  it('marks the row processed (clearing claimToken) and upserts InventoryStock (create path) inside one transaction', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mockResolvedValueOnce({ count: 1 } as never);
    vi.mocked(prisma.inventoryStock.findUnique).mockResolvedValueOnce(null as never);
    vi.mocked(prisma.inventoryStock.upsert).mockResolvedValueOnce({} as never);

    const applied = await inventoryProjectionRepository.applyProjection({
      outboxId: 'row-1',
      claimToken: 'token-a',
      branchId: 'branch-1',
      inventoryItemId: 'item-1',
      quantityChange: decimal(-5),
      movementCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(applied).toBe(true);
    expect(prisma.inventoryProjectionOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'row-1', status: 'processing', claimToken: 'token-a' },
      data: { status: 'processed', processedAt: expect.any(Date), claimToken: null, lockedAt: null },
    });
    expect(prisma.inventoryStock.upsert).toHaveBeenCalledWith({
      where: { branchId_inventoryItemId: { branchId: 'branch-1', inventoryItemId: 'item-1' } },
      create: { branchId: 'branch-1', inventoryItemId: 'item-1', quantityOnHand: decimal(-5), version: 1 },
      update: { quantityOnHand: { increment: decimal(-5) }, version: { increment: 1 } },
    });
  });

  it('returns false and never upserts InventoryStock when the row is no longer processing under this token (lost claim guard)', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mockResolvedValueOnce({ count: 0 } as never);

    const applied = await inventoryProjectionRepository.applyProjection({
      outboxId: 'row-1',
      claimToken: 'stale-token',
      branchId: 'branch-1',
      inventoryItemId: 'item-1',
      quantityChange: decimal(5),
      movementCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(applied).toBe(false);
    expect(prisma.inventoryStock.upsert).not.toHaveBeenCalled();
  });

  it('an expired owner cannot finalize a row after a new worker reclaims it under a different token', async () => {
    // The CAS where-clause includes the stale token, so it matches 0 rows once the row has moved
    // to a new claimToken — this is exactly what makes the finalize a no-op instead of a double-apply.
    vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mockResolvedValueOnce({ count: 0 } as never);

    const applied = await inventoryProjectionRepository.applyProjection({
      outboxId: 'row-1',
      claimToken: 'old-worker-token',
      branchId: 'branch-1',
      inventoryItemId: 'item-1',
      quantityChange: decimal(-5),
      movementCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(applied).toBe(false);
    const call = firstOf(firstOf(vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mock.calls));
    expect(call.where).toMatchObject({ claimToken: 'old-worker-token' });
    expect(prisma.inventoryStock.upsert).not.toHaveBeenCalled();
  });

  it('skips the InventoryStock write (but still finalizes the outbox row) when the movement predates the rebuild watermark', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mockResolvedValueOnce({ count: 1 } as never);
    vi.mocked(prisma.inventoryStock.findUnique).mockResolvedValueOnce({ rebuiltThroughAt: new Date('2026-01-02T00:00:00.000Z') } as never);

    const applied = await inventoryProjectionRepository.applyProjection({
      outboxId: 'row-1',
      claimToken: 'token-a',
      branchId: 'branch-1',
      inventoryItemId: 'item-1',
      quantityChange: decimal(-5),
      movementCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(applied).toBe(true);
    expect(prisma.inventoryStock.upsert).not.toHaveBeenCalled();
  });

  it('applies the increment normally when the movement is newer than the rebuild watermark', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mockResolvedValueOnce({ count: 1 } as never);
    vi.mocked(prisma.inventoryStock.findUnique).mockResolvedValueOnce({ rebuiltThroughAt: new Date('2026-01-01T00:00:00.000Z') } as never);
    vi.mocked(prisma.inventoryStock.upsert).mockResolvedValueOnce({} as never);

    const applied = await inventoryProjectionRepository.applyProjection({
      outboxId: 'row-1',
      claimToken: 'token-a',
      branchId: 'branch-1',
      inventoryItemId: 'item-1',
      quantityChange: decimal(-5),
      movementCreatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    expect(applied).toBe(true);
    expect(prisma.inventoryStock.upsert).toHaveBeenCalled();
  });
});

describe('inventoryProjectionRepository.recordFailure', () => {
  it('persists attempts, sanitized lastError, next status and backoff, and releases the lock/token — scoped to this claimToken', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mockResolvedValueOnce({ count: 1 } as never);
    const nextAttemptAt = new Date('2026-01-01T00:00:10.000Z');

    await inventoryProjectionRepository.recordFailure({
      outboxId: 'row-1',
      claimToken: 'token-a',
      attempts: 2,
      nextStatus: 'pending',
      lastError: 'db timeout',
      nextAttemptAt,
    });

    expect(prisma.inventoryProjectionOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'row-1', status: 'processing', claimToken: 'token-a' },
      data: { attempts: 2, lastError: 'db timeout', status: 'pending', nextAttemptAt, claimToken: null, lockedAt: null },
    });
  });

  it('sets status stuck with a null nextAttemptAt when called with nextStatus stuck', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mockResolvedValueOnce({ count: 1 } as never);

    await inventoryProjectionRepository.recordFailure({
      outboxId: 'row-1',
      claimToken: 'token-a',
      attempts: 3,
      nextStatus: 'stuck',
      lastError: 'db timeout',
      nextAttemptAt: null,
    });

    expect(prisma.inventoryProjectionOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'row-1', status: 'processing', claimToken: 'token-a' },
      data: { attempts: 3, lastError: 'db timeout', status: 'stuck', nextAttemptAt: null, claimToken: null, lockedAt: null },
    });
  });

  it('a mismatched claimToken scopes the update to 0 rows — only the correct token can mark stuck/retry', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mockResolvedValueOnce({ count: 0 } as never);

    await inventoryProjectionRepository.recordFailure({
      outboxId: 'row-1',
      claimToken: 'wrong-token',
      attempts: 1,
      nextStatus: 'pending',
      lastError: 'db timeout',
      nextAttemptAt: new Date(),
    });

    const call = firstOf(firstOf(vi.mocked(prisma.inventoryProjectionOutbox.updateMany).mock.calls));
    expect(call.where).toEqual({ id: 'row-1', status: 'processing', claimToken: 'wrong-token' });
  });
});

describe('inventoryProjectionRepository — deferred retry eligibility', () => {
  it('does not include a freshly deferred row (nextAttemptAt in the future) in the claimable window', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.findMany).mockResolvedValueOnce([] as never);

    await inventoryProjectionRepository.claimBatch(10, 300_000);

    const readCall = nonNull(firstOf(firstOf(vi.mocked(prisma.inventoryProjectionOutbox.findMany).mock.calls)));
    const readWhere = readCall.where as { OR: Array<{ status?: { in: string[] }; OR?: Array<{ nextAttemptAt?: unknown }> }> };
    const deferredBranch = readWhere.OR.find((clause) => clause.status?.in?.includes('deferred'));
    expect(deferredBranch?.OR).toEqual([{ nextAttemptAt: null }, { nextAttemptAt: { lte: expect.any(Date) } }]);
  });
});
