import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { Job } from 'bullmq';
import type { SaleDeductionJobData } from './inventory.queue.js';

/**
 * inventory.queue.ts constructs a real BullMQ Queue and Worker at module
 * load time (top-level `new Queue(...)` / `new Worker(...)`), which would
 * otherwise require a live Redis connection just to import the file. bullmq
 * itself is mocked so those constructors are inert — this file tests
 * `processSaleDeduction` directly, never through the real Queue/Worker
 * dispatch machinery.
 */
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn() })),
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn() })),
}));

vi.mock('../lib/redis.js', () => ({
  redis: {},
  createWorkerConnection: vi.fn().mockReturnValue({ on: vi.fn() }),
}));

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
  notificationQueue: { add: vi.fn() },
}));

vi.mock('../lib/notify.js', () => ({
  notifyBranch: vi.fn(),
  notifySuperAdmin: vi.fn(),
}));

const { inventoryRepository } = await import('../modules/inventory/inventory.repository.js');
const { computeDeduction } = await import('../modules/recipes/recipes.service.js');
const { notificationQueue } = await import('./notification.queue.js');
const { notifyBranch, notifySuperAdmin } = await import('../lib/notify.js');
const { processSaleDeduction } = await import('./inventory.queue.js');

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

function fakeJob(data: SaleDeductionJobData): Job<SaleDeductionJobData> {
  return { data } as Job<SaleDeductionJobData>;
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

describe('processSaleDeduction — happy path', () => {
  it('deducts every item, appending one InventoryMovement per ingredient, and marks the transaction completed', async () => {
    vi.mocked(computeDeduction)
      .mockResolvedValueOnce([deductionLine({ ingredient_id: 'ing-1', quantity: 2 })] as never)
      .mockResolvedValueOnce([deductionLine({ ingredient_id: 'ing-2', quantity: 4 })] as never);
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow() as never);

    const job = fakeJob({
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [
        { productVariantId: 'variant-1', flavorId: null, quantity: 1 },
        { productVariantId: 'variant-2', flavorId: null, quantity: 1 },
      ],
    });

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

    const job = fakeJob({
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [
        { productVariantId: 'variant-1', flavorId: null, quantity: 1 },
        { productVariantId: 'variant-2', flavorId: null, quantity: 1 },
      ],
    });

    await processSaleDeduction(job);

    expect(inventoryRepository.appendMovement).toHaveBeenCalledOnce();
    expect(inventoryRepository.appendMovement).toHaveBeenCalledWith(expect.objectContaining({ ingredientId: 'ing-1', quantityChange: -7 }));
  });
});

describe('processSaleDeduction — recipe precedence', () => {
  it('passes branchId through to computeDeduction (the BranchRecipeOverride-first-then-master resolver) and deducts whatever quantity it resolves', async () => {
    vi.mocked(computeDeduction).mockResolvedValueOnce([
      deductionLine({ ingredient_id: 'ing-1', quantity: 9, source: 'branch_base' }),
    ] as never);

    const job = fakeJob({
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    });

    await processSaleDeduction(job);

    expect(computeDeduction).toHaveBeenCalledWith(
      expect.objectContaining({ productVariantId: 'variant-1', branchId: 'branch-1' }),
    );
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

    const job = fakeJob({
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    });

    await processSaleDeduction(job);

    expect(notificationQueue.add).toHaveBeenCalledWith(
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

    const job = fakeJob({
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    });

    await processSaleDeduction(job);

    expect(notificationQueue.add).not.toHaveBeenCalled();
  });
});

describe('processSaleDeduction — idempotency', () => {
  it('skips an ingredient that already has a movement recorded for this transactionId, but still processes the rest', async () => {
    vi.mocked(computeDeduction)
      .mockResolvedValueOnce([deductionLine({ ingredient_id: 'ing-1', quantity: 2 })] as never)
      .mockResolvedValueOnce([deductionLine({ ingredient_id: 'ing-2', quantity: 4 })] as never);
    vi.mocked(inventoryRepository.hasMovementForReference).mockImplementation(async (ingredientId) => ingredientId === 'ing-1');

    const job = fakeJob({
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [
        { productVariantId: 'variant-1', flavorId: null, quantity: 1 },
        { productVariantId: 'variant-2', flavorId: null, quantity: 1 },
      ],
    });

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

    const job = fakeJob({
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-no-recipe', flavorId: null, quantity: 1 }],
    });

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

    const job = fakeJob({
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    });

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

    const job = fakeJob({
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    });

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
    expect(notificationQueue.add).toHaveBeenCalledWith('inventory_product_unavailable', expectedPayload);
  });

  it('does not broadcast when the cascade affects nothing (idempotent retry)', async () => {
    vi.mocked(computeDeduction).mockResolvedValueOnce([deductionLine({ quantity: 50 })] as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ quantityAfter: decimal(0) }) as never);
    vi.mocked(inventoryRepository.runOutOfStockCascade).mockResolvedValue({ affectedFlavors: [], affectedProducts: [] });

    const job = fakeJob({
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    });

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

    const job = fakeJob({
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    });

    await processSaleDeduction(job);

    expect(inventoryRepository.runOutOfStockCascade).not.toHaveBeenCalled();
    // The existing low-stock alert still fires — the cascade is additive, not a replacement.
    expect(notificationQueue.add).toHaveBeenCalledWith('low_stock_alert', expect.objectContaining({ severity: 'low' }));
  });
});
