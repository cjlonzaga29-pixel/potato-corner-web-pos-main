import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('./inventory.repository.js', () => ({
  inventoryRepository: {
    findAllIngredients: vi.fn(),
    findIngredientById: vi.fn(),
    findIngredientByBranchAndName: vi.fn(),
    createIngredient: vi.fn(),
    updateIngredient: vi.fn(),
    softDeleteIngredient: vi.fn(),
    getCurrentStock: vi.fn(),
    getCurrentStockMap: vi.fn(),
    appendMovement: vi.fn(),
    transferStock: vi.fn(),
    findMovements: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../queues/notification.queue.js', () => ({
  enqueueRawNotificationJob: vi.fn().mockResolvedValue(undefined),
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));

const { inventoryRepository } = await import('./inventory.repository.js');
const { enqueueRawNotificationJob, enqueueNotification } = await import('../../queues/notification.queue.js');
const { inventoryService } = await import('./inventory.service.js');

const ACTOR = { id: 'user-1', role: 'supervisor' };

function decimal(value: number): { toNumber(): number } {
  return { toNumber: () => value };
}

function ingredientRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ing-1',
    branchId: 'branch-1',
    name: 'Potato',
    unit: 'kg',
    lowStockThreshold: decimal(10),
    criticalThreshold: decimal(5),
    unitCost: decimal(20),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function movementRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'mov-1',
    branchId: 'branch-1',
    ingredientId: 'ing-1',
    ingredient: { name: 'Potato' },
    movementType: 'stock_in',
    quantityChange: decimal(10),
    quantityBefore: decimal(0),
    quantityAfter: decimal(10),
    referenceId: null,
    notes: null,
    imageProofUrl: null,
    imageProofType: null,
    approvedBy: null,
    recordedBy: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('inventoryService.createIngredient', () => {
  it('rejects a duplicate (branch, name) with 409, not an uncaught 500', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.0.0' });
    vi.mocked(inventoryRepository.createIngredient).mockRejectedValue(p2002);

    await expect(
      inventoryService.createIngredient(
        { branch_id: 'branch-1', name: 'Potato', unit: 'kg', current_stock: 0, low_stock_threshold: 10, critical_threshold: 5 },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'INGREDIENT_NAME_TAKEN', statusCode: 409 });
  });

  it('re-throws any other repository error unchanged', async () => {
    const otherError = new Error('connection lost');
    vi.mocked(inventoryRepository.createIngredient).mockRejectedValue(otherError);

    await expect(
      inventoryService.createIngredient(
        { branch_id: 'branch-1', name: 'Potato', unit: 'kg', current_stock: 0, low_stock_threshold: 10, critical_threshold: 5 },
        ACTOR,
        null,
      ),
    ).rejects.toBe(otherError);
  });

  it('routes a positive initial current_stock through appendMovement as a STOCK_IN, not a stored field write', async () => {
    vi.mocked(inventoryRepository.createIngredient).mockResolvedValue(ingredientRow() as never);
    vi.mocked(inventoryRepository.getCurrentStock).mockResolvedValue(decimal(50) as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow() as never);

    await inventoryService.createIngredient(
      { branch_id: 'branch-1', name: 'Potato', unit: 'kg', current_stock: 50, low_stock_threshold: 10, critical_threshold: 5 },
      ACTOR,
      null,
    );

    expect(inventoryRepository.appendMovement).toHaveBeenCalledWith(
      expect.objectContaining({ movementType: 'stock_in', quantityChange: 50 }),
    );
  });

  it('does not append a movement when initial current_stock is zero', async () => {
    vi.mocked(inventoryRepository.createIngredient).mockResolvedValue(ingredientRow() as never);
    vi.mocked(inventoryRepository.getCurrentStock).mockResolvedValue(decimal(0) as never);

    await inventoryService.createIngredient(
      { branch_id: 'branch-1', name: 'Potato', unit: 'kg', current_stock: 0, low_stock_threshold: 10, critical_threshold: 5 },
      ACTOR,
      null,
    );

    expect(inventoryRepository.appendMovement).not.toHaveBeenCalled();
  });
});

describe('inventoryService.updateIngredient', () => {
  it('throws 404 when the ingredient does not exist', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(null);

    await expect(inventoryService.updateIngredient('missing', { name: 'x' }, ACTOR, null)).rejects.toMatchObject({
      code: 'INGREDIENT_NOT_FOUND',
      statusCode: 404,
    });
    expect(inventoryRepository.updateIngredient).not.toHaveBeenCalled();
  });

  it('updates fields via repository.updateIngredient and never touches the stock ledger', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow() as never);
    vi.mocked(inventoryRepository.updateIngredient).mockResolvedValue(ingredientRow({ name: 'Potato (Russet)' }) as never);
    vi.mocked(inventoryRepository.getCurrentStock).mockResolvedValue(decimal(20) as never);

    const result = await inventoryService.updateIngredient('ing-1', { name: 'Potato (Russet)' }, ACTOR, null);

    expect(result.name).toBe('Potato (Russet)');
    expect(inventoryRepository.appendMovement).not.toHaveBeenCalled();
  });
});

describe('inventoryService.deleteIngredient', () => {
  it('soft-deletes via repository.softDeleteIngredient, never a hard delete', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow() as never);

    await inventoryService.deleteIngredient('ing-1', ACTOR, null);

    expect(inventoryRepository.softDeleteIngredient).toHaveBeenCalledWith('ing-1');
  });

  it('throws 404 when the ingredient does not exist', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(null);

    await expect(inventoryService.deleteIngredient('missing', ACTOR, null)).rejects.toMatchObject({
      code: 'INGREDIENT_NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('inventoryService.stockIn', () => {
  it('creates a STOCK_IN movement with a positive quantityChange', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow() as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ movementType: 'stock_in', quantityChange: decimal(30) }) as never);

    await inventoryService.stockIn('ing-1', { quantity: 30 }, ACTOR, null);

    expect(inventoryRepository.appendMovement).toHaveBeenCalledWith(
      expect.objectContaining({ movementType: 'stock_in', quantityChange: 30 }),
    );
  });

  it('enqueues a low_stock_alert when the resulting stock is at or below the low threshold', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow({ lowStockThreshold: decimal(10), criticalThreshold: decimal(5) }) as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ quantityAfter: decimal(8) }) as never);

    await inventoryService.stockIn('ing-1', { quantity: 30 }, ACTOR, null);

    expect(enqueueRawNotificationJob).toHaveBeenCalledWith(
      'low_stock_alert',
      expect.objectContaining({ branchId: 'branch-1', ingredientId: 'ing-1', currentStock: 8, severity: 'low' }),
    );
  });

  it('does not enqueue a low_stock_alert when the resulting stock is above the low threshold', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow({ lowStockThreshold: decimal(10), criticalThreshold: decimal(5) }) as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ quantityAfter: decimal(40) }) as never);

    await inventoryService.stockIn('ing-1', { quantity: 30 }, ACTOR, null);

    expect(enqueueRawNotificationJob).not.toHaveBeenCalled();
  });
});

describe('inventoryService.adjustIngredient', () => {
  it('accepts a positive quantity_delta and includes the reason in the movement notes', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow() as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ movementType: 'manual_adjustment' }) as never);

    await inventoryService.adjustIngredient('ing-1', { quantity_delta: 5, reason_code: 'count_correction' }, ACTOR, null);

    expect(inventoryRepository.appendMovement).toHaveBeenCalledWith(
      expect.objectContaining({ movementType: 'manual_adjustment', quantityChange: 5, notes: expect.stringContaining('count_correction') }),
    );
  });

  it('accepts a negative quantity_delta when it does not take stock below zero', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow() as never);
    vi.mocked(inventoryRepository.getCurrentStock).mockResolvedValue(decimal(10) as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ movementType: 'manual_adjustment' }) as never);

    await inventoryService.adjustIngredient('ing-1', { quantity_delta: -4, reason_code: 'damaged' }, ACTOR, null);

    expect(inventoryRepository.appendMovement).toHaveBeenCalledWith(
      expect.objectContaining({ movementType: 'manual_adjustment', quantityChange: -4 }),
    );
  });

  it('rejects a negative quantity_delta that would take stock below zero — 409', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow() as never);
    vi.mocked(inventoryRepository.getCurrentStock).mockResolvedValue(decimal(3) as never);

    await expect(inventoryService.adjustIngredient('ing-1', { quantity_delta: -4, reason_code: 'damaged' }, ACTOR, null)).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      statusCode: 409,
    });
    expect(inventoryRepository.appendMovement).not.toHaveBeenCalled();
  });

  // reason_code presence is enforced by adjustIngredientSchema at the router's
  // validate() layer (see inventory.router.test.ts), not re-validated here —
  // the service trusts its input has already passed that schema, matching
  // every other module's service/router division in this codebase.

  it('enqueues large_adjustment_approval_needed when |quantity_delta| * unitCost meets the ₱5,000 threshold', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow({ unitCost: decimal(20) }) as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ id: 'mov-9', movementType: 'manual_adjustment' }) as never);

    await inventoryService.adjustIngredient('ing-1', { quantity_delta: 300, reason_code: 'count_correction' }, ACTOR, null);

    expect(enqueueNotification).toHaveBeenCalledWith('large_adjustment_approval_needed', {
      type: 'large_adjustment_approval_needed',
      branchId: 'branch-1',
      adjustmentId: 'mov-9',
      requestedByUserId: 'user-1',
      amount: 6000,
    });
  });

  it('uses the absolute value of a negative quantity_delta when computing the adjustment amount', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow({ unitCost: decimal(20) }) as never);
    vi.mocked(inventoryRepository.getCurrentStock).mockResolvedValue(decimal(1000) as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ movementType: 'manual_adjustment' }) as never);

    await inventoryService.adjustIngredient('ing-1', { quantity_delta: -300, reason_code: 'damaged' }, ACTOR, null);

    expect(enqueueNotification).toHaveBeenCalledWith('large_adjustment_approval_needed', expect.objectContaining({ amount: 6000 }));
  });

  it('does not enqueue large_adjustment_approval_needed when the adjustment amount is below the threshold', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow({ unitCost: decimal(20) }) as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ movementType: 'manual_adjustment' }) as never);

    await inventoryService.adjustIngredient('ing-1', { quantity_delta: 5, reason_code: 'count_correction' }, ACTOR, null);

    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('does not enqueue large_adjustment_approval_needed when the ingredient has no recorded unitCost', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow({ unitCost: null }) as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ movementType: 'manual_adjustment' }) as never);

    await inventoryService.adjustIngredient('ing-1', { quantity_delta: 1000, reason_code: 'count_correction' }, ACTOR, null);

    expect(enqueueNotification).not.toHaveBeenCalled();
  });
});

describe('inventoryService.wasteIngredient', () => {
  it('stores quantityChange as negative and movementType WASTE', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow() as never);
    vi.mocked(inventoryRepository.getCurrentStock).mockResolvedValue(decimal(20) as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ movementType: 'waste' }) as never);

    await inventoryService.wasteIngredient('ing-1', { quantity: 6, reason_code: 'spoilage' }, ACTOR, null);

    expect(inventoryRepository.appendMovement).toHaveBeenCalledWith(
      expect.objectContaining({ movementType: 'waste', quantityChange: -6 }),
    );
  });

  it('rejects a waste quantity exceeding current stock — 409', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow() as never);
    vi.mocked(inventoryRepository.getCurrentStock).mockResolvedValue(decimal(5) as never);

    await expect(inventoryService.wasteIngredient('ing-1', { quantity: 6, reason_code: 'spoilage' }, ACTOR, null)).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      statusCode: 409,
    });
  });
});

describe('inventoryService.submitPhysicalCount', () => {
  it('computes variance as counted_quantity - currentStock and appends a PHYSICAL_COUNT movement for a nonzero variance', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow() as never);
    vi.mocked(inventoryRepository.getCurrentStock).mockResolvedValue(decimal(40) as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ movementType: 'physical_count' }) as never);

    const result = await inventoryService.submitPhysicalCount(
      'branch-1',
      { branch_id: 'branch-1', started_at: new Date().toISOString(), counts: [{ ingredient_id: 'ing-1', counted_quantity: 35 }] },
      ACTOR,
      null,
    );

    expect(result.results[0]).toMatchObject({ ingredient_id: 'ing-1', counted_quantity: 35, previous_quantity: 40, variance: -5 });
    expect(inventoryRepository.appendMovement).toHaveBeenCalledWith(
      expect.objectContaining({ movementType: 'physical_count', quantityChange: -5 }),
    );
  });

  it('does not append a movement when the count matches current stock exactly (variance zero)', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow() as never);
    vi.mocked(inventoryRepository.getCurrentStock).mockResolvedValue(decimal(40) as never);

    const result = await inventoryService.submitPhysicalCount(
      'branch-1',
      { branch_id: 'branch-1', started_at: new Date().toISOString(), counts: [{ ingredient_id: 'ing-1', counted_quantity: 40 }] },
      ACTOR,
      null,
    );

    expect(result.results[0]?.variance).toBe(0);
    expect(inventoryRepository.appendMovement).not.toHaveBeenCalled();
  });

  it('throws 404 when a counted ingredient does not belong to the branch', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow({ branchId: 'other-branch' }) as never);

    await expect(
      inventoryService.submitPhysicalCount(
        'branch-1',
        { branch_id: 'branch-1', started_at: new Date().toISOString(), counts: [{ ingredient_id: 'ing-1', counted_quantity: 10 }] },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'INGREDIENT_NOT_FOUND', statusCode: 404 });
  });
});

describe('inventoryService.transferStock', () => {
  it('rejects a transfer where the destination equals the source branch — 422', async () => {
    await expect(
      inventoryService.transferStock('branch-1', { ingredient_id: 'ing-1', to_branch_id: 'branch-1', quantity: 5 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSFER', statusCode: 422 });
    expect(inventoryRepository.findIngredientById).not.toHaveBeenCalled();
  });

  it('appends TRANSFER_OUT (negative) on the source and TRANSFER_IN (positive) on the destination via one repository call', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow({ id: 'ing-1', branchId: 'branch-1' }) as never);
    vi.mocked(inventoryRepository.findIngredientByBranchAndName).mockResolvedValue(ingredientRow({ id: 'ing-2', branchId: 'branch-2' }) as never);
    vi.mocked(inventoryRepository.getCurrentStock).mockResolvedValue(decimal(50) as never);
    vi.mocked(inventoryRepository.transferStock).mockResolvedValue({
      transferOut: movementRow({ id: 'mov-out', movementType: 'transfer_out', quantityChange: decimal(-10) }),
      transferIn: movementRow({ id: 'mov-in', movementType: 'transfer_in', quantityChange: decimal(10) }),
    } as never);

    await inventoryService.transferStock('branch-1', { ingredient_id: 'ing-1', to_branch_id: 'branch-2', quantity: 10 }, ACTOR, null);

    // Atomicity (both writes in a single DB transaction) is the repository's
    // responsibility and is verified directly against Prisma in
    // inventory.repository.test.ts — here, mocked, we can only confirm the
    // service calls the one atomic repository method with the right shape.
    expect(inventoryRepository.transferStock).toHaveBeenCalledWith(
      expect.objectContaining({ fromBranchId: 'branch-1', fromIngredientId: 'ing-1', toBranchId: 'branch-2', toIngredientId: 'ing-2', quantity: 10 }),
    );
  });

  it('rejects a transfer quantity exceeding current stock at the source — 409', async () => {
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(ingredientRow({ id: 'ing-1', branchId: 'branch-1' }) as never);
    vi.mocked(inventoryRepository.findIngredientByBranchAndName).mockResolvedValue(ingredientRow({ id: 'ing-2', branchId: 'branch-2' }) as never);
    vi.mocked(inventoryRepository.getCurrentStock).mockResolvedValue(decimal(5) as never);

    await expect(
      inventoryService.transferStock('branch-1', { ingredient_id: 'ing-1', to_branch_id: 'branch-2', quantity: 10 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK', statusCode: 409 });
    expect(inventoryRepository.transferStock).not.toHaveBeenCalled();
  });
});

describe('inventoryService.getBranchAlerts', () => {
  it('flags an ingredient at exactly the low_stock_threshold as low', async () => {
    vi.mocked(inventoryRepository.findAllIngredients).mockResolvedValue([
      ingredientRow({ id: 'ing-1', lowStockThreshold: decimal(10), criticalThreshold: decimal(5) }),
    ] as never);
    vi.mocked(inventoryRepository.getCurrentStockMap).mockResolvedValue(new Map([['ing-1', decimal(10)]]) as never);

    const result = await inventoryService.getBranchAlerts('branch-1');

    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatchObject({ ingredient_id: 'ing-1', severity: 'low', threshold: 10 });
  });

  it('does not flag an ingredient one unit above the low_stock_threshold', async () => {
    vi.mocked(inventoryRepository.findAllIngredients).mockResolvedValue([
      ingredientRow({ id: 'ing-1', lowStockThreshold: decimal(10), criticalThreshold: decimal(5) }),
    ] as never);
    vi.mocked(inventoryRepository.getCurrentStockMap).mockResolvedValue(new Map([['ing-1', decimal(11)]]) as never);

    const result = await inventoryService.getBranchAlerts('branch-1');

    expect(result.alerts).toHaveLength(0);
  });

  it('flags an ingredient at or below the critical_threshold as critical, not low', async () => {
    vi.mocked(inventoryRepository.findAllIngredients).mockResolvedValue([
      ingredientRow({ id: 'ing-1', lowStockThreshold: decimal(10), criticalThreshold: decimal(5) }),
    ] as never);
    vi.mocked(inventoryRepository.getCurrentStockMap).mockResolvedValue(new Map([['ing-1', decimal(5)]]) as never);

    const result = await inventoryService.getBranchAlerts('branch-1');

    expect(result.alerts[0]).toMatchObject({ severity: 'critical', threshold: 5 });
  });

  it('treats an ingredient with zero recorded movements as zero stock, not excluded from alerting', async () => {
    vi.mocked(inventoryRepository.findAllIngredients).mockResolvedValue([
      ingredientRow({ id: 'ing-1', lowStockThreshold: decimal(10), criticalThreshold: decimal(5) }),
    ] as never);
    vi.mocked(inventoryRepository.getCurrentStockMap).mockResolvedValue(new Map() as never);

    const result = await inventoryService.getBranchAlerts('branch-1');

    expect(result.alerts[0]).toMatchObject({ current_stock: 0, severity: 'critical' });
  });
});
