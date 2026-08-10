import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('./universal-inventory.repository.js', () => ({
  universalInventoryRepository: {
    listCategories: vi.fn(),
    findCategoryById: vi.fn(),
    findCategoryByName: vi.fn(),
    createCategory: vi.fn(),
    updateCategory: vi.fn(),
    listUnits: vi.fn(),
    findUnitById: vi.fn(),
    findUnitByCode: vi.fn(),
    createUnit: vi.fn(),
    updateUnit: vi.fn(),
    listConversions: vi.fn(),
    findConversion: vi.fn(),
    createConversion: vi.fn(),
    listItemConversions: vi.fn(),
    findItemConversionById: vi.fn(),
    findItemConversion: vi.fn(),
    createItemConversion: vi.fn(),
    updateItemConversion: vi.fn(),
    deleteItemConversion: vi.fn(),
    listItems: vi.fn(),
    findItemById: vi.fn(),
    findItemByName: vi.fn(),
    findItemBySku: vi.fn(),
    findItemByBarcode: vi.fn(),
    createItem: vi.fn(),
    updateItem: vi.fn(),
    listAssignedBranches: vi.fn(),
    findAssignment: vi.fn(),
    assignToBranch: vi.fn(),
    listActiveTrackedItemIds: vi.fn(),
    createStockRows: vi.fn(),
    lockAndGetStock: vi.fn(),
    updateStockQuantity: vi.fn(),
    incrementStockQuantity: vi.fn(),
    createStockMovement: vi.fn(),
    findBranchStockRows: vi.fn(),
    getConsumedTodayByBranch: vi.fn(),
    findStock: vi.fn(),
    findStockMovements: vi.fn(),
  },
}));

vi.mock('../branches/branches.repository.js', () => ({
  branchesRepository: {
    listAllBranchIds: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({})),
  },
}));

vi.mock('../../lib/notify.js', () => ({
  notifyBranch: vi.fn(),
  notifySuperAdmin: vi.fn(),
}));

vi.mock('../../queues/notification.queue.js', () => ({
  enqueueRawNotificationJob: vi.fn().mockResolvedValue(undefined),
}));

// Branch inventory cutover — receive/waste convert the entered unit to the
// item's base unit before touching InventoryStock. Tests below always enter
// quantities already in the base unit, so the identity conversion here keeps
// fixtures focused on the stock-movement math rather than unit conversion
// (which unit-conversion.util.test.ts already covers in isolation).
vi.mock('../product-components/unit-conversion.util.js', () => ({
  convertQuantity: vi.fn((quantity: number) => Promise.resolve(new Prisma.Decimal(quantity))),
}));

const { universalInventoryRepository: repo } = await import('./universal-inventory.repository.js');
const { branchesRepository } = await import('../branches/branches.repository.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');
const { universalInventoryService } = await import('./universal-inventory.service.js');
const { convertQuantity } = await import('../product-components/unit-conversion.util.js');

const ACTOR = { id: 'admin-1', role: 'super_admin' };

function decimal(value: number) {
  return { toNumber: () => value };
}

function dec(value: number) {
  return new Prisma.Decimal(value);
}

function buildStock(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    branchId: 'branch-1',
    inventoryItemId: 'item-1',
    quantityOnHand: dec(10),
    lowStockThreshold: null,
    criticalThreshold: null,
    ...overrides,
  };
}

function buildMovement(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'movement-1',
    branchId: 'branch-1',
    inventoryItemId: 'item-1',
    inventoryItem: { name: 'Cheese Powder' },
    movementType: 'RECEIVING',
    quantityChange: dec(5),
    quantityBefore: dec(10),
    quantityAfter: dec(15),
    unitId: 'unit-1',
    unit: { code: 'tbsp' },
    referenceType: null,
    referenceId: null,
    notes: null,
    performedByUserId: 'admin-1',
    createdAt: new Date('2026-07-29'),
    ...overrides,
  };
}

function buildUnit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'unit-1',
    code: 'kg',
    name: 'Kilogram',
    dimension: 'WEIGHT',
    isBaseUnit: true,
    isActive: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function buildItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'item-1',
    name: 'Cheese Powder',
    sku: null,
    barcode: null,
    categoryId: null,
    baseUnitId: 'unit-1',
    trackInventory: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    category: null,
    baseUnit: { id: 'unit-1', code: 'kg', name: 'Kilogram' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(branchesRepository.listAllBranchIds).mockResolvedValue([]);
  vi.mocked(branchesRepository.findById).mockResolvedValue({ id: 'branch-1', code: 'MNL001', name: 'Manila' } as never);
  vi.mocked(repo.createStockRows).mockResolvedValue({ count: 0 } as never);
  vi.mocked(repo.findItemById).mockResolvedValue(buildItem() as never);
  vi.mocked(repo.getConsumedTodayByBranch).mockResolvedValue(new Map());
  // Mirrors a real Prisma round-trip: Decimal-typed columns always come back
  // as Decimal instances on read, even when the write was given a plain
  // number (as adjustStock's quantityDelta and transferStock's quantity are).
  vi.mocked(repo.createStockMovement).mockImplementation((async (input: Record<string, unknown>) =>
    buildMovement({
      ...input,
      quantityChange: new Prisma.Decimal(input.quantityChange as Prisma.Decimal.Value),
      quantityBefore: new Prisma.Decimal(input.quantityBefore as Prisma.Decimal.Value),
      quantityAfter: new Prisma.Decimal(input.quantityAfter as Prisma.Decimal.Value),
    })) as never);
});

describe('universalInventoryService.assignToBranches', () => {
  it('creates one InventoryStock row per not-yet-assigned branch, reporting duplicates instead of erroring', async () => {
    vi.mocked(repo.findItemById).mockResolvedValue(buildItem() as never);
    vi.mocked(branchesRepository.listAllBranchIds).mockResolvedValue(['branch-1', 'branch-2']);
    vi.mocked(repo.findAssignment).mockImplementation(
      (branchId: string) => (branchId === 'branch-1' ? Promise.resolve({ id: 'stock-1' } as never) : Promise.resolve(null)) as never,
    );
    vi.mocked(repo.assignToBranch).mockResolvedValue({} as never);

    const result = await universalInventoryService.assignToBranches('item-1', ['branch-1', 'branch-2'], ACTOR, null);

    expect(result.already_assigned).toEqual(['branch-1']);
    expect(result.assigned).toEqual(['branch-2']);
    expect(repo.assignToBranch).toHaveBeenCalledTimes(1);
    expect(repo.assignToBranch).toHaveBeenCalledWith('branch-2', 'item-1');
  });

  it('rejects assignment to an unknown branch_id', async () => {
    vi.mocked(repo.findItemById).mockResolvedValue(buildItem() as never);
    vi.mocked(branchesRepository.listAllBranchIds).mockResolvedValue(['branch-1']);

    await expect(universalInventoryService.assignToBranches('item-1', ['not-a-branch'], ACTOR, null)).rejects.toMatchObject({
      code: 'BRANCH_NOT_FOUND',
    });
    expect(repo.assignToBranch).not.toHaveBeenCalled();
  });

  it('throws when the inventory item itself does not exist', async () => {
    vi.mocked(repo.findItemById).mockResolvedValue(null);

    await expect(universalInventoryService.assignToBranches('missing-item', ['branch-1'], ACTOR, null)).rejects.toMatchObject({
      code: 'INVENTORY_ITEM_NOT_FOUND',
    });
  });
});

describe('universalInventoryService.createItem', () => {
  it('rejects a duplicate name — one identity, never duplicated', async () => {
    vi.mocked(repo.findItemByName).mockResolvedValue(buildItem() as never);
    vi.mocked(repo.findUnitById).mockResolvedValue(buildUnit() as never);

    await expect(
      universalInventoryService.createItem({ name: 'Cheese Powder', baseUnitId: 'unit-1' }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'INVENTORY_ITEM_NAME_CONFLICT' });
    expect(repo.createItem).not.toHaveBeenCalled();
  });

  it('creates the item when the name and base unit are valid', async () => {
    vi.mocked(repo.findItemByName).mockResolvedValue(null);
    vi.mocked(repo.findUnitById).mockResolvedValue(buildUnit() as never);
    vi.mocked(repo.createItem).mockResolvedValue(buildItem() as never);

    const result = await universalInventoryService.createItem({ name: 'Cheese Powder', baseUnitId: 'unit-1' }, ACTOR, null);

    expect(result.id).toBe('item-1');
    expect(repo.createItem).toHaveBeenCalledTimes(1);
  });

  it('creates the item with blank sku/barcode/category treated as absent', async () => {
    vi.mocked(repo.findItemByName).mockResolvedValue(null);
    vi.mocked(repo.findUnitById).mockResolvedValue(buildUnit() as never);
    vi.mocked(repo.createItem).mockResolvedValue(buildItem() as never);

    await universalInventoryService.createItem({ name: 'Cheese Powder', baseUnitId: 'unit-1' }, ACTOR, null);

    expect(repo.findItemBySku).not.toHaveBeenCalled();
    expect(repo.findItemByBarcode).not.toHaveBeenCalled();
    expect(repo.findCategoryById).not.toHaveBeenCalled();
  });

  it('provisions InventoryStock rows in every active branch when a new item is created', async () => {
    vi.mocked(repo.findItemByName).mockResolvedValue(null);
    vi.mocked(repo.findUnitById).mockResolvedValue(buildUnit() as never);
    vi.mocked(repo.createItem).mockResolvedValue(buildItem({ id: 'item-9' }) as never);
    vi.mocked(branchesRepository.listAllBranchIds).mockResolvedValue(['branch-1', 'branch-2']);

    await universalInventoryService.createItem({ name: 'Cheese Powder', baseUnitId: 'unit-1' }, ACTOR, null);

    expect(repo.createStockRows).toHaveBeenCalledWith([
      { branchId: 'branch-1', inventoryItemId: 'item-9' },
      { branchId: 'branch-2', inventoryItemId: 'item-9' },
    ]);
  });

  it('rejects a duplicate SKU with a clear 409', async () => {
    vi.mocked(repo.findItemByName).mockResolvedValue(null);
    vi.mocked(repo.findUnitById).mockResolvedValue(buildUnit() as never);
    vi.mocked(repo.findItemBySku).mockResolvedValue(buildItem({ id: 'item-2', sku: 'RAW-001' }) as never);

    await expect(
      universalInventoryService.createItem({ name: 'Frozen Fries', sku: 'RAW-001', baseUnitId: 'unit-1' }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'SKU_CONFLICT', statusCode: 409 });
    expect(repo.createItem).not.toHaveBeenCalled();
  });

  it('rejects an unknown base_unit_id', async () => {
    vi.mocked(repo.findItemByName).mockResolvedValue(null);
    vi.mocked(repo.findUnitById).mockResolvedValue(null);

    await expect(
      universalInventoryService.createItem({ name: 'Frozen Fries', baseUnitId: 'missing-unit' }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'UNIT_NOT_FOUND', statusCode: 404 });
    expect(repo.createItem).not.toHaveBeenCalled();
  });

  it('rejects an unknown category_id', async () => {
    vi.mocked(repo.findItemByName).mockResolvedValue(null);
    vi.mocked(repo.findUnitById).mockResolvedValue(buildUnit() as never);
    vi.mocked(repo.findCategoryById).mockResolvedValue(null);

    await expect(
      universalInventoryService.createItem({ name: 'Frozen Fries', baseUnitId: 'unit-1', categoryId: 'missing-category' }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'CATEGORY_NOT_FOUND', statusCode: 404 });
    expect(repo.createItem).not.toHaveBeenCalled();
  });
});

describe('universalInventoryService.getItemById', () => {
  it('returns the same inventory_item_id assigned across multiple branches', async () => {
    vi.mocked(repo.findItemById).mockResolvedValue(buildItem() as never);
    vi.mocked(repo.listAssignedBranches).mockResolvedValue([
      { branchId: 'branch-1', quantityOnHand: decimal(0), branch: { code: 'B1', name: 'Branch One', city: 'Manila' } },
      { branchId: 'branch-2', quantityOnHand: decimal(0), branch: { code: 'B2', name: 'Branch Two', city: 'Cebu' } },
    ] as never);

    const result = await universalInventoryService.getItemById('item-1');

    expect(result.id).toBe('item-1');
    expect(result.assigned_branches).toHaveLength(2);
    expect(result.assigned_branches.map((b) => b.branch_id)).toEqual(['branch-1', 'branch-2']);
  });
});

describe('universalInventoryService.provisionBranchStock', () => {
  it('creates a zero-stock InventoryStock row for every active InventoryItem', async () => {
    vi.mocked(repo.listActiveTrackedItemIds).mockResolvedValue([{ id: 'item-1' }, { id: 'item-2' }] as never);

    await universalInventoryService.provisionBranchStock('branch-1');

    expect(repo.createStockRows).toHaveBeenCalledWith(
      [
        { branchId: 'branch-1', inventoryItemId: 'item-1' },
        { branchId: 'branch-1', inventoryItemId: 'item-2' },
      ],
      undefined,
    );
  });

  it('is a no-op when there are no active inventory items', async () => {
    vi.mocked(repo.listActiveTrackedItemIds).mockResolvedValue([]);

    await universalInventoryService.provisionBranchStock('branch-1');

    expect(repo.createStockRows).not.toHaveBeenCalled();
  });
});

describe('universalInventoryService.getBranchStock — Test I (Branch Inventory list + alert classification)', () => {
  it('rejects an unknown branch_id', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(null);

    await expect(universalInventoryService.getBranchStock('missing-branch')).rejects.toMatchObject({
      code: 'BRANCH_NOT_FOUND',
    });
  });

  it('classifies each row healthy/low/critical from InventoryStock thresholds, never from legacy Ingredient fields', async () => {
    vi.mocked(repo.findBranchStockRows).mockResolvedValue([
      {
        inventoryItemId: 'item-healthy',
        quantityOnHand: decimal(50),
        lowStockThreshold: decimal(10),
        criticalThreshold: decimal(5),
        inventoryItem: { name: 'Flour', sku: null, category: null, baseUnit: { code: 'kg' } },
      },
      {
        inventoryItemId: 'item-low',
        quantityOnHand: decimal(8),
        lowStockThreshold: decimal(10),
        criticalThreshold: decimal(5),
        inventoryItem: { name: 'Sugar', sku: null, category: null, baseUnit: { code: 'kg' } },
      },
      {
        inventoryItemId: 'item-critical',
        quantityOnHand: decimal(2),
        lowStockThreshold: decimal(10),
        criticalThreshold: decimal(5),
        inventoryItem: { name: 'Cheese Powder', sku: null, category: null, baseUnit: { code: 'kg' } },
      },
      {
        inventoryItemId: 'item-no-threshold',
        quantityOnHand: decimal(0),
        lowStockThreshold: null,
        criticalThreshold: null,
        inventoryItem: { name: 'Napkins', sku: null, category: null, baseUnit: { code: 'pc' } },
      },
    ] as never);

    const result = await universalInventoryService.getBranchStock('branch-1');

    expect(result.items.map((i) => ({ id: i.inventory_item_id, status: i.status }))).toEqual([
      { id: 'item-healthy', status: 'healthy' },
      { id: 'item-low', status: 'low' },
      { id: 'item-critical', status: 'critical' },
      { id: 'item-no-threshold', status: 'healthy' },
    ]);
  });

  it('attaches consumed_today from getConsumedTodayByBranch, defaulting to 0 for items with no sales today', async () => {
    vi.mocked(repo.findBranchStockRows).mockResolvedValue([
      {
        inventoryItemId: 'item-sold',
        quantityOnHand: decimal(50),
        lowStockThreshold: decimal(10),
        criticalThreshold: decimal(5),
        inventoryItem: { name: 'Flour', sku: null, category: null, baseUnit: { code: 'kg' } },
      },
      {
        inventoryItemId: 'item-unsold',
        quantityOnHand: decimal(20),
        lowStockThreshold: decimal(10),
        criticalThreshold: decimal(5),
        inventoryItem: { name: 'Sugar', sku: null, category: null, baseUnit: { code: 'kg' } },
      },
    ] as never);
    vi.mocked(repo.getConsumedTodayByBranch).mockResolvedValue(new Map([['item-sold', 3.5]]));

    const result = await universalInventoryService.getBranchStock('branch-1');

    expect(result.items.map((i) => ({ id: i.inventory_item_id, consumed_today: i.consumed_today }))).toEqual([
      { id: 'item-sold', consumed_today: 3.5 },
      { id: 'item-unsold', consumed_today: 0 },
    ]);
  });
});

describe('universalInventoryService.getBranchStockAlerts — Test I (dashboard alerts)', () => {
  it('rejects an unknown branch_id', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(null);

    await expect(universalInventoryService.getBranchStockAlerts('missing-branch')).rejects.toMatchObject({
      code: 'BRANCH_NOT_FOUND',
    });
  });

  it('excludes healthy rows and reports the breaching threshold for low/critical rows', async () => {
    vi.mocked(repo.findBranchStockRows).mockResolvedValue([
      {
        inventoryItemId: 'item-healthy',
        quantityOnHand: decimal(50),
        lowStockThreshold: decimal(10),
        criticalThreshold: decimal(5),
        inventoryItem: { name: 'Flour', sku: null, category: null, baseUnit: { code: 'kg' } },
      },
      {
        inventoryItemId: 'item-low',
        quantityOnHand: decimal(8),
        lowStockThreshold: decimal(10),
        criticalThreshold: decimal(5),
        inventoryItem: { name: 'Sugar', sku: null, category: null, baseUnit: { code: 'kg' } },
      },
      {
        inventoryItemId: 'item-critical',
        quantityOnHand: decimal(2),
        lowStockThreshold: decimal(10),
        criticalThreshold: decimal(5),
        inventoryItem: { name: 'Cheese Powder', sku: null, category: null, baseUnit: { code: 'kg' } },
      },
    ] as never);

    const result = await universalInventoryService.getBranchStockAlerts('branch-1');

    expect(result.alerts).toEqual([
      { inventory_item_id: 'item-low', name: 'Sugar', quantity_on_hand: 8, threshold: 10, severity: 'low' },
      { inventory_item_id: 'item-critical', name: 'Cheese Powder', quantity_on_hand: 2, threshold: 5, severity: 'critical' },
    ]);
  });
});

describe('universalInventoryService.getStockMovements', () => {
  it('forwards branch, filters, and pagination unchanged to the repository', async () => {
    vi.mocked(repo.findStockMovements).mockResolvedValue({ movements: [buildMovement()], total: 1 } as never);

    const filters = { inventoryItemId: 'item-1', page: 2, limit: 10 };
    const result = await universalInventoryService.getStockMovements('branch-1', filters);

    expect(repo.findStockMovements).toHaveBeenCalledWith('branch-1', filters);
    expect(result.total).toBe(1);
    expect(result.page).toBe(2);
    expect(result.limit).toBe(10);
    expect(result.movements).toHaveLength(1);
    expect(result.movements[0]).toMatchObject({ unit_id: 'unit-1', unit_code: 'tbsp' });
  });

  it('nulls unit_code when the movement has no unit relation', async () => {
    vi.mocked(repo.findStockMovements).mockResolvedValue({
      movements: [buildMovement({ unitId: null, unit: null })],
      total: 1,
    } as never);

    const result = await universalInventoryService.getStockMovements('branch-1', { page: 1, limit: 10 });

    expect(result.movements[0]).toMatchObject({ unit_id: null, unit_code: null });
  });
});

describe('universalInventoryService.receiveStock — Test B (direct receiving)', () => {
  it('rejects an unknown branch_id', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(null);

    await expect(
      universalInventoryService.receiveStock({ branchId: 'missing', inventoryItemId: 'item-1', quantity: 5 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });
  });

  it('rejects an unknown inventory_item_id', async () => {
    vi.mocked(repo.findItemById).mockResolvedValue(null);

    await expect(
      universalInventoryService.receiveStock({ branchId: 'branch-1', inventoryItemId: 'missing', quantity: 5 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'INVENTORY_ITEM_NOT_FOUND' });
  });

  it('rejects when no InventoryStock row exists yet (provisioning has not completed)', async () => {
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(null);

    await expect(
      universalInventoryService.receiveStock({ branchId: 'branch-1', inventoryItemId: 'item-1', quantity: 5 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'STOCK_ROW_NOT_FOUND' });
    expect(repo.createStockMovement).not.toHaveBeenCalled();
  });

  it('increases InventoryStock and records a RECEIVING movement, audit-logged with the delivery reference', async () => {
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(buildStock({ quantityOnHand: dec(10) }) as never);
    vi.mocked(repo.incrementStockQuantity).mockResolvedValue({ quantityOnHand: dec(15) } as never);

    const result = await universalInventoryService.receiveStock(
      { branchId: 'branch-1', inventoryItemId: 'item-1', quantity: 5, deliveryReference: 'PO-1001' },
      ACTOR,
      null,
    );

    // Delta-based write: an atomic `increment: 5` at the DB layer, not a
    // locally-computed absolute SET of 15.
    expect(repo.incrementStockQuantity).toHaveBeenCalledWith('branch-1', 'item-1', dec(5), {});
    expect(repo.createStockMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: 'branch-1',
        inventoryItemId: 'item-1',
        movementType: 'RECEIVING',
        quantityBefore: dec(10),
        quantityAfter: dec(15),
        referenceType: 'delivery',
        referenceId: 'PO-1001',
      }),
      {},
    );
    expect(result.movement_type).toBe('RECEIVING');
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'INVENTORY_STOCK_RECEIVED' }));
  });

  it('TASK 118 — passes the InventoryItem id to convertQuantity so an item-specific conversion is preferred', async () => {
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(buildStock({ quantityOnHand: dec(10) }) as never);
    vi.mocked(repo.incrementStockQuantity).mockResolvedValue({ quantityOnHand: dec(15) } as never);

    await universalInventoryService.receiveStock(
      { branchId: 'branch-1', inventoryItemId: 'item-1', quantity: 5, enteredUnitId: 'unit-tbsp' },
      ACTOR,
      null,
    );

    expect(convertQuantity).toHaveBeenCalledWith(5, 'unit-tbsp', 'unit-1', 'item-1');
  });
});

describe('universalInventoryService.adjustStock — Test C (stock adjustment)', () => {
  it('rejects when no InventoryStock row exists', async () => {
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(null);

    await expect(
      universalInventoryService.adjustStock({ branchId: 'branch-1', inventoryItemId: 'item-1', quantityDelta: 5, reasonCode: 'count_correction' }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'STOCK_ROW_NOT_FOUND' });
  });

  it('records ADJUSTMENT_IN for a positive delta', async () => {
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(buildStock({ quantityOnHand: dec(10) }) as never);
    vi.mocked(repo.incrementStockQuantity).mockResolvedValue({ quantityOnHand: dec(15) } as never);
    vi.mocked(repo.findStock).mockResolvedValue(buildStock({ quantityOnHand: dec(15) }) as never);

    await universalInventoryService.adjustStock(
      { branchId: 'branch-1', inventoryItemId: 'item-1', quantityDelta: 5, reasonCode: 'count_correction' },
      ACTOR,
      null,
    );

    // Delta-based write: an atomic `increment: 5`, not a locally-computed absolute SET of 15.
    expect(repo.incrementStockQuantity).toHaveBeenCalledWith('branch-1', 'item-1', 5, {});
    expect(repo.createStockMovement).toHaveBeenCalledWith(
      expect.objectContaining({ movementType: 'ADJUSTMENT_IN', quantityChange: 5, quantityBefore: dec(10), quantityAfter: dec(15) }),
      {},
    );
  });

  it('records ADJUSTMENT_OUT for a negative delta', async () => {
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(buildStock({ quantityOnHand: dec(10) }) as never);
    vi.mocked(repo.incrementStockQuantity).mockResolvedValue({ quantityOnHand: dec(7) } as never);
    vi.mocked(repo.findStock).mockResolvedValue(buildStock({ quantityOnHand: dec(7) }) as never);

    await universalInventoryService.adjustStock(
      { branchId: 'branch-1', inventoryItemId: 'item-1', quantityDelta: -3, reasonCode: 'damaged' },
      ACTOR,
      null,
    );

    expect(repo.incrementStockQuantity).toHaveBeenCalledWith('branch-1', 'item-1', -3, {});
    expect(repo.createStockMovement).toHaveBeenCalledWith(
      expect.objectContaining({ movementType: 'ADJUSTMENT_OUT', quantityChange: -3 }),
      {},
    );
  });

  it('rejects an adjustment that would take stock below zero — never negative results', async () => {
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(buildStock({ quantityOnHand: dec(2) }) as never);

    await expect(
      universalInventoryService.adjustStock({ branchId: 'branch-1', inventoryItemId: 'item-1', quantityDelta: -5, reasonCode: 'damaged' }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(repo.incrementStockQuantity).not.toHaveBeenCalled();
    expect(repo.createStockMovement).not.toHaveBeenCalled();
  });

  it('enqueues a low-stock alert when the post-adjustment quantity is at or below the low threshold', async () => {
    const { enqueueRawNotificationJob } = await import('../../queues/notification.queue.js');
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(buildStock({ quantityOnHand: dec(10) }) as never);
    vi.mocked(repo.incrementStockQuantity).mockResolvedValue({ quantityOnHand: dec(3) } as never);
    vi.mocked(repo.findStock).mockResolvedValue(buildStock({ quantityOnHand: dec(3), lowStockThreshold: dec(5), criticalThreshold: dec(2) }) as never);

    await universalInventoryService.adjustStock(
      { branchId: 'branch-1', inventoryItemId: 'item-1', quantityDelta: -7, reasonCode: 'damaged' },
      ACTOR,
      null,
    );

    expect(enqueueRawNotificationJob).toHaveBeenCalledWith('low_stock_alert', expect.objectContaining({ severity: 'low' }));
  });

  it('does not enqueue a low-stock alert when the item has no low_stock_threshold configured', async () => {
    const { enqueueRawNotificationJob } = await import('../../queues/notification.queue.js');
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(buildStock({ quantityOnHand: dec(10) }) as never);
    vi.mocked(repo.incrementStockQuantity).mockResolvedValue({ quantityOnHand: dec(0) } as never);
    vi.mocked(repo.findStock).mockResolvedValue(buildStock({ quantityOnHand: dec(0), lowStockThreshold: null, criticalThreshold: null }) as never);

    await universalInventoryService.adjustStock(
      { branchId: 'branch-1', inventoryItemId: 'item-1', quantityDelta: -10, reasonCode: 'damaged' },
      ACTOR,
      null,
    );

    expect(enqueueRawNotificationJob).not.toHaveBeenCalled();
  });
});

describe('universalInventoryService.wasteStock — Test D (waste management)', () => {
  it('records a WASTE movement with a negative quantity_change', async () => {
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(buildStock({ quantityOnHand: dec(10) }) as never);
    vi.mocked(repo.incrementStockQuantity).mockResolvedValue({ quantityOnHand: dec(7) } as never);
    vi.mocked(repo.findStock).mockResolvedValue(buildStock({ quantityOnHand: dec(7) }) as never);

    await universalInventoryService.wasteStock(
      { branchId: 'branch-1', inventoryItemId: 'item-1', quantity: 3, reasonCode: 'spoilage' },
      ACTOR,
      null,
    );

    // Delta-based write: an atomic `increment: -3`, not a locally-computed absolute SET of 7.
    expect(repo.incrementStockQuantity).toHaveBeenCalledWith('branch-1', 'item-1', dec(-3), {});
    expect(repo.createStockMovement).toHaveBeenCalledWith(
      expect.objectContaining({ movementType: 'WASTE', quantityChange: dec(-3), quantityBefore: dec(10), quantityAfter: dec(7) }),
      {},
    );
  });

  it('rejects a waste quantity greater than the current stock — validated against sufficient stock', async () => {
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(buildStock({ quantityOnHand: dec(2) }) as never);

    await expect(
      universalInventoryService.wasteStock({ branchId: 'branch-1', inventoryItemId: 'item-1', quantity: 5, reasonCode: 'spoilage' }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(repo.createStockMovement).not.toHaveBeenCalled();
  });

  it('TASK 118 — passes the InventoryItem id to convertQuantity so an item-specific conversion is preferred', async () => {
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(buildStock({ quantityOnHand: dec(10) }) as never);
    vi.mocked(repo.incrementStockQuantity).mockResolvedValue({ quantityOnHand: dec(7) } as never);
    vi.mocked(repo.findStock).mockResolvedValue(buildStock({ quantityOnHand: dec(7) }) as never);

    await universalInventoryService.wasteStock(
      { branchId: 'branch-1', inventoryItemId: 'item-1', quantity: 3, reasonCode: 'spoilage', enteredUnitId: 'unit-tbsp' },
      ACTOR,
      null,
    );

    expect(convertQuantity).toHaveBeenCalledWith(3, 'unit-tbsp', 'unit-1', 'item-1');
  });
});

describe('universalInventoryService.transferStock — Test E (atomic branch transfers)', () => {
  it('rejects a transfer to the same branch', async () => {
    await expect(
      universalInventoryService.transferStock(
        { inventoryItemId: 'item-1', fromBranchId: 'branch-1', toBranchId: 'branch-1', quantity: 5 },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSFER' });
  });

  it('rejects when the destination branch does not exist', async () => {
    vi.mocked(branchesRepository.findById).mockImplementation(
      (id: string) => Promise.resolve(id === 'branch-1' ? { id: 'branch-1' } : null) as never,
    );

    await expect(
      universalInventoryService.transferStock(
        { inventoryItemId: 'item-1', fromBranchId: 'branch-1', toBranchId: 'branch-2', quantity: 5 },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });
  });

  it('locks the lexicographically smaller branch first regardless of transfer direction, to avoid cross-transfer deadlocks', async () => {
    vi.mocked(repo.lockAndGetStock).mockImplementation(
      (branchId: string) => Promise.resolve(buildStock({ branchId, quantityOnHand: dec(20) })) as never,
    );
    vi.mocked(repo.incrementStockQuantity).mockResolvedValue({ quantityOnHand: dec(20) } as never);

    await universalInventoryService.transferStock(
      { inventoryItemId: 'item-1', fromBranchId: 'branch-z', toBranchId: 'branch-a', quantity: 5 },
      ACTOR,
      null,
    );

    const lockCalls = vi.mocked(repo.lockAndGetStock).mock.calls;
    expect(lockCalls).toHaveLength(2);
    expect(lockCalls[0]?.[0]).toBe('branch-a');
    expect(lockCalls[1]?.[0]).toBe('branch-z');
  });

  it('writes both legs atomically — TRANSFER_OUT on the source and TRANSFER_IN on the destination, sharing one reference id', async () => {
    vi.mocked(repo.lockAndGetStock).mockImplementation(
      (branchId: string) => Promise.resolve(buildStock({ branchId, quantityOnHand: dec(20) })) as never,
    );
    // Called source-first then dest (see transferStock) — chained Once
    // values line up with that order.
    vi.mocked(repo.incrementStockQuantity)
      .mockResolvedValueOnce({ quantityOnHand: dec(15) } as never)
      .mockResolvedValueOnce({ quantityOnHand: dec(25) } as never);

    const result = await universalInventoryService.transferStock(
      { inventoryItemId: 'item-1', fromBranchId: 'branch-1', toBranchId: 'branch-2', quantity: 5 },
      ACTOR,
      null,
    );

    // Delta-based writes: atomic `increment: -5` / `increment: 5`, not
    // locally-computed absolute SETs of 15/25.
    expect(repo.incrementStockQuantity).toHaveBeenCalledWith('branch-1', 'item-1', -5, {});
    expect(repo.incrementStockQuantity).toHaveBeenCalledWith('branch-2', 'item-1', 5, {});
    expect(repo.createStockMovement).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'branch-1', movementType: 'TRANSFER_OUT', quantityBefore: dec(20), quantityAfter: dec(15) }),
      {},
    );
    expect(repo.createStockMovement).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'branch-2', movementType: 'TRANSFER_IN', quantityBefore: dec(20), quantityAfter: dec(25) }),
      {},
    );
    expect(result.transfer_out.reference_id).toBe(result.transfer_in.reference_id);
  });

  it('rejects (with no partial write) when the source branch has insufficient stock', async () => {
    vi.mocked(repo.lockAndGetStock).mockImplementation(
      (branchId: string) => Promise.resolve(buildStock({ branchId, quantityOnHand: branchId === 'branch-1' ? dec(2) : dec(20) })) as never,
    );

    await expect(
      universalInventoryService.transferStock(
        { inventoryItemId: 'item-1', fromBranchId: 'branch-1', toBranchId: 'branch-2', quantity: 5 },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(repo.incrementStockQuantity).not.toHaveBeenCalled();
    expect(repo.createStockMovement).not.toHaveBeenCalled();
  });

  it('rejects when either branch has no InventoryStock row for this item yet', async () => {
    vi.mocked(repo.lockAndGetStock).mockImplementation(
      (branchId: string) => Promise.resolve(branchId === 'branch-1' ? null : buildStock({ branchId })) as never,
    );

    await expect(
      universalInventoryService.transferStock(
        { inventoryItemId: 'item-1', fromBranchId: 'branch-1', toBranchId: 'branch-2', quantity: 5 },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'STOCK_ROW_NOT_FOUND' });
  });
});

describe('universalInventoryService.submitPhysicalCount — Test F (physical count)', () => {
  it('records a PHYSICAL_COUNT movement with the system-vs-counted variance when the count differs', async () => {
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(buildStock({ quantityOnHand: dec(10) }) as never);

    const result = await universalInventoryService.submitPhysicalCount(
      { branchId: 'branch-1', counts: [{ inventoryItemId: 'item-1', countedQuantity: 12 }] },
      ACTOR,
      null,
    );

    expect(repo.updateStockQuantity).toHaveBeenCalledWith('branch-1', 'item-1', dec(12), {});
    expect(repo.createStockMovement).toHaveBeenCalledWith(
      expect.objectContaining({ movementType: 'PHYSICAL_COUNT', quantityBefore: dec(10), quantityAfter: dec(12) }),
      {},
    );
    expect(result.results[0]).toMatchObject({ inventory_item_id: 'item-1', previous_quantity: 10, counted_quantity: 12, variance: 2 });
  });

  it('writes InventoryStock but records no movement when the counted quantity matches current stock exactly (zero variance)', async () => {
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(buildStock({ quantityOnHand: dec(10) }) as never);

    await universalInventoryService.submitPhysicalCount(
      { branchId: 'branch-1', counts: [{ inventoryItemId: 'item-1', countedQuantity: 10 }] },
      ACTOR,
      null,
    );

    expect(repo.updateStockQuantity).toHaveBeenCalledWith('branch-1', 'item-1', dec(10), {});
    expect(repo.createStockMovement).not.toHaveBeenCalled();
  });

  it('rejects when an inventory_item_id in the count batch does not exist', async () => {
    vi.mocked(repo.findItemById).mockResolvedValueOnce(null);

    await expect(
      universalInventoryService.submitPhysicalCount(
        { branchId: 'branch-1', counts: [{ inventoryItemId: 'missing-item', countedQuantity: 5 }] },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'INVENTORY_ITEM_NOT_FOUND' });
  });
});

function buildItemConversion(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'item-conv-1',
    inventoryItemId: 'item-1',
    fromUnitId: 'unit-tbsp',
    toUnitId: 'unit-g',
    factor: dec(7),
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    fromUnit: { code: 'tbsp', name: 'Tablespoon' },
    toUnit: { code: 'g', name: 'Gram' },
    ...overrides,
  };
}

// Task 209.37 #6 — every manual inventory write (delta-based or absolute)
// must still acquire the per-(branch, item) advisory lock before touching
// InventoryStock, whether that write is now incrementStockQuantity (receive/
// adjust/waste/transfer) or the unchanged absolute updateStockQuantity
// (physical count).
describe('universalInventoryService — manual inventory writes always lock before writing (Task 209.37 #6)', () => {
  it('receiveStock acquires the advisory lock before writing', async () => {
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(buildStock({ quantityOnHand: dec(10) }) as never);
    vi.mocked(repo.incrementStockQuantity).mockResolvedValue({ quantityOnHand: dec(15) } as never);

    await universalInventoryService.receiveStock({ branchId: 'branch-1', inventoryItemId: 'item-1', quantity: 5 }, ACTOR, null);

    const lockOrder = vi.mocked(repo.lockAndGetStock).mock.invocationCallOrder[0] as number;
    const writeOrder = vi.mocked(repo.incrementStockQuantity).mock.invocationCallOrder[0] as number;
    expect(lockOrder).toBeLessThan(writeOrder);
  });

  it('adjustStock acquires the advisory lock before writing', async () => {
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(buildStock({ quantityOnHand: dec(10) }) as never);
    vi.mocked(repo.incrementStockQuantity).mockResolvedValue({ quantityOnHand: dec(15) } as never);

    await universalInventoryService.adjustStock(
      { branchId: 'branch-1', inventoryItemId: 'item-1', quantityDelta: 5, reasonCode: 'count_correction' },
      ACTOR,
      null,
    );

    const lockOrder = vi.mocked(repo.lockAndGetStock).mock.invocationCallOrder[0] as number;
    const writeOrder = vi.mocked(repo.incrementStockQuantity).mock.invocationCallOrder[0] as number;
    expect(lockOrder).toBeLessThan(writeOrder);
  });

  it('wasteStock acquires the advisory lock before writing', async () => {
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(buildStock({ quantityOnHand: dec(10) }) as never);
    vi.mocked(repo.incrementStockQuantity).mockResolvedValue({ quantityOnHand: dec(7) } as never);

    await universalInventoryService.wasteStock(
      { branchId: 'branch-1', inventoryItemId: 'item-1', quantity: 3, reasonCode: 'spoilage' },
      ACTOR,
      null,
    );

    const lockOrder = vi.mocked(repo.lockAndGetStock).mock.invocationCallOrder[0] as number;
    const writeOrder = vi.mocked(repo.incrementStockQuantity).mock.invocationCallOrder[0] as number;
    expect(lockOrder).toBeLessThan(writeOrder);
  });

  it('transferStock acquires both branches\' advisory locks before writing either leg', async () => {
    vi.mocked(repo.lockAndGetStock).mockImplementation(
      (branchId: string) => Promise.resolve(buildStock({ branchId, quantityOnHand: dec(20) })) as never,
    );
    vi.mocked(repo.incrementStockQuantity)
      .mockResolvedValueOnce({ quantityOnHand: dec(15) } as never)
      .mockResolvedValueOnce({ quantityOnHand: dec(25) } as never);

    await universalInventoryService.transferStock(
      { inventoryItemId: 'item-1', fromBranchId: 'branch-1', toBranchId: 'branch-2', quantity: 5 },
      ACTOR,
      null,
    );

    const lastLockOrder = Math.max(...vi.mocked(repo.lockAndGetStock).mock.invocationCallOrder);
    const firstWriteOrder = Math.min(...vi.mocked(repo.incrementStockQuantity).mock.invocationCallOrder);
    expect(lastLockOrder).toBeLessThan(firstWriteOrder);
  });

  it('submitPhysicalCount acquires the advisory lock before writing (absolute set, unchanged)', async () => {
    vi.mocked(repo.lockAndGetStock).mockResolvedValue(buildStock({ quantityOnHand: dec(10) }) as never);

    await universalInventoryService.submitPhysicalCount(
      { branchId: 'branch-1', counts: [{ inventoryItemId: 'item-1', countedQuantity: 12 }] },
      ACTOR,
      null,
    );

    const lockOrder = vi.mocked(repo.lockAndGetStock).mock.invocationCallOrder[0] as number;
    const writeOrder = vi.mocked(repo.updateStockQuantity).mock.invocationCallOrder[0] as number;
    expect(lockOrder).toBeLessThan(writeOrder);
  });
});

describe('universalInventoryService.createItemConversion — TASK 115', () => {
  it('creates a conversion scoped to one inventory item', async () => {
    vi.mocked(repo.findItemById).mockResolvedValue(buildItem() as never);
    vi.mocked(repo.findUnitById).mockImplementation(
      (id: string) => Promise.resolve(buildUnit({ id, dimension: id === 'unit-tbsp' ? 'VOLUME' : 'WEIGHT' })) as never,
    );
    vi.mocked(repo.findItemConversion).mockResolvedValue(null);
    vi.mocked(repo.createItemConversion).mockResolvedValue(buildItemConversion() as never);

    const result = await universalInventoryService.createItemConversion(
      { inventoryItemId: 'item-1', fromUnitId: 'unit-tbsp', toUnitId: 'unit-g', factor: 7 },
      ACTOR,
      null,
    );

    expect(result).toMatchObject({
      inventory_item_id: 'item-1',
      from_unit_id: 'unit-tbsp',
      from_unit_code: 'tbsp',
      from_unit_name: 'Tablespoon',
      to_unit_id: 'unit-g',
      to_unit_code: 'g',
      to_unit_name: 'Gram',
      factor: 7,
    });
    expect(repo.createItemConversion).toHaveBeenCalledWith({ inventoryItemId: 'item-1', fromUnitId: 'unit-tbsp', toUnitId: 'unit-g', factor: 7 });
  });

  it('allows different items to declare different factors for the same unit pair (density override)', async () => {
    vi.mocked(repo.findItemById).mockResolvedValue(buildItem() as never);
    vi.mocked(repo.findUnitById).mockResolvedValue(buildUnit() as never);
    vi.mocked(repo.findItemConversion).mockResolvedValue(null);
    vi.mocked(repo.createItemConversion).mockImplementation(
      ((data: { inventoryItemId: string; fromUnitId: string; toUnitId: string; factor: number }) =>
        Promise.resolve(buildItemConversion({ ...data, factor: dec(data.factor) }))) as never,
    );

    const cheese = await universalInventoryService.createItemConversion(
      { inventoryItemId: 'item-cheese', fromUnitId: 'unit-tbsp', toUnitId: 'unit-g', factor: 7 },
      ACTOR,
      null,
    );
    const bbq = await universalInventoryService.createItemConversion(
      { inventoryItemId: 'item-bbq', fromUnitId: 'unit-tbsp', toUnitId: 'unit-g', factor: 6 },
      ACTOR,
      null,
    );

    expect(cheese.factor).toBe(7);
    expect(bbq.factor).toBe(6);
  });

  it('rejects a non-positive factor', async () => {
    await expect(
      universalInventoryService.createItemConversion({ inventoryItemId: 'item-1', fromUnitId: 'unit-tbsp', toUnitId: 'unit-g', factor: 0 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'CONVERSION_FACTOR_INVALID' });
    expect(repo.createItemConversion).not.toHaveBeenCalled();
  });

  it('rejects when from_unit_id and to_unit_id are identical', async () => {
    await expect(
      universalInventoryService.createItemConversion({ inventoryItemId: 'item-1', fromUnitId: 'unit-g', toUnitId: 'unit-g', factor: 1 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'CONVERSION_SAME_UNIT' });
  });

  it('rejects a duplicate item/from/to conversion', async () => {
    vi.mocked(repo.findItemById).mockResolvedValue(buildItem() as never);
    vi.mocked(repo.findUnitById).mockResolvedValue(buildUnit() as never);
    vi.mocked(repo.findItemConversion).mockResolvedValue(buildItemConversion() as never);

    await expect(
      universalInventoryService.createItemConversion({ inventoryItemId: 'item-1', fromUnitId: 'unit-tbsp', toUnitId: 'unit-g', factor: 7 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'ITEM_CONVERSION_ALREADY_EXISTS' });
    expect(repo.createItemConversion).not.toHaveBeenCalled();
  });

  it('rejects when the inventory item does not exist', async () => {
    vi.mocked(repo.findItemById).mockResolvedValue(null);

    await expect(
      universalInventoryService.createItemConversion({ inventoryItemId: 'missing-item', fromUnitId: 'unit-tbsp', toUnitId: 'unit-g', factor: 7 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'INVENTORY_ITEM_NOT_FOUND' });
  });

  it('allows dimensions to differ, since item-specific density conversions cross dimensions on purpose', async () => {
    vi.mocked(repo.findItemById).mockResolvedValue(buildItem() as never);
    vi.mocked(repo.findUnitById).mockImplementation(
      (id: string) => Promise.resolve(buildUnit({ id, dimension: id === 'unit-tbsp' ? 'VOLUME' : 'WEIGHT' })) as never,
    );
    vi.mocked(repo.findItemConversion).mockResolvedValue(null);
    vi.mocked(repo.createItemConversion).mockResolvedValue(buildItemConversion() as never);

    await expect(
      universalInventoryService.createItemConversion({ inventoryItemId: 'item-1', fromUnitId: 'unit-tbsp', toUnitId: 'unit-g', factor: 7 }, ACTOR, null),
    ).resolves.toMatchObject({ factor: 7 });
  });
});

describe('universalInventoryService.updateItemConversion — TASK 115 / TASK 121', () => {
  it('updates the factor', async () => {
    vi.mocked(repo.findItemConversionById).mockResolvedValue(buildItemConversion() as never);
    vi.mocked(repo.updateItemConversion).mockResolvedValue(buildItemConversion({ factor: dec(9) }) as never);

    const result = await universalInventoryService.updateItemConversion('item-1', 'item-conv-1', { factor: 9 }, ACTOR, null);

    expect(result.factor).toBe(9);
    expect(repo.updateItemConversion).toHaveBeenCalledWith('item-conv-1', { factor: 9 });
  });

  it('rejects a non-positive factor', async () => {
    await expect(universalInventoryService.updateItemConversion('item-1', 'item-conv-1', { factor: -1 }, ACTOR, null)).rejects.toMatchObject({
      code: 'CONVERSION_FACTOR_INVALID',
    });
    expect(repo.updateItemConversion).not.toHaveBeenCalled();
  });

  it('rejects when the conversion does not exist', async () => {
    vi.mocked(repo.findItemConversionById).mockResolvedValue(null);

    await expect(universalInventoryService.updateItemConversion('item-1', 'missing', { factor: 5 }, ACTOR, null)).rejects.toMatchObject({
      code: 'ITEM_CONVERSION_NOT_FOUND',
    });
  });

  it('rejects when the conversion belongs to a different inventory item', async () => {
    vi.mocked(repo.findItemConversionById).mockResolvedValue(buildItemConversion({ inventoryItemId: 'item-other' }) as never);

    await expect(universalInventoryService.updateItemConversion('item-1', 'item-conv-1', { factor: 9 }, ACTOR, null)).rejects.toMatchObject({
      code: 'ITEM_CONVERSION_NOT_FOUND',
    });
    expect(repo.updateItemConversion).not.toHaveBeenCalled();
  });
});

describe('universalInventoryService.deleteItemConversion — TASK 115 / TASK 121', () => {
  it('deletes an existing conversion', async () => {
    vi.mocked(repo.findItemConversionById).mockResolvedValue(buildItemConversion() as never);
    vi.mocked(repo.deleteItemConversion).mockResolvedValue(buildItemConversion() as never);

    const result = await universalInventoryService.deleteItemConversion('item-1', 'item-conv-1', ACTOR, null);

    expect(result).toEqual({ id: 'item-conv-1' });
    expect(repo.deleteItemConversion).toHaveBeenCalledWith('item-conv-1');
  });

  it('rejects when the conversion does not exist', async () => {
    vi.mocked(repo.findItemConversionById).mockResolvedValue(null);

    await expect(universalInventoryService.deleteItemConversion('item-1', 'missing', ACTOR, null)).rejects.toMatchObject({
      code: 'ITEM_CONVERSION_NOT_FOUND',
    });
    expect(repo.deleteItemConversion).not.toHaveBeenCalled();
  });

  it('rejects when the conversion belongs to a different inventory item', async () => {
    vi.mocked(repo.findItemConversionById).mockResolvedValue(buildItemConversion({ inventoryItemId: 'item-other' }) as never);

    await expect(universalInventoryService.deleteItemConversion('item-1', 'item-conv-1', ACTOR, null)).rejects.toMatchObject({
      code: 'ITEM_CONVERSION_NOT_FOUND',
    });
    expect(repo.deleteItemConversion).not.toHaveBeenCalled();
  });
});

describe('universalInventoryService.listItemConversions — TASK 115', () => {
  it('lists conversions for one inventory item', async () => {
    vi.mocked(repo.findItemById).mockResolvedValue(buildItem() as never);
    vi.mocked(repo.listItemConversions).mockResolvedValue([buildItemConversion()] as never);

    const result = await universalInventoryService.listItemConversions('item-1');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ inventory_item_id: 'item-1', factor: 7 });
  });

  it('rejects when the inventory item does not exist', async () => {
    vi.mocked(repo.findItemById).mockResolvedValue(null);

    await expect(universalInventoryService.listItemConversions('missing-item')).rejects.toMatchObject({
      code: 'INVENTORY_ITEM_NOT_FOUND',
    });
  });
});
