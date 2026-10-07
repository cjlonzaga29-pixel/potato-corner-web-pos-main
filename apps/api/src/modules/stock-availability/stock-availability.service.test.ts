import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shadow-bom-deduction/shadow-bom-deduction.service.js', () => ({
  computeBomDeduction: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    inventoryStock: { findMany: vi.fn() },
  },
}));

const { computeBomDeduction } = await import('../shadow-bom-deduction/shadow-bom-deduction.service.js');
const { prisma } = await import('../../lib/prisma.js');
const { stockAvailabilityService } = await import('./stock-availability.service.js');

function decimal(value: number) {
  return { toNumber: () => value };
}

function stockRow(overrides: Record<string, unknown> = {}) {
  return {
    inventoryItemId: 'item-potato',
    quantityOnHand: decimal(100),
    quantityReserved: decimal(0),
    lowStockThreshold: null,
    criticalThreshold: null,
    inventoryItem: { name: 'Potato' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('stockAvailabilityService.evaluateCatalogStock', () => {
  it('returns in_stock when available stock comfortably covers one unit', async () => {
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 10 }]);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([stockRow()] as never);

    const result = await stockAvailabilityService.evaluateCatalogStock('branch-1', ['variant-1']);

    expect(result.get('variant-1')).toEqual({ productVariantId: 'variant-1', status: 'in_stock', maxSellableUnits: 10 });
  });

  it('returns out_of_stock when available stock cannot cover one unit', async () => {
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 50 }]);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([stockRow({ quantityOnHand: decimal(10) })] as never);

    const result = await stockAvailabilityService.evaluateCatalogStock('branch-1', ['variant-1']);

    expect(result.get('variant-1')).toEqual({ productVariantId: 'variant-1', status: 'out_of_stock', maxSellableUnits: 0 });
  });

  it('accounts for quantity already reserved by pending sales', async () => {
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 10 }]);
    // 100 on hand, 95 reserved -> only 5 available -> 0 sellable units at 10/unit.
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([
      stockRow({ quantityOnHand: decimal(100), quantityReserved: decimal(95) }),
    ] as never);

    const result = await stockAvailabilityService.evaluateCatalogStock('branch-1', ['variant-1']);

    expect(result.get('variant-1')?.status).toBe('out_of_stock');
  });

  it('returns low_stock (not out_of_stock) when sellable but below the low-stock threshold', async () => {
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 1 }]);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([
      stockRow({ quantityOnHand: decimal(5), lowStockThreshold: decimal(10) }),
    ] as never);

    const result = await stockAvailabilityService.evaluateCatalogStock('branch-1', ['variant-1']);

    expect(result.get('variant-1')).toEqual({ productVariantId: 'variant-1', status: 'low_stock', maxSellableUnits: 5 });
  });

  it('returns unknown (not out_of_stock) for a variant with no BOM components', async () => {
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([]);

    const result = await stockAvailabilityService.evaluateCatalogStock('branch-1', ['variant-1']);

    expect(result.get('variant-1')).toEqual({ productVariantId: 'variant-1', status: 'unknown', maxSellableUnits: null });
  });

  it('never equates raw ingredient quantity with sellable product units — divides by per-unit requirement', async () => {
    // 2 ingredients required per unit, 21 available -> floor(21/2) = 10 sellable units, not 21.
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 2 }]);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([stockRow({ quantityOnHand: decimal(21) })] as never);

    const result = await stockAvailabilityService.evaluateCatalogStock('branch-1', ['variant-1']);

    expect(result.get('variant-1')?.maxSellableUnits).toBe(10);
  });
});

describe('stockAvailabilityService.evaluateCartAvailability', () => {
  it('sums shared-ingredient requirements across multiple cart lines instead of checking each in isolation', async () => {
    // Two lines each needing 60 of the same ingredient; only 100 available in total.
    vi.mocked(computeBomDeduction)
      .mockResolvedValueOnce([{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 60 }])
      .mockResolvedValueOnce([{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 60 }]);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([stockRow({ quantityOnHand: decimal(100) })] as never);

    const result = await stockAvailabilityService.evaluateCartAvailability('branch-1', [
      { productVariantId: 'variant-1', quantity: 1 },
      { productVariantId: 'variant-2', quantity: 1 },
    ]);

    expect(result.ok).toBe(false);
    expect(result.shortfalls).toEqual([{ inventoryItemId: 'item-potato', itemName: 'Potato', available: 100, required: 120 }]);
  });

  it('includes each Mix & Max slot snack variant BOM on top of the parent variant BOM', async () => {
    vi.mocked(computeBomDeduction)
      .mockResolvedValueOnce([{ inventoryItemId: 'item-base', baseUnitId: 'unit-g', quantity: 5 }]) // parent
      .mockResolvedValueOnce([{ inventoryItemId: 'item-snack', baseUnitId: 'unit-g', quantity: 3 }]); // slot snack
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([
      stockRow({ inventoryItemId: 'item-base', quantityOnHand: decimal(100) }),
      stockRow({ inventoryItemId: 'item-snack', quantityOnHand: decimal(100) }),
    ] as never);

    const result = await stockAvailabilityService.evaluateCartAvailability('branch-1', [
      {
        productVariantId: 'variant-1',
        quantity: 1,
        selectedFlavors: [{ slotIndex: 0, snackProductVariantId: 'snack-variant-1', flavorId: 'flavor-1' }],
      },
    ]);

    expect(computeBomDeduction).toHaveBeenNthCalledWith(1, 'variant-1', 'branch-1', 1, null);
    expect(computeBomDeduction).toHaveBeenNthCalledWith(2, 'snack-variant-1', 'branch-1', 1, 'flavor-1');
    expect(result.ok).toBe(true);
  });

  it('ok with no shortfalls when nothing requires any BOM components', async () => {
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([]);

    const result = await stockAvailabilityService.evaluateCartAvailability('branch-1', [{ productVariantId: 'variant-1', quantity: 1 }]);

    expect(result).toEqual({ ok: true, shortfalls: [] });
  });
});
