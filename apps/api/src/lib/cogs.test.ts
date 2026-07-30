import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./prisma.js', () => {
  const prismaMock = {
    inventoryStock: { findMany: vi.fn() },
    inventoryItem: { findMany: vi.fn() },
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('./prisma.js');
const { resolveCurrentUnitCosts, attachCostToDeductionLines, computeCogsForItems } = await import('./cogs.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.inventoryItem.findMany).mockResolvedValue([] as never);
});

describe('resolveCurrentUnitCosts', () => {
  it('prefers InventoryStock.unitCost for the branch over InventoryItem.unitCost', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      { branchId: 'branch-1', inventoryItemId: 'item-1', unitCost: { toNumber: () => 5 } },
    ] as never);
    vi.mocked(prisma.inventoryItem.findMany).mockResolvedValue([
      { id: 'item-1', unitCost: { toNumber: () => 9 } },
    ] as never);

    const result = await resolveCurrentUnitCosts([{ branchId: 'branch-1', inventoryItemId: 'item-1' }]);

    expect(result.get('branch-1::item-1')).toBe(5);
  });

  it('falls back to InventoryItem.unitCost when no branch-level InventoryStock cost exists', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.inventoryItem.findMany).mockResolvedValue([
      { id: 'item-1', unitCost: { toNumber: () => 9 } },
    ] as never);

    const result = await resolveCurrentUnitCosts([{ branchId: 'branch-1', inventoryItemId: 'item-1' }]);

    expect(result.get('branch-1::item-1')).toBe(9);
  });

  it('resolves to null when neither InventoryStock nor InventoryItem has a cost', async () => {
    const result = await resolveCurrentUnitCosts([{ branchId: 'branch-1', inventoryItemId: 'item-1' }]);
    expect(result.get('branch-1::item-1')).toBeNull();
  });
});

describe('attachCostToDeductionLines', () => {
  it('attaches componentUnitCost and componentCost (unitCost * quantity) to each line', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      { branchId: 'branch-1', inventoryItemId: 'item-1', unitCost: { toNumber: () => 2.5 } },
    ] as never);

    const result = await attachCostToDeductionLines('branch-1', [{ inventoryItemId: 'item-1', quantity: 4 }]);

    expect(result[0]).toMatchObject({ inventoryItemId: 'item-1', quantity: 4, componentUnitCost: 2.5, componentCost: 10 });
  });

  it('leaves componentCost null when no cost is available anywhere', async () => {
    const result = await attachCostToDeductionLines('branch-1', [{ inventoryItemId: 'item-1', quantity: 4 }]);
    expect(result[0]).toMatchObject({ componentUnitCost: null, componentCost: null });
  });
});

describe('computeCogsForItems', () => {
  it('sums componentCost straight from the snapshot when every line has captured cost', async () => {
    const result = await computeCogsForItems([
      { branchId: 'branch-1', deductionSnapshot: [{ inventoryItemId: 'item-1', quantity: 2, componentCost: 10 }] },
      { branchId: 'branch-1', deductionSnapshot: [{ inventoryItemId: 'item-2', quantity: 1, componentCost: 5 }] },
    ]);

    expect(result).toEqual({ cogs: 15, isEstimated: false, missingCostItemCount: 0 });
  });

  it('falls back to current cost and marks the result estimated when componentCost is missing', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      { branchId: 'branch-1', inventoryItemId: 'item-1', unitCost: { toNumber: () => 3 } },
    ] as never);

    const result = await computeCogsForItems([
      { branchId: 'branch-1', deductionSnapshot: [{ inventoryItemId: 'item-1', quantity: 2 }] },
    ]);

    expect(result.cogs).toBe(6);
    expect(result.isEstimated).toBe(true);
    expect(result.missingCostItemCount).toBe(0);
  });

  it('flags missingCostItemCount when a component has no cost available at all (never treats it as zero silently)', async () => {
    const result = await computeCogsForItems([
      { branchId: 'branch-1', deductionSnapshot: [{ inventoryItemId: 'item-1', quantity: 2 }] },
    ]);

    expect(result.cogs).toBe(0);
    expect(result.isEstimated).toBe(true);
    expect(result.missingCostItemCount).toBe(1);
  });

  it('treats a TransactionItem with no deductionSnapshot at all as missing, not zero-cost', async () => {
    const result = await computeCogsForItems([{ branchId: 'branch-1', deductionSnapshot: null }]);

    expect(result.cogs).toBe(0);
    expect(result.isEstimated).toBe(true);
    expect(result.missingCostItemCount).toBe(1);
  });

  it('a fully-costed period reports isEstimated false and zero missing items', async () => {
    const result = await computeCogsForItems([
      { branchId: 'branch-1', deductionSnapshot: [{ inventoryItemId: 'item-1', quantity: 3, componentCost: 9, componentUnitCost: 3 }] },
    ]);

    expect(result.isEstimated).toBe(false);
    expect(result.missingCostItemCount).toBe(0);
  });
});
