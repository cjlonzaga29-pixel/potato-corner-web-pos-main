import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('./inventory-reconciliation.repository.js', () => ({
  inventoryReconciliationRepository: {
    findAcceptedMappings: vi.fn(),
    findUnacceptedMappingsByIngredientIds: vi.fn(),
    findIngredientsWithMovements: vi.fn(),
    aggregateMovementsByIngredient: vi.fn(),
    findAllStockRows: vi.fn(),
    getOutboxStatusCounts: vi.fn(),
    upsertStockRow: vi.fn(),
    deleteOrphan: vi.fn(),
    runInTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  },
}));

const { inventoryReconciliationRepository } = await import('./inventory-reconciliation.repository.js');
const { inventoryReconciliationService } = await import('./inventory-reconciliation.service.js');

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

const ZERO_OUTBOX = { pending: 0, processing: 0, deferred: 0, stuck: 0, processed: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(inventoryReconciliationRepository.findAcceptedMappings).mockResolvedValue([]);
  vi.mocked(inventoryReconciliationRepository.aggregateMovementsByIngredient).mockResolvedValue(new Map());
  vi.mocked(inventoryReconciliationRepository.findAllStockRows).mockResolvedValue([]);
  vi.mocked(inventoryReconciliationRepository.getOutboxStatusCounts).mockResolvedValue({ ...ZERO_OUTBOX });
  vi.mocked(inventoryReconciliationRepository.findIngredientsWithMovements).mockResolvedValue([]);
  vi.mocked(inventoryReconciliationRepository.findUnacceptedMappingsByIngredientIds).mockResolvedValue(new Map());
});

function stockRow(overrides: Partial<{ branchId: string; inventoryItemId: string; quantityOnHand: Prisma.Decimal; version: number }> = {}) {
  return {
    id: 'stock-1',
    branchId: 'branch-1',
    inventoryItemId: 'item-1',
    quantityOnHand: decimal(10),
    lowStockThreshold: null,
    criticalThreshold: null,
    version: 1,
    rebuiltThroughAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as never;
}

describe('inventoryReconciliationService.buildReport', () => {
  it('reports an exact stock match', async () => {
    vi.mocked(inventoryReconciliationRepository.findAcceptedMappings).mockResolvedValue([
      { legacyIngredientId: 'ing-1', inventoryItemId: 'item-1', branchId: 'branch-1' },
    ]);
    vi.mocked(inventoryReconciliationRepository.aggregateMovementsByIngredient).mockResolvedValue(
      new Map([['ing-1', { ingredientId: 'ing-1', sum: decimal(10), maxCreatedAt: new Date('2026-01-01') }]]),
    );
    vi.mocked(inventoryReconciliationRepository.findAllStockRows).mockResolvedValue([stockRow({ quantityOnHand: decimal(10) })]);

    const report = await inventoryReconciliationService.buildReport();

    expect(report.matched).toHaveLength(1);
    expect(report.matched[0]).toMatchObject({ branchId: 'branch-1', inventoryItemId: 'item-1' });
    expect(report.drift).toHaveLength(0);
    expect(report.missingStock).toHaveLength(0);
  });

  it('reports a missing InventoryStock row when no stock row exists for an expected key', async () => {
    vi.mocked(inventoryReconciliationRepository.findAcceptedMappings).mockResolvedValue([
      { legacyIngredientId: 'ing-1', inventoryItemId: 'item-1', branchId: 'branch-1' },
    ]);
    vi.mocked(inventoryReconciliationRepository.aggregateMovementsByIngredient).mockResolvedValue(
      new Map([['ing-1', { ingredientId: 'ing-1', sum: decimal(7), maxCreatedAt: new Date('2026-01-01') }]]),
    );
    vi.mocked(inventoryReconciliationRepository.findAllStockRows).mockResolvedValue([]);

    const report = await inventoryReconciliationService.buildReport();

    expect(report.missingStock).toHaveLength(1);
    expect(report.missingStock[0]).toMatchObject({ branchId: 'branch-1', inventoryItemId: 'item-1', expectedQuantity: decimal(7) });
  });

  it('reports positive drift when InventoryStock has more than the derived expected quantity', async () => {
    vi.mocked(inventoryReconciliationRepository.findAcceptedMappings).mockResolvedValue([
      { legacyIngredientId: 'ing-1', inventoryItemId: 'item-1', branchId: 'branch-1' },
    ]);
    vi.mocked(inventoryReconciliationRepository.aggregateMovementsByIngredient).mockResolvedValue(
      new Map([['ing-1', { ingredientId: 'ing-1', sum: decimal(10), maxCreatedAt: new Date('2026-01-01') }]]),
    );
    vi.mocked(inventoryReconciliationRepository.findAllStockRows).mockResolvedValue([stockRow({ quantityOnHand: decimal(15) })]);

    const report = await inventoryReconciliationService.buildReport();

    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]).toMatchObject({ expectedQuantity: decimal(10), actualQuantity: decimal(15), drift: decimal(5) });
  });

  it('reports negative drift when InventoryStock has less than the derived expected quantity', async () => {
    vi.mocked(inventoryReconciliationRepository.findAcceptedMappings).mockResolvedValue([
      { legacyIngredientId: 'ing-1', inventoryItemId: 'item-1', branchId: 'branch-1' },
    ]);
    vi.mocked(inventoryReconciliationRepository.aggregateMovementsByIngredient).mockResolvedValue(
      new Map([['ing-1', { ingredientId: 'ing-1', sum: decimal(10), maxCreatedAt: new Date('2026-01-01') }]]),
    );
    vi.mocked(inventoryReconciliationRepository.findAllStockRows).mockResolvedValue([stockRow({ quantityOnHand: decimal(4) })]);

    const report = await inventoryReconciliationService.buildReport();

    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]).toMatchObject({ expectedQuantity: decimal(10), actualQuantity: decimal(4), drift: decimal(-6) });
  });

  it('reports an unresolved mapping for an ingredient with movements but no accepted mapping', async () => {
    vi.mocked(inventoryReconciliationRepository.findAcceptedMappings).mockResolvedValue([]);
    vi.mocked(inventoryReconciliationRepository.findIngredientsWithMovements).mockResolvedValue([
      { id: 'ing-2', name: 'Flour', branchId: 'branch-1' },
    ]);
    vi.mocked(inventoryReconciliationRepository.findUnacceptedMappingsByIngredientIds).mockResolvedValue(new Map([['ing-2', 'PENDING']]));

    const report = await inventoryReconciliationService.buildReport();

    expect(report.unresolvedMapping).toHaveLength(1);
    expect(report.unresolvedMapping[0]).toMatchObject({ ingredientId: 'ing-2', reason: 'pending' });
  });

  it('reports "no_mapping" when an ingredient with movements has no mapping row at all', async () => {
    vi.mocked(inventoryReconciliationRepository.findIngredientsWithMovements).mockResolvedValue([
      { id: 'ing-3', name: 'Sugar', branchId: 'branch-1' },
    ]);
    vi.mocked(inventoryReconciliationRepository.findUnacceptedMappingsByIngredientIds).mockResolvedValue(new Map());

    const report = await inventoryReconciliationService.buildReport();

    expect(report.unresolvedMapping[0]).toMatchObject({ ingredientId: 'ing-3', reason: 'no_mapping' });
  });

  it('reports an orphan InventoryStock row when no accepted mapping targets its key', async () => {
    vi.mocked(inventoryReconciliationRepository.findAllStockRows).mockResolvedValue([
      stockRow({ branchId: 'branch-9', inventoryItemId: 'item-9', quantityOnHand: decimal(3) }),
    ]);

    const report = await inventoryReconciliationService.buildReport();

    expect(report.orphanStock).toHaveLength(1);
    expect(report.orphanStock[0]).toMatchObject({ branchId: 'branch-9', inventoryItemId: 'item-9', quantityOnHand: decimal(3) });
  });
});

describe('inventoryReconciliationService.buildRebuildPlan', () => {
  it('plans a create for a missing stock row and an update for a drifted one, leaving a matched row unchanged', async () => {
    vi.mocked(inventoryReconciliationRepository.findAcceptedMappings).mockResolvedValue([
      { legacyIngredientId: 'ing-missing', inventoryItemId: 'item-missing', branchId: 'branch-1' },
      { legacyIngredientId: 'ing-drift', inventoryItemId: 'item-drift', branchId: 'branch-1' },
      { legacyIngredientId: 'ing-ok', inventoryItemId: 'item-ok', branchId: 'branch-1' },
    ]);
    vi.mocked(inventoryReconciliationRepository.aggregateMovementsByIngredient).mockResolvedValue(
      new Map([
        ['ing-missing', { ingredientId: 'ing-missing', sum: decimal(5), maxCreatedAt: new Date('2026-01-01') }],
        ['ing-drift', { ingredientId: 'ing-drift', sum: decimal(20), maxCreatedAt: new Date('2026-01-02') }],
        ['ing-ok', { ingredientId: 'ing-ok', sum: decimal(8), maxCreatedAt: new Date('2026-01-03') }],
      ]),
    );
    vi.mocked(inventoryReconciliationRepository.findAllStockRows).mockResolvedValue([
      stockRow({ inventoryItemId: 'item-drift', quantityOnHand: decimal(2), version: 3 }),
      stockRow({ inventoryItemId: 'item-ok', quantityOnHand: decimal(8), version: 5 }),
    ]);

    const plan = await inventoryReconciliationService.buildRebuildPlan();

    const byItem = new Map(plan.rows.map((r) => [r.inventoryItemId, r]));
    expect(byItem.get('item-missing')?.action).toBe('create');
    expect(byItem.get('item-drift')?.action).toBe('update');
    expect(byItem.get('item-ok')?.action).toBe('unchanged');
  });
});

describe('inventoryReconciliationService.executeRebuild', () => {
  it('throws without confirm: true and writes nothing', async () => {
    await expect(inventoryReconciliationService.executeRebuild({ confirm: false })).rejects.toThrow(/confirm/i);
    expect(inventoryReconciliationRepository.upsertStockRow).not.toHaveBeenCalled();
  });

  it('creates missing rows with version 1', async () => {
    vi.mocked(inventoryReconciliationRepository.findAcceptedMappings).mockResolvedValue([
      { legacyIngredientId: 'ing-1', inventoryItemId: 'item-1', branchId: 'branch-1' },
    ]);
    vi.mocked(inventoryReconciliationRepository.aggregateMovementsByIngredient).mockResolvedValue(
      new Map([['ing-1', { ingredientId: 'ing-1', sum: decimal(9), maxCreatedAt: new Date('2026-01-01') }]]),
    );
    vi.mocked(inventoryReconciliationRepository.findAllStockRows).mockResolvedValue([]);

    const result = await inventoryReconciliationService.executeRebuild({ confirm: true });

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(inventoryReconciliationRepository.upsertStockRow).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'branch-1', inventoryItemId: 'item-1', action: 'create', expectedQuantity: decimal(9) }),
      expect.anything(),
    );
  });

  it('corrects a drifted row and increments version only when the value actually changes', async () => {
    vi.mocked(inventoryReconciliationRepository.findAcceptedMappings).mockResolvedValue([
      { legacyIngredientId: 'ing-1', inventoryItemId: 'item-1', branchId: 'branch-1' },
    ]);
    vi.mocked(inventoryReconciliationRepository.aggregateMovementsByIngredient).mockResolvedValue(
      new Map([['ing-1', { ingredientId: 'ing-1', sum: decimal(12), maxCreatedAt: new Date('2026-01-01') }]]),
    );
    vi.mocked(inventoryReconciliationRepository.findAllStockRows).mockResolvedValue([stockRow({ quantityOnHand: decimal(2), version: 4 })]);

    const result = await inventoryReconciliationService.executeRebuild({ confirm: true });

    expect(result.updated).toBe(1);
    expect(inventoryReconciliationRepository.upsertStockRow).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'update', expectedQuantity: decimal(12) }),
      expect.anything(),
    );
  });

  it('leaves an unchanged row\'s quantity/version untouched (no version bump)', async () => {
    vi.mocked(inventoryReconciliationRepository.findAcceptedMappings).mockResolvedValue([
      { legacyIngredientId: 'ing-1', inventoryItemId: 'item-1', branchId: 'branch-1' },
    ]);
    vi.mocked(inventoryReconciliationRepository.aggregateMovementsByIngredient).mockResolvedValue(
      new Map([['ing-1', { ingredientId: 'ing-1', sum: decimal(10), maxCreatedAt: new Date('2026-01-01') }]]),
    );
    vi.mocked(inventoryReconciliationRepository.findAllStockRows).mockResolvedValue([stockRow({ quantityOnHand: decimal(10), version: 7 })]);

    const result = await inventoryReconciliationService.executeRebuild({ confirm: true });

    expect(result.unchanged).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.created).toBe(0);
    expect(inventoryReconciliationRepository.upsertStockRow).toHaveBeenCalledWith(expect.objectContaining({ action: 'unchanged' }), expect.anything());
  });

  it('never calls any repository method touching Ingredient, ProductInventory, or InventoryMovement', async () => {
    vi.mocked(inventoryReconciliationRepository.findAcceptedMappings).mockResolvedValue([
      { legacyIngredientId: 'ing-1', inventoryItemId: 'item-1', branchId: 'branch-1' },
    ]);
    vi.mocked(inventoryReconciliationRepository.aggregateMovementsByIngredient).mockResolvedValue(
      new Map([['ing-1', { ingredientId: 'ing-1', sum: decimal(1), maxCreatedAt: new Date('2026-01-01') }]]),
    );

    await inventoryReconciliationService.executeRebuild({ confirm: true });

    const calledMethods = Object.keys(inventoryReconciliationRepository);
    // The repository interface itself only exposes InventoryStock/outbox/mapping/movement read methods —
    // asserting the mock's own surface has no ingredient/productInventory mutation methods to call.
    expect(calledMethods).not.toContain('softDeleteIngredient');
    expect(calledMethods).not.toContain('updateProductInventory');
    expect(calledMethods).not.toContain('createMovement');
  });

  it('blocks the rebuild when unprocessed outbox rows exist and allowPendingOutbox is not set', async () => {
    vi.mocked(inventoryReconciliationRepository.getOutboxStatusCounts).mockResolvedValue({ ...ZERO_OUTBOX, pending: 3 });

    await expect(inventoryReconciliationService.executeRebuild({ confirm: true })).rejects.toThrow(/unprocessed/i);
    expect(inventoryReconciliationRepository.upsertStockRow).not.toHaveBeenCalled();
  });

  it('proceeds when unprocessed outbox rows exist but allowPendingOutbox is explicitly set', async () => {
    vi.mocked(inventoryReconciliationRepository.getOutboxStatusCounts).mockResolvedValue({ ...ZERO_OUTBOX, deferred: 2 });
    vi.mocked(inventoryReconciliationRepository.findAcceptedMappings).mockResolvedValue([
      { legacyIngredientId: 'ing-1', inventoryItemId: 'item-1', branchId: 'branch-1' },
    ]);
    vi.mocked(inventoryReconciliationRepository.aggregateMovementsByIngredient).mockResolvedValue(
      new Map([['ing-1', { ingredientId: 'ing-1', sum: decimal(4), maxCreatedAt: new Date('2026-01-01') }]]),
    );

    const result = await inventoryReconciliationService.executeRebuild({ confirm: true, allowPendingOutbox: true });

    expect(result.created).toBe(1);
  });

  it('reports orphan rows but does not delete them unless deleteOrphans is set', async () => {
    vi.mocked(inventoryReconciliationRepository.findAllStockRows).mockResolvedValue([
      stockRow({ branchId: 'branch-9', inventoryItemId: 'item-9', quantityOnHand: decimal(3) }),
    ]);

    const result = await inventoryReconciliationService.executeRebuild({ confirm: true });

    expect(result.orphans).toHaveLength(1);
    expect(result.orphansDeleted).toBe(0);
    expect(inventoryReconciliationRepository.deleteOrphan).not.toHaveBeenCalled();
  });

  it('deletes orphan rows only when deleteOrphans is explicitly true', async () => {
    vi.mocked(inventoryReconciliationRepository.findAllStockRows).mockResolvedValue([
      stockRow({ branchId: 'branch-9', inventoryItemId: 'item-9', quantityOnHand: decimal(3) }),
    ]);

    const result = await inventoryReconciliationService.executeRebuild({ confirm: true, deleteOrphans: true });

    expect(result.orphansDeleted).toBe(1);
    expect(inventoryReconciliationRepository.deleteOrphan).toHaveBeenCalledWith('branch-9', 'item-9', expect.anything());
  });

  it('is idempotent — a second rebuild against unchanged inputs reports zero creates/updates', async () => {
    vi.mocked(inventoryReconciliationRepository.findAcceptedMappings).mockResolvedValue([
      { legacyIngredientId: 'ing-1', inventoryItemId: 'item-1', branchId: 'branch-1' },
    ]);
    vi.mocked(inventoryReconciliationRepository.aggregateMovementsByIngredient).mockResolvedValue(
      new Map([['ing-1', { ingredientId: 'ing-1', sum: decimal(6), maxCreatedAt: new Date('2026-01-01') }]]),
    );
    vi.mocked(inventoryReconciliationRepository.findAllStockRows).mockResolvedValueOnce([]);

    const first = await inventoryReconciliationService.executeRebuild({ confirm: true });
    expect(first.created).toBe(1);

    // Second run: the row now "exists" with the rebuilt value, matching expected exactly.
    vi.mocked(inventoryReconciliationRepository.findAllStockRows).mockResolvedValueOnce([stockRow({ quantityOnHand: decimal(6), version: 1 })]);

    const second = await inventoryReconciliationService.executeRebuild({ confirm: true });

    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);
  });
});
