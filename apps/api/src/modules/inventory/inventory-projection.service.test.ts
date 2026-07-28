import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('./inventory-projection.repository.js', () => ({
  inventoryProjectionRepository: {
    claimBatch: vi.fn(),
    findAcceptedMapping: vi.fn(),
    deferRow: vi.fn(),
    applyProjection: vi.fn(),
    recordFailure: vi.fn(),
  },
}));

const { inventoryProjectionRepository } = await import('./inventory-projection.repository.js');
const { inventoryProjectionService } = await import('./inventory-projection.service.js');
const { PROJECTION_MAX_ATTEMPTS, PROJECTION_RETRY_DELAYS_MS } = await import('./inventory-projection.types.js');

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

function outboxRow(overrides: Partial<{ id: string; attempts: number; claimToken: string | null; movement: Record<string, unknown> }> = {}) {
  return {
    id: 'outbox-1',
    movementId: 'mv-1',
    attempts: 0,
    status: 'processing',
    claimToken: 'token-1',
    movement: {
      id: 'mv-1',
      branchId: 'branch-1',
      ingredientId: 'ing-1',
      quantityChange: decimal(-5),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides.movement,
    },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('inventoryProjectionService.runCycle — successful projection', () => {
  it('projects a claimed row with an accepted mapping and counts it as processed', async () => {
    const row = outboxRow();
    vi.mocked(inventoryProjectionRepository.claimBatch).mockResolvedValueOnce([row]);
    vi.mocked(inventoryProjectionRepository.findAcceptedMapping).mockResolvedValueOnce({ inventoryItemId: 'item-1', mappingStatus: 'AUTO_MATCHED' } as never);
    vi.mocked(inventoryProjectionRepository.applyProjection).mockResolvedValueOnce(true);

    const result = await inventoryProjectionService.runCycle(10);

    expect(inventoryProjectionRepository.applyProjection).toHaveBeenCalledWith({
      outboxId: 'outbox-1',
      claimToken: 'token-1',
      branchId: 'branch-1',
      inventoryItemId: 'item-1',
      quantityChange: decimal(-5),
      movementCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(result).toEqual({ claimed: 1, processed: 1, deferred: 0, retried: 0, stuck: 0 });
  });

  it('passes a positive quantityChange through unchanged (stock-in movements)', async () => {
    const row = outboxRow({ movement: { quantityChange: decimal(12) } });
    vi.mocked(inventoryProjectionRepository.claimBatch).mockResolvedValueOnce([row]);
    vi.mocked(inventoryProjectionRepository.findAcceptedMapping).mockResolvedValueOnce({ inventoryItemId: 'item-1', mappingStatus: 'MANUALLY_MATCHED' } as never);
    vi.mocked(inventoryProjectionRepository.applyProjection).mockResolvedValueOnce(true);

    await inventoryProjectionService.runCycle(10);

    expect(inventoryProjectionRepository.applyProjection).toHaveBeenCalledWith(expect.objectContaining({ quantityChange: decimal(12) }));
  });

  it('processes multiple claimed rows in the claimed (createdAt) order, sequentially', async () => {
    const rowA = outboxRow({ id: 'outbox-a' });
    const rowB = outboxRow({ id: 'outbox-b' });
    vi.mocked(inventoryProjectionRepository.claimBatch).mockResolvedValueOnce([rowA, rowB]);
    vi.mocked(inventoryProjectionRepository.findAcceptedMapping).mockResolvedValue({ inventoryItemId: 'item-1', mappingStatus: 'AUTO_MATCHED' } as never);
    vi.mocked(inventoryProjectionRepository.applyProjection).mockResolvedValue(true);

    await inventoryProjectionService.runCycle(10);

    const callOrder = vi.mocked(inventoryProjectionRepository.applyProjection).mock.calls.map((c) => c[0].outboxId);
    expect(callOrder).toEqual(['outbox-a', 'outbox-b']);
  });
});

describe('inventoryProjectionService.runCycle — missing/unresolved mapping', () => {
  it('defers the row and does not apply a projection when no mapping exists', async () => {
    const row = outboxRow();
    vi.mocked(inventoryProjectionRepository.claimBatch).mockResolvedValueOnce([row]);
    vi.mocked(inventoryProjectionRepository.findAcceptedMapping).mockResolvedValueOnce(null);

    const result = await inventoryProjectionService.runCycle(10);

    expect(inventoryProjectionRepository.deferRow).toHaveBeenCalledWith('outbox-1', 'token-1');
    expect(inventoryProjectionRepository.applyProjection).not.toHaveBeenCalled();
    expect(inventoryProjectionRepository.recordFailure).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: 1, processed: 0, deferred: 1, retried: 0, stuck: 0 });
  });

  it('never defers/finalizes using another row\'s claim token when processing multiple claimed rows', async () => {
    const rowA = outboxRow({ id: 'outbox-a', claimToken: 'token-a' });
    const rowB = outboxRow({ id: 'outbox-b', claimToken: 'token-b' });
    vi.mocked(inventoryProjectionRepository.claimBatch).mockResolvedValueOnce([rowA, rowB]);
    vi.mocked(inventoryProjectionRepository.findAcceptedMapping).mockResolvedValue(null);

    await inventoryProjectionService.runCycle(10);

    expect(inventoryProjectionRepository.deferRow).toHaveBeenCalledWith('outbox-a', 'token-a');
    expect(inventoryProjectionRepository.deferRow).toHaveBeenCalledWith('outbox-b', 'token-b');
  });
});

describe('inventoryProjectionService.runCycle — processing errors', () => {
  it('records a retry with bounded backoff and increments attempts on a real failure below the max', async () => {
    const row = outboxRow({ attempts: 0 });
    vi.mocked(inventoryProjectionRepository.claimBatch).mockResolvedValueOnce([row]);
    vi.mocked(inventoryProjectionRepository.findAcceptedMapping).mockResolvedValueOnce({ inventoryItemId: 'item-1', mappingStatus: 'AUTO_MATCHED' } as never);
    vi.mocked(inventoryProjectionRepository.applyProjection).mockRejectedValueOnce(new Error('db timeout'));

    const result = await inventoryProjectionService.runCycle(10);

    expect(inventoryProjectionRepository.recordFailure).toHaveBeenCalledWith({
      outboxId: 'outbox-1',
      claimToken: 'token-1',
      attempts: 1,
      nextStatus: 'pending',
      lastError: 'db timeout',
      nextAttemptAt: expect.any(Date),
    });
    const call = firstOf(firstOf(vi.mocked(inventoryProjectionRepository.recordFailure).mock.calls));
    expect(nonNull(call.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() + firstOf(PROJECTION_RETRY_DELAYS_MS) - 1000);
    expect(result.retried).toBe(1);
  });

  it('never includes a stack trace or the full error object in lastError', async () => {
    const row = outboxRow();
    vi.mocked(inventoryProjectionRepository.claimBatch).mockResolvedValueOnce([row]);
    vi.mocked(inventoryProjectionRepository.findAcceptedMapping).mockResolvedValueOnce({ inventoryItemId: 'item-1', mappingStatus: 'AUTO_MATCHED' } as never);
    const error = new Error('boom');
    error.stack = 'Error: boom\n    at secretInternalPath (/very/sensitive/path.ts:1:1)';
    vi.mocked(inventoryProjectionRepository.applyProjection).mockRejectedValueOnce(error);

    await inventoryProjectionService.runCycle(10);

    const persisted = firstOf(firstOf(vi.mocked(inventoryProjectionRepository.recordFailure).mock.calls)).lastError;
    expect(persisted).toBe('boom');
    expect(persisted).not.toContain('secretInternalPath');
  });

  it('marks the row stuck once attempts reaches PROJECTION_MAX_ATTEMPTS', async () => {
    const row = outboxRow({ attempts: PROJECTION_MAX_ATTEMPTS - 1 });
    vi.mocked(inventoryProjectionRepository.claimBatch).mockResolvedValueOnce([row]);
    vi.mocked(inventoryProjectionRepository.findAcceptedMapping).mockResolvedValueOnce({ inventoryItemId: 'item-1', mappingStatus: 'AUTO_MATCHED' } as never);
    vi.mocked(inventoryProjectionRepository.applyProjection).mockRejectedValueOnce(new Error('still failing'));

    const result = await inventoryProjectionService.runCycle(10);

    expect(inventoryProjectionRepository.recordFailure).toHaveBeenCalledWith({
      outboxId: 'outbox-1',
      claimToken: 'token-1',
      attempts: PROJECTION_MAX_ATTEMPTS,
      nextStatus: 'stuck',
      lastError: 'still failing',
      nextAttemptAt: null,
    });
    expect(result.stuck).toBe(1);
  });
});

describe('inventoryProjectionService.runCycle — lost claim guard (processed row cannot be applied twice)', () => {
  it('counts the row as deferred and does not treat a false applyProjection result as an error', async () => {
    const row = outboxRow();
    vi.mocked(inventoryProjectionRepository.claimBatch).mockResolvedValueOnce([row]);
    vi.mocked(inventoryProjectionRepository.findAcceptedMapping).mockResolvedValueOnce({ inventoryItemId: 'item-1', mappingStatus: 'AUTO_MATCHED' } as never);
    vi.mocked(inventoryProjectionRepository.applyProjection).mockResolvedValueOnce(false);

    const result = await inventoryProjectionService.runCycle(10);

    expect(inventoryProjectionRepository.recordFailure).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: 1, processed: 0, deferred: 1, retried: 0, stuck: 0 });
  });

  it('never touches the repository (no InventoryStock write, no state transition) for a row with no claimToken', async () => {
    // Defensive: claimBatch is documented to only ever return rows it just stamped with a token, so a
    // null claimToken should be unreachable — but if it ever happened, ownership cannot be proven, so
    // nothing about that row may be written.
    const row = outboxRow({ claimToken: null });
    vi.mocked(inventoryProjectionRepository.claimBatch).mockResolvedValueOnce([row]);

    await inventoryProjectionService.runCycle(10);

    expect(inventoryProjectionRepository.findAcceptedMapping).not.toHaveBeenCalled();
    expect(inventoryProjectionRepository.deferRow).not.toHaveBeenCalled();
    expect(inventoryProjectionRepository.applyProjection).not.toHaveBeenCalled();
    expect(inventoryProjectionRepository.recordFailure).not.toHaveBeenCalled();
  });
});

describe('inventoryProjectionService.runCycle — empty batch', () => {
  it('returns all-zero counts and touches nothing else when nothing is claimed', async () => {
    vi.mocked(inventoryProjectionRepository.claimBatch).mockResolvedValueOnce([]);

    const result = await inventoryProjectionService.runCycle(10);

    expect(result).toEqual({ claimed: 0, processed: 0, deferred: 0, retried: 0, stuck: 0 });
    expect(inventoryProjectionRepository.findAcceptedMapping).not.toHaveBeenCalled();
  });
});
