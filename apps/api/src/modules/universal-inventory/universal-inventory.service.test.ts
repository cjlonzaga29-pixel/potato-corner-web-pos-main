import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  },
}));

vi.mock('../branches/branches.repository.js', () => ({
  branchesRepository: {
    listAllBranchIds: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const { universalInventoryRepository: repo } = await import('./universal-inventory.repository.js');
const { branchesRepository } = await import('../branches/branches.repository.js');
const { universalInventoryService } = await import('./universal-inventory.service.js');

const ACTOR = { id: 'admin-1', role: 'super_admin' };

function decimal(value: number) {
  return { toNumber: () => value };
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
