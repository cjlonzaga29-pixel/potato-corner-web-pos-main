import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shadow-bom-deduction/shadow-bom-deduction.service.js', () => ({
  computeBomDeductionBatch: vi.fn(),
  buildBatchConverter: vi.fn(async () => (quantity: { toNumber(): number }) => quantity.toNumber()),
}));

vi.mock('../products/products.repository.js', () => ({
  productsRepository: { findRecipeCheckCatalogForBranch: vi.fn(), findDisabledFlavorIds: vi.fn() },
}));

vi.mock('../product-readiness/product-readiness.service.js', () => ({
  productReadinessService: { evaluateProductVariantReadinessBatch: vi.fn() },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    inventoryStock: { findMany: vi.fn() },
    inventoryItem: { findMany: vi.fn() },
    productOptionInventoryMapping: { findMany: vi.fn() },
  },
}));

vi.mock('../product-components/unit-conversion.util.js', () => ({
  convertQuantity: vi.fn(async (quantity: { toNumber(): number } | number) => ({ toNumber: () => (typeof quantity === 'number' ? quantity : quantity.toNumber()) })),
}));

const { computeBomDeductionBatch } = await import('../shadow-bom-deduction/shadow-bom-deduction.service.js');
const { prisma } = await import('../../lib/prisma.js');
const { stockAvailabilityService } = await import('./stock-availability.service.js');
const { convertQuantity } = await import('../product-components/unit-conversion.util.js');
const { productsRepository } = await import('../products/products.repository.js');
const { productReadinessService } = await import('../product-readiness/product-readiness.service.js');

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
  vi.mocked(prisma.inventoryItem.findMany).mockResolvedValue([
    { id: 'item-potato', name: 'Potato', trackInventory: true, baseUnit: { code: 'g' } },
    { id: 'item-salt', name: 'Salt', trackInventory: false, baseUnit: { code: 'g' } },
  ] as never);
});

describe('stockAvailabilityService.evaluateCatalogStock', () => {
  it('returns in_stock when available stock comfortably covers one unit', async () => {
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([[{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 10 }]]);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([stockRow()] as never);

    const result = await stockAvailabilityService.evaluateCatalogStock('branch-1', [{ productVariantId: 'variant-1', flavorIds: [] }]);

    expect(result.get('variant-1')).toEqual({ productVariantId: 'variant-1', status: 'in_stock', maxSellableUnits: 10, shortages: [] });
  });

  it('returns out_of_stock when available stock cannot cover one unit', async () => {
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([[{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 50 }]]);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([stockRow({ quantityOnHand: decimal(10) })] as never);

    const result = await stockAvailabilityService.evaluateCatalogStock('branch-1', [{ productVariantId: 'variant-1', flavorIds: [] }]);

    expect(result.get('variant-1')).toEqual({
      productVariantId: 'variant-1',
      status: 'out_of_stock',
      maxSellableUnits: 0,
      shortages: [{ inventoryItemId: 'item-potato', name: 'Potato', reason: 'below_recipe_quantity', available: 10, required: 50, unitCode: 'g', trackInventory: true }],
    });
  });

  it('POS-PERF-P56 — says which kind of shortage: no stock, fully reserved, not assigned to the branch, or an untracked item', async () => {
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([
      [{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 1 }],
      [{ inventoryItemId: 'item-reserved', baseUnitId: 'unit-g', quantity: 1 }],
      [{ inventoryItemId: 'item-missing', baseUnitId: 'unit-g', quantity: 1 }],
      [{ inventoryItemId: 'item-salt', baseUnitId: 'unit-g', quantity: 1 }],
    ]);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([
      stockRow({ quantityOnHand: decimal(0) }),
      stockRow({ inventoryItemId: 'item-reserved', quantityOnHand: decimal(4), quantityReserved: decimal(4) }),
      stockRow({ inventoryItemId: 'item-salt', quantityOnHand: decimal(0) }),
    ] as never);

    const result = await stockAvailabilityService.evaluateCatalogStock('branch-1', [
      { productVariantId: 'zero', flavorIds: [] },
      { productVariantId: 'reserved', flavorIds: [] },
      { productVariantId: 'missing', flavorIds: [] },
      { productVariantId: 'untracked', flavorIds: [] },
    ]);

    expect(result.get('zero')?.shortages[0]?.reason).toBe('no_stock');
    expect(result.get('reserved')?.shortages[0]?.reason).toBe('fully_reserved');
    expect(result.get('missing')?.shortages[0]?.reason).toBe('not_assigned');
    expect(result.get('untracked')?.shortages[0]).toMatchObject({ reason: 'no_stock', name: 'Salt', trackInventory: false });
    expect(prisma.inventoryItem.findMany).toHaveBeenCalledTimes(1);
  });

  it('POS-PERF-P56 — positive stock without thresholds stays in_stock, with no invented low-stock state and no extra query', async () => {
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([[{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 1 }]]);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([stockRow({ quantityOnHand: decimal(2) })] as never);

    const result = await stockAvailabilityService.evaluateCatalogStock('branch-1', [{ productVariantId: 'variant-1', flavorIds: [] }]);

    expect(result.get('variant-1')).toMatchObject({ status: 'in_stock', maxSellableUnits: 2, shortages: [] });
    expect(prisma.inventoryItem.findMany).not.toHaveBeenCalled();
  });

  it('accounts for quantity already reserved by pending sales', async () => {
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([[{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 10 }]]);
    // 100 on hand, 95 reserved -> only 5 available -> 0 sellable units at 10/unit.
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([
      stockRow({ quantityOnHand: decimal(100), quantityReserved: decimal(95) }),
    ] as never);

    const result = await stockAvailabilityService.evaluateCatalogStock('branch-1', [{ productVariantId: 'variant-1', flavorIds: [] }]);

    expect(result.get('variant-1')?.status).toBe('out_of_stock');
  });

  it('returns low_stock (not out_of_stock) when sellable but below the low-stock threshold', async () => {
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([[{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 1 }]]);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([
      stockRow({ quantityOnHand: decimal(5), lowStockThreshold: decimal(10) }),
    ] as never);

    const result = await stockAvailabilityService.evaluateCatalogStock('branch-1', [{ productVariantId: 'variant-1', flavorIds: [] }]);

    expect(result.get('variant-1')).toEqual({ productVariantId: 'variant-1', status: 'low_stock', maxSellableUnits: 5, shortages: [] });
  });

  it('returns unknown (not out_of_stock) for a variant with no BOM components', async () => {
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([[]]);

    const result = await stockAvailabilityService.evaluateCatalogStock('branch-1', [{ productVariantId: 'variant-1', flavorIds: [] }]);

    expect(result.get('variant-1')).toEqual({ productVariantId: 'variant-1', status: 'unknown', maxSellableUnits: null, shortages: [] });
  });

  it('never equates raw ingredient quantity with sellable product units — divides by per-unit requirement', async () => {
    // 2 ingredients required per unit, 21 available -> floor(21/2) = 10 sellable units, not 21.
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([[{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 2 }]]);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([stockRow({ quantityOnHand: decimal(21) })] as never);

    const result = await stockAvailabilityService.evaluateCatalogStock('branch-1', [{ productVariantId: 'variant-1', flavorIds: [] }]);

    expect(result.get('variant-1')?.maxSellableUnits).toBe(10);
  });

  it('checks every flavor configuration, not just the base recipe, and passes each (variant, flavor) pair through in one batched call', async () => {
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([
      [{ inventoryItemId: 'item-a', baseUnitId: 'unit-g', quantity: 5 }],
      [{ inventoryItemId: 'item-b', baseUnitId: 'unit-g', quantity: 5 }],
    ]);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([
      stockRow({ inventoryItemId: 'item-a', quantityOnHand: decimal(100) }),
      stockRow({ inventoryItemId: 'item-b', quantityOnHand: decimal(100) }),
    ] as never);

    await stockAvailabilityService.evaluateCatalogStock('branch-1', [{ productVariantId: 'variant-1', flavorIds: ['flavor-a', 'flavor-b'] }]);

    expect(computeBomDeductionBatch).toHaveBeenCalledWith([
      { productVariantId: 'variant-1', flavorId: 'flavor-a', quantitySold: 1 },
      { productVariantId: 'variant-1', flavorId: 'flavor-b', quantitySold: 1 },
    ]);
  });

  it('does not block a variant when the base recipe is short but a flavor override avoids the shortfall — no sellable configuration must remain before out_of_stock is reported', async () => {
    // flavor-a's configuration is out of stock; flavor-b's is fine. The
    // variant as a whole still has a sellable configuration.
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([
      [{ inventoryItemId: 'item-scarce', baseUnitId: 'unit-g', quantity: 50 }],
      [{ inventoryItemId: 'item-plentiful', baseUnitId: 'unit-g', quantity: 5 }],
    ]);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([
      stockRow({ inventoryItemId: 'item-scarce', quantityOnHand: decimal(0) }),
      stockRow({ inventoryItemId: 'item-plentiful', quantityOnHand: decimal(100) }),
    ] as never);

    const result = await stockAvailabilityService.evaluateCatalogStock('branch-1', [
      { productVariantId: 'variant-1', flavorIds: ['flavor-a', 'flavor-b'] },
    ]);

    expect(result.get('variant-1')).toEqual({ productVariantId: 'variant-1', status: 'in_stock', maxSellableUnits: 20, shortages: [] });
  });

  it('reports out_of_stock only once every flavor configuration is confirmed out of stock', async () => {
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([
      [{ inventoryItemId: 'item-scarce', baseUnitId: 'unit-g', quantity: 50 }],
      [{ inventoryItemId: 'item-scarce', baseUnitId: 'unit-g', quantity: 50 }],
    ]);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([
      stockRow({ inventoryItemId: 'item-scarce', quantityOnHand: decimal(0) }),
    ] as never);

    const result = await stockAvailabilityService.evaluateCatalogStock('branch-1', [
      { productVariantId: 'variant-1', flavorIds: ['flavor-a', 'flavor-b'] },
    ]);

    expect(result.get('variant-1')).toMatchObject({ productVariantId: 'variant-1', status: 'out_of_stock', maxSellableUnits: 0 });
  });
});

describe('stockAvailabilityService.evaluateCartAvailability', () => {
  it('sums shared-ingredient requirements across multiple cart lines instead of checking each in isolation', async () => {
    // Two lines each needing 60 of the same ingredient; only 100 available in total.
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([
      [{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 60 }],
      [{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 60 }],
    ]);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([stockRow({ quantityOnHand: decimal(100) })] as never);

    const result = await stockAvailabilityService.evaluateCartAvailability('branch-1', [
      { productVariantId: 'variant-1', quantity: 1 },
      { productVariantId: 'variant-2', quantity: 1 },
    ]);

    expect(result.ok).toBe(false);
    expect(result.shortfalls).toEqual([{ inventoryItemId: 'item-potato', itemName: 'Potato', available: 100, required: 120 }]);
  });

  it('includes each Mix & Max slot snack variant BOM on top of the parent variant BOM, resolved in one batched call', async () => {
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([
      [{ inventoryItemId: 'item-base', baseUnitId: 'unit-g', quantity: 5 }], // parent
      [{ inventoryItemId: 'item-snack', baseUnitId: 'unit-g', quantity: 3 }], // slot snack
    ]);
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

    expect(computeBomDeductionBatch).toHaveBeenCalledWith([
      { productVariantId: 'variant-1', flavorId: null, quantitySold: 1 },
      { productVariantId: 'snack-variant-1', flavorId: 'flavor-1', quantitySold: 1 },
    ]);
    expect(result.ok).toBe(true);
  });

  it('ok with no shortfalls when nothing requires any BOM components', async () => {
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([[]]);

    const result = await stockAvailabilityService.evaluateCartAvailability('branch-1', [{ productVariantId: 'variant-1', quantity: 1 }]);

    expect(result).toEqual({ ok: true, shortfalls: [] });
  });

  // POS-PERF-P41 — add-on options deduct their mapped ingredient at checkout,
  // so the pre-check sums them with the recipes (one mapping query).
  it('adds each selected add-on option ingredient, times the line quantity, to the shared total', async () => {
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([
      [{ inventoryItemId: 'item-potato', baseUnitId: 'unit-g', quantity: 200 }], // cheesy fries x2
      [{ inventoryItemId: 'item-cheese', baseUnitId: 'unit-g', quantity: 15 }], // cheese sticks recipe
    ]);
    vi.mocked(prisma.productOptionInventoryMapping.findMany).mockResolvedValueOnce([
      { productOptionId: 'opt-cheese', inventoryItemId: 'item-cheese', quantityRequired: decimal(10), deductionUnitId: 'unit-g', inventoryItem: { baseUnitId: 'unit-g', deletedAt: null } },
    ] as never);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([
      stockRow({ inventoryItemId: 'item-potato', quantityOnHand: decimal(1000) }),
      stockRow({ inventoryItemId: 'item-cheese', quantityOnHand: decimal(30), inventoryItem: { name: 'Cheese' } }),
    ] as never);

    const result = await stockAvailabilityService.evaluateCartAvailability('branch-1', [
      { productVariantId: 'variant-cheesy', quantity: 2, selectedOptionIds: ['opt-cheese'] },
      { productVariantId: 'variant-sticks', quantity: 1 },
    ]);

    expect(prisma.productOptionInventoryMapping.findMany).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, shortfalls: [{ inventoryItemId: 'item-cheese', itemName: 'Cheese', available: 30, required: 35 }] });
  });

  it('counts an option listed twice twice, and leaves out mappings checkout would refuse instead of failing the pre-check', async () => {
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([[]]);
    vi.mocked(prisma.productOptionInventoryMapping.findMany).mockResolvedValueOnce([
      { productOptionId: 'opt-cheese', inventoryItemId: 'item-cheese', quantityRequired: decimal(10), deductionUnitId: 'unit-g', inventoryItem: { baseUnitId: 'unit-g', deletedAt: null } },
      { productOptionId: 'opt-gone', inventoryItemId: 'item-gone', quantityRequired: decimal(10), deductionUnitId: 'unit-g', inventoryItem: { baseUnitId: 'unit-g', deletedAt: new Date() } },
      { productOptionId: 'opt-tbsp', inventoryItemId: 'item-sauce', quantityRequired: decimal(1), deductionUnitId: 'unit-tbsp', inventoryItem: { baseUnitId: 'unit-ml', deletedAt: null } },
    ] as never);
    vi.mocked(convertQuantity).mockImplementation(async (quantity, from, to) => {
      if (from !== to) throw new Error('MISSING_UNIT_CONVERSION');
      return { toNumber: () => (typeof quantity === 'number' ? quantity : quantity.toNumber()) } as never;
    });
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([
      stockRow({ inventoryItemId: 'item-cheese', quantityOnHand: decimal(100), inventoryItem: { name: 'Cheese' } }),
    ] as never);

    const result = await stockAvailabilityService.evaluateCartAvailability('branch-1', [
      { productVariantId: 'variant-1', quantity: 3, selectedOptionIds: ['opt-cheese', 'opt-cheese', 'opt-gone', 'opt-tbsp'] },
    ]);

    expect(prisma.inventoryStock.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { branchId: 'branch-1', inventoryItemId: { in: ['item-cheese'] } } }));
    expect(result).toEqual({ ok: true, shortfalls: [] });
  });

  it('makes no option-mapping query for a cart without add-ons', async () => {
    vi.mocked(computeBomDeductionBatch).mockResolvedValueOnce([[]]);

    await stockAvailabilityService.evaluateCartAvailability('branch-1', [{ productVariantId: 'variant-1', quantity: 1 }]);

    expect(prisma.productOptionInventoryMapping.findMany).not.toHaveBeenCalled();
  });
});

describe('stockAvailabilityService.evaluateBranchRecipeShortages (POS-PERF-P57)', () => {
  const variant = (id: string) => ({ id, name: id, variantFlavors: [], optionGroupAssignments: [] });

  it('keeps a fixed query count however many products the branch has (no N+1)', async () => {
    const products = Array.from({ length: 50 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, variants: [variant(`v${index}`)] }));
    vi.mocked(productsRepository.findRecipeCheckCatalogForBranch).mockResolvedValue(products as never);
    vi.mocked(productsRepository.findDisabledFlavorIds).mockResolvedValue([]);
    vi.mocked(productReadinessService.evaluateProductVariantReadinessBatch).mockResolvedValue(products.map((product) => ({ productVariantId: product.variants[0]?.id, sellable: true })) as never);
    vi.mocked(computeBomDeductionBatch).mockResolvedValue(products.map(() => [{ inventoryItemId: 'item-potato', baseUnitId: 'g', quantity: 500 }]));
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([stockRow()] as never);

    const result = await stockAvailabilityService.evaluateBranchRecipeShortages('branch-1');

    expect(productReadinessService.evaluateProductVariantReadinessBatch).toHaveBeenCalledTimes(1);
    expect(computeBomDeductionBatch).toHaveBeenCalledTimes(1);
    expect(prisma.inventoryStock.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.inventoryItem.findMany).toHaveBeenCalledTimes(1);
    // One item, however many sizes use it.
    expect(result.byItem.size).toBe(1);
    expect(result.byItem.get('item-potato')?.affected).toHaveLength(50);
    expect(result.byItem.get('item-potato')).toMatchObject({ required: 500, deficit: 400 });
  });

  it('reads nothing further when the branch offers no products', async () => {
    vi.mocked(productsRepository.findRecipeCheckCatalogForBranch).mockResolvedValue([]);
    vi.mocked(productsRepository.findDisabledFlavorIds).mockResolvedValue([]);
    const result = await stockAvailabilityService.evaluateBranchRecipeShortages('branch-1');
    expect(result.byItem.size).toBe(0);
    expect(computeBomDeductionBatch).not.toHaveBeenCalled();
  });

  it('never reads a size that failed readiness', async () => {
    vi.mocked(productsRepository.findRecipeCheckCatalogForBranch).mockResolvedValue([{ id: 'p', name: 'P', variants: [variant('v')] }] as never);
    vi.mocked(productsRepository.findDisabledFlavorIds).mockResolvedValue([]);
    vi.mocked(productReadinessService.evaluateProductVariantReadinessBatch).mockResolvedValue([{ productVariantId: 'v', sellable: false }] as never);
    vi.mocked(computeBomDeductionBatch).mockResolvedValue([]);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([]);
    expect((await stockAvailabilityService.evaluateBranchRecipeShortages('branch-1')).byItem.size).toBe(0);
    expect(computeBomDeductionBatch).toHaveBeenCalledWith([]);
  });
});
