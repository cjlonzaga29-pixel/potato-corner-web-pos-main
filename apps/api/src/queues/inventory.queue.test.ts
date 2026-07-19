import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { SaleDeductionJobData } from './inventory.queue.js';

/**
 * Phase 21: BullMQ removed — processSaleDeduction now runs directly
 * in-process. enqueueSaleDeduction fires it in the background (via
 * lib/job-runner.ts's runFireAndForget, retried via runWithRetry), wrapped
 * in a Postgres advisory lock keyed by transactionId (prisma.$transaction +
 * pg_advisory_xact_lock — see the design note at the top of
 * inventory.queue.ts) that replaces BullMQ's `jobId: transactionId`
 * concurrent-enqueue dedup. job-runner is mocked as a thin wrapper around
 * the real implementation (via importOriginal) so retry/fire-and-forget
 * behavior stays real while still letting us assert on call arguments.
 * Most tests below call processSaleDeduction directly — deterministic,
 * synchronous — since that's where the deduction/idempotency/cascade logic
 * under test actually lives; only the "enqueueSaleDeduction" describe block
 * exercises the advisory-lock wrapping and retry/failure wiring.
 */
vi.mock('../lib/job-runner.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../lib/job-runner.js');
  return {
    ...actual,
    runWithRetry: vi.fn(actual.runWithRetry),
    runFireAndForget: vi.fn(actual.runFireAndForget),
  };
});

vi.mock('../modules/inventory/inventory.repository.js', () => ({
  inventoryRepository: {
    findIngredientById: vi.fn(),
    appendMovement: vi.fn(),
    hasMovementForReference: vi.fn(),
    updateTransactionDeductionStatus: vi.fn(),
    runOutOfStockCascade: vi.fn(),
  },
}));

vi.mock('../modules/recipes/recipes.service.js', () => ({
  computeDeduction: vi.fn(),
}));

vi.mock('../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./notification.queue.js', () => ({
  enqueueRawNotificationJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/notify.js', () => ({
  notifyBranch: vi.fn(),
  notifySuperAdmin: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(async (callback: (tx: { $executeRaw: (...args: unknown[]) => Promise<unknown> }) => Promise<void>) =>
      callback({ $executeRaw: vi.fn().mockResolvedValue(undefined) }),
    ),
  },
}));

const { runWithRetry } = await import('../lib/job-runner.js');
const { inventoryRepository } = await import('../modules/inventory/inventory.repository.js');
const { computeDeduction } = await import('../modules/recipes/recipes.service.js');
const { enqueueRawNotificationJob } = await import('./notification.queue.js');
const { notifyBranch, notifySuperAdmin } = await import('../lib/notify.js');
const { recordAuditLog } = await import('../middleware/audit-log.js');
const { prisma } = await import('../lib/prisma.js');
const { processSaleDeduction, enqueueSaleDeduction } = await import('./inventory.queue.js');

function decimal(value: number): { toNumber(): number } {
  return { toNumber: () => value };
}

function ingredientRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ing-1',
    branchId: 'branch-1',
    lowStockThreshold: decimal(10),
    criticalThreshold: decimal(5),
    ...overrides,
  };
}

function movementRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'mov-1',
    quantityChange: decimal(-3),
    quantityAfter: decimal(50),
    ...overrides,
  };
}

function deductionLine(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ingredient_id: 'ing-1',
    ingredient_name: 'Potato',
    quantity: 3,
    unit: 'kg',
    source: 'master_base',
    ...overrides,
  };
}

let warnSpy: MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(inventoryRepository.hasMovementForReference).mockResolvedValue(false);
  vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow() as never);
  vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow() as never);
  vi.mocked(inventoryRepository.runOutOfStockCascade).mockResolvedValue({ affectedFlavors: [], affectedProducts: [] });
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('processSaleDeduction — happy path', () => {
  it('deducts every item, appending one InventoryMovement per ingredient, and marks the transaction completed', async () => {
    vi.mocked(computeDeduction)
      .mockResolvedValueOnce([deductionLine({ ingredient_id: 'ing-1', quantity: 2 })] as never)
      .mockResolvedValueOnce([deductionLine({ ingredient_id: 'ing-2', quantity: 4 })] as never);
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow() as never);

    const job: SaleDeductionJobData = {
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [
        { productVariantId: 'variant-1', flavorId: null, quantity: 1 },
        { productVariantId: 'variant-2', flavorId: null, quantity: 1 },
      ],
    };

    await expect(processSaleDeduction(job)).resolves.toBeUndefined();

    expect(inventoryRepository.appendMovement).toHaveBeenCalledTimes(2);
    expect(inventoryRepository.appendMovement).toHaveBeenCalledWith(
      expect.objectContaining({ ingredientId: 'ing-1', movementType: 'sale_deduction', quantityChange: -2, referenceId: 'txn-1' }),
    );
    expect(inventoryRepository.appendMovement).toHaveBeenCalledWith(
      expect.objectContaining({ ingredientId: 'ing-2', movementType: 'sale_deduction', quantityChange: -4, referenceId: 'txn-1' }),
    );
    expect(inventoryRepository.updateTransactionDeductionStatus).toHaveBeenCalledWith('txn-1', 'completed');
  });

  it('aggregates two items that share an ingredient into a single movement', async () => {
    vi.mocked(computeDeduction)
      .mockResolvedValueOnce([deductionLine({ ingredient_id: 'ing-1', quantity: 2 })] as never)
      .mockResolvedValueOnce([deductionLine({ ingredient_id: 'ing-1', quantity: 5 })] as never);

    const job: SaleDeductionJobData = {
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [
        { productVariantId: 'variant-1', flavorId: null, quantity: 1 },
        { productVariantId: 'variant-2', flavorId: null, quantity: 1 },
      ],
    };

    await processSaleDeduction(job);

    expect(inventoryRepository.appendMovement).toHaveBeenCalledOnce();
    expect(inventoryRepository.appendMovement).toHaveBeenCalledWith(expect.objectContaining({ ingredientId: 'ing-1', quantityChange: -7 }));
  });
});

describe('processSaleDeduction — recipe precedence', () => {
  it('passes branchId through to computeDeduction (the BranchRecipeOverride-first-then-master resolver) and deducts whatever quantity it resolves', async () => {
    vi.mocked(computeDeduction).mockResolvedValueOnce([deductionLine({ ingredient_id: 'ing-1', quantity: 9, source: 'branch_base' })] as never);

    const job: SaleDeductionJobData = {
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    };

    await processSaleDeduction(job);

    expect(computeDeduction).toHaveBeenCalledWith(expect.objectContaining({ productVariantId: 'variant-1', branchId: 'branch-1' }));
    // The worker doesn't re-derive override-vs-master itself (that
    // algorithm and its precedence tests live in recipes.service.test.ts) —
    // its own responsibility is to faithfully use whatever line
    // computeDeduction resolves, override or not.
    expect(inventoryRepository.appendMovement).toHaveBeenCalledWith(expect.objectContaining({ ingredientId: 'ing-1', quantityChange: -9 }));
  });
});

describe('processSaleDeduction — low-stock trigger', () => {
  it('enqueues a low-stock alert when post-deduction stock falls to or below the threshold', async () => {
    vi.mocked(computeDeduction).mockResolvedValueOnce([deductionLine({ quantity: 45 })] as never);
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(
      ingredientRow({ lowStockThreshold: decimal(10), criticalThreshold: decimal(5) }) as never,
    );
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ quantityAfter: decimal(8) }) as never);

    const job: SaleDeductionJobData = {
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    };

    await processSaleDeduction(job);

    expect(enqueueRawNotificationJob).toHaveBeenCalledWith(
      'low_stock_alert',
      expect.objectContaining({ branchId: 'branch-1', ingredientId: 'ing-1', currentStock: 8, severity: 'low' }),
    );
  });

  it('does not enqueue an alert when post-deduction stock stays above the threshold', async () => {
    vi.mocked(computeDeduction).mockResolvedValueOnce([deductionLine({ quantity: 1 })] as never);
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(
      ingredientRow({ lowStockThreshold: decimal(10), criticalThreshold: decimal(5) }) as never,
    );
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ quantityAfter: decimal(50) }) as never);

    const job: SaleDeductionJobData = {
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    };

    await processSaleDeduction(job);

    expect(enqueueRawNotificationJob).not.toHaveBeenCalled();
  });
});

describe('processSaleDeduction — idempotency', () => {
  it('skips an ingredient that already has a movement recorded for this transactionId, but still processes the rest', async () => {
    vi.mocked(computeDeduction)
      .mockResolvedValueOnce([deductionLine({ ingredient_id: 'ing-1', quantity: 2 })] as never)
      .mockResolvedValueOnce([deductionLine({ ingredient_id: 'ing-2', quantity: 4 })] as never);
    vi.mocked(inventoryRepository.hasMovementForReference).mockImplementation(async (ingredientId) => ingredientId === 'ing-1');

    const job: SaleDeductionJobData = {
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [
        { productVariantId: 'variant-1', flavorId: null, quantity: 1 },
        { productVariantId: 'variant-2', flavorId: null, quantity: 1 },
      ],
    };

    await processSaleDeduction(job);

    expect(inventoryRepository.appendMovement).toHaveBeenCalledOnce();
    expect(inventoryRepository.appendMovement).toHaveBeenCalledWith(expect.objectContaining({ ingredientId: 'ing-2' }));
    // Still completes and marks the transaction done — a fully-idempotent
    // retry (every ingredient already recorded) must not get stuck pending.
    expect(inventoryRepository.updateTransactionDeductionStatus).toHaveBeenCalledWith('txn-1', 'completed');
  });
});

describe('processSaleDeduction — missing recipe', () => {
  it('logs a warning and skips the item instead of throwing when no recipe resolves any deduction lines', async () => {
    vi.mocked(computeDeduction).mockResolvedValueOnce([] as never);

    const job: SaleDeductionJobData = {
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-no-recipe', flavorId: null, quantity: 1 }],
    };

    await expect(processSaleDeduction(job)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('variant-no-recipe'));
    expect(inventoryRepository.appendMovement).not.toHaveBeenCalled();
    expect(inventoryRepository.updateTransactionDeductionStatus).toHaveBeenCalledWith('txn-1', 'completed');
  });
});

describe('processSaleDeduction — Out-of-Stock Cascade', () => {
  it('runs the cascade when post-deduction stock reaches exactly zero', async () => {
    vi.mocked(computeDeduction).mockResolvedValueOnce([deductionLine({ quantity: 50 })] as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ quantityAfter: decimal(0) }) as never);
    vi.mocked(inventoryRepository.runOutOfStockCascade).mockResolvedValue({
      affectedFlavors: [{ flavorId: 'flavor-1', flavorName: 'Sour Cream' }],
      affectedProducts: [{ productId: 'product-1', productName: 'Potato Corner Fries' }],
    });

    const job: SaleDeductionJobData = {
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    };

    await processSaleDeduction(job);

    expect(inventoryRepository.runOutOfStockCascade).toHaveBeenCalledWith('branch-1', 'ing-1');
  });

  it('broadcasts INVENTORY_PRODUCT_UNAVAILABLE to the branch room and Super Admin when the cascade affects flavors or products', async () => {
    vi.mocked(computeDeduction).mockResolvedValueOnce([deductionLine({ quantity: 50 })] as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ quantityAfter: decimal(0) }) as never);
    vi.mocked(inventoryRepository.runOutOfStockCascade).mockResolvedValue({
      affectedFlavors: [{ flavorId: 'flavor-1', flavorName: 'Sour Cream' }],
      affectedProducts: [{ productId: 'product-1', productName: 'Potato Corner Fries' }],
    });

    const job: SaleDeductionJobData = {
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    };

    await processSaleDeduction(job);

    const expectedPayload = {
      branchId: 'branch-1',
      triggeredByIngredientId: 'ing-1',
      triggeredByIngredientName: 'Potato',
      affectedFlavors: [{ flavorId: 'flavor-1', name: 'Sour Cream' }],
      affectedProducts: [{ productId: 'product-1', name: 'Potato Corner Fries' }],
    };
    expect(notifyBranch).toHaveBeenCalledWith('branch-1', 'inventory:product_unavailable', expectedPayload);
    expect(notifySuperAdmin).toHaveBeenCalledWith('inventory:product_unavailable', expectedPayload);
    expect(enqueueRawNotificationJob).toHaveBeenCalledWith('inventory_product_unavailable', expectedPayload);
  });

  it('does not broadcast when the cascade affects nothing (idempotent retry)', async () => {
    vi.mocked(computeDeduction).mockResolvedValueOnce([deductionLine({ quantity: 50 })] as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ quantityAfter: decimal(0) }) as never);
    vi.mocked(inventoryRepository.runOutOfStockCascade).mockResolvedValue({ affectedFlavors: [], affectedProducts: [] });

    const job: SaleDeductionJobData = {
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    };

    await processSaleDeduction(job);

    expect(notifyBranch).not.toHaveBeenCalledWith(expect.anything(), 'inventory:product_unavailable', expect.anything());
    expect(notifySuperAdmin).not.toHaveBeenCalledWith('inventory:product_unavailable', expect.anything());
  });

  it('does not run the cascade when stock is low but not zero', async () => {
    vi.mocked(computeDeduction).mockResolvedValueOnce([deductionLine({ quantity: 42 })] as never);
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(
      ingredientRow({ lowStockThreshold: decimal(10), criticalThreshold: decimal(5) }) as never,
    );
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ quantityAfter: decimal(8) }) as never);

    const job: SaleDeductionJobData = {
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    };

    await processSaleDeduction(job);

    expect(inventoryRepository.runOutOfStockCascade).not.toHaveBeenCalled();
    // The existing low-stock alert still fires — the cascade is additive, not a replacement.
    expect(enqueueRawNotificationJob).toHaveBeenCalledWith('low_stock_alert', expect.objectContaining({ severity: 'low' }));
  });
});

describe('enqueueSaleDeduction', () => {
  const job: SaleDeductionJobData = {
    transactionId: 'txn-1',
    branchId: 'branch-1',
    items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
  };

  it('serializes the run inside a Postgres advisory lock (pg_advisory_xact_lock) keyed by transactionId, then processes the deduction, under the Decision 7 retry policy', async () => {
    vi.mocked(computeDeduction).mockResolvedValue([deductionLine({ ingredient_id: 'ing-1', quantity: 2 })] as never);

    await enqueueSaleDeduction(job);
    await vi.waitFor(() => expect(inventoryRepository.appendMovement).toHaveBeenCalled());

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(runWithRetry).toHaveBeenCalledWith(expect.any(Function), [10_000, 60_000, 300_000]);
    expect(inventoryRepository.updateTransactionDeductionStatus).toHaveBeenCalledWith('txn-1', 'completed');
  });

  it('marks the transaction deduction failed, audit-logs it, and notifies Super Admins only after every retry attempt is exhausted', async () => {
    vi.useFakeTimers();
    vi.mocked(computeDeduction).mockRejectedValue(new Error('recipe lookup failed'));

    await enqueueSaleDeduction(job);
    await vi.advanceTimersByTimeAsync(10_000 + 60_000 + 300_000);
    await vi.waitFor(() => expect(inventoryRepository.updateTransactionDeductionStatus).toHaveBeenCalled());

    expect(computeDeduction).toHaveBeenCalledTimes(3);
    expect(inventoryRepository.updateTransactionDeductionStatus).toHaveBeenCalledWith('txn-1', 'failed');
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'INVENTORY_SALE_DEDUCTION_FAILED',
        entityType: 'transaction',
        entityId: 'txn-1',
        branchId: 'branch-1',
        afterState: expect.objectContaining({ transaction_id: 'txn-1', attempts: 3 }),
      }),
    );
    expect(enqueueRawNotificationJob).toHaveBeenCalledWith(
      'inventory_deduction_failed',
      expect.objectContaining({ transactionId: 'txn-1', branchId: 'branch-1' }),
    );
  });
});
